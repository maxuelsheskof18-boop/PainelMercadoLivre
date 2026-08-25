// Le uma conversa (pack) devolvida pela API do Mercado Livre e grava/atualiza
// as tabelas locais (conversations + messages), decidindo se ela fica
// "pending" (aguardando resposta do vendedor) ou "answered".
const db = require("./db");
const { fetchPackMessages, fetchPendingRead } = require("./ml/api");
const { getValidAccessToken } = require("./ml/tokens");

function messageDate(msg) {
  return (
    msg?.message_date?.received ||
    msg?.message_date?.available ||
    msg?.message_date?.created ||
    msg?.message_date?.notified ||
    null
  );
}

function upsertConversationFromPack(sellerId, packId, packData, orderId) {
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

  const lastFromId = String(last?.from?.user_id ?? "");
  const isLastFromSeller = lastFromId === String(sellerId);
  const status = isLastFromSeller ? "answered" : "pending";

  // Descobre quem e o comprador: o participante que nao e o vendedor.
  let buyerId = null;
  for (const m of messages) {
    const fromId = String(m?.from?.user_id ?? "");
    const toId = String(m?.to?.user_id ?? "");
    if (fromId && fromId !== String(sellerId)) buyerId = fromId;
    if (toId && toId !== String(sellerId)) buyerId = buyerId || toId;
  }

  const buyerNickname = packData?.buyer?.nickname || null;

  db.prepare(
    `INSERT INTO conversations
       (pack_id, seller_id, order_id, buyer_id, buyer_nickname, last_message_text, last_message_date, status, updated_at)
     VALUES (@pack_id, @seller_id, @order_id, @buyer_id, @buyer_nickname, @last_message_text, @last_message_date, @status, datetime('now'))
     ON CONFLICT(pack_id) DO UPDATE SET
       order_id = excluded.order_id,
       buyer_id = COALESCE(excluded.buyer_id, conversations.buyer_id),
       buyer_nickname = COALESCE(excluded.buyer_nickname, conversations.buyer_nickname),
       last_message_text = excluded.last_message_text,
       last_message_date = excluded.last_message_date,
       status = excluded.status,
       updated_at = datetime('now')`
  ).run({
    pack_id: String(packId),
    seller_id: sellerId,
    order_id: orderId || null,
    buyer_id: buyerId,
    buyer_nickname: buyerNickname,
    last_message_text: last?.text || null,
    last_message_date: messageDate(last),
    status,
  });

  const insertMsg = db.prepare(
    `INSERT INTO messages (pack_id, message_id, direction, author_user_id, text, sent_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const existing = new Set(
    db
      .prepare("SELECT message_id FROM messages WHERE pack_id = ?")
      .all(String(packId))
      .map((r) => r.message_id)
  );

  for (const m of messages) {
    const id = m?.id ? String(m.id) : null;
    if (id && existing.has(id)) continue; // ja gravada
    const fromId = String(m?.from?.user_id ?? "");
    insertMsg.run(
      String(packId),
      id,
      fromId === String(sellerId) ? "out" : "in",
      fromId || null,
      m?.text || null,
      messageDate(m)
    );
  }
}

// Puxa uma conversa especifica (usado pelo webhook, que ja sabe o pack_id).
async function syncPack(sellerId, packId, orderId) {
  const accessToken = await getValidAccessToken(sellerId);
  const packData = await fetchPackMessages(accessToken, packId, sellerId);
  upsertConversationFromPack(sellerId, packId, packData, orderId);
}

// Varredura de reconciliacao: pergunta ao Mercado Livre quais packs tem
// mensagem nao lida e sincroniza cada um. Serve de rede de seguranca caso
// algum webhook se perca.
async function reconcileAccount(sellerId) {
  const accessToken = await getValidAccessToken(sellerId);
  const pending = await fetchPendingRead(accessToken);

  const items = Array.isArray(pending) ? pending : pending?.results || [];
  for (const item of items) {
    const packId = item?.pack_id ?? item?.id;
    if (!packId) continue;
    try {
      const packData = await fetchPackMessages(accessToken, packId, sellerId);
      upsertConversationFromPack(sellerId, packId, packData, item?.order_id);
    } catch (err) {
      console.error(`[reconcile] falha ao sincronizar pack ${packId}:`, err.message);
    }
  }
}

async function reconcileAllAccounts() {
  const accounts = db.prepare("SELECT id FROM accounts").all();
  for (const acc of accounts) {
    try {
      await reconcileAccount(acc.id);
    } catch (err) {
      console.error(`[reconcile] falha na conta ${acc.id}:`, err.message);
    }
  }
}

module.exports = { syncPack, reconcileAccount, reconcileAllAccounts, upsertConversationFromPack };
