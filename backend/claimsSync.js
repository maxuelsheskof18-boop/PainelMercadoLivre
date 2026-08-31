// Sincronizacao das RECLAMACOES (Central de Resolucoes/mediacao) do Mercado
// Livre — sistema separado das mensagens pos-venda (ver sync.js). Mesma
// filosofia geral: uma varredura periodica (chamada de dentro do mesmo loop
// de reconciliacao que ja existe) busca as reclamacoes abertas de cada
// conta, guarda localmente, e classifica em 'pending' (aguardando o
// vendedor) ou 'answered' (vendedor ja respondeu por ultimo) pra alimentar
// uma aba propria no painel.
const db = require("./db");
const { getValidAccessToken, withTokenRetry } = require("./ml/tokens");
const { fetchOrderById } = require("./ml/api");
const { extractOrderInfo, fetchShippingType } = require("./sync");
const {
  fetchClaims,
  fetchClaimById,
  fetchClaimMessages,
} = require("./ml/claimsApi");

const CLAIMS_PAGE_SIZE = 50;
// Reclamacao e bem mais rara que pedido — mesmo numa conta de alto volume,
// 150 reclamacoes abertas ao mesmo tempo ja seria um volume atipico.
const CLAIMS_MAX_PAGES = 3;

function claimMessageDate(m) {
  return m?.date_created || null;
}

// Assim que uma reclamacao entra em mediacao/disputa, o Mercado Livre
// bloqueia mensagem direta pro comprador — so pro mediador (o proprio
// Mercado Livre) a partir dai. Documentacao oficial: "Once mediation has
// begun, messages cannot be sent to the buyer. All communication will be
// made by Mercado Libre." Nos outros estagios ('claim', 'recontact', 'none')
// ainda da pra falar direto com o comprador.
function decideReceiverRole(stage) {
  return stage === "dispute" ? "mediator" : "complainant";
}

// Extrai os campos principais de uma reclamacao. Segue o formato
// documentado (post-purchase/v1/claims/search) — se o Mercado Livre devolver
// algo diferente na pratica, a rota /api/debug/probe-claims ajuda a achar o
// nome certo rapido.
function extractClaimInfo(claim) {
  if (!claim) return null;
  const players = Array.isArray(claim.players) ? claim.players : [];
  // Assumimos que o dono do token (o vendedor) e sempre o "respondent" —
  // caso valido pra reclamacao aberta PELO COMPRADOR contra uma venda, que e
  // o cenario que motivou esse recurso. Se um dia precisar cobrir o caso
  // contrario (vendedor reclamando), essa suposicao precisa ser revista.
  const complainant = players.find((p) => p?.role === "complainant");
  const buyerId = complainant?.user_id != null ? String(complainant.user_id) : null;

  const actions = Array.isArray(claim.available_actions) ? claim.available_actions : [];
  const mandatoryActions = actions.filter((a) => a?.mandatory);
  const nextDue = mandatoryActions
    .map((a) => a?.due_date)
    .filter(Boolean)
    .sort()[0] || null;

  return {
    resource: claim.resource || null,
    resourceId: claim.resource_id != null ? String(claim.resource_id) : null,
    type: claim.type || null,
    stage: claim.stage || null,
    mlStatus: claim.status || null,
    reasonId: claim.reason_id || null,
    buyerId,
    dueDate: nextDue,
    mandatoryAction: mandatoryActions.length > 0,
  };
}

function computeLocalStatus(mlStatus, messages) {
  if (mlStatus === "closed") return "closed";
  const msgs = Array.isArray(messages) ? [...messages] : [];
  if (msgs.length === 0) return "pending";
  msgs.sort((a, b) => {
    const da = claimMessageDate(a);
    const db_ = claimMessageDate(b);
    if (!da || !db_) return 0;
    return new Date(da) - new Date(db_);
  });
  const last = msgs[msgs.length - 1];
  return last?.sender_role === "respondent" ? "answered" : "pending";
}

// Grava/atualiza uma reclamacao e suas mensagens no banco. As mensagens sao
// substituidas por inteiro a cada sincronizacao (nao da pra saber um id
// estavel de mensagem individual pelo formato documentado) — reclamacao tem
// volume baixo o suficiente pra isso nao pesar.
async function upsertClaim(sellerId, claim, messages, orderInfo) {
  const info = extractClaimInfo(claim);
  if (!info) return;
  const claimId = String(claim.id);

  const msgs = Array.isArray(messages) ? [...messages] : [];
  msgs.sort((a, b) => {
    const da = claimMessageDate(a);
    const db_ = claimMessageDate(b);
    if (!da || !db_) return 0;
    return new Date(da) - new Date(db_);
  });
  const last = msgs[msgs.length - 1];

  // Se o vendedor marcou essa reclamacao como "resolvida" manualmente (pra
  // casos antigos ja tratados por fora do painel — ver rota
  // POST /claims/:claimId/mark-resolved), mantemos ela fechada aqui mesmo
  // que o Mercado Livre ainda a considere aberta — A NAO SER que tenha
  // chegado mensagem nova depois da marcacao, o que indica que o assunto
  // voltou a ficar ativo e precisa reabrir sozinho.
  const { rows: existingRows } = await db.query(
    "SELECT resolved_by_operator_at, resolved_by_operator FROM claims WHERE claim_id = $1",
    [claimId]
  );
  let resolvedByOperatorAt = existingRows[0]?.resolved_by_operator_at || null;
  let resolvedByOperator = existingRows[0]?.resolved_by_operator || null;
  const lastMessageDate = claimMessageDate(last);
  if (resolvedByOperatorAt && lastMessageDate && new Date(lastMessageDate) > new Date(resolvedByOperatorAt)) {
    // Reabre: chegou mensagem depois da marcacao manual.
    resolvedByOperatorAt = null;
    resolvedByOperator = null;
  }

  const localStatus = resolvedByOperatorAt ? "closed" : computeLocalStatus(info.mlStatus, messages);

  const orderId = info.resource === "order" ? info.resourceId : null;
  const buyerFullName = orderInfo?.buyerFullName ?? null;
  const productTitle = orderInfo?.productTitle ?? null;
  const orderTotal = orderInfo && typeof orderInfo.orderTotal === "number" ? orderInfo.orderTotal : null;
  const orderQuantity = orderInfo && typeof orderInfo.orderQuantity === "number" ? orderInfo.orderQuantity : null;
  const shippingType = orderInfo?.shippingType ?? null;

  await db.query(
    `INSERT INTO claims
       (claim_id, seller_id, order_id, resource, resource_id, type, stage, ml_status, reason_id, buyer_id, buyer_full_name, product_title, order_total, order_quantity, last_message_text, last_message_date, local_status, due_date, mandatory_action, shipping_type, resolved_by_operator_at, resolved_by_operator, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, now())
     ON CONFLICT (claim_id) DO UPDATE SET
       order_id = COALESCE(EXCLUDED.order_id, claims.order_id),
       resource = EXCLUDED.resource,
       resource_id = EXCLUDED.resource_id,
       type = EXCLUDED.type,
       stage = EXCLUDED.stage,
       ml_status = EXCLUDED.ml_status,
       reason_id = EXCLUDED.reason_id,
       buyer_id = COALESCE(EXCLUDED.buyer_id, claims.buyer_id),
       buyer_full_name = COALESCE(EXCLUDED.buyer_full_name, claims.buyer_full_name),
       product_title = COALESCE(EXCLUDED.product_title, claims.product_title),
       order_total = COALESCE(EXCLUDED.order_total, claims.order_total),
       order_quantity = COALESCE(EXCLUDED.order_quantity, claims.order_quantity),
       last_message_text = EXCLUDED.last_message_text,
       last_message_date = EXCLUDED.last_message_date,
       local_status = EXCLUDED.local_status,
       due_date = EXCLUDED.due_date,
       mandatory_action = EXCLUDED.mandatory_action,
       shipping_type = COALESCE(EXCLUDED.shipping_type, claims.shipping_type),
       resolved_by_operator_at = EXCLUDED.resolved_by_operator_at,
       resolved_by_operator = EXCLUDED.resolved_by_operator,
       updated_at = now()`,
    [
      claimId,
      String(sellerId),
      orderId,
      info.resource,
      info.resourceId,
      info.type,
      info.stage,
      info.mlStatus,
      info.reasonId,
      info.buyerId,
      buyerFullName,
      productTitle,
      orderTotal,
      orderQuantity,
      last?.message || null,
      claimMessageDate(last),
      localStatus,
      info.dueDate,
      info.mandatoryAction,
      shippingType,
      resolvedByOperatorAt,
      resolvedByOperator,
    ]
  );

  await db.query("DELETE FROM claim_messages WHERE claim_id = $1", [claimId]);
  for (const m of msgs) {
    await db.query(
      `INSERT INTO claim_messages (claim_id, sender_role, receiver_role, message, attachments, sent_date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        claimId,
        m?.sender_role || null,
        m?.receiver_role || null,
        m?.message || null,
        m?.attachments ? JSON.stringify(m.attachments) : null,
        claimMessageDate(m),
      ]
    );
  }
}

// Busca detalhes do pedido (produto/comprador/valor) associados a uma
// reclamacao, quando o "resource" dela for um pedido — mesma logica ja usada
// pras conversas de mensagens (extractOrderInfo), reaproveitada aqui.
// Devolve { orderInfo, accessToken } — o accessToken devolvido pode ter sido
// renovado (ver withTokenRetry em ml/tokens.js), e quem chamou deve
// atualizar sua propria copia local com ele.
async function fetchOrderInfoForClaim(sellerId, accessToken, info) {
  if (info.resource !== "order" || !info.resourceId) return { orderInfo: null, accessToken };
  try {
    const orderResult = await withTokenRetry(sellerId, accessToken, (token) => fetchOrderById(token, info.resourceId));
    const order = orderResult.result;
    accessToken = orderResult.accessToken;
    // O tipo de envio (Flex/Agência/etc.) vem do mesmo pedido, do mesmo jeito
    // que ja e feito pras conversas de mensagens (ver fetchShippingType).
    const shippingType = await fetchShippingType(accessToken, order);
    return { orderInfo: { ...extractOrderInfo(order), shippingType }, accessToken };
  } catch (err) {
    console.warn(
      `[claims] nao consegui buscar detalhes do pedido ${info.resourceId} da reclamacao:`,
      err.status,
      err.body || err.message
    );
    return { orderInfo: null, accessToken };
  }
}

// Sincroniza UMA reclamacao especifica pelo id — usado tanto pelo webhook
// (tempo real) quanto pela reverificacao de reclamacoes ja fechadas.
async function syncClaim(sellerId, claimId) {
  const accessToken = await getValidAccessToken(sellerId);
  const claim = await fetchClaimById(accessToken, claimId);
  const messagesData = await fetchClaimMessages(accessToken, claimId);
  const messages = Array.isArray(messagesData) ? messagesData : messagesData?.messages || [];
  const info = extractClaimInfo(claim);
  const { orderInfo } = await fetchOrderInfoForClaim(sellerId, accessToken, info);
  await upsertClaim(sellerId, claim, messages, orderInfo);
}

// Varredura periodica de UMA conta: busca as reclamacoes abertas, e
// reverifica as que estavam abertas localmente pra ver se ja fecharam
// (a busca por status=opened nao devolve mais reclamacoes fechadas, entao
// sem isso uma reclamacao resolvida ficaria "presa" pra sempre na aba
// errada).
async function reconcileClaimsForAccount(sellerId) {
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
  for (let page = 0; page < CLAIMS_MAX_PAGES; page++) {
    let data;
    try {
      data = await fetchClaims(accessToken, { status: "opened", offset, limit: CLAIMS_PAGE_SIZE });
    } catch (err) {
      console.warn(`[claims] falha ao buscar reclamacoes abertas da conta ${sellerId}:`, err.status, err.body || err.message);
      break;
    }
    const results = Array.isArray(data?.data) ? data.data : Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    offset += results.length;
    total = data?.paging?.total ?? offset;
    if (results.length === 0 || offset >= total) break;
  }

  let processadas = 0;
  for (const claim of all) {
    try {
      const info = extractClaimInfo(claim);
      const msgResult = await withTokenRetry(sellerId, accessToken, (token) => fetchClaimMessages(token, claim.id));
      const messagesData = msgResult.result;
      accessToken = msgResult.accessToken;
      const messages = Array.isArray(messagesData) ? messagesData : messagesData?.messages || [];
      const { orderInfo, accessToken: tokenAfterOrder } = await fetchOrderInfoForClaim(sellerId, accessToken, info);
      accessToken = tokenAfterOrder;
      await upsertClaim(sellerId, claim, messages, orderInfo);
      processadas++;
    } catch (err) {
      console.warn(`[claims] falha ao sincronizar reclamacao ${claim?.id}:`, err.status, err.body || err.message);
    }
  }

  // Reverifica reclamacoes que este painel ainda acha que estao abertas —
  // se o Mercado Livre ja fechou, essa e a unica forma de descobrir (a busca
  // por status=opened acima nunca mais vai trazer de volta).
  const { rows: trackedOpen } = await db.query(
    `SELECT claim_id FROM claims WHERE seller_id = $1 AND local_status <> 'closed'`,
    [sellerId]
  );
  let fechadas = 0;
  for (const row of trackedOpen) {
    if (all.some((c) => String(c.id) === row.claim_id)) continue; // ja atualizada acima
    try {
      await syncClaim(sellerId, row.claim_id);
      const { rows: check } = await db.query("SELECT local_status FROM claims WHERE claim_id = $1", [row.claim_id]);
      if (check[0]?.local_status === "closed") fechadas++;
    } catch (err) {
      console.warn(`[claims] falha ao reverificar reclamacao ${row.claim_id}:`, err.status, err.body || err.message);
    }
  }

  console.log(
    `[claims] conta ${sellerId}: ${all.length} reclamacao(oes) aberta(s) encontrada(s) (${processadas} sincronizada(s)), ${trackedOpen.length} rastreada(s) reverificada(s) (${fechadas} fecharam agora).`
  );
}

async function reconcileAllClaims() {
  const { rows: accounts } = await db.query("SELECT id FROM accounts");
  for (const acc of accounts) {
    try {
      await reconcileClaimsForAccount(acc.id);
    } catch (err) {
      console.error(`[claims] falha na conta ${acc.id}:`, err.message);
    }
  }
}

module.exports = {
  reconcileClaimsForAccount,
  reconcileAllClaims,
  syncClaim,
  decideReceiverRole,
  extractClaimInfo,
  upsertClaim,
};
