// Cliente da Shopee Open Platform (API v2).
//
// Diferencas importantes em relacao ao Mercado Livre (backend/ml/):
//   - Toda chamada e ASSINADA: sign = HMAC-SHA256(partner_key, base), com
//       base = partner_id + path + timestamp                       (auth/publica)
//       base = partner_id + path + timestamp + access_token + shop_id  (loja)
//     e os parametros comuns vao na query string (partner_id, timestamp,
//     sign, e para loja access_token + shop_id).
//   - access_token dura ~4h e o refresh_token ~30 dias. A Shopee devolve um
//     refresh_token NOVO a cada renovacao (o antigo para de valer) — por isso
//     a renovacao grava os dois de uma vez.
//   - Erro vem com HTTP 200 as vezes: o que vale e o campo "error" do corpo
//     (vazio = ok).
//
// Ambientes: SHOPEE_ENV=test usa o sandbox (chaves "Test" do console, so
// funciona com loja de teste criada em Tools > Test Account-Sandbox);
// SHOPEE_ENV=live usa producao (chaves liberadas depois do Go-Live).
//
// Tabela shopee_contas criada sob demanda (mesmo jeito do prazos_config).

const crypto = require("crypto");
const db = require("../db");

const HOSTS = {
  test: "https://partner.test-stable.shopeemobile.com",
  live: "https://partner.shopeemobile.com",
};

// Renova 10 min antes de vencer (token dura ~4h).
const MARGEM_RENOVACAO_MS = 10 * 60 * 1000;

function ambiente() {
  return process.env.SHOPEE_ENV === "live" ? "live" : "test";
}

function config() {
  // trim: chave colada no Render com espaco/quebra de linha no fim muda o
  // HMAC inteiro e a Shopee responde "error_sign / Wrong sign".
  const partnerId = Number(String(process.env.SHOPEE_PARTNER_ID || "").trim() || 0);
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
  return { partnerId, partnerKey, host: HOSTS[ambiente()], ambiente: ambiente() };
}

// Diagnostico do "Wrong sign" sem expor a chave: so tamanho e formato.
function diagnosticoChave() {
  const bruta = String(process.env.SHOPEE_PARTNER_KEY || "");
  const limpa = bruta.trim();
  return {
    tamanho: limpa.length,
    tinhaEspacoOuQuebra: bruta !== limpa,
    comecaComShpk: limpa.startsWith("shpk"),
    temAsteriscos: limpa.includes("*"),
    partnerIdBruto: String(process.env.SHOPEE_PARTNER_ID || "").trim(),
  };
}

function configurado() {
  const { partnerId, partnerKey } = config();
  return Boolean(partnerId && partnerKey);
}

function assinar(base) {
  return crypto.createHmac("sha256", config().partnerKey).update(base).digest("hex");
}

const agora = () => Math.floor(Date.now() / 1000);

let tabelaPronta = null;
function garantirTabela() {
  if (!tabelaPronta) {
    tabelaPronta = db
      .query(
        `CREATE TABLE IF NOT EXISTS shopee_contas (
           shop_id BIGINT PRIMARY KEY,
           nome TEXT,
           ambiente TEXT NOT NULL,
           access_token TEXT NOT NULL,
           refresh_token TEXT NOT NULL,
           expires_at BIGINT NOT NULL,
           refresh_expires_at BIGINT,
           criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
           atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      )
      .catch((err) => {
        tabelaPronta = null; // tenta de novo na proxima chamada
        throw err;
      });
  }
  return tabelaPronta;
}

// Link que manda o vendedor autorizar a loja. "redirect" precisa estar no
// dominio cadastrado no app (Redirect URL Domain no console).
function linkAutorizacao(redirect) {
  const { partnerId, host } = config();
  const path = "/api/v2/shop/auth_partner";
  const ts = agora();
  const sign = assinar(`${partnerId}${path}${ts}`);
  const qs = new URLSearchParams({ partner_id: String(partnerId), timestamp: String(ts), sign, redirect });
  return `${host}${path}?${qs}`;
}

async function postPublico(path, corpo) {
  const { partnerId, host } = config();
  const ts = agora();
  const sign = assinar(`${partnerId}${path}${ts}`);
  const qs = new URLSearchParams({ partner_id: String(partnerId), timestamp: String(ts), sign });
  const res = await fetch(`${host}${path}?${qs}`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...corpo, partner_id: partnerId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Shopee ${path}: ${data.error || res.status} ${data.message || ""}`.trim());
  }
  return data;
}

async function gravarTokens(shopId, data, nome) {
  await garantirTabela();
  const expiresAt = Date.now() + Number(data.expire_in || 14400) * 1000;
  // refresh_token: a doc fala em ~30 dias; nao vem o prazo na resposta.
  const refreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await db.query(
    `INSERT INTO shopee_contas (shop_id, nome, ambiente, access_token, refresh_token, expires_at, refresh_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (shop_id) DO UPDATE SET
       nome = COALESCE(EXCLUDED.nome, shopee_contas.nome),
       ambiente = EXCLUDED.ambiente,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       atualizado_em = now()`,
    [String(shopId), nome || null, ambiente(), data.access_token, data.refresh_token, expiresAt, refreshExpiresAt]
  );
}

// Troca o "code" do retorno da autorizacao pelos tokens da loja.
async function trocarCodigo(code, shopId) {
  const data = await postPublico("/api/v2/auth/token/get", { code, shop_id: Number(shopId) });
  await gravarTokens(shopId, data);
  return data;
}

// Varias abas/coletores podem pedir token ao mesmo tempo: uma renovacao por
// loja de cada vez, senao a segunda usa o refresh_token que a primeira ja
// invalidou e a loja "cai".
const renovando = new Map();

async function tokenValido(shopId) {
  await garantirTabela();
  const { rows } = await db.query("SELECT * FROM shopee_contas WHERE shop_id = $1", [String(shopId)]);
  const conta = rows[0];
  if (!conta) throw new Error(`Loja Shopee ${shopId} nao conectada.`);
  if (Number(conta.expires_at) - MARGEM_RENOVACAO_MS > Date.now()) return conta.access_token;

  if (!renovando.has(String(shopId))) {
    const p = postPublico("/api/v2/auth/access_token/get", {
      refresh_token: conta.refresh_token,
      shop_id: Number(shopId),
    })
      .then(async (data) => {
        await gravarTokens(shopId, data);
        return data.access_token;
      })
      .finally(() => renovando.delete(String(shopId)));
    renovando.set(String(shopId), p);
  }
  return renovando.get(String(shopId));
}

// Chamada de loja. Devolve { status, corpo } sem lancar excecao — a sonda
// precisa ver o erro cru tanto quanto o sucesso. Para uso "normal", ver
// chamarLoja (lanca em erro).
async function chamarLojaCru(shopId, path, { query = {}, metodo = "GET", corpo } = {}) {
  const { partnerId, host } = config();
  const accessToken = await tokenValido(shopId);
  const ts = agora();
  const sign = assinar(`${partnerId}${path}${ts}${accessToken}${shopId}`);
  const qs = new URLSearchParams({
    partner_id: String(partnerId),
    timestamp: String(ts),
    access_token: accessToken,
    shop_id: String(shopId),
    sign,
  });
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  try {
    const res = await fetch(`${host}${path}?${qs}`, {
      method: metodo,
      signal: AbortSignal.timeout(20_000),
      headers: metodo === "POST" ? { "Content-Type": "application/json" } : {},
      body: metodo === "POST" ? JSON.stringify(corpo || {}) : undefined,
    });
    const texto = await res.text();
    let json;
    try {
      json = JSON.parse(texto);
    } catch {
      json = { _naoJson: texto.slice(0, 500) };
    }
    return { status: res.status, corpo: json };
  } catch (err) {
    return { status: 0, corpo: { erroDeRede: err.message } };
  }
}

async function chamarLoja(shopId, path, opcoes) {
  const { status, corpo } = await chamarLojaCru(shopId, path, opcoes);
  if (status !== 200 || corpo.error) {
    throw new Error(`Shopee ${path}: ${corpo.error || status} ${corpo.message || ""}`.trim());
  }
  return corpo;
}

async function listarContas() {
  await garantirTabela();
  const { rows } = await db.query(
    "SELECT shop_id, nome, ambiente, expires_at, refresh_expires_at, atualizado_em FROM shopee_contas ORDER BY nome NULLS LAST, shop_id"
  );
  return rows;
}

async function definirNome(shopId, nome) {
  await garantirTabela();
  await db.query("UPDATE shopee_contas SET nome = $2, atualizado_em = now() WHERE shop_id = $1", [String(shopId), nome]);
}

async function removerConta(shopId) {
  await garantirTabela();
  await db.query("DELETE FROM shopee_contas WHERE shop_id = $1", [String(shopId)]);
}

module.exports = {
  config,
  configurado,
  diagnosticoChave,
  ambiente,
  linkAutorizacao,
  trocarCodigo,
  tokenValido,
  chamarLoja,
  chamarLojaCru,
  listarContas,
  definirNome,
  removerConta,
};
