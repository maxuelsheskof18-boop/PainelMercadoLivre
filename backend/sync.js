// Le uma conversa (pack) devolvida pela API do Mercado Livre e grava/atualiza
// as tabelas locais (conversations + messages), decidindo se ela fica
// "pending" (aguardando resposta do vendedor) ou "answered".
const db = require("./db");
const { fetchPackMessages, fetchRecentOrders, fetchOrderById } = require("./ml/api");
const { getValidAccessToken } = require("./ml/tokens");

// Quantos pedidos recentes verificar por conta a cada reconciliacao. O
// Mercado Livre nao tem mais (ou nunca teve de forma confiavel, pra essa
// aplicacao) um endpoint que liste so os pedidos com mensagem pendente —
// confirmamos isso testando ao vivo. Em vez disso, olhamos os N pedidos
// mais recentes e checamos as mensagens de cada um. Isso cobre bem o caso
// de uso (webhooks cuidam do tempo real; isso aqui e so uma rede de
// seguranca).
//
// PROBLEMA JA VISTO NA PRATICA: numa conta que vende muito (ex: dezenas de
// pedidos por dia via Flex/Agencia, alem dos de combinar entrega), os N
// pedidos MAIS RECENTES no geral podem ser todos de outros tipos de envio —
// um pedido de combinar entrega de ontem pode ja ter saido dessa janela so
// porque vieram 50+ pedidos de outros tipos depois dele. Foi exatamente o
// que aconteceu com uma conta de maior volume: as mensagens dela paravam de
// ser importadas.
//
// A correcao: alem dessa varredura geral (que continua servindo de rede de
// seguranca ampla), fazemos TAMBEM uma busca dedicada e paginada so pelos
// pedidos com a tag "no_shipping" (= combinar entrega) — assim um pedido
// desse tipo nunca fica de fora so por causa do volume de outros tipos de
// envio. Ver fetchAllNoShippingOrders() abaixo.
const RECENT_ORDERS_LIMIT = 50;

// Tamanho de cada pagina e quantas paginas buscar, no maximo, na varredura
// dedicada de "combinar entrega". Combinar entrega costuma ser uma fatia
// pequena do total de vendas de uma loja, entao da pra cobrir uma janela
// bem mais larga (ate 300 pedidos) gastando poucas chamadas extras de API.
const NO_SHIPPING_PAGE_SIZE = 50;
const NO_SHIPPING_MAX_PAGES = 6;

// Busca TODOS os pedidos recentes marcados com a tag "no_shipping"
// (combinar entrega), paginando ate NO_SHIPPING_MAX_PAGES paginas ou ate
// acabarem os resultados — o que vier primeiro.
async function fetchAllNoShippingOrders(accessToken, sellerId) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < NO_SHIPPING_MAX_PAGES; page++) {
    const data = await fetchRecentOrders(accessToken, sellerId, {
      limit: NO_SHIPPING_PAGE_SIZE,
      offset,
      tags: "no_shipping",
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    offset += results.length;
    const total = data?.paging?.total ?? offset;
    if (results.length === 0 || offset >= total) break;
  }
  return all;
}

// Segunda rede de seguranca dedicada, pelo mesmo motivo da de "combinar
// entrega" acima: o usuario relatou pedidos JA ENTREGUES (nao so combinar
// entrega — pedidos normais de Flex/Agencia tambem) recebendo mensagem nova
// (pedido de nota fiscal, duvida) muito tempo depois de terem sido criados
// — numa conta de alto volume, um pedido assim ja saiu ha muito da janela
// dos RECENT_ORDERS_LIMIT mais recentes (que ordena por data do pedido, nao
// da mensagem). Como o Mercado Livre nao tem uma busca por "tem mensagem
// nova", usamos o filtro por order.date_last_updated (documentado
// separadamente de date_created) pra pegar pedidos que tiveram QUALQUER
// atividade recente, mesmo antigos. Isso e complementar ao webhook em tempo
// real (que deveria ser o caminho principal pra esse caso) — nao um
// substituto: nao ha garantia de que o Mercado Livre atualiza esse campo so
// por causa de uma mensagem nova, so quando o status/envio muda. Por isso a
// importancia de tambem confirmar se o webhook de "messages" esta mesmo
// configurado e chegando pra essa conta.
// Paginas mais curtas que as de "combinar entrega" (3 em vez de 6) de
// proposito: essa busca (sem filtro de tag) e a de "delivered" abaixo somam
// chamadas de API a cada reconciliacao (a cada 10 minutos), e numa conta de
// altissimo volume como a que motivou essa correcao (quase 100 mudancas de
// pedido notificadas em poucas horas) isso pode virar bastante chamada
// extra. 150 pedidos por busca ja cobre bem o caso comum sem pesar demais.
const RECENTLY_UPDATED_WINDOW_DAYS = 3;
const RECENTLY_UPDATED_PAGE_SIZE = 50;
const RECENTLY_UPDATED_MAX_PAGES = 3;

// Formata uma data no formato que a API do Mercado Livre espera
// (ISO 8601 com o offset de Brasilia, -03:00 — o Brasil nao tem mais
// horario de verao desde 2019, entao o offset e fixo).
function toMlDateParam(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const shifted = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(
    shifted.getUTCHours()
  )}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}.000-03:00`;
}

async function fetchAllRecentlyUpdatedOrders(accessToken, sellerId) {
  const to = new Date();
  const from = new Date(to.getTime() - RECENTLY_UPDATED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const all = [];
  let offset = 0;
  let total = 0;
  for (let page = 0; page < RECENTLY_UPDATED_MAX_PAGES; page++) {
    const data = await fetchRecentOrders(accessToken, sellerId, {
      limit: RECENTLY_UPDATED_PAGE_SIZE,
      offset,
      dateLastUpdatedFrom: toMlDateParam(from),
      dateLastUpdatedTo: toMlDateParam(to),
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    offset += results.length;
    total = data?.paging?.total ?? offset;
    if (results.length === 0 || offset >= total) break;
  }
  // Numa conta de altissimo volume (visto na pratica: uma conta chegou a
  // gerar quase 100 notificacoes de mudanca de pedido em poucas horas),
  // essa busca sem filtro de tag pode ter MUITO mais pedidos "com atividade
  // recente" (qualquer mudanca de status) do que da pra cobrir nas paginas
  // buscadas — e ai um pedido especifico com mensagem nova pode acabar
  // ficando de fora mesmo assim. Melhor avisar isso no log (sem cortar
  // silenciosamente) do que fingir que a cobertura foi completa.
  if (total > all.length) {
    console.warn(
      `[reconcile] busca de atividade recente da conta ${sellerId}: so cobri ${all.length} de ${total} pedidos (limite de paginas atingido) — pode haver pedidos com mensagem nova fora dessa varredura.`
    );
  }
  return all;
}

// Quarta rede de seguranca, mais direcionada que a de "atividade recente"
// acima: busca os pedidos com a tag "delivered" (ja entregues), sem filtro
// de data. A API do Mercado Livre ordena por data_desc que, pra contas de
// vendedor, e a data de FECHAMENTO do pedido (nao de criacao) — entao os
// primeiros resultados sao sempre os pedidos entregues/fechados MAIS
// RECENTEMENTE, o que cobre bem o caso de "comprador manda mensagem logo
// depois da entrega" sem depender do campo incerto date_last_updated.
// Complementa (nao substitui) a busca acima: uma conta de alto volume tem
// MUITO mais pedidos entregues no total do que "com atividade nas ultimas
// 72h", entao aqui vale a pena olhar uma janela maior de paginas.
const DELIVERED_PAGE_SIZE = 50;
const DELIVERED_MAX_PAGES = 3;

async function fetchAllDeliveredOrders(accessToken, sellerId) {
  const all = [];
  let offset = 0;
  let total = 0;
  for (let page = 0; page < DELIVERED_MAX_PAGES; page++) {
    const data = await fetchRecentOrders(accessToken, sellerId, {
      limit: DELIVERED_PAGE_SIZE,
      offset,
      tags: "delivered",
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    offset += results.length;
    total = data?.paging?.total ?? offset;
    if (results.length === 0 || offset >= total) break;
  }
  if (total > all.length) {
    console.warn(
      `[reconcile] busca de pedidos entregues (tags=delivered) da conta ${sellerId}: so cobri ${all.length} de ${total} pedidos entregues no total (limite de paginas atingido) — como a lista vem ordenada pelos fechados mais recentemente primeiro, os pedidos entregues ha mais tempo podem ficar de fora, mas os recem-entregues (que sao os que costumam receber mensagem de pos-entrega) estao cobertos.`
    );
  }
  return all;
}

function messageDate(msg) {
  return (
    msg?.message_date?.received ||
    msg?.message_date?.available ||
    msg?.message_date?.created ||
    msg?.message_date?.notified ||
    null
  );
}

// A tag "no_shipping" num pedido significa que nao ha envio pelo Mercado
// Envios associado — ou seja, a entrega e combinada diretamente entre
// vendedor e comprador. Confirmamos isso comparando pedidos reais: os que
// tinham essa tag eram exatamente os de "combinar entrega", e o unico
// pedido com envio de verdade (logistic_type real) nao tinha essa tag.
function extractOrderInfo(order) {
  if (!order) return null;
  const tags = Array.isArray(order.tags) ? order.tags : [];
  const isCombinarEntrega = tags.includes("no_shipping");
  // Mesma tag usada em isAlreadyResolved() (pedidos sem mensagem que ja
  // foram entregues/concluidos). Aqui serve pra outro caso: pedidos que TEM
  // mensagem, mas o comprador escreveu depois de ja ter recebido a compra
  // (ex: pedindo nota fiscal, duvida geral) — esses vao pra uma aba propria
  // ("Entregues"), separada de Pendentes/Respondidas/Sem contato.
  const isDelivered = tags.includes("delivered");

  const productTitle =
    (order.order_items || [])
      .map((oi) => oi?.item?.title)
      .filter(Boolean)
      .join(", ") || null;

  const buyerFullName = order.buyer
    ? [order.buyer.first_name, order.buyer.last_name]
        .map((s) => (s || "").trim())
        .filter(Boolean)
        .join(" ") || null
    : null;

  // total_amount e o valor total da venda (soma dos itens); e o mesmo
  // numero que aparece como "Total" na tela do pedido no Mercado Livre.
  const orderTotal = typeof order.total_amount === "number" ? order.total_amount : null;

  return { isCombinarEntrega, isDelivered, productTitle, buyerFullName, orderTotal };
}

async function upsertConversationFromPack(sellerId, packId, packData, orderId, orderInfo) {
  const messages = Array.isArray(packData?.messages) ? [...packData.messages] : [];

  // Ordena por data (mais antiga -> mais recente). Se a data vier vazia,
  // mantem a ordem original devolvida pela API.
  messages.sort((a, b) => {
    const da = messageDate(a);
    const db_ = messageDate(b);
    if (!da || !db_) return 0;
    return new Date(da) - new Date(db_);
  });

  const last = messages[messages.length - 1];
  if (!last) return; // conversa sem mensagens ainda, nada a fazer

  const sellerIdStr = String(sellerId);
  const lastFromId = String(last?.from?.user_id ?? "");
  const isLastFromSeller = lastFromId === sellerIdStr;
  const status = isLastFromSeller ? "answered" : "pending";

  // Descobre quem e o comprador: o participante que nao e o vendedor.
  let buyerId = null;
  for (const m of messages) {
    const fromId = String(m?.from?.user_id ?? "");
    const toId = String(m?.to?.user_id ?? "");
    if (fromId && fromId !== sellerIdStr) buyerId = fromId;
    if (toId && toId !== sellerIdStr) buyerId = buyerId || toId;
  }

  const buyerNickname = packData?.buyer?.nickname || null;
  const productTitle = orderInfo?.productTitle ?? null;
  const buyerFullName = orderInfo?.buyerFullName ?? null;
  const orderTotal = orderInfo && typeof orderInfo.orderTotal === "number" ? orderInfo.orderTotal : null;
  // is_combinar_entrega fica null (nao "false") quando ainda nao
  // conseguimos os detalhes do pedido — assim nao classificamos errado por
  // falta de dado, so quando o proprio orderInfo.isCombinarEntrega==false.
  const isCombinarEntrega =
    orderInfo && typeof orderInfo.isCombinarEntrega === "boolean" ? orderInfo.isCombinarEntrega : null;
  // Mesma logica do is_combinar_entrega: fica null (nao "false") quando
  // ainda nao temos os detalhes do pedido, pra nao reclassificar por engano
  // uma conversa que ja estava marcada como "ja entregue" antes.
  const isDelivered = orderInfo && typeof orderInfo.isDelivered === "boolean" ? orderInfo.isDelivered : null;

  await db.query(
    `INSERT INTO conversations
       (pack_id, seller_id, order_id, buyer_id, buyer_nickname, buyer_full_name, product_title, order_total, is_combinar_entrega, is_delivered, last_message_text, last_message_date, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     ON CONFLICT (pack_id) DO UPDATE SET
       order_id = EXCLUDED.order_id,
       buyer_id = COALESCE(EXCLUDED.buyer_id, conversations.buyer_id),
       buyer_nickname = COALESCE(EXCLUDED.buyer_nickname, conversations.buyer_nickname),
       buyer_full_name = COALESCE(EXCLUDED.buyer_full_name, conversations.buyer_full_name),
       product_title = COALESCE(EXCLUDED.product_title, conversations.product_title),
       order_total = COALESCE(EXCLUDED.order_total, conversations.order_total),
       is_combinar_entrega = COALESCE(EXCLUDED.is_combinar_entrega, conversations.is_combinar_entrega),
       is_delivered = COALESCE(EXCLUDED.is_delivered, conversations.is_delivered),
       last_message_text = EXCLUDED.last_message_text,
       last_message_date = EXCLUDED.last_message_date,
       status = EXCLUDED.status,
       updated_at = now()`,
    [
      String(packId),
      sellerIdStr,
      orderId || null,
      buyerId,
      buyerNickname,
      buyerFullName,
      productTitle,
      orderTotal,
      isCombinarEntrega,
      isDelivered,
      last?.text || null,
      messageDate(last),
      status,
    ]
  );

  const { rows: existingRows } = await db.query(
    "SELECT message_id FROM messages WHERE pack_id = $1",
    [String(packId)]
  );
  const existing = new Set(existingRows.map((r) => r.message_id));

  for (const m of messages) {
    const id = m?.id ? String(m.id) : null;
    if (id && existing.has(id)) continue; // ja gravada
    const fromId = String(m?.from?.user_id ?? "");
    await db.query(
      `INSERT INTO messages (pack_id, message_id, direction, author_user_id, text, sent_date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(packId),
        id,
        fromId === sellerIdStr ? "out" : "in",
        fromId || null,
        m?.text || null,
        messageDate(m),
      ]
    );
  }
}

// Grava um pedido de "combinar entrega" que AINDA NAO TEM nenhuma mensagem
// trocada — acontece quando o comprador compra sem perceber que precisa
// combinar a entrega, e por isso nunca escreve. O vendedor pediu pra ver
// esses pedidos tambem (numa lista separada, "Sem contato"), pra poder
// iniciar a conversa. Diferente de upsertConversationFromPack, aqui nao ha
// mensagens pra gravar na tabela "messages" — so o pedido em si.
//
// O ON CONFLICT so atualiza quando a conversa ja gravada tambem esta como
// 'no_contact' (ou e um registro novo): se ja existe uma conversa de
// verdade (pending/answered/blocked) pra esse pack_id, esse UPDATE nao mexe
// nela — quem manda nesse caso e sempre upsertConversationFromPack.
async function upsertNoContactOrder(sellerId, packId, order, orderInfo) {
  const sellerIdStr = String(sellerId);
  const buyerId = order?.buyer?.id != null ? String(order.buyer.id) : null;
  const buyerNickname = order?.buyer?.nickname || null;
  const buyerFullName = orderInfo?.buyerFullName ?? null;
  const productTitle = orderInfo?.productTitle ?? null;
  const orderTotal = orderInfo && typeof orderInfo.orderTotal === "number" ? orderInfo.orderTotal : null;

  await db.query(
    `INSERT INTO conversations
       (pack_id, seller_id, order_id, buyer_id, buyer_nickname, buyer_full_name, product_title, order_total, is_combinar_entrega, last_message_text, last_message_date, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NULL, NULL, 'no_contact', now())
     ON CONFLICT (pack_id) DO UPDATE SET
       buyer_id = COALESCE(EXCLUDED.buyer_id, conversations.buyer_id),
       buyer_nickname = COALESCE(EXCLUDED.buyer_nickname, conversations.buyer_nickname),
       buyer_full_name = COALESCE(EXCLUDED.buyer_full_name, conversations.buyer_full_name),
       product_title = COALESCE(EXCLUDED.product_title, conversations.product_title),
       order_total = COALESCE(EXCLUDED.order_total, conversations.order_total),
       is_combinar_entrega = true,
       updated_at = now()
     WHERE conversations.status = 'no_contact'`,
    [
      String(packId),
      sellerIdStr,
      order?.id != null ? String(order.id) : null,
      buyerId,
      buyerNickname,
      buyerFullName,
      productTitle,
      orderTotal,
    ]
  );
}

// Puxa uma conversa especifica (usado pelo webhook, que ja sabe o pack_id).
async function syncPack(sellerId, packId, orderId) {
  const accessToken = await getValidAccessToken(sellerId);
  const packData = await fetchPackMessages(accessToken, packId, sellerId);

  // O webhook normalmente so manda o pack_id, sem order_id. Quando o
  // pedido nao faz parte de um envio combinado (o caso mais comum, e
  // exatamente o dos pedidos de "combinar entrega"), pack_id == order_id —
  // entao usamos o pack_id como palpite de order_id pra buscar os detalhes
  // (produto, comprador, tipo de entrega). Se falhar, so seguimos sem
  // esses detalhes extras; a mensagem em si e salva do mesmo jeito.
  const effectiveOrderId = orderId || packId;
  let orderInfo = null;
  try {
    const order = await fetchOrderById(accessToken, effectiveOrderId);
    orderInfo = extractOrderInfo(order);
  } catch (err) {
    console.warn(
      `[syncPack] nao consegui buscar detalhes do pedido ${effectiveOrderId}:`,
      err.status,
      err.body || err.message
    );
  }

  await upsertConversationFromPack(sellerId, packId, packData, effectiveOrderId, orderInfo);
}

// Varredura de reconciliacao: olha os pedidos recentes do vendedor e checa
// as mensagens de cada um. Serve de rede de seguranca caso algum webhook se
// perca (ou, com o Render gratuito, enquanto o servico esteve "dormindo" e
// nao recebeu nenhum webhook).
async function reconcileAccount(sellerId) {
  const accessToken = await getValidAccessToken(sellerId);

  const orders = await fetchRecentOrders(accessToken, sellerId, {
    limit: RECENT_ORDERS_LIMIT,
  });
  const recentList = Array.isArray(orders?.results) ? orders.results : [];

  // Busca dedicada: todos os pedidos de "combinar entrega" recentes, sem
  // depender de estarem entre os RECENT_ORDERS_LIMIT pedidos mais recentes
  // no geral (ver comentario acima de RECENT_ORDERS_LIMIT pra entender o
  // problema que isso corrige).
  let noShippingList = [];
  try {
    noShippingList = await fetchAllNoShippingOrders(accessToken, sellerId);
  } catch (err) {
    console.warn(
      `[reconcile] falha ao buscar pedidos de combinar entrega (tags=no_shipping) da conta ${sellerId}:`,
      err.status,
      err.body || err.message
    );
  }

  // Terceira busca dedicada: pedidos com QUALQUER atividade recente (campo
  // date_last_updated), independente de quando foram criados — cobre o
  // caso de um pedido antigo (ja entregue ha tempos, por exemplo) que
  // recebeu uma mensagem nova agora. Ver comentario acima de
  // fetchAllRecentlyUpdatedOrders pra entender os limites dessa abordagem.
  let recentlyUpdatedList = [];
  try {
    recentlyUpdatedList = await fetchAllRecentlyUpdatedOrders(accessToken, sellerId);
  } catch (err) {
    console.warn(
      `[reconcile] falha ao buscar pedidos com atividade recente (date_last_updated) da conta ${sellerId}:`,
      err.status,
      err.body || err.message
    );
  }

  let deliveredList = [];
  try {
    deliveredList = await fetchAllDeliveredOrders(accessToken, sellerId);
  } catch (err) {
    console.warn(
      `[reconcile] falha ao buscar pedidos entregues (tags=delivered) da conta ${sellerId}:`,
      err.status,
      err.body || err.message
    );
  }

  // Junta as quatro listas removendo duplicados (um mesmo pedido pode
  // aparecer em mais de uma busca).
  const seenIds = new Set(recentList.map((o) => o?.id));
  const list = [...recentList];
  for (const order of [...noShippingList, ...recentlyUpdatedList, ...deliveredList]) {
    if (order?.id != null && !seenIds.has(order.id)) {
      seenIds.add(order.id);
      list.push(order);
    }
  }

  console.log(
    `[reconcile] conta ${sellerId}: ${recentList.length} pedido(s) recente(s) (de um total de ${
      orders?.paging?.total ?? "?"
    }) + ${noShippingList.length} de combinar entrega dedicados + ${recentlyUpdatedList.length} com atividade recente dedicados + ${deliveredList.length} entregues dedicados = ${list.length} pedido(s) a verificar.`
  );

  let comMensagens = 0;
  let semContato = 0;
  let cancelados = 0;
  let resolvidosSemContato = 0;
  for (const order of list) {
    // Pedidos que nao fazem parte de um envio combinado nao tem pack_id
    // (vem null) — nesse caso o proprio order_id funciona no lugar.
    const packId = order?.pack_id || order?.id;
    if (!packId) continue;

    // Pedido cancelado (normalmente porque foi reembolsado) nao tem mais
    // entrega nenhuma pra combinar — o usuario pediu pra parar de trazer
    // esses pro painel. Se ja existia uma conversa gravada desse pedido (de
    // antes dessa checagem existir), ela e marcada como 'cancelled' pra
    // sumir das abas Pendentes/Respondidas/Sem contato, sem apagar o
    // historico do banco.
    if (order?.status === "cancelled") {
      cancelados++;
      try {
        await markConversationCancelled(packId);
      } catch (err) {
        console.warn(`[reconcile] falha ao marcar pedido cancelado ${order?.id} (pack ${packId}):`, err.message);
      }
      continue;
    }

    try {
      const packData = await fetchPackMessages(accessToken, packId, sellerId);
      if (Array.isArray(packData?.messages) && packData.messages.length > 0) {
        comMensagens++;

        // So busca o detalhe completo do pedido (produto/comprador/tipo de
        // entrega) pros que realmente tem mensagem — evita gastar chamadas
        // de API a toa nos outros ~50 pedidos que nao tem nada pendente.
        let orderInfo = null;
        try {
          const fullOrder = await fetchOrderById(accessToken, order?.id);
          orderInfo = extractOrderInfo(fullOrder);
        } catch (err) {
          console.warn(
            `[reconcile] nao consegui buscar detalhes do pedido ${order?.id}:`,
            err.status,
            err.body || err.message
          );
        }

        await upsertConversationFromPack(sellerId, packId, packData, order?.id, orderInfo);
      } else {
        // Sem mensagem nenhuma ainda. O usuario pediu pra ver tambem os
        // pedidos de "combinar entrega" nesse estado (tem comprador que
        // compra sem saber que precisa combinar a entrega, e por isso nunca
        // escreve) — /orders/search ja devolve o pedido completo (com
        // "tags"), entao normalmente da pra classificar sem uma chamada
        // extra a API. So busca o pedido completo de novo se "tags" nao
        // vier nessa listagem (defensivo, caso a API mude).
        let orderForInfo = order;
        if (!Array.isArray(order?.tags)) {
          try {
            orderForInfo = await fetchOrderById(accessToken, order?.id);
          } catch (err) {
            console.warn(
              `[reconcile] nao consegui buscar detalhes do pedido ${order?.id} (sem tags na listagem):`,
              err.status,
              err.body || err.message
            );
            orderForInfo = null;
          }
        }
        const orderInfo = orderForInfo ? extractOrderInfo(orderForInfo) : null;
        if (orderInfo?.isCombinarEntrega) {
          if (isAlreadyResolved(orderForInfo)) {
            // Combinar entrega sem nenhuma mensagem, mas que ja foi
            // entregue/concluido sozinho (ex: Mercado Livre fecha a venda
            // automaticamente depois de 28 dias sem reclamacao, ou o
            // comprador confirmou o recebimento por fora) — nao faz
            // sentido pedir "inicie o contato" pra um pedido que ja
            // acabou. Se por algum motivo ja tinha entrado como
            // "no_contact" antes dessa checagem existir, tira das abas.
            resolvidosSemContato++;
            await markConversationResolved(packId);
          } else {
            semContato++;
            await upsertNoContactOrder(sellerId, packId, order, orderInfo);
          }
        }
      }
    } catch (err) {
      console.warn(
        `[reconcile] falha ao checar mensagens do pedido ${order?.id} (pack ${packId}):`,
        err.status,
        err.body || err.message
      );
    }
  }

  console.log(
    `[reconcile] conta ${sellerId}: ${comMensagens} pedido(s) com mensagens, ${semContato} combinar-entrega sem contato ainda, ${cancelados} cancelado(s) ignorado(s), ${resolvidosSemContato} ja entregue(s)/concluido(s) sem contato ignorado(s).`
  );
}

// Uma venda "combinar entrega" que ja foi entregue/concluida sozinha (sem
// nunca precisar de mensagem) nao tem mais nada pra "combinar" — o
// vendedor pediu pra essas so aparecerem no painel se o comprador de fato
// mandar uma mensagem, e nao ficarem poluindo a aba "Sem contato" so
// porque tecnicamente sao combinar entrega. A tag "delivered" e o sinal
// que o Mercado Livre usa tanto pra confirmacao manual de entrega quanto
// pro fechamento automatico da venda apos ~28 dias sem reclamacao.
function isAlreadyResolved(order) {
  const tags = Array.isArray(order?.tags) ? order.tags : [];
  return tags.includes("delivered");
}

// Marca uma conversa como 'cancelled' se ela ja existir no banco (pedido
// cancelado/reembolsado) — assim ela some das abas ativas do painel sem
// perder o historico. Se a conversa nunca foi gravada, nao faz nada (nao
// tem motivo pra criar uma conversa nova so pra marcar como cancelada).
async function markConversationCancelled(packId) {
  await db.query(
    `UPDATE conversations SET status = 'cancelled', updated_at = now()
     WHERE pack_id = $1 AND status <> 'cancelled'`,
    [String(packId)]
  );
}

// Mesma ideia de markConversationCancelled, mas so mexe em conversas que
// estavam como 'no_contact' — um pedido que ja tem mensagem de verdade
// (pending/answered) nunca deveria ser tocado por essa checagem.
async function markConversationResolved(packId) {
  await db.query(
    `UPDATE conversations SET status = 'resolved', updated_at = now()
     WHERE pack_id = $1 AND status = 'no_contact'`,
    [String(packId)]
  );
}

async function reconcileAllAccounts() {
  const { rows: accounts } = await db.query("SELECT id FROM accounts");
  console.log(
    `[reconcile] contas conectadas no banco:`,
    accounts.map((a) => a.id)
  );
  for (const acc of accounts) {
    try {
      await reconcileAccount(acc.id);
    } catch (err) {
      console.error(`[reconcile] falha na conta ${acc.id}:`, err.message);
    }
  }
}

module.exports = {
  syncPack,
  reconcileAccount,
  reconcileAllAccounts,
  upsertConversationFromPack,
  upsertNoContactOrder,
  extractOrderInfo,
};
