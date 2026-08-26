const db = require("../db");
const { refreshAccessToken } = require("./oauth");

// O access_token do Melhor Envio dura 30 dias (bem mais que o do Mercado
// Livre) — uma margem de 1 dia antes do vencimento e mais que suficiente.
const SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000;

async function getAccount() {
  const { rows } = await db.query("SELECT * FROM melhorenvio_account WHERE id = 'main'");
  return rows[0] || null;
}

function isConnected(account) {
  return !!(account && account.access_token && account.refresh_token);
}

// Devolve um access_token valido, renovando com o refresh_token se estiver
// perto de vencer. Lanca erro se a conta nunca foi conectada.
async function getValidAccessToken() {
  const account = await getAccount();
  if (!isConnected(account)) {
    throw new Error("Melhor Envio nao esta conectado ainda.");
  }

  const now = Date.now();
  if (Number(account.expires_at) - SAFETY_MARGIN_MS > now) {
    return account.access_token;
  }

  const data = await refreshAccessToken(account.refresh_token);
  const newExpiresAt = Date.now() + data.expires_in * 1000;

  await db.query(
    `UPDATE melhorenvio_account
        SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = now()
      WHERE id = 'main'`,
    [data.access_token, data.refresh_token, newExpiresAt]
  );

  return data.access_token;
}

module.exports = { getAccount, isConnected, getValidAccessToken };
