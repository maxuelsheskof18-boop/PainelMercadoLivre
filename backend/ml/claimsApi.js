// Chamadas a API de RECLAMACOES (Central de Resolucoes/mediacao) do Mercado
// Livre — sistema SEPARADO da API de mensagens pos-venda (ml/api.js). Doc
// oficial: https://developers.mercadolivre.com.br/pt_br/gerenciar-reclamacoes
//
// Assim como em ml/api.js: os nomes de campo abaixo seguem a documentacao
// oficial no momento em que este trecho foi escrito. Na primeira reclamacao
// real, confira os logs de debug (ou a rota /api/debug/probe-claims) e, se
// algum campo vier diferente, ajuste so aqui.
const API_BASE = "https://api.mercadolibre.com";

async function claimsFetch(path, accessToken, options = {}) {
  const base = path.startsWith("http") ? path : `${API_BASE}${path}`;
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

// Busca todas as mensagens trocadas numa reclamacao.
async function fetchClaimMessages(accessToken, claimId) {
  return claimsFetch(`/post-purchase/v1/claims/${claimId}/messages`, accessToken);
}

// Envia uma mensagem de TEXTO (sem anexo) numa reclamacao. "receiverRole" e
// 'complainant' (comprador, so funciona antes de virar mediacao) ou
// 'mediator' (Mercado Livre, depois que a reclamacao vira disputa/mediacao —
// ver decideReceiverRole em claimsSync.js).
async function sendClaimMessage(accessToken, claimId, receiverRole, text) {
  return claimsFetch(`/post-purchase/v1/claims/${claimId}/messages`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ receiver_role: receiverRole, message: text }),
  });
}

// Envia um ANEXO (foto, nota fiscal, comprovante — ate 5MB, JPG/PNG/PDF/TXT)
// pra reclamacao. Devolve um identificador (nome de arquivo com hash) que
// precisa ser referenciado em sendClaimMessageWithAttachments logo depois —
// o upload em si NAO manda a mensagem, so guarda o arquivo.
async function uploadClaimAttachment(accessToken, claimId, buffer, filename, mimetype) {
  const form = new FormData();
  form.set("file", new Blob([buffer], { type: mimetype || "application/octet-stream" }), filename);

  const url = new URL(`${API_BASE}/post-purchase/v1/claims/${claimId}/attachments`);
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
    const err = new Error(`Mercado Livre Claims API ${res.status} ao enviar anexo`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Envia uma mensagem JUNTO com um ou mais anexos ja enviados por
// uploadClaimAttachment (usa os identificadores devolvidos por ele).
async function sendClaimMessageWithAttachments(accessToken, claimId, receiverRole, text, attachmentIds, applicationId) {
  const params = new URLSearchParams();
  if (applicationId) params.set("application_id", applicationId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return claimsFetch(`/post-purchase/v1/claims/${claimId}/actions/message${query}`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      receiver_role: receiverRole,
      message: text,
      attachments: attachmentIds,
    }),
  });
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

module.exports = {
  fetchClaims,
  fetchClaimById,
  fetchClaimMessages,
  sendClaimMessage,
  uploadClaimAttachment,
  sendClaimMessageWithAttachments,
  sendShippingEvidence,
};
