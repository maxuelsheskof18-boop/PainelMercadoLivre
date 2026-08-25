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
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
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
async function fetchPendingRead(accessToken) {
  return mlFetch(`/messages/pending_read?role=seller`, accessToken);
}

// Busca a conversa completa de um pedido (pack).
async function fetchPackMessages(accessToken, packId, sellerId) {
  return mlFetch(
    `/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`,
    accessToken
  );
}

// Segue um link de recurso vindo de um webhook (ex: "/messages/packs/123/sellers/456").
async function fetchResource(accessToken, resourcePath) {
  return mlFetch(resourcePath, accessToken);
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
  fetchResource,
  sendMessage,
  fetchMe,
};
