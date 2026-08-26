const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");
const {
  sendMessage,
  fetchMe,
  fetchRecentOrders,
  fetchPackMessages,
  fetchOrderById,
  fetchShipment,
} = require("../ml/api");
const { reconcileAllAccounts, extractOrderInfo } = require("../sync");

const router = express.Router();

// Este router e montado em "/api" (veja server.js), entao os caminhos aqui
// dentro NAO repetem o prefixo "/api" — e por isso, alem de exigir login,
// que ele so intercepta pedidos que ja comecam com /api/..., sem afetar
// paginas publicas como /login.html.
router.use(requireLogin);

router.get("/pending-count", async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'no_contact')::int AS no_contact
     FROM conversations`
  );
  res.json({ pending: rows[0].pending, noContact: rows[0].no_contact });
});

router.get("/conversations", async (req, res) => {
  const status = ["pending", "answered", "no_contact"].includes(req.query.status)
    ? req.query.status
    : "pending";

  // Filtro opcional: so as conversas classificadas como "combinar entrega"
  // (coluna is_combinar_entrega). Na aba "no_contact" isso e sempre
  // verdadeiro (so entra la quem e combinar entrega), mas nao atrapalha
  // deixar o filtro ligado tambem.
  const onlyCombinar = req.query.combinar === "1";
  const where = onlyCombinar
    ? "c.status = $1 AND c.is_combinar_entrega = true"
    : "c.status = $1";

  const { rows } = await db.query(
    `SELECT c.*, a.nickname AS seller_nickname
       FROM conversations c
       JOIN accounts a ON a.id = c.seller_id
       WHERE ${where}
       ORDER BY c.last_message_date DESC NULLS LAST, c.updated_at DESC`,
    [status]
  );

  res.json(rows);
});

router.get("/conversations/:packId/messages", async (req, res) => {
  const packId = req.params.packId;

  const { rows: messages } = await db.query(
    "SELECT * FROM messages WHERE pack_id = $1 ORDER BY id ASC",
    [packId]
  );

  const { rows: convRows } = await db.query(
    `SELECT c.*, a.nickname AS seller_nickname
       FROM conversations c
       JOIN accounts a ON a.id = c.seller_id
      WHERE c.pack_id = $1`,
    [packId]
  );
  let conversation = convRows[0] || null;

  // Conversas mais antigas (que ja sairam da janela dos pedidos recentes
  // verificados pela reconciliacao periodica) podem nao ter produto/tipo
  // de entrega ainda. Como o usuario esta olhando essa conversa agora, vale
  // a pena buscar na hora, em vez de esperar ela entrar de novo na janela.
  if (
    conversation &&
    conversation.order_id &&
    (conversation.product_title == null || conversation.order_total == null)
  ) {
    try {
      const accessToken = await getValidAccessToken(conversation.seller_id);
      const order = await fetchOrderById(accessToken, conversation.order_id);
      const orderInfo = extractOrderInfo(order);

      const { rows: updated } = await db.query(
        `UPDATE conversations
            SET buyer_full_name = COALESCE($1, buyer_full_name),
                product_title = COALESCE($2, product_title),
                is_combinar_entrega = COALESCE($3, is_combinar_entrega),
                order_total = COALESCE($4, order_total),
                updated_at = now()
          WHERE pack_id = $5
          RETURNING *`,
        [
          orderInfo?.buyerFullName ?? null,
          orderInfo?.productTitle ?? null,
          orderInfo?.isCombinarEntrega ?? null,
          orderInfo?.orderTotal ?? null,
          packId,
        ]
      );
      if (updated[0]) conversation = { ...conversation, ...updated[0] };
    } catch (err) {
      console.warn(
        `[conversations] nao consegui enriquecer o pedido ${conversation.order_id} sob demanda:`,
        err.status,
        err.body || err.message
      );
    }
  }

  res.json({ conversation, messages });
});

// Quando o Mercado Livre recusa o envio porque a conversa foi bloqueada
// permanentemente (reembolso, mediacao/reclamacao encerrada, envio Full,
// prazo de resposta esgotado), nao adianta o vendedor tentar de novo — a
// API sempre vai recusar. Detecta esses casos ("blocked_by_...") em
// qualquer lugar que a mensagem de erro do Mercado Livre venha.
function extractBlockReason(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [];
  if (typeof body.message === "string") candidates.push(body.message);
  if (typeof body.error === "string") candidates.push(body.error);
  if (Array.isArray(body.cause)) {
    for (const c of body.cause) {
      if (typeof c === "string") candidates.push(c);
      else if (c && typeof c.message === "string") candidates.push(c.message);
      else if (c && typeof c.code === "string") candidates.push(c.code);
    }
  }
  return candidates.find((c) => /^blocked_by_/i.test(c)) || null;
}

const BLOCK_REASON_LABELS = {
  blocked_by_refund: "reembolso feito ao comprador",
  blocked_by_mediation: "mediação/reclamação encerrada",
  blocked_by_fulfillment: "pedido enviado por Full",
  blocked_by_time: "prazo para responder encerrado",
};

router.post("/conversations/:packId/reply", express.json(), async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Mensagem vazia" });
  }

  const { rows } = await db.query(
    "SELECT * FROM conversations WHERE pack_id = $1",
    [req.params.packId]
  );
  const conv = rows[0];

  if (!conv) return res.status(404).json({ error: "Conversa nao encontrada" });
  if (!conv.buyer_id) {
    return res.status(409).json({
      error:
        "Nao sei quem e o comprador desta conversa ainda (aguarde a proxima sincronizacao ou clique em Atualizar).",
    });
  }

  try {
    const accessToken = await getValidAccessToken(conv.seller_id);
    const me = await fetchMe(accessToken);

    await sendMessage({
      accessToken,
      packId: conv.pack_id,
      sellerId: conv.seller_id,
      buyerId: conv.buyer_id,
      sellerEmail: me?.email,
      text: text.trim(),
    });

    const nowIso = new Date().toISOString();

    await db.query(
      `INSERT INTO messages (pack_id, direction, author_user_id, text, sent_date)
       VALUES ($1, 'out', $2, $3, $4)`,
      [conv.pack_id, conv.seller_id, text.trim(), nowIso]
    );

    await db.query(
      `UPDATE conversations
       SET status = 'answered', last_message_text = $1, last_message_date = $2, updated_at = now()
       WHERE pack_id = $3`,
      [text.trim(), nowIso, conv.pack_id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[reply]", err.status, err.body || err.message);
    // err.body normalmente vem da API do Mercado Livre como um objeto tipo
    // {message: "...", error: "...", cause: [...]}. Extraimos uma frase
    // legivel pra mostrar na tela, em vez de so "[object Object]".
    const mlMessage =
      err.body?.message ||
      err.body?.cause?.[0]?.message ||
      (typeof err.body === "string" ? err.body : null);

    const blockReason = err.status === 403 ? extractBlockReason(err.body) : null;
    if (blockReason) {
      // Bloqueio permanente: essa conversa nunca mais vai aceitar uma
      // resposta enviada por aqui. Marcamos como "blocked" pra ela sair
      // sozinha das abas "Pendentes" e "Respondidas" (as duas so mostram
      // status='pending' ou 'answered') — assim ela nao fica poluindo a
      // lista, como o usuario pediu, sem apagar o historico da conversa.
      await db.query(
        `UPDATE conversations SET status = 'blocked', blocked_reason = $1, updated_at = now() WHERE pack_id = $2`,
        [blockReason, conv.pack_id]
      );
    }

    res.status(502).json({
      error: "Falha ao enviar a mensagem para o Mercado Livre.",
      detail: mlMessage || err.message || "Sem detalhes do Mercado Livre.",
      blocked: !!blockReason,
      blockReason: blockReason || null,
      blockReasonLabel: blockReason ? BLOCK_REASON_LABELS[blockReason.toLowerCase()] || null : null,
    });
  }
});

// Botao "Atualizar agora" no painel: forca uma reconciliacao manual, sem
// esperar o webhook (util principalmente logo apos o servico "acordar" no
// plano gratuito do Render).
router.post("/sync", async (req, res) => {
  try {
    await reconcileAllAccounts();
    res.json({ ok: true });
  } catch (err) {
    console.error("[sync]", err.message);
    res.status(500).json({ error: "Falha ao sincronizar", detail: err.message });
  }
});

// Rota TEMPORARIA de diagnostico: busca pedidos recentes de cada conta (via
// API de Orders, que e estavel) e tenta buscar as mensagens de cada um
// (via /messages/packs/.../sellers/...), pra descobrir se o problema e so
// no endpoint de "listar pendentes" ou se e a API de mensagens inteira que
// esta bloqueada pra essa aplicacao. Depois de resolvido, pode remover essa
// rota (e o require de fetchRecentOrders/fetchPackMessages acima).
router.get("/debug/probe-messages", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = [];

  for (const acc of accounts) {
    const sellerId = acc.id;
    const entry = { sellerId, nickname: acc.nickname };
    try {
      const accessToken = await getValidAccessToken(sellerId);

      let orders;
      try {
        orders = await fetchRecentOrders(accessToken, sellerId);
      } catch (err) {
        entry.ordersError = { status: err.status, body: err.body || err.message };
        report.push(entry);
        continue;
      }

      const sample = (orders.results || []).slice(0, 3).map((o) => ({
        order_id: o.id,
        pack_id: o.pack_id || null,
        status: o.status,
      }));
      entry.totalOrders = orders.paging?.total ?? null;
      entry.sampleOrders = sample;
      entry.probes = [];

      for (const o of sample) {
        const idToTry = o.pack_id || o.order_id;
        try {
          const packData = await fetchPackMessages(accessToken, idToTry, sellerId);
          entry.probes.push({
            tried: idToTry,
            usedPackId: !!o.pack_id,
            ok: true,
            messageCount: Array.isArray(packData?.messages) ? packData.messages.length : null,
          });
        } catch (err) {
          entry.probes.push({
            tried: idToTry,
            usedPackId: !!o.pack_id,
            ok: false,
            status: err.status,
            body: err.body || err.message,
          });
        }
      }
    } catch (err) {
      entry.error = err.message;
    }
    report.push(entry);
  }

  res.json(report);
});

// Rota TEMPORARIA de diagnostico: pega ate 5 conversas pendentes reais que
// ja estao no banco e busca o envio (shipment) de cada uma, pra descobrir
// qual campo/valor identifica um envio do tipo "a combinar com o
// comprador" (nao ha essa informacao confiavel na documentacao publica).
router.get("/debug/probe-shipping", async (req, res) => {
  const { rows: convs } = await db.query(
    `SELECT pack_id, seller_id, order_id, buyer_nickname, status
       FROM conversations
      WHERE order_id IS NOT NULL
      ORDER BY status ASC, last_message_date DESC
      LIMIT 5`
  );

  const report = [];
  for (const conv of convs) {
    const entry = { pack_id: conv.pack_id, order_id: conv.order_id, status: conv.status };
    try {
      const accessToken = await getValidAccessToken(conv.seller_id);
      const order = await fetchOrderById(accessToken, conv.order_id);
      entry.orderTags = order?.tags || null;
      entry.shippingId = order?.shipping?.id || null;
      // Pra descobrir como mostrar produto/comprador de verdade no painel:
      entry.orderItems = (order?.order_items || []).map((oi) => ({
        title: oi?.item?.title,
        quantity: oi?.quantity,
      }));
      entry.buyer = order?.buyer
        ? {
            nickname: order.buyer.nickname,
            first_name: order.buyer.first_name,
            last_name: order.buyer.last_name,
          }
        : null;
      entry.dateCreated = order?.date_created || null;

      if (entry.shippingId) {
        try {
          const shipment = await fetchShipment(accessToken, entry.shippingId);
          entry.shipment = {
            logistic_type: shipment?.logistic_type,
            mode: shipment?.mode,
            status: shipment?.status,
            substatus: shipment?.substatus,
          };
        } catch (err) {
          entry.shipmentError = { status: err.status, body: err.body || err.message };
        }
      }
    } catch (err) {
      entry.error = err.message;
    }
    report.push(entry);
  }

  res.json(report);
});

module.exports = router;
