/* =====================================================================
   MAPA + ROTAS
   Lê o resultado da coleta (/api/flex/estado), desenha os pedidos
   num mapa de SP com tiles do OpenStreetMap (sem biblioteca externa,
   porque o CSP do MV3 bloqueia script de CDN), agrupa por zona e monta
   as rotas de carro na ordem de visita.
   ===================================================================== */

const TILE = 256;

/*  Base do mapa: o tile.openstreetmap.org bloqueia requisição vinda de
    extensão (403, "not following the tile usage policy") e a CARTO passou a
    exigir chave (devolve o tile com marca d'água). O Esri serve sem chave.
    Se um provedor falhar, a página passa sozinha para o próximo e grava
    qual funcionou. */
const PROVEDORES = [
  {
    nome: "Esri",
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
    credito: "© Esri · OpenStreetMap contributors"
  },
  {
    nome: "OSM-DE",
    url: (z, x, y) => `https://tile.openstreetmap.de/${z}/${x}/${y}.png`,
    credito: "© OpenStreetMap contributors"
  },
  {
    nome: "OSM",
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    credito: "© OpenStreetMap contributors"
  }
];

let provedorAtual = Math.max(0, PROVEDORES.findIndex(p => p.nome === localStorage.getItem("flex_tiles")));
if (provedorAtual < 0) provedorAtual = 0;
let falhasTile = 0;

function trocarProvedor() {
  if (provedorAtual >= PROVEDORES.length - 1) {
    $("credito").textContent = "Mapa base indisponível — os pinos e as rotas continuam funcionando.";
    return;
  }
  provedorAtual++;
  falhasTile = 0;
  localStorage.setItem("flex_tiles", PROVEDORES[provedorAtual].nome);
  for (const [chave, img] of tilesCache) { img.remove(); tilesCache.delete(chave); }
  $("credito").textContent = PROVEDORES[provedorAtual].credito;
  render();
}
const CORES_FIXAS = {
  "Centro": "#6b7280",
  "Zona Norte": "#d97706",
  "Zona Leste": "#dc2626",
  "Zona Sul": "#2563eb",
  "Zona Oeste": "#16a34a",
  "Sem zona": "#9ca3af"
};
const PALETA = ["#7c3aed", "#0891b2", "#be185d", "#4d7c0f", "#b45309", "#1d4ed8", "#9333ea"];

const estado = {
  run: null,
  registros: [],
  paradas: [],
  zonasOcultas: new Set(),
  contasOcultas: new Set(),
  rotas: [],
  manual: { ativo: false, chaves: [] },
  achada: null,
  motorista: null,
  semSessao: false,
  ultimaLeitura: 0,
  extras: [],
  historico: null,
  zonasAbertas: false,
  partida: null,
  centro: { lat: -23.5505, lng: -46.6333 },
  zoom: 11,
  selecionada: null
};

const $ = id => document.getElementById(id);
const semAcento = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/* =====================================================================
   PROJEÇÃO (Web Mercator)
   ===================================================================== */
const escala = z => Math.pow(2, z) * TILE;
const lng2x = (lng, z) => (lng + 180) / 360 * escala(z);
const lat2y = (lat, z) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * escala(z);
};
const x2lng = (x, z) => x / escala(z) * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI - 2 * Math.PI * y / escala(z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/* =====================================================================
   DADOS
   ===================================================================== */
function corDaZona(zona) {
  if (CORES_FIXAS[zona]) return CORES_FIXAS[zona];
  const zonas = [...new Set(estado.paradas.map(p => p.zona))].filter(z => !CORES_FIXAS[z]).sort();
  const i = zonas.indexOf(zona);
  // Nome que nao vem das paradas (a rota "Zonas ligadas", por exemplo) daria
  // indice -1 e cor "undefined" — a linha some do mapa sem erro nenhum.
  return i < 0 ? "#111827" : PALETA[i % PALETA.length];
}

// Mesma regra usada pela busca para achar a parada de um pedido.
const chaveDaParada = r => semAcento(r.rua) + "|" + String(r.cep || "").replace(/[^0-9]/g, "");

// agrupa pedidos do mesmo endereço numa única parada
function montarParadas(registros) {
  const mapa = new Map();
  for (const r of registros) {
    const chave = chaveDaParada(r);
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        chave,
        rua: r.rua,
        comp: r.comp,
        cep: r.cep,
        bairro: r.bairro || "",
        cidade: r.cidade || "",
        region: r.region,
        zona: r.zona || "Sem zona",
        lat: r.lat || null,
        lng: r.lng || null,
        geoFonte: r.geoFonte,
        geoErro: r.geoErro,
        aprox: !!r.aprox,
        pedidos: []
      });
    }
    const p = mapa.get(chave);
    p.pedidos.push(r);
    if (!p.lat && r.lat) { p.lat = r.lat; p.lng = r.lng; }
  }
  for (const p of mapa.values()) {
    p.valorTotal = p.pedidos.reduce((s, r) => s + (Number(r.valor) || 0), 0);
    p.valorMax = p.pedidos.reduce((s, r) => Math.max(s, Number(r.valor) || 0), 0);
    p.enderecoTexto = [p.rua, p.bairro, p.cidade || "São Paulo", p.cep].filter(Boolean).join(", ");
  }
  return [...mapa.values()];
}

/*  Filtro no nível do pedido: tipo de envio, status e valor.
    "Somente Flex" usa o rótulo da listagem e o bloco "Dados do envio"
    do detalhe — basta um dos dois dizer Flex. */
function filtrarRegistros() {
  const min = Number($("valor-min").value) || 0;
  const soFlex = $("so-flex").checked;
  const semCancelados = $("sem-cancelados").checked;
  const quando = $("filtro-prazo").value;

  return (estado.registros || []).filter(r => {
    if (estado.contasOcultas.has(r.conta)) return false;
    if (soFlex && !r.flex) return false;
    if (semCancelados && r.cancelado) return false;
    if ((Number(r.valor) || 0) < min) return false;
    if (quando) {
      const q = rotuloPrazo(r.prazo_entrega).quando;
      // Pedido sem prazo informado nunca e escondido: sumir com ele em
      // silencio seria pior do que mostrar fora do dia escolhido.
      if (q && q !== quando) return false;
    }
    return true;
  });
}

function recalcular() {
  estado.paradas = [...montarParadas(filtrarRegistros()), ...paradasExtras()];
  desenharExtras();
  estado.rotas = [];
  desenharResumoFiltro();
  desenharZonas();
  desenharProblemas();
  desenharRotas();
  render();
}

function desenharResumoFiltro() {
  const total = (estado.registros || []).length;
  const passam = filtrarRegistros().length;
  const naoFlex = (estado.registros || []).filter(r => !r.flex).length;
  const cancelados = (estado.registros || []).filter(r => r.cancelado).length;
  const deHoje = (estado.registros || []).filter(
    r => r.flex && ["hoje"].includes(rotuloPrazo(r.prazo_entrega).quando)
  ).length;
  $("resumo-filtro").textContent = total
    ? `${passam} de ${total} pedidos no mapa` +
      (naoFlex ? ` · ${naoFlex} fora do Flex` : "") +
      (cancelados ? ` · ${cancelados} cancelada(s)` : "") +
      (deHoje ? ` · ${deHoje} Flex para hoje` : "")
    : "";
}

/* =====================================================================
   PARADAS EXTRAS
   Endereco que nao veio do Mercado Livre: uma venda do ERP, uma coleta,
   o almoco. Entra no mapa, nas rotas, na folha impressa e no CSV do My
   Maps como qualquer outra parada. Fica guardada no servidor (config),
   entao sobrevive a recarregar a pagina.

   O campo aceita desde um endereco solto ate a mensagem inteira do ERP
   colada do WhatsApp — o interpretador abaixo separa empresa, pedido,
   endereco, telefone, observacao e horario.
   ===================================================================== */

// Tira emoji, asterisco de negrito e espaco sobrando, mantendo o texto.
function limparLinha(l) {
  return l
    .replace(/[‍←-⯿☀-➿-️]/g, "")
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")
    .replace(/\*/g, "")
    .trim();
}

const semAcentoMaiusc = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

/*  Le "RÓTULO: valor", aceitando que o valor continue nas linhas
    seguintes (o endereco do ERP quebra o CEP na linha de baixo). */
function camposDaColagem(texto) {
  const campos = {};
  let atual = null;

  for (const bruta of String(texto).split(/\r?\n/)) {
    const linha = limparLinha(bruta);
    if (!linha) continue;

    const m = linha.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ \/]{2,60}?)\s*:\s*(.*)$/);
    if (m) {
      atual = semAcentoMaiusc(m[1]);
      campos[atual] = (m[2] || "").trim();
    } else if (atual) {
      campos[atual] = (campos[atual] + " " + linha).trim();
    } else {
      campos.__SOLTO = ((campos.__SOLTO || "") + " " + linha).trim();
    }
  }
  return campos;
}

const vazio = (v) => !v || v === "-" || v === "--" || semAcentoMaiusc(v) === "N/A";

/*  Monta o prazo a partir de "DATA PREVISTA: 28/10" + "ate as 20:00".
    Sem data, assume hoje; sem hora, fim do dia. O navegador do usuario
    esta no fuso de SP, entao new Date(...) local resolve. */
function prazoDaColagem(data, hora) {
  const agora = new Date();
  let dia = agora.getDate();
  let mes = agora.getMonth();
  let ano = agora.getFullYear();

  const mData = (data || "").match(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/);
  if (mData) {
    dia = Number(mData[1]);
    mes = Number(mData[2]) - 1;
    if (mData[3]) ano = Number(mData[3].length === 2 ? "20" + mData[3] : mData[3]);
  }

  const mHora = (hora || "").match(/(\d{1,2})\s*[:h]\s*(\d{2})?/);
  const h = mHora ? Number(mHora[1]) : 23;
  const min = mHora && mHora[2] ? Number(mHora[2]) : mHora ? 0 : 59;

  const d = new Date(ano, mes, dia, h, min, 0);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function interpretarExtra(texto) {
  const campos = camposDaColagem(texto);
  /*  Busca por aproximacao: o ERP mudou "DATA PREVISTA" para "DATA
      PREVISTA DE ENTREGA E CLIENTE" e um match exato pararia de achar.
      Primeiro tenta o nome exato, depois qualquer rotulo que comece com
      ele, depois qualquer um que o contenha. */
  const pegar = (...nomes) => {
    const chaves = Object.keys(campos);
    for (const n of nomes) {
      const alvo = semAcentoMaiusc(n);
      const achada =
        chaves.find((k) => k === alvo) ||
        chaves.find((k) => k.startsWith(alvo)) ||
        chaves.find((k) => k.includes(alvo));
      const v = achada ? campos[achada] : "";
      if (!vazio(v)) return v.trim();
    }
    return "";
  };

  const endereco = pegar("ENDERECO", "ENDEREÇO");
  const temRotulos = !!(endereco || pegar("PEDIDO") || pegar("EMPRESA"));

  // Sem rotulo nenhum: o texto inteiro e o endereco (uso simples do campo)
  if (!temRotulos) {
    return { endereco: limparLinha(String(texto).replace(/\s+/g, " ")), cliente: "", pedido: "", telefone: "", obs: "", prazo: "" };
  }

  // Telefone: tira o "-" que o ERP coloca antes do numero
  let telefone = pegar("CONTATO", "TELEFONE", "FONE").replace(/\D/g, "");
  if (telefone.length > 11 && telefone.startsWith("55")) telefone = telefone.slice(2);
  if (![10, 11].includes(telefone.length)) telefone = "";

  // "ate as 20:00" costuma vir solto no fim da mensagem
  const solto = campos.__SOLTO || "";
  const horaSolta = solto.match(/(?:ate|até)\s*(?:as|às)?\s*(\d{1,2}\s*[:h]\s*\d{0,2})/i);
  const hora = pegar("HORARIO", "HORÁRIO") || (horaSolta ? horaSolta[1] : "");

  const observacao = [
    pegar("OBSERVACAO", "OBSERVAÇÃO"),
    pegar("SUBIR NO LOCAL") ? "Subir: " + pegar("SUBIR NO LOCAL") : "",
    pegar("TAXA DE SUBIDA") ? "Taxa: " + pegar("TAXA DE SUBIDA") : "",
    pegar("PAGAMENTO") ? "Pgto: " + pegar("PAGAMENTO") : "",
    pegar("FRETE") ? "Frete: " + pegar("FRETE") : "",
    !horaSolta && solto ? solto : "",
  ].filter(Boolean).join(" · ");

  /*  "DATA PREVISTA DE ENTREGA E CLIENTE: 30/10 - Fulano" traz as duas
      informacoes na mesma linha: o que vem depois do primeiro travessao
      e o cliente. */
  const dataECliente = pegar("DATA PREVISTA", "DATA");
  const depoisDoTraco = dataECliente.replace(/^[^-]*-\s*/, "").trim();
  const clienteNaData =
    depoisDoTraco && depoisDoTraco !== dataECliente ? depoisDoTraco : "";

  // O rotulo da data contem a palavra CLIENTE, entao o valor pode vir
  // como "30/10 - Fulano": a data no comeco sai fora.
  const semData = (v) =>
    v.replace(/^\s*\d{1,2}\s*\/\s*\d{1,2}(?:\s*\/\s*\d{2,4})?\s*[-–—]\s*/, "").trim();

  return {
    endereco: endereco.replace(/\s+/g, " ").trim(),
    cliente: semData(pegar("EMPRESA", "CLIENTE", "NOME") || clienteNaData),
    pedido: pegar("PEDIDO", "N PEDIDO", "NUMERO DO PEDIDO"),
    telefone,
    obs: observacao,
    prazo: prazoDaColagem(dataECliente, hora),
  };
}

/*  Quebra o endereco do ERP em rua / bairro / cidade / CEP, para o
    popup e a folha ficarem iguais aos dos pedidos do ML. */
function partesDoEndereco(texto) {
  const cep = (texto.match(/\d{5}-?\d{3}/) || [""])[0];
  const bairro = (texto.match(/Bairro\s*:\s*([^.,;]+)/i) || ["", ""])[1].trim();
  const cidade = (texto.match(/\d{5}-?\d{3}\s*-\s*([^,]+)/) || ["", ""])[1].trim();
  const rua = texto
    .replace(/Bairro\s*:\s*[^.,;]+[.,;]?/i, "")
    .replace(/\d{5}-?\d{3}.*$/, "")
    .replace(/[\s.,;-]+$/, "")
    .trim();
  return { rua: rua || texto, bairro, cidade, cep };
}

/*  O texto do ERP vem com "Nº 82" e "Bairro: Vila Guilherme." — nenhum
    servico de geocodificacao entende esses rotulos, e a busca falha (era
    o erro relatado: tirando o bairro e o Nº na mao, funcionava). Aqui a
    consulta e remontada a partir das partes, em formato limpo. */
function enderecoParaBusca(texto) {
  const p = partesDoEndereco(texto);
  const rua = p.rua
    .replace(/\bn[º°o]?\.?\s*(?=\d)/gi, "")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return [rua, p.bairro, p.cidade || "São Paulo", p.cep, "Brasil"]
    .filter(Boolean)
    .join(", ");
}

function paradasExtras() {
  return (estado.extras || []).map((e) => ({
    chave: "extra:" + e.id,
    extra: true,
    rua: e.rua || e.texto,
    comp: e.obs || "",
    cep: e.cep || "",
    bairro: e.bairro || "",
    cidade: e.cidade || "",
    region: "",
    zona: "Parada extra",
    lat: e.lat,
    lng: e.lng,
    aprox: !!e.aprox,
    enderecoTexto: e.texto,
    valorTotal: 0,
    valorMax: 0,
    pedidos: [{
      pedido: e.pedido || "",
      valor: null,
      nome: e.cliente || "",
      quem: e.cliente || "",
      user: "",
      telefone: e.telefone || "",
      whatsapp: e.telefone ? "55" + e.telefone : "",
      conta: "manual",
      itens: [],
      tipoEnvio: "parada extra",
      prazo_entrega: e.prazo || "",
    }],
  }));
}

/*  Geocodificar e aceitar o que vier e perigoso: o servico gratuito,
    quando nao conhece a rua, devolve um ponto qualquer parecido em vez de
    recusar — e um pino errado manda o motorista para o outro lado da
    cidade sem ninguem desconfiar. Aqui o resultado so e aceito se estiver
    perto do bairro informado (o bairro, esse, o mapa conhece bem).
    Nao batendo, o pino fica no bairro e e marcado como aproximado. */
async function localizarComConferencia(texto, partes) {
  const consulta = enderecoParaBusca(texto);
  const ponto = await geocodificarTexto(consulta);

  const bairro = partes.bairro
    ? await geocodificarTexto([partes.bairro, partes.cidade || "São Paulo", "Brasil"].join(", "))
    : null;

  const LIMITE_KM = 8;
  if (ponto && (!bairro || distKm(ponto, bairro) <= LIMITE_KM)) return { ...ponto, aprox: false };
  if (bairro) return { ...bairro, aprox: true };
  return ponto ? { ...ponto, aprox: true } : null;
}

async function adicionarExtra() {
  const texto = $("extra-texto").value.trim();
  if (!texto) return;
  $("extra-info").textContent = "Lendo e localizando...";

  const dados = interpretarExtra(texto);
  if (!dados.endereco) {
    $("extra-info").textContent = "Nao achei o endereco no texto colado.";
    return;
  }

  const partes = partesDoEndereco(dados.endereco);
  const achado = await localizarComConferencia(dados.endereco, partes);
  if (!achado) {
    $("extra-info").textContent =
      "Nao consegui localizar esse endereco. Confira rua, numero e cidade.";
    return;
  }
  const ponto = achado;
  estado.extras.push({
    id: String(Date.now()),
    texto: dados.endereco,
    ...partes,
    cliente: dados.cliente,
    pedido: dados.pedido,
    telefone: dados.telefone,
    obs: dados.obs,
    prazo: dados.prazo,
    lat: ponto.lat,
    lng: ponto.lng,
    aprox: !!ponto.aprox,
  });

  await salvarExtras();
  $("extra-info").textContent = ponto.aprox
    ? "Endereco exato nao encontrado: o pino ficou no bairro. Use editar para ajustar."
    : "";
  $("extra-texto").value = "";
  $("extra-info").textContent = "";
  recalcular();
}

async function geocodificarTexto(texto) {
  const resp = await pegarJson("/api/flex/geocodificar?q=" + encodeURIComponent(texto));
  return resp?.ok && resp.ponto ? resp.ponto : null;
}

async function salvarExtras() {
  await pegarJson("/api/flex/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paradas_extras: estado.extras }),
  });
}

function desenharExtras() {
  const alvo = $("extras");
  if (!estado.extras.length) {
    alvo.innerHTML = "";
    return;
  }

  alvo.innerHTML = estado.extras.map((e) => {
    const q = rotuloPrazo(e.prazo);
    return `
    <div class="extra-item" data-id="${e.id}">
      <div class="extra-corpo" data-ir="extra:${e.id}" title="Ver no mapa">
        <b>${escapar(e.rua || e.texto)}</b>
        <span>${escapar([e.cliente, e.pedido ? "#" + e.pedido : "", e.telefone ? formatarTel(e.telefone) : ""].filter(Boolean).join(" · "))}
        ${q.texto ? `<span class="etiqueta ${q.classe}">${escapar(q.texto)}</span>` : ""}</span>
        ${e.obs ? `<span>${escapar(e.obs)}</span>` : ""}
      </div>
      <button class="mini-btn" data-editar="${e.id}" title="Editar">editar</button>
      <button class="mini-btn" data-extra="${e.id}" title="Tirar">&times;</button>
    </div>`;
  }).join("");

  alvo.querySelectorAll("[data-ir]").forEach((d) => {
    d.onclick = () => irPara(d.dataset.ir);
  });
  alvo.querySelectorAll("[data-extra]").forEach((b) => {
    b.onclick = async () => {
      estado.extras = estado.extras.filter((e) => e.id !== b.dataset.extra);
      estado.manual.chaves = estado.manual.chaves.filter((c) => c !== "extra:" + b.dataset.extra);
      await salvarExtras();
      recalcular();
    };
  });
  alvo.querySelectorAll("[data-editar]").forEach((b) => {
    b.onclick = () => editarExtra(b.dataset.editar);
  });
}

function editarExtra(id) {
  const e = estado.extras.find((x) => x.id === id);
  if (!e) return;
  const linha = $("extras").querySelector(`[data-id="${id}"]`);

  const campo = (rotulo, nome, valor, tipo = "text") => `
    <label class="campo-label">${rotulo}
      <input data-campo="${nome}" type="${tipo}" value="${escapar(valor || "")}">
    </label>`;

  linha.innerHTML = `
    <div class="extra-form">
      ${campo("Endereco", "texto", e.texto)}
      ${campo("Cliente", "cliente", e.cliente)}
      ${campo("Pedido", "pedido", e.pedido)}
      ${campo("Telefone", "telefone", e.telefone)}
      ${campo("Observacao", "obs", e.obs)}
      ${campo("Entregar ate", "prazo_local", e.prazo ? paraInputLocal(e.prazo) : "", "datetime-local")}
      <div class="linha-botoes">
        <button class="primario" data-salvar="${id}">Salvar</button>
        <button data-cancelar="${id}">Cancelar</button>
      </div>
    </div>`;

  linha.querySelector("[data-cancelar]").onclick = () => desenharExtras();
  linha.querySelector("[data-salvar]").onclick = async () => {
    const valor = (nome) => linha.querySelector(`[data-campo="${nome}"]`).value.trim();
    const enderecoNovo = valor("texto");
    const mudouEndereco = enderecoNovo && enderecoNovo !== e.texto;

    if (mudouEndereco) {
      const partesNovas = partesDoEndereco(enderecoNovo);
      const ponto = await localizarComConferencia(enderecoNovo, partesNovas);
      if (!ponto) {
        $("extra-info").textContent = "Nao consegui localizar o endereco novo; o antigo foi mantido.";
        return;
      }
      Object.assign(e, { lat: ponto.lat, lng: ponto.lng, aprox: !!ponto.aprox }, { texto: enderecoNovo }, partesNovas);
    }

    let tel = valor("telefone").replace(/\D/g, "");
    if (tel.length > 11 && tel.startsWith("55")) tel = tel.slice(2);

    e.cliente = valor("cliente");
    e.pedido = valor("pedido");
    e.telefone = [10, 11].includes(tel.length) ? tel : "";
    e.obs = valor("obs");
    const local = valor("prazo_local");
    e.prazo = local ? new Date(local).toISOString() : "";

    await salvarExtras();
    $("extra-info").textContent = "";
    recalcular();
  };
}

// ISO -> valor aceito por <input type="datetime-local"> (hora local)
function paraInputLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function paradasVisiveis() {
  // Vendo um dia guardado: o mapa e a lista mostram aquele dia, nao o de hoje.
  if (estado.historico) return estado.historico.paradas.filter(p => p.lat && p.lng);
  return estado.paradas.filter(p => !estado.zonasOcultas.has(p.zona) && p.lat && p.lng);
}

/* =====================================================================
   MAPA
   ===================================================================== */
const tilesCache = new Map();

function render() {
  const wrap = $("mapa");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const z = estado.zoom;
  const cx = lng2x(estado.centro.lng, z), cy = lat2y(estado.centro.lat, z);
  const left = cx - w / 2, top = cy - h / 2;

  // --- tiles ---
  const usados = new Set();
  const n = Math.pow(2, z);
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      const chave = `${z}/${wx}/${ty}`;
      usados.add(chave);
      let img = tilesCache.get(chave);
      if (!img) {
        img = document.createElement("img");
        img.referrerPolicy = "no-referrer";
        img.alt = "";
        img.onerror = () => { if (++falhasTile > 3) trocarProvedor(); };
        img.src = PROVEDORES[provedorAtual].url(z, wx, ty);
        tilesCache.set(chave, img);
        $("tiles").appendChild(img);
      }
      img.style.left = (tx * TILE - left) + "px";
      img.style.top = (ty * TILE - top) + "px";
    }
  }
  for (const [chave, img] of tilesCache) {
    if (!usados.has(chave)) { img.remove(); tilesCache.delete(chave); }
  }

  const px = p => ({ x: lng2x(p.lng, z) - left, y: lat2y(p.lat, z) - top });

  // --- linhas das rotas ---
  const svg = $("linhas");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  const linhaManual = (() => {
    const pts = [];
    if (estado.partida) pts.push(px(estado.partida));
    for (const c of estado.manual.chaves) {
      const p = estado.paradas.find(x => x.chave === c);
      if (p && p.lat) pts.push(px(p));
    }
    if (pts.length < 2) return "";
    const d = pts.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="#111827" stroke-width="3"
             stroke-dasharray="7 5" stroke-linejoin="round"/>`;
  })();

  svg.innerHTML = linhaManual + estado.rotas.map(rota => {
    const pts = [];
    if (estado.partida) pts.push(px(estado.partida));
    rota.paradas.forEach(p => pts.push(px(p)));
    if (pts.length < 2) return "";
    const d = pts.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${corDaZona(rota.zona)}" stroke-width="3"
             stroke-opacity=".65" stroke-linejoin="round"/>`;
  }).join("");

  // --- pinos ---
  const ordem = new Map();
  estado.rotas.forEach(rota => rota.paradas.forEach((p, i) => ordem.set(p.chave, i + 1)));
  const manual = new Map();
  estado.manual.chaves.forEach((c, i) => manual.set(c, i + 1));

  const pins = paradasVisiveis().map(p => {
    const q = px(p);
    const num = manual.get(p.chave) || ordem.get(p.chave) || p.pedidos.length;
    const escolhido = manual.has(p.chave) ? " escolhido" : "";
    const achado = estado.achada === p.chave ? " achado" : "";
    const marcaExtra = p.extra ? " extra" : "";
    return `<div class="pin${p.aprox ? " aprox" : ""}${escolhido}${achado}${marcaExtra}" data-chave="${p.chave}"
            title="${p.aprox ? "Localização aproximada" : ""}"
            style="left:${q.x}px;top:${q.y}px;background:${corDaZona(p.zona)}"><b>${num}</b></div>`;
  });

  if (estado.partida) {
    const q = px(estado.partida);
    pins.push(`<div class="pin partida" style="left:${q.x}px;top:${q.y}px" title="Partida"><b>CD</b></div>`);
  }
  $("pins").innerHTML = pins.join("");
}

function enquadrar() {
  const pts = paradasVisiveis();
  if (estado.partida) pts.push(estado.partida);
  if (!pts.length) { render(); return; }

  const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  estado.centro = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };

  const w = $("mapa").clientWidth, h = $("mapa").clientHeight;
  let z = 17;
  while (z > 8) {
    const dx = Math.abs(lng2x(maxLng, z) - lng2x(minLng, z));
    const dy = Math.abs(lat2y(minLat, z) - lat2y(maxLat, z));
    if (dx < w - 80 && dy < h - 80) break;
    z--;
  }
  estado.zoom = z;
  render();
}

/* --- interação --- */
let arrastando = null;

$("mapa").addEventListener("pointerdown", e => {
  arrastando = { x: e.clientX, y: e.clientY, movido: false };
  $("mapa").classList.add("arrastando");
});

window.addEventListener("pointermove", e => {
  if (!arrastando) return;
  const dx = e.clientX - arrastando.x, dy = e.clientY - arrastando.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) arrastando.movido = true;
  arrastando.x = e.clientX;
  arrastando.y = e.clientY;

  const z = estado.zoom;
  const cx = lng2x(estado.centro.lng, z) - dx;
  const cy = lat2y(estado.centro.lat, z) - dy;
  estado.centro = { lat: y2lat(cy, z), lng: x2lng(cx, z) };
  render();
});

window.addEventListener("pointerup", () => {
  $("mapa").classList.remove("arrastando");
  arrastando = null;
});

$("mapa").addEventListener("wheel", e => {
  e.preventDefault();
  const passo = e.deltaY < 0 ? 1 : -1;
  const z2 = Math.max(8, Math.min(18, estado.zoom + passo));
  if (z2 === estado.zoom) return;

  const r = $("mapa").getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const z = estado.zoom;
  const left = lng2x(estado.centro.lng, z) - r.width / 2;
  const top = lat2y(estado.centro.lat, z) - r.height / 2;
  const alvo = { lat: y2lat(top + my, z), lng: x2lng(left + mx, z) };

  // mantém o ponto sob o cursor fixo
  const left2 = lng2x(alvo.lng, z2) - mx;
  const top2 = lat2y(alvo.lat, z2) - my;
  estado.zoom = z2;
  estado.centro = {
    lat: y2lat(top2 + r.height / 2, z2),
    lng: x2lng(left2 + r.width / 2, z2)
  };
  render();
}, { passive: false });

$("pins").addEventListener("click", e => {
  const pin = e.target.closest(".pin");
  if (!pin || !pin.dataset.chave) return;

  // No modo manual o clique entra/sai da rota em vez de abrir a ficha —
  // a ordem dos cliques e a ordem de visita.
  if (estado.manual.ativo) {
    const chave = pin.dataset.chave;
    const i = estado.manual.chaves.indexOf(chave);
    if (i >= 0) estado.manual.chaves.splice(i, 1);
    else estado.manual.chaves.push(chave);
    desenharManual();
    render();
    return;
  }
  abrirPopup(estado.paradas.find(p => p.chave === pin.dataset.chave));
});

$("btn-mais").onclick = () => { estado.zoom = Math.min(18, estado.zoom + 1); render(); };
$("btn-menos").onclick = () => { estado.zoom = Math.max(8, estado.zoom - 1); render(); };
$("btn-fit").onclick = enquadrar;

/* =====================================================================
   POPUP
   ===================================================================== */
function abrirPopup(p) {
  if (!p) return;
  const pedidos = p.pedidos.map(r => `
    <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #e5e7eb">
      <b>#${r.pedido}</b> ${r.valor ? "— R$ " + r.valor.toFixed(2) : ""}
      ${r.pack && r.pack !== r.pedido ? `<br><span class="ids">pacote #${escapar(r.pack)}</span>` : ""}
      ${r.envio_id ? `<span class="ids">envio #${escapar(r.envio_id)}</span>` : ""}
      ${r.conta ? `<span class="etiqueta conta">${escapar(r.conta)}</span>` : ""}
      ${(() => { const q = rotuloPrazo(r.prazo_entrega);
         return q.texto ? `<span class="etiqueta ${q.classe}">${q.texto}</span>` : ""; })()}<br>
      ${escapar(r.quem || r.nome)} ${r.telefone ? "· " + formatarTel(r.telefone) : "· sem telefone"}<br>
      <span style="color:#6b7280">${escapar(r.itens.map(i => i.qtd + "x " + i.titulo).join(" | "))}</span>
    </div>`).join("");

  const wa = p.pedidos.find(r => r.whatsapp)?.whatsapp;
  $("popup").innerHTML = `
    <button class="fechar" id="popup-fechar">×</button>
    <h3>${escapar(p.rua)}</h3>
    <dl>
      <dt>Bairro</dt><dd>${escapar(p.bairro || "—")}</dd>
      <dt>Zona</dt><dd>${escapar(p.zona)}</dd>
      <dt>Envio</dt><dd>${escapar(p.pedidos[0].tipoEnvio || (p.pedidos[0].flex ? "Flex" : "—"))}</dd>
      <dt>Entregar</dt><dd>${escapar(prazoDaParada(p).texto)}</dd>
      <dt>Conta</dt><dd>${escapar(contasDaParada(p).join(" / "))}</dd>
      <dt>CEP</dt><dd>${escapar(p.cep)}</dd>
      ${p.comp ? `<dt>Compl.</dt><dd>${escapar(p.comp)}</dd>` : ""}
    </dl>
    ${pedidos}
    <div class="acoes">
      <a class="botao-link" target="_blank" rel="noreferrer"
         href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.enderecoTexto)}&travelmode=driving">Rota até aqui</a>
      <a class="botao-link secundario" target="_blank" rel="noreferrer"
         href="https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes">Waze</a>
      ${wa ? `<a class="botao-link secundario" target="_blank" rel="noreferrer"
         href="https://wa.me/${wa}">WhatsApp</a>` : ""}
    </div>`;
  $("popup").hidden = false;
  $("popup-fechar").onclick = () => { $("popup").hidden = true; };
}

/*  Prazo de entrega em palavras. O dia tem que ser calculado no fuso de
    Sao Paulo, nao no do servidor nem no UTC: as 22h de SP ja e o dia
    seguinte em UTC, e "amanha" apareceria como "hoje". */
const diaSP = (quando) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(quando ? new Date(quando) : new Date());

function rotuloPrazo(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return { texto: "", classe: "", quando: "" };
  const dia = diaSP(iso);
  const hoje = diaSP();
  const amanha = diaSP(Date.now() + 86400000);

  const hora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
  const comHora = hora === "00:00" ? "" : " " + hora;

  /*  Atrasado e pelo HORARIO, nao so pelo dia: um prazo que venceu as 13h
      de hoje ainda cai na data de hoje, e chamar isso de "hoje" esconderia
      justamente a entrega que estourou. Prazo so com data (00:00) e
      diferente — esse so vence quando o dia acaba. */
  const vencido = comHora ? Date.parse(iso) < Date.now() : dia < hoje;
  if (vencido) return { texto: "atrasado" + comHora, classe: "atrasado", quando: "hoje" };
  if (dia === hoje) return { texto: "hoje" + comHora, classe: "hoje", quando: "hoje" };
  if (dia === amanha) return { texto: "amanha" + comHora, classe: "amanha", quando: "amanha" };
  const curto = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(iso));
  return { texto: curto, classe: "", quando: "depois" };
}

// Uma parada pode juntar pedidos de contas e prazos diferentes: vale o
// mais apertado, que e o que manda na rota.
function prazoDaParada(p) {
  const rotulos = p.pedidos.map(r => rotuloPrazo(r.prazo_entrega)).filter(r => r.texto);
  if (!rotulos.length) return { texto: "sem prazo", classe: "", quando: "" };
  const ordem = { atrasado: 0, hoje: 1, amanha: 2, "": 3 };
  return rotulos.sort((a, b) => (ordem[a.classe] ?? 9) - (ordem[b.classe] ?? 9))[0];
}

const contasDaParada = p => [...new Set(p.pedidos.map(r => r.conta).filter(Boolean))];

const escapar = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const formatarTel = t => t && t.length >= 10 ? `(${t.slice(0, 2)}) ${t.slice(2, -4)}-${t.slice(-4)}` : (t || "");

/* =====================================================================
   ROTAS
   ===================================================================== */
const R_TERRA = 6371;
function distKm(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_TERRA * Math.asin(Math.sqrt(x));
}

// vizinho mais próximo + 2-opt: ordem de visita curta sem depender de API paga
function ordenar(paradas, origem) {
  const restantes = [...paradas];
  const ordem = [];
  let atual = origem || restantes[0];

  while (restantes.length) {
    let melhor = 0;
    for (let i = 1; i < restantes.length; i++) {
      if (distKm(atual, restantes[i]) < distKm(atual, restantes[melhor])) melhor = i;
    }
    atual = restantes.splice(melhor, 1)[0];
    ordem.push(atual);
  }

  const custo = seq => {
    let t = 0;
    let ant = origem || seq[0];
    for (const p of seq) { t += distKm(ant, p); ant = p; }
    return t;
  };

  let melhorou = true, voltas = 0;
  while (melhorou && voltas++ < 40) {
    melhorou = false;
    for (let i = 0; i < ordem.length - 1; i++) {
      for (let j = i + 1; j < ordem.length; j++) {
        const nova = ordem.slice(0, i).concat(ordem.slice(i, j + 1).reverse(), ordem.slice(j + 1));
        if (custo(nova) < custo(ordem) - 0.0001) {
          ordem.splice(0, ordem.length, ...nova);
          melhorou = true;
        }
      }
    }
  }
  return ordem;
}

function gerarRotas() {
  const visiveis = paradasVisiveis();
  const porZona = new Map();

  if ($("juntar-zonas").checked) {
    // Zona vizinha no mesmo sentido vira a mesma rota: ordena tudo junto e
    // deixa a proximidade decidir os trechos, em vez da divisao por zona.
    porZona.set("Zonas ligadas", visiveis);
  } else {
    for (const p of visiveis) {
      if (!porZona.has(p.zona)) porZona.set(p.zona, []);
      porZona.get(p.zona).push(p);
    }
  }

  const maxParadas = Math.max(2, Math.min(23, Number($("max-paradas").value) || 9));
  estado.rotas = [];

  for (const [zona, paradas] of [...porZona].sort((a, b) => b[1].length - a[1].length)) {
    const ordenadas = ordenar(paradas, estado.partida);
    for (let i = 0; i < ordenadas.length; i += maxParadas) {
      const trecho = ordenadas.slice(i, i + maxParadas);
      const anterior = i > 0 ? ordenadas[i - 1] : null;
      estado.rotas.push({
        zona,
        nome: zona + (ordenadas.length > maxParadas ? ` — trecho ${Math.floor(i / maxParadas) + 1}` : ""),
        paradas: trecho,
        origem: i === 0 ? estado.partida : anterior,
        km: kmTotal(trecho, i === 0 ? estado.partida : anterior)
      });
    }
  }

  desenharRotas();
  render();
}

function kmTotal(paradas, origem) {
  let t = 0, ant = origem || paradas[0];
  for (const p of paradas) { t += distKm(ant, p); ant = p; }
  return t;
}

function linkGoogleDe(paradas, origemPonto) {
  const pontos = paradas.map(p => p.enderecoTexto);
  const origem = origemPonto
    ? origemPonto.enderecoTexto || `${origemPonto.lat},${origemPonto.lng}`
    : pontos.shift();
  const destino = pontos.pop();
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("travelmode", "driving");
  u.searchParams.set("origin", origem);
  u.searchParams.set("destination", destino || origem);
  if (pontos.length) u.searchParams.set("waypoints", pontos.join("|"));
  return u.toString();
}

function linkGoogle(rota) {
  return linkGoogleDe(rota.paradas, rota.origem);
}

/*  O Waze nao aceita varias paradas num link — so destino unico. Entao o
    botao da rota abre a PRIMEIRA parada, e cada parada da lista tem o seu
    proprio link para o motorista ir tocando conforme entrega. */
function linkWaze(parada) {
  if (!parada) return "#";
  // No Waze, "ll" navega direto para a coordenada e "q" faz busca por
  // texto. Mandar os dois juntos faz ele BUSCAR perto do ponto em vez de
  // navegar — por isso aqui e um ou outro. navigate=yes so tem efeito no
  // app do celular; no site ele apenas marca o ponto no mapa.
  if (parada.lat && !parada.aprox) {
    return `https://waze.com/ul?ll=${parada.lat},${parada.lng}&navigate=yes&zoom=17`;
  }
  const texto = parada.enderecoTexto || "";
  return texto ? `https://waze.com/ul?q=${encodeURIComponent(texto)}&navigate=yes` : "#";
}

/* =====================================================================
   MODO MOTORISTA
   O Waze nao aceita rota com varias paradas por link — nenhum app
   consegue mandar isso para ele. O que funciona na pratica e navegar
   uma parada por vez: aqui o motorista ve a parada atual em tela cheia,
   toca em Navegar, entrega, marca Entregue e vai para a proxima.
   O progresso fica no proprio celular (localStorage), entao fechar a
   aba ou perder sinal nao apaga o que ja foi entregue.
   ===================================================================== */
function chaveProgresso(rota) {
  return "flex_motorista:" + rota.nome;
}

function lerProgresso(rota) {
  try {
    return Number(localStorage.getItem(chaveProgresso(rota))) || 0;
  } catch {
    return 0;
  }
}

function gravarProgresso(rota, i) {
  try {
    localStorage.setItem(chaveProgresso(rota), String(i));
  } catch {
    /* navegador sem storage: segue sem lembrar */
  }
}

function abrirMotorista(rota) {
  estado.motorista = { rota, i: Math.min(lerProgresso(rota), rota.paradas.length) };
  desenharMotorista();
}

function desenharMotorista() {
  const alvo = $("motorista");
  const m = estado.motorista;
  if (!m) {
    alvo.hidden = true;
    alvo.innerHTML = "";
    return;
  }

  const { rota, i } = m;
  const total = rota.paradas.length;
  const cabecalho = `
    <header>
      <b>${escapar(rota.nome)}</b>
      <span class="contagem">${Math.min(i + 1, total)} de ${total}</span>
      <button id="mot-fechar" title="Sair">&times;</button>
    </header>`;

  if (i >= total) {
    alvo.innerHTML = cabecalho + `
      <div class="mot-corpo">
        <div class="mot-fim">
          <b>Rota concluida</b>
          <p class="mini">${total} paradas entregues.</p>
          <button class="mot-botao" id="mot-recomecar">Recomecar esta rota</button>
        </div>
      </div>`;
    alvo.hidden = false;
    $("mot-fechar").onclick = fecharMotorista;
    $("mot-recomecar").onclick = () => {
      gravarProgresso(rota, 0);
      estado.motorista.i = 0;
      desenharMotorista();
    };
    return;
  }

  const p = rota.paradas[i];
  const pedido = p.pedidos[0];
  const tel = pedido.telefone;

  alvo.innerHTML = cabecalho + `
    <div class="mot-corpo">
      <p class="mot-rua">${escapar(p.rua)}</p>
      <p class="mot-sub">${escapar(p.bairro || "")}${p.cidade ? " · " + escapar(p.cidade) : ""} · ${escapar(p.cep)}</p>
      <dl class="mot-dados">
        ${p.comp ? `<dt>Compl.</dt><dd>${escapar(p.comp)}</dd>` : ""}
        <dt>Entregar</dt><dd><b>${escapar(prazoDaParada(p).texto)}</b></dd>
        <dt>Conta</dt><dd>${escapar(contasDaParada(p).join(" / "))}</dd>
        <dt>Quem recebe</dt><dd>${escapar(p.pedidos.map(r => r.quem || r.nome).join(" / "))}</dd>
        <dt>Pedido</dt><dd>${p.pedidos.map(r => "#" + escapar(r.pedido)).join("<br>")}</dd>
        <dt>Itens</dt><dd>${escapar(p.pedidos.flatMap(r => r.itens.map(it => it.qtd + "x " + it.titulo)).join(" | "))}</dd>
        ${tel ? `<dt>Telefone</dt><dd>${formatarTel(tel)}</dd>` : ""}
      </dl>
      <div class="mot-acoes">
        <a class="mot-botao waze" href="${linkWaze(p)}" target="_blank" rel="noreferrer">Navegar no Waze</a>
        <a class="mot-botao" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.enderecoTexto)}&travelmode=driving"
           target="_blank" rel="noreferrer">Navegar no Google Maps</a>
        ${tel ? `<a class="mot-botao zap" href="https://wa.me/${pedido.whatsapp}" target="_blank" rel="noreferrer">Avisar no WhatsApp</a>` : ""}
        <button class="mot-botao ok" id="mot-entregue">Entregue — proxima parada</button>
        <button class="mot-botao" id="mot-pular">Pular esta parada</button>
      </div>
      <div class="mot-prox">
        Proximas paradas
        <ol>
          ${rota.paradas.map((q, k) => `<li class="${k < i ? "feita" : ""}">${escapar(q.rua)} — ${escapar(q.bairro || "")}</li>`).join("")}
        </ol>
      </div>
    </div>`;
  alvo.hidden = false;

  $("mot-fechar").onclick = fecharMotorista;
  $("mot-entregue").onclick = () => avancarMotorista(1);
  $("mot-pular").onclick = () => avancarMotorista(1);
}

function avancarMotorista(passo) {
  const m = estado.motorista;
  if (!m) return;
  m.i = Math.max(0, m.i + passo);
  gravarProgresso(m.rota, m.i);
  desenharMotorista();
}

function fecharMotorista() {
  estado.motorista = null;
  desenharMotorista();
}

/* ---------- rota manual: o proprio usuario clica a ordem ---------- */
function paradasManuais() {
  return estado.manual.chaves
    .map(c => estado.paradas.find(p => p.chave === c))
    .filter(Boolean);
}

function moverManual(i, passo) {
  const j = i + passo;
  if (j < 0 || j >= estado.manual.chaves.length) return;
  const c = estado.manual.chaves;
  [c[i], c[j]] = [c[j], c[i]];
  desenharManual();
  render();
}

function desenharManual() {
  const alvo = $("rota-manual");
  if (!estado.manual.ativo) {
    alvo.innerHTML = "";
    return;
  }

  const paradas = paradasManuais();
  if (!paradas.length) {
    alvo.innerHTML = `<p class="dica">Clique nos pinos do mapa na ordem em que vai entregar.
      Pode misturar zonas a vontade. Clicar de novo tira a parada da rota.</p>`;
    return;
  }

  const km = kmTotal(paradas, estado.partida);
  alvo.innerHTML = `
    <div class="manual">
      <header>Rota manual <span class="contagem">${paradas.length} paradas · ${km.toFixed(1)} km</span></header>
      <ol>
        ${paradas.map((p, i) => `
          <li>${escapar(p.rua)}
            <span>${p.pedidos.map(r => "#" + escapar(r.pedido)).join(" ")}
              · ${escapar(p.bairro || "")} · ${escapar(p.zona)}
              ${p.pedidos[0].telefone ? " · " + formatarTel(p.pedidos[0].telefone) : ""}<br>
              <span class="etiqueta conta">${escapar(contasDaParada(p).join(" / "))}</span>
              <span class="etiqueta ${prazoDaParada(p).classe}">${escapar(prazoDaParada(p).texto)}</span>
              <button class="mini-btn" data-sobe="${i}" title="Subir">↑</button>
              <button class="mini-btn" data-desce="${i}" title="Descer">↓</button>
              <button class="mini-btn" data-tira="${i}" title="Tirar da rota">×</button>
              <a class="mini-btn" target="_blank" rel="noreferrer" href="${linkWaze(p)}">Waze</a>
            </span>
          </li>`).join("")}
      </ol>
      <div class="acoes">
        <button id="btn-gerar-manual" class="primario">Gerar esta rota</button>
        <a class="botao-link" target="_blank" rel="noreferrer"
           href="${escapar(linkGoogleDe(paradas, estado.partida))}">Abrir no Google Maps</a>
        <a class="botao-link waze" target="_blank" rel="noreferrer"
           href="${linkWaze(paradas[0])}">Waze (1ª parada)</a>
        <button id="btn-imprimir-manual">Imprimir / PDF</button>
        <button id="btn-otimizar">Otimizar ordem</button>
        <button id="btn-limpar-manual">Limpar</button>
      </div>
    </div>`;

  alvo.querySelectorAll("[data-sobe]").forEach(b => (b.onclick = () => moverManual(+b.dataset.sobe, -1)));
  alvo.querySelectorAll("[data-desce]").forEach(b => (b.onclick = () => moverManual(+b.dataset.desce, 1)));
  alvo.querySelectorAll("[data-tira]").forEach(b => (b.onclick = () => {
    estado.manual.chaves.splice(+b.dataset.tira, 1);
    desenharManual();
    render();
  }));
  /*  Gerar: a selecao vira uma rota igual as automaticas — entra na lista
      com km e botao de remover, aparece no CSV nas colunas rota e
      ordem_na_rota, e libera a selecao para voce montar a proxima. */
  $("btn-gerar-manual").onclick = () => {
    const escolhidas = paradasManuais();
    if (!escolhidas.length) return;
    const n = estado.rotas.filter(r => r.manual).length + 1;
    estado.rotas.push({
      zona: "Rota manual",
      nome: "Rota manual " + n,
      paradas: escolhidas,
      origem: estado.partida,
      km: kmTotal(escolhidas, estado.partida),
      manual: true,
    });
    estado.manual.chaves = [];
    desenharManual();
    desenharRotas();
    render();
  };

  $("btn-imprimir-manual").onclick = () =>
    imprimirRotas([{
      nome: "Rota manual",
      paradas: paradasManuais(),
      km: kmTotal(paradasManuais(), estado.partida),
      motorista: "",
    }]);

  $("btn-otimizar").onclick = () => {
    estado.manual.chaves = ordenar(paradasManuais(), estado.partida).map(p => p.chave);
    desenharManual();
    render();
  };
  $("btn-limpar-manual").onclick = () => {
    estado.manual.chaves = [];
    desenharManual();
    render();
  };
}

function desenharRotas() {
  if (!estado.rotas.length) {
    const quantas = paradasVisiveis().length;
    $("rotas").innerHTML = quantas
      ? `<p class="mini">${quantas} paradas no mapa. Clique em “Gerar rotas”.</p>`
      : `<p class="mini">Sem paradas localizadas para montar rota.</p>`;
    return;
  }

  $("rotas").innerHTML = estado.rotas.map((rota, idx) => `
    <div class="rota">
      <header>
        <span class="bolinha" style="background:${corDaZona(rota.zona)}"></span>
        ${escapar(rota.nome)}
        <span class="contagem">${rota.paradas.length} paradas · ${rota.km.toFixed(1)} km</span>
        <button class="mini-btn" data-remove="${idx}" title="Tirar esta rota do mapa">&times;</button>
      </header>
      <ol>
        ${rota.paradas.map(p => `
          <li>${escapar(p.rua)}
            <span>${p.pedidos.map(r => "#" + escapar(r.pedido)).join(" ")}
            · ${escapar(p.bairro || p.region || "")} · ${escapar(p.zona)}
            ${p.pedidos[0].telefone ? " · " + formatarTel(p.pedidos[0].telefone) : ""}<br>
            <span class="etiqueta conta">${escapar(contasDaParada(p).join(" / "))}</span>
            <span class="etiqueta ${prazoDaParada(p).classe}">${escapar(prazoDaParada(p).texto)}</span>
            <a class="mini-btn" target="_blank" rel="noreferrer" href="${linkWaze(p)}">Waze</a></span>
          </li>`).join("")}
      </ol>
      <div class="campos">
        <input data-nome="${idx}" value="${escapar(rota.nome)}" placeholder="nome da rota">
        <input data-motorista="${idx}" value="${escapar(rota.motorista || "")}" placeholder="quem levou">
      </div>
      <div class="acoes">
        <a class="botao-link" target="_blank" rel="noreferrer" href="${escapar(linkGoogle(rota))}">Abrir no Google Maps</a>
        <a class="botao-link waze" target="_blank" rel="noreferrer" href="${linkWaze(rota.paradas[0])}">Waze (1ª parada)</a>
        <button class="btn-motorista" data-rota="${idx}">Modo motorista</button>
        <button class="btn-imprimir-rota" data-rota="${idx}">Imprimir / PDF</button>
        <button class="btn-guardar" data-rota="${idx}">Guardar no historico</button>
        <button class="btn-centrar" data-rota="${idx}">Ver no mapa</button>
      </div>
    </div>`).join("");

  // Tirar uma rota: some a linha do mapa e o card da lista; as paradas
  // continuam no mapa (quem esconde parada e o filtro de zona/conta).
  $("rotas").querySelectorAll("[data-remove]").forEach(b => {
    b.onclick = () => {
      estado.rotas.splice(Number(b.dataset.remove), 1);
      desenharRotas();
      render();
    };
  });

  $("rotas").querySelectorAll("[data-nome]").forEach(i => {
    i.onchange = () => { estado.rotas[Number(i.dataset.nome)].nome = i.value.trim() || "Rota"; };
  });
  $("rotas").querySelectorAll("[data-motorista]").forEach(i => {
    i.onchange = () => { estado.rotas[Number(i.dataset.motorista)].motorista = i.value.trim(); };
  });
  $("rotas").querySelectorAll(".btn-imprimir-rota").forEach(b => {
    b.onclick = () => imprimirRotas([estado.rotas[Number(b.dataset.rota)]]);
  });
  $("rotas").querySelectorAll(".btn-guardar").forEach(b => {
    b.onclick = () => guardarNoHistorico(estado.rotas[Number(b.dataset.rota)], b);
  });

  $("rotas").querySelectorAll(".btn-motorista").forEach(b => {
    b.onclick = () => abrirMotorista(estado.rotas[Number(b.dataset.rota)]);
  });

  $("rotas").querySelectorAll(".btn-centrar").forEach(b => {
    b.onclick = () => {
      const rota = estado.rotas[Number(b.dataset.rota)];
      const lats = rota.paradas.map(p => p.lat), lngs = rota.paradas.map(p => p.lng);
      estado.centro = {
        lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        lng: (Math.min(...lngs) + Math.max(...lngs)) / 2
      };
      estado.zoom = 13;
      render();
    };
  });
}

/* =====================================================================
   CHAMADAS AO SERVIDOR
   Centralizadas para que sessao expirada, servidor reiniciando ou
   resposta que nao e JSON virem um aviso na tela — antes disso a pagina
   simplesmente parava, sem explicar nada a quem estava olhando.
   ===================================================================== */
async function pegarJson(url, opcoes) {
  if (estado.semSessao) return null;
  let res;
  try {
    res = await fetch(url, opcoes);
  } catch (e) {
    avisarFalha("Sem conexao com o servidor. Verifique a internet e recarregue.");
    return null;
  }

  if (res.status === 401 || res.redirected) {
    avisarFalha('Sessao expirada. <a href="/login.html">Entrar de novo</a>.');
    return null;
  }
  const tipo = res.headers.get("content-type") || "";
  if (!tipo.includes("json")) {
    avisarFalha(`O servidor respondeu em formato inesperado (HTTP ${res.status}). ` +
      `<a href="/login.html">Entrar de novo</a> ou recarregar a pagina.`);
    return null;
  }
  try {
    return await res.json();
  } catch (e) {
    avisarFalha("Resposta do servidor veio incompleta. Tente recarregar.");
    return null;
  }
}

function avisarFalha(html) {
  estado.semSessao = true; // para o polling: nao adianta insistir
  const el = $("status");
  el.className = "status erro";
  el.innerHTML = html;
}

/* =====================================================================
   MEMORIA DO DIA
   Guarda a rota como ela saiu — nome, quem levou e a foto das paradas
   com pedidos, cliente e prazo. Depois da para abrir o dia X e ver o que
   foi entregue e por quem, inclusive imprimir a folha de novo.
   ===================================================================== */
async function guardarNoHistorico(rota, botao) {
  if (!rota || !rota.paradas.length) return;
  const texto = botao.textContent;
  botao.disabled = true;
  botao.textContent = "Guardando...";

  const r = await pegarJson("/api/flex/historico", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nome: rota.nome,
      motorista: rota.motorista || "",
      rotas: [{
        nome: rota.nome,
        motorista: rota.motorista || "",
        km: rota.km,
        zona: rota.zona,
        paradas: rota.paradas,
      }],
    }),
  });

  botao.disabled = false;
  botao.textContent = r ? "Guardado" : texto;
  if (r) {
    setTimeout(() => { botao.textContent = texto; }, 2000);
    carregarHistorico();
  }
}

async function carregarHistorico() {
  const lista = await pegarJson("/api/flex/historico");
  if (!lista) return;
  if (!lista.length) {
    $("historico").innerHTML = `<p class="mini">Nenhum dia guardado ainda.</p>`;
    return;
  }

  $("historico").innerHTML = lista.map(item => {
    const dia = String(item.dia).slice(0, 10).split("-").reverse().join("/");
    return `
    <div class="hist-item">
      <div class="corpo">
        <b>${escapar(dia)} · ${escapar(item.nome || "sem nome")}</b>
        <span>${escapar(item.motorista || "sem motorista")} · ${item.paradas} paradas</span>
      </div>
      <div class="acoes">
        <button class="mini-btn" data-ver="${item.id}">ver</button>
        <button class="mini-btn" data-apagar="${item.id}">&times;</button>
      </div>
    </div>`;
  }).join("");

  $("historico").querySelectorAll("[data-ver]").forEach(b => {
    b.onclick = () => abrirHistorico(b.dataset.ver);
  });
  $("historico").querySelectorAll("[data-apagar]").forEach(b => {
    b.onclick = async () => {
      if (!confirm("Apagar este dia do historico?")) return;
      await pegarJson("/api/flex/historico/" + b.dataset.apagar, { method: "DELETE" });
      carregarHistorico();
    };
  });
}

async function abrirHistorico(id) {
  const item = await pegarJson("/api/flex/historico/" + id);
  if (!item) return;

  const rotas = (item.dados?.rotas || []).map(r => ({
    ...r,
    origem: null,
    km: Number(r.km) || 0,
    historico: true,
  }));
  const paradas = rotas.flatMap(r => r.paradas || []);

  estado.historico = { item, paradas };
  estado.rotas = rotas;
  estado.manual = { ativo: false, chaves: [] };

  const dia = String(item.dia).slice(0, 10).split("-").reverse().join("/");
  $("historico-aviso").innerHTML = `<div class="aviso"><b>Vendo o dia ${escapar(dia)}</b>
    ${escapar(item.nome || "")} ${item.motorista ? "· levou: " + escapar(item.motorista) : ""}
    <br><button class="mini-btn" id="btn-sair-hist">voltar para hoje</button></div>`;
  $("btn-sair-hist").onclick = sairDoHistorico;

  desenharRotas();
  desenharManual();
  render();
  enquadrar();
}

function sairDoHistorico() {
  estado.historico = null;
  estado.rotas = [];
  $("historico-aviso").innerHTML = "";
  recalcular();
  enquadrar();
}

/* =====================================================================
   BUSCA
   Varre TODOS os pedidos coletados, nao so os que passam nos filtros —
   senao a busca falha justamente quando o pedido sumiu da tela e voce
   quer entender por que.
   ===================================================================== */
function buscar(termo) {
  const alvo = $("busca-resultados");
  const texto = semAcento(termo).trim();
  if (texto.length < 2) {
    alvo.innerHTML = "";
    estado.achada = null;
    render();
    return;
  }

  const digitos = texto.replace(/[^0-9]/g, "");
  const porDigitos = digitos.length >= 4;

  const achados = (estado.registros || []).filter(r => {
    if (porDigitos) {
      // pedido, pacote e envio: o numero que o usuario copia do ML pode
      // ser qualquer um dos tres
      const campos = [r.pedido, r.pack, r.envio_id, r.telefone, r.cep].map(v =>
        String(v || "").replace(/[^0-9]/g, "")
      );
      if (campos.some(v => v && v.includes(digitos))) return true;
    }
    return [r.nome, r.quem, r.user, r.rua, r.bairro, r.cidade, r.conta]
      .some(v => semAcento(v).includes(texto));
  }).slice(0, 10);

  if (!achados.length) {
    alvo.innerHTML = `<p class="mini">Nada encontrado para “${escapar(termo)}”.</p>`;
    return;
  }

  const visiveis = new Set(estado.paradas.map(p => p.chave));
  alvo.innerHTML = achados.map(r => {
    const chave = chaveDaParada(r);
    const escondido = !visiveis.has(chave);
    return `<button class="resultado${escondido ? " escondido" : ""}" data-chave="${chave}" data-pedido="${r.pedido}">
      <b>#${escapar(r.pedido)} — ${escapar(r.quem || r.nome || "")}</b>
      <span>${escapar(r.rua)} · ${escapar(r.bairro || r.cidade || "")} · ${escapar(r.conta)}
      ${r.pack && r.pack !== r.pedido ? "<br>pacote #" + escapar(r.pack) : ""}
      ${r.envio_id ? " · envio #" + escapar(r.envio_id) : ""}
      ${escondido ? "<br>⚠ fora dos filtros atuais (Flex, cancelada, zona ou conta desligada)" : ""}</span>
    </button>`;
  }).join("");

  alvo.querySelectorAll(".resultado").forEach(b => {
    b.onclick = () => irPara(b.dataset.chave);
  });
}

function irPara(chave) {
  const parada = estado.paradas.find(p => p.chave === chave);
  if (!parada || !parada.lat) {
    estado.achada = null;
    render();
    return;
  }
  estado.achada = chave;
  estado.centro = { lat: parada.lat, lng: parada.lng };
  estado.zoom = Math.max(estado.zoom, 15);
  render();
  abrirPopup(parada);
}

/* =====================================================================
   PAINEL
   ===================================================================== */
function desenharZonas() {
  const cont = new Map();
  for (const p of estado.paradas) {
    const atual = cont.get(p.zona) || { paradas: 0, pedidos: 0, semGeo: 0 };
    atual.paradas++;
    atual.pedidos += p.pedidos.length;
    if (!p.lat) atual.semGeo++;
    cont.set(p.zona, atual);
  }

  $("zonas-filtro").innerHTML = [...cont].sort((a, b) => b[1].pedidos - a[1].pedidos).map(([zona, c]) => `
    <label class="zona-item">
      <input type="checkbox" data-zona="${escapar(zona)}" ${estado.zonasOcultas.has(zona) ? "" : "checked"}>
      <span class="bolinha" style="background:${corDaZona(zona)}"></span>
      ${escapar(zona)}
      <span class="contagem">${c.pedidos} ped.${c.semGeo ? " · " + c.semGeo + " s/ local" : ""}</span>
    </label>`).join("");

  const ligadas = [...cont.keys()].filter(z => !estado.zonasOcultas.has(z)).length;
  $("zonas-rotulo").textContent =
    `Zonas — ${ligadas} de ${cont.size} ligadas`;
  $("zonas-seta").textContent = estado.zonasAbertas ? "▾" : "▸";
  $("zonas-filtro").hidden = !estado.zonasAbertas;

  $("zonas-filtro").querySelectorAll("input").forEach(chk => {
    chk.onchange = () => {
      if (chk.checked) estado.zonasOcultas.delete(chk.dataset.zona);
      else estado.zonasOcultas.add(chk.dataset.zona);
      estado.rotas = [];
      desenharZonas(); // mantem o rotulo "N de M ligadas" em dia
      desenharRotas();
      render();
    };
  });
}

function desenharProblemas() {
  const semGeo = estado.paradas.filter(p => !p.lat);
  const falhas = estado.run?.falhas || [];
  const partes = [];

  if (semGeo.length) {
    partes.push(`<div class="aviso"><b>${semGeo.length} endereço(s) sem localização</b>
      ${semGeo.map(p => escapar(p.rua + " — CEP " + p.cep)).join("<br>")}</div>`);
  }
  const aprox = estado.paradas.filter(p => p.lat && p.aprox);
  if (aprox.length) {
    partes.push(`<div class="aviso"><b>${aprox.length} pino(s) em local aproximado</b>
      Não foi possível achar o número exato; o pino caiu no bairro ou no centro da cidade.<br>
      ${aprox.map(p => escapar(p.rua + " — " + (p.bairro || p.cep))).join("<br>")}</div>`);
  }
  if (falhas.length) {
    partes.push(`<div class="aviso"><b>${falhas.length} pedido(s) não lido(s)</b>
      ${falhas.map(f => escapar("#" + f.pedido + " — " + f.erro)).join("<br>")}</div>`);
  }
  $("problemas").innerHTML = partes.join("") || `<p class="mini">Nada pendente.</p>`;
}

function idadeEmTexto(iso) {
  if (!iso) return "";
  const seg = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seg < 90) return "agora mesmo";
  const min = Math.round(seg / 60);
  if (min < 60) return `ha ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `ha ${h}h${String(min % 60).padStart(2, "0")}` : `ha ${Math.floor(h / 24)} dia(s)`;
}

function desenharStatus() {
  const run = estado.run;
  const el = $("status");
  el.className = "status" + (run?.estado === "erro" ? " erro" : run?.estado === "pronto" ? " ok" : "");

  const carimbo =
    run?.estado === "pronto" && run?.gerado_em
      ? ` · atualizado ${idadeEmTexto(run.gerado_em)}` +
        (run.modo === "incremental" ? " (automatico)" : "")
      : "";
  el.textContent = (run?.mensagem || "Clique em “Puxar pedidos das contas”.") + carimbo;

  const ocupado = run?.estado === "coletando" || run?.estado === "geocodificando";
  $("btn-rodar").disabled = ocupado;
  $("btn-atualizar").disabled = ocupado;
  $("btn-atualizar").textContent = ocupado ? "Atualizando..." : "Atualizar";

  $("contas-resumo").innerHTML = (run?.contas || []).map(c =>
    `${escapar(c.nickname)} — ${c.erro ? "erro: " + escapar(c.erro)
      : `${c.pedidos} a enviar (${c.flex} Flex)` +
        (c.novos ? ` · ${c.novos} novo(s)` : "") +
        (c.sairam ? ` · ${c.sairam} despachado(s)` : "") +
        (c.truncado ? ` <b>— só os ${c.pedidos} mais recentes de ${c.truncado}</b>` : "")}`
  ).join("<br>");
}

/* lista das contas conectadas, com liga/desliga por conta */
async function desenharContas() {
  const contas = await pegarJson("/api/accounts");
  if (!contas) return;
  if (!contas.length) {
    $("contas").innerHTML = `<p class="vazio">Nenhuma conta conectada ainda.</p>`;
    return;
  }
  const porConta = {};
  for (const r of estado.registros || []) porConta[r.conta] = (porConta[r.conta] || 0) + 1;

  $("contas").innerHTML = contas.map(c => `
    <label class="conta-item">
      <input type="checkbox" data-conta="${escapar(c.nickname)}" ${estado.contasOcultas.has(c.nickname) ? "" : "checked"}>
      ${escapar(c.nickname)}
      <span class="contagem">${porConta[c.nickname] || 0} ped.</span>
    </label>`).join("");

  $("contas").querySelectorAll("input").forEach(chk => {
    chk.onchange = () => {
      if (chk.checked) estado.contasOcultas.delete(chk.dataset.conta);
      else estado.contasOcultas.add(chk.dataset.conta);
      recalcular();
    };
  });
}

/* =====================================================================
   EXPORTAR
   ===================================================================== */
const CABECALHO = ["endereco", "titulo", "nome_lalamove", "telefone", "complemento_lalamove",
  "complemento", "produto_completo", "ordem", "nome", "username", "pedido", "nome_loja",
  "frete", "cep", "quem_recebe", "whatsapp", "zona", "rota", "ordem_na_rota",
  "conta", "prazo_entrega", "entregar_em"];

function baixarCSV() {
  const posicao = new Map();
  estado.rotas.forEach(rota => rota.paradas.forEach((p, i) =>
    posicao.set(p.chave, { rota: rota.nome, ordem: i + 1 })));

  const linhas = [];
  const visiveis = new Set(paradasVisiveis().map(p => p.chave));

  for (const p of estado.paradas) {
    if (p.extra) continue; // parada extra nao e pedido: nao entra no CSV do Lalamove
    if (!visiveis.has(p.chave) && estado.rotas.length) continue;
    const pos = posicao.get(p.chave);
    for (const r of p.pedidos) {
      linhas.push([
        r.enderecoCompleto,
        `${r.user} - #${r.pedido}`,
        `${r.nome} - ${r.user}`,
        r.telefone,
        `${r.comp || ""}|#${r.pedido}|${r.prodLala}${r.nome_loja}`,
        r.comp || "",
        r.prodComp,
        pos?.ordem || "1",
        r.nome,
        r.user,
        "#" + r.pedido,
        r.nome_loja,
        "0.00",
        "'" + (r.cep || "").replace(/\D/g, ""),
        r.quem,
        r.whatsapp,
        p.zona,
        pos?.rota || "",
        pos?.ordem || "",
        r.conta || "",
        r.prazo_entrega || "",
        rotuloPrazo(r.prazo_entrega).texto
      ]);
    }
  }

  const csv = [CABECALHO, ...linhas]
    .map(l => l.map(v => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(","))
    .join("\n");

  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" }));
  a.download = `${linhas.length}_FLEX_${new Date().toLocaleDateString("pt-BR").replace(/\//g, "-")}.csv`;
  a.click();
}

/* =====================================================================
   CSV PARA O GOOGLE MY MAPS
   O My Maps importa por colunas de latitude/longitude — e nos ja temos a
   coordenada exata que o Mercado Livre devolveu, entao o pino cai no
   lugar certo sem ele precisar adivinhar pelo endereco. Na importacao,
   escolha "latitude" e "longitude" como posicao e "nome" como titulo.
   ===================================================================== */
function posicaoNasRotas() {
  const pos = new Map();
  estado.rotas.forEach(rota =>
    rota.paradas.forEach((p, i) => pos.set(p.chave, { rota: rota.nome, ordem: i + 1 }))
  );
  return pos;
}

function baixarCSVMyMaps() {
  const pos = posicaoNasRotas();
  const paradas = paradasVisiveis().slice().sort((a, b) => {
    const A = pos.get(a.chave), B = pos.get(b.chave);
    if (A && B) return A.rota === B.rota ? A.ordem - B.ordem : A.rota.localeCompare(B.rota);
    return A ? -1 : B ? 1 : 0;
  });

  const cabecalho = ["nome", "latitude", "longitude", "endereco", "descricao",
    "rota", "ordem", "prazo", "conta", "telefone"];

  const linhas = paradas.map(p => {
    const d = pos.get(p.chave);
    const prazo = prazoDaParada(p).texto;
    const tel = p.pedidos.map(r => r.telefone).filter(Boolean)[0] || "";
    const descricao = [
      p.pedidos.map(r => (r.pedido ? "#" + r.pedido : "")).filter(Boolean).join(" "),
      p.pedidos.map(r => r.quem || r.nome).filter(Boolean).join(" / "),
      tel ? formatarTel(tel) : "sem telefone",
      p.comp || "",
      p.pedidos.flatMap(r => r.itens.map(i => i.qtd + "x " + i.titulo)).join(" | "),
      prazo ? "Entregar: " + prazo : "",
      contasDaParada(p).join(" / "),
    ].filter(Boolean).join(" — ");

    return [
      (d ? d.ordem + " · " : "") + p.rua,
      p.lat, p.lng,
      p.enderecoTexto || p.rua,
      descricao,
      d?.rota || "",
      d?.ordem || "",
      prazo,
      contasDaParada(p).join(" / "),
      tel,
    ];
  });

  /*  Aspas so quando a celula precisa (virgula ou aspas dentro do texto).
      O cabecalho sai limpo: o My Maps rejeita nome de coluna que contenha
      aspas, e envolver tudo em aspas fazia exatamente isso. */
  const celula = (v) => {
    const t = String(v ?? "").replace(/[\r\n]+/g, " ").trim();
    return /[",]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };

  const csv = [
    cabecalho.join(","),
    ...linhas.map(l => l.map(celula).join(",")),
  ].join("\n");

  // sem BOM: ele viraria parte do nome da primeira coluna no My Maps
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  a.download = `mymaps_${linhas.length}_paradas_${new Date().toLocaleDateString("pt-BR").replace(/\//g, "-")}.csv`;
  a.click();
}

/* =====================================================================
   FOLHA DE ROTA (imprimir / salvar em PDF)
   Sem biblioteca de PDF: o navegador ja sabe gerar um, e "Salvar como
   PDF" na janela de impressao resolve — menos uma dependencia num
   servico que nao pode quebrar.
   ===================================================================== */
function imprimirRotas(apenas) {
  // "apenas" vem do botao de uma rota especifica; sem ele, imprime todas
  // (e, se nenhuma rota foi gerada, o que estiver no mapa).
  const rotas = apenas?.length
    ? apenas
    : estado.rotas.length
      ? estado.rotas
      : [{ nome: "Paradas no mapa", paradas: paradasVisiveis(), km: kmTotal(paradasVisiveis(), estado.partida) }];

  if (!rotas[0].paradas.length) {
    alert("Nao ha paradas para imprimir.");
    return;
  }

  const quando = new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

  $("folha").innerHTML = rotas.map(rota => `
    <div class="folha-rota">
      <h2>${escapar(rota.nome)}</h2>
      <p class="sub">${rota.paradas.length} paradas · ${rota.km.toFixed(1)} km
        ${rota.motorista ? "· levou: " + escapar(rota.motorista) : ""}
        ${estado.partida ? "· saindo de " + escapar(estado.partida.enderecoTexto || "") : ""}
        · gerado em ${escapar(quando)}</p>
      <table class="folha-tabela">
        <thead>
          <tr>
            <th class="ok">✓</th><th class="num">#</th><th>Endereco</th>
            <th>Pedido / conta</th><th>Quem recebe</th><th>Entregar</th>
          </tr>
        </thead>
        <tbody>
          ${rota.paradas.map((p, i) => `
            <tr>
              <td class="ok"></td>
              <td class="num">${i + 1}</td>
              <td>
                <b>${escapar(p.rua)}</b>${p.comp ? " — " + escapar(p.comp) : ""}<br>
                ${escapar([p.bairro, p.cidade, p.cep].filter(Boolean).join(" · "))}
                ${p.pedidos.some(r => r.itens.length)
                  ? "<br>" + escapar(p.pedidos.flatMap(r => r.itens.map(it => it.qtd + "x " + it.titulo)).join(" | "))
                  : ""}
              </td>
              <td>${p.pedidos.map(r => (r.pedido ? "#" + escapar(r.pedido) : "")).filter(Boolean).join("<br>")}
                <br>${escapar(contasDaParada(p).join(" / "))}</td>
              <td>${escapar(p.pedidos.map(r => r.quem || r.nome).filter(Boolean).join(" / "))}
                ${p.pedidos[0].telefone ? "<br>" + formatarTel(p.pedidos[0].telefone) : ""}</td>
              <td>${escapar(prazoDaParada(p).texto)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`).join("");

  $("folha").hidden = false;
  const esconder = () => { $("folha").hidden = true; };
  window.addEventListener("afterprint", esconder, { once: true });
  window.print();
  setTimeout(esconder, 1500); // navegador que nao dispara afterprint
}

/* =====================================================================
   PARTIDA (ponto de saída do CD)
   ===================================================================== */
async function definirPartida() {
  const texto = $("partida").value.trim();
  if (!texto) {
    estado.partida = null;
    await pegarJson("/api/flex/config", { method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partida: null }) });
    $("partida-info").textContent = "Sem partida definida — a rota começa na parada mais próxima.";
    estado.rotas = [];
    desenharRotas();
    render();
    return;
  }

  $("partida-info").textContent = "Localizando...";
  const resp = await pegarJson("/api/flex/geocodificar?q=" + encodeURIComponent(texto));
  if (!resp?.ok || !resp.ponto) {
    $("partida-info").textContent = "Não foi possível localizar esse endereço.";
    return;
  }

  estado.partida = { ...resp.ponto, enderecoTexto: texto, chave: "__partida__" };
  await pegarJson("/api/flex/config", { method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partida: estado.partida }) });
  $("partida-info").textContent = `Partida: ${texto}`;
  estado.rotas = [];
  desenharRotas();
  render();
}

/* =====================================================================
   CICLO DE VIDA
   ===================================================================== */
function aplicarRun(run) {
  estado.run = run;
  estado.registros = run?.registros || [];
  estado.paradas = [...montarParadas(filtrarRegistros()), ...paradasExtras()];
  desenharExtras();
  desenharStatus();
  desenharResumoFiltro();
  desenharZonas();
  desenharProblemas();
  if (!estado.rotas.length) desenharRotas();
  render();
}

async function iniciar() {
  $("credito").textContent = PROVEDORES[provedorAtual].credito;

  const cfg = (await pegarJson("/api/flex/config")) || {};
  estado.extras = Array.isArray(cfg.paradas_extras) ? cfg.paradas_extras : [];
  if (cfg.partida) {
    estado.partida = cfg.partida;
    $("partida").value = cfg.partida.enderecoTexto || "";
    $("partida-info").textContent = `Partida: ${cfg.partida.enderecoTexto || ""}`;
  }

  await atualizar(true);

  /*  Abrir a tela ja vale como "atualizar": se o ultimo dado tem mais de
      3 minutos e nao ha coleta em andamento, dispara a incremental (que e
      barata) em vez de mostrar algo de meia hora atras esperando clique. */
  const inicial = estado.run;
  const jaOcupado =
    inicial?.estado === "coletando" || inicial?.estado === "geocodificando";
  const idadeInicial = inicial?.gerado_em
    ? Date.now() - Date.parse(inicial.gerado_em)
    : Infinity;
  if (!estado.semSessao && !jaOcupado && idadeInicial > 3 * 60000) {
    pedirColeta(true);
  }

  /*  Enquanto a coleta roda, acompanha de perto; parada, confere uma vez
      por minuto — e assim a tela percebe a coleta que o servidor fez
      sozinho, sem ninguem clicar em nada. */
  setInterval(() => {
    if (estado.semSessao) return;
    const rodando = estado.run?.estado === "coletando" || estado.run?.estado === "geocodificando";
    const desdeALeitura = Date.now() - (estado.ultimaLeitura || 0);
    if (rodando ? desdeALeitura > 2000 : desdeALeitura > 60000) atualizar(false);
    else if (!rodando) desenharStatus(); // mantem o "atualizado ha X" correndo
  }, 2000);
}

/*  Enquanto a coleta roda no servidor, a tela se atualiza sozinha a cada
    2 segundos; parada, não fica batendo à toa. */
async function atualizar(primeira) {
  const antes = estado.paradas.filter(p => p.lat).length;
  const run = await pegarJson("/api/flex/estado");
  if (!run) return;
  estado.ultimaLeitura = Date.now();

  // Nada mudou no servidor: so acerta o "atualizado ha X" e sai, sem
  // redesenhar o mapa embaixo de quem esta mexendo nele.
  if (!primeira && run.gerado_em === estado.run?.gerado_em && run.estado === estado.run?.estado) {
    desenharStatus();
    return;
  }
  aplicarRun(run);
  await desenharContas();
  const agora = estado.paradas.filter(p => p.lat).length;
  if ((primeira && agora) || (!antes && agora)) enquadrar();
}

async function pedirColeta(incremental) {
  $("btn-atualizar").disabled = true;
  $("btn-rodar").disabled = true;
  const r = await pegarJson("/api/flex/coletar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incremental }),
  });
  if (!r) {
    $("btn-atualizar").disabled = false;
    $("btn-rodar").disabled = false;
    return;
  }
  setTimeout(() => atualizar(false), 600);
}

$("btn-atualizar").onclick = () => pedirColeta(true);
$("btn-rodar").onclick = () => {
  estado.rotas = [];
  pedirColeta(false);
};
let tempoBusca = null;
$("busca").oninput = () => {
  clearTimeout(tempoBusca);
  tempoBusca = setTimeout(() => buscar($("busca").value), 180);
};
$("busca").onkeydown = e => {
  if (e.key === "Enter") {
    const primeiro = $("busca-resultados").querySelector(".resultado");
    if (primeiro) primeiro.click();
  }
};
$("btn-busca-limpar").onclick = () => {
  $("busca").value = "";
  buscar("");
};
$("btn-limpar-rotas").onclick = () => {
  estado.rotas = [];
  desenharRotas();
  render();
};
$("btn-rotas").onclick = gerarRotas;
$("juntar-zonas").onchange = () => { if (estado.rotas.length) gerarRotas(); };
$("btn-manual").onclick = () => {
  estado.manual.ativo = !estado.manual.ativo;
  $("btn-manual").textContent = estado.manual.ativo ? "Sair do modo manual" : "Montar rota manual";
  $("btn-manual").classList.toggle("primario", estado.manual.ativo);
  $("mapa").classList.toggle("escolhendo", estado.manual.ativo);
  desenharManual();
  render();
};
$("btn-historico").onclick = carregarHistorico;
$("btn-zonas").onclick = () => {
  estado.zonasAbertas = !estado.zonasAbertas;
  desenharZonas();
};
$("btn-csv").onclick = baixarCSV;
$("btn-csv-mymaps").onclick = baixarCSVMyMaps;
$("btn-imprimir").onclick = imprimirRotas;
$("btn-json").onclick = async () => {
  await navigator.clipboard.writeText(JSON.stringify(estado.run?.registros || [], null, 2));
  $("btn-json").textContent = "Copiado!";
  setTimeout(() => ($("btn-json").textContent = "Copiar JSON"), 1500);
};
$("btn-partida").onclick = definirPartida;
$("btn-extra").onclick = adicionarExtra;
$("extra-texto").onkeydown = e => { if (e.key === "Enter") adicionarExtra(); };
$("valor-min").onchange = recalcular;
$("so-flex").onchange = recalcular;
$("filtro-prazo").onchange = recalcular;
$("sem-cancelados").onchange = recalcular;
window.addEventListener("resize", render);

iniciar();
