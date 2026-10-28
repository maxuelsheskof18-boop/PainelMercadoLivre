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
const { fetchRecentOrders } = require("../ml/api");
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

async function buscarEnvio(accessToken, shipmentId) {
  const res = await fetch(`${API_BASE}/shipments/${shipmentId}`, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "x-format-new": "true",
      // Mesmo motivo documentado em ml/api.js: sem User-Agent de navegador o
      // ML bloqueia como "robo" (403 PolicyAgent).
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
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

/* ---------------- montagem de um pedido ---------------- */
async function montarRegistro(conta, pedido, envio, flexTypes) {
  const { end, receiverName, receiverPhone } = enderecoDoEnvio(envio);
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

  const itens = (pedido.order_items || []).map((it) => ({
    titulo: it.item?.title || "Produto",
    qtd: String(it.quantity ?? 1),
    sku: it.item?.seller_sku || it.item?.seller_custom_field || "",
    preco: it.unit_price != null ? String(it.unit_price) : "",
  }));

  const lat = end.latitude != null ? Number(end.latitude) : null;
  const lng = end.longitude != null ? Number(end.longitude) : null;

  let info = {};
  if (!bairro || !cidade) info = await consultarCep(so(cep));

  const region = [bairro || info.bairro, cidade || info.cidade].filter(Boolean).join(" - ") +
    (uf || info.uf ? "/" + (uf || info.uf) : "");

  return {
    pedido: String(pedido.id),
    pack: pedido.pack_id ? String(pedido.pack_id) : "",
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

async function coletar({ dias = Number(process.env.FLEX_DIAS) || 3 } = {}) {
  if (rodando) return await lerEstado();
  rodando = true;

  const flexTypes = tiposFlex();
  const registros = [];
  const falhas = [];
  const resumoContas = [];

  const progresso = (mensagem, estado = "coletando") =>
    salvarEstado({
      estado,
      mensagem,
      registros,
      falhas,
      contas: resumoContas,
      gerado_em: new Date().toISOString(),
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

    const desde = new Date(Date.now() - dias * 86400000).toISOString();

    for (const conta of contas) {
      await progresso(`Lendo pedidos de ${conta.nickname}...`);
      try {
        const token = await getValidAccessToken(conta.id);
        const limite = Number(process.env.FLEX_MAX_PEDIDOS) || 400;
        const pedidos = [];
        let offset = 0;
        let total = 0;

        while (offset < limite) {
          const r = await fetchRecentOrders(token, conta.id, {
            limit: 50,
            offset,
            dateCreatedFrom: desde,
          });
          const lote = r.results || [];
          total = r.paging?.total || 0;
          pedidos.push(...lote);
          offset += lote.length;
          if (lote.length < 50 || offset >= total) break;
        }

        const envios = new Map(); // pedidos do mesmo pacote dividem o envio
        let doFlex = 0;

        for (let i = 0; i < pedidos.length; i++) {
          const pedido = pedidos[i];
          if (pedido.status !== "paid") continue;
          const shipId = pedido.shipping?.id;
          if (!shipId) continue;
          if (i % 5 === 0) {
            await progresso(`${conta.nickname}: pedido ${i + 1} de ${pedidos.length}...`);
          }
          try {
            if (!envios.has(shipId)) envios.set(shipId, await buscarEnvio(token, shipId));
            const reg = await montarRegistro(conta, pedido, envios.get(shipId), flexTypes);
            registros.push(reg);
            if (reg.flex) doFlex++;
          } catch (e) {
            falhas.push({
              conta: conta.nickname,
              pedido: String(pedido.id),
              erro: String(e?.message || e),
            });
          }
        }

        resumoContas.push({
          nickname: conta.nickname,
          pedidos: pedidos.length,
          flex: doFlex,
          // Conta movimentada tem mais pedidos na janela do que o limite:
          // pegamos os mais recentes (a busca vem ordenada por data desc).
          truncado: total > pedidos.length ? total : 0,
        });
      } catch (e) {
        resumoContas.push({ nickname: conta.nickname, erro: String(e?.message || e) });
      }
    }

    /* Coordenada: so para os Flex, que sao os que vao para o mapa. O
       servico gratuito aceita 1 consulta por segundo — geocodificar os 800+
       pedidos de todos os tipos levaria mais de dez minutos a toa. */
    const paraLocalizar = registros.filter((r) => r.flex);
    await progresso(`Localizando ${paraLocalizar.length} enderecos Flex...`, "geocodificando");

    for (let i = 0; i < paraLocalizar.length; i++) {
      const reg = paraLocalizar[i];
      if (i % 5 === 0) {
        await progresso(
          `Localizando endereco ${i + 1} de ${paraLocalizar.length}...`,
          "geocodificando"
        );
      }
      if (!reg.lat) {
        try {
          const p = await geocodificar(reg);
          if (p) Object.assign(reg, p);
        } catch (e) {
          reg.geoErro = String(e?.message || e);
        }
      }
    }
    for (const reg of registros) {
      if (!reg.flex && !reg.geoFonte) reg.geoFonte = "nao-flex";
      reg.zona = classificarZona(reg);
    }

    const semGeo = paraLocalizar.filter((r) => !r.lat).length;
    const totalFlex = paraLocalizar.length;
    await salvarEstado({
      estado: "pronto",
      registros,
      falhas,
      contas: resumoContas,
      gerado_em: new Date().toISOString(),
      mensagem:
        `${registros.length} pedidos (${totalFlex} Flex) de ${resumoContas.length} conta(s) | ` +
        `${totalFlex - semGeo} Flex no mapa | ${semGeo} sem localizacao | ${falhas.length} falhas`,
    });
  } catch (e) {
    await salvarEstado({
      estado: "erro",
      registros,
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
          chaves_do_destination: Object.keys(envio.destination || {}).join(", "),
          chaves_do_endereco: Object.keys(end).join(", "),
          status: [envio.status, envio.substatus].filter(Boolean).join(" / "),
          tem_telefone: !!tel,
          telefone_mascarado: tel ? tel.slice(0, 2) + "*****" + tel.slice(-2) : "",
          quem_recebe: receiverName ? receiverName.slice(0, 3) + "..." : "",
          tem_coordenada: end.latitude != null && end.longitude != null,
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
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
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

  // fonte 4: a etiqueta de envio (o vendedor imprime ela com o telefone)
  const etiqueta = await chamarCru(
    `/shipment_labels?shipment_ids=${envioId}&response_type=zpl2`,
    token,
    { Accept: "text/plain" }
  );
  const telEtiqueta = telefoneNoTexto(etiqueta.texto);
  tentativas.push({
    fonte: "shipment_labels (ZPL da etiqueta)",
    status: etiqueta.status,
    tamanho_resposta: etiqueta.texto ? etiqueta.texto.length : 0,
    achou: !!telEtiqueta,
    telefone: mascarar(telEtiqueta),
  });

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

module.exports = {
  coletar,
  diagnosticar,
  sondarTelefone,
  lerEstado,
  lerConfig,
  salvarConfig,
  montarRegistro,
  tiposFlex,
};
