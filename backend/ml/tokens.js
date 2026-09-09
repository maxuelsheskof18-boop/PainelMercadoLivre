const db = require("../db");
const { refreshAccessToken } = require("./oauth");
const { fetchMe } = require("./api");

// Da uma margem de 5 minutos antes do vencimento real (token dura 6h)
const SAFETY_MARGIN_MS = 5 * 60 * 1000;

// Erro usado quando a conta precisa ser reconectada pelo painel (o
// refresh_token de uso unico do Mercado Livre foi invalidado).
class AccountNeedsReauthError extends Error {
  constructor(accountId) {
    super(
      `Conta ${accountId} precisa ser reconectada no painel (o Mercado Livre invalidou a autorizacao).`
    );
    this.name = "AccountNeedsReauthError";
    this.accountId = accountId;
    this.needsReauth = true;
  }
}

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
  let data;
  try {
    data = await refreshAccessToken(account.refresh_token);
  } catch (err) {
    db.prepare(
      `UPDATE accounts SET needs_reauth = 1, updated_at = datetime('now') WHERE id = ?`
    ).run(accountId);
    console.error(`[tokens] refresh falhou para conta ${accountId}:`, err.message);
    throw new AccountNeedsReauthError(accountId);
  }

  const newExpiresAt = Date.now() + data.expires_in * 1000;
  db.prepare(
    `UPDATE accounts
     SET access_token = ?, refresh_token = ?, expires_at = ?, needs_reauth = 0, updated_at = datetime('now')
     WHERE id = ?`
  ).run(data.access_token, data.refresh_token, newExpiresAt, accountId);

  return data.access_token;
}

// Email do vendedor, guardado na tabela accounts. Busca em /users/me so
// quando ainda nao temos (ex: contas conectadas antes desta versao).
async function getSellerEmail(accountId) {
  const row = db.prepare("SELECT email FROM accounts WHERE id = ?").get(accountId);
  if (row && row.email) return row.email;

  const accessToken = await getValidAccessToken(accountId);
  const me = await fetchMe(accessToken);
  if (me && me.email) {
    db.prepare(
      `UPDATE accounts SET email = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(me.email, accountId);
    return me.email;
  }
  return null;
}

function listAccounts() {
  return db
    .prepare(
      "SELECT id, nickname, needs_reauth, created_at, updated_at FROM accounts ORDER BY nickname"
    )
    .all();
}

module.exports = {
  getValidAccessToken,
  getSellerEmail,
  listAccounts,
  AccountNeedsReauthError,
};
