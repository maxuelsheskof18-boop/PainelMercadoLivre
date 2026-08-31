// Sincronizacao das PERGUNTAS feitas no anuncio, antes da compra (Q&A
// publica) do Mercado Livre — sistema SEPARADO tanto das mensagens
// pos-venda (sync.js) quanto das reclamacoes (claimsSync.js). Mesma
// filosofia geral das outras duas: uma varredura periodica busca as
// perguntas nao respondidas de cada conta, guarda localmente, e classifica
// em 'pending' (aguardando o vendedor) ou 'answered' (ja respondida) pra
// alimentar uma aba propria no painel — pedido do usuario: "Igual mensagem
// mas com nova categoria de duvidas".
//
// Diferenca importante em relacao as outras duas: uma pergunta tem no
// maximo UMA resposta (nao e uma conversa de ida-e-volta) — uma vez
// respondida, acabou. Por isso nao ha uma tabela separada de mensagens, so
// os campos question_text/answer_text na propria linha (ver tabela
// "questions" em db.js).
const db = require("./db");
const { getValidAccessToken, withTokenRetry } = require("./ml/tokens");
const { fetchItemById } = require("./ml/api");
const { fetchQuestions, fetchQuestionById } = require("./ml/questionsApi");

const QUESTIONS_PAGE_SIZE = 50;
// Pergunta pre-venda tende a ter volume ainda menor que reclamacao — mesmo
// numa loja bem movimentada, poucas dezenas de perguntas sem resposta ao
// mesmo tempo ja seria atipico.
const QUESTIONS_MAX_PAGES = 3;

// Calcula o status local (pra aba/badge) a partir do status bruto do
// Mercado Livre. Aceita tanto maiusculo quanto minusculo porque a
// documentacao publica e inconsistente sobre isso dependendo do endpoint —
// ver comentario no topo de ml/questionsApi.js.
function computeLocalStatus(mlStatus) {
  const s = (mlStatus || "").toLowerCase();
  if (s === "answered") return "answered";
  if (s === "closed_unanswered") return "closed"; // Mercado Livre fechou sozinho sem resposta (ex: prazo ou anuncio removido)
  return "pending"; // 'unanswered' | 'under_review' | qualquer outro valor nao previsto
}

// Extrai os campos principais de uma pergunta. Segue o formato documentado
// (marketplace/questions/search) — se o Mercado Livre devolver algo
// diferente na pratica, a rota /api/debug/probe-questions ajuda a achar o
// nome certo rapido.
function extractQuestionInfo(question) {
  if (!question) return null;
  return {
    itemId: question.item_id != null ? String(question.item_id) : null,
    buyerId: question.from?.id != null ? String(question.from.id) : null,
    buyerNickname: question.from?.nickname || null,
    questionText: question.text || null,
    questionDate: question.date_created || null,
    mlStatus: question.status || null,
    answerText: question.answer?.text || null,
    answerDate: question.answer?.date_created || null,
  };
}

// Busca titulo/link publico do anuncio associado a pergunta — a pergunta em
// si so traz o item_id, sem esses dados (ver fetchItemById em ml/api.js).
async function fetchItemInfoForQuestion(sellerId, accessToken, itemId) {
  if (!itemId) return { itemInfo: null, accessToken };
  try {
    const result = await withTokenRetry(sellerId, accessToken, (token) => fetchItemById(token, itemId));
    const item = result.result;
    accessToken = result.accessToken;
    return {
      itemInfo: {
        title: item?.title || null,
        permalink: item?.permalink || null,
      },
      accessToken,
    };
  } catch (err) {
    console.warn(`[questions] nao consegui buscar detalhes do anuncio ${itemId}:`, err.status, err.body || err.message);
    return { itemInfo: null, accessToken };
  }
}

// Grava/atualiza uma pergunta no banco.
async function upsertQuestion(sellerId, question, itemInfo) {
  const info = extractQuestionInfo(question);
  if (!info) return;
  const questionId = String(question.id);
  const localStatus = computeLocalStatus(info.mlStatus);

  // Se essa pergunta ja foi respondida por aqui antes (operator_name
  // gravado na hora do envio — ver POST /questions/:id/reply), preserva
  // esse nome numa reconciliacao seguinte mesmo que o Mercado Livre nao
  // devolva essa informacao (ele nunca devolve "quem" respondeu, so o texto
  // da resposta).
  const { rows: existingRows } = await db.query(
    "SELECT operator_name FROM questions WHERE question_id = $1",
    [questionId]
  );
  const operatorName = existingRows[0]?.operator_name || null;

  await db.query(
    `INSERT INTO questions
       (question_id, seller_id, item_id, item_title, item_permalink, buyer_id, buyer_nickname, question_text, question_date, ml_status, local_status, answer_text, answer_date, operator_name, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
     ON CONFLICT (question_id) DO UPDATE SET
       item_id = COALESCE(EXCLUDED.item_id, questions.item_id),
       item_title = COALESCE(EXCLUDED.item_title, questions.item_title),
       item_permalink = COALESCE(EXCLUDED.item_permalink, questions.item_permalink),
       buyer_id = COALESCE(EXCLUDED.buyer_id, questions.buyer_id),
       buyer_nickname = COALESCE(EXCLUDED.buyer_nickname, questions.buyer_nickname),
       question_text = COALESCE(EXCLUDED.question_text, questions.question_text),
       question_date = COALESCE(EXCLUDED.question_date, questions.question_date),
       ml_status = EXCLUDED.ml_status,
       local_status = EXCLUDED.local_status,
       answer_text = COALESCE(EXCLUDED.answer_text, questions.answer_text),
       answer_date = COALESCE(EXCLUDED.answer_date, questions.answer_date),
       operator_name = EXCLUDED.operator_name,
       updated_at = now()`,
    [
      questionId,
      String(sellerId),
      info.itemId,
      itemInfo?.title ?? null,
      itemInfo?.permalink ?? null,
      info.buyerId,
      info.buyerNickname,
      info.questionText,
      info.questionDate,
      info.mlStatus,
      localStatus,
      info.answerText,
      info.answerDate,
      operatorName,
    ]
  );
}

// Sincroniza UMA pergunta especifica pelo id — usado tanto pelo webhook
// (tempo real) quanto pela reverificacao de perguntas ja pendentes.
async function syncQuestion(sellerId, questionId) {
  const accessToken = await getValidAccessToken(sellerId);
  const question = await fetchQuestionById(accessToken, questionId);
  const info = extractQuestionInfo(question);
  const { itemInfo } = await fetchItemInfoForQuestion(sellerId, accessToken, info?.itemId);
  await upsertQuestion(sellerId, question, itemInfo);
}

// Varredura periodica de UMA conta: busca as perguntas ainda sem resposta, e
// reverifica as que estavam pendentes localmente pra ver se ja foram
// respondidas ou fechadas por fora deste painel (ex: pelo app oficial do
// Mercado Livre no celular) — sem isso, uma pergunta respondida por fora
// ficaria "presa" pra sempre na aba de pendentes aqui.
async function reconcileQuestionsForAccount(sellerId) {
  // Ver o comentario extenso em reconcileAccount (sync.js) sobre o mesmo
  // bug (token capturado uma unica vez pode vencer no meio de uma
  // reconciliacao longa, ou ser invalidado por outra reconciliacao rodando
  // em paralelo) e sobre por que a correcao NAO reconfirma o token
  // proativamente a cada item (isso ja causou uma regressao real — ver
  // withTokenRetry em ml/tokens.js). Aqui cada chamada arriscada usa
  // withTokenRetry, que so renova o token se a chamada realmente falhar.
  let accessToken = await getValidAccessToken(sellerId);

  const all = [];
  let offset = 0;
  let total = 0;
  for (let page = 0; page < QUESTIONS_MAX_PAGES; page++) {
    let data;
    try {
      data = await fetchQuestions(accessToken, sellerId, { status: "unanswered", offset, limit: QUESTIONS_PAGE_SIZE });
    } catch (err) {
      console.warn(`[questions] falha ao buscar perguntas sem resposta da conta ${sellerId}:`, err.status, err.body || err.message);
      break;
    }
    const results = Array.isArray(data?.questions) ? data.questions : Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    offset += results.length;
    total = data?.total ?? data?.paging?.total ?? offset;
    if (results.length === 0 || offset >= total) break;
  }

  let processadas = 0;
  for (const question of all) {
    try {
      const info = extractQuestionInfo(question);
      const { itemInfo, accessToken: tokenAfterItem } = await fetchItemInfoForQuestion(sellerId, accessToken, info?.itemId);
      accessToken = tokenAfterItem;
      await upsertQuestion(sellerId, question, itemInfo);
      processadas++;
    } catch (err) {
      console.warn(`[questions] falha ao sincronizar pergunta ${question?.id}:`, err.status, err.body || err.message);
    }
  }

  // Reverifica perguntas que este painel ainda acha que estao pendentes —
  // se ja foram respondidas/fechadas por fora, essa e a unica forma de
  // descobrir (a busca por status=unanswered acima nunca mais vai trazer de
  // volta uma pergunta ja respondida).
  const { rows: trackedPending } = await db.query(
    `SELECT question_id FROM questions WHERE seller_id = $1 AND local_status = 'pending'`,
    [sellerId]
  );
  let atualizadas = 0;
  for (const row of trackedPending) {
    if (all.some((q) => String(q.id) === row.question_id)) continue; // ja atualizada acima
    try {
      await syncQuestion(sellerId, row.question_id);
      const { rows: check } = await db.query("SELECT local_status FROM questions WHERE question_id = $1", [row.question_id]);
      if (check[0]?.local_status && check[0].local_status !== "pending") atualizadas++;
    } catch (err) {
      console.warn(`[questions] falha ao reverificar pergunta ${row.question_id}:`, err.status, err.body || err.message);
    }
  }

  console.log(
    `[questions] conta ${sellerId}: ${all.length} pergunta(s) sem resposta encontrada(s) (${processadas} sincronizada(s)), ${trackedPending.length} pendente(s) rastreada(s) reverificada(s) (${atualizadas} mudaram de status agora).`
  );
}

async function reconcileAllQuestions() {
  const { rows: accounts } = await db.query("SELECT id FROM accounts");
  for (const acc of accounts) {
    try {
      await reconcileQuestionsForAccount(acc.id);
    } catch (err) {
      console.error(`[questions] falha na conta ${acc.id}:`, err.message);
    }
  }
}

module.exports = {
  reconcileQuestionsForAccount,
  reconcileAllQuestions,
  syncQuestion,
  extractQuestionInfo,
  upsertQuestion,
  computeLocalStatus,
};
