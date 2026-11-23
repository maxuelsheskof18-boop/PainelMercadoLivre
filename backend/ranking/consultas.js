// Consultas do Ranking de produtos (leem ranking_vendas).
//
// "Produto" = SKU quando existe (e o que liga o MESMO produto na Shopee e no
// Mercado Livre); sem SKU, vale canal + id do anuncio.

const db = require("../db");
const { MAX_DIAS } = require("./coletor");

const TZ = "America/Sao_Paulo";
const DIA = 864e5;
const hojeSP = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const somaDia = (iso, n) => new Date(Date.parse(`${iso}T12:00:00-03:00`) + n * DIA).toLocaleDateString("en-CA", { timeZone: TZ });
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DIA);
const ultimoDiaDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, "0");
const menor = (a, b) => (a < b ? a : b);

const CHAVE = "COALESCE(NULLIF(sku, ''), canal || ':' || produto_id)";
const CANAIS = new Set(["shopee", "ml"]);

// tipo: "mes" (ref AAAA-MM), "ano" (ref AAAA) ou "dias" (ref = quantidade).
// "anterior" = o periodo equivalente de antes, com o MESMO numero de dias
// corridos (mes/ano em andamento nao pode perder para um mes inteiro).
function periodo({ tipo = "mes", ref } = {}) {
  const hoje = hojeSP();
  let de;
  let ate;
  let rotulo;
  if (tipo === "ano") {
    const ano = /^\d{4}$/.test(ref || "") ? ref : hoje.slice(0, 4);
    de = `${ano}-01-01`;
    ate = `${ano}-12-31`;
    rotulo = ano;
    ref = ano;
  } else if (tipo === "dias") {
    const n = Math.min(Math.max(Number(ref) || 30, 1), 400);
    ate = hoje;
    de = somaDia(hoje, -(n - 1));
    rotulo = `Últimos ${n} dias`;
    ref = String(n);
  } else {
    tipo = "mes";
    const m = /^(\d{4})-(\d{2})$/.test(ref || "") ? ref : hoje.slice(0, 7);
    const [ano, mes] = m.split("-").map(Number);
    de = `${m}-01`;
    ate = `${m}-${pad(ultimoDiaDoMes(ano, mes))}`;
    rotulo = m;
    ref = m;
  }
  const efetivoAte = menor(ate, hoje); // dias que ja passaram
  const parcial = ate > hoje;
  const decorridos = Math.max(1, diasEntre(de, efetivoAte) + 1);
  let aDe;
  let aAte;
  if (tipo === "ano") {
    aDe = `${Number(ref) - 1}-01-01`;
    aAte = menor(somaDia(aDe, decorridos - 1), `${Number(ref) - 1}-12-31`);
  } else if (tipo === "dias") {
    aDe = somaDia(de, -decorridos);
    aAte = somaDia(de, -1);
  } else {
    const [ano, mes] = ref.split("-").map(Number);
    const pa = mes === 1 ? ano - 1 : ano;
    const pm = mes === 1 ? 12 : mes - 1;
    aDe = `${pa}-${pad(pm)}-01`;
    aAte = menor(somaDia(aDe, decorridos - 1), `${pa}-${pad(pm)}-${pad(ultimoDiaDoMes(pa, pm))}`);
  }
  return { tipo, ref, rotulo, de, ate, efetivoAte, parcial, anterior: { de: aDe, ate: aAte } };
}

const canalOk = (c) => (CANAIS.has(c) ? c : null);

// O periodo de comparacao so vale se TODAS as contas do filtro ja tem venda
// registrada naquela epoca (senao tudo apareceria como "novo" so porque o
// historico ainda nao foi coletado ate la).
async function periodoCoberto(canal, de) {
  const { rows } = await db.query("SELECT canal, conta_id, to_char(min(dia), 'YYYY-MM-DD') AS de FROM ranking_vendas GROUP BY canal, conta_id");
  const incl = canal ? rows.filter((r) => r.canal === canal) : rows;
  return incl.length > 0 && incl.every((r) => r.de <= de);
}
const num = (v) => (v == null ? 0 : Number(v));

// ---------- ranking ----------
async function ranking({ tipo, ref, canal, ordem = "qtd", busca = "", limite = 100 } = {}) {
  const p = periodo({ tipo, ref });
  const cn = canalOk(canal);
  const lim = Math.min(Math.max(Number(limite) || 100, 10), 500);
  const filtros = ["dia BETWEEN $1::date AND $2::date"];
  const params = [p.de, p.ate];
  if (cn) {
    params.push(cn);
    filtros.push(`canal = $${params.length}`);
  }
  const termo = String(busca || "").trim().slice(0, 60);
  if (termo) {
    params.push(`%${termo}%`);
    filtros.push(`(titulo ILIKE $${params.length} OR sku ILIKE $${params.length})`);
  }
  const where = filtros.join(" AND ");
  const { rows } = await db.query(
    `SELECT ${CHAVE} AS chave,
            (array_agg(titulo ORDER BY dia DESC))[1] AS titulo,
            max(NULLIF(sku, '')) AS sku,
            sum(qtd)::int AS qtd, sum(valor) AS valor, sum(pedidos)::int AS pedidos,
            COALESCE(sum(qtd) FILTER (WHERE canal = 'shopee'), 0)::int AS qtd_shopee,
            COALESCE(sum(qtd) FILTER (WHERE canal = 'ml'), 0)::int AS qtd_ml,
            COALESCE(sum(valor) FILTER (WHERE canal = 'shopee'), 0) AS valor_shopee,
            COALESCE(sum(valor) FILTER (WHERE canal = 'ml'), 0) AS valor_ml,
            to_char(max(dia), 'YYYY-MM-DD') AS ultima_venda
       FROM ranking_vendas WHERE ${where}
      GROUP BY 1
      ORDER BY ${ordem === "valor" ? "sum(valor)" : "sum(qtd)"} DESC, 1
      LIMIT ${lim}`,
    params
  );
  const { rows: tot } = await db.query(
    `SELECT COALESCE(sum(qtd), 0)::int AS qtd, COALESCE(sum(valor), 0) AS valor, COALESCE(sum(pedidos), 0)::int AS pedidos,
            count(DISTINCT ${CHAVE})::int AS produtos,
            COALESCE(sum(qtd) FILTER (WHERE canal = 'shopee'), 0)::int AS qtd_shopee,
            COALESCE(sum(qtd) FILTER (WHERE canal = 'ml'), 0)::int AS qtd_ml,
            COALESCE(sum(valor) FILTER (WHERE canal = 'shopee'), 0) AS valor_shopee,
            COALESCE(sum(valor) FILTER (WHERE canal = 'ml'), 0) AS valor_ml
       FROM ranking_vendas WHERE ${where}`,
    params
  );
  // Periodo anterior (mesma quantidade de dias) para a seta de tendencia.
  const anterior = new Map();
  if (rows.length) {
    const pa = [p.anterior.de, p.anterior.ate, rows.map((r) => r.chave)];
    let filtroCanal = "";
    if (cn) {
      pa.push(cn);
      filtroCanal = ` AND canal = $4`;
    }
    const { rows: ant } = await db.query(
      `SELECT chave, sum(qtd)::int AS qtd, sum(valor) AS valor FROM (
         SELECT ${CHAVE} AS chave, qtd, valor FROM ranking_vendas WHERE dia BETWEEN $1::date AND $2::date${filtroCanal}
       ) t WHERE chave = ANY($3::text[]) GROUP BY chave`,
      pa
    );
    for (const a of ant) anterior.set(a.chave, { qtd: a.qtd, valor: num(a.valor) });
  }
  const t = tot[0] || {};
  return {
    periodo: { ...p, anteriorCoberto: await periodoCoberto(cn, p.anterior.de) },
    total: {
      qtd: num(t.qtd), valor: num(t.valor), pedidos: num(t.pedidos), produtos: num(t.produtos),
      qtdShopee: num(t.qtd_shopee), qtdMl: num(t.qtd_ml), valorShopee: num(t.valor_shopee), valorMl: num(t.valor_ml),
    },
    itens: rows.map((r, i) => {
      const ant = anterior.get(r.chave);
      return {
        pos: i + 1,
        chave: r.chave,
        titulo: r.titulo || r.chave,
        sku: r.sku || "",
        qtd: r.qtd, valor: num(r.valor), pedidos: r.pedidos,
        qtdShopee: r.qtd_shopee, qtdMl: r.qtd_ml, valorShopee: num(r.valor_shopee), valorMl: num(r.valor_ml),
        ultimaVenda: r.ultima_venda,
        anterior: ant ? ant.qtd : 0,
      };
    }),
    cobertura: await cobertura(),
  };
}

// ---------- comparar periodos (A x B) ----------
async function compararPeriodos({ tipo, a, b, canal, ordem = "diferenca", busca = "", limite = 150 } = {}) {
  const pa = periodo({ tipo, ref: a });
  // B = o periodo equivalente de antes, a menos que venha informado.
  const pb = b ? periodo({ tipo: pa.tipo, ref: b }) : { ...pa.anterior, rotulo: "Período anterior" };
  const cn = canalOk(canal);
  const params = [pa.de, pa.efetivoAte, pb.de, pb.ate, menor(pa.de, pb.de), pa.efetivoAte > pb.ate ? pa.efetivoAte : pb.ate];
  const filtros = ["dia BETWEEN $5::date AND $6::date"];
  if (cn) {
    params.push(cn);
    filtros.push(`canal = $${params.length}`);
  }
  const termo = String(busca || "").trim().slice(0, 60);
  if (termo) {
    params.push(`%${termo}%`);
    filtros.push(`(titulo ILIKE $${params.length} OR sku ILIKE $${params.length})`);
  }
  const lim = Math.min(Math.max(Number(limite) || 150, 10), 500);
  const { rows } = await db.query(
    `SELECT ${CHAVE} AS chave, (array_agg(titulo ORDER BY dia DESC))[1] AS titulo, max(NULLIF(sku, '')) AS sku,
            COALESCE(sum(qtd) FILTER (WHERE dia BETWEEN $1::date AND $2::date), 0)::int AS qtd_a,
            COALESCE(sum(qtd) FILTER (WHERE dia BETWEEN $3::date AND $4::date), 0)::int AS qtd_b,
            COALESCE(sum(valor) FILTER (WHERE dia BETWEEN $1::date AND $2::date), 0) AS valor_a,
            COALESCE(sum(valor) FILTER (WHERE dia BETWEEN $3::date AND $4::date), 0) AS valor_b
       FROM ranking_vendas WHERE ${filtros.join(" AND ")}
      GROUP BY 1
     HAVING COALESCE(sum(qtd) FILTER (WHERE dia BETWEEN $1::date AND $2::date), 0) + COALESCE(sum(qtd) FILTER (WHERE dia BETWEEN $3::date AND $4::date), 0) > 0
      ORDER BY ${ordem === "a" ? "qtd_a" : ordem === "b" ? "qtd_b" : "abs(COALESCE(sum(qtd) FILTER (WHERE dia BETWEEN $1::date AND $2::date), 0) - COALESCE(sum(qtd) FILTER (WHERE dia BETWEEN $3::date AND $4::date), 0))"} DESC, 1
      LIMIT ${lim}`,
    params
  );
  return {
    a: { rotulo: pa.rotulo, de: pa.de, ate: pa.efetivoAte },
    b: { rotulo: pb.rotulo || `${pb.de} a ${pb.ate}`, de: pb.de, ate: pb.ate, coberto: await periodoCoberto(cn, pb.de) },
    itens: rows.map((r) => ({
      chave: r.chave, titulo: r.titulo || r.chave, sku: r.sku || "",
      qtdA: r.qtd_a, qtdB: r.qtd_b, valorA: num(r.valor_a), valorB: num(r.valor_b),
    })),
    cobertura: await cobertura(),
  };
}

// ---------- alertas: produtos que pararam de vender ----------
// Vendia (>= min unidades nos "base" dias antes) e nao vendeu nada nos ultimos
// "dias". Por produto E canal (parou na Shopee mas vende no ML tambem aparece).
// Conta cujo coletor esta atrasado fica de fora (senao tudo dela pareceria parado).
async function alertas({ dias = 7, base = 60, min = 3, canal } = {}) {
  const hoje = hojeSP();
  const N = Math.min(Math.max(Number(dias) || 7, 1), 90);
  const B = Math.min(Math.max(Number(base) || 60, 7), 180);
  const M = Math.min(Math.max(Number(min) || 3, 1), 1000);
  const cn = canalOk(canal);
  const recenteDe = somaDia(hoje, -(N - 1)); // 1o dia do periodo "sem vender"
  const baseAte = somaDia(hoje, -N);
  const baseDe = somaDia(hoje, -(N + B - 1));
  const { rows: st } = await db.query(
    `SELECT canal, conta_id, conta, extract(epoch FROM recente_em) * 1000 AS rec FROM ranking_estado`
  );
  const agora = Date.now();
  const desatualizadas = st.filter((s) => !s.rec || agora - Number(s.rec) > 3 * 3600e3);
  const ignorar = desatualizadas.map((s) => `${s.canal}|${s.conta_id}`);
  const params = [baseDe, baseAte, recenteDe, M, ignorar];
  let filtroCanal = "";
  if (cn) {
    params.push(cn);
    filtroCanal = ` AND canal = $6`;
  }
  const { rows } = await db.query(
    `SELECT ${CHAVE} AS chave, canal,
            (array_agg(titulo ORDER BY dia DESC))[1] AS titulo, max(NULLIF(sku, '')) AS sku,
            COALESCE(sum(qtd) FILTER (WHERE dia BETWEEN $1::date AND $2::date), 0)::int AS qtd_base,
            to_char(max(dia), 'YYYY-MM-DD') AS ultima,
            array_agg(DISTINCT conta_id || '|' || COALESCE(conta, '') || '|' || produto_id) AS itens
       FROM ranking_vendas
      WHERE dia >= $1::date AND NOT ((canal || '|' || conta_id) = ANY($5::text[]))${filtroCanal}
      GROUP BY 1, canal
     HAVING COALESCE(sum(qtd) FILTER (WHERE dia >= $3::date), 0) = 0
        AND COALESCE(sum(qtd) FILTER (WHERE dia BETWEEN $1::date AND $2::date), 0) >= $4::int
      ORDER BY qtd_base DESC
      LIMIT 300`,
    params
  );
  return {
    parametros: { dias: N, base: B, min: M },
    suspensas: desatualizadas.map((s) => ({ canal: s.canal, conta: s.conta })),
    itens: rows.map((r) => ({
      chave: r.chave,
      canal: r.canal,
      titulo: r.titulo || r.chave,
      sku: r.sku || "",
      qtdBase: r.qtd_base,
      mediaDia: Math.round((r.qtd_base / B) * 100) / 100,
      ultimaVenda: r.ultima,
      diasSemVender: diasEntre(r.ultima, hoje),
      itens: (r.itens || []).map((s) => {
        const partes = s.split("|");
        return { contaId: partes[0], conta: partes.slice(1, -1).join("|"), produtoId: partes[partes.length - 1] };
      }),
    })),
  };
}

// ---------- andamento da coleta ----------
async function cobertura() {
  const { rows: est } = await db.query(
    `SELECT canal, conta_id, conta, concluido, erro, to_char(backfill_ate, 'YYYY-MM-DD') AS ate, to_char(primeiro_dia, 'YYYY-MM-DD') AS primeiro,
            extract(epoch FROM recente_em) * 1000 AS rec
       FROM ranking_estado ORDER BY canal, conta`
  );
  const { rows: faixa } = await db.query(
    `SELECT canal, to_char(min(dia), 'YYYY-MM-DD') AS de, to_char(max(dia), 'YYYY-MM-DD') AS ate, count(*)::int AS linhas FROM ranking_vendas GROUP BY canal`
  );
  const hoje = hojeSP();
  const alvoDias = Math.max(1, MAX_DIAS - 19);
  return {
    contas: est.map((e) => ({
      canal: e.canal,
      conta: e.conta,
      concluido: e.concluido,
      erro: e.erro,
      coletadoDesde: e.ate,
      primeiraVenda: e.primeiro,
      atualizadoEm: e.rec ? Number(e.rec) : null,
      progresso: e.concluido ? 100 : Math.max(0, Math.min(99, Math.round((100 * diasEntre(e.ate || somaDia(hoje, -19), somaDia(hoje, -19))) / alvoDias))),
    })),
    canais: Object.fromEntries(faixa.map((f) => [f.canal, { de: f.de, ate: f.ate, linhas: f.linhas }])),
  };
}

module.exports = { ranking, compararPeriodos, alertas, cobertura, periodo, hojeSP };
