// Ranking de produtos (24/11): vendas por dia, produto e canal (Shopee e
// Mercado Livre), guardadas no banco para somar por mes/ano.
//
// Como coleta:
//  - RECENTE: a cada 20 min refaz os ultimos 3 dias; a cada 6 h os ultimos 20
//    (cancelamentos e pedidos que mudam de status).
//  - HISTORICO: de pouco em pouco, uma janela por vez, indo do mais novo para
//    o mais velho ate 366 dias. Para sozinho quando a conta nao tem mais nada
//    para tras (ou quando a API deixa de devolver). O progresso fica no banco:
//    se o Render dormir/reiniciar, continua de onde parou.
//  - Cada janela substitui os dias dela (apaga e grava de novo): nada dobra.
//
// Conta como venda: pedido que NAO esta cancelado/invalido/aguardando
// pagamento. Dia = dia da CRIACAO do pedido (fuso de Sao Paulo).
//
// Chamadas espacadas (~250 ms) e uma tarefa pesada por conta a cada 30 s: o
// painel tem outros coletores (Prazos, Tiny) usando as mesmas contas.

const db = require("../db");
const shopee = require("../shopee/api");
const { mlConta, espera } = require("./ml");

const TZ = "America/Sao_Paulo";
const DIA = 864e5;
const MAX_DIAS = Number(process.env.RANKING_DIAS || 366);
const TICK_MS = 30_000;
const JANELA = { shopee: 15, ml: 7 }; // dias por janela (Shopee: maximo da API = 15)
const VAZIOS_PARA_PARAR = { shopee: 4, ml: 9 }; // janelas seguidas sem venda = fim do historico

const diaSP = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const somaDia = (iso, n) => diaSP(Date.parse(`${iso}T12:00:00-03:00`) + n * DIA);
const inicioMs = (iso) => Date.parse(`${iso}T00:00:00-03:00`);
const fimMs = (iso) => Date.parse(`${iso}T23:59:59-03:00`);

const normSku = (v) => String(v ?? "").trim().toUpperCase();
const EXCLUIR_SHOPEE = new Set(["UNPAID", "CANCELLED", "IN_CANCEL"]);
const EXCLUIR_ML = new Set(["cancelled", "invalid", "payment_required", "payment_in_process"]);

// ---------- tabelas ----------
let tabelas = null;
function garantirTabelas() {
  if (!tabelas) {
    tabelas = (async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS ranking_vendas (
        dia DATE NOT NULL,
        canal TEXT NOT NULL,
        conta_id TEXT NOT NULL,
        conta TEXT,
        produto_id TEXT NOT NULL,
        variacao TEXT NOT NULL DEFAULT '',
        sku TEXT NOT NULL DEFAULT '',
        titulo TEXT,
        var_nome TEXT,
        qtd INT NOT NULL,
        valor NUMERIC(14,2) NOT NULL DEFAULT 0,
        pedidos INT NOT NULL DEFAULT 0,
        PRIMARY KEY (dia, canal, conta_id, produto_id, variacao)
      )`);
      await db.query("CREATE INDEX IF NOT EXISTS ranking_vendas_dia_idx ON ranking_vendas (dia)");
      await db.query("CREATE INDEX IF NOT EXISTS ranking_vendas_sku_idx ON ranking_vendas (sku)");
      await db.query(`CREATE TABLE IF NOT EXISTS ranking_estado (
        canal TEXT NOT NULL,
        conta_id TEXT NOT NULL,
        conta TEXT,
        backfill_ate DATE,
        vazios INT NOT NULL DEFAULT 0,
        concluido BOOLEAN NOT NULL DEFAULT false,
        erros_seguidos INT NOT NULL DEFAULT 0,
        erro TEXT,
        pausado_ate TIMESTAMPTZ,
        primeiro_dia DATE,
        recente_em TIMESTAMPTZ,
        completo_em TIMESTAMPTZ,
        atualizado_em TIMESTAMPTZ,
        PRIMARY KEY (canal, conta_id)
      )`);
    })().catch((err) => {
      tabelas = null;
      throw err;
    });
  }
  return tabelas;
}

// ---------- agregacao ----------
function somar(mapa, linha, pedidoId) {
  const k = `${linha.dia}|${linha.produto_id}|${linha.variacao}`;
  let r = mapa.get(k);
  if (!r) {
    r = { ...linha, qtd: 0, valor: 0, _ped: new Set() };
    mapa.set(k, r);
  }
  r.qtd += linha.qtd;
  r.valor += linha.valor;
  r._ped.add(pedidoId);
  if (!r.sku && linha.sku) r.sku = linha.sku;
  if (!r.titulo && linha.titulo) r.titulo = linha.titulo;
}
const fechar = (mapa) => [...mapa.values()].map(({ _ped, ...r }) => ({ ...r, valor: Math.round(r.valor * 100) / 100, pedidos: _ped.size }));

// ---------- Shopee: janela [de, ate] (dias inclusivos, ate 15) ----------
async function coletarShopeeJanela(shopId, de, ate) {
  const mapa = new Map();
  const sns = [];
  let cursor = "";
  const to = Math.min(Math.floor(fimMs(ate) / 1000), Math.floor(Date.now() / 1000));
  for (let pagina = 0; pagina < 80; pagina++) {
    const r = await shopee.chamarLoja(shopId, "/api/v2/order/get_order_list", {
      query: { time_range_field: "create_time", time_from: Math.floor(inicioMs(de) / 1000), time_to: to, page_size: 100, cursor },
    });
    const resp = r.response || {};
    for (const o of resp.order_list || []) sns.push(o.order_sn);
    if (!resp.more || !resp.next_cursor) break;
    cursor = resp.next_cursor;
    await espera(200);
  }
  for (let i = 0; i < sns.length; i += 50) {
    const r = await shopee.chamarLoja(shopId, "/api/v2/order/get_order_detail", {
      query: { order_sn_list: sns.slice(i, i + 50).join(","), response_optional_fields: "item_list" },
    });
    for (const o of r.response?.order_list || []) {
      if (EXCLUIR_SHOPEE.has(o.order_status)) continue;
      const dia = diaSP(Number(o.create_time) * 1000);
      for (const it of o.item_list || []) {
        const qtd = Number(it.model_quantity_purchased || it.quantity || 1);
        const preco = Number(it.model_discounted_price ?? it.model_original_price ?? 0);
        somar(
          mapa,
          {
            dia,
            produto_id: String(it.item_id),
            variacao: it.model_id ? String(it.model_id) : "",
            sku: normSku(it.model_sku || it.item_sku),
            titulo: it.item_name || "",
            var_nome: it.model_name || "",
            qtd,
            valor: preco * qtd,
          },
          o.order_sn
        );
      }
    }
    await espera(200);
  }
  return fechar(mapa);
}

// ---------- Mercado Livre: janela [de, ate] ----------
async function coletarMLJanela(contaId, de, ate) {
  const mapa = new Map();
  const LIM = 50;
  for (let offset = 0; offset <= 9950; offset += LIM) {
    const params = new URLSearchParams({
      seller: contaId,
      sort: "date_asc",
      limit: String(LIM),
      offset: String(offset),
      "order.date_created.from": `${de}T00:00:00.000-03:00`,
      "order.date_created.to": `${ate}T23:59:59.999-03:00`,
    });
    const r = await mlConta(contaId, `/orders/search?${params.toString()}`);
    const lista = r.results || [];
    for (const o of lista) {
      if (EXCLUIR_ML.has(o.status)) continue;
      const dia = diaSP(Date.parse(o.date_created));
      for (const it of o.order_items || []) {
        const item = it.item || {};
        const qtd = Number(it.quantity || 1);
        somar(
          mapa,
          {
            dia,
            produto_id: String(item.id),
            variacao: item.variation_id ? String(item.variation_id) : "",
            sku: normSku(item.seller_sku || item.seller_custom_field),
            titulo: item.title || "",
            var_nome: "",
            qtd,
            valor: Number(it.unit_price || 0) * qtd,
          },
          String(o.id)
        );
      }
    }
    const total = Number(r.paging?.total ?? 0);
    if (!lista.length || offset + lista.length >= total) break;
    await espera(250);
  }
  return fechar(mapa);
}

// ---------- gravar (troca os dias da janela) ----------
async function gravarJanela(canal, contaId, conta, de, ate, linhas) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM ranking_vendas WHERE canal = $1 AND conta_id = $2 AND dia BETWEEN $3 AND $4", [canal, contaId, de, ate]);
    for (let i = 0; i < linhas.length; i += 200) {
      const lote = linhas.slice(i, i + 200);
      const params = [];
      const valores = lote.map((l) => {
        const base = params.length;
        params.push(l.dia, canal, contaId, conta, l.produto_id, l.variacao, l.sku, l.titulo, l.var_nome, l.qtd, l.valor, l.pedidos);
        return `(${Array.from({ length: 12 }, (_, k) => `$${base + k + 1}`).join(",")})`;
      });
      await client.query(
        `INSERT INTO ranking_vendas (dia, canal, conta_id, conta, produto_id, variacao, sku, titulo, var_nome, qtd, valor, pedidos)
         VALUES ${valores.join(",")}
         ON CONFLICT (dia, canal, conta_id, produto_id, variacao) DO UPDATE SET
           qtd = EXCLUDED.qtd, valor = EXCLUDED.valor, pedidos = EXCLUDED.pedidos, sku = EXCLUDED.sku,
           titulo = EXCLUDED.titulo, var_nome = EXCLUDED.var_nome, conta = EXCLUDED.conta`,
        params
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function coletarEGravar(canal, contaId, nome, de, ate) {
  const linhas = canal === "shopee" ? await coletarShopeeJanela(contaId, de, ate) : await coletarMLJanela(contaId, de, ate);
  await gravarJanela(canal, contaId, nome, de, ate, linhas);
  return linhas;
}

// Refaz [de, ate] em janelas do tamanho permitido.
async function recoletar(canal, contaId, nome, de, ate) {
  const passo = JANELA[canal];
  let ini = de;
  while (ini <= ate) {
    const fim = somaDia(ini, passo - 1) < ate ? somaDia(ini, passo - 1) : ate;
    await coletarEGravar(canal, contaId, nome, ini, fim);
    ini = somaDia(fim, 1);
  }
}

// ---------- uma tarefa por conta ----------
async function passoConta(canal, conta) {
  const contaId = canal === "ml" ? String(conta.id) : String(conta.shop_id);
  const nome = canal === "ml" ? conta.nickname || `Conta ${contaId}` : conta.nome || `Loja ${contaId}`;
  const hoje = diaSP(Date.now());
  await db.query(
    `INSERT INTO ranking_estado (canal, conta_id, conta, backfill_ate) VALUES ($1,$2,$3,$4)
     ON CONFLICT (canal, conta_id) DO UPDATE SET conta = EXCLUDED.conta`,
    [canal, contaId, nome, somaDia(hoje, -19)]
  );
  const { rows } = await db.query(
    `SELECT concluido, backfill_ate, vazios, erros_seguidos,
            to_char(backfill_ate, 'YYYY-MM-DD') AS ate,
            extract(epoch FROM recente_em) * 1000 AS rec_ms,
            extract(epoch FROM completo_em) * 1000 AS comp_ms,
            extract(epoch FROM pausado_ate) * 1000 AS pausa_ms
       FROM ranking_estado WHERE canal = $1 AND conta_id = $2`,
    [canal, contaId]
  );
  const st = rows[0];
  const agora = Date.now();
  try {
    if (!st.comp_ms || agora - Number(st.comp_ms) > 6 * 3600e3) {
      await recoletar(canal, contaId, nome, somaDia(hoje, -19), hoje);
      await db.query("UPDATE ranking_estado SET completo_em = now(), recente_em = now(), erro = NULL, atualizado_em = now() WHERE canal = $1 AND conta_id = $2", [canal, contaId]);
      return;
    }
    if (!st.rec_ms || agora - Number(st.rec_ms) > 20 * 60e3) {
      await recoletar(canal, contaId, nome, somaDia(hoje, -2), hoje);
      await db.query("UPDATE ranking_estado SET recente_em = now(), erro = NULL, atualizado_em = now() WHERE canal = $1 AND conta_id = $2", [canal, contaId]);
      return;
    }
  } catch (err) {
    console.error(`[ranking] ${canal} ${nome} (recente):`, err.message);
    await db.query("UPDATE ranking_estado SET erro = $3, atualizado_em = now() WHERE canal = $1 AND conta_id = $2", [canal, contaId, String(err.message).slice(0, 300)]);
    return;
  }
  if (st.concluido || (st.pausa_ms && Number(st.pausa_ms) > agora)) return;
  await backfill(canal, contaId, nome, st, hoje);
}

async function backfill(canal, contaId, nome, st, hoje) {
  const ate = st.ate; // dias ANTES desta data ainda nao foram coletados
  const de = somaDia(ate, -JANELA[canal]);
  const fim = somaDia(ate, -1);
  const limite = somaDia(hoje, -MAX_DIAS);
  try {
    const linhas = await coletarEGravar(canal, contaId, nome, de, fim);
    const vazios = linhas.length ? 0 : Number(st.vazios) + 1;
    const acabou = de <= limite || vazios >= VAZIOS_PARA_PARAR[canal];
    const primeiro = linhas.length ? linhas.reduce((m, l) => (l.dia < m ? l.dia : m), fim) : null;
    await db.query(
      `UPDATE ranking_estado SET backfill_ate = $3, vazios = $4, concluido = $5, erros_seguidos = 0, erro = NULL, atualizado_em = now(),
              primeiro_dia = CASE WHEN $6::date IS NULL THEN primeiro_dia WHEN primeiro_dia IS NULL OR $6::date < primeiro_dia THEN $6::date ELSE primeiro_dia END
        WHERE canal = $1 AND conta_id = $2`,
      [canal, contaId, de, vazios, acabou, primeiro]
    );
  } catch (err) {
    const seguidos = Number(st.erros_seguidos) + 1;
    console.error(`[ranking] ${canal} ${nome} historico ${de}..${fim}:`, err.message);
    if (seguidos >= 5) {
      // Dados muito antigos podem nao estar mais disponiveis na API: encerra o
      // historico. Perto de hoje e instabilidade: pausa 30 min e tenta de novo.
      const antigo = de < somaDia(hoje, -75);
      await db.query(
        `UPDATE ranking_estado SET erros_seguidos = 0, erro = $3, concluido = $4, pausado_ate = CASE WHEN $4 THEN NULL ELSE now() + interval '30 minutes' END, atualizado_em = now()
          WHERE canal = $1 AND conta_id = $2`,
        [canal, contaId, String(err.message).slice(0, 300), antigo]
      );
    } else {
      await db.query("UPDATE ranking_estado SET erros_seguidos = $3, erro = $4, atualizado_em = now() WHERE canal = $1 AND conta_id = $2", [canal, contaId, seguidos, String(err.message).slice(0, 300)]);
    }
  }
}

// ---------- ciclo ----------
let rodando = false;
async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    await garantirTabelas();
    if (shopee.configurado()) {
      const contas = (await shopee.listarContas()).filter((c) => c.ambiente === shopee.ambiente());
      for (const c of contas) await passoConta("shopee", c).catch((e) => console.error("[ranking] shopee:", e.message));
    }
    const { rows } = await db.query("SELECT id, nickname FROM accounts ORDER BY nickname").catch(() => ({ rows: [] }));
    for (const c of rows) await passoConta("ml", c).catch((e) => console.error("[ranking] ml:", e.message));
  } catch (err) {
    console.error("[ranking] ciclo:", err.message);
  } finally {
    rodando = false;
  }
}

let timer = null;
function iniciar() {
  if (timer) return;
  // Interruptor: no Render, RANKING_COLETA=off para a coleta sem mexer no codigo.
  if (process.env.RANKING_COLETA === "off") return;
  setTimeout(() => ciclo().catch(() => {}), 45_000);
  timer = setInterval(() => ciclo().catch(() => {}), TICK_MS);
}

module.exports = { iniciar, ciclo, garantirTabelas, passoConta, coletarShopeeJanela, coletarMLJanela, gravarJanela, somaDia, diaSP, MAX_DIAS };
