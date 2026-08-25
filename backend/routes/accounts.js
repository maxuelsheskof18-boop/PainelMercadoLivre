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
    const accountId = String(tokenData.user_id || me.id);

    await db.query(
      `INSERT INTO accounts (id, nickname, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         nickname = EXCLUDED.nickname,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [
        accountId,
        me?.nickname || accountId,
        tokenData.access_token,
        tokenData.refresh_token,
        expiresAt,
      ]
    );

    delete req.session.oauth;

    res.redirect("/index.html?connected=1");
  } catch (err) {
    console.error("[oauth/callback]", err);
    res.status(500).send(
      "Deu erro ao concluir a conexao com o Mercado Livre. Confira ML_CLIENT_ID/ML_CLIENT_SECRET/ML_REDIRECT_URI no .env e tente novamente."
    );
  }
});

router.get("/api/accounts", requireLogin, async (req, res) => {
  const { rows } = await db.query(
    "SELECT id, nickname, created_at FROM accounts ORDER BY nickname"
  );
  res.json(rows);
});

router.delete("/api/accounts/:id", requireLogin, async (req, res) => {
  await db.query("DELETE FROM accounts WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
