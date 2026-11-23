// Coleta dos pedidos Flex das contas conectadas no painel.
// Reaproveita o que o painel ja tem: lista de contas, renovacao de token e
// busca de pedidos. O unico pedaco proprio e a leitura do envio, porque o
// recurso /shipments quer o cabecalho "x-format-new" — o mlFetch de
// ml/api.js nao manda esse cabecalho e preferi nao mexer nele (mesmo
// motivo do rawGet em routes/prazos.js).
//
// Pipeline: pedido pago -> envio -> endereco do destinatario -> coordenada
// -> zona. O resultado fica em flex_estado para a tela ler.

const db = require("../db");
const { listAccounts, getValidAccessToken } = require("../ml/tokens");
const { fetchRecentOrders, fetchOrderById, fetchResource, USER_AGENT } = require("../ml/api");
const { geocodificar, consultarCep } = require("./geo");
const { classificarZona, extrairCidade } = require("./zonas");

const API_BASE = "https://api.mercadolibre.com";
const so = (s) => (s == null ? "" : String(s)).replace(/\D/g, "");

function tiposFlex() {
  return (process.env.FLEX_LOGISTIC_TYPES || "self_service")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/*  Com nova tentativa: o ML devolve 429 quando a conta ja esta sendo muito
    consultada (as mensagens, reclamacoes e prazos do painel batem na mesma
    cota). Sem isso, um ciclo automatico com dezenas de envios derrubaria
    varios pedidos de uma vez — mesmo cuidado que routes/prazos.js tomou. */
async function buscarEnvio(accessToken, shipmentId, tentativa = 0) {
  try {
    return await buscarEnvioUmaVez(accessToken, shipmentId);
  } catch (e) {
    const transitorio = e.status === 429 || (e.status >= 500 && e.status < 600);
    if (!transitorio || tentativa >= 2) throw e;
    await new Promise((r) => setTimeout(r, 1500 * (tentativa + 1)));
    return buscarEnvio(accessToken, shipmentId, tentativa + 1);
  }
}

async function buscarEnvioUmaVez(accessToken, shipmentId) {
  const res = await fetch(`${API_BASE}/shipments/${shipmentId}`, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "x-format-new": "true",
      // O painel se identifica como aplicativo (ver USER_AGENT em ml/api.js).
      "User-Agent": USER_AGENT,
      "Accept-Language": "pt-BR,pt;q=0.9",
    },
  });
  const texto = await res.text();
  let dados = {};
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = {};
  }
  if (!res.ok) {
    const err = new Error(`shipments/${shipmentId} -> ${res.status} ${texto.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  return dados;
}

/* ---------------- estado (o que a tela le) ---------------- */
async function lerEstado() {
  const { rows } = await db.query("SELECT dados FROM flex_estado WHERE id = 'ultimo'");
  return rows[0]?.dados || { estado: "vazio", registros: [], mensagem: "Nenhuma coleta ainda." };
}

async function salvarEstado(dados) {
  await db.query(
    `INSERT INTO flex_estado (id, dados, atualizado_em) VALUES ('ultimo', $1, now())
     ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now()`,
    [dados]
  );
}

async function lerConfig() {
  const { rows } = await db.query("SELECT dados FROM flex_estado WHERE id = 'config'");
  return rows[0]?.dados || {};
}

async function salvarConfig(patch) {
  const novo = { ...(await lerConfig()), ...patch };
  await db.query(
    `INSERT INTO flex_estado (id, dados, atualizado_em) VALUES ('config', $1, now())
     ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now()`,
    [novo]
  );
  return novo;
}

/* ---------------- endereco do envio ----------------
   Com o cabecalho "x-format-new" o /shipments devolve o endereco em
   destination.shipping_address (e o nome/telefone em destination); o
   formato antigo usa receiver_address direto na raiz. Lemos os dois, e o
   diagnostico mostra qual veio — assim nao dependemos de adivinhar. */
// O telefone aparece como texto ("11 98888-7777") ou como objeto
// ({ area_code, number }) dependendo do formato. Juntar DDD + numero
// importa: so o numero reprovaria na validacao de 10/11 digitos e o
// telefone seria descartado em silencio.
function telefoneDe(v) {
  if (!v) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  const ddd = v.area_code || v.areaCode || "";
  const num = v.number || v.phone_number || "";
  return [ddd, num].filter(Boolean).join("");
}

function enderecoDoEnvio(envio) {
  const dest = envio.destination || {};
  const novo = dest.shipping_address || dest.receiver_address || null;
  const antigo = envio.receiver_address || null;
  const end = novo || antigo || {};
  return {
    end,
    // instrucao que o comprador escreveu na compra ("portao azul",
    // "deixar na portaria") — e o campo mais util que estava sobrando
    comentarios: dest.comments || end.comment || "",
    formato: novo ? "destination.shipping_address" : antigo ? "receiver_address" : "nao encontrado",
    receiverName: dest.receiver_name || end.receiver_name || "",
    receiverPhone:
      telefoneDe(dest.receiver_phone) ||
      telefoneDe(end.receiver_phone) ||
      telefoneDe(end.phone) ||
      telefoneDe(dest.phone) ||
      "",
  };
}

/*  So interessa o que ainda esta para sair: etiqueta a imprimir ou a
    reimprimir. Pedido ja despachado ("a caminho") ou entregue nao entra no
    mapa — nao ha o que roteirizar nele.
    O status manda (ready_to_ship); o substatus separa o que esta pronto
    (ready_to_print / printed) do que ainda nem pode ser impresso. Quando o
    ML nao manda substatus, o pedido entra: esconder algo pendente seria
    pior do que mostrar um a mais. */
function substatusAceitos() {
  return (process.env.FLEX_SUBSTATUS || "ready_to_print,printed")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function etiquetaPendente(envio) {
  const status = String(envio.status || "").toLowerCase();
  const sub = String(envio.substatus || "").toLowerCase();
  if (status !== "ready_to_ship") return false;
  if (!sub) return true;
  return substatusAceitos().includes(sub);
}

/*  Prazo de entrega: o proprio /shipments ja traz lead_time, entao nao
    precisamos da chamada extra em /shipments/{id}/sla que o modulo de
    prazos usa — numa coleta de centenas de pedidos isso dobraria o custo.
    Os nomes de campo variam conforme o tipo de envio, por isso tentamos em
    ordem e guardamos DE QUAL campo veio (prazo_fonte), para conferir com
    dado real em vez de confiar na documentacao.  */
function prazoDoEnvio(envio) {
  const lt = envio.lead_time || {};
  const candidatos = [
    ["estimated_delivery_limit", lt.estimated_delivery_limit?.date],
    ["estimated_delivery_time", lt.estimated_delivery_time?.date],
    ["estimated_delivery_final", lt.estimated_delivery_final?.date],
    ["estimated_handling_limit", lt.estimated_handling_limit?.date],
    ["shipping_option.estimated_delivery_time", envio.shipping_option?.estimated_delivery_time?.date],
  ];
  for (const [fonte, data] of candidatos) {
    if (data && !Number.isNaN(Date.parse(data))) return { data, fonte };
  }
  return { data: "", fonte: "" };
}

/* ---------------- memoria do dia ---------------- */
async function salvarHistorico({ dia, nome, motorista, rotas }) {
  const id = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7);
  const quando = dia || new Date().toISOString().slice(0, 10);
  await db.query(
    `INSERT INTO flex_historico (id, dia, nome, motorista, dados)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, quando, nome || "", motorista || "", { rotas: rotas || [] }]
  );
  return { id, dia: quando, nome, motorista };
}

async function listarHistorico(dias = 60) {
  // o resumo nao carrega o jsonb inteiro: a lista fica leve mesmo com
  // muitos dias guardados
  const { rows } = await db.query(
    `SELECT id, dia, nome, motorista, criado_em,
            jsonb_array_length(dados->'rotas') AS rotas,
            dados->'rotas'->0->>'veiculo' AS veiculo,
            (SELECT COALESCE(SUM(jsonb_array_length(r->'paradas')), 0)
               FROM jsonb_array_elements(dados->'rotas') r) AS paradas
       FROM flex_historico
      WHERE dia >= CURRENT_DATE - $1::int
      ORDER BY dia DESC, criado_em DESC`,
    [dias]
  );
  return rows;
}

async function lerHistorico(id) {
  const { rows } = await db.query("SELECT * FROM flex_historico WHERE id = $1", [id]);
  return rows[0] || null;
}

async function apagarHistorico(id) {
  await db.query("DELETE FROM flex_historico WHERE id = $1", [id]);
}

/* ---------------- montagem de um pedido ---------------- */
async function montarRegistro(conta, pedido, envio, flexTypes) {
  const { end, receiverName, receiverPhone, comentarios } = enderecoDoEnvio(envio);
  const logistic = String(envio.logistic_type || envio.logistic?.type || "").toLowerCase();

  const bairro = end.neighborhood?.name || end.neighborhood || "";
  const cidade = end.city?.name || end.city || "";
  const uf = String(end.state?.id || end.state?.name || end.state || "").replace(/^BR-/, "");
  const cep = end.zip_code || "";
  const rua =
    [end.street_name, end.street_number].filter(Boolean).join(", ") || end.address_line || "";

  let telefone = so(receiverPhone || telefoneDe(pedido.buyer?.phone) || "");
  if (telefone.length > 11 && telefone.startsWith("55")) telefone = telefone.slice(2);
  if (![10, 11].includes(telefone.length)) telefone = "";

  const itens = (pedido.order_items || []).map((it) => {
    const id = it.item?.id ? String(it.item.id) : "";
    return {
      titulo: it.item?.title || "Produto",
      qtd: String(it.quantity ?? 1),
      sku: it.item?.seller_sku || it.item?.seller_custom_field || "",
      preco: it.unit_price != null ? String(it.unit_price) : "",
      // o que ja vinha na resposta e eu descartava:
      item_id: id,
      anuncio: id ? "https://produto.mercadolivre.com.br/" + id.replace(/^MLB/, "MLB-") : "",
      variacao: (it.item?.variation_attributes || [])
        .map((a) => a.name + ": " + a.value_name)
        .join(", "),
      categoria: it.item?.category_id || "",
      tipo_anuncio: it.listing_type_id || "",
      taxa_ml: it.sale_fee != null ? Number(it.sale_fee) : null,
      preco_cheio: it.full_unit_price != null ? Number(it.full_unit_price) : null,
    };
  });

  const lat = end.latitude != null ? Number(end.latitude) : null;
  const lng = end.longitude != null ? Number(end.longitude) : null;
  const prazo = prazoDoEnvio(envio);

  /*  Pagamento, taxa e frete vem dentro do proprio pedido; peso,
      dimensoes, rastreio e metodo de envio, dentro do proprio envio. */
  const pagamentos = pedido.payments || [];
  const pagamento = pagamentos
    .map((p) =>
      [p.payment_method_id, p.installments > 1 ? p.installments + "x" : "", p.status]
        .filter(Boolean)
        .join(" ")
    )
    .join(" | ");
  const freteCobrado =
    Number(pedido.shipping_cost) ||
    pagamentos.reduce((t, p) => t + (Number(p.shipping_cost) || 0), 0) ||
    0;
  const taxaML = itens.reduce((t, i) => t + (Number(i.taxa_ml) || 0), 0);
  const dim = envio.dimensions || {};

  /*  Etiqueta: o ML marca no substatus do envio se ela ja saiu da
      impressora — "ready_to_print" = nunca impressa (botao "Imprimir"),
      "printed" = ja impressa (botao vira "Reimprimir"). Quando a conta
      devolve o historico do envio, pega tambem a hora da 1a impressao. */
  const hist = envio.status_history || envio.shipping_history || {};
  const impressoEm =
    hist.date_first_printed || hist.date_printed || envio.date_first_printed || "";
  const subEnvio = String(envio.substatus || "").toLowerCase();
  const etiqueta =
    String(envio.status || "").toLowerCase() !== "ready_to_ship"
      ? ""
      : subEnvio === "printed" || impressoEm
        ? "reimprimir"
        : "imprimir";

  let info = {};
  if (!bairro || !cidade) info = await consultarCep(so(cep));

  const region = [bairro || info.bairro, cidade || info.cidade].filter(Boolean).join(" - ") +
    (uf || info.uf ? "/" + (uf || info.uf) : "");

  return {
    pedido: String(pedido.id),
    pack: pedido.pack_id ? String(pedido.pack_id) : "",
    // datas do pedido: a coleta incremental usa criado_em para saber o que
    // ja saiu da janela de dias e pode ser descartado
    criado_em: pedido.date_created || "",
    atualizado_em: pedido.date_last_updated || "",
    prazo_entrega: prazo.data,
    prazo_fonte: prazo.fonte,

    // --- extras que ja vinham na resposta da API ---
    comentario_entrega: comentarios, // recado do comprador
    pagamento,
    parcelas: pagamentos[0]?.installments || 1,
    frete_cobrado: freteCobrado,
    taxa_ml: Number(taxaML.toFixed(2)),
    recebido: Number(pedido.paid_amount) || null,
    rastreio: envio.tracking_number || "",
    metodo_envio: envio.lead_time?.shipping_method?.name || "",
    promessa_entrega: envio.lead_time?.estimated_delivery_time?.date || "",
    peso: dim.weight ?? "",
    dimensoes: [dim.height, dim.width, dim.length].filter(Boolean).join("x"),
    tags: (pedido.tags || []).join(" "),
    canal: pedido.context?.channel || "",
    comprador_id: String(pedido.buyer?.id || ""),
    fechado_em: pedido.date_closed || "",
    etiqueta_pendente: etiquetaPendente(envio),
    substatus: envio.substatus || "",
    etiqueta, // "imprimir" | "reimprimir" | "" (ja despachado)
    impresso_em: impressoEm,
    envio_id: String(envio.id || ""),
    conta: conta.nickname,
    conta_id: String(conta.id),
    valor: Number(pedido.total_amount) || null,
    nome:
      [pedido.buyer?.first_name, pedido.buyer?.last_name].filter(Boolean).join(" ") ||
      receiverName ||
      "",
    user: pedido.buyer?.nickname || "",
    quem: receiverName || "",
    telefone,
    whatsapp: telefone ? "55" + telefone : "",
    rua,
    comp: end.comment || end.delivery_preference || "",
    cep,
    bairro: bairro || info.bairro || "",
    cidade: cidade || info.cidade || "",
    uf: uf || info.uf || "SP",
    region,
    enderecoCompleto: [rua, region, cep, "Brasil"].filter(Boolean).join(", "),
    itens,
    prodComp: itens
      .map((p, k) => `${k + 1}_${p.titulo}_Q:${p.qtd}_Pr:${p.preco}-SKU:${p.sku}`)
      .join("| "),
    prodLala: itens.map((p) => `${p.qtd}x${p.titulo.substring(0, 15)}_${p.sku}`).join("|"),
    nome_loja: conta.nickname,
    flex: flexTypes.includes(logistic),
    logistic_type: logistic,
    tipoEnvio: logistic + (envio.substatus ? " · " + envio.substatus : ""),
    statusEnvio: envio.status || "",
    statusLista: [envio.status, envio.substatus].filter(Boolean).join(" / "),
    cancelado: envio.status === "cancelled" || pedido.status === "cancelled",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    geoFonte: Number.isFinite(lat) ? "mercado-livre" : "",
  };
}

/* ---------------- pipeline ---------------- */
let rodando = false;

/* ---------------------------------------------------------------
   JANELA DE LEITURA
   Ate onde para tras a coleta cheia procura pedidos. Era "3 dias
   corridos", e isso nunca serviu para quem nao expede no fim de semana:
   pedido de quinta, com sexta feriado, ja estava fora na segunda e nem
   era lido. Agora conta DIAS UTEIS — sabado, domingo e feriado nao
   contam — e a janela so anda para a frente (nunca encolhe no fim de
   semana), senao um pedido pendente sairia da leitura no domingo e nao
   voltaria na segunda.
   --------------------------------------------------------------- */
// feriados nacionais + os de Sao Paulo (capital/estado) que param a expedicao.
// FLEX_FERIADOS=AAAA-MM-DD,AAAA-MM-DD acrescenta outros (ponto facultativo, etc).
const FERIADOS_PADRAO = [
  // 2026
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-04-03", "2026-04-21", "2026-05-01",
  "2026-06-04", "2026-07-09", "2026-09-07", "2026-10-12", "2026-11-02", "2026-11-20",
  "2026-12-25",
  // 2027
  "2027-01-01", "2027-02-08", "2027-02-09", "2027-03-26", "2027-04-21", "2027-05-27",
  "2027-07-09", "2027-09-07", "2027-10-12", "2027-11-02", "2027-11-15", "2027-12-25",
];

function feriadosAtivos() {
  const extras = String(process.env.FLEX_FERIADOS || "")
    .split(/[,;\s]+/)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return new Set([...FERIADOS_PADRAO, ...extras]);
}

// "AAAA-MM-DD" no fuso de Sao Paulo (as 22h de SP ja e o dia seguinte em UTC)
const diaDeSP = (ms) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));

const somaDias = (iso, n) =>
  new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

const ehDiaUtil = (iso, feriados) => {
  const dow = new Date(iso + "T12:00:00Z").getUTCDay();
  return dow !== 0 && dow !== 6 && !feriados.has(iso);
};

/*  { inicio (ms), chave, descricao }. A "chave" muda quando a configuracao
    muda — e e ela que obriga uma coleta cheia, porque a incremental so
    olha o que mudou e nunca descobriria os pedidos da janela nova. */
function janelaDeLeitura(agora = Date.now(), diasCorridos) {
  const fixo = Number(diasCorridos) || Number(process.env.FLEX_DIAS) || 0;
  const teto = Number(process.env.FLEX_DIAS_MAX) || 14;
  const dataBr = (ms) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })
      .format(new Date(ms));

  if (fixo > 0) {
    const inicio = agora - fixo * 86400000;
    return { inicio, chave: "corridos:" + fixo, descricao: fixo + " dias corridos (desde " + dataBr(inicio) + ")" };
  }

  const uteis = Number(process.env.FLEX_DIAS_UTEIS) || 5;
  const feriados = feriadosAtivos();

  // referencia = hoje, ou o ultimo dia util se hoje nao for (fim de semana/feriado)
  let ref = diaDeSP(agora);
  while (!ehDiaUtil(ref, feriados)) ref = somaDias(ref, -1);

  let dia = ref;
  let contados = 0;
  while (contados < uteis) {
    dia = somaDias(dia, -1);
    if (ehDiaUtil(dia, feriados)) contados++;
  }

  const inicio = Math.max(Date.parse(dia + "T00:00:00-03:00"), agora - teto * 86400000);
  return {
    inicio,
    chave: "uteis:" + uteis + ":" + teto + ":" + [...feriados].filter((d) => d >= dia).length,
    descricao: uteis + " dias uteis (desde " + dataBr(inicio) + ")",
  };
}

/*  Envio que AINDA NAO tem etiqueta mas pode vir a ter: esperando a NF
    (ready_to_ship com substatus diferente de ready_to_print), pending ou
    handling. A etiqueta libera por mudanca no ENVIO — o pedido continua
    com o mesmo date_last_updated, entao a coleta incremental (que so
    pergunta "que pedidos mudaram?") nunca mais olhava para ele. Esses
    ficam numa lista de vigiados, e a cada ciclo so o envio deles e relido
    (1 chamada cada). So Flex: Coleta e agencia nao entram no mapa. */
function vigiavel(envio, flexTypes) {
  const logistic = String(envio.logistic_type || envio.logistic?.type || "").toLowerCase();
  if (!flexTypes.includes(logistic)) return false;
  const status = String(envio.status || "").toLowerCase();
  if (status === "pending" || status === "handling") return true;
  if (status === "ready_to_ship") return !etiquetaPendente(envio);
  return false; // shipped, delivered, cancelled...: acabou
}

function vigiar(mapa, conta, pedido, envioId) {
  const chave = String(pedido.id);
  mapa.set(chave, {
    pedido: chave,
    conta_id: String(conta.id),
    envio_id: String(envioId),
    criado_em: pedido.date_created || "",
    tentativas: mapa.get(chave)?.tentativas || 0,
  });
}

async function coletar({ dias, incremental = false } = {}) {
  if (rodando) return await lerEstado();
  rodando = true;

  const flexTypes = tiposFlex();
  const falhas = [];
  const lidosPorConta = [];

  /*  Coleta incremental: reaproveita o que ja esta guardado e pede ao
      Mercado Livre so os pedidos ALTERADOS desde a rodada anterior.
      Sem isso, cada ciclo automatico refaria uma chamada de envio por
      pedido (foram ~850 na primeira coleta real) e bateria no limite de
      requisicoes — o painel ja levou 429 nos prazos por bem menos.
      A coleta cheia continua existindo: e a do botao e a do primeiro
      ciclo apos o servico subir.  */
  const anterior = await lerEstado();
  const leitura = janelaDeLeitura(Date.now(), dias);
  const limiteJanela = leitura.inicio;

  /*  Incremental so vale se o estado guardado ja tem os cursores por conta
      e a lista de vigiados. Estado de antes desta versao nao tem: cai numa
      coleta cheia, que tambem semeia as duas listas. */
  const podeIncremental =
    incremental &&
    !!anterior?.cursores &&
    // janela de outra configuracao (ou de antes desta versao): a incremental
    // nunca descobriria os pedidos novos dela, entao faz uma cheia
    anterior?.janela?.chave === leitura.chave &&
    Array.isArray(anterior?.vigiados) &&
    Array.isArray(anterior?.registros);

  // parte sempre do que ja esta guardado: se uma conta falhar na leitura,
  // os pedidos dela continuam no mapa em vez de sumirem
  const porPedido = new Map();
  for (const r of anterior?.registros || []) {
    const criado = Date.parse(r.criado_em || "");
    if (!criado || criado >= limiteJanela) porPedido.set(r.pedido, r);
  }

  const vigiados = new Map();
  for (const v of anterior?.vigiados || []) {
    const criado = Date.parse(v.criado_em || "");
    if (!criado || criado >= limiteJanela) vigiados.set(v.pedido, v);
  }

  /*  "Li esta conta ate quando". Um cursor so para a coleta inteira fazia
      uma conta que falhou num ciclo perder, para sempre, os pedidos que
      chegaram antes dele: o ciclo seguinte pedia so "o que mudou desde
      agora". Agora cada conta so avanca o seu cursor quando e lida com
      sucesso. */
  const cursores = { ...(anterior?.cursores || {}) };

  const registros = () => [...porPedido.values()];
  const progresso = (mensagem, estado = "coletando") =>
    salvarEstado({
      estado,
      mensagem,
      registros: registros(),
      falhas,
      contas: lidosPorConta,
      cursores: anterior?.cursores || {}, // so o fim da coleta avanca o cursor
      janela: anterior?.janela,
      vigiados: [...vigiados.values()],
      gerado_em: anterior?.gerado_em || new Date().toISOString(),
    });

  try {
    const contas = await listAccounts();
    if (!contas.length) {
      await salvarEstado({
        estado: "erro",
        registros: [],
        mensagem: "Nenhuma conta conectada. Conecte as contas na tela principal do painel.",
      });
      return await lerEstado();
    }

    // conta que foi desconectada leva os pedidos dela junto
    const idsContas = new Set(contas.map((c) => String(c.id)));
    for (const [k, r] of porPedido) {
      if (r.conta_id && !idsContas.has(String(r.conta_id))) porPedido.delete(k);
    }
    for (const [k, v] of vigiados) if (!idsContas.has(v.conta_id)) vigiados.delete(k);

    for (const conta of contas) {
      await progresso(`Lendo pedidos de ${conta.nickname}...`);
      const contaId = String(conta.id);
      try {
        const token = await getValidAccessToken(conta.id);
        /*  Conta grande tem milhares de pedidos na janela (a VESCO
            SUPRIMENTOS teve 2008 em 3 dias). Com teto baixo, um pedido
            ainda pendente de ontem ficava fora da leitura. O custo so
            aparece na coleta cheia; o ciclo incremental le poucos. */
        const limite = Number(process.env.FLEX_MAX_PEDIDOS) || 3000;

        // conta sem cursor (nova, ou que nunca foi lida com sucesso): cheia
        const cursor = podeIncremental ? cursores[contaId] : null;
        const completa = !cursor;
        // anotado ANTES de buscar: o que mudar durante a leitura entra no proximo ciclo
        const inicioDaLeitura = new Date().toISOString();
        const janela = completa
          ? { dateCreatedFrom: new Date(limiteJanela).toISOString() }
          : { dateLastUpdatedFrom: new Date(Date.parse(cursor) - 5 * 60000).toISOString() };

        const pedidos = [];
        let offset = 0;
        let total = 0;

        while (offset < limite) {
          const r = await fetchRecentOrders(token, conta.id, { limit: 50, offset, ...janela });
          const lote = r.results || [];
          total = r.paging?.total || 0;
          pedidos.push(...lote);
          offset += lote.length;
          if (lote.length < 50 || offset >= total) break;
        }

        const envios = new Map(); // pedidos do mesmo pacote dividem o envio
        const vistos = new Set();
        let novos = 0;
        let descartados = 0;
        let sairam = 0;

        for (let i = 0; i < pedidos.length; i++) {
          const pedido = pedidos[i];
          const chave = String(pedido.id);

          // pago que virou cancelado/devolvido: sai do mapa (antes ficava fantasma)
          if (pedido.status !== "paid") {
            if (porPedido.delete(chave)) sairam++;
            vigiados.delete(chave);
            continue;
          }
          const shipId = pedido.shipping?.id;
          if (!shipId) continue;
          if (i % 5 === 0) {
            await progresso(`${conta.nickname}: pedido ${i + 1} de ${pedidos.length}...`);
          }

          vistos.add(chave);
          vigiados.delete(chave); // e reavaliado logo abaixo

          /*  Entregue nao tem etiqueta para imprimir. Com a janela maior ha
              muito pedido assim, e cada um custaria uma chamada de envio. */
          if ((pedido.tags || []).includes("delivered")) {
            if (porPedido.delete(chave)) sairam++;
            descartados++;
            continue;
          }
          try {
            if (!envios.has(shipId)) envios.set(shipId, await buscarEnvio(token, shipId));
            const envio = envios.get(shipId);
            const reg = await montarRegistro(conta, pedido, envio, flexTypes);
            if (reg.etiqueta_pendente) {
              porPedido.set(reg.pedido, reg);
              novos++;
            } else {
              // Saiu da lista: foi despachado ou entregue desde a ultima
              // rodada. Sem este delete, o pedido ficaria para sempre no
              // mapa, porque a coleta incremental so acrescenta.
              if (porPedido.delete(reg.pedido)) sairam++;
              descartados++;
              // ainda sem etiqueta mas pode liberar (NF pendente): fica de olho
              if (vigiavel(envio, flexTypes)) vigiar(vigiados, conta, pedido, shipId);
            }
          } catch (e) {
            falhas.push({
              conta: conta.nickname,
              pedido: chave,
              erro: String(e?.message || e),
            });
            // nao perde o pedido: o proximo ciclo tenta de novo
            vigiar(vigiados, conta, pedido, shipId);
          }
        }

        if (completa) {
          // leitura cheia: o que nao apareceu saiu da janela (ou do teto) e nao vale mais
          for (const [k, r] of porPedido) {
            if (String(r.conta_id) === contaId && !vistos.has(k)) porPedido.delete(k);
          }
          for (const [k, v] of vigiados) {
            if (v.conta_id === contaId && !vistos.has(k)) vigiados.delete(k);
          }
        } else {
          /*  Vigiados que o ML NAO devolveu como alterados: olha so o envio.
              Se a etiqueta liberou, busca o pedido e entra no mapa. */
          const teto = Number(process.env.FLEX_MAX_VIGIADOS) || 300;
          const meus = [...vigiados.values()].filter(
            (v) => v.conta_id === contaId && !vistos.has(v.pedido)
          );
          for (const v of meus.slice(0, teto)) {
            try {
              if (!envios.has(v.envio_id)) envios.set(v.envio_id, await buscarEnvio(token, v.envio_id));
              const envio = envios.get(v.envio_id);
              if (etiquetaPendente(envio)) {
                const pedido = await fetchOrderById(token, v.pedido);
                const reg = await montarRegistro(conta, pedido, envio, flexTypes);
                if (reg.etiqueta_pendente) {
                  porPedido.set(reg.pedido, reg);
                  novos++;
                }
                vigiados.delete(v.pedido);
              } else if (!vigiavel(envio, flexTypes)) {
                // despachado, entregue ou cancelado antes de liberar a etiqueta
                if (porPedido.delete(v.pedido)) sairam++;
                vigiados.delete(v.pedido);
              }
            } catch (e) {
              v.tentativas = (v.tentativas || 0) + 1;
              if (e.status === 404 || v.tentativas >= 20) vigiados.delete(v.pedido);
              else {
                falhas.push({
                  conta: conta.nickname,
                  pedido: v.pedido,
                  erro: String(e?.message || e),
                });
              }
            }
          }
        }

        cursores[contaId] = inicioDaLeitura; // so aqui: conta lida com sucesso

        lidosPorConta.push({
          nickname: conta.nickname,
          lidos: novos,
          descartados,
          sairam,
          // Conta movimentada tem mais pedidos na janela do que o limite:
          // pegamos os mais recentes (a busca vem ordenada por data desc).
          truncado: completa && total > pedidos.length ? total : 0,
        });
      } catch (e) {
        // o cursor desta conta NAO avanca: o proximo ciclo cobre o buraco
        lidosPorConta.push({ nickname: conta.nickname, erro: String(e?.message || e) });
      }
    }

    /* Coordenada: so para os Flex que ainda nao tem, porque e a etapa cara
       (o servico gratuito aceita 1 consulta por segundo). Num ciclo
       incremental isso costuma ser zero ou um punhado. */
    const paraLocalizar = registros().filter((r) => r.flex && !r.lat);
    if (paraLocalizar.length) {
      await progresso(`Localizando ${paraLocalizar.length} enderecos Flex...`, "geocodificando");
      for (let i = 0; i < paraLocalizar.length; i++) {
        const reg = paraLocalizar[i];
        if (i % 5 === 0) {
          await progresso(
            `Localizando endereco ${i + 1} de ${paraLocalizar.length}...`,
            "geocodificando"
          );
        }
        try {
          const p = await geocodificar(reg);
          if (p) Object.assign(reg, p);
        } catch (e) {
          reg.geoErro = String(e?.message || e);
        }
      }
    }

    const finais = registros();
    for (const reg of finais) {
      if (!reg.flex && !reg.geoFonte) reg.geoFonte = "nao-flex";
      reg.zona = classificarZona(reg);
    }

    /*  O resumo por conta sai do conjunto final, nao so do que foi lido
        agora — senao a tela mostraria "0 pedidos" depois de um ciclo
        incremental em que nada mudou. "novos" e o que entrou nesta rodada. */
    const contasResumo = contas.map((c) => {
      const meus = finais.filter((r) => r.conta === c.nickname);
      const lido = lidosPorConta.find((x) => x.nickname === c.nickname) || {};
      return {
        nickname: c.nickname,
        pedidos: meus.length,
        flex: meus.filter((r) => r.flex).length,
        novos: lido.lidos || 0,
        descartados: lido.descartados || 0,
        sairam: lido.sairam || 0,
        truncado: lido.truncado || 0,
        aguardando: [...vigiados.values()].filter((v) => v.conta_id === String(c.id)).length,
        erro: lido.erro,
      };
    });

    const foraDaLista = contasResumo.reduce((t, c) => t + (c.descartados || 0), 0);
    const doFlex = finais.filter((r) => r.flex);
    const semGeo = doFlex.filter((r) => !r.lat).length;
    await salvarEstado({
      estado: "pronto",
      registros: finais,
      falhas,
      contas: contasResumo,
      cursores,
      vigiados: [...vigiados.values()],
      janela: { desde: new Date(leitura.inicio).toISOString(), chave: leitura.chave, descricao: leitura.descricao },
      gerado_em: new Date().toISOString(),
      modo: podeIncremental ? "incremental" : "completa",
      mensagem:
        `${finais.length} a enviar (${doFlex.length} Flex) de ${contasResumo.length} conta(s) | ` +
        `${doFlex.length - semGeo} Flex no mapa | ${semGeo} sem localizacao | ` +
        `${foraDaLista} ja despachados/entregues | ${falhas.length} falhas` +
        (vigiados.size ? ` | ${vigiados.size} Flex aguardando NF/etiqueta` : "") +
        ` | lendo ${leitura.descricao}`,
    });
  } catch (e) {
    await salvarEstado({
      estado: "erro",
      registros: registros(),
      falhas,
      mensagem: String(e?.message || e),
    });
  } finally {
    rodando = false;
  }

  return await lerEstado();
}

/* ---------------------------------------------------------------
   DIAGNOSTICO — roda primeiro, com poucos pedidos, e responde:
   a API devolve telefone? devolve coordenada? qual logistic_type e o Flex?
   --------------------------------------------------------------- */
async function diagnosticar(conta, quantos = 30, dias = 7) {
  const token = await getValidAccessToken(conta.id);
  const desde = new Date(Date.now() - dias * 86400000).toISOString();

  const pedidos = [];
  let offset = 0;
  while (pedidos.length < quantos) {
    const r = await fetchRecentOrders(token, conta.id, {
      limit: Math.min(50, quantos - pedidos.length),
      offset,
      dateCreatedFrom: desde,
    });
    const lote = r.results || [];
    pedidos.push(...lote);
    offset += lote.length;
    if (lote.length < 50 || offset >= (r.paging?.total || 0)) break;
  }

  // O que interessa e por TIPO DE ENVIO: o Flex (quem entrega e o vendedor)
  // pode receber telefone enquanto os envios que o proprio ML entrega nao.
  // Misturar os dois numa media so esconde a resposta.
  const porTipo = {};
  const amostra = [];

  for (const pedido of pedidos) {
    const shipId = pedido.shipping?.id;
    if (!shipId) continue;
    try {
      const envio = await buscarEnvio(token, shipId);
      const { end, formato, receiverName, receiverPhone } = enderecoDoEnvio(envio);
      const tipo =
        String(envio.logistic_type || envio.logistic?.type || "").toLowerCase() || "(vazio)";

      const t = (porTipo[tipo] = porTipo[tipo] || {
        pedidos: 0,
        com_telefone: 0,
        com_coordenada: 0,
        com_rua_e_numero: 0,
        com_nome_de_quem_recebe: 0,
      });

      const tel = so(receiverPhone);
      t.pedidos++;
      if (tel) t.com_telefone++;
      if (end.latitude != null && end.longitude != null) t.com_coordenada++;
      if (end.street_name && end.street_number) t.com_rua_e_numero++;
      if (receiverName) t.com_nome_de_quem_recebe++;

      // guarda ate 3 exemplos de cada tipo, com as chaves cruas para a
      // hipotese seguinte nao precisar de chute
      if (amostra.filter((a) => a.logistic_type === tipo).length < 3) {
        amostra.push({
          pedido: String(pedido.id),
          logistic_type: tipo,
          logistic_cru: envio.logistic || null,
          formato_do_endereco: formato,
          chaves_do_pedido: Object.keys(pedido).join(", "),
          chaves_do_envio: Object.keys(envio).join(", "),
          etiqueta_estado:
            String(envio.substatus || "").toLowerCase() === "printed"
              ? "ja impressa (reimprimir)"
              : "a imprimir",
          historico_do_envio: JSON.stringify(
            envio.status_history || envio.shipping_history || {}
          ).slice(0, 300),
          chaves_do_destination: Object.keys(envio.destination || {}).join(", "),
          chaves_do_lead_time_detalhe: Object.keys(envio.lead_time || {}).join(", "),
          tem_comentario_do_comprador: !!(envio.destination?.comments || ""),
          tem_pagamento: (pedido.payments || []).length,
          tem_peso: envio.dimensions?.weight ?? "(sem)",
          chaves_do_endereco: Object.keys(end).join(", "),
          status: [envio.status, envio.substatus].filter(Boolean).join(" / "),
          etiqueta_pendente: etiquetaPendente(envio),
          tem_telefone: !!tel,
          telefone_mascarado: tel ? tel.slice(0, 2) + "*****" + tel.slice(-2) : "",
          quem_recebe: receiverName ? receiverName.slice(0, 3) + "..." : "",
          tem_coordenada: end.latitude != null && end.longitude != null,
          prazo_entrega: prazoDoEnvio(envio).data || "(sem prazo)",
          prazo_fonte: prazoDoEnvio(envio).fonte || "(nenhum campo serviu)",
          chaves_do_lead_time: Object.keys(envio.lead_time || {}).join(", "),
          cidade: end.city?.name || "",
        });
      }
    } catch (e) {
      amostra.push({ pedido: String(pedido.id), erro: String(e?.message || e) });
    }
  }

  const flex = tiposFlex();
  const resumoFlex = Object.entries(porTipo)
    .filter(([tipo]) => flex.includes(tipo))
    .reduce(
      (acc, [, v]) => ({
        pedidos: acc.pedidos + v.pedidos,
        com_telefone: acc.com_telefone + v.com_telefone,
        com_coordenada: acc.com_coordenada + v.com_coordenada,
      }),
      { pedidos: 0, com_telefone: 0, com_coordenada: 0 }
    );

  return {
    conta: conta.nickname,
    pedidos_analisados: pedidos.length,
    flex_configurado_como: flex,
    resposta_do_flex: resumoFlex.pedidos
      ? `Dos ${resumoFlex.pedidos} pedidos Flex da amostra: ${resumoFlex.com_telefone} com telefone, ` +
        `${resumoFlex.com_coordenada} com coordenada.`
      : "Nenhum pedido Flex nesta amostra — aumente ?n= ou ?dias= para alcancar algum.",
    por_logistic_type: porTipo,
    amostra,
  };
}

/* =====================================================================
   SONDA DE TELEFONE
   O /shipments novo traz a chave destination.receiver_phone, mas vazia.
   Antes de dar a API como incapaz de entregar o telefone, vale bater nas
   outras portas que o vendedor tem direito de abrir no proprio pedido.
   A sonda tenta todas no MESMO pedido Flex e diz qual devolve digitos.
   Valores sempre mascarados: isso sai numa tela, nao num log privado.
   ===================================================================== */
const mascarar = (t) => {
  const d = so(t);
  return d.length >= 6 ? d.slice(0, 2) + "*".repeat(d.length - 4) + d.slice(-2) : d ? "(curto)" : "";
};

async function chamarCru(caminho, token, cabecalhos = {}) {
  try {
    const res = await fetch(`${API_BASE}${caminho}`, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Accept-Language": "pt-BR,pt;q=0.9",
        ...cabecalhos,
      },
    });
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* pode ser ZPL/PDF */ }
    return { status: res.status, json, texto };
  } catch (e) {
    return { status: 0, erro: String(e?.message || e) };
  }
}

// procura telefone brasileiro em texto solto (etiqueta ZPL, por exemplo)
function telefoneNoTexto(txt) {
  if (!txt) return "";
  // (?<!\d) e (?!\d) impedem que o numero do pedido (16 digitos seguidos)
  // seja confundido com um telefone de 10/11 digitos no meio dele.
  const m = String(txt).match(
    /(?<!\d)(?:\+?55[\s.-]*)?\(?(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})(?!\d)/
  );
  return m ? m[1] + m[2] + m[3] : "";
}

// A etiqueta vem como binario (PDF) ou texto (ZPL). Ler com res.text()
// estraga o binario, por isso aqui e arrayBuffer.
async function baixarEtiqueta(envioId, token, tipo) {
  try {
    const res = await fetch(
      `${API_BASE}/shipment_labels?shipment_ids=${envioId}&response_type=${tipo}`,
      {
        signal: AbortSignal.timeout(25_000),
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
        },
      }
    );
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      buf: Buffer.from(await res.arrayBuffer()),
    };
  } catch (e) {
    return { status: 0, erro: String(e?.message || e) };
  }
}

// Texto legivel de uma etiqueta: ZPL ja e texto; PDF guarda o conteudo em
// streams comprimidos (FlateDecode), que precisam ser inflados antes.
function textoDaEtiqueta(buf) {
  const inicio = buf.subarray(0, 4).toString("latin1");

  if (inicio.startsWith("^XA") || inicio.startsWith("CT~")) {
    return { formato: "ZPL (texto)", texto: buf.toString("latin1") };
  }
  if (inicio === "%PDF") {
    const zlib = require("node:zlib");
    const cru = buf.toString("latin1");
    let saida = "";
    const re = /stream\r?\n([\s\S]*?)endstream/g;
    let m;
    while ((m = re.exec(cru))) {
      const bloco = Buffer.from(m[1], "latin1");
      for (const inflar of [zlib.inflateSync, zlib.inflateRawSync]) {
        try {
          saida += inflar(bloco).toString("latin1");
          break;
        } catch {
          /* stream em outro filtro: ignora */
        }
      }
    }
    return { formato: "PDF (streams descomprimidos)", texto: saida || cru };
  }
  if (inicio.startsWith("PK")) {
    return { formato: "ZIP (nao aberto)", texto: "" };
  }
  return { formato: "desconhecido: " + JSON.stringify(inicio), texto: buf.toString("latin1") };
}

async function sondarTelefone(conta, { pedidoId, dias = 7 } = {}) {
  const token = await getValidAccessToken(conta.id);
  const flex = tiposFlex();

  // 1. acha um pedido Flex (o informado, ou o primeiro da janela)
  let pedido = null;
  let envio = null;

  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const r = await fetchRecentOrders(token, conta.id, { limit: 50, dateCreatedFrom: desde });
  for (const p of r.results || []) {
    if (pedidoId && String(p.id) !== String(pedidoId)) continue;
    if (!p.shipping?.id) continue;
    const e = await buscarEnvio(token, p.shipping.id);
    const tipo = String(e.logistic_type || e.logistic?.type || "").toLowerCase();
    if (pedidoId || flex.includes(tipo)) { pedido = p; envio = e; break; }
  }
  if (!pedido) {
    return { conta: conta.nickname, erro: "Nenhum pedido Flex encontrado na janela. Use ?pedido=<id> ou aumente ?dias=." };
  }

  const envioId = pedido.shipping.id;
  const tentativas = [];

  // fonte 1: o que ja temos (formato novo)
  const brutoNovo = envio.destination?.receiver_phone;
  tentativas.push({
    fonte: "shipments (x-format-new) -> destination.receiver_phone",
    status: 200,
    tipo_do_campo: brutoNovo === null ? "null" : Array.isArray(brutoNovo) ? "array" : typeof brutoNovo,
    conteudo_cru: brutoNovo && typeof brutoNovo === "object" ? Object.keys(brutoNovo).join(", ") : String(brutoNovo ?? ""),
    achou: !!so(telefoneDe(brutoNovo)),
    telefone: mascarar(telefoneDe(brutoNovo)),
  });

  // fonte 2: o MESMO envio no formato antigo (sem x-format-new)
  const legado = await chamarCru(`/shipments/${envioId}`, token);
  const endLegado = legado.json?.receiver_address || {};
  tentativas.push({
    fonte: "shipments SEM x-format-new -> receiver_address.receiver_phone",
    status: legado.status,
    chaves: Object.keys(endLegado).join(", ") || "(sem receiver_address)",
    achou: !!so(telefoneDe(endLegado.receiver_phone || endLegado.phone)),
    telefone: mascarar(telefoneDe(endLegado.receiver_phone || endLegado.phone)),
  });

  // fonte 3: o pedido -> dados do comprador
  const ordem = await chamarCru(`/orders/${pedido.id}`, token);
  const comprador = ordem.json?.buyer || {};
  tentativas.push({
    fonte: "orders/{id} -> buyer.phone / buyer.alternative_phone",
    status: ordem.status,
    chaves: Object.keys(comprador).join(", "),
    achou: !!(so(telefoneDe(comprador.phone)) || so(telefoneDe(comprador.alternative_phone))),
    telefone: mascarar(telefoneDe(comprador.phone) || telefoneDe(comprador.alternative_phone)),
  });

  // fonte 4: a etiqueta de envio, nos dois formatos.
  // A primeira sonda leu a resposta como texto e nao achou nada — mas uma
  // etiqueta em PDF e binario comprimido, entao procurar texto nela nao
  // prova coisa alguma. Aqui ela vem como binario, e o conteudo e
  // descomprimido antes da busca.
  for (const tipo of ["zpl2", "pdf"]) {
    const et = await baixarEtiqueta(envioId, token, tipo);
    const conteudo = et.buf ? textoDaEtiqueta(et.buf) : { formato: "sem resposta", texto: "" };
    const tel = telefoneNoTexto(conteudo.texto);
    tentativas.push({
      fonte: `shipment_labels response_type=${tipo}`,
      status: et.status,
      content_type: et.contentType || "",
      tamanho_bytes: et.buf ? et.buf.length : 0,
      formato_detectado: conteudo.formato,
      texto_extraido_chars: conteudo.texto.length,
      achou: !!tel,
      telefone: mascarar(tel),
    });
    if (tel) break;
  }

  const venceu = tentativas.find((t) => t.achou);
  return {
    conta: conta.nickname,
    pedido: String(pedido.id),
    envio: String(envioId),
    logistic_type: String(envio.logistic_type || envio.logistic?.type || "").toLowerCase(),
    veredito: venceu
      ? `O telefone VEM pela API, em: ${venceu.fonte}`
      : "Nenhuma das fontes devolveu telefone para este pedido Flex.",
    tentativas,
  };
}

/*  Pergunta a propria API, conta por conta, em que pe esta um pedido e
    compara com o que o painel guardou. O numero que a tela de vendas do
    Mercado Livre mostra pode ser do pedido, do PACOTE ou do envio — aceita
    os tres. Responde com um veredito em portugues. */
async function explicarPedido(referencia) {
  const ref = so(referencia);
  if (!ref) return { ok: false, erro: "Informe o numero do pedido, do pacote ou do envio." };

  const estado = await lerEstado();
  const contas = await listAccounts();
  const flexTypes = tiposFlex();
  const leitura = janelaDeLeitura();

  const guardado = (estado.registros || []).find(
    (r) => r.pedido === ref || r.pack === ref || r.envio_id === ref
  );
  const vigiado = (estado.vigiados || []).find((v) => v.pedido === ref || v.envio_id === ref);

  let achado = null;
  const consultadas = [];
  for (const conta of contas) {
    let token;
    try {
      token = await getValidAccessToken(conta.id);
    } catch (e) {
      consultadas.push({ conta: conta.nickname, erro: "sem token: " + String(e?.message || e) });
      continue;
    }

    let pedido = null;
    let envio = null;
    // 1) numero do pedido
    try { pedido = await fetchOrderById(token, ref); } catch { /* outra conta ou outro tipo de numero */ }
    // 2) numero do envio — o envio sabe a qual pedido pertence
    if (!pedido) {
      try {
        envio = await buscarEnvio(token, ref);
        if (envio?.order_id) pedido = await fetchOrderById(token, envio.order_id);
      } catch { /* nao e envio desta conta */ }
    }
    // 3) numero do pacote (o que a tela de vendas costuma mostrar)
    if (!pedido) {
      try {
        const pacote = await fetchResource(token, `/packs/${ref}`);
        const primeiro = pacote?.orders?.[0]?.id;
        if (primeiro) pedido = await fetchOrderById(token, primeiro);
      } catch { /* nao e pacote desta conta */ }
    }

    if (pedido) {
      const envioId = pedido.shipping?.id;
      if (envioId && !envio) {
        try { envio = await buscarEnvio(token, envioId); } catch (e) {
          consultadas.push({ conta: conta.nickname, erro: "envio: " + String(e?.message || e) });
        }
      }
      achado = { conta, pedido, envio };
      break;
    }
    consultadas.push({ conta: conta.nickname, achou: false });
  }

  if (!achado) {
    return {
      ok: true,
      referencia: ref,
      no_painel: !!guardado,
      veredito:
        "Nao achei esse numero em nenhuma das " + contas.length + " conta(s) conectada(s) (" +
        contas.map((c) => c.nickname).join(", ") + "). Ou a conta dona do pedido nao esta " +
        "conectada no painel, ou o numero esta errado.",
      consultadas,
    };
  }

  const { conta, pedido, envio } = achado;
  const logistic = String(envio?.logistic_type || envio?.logistic?.type || "").toLowerCase();
  const eFlex = flexTypes.includes(logistic);
  const pronto = envio ? etiquetaPendente(envio) : false;
  const dentroDaJanela = Date.parse(pedido.date_created || "") >= leitura.inicio;

  let veredito;
  if (guardado) {
    veredito = "Ja esta no painel (conta " + guardado.conta + ", zona " + (guardado.zona || "?") + ")." +
      (guardado.flex ? "" : " Mas nao e Flex, entao so aparece com o filtro 'Somente Flex' desligado.");
  } else if (pedido.status !== "paid") {
    veredito = "O pedido nao esta pago (status '" + pedido.status + "'): o painel so lista pedidos pagos.";
  } else if (!pedido.shipping?.id) {
    veredito = "O pedido nao tem envio associado.";
  } else if (!envio) {
    veredito = "Nao consegui ler o envio na API — veja o campo 'consultadas'.";
  } else if (!eFlex) {
    veredito = "Nao e Flex: o tipo logistico e '" + (logistic || "?") + "'.";
  } else if (!pronto) {
    veredito =
      "O envio esta em '" + envio.status + (envio.substatus ? " / " + envio.substatus : "") +
      "' — ainda sem etiqueta para imprimir (costuma ser NF pendente). " +
      (vigiado
        ? "O painel esta de olho nele e lista assim que a etiqueta liberar."
        : "Vai entrar no painel assim que liberar a etiqueta (na proxima coleta cheia, ou no ciclo se estiver na lista de vigiados).");
  } else if (!dentroDaJanela) {
    veredito =
      "A etiqueta esta pronta, mas o pedido e de " +
      new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })
        .format(new Date(pedido.date_created)) +
      " e a coleta le " + leitura.descricao + ". Aumente FLEX_DIAS_UTEIS no servidor.";
  } else {
    veredito =
      "A etiqueta esta pronta, o pedido e Flex e esta na janela — deveria estar no painel e nao esta. " +
      "Clique em 'recarregar tudo'; se a conta aparecer com aviso de 'so os N mais recentes', o limite " +
      "FLEX_MAX_PEDIDOS cortou este pedido.";
  }

  return {
    ok: true,
    referencia: ref,
    conta: conta.nickname,
    pedido: String(pedido.id),
    pack: pedido.pack_id ? String(pedido.pack_id) : "",
    envio_id: String(pedido.shipping?.id || ""),
    pedido_status: pedido.status,
    criado_em: pedido.date_created,
    dentro_da_janela: dentroDaJanela,
    janela: leitura.descricao,
    envio_status: envio?.status || "",
    envio_substatus: envio?.substatus || "",
    tipo_logistico: logistic,
    e_flex: eFlex,
    etiqueta_pronta: pronto,
    no_painel: !!guardado,
    vigiado: !!vigiado,
    veredito,
    consultadas,
  };
}

module.exports = {
  janelaDeLeitura,
  explicarPedido,
  coletar,
  salvarHistorico,
  listarHistorico,
  lerHistorico,
  apagarHistorico,
  diagnosticar,
  sondarTelefone,
  lerEstado,
  lerConfig,
  salvarConfig,
  montarRegistro,
  tiposFlex,
};
