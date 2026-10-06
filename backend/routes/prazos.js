// Monitor de prazos de despacho (coleta / agencia / Flex).
//
// FASE 1 — so a sonda de diagnostico. Antes de construir o painel de prazos,
// precisamos confirmar contra a API real tres coisas que a documentacao
// publica nao deixa claras:
//   1. se a janela de coleta/agencia/Flex configurada no Mercado Livre pode
//      ser lida pela API (endpoint de "schedule" — nome nao confirmado);
//   2. qual campo traz o prazo de despacho de cada envio (/sla, /lead_time
//      ou dentro do proprio /shipments) e se bate com o site do ML;
//   3. se o filtro "a imprimir" (substatus ready_to_print) funciona na busca
//      de pedidos — e o que vai alimentar o alerta de "nao impresso".
//
// Uso: abrir no navegador (ja logado no painel) /api/debug/probe-prazos
// Opcional: ?sellerId=... (uma conta so) e ?limit=N (envios por conta, max 15).

const express = require("express");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");
const { fetchRecentOrders } = require("../ml/api");

const API_BASE = "https://api.mercadolibre.com";
const router = express.Router();
router.use(requireLogin);

// Chamada crua: devolve status + corpo mesmo em erro (numa sonda o 404/403
// e tao informativo quanto o 200 — mlFetch lancaria excecao e perderiamos
// o corpo da resposta).
async function rawGet(path, accessToken, extraHeaders = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        ...extraHeaders,
      },
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 500);
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: "erro", body: err.message };
  }
}

const LOGISTIC_TYPES = ["cross_docking", "drop_off", "xd_drop_off", "self_service"];

router.get("/debug/probe-prazos", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 6, 15);
  const { rows: accounts } = req.query.sellerId
    ? await db.query("SELECT id, nickname FROM accounts WHERE id = $1", [req.query.sellerId])
    : await db.query("SELECT id, nickname FROM accounts");

  const report = {
    horaServidor: new Date().toISOString(),
    fusoServidor: Intl.DateTimeFormat().resolvedOptions().timeZone,
    contas: [],
  };

  for (const acc of accounts) {
    const sellerId = acc.id;
    const entry = { sellerId, nickname: acc.nickname };
    report.contas.push(entry);

    let accessToken;
    try {
      accessToken = await getValidAccessToken(sellerId);
    } catch (err) {
      entry.erroToken = err.message;
      continue;
    }

    // 1) Janelas configuradas (coleta/agencia/Flex). Variantes de endpoint
    //    testadas lado a lado — so uma (ou nenhuma) deve responder 200.
    entry.janelas = {};
    entry.janelas.shipping_preferences = await rawGet(
      `/users/${sellerId}/shipping_preferences`,
      accessToken
    );
    for (const lt of LOGISTIC_TYPES) {
      entry.janelas[`schedule_${lt}`] = await rawGet(
        `/users/${sellerId}/shipping/schedule/${lt}`,
        accessToken
      );
    }

    // 2) Filtros da busca de pedidos: quantos ha em cada recorte. O
    //    paging.total diz se o filtro foi reconhecido (um filtro ignorado
    //    devolve o mesmo total que a busca sem filtro).
    const base = `seller=${sellerId}&limit=1`;
    entry.filtros = {};
    for (const [nome, qs] of Object.entries({
      semFiltro: "",
      ready_to_ship: "&shipping.status=ready_to_ship",
      a_imprimir: "&shipping.status=ready_to_ship&shipping.substatus=ready_to_print",
      impresso: "&shipping.status=ready_to_ship&shipping.substatus=printed",
      atrasado_tag: "&tags=delayed",
    })) {
      const r = await rawGet(`/orders/search?${base}${qs}`, accessToken);
      entry.filtros[nome] =
        r.status === 200 ? { total: r.body?.paging?.total } : { status: r.status, body: r.body };
    }

    // 3) Amostra de envios ainda nao despachados: tudo que pode carregar o
    //    prazo, pra comparar com o que o site do ML mostra pra mesma venda.
    entry.envios = [];
    let orders = [];
    try {
      const r = await rawGet(
        `/orders/search?seller=${sellerId}&shipping.status=ready_to_ship&sort=date_desc&limit=${limit}`,
        accessToken
      );
      orders = r.status === 200 ? r.body?.results || [] : [];
      if (r.status !== 200) entry.erroBuscaReadyToShip = r;
    } catch (err) {
      entry.erroBuscaReadyToShip = err.message;
    }
    // Plano B: se o filtro shipping.status nao existir, pega os mais recentes.
    if (!orders.length) {
      try {
        const r = await fetchRecentOrders(accessToken, sellerId, { limit });
        orders = r?.results || [];
        entry.amostraSemFiltro = true;
      } catch (err) {
        entry.erroBuscaRecentes = err.message;
      }
    }

    for (const order of orders) {
      const shipId = order?.shipping?.id;
      const envio = {
        order_id: order.id,
        pack_id: order.pack_id || null,
        date_created: order.date_created,
        date_closed: order.date_closed,
        order_tags: order.tags,
        shipping_id: shipId || null,
      };
      entry.envios.push(envio);
      if (!shipId) continue;

      const ship = await rawGet(`/shipments/${shipId}`, accessToken, { "x-format-new": "true" });
      if (ship.status === 200) {
        const s = ship.body || {};
        envio.shipment = {
          logistic_type: s.logistic?.type ?? s.logistic_type,
          mode: s.logistic?.mode ?? s.mode,
          status: s.status,
          substatus: s.substatus,
          tags: s.tags,
          // Campos candidatos ao prazo de despacho:
          lead_time: s.lead_time ?? null,
          shipping_option: s.shipping_option ?? null,
          status_history: s.status_history ?? null,
          date_created: s.date_created,
          last_updated: s.last_updated,
        };
      } else {
        envio.shipment = ship;
      }

      envio.sla = await rawGet(`/shipments/${shipId}/sla`, accessToken);
      envio.lead_time = await rawGet(`/shipments/${shipId}/lead_time`, accessToken);
    }
  }

  res.json(report);
});

module.exports = router;
