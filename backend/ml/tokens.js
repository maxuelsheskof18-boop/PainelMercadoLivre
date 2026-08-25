const db = require("../db");
const { refreshAccessToken } = require("./oauth");

// Da uma margem de 5 minutos antes do vencimento real (token dura 6h)
const SAFETY_MARGIN_MS = 5 * 60 * 1000;

async function getValidAccessToken(accountId) {
  const account = db
    .prepare("SELECT * FROM accounts WHERE id = ?")
    .get(accountId);

  if (!account) {
    throw new Error(`Conta ${accountId} nao encontrada. Conecte a conta primeiro.`);
  }

  const now = Date.now();
  if (account.expires_at - SAFETY_MARGIN_MS > now) {
    return account.access_token;
  }

  // Token perto de vencer (ou vencido) -> renova usando o refresh_token.
  // Importante: o Mercado Livre invalida o refresh_token antigo a cada uso
  // e devolve um novo. Se isso falhar, a conta precisa ser reconectada.
  const data = await refreshAccessToken(account.refresh_token);

  const newExpiresAt = Date.now() + data.expires_in * 1000;
  db.prepare(
    `UPDATE accounts
     SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(data.access_token, data.refresh_token, newExpiresAt, accountId);

  return data.access_token;
}

function listAccounts() {
  return db
    .prepare("SELECT id, nickname, created_at, updated_at FROM accounts ORDER BY nickname")
    .all();
}

module.exports = { getValidAccessToken, listAccounts };
