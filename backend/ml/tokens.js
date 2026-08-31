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

// Executa fn(accessToken) usando o token atual; se a chamada falhar
// especificamente com 401 (token invalido/vencido -- pode acontecer mesmo
// que o token parecesse valido ha pouco, se outro processo concorrente --
// uma reconciliacao de mensagens/reclamacoes/perguntas rodando em paralelo,
// ver comentario extenso em sync.js/reconcileAccount -- ja tiver renovado
// ele nesse meio tempo), renova o token e tenta de novo UMA vez com o token
// novo, devolvendo esse token pra quem chamou atualizar sua propria copia
// local (assim os proximos itens do mesmo loop ja usam o token certo, sem
// precisar renovar de novo).
//
// Por que isso em vez de simplesmente reconfirmar o token ANTES de cada
// chamada (o que este projeto chegou a fazer numa correcao anterior, e
// causou uma regressao real: o botao "Atualizar" ficava girando pra sempre
// numa conta de alto volume): reconfirmar antes de toda chamada custa uma
// consulta extra ao banco POR ITEM — numa lista grande (ex: pedidos
// "entregues em observacao" acumulados, que so saem dessa lista quando
// finalmente recebem uma mensagem, e podem chegar a milhares numa conta
// bem movimentada), isso multiplica o tempo total da sincronizacao a ponto
// de nunca terminar dentro do tempo que o navegador/usuario espera. Aqui,
// em vez disso, so se paga o custo real de uma renovacao quando ela de fato
// e necessaria (a chamada falhou com 401) — no caminho normal (token ainda
// valido, a grande maioria das vezes) nao ha nenhum custo extra.
async function withTokenRetry(sellerId, accessToken, fn) {
  try {
    return { result: await fn(accessToken), accessToken };
  } catch (err) {
    if (err?.status !== 401) throw err;
    const fresh = await getValidAccessToken(sellerId);
    return { result: await fn(fresh), accessToken: fresh };
  }
}

async function listAccounts() {
  const { rows } = await db.query(
    "SELECT id, nickname, created_at, updated_at FROM accounts ORDER BY nickname"
  );
  return rows;
}

module.exports = { getValidAccessToken, withTokenRetry, listAccounts };
