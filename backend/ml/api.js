// Chamadas a API de mensagens pos-venda do Mercado Livre.
// Doc oficial: https://developers.mercadolivre.com.br/pt_br/mensagens-post-venda
//
// IMPORTANTE: os nomes de campo abaixo seguem a documentacao oficial no
// momento em que este projeto foi gerado. Na primeira sincronizacao real
// (com uma conta e mensagens de verdade), confira os logs de debug
// (console.log do payload cru) e, se algum campo vier com nome diferente,
// e so ajustar aqui — a estrutura do resto do app nao muda.

const API_BASE = "https://api.mercadolibre.com";

async function mlFetch(path, accessToken, options = {}) {
  const base = path.startsWith("http") ? path : `${API_BASE}${path}`;

  // A API de mensagens pos-venda e uma das mais antigas do Mercado Livre e,
  // segundo a documentacao oficial, espera o token como query string
  // (?access_token=...) em vez do cabecalho Authorization moderno usado
  // pelo resto da API. Mandamos dos dois jeitos ao mesmo tempo — nao tem
  // custo mandar os dois, e isso cobre qualquer uma das duas exigencias.
  const url = new URL(base);
  if (!url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", accessToken);
  }

  const res = await fetch(url.toString(), {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Mercado Livre API ${res.status} em ${path}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Lista os packs/pedidos com mensagens nao lidas para essa conta.
//
// A documentacao do Mercado Livre sobre esse endpoint esta inconsistente
// entre si (paginas diferentes, aparentemente de epocas diferentes,
// descrevem caminhos diferentes). Ja vimos 404 em pelo menos um deles nessa
// conta. Em vez de apostar em um so, tentamos varios candidatos conhecidos,
// em ordem, e usamos o primeiro que responder com sucesso — registrando
// nos logs o resultado de cada tentativa pra sabermos exatamente qual
// funciona nessa conta.
const PENDING_READ_CANDIDATES = [
  "/messages/pending_read?role=seller",
  "/messages/unread?role=seller",
  "/messages/packs?tag=post_sale&role=seller",
];

async function fetchPendingRead(accessToken) {
  const attempts = [];
  for (const path of PENDING_READ_CANDIDATES) {
    try {
      const data = await mlFetch(path, accessToken);
      console.log(`[fetchPendingRead] sucesso em ${path}`);
      return data;
    } catch (err) {
      attempts.push(`${path} -> ${err.status || "?"} ${JSON.stringify(err.body || err.message)}`);
      console.warn(`[fetchPendingRead] falhou em ${path}: ${err.status}`, err.body || err.message);
    }
  }
  const err = new Error(
    `Nenhum endpoint de mensagens pendentes funcionou. Tentativas: ${attempts.join(" | ")}`
  );
  err.attempts = attempts;
  throw err;
}

// Busca a conversa completa de um pedido (pack).
async function fetchPackMessages(accessToken, packId, sellerId) {
  return mlFetch(
    `/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`,
    accessToken
  );
}

// Busca pedidos recentes do vendedor (API de Orders, bem mais estavel/
// documentada que a de mensagens). Usado so pra diagnostico: cada pedido
// devolve "pack_id" (as vezes null, quando o pedido nao faz parte de um
// envio combinado) e "id" (o order_id).
async function fetchRecentOrders(accessToken, sellerId) {
  return mlFetch(
    `/orders/search?seller=${sellerId}&sort=date_desc&limit=5`,
    accessToken
  );
}

// Segue um link de recurso vindo de um webhook (ex: "/messages/packs/123/sellers/456").
async function fetchResource(accessToken, resourcePath) {
  return mlFetch(resourcePath, accessToken);
}

// Extrai pack_id (e seller_id, quando presente) de um "resource" devolvido
// pela API do Mercado Livre. O formato muda dependendo de onde ele vem:
//   - webhook de notificacao:        "/messages/packs/{pack_id}/sellers/{seller_id}"
//   - GET /messages/pending_read:    "/packs/{pack_id}/sellers/{seller_id}"
//   - GET /messages/packs (novo):    "/packs/{pack_id}" (sem "/sellers/...")
// O regex captura so o pack_id como obrigatorio; o seller_id, quando vem
// no resource, e capturado a parte (pode nao existir).
function parsePackResource(resource) {
  const match = /packs\/([^/?]+)(?:\/sellers\/([^/?]+))?/i.exec(resource || "");
  if (!match) return null;
  return { packId: match[1], sellerId: match[2] || null };
}

// Envia uma resposta numa conversa.
async function sendMessage({
  accessToken,
  packId,
  sellerId,
  buyerId,
  sellerEmail,
  text,
}) {
  return mlFetch(`/messages/packs/${packId}/sellers/${sellerId}`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: { user_id: String(sellerId), ...(sellerEmail ? { email: sellerEmail } : {}) },
      to: { user_id: String(buyerId) },
      text,
    }),
  });
}

// Dados basicos do usuario autenticado (usado logo apos o OAuth para
// confirmar qual conta/vendedor foi conectado).
async function fetchMe(accessToken) {
  return mlFetch(`/users/me`, accessToken);
}

module.exports = {
  fetchPendingRead,
  fetchPackMessages,
  fetchRecentOrders,
  fetchResource,
  parsePackResource,
  sendMessage,
  fetchMe,
};
