const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { buildAuthorizeUrl, exchangeCodeForToken } = require("../melhorenvio/oauth");
const { getAccount, isConnected, getValidAccessToken } = require("../melhorenvio/tokens");
const { calculateShipping } = require("../melhorenvio/api");

const router = express.Router();

// Passo 1: usuario clica em "Conectar Melhor Envio" no topo do painel.
router.get("/melhorenvio/connect", requireLogin, (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.melhorenvioOauthState = state;
  res.redirect(buildAuthorizeUrl({ state }));
});

// Passo 2: o Melhor Envio chama esta URL de volta com ?code=...&state=...
router.get("/melhorenvio/oauth/callback", requireLogin, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res
      .status(400)
      .send(`Melhor Envio recusou a autorizacao: ${error}. Feche esta aba e tente de novo.`);
  }

  const savedState = req.session.melhorenvioOauthState;
  if (!savedState || !code || state !== savedState) {
    return res
      .status(400)
      .send("Sessao de autorizacao invalida ou expirada. Feche esta aba e clique em 'Conectar Melhor Envio' novamente.");
  }

  try {
    const tokenData = await exchangeCodeForToken(code);
    const expiresAt = Date.now() + tokenData.expires_in * 1000;

    // COALESCE no origin_postal_code: se o usuario ja tinha configurado o
    // CEP de origem antes de conectar, nao apaga ao (re)conectar.
    await db.query(
      `INSERT INTO melhorenvio_account (id, access_token, refresh_token, expires_at, updated_at)
       VALUES ('main', $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [tokenData.access_token, tokenData.refresh_token, expiresAt]
    );

    delete req.session.melhorenvioOauthState;
    res.redirect("/index.html?me_connected=1");
  } catch (err) {
    console.error("[melhorenvio/oauth/callback]", err.message);
    res.status(500).send(
      "Deu erro ao concluir a conexao com o Melhor Envio. Confira MELHORENVIO_CLIENT_ID/MELHORENVIO_CLIENT_SECRET/MELHORENVIO_REDIRECT_URI no .env e tente novamente."
    );
  }
});

router.get("/api/melhorenvio/status", requireLogin, async (req, res) => {
  const account = await getAccount();
  res.json({
    connected: isConnected(account),
    originPostalCode: account?.origin_postal_code || null,
  });
});

router.post("/api/melhorenvio/settings", requireLogin, express.json(), async (req, res) => {
  const { originPostalCode } = req.body || {};
  await db.query(
    `INSERT INTO melhorenvio_account (id, origin_postal_code, updated_at)
     VALUES ('main', $1, now())
     ON CONFLICT (id) DO UPDATE SET
       origin_postal_code = EXCLUDED.origin_postal_code,
       updated_at = now()`,
    [originPostalCode || null]
  );
  res.json({ ok: true });
});

router.post("/api/melhorenvio/calculate", requireLogin, express.json(), async (req, res) => {
  const account = await getAccount();
  if (!isConnected(account)) {
    return res.status(409).json({ error: "Melhor Envio ainda nao foi conectado." });
  }
  if (!account.origin_postal_code) {
    return res.status(409).json({ error: "Configure o CEP de origem antes de calcular o frete." });
  }

  const { toPostalCode, weight, height, width, length, insuranceValue } = req.body || {};
  if (!toPostalCode) {
    return res.status(400).json({ error: "Informe o CEP de destino." });
  }

  try {
    const accessToken = await getValidAccessToken();
    // "insuranceValue" (valor assegurado) e o valor declarado do produto pro
    // seguro do envio — o Melhor Envio cobra o seguro em cima desse valor,
    // entao ele muda o preco final do frete (pedido do usuario: o painel ja
    // preenche isso com o valor da venda, mas o campo aceita ser trocado).
    // Sem valor nenhum, calculateShipping ja cai pro padrao de R$ 20.
    const parsedInsurance = Number(insuranceValue);
    const raw = await calculateShipping(accessToken, {
      fromPostalCode: account.origin_postal_code,
      toPostalCode,
      weight,
      height,
      width,
      length,
      insuranceValue: Number.isFinite(parsedInsurance) && parsedInsurance > 0 ? parsedInsurance : undefined,
    });

    // A resposta e uma lista com uma entrada por transportadora/servico; as
    // que nao conseguiram cotar (fora de area, peso fora do limite etc.)
    // vem com um campo "error" em vez de preco — essas sao filtradas.
    const options = (Array.isArray(raw) ? raw : [])
      .filter((o) => o && !o.error && (o.price || o.custom_price))
      .map((o) => ({
        id: o.id,
        name: o.name,
        company: o.company?.name || null,
        price: Number(o.custom_price ?? o.price),
        deliveryTime: o.custom_delivery_time ?? o.delivery_time ?? null,
      }))
      .sort((a, b) => a.price - b.price);

    res.json({ options });
  } catch (err) {
    console.error("[melhorenvio/calculate]", err.status, err.body || err.message);
    res.status(502).json({
      error: "Falha ao calcular o frete no Melhor Envio.",
      detail: err.body?.message || err.message,
    });
  }
});

module.exports = router;
