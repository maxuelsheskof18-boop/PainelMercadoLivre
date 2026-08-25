const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");
const { sendMessage, fetchMe } = require("../ml/api");
const { reconcileAllAccounts } = require("../sync");

const router = express.Router();

// Este router e montado em "/api" (veja server.js), entao os caminhos aqui
// dentro NAO repetem o prefixo "/api" — e por isso, alem de exigir login,
// que ele so intercepta pedidos que ja comecam com /api/..., sem afetar
// paginas publicas como /login.html.
router.use(requireLogin);

router.get("/pending-count", (req, res) => {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM conversations WHERE status = 'pending'")
    .get();
  res.json({ pending: row.total });
});

router.get("/conversations", (req, res) => {
  const status = ["pending", "answered"].includes(req.query.status)
    ? req.query.status
    : "pending";

  const rows = db
    .prepare(
      `SELECT c.*, a.nickname AS seller_nickname
       FROM conversations c
       JOIN accounts a ON a.id = c.seller_id
       WHERE c.status = ?
       ORDER BY c.last_message_date DESC`
    )
    .all(status);

  res.json(rows);
});

router.get("/conversations/:packId/messages", (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE pack_id = ? ORDER BY id ASC`
    )
    .all(req.params.packId);
  res.json(rows);
});

router.post("/conversations/:packId/reply", express.json(), async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Mensagem vazia" });
  }

  const conv = db
    .prepare("SELECT * FROM conversations WHERE pack_id = ?")
    .get(req.params.packId);

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

    db.prepare(
      `INSERT INTO messages (pack_id, direction, author_user_id, text, sent_date)
       VALUES (?, 'out', ?, ?, datetime('now'))`
    ).run(conv.pack_id, conv.seller_id, text.trim());

    db.prepare(
      `UPDATE conversations
       SET status = 'answered', last_message_text = ?, last_message_date = datetime('now'), updated_at = datetime('now')
       WHERE pack_id = ?`
    ).run(text.trim(), conv.pack_id);

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
// esperar o webhook.
router.post("/sync", async (req, res) => {
  try {
    await reconcileAllAccounts();
    res.json({ ok: true });
  } catch (err) {
    console.error("[sync]", err.message);
    res.status(500).json({ error: "Falha ao sincronizar", detail: err.message });
  }
});

module.exports = router;
