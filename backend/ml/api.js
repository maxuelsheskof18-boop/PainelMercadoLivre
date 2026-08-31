// Chamadas a API de mensagens pos-venda do Mercado Livre.
// Doc oficial: https://developers.mercadolivre.com.br/pt_br/mensagens-post-venda
//
// IMPORTANTE: os nomes de campo abaixo seguem a documentacao oficial no
// momento em que este projeto foi gerado. Na primeira sincronizacao real
// (com uma conta e mensagens de verdade), confira os logs de debug
// (console.log do payload cru) e, se algum campo vier com nome diferente,
// e so ajustar aqui — a estrutura do resto do app nao muda.

const API_BASE = "https://api.mercadolibre.com";

// Nenhuma chamada a uma API externa deve poder travar pra sempre — ja
// aconteceu na pratica de o botao "Atualizar" do painel ficar girando
// indefinidamente porque uma chamada ao Mercado Livre simplesmente nunca
// respondia nem dava erro (o fetch nativo do Node nao tem timeout por
// padrao). Com esse limite, uma chamada travada falha depois de 20s (tempo
// de sobra pra uma API que normalmente responde em menos de 1s) em vez de
// travar a reconciliacao inteira — o item falha, fica registrado no log, e
// o painel segue pro proximo em vez de nunca mais terminar.
const REQUEST_TIMEOUT_MS = 20_000;

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
    signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

// Lista os packs/pedidos com mensagens NAO LIDAS pra essa conta — o mesmo
// dado que aparece no proprio painel de Vendas do Mercado Livre no filtro
// "Com mensagens não lidas". Usamos isso como mais uma rede de seguranca na
// reconciliacao (ver reconcileAccount em sync.js): as outras buscas dedicadas
// (no_shipping, delivered, atividade recente) sao todas baseadas em JANELAS
// de pedidos, e um pedido pode cair fora de todas elas numa conta de alto
// volume mesmo tendo mensagem nao lida esperando resposta — esse endpoint
// resolve isso porque nao depende de nenhuma janela, e sim exatamente do que
// o Mercado Livre ja sabe estar pendente de leitura.
//
// Endpoint correto (confirmado via documentacao — as tentativas antigas sem
// o prefixo "/marketplace" e sem "user_id" devolviam 404/formato errado):
// GET /marketplace/messages/unread?role=seller&tag=post_sale&user_id=$SELLER_ID
// Resposta: { results: [ { resource: "/packs/{pack_id}", count: N }, ... ] }
async function fetchUnreadMessagePacks(accessToken, sellerId) {
  const params = new URLSearchParams({
    role: "seller",
    tag: "post_sale",
    user_id: String(sellerId),
  });
  const data = await mlFetch(`/marketplace/messages/unread?${params.toString()}`, accessToken);
  const results = Array.isArray(data?.results) ? data.results : [];
  // "resource" vem como "/packs/{pack_id}" — extrai so o id.
  return results
    .map((r) => {
      const match = /\/packs\/(\w+)/.exec(r?.resource || "");
      return match ? { packId: match[1], count: r?.count ?? null } : null;
    })
    .filter(Boolean);
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

// Busca o detalhe de um ANUNCIO (titulo, link publico) — usado pelas
// perguntas pre-venda (ver backend/questionsSync.js), ja que a pergunta em
// si so traz o item_id, sem o titulo do produto.
async function fetchItemById(accessToken, itemId) {
  return mlFetch(`/items/${itemId}`, accessToken);
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
    // Upload pode legitimamente demorar mais que uma chamada normal (arquivo
    // ate 25MB) — timeout mais generoso que REQUEST_TIMEOUT_MS, mas ainda
    // finito, pelo mesmo motivo (nunca travar pra sempre).
    signal: AbortSignal.timeout(60_000),
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
  fetchUnreadMessagePacks,
  fetchPackMessages,
  fetchRecentOrders,
  fetchOrderById,
  fetchShipment,
  fetchItemById,
  fetchResource,
  parsePackResource,
  sendMessage,
  uploadMessageAttachment,
  fetchMe,
};
