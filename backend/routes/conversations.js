const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");
const {
  sendMessage,
  fetchMe,
  fetchRecentOrders,
  fetchPackMessages,
  fetchOrderById,
  fetchShipment,
  fetchPendingRead,
} = require("../ml/api");
const {
  reconcileAllAccounts,
  extractOrderInfo,
  upsertConversationFromPack,
  fetchShippingType,
} = require("../sync");

const router = express.Router();

// Este router e montado em "/api" (veja server.js), entao os caminhos aqui
// dentro NAO repetem o prefixo "/api" — e por isso, alem de exigir login,
// que ele so intercepta pedidos que ja comecam com /api/..., sem afetar
// paginas publicas como /login.html.
router.use(requireLogin);

router.get("/pending-count", async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending' AND is_delivered IS NOT TRUE)::int AS pending,
       COUNT(*) FILTER (WHERE status = 'no_contact')::int AS no_contact,
       COUNT(*) FILTER (WHERE status = 'pending' AND is_delivered = true)::int AS delivered
     FROM conversations`
  );
  res.json({ pending: rows[0].pending, noContact: rows[0].no_contact, delivered: rows[0].delivered });
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

  const { rows } = await db.query(
    `SELECT c.*, a.nickname AS seller_nickname
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
    `SELECT c.*, a.nickname AS seller_nickname
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
                shipping_type = COALESCE($5, shipping_type),
                updated_at = now()
          WHERE pack_id = $6
          RETURNING *`,
        [
          orderInfo?.buyerFullName ?? null,
          orderInfo?.productTitle ?? null,
          orderInfo?.isCombinarEntrega ?? null,
          orderInfo?.orderTotal ?? null,
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

// Quando o Mercado Livre recusa o envio porque a conversa foi bloqueada
// permanentemente (reembolso, mediacao/reclamacao encerrada, envio Full,
// prazo de resposta esgotado), nao adianta o vendedor tentar de novo — a
// API sempre vai recusar. Detecta esses casos ("blocked_by_...") em
// qualquer lugar que a mensagem de erro do Mercado Livre venha.
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
  return candidates.find((c) => /^blocked_by_/i.test(c)) || null;
}

const BLOCK_REASON_LABELS = {
  blocked_by_refund: "reembolso feito ao comprador",
  blocked_by_mediation: "mediação/reclamação encerrada",
  blocked_by_fulfillment: "pedido enviado por Full",
  blocked_by_time: "prazo para responder encerrado",
};

router.post("/conversations/:packId/reply", express.json(), async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Mensagem vazia" });
  }

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

    await sendMessage({
      accessToken,
      packId: conv.pack_id,
      sellerId: conv.seller_id,
      buyerId: conv.buyer_id,
      sellerEmail: me?.email,
      text: text.trim(),
    });

    const nowIso = new Date().toISOString();

    await db.query(
      `INSERT INTO messages (pack_id, direction, author_user_id, text, sent_date)
       VALUES ($1, 'out', $2, $3, $4)`,
      [conv.pack_id, conv.seller_id, text.trim(), nowIso]
    );

    await db.query(
      `UPDATE conversations
       SET status = 'answered', last_message_text = $1, last_message_date = $2, updated_at = now()
       WHERE pack_id = $3`,
      [text.trim(), nowIso, conv.pack_id]
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

    const blockReason = err.status === 403 ? extractBlockReason(err.body) : null;
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

// Botao "Atualizar agora" no painel: forca uma reconciliacao manual, sem
// esperar o webhook (util principalmente logo apos o servico "acordar" no
// plano gratuito do Render).
router.post("/sync", async (req, res) => {
  try {
    await reconcileAllAccounts();
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

// Rota TEMPORARIA de diagnostico: tenta os 3 caminhos conhecidos de "listar
// mensagens pendentes/nao lidas" (fetchPendingRead, ja escrito ha tempos
// mas nunca usado de verdade porque nenhum tinha sido confirmado
// funcionando) pra cada conta conectada. Motivo: as buscas dedicadas feitas
// hoje (tags=no_shipping, tags=delivered, date_last_updated) sao todas
// baseadas na lista de PEDIDOS, ordenada por data de criacao/fechamento do
// pedido — nunca por "tem mensagem nova". Numa conta de altissimo volume
// como a Vesco Suprimentos, um pedido bem antigo (fechado ha muito tempo)
// que recebe mensagem nova pode ficar fora de QUALQUER janela baseada em
// pedido, por maior que seja. Se algum desses 3 caminhos realmente
// funcionar, ele resolveria isso de vez (lista direto por mensagem, nao por
// pedido) em vez de continuar so alargando janelas de busca. Uso: abrir no
// navegador (ja logado no painel) /api/debug/probe-pending-read
router.get("/debug/probe-pending-read", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = [];

  for (const acc of accounts) {
    const sellerId = acc.id;
    const entry = { sellerId, nickname: acc.nickname };
    try {
      const accessToken = await getValidAccessToken(sellerId);
      try {
        const data = await fetchPendingRead(accessToken);
        entry.sucesso = true;
        entry.resultadoResumido = Array.isArray(data?.results)
          ? { totalResultados: data.results.length, paging: data.paging, amostra: data.results.slice(0, 5) }
          : data;
      } catch (err) {
        entry.sucesso = false;
        entry.erro = err.message;
        entry.tentativas = err.attempts || null;
      }
    } catch (err) {
      entry.erro = err.message;
    }
    report.push(entry);
  }

  res.json(report);
});

module.exports = router;
