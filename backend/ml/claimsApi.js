// Chamadas a API de RECLAMACOES (Central de Resolucoes/mediacao) do Mercado
// Livre — sistema SEPARADO da API de mensagens pos-venda (ml/api.js). Doc
// oficial: https://developers.mercadolivre.com.br/pt_br/gerenciar-reclamacoes
//
// Assim como em ml/api.js: os nomes de campo abaixo seguem a documentacao
// oficial no momento em que este trecho foi escrito. Na primeira reclamacao
// real, confira os logs de debug (ou a rota /api/debug/probe-claims) e, se
// algum campo vier diferente, ajuste so aqui.
const API_BASE = "https://api.mercadolibre.com";

// Ver o mesmo comentario em ml/api.js (REQUEST_TIMEOUT_MS) — nenhuma chamada
// externa deve poder travar pra sempre.
const REQUEST_TIMEOUT_MS = 20_000;

async function claimsFetch(path, accessToken, options = {}) {
  const base = path.startsWith("http") ? path : `${API_BASE}${path}`;
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
    const err = new Error(`Mercado Livre Claims API ${res.status} em ${path}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Lista as reclamacoes da conta autenticada. "status" (opcional) filtra por
// 'opened' ou 'closed'. A API ja devolve so as reclamacoes que envolvem o
// dono do token (como reclamante ou reclamado) — nao precisa filtrar por
// player manualmente.
async function fetchClaims(accessToken, { status, offset = 0, limit = 50 } = {}) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    sort: "date_created:desc",
  });
  if (status) params.set("status", status);
  return claimsFetch(`/post-purchase/v1/claims/search?${params.toString()}`, accessToken);
}

// Busca o detalhe de UMA reclamacao especifica (usado quando o webhook avisa
// de uma reclamacao pelo id, sem precisar esperar ela aparecer de novo na
// busca geral).
async function fetchClaimById(accessToken, claimId) {
  return claimsFetch(`/post-purchase/v1/claims/${claimId}`, accessToken);
}

// Busca todas as mensagens trocadas numa reclamacao. Endpoint em
// marketplace/v2 (o antigo post-purchase/v1/claims/.../messages ainda
// devolve leitura, mas o envio nesse antigo caminho parou de aceitar POST —
// ver sendClaimMessage abaixo — entao migramos a leitura tambem pra v2 pra
// usar sempre a versao atual e evitar formatos divergentes).
async function fetchClaimMessages(accessToken, claimId) {
  return claimsFetch(`/marketplace/v2/claims/${claimId}/messages`, accessToken);
}

// Envia uma mensagem numa reclamacao — com ou sem anexo, tanto faz (o
// endpoint e o mesmo, "attachments" so vem vazio quando nao ha anexo).
// "receiverRole" e 'complainant' (comprador, so funciona antes de virar
// mediacao) ou 'mediator' (Mercado Livre, depois que a reclamacao vira
// disputa/mediacao — ver decideReceiverRole em claimsSync.js).
//
// Endpoint corrigido (agosto/2026): o Mercado Livre desativou o POST no
// antigo /post-purchase/v1/claims/{id}/messages (passou a devolver "Request
// method 'POST' is not supported") e no /post-purchase/v1/claims/{id}/
// actions/message — o envio de mensagem (com ou sem anexo) agora e so por
// aqui: POST /marketplace/v2/claims/{id}/actions/send-message.
async function sendClaimMessage(accessToken, claimId, receiverRole, text, attachmentIds = []) {
  return claimsFetch(`/marketplace/v2/claims/${claimId}/actions/send-message`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      receiver_role: receiverRole,
      message: text,
      attachments: attachmentIds,
    }),
  });
}

// Envia um ANEXO (foto, nota fiscal, comprovante — ate 5MB, JPG/PNG/PDF/TXT)
// pra reclamacao. Devolve um identificador (nome de arquivo com hash) que
// precisa ser referenciado em sendClaimMessage logo depois — o upload em si
// NAO manda a mensagem, so guarda o arquivo. Mesma migracao de endpoint que
// sendClaimMessage acima (post-purchase/v1 -> marketplace/v2).
async function uploadClaimAttachment(accessToken, claimId, buffer, filename, mimetype) {
  const form = new FormData();
  form.set("file", new Blob([buffer], { type: mimetype || "application/octet-stream" }), filename);

  const url = new URL(`${API_BASE}/marketplace/v2/claims/${claimId}/attachments`);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString(), {
    method: "POST",
    // Upload pode demorar mais que uma chamada normal — ver comentario
    // analogo em ml/api.js::uploadMessageAttachment.
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
    const err = new Error(`Mercado Livre Claims API ${res.status} ao enviar anexo`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Mantido so pra nao quebrar quem ainda chama pelo nome antigo — repassa
// direto pra sendClaimMessage (o endpoint novo e o mesmo, com ou sem anexo).
async function sendClaimMessageWithAttachments(accessToken, claimId, receiverRole, text, attachmentIds) {
  return sendClaimMessage(accessToken, claimId, receiverRole, text, attachmentIds);
}

// Envia o comprovante de envio pra uma reclamacao do tipo "produto nao
// recebido" (PNR). "payload" varia de acordo com shipping_method (ver
// backend/routes/claims.js pra validacao dos campos obrigatorios de cada
// metodo).
async function sendShippingEvidence(accessToken, claimId, payload) {
  return claimsFetch(`/post-purchase/v1/claims/${claimId}/evidences`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "shipping_evidence", ...payload }),
  });
}

// Baixa o ARQUIVO de um anexo trocado numa reclamacao (o comprador manda
// fotos/videos como evidencia, e essas evidencias ficam disponiveis pelo
// mesmo id/"filename" que aparece no campo "attachments" de cada mensagem —
// ver upsertClaim em claimsSync.js). Endpoint documentado separado do de
// upload (que fica em /post-purchase/v1/...): esse de download usa a rota
// "marketplace/v2". Devolve o arquivo cru (buffer) + o content-type, pra
// rota do painel repassar pro navegador sem expor o access_token pro
// front-end.
async function fetchClaimAttachmentFile(accessToken, claimId, attachmentId) {
  const url = new URL(`${API_BASE}/marketplace/v2/claims/${claimId}/attachments/${attachmentId}/download`);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString(), {
    // Download tambem pode demorar mais que uma chamada normal.
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    const err = new Error(`Mercado Livre Claims API ${res.status} ao baixar anexo`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}

module.exports = {
  fetchClaims,
  fetchClaimById,
  fetchClaimMessages,
  sendClaimMessage,
  uploadClaimAttachment,
  sendClaimMessageWithAttachments,
  sendShippingEvidence,
  fetchClaimAttachmentFile,
};
