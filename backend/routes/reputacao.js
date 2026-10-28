// Reputacao + desempenho de envios + Full (sem cookie).
//
// FASE 1 — so a sonda. Antes de construir as telas, confirmar contra a API
// real o que a aplicacao do ML consegue ler (pedido do usuario em 13/10):
//   1. Reputacao: /users/{id} -> seller_reputation (termometro, MercadoLider,
//      reclamacoes, atrasos no envio, canceladas).
//   2. Desempenho de envios: o que o ML informa + o que o proprio painel ja
//      grava em prazos_envios (cada pacote, impressao, saida, atraso).
//   3. Full sem cookie: o "Dash FUll" antigo lia os envios ao Full pela API
//      interna do site com o cookie da sessao (quebra quando expira). Aqui
//      testamos o caminho oficial: estoque Full por inventory_id e as
//      movimentacoes (/stock/fulfillment/operations/search), onde as
//      recepcoes de envio no armazem devem aparecer.
//   4. Notas fiscais do emissor do ML (a NF de remessa ao Full e emitida
//      pelo proprio ML): se legiveis, dao o "o que foi enviado".
//
// Uso: /api/debug/probe-reputacao-full  (todas as contas)
//      /api/debug/probe-reputacao-full?sellerId=522101670  (uma conta)

const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");

const API_BASE = "https://api.mercadolibre.com";
const router = express.Router();
router.use(requireLogin);

// Chamada crua: status + corpo mesmo em erro (403/404 tambem sao resposta).
async function rawGet(path, token) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 400);
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: "erro", body: err.message };
  }
}

// Resumo curto de uma resposta grande (para o JSON da sonda caber na tela).
const amostra = (r, fn) => (r.status === 200 ? { status: 200, ...fn(r.body) } : r);

// Procura um id de envio ao Full (inbound) em qualquer formato: chave
// "inbound_id": 123 ou par { type: "inbound_id", value: "123" }.
function acharInboundId(obj, prof = 0) {
  if (!obj || typeof obj !== "object" || prof > 6) return null;
  if (/inbound/i.test(String(obj.type || obj.key || "")) && obj.value != null) return String(obj.value);
  for (const [k, v] of Object.entries(obj)) {
    if (/inbound/i.test(k) && (typeof v === "string" || typeof v === "number")) return String(v);
    const achou = acharInboundId(v, prof + 1);
    if (achou) return achou;
  }
  return null;
}

function diasAtras(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

router.get("/debug/probe-reputacao-full", async (req, res) => {
  const { rows: accounts } = req.query.sellerId
    ? await db.query("SELECT id, nickname FROM accounts WHERE id = $1", [String(req.query.sellerId)])
    : await db.query("SELECT id, nickname FROM accounts ORDER BY nickname");

  const relatorio = { geradoEm: new Date().toISOString(), contas: [] };

  for (const acc of accounts) {
    const sellerId = String(acc.id);
    const conta = { sellerId, nickname: acc.nickname };
    relatorio.contas.push(conta);
    let token;
    try {
      token = await getValidAccessToken(sellerId);
    } catch (err) {
      conta.erroToken = err.message;
      continue;
    }

    // 1) Reputacao (termometro completo).
    const user = await rawGet(`/users/${sellerId}`, token);
    conta.reputacao = amostra(user, (b) => ({
      seller_reputation: b.seller_reputation,
      status: b.status,
      tags: b.tags,
    }));

    // 2) Desempenho de envios: candidatos de endpoint dedicado (exploratorio —
    //    404 aqui so significa que nao existe para esta aplicacao).
    conta.desempenhoEnviosApi = {};
    for (const p of [
      `/users/${sellerId}/reputation`,
      `/users/${sellerId}/shipping/performance`,
      `/shipping/sellers/${sellerId}/performance`,
    ]) {
      conta.desempenhoEnviosApi[p] = await rawGet(p, token);
    }

    // 2b) Desempenho de envios pelo que o PAINEL ja grava (ultimos 60 dias).
    try {
      const { rows } = await db.query(
        `SELECT modalidade,
                count(*) FILTER (WHERE status_final IS DISTINCT FROM 'cancelled')::int AS pacotes,
                count(*) FILTER (WHERE atrasou)::int AS atrasaram,
                count(*) FILTER (WHERE impresso_em IS NOT NULL AND impresso_em <= limite_impressao)::int AS impressos_no_limite,
                min(dia_prazo)::text AS desde
           FROM prazos_envios
          WHERE seller_id = $1 AND dia_prazo >= (now() - interval '60 days')::date
          GROUP BY modalidade`,
        [sellerId]
      );
      conta.desempenhoEnviosPainel = rows;
    } catch (err) {
      conta.desempenhoEnviosPainel = { erro: err.message };
    }

    // 3) Full: descobrir anuncios do Full e o inventory_id deles.
    const itensFull = await rawGet(
      `/users/${sellerId}/items/search?logistic_type=fulfillment&status=active&limit=5`,
      token
    );
    conta.full = {
      itensBusca: amostra(itensFull, (b) => ({ total: b.paging?.total, ids: b.results })),
    };
    let itemIds = itensFull.status === 200 ? itensFull.body?.results || [] : [];

    // Plano B para achar anuncios do Full: pedidos que estao no armazem.
    if (!itemIds.length) {
      const ped = await rawGet(
        `/orders/search?seller=${sellerId}&shipping.status=ready_to_ship&shipping.substatus=in_warehouse&sort=date_desc&limit=5`,
        token
      );
      itemIds = [...new Set((ped.body?.results || []).flatMap((o) => (o.order_items || []).map((it) => it.item?.id)).filter(Boolean))];
      conta.full.itensPorPedidos = { status: ped.status, ids: itemIds };
    }

    // inventory_id: multiget e item avulso (o /items ja foi bloqueado por
    // PolicyAgent nas Perguntas — testar os dois jeitos).
    let inventoryIds = [];
    if (itemIds.length) {
      const multi = await rawGet(`/items?ids=${itemIds.slice(0, 5).join(",")}&attributes=id,title,inventory_id,variations`, token);
      conta.full.itensMultiget = amostra(multi, (b) => ({
        itens: (Array.isArray(b) ? b : []).map((x) => ({
          code: x.code,
          id: x.body?.id,
          title: x.body?.title,
          inventory_id: x.body?.inventory_id,
          variacoes_inventory: (x.body?.variations || []).map((v) => v.inventory_id).filter(Boolean),
          erro: x.code !== 200 ? x.body : undefined,
        })),
      }));
      if (multi.status === 200 && Array.isArray(multi.body)) {
        for (const x of multi.body) {
          if (x.body?.inventory_id) inventoryIds.push(x.body.inventory_id);
          for (const v of x.body?.variations || []) if (v.inventory_id) inventoryIds.push(v.inventory_id);
        }
      }
      const avulso = await rawGet(`/items/${itemIds[0]}?attributes=id,inventory_id,variations`, token);
      conta.full.itemAvulso = amostra(avulso, (b) => ({ id: b.id, inventory_id: b.inventory_id }));
      if (avulso.status === 200 && avulso.body?.inventory_id) inventoryIds.push(avulso.body.inventory_id);
    }
    inventoryIds = [...new Set(inventoryIds)];
    conta.full.inventoryIds = inventoryIds;

    // Estoque Full + movimentacoes (30 dias) do primeiro inventory_id.
    if (inventoryIds.length) {
      const inv = inventoryIds[0];
      conta.full.estoque = await rawGet(`/inventories/${inv}/stock/fulfillment`, token);
      const ops = await rawGet(
        `/stock/fulfillment/operations/search?seller_id=${sellerId}&inventory_id=${inv}&date_from=${diasAtras(30).slice(0, 10)}&date_to=${new Date().toISOString().slice(0, 10)}&limit=50`,
        token
      );
      conta.full.operacoes = amostra(ops, (b) => {
        const lista = b.results || b.operations || [];
        const porTipo = {};
        for (const o of lista) porTipo[o.type] = (porTipo[o.type] || 0) + 1;
        return {
          total: b.paging?.total ?? lista.length,
          porTipo,
          // Recepcoes de envio ao Full (o que chegou no armazem) — amostra crua.
          recepcoes: lista.filter((o) => /inbound|reception/i.test(o.type || "")).slice(0, 5),
          exemplo: lista[0] || null,
        };
      });
    }
    // Movimentacoes sem inventory_id (se for aceito, da para varrer a conta toda).
    conta.full.operacoesSemInventory = amostra(
      await rawGet(
        `/stock/fulfillment/operations/search?seller_id=${sellerId}&date_from=${diasAtras(7).slice(0, 10)}&date_to=${new Date().toISOString().slice(0, 10)}&limit=5`,
        token
      ),
      (b) => ({ total: b.paging?.total, tipos: (b.results || []).map((o) => o.type) })
    );

    // Envios ao Full por endpoint oficial (exploratorio).
    conta.full.inboundsApi = {};
    for (const p of [`/inbounds/search?seller_id=${sellerId}&limit=5`, `/fbm/inbounds/search?seller_id=${sellerId}&limit=5`]) {
      conta.full.inboundsApi[p] = await rawGet(p, token);
    }

    // 4) Notas fiscais emitidas pelo PROPRIO Mercado Livre (usuario, 13/10:
    //    "a NF [de remessa ao Full] e emitida pelo Mercado Livre"). Se a
    //    aplicacao ler essas notas, o "o que foi enviado ao Full" (itens e
    //    quantidades) sai daqui — sem cookie e sem Tiny. Endpoints do emissor
    //    de notas do ML nao confirmados: varios candidatos, 404/403 tambem
    //    e resposta.
    conta.notasFiscais = {};
    const ultimo = await rawGet(`/orders/search?seller=${sellerId}&sort=date_desc&limit=1`, token);
    const pedido = ultimo.body?.results?.[0];
    const orderId = pedido?.id;
    const shipmentId = pedido?.shipping?.id;
    // inbound_id que aparecer nas recepcoes do estoque Full (se aparecer).
    const inboundId = acharInboundId(conta.full.operacoes?.recepcoes || conta.full.operacoes?.exemplo);
    conta.notasFiscais.referencias = { orderId: orderId || null, shipmentId: shipmentId || null, inboundIdDasRecepcoes: inboundId };
    const candidatos = [
      orderId && `/users/${sellerId}/invoices/orders/${orderId}`,
      shipmentId && `/users/${sellerId}/invoices/shipments/${shipmentId}`,
      `/users/${sellerId}/invoices/search?limit=5`,
      `/users/${sellerId}/invoices/sites/MLB/search?limit=5`,
      `/users/${sellerId}/invoices/inbounds/search?limit=5`,
      inboundId && `/users/${sellerId}/invoices/inbounds/${inboundId}`,
      inboundId && `/inbounds/${inboundId}`,
    ].filter(Boolean);
    for (const p of candidatos) {
      const r = await rawGet(p, token);
      // Nota pode ser grande (XML/itens): guarda so o comeco para caber na tela.
      conta.notasFiscais[p] = r.status === 200 ? { status: 200, chaves: Object.keys(r.body || {}), amostra: JSON.stringify(r.body).slice(0, 1500) } : r;
    }
  }

  res.json(relatorio);
});

module.exports = router;
