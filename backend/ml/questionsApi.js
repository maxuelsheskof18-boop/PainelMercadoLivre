// Chamadas a API de PERGUNTAS (Q&A publica do anuncio, antes da compra) do
// Mercado Livre — sistema SEPARADO tanto das mensagens pos-venda
// (ml/api.js) quanto das reclamacoes (ml/claimsApi.js). Pedido do usuario:
// "Ate perguntas nos anuncio tambem queria que puxasse que sao as duvidas
// antes da compra".
//
// IMPORTANTE (mesma ressalva que ja valeu, nesse projeto, tanto pra
// mensagens quanto pra reclamacoes): os nomes de endpoint/campo abaixo
// seguem a documentacao publica no momento em que este arquivo foi escrito.
// Assim que a primeira pergunta de verdade passar por aqui, confira a rota
// /api/debug/probe-questions (ver routes/questions.js) — se algum nome vier
// diferente, e so ajustar aqui, a estrutura do resto do app nao muda.
const API_BASE = "https://api.mercadolibre.com";

// Ver o mesmo comentario em ml/api.js (REQUEST_TIMEOUT_MS) — nenhuma chamada
// externa deve poder travar pra sempre.
const REQUEST_TIMEOUT_MS = 20_000;

async function questionsFetch(path, accessToken, options = {}) {
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
      "Content-Type": "application/json",
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
    const err = new Error(`Mercado Livre Questions API ${res.status} em ${path}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Lista as perguntas recebidas pela conta autenticada. "status" (opcional)
// filtra por 'UNANSWERED' | 'ANSWERED' | 'CLOSED_UNANSWERED' | 'UNDER_REVIEW'
// (o Mercado Livre documenta esses valores em maiusculo pra esse endpoint).
async function fetchQuestions(accessToken, sellerId, { status, offset = 0, limit = 50 } = {}) {
  const params = new URLSearchParams({
    seller_id: String(sellerId),
    offset: String(offset),
    limit: String(limit),
    sort_fields: "date_created",
    sort_types: "DESC",
  });
  if (status) params.set("status", status);
  return questionsFetch(`/marketplace/questions/search?${params.toString()}`, accessToken);
}

// Busca UMA pergunta especifica pelo id — usado quando o webhook avisa de
// uma pergunta nova/atualizada pelo resource ("/marketplace/questions/{id}").
async function fetchQuestionById(accessToken, questionId) {
  return questionsFetch(`/marketplace/questions/${questionId}`, accessToken);
}

// Responde uma pergunta. Uma vez respondida, o Mercado Livre nao permite
// mais nenhuma interacao nessa pergunta (nao e uma conversa de ida-e-volta
// como mensagens/reclamacoes) — por isso so existe esse envio, sem
// anexo/mediador/etc.
async function answerQuestion(accessToken, questionId, text) {
  return questionsFetch(`/marketplace/answers/`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      question_id: Number(questionId) || questionId,
      text,
    }),
  });
}

module.exports = {
  fetchQuestions,
  fetchQuestionById,
  answerQuestion,
};
