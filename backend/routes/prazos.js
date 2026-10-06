// Monitor de prazos de despacho (coleta / agencia / Flex).
// Rotas: GET /api/prazos, POST /api/prazos/atualizar, PUT /api/prazos/config,
// GET /api/prazos/calendario e /api/prazos/dia (historico)
// (fase 2, mais abaixo) e a sonda /api/debug/probe-prazos (fase 1).
//
// FASE 1 — sonda de diagnostico. Antes de construir o painel de prazos,
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


// ===========================================================================
// FASE 2 — coletor + API do painel de prazos.
//
// O que a sonda confirmou (contas reais, 06/10/2026):
//   - GET /users/{id}/shipping/schedule/{logistic_type} devolve a janela por
//     dia da semana: cross_docking (coleta) traz from/to/cutoff; xd_drop_off
//     (agencia) traz so from (horario limite de entrega) e cutoff. Flex
//     (self_service) NAO tem schedule (404) -> horario limite e configurado
//     no proprio painel.
//   - GET /shipments/{id}/sla -> { status: "on_time"|"delayed"|..., expected_date }
//     e o prazo de despacho (agencia: 16:30, bate com o schedule). No Flex o
//     expected_date e 23:00 = prazo de ENTREGA, nao serve de limite de
//     impressao. Full (fulfillment) da 404 ou vazio — nao entra aqui.
//   - orders/search aceita shipping.status=ready_to_ship +
//     shipping.substatus=ready_to_print|printed (os totais mudam com o filtro).
//
// O estado fica em memoria (recalculado a cada ciclo). A unica coisa gravada
// no banco e a configuracao (margens / horario do Flex).
// ===========================================================================

const { fetchShipment, fetchResource } = require("../ml/api");

// mlFetch nao e exportado por ml/api.js; fetchResource e o mesmo mlFetch.
const mlGet = (path, token) => fetchResource(token, path);

const CICLO_MS = 3 * 60 * 1000;
const SLA_TTL_MS = 10 * 60 * 1000;

// Modalidades exibidas. Full (fulfillment) fica de fora: quem despacha e o ML.
const MODALIDADE = {
  cross_docking: "coleta",
  drop_off: "agencia",
  xd_drop_off: "agencia",
  self_service: "flex",
};

const CONFIG_PADRAO = {
  // Coleta: limite de impressao = FIM da janela de coleta - margem
  // (regra do usuario: janela ate 14:45 -> tudo impresso ate 14:00).
  coleta: { margemMin: 45 },
  // Agencia: limite = horario de entrega na agencia - margem (tempo de
  // separar, embalar e levar).
  agencia: { margemMin: 60 },
  // Flex: o ML nao informa janela; limite fixo do dia (saida da rota).
  flex: { limite: "13:00" },
  // Quanto tempo antes do limite o pedido nao impresso vira "em risco".
  avisoMin: 60,
};

// --- Horario de Sao Paulo ---------------------------------------------------
// O servidor roda em UTC (confirmado na sonda). O Brasil nao tem horario de
// verao desde 2019, entao Sao Paulo e sempre -03:00.
const TZ = "America/Sao_Paulo";
const OFFSET_SP = "-03:00";

function partesSP(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return {
    dia: `${p.year}-${p.month}-${p.day}`,
    semana: p.weekday.toLowerCase(),
    hora: `${p.hour}:${p.minute}`,
  };
}

function horaSP(dia, hhmm) {
  return new Date(`${dia}T${hhmm}:00${OFFSET_SP}`);
}

const menosMin = (d, min) => new Date(d.getTime() - min * 60000);

// --- Configuracao (tabela propria, criada sob demanda) ----------------------
let configCache = null;

function mesclarConfig(salva) {
  const c = JSON.parse(JSON.stringify(CONFIG_PADRAO));
  if (!salva) return c;
  const num = (v, min, max) =>
    v !== "" && v != null && Number.isFinite(+v) ? Math.min(Math.max(+v, min), max) : undefined;
  c.coleta.margemMin = num(salva.coleta?.margemMin, 0, 600) ?? c.coleta.margemMin;
  c.agencia.margemMin = num(salva.agencia?.margemMin, 0, 600) ?? c.agencia.margemMin;
  if (/^\d{2}:\d{2}$/.test(salva.flex?.limite || "")) c.flex.limite = salva.flex.limite;
  c.avisoMin = num(salva.avisoMin, 5, 600) ?? c.avisoMin;
  return c;
}

async function lerConfig() {
  if (configCache) return configCache;
  try {
    await db.query(
      "CREATE TABLE IF NOT EXISTS prazos_config (id INTEGER PRIMARY KEY, data JSONB NOT NULL)"
    );
    const { rows } = await db.query("SELECT data FROM prazos_config WHERE id = 1");
    configCache = mesclarConfig(rows[0]?.data);
  } catch (err) {
    console.error("[prazos] falha ao ler config, usando padrao:", err.message);
    return mesclarConfig(null);
  }
  return configCache;
}

async function salvarConfig(nova) {
  const c = mesclarConfig(nova);
  await lerConfig(); // garante a tabela
  await db.query(
    `INSERT INTO prazos_config (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [JSON.stringify(c)]
  );
  configCache = c;
  return c;
}

// --- Coleta de dados no Mercado Livre ---------------------------------------
const cacheEnvio = new Map(); // shipping_id -> { logistic_type }
const cacheSla = new Map(); // shipping_id -> { status, expected_date, em }
const cacheJanelas = new Map(); // `${seller}:${lt}` -> { dia, schedule }

let estado = { atualizadoEm: null, emAndamento: false, contas: [], envios: [], erros: [] };
let cicloAtual = null;

async function emLotes(itens, n, fn) {
  const out = [];
  for (let i = 0; i < itens.length; i += n) {
    out.push(...(await Promise.all(itens.slice(i, i + n).map(fn))));
  }
  return out;
}

async function janelasDaConta(sellerId, token, hojeSP) {
  const janelas = {};
  for (const lt of ["cross_docking", "xd_drop_off", "drop_off"]) {
    const chave = `${sellerId}:${lt}`;
    const c = cacheJanelas.get(chave);
    if (c && c.dia === hojeSP) {
      if (c.schedule) janelas[lt] = c.schedule;
      continue;
    }
    let schedule = null;
    try {
      const r = await mlGet(`/users/${sellerId}/shipping/schedule/${lt}`, token);
      schedule = r?.schedule || null;
    } catch (err) {
      if (err.status !== 404) throw err; // 404 = conta nao usa essa modalidade
    }
    cacheJanelas.set(chave, { dia: hojeSP, schedule });
    if (schedule) janelas[lt] = schedule;
  }
  return janelas;
}

async function buscarPedidos(sellerId, token, substatus) {
  const pedidos = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const r = await mlGet(
      `/orders/search?seller=${sellerId}&shipping.status=ready_to_ship` +
        `&shipping.substatus=${substatus}&sort=date_asc&limit=50&offset=${offset}`,
      token
    );
    pedidos.push(...(r?.results || []));
    if (offset + 50 >= (r?.paging?.total || 0)) break;
  }
  return pedidos;
}

async function tipoLogistico(shipId, token) {
  if (cacheEnvio.has(shipId)) return cacheEnvio.get(shipId);
  const s = await fetchShipment(token, shipId);
  const info = { logistic_type: s?.logistic_type ?? s?.logistic?.type ?? null };
  cacheEnvio.set(shipId, info);
  return info;
}

async function slaDoEnvio(shipId, token) {
  const c = cacheSla.get(shipId);
  if (c && Date.now() - c.em < SLA_TTL_MS) return c;
  let sla = { status: null, expected_date: null, em: Date.now() };
  try {
    const r = await mlGet(`/shipments/${shipId}/sla`, token);
    sla = { status: r?.status || null, expected_date: r?.expected_date || null, em: Date.now() };
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  cacheSla.set(shipId, sla);
  return sla;
}

// Limite de impressao de um envio, a partir do prazo de despacho (SLA) e da
// janela configurada no ML para aquele dia da semana.
// Devolve tambem o prazoEfetivo de despacho: na COLETA o SLA do ML traz o
// INICIO da janela (ex.: 11:45), mas o motorista pode passar ate o FIM
// (13:45) — so e atraso depois disso (relatado pelo usuario em 06/10).
function calcularLimite({ modalidade, logisticType, prazo, janelas, config }) {
  if (!prazo) return { limite: null, janela: null, prazoEfetivo: null };
  const { dia, semana } = partesSP(prazo);

  if (modalidade === "flex") {
    return { limite: horaSP(dia, config.flex.limite), janela: { ate: config.flex.limite }, prazoEfetivo: prazo };
  }

  const det = janelas[logisticType]?.[semana]?.detail?.[0] || null;
  const janela = det ? { de: det.from || null, ate: det.to || null, corte: det.cutoff || null } : null;

  if (modalidade === "coleta") {
    // Fim da janela de coleta; sem janela, o proprio prazo do SLA.
    let fim = det?.to ? horaSP(dia, det.to) : prazo;
    if (fim < prazo) fim = prazo; // janela mudou/estranha: nunca antes do SLA
    return { limite: menosMin(fim, config.coleta.margemMin), janela, prazoEfetivo: fim };
  }
  // Agencia: o schedule so traz "from" (= horario de entrega, igual ao SLA).
  const entrega = det?.from ? horaSP(dia, det.from) : prazo;
  return { limite: menosMin(entrega, config.agencia.margemMin), janela, prazoEfetivo: prazo };
}

function classificar({ impresso, prazo, limite, slaStatus, agora, hojeSP, avisoMin }) {
  // O prazo (efetivo) manda; o "delayed" do ML so conta quando nao ha prazo
  // — senao a coleta viraria atrasada no inicio da janela.
  if (prazo ? agora > prazo : slaStatus === "delayed") return "atrasado";
  if (prazo && partesSP(prazo).dia > hojeSP) return "proximos";
  if (impresso) return "impresso";
  if (!limite) return "sem_prazo";
  if (agora > limite) return "estourou";
  if (agora > menosMin(limite, avisoMin)) return "risco";
  return "no_prazo";
}

function resumoJanelas(janelas, semana) {
  const out = {};
  for (const [lt, sched] of Object.entries(janelas)) {
    const d = sched?.[semana];
    out[lt] =
      d?.work && d.detail?.[0]
        ? { de: d.detail[0].from || null, ate: d.detail[0].to || null, corte: d.detail[0].cutoff || null }
        : null; // nao trabalha hoje
  }
  return out;
}

// Grade da semana (igual a tela "Coletas" do ML): por modalidade, cada dia
// com janela, horario de corte e se ja passou.
const DIAS_SEMANA = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
function semanaJanelas(janelas) {
  const out = {};
  for (const [lt, sched] of Object.entries(janelas)) {
    out[lt] = DIAS_SEMANA.map((dia) => {
      const d = sched?.[dia];
      const det = d?.detail?.[0];
      return {
        dia,
        trabalha: !!(d?.work && det),
        passou: !!d?.is_past,
        de: det?.from || null,
        ate: det?.to || null,
        corte: det?.cutoff || null,
      };
    });
  }
  return out;
}

async function coletarConta(acc, config, agora, hojeSP) {
  const sellerId = String(acc.id);
  const token = await getValidAccessToken(sellerId);
  const janelas = await janelasDaConta(sellerId, token, hojeSP);

  // Substatus que ainda estao no CD (confirmado com /debug/probe-prazos-conta
  // em 06/10): invoice_pending = falta a nota fiscal, o ML nem libera a
  // etiqueta (contas com NF obrigatoria); ready_for_pickup = impresso e
  // esperando o motorista da coleta. picked_up/dropped_off/in_hub ja sairam.
  const [aImprimir, nfPendente, impressos, prontosColeta] = await Promise.all([
    buscarPedidos(sellerId, token, "ready_to_print"),
    buscarPedidos(sellerId, token, "invoice_pending"),
    buscarPedidos(sellerId, token, "printed"),
    buscarPedidos(sellerId, token, "ready_for_pickup"),
  ]);

  // Pedidos de um mesmo carrinho (pack) dividem o mesmo envio.
  const porEnvio = new Map();
  for (const [lista, impresso, nf] of [
    [aImprimir, false, false],
    [nfPendente, false, true],
    [impressos, true, false],
    [prontosColeta, true, false],
  ]) {
    for (const o of lista) {
      const shipId = o?.shipping?.id;
      if (!shipId) continue;
      if (!porEnvio.has(shipId)) porEnvio.set(shipId, { shipId, impresso, nfPendente: nf, pedidos: [] });
      porEnvio.get(shipId).pedidos.push(o);
    }
  }

  const envios = await emLotes([...porEnvio.values()], 5, async (e) => {
    const { logistic_type } = await tipoLogistico(e.shipId, token);
    const modalidade = MODALIDADE[logistic_type];
    if (!modalidade) return null; // Full ou modalidade desconhecida
    const sla = await slaDoEnvio(e.shipId, token);
    const prazoSla = sla.expected_date ? new Date(sla.expected_date) : null;
    const { limite, janela, prazoEfetivo: prazo } = calcularLimite({
      modalidade,
      logisticType: logistic_type,
      prazo: prazoSla,
      janelas,
      config,
    });
    const o = e.pedidos[0];
    return {
      sellerId,
      conta: acc.nickname,
      shippingId: e.shipId,
      venda: String(o.pack_id || o.id),
      pedidos: e.pedidos.map((p) => String(p.id)),
      comprador: o.buyer?.nickname || null,
      itens: e.pedidos.flatMap((p) =>
        (p.order_items || []).map((it) => ({ titulo: it.item?.title, qtd: it.quantity }))
      ),
      criadoEm: o.date_created,
      modalidade,
      logisticType: logistic_type,
      impresso: e.impresso,
      nfPendente: e.nfPendente,
      slaStatus: sla.status,
      prazo: prazo ? prazo.toISOString() : null,
      prazoSla: prazoSla ? prazoSla.toISOString() : null,
      limiteImpressao: limite ? limite.toISOString() : null,
      janela,
      situacao: classificar({
        impresso: e.impresso,
        prazo,
        limite,
        slaStatus: sla.status,
        agora,
        hojeSP,
        avisoMin: config.avisoMin,
      }),
    };
  });

  return {
    conta: {
      sellerId,
      nickname: acc.nickname,
      janelasHoje: resumoJanelas(janelas, partesSP(agora).semana),
      semana: semanaJanelas(janelas),
    },
    envios: envios.filter(Boolean),
  };
}

// --- Historico (calendario) -------------------------------------------------
// A API do ML so mostra o que ainda esta "pronto para enviar": o que foi
// despachado ontem some. Para poder voltar num dia e ver o que foi impresso,
// cada ciclo grava os envios em prazos_envios:
//   - impresso_em: primeiro ciclo em que o envio apareceu como "impresso"
//     (precisao de ~3 min). impresso_estimado=true quando ja chegou impresso
//     no primeiro ciclo (ou saiu despachado sem nunca ter sido visto impresso).
//   - atrasou: em algum ciclo ficou pendente depois do prazo de despacho.
//   - saiu_em / status_final: quando deixou a lista e por que (shipped,
//     cancelled...), conferido no /shipments.
// O historico comeca no dia em que esta versao foi publicada.
let tabelaHistorico = null;

function garantirTabelaHistorico() {
  if (!tabelaHistorico) {
    tabelaHistorico = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS prazos_envios (
          shipping_id TEXT PRIMARY KEY,
          seller_id TEXT NOT NULL,
          conta TEXT,
          venda TEXT,
          comprador TEXT,
          itens JSONB,
          modalidade TEXT,
          prazo TIMESTAMPTZ,
          limite_impressao TIMESTAMPTZ,
          dia_prazo DATE,
          sla_status TEXT,
          impresso BOOLEAN NOT NULL DEFAULT false,
          impresso_em TIMESTAMPTZ,
          impresso_estimado BOOLEAN NOT NULL DEFAULT false,
          atrasou BOOLEAN NOT NULL DEFAULT false,
          visto_em TIMESTAMPTZ NOT NULL,
          ultimo_visto TIMESTAMPTZ NOT NULL,
          saiu_em TIMESTAMPTZ,
          status_final TEXT
        )`);
      await db.query("CREATE INDEX IF NOT EXISTS prazos_envios_dia_idx ON prazos_envios (dia_prazo)");
      // Teve NF pendente em algum momento (motivo de atraso no relatorio).
      await db.query("ALTER TABLE prazos_envios ADD COLUMN IF NOT EXISTS nf_pendente BOOLEAN NOT NULL DEFAULT false");
      // Correcao unica: ate 06/10/2026 a coleta usava o INICIO da janela como
      // prazo e marcava "atrasou" quem saiu dentro da janela. Todas as janelas
      // observadas tem 2h; o que saiu ate 2h depois desse prazo nao atrasou.
      await db.query(
        `UPDATE prazos_envios SET atrasou = false
          WHERE modalidade = 'coleta' AND atrasou AND dia_prazo <= '2026-10-06'
            AND saiu_em IS NOT NULL AND saiu_em <= prazo + interval '2 hours'`
      );
    })().catch((err) => {
      tabelaHistorico = null;
      throw err;
    });
  }
  return tabelaHistorico;
}

const COLUNAS_HIST = [
  "shipping_id", "seller_id", "conta", "venda", "comprador", "itens", "modalidade", "prazo",
  "limite_impressao", "dia_prazo", "sla_status", "impresso", "impresso_em", "impresso_estimado",
  "atrasou", "visto_em", "ultimo_visto", "nf_pendente",
];

async function gravarHistorico(envios, contasOk, agora) {
  await garantirTabelaHistorico();

  for (let i = 0; i < envios.length; i += 100) {
    const lote = envios.slice(i, i + 100);
    const params = [];
    const linhas = lote.map((e) => {
      const valores = [
        String(e.shippingId), e.sellerId, e.conta, e.venda, e.comprador, JSON.stringify(e.itens),
        e.modalidade, e.prazo, e.limiteImpressao, e.prazo ? partesSP(new Date(e.prazo)).dia : null,
        e.slaStatus, e.impresso, e.impresso ? agora : null, e.impresso,
        e.situacao === "atrasado", agora, agora, !!e.nfPendente,
      ];
      const ph = valores.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(",")})`;
    });
    await db.query(
      `INSERT INTO prazos_envios (${COLUNAS_HIST.join(",")}) VALUES ${linhas.join(",")}
       ON CONFLICT (shipping_id) DO UPDATE SET
         conta = EXCLUDED.conta,
         comprador = EXCLUDED.comprador,
         itens = EXCLUDED.itens,
         modalidade = EXCLUDED.modalidade,
         prazo = EXCLUDED.prazo,
         limite_impressao = EXCLUDED.limite_impressao,
         dia_prazo = EXCLUDED.dia_prazo,
         sla_status = EXCLUDED.sla_status,
         impresso = EXCLUDED.impresso,
         -- Virou "impresso" agora (antes nao era): horario observado, nao estimado.
         impresso_estimado = CASE WHEN prazos_envios.impresso_em IS NULL AND EXCLUDED.impresso
                                  THEN false ELSE prazos_envios.impresso_estimado END,
         impresso_em = COALESCE(prazos_envios.impresso_em, EXCLUDED.impresso_em),
         -- Se o prazo mudou (ex.: coleta passou a usar o fim da janela), o
         -- "atrasou" calculado com o prazo antigo nao vale mais.
         atrasou = EXCLUDED.atrasou OR (prazos_envios.atrasou AND prazos_envios.prazo IS NOT DISTINCT FROM EXCLUDED.prazo),
         ultimo_visto = EXCLUDED.ultimo_visto,
         nf_pendente = prazos_envios.nf_pendente OR EXCLUDED.nf_pendente,
         saiu_em = NULL,
         status_final = NULL`,
      params
    );
  }

  // Saiu da lista neste ciclo: so para contas que foram lidas com sucesso
  // (falha de rede numa conta nao pode "despachar" os envios dela).
  if (!contasOk.length) return;
  const { rows: sairam } = await db.query(
    `UPDATE prazos_envios SET saiu_em = $1
      WHERE saiu_em IS NULL AND ultimo_visto < $1 AND seller_id = ANY($2)
      RETURNING shipping_id, seller_id`,
    [agora, contasOk]
  );
  await emLotes(sairam, 5, async (r) => {
    try {
      const token = await getValidAccessToken(r.seller_id);
      const s = await fetchShipment(token, r.shipping_id);
      await db.query(
        `UPDATE prazos_envios SET status_final = $2,
           impresso_estimado = CASE WHEN impresso_em IS NULL AND $2 IN ('shipped','delivered') THEN true ELSE impresso_estimado END,
           impresso_em = CASE WHEN impresso_em IS NULL AND $2 IN ('shipped','delivered') THEN saiu_em ELSE impresso_em END
         WHERE shipping_id = $1`,
        [r.shipping_id, s?.status || null]
      );
    } catch (err) {
      console.error(`[prazos] status final ${r.shipping_id}:`, err.message);
    }
  });
}

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/prazos/calendario", async (req, res) => {
  const { de, ate } = req.query;
  if (!DATA_RE.test(de || "") || !DATA_RE.test(ate || "")) {
    return res.status(400).json({ error: "Informe ?de=AAAA-MM-DD&ate=AAAA-MM-DD" });
  }
  try {
    await garantirTabelaHistorico();
    const { rows } = await db.query(
      `SELECT to_char(dia_prazo, 'YYYY-MM-DD') AS dia,
              count(*) FILTER (WHERE status_final IS DISTINCT FROM 'cancelled')::int AS total,
              count(*) FILTER (WHERE impresso_em IS NOT NULL)::int AS impressos,
              count(*) FILTER (WHERE impresso_em IS NOT NULL
                                 AND (limite_impressao IS NULL OR impresso_em <= limite_impressao))::int AS no_limite,
              count(*) FILTER (WHERE impresso_em IS NULL AND status_final IS DISTINCT FROM 'cancelled')::int AS nao_impressos,
              count(*) FILTER (WHERE atrasou)::int AS atrasados,
              count(*) FILTER (WHERE status_final = 'cancelled')::int AS cancelados
         FROM prazos_envios
        WHERE dia_prazo BETWEEN $1 AND $2
        GROUP BY dia_prazo
        ORDER BY dia_prazo`,
      [de, ate]
    );
    const { rows: ini } = await db.query(
      "SELECT to_char(min(visto_em) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS inicio FROM prazos_envios"
    );
    res.json({ dias: rows, inicio: ini[0]?.inicio || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const isoOuNulo = (d) => (d ? new Date(d).toISOString() : null);
function envioDoHistorico(r) {
  return {
    dia: r.dia,
    shippingId: r.shipping_id,
    sellerId: r.seller_id,
    conta: r.conta,
    venda: r.venda,
    comprador: r.comprador,
    itens: r.itens || [],
    modalidade: r.modalidade,
    prazo: isoOuNulo(r.prazo),
    limiteImpressao: isoOuNulo(r.limite_impressao),
    slaStatus: r.sla_status,
    impressoEm: isoOuNulo(r.impresso_em),
    impressoEstimado: r.impresso_estimado,
    atrasou: r.atrasou,
    saiuEm: isoOuNulo(r.saiu_em),
    statusFinal: r.status_final,
    aindaNaLista: !r.saiu_em,
    nfPendente: !!r.nf_pendente,
  };
}

async function enviosDoPeriodo(de, ate) {
  await garantirTabelaHistorico();
  const { rows } = await db.query(
    `SELECT *, to_char(dia_prazo, 'YYYY-MM-DD') AS dia FROM prazos_envios
      WHERE dia_prazo BETWEEN $1 AND $2
      ORDER BY dia_prazo, limite_impressao NULLS LAST, venda`,
    [de, ate]
  );
  return rows.map(envioDoHistorico);
}

router.get("/prazos/dia", async (req, res) => {
  const { data } = req.query;
  if (!DATA_RE.test(data || "")) return res.status(400).json({ error: "Informe ?data=AAAA-MM-DD" });
  try {
    res.json({ data, envios: await enviosDoPeriodo(data, data) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Relatorio de um periodo (ex.: 01 a 06). Limite de 93 dias por consulta.
router.get("/prazos/periodo", async (req, res) => {
  const { de, ate } = req.query;
  if (!DATA_RE.test(de || "") || !DATA_RE.test(ate || "") || de > ate) {
    return res.status(400).json({ error: "Informe ?de=AAAA-MM-DD&ate=AAAA-MM-DD (de <= ate)" });
  }
  if ((Date.parse(ate) - Date.parse(de)) / 86400000 > 92) {
    return res.status(400).json({ error: "Período máximo: 93 dias" });
  }
  try {
    res.json({ de, ate, envios: await enviosDoPeriodo(de, ate) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function rodarCiclo() {
  if (cicloAtual) return cicloAtual;
  cicloAtual = (async () => {
    estado.emAndamento = true;
    const agora = new Date();
    const hojeSP = partesSP(agora).dia;
    const config = await lerConfig();
    const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts ORDER BY nickname");
    const contas = [];
    const envios = [];
    const erros = [];
    const contasOk = [];
    for (const acc of accounts) {
      try {
        const r = await coletarConta(acc, config, agora, hojeSP);
        contas.push(r.conta);
        envios.push(...r.envios);
        contasOk.push(String(acc.id));
      } catch (err) {
        console.error(`[prazos] conta ${acc.nickname}:`, err.message);
        erros.push({ sellerId: String(acc.id), conta: acc.nickname, erro: err.message });
      }
    }
    // Esquece envios que ja sairam da lista (despachados/cancelados).
    const vivos = new Set(envios.map((e) => e.shippingId));
    for (const id of cacheSla.keys()) if (!vivos.has(id)) cacheSla.delete(id);
    for (const id of cacheEnvio.keys()) if (!vivos.has(id)) cacheEnvio.delete(id);

    estado = { atualizadoEm: agora.toISOString(), emAndamento: false, contas, envios, erros };

    // Historico (calendario): falha no banco nao pode derrubar a tela ao vivo.
    try {
      await gravarHistorico(envios, contasOk, agora);
      // A tela de impressos mostra a que horas cada pacote foi impresso.
      const impressos = envios.filter((e) => e.impresso);
      if (impressos.length) {
        const { rows } = await db.query(
          "SELECT shipping_id, impresso_em, impresso_estimado FROM prazos_envios WHERE shipping_id = ANY($1)",
          [impressos.map((e) => String(e.shippingId))]
        );
        const porId = new Map(rows.map((r) => [r.shipping_id, r]));
        for (const e of impressos) {
          const r = porId.get(String(e.shippingId));
          if (r?.impresso_em) {
            e.impressoEm = new Date(r.impresso_em).toISOString();
            e.impressoEstimado = r.impresso_estimado;
          }
        }
      }
    } catch (err) {
      console.error("[prazos] falha ao gravar historico:", err.message);
    }
  })()
    .catch((err) => {
      console.error("[prazos] ciclo falhou:", err.message);
      estado.emAndamento = false;
      estado.erros = [{ erro: err.message }];
    })
    .finally(() => {
      cicloAtual = null;
    });
  return cicloAtual;
}

// A situacao depende da hora: reclassifica na leitura em vez de esperar o
// proximo ciclo (um pedido vira "em risco" no minuto certo).
async function estadoAtual() {
  const config = await lerConfig();
  const agora = new Date();
  const hojeSP = partesSP(agora).dia;
  const envios = estado.envios.map((e) => ({
    ...e,
    situacao: classificar({
      impresso: e.impresso,
      prazo: e.prazo ? new Date(e.prazo) : null,
      limite: e.limiteImpressao ? new Date(e.limiteImpressao) : null,
      slaStatus: e.slaStatus,
      agora,
      hojeSP,
      avisoMin: config.avisoMin,
    }),
  }));
  return { ...estado, envios, agora: agora.toISOString(), hojeSP, config };
}

function iniciarColetorPrazos() {
  setTimeout(() => rodarCiclo(), 15_000);
  setInterval(() => rodarCiclo(), CICLO_MS);
}

router.get("/prazos", async (req, res) => {
  // Render gratuito dorme e para o setInterval: se o dado estiver velho,
  // atualiza agora (e espera, se ainda nao houver nada).
  const idade = estado.atualizadoEm ? Date.now() - Date.parse(estado.atualizadoEm) : Infinity;
  if (idade > CICLO_MS + 30_000) {
    const p = rodarCiclo();
    if (!estado.atualizadoEm) await p;
  }
  res.json(await estadoAtual());
});

router.post("/prazos/atualizar", async (req, res) => {
  await rodarCiclo();
  res.json(await estadoAtual());
});

router.put("/prazos/config", express.json(), async (req, res) => {
  try {
    const config = await salvarConfig(req.body || {});
    // Os limites de impressao sao calculados no ciclo: recalcula ja.
    await rodarCiclo();
    res.json(await estadoAtual());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sonda: "o ML mostra N a imprimir e o painel mostra menos". Compara o que o
// painel contou para a conta com o que a API tem em cada substatus.
// Uso: /api/debug/probe-prazos-conta?sellerId=522101670
const SUBSTATUS_RTS = [
  "ready_to_print", "printed", "invoice_pending", "ready_to_pack", "packed", "in_packing_list",
  "in_pickup_list", "ready_for_pkl_creation", "ready_for_pickup", "ready_for_dropoff",
  "picked_up", "dropped_off", "in_hub", "authorized_by_carrier", "stale", "in_warehouse",
];
const SUBSTATUS_PENDING = ["buffered", "creating_route", "manufacturing", "cost_exceeded", "under_review", "waiting_for_label_generation"];

router.get("/debug/probe-prazos-conta", async (req, res) => {
  const sellerId = String(req.query.sellerId || "");
  if (!sellerId) return res.status(400).json({ error: "Informe ?sellerId=..." });
  try {
    const token = await getValidAccessToken(sellerId);
    const doPainel = estado.envios.filter((e) => e.sellerId === sellerId);

    const contar = async (qs) => {
      try {
        const r = await mlGet(`/orders/search?seller=${sellerId}${qs}&limit=1`, token);
        return r?.paging?.total ?? null;
      } catch (err) {
        return `erro ${err.status || err.message}`;
      }
    };
    const porSubstatus = {};
    for (const sub of SUBSTATUS_RTS) porSubstatus[`ready_to_ship/${sub}`] = await contar(`&shipping.status=ready_to_ship&shipping.substatus=${sub}`);
    porSubstatus["ready_to_ship (todos)"] = await contar("&shipping.status=ready_to_ship");
    porSubstatus["pending (todos)"] = await contar("&shipping.status=pending");
    for (const sub of SUBSTATUS_PENDING) porSubstatus[`pending/${sub}`] = await contar(`&shipping.status=pending&shipping.substatus=${sub}`);

    // Detalhe dos envios que NAO sao Full e o painel nao busca (ate 30).
    const foraDoPainel = [];
    const candidatos = [
      ...SUBSTATUS_RTS.filter((s) => !["ready_to_print", "printed", "in_warehouse"].includes(s)).map((s) => ["ready_to_ship", s]),
      ...SUBSTATUS_PENDING.map((s) => ["pending", s]),
    ];
    for (const [st, sub] of candidatos) {
      const n = porSubstatus[`${st}/${sub}`];
      if (typeof n !== "number" || n === 0 || foraDoPainel.length >= 30) continue;
      const r = await mlGet(
        `/orders/search?seller=${sellerId}&shipping.status=${st}&shipping.substatus=${sub}&sort=date_desc&limit=15`,
        token
      );
      for (const o of r?.results || []) {
        const shipId = o?.shipping?.id;
        if (!shipId || foraDoPainel.length >= 30) continue;
        const s = await fetchShipment(token, shipId).catch((err) => ({ erro: err.message }));
        const lt = s?.logistic_type ?? s?.logistic?.type;
        if (lt === "fulfillment") continue;
        let sla = null;
        try {
          sla = await mlGet(`/shipments/${shipId}/sla`, token);
        } catch (err) {
          sla = { erro: err.status || err.message };
        }
        foraDoPainel.push({
          venda: String(o.pack_id || o.id), order_id: o.id, shipping_id: shipId,
          status: s?.status, substatus: s?.substatus, logistic_type: lt,
          criado: o.date_created, sla, produto: o.order_items?.[0]?.item?.title,
        });
      }
    }

    res.json({
      sellerId,
      painel: {
        atualizadoEm: estado.atualizadoEm,
        pacotes: doPainel.length,
        pedidos: doPainel.reduce((n, e) => n + e.pedidos.length, 0),
        porModalidadeESituacao: doPainel.reduce((acc, e) => {
          const k = `${e.modalidade}/${e.situacao}`;
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {}),
        coleta: doPainel
          .filter((e) => e.modalidade === "coleta")
          .map((e) => ({
            venda: e.venda, pedidos: e.pedidos, shippingId: e.shippingId, situacao: e.situacao,
            impresso: e.impresso, prazoSla: e.prazoSla, prazo: e.prazo, limite: e.limiteImpressao,
          })),
      },
      apiPorSubstatus: porSubstatus,
      foraDoPainel,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.iniciarColetorPrazos = iniciarColetorPrazos;
// Exposto so para teste.
module.exports._interno = { partesSP, horaSP, calcularLimite, classificar, mesclarConfig };
