// Busca de data Full — acompanhar e comandar pelo celular.
//
// Quem fala com o Mercado Livre e a extensao "ML Full - Busca de Data",
// rodando num PC com a Central de Vendedores logada. Este modulo e so o
// ponto de encontro:
//
//   extensao (token)  PUT  /api/full-agenda/maquina/:id/estado   foto do que esta fazendo
//                     GET  /api/full-agenda/maquina/:id/comandos  pega os comandos pendentes
//                     POST /api/full-agenda/comandos/:id/resultado
//
//   pagina (login)    GET    /api/full-agenda/estado             maquinas + comandos recentes
//                     POST   /api/full-agenda/comandos           novo comando
//                     DELETE /api/full-agenda/comandos/:id       cancela um pendente
//
// A extensao se identifica pelo cabecalho x-full-token (FULL_AGENDA_TOKEN
// no .env). Toda rota tem try/catch proprio, no padrao de routes/questions.js.

const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");

const router = express.Router();
const json = express.json({ limit: "2mb" });

const TIPOS = ["agendar", "aprovar_envio", "recusar_envio", "config", "verificar"];
// Comando pego e nao respondido em 10 min (PC desligou no meio): volta pra fila.
const REENTREGA_MIN = 10;

function exigirToken(req, res, next) {
  const esperado = process.env.FULL_AGENDA_TOKEN;
  if (!esperado) return res.status(503).json({ error: "FULL_AGENDA_TOKEN nao configurado no servidor" });
  const recebido = String(req.get("x-full-token") || "");
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Token da extensao invalido" });
  }
  next();
}

function idValido(id) {
  return /^[\w-]{4,64}$/.test(String(id || ""));
}

/* ---------- lado da extensao ---------- */

router.put("/full-agenda/maquina/:id/estado", exigirToken, json, async (req, res) => {
  try {
    if (!idValido(req.params.id)) return res.status(400).json({ error: "id de maquina invalido" });
    await db.query(
      `INSERT INTO full_agenda_estado (id, dados, atualizado_em) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now()`,
      [req.params.id, req.body || {}]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[full-agenda] salvar estado:", err.message);
    res.status(500).json({ error: "Falha ao salvar o estado" });
  }
});

router.get("/full-agenda/maquina/:id/comandos", exigirToken, async (req, res) => {
  try {
    if (!idValido(req.params.id)) return res.status(400).json({ error: "id de maquina invalido" });
    // Marca como "executando" na mesma consulta: o filtro de status fica no
    // proprio UPDATE, entao o Postgres o reavalia depois de travar a linha e
    // dois pedidos seguidos da extensao nunca recebem o mesmo comando.
    const { rows } = await db.query(
      `UPDATE full_agenda_comandos SET status = 'executando', pego_em = now()
       WHERE maquina = $1
         AND (status = 'pendente'
              OR (status = 'executando' AND pego_em < $2))
       RETURNING id, tipo, dados, criado_em`,
      [req.params.id, new Date(Date.now() - REENTREGA_MIN * 60_000)]
    );
    rows.sort((a, b) => Number(a.id) - Number(b.id)); // na ordem em que voce mandou
    res.json({ comandos: rows });
  } catch (err) {
    console.error("[full-agenda] buscar comandos:", err.message);
    res.status(500).json({ error: "Falha ao buscar comandos" });
  }
});

router.post("/full-agenda/comandos/:id/resultado", exigirToken, json, async (req, res) => {
  try {
    const ok = !!(req.body && req.body.ok);
    await db.query(
      `UPDATE full_agenda_comandos SET status = $2, resultado = $3, concluido_em = now()
       WHERE id = $1 AND status = 'executando'`,
      [req.params.id, ok ? "feito" : "erro", req.body || {}]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[full-agenda] salvar resultado:", err.message);
    res.status(500).json({ error: "Falha ao salvar o resultado" });
  }
});

/* ---------- lado da pagina (login do painel) ---------- */

router.get("/full-agenda/estado", requireLogin, async (req, res) => {
  try {
    const maquinas = await db.query(
      `SELECT id, dados, atualizado_em FROM full_agenda_estado ORDER BY atualizado_em DESC`
    );
    const comandos = await db.query(
      `SELECT id, maquina, tipo, dados, status, resultado, criado_em, concluido_em
       FROM full_agenda_comandos ORDER BY id DESC LIMIT 40`
    );
    res.json({ agora: new Date().toISOString(), maquinas: maquinas.rows, comandos: comandos.rows });
  } catch (err) {
    console.error("[full-agenda] ler estado:", err.message);
    res.status(500).json({ error: "Falha ao ler o estado" });
  }
});

router.post("/full-agenda/comandos", requireLogin, json, async (req, res) => {
  try {
    const { maquina, tipo, dados } = req.body || {};
    if (!idValido(maquina)) return res.status(400).json({ error: "Maquina invalida" });
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: "Tipo de comando invalido" });
    const { rows } = await db.query(
      `INSERT INTO full_agenda_comandos (maquina, tipo, dados) VALUES ($1, $2, $3) RETURNING id, status, criado_em`,
      [maquina, tipo, dados || {}]
    );
    res.json({ ok: true, comando: rows[0] });
  } catch (err) {
    console.error("[full-agenda] criar comando:", err.message);
    res.status(500).json({ error: "Falha ao criar o comando" });
  }
});

router.delete("/full-agenda/comandos/:id", requireLogin, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE full_agenda_comandos SET status = 'cancelado', concluido_em = now()
       WHERE id = $1 AND status = 'pendente'`,
      [req.params.id]
    );
    res.json({ ok: rowCount > 0 });
  } catch (err) {
    console.error("[full-agenda] cancelar comando:", err.message);
    res.status(500).json({ error: "Falha ao cancelar o comando" });
  }
});

module.exports = router;
