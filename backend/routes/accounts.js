const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const {
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeCodeForToken,
} = require("../ml/oauth");
const { fetchMe } = require("../ml/api");

const router = express.Router();

// Passo 1: usuario logado no painel clica em "Conectar conta do Mercado Livre".
// Geramos state + PKCE, guardamos na sessao (cookie assinado) e mandamos
// para a tela de login/autorizacao do proprio Mercado Livre.
router.get("/connect", requireLogin, (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const { verifier, challenge } = generatePkcePair();

  req.session.oauth = { state, verifier };

  const url = buildAuthorizeUrl({ state, codeChallenge: challenge });
  res.redirect(url);
});

// Passo 2: o Mercado Livre chama esta URL de volta com ?code=...&state=...
router.get("/oauth/callback", requireLogin, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res
      .status(400)
      .send(`Mercado Livre recusou a autorizacao: ${error}. Feche esta aba e tente de novo.`);
  }

  const saved = req.session.oauth;
  if (!saved || !code || state !== saved.state) {
    return res
      .status(400)
      .send("Sessao de autorizacao invalida ou expirada. Feche esta aba e clique em 'Conectar conta' novamente.");
  }

  try {
    const tokenData = await exchangeCodeForToken({
      code,
      codeVerifier: saved.verifier,
    });

    const me = await fetchMe(tokenData.access_token);
    const expiresAt = Date.now() + tokenData.expires_in * 1000;

    db.prepare(
      `INSERT INTO accounts (id, nickname, access_token, refresh_token, expires_at, updated_at)
       VALUES (@id, @nickname, @access_token, @refresh_token, @expires_at, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         nickname = excluded.nickname,
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         updated_at = datetime('now')`
    ).run({
      id: tokenData.user_id || me.id,
      nickname: me?.nickname || String(tokenData.user_id || me.id),
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt,
    });

    delete req.session.oauth;

    res.redirect("/index.html?connected=1");
  } catch (err) {
    console.error("[oauth/callback]", err);
    res.status(500).send(
      "Deu erro ao concluir a conexao com o Mercado Livre. Confira ML_CLIENT_ID/ML_CLIENT_SECRET/ML_REDIRECT_URI no .env e tente novamente."
    );
  }
});

router.get("/api/accounts", requireLogin, (req, res) => {
  const accounts = db
    .prepare("SELECT id, nickname, created_at FROM accounts ORDER BY nickname")
    .all();
  res.json(accounts);
});

router.delete("/api/accounts/:id", requireLogin, (req, res) => {
  db.prepare("DELETE FROM accounts WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
