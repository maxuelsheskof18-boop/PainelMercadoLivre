const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");
const { sendMessage, fetchMe, fetchRecentOrders, fetchPackMessages } = require("../ml/api");
const { reconcileAllAccounts } = require("../sync");

const router = express.Router();

// Este router e montado em "/api" (veja server.js), entao os caminhos aqui
// dentro NAO repetem o prefixo "/api" — e por isso, alem de exigir login,
// que ele so intercepta pedidos que ja comecam com /api/..., sem afetar
// paginas publicas como /login.html.
router.use(requireLogin);

router.get("/pending-count", async (req, res) => {
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS total FROM conversations WHERE status = 'pending'"
  );
  res.json({ pending: rows[0].total });
});

router.get("/conversations", async (req, res) => {
  const status = ["pending", "answered"].includes(req.query.status)
    ? req.query.status
    : "pending";

  const { rows } = await db.query(
    `SELECT c.*, a.nickname AS seller_nickname
       FROM conversations c
       JOIN accounts a ON a.id = c.seller_id
       WHERE c.status = $1
       ORDER BY c.last_message_date DESC`,
    [status]
  );

  res.json(rows);
});

router.get("/conversations/:packId/messages", async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM messages WHERE pack_id = $1 ORDER BY id ASC",
    [req.params.packId]
  );
  res.json(rows);
});

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
    res.status(502).json({
      error: "Falha ao enviar a mensagem para o Mercado Livre.",
      detail: err.body || err.message,
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

module.exports = router;
