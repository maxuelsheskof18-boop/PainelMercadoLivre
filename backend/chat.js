// Shopee — chat com compradores (SellerChat API).
//
// Diferente das Mensagens do ML, aqui nao se grava nada no banco: a lista
// de conversas e as mensagens vem direto da Shopee na hora (com um cache
// curto), porque o chat da Shopee ja guarda tudo e tem "nao lida" confiavel.
// Na Shopee, pergunta de anuncio (antes da compra) tambem chega pelo chat —
// por isso nao existe um modulo "Perguntas" separado.
//
// Endpoints da doc v2 (sandbox respondeu 200 em get_conversation_list em
// 17/11/2026, sem conversas). Formato das mensagens NAO confirmado com loja
// real: leitura tolerante.

const shopee = require("./api");

const CACHE_LISTA_MS = 15_000;
const cacheLista = new Map(); // shopId -> { em, conversas }

// Timestamps de conversa vem em NANOssegundos (string).
function nanoParaMs(v) {
  const n = Number(v || 0);
  if (!n) return null;
  if (n > 1e17) return Math.floor(n / 1e6); // nano
  if (n > 1e14) return Math.floor(n / 1e3); // micro
  if (n > 1e11) return n; // ms
  return n * 1000; // s
}

function textoDaMensagem(tipo, c = {}) {
  switch (tipo) {
    case "text":
      return c.text || "";
    case "image":
      return "📷 Imagem";
    case "video":
      return "🎬 Vídeo";
    case "sticker":
      return "Figurinha";
    case "item":
    case "product":
      return "🛍️ Produto";
    case "item_list":
    case "product_list":
      return "🛍️ Produtos";
    case "bundle_message":
    case "add_on_deal":
      return "🎁 Promoção";
    case "order":
      return `🧾 Pedido ${c.order_sn || ""}`.trim();
    default:
      return c.text || `[${tipo || "mensagem"}]`;
  }
}

async function conversasDaLoja(conta, { forcar = false } = {}) {
  const shopId = String(conta.shop_id);
  const c = cacheLista.get(shopId);
  if (!forcar && c && Date.now() - c.em < CACHE_LISTA_MS) return c.conversas;

  const conversas = [];
  let nextNano = undefined;
  // Ate 3 paginas de 60 = 180 conversas mais recentes por loja.
  for (let pagina = 0; pagina < 3; pagina++) {
    const r = await shopee.chamarLoja(shopId, "/api/v2/sellerchat/get_conversation_list", {
      query: { direction: "older", type: "all", page_size: 60, next_timestamp_nano: nextNano },
    });
    const resp = r.response || {};
    for (const cv of resp.conversations || []) {
      conversas.push({
        shopId,
        loja: conta.nome || `Loja ${shopId}`,
        id: String(cv.conversation_id),
        compradorId: String(cv.to_id || ""),
        comprador: cv.to_name || "Comprador",
        avatar: cv.to_avatar || null,
        naoLidas: Number(cv.unread_count || 0),
        fixada: Boolean(cv.pinned),
        ultimaEm: nanoParaMs(cv.last_message_timestamp),
        ultimaTexto: textoDaMensagem(cv.latest_message_type, cv.latest_message_content || {}),
        ultimaDoComprador: cv.latest_message_from_id ? String(cv.latest_message_from_id) === String(cv.to_id) : null,
        ultimaMensagemId: cv.latest_message_id ? String(cv.latest_message_id) : null,
      });
    }
    const prox = resp.page_result?.next_cursor?.next_message_time_nano;
    if (!resp.page_result?.more || !prox || prox === "0") break;
    nextNano = prox;
  }
  cacheLista.set(shopId, { em: Date.now(), conversas });
  return conversas;
}

async function listarConversas({ forcar = false } = {}) {
  const contas = (await shopee.listarContas()).filter((c) => c.ambiente === shopee.ambiente());
  const conversas = [];
  const erros = {};
  await Promise.all(
    contas.map(async (c) => {
      try {
        conversas.push(...(await conversasDaLoja(c, { forcar })));
      } catch (err) {
        erros[String(c.shop_id)] = err.message;
      }
    })
  );
  conversas.sort((a, b) => (b.ultimaEm || 0) - (a.ultimaEm || 0));
  return { conversas, erros };
}

async function mensagens(shopId, conversationId, compradorId) {
  const r = await shopee.chamarLoja(shopId, "/api/v2/sellerchat/get_message", {
    query: { conversation_id: conversationId, page_size: 60 },
  });
  const lista = (r.response?.messages || []).map((m) => {
    const c = m.content || {};
    return {
      id: String(m.message_id),
      tipo: m.message_type,
      // from_id do vendedor e o ID de USUARIO dele, diferente do shop_id (visto
      // na loja real em 18/11). Por isso compara com o comprador.
      daLoja: compradorId ? String(m.from_id) !== String(compradorId) : String(m.from_shop_id || "") === String(shopId),
      texto: textoDaMensagem(m.message_type, c),
      // Anexos: foto (url grande + miniatura) e video (miniatura + link).
      // Nomes de campo da doc v2; leitura tolerante (nao confirmados).
      imagem: m.message_type === "image" ? c.url || c.thumb_url || null : null,
      miniatura: m.message_type === "image" || m.message_type === "video" ? c.thumb_url || c.url || null : null,
      video: m.message_type === "video" ? c.video_url || c.url || null : null,
      duracao: c.duration_seconds || null,
      produtos: idsDeProduto(m.message_type, c),
      pedido: c.order_sn || null,
      em: nanoParaMs(m.created_timestamp),
    };
  });
  // Mais antiga primeiro (ordem de leitura).
  lista.sort((a, b) => (a.em || 0) - (b.em || 0));
  return lista;
}

// item_id(s) citados numa mensagem de produto (um ou lista).
function idsDeProduto(tipo, c = {}) {
  const ids = [];
  if (c.item_id || c.itemid) ids.push(c.item_id || c.itemid);
  for (const it of c.item_list || c.items || []) if (it?.item_id || it?.itemid) ids.push(it.item_id || it.itemid);
  return [...new Set(ids.map(String))];
}

// ---------- Contexto da conversa: produtos e pedidos citados ----------
// Junta tudo que da para saber sobre o que o comprador esta falando: os
// anuncios que ele mandou/perguntou e os pedidos citados. Cache de 2 min
// por produto/pedido (a conversa aberta e consultada a cada 8s).
const CACHE_CTX_MS = 2 * 60 * 1000;
const cacheProduto = new Map(); // shop|item -> { em, dado }
const cachePedido = new Map(); // shop|sn -> { em, dado }

async function produtos(shopId, ids) {
  const out = [];
  const faltam = [];
  for (const id of ids) {
    const c = cacheProduto.get(`${shopId}|${id}`);
    if (c && Date.now() - c.em < CACHE_CTX_MS) out.push(c.dado);
    else faltam.push(id);
  }
  for (let i = 0; i < faltam.length; i += 50) {
    const r = await shopee.chamarLoja(shopId, "/api/v2/product/get_item_base_info", {
      query: { item_id_list: faltam.slice(i, i + 50).join(","), need_tax_info: false, need_complaint_policy: false },
    });
    for (const it of r.response?.item_list || []) {
      const preco = (it.price_info || [])[0] || {};
      const estoque = it.stock_info_v2?.summary_info?.total_available_stock ?? (it.stock_info || [])[0]?.current_stock ?? null;
      const dado = {
        itemId: String(it.item_id),
        nome: it.item_name || `Produto ${it.item_id}`,
        imagem: (it.image?.image_url_list || [])[0] || null,
        sku: it.item_sku || "",
        status: it.item_status || null,
        preco: preco.current_price ?? null,
        precoOriginal: preco.original_price ?? null,
        temVariacao: Boolean(it.has_model),
        estoque,
        avaliacao: it.rating_star ?? null,
        link: `https://shopee.com.br/product/${shopId}/${it.item_id}`,
      };
      cacheProduto.set(`${shopId}|${dado.itemId}`, { em: Date.now(), dado });
      out.push(dado);
    }
  }
  // Mantem a ordem em que foram citados.
  return ids.map((id) => out.find((p) => p.itemId === String(id))).filter(Boolean);
}

const STATUS_PEDIDO = {
  UNPAID: "Aguardando pagamento",
  READY_TO_SHIP: "Pago · a organizar envio",
  PROCESSED: "Etiqueta gerada · aguardando envio",
  RETRY_SHIP: "Reenvio",
  SHIPPED: "Enviado",
  TO_CONFIRM_RECEIVE: "Entregue · aguardando confirmação",
  IN_CANCEL: "Cancelamento solicitado",
  CANCELLED: "Cancelado",
  TO_RETURN: "Devolução",
  COMPLETED: "Concluído",
  INVOICE_PENDING: "Nota fiscal pendente",
};

async function pedidos(shopId, sns) {
  const out = [];
  for (const sn of sns) {
    const c = cachePedido.get(`${shopId}|${sn}`);
    if (c && Date.now() - c.em < CACHE_CTX_MS) {
      out.push(c.dado);
      continue;
    }
    const r = await shopee.chamarLoja(shopId, "/api/v2/order/get_order_detail", {
      query: {
        order_sn_list: sn,
        response_optional_fields:
          "item_list,package_list,shipping_carrier,pay_time,pickup_done_time,total_amount,payment_method,note,edt,cancel_reason,buyer_cancel_reason",
      },
    });
    const o = (r.response?.order_list || [])[0];
    if (!o) continue;
    let rastreio = null;
    if (["PROCESSED", "SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED"].includes(o.order_status)) {
      try {
        const t = await shopee.chamarLoja(shopId, "/api/v2/logistics/get_tracking_number", { query: { order_sn: sn } });
        rastreio = t.response?.tracking_number || null;
      } catch {}
    }
    const dado = {
      orderSn: o.order_sn,
      status: o.order_status,
      statusTexto: STATUS_PEDIDO[o.order_status] || o.order_status,
      total: o.total_amount ?? null,
      pagamento: o.payment_method || null,
      criadoEm: o.create_time ? o.create_time * 1000 : null,
      pagoEm: o.pay_time ? o.pay_time * 1000 : null,
      enviarAte: o.ship_by_date ? o.ship_by_date * 1000 : null,
      saiuEm: o.pickup_done_time ? o.pickup_done_time * 1000 : null,
      entregaPrevista: o.edt_to ? o.edt_to * 1000 : o.edt_from ? o.edt_from * 1000 : null,
      transportadora: o.shipping_carrier || "",
      rastreio,
      mensagemComprador: o.message_to_seller || "",
      cancelamento: o.cancel_reason || o.buyer_cancel_reason || "",
      itens: (o.item_list || []).map((i) => ({
        itemId: String(i.item_id),
        nome: i.item_name,
        variacao: i.model_name || "",
        sku: String(i.model_sku || i.item_sku || "").trim(),
        qtd: Number(i.model_quantity_purchased || 1),
        preco: i.model_discounted_price ?? i.model_original_price ?? null,
        imagem: i.image_info?.image_url || null,
      })),
    };
    cachePedido.set(`${shopId}|${sn}`, { em: Date.now(), dado });
    out.push(dado);
  }
  return out;
}

async function contexto(shopId, conversationId, compradorId) {
  const msgs = await mensagens(shopId, conversationId, compradorId);
  // Mais recentes primeiro: o que o comprador falou por ultimo e o mais relevante.
  const idsProd = [...new Set(msgs.slice().reverse().flatMap((m) => m.produtos))].slice(0, 10);
  const sns = [...new Set(msgs.slice().reverse().map((m) => m.pedido).filter(Boolean))].slice(0, 5);
  const [prod, ped] = await Promise.allSettled([produtos(shopId, idsProd), pedidos(shopId, sns)]);
  // Produtos dos pedidos tambem viram cartao (foto/estoque/link do anuncio).
  const pedidosOk = ped.status === "fulfilled" ? ped.value : [];
  const extras = [...new Set(pedidosOk.flatMap((p) => p.itens.map((i) => i.itemId)))].filter((id) => !idsProd.includes(id)).slice(0, 10);
  let prodPedidos = [];
  if (extras.length) {
    try {
      prodPedidos = await produtos(shopId, extras);
    } catch {}
  }
  return {
    produtos: prod.status === "fulfilled" ? prod.value : [],
    produtosDosPedidos: prodPedidos,
    pedidos: pedidosOk,
    erros: [prod, ped].filter((x) => x.status === "rejected").map((x) => x.reason.message),
  };
}

async function enviar(shopId, compradorId, texto) {
  const r = await shopee.chamarLoja(shopId, "/api/v2/sellerchat/send_message", {
    metodo: "POST",
    corpo: { to_id: Number(compradorId), message_type: "text", content: { text: texto } },
  });
  cacheLista.delete(String(shopId));
  return r.response || {};
}

async function marcarLida(shopId, conversationId, ultimaMensagemId) {
  if (!ultimaMensagemId) return;
  await shopee.chamarLoja(shopId, "/api/v2/sellerchat/read_conversation", {
    metodo: "POST",
    corpo: { conversation_id: conversationId, last_read_message_id: ultimaMensagemId },
  });
  cacheLista.delete(String(shopId));
}

module.exports = { listarConversas, mensagens, contexto, enviar, marcarLida };
