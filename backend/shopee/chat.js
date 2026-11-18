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
      return "🛍️ Produto enviado";
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
  const lista = (r.response?.messages || []).map((m) => ({
    id: String(m.message_id),
    tipo: m.message_type,
    // from_id do vendedor e o ID de USUARIO dele, diferente do shop_id (visto
    // na loja real em 18/11). Por isso compara com o comprador.
    daLoja: compradorId ? String(m.from_id) !== String(compradorId) : String(m.from_shop_id || "") === String(shopId),
    texto: textoDaMensagem(m.message_type, m.content || {}),
    imagem: m.message_type === "image" ? m.content?.url || m.content?.thumb_url || null : null,
    pedido: m.content?.order_sn || null,
    em: nanoParaMs(m.created_timestamp),
  }));
  // Mais antiga primeiro (ordem de leitura).
  lista.sort((a, b) => (a.em || 0) - (b.em || 0));
  return lista;
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

module.exports = { listarConversas, mensagens, enviar, marcarLida };
