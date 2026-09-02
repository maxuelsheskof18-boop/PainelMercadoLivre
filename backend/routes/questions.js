// Rotas do painel pras PERGUNTAS feitas no anuncio, antes da compra (Q&A
// publica) — sistema separado tanto das conversas de mensagens pos-venda
// (routes/conversations.js) quanto das reclamacoes (routes/claims.js).
const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");
const { answerQuestion, fetchQuestions } = require("../ml/questionsApi");
const { fetchUserById } = require("../ml/api");
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
      // Inclui buyer_id na busca (pedido do usuario: "tem que ser possivel a
      // pesquisa atraves do numero depois do #") — assim da pra achar um
      // comprador especifico digitando o numero que aparece como
      // "Comprador #123..." quando o nome dele nao e conhecido.
      conditions.push(
        `(q.buyer_nickname ILIKE ${p} OR q.item_title ILIKE ${p} OR q.question_text ILIKE ${p} OR q.buyer_id ILIKE ${p})`
      );
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // Agrupa por comprador dentro da mesma loja: se o mesmo comprador (mesmo
    // numero depois do "#") fez mais de uma pergunta, mostra so UMA entrada
    // na lista em vez de uma linha repetida pra cada pergunta separada —
    // pedido do usuario ("se e o mesmo numero deixar as mensagens uma abaixo
    // da outra"). A entrada mostrada e a pergunta mais recente AINDA
    // PENDENTE do grupo (se houver alguma); senao, a mais recente de
    // qualquer status. Ao abrir essa entrada (GET /questions/:questionId
    // abaixo), TODAS as perguntas desse comprador aparecem juntas,
    // empilhadas, na mesma tela. Perguntas sem buyer_id conhecido (raro)
    // usam o proprio question_id como chave de agrupamento, entao nunca se
    // misturam por engano com as de outro comprador. Duas contas diferentes
    // (seller_id diferente) NUNCA agrupam entre si, mesmo que seja o mesmo
    // comprador em ambas — cada loja responde com o proprio login dela.
    const { rows } = await db.query(
      `SELECT DISTINCT ON (q.seller_id, COALESCE(q.buyer_id, q.question_id))
              q.*, a.nickname AS seller_nickname,
              COUNT(*) OVER (PARTITION BY q.seller_id, COALESCE(q.buyer_id, q.question_id))::int AS grupo_total,
              COUNT(*) FILTER (WHERE q.local_status = 'pending')
                OVER (PARTITION BY q.seller_id, COALESCE(q.buyer_id, q.question_id))::int AS grupo_pendentes
         FROM questions q
         JOIN accounts a ON a.id = q.seller_id
         ${where}
        ORDER BY q.seller_id, COALESCE(q.buyer_id, q.question_id),
                 (q.local_status = 'pending') DESC,
                 q.question_date DESC NULLS LAST,
                 q.updated_at DESC`,
      params
    );

    // O DISTINCT ON acima precisa ordenar primeiro pela chave de
    // agrupamento (senao nao funciona) — reordena aqui pelo criterio real da
    // lista (mais recente primeiro), igual antes do agrupamento existir.
    rows.sort((a, b) => {
      const dateA = a.question_date ? new Date(a.question_date).getTime() : 0;
      const dateB = b.question_date ? new Date(b.question_date).getTime() : 0;
      if (dateB !== dateA) return dateB - dateA;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

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

  // Se o mesmo comprador fez mais de uma pergunta pra essa loja, traz todas
  // juntas (da mais antiga pra mais nova, uma abaixo da outra) — mesmo
  // agrupamento da listagem acima (GET /questions). Perguntas do mesmo
  // comprador em OUTRAS lojas ficam de fora de proposito (cada loja responde
  // com o proprio login/token dela, entao nao daria pra misturar as
  // respostas).
  const grupoChave = question.buyer_id || question.question_id;
  const { rows: grupo } = await db.query(
    `SELECT * FROM questions
      WHERE seller_id = $1 AND COALESCE(buyer_id, question_id) = $2
      ORDER BY question_date ASC NULLS LAST, updated_at ASC`,
    [question.seller_id, grupoChave]
  );
  const perguntas = grupo.length > 0 ? grupo : [question];

  const messages = [];
  let ultimoAnuncio = null;
  for (const q of perguntas) {
    // Mostra de qual anuncio se trata so quando muda em relacao a pergunta
    // anterior da mesma "conversa" (evita repetir a mesma legenda em toda
    // mensagem quando e tudo sobre o mesmo produto, o caso mais comum).
    const anuncioAtual = q.item_title || (q.item_id ? `Anúncio ${q.item_id}` : null);
    messages.push({
      sender_role: "buyer",
      message: q.question_text,
      sent_date: q.question_date,
      itemLabel: anuncioAtual && anuncioAtual !== ultimoAnuncio ? anuncioAtual : null,
    });
    ultimoAnuncio = anuncioAtual;
    if (q.answer_text) {
      messages.push({
        sender_role: "respondent",
        message: q.answer_text,
        sent_date: q.answer_date,
        operator_name: q.operator_name,
      });
    }
  }

  // A caixa de resposta so envia pra UMA pergunta por vez (assim que a API
  // do Mercado Livre funciona) — se houver mais de uma pergunta desse
  // comprador ainda sem resposta no grupo, aponta pra mais recente delas.
  const pendentes = perguntas.filter((q) => q.local_status === "pending");
  const replyTarget = pendentes.length > 0 ? pendentes[pendentes.length - 1] : question;

  res.json({ question, messages, replyTargetQuestionId: replyTarget.question_id });
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

// "Marcar como resolvido" (pedido do usuario) — mesma logica ja usada em
// mensagens/reclamacoes (ver POST /claims/:claimId/mark-resolved e POST
// /conversations/:packId/mark-resolved), agora tambem pra perguntas. Cobre
// o caso de uma pergunta que nunca vai poder ser respondida pelo Mercado
// Livre (ex: erro real visto pelo vendedor "Item must be active", quando o
// anuncio foi pausado/removido depois da pergunta) — sem isso ela ficaria
// pendente pra sempre, sem nenhum jeito de tirar da aba de pendentes.
router.post("/questions/:questionId/mark-resolved", express.json(), async (req, res) => {
  const questionId = req.params.questionId;
  const operator = String(req.body?.operatorName || "").trim().slice(0, 60) || null;

  const { rows } = await db.query("SELECT question_id FROM questions WHERE question_id = $1", [questionId]);
  if (!rows[0]) return res.status(404).json({ error: "Pergunta não encontrada" });

  await db.query(
    `UPDATE questions
     SET local_status = 'closed', resolved_by_operator_at = now(), resolved_by_operator = $1, updated_at = now()
     WHERE question_id = $2`,
    [operator, questionId]
  );

  res.json({ ok: true });
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

      // 3) Mesma chamada de UM item, mas SEM NENHUM token/autenticacao — o
      // detalhe de um anuncio publico e documentado como leitura publica
      // (qualquer pessoa, logada ou nao, consegue ver os dados de um
      // anuncio ativo no site). O erro visto acima ("blocked_by":
      // "PolicyAgent", "PA_UNAUTHORIZED_RESULT_FROM_POLICIES") e um bloqueio
      // de seguranca/policy do Mercado Livre que, por relatos de outros
      // desenvolvedores, pode disparar justamente por causa da autenticacao
      // (ex: aplicativo sem uma permissao especifica pra API de Itens,
      // separada do escopo basico de leitura/escrita) — nao por falta dela.
      // Se essa chamada sem token funcionar, confirma que o jeito de
      // contornar e parar de mandar token nessa chamada especifica.
      const anonRes = await fetch(`https://api.mercadolibre.com/items/${itemIds[0]}`, {
        headers: { Accept: "application/json" },
      });
      const anonText = await anonRes.text();
      entry.chamadaSemToken = {
        itemId: itemIds[0],
        status: anonRes.status,
        ok: anonRes.ok,
        corpo: (() => {
          try {
            return JSON.parse(anonText);
          } catch {
            return anonText;
          }
        })(),
      };

      // 4) Mesma chamada de novo, mas com um "User-Agent" de navegador de
      // verdade — o resultado da tentativa 3 (sem token nenhum) mostrou que
      // o bloqueio acontece MESMO sem autenticacao, ou seja, nao e sobre
      // permissao do aplicativo: e um bloqueio de seguranca contra
      // "robôs"/tráfego automatizado, aplicado com base em como a chamada
      // se parece (sem User-Agent = "obviamente um programa", nao uma
      // pessoa navegando) — bem comum em sites que sofrem raspagem de
      // dados de produto. Servidores como o Render, sem esse cabecalho,
      // caem direto nesse bloqueio.
      const uaRes = await fetch(`https://api.mercadolibre.com/items/${itemIds[0]}`, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "pt-BR,pt;q=0.9",
        },
      });
      const uaText = await uaRes.text();
      entry.chamadaComUserAgentDeNavegador = {
        itemId: itemIds[0],
        status: uaRes.status,
        ok: uaRes.ok,
        corpo: (() => {
          try {
            return JSON.parse(uaText);
          } catch {
            return uaText;
          }
        })(),
      };

      // 5) Confirma, no mesmo instante, que outra chamada AUTENTICADA
      // qualquer (essa nunca falhou pra nenhuma conta) continua funcionando
      // — descarta a hipotese de o token ter expirado bem na hora do teste.
      const meRes = await fetch(`https://api.mercadolibre.com/users/me`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      entry.chamadaUsersMeAindaFunciona = { status: meRes.status, ok: meRes.ok };

      // 6) O bloqueio (tentativas 1 a 4) se repete identico com ou sem
      // token e com ou sem User-Agent de navegador — ou seja, nao e sobre
      // autenticacao nem sobre "parecer um robô": e a API de Itens
      // (api.mercadolibre.com/items) bloqueando esse servidor
      // especificamente (bloqueio por IP, bem comum contra raspagem de
      // preco/produto, e o /users/me confirma que o resto da API aceita
      // esse mesmo servidor numa boa). Ultima alternativa: em vez da API,
      // buscar o TITULO direto na PAGINA PUBLICA do anuncio (a mesma que
      // qualquer comprador ve no navegador) — e um dominio/sistema
      // diferente (site de vendas, nao a API), que pode nao estar sob o
      // mesmo bloqueio.
      // "articulo.mercadolibre.com.br" (tentativa anterior) nem existe de
      // verdade (deu erro de rede, nao de bloqueio) — o dominio publico
      // certo do Brasil e "produto.mercadolivre.com.br" (com "v", igual o
      // link que a propria API devolve no campo "permalink" quando
      // funciona).
      let paginaPublica = { tentativa: `https://produto.mercadolivre.com.br/${itemIds[0].replace(/^([A-Z]+)(\d+)$/, "$1-$2")}` };
      try {
        const pageRes = await fetch(paginaPublica.tentativa, {
          redirect: "follow",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "text/html",
          },
        });
        const pageHtml = await pageRes.text();
        const titleMatch = /<title>([^<]*)<\/title>/i.exec(pageHtml);
        const ogTitleMatch = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(pageHtml);
        paginaPublica.status = pageRes.status;
        paginaPublica.ok = pageRes.ok;
        paginaPublica.urlFinalAposRedirect = pageRes.url;
        paginaPublica.tituloEncontrado = ogTitleMatch?.[1] || titleMatch?.[1] || null;
        paginaPublica.tamanhoHtml = pageHtml.length;
      } catch (errPage) {
        paginaPublica.erro = errPage.message;
      }
      entry.chamadaPaginaPublica = paginaPublica;
    } catch (err) {
      entry.erro = { status: err.status, body: err.body || err.message };
    }
    report.push(entry);
  }

  res.json(report);
});

// Rota TEMPORARIA de diagnostico: o usuario relatou que, mesmo depois da
// correcao feita em upsertQuestion (ver questionsSync.js — o guard que
// preserva local_status='closed' quando resolved_by_operator_at esta
// preenchido), perguntas marcadas manualmente como resolvidas continuam
// aparecendo em Pendentes, mesmo apos o deploy dessa correcao (v20) e um
// "Manual Deploy" forcado no Render. Essa rota mostra, pra CADA pergunta
// que ja foi marcada como resolvida manualmente (resolved_by_operator_at
// preenchido), o estado exato dela AGORA no banco — local_status realmente
// gravado, ml_status (o que o Mercado Livre diz), e importante: quantas
// perguntas existem no MESMO grupo (mesmo comprador+loja — ver agrupamento
// em GET /questions) e quantas dessas ainda estao pendentes. Isso separa
// duas hipoteses bem diferentes: (a) o guard nao esta segurando o
// local_status da PROPRIA pergunta (voltou pra 'pending' sozinha — bug
// ainda nao corrigido de verdade, ou versao antiga ainda no ar), ou (b) a
// pergunta em si continua 'closed' certinho, mas ela aparece agrupada com
// OUTRA pergunta do mesmo comprador que ainda esta pendente de verdade
// (grupo_pendentes > 0) — nesse caso nao e bug, e so uma 2a duvida do
// mesmo comprador que ainda precisa de resposta separada. Uso: abrir no
// navegador (ja logado no painel) /api/debug/probe-resolved-questions
router.get("/debug/probe-resolved-questions", async (req, res) => {
  const { rows } = await db.query(
    `SELECT q.question_id, q.seller_id, a.nickname AS seller_nickname,
            q.buyer_id, q.buyer_nickname, q.question_text,
            q.local_status, q.ml_status, q.resolved_by_operator, q.resolved_by_operator_at,
            q.updated_at, q.question_date,
            (SELECT COUNT(*) FROM questions q2
              WHERE q2.seller_id = q.seller_id
                AND COALESCE(q2.buyer_id, q2.question_id) = COALESCE(q.buyer_id, q.question_id))::int AS grupo_total,
            (SELECT COUNT(*) FROM questions q2
              WHERE q2.seller_id = q.seller_id
                AND COALESCE(q2.buyer_id, q2.question_id) = COALESCE(q.buyer_id, q.question_id)
                AND q2.local_status = 'pending')::int AS grupo_pendentes,
            (SELECT json_agg(json_build_object('question_id', q3.question_id, 'local_status', q3.local_status, 'question_text', q3.question_text, 'question_date', q3.question_date))
               FROM questions q3
              WHERE q3.seller_id = q.seller_id
                AND COALESCE(q3.buyer_id, q3.question_id) = COALESCE(q.buyer_id, q.question_id)
                AND q3.question_id <> q.question_id) AS outras_perguntas_do_mesmo_grupo
       FROM questions q
       JOIN accounts a ON a.id = q.seller_id
      WHERE q.resolved_by_operator_at IS NOT NULL
      ORDER BY q.resolved_by_operator_at DESC
      LIMIT 50`
  );
  res.json(rows);
});

// Rota TEMPORARIA de diagnostico: mesma logica de probe-item-batch acima,
// so que pro NOME DO COMPRADOR em vez do anuncio (pedido do usuario: "Nem o
// nome do comprador tambem [aparece]") — testa /users/{id} (endpoint nunca
// chamado antes pra um usuario que nao seja "me") direto pra algumas
// perguntas reais que ainda estao com buyer_nickname em branco, mostrando o
// status/corpo cru da resposta. Uso: abrir no navegador (ja logado no
// painel) /api/debug/probe-buyer-info
router.get("/debug/probe-buyer-info", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = [];

  for (const acc of accounts) {
    const entry = { sellerId: acc.id, nickname: acc.nickname };
    try {
      const { rows: semNome } = await db.query(
        `SELECT question_id, buyer_id FROM questions WHERE seller_id = $1 AND buyer_id IS NOT NULL AND buyer_nickname IS NULL LIMIT 3`,
        [acc.id]
      );
      entry.perguntasSemNomeEncontradas = semNome.length;
      if (semNome.length === 0) {
        entry.observacao = "Nenhuma pergunta sem nome de comprador pra essa conta agora.";
        report.push(entry);
        continue;
      }

      const accessToken = await getValidAccessToken(acc.id);
      entry.tentativas = [];
      for (const row of semNome) {
        const tentativa = { buyerId: row.buyer_id };
        try {
          const user = await fetchUserById(accessToken, row.buyer_id);
          tentativa.status = 200;
          tentativa.nicknameEncontrado = user?.nickname || null;
        } catch (err) {
          tentativa.status = err.status;
          tentativa.corpo = err.body || err.message;
        }
        entry.tentativas.push(tentativa);
      }
    } catch (err) {
      entry.erro = { status: err.status, body: err.body || err.message };
    }
    report.push(entry);
  }

  res.json(report);
});

module.exports = router;
