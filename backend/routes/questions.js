// Rotas do painel pras PERGUNTAS feitas no anuncio, antes da compra (Q&A
// publica) — sistema separado tanto das conversas de mensagens pos-venda
// (routes/conversations.js) quanto das reclamacoes (routes/claims.js).
const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");
const { answerQuestion, fetchQuestions } = require("../ml/questionsApi");
const { reconcileAllQuestions, extractQuestionInfo } = require("../questionsSync");

const router = express.Router();
router.use(requireLogin);

// As duas rotas abaixo (lista e contador) sao chamadas o tempo todo (a
// cada 20s, pra atualizar o badge, e toda vez que a aba Perguntas abre) —
// se a tabela "questions" nao existir por algum motivo (ex: esse arquivo
// foi atualizado no GitHub mas backend/db.js — que cria a tabela — nao foi,
// ou o servico ainda nao reiniciou depois do deploy), sem o try/catch o
// erro batia direto no tratador padrao do Express e virava uma pagina HTML
// generica de erro 500, que o painel so conseguia mostrar como "Erro ao
// carregar." — sem nenhuma pista do motivo real. Com o try/catch, o erro
// exato do banco (ex: 'relation "questions" does not exist') volta como
// JSON e aparece na propria tela, sem precisar abrir nada tecnico.
router.get("/questions/pending-count", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE local_status = 'pending')::int AS pending FROM questions`
    );
    res.json({ pending: rows[0].pending });
  } catch (err) {
    console.error("[questions/pending-count]", err.message);
    res.status(500).json({ pending: 0, error: "Falha ao contar perguntas pendentes.", detail: err.message });
  }
});

router.get("/questions", async (req, res) => {
  try {
    const status = ["pending", "answered", "closed", "all"].includes(req.query.status)
      ? req.query.status
      : "pending";

    const conditions = [];
    const params = [];
    if (status !== "all") {
      params.push(status);
      conditions.push(`q.local_status = $${params.length}`);
    }

    if (req.query.sellerId) {
      params.push(req.query.sellerId);
      conditions.push(`q.seller_id = $${params.length}`);
    }

    // Filtro opcional "so pendentes (a responder)" — mesma ideia das outras
    // duas telas: forca pendente independente da aba aberta no momento.
    if (req.query.onlyPending === "1") {
      conditions.push("q.local_status = 'pending'");
    }

    const query = (req.query.q || "").trim();
    if (query) {
      params.push(`%${query}%`);
      const p = `$${params.length}`;
      conditions.push(`(q.buyer_nickname ILIKE ${p} OR q.item_title ILIKE ${p} OR q.question_text ILIKE ${p})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await db.query(
      `SELECT q.*, a.nickname AS seller_nickname
         FROM questions q
         JOIN accounts a ON a.id = q.seller_id
         ${where}
        ORDER BY q.question_date DESC NULLS LAST, q.updated_at DESC`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("[questions/list]", err.message);
    res.status(500).json({ error: "Falha ao carregar as perguntas.", detail: err.message });
  }
});

// Monta a "conversa" (na verdade so pergunta + resposta, no maximo) no mesmo
// formato usado pelas outras duas telas, pra reaproveitar a mesma logica de
// exibicao de balõezinho de mensagem no front-end.
router.get("/questions/:questionId", async (req, res) => {
  const questionId = req.params.questionId;

  const { rows } = await db.query(
    `SELECT q.*, a.nickname AS seller_nickname
       FROM questions q
       JOIN accounts a ON a.id = q.seller_id
      WHERE q.question_id = $1`,
    [questionId]
  );
  const question = rows[0] || null;
  if (!question) return res.status(404).json({ error: "Pergunta não encontrada" });

  const messages = [
    { sender_role: "buyer", message: question.question_text, sent_date: question.question_date },
  ];
  if (question.answer_text) {
    messages.push({
      sender_role: "respondent",
      message: question.answer_text,
      sent_date: question.answer_date,
      operator_name: question.operator_name,
    });
  }

  res.json({ question, messages });
});

router.post("/questions/:questionId/reply", express.json(), async (req, res) => {
  const questionId = req.params.questionId;
  const text = (req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Resposta vazia" });
  const operator = String(req.body?.operatorName || "").trim().slice(0, 60) || null;

  const { rows } = await db.query("SELECT * FROM questions WHERE question_id = $1", [questionId]);
  const question = rows[0];
  if (!question) return res.status(404).json({ error: "Pergunta não encontrada" });

  try {
    const accessToken = await getValidAccessToken(question.seller_id);
    await answerQuestion(accessToken, questionId, text);

    const nowIso = new Date().toISOString();
    await db.query(
      `UPDATE questions
       SET local_status = 'answered', ml_status = 'answered', answer_text = $1, answer_date = $2, operator_name = $3, updated_at = now()
       WHERE question_id = $4`,
      [text, nowIso, operator, questionId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[questions/reply]", err.status, err.body || err.message);
    const mlMessage =
      err.body?.message || err.body?.cause?.[0]?.message || (typeof err.body === "string" ? err.body : null);
    res.status(502).json({
      error: "Falha ao enviar a resposta para o Mercado Livre.",
      detail: mlMessage || err.message || "Sem detalhes do Mercado Livre.",
    });
  }
});

// Mesma logica do botao "Atualizar" das outras duas telas, so que pras
// perguntas.
router.post("/questions/sync", async (req, res) => {
  try {
    await reconcileAllQuestions();
    res.json({ ok: true });
  } catch (err) {
    console.error("[questions/sync]", err.message);
    res.status(500).json({ error: "Falha ao sincronizar perguntas", detail: err.message });
  }
});

// Rota TEMPORARIA de diagnostico: busca as perguntas SEM RESPOSTA de cada
// conta direto na API (sem passar pelo processamento normal) e devolve o
// JSON cru, junto com o que extractQuestionInfo entendeu disso — serve pra
// confirmar rapido, com uma pergunta real, se os nomes de campo batem com a
// documentacao (ver comentario no topo de ml/questionsApi.js). Uso: abrir no
// navegador (ja logado no painel) /api/debug/probe-questions
router.get("/debug/probe-questions", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = [];

  for (const acc of accounts) {
    const entry = { sellerId: acc.id, nickname: acc.nickname };
    try {
      const accessToken = await getValidAccessToken(acc.id);
      const data = await fetchQuestions(accessToken, acc.id, { status: "unanswered", limit: 5 });
      const results = Array.isArray(data?.questions) ? data.questions : Array.isArray(data?.results) ? data.results : [];
      entry.totalPerguntasSemResposta = data?.total ?? data?.paging?.total ?? null;
      entry.amostraBruta = results.slice(0, 2);
      entry.amostraInterpretada = results.slice(0, 2).map((q) => ({ id: q.id, ...extractQuestionInfo(q) }));
    } catch (err) {
      entry.erro = { status: err.status, body: err.body || err.message };
    }
    report.push(entry);
  }

  res.json(report);
});

// Rota TEMPORARIA de diagnostico (segunda etapa): o usuario relatou que,
// mesmo depois da busca em lote dos anuncios (fetchItemsByIds em ml/api.js),
// as perguntas continuam mostrando "Anúncio não identificado" — ou seja,
// algo na busca do ANUNCIO em si (nao mais na busca da pergunta, que ja
// esta funcionando) esta falhando silenciosamente (fetchItemsByIds engole
// qualquer erro que nao seja 401 e so registra um aviso no log). Esta rota
// pega item_id's REAIS de perguntas que ainda estao sem titulo no banco, e
// faz a mesma chamada "na mao" (sem engolir erro nenhum), pra aparecer bem
// claro o motivo exato (403? 404? campo errado?). Uso: abrir no navegador
// (ja logado no painel) /api/debug/probe-item-batch
router.get("/debug/probe-item-batch", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = [];

  for (const acc of accounts) {
    const entry = { sellerId: acc.id, nickname: acc.nickname };
    try {
      const { rows: semTitulo } = await db.query(
        `SELECT question_id, item_id FROM questions WHERE seller_id = $1 AND item_id IS NOT NULL AND item_title IS NULL LIMIT 5`,
        [acc.id]
      );
      entry.perguntasSemTituloEncontradas = semTitulo.length;
      if (semTitulo.length === 0) {
        entry.observacao = "Nenhuma pergunta sem titulo pra essa conta agora (pode ja ter sido corrigida).";
        report.push(entry);
        continue;
      }
      const itemIds = [...new Set(semTitulo.map((r) => r.item_id))];
      entry.itemIdsTentados = itemIds;

      const accessToken = await getValidAccessToken(acc.id);

      // 1) Chamada em LOTE, exatamente como o backfill automatico faz.
      const multigetUrl = `https://api.mercadolibre.com/items?ids=${itemIds.join(
        ","
      )}&attributes=id,title,permalink,price&access_token=${accessToken}`;
      const multigetRes = await fetch(multigetUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      const multigetText = await multigetRes.text();
      entry.chamadaEmLote = {
        status: multigetRes.status,
        ok: multigetRes.ok,
        corpo: (() => {
          try {
            return JSON.parse(multigetText);
          } catch {
            return multigetText;
          }
        })(),
      };

      // 2) Chamada de UM item so (endpoint mais simples/antigo), pra ver se
      // o problema e so no formato "em lote" ou se e mais geral.
      const singleUrl = `https://api.mercadolibre.com/items/${itemIds[0]}?access_token=${accessToken}`;
      const singleRes = await fetch(singleUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      const singleText = await singleRes.text();
      entry.chamadaUnica = {
        itemId: itemIds[0],
        status: singleRes.status,
        ok: singleRes.ok,
        corpo: (() => {
          try {
            return JSON.parse(singleText);
          } catch {
            return singleText;
          }
        })(),
      };
    } catch (err) {
      entry.erro = { status: err.status, body: err.body || err.message };
    }
    report.push(entry);
  }

  res.json(report);
});

module.exports = router;
