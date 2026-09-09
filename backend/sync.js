// Le uma conversa (pack) devolvida pela API do Mercado Livre e grava/atualiza
// as tabelas locais (conversations + messages), decidindo se ela fica
// "pending" (aguardando resposta do vendedor) ou "answered".
const db = require("./db");
const {
  fetchPackMessages,
  fetchPendingRead,
  fetchOrder,
  fetchShipment,
} = require("./ml/api");
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

// Normaliza qualquer data (ISO 8601 do ML ou "YYYY-MM-DD HH:MM:SS" do SQLite)
// para ISO 8601 em UTC. Assim o ORDER BY last_message_date fica consistente e
// o front recebe sempre o mesmo formato.
function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return typeof value === "string" ? value : null;
  return d.toISOString();
}

function nowIso() {
  return new Date().toISOString();
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
       order_id = COALESCE(excluded.order_id, conversations.order_id),
       buyer_id = COALESCE(excluded.buyer_id, conversations.buyer_id),
       buyer_nickname = COALESCE(excluded.buyer_nickname, conversations.buyer_nickname),
       last_message_text = excluded.last_message_text,
       last_message_date = excluded.last_message_date,
       status = excluded.status,
       updated_at = datetime('now')`
  ).run({
    pack_id: String(packId),
    seller_id: sellerId,
    order_id: orderId ? String(orderId) : null,
    buyer_id: buyerId,
    buyer_nickname: buyerNickname,
    last_message_text: last?.text || null,
    last_message_date: toIso(messageDate(last)),
    status,
  });

  const insertMsg = db.prepare(
    `INSERT OR IGNORE INTO messages (pack_id, message_id, direction, author_user_id, text, sent_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  // Casa a resposta que o painel gravou de forma otimista (message_id NULL)
  // com a versao real que agora veio da API, em vez de duplicar a linha.
  const claimOptimistic = db.prepare(
    `UPDATE messages SET message_id = @message_id, sent_date = @sent_date
     WHERE id = (
       SELECT id FROM messages
       WHERE pack_id = @pack_id AND message_id IS NULL AND direction = 'out'
         AND text = @text
       ORDER BY id ASC LIMIT 1
     )`
  );

  const existing = new Set(
    db
      .prepare("SELECT message_id FROM messages WHERE pack_id = ? AND message_id IS NOT NULL")
      .all(String(packId))
      .map((r) => r.message_id)
  );

  for (const m of messages) {
    const id = m?.id ? String(m.id) : null;
    if (id && existing.has(id)) continue; // ja gravada
    const fromId = String(m?.from?.user_id ?? "");
    const direction = fromId === String(sellerId) ? "out" : "in";
    const text = m?.text || null;
    const sentDate = toIso(messageDate(m));

    if (id && direction === "out" && text) {
      const claimed = claimOptimistic.run({
        message_id: id,
        sent_date: sentDate,
        pack_id: String(packId),
        text,
      });
      if (claimed.changes > 0) {
        existing.add(id);
        continue;
      }
    }

    insertMsg.run(String(packId), id, direction, fromId || null, text, sentDate);
    if (id) existing.add(id);
  }
}

// Busca dados do pedido (item, valor, envio) e grava na conversa. Best-effort:
// qualquer falha e ignorada e sera tentada de novo na proxima sincronizacao.
async function enrichOrder(sellerId, packId) {
  const conv = db
    .prepare("SELECT order_id, order_enriched_at FROM conversations WHERE pack_id = ?")
    .get(String(packId));
  if (!conv || !conv.order_id) return;
  // Ja enriquecido nas ultimas 6h -> nao repete (o status de envio muda pouco).
  if (conv.order_enriched_at && Date.now() - new Date(conv.order_enriched_at).getTime() < 6 * 60 * 60 * 1000) {
    return;
  }

  try {
    const accessToken = await getValidAccessToken(sellerId);
    const order = await fetchOrder(accessToken, conv.order_id);

    const firstItem = Array.isArray(order?.order_items) ? order.order_items[0] : null;
    const itemTitle = firstItem?.item?.title || null;
    const itemQuantity = Array.isArray(order?.order_items)
      ? order.order_items.reduce((sum, it) => sum + (Number(it?.quantity) || 0), 0)
      : null;

    let shippingStatus = null;
    const shipmentId = order?.shipping?.id;
    if (shipmentId) {
      try {
        const shipment = await fetchShipment(accessToken, shipmentId);
        shippingStatus = shipment?.status || null;
      } catch {
        // escopo de logistica pode nao estar liberado; ignora
      }
    }

    db.prepare(
      `UPDATE conversations SET
         item_title = @item_title,
         item_quantity = @item_quantity,
         order_total = @order_total,
         currency = @currency,
         order_status = @order_status,
         shipping_status = @shipping_status,
         order_enriched_at = @order_enriched_at
       WHERE pack_id = @pack_id`
    ).run({
      item_title: itemTitle,
      item_quantity: itemQuantity,
      order_total: order?.total_amount ?? null,
      currency: order?.currency_id || null,
      order_status: order?.status || null,
      shipping_status: shippingStatus,
      order_enriched_at: nowIso(),
      pack_id: String(packId),
    });
  } catch (err) {
    console.error(`[order] falha ao enriquecer pack ${packId}:`, err.message);
  }
}

// Puxa uma conversa especifica (usado pelo webhook, que ja sabe o pack_id).
async function syncPack(sellerId, packId, orderId) {
  const accessToken = await getValidAccessToken(sellerId);
  const packData = await fetchPackMessages(accessToken, packId, sellerId);
  upsertConversationFromPack(sellerId, packId, packData, orderId);
  await enrichOrder(sellerId, packId);
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
      await enrichOrder(sellerId, packId);
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

module.exports = {
  syncPack,
  reconcileAccount,
  reconcileAllAccounts,
  upsertConversationFromPack,
  enrichOrder,
  toIso,
};
