// Chamadas a API de PERGUNTAS (Q&A publica do anuncio, antes da compra) do
// Mercado Livre — sistema SEPARADO tanto das mensagens pos-venda
// (ml/api.js) quanto das reclamacoes (ml/claimsApi.js). Pedido do usuario:
// "Ate perguntas nos anuncio tambem queria que puxasse que sao as duvidas
// antes da compra".
//
// CORRIGIDO: a primeira versao deste arquivo usava paths "/marketplace/
// questions/..." (um palpite, por analogia com mensagens/reclamacoes, nunca
// confirmado contra a documentacao de verdade) — por isso NENHUMA pergunta
// jamais foi importada (toda chamada falhava, provavelmente com 404,
// silenciosamente registrada so como aviso no log a cada ciclo). Os paths
// certos, confirmados na documentacao oficial (developers.mercadolivre.com
// /en_us/manage-questions-and-answers): "/my/received_questions/search" pra
// listar, "/questions/{id}" pra buscar uma especifica, "/answers" pra
// responder. Os valores de status tambem sao documentados em MINUSCULO
// ('unanswered', 'answered', 'closed_unanswered', 'under_review').
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
// filtra por 'unanswered' | 'answered' | 'closed_unanswered' | 'under_review'
// (minusculo — documentado assim pra esse endpoint). "api_version=4" pede a
// estrutura de JSON nova (from.id, answer.text/status/date_created, etc.),
// que e a que o resto deste modulo (extractQuestionInfo em questionsSync.js)
// espera.
async function fetchQuestions(accessToken, sellerId, { status, offset = 0, limit = 50 } = {}) {
  const params = new URLSearchParams({
    seller_id: String(sellerId),
    offset: String(offset),
    limit: String(limit),
    sort_fields: "date_created",
    sort_types: "DESC",
    api_version: "4",
  });
  if (status) params.set("status", status);
  return questionsFetch(`/my/received_questions/search?${params.toString()}`, accessToken);
}

// Busca UMA pergunta especifica pelo id — usado quando o webhook avisa de
// uma pergunta nova/atualizada pelo resource ("/questions/{id}").
async function fetchQuestionById(accessToken, questionId) {
  return questionsFetch(`/questions/${questionId}`, accessToken);
}

// Responde uma pergunta. Uma vez respondida, o Mercado Livre nao permite
// mais nenhuma interacao nessa pergunta (nao e uma conversa de ida-e-volta
// como mensagens/reclamacoes) — por isso so existe esse envio, sem
// anexo/mediador/etc.
async function answerQuestion(accessToken, questionId, text) {
  return questionsFetch(`/answers`, accessToken, {
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
