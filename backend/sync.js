// Le uma conversa (pack) devolvida pela API do Mercado Livre e grava/atualiza
// as tabelas locais (conversations + messages), decidindo se ela fica
// "pending" (aguardando resposta do vendedor) ou "answered".
const db = require("./db");
const { fetchPackMessages, fetchRecentOrders } = require("./ml/api");
const { getValidAccessToken } = require("./ml/tokens");

// Quantos pedidos recentes verificar por conta a cada reconciliacao. O
// Mercado Livre nao tem mais (ou nunca teve de forma confiavel, pra essa
// aplicacao) um endpoint que liste so os pedidos com mensagem pendente —
// confirmamos isso testando ao vivo. Em vez disso, olhamos os N pedidos
// mais recentes e checamos as mensagens de cada um. Isso cobre bem o caso
// de uso (webhooks cuidam do tempo real; isso aqui e so uma rede de
// seguranca), mas nao alcanca um pedido de "combinar entrega" muito antigo
// que ja saiu dessa janela — se isso acontecer, aumente esse numero.
const RECENT_ORDERS_LIMIT = 50;

function messageDate(msg) {
  return (
    msg?.message_date?.received ||
    msg?.message_date?.available ||
    msg?.message_date?.created ||
    msg?.message_date?.notified ||
    null
  );
}

async function upsertConversationFromPack(sellerId, packId, packData, orderId) {
  const messages = Array.isArray(packData?.messages) ? [...packData.messages] : [];

  // Ordena por data (mais antiga -> mais recente). Se a data vier vazia,
  // mantem a ordem original devolvida pela API.
  messages.sort((a, b) => {
    const da = messageDate(a);
    const db_ = messageDate(b);
    if (!da || !db_) return 0;
    return new Date(da) - new Date(db_);
  });

  const last = messages[messages.length - 1];
  if (!last) return; // conversa sem mensagens ainda, nada a fazer

  const sellerIdStr = String(sellerId);
  const lastFromId = String(last?.from?.user_id ?? "");
  const isLastFromSeller = lastFromId === sellerIdStr;
  const status = isLastFromSeller ? "answered" : "pending";

  // Descobre quem e o comprador: o participante que nao e o vendedor.
  let buyerId = null;
  for (const m of messages) {
    const fromId = String(m?.from?.user_id ?? "");
    const toId = String(m?.to?.user_id ?? "");
    if (fromId && fromId !== sellerIdStr) buyerId = fromId;
    if (toId && toId !== sellerIdStr) buyerId = buyerId || toId;
  }

  const buyerNickname = packData?.buyer?.nickname || null;

  await db.query(
    `INSERT INTO conversations
       (pack_id, seller_id, order_id, buyer_id, buyer_nickname, last_message_text, last_message_date, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (pack_id) DO UPDATE SET
       order_id = EXCLUDED.order_id,
       buyer_id = COALESCE(EXCLUDED.buyer_id, conversations.buyer_id),
       buyer_nickname = COALESCE(EXCLUDED.buyer_nickname, conversations.buyer_nickname),
       last_message_text = EXCLUDED.last_message_text,
       last_message_date = EXCLUDED.last_message_date,
       status = EXCLUDED.status,
       updated_at = now()`,
    [
      String(packId),
      sellerIdStr,
      orderId || null,
      buyerId,
      buyerNickname,
      last?.text || null,
      messageDate(last),
      status,
    ]
  );

  const { rows: existingRows } = await db.query(
    "SELECT message_id FROM messages WHERE pack_id = $1",
    [String(packId)]
  );
  const existing = new Set(existingRows.map((r) => r.message_id));

  for (const m of messages) {
    const id = m?.id ? String(m.id) : null;
    if (id && existing.has(id)) continue; // ja gravada
    const fromId = String(m?.from?.user_id ?? "");
    await db.query(
      `INSERT INTO messages (pack_id, message_id, direction, author_user_id, text, sent_date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(packId),
        id,
        fromId === sellerIdStr ? "out" : "in",
        fromId || null,
        m?.text || null,
        messageDate(m),
      ]
    );
  }
}

// Puxa uma conversa especifica (usado pelo webhook, que ja sabe o pack_id).
async function syncPack(sellerId, packId, orderId) {
  const accessToken = await getValidAccessToken(sellerId);
  const packData = await fetchPackMessages(accessToken, packId, sellerId);
  await upsertConversationFromPack(sellerId, packId, packData, orderId);
}

// Varredura de reconciliacao: olha os pedidos recentes do vendedor e checa
// as mensagens de cada um. Serve de rede de seguranca caso algum webhook se
// perca (ou, com o Render gratuito, enquanto o servico esteve "dormindo" e
// nao recebeu nenhum webhook).
async function reconcileAccount(sellerId) {
  const accessToken = await getValidAccessToken(sellerId);

  const orders = await fetchRecentOrders(accessToken, sellerId, {
    limit: RECENT_ORDERS_LIMIT,
  });
  const list = Array.isArray(orders?.results) ? orders.results : [];

  console.log(
    `[reconcile] conta ${sellerId}: verificando ${list.length} pedido(s) recente(s) (de um total de ${
      orders?.paging?.total ?? "?"
    } pedidos).`
  );

  let comMensagens = 0;
  for (const order of list) {
    // Pedidos que nao fazem parte de um envio combinado nao tem pack_id
    // (vem null) — nesse caso o proprio order_id funciona no lugar.
    const packId = order?.pack_id || order?.id;
    if (!packId) continue;

    try {
      const packData = await fetchPackMessages(accessToken, packId, sellerId);
      if (Array.isArray(packData?.messages) && packData.messages.length > 0) {
        comMensagens++;
        await upsertConversationFromPack(sellerId, packId, packData, order?.id);
      }
    } catch (err) {
      console.warn(
        `[reconcile] falha ao checar mensagens do pedido ${order?.id} (pack ${packId}):`,
        err.status,
        err.body || err.message
      );
    }
  }

  console.log(`[reconcile] conta ${sellerId}: ${comMensagens} pedido(s) com mensagens encontrados.`);
}

async function reconcileAllAccounts() {
  const { rows: accounts } = await db.query("SELECT id FROM accounts");
  console.log(
    `[reconcile] contas conectadas no banco:`,
    accounts.map((a) => a.id)
  );
  for (const acc of accounts) {
    try {
      await reconcileAccount(acc.id);
    } catch (err) {
      console.error(`[reconcile] falha na conta ${acc.id}:`, err.message);
    }
  }
}

module.exports = { syncPack, reconcileAccount, reconcileAllAccounts, upsertConversationFromPack };
