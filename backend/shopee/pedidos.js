// Shopee — prazos de despacho.
//
// Coletor em memoria (igual ao Prazos do Mercado Livre): a cada 3 min busca,
// em cada loja conectada, os pedidos que ainda nao sairam:
//   READY_TO_SHIP = pago, falta "organizar envio" (gerar etiqueta)
//   PROCESSED     = envio organizado/etiqueta gerada, esperando coleta ou
//                   postagem na agencia
// O prazo vem pronto da Shopee: ship_by_date (data limite para despachar).
// Nao precisa descobrir janela de coleta como no ML.
//
// Coleta x agencia: get_shipping_parameter (1 chamada por pedido, guardada
// em cache — so muda se o vendedor trocar o metodo).
//
// Campos usados sao os da documentacao v2; NAO confirmados com loja real
// (sandbox estava sem pedidos). Tudo com fallback para nao quebrar a tela.

const shopee = require("./api");

const DIA = 24 * 60 * 60;
const INTERVALO_MS = 3 * 60 * 1000;
// "Em risco": falta menos que isso para o prazo.
const MARGEM_RISCO_H = Number(process.env.SHOPEE_MARGEM_RISCO_H || 4);

const estado = {
  atualizadoEm: null,
  rodando: false,
  pedidos: [], // pedidos pendentes de todas as lojas
  saidos: [], // pacotes que JA SAIRAM hoje (coletados/postados) - acumulado do dia
  lojas: {}, // shopId -> { nome, erro, total, atualizadoEm }
};
const cacheModalidade = new Map(); // order_sn -> { modalidade, coletaTexto }

async function listarPorStatus(shopId, status) {
  const sns = [];
  const fim = Math.floor(Date.now() / 1000);
  // Janela maxima da Shopee e 15 dias: 2 janelas = 30 dias de pedidos.
  for (let j = 0; j < 2; j++) {
    const to = fim - j * 15 * DIA;
    const from = to - 15 * DIA + 1;
    let cursor = "";
    for (let pagina = 0; pagina < 20; pagina++) {
      const r = await shopee.chamarLoja(shopId, "/api/v2/order/get_order_list", {
        query: {
          time_range_field: "create_time",
          time_from: from,
          time_to: to,
          page_size: 100,
          cursor,
          order_status: status,
        },
      });
      const resp = r.response || {};
      for (const o of resp.order_list || []) sns.push(o.order_sn);
      if (!resp.more || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }
  }
  return sns;
}

// Pedidos que mudaram de situacao desde "desde" (segundos). Usado para achar
// o que ja foi enviado hoje: depois da coleta o pedido vira SHIPPED e some
// da lista de pendentes.
async function listarAtualizados(shopId, status, desde) {
  const sns = [];
  let cursor = "";
  for (let pagina = 0; pagina < 20; pagina++) {
    const r = await shopee.chamarLoja(shopId, "/api/v2/order/get_order_list", {
      query: {
        time_range_field: "update_time",
        time_from: desde,
        time_to: Math.floor(Date.now() / 1000),
        page_size: 100,
        cursor,
        order_status: status,
      },
    });
    const resp = r.response || {};
    for (const o of resp.order_list || []) sns.push(o.order_sn);
    if (!resp.more || !resp.next_cursor) break;
    cursor = resp.next_cursor;
  }
  return sns;
}

async function detalhar(shopId, sns) {
  const out = [];
  for (let i = 0; i < sns.length; i += 50) {
    const r = await shopee.chamarLoja(shopId, "/api/v2/order/get_order_detail", {
      query: {
        order_sn_list: sns.slice(i, i + 50).join(","),
        response_optional_fields: "buyer_user_id,item_list,package_list,shipping_carrier,pay_time,pickup_done_time,fulfillment_flag",
      },
    });
    out.push(...(r.response?.order_list || []));
  }
  return out;
}

// Coleta (pickup) ou entrega na agencia (dropoff). Pedido ja organizado
// (PROCESSED) nao responde mais isso — fica com o que foi visto antes.
async function modalidade(shopId, orderSn) {
  if (cacheModalidade.has(orderSn)) return cacheModalidade.get(orderSn);
  let info = { modalidade: null, coletaTexto: null };
  try {
    const r = await shopee.chamarLoja(shopId, "/api/v2/logistics/get_shipping_parameter", {
      query: { order_sn: orderSn },
    });
    const precisa = r.response?.info_needed || {};
    const temColeta = Array.isArray(precisa.pickup);
    const temAgencia = Array.isArray(precisa.dropoff);
    info.modalidade = temColeta && !temAgencia ? "coleta" : temAgencia && !temColeta ? "agencia" : temColeta ? "coleta" : null;
    // Primeiro horario de coleta oferecido (se houver).
    const slot = r.response?.pickup?.address_list?.flatMap((a) => a.time_slot_list || [])?.[0];
    if (slot) info.coletaTexto = slot.time_text || (slot.date ? new Date(slot.date * 1000).toISOString() : null);
  } catch {
    // sem info: mostra "—"
  }
  cacheModalidade.set(orderSn, info);
  return info;
}

function montarPedido(shopId, nomeLoja, o) {
  const pacote = (o.package_list || [])[0] || {};
  const itens = (o.item_list || []).map((i) => ({
    nome: i.item_name || i.model_name || `Item ${i.item_id}`,
    variacao: i.model_name || "",
    // SKU real veio com TAB na frente ("	1A789...") em 18/11.
    sku: String(i.model_sku || i.item_sku || "").trim(),
    qtd: Number(i.model_quantity_purchased || i.quantity || 1),
    imagem: i.image_info?.image_url || null,
  }));
  return {
    shopId: String(shopId),
    loja: nomeLoja,
    orderSn: o.order_sn,
    // Para ligar o chat ao pedido (comprador da conversa = to_id).
    compradorId: o.buyer_user_id ? String(o.buyer_user_id) : null,
    status: o.order_status,
    etapa: o.order_status === "READY_TO_SHIP" ? "organizar" : "aguardando",
    prazo: o.ship_by_date ? Number(o.ship_by_date) * 1000 : null,
    diasParaEnviar: o.days_to_ship ?? null,
    criadoEm: o.create_time ? Number(o.create_time) * 1000 : null,
    pagoEm: o.pay_time ? Number(o.pay_time) * 1000 : null,
    transportadora: o.shipping_carrier || pacote.shipping_carrier || "",
    statusLogistica: pacote.logistics_status || "",
    itens,
  };
}

async function coletarLoja(conta) {
  const shopId = String(conta.shop_id);
  const nome = conta.nome || `Loja ${shopId}`;
  const aOrganizar = await listarPorStatus(shopId, "READY_TO_SHIP");
  const aguardando = await listarPorStatus(shopId, "PROCESSED");
  const detalhes = await detalhar(shopId, [...new Set([...aOrganizar, ...aguardando])]);
  const pedidos = [];
  const saidos = new Map(); // order_sn -> saiuEm (ms)
  const hoje = diaSP(Date.now());
  const saiuHoje = (o) => Number(o.pickup_done_time) > 0 && diaSP(Number(o.pickup_done_time) * 1000) === hoje;
  for (const o of detalhes) {
    if (Number(o.pickup_done_time) > 0) {
      // ja saiu
      if (saiuHoje(o)) saidos.set(o.order_sn, Number(o.pickup_done_time) * 1000);
      continue;
    }
    const p = montarPedido(shopId, nome, o);
    // get_shipping_parameter so responde antes de organizar o envio. Na loja
    // real (18/11) quase tudo ja chega PROCESSED — sem isso seriam dezenas de
    // chamadas inuteis por ciclo.
    const m =
      o.order_status === "READY_TO_SHIP" ? await modalidade(shopId, o.order_sn) : cacheModalidade.get(o.order_sn) || {};
    p.modalidade = m.modalidade || null;
    p.coletaTexto = m.coletaTexto || null;
    pedidos.push(p);
  }
  // Ja enviados: o que mudou nas ultimas ~30h e esta SHIPPED (ou ja entregue,
  // no caso de entrega rapida). Conta so os coletados/postados HOJE.
  // Falha aqui nao derruba os pendentes (acumulado e informativo).
  try {
    const desde = Math.floor(Date.now() / 1000) - 30 * 3600;
    const enviados = [];
    for (const st of ["SHIPPED", "TO_CONFIRM_RECEIVE"]) enviados.push(...(await listarAtualizados(shopId, st, desde)));
    const faltam = [...new Set(enviados)].filter((sn) => !saidos.has(sn));
    for (const o of await detalhar(shopId, faltam)) {
      if (saiuHoje(o)) saidos.set(o.order_sn, Number(o.pickup_done_time) * 1000);
    }
  } catch (err) {
    console.error(`[shopee-prazos] enviados hoje ${shopId}:`, err.message);
  }
  return {
    pedidos,
    saidos: [...saidos].map(([orderSn, saiuEm]) => ({ shopId, loja: nome, orderSn, saiuEm })),
  };
}

async function coletar() {
  if (estado.rodando || !shopee.configurado()) return;
  estado.rodando = true;
  try {
    const contas = (await shopee.listarContas()).filter((c) => c.ambiente === shopee.ambiente());
    const todos = [];
    const saidos = [];
    const lojas = {};
    for (const c of contas) {
      const shopId = String(c.shop_id);
      try {
        const { pedidos, saidos: sairam } = await coletarLoja(c);
        todos.push(...pedidos);
        saidos.push(...sairam);
        lojas[shopId] = { nome: c.nome || `Loja ${shopId}`, erro: null, total: pedidos.length, atualizadoEm: Date.now() };
      } catch (err) {
        // Mantem os pedidos da coleta anterior dessa loja: queda momentanea
        // nao pode zerar a tela.
        todos.push(...estado.pedidos.filter((p) => p.shopId === shopId));
        saidos.push(...estado.saidos.filter((p) => p.shopId === shopId));
        lojas[shopId] = { nome: c.nome || `Loja ${shopId}`, erro: err.message, total: null, atualizadoEm: Date.now() };
      }
    }
    estado.pedidos = todos;
    estado.saidos = saidos;
    estado.lojas = lojas;
    estado.atualizadoEm = Date.now();
    // Cache de modalidade so dos pedidos que ainda existem.
    const vivos = new Set(todos.map((p) => p.orderSn));
    for (const sn of cacheModalidade.keys()) if (!vivos.has(sn)) cacheModalidade.delete(sn);
  } catch (err) {
    console.error("[shopee-prazos] erro no ciclo:", err.message);
  } finally {
    estado.rodando = false;
  }
}

function diaSP(ms) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function situacao(p, agora = Date.now()) {
  if (!p.prazo) return "sem_prazo";
  if (p.prazo < agora) return "atrasado";
  if (p.prazo - agora < MARGEM_RISCO_H * 3600 * 1000) return "risco";
  if (diaSP(p.prazo) === diaSP(agora)) return "hoje";
  return "no_prazo";
}

function snapshot() {
  const agora = Date.now();
  return {
    atualizadoEm: estado.atualizadoEm,
    margemRiscoHoras: MARGEM_RISCO_H,
    lojas: estado.lojas,
    // Acumulado do dia: pacotes ja coletados/postados hoje.
    saidosHoje: estado.saidos.filter((s) => diaSP(s.saiuEm) === diaSP(agora)),
    pedidos: estado.pedidos
      .map((p) => ({ ...p, situacao: situacao(p, agora) }))
      .sort((a, b) => (a.prazo || Infinity) - (b.prazo || Infinity)),
  };
}

let timer = null;
function iniciar() {
  if (timer) return;
  // Primeira coleta 20s depois de subir (da tempo do banco ficar pronto).
  setTimeout(() => coletar().catch(() => {}), 20_000);
  timer = setInterval(() => coletar().catch(() => {}), INTERVALO_MS);
}

module.exports = { iniciar, coletar, snapshot, situacao };
