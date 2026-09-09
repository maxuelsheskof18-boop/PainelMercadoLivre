// CRUD das respostas rapidas (templates). Montado em "/api" pelo server.js,
// entao os caminhos aqui vivem sob /api/templates.
const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");

const router = express.Router();
router.use(requireLogin);
router.use(express.json());

router.get("/templates", (req, res) => {
  const rows = db
    .prepare(
      "SELECT id, title, body, sort_order FROM reply_templates ORDER BY sort_order ASC, id ASC"
    )
    .all();
  res.json(rows);
});

router.post("/templates", (req, res) => {
  const title = (req.body?.title || "").trim();
  const body = (req.body?.body || "").trim();
  if (!title || !body) {
    return res.status(400).json({ error: "Titulo e texto sao obrigatorios." });
  }
  const maxOrder =
    db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM reply_templates").get().m;
  const info = db
    .prepare(
      "INSERT INTO reply_templates (title, body, sort_order) VALUES (?, ?, ?)"
    )
    .run(title, body, maxOrder + 1);
  res.json({ id: info.lastInsertRowid, title, body });
});

router.put("/templates/:id", (req, res) => {
  const title = (req.body?.title || "").trim();
  const body = (req.body?.body || "").trim();
  if (!title || !body) {
    return res.status(400).json({ error: "Titulo e texto sao obrigatorios." });
  }
  const info = db
    .prepare(
      "UPDATE reply_templates SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(title, body, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "Template nao encontrado." });
  res.json({ ok: true });
});

router.delete("/templates/:id", (req, res) => {
  db.prepare("DELETE FROM reply_templates WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
