const db = require("../db");
const { refreshAccessToken } = require("./oauth");

// Da uma margem de 5 minutos antes do vencimento real (token dura 6h)
const SAFETY_MARGIN_MS = 5 * 60 * 1000;

async function getValidAccessToken(accountId) {
  const { rows } = await db.query("SELECT * FROM accounts WHERE id = $1", [
    String(accountId),
  ]);
  const account = rows[0];

  if (!account) {
    throw new Error(`Conta ${accountId} nao encontrada. Conecte a conta primeiro.`);
  }

  const now = Date.now();
  if (Number(account.expires_at) - SAFETY_MARGIN_MS > now) {
    return account.access_token;
  }

  // Token perto de vencer (ou vencido) -> renova usando o refresh_token.
  // Importante: o Mercado Livre invalida o refresh_token antigo a cada uso
  // e devolve um novo. Se isso falhar, a conta precisa ser reconectada.
  const data = await refreshAccessToken(account.refresh_token);

  const newExpiresAt = Date.now() + data.expires_in * 1000;
  await db.query(
    `UPDATE accounts
     SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = now()
     WHERE id = $4`,
    [data.access_token, data.refresh_token, newExpiresAt, String(accountId)]
  );

  return data.access_token;
}

async function listAccounts() {
  const { rows } = await db.query(
    "SELECT id, nickname, created_at, updated_at FROM accounts ORDER BY nickname"
  );
  return rows;
}

module.exports = { getValidAccessToken, listAccounts };
