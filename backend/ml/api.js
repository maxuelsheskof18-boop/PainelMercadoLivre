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
// documentada que a de mensagens — confirmamos por teste real que ela
// funciona quando o "listar mensagens pendentes" nao funciona). Cada
// pedido devolve "pack_id" (as vezes null, quando o pedido nao faz parte
// de um envio combinado — nesse caso usa-se o proprio order_id) e "id"
// (o order_id).
//
// "tags" (opcional) filtra so pedidos com aquela tag — ex: "no_shipping"
// pra pegar direto os pedidos de "combinar entrega", sem depender de eles
// estarem entre os N pedidos mais recentes gerais (ver uso em sync.js).
// "offset" (opcional) pagina alem dos primeiros resultados.
// "dateLastUpdatedFrom"/"dateLastUpdatedTo" (opcional) filtram por
// order.date_last_updated — a API documenta esse campo separado de
// date_created, o que permite achar pedidos ANTIGOS que tiveram alguma
// atividade recente (ex: status mudou, ou — na esperanca que o campo
// reflita isso tambem — uma mensagem nova chegou), mesmo que o pedido em
// si nao esteja entre os mais recentes por data de criacao (ver uso em
// sync.js).
// "dateCreatedFrom"/"dateCreatedTo" (opcional) filtram por
// order.date_created — usado pra varrer o historico MES A MES (ver
// runBackfillStep em sync.js): em vez de tentar achar pedidos antigos
// "adivinhando" por atividade recente, isso deixa varrer sistematicamente
// um mes inteiro de cada vez, garantindo que todo pedido daquele mes seja
// checado pelo menos uma vez, nao importa o quao antigo.
async function fetchRecentOrders(
  accessToken,
  sellerId,
  { limit = 50, offset = 0, tags, dateLastUpdatedFrom, dateLastUpdatedTo, dateCreatedFrom, dateCreatedTo } = {}
) {
  const params = new URLSearchParams({
    seller: sellerId,
    sort: "date_desc",
    limit: String(limit),
    offset: String(offset),
  });
  if (tags) params.set("tags", tags);
  if (dateLastUpdatedFrom) params.set("order.date_last_updated.from", dateLastUpdatedFrom);
  if (dateLastUpdatedTo) params.set("order.date_last_updated.to", dateLastUpdatedTo);
  if (dateCreatedFrom) params.set("order.date_created.from", dateCreatedFrom);
  if (dateCreatedTo) params.set("order.date_created.to", dateCreatedTo);
  return mlFetch(`/orders/search?${params.toString()}`, accessToken);
}

// Busca o detalhe completo de um pedido (inclui o campo "shipping.id").
async function fetchOrderById(accessToken, orderId) {
  return mlFetch(`/orders/${orderId}`, accessToken);
}

// Busca o detalhe completo de um envio — e aqui que vem o campo que
// identifica o TIPO de entrega (ex: se e "a combinar com o comprador").
async function fetchShipment(accessToken, shipmentId) {
  return mlFetch(`/shipments/${shipmentId}`, accessToken);
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
//
// Diferente do GET (que so precisa do access_token), a documentacao oficial
// do POST de mensagens pos-venda tambem exige a identificacao da PROPRIA
// APLICACAO: o parametro "application_id" na URL e o cabecalho "X-Client-Id",
// ambos com o client_id da aplicacao (o mesmo ML_CLIENT_ID usado no OAuth).
// Isso ja foi adicionado, mas mesmo assim o Mercado Livre continuou
// respondendo 404 "resource not found" em producao — entao tambem
// adicionamos "?tag=post_sale" na URL, igual ao GET (fetchPackMessages),
// que e o unico que sabidamente funciona pra essa conta. A hipotese e que,
// sem essa tag, o Mercado Livre nao acha o pack como um recurso de mensagem
// pos-venda (pode existir mais de um "tipo" de pack/conversa com o mesmo id).
async function sendMessage({
  accessToken,
  packId,
  sellerId,
  buyerId,
  sellerEmail,
  text,
  attachmentIds,
}) {
  const clientId = process.env.ML_CLIENT_ID;
  const params = new URLSearchParams({ tag: "post_sale" });
  if (clientId) params.set("application_id", clientId);
  const path = `/messages/packs/${packId}/sellers/${sellerId}?${params.toString()}`;

  console.log(`[sendMessage] chamando POST ${path}`);

  // Importante (documentado pelo Mercado Livre): quando nao ha anexo, a
  // chave "attachments" precisa ficar TOTALMENTE FORA do JSON — mandar um
  // array vazio nao e a mesma coisa e pode quebrar o envio. Por isso o
  // spread condicional abaixo.
  return mlFetch(path, accessToken, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(clientId ? { "X-Client-Id": clientId } : {}),
    },
    body: JSON.stringify({
      from: { user_id: String(sellerId), ...(sellerEmail ? { email: sellerEmail } : {}) },
      to: { user_id: String(buyerId) },
      text,
      ...(attachmentIds && attachmentIds.length ? { attachments: attachmentIds } : {}),
    }),
  });
}

// Envia um ANEXO (foto, PDF, etc. — ate 25MB, JPG/PNG/PDF/TXT) pra ser
// referenciado numa mensagem pos-venda logo em seguida (ver sendMessage
// acima). Mesmo padrao de backend/ml/claimsApi.js::uploadClaimAttachment,
// so que num endpoint diferente e com limite de tamanho maior — a API de
// reclamacoes e a de mensagens pos-venda sao sistemas separados no Mercado
// Livre, cada uma com seu proprio endpoint de upload.
async function uploadMessageAttachment(accessToken, buffer, filename, mimetype) {
  const form = new FormData();
  form.set("file", new Blob([buffer], { type: mimetype || "application/octet-stream" }), filename);

  const url = new URL(`${API_BASE}/messages/attachments`);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Mercado Livre API ${res.status} ao enviar anexo de mensagem`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
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
  fetchOrderById,
  fetchShipment,
  fetchResource,
  parsePackResource,
  sendMessage,
  uploadMessageAttachment,
  fetchMe,
};
