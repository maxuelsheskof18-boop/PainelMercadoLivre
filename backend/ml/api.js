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
//
// A documentacao "antiga" do Mercado Livre descreve o endpoint
// /messages/pending_read, mas ele pode devolver 404 (parece ter sido
// descontinuado/substituido em algumas contas). A documentacao mais
// recente usa /messages/packs?tag=post_sale&role=seller. Por seguranca,
// tentamos o primeiro e, se der 404, caimos automaticamente pro segundo —
// assim nao dependemos de adivinhar qual esta ativo pra essa conta.
async function fetchPendingRead(accessToken) {
  try {
    return await mlFetch(`/messages/pending_read?role=seller`, accessToken);
  } catch (err) {
    if (err.status === 404) {
      console.warn(
        "[fetchPendingRead] /messages/pending_read deu 404, tentando /messages/packs?tag=post_sale&role=seller"
      );
      return mlFetch(`/messages/packs?tag=post_sale&role=seller`, accessToken);
    }
    throw err;
  }
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
  fetchResource,
  parsePackResource,
  sendMessage,
  fetchMe,
};
