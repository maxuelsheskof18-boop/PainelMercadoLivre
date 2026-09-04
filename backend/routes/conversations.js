const express = require("express");
const multer = require("multer");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");
const {
  sendMessage,
  uploadMessageAttachment,
  fetchMessageAttachmentFile,
  fetchMe,
  fetchRecentOrders,
  fetchPackMessages,
  fetchOrderById,
  fetchShipment,
  fetchUnreadMessagePacks,
} = require("../ml/api");
const {
  reconcileAllAccounts,
  extractOrderInfo,
  upsertConversationFromPack,
  fetchShippingType,
} = require("../sync");
const { reconcileAllClaims } = require("../claimsSync");
const { reconcileAllQuestions } = require("../questionsSync");

const router = express.Router();

// Este router e montado em "/api" (veja server.js), entao os caminhos aqui
// dentro NAO repetem o prefixo "/api" — e por isso, alem de exigir login,
// que ele so intercepta pedidos que ja comecam com /api/..., sem afetar
// paginas publicas como /login.html.
router.use(requireLogin);

// Limite de caracteres por mensagem imposto pelo proprio Mercado Livre (a
// API de mensagens pos-venda recusa qualquer texto acima disso) — trava
// aqui tambem (alem do maxlength no campo, so pra UX) pra nunca depender
// so do front-end, ja que a rota pode ser chamada de outro jeito.
const MAX_MESSAGE_LENGTH = 350;

// Mesmo limite documentado pela API de mensagens pos-venda do Mercado Livre
// pra anexos: ate 25MB, em JPG/PNG/PDF/TXT (maior que o limite de 5MB das
// reclamacoes — sao endpoints/documentacoes separados).
const ALLOWED_MESSAGE_ATTACHMENT_MIME = ["image/jpeg", "image/png", "application/pdf", "text/plain"];
const uploadMessageFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MESSAGE_ATTACHMENT_MIME.includes(file.mimetype)) {
      return cb(new Error("Formato nao suportado. Envie JPG, PNG, PDF ou TXT."));
    }
    cb(null, true);
  },
});

router.get("/pending-count", async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending' AND is_delivered IS NOT TRUE)::int AS pending,
       COUNT(*) FILTER (WHERE status = 'no_contact')::int AS no_contact,
       COUNT(*) FILTER (WHERE status = 'pending' AND is_delivered = true)::int AS delivered
     FROM conversations`
  );
  const { rows: claimRows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE local_status = 'pending')::int AS pending FROM claims`
  );

  // Essa rota e chamada o tempo todo (a cada 20s, em toda aba aberta do
  // painel — ver setInterval(loadPendingCount, ...) em app.js), pra
  // atualizar o sininho/badges. Isolado num try/catch proprio: se por
  // algum motivo a tabela "questions" nao existir ainda (ex: deploy do
  // modulo de Perguntas ficou incompleto/fora de ordem), isso NAO pode
  // derrubar essa chamada inteira — ela e critica demais (roda a cada 20s
  // em background) pra travar o resto do painel (Mensagens/Reclamações)
  // por causa so da contagem de Perguntas. Na duvida, conta 0.
  let questionsPending = 0;
  try {
    const { rows: questionRows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE local_status = 'pending')::int AS pending FROM questions`
    );
    questionsPending = questionRows[0].pending;
  } catch (err) {
    console.error("[pending-count] falha ao contar perguntas pendentes (tabela ainda nao existe?):", err.message);
  }

  res.json({
    pending: rows[0].pending,
    noContact: rows[0].no_contact,
    delivered: rows[0].delivered,
    claims: claimRows[0].pending,
    questions: questionsPending,
  });
});

router.get("/conversations", async (req, res) => {
  const status = ["pending", "answered", "no_contact", "delivered"].includes(req.query.status)
    ? req.query.status
    : "pending";

  // Monta o WHERE dinamicamente, sempre com parametros posicionais (nunca
  // concatenando valor de usuario direto na string) pra evitar SQL
  // injection no campo de busca livre.
  const conditions = [];
  const params = [];

  if (status === "delivered") {
    // Categoria separada (pedido do usuario): mensagens recebidas em
    // pedidos JA ENTREGUES (ex: pedindo nota fiscal, duvida geral) — nao e
    // mais sobre "combinar a entrega", entao fica fora de
    // Pendentes/Respondidas, numa aba propria. Pode estar pendente ou ja
    // respondida dentro dessa aba (por isso os dois status entram aqui).
    conditions.push("c.is_delivered = true");
    conditions.push("c.status IN ('pending', 'answered')");
  } else {
    params.push(status);
    conditions.push(`c.status = $${params.length}`);
    if (status === "pending" || status === "answered") {
      // Pedidos ja entregues com mensagem saem daqui e vao exclusivamente
      // pra aba "Entregues" acima, pra nao aparecer duplicado nas duas.
      conditions.push("c.is_delivered IS NOT TRUE");
    }
  }

  // Filtro opcional: so as conversas classificadas como "combinar entrega"
  // (coluna is_combinar_entrega). Na aba "no_contact" isso e sempre
  // verdadeiro (so entra la quem e combinar entrega), mas nao atrapalha
  // deixar o filtro ligado tambem.
  if (req.query.combinar === "1") {
    conditions.push("c.is_combinar_entrega = true");
  }

  // Filtro opcional "so pendentes (a responder)": pedido do usuario pra nao
  // precisar caçar as pendentes dentro de abas que misturam status, como a
  // "Entregues" (que junta pending + answered). Nas abas que ja sao so
  // pending isso nao muda nada.
  if (req.query.onlyPending === "1") {
    conditions.push("c.status = 'pending'");
  }

  // Filtro opcional por loja (conta do Mercado Livre) especifica.
  if (req.query.sellerId) {
    params.push(req.query.sellerId);
    conditions.push(`c.seller_id = $${params.length}`);
  }

  // Busca livre: nome/apelido do comprador, produto ou numero do pedido.
  const q = (req.query.q || "").trim();
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(c.buyer_full_name ILIKE ${p} OR c.buyer_nickname ILIKE ${p} OR c.product_title ILIKE ${p} OR c.order_id ILIKE ${p})`
    );
  }

  // Ordenacao: mais recentes primeiro (padrao) ou mais antigas primeiro.
  const orderDir = req.query.sort === "oldest" ? "ASC" : "DESC";
  const nullsPos = orderDir === "ASC" ? "NULLS FIRST" : "NULLS LAST";

  // Marca se o PEDIDO dessa conversa tem uma reclamacao ainda ABERTA (aba
  // separada de Reclamacoes, tabela "claims" — ver claimsSync.js). Pedido do
  // usuario: quando o comprador abre reclamacao numa venda de "combinar
  // entrega" (ou em qualquer venda), ela precisa continuar aparecendo (ou
  // com um marcador) aqui em Mensagens tambem — sem isso, o vendedor so
  // ficaria sabendo da reclamacao se checasse a aba de Reclamacoes por
  // conta propria, podendo perder o prazo (ex: reputacao afetada, como no
  // aviso real do Mercado Livre: "Você tem até [data] para... para que sua
  // reputação não seja afetada"). "cl.order_id = c.order_id" cobre o caso
  // comum (mesmo pedido); claims sem order_id (ex: reclamacao ligada a
  // pagamento/envio, nao a pedido) simplesmente nunca casam aqui, sem falso
  // positivo.
  const { rows } = await db.query(
    `SELECT c.*, a.nickname AS seller_nickname,
            EXISTS (
              SELECT 1 FROM claims cl
               WHERE cl.seller_id = c.seller_id
                 AND cl.order_id = c.order_id
                 AND c.order_id IS NOT NULL
                 AND cl.local_status <> 'closed'
            ) AS has_open_claim
       FROM conversations c
       JOIN accounts a ON a.id = c.seller_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.last_message_date ${orderDir} ${nullsPos}, c.updated_at ${orderDir}`,
    params
  );

  res.json(rows);
});

router.get("/conversations/:packId/messages", async (req, res) => {
  const packId = req.params.packId;

  const { rows: messages } = await db.query(
    "SELECT * FROM messages WHERE pack_id = $1 ORDER BY id ASC",
    [packId]
  );

  const { rows: convRows } = await db.query(
    `SELECT c.*, a.nickname AS seller_nickname,
            EXISTS (
              SELECT 1 FROM claims cl
               WHERE cl.seller_id = c.seller_id
                 AND cl.order_id = c.order_id
                 AND c.order_id IS NOT NULL
                 AND cl.local_status <> 'closed'
            ) AS has_open_claim
       FROM conversations c
       JOIN accounts a ON a.id = c.seller_id
      WHERE c.pack_id = $1`,
    [packId]
  );
  let conversation = convRows[0] || null;

  // Conversas mais antigas (que ja sairam da janela dos pedidos recentes
  // verificados pela reconciliacao periodica) podem nao ter produto/tipo
  // de entrega ainda. Como o usuario esta olhando essa conversa agora, vale
  // a pena buscar na hora, em vez de esperar ela entrar de novo na janela.
  if (
    conversation &&
    conversation.order_id &&
    (conversation.product_title == null ||
      conversation.order_total == null ||
      conversation.order_quantity == null ||
      (conversation.shipping_type == null && conversation.is_combinar_entrega !== true))
  ) {
    try {
      const accessToken = await getValidAccessToken(conversation.seller_id);
      const order = await fetchOrderById(accessToken, conversation.order_id);
      const orderInfo = extractOrderInfo(order);
      // So busca o tipo de envio (Flex/Agência/etc.) se ainda nao tem — pedido
      // de combinar entrega nunca vai ter (nao tem envio de verdade), entao
      // nem tenta nesse caso pra nao gastar chamada de API a toa toda vez que
      // essa conversa for aberta.
      const shippingType = orderInfo?.isCombinarEntrega
        ? null
        : await fetchShippingType(accessToken, order);

      const { rows: updated } = await db.query(
        `UPDATE conversations
            SET buyer_full_name = COALESCE($1, buyer_full_name),
                product_title = COALESCE($2, product_title),
                is_combinar_entrega = COALESCE($3, is_combinar_entrega),
                order_total = COALESCE($4, order_total),
                order_quantity = COALESCE($5, order_quantity),
                shipping_type = COALESCE($6, shipping_type),
                updated_at = now()
          WHERE pack_id = $7
          RETURNING *`,
        [
          orderInfo?.buyerFullName ?? null,
          orderInfo?.productTitle ?? null,
          orderInfo?.isCombinarEntrega ?? null,
          orderInfo?.orderTotal ?? null,
          orderInfo?.orderQuantity ?? null,
          shippingType,
          packId,
        ]
      );
      if (updated[0]) conversation = { ...conversation, ...updated[0] };
    } catch (err) {
      console.warn(
        `[conversations] nao consegui enriquecer o pedido ${conversation.order_id} sob demanda:`,
        err.status,
        err.body || err.message
      );
    }
  }

  res.json({ conversation, messages });
});

// Baixa o arquivo de um anexo que o COMPRADOR mandou numa mensagem pos-venda
// (ex: foto de um produto que veio com defeito) — ate agora o painel so
// gravava/mostrava o texto da mensagem, o anexo em si era ignorado por
// completo (pedido do usuario: "Nem todas as midia estao sendo
// importadas"). O id do anexo vem do campo "attachments" de cada mensagem
// (ver GET /conversations/:packId/messages acima e upsertConversationFromPack
// em sync.js). Mesmo padrao da rota equivalente de reclamacoes (ver GET
// /claims/:claimId/attachments/:attachmentId/download em routes/claims.js).
router.get("/conversations/:packId/attachments/:attachmentId/download", async (req, res) => {
  const { packId, attachmentId } = req.params;
  const { rows } = await db.query("SELECT seller_id FROM conversations WHERE pack_id = $1", [packId]);
  const conversation = rows[0];
  if (!conversation) return res.status(404).json({ error: "Conversa não encontrada" });

  try {
    const accessToken = await getValidAccessToken(conversation.seller_id);
    const file = await fetchMessageAttachmentFile(accessToken, attachmentId);
    res.set("Content-Type", file.contentType);
    res.send(file.buffer);
  } catch (err) {
    console.error("[conversations/attachment-download]", err.status, err.body || err.message);
    res.status(502).json({ error: "Falha ao baixar o anexo do Mercado Livre." });
  }
});

// Quando o Mercado Livre recusa o envio porque a conversa foi bloqueada
// permanentemente (reembolso, mediacao/reclamacao encerrada, envio Full,
// prazo de resposta esgotado), nao adianta o vendedor tentar de novo — a
// API sempre vai recusar. Detecta esses casos ("blocked_by_...") em
// qualquer lugar que a mensagem de erro do Mercado Livre venha.
//
// Alem dos codigos "blocked_by_..." (que vem com HTTP 403), existe outro
// jeito da mesma coisa acontecer na pratica: quando o prazo pra responder
// vence, o Mercado Livre manda uma mensagem automatica avisando que
// "considera a conversa encerrada" — e a PARTIR DAI, tentar responder por
// aqui volta com "The conversation ID is invalid" (nao com um codigo
// "blocked_by_time", e nem sempre com status 403). Sem essa deteccao, a
// conversa ficava pra sempre em Pendentes, o vendedor tentava responder de
// novo, e sempre tomava o mesmo erro em ingles sem explicacao nenhuma.
function extractBlockReason(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [];
  if (typeof body.message === "string") candidates.push(body.message);
  if (typeof body.error === "string") candidates.push(body.error);
  if (Array.isArray(body.cause)) {
    for (const c of body.cause) {
      if (typeof c === "string") candidates.push(c);
      else if (c && typeof c.message === "string") candidates.push(c.message);
      else if (c && typeof c.code === "string") candidates.push(c.code);
    }
  }
  const blockedByCode = candidates.find((c) => /^blocked_by_/i.test(c));
  if (blockedByCode) return blockedByCode;
  if (candidates.some((c) => /conversation id is invalid/i.test(c))) return "invalid_conversation_id";
  return null;
}

const BLOCK_REASON_LABELS = {
  blocked_by_refund: "reembolso feito ao comprador",
  blocked_by_mediation: "mediação/reclamação encerrada",
  blocked_by_fulfillment: "pedido enviado por Full",
  blocked_by_time: "prazo para responder encerrado",
  invalid_conversation_id: "conversa encerrada pelo Mercado Livre (prazo de resposta esgotado)",
};

// Nome de quem esta operando o painel (varios atendentes podem usar o mesmo
// login/senha compartilhado) — o front manda isso em toda resposta enviada,
// pra registrar quem respondeu cada pedido e quando (ver tela "Histórico").
// Sem exigencia nenhuma alem de nao vir vazio: e so uma identificacao, nao
// uma autenticacao de verdade.
function sanitizeOperatorName(raw) {
  const name = String(raw || "").trim().slice(0, 60);
  return name || null;
}

// A mensagem pode chegar de duas formas: so texto (JSON, sem anexo) ou
// multipart/form-data (quando tem arquivo junto). express.json() so age
// quando o Content-Type e "application/json" (senao so passa adiante sem
// tocar em nada), e o multer so age quando e "multipart/form-data" — as duas
// coisas encadeadas cobrem os dois casos sem conflitar uma com a outra
// (mesmo padrao usado em routes/claims.js).
router.post("/conversations/:packId/reply", express.json(), (req, res) => {
  uploadMessageFile.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || "Falha ao processar o anexo." });
    }

    const text = (req.body?.text || "").trim();
    if (!text) {
      return res.status(400).json({ error: "Mensagem vazia" });
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: `Mensagem muito longa (${text.length} caracteres). O Mercado Livre só aceita até ${MAX_MESSAGE_LENGTH} caracteres por mensagem — divida em mais de uma mensagem.`,
      });
    }
    const operator = sanitizeOperatorName(req.body?.operatorName);

    const { rows } = await db.query(
      "SELECT * FROM conversations WHERE pack_id = $1",
      [req.params.packId]
    );
    const conv = rows[0];

    if (!conv) return res.status(404).json({ error: "Conversa nao encontrada" });
    if (!conv.buyer_id) {
      return res.status(409).json({
        error:
          "Nao sei quem e o comprador desta conversa ainda (aguarde a proxima sincronizacao ou clique em Atualizar).",
      });
    }

    try {
      const accessToken = await getValidAccessToken(conv.seller_id);
      const me = await fetchMe(accessToken);

      let attachmentIds;
      if (req.file) {
        const uploadResult = await uploadMessageAttachment(
          accessToken,
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype
        );
        const attachmentId = uploadResult?.id || uploadResult?.filename || uploadResult?.attachment_id;
        if (!attachmentId) {
          throw Object.assign(new Error("Nao recebi um identificador de anexo do Mercado Livre."), {
            body: uploadResult,
          });
        }
        attachmentIds = [attachmentId];
      }

      await sendMessage({
        accessToken,
        packId: conv.pack_id,
        sellerId: conv.seller_id,
        buyerId: conv.buyer_id,
        sellerEmail: me?.email,
        text,
        attachmentIds,
      });

      const nowIso = new Date().toISOString();

      await db.query(
        `INSERT INTO messages (pack_id, direction, author_user_id, text, sent_date, operator_name, attachment_name)
         VALUES ($1, 'out', $2, $3, $4, $5, $6)`,
        [conv.pack_id, conv.seller_id, text, nowIso, operator, req.file ? req.file.originalname : null]
      );

      await db.query(
        `UPDATE conversations
         SET status = 'answered', last_message_text = $1, last_message_date = $2, updated_at = now()
         WHERE pack_id = $3`,
        [text, nowIso, conv.pack_id]
      );

      res.json({ ok: true });
    } catch (err) {
      console.error("[reply]", err.status, err.body || err.message);
      // err.body normalmente vem da API do Mercado Livre como um objeto tipo
      // {message: "...", error: "...", cause: [...]}. Extraimos uma frase
      // legivel pra mostrar na tela, em vez de so "[object Object]".
      const mlMessage =
        err.body?.message ||
        err.body?.cause?.[0]?.message ||
        (typeof err.body === "string" ? err.body : null);

      // Antes so verificava esse bloqueio quando o status era 403 — mas o
      // caso "invalid_conversation_id" (ver extractBlockReason acima) pode
      // vir com outro status, entao agora checamos sempre; a funcao so
      // retorna algo quando reconhece um dos padroes conhecidos, entao nao
      // tem risco de marcar bloqueio por engano num erro qualquer.
      const blockReason = extractBlockReason(err.body);
      if (blockReason) {
        // Bloqueio permanente: essa conversa nunca mais vai aceitar uma
        // resposta enviada por aqui. Marcamos como "blocked" pra ela sair
        // sozinha das abas "Pendentes" e "Respondidas" (as duas so mostram
        // status='pending' ou 'answered') — assim ela nao fica poluindo a
        // lista, como o usuario pediu, sem apagar o historico da conversa.
        await db.query(
          `UPDATE conversations SET status = 'blocked', blocked_reason = $1, updated_at = now() WHERE pack_id = $2`,
          [blockReason, conv.pack_id]
        );
      }

      res.status(502).json({
        error: "Falha ao enviar a mensagem para o Mercado Livre.",
        detail: mlMessage || err.message || "Sem detalhes do Mercado Livre.",
        blocked: !!blockReason,
        blockReason: blockReason || null,
        blockReasonLabel: blockReason ? BLOCK_REASON_LABELS[blockReason.toLowerCase()] || null : null,
      });
    }
  });
});

// Pra conversas antigas que ja foram resolvidas por fora do painel (ex: por
// telefone/whatsapp com o comprador) e que, por isso, nao vao mudar de
// status sozinhas — o vendedor pode marcar manualmente como resolvida, e
// ela sai de Pendentes/Respondidas/Entregues. Usa o status
// 'resolved_by_operator' (DIFERENTE do 'resolved' automatico, que e so pra
// combinar-entrega entregue sem nenhuma mensagem — ver markConversationResolved
// em sync.js). Fica guardado em resolved_by_operator(_at), que sobrevive as
// proximas sincronizacoes (ver upsertConversationFromPack em sync.js) — a
// nao ser que chegue mensagem nova depois da marcacao, o que reabre sozinho.
router.post("/conversations/:packId/mark-resolved", express.json(), async (req, res) => {
  const packId = req.params.packId;
  const operator = String(req.body?.operatorName || "").trim().slice(0, 60) || null;

  const { rows } = await db.query("SELECT * FROM conversations WHERE pack_id = $1", [packId]);
  const conv = rows[0];
  if (!conv) return res.status(404).json({ error: "Conversa nao encontrada" });

  await db.query(
    `UPDATE conversations
     SET status = 'resolved_by_operator', resolved_by_operator_at = now(), resolved_by_operator = $1, updated_at = now()
     WHERE pack_id = $2`,
    [operator, packId]
  );

  res.json({ ok: true });
});

// Botao "Atualizar agora" no painel: forca uma reconciliacao manual, sem
// esperar o webhook (util principalmente logo apos o servico "acordar" no
// plano gratuito do Render).
router.post("/sync", async (req, res) => {
  try {
    await reconcileAllAccounts();
    // Reclamacoes sao sincronizadas junto do mesmo botao "Atualizar" — nao
    // deixa de responder ok se so essa parte falhar (ex: conta sem
    // permissao de reclamacoes ainda), pra nao travar a atualizacao das
    // mensagens normais por causa disso.
    try {
      await reconcileAllClaims();
    } catch (err) {
      console.error("[sync] falha ao sincronizar reclamacoes:", err.message);
    }
    try {
      await reconcileAllQuestions();
    } catch (err) {
      console.error("[sync] falha ao sincronizar perguntas:", err.message);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[sync]", err.message);
    res.status(500).json({ error: "Falha ao sincronizar", detail: err.message });
  }
});

// Rota TEMPORARIA de diagnostico: busca pedidos recentes de cada conta (via
// API de Orders, que e estavel) e tenta buscar as mensagens de cada um
// (via /messages/packs/.../sellers/...), pra descobrir se o problema e so
// no endpoint de "listar pendentes" ou se e a API de mensagens inteira que
// esta bloqueada pra essa aplicacao. Depois de resolvido, pode remover essa
// rota (e o require de fetchRecentOrders/fetchPackMessages acima).
router.get("/debug/probe-messages", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = [];

  for (const acc of accounts) {
    const sellerId = acc.id;
    const entry = { sellerId, nickname: acc.nickname };
    try {
      const accessToken = await getValidAccessToken(sellerId);

      let orders;
      try {
        orders = await fetchRecentOrders(accessToken, sellerId);
      } catch (err) {
        entry.ordersError = { status: err.status, body: err.body || err.message };
        report.push(entry);
        continue;
      }

      const sample = (orders.results || []).slice(0, 3).map((o) => ({
        order_id: o.id,
        pack_id: o.pack_id || null,
        status: o.status,
      }));
      entry.totalOrders = orders.paging?.total ?? null;
      entry.sampleOrders = sample;
      entry.probes = [];

      for (const o of sample) {
        const idToTry = o.pack_id || o.order_id;
        try {
          const packData = await fetchPackMessages(accessToken, idToTry, sellerId);
          entry.probes.push({
            tried: idToTry,
            usedPackId: !!o.pack_id,
            ok: true,
            messageCount: Array.isArray(packData?.messages) ? packData.messages.length : null,
          });
        } catch (err) {
          entry.probes.push({
            tried: idToTry,
            usedPackId: !!o.pack_id,
            ok: false,
            status: err.status,
            body: err.body || err.message,
          });
        }
      }
    } catch (err) {
      entry.error = err.message;
    }
    report.push(entry);
  }

  res.json(report);
});

// Rota TEMPORARIA de diagnostico: o usuario relatou (com print real) que
// mensagens com foto/anexo do comprador continuam aparecendo em branco (so
// a data e hora, sem texto nem imagem nenhuma) mesmo depois da correcao que
// deveria importar esses anexos (ver upsertConversationFromPack em sync.js,
// que le o campo "attachments" de cada mensagem). A hipotese da correcao
// era que o GET de mensagens devolve o anexo no mesmo campo "attachments"
// usado pra ENVIAR (ver sendMessage em ml/api.js) — mas isso nunca foi
// confirmado contra uma mensagem real com foto, so contra a documentacao. Se
// o nome do campo de verdade for outro (ex: "message_attachments", ou o
// anexo vier dentro de outra estrutura), a correcao simplesmente nunca
// encontra nada pra gravar, e a mensagem continua em branco do mesmo jeito
// que antes. Esta rota busca a conversa pelo PEDIDO (nao pelo pack_id, que o
// vendedor nao tem como saber de cabeca) e devolve o JSON CRU de todas as
// mensagens desse pack, direto do Mercado Livre, pra ver o nome real do
// campo onde o anexo vem. Uso: abrir no navegador (ja logado)
// /api/debug/probe-message-attachments/SEU_NUMERO_DE_PEDIDO
router.get("/debug/probe-message-attachments/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const { rows } = await db.query(
    "SELECT pack_id, seller_id FROM conversations WHERE order_id = $1",
    [orderId]
  );
  const conversation = rows[0];
  if (!conversation) {
    return res.status(404).json({ error: `Nenhuma conversa encontrada no banco pro pedido ${orderId}.` });
  }

  try {
    const accessToken = await getValidAccessToken(conversation.seller_id);
    const packData = await fetchPackMessages(accessToken, conversation.pack_id, conversation.seller_id);
    res.json({
      packId: conversation.pack_id,
      sellerId: conversation.seller_id,
      totalMensagens: Array.isArray(packData?.messages) ? packData.messages.length : null,
      jsonCruCompleto: packData,
    });
  } catch (err) {
    res.status(502).json({
      error: "Falha ao buscar as mensagens desse pack no Mercado Livre.",
      status: err.status,
      body: err.body || err.message,
    });
  }
});

// Rota TEMPORARIA de diagnostico: chama fetchUnreadMessagePacks (a busca
// dedicada por mensagens NAO LIDAS, ver comentario dela em ml/api.js) pra
// cada conta e devolve a lista crua devolvida pelo Mercado Livre — serve pra
// confirmar se um pedido especifico (que o vendedor ve com mensagem nao lida
// no proprio painel de Vendas do Mercado Livre) realmente aparece nessa
// busca ou nao. Uso: abrir no navegador (ja logado)
// /api/debug/probe-unread?packId=SEU_PACK_OU_PEDIDO
router.get("/debug/probe-unread", async (req, res) => {
  const packIdProcurado = req.query.packId ? String(req.query.packId) : null;
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = [];

  for (const acc of accounts) {
    const entry = { sellerId: acc.id, nickname: acc.nickname };
    try {
      const accessToken = await getValidAccessToken(acc.id);
      const unreadPacks = await fetchUnreadMessagePacks(accessToken, acc.id);
      entry.totalPacksComMensagemNaoLida = unreadPacks.length;
      entry.amostra = unreadPacks.slice(0, 10);
      if (packIdProcurado) {
        entry.pedidoProcuradoEncontrado = unreadPacks.some((p) => String(p.packId) === packIdProcurado);
      }
    } catch (err) {
      entry.erro = { status: err.status, body: err.body || err.message };
    }
    report.push(entry);
  }

  res.json(report);
});

// Rota TEMPORARIA de diagnostico: o endpoint "/messages/pending_read" (que
// eu tinha confirmado como certo via um resumo automatico da documentacao)
// devolveu 404 "resource not found" na pratica pra essa conta — ou seja, a
// "confirmacao" anterior nao era confiavel (aconteceu de novo com o dominio
// da pagina publica do anuncio: "articulo.mercadolibre.com.br" tambem era
// invencao). Em vez de continuar tentando adivinhar a partir de resumos de
// documentacao, esta rota testa VARIAS variantes de endpoint direto contra
// a API de verdade, com o token de uma conta real, e devolve o resultado
// cru de cada uma — assim a gente descobre empiricamente qual (se alguma)
// e a certa, em vez de confiar em mais uma "leitura" da documentacao. Uso:
// abrir no navegador (ja logado) /api/debug/probe-unread-variants
router.get("/debug/probe-unread-variants", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts LIMIT 1");
  const acc = accounts[0];
  if (!acc) return res.json({ erro: "Nenhuma conta cadastrada." });

  const accessToken = await getValidAccessToken(acc.id);
  const sellerId = acc.id;

  const variantes = [
    { nome: "pending_read (sem parametro nenhum)", path: `/messages/pending_read` },
    { nome: "pending_read?role=seller", path: `/messages/pending_read?role=seller` },
    { nome: "pending_read?role=seller&tag=post_sale", path: `/messages/pending_read?role=seller&tag=post_sale` },
    { nome: "packs?role=seller&tag=post_sale", path: `/messages/packs?role=seller&tag=post_sale` },
    { nome: "packs?tag=post_sale", path: `/messages/packs?tag=post_sale` },
    {
      nome: "marketplace/messages/unread (a antiga, so pra comparar)",
      path: `/marketplace/messages/unread?role=seller&tag=post_sale&user_id=${sellerId}`,
    },
  ];

  const resultados = [];
  for (const variante of variantes) {
    const url = new URL(`https://api.mercadolibre.com${variante.path}`);
    url.searchParams.set("access_token", accessToken);
    try {
      const r = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      const text = await r.text();
      let corpo;
      try {
        corpo = JSON.parse(text);
      } catch {
        corpo = text;
      }
      resultados.push({ nome: variante.nome, path: variante.path, status: r.status, ok: r.ok, corpo });
    } catch (err) {
      resultados.push({ nome: variante.nome, path: variante.path, erro: err.message });
    }
  }

  res.json({ sellerId, nickname: acc.nickname, resultados });
});

// Rota TEMPORARIA de diagnostico: pega ate 5 conversas pendentes reais que
// ja estao no banco e busca o envio (shipment) de cada uma, pra descobrir
// qual campo/valor identifica um envio do tipo "a combinar com o
// comprador" (nao ha essa informacao confiavel na documentacao publica).
router.get("/debug/probe-shipping", async (req, res) => {
  const { rows: convs } = await db.query(
    `SELECT pack_id, seller_id, order_id, buyer_nickname, status
       FROM conversations
      WHERE order_id IS NOT NULL
      ORDER BY status ASC, last_message_date DESC
      LIMIT 5`
  );

  const report = [];
  for (const conv of convs) {
    const entry = { pack_id: conv.pack_id, order_id: conv.order_id, status: conv.status };
    try {
      const accessToken = await getValidAccessToken(conv.seller_id);
      const order = await fetchOrderById(accessToken, conv.order_id);
      entry.orderTags = order?.tags || null;
      entry.shippingId = order?.shipping?.id || null;
      // Pra descobrir como mostrar produto/comprador de verdade no painel:
      entry.orderItems = (order?.order_items || []).map((oi) => ({
        title: oi?.item?.title,
        quantity: oi?.quantity,
      }));
      entry.buyer = order?.buyer
        ? {
            nickname: order.buyer.nickname,
            first_name: order.buyer.first_name,
            last_name: order.buyer.last_name,
          }
        : null;
      entry.dateCreated = order?.date_created || null;

      if (entry.shippingId) {
        try {
          const shipment = await fetchShipment(accessToken, entry.shippingId);
          entry.shipment = {
            logistic_type: shipment?.logistic_type,
            mode: shipment?.mode,
            status: shipment?.status,
            substatus: shipment?.substatus,
          };
        } catch (err) {
          entry.shipmentError = { status: err.status, body: err.body || err.message };
        }
      }
    } catch (err) {
      entry.error = err.message;
    }
    report.push(entry);
  }

  res.json(report);
});

// Rota TEMPORARIA de diagnostico: dado um numero de pedido, procura em
// todas as contas conectadas qual delas e a dona, mostra os dados brutos
// do pedido (tags, status), se ele aparece na busca dedicada de "combinar
// entrega" (tags=no_shipping), e tenta buscar as mensagens do pack. Serve
// pra descobrir exatamente onde a cadeia quebra quando um pedido especifico
// nao aparece no painel. Uso: abrir no navegador (ja logado no painel)
// /api/debug/probe-order?orderId=2000018117639410
router.get("/debug/probe-order", async (req, res) => {
  const orderId = req.query.orderId;
  if (!orderId) return res.status(400).json({ error: "Informe ?orderId=..." });

  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = { orderId, contasChecadas: [] };

  for (const acc of accounts) {
    const sellerId = acc.id;
    const entry = { sellerId, nickname: acc.nickname };
    try {
      const accessToken = await getValidAccessToken(sellerId);

      let order;
      try {
        order = await fetchOrderById(accessToken, orderId);
      } catch (err) {
        entry.pedidoEncontradoNestaConta = false;
        entry.erroBuscarPedido = { status: err.status, body: err.body || err.message };
        report.contasChecadas.push(entry);
        continue;
      }

      entry.pedidoEncontradoNestaConta = true;
      entry.tags = order?.tags || null;
      entry.status = order?.status || null;
      entry.packIdDoPedido = order?.pack_id || null;
      entry.buyer = order?.buyer
        ? { id: order.buyer.id, nickname: order.buyer.nickname, first_name: order.buyer.first_name, last_name: order.buyer.last_name }
        : null;
      entry.totalAmount = order?.total_amount ?? null;
      entry.dateCreated = order?.date_created || null;

      // Confere se esse pedido aparece na busca geral dos 50 mais recentes
      // (sem nenhum filtro) — se NAO aparecer aqui, e um pedido antigo o
      // suficiente pra ter saido da janela padrao de reconciliacao (a busca
      // geral ordena por data do pedido, nao por data da ultima mensagem).
      try {
        const generalSearch = await fetchRecentOrders(accessToken, sellerId, { limit: 50 });
        const found = (generalSearch?.results || []).some((o) => String(o.id) === String(orderId));
        entry.apareceNos50MaisRecentesGeral = found;
        entry.totalPedidosDaConta = generalSearch?.paging?.total ?? null;
      } catch (err) {
        entry.erroBusca50MaisRecentes = { status: err.status, body: err.body || err.message };
      }

      // Confere se esse pedido aparece na busca dedicada por tags=no_shipping
      // (a que corrige o problema de pedidos saindo da janela dos mais
      // recentes) — se nao aparecer aqui mesmo sendo no_shipping, o
      // problema esta na busca da API, nao no processamento do painel.
      try {
        const noShippingSearch = await fetchRecentOrders(accessToken, sellerId, {
          limit: 50,
          tags: "no_shipping",
        });
        const found = (noShippingSearch?.results || []).some((o) => String(o.id) === String(orderId));
        entry.apareceNaBuscaTagsNoShipping = found;
        entry.totalPedidosNaBuscaTagsNoShipping = noShippingSearch?.paging?.total ?? null;
      } catch (err) {
        entry.erroBuscaTagsNoShipping = { status: err.status, body: err.body || err.message };
      }

      // Confere se esse pedido aparece na busca dedicada por
      // date_last_updated dos ultimos 3 dias (a nova rede de seguranca pra
      // pedidos antigos com atividade recente) — se a mensagem chegou ha
      // pouco (como no relato do usuario) mas o pedido NAO aparecer aqui,
      // e sinal de que esse campo do Mercado Livre nao e atualizado so por
      // causa de mensagem nova, e o caminho que precisa funcionar e o
      // webhook em tempo real, nao essa busca.
      try {
        const to = new Date();
        const from = new Date(to.getTime() - 3 * 24 * 60 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        const toMlDate = (d) => {
          const s = new Date(d.getTime() - 3 * 60 * 60 * 1000);
          return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}T${pad(
            s.getUTCHours()
          )}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}.000-03:00`;
        };
        const recentlyUpdatedSearch = await fetchRecentOrders(accessToken, sellerId, {
          limit: 50,
          dateLastUpdatedFrom: toMlDate(from),
          dateLastUpdatedTo: toMlDate(to),
        });
        const found = (recentlyUpdatedSearch?.results || []).some((o) => String(o.id) === String(orderId));
        entry.apareceNaBuscaAtividadeRecente = found;
        entry.totalPedidosNaBuscaAtividadeRecente = recentlyUpdatedSearch?.paging?.total ?? null;
      } catch (err) {
        entry.erroBuscaAtividadeRecente = { status: err.status, body: err.body || err.message };
      }

      // Tenta buscar as mensagens do pack (pack_id do pedido, ou o proprio
      // order_id quando nao ha pack_id — regra ja usada no resto do painel).
      // Se encontrar mensagem, ja aproveita e GRAVA a conversa de verdade no
      // banco (mesma funcao usada pela reconciliacao normal) — assim essa
      // rota nao serve so pra diagnosticar, serve tambem pra "destravar" na
      // hora um pedido especifico que as buscas automaticas ainda nao
      // alcancaram (por exemplo, um pedido antigo demais pra caber na
      // janela das buscas dedicadas).
      const packId = order?.pack_id || order?.id;
      try {
        const packData = await fetchPackMessages(accessToken, packId, sellerId);
        entry.packIdUsado = packId;
        entry.mensagensEncontradas = Array.isArray(packData?.messages) ? packData.messages.length : null;
        entry.ultimasMensagens = (packData?.messages || []).slice(-3).map((m) => ({
          from: m?.from?.user_id,
          text: m?.text,
          data: m?.message_date,
        }));

        if (entry.mensagensEncontradas > 0) {
          try {
            await upsertConversationFromPack(sellerId, packId, packData, orderId, extractOrderInfo(order));
            entry.gravadoNoPainel = true;
          } catch (err) {
            entry.erroGravarNoPainel = err.message;
          }
        }
      } catch (err) {
        entry.erroBuscarMensagens = { status: err.status, body: err.body || err.message };
      }

      // Confere se ja existe (ou existia) uma conversa gravada no banco
      // pra esse pedido, e com qual status.
      const { rows: convRows } = await db.query(
        "SELECT pack_id, status, blocked_reason, updated_at FROM conversations WHERE order_id = $1",
        [String(orderId)]
      );
      entry.conversaNoBanco = convRows[0] || null;
    } catch (err) {
      entry.erro = err.message;
    }
    report.contasChecadas.push(entry);
  }

  res.json(report);
});

// Rota TEMPORARIA de diagnostico: o pedido #2000014790041703 (Escola
// Delariva Barueri, "atrasado 2 dias") aparece no proprio painel de Vendas
// do Mercado Livre dentro da conta VESCO SUPRIMENTOS (confirmado pelo
// vendedor), mas /orders/2000014790041703 devolve 404 "Order do not exists"
// justamente quando chamado com o token gravado pra essa conta (id
// 522101670) — ou seja, o pedido e real e e dela, mas o token que a gente
// tem gravado pra "VESCO SUPRIMENTOS" nao enxerga ele. Isso só faz sentido
// se o token gravado no nosso banco pra essa conta na verdade pertencer a
// um usuario/vendedor diferente do que a gente pensa (por exemplo: a conta
// foi reconectada em algum momento e o token novo ficou de outro usuario,
// ou o ID gravado como "dono" desse token nao e o ID real do vendedor
// autenticado). Essa rota confere isso na fonte: pra cada conta gravada,
// pega o token e pergunta pro proprio Mercado Livre (/users/me) "de quem
// e esse token" — e compara com o que o nosso banco acha que e essa conta.
// Uso: abrir no navegador (ja logado no painel) /api/debug/probe-identidade
router.get("/debug/probe-identidade", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const relatorio = [];

  for (const acc of accounts) {
    const entry = { idGravadoNoBanco: acc.id, nicknameGravadoNoBanco: acc.nickname };
    try {
      const accessToken = await getValidAccessToken(acc.id);
      const me = await fetchMe(accessToken);
      entry.idRealDoToken = String(me?.id ?? "");
      entry.nicknameRealDoToken = me?.nickname ?? null;
      entry.bateCertinho = String(me?.id ?? "") === String(acc.id);
    } catch (err) {
      entry.erro = { status: err.status, body: err.body || err.message };
    }
    relatorio.push(entry);
  }

  res.json(relatorio);
});

// Rota TEMPORARIA de diagnostico: mostra as ultimas notificacoes (webhooks)
// que o Mercado Livre mandou pra essa aplicacao, por conta — inclusive de
// topicos que a gente ignora. Serve pra responder se o problema de
// mensagens "sumidas" de uma conta especifica (ex: Vesco Suprimentos) e
// porque o Mercado Livre nunca chega a notificar essa conta (nesse caso,
// nao vai aparecer NADA aqui pra ela, mesmo com mensagem nova chegando de
// verdade) — o que indicaria um problema na configuracao do webhook
// (URL de callback e topico "messages" cadastrados no app do Mercado
// Livre), e nao no processamento feito por este painel. Uso: abrir no
// navegador (ja logado no painel) /api/debug/webhook-events, ou
// /api/debug/webhook-events?sellerId=... pra filtrar so uma conta.
router.get("/debug/webhook-events", async (req, res) => {
  const conditions = [];
  const params = [];
  if (req.query.sellerId) {
    params.push(req.query.sellerId);
    conditions.push(`w.seller_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await db.query(
    `SELECT w.id, w.topic, w.seller_id, a.nickname AS seller_nickname, w.resource, w.received_at
       FROM webhook_events w
       LEFT JOIN accounts a ON a.id = w.seller_id
       ${where}
       ORDER BY w.received_at DESC
       LIMIT 100`,
    params
  );

  const { rows: porConta } = await db.query(
    `SELECT a.id AS seller_id, a.nickname,
            COUNT(w.id)::int AS total_notificacoes,
            COUNT(w.id) FILTER (WHERE w.topic ILIKE '%message%')::int AS total_notificacoes_mensagem,
            MAX(w.received_at) AS ultima_notificacao_em
       FROM accounts a
       LEFT JOIN webhook_events w ON w.seller_id = a.id
      GROUP BY a.id, a.nickname
      ORDER BY a.nickname`
  );

  res.json({ resumoPorConta: porConta, ultimasNotificacoes: rows });
});

// Rota de diagnostico: mostra, por conta, os packs com mensagem NAO LIDA
// que o endpoint dedicado (GET /messages/pending_read — ver
// fetchUnreadMessagePacks em ml/api.js) devolve agora mesmo. Isso e o mesmo
// dado que aparece no filtro "Com mensagens não lidas" do proprio painel de
// Vendas do Mercado Livre. CORRIGIDO: esse endpoint usava antes
// "/marketplace/messages/unread" (API de Global Selling — venda
// transfronteirica —, que devolvia 403 "Invalid caller.id" pra qualquer
// conta comum brasileira, ou seja, nunca funcionou de verdade); agora usa
// "/messages/pending_read", da API normal de mensagens pos-venda (mesmo
// dominio das outras chamadas deste arquivo). Esse dado alimenta a
// reconciliacao de verdade (ver o passo dedicado em reconcileAccount, em
// sync.js) — essa rota so serve pra conferir manualmente o que essa busca
// esta encontrando pra uma conta. Uso: abrir no navegador (ja logado no
// painel) /api/debug/probe-unread-messages
router.get("/debug/probe-unread-messages", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = [];

  for (const acc of accounts) {
    const sellerId = acc.id;
    const entry = { sellerId, nickname: acc.nickname };
    try {
      const accessToken = await getValidAccessToken(sellerId);
      try {
        const packs = await fetchUnreadMessagePacks(accessToken, sellerId);
        entry.sucesso = true;
        entry.totalPacksComNaoLida = packs.length;
        entry.packs = packs;
      } catch (err) {
        entry.sucesso = false;
        entry.erro = err.message;
        entry.status = err.status;
        entry.body = err.body;
      }
    } catch (err) {
      entry.erro = err.message;
    }
    report.push(entry);
  }

  res.json(report);
});

// Lista de nomes de operador ja usados (mensagens + reclamacoes), pra
// preencher o filtro da tela de Histórico sem o vendedor ter que digitar de
// cabeça quem ja respondeu por ali.
router.get("/operators", async (req, res) => {
  const { rows } = await db.query(`
    SELECT DISTINCT operator_name FROM (
      SELECT operator_name FROM messages WHERE operator_name IS NOT NULL
      UNION
      SELECT operator_name FROM claim_messages WHERE operator_name IS NOT NULL
      UNION
      SELECT operator_name FROM questions WHERE operator_name IS NOT NULL
    ) t
    ORDER BY operator_name ASC
  `);
  res.json(rows.map((r) => r.operator_name));
});

// Histórico de respostas: junta as mensagens (pos-venda) e as respostas de
// reclamacao enviadas por aqui, numa unica lista — cada linha e "quem
// respondeu, o pedido, quando". So entram respostas que passaram por este
// painel depois que essa coluna foi criada (envios antigos ficam de fora,
// ja que nao tem como saber quem os enviou).
router.get("/operator-log", async (req, res) => {
  const conditions = ["operator_name IS NOT NULL"];
  const params = [];

  const operator = (req.query.operator || "").trim();
  if (operator) {
    params.push(operator);
    conditions.push(`operator_name = $${params.length}`);
  }
  const from = (req.query.from || "").trim();
  if (from) {
    params.push(`${from}T00:00:00.000Z`);
    conditions.push(`sent_date >= $${params.length}`);
  }
  const to = (req.query.to || "").trim();
  if (to) {
    params.push(`${to}T23:59:59.999Z`);
    conditions.push(`sent_date <= $${params.length}`);
  }
  const where = conditions.join(" AND ");

  // As duas metades da UNION precisam da mesma lista de parametros
  // (mesma ordem de $1, $2...), entao usamos os MESMOS params pras duas.
  const { rows } = await db.query(
    `
    (
      SELECT 'message' AS type, m.operator_name, c.pack_id AS ref_id, c.order_id,
             c.buyer_full_name AS buyer_name, c.product_title, m.text, m.sent_date,
             a.nickname AS seller_nickname
        FROM messages m
        JOIN conversations c ON c.pack_id = m.pack_id
        JOIN accounts a ON a.id = c.seller_id
       WHERE m.direction = 'out' AND ${where.replace(/operator_name/g, "m.operator_name").replace(/sent_date/g, "m.sent_date")}
    )
    UNION ALL
    (
      SELECT 'claim' AS type, cm.operator_name, cl.claim_id AS ref_id, cl.order_id,
             cl.buyer_full_name AS buyer_name, cl.product_title, cm.message AS text, cm.sent_date,
             a.nickname AS seller_nickname
        FROM claim_messages cm
        JOIN claims cl ON cl.claim_id = cm.claim_id
        JOIN accounts a ON a.id = cl.seller_id
       WHERE cm.sender_role = 'respondent' AND ${where.replace(/operator_name/g, "cm.operator_name").replace(/sent_date/g, "cm.sent_date")}
    )
    UNION ALL
    (
      SELECT 'question' AS type, q.operator_name, q.question_id AS ref_id, NULL AS order_id,
             q.buyer_nickname AS buyer_name, q.item_title AS product_title, q.answer_text AS text, q.answer_date::text AS sent_date,
             a.nickname AS seller_nickname
        FROM questions q
        JOIN accounts a ON a.id = q.seller_id
       WHERE q.answer_text IS NOT NULL AND ${where.replace(/operator_name/g, "q.operator_name").replace(/sent_date/g, "q.answer_date::text")}
    )
    ORDER BY sent_date DESC
    LIMIT 500
    `,
    params
  );

  res.json({ rows, truncated: rows.length === 500 });
});

module.exports = router;
