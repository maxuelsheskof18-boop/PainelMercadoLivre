// Ranking de produtos (Shopee + Mercado Livre).
// Carregado pelo shopee.js (aba "Ranking" do grupo Operacao). Fica em arquivo
// proprio para nao crescer o shopee.js. Expoe window.RankingUI.
//
//   Ranking   : mais vendidos por mes, ano ou ultimos N dias, por canal
//   Comparar  : Shopee x Mercado Livre por produto, ou periodo x periodo
//   Sem vendas: produtos que vendiam e pararam (com a situacao do anuncio)
(function () {
  const CSS = `
  .rk-raiz { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 24px; }
  .rk-abas { display: flex; gap: 6px; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
  .rk-aba { border: none; background: none; font: inherit; font-size: 14px; font-weight: 700; color: var(--muted); padding: 9px 14px; cursor: pointer; border-bottom: 3px solid transparent; margin-bottom: -1px; display: flex; gap: 7px; align-items: center; }
  .rk-aba.ativa { color: var(--text); border-bottom-color: #7c3aed; }
  .rk-aba .rk-n { background: #dc2626; color: #fff; border-radius: 999px; font-size: 11px; padding: 1px 7px; }
  .rk-filtros { display: flex; gap: 8px 14px; flex-wrap: wrap; align-items: center; }
  .rk-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 10px; padding: 2px; background: var(--bg); }
  .rk-seg button { border: none; background: transparent; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--muted); padding: 5px 11px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
  .rk-seg button.ativo { background: var(--card, #fff); color: var(--text); box-shadow: var(--shadow-sm); }
  .rk-filtros select, .rk-filtros input[type="search"], .rk-inp { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 13px; background: #fff; color: var(--text); }
  .rk-filtros input[type="search"] { min-width: 200px; flex: 1; max-width: 300px; }
  .rk-inp { width: 64px; text-align: center; padding: 4px 6px; }
  .rk-cobertura { font-size: 12px; color: var(--muted); line-height: 1.5; }
  .rk-cobertura b { color: var(--text-soft, var(--text)); }
  .rk-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .rk-card { border: 1px solid var(--border); border-radius: 14px; padding: 12px 14px; background: #fff; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .rk-card-n { font-size: 26px; font-weight: 800; letter-spacing: -.02em; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .rk-card-r { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .rk-card-s { font-size: 12px; color: var(--muted); }
  .rk-div { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--bg); margin: 6px 0 2px; }
  .rk-div span { display: block; height: 100%; }
  .rk-sp { background: #ee4d2d; }
  .rk-ml { background: #ffd400; }
  .rk-tabela { width: 100%; border-collapse: collapse; font-size: 13px; }
  .rk-tabela th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .rk-tabela th.d, .rk-tabela td.d { text-align: right; }
  .rk-tabela td { padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .rk-tabela tr:hover td { background: color-mix(in srgb, var(--bg) 70%, #fff); }
  .rk-pos { font-weight: 800; color: var(--muted); width: 38px; text-align: center; font-variant-numeric: tabular-nums; }
  .rk-pos.top { font-size: 18px; }
  .rk-prod { min-width: 220px; max-width: 420px; }
  .rk-prod b { display: block; font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }
  .rk-prod small { color: var(--muted); font-size: 11.5px; font-family: ui-monospace, Menlo, monospace; }
  .rk-num { font-variant-numeric: tabular-nums; font-weight: 700; }
  .rk-bar { height: 7px; background: var(--bg); border-radius: 999px; overflow: hidden; min-width: 80px; }
  .rk-bar i { display: block; height: 100%; background: #7c3aed; border-radius: 999px; }
  .rk-canais { min-width: 140px; }
  .rk-canais .rk-div { margin: 0 0 3px; height: 8px; }
  .rk-canais small { font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; }
  .rk-canais small .s { color: #c2410c; font-weight: 700; }
  .rk-canais small .m { color: #a16207; font-weight: 700; }
  .rk-tend { font-size: 12px; font-weight: 700; white-space: nowrap; }
  .rk-tend.up { color: #15803d; }
  .rk-tend.down { color: #b91c1c; }
  .rk-tend.novo { color: #7c3aed; }
  .rk-tend.igual { color: var(--muted); }
  .rk-vazio { text-align: center; padding: 40px 16px; color: var(--muted); line-height: 1.6; }
  .rk-mais { align-self: center; }
  .rk-aviso { border: 1px solid #fde68a; background: #fffbeb; color: #92400e; border-radius: 10px; padding: 8px 12px; font-size: 12.5px; }
  .rk-aviso.erro { border-color: #fecaca; background: #fef2f2; color: #991b1b; }
  .rk-sub { display: flex; gap: 10px 14px; flex-wrap: wrap; align-items: center; }
  .rk-vs { display: flex; align-items: center; gap: 6px; min-width: 190px; }
  .rk-vs .e, .rk-vs .d { flex: 1; display: flex; height: 9px; background: var(--bg); border-radius: 999px; overflow: hidden; }
  .rk-vs .e { justify-content: flex-end; }
  .rk-vs .e i { background: #ee4d2d; }
  .rk-vs .d i { background: #ffd400; }
  .rk-vs i { display: block; height: 100%; }
  .rk-chip { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); background: #fff; }
  .rk-chip.shopee { color: #c2410c; background: #fff7ed; border-color: #fed7aa; }
  .rk-chip.ml { color: #854d0e; background: #fefce8; border-color: #fde68a; }
  .rk-st { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px; }
  .rk-st.verde { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
  .rk-st.laranja { background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; }
  .rk-st.vermelho { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
  .rk-st.cinza { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }
  .rk-alertas { display: flex; flex-direction: column; gap: 10px; }
  .rk-alerta { border: 1px solid var(--border); border-left: 5px solid #f59e0b; border-radius: 12px; padding: 12px 14px; background: #fff; display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 8px 18px; }
  .rk-alerta.problema { border-left-color: #dc2626; }
  .rk-alerta.ativo { border-left-color: #f59e0b; }
  .rk-alerta h4 { margin: 0 0 3px; font-size: 14px; line-height: 1.35; }
  .rk-alerta .meta { font-size: 12.5px; color: var(--muted); line-height: 1.55; }
  .rk-alerta .meta b { color: var(--text); }
  .rk-itens { display: flex; flex-direction: column; gap: 6px; }
  .rk-item { display: flex; align-items: center; gap: 6px 8px; flex-wrap: wrap; font-size: 12px; }
  .rk-item .conta { color: var(--muted); }
  .rk-item a, .rk-item button { font: inherit; font-size: 11.5px; color: #2563eb; border: none; background: none; cursor: pointer; padding: 0; text-decoration: none; }
  .rk-item a:hover, .rk-item button:hover { text-decoration: underline; }
  .rk-ajuste { display: flex; gap: 6px 10px; flex-wrap: wrap; align-items: center; font-size: 13px; color: var(--text-soft, var(--text)); }
  @media (max-width: 900px) {
    .rk-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .rk-alerta { grid-template-columns: 1fr; }
    .rk-tabela { display: block; overflow-x: auto; }
  }
  `;

  let ctx = null;
  let host = null;
  const S = {
    aba: "ranking",
    tipo: "mes",
    ref: "",
    canal: "todos",
    ordem: "qtd",
    busca: "",
    limite: 100,
    cmpModo: "canais", // canais | periodos
    cmpB: "", // "" = periodo anterior
    soNosDois: false,
    alDias: 7,
    alBase: 60,
    alMin: 3,
    alFiltro: "todos", // todos | problema | ativo
  };
  const cache = new Map(); // url -> { em, dado }
  let alertasN = null;
  let carregando = 0;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const int = (n) => Number(n || 0).toLocaleString("pt-BR");
  const brl = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const brlCurto = (v) => (Math.abs(v) >= 1e6 ? `R$ ${(v / 1e6).toFixed(1).replace(".", ",")} mi` : Math.abs(v) >= 1e4 ? `R$ ${Math.round(v / 1e3)} mil` : brl(v));
  const dm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—");
  const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");

  const hoje = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  function opcoesMes() {
    const [a, m] = hoje().split("-").map(Number);
    const out = [];
    for (let i = 0; i < 24; i++) {
      const d = new Date(a, m - 1 - i, 1);
      const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      out.push([v, d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })]);
    }
    return out;
  }
  function opcoesAno() {
    const a = Number(hoje().slice(0, 4));
    return [0, 1, 2, 3].map((i) => [String(a - i), String(a - i)]);
  }
  const OPCOES_DIAS = [["7", "Últimos 7 dias"], ["15", "Últimos 15 dias"], ["30", "Últimos 30 dias"], ["60", "Últimos 60 dias"], ["90", "Últimos 90 dias"]];
  function opcoesRef(tipo) {
    return tipo === "ano" ? opcoesAno() : tipo === "dias" ? OPCOES_DIAS : opcoesMes();
  }
  function refPadrao(tipo) {
    return tipo === "ano" ? hoje().slice(0, 4) : tipo === "dias" ? "30" : hoje().slice(0, 7);
  }

  // ---------- dados ----------
  async function buscar(url, { forcar = false, ttl = 60_000 } = {}) {
    const c = cache.get(url);
    if (!forcar && c && Date.now() - c.em < ttl) return c.dado;
    carregando++;
    try {
      const dado = await ctx.api(url);
      cache.set(url, { em: Date.now(), dado });
      return dado;
    } finally {
      carregando--;
    }
  }
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== "" && v != null && v !== "todos")).toString();

  // ---------- casca ----------
  function casca() {
    host.innerHTML = `<div class="rk-raiz">
      <div class="rk-abas" id="rk-abas"></div>
      <div id="rk-corpo"></div>
    </div>`;
    host.querySelector("#rk-abas").addEventListener("click", (e) => {
      const b = e.target.closest("[data-rk-aba]");
      if (!b) return;
      S.aba = b.dataset.rkAba;
      salvar();
      desenhar();
    });
    host.querySelector("#rk-corpo").addEventListener("click", aoClicar);
    host.querySelector("#rk-corpo").addEventListener("change", aoMudar);
    host.querySelector("#rk-corpo").addEventListener("input", aoDigitar);
  }

  function salvar() {
    for (const k of ["aba", "tipo", "canal", "ordem", "cmpModo", "alDias", "alBase", "alMin"]) ctx.salvarPref(`rk_${k}`, String(S[k]));
    ctx.salvarPref("rk_dias", String(S.alDias)); // o selo do menu usa estes
    ctx.salvarPref("rk_base", String(S.alBase));
    ctx.salvarPref("rk_min", String(S.alMin));
  }
  function restaurar() {
    S.aba = ctx.lerPref("rk_aba", "ranking");
    S.tipo = ctx.lerPref("rk_tipo", "mes");
    S.canal = ctx.lerPref("rk_canal", "todos");
    S.ordem = ctx.lerPref("rk_ordem", "qtd");
    S.cmpModo = ctx.lerPref("rk_cmpModo", "canais");
    S.alDias = Number(ctx.lerPref("rk_alDias", "7")) || 7;
    S.alBase = Number(ctx.lerPref("rk_alBase", "60")) || 60;
    S.alMin = Number(ctx.lerPref("rk_alMin", "3")) || 3;
    if (!S.ref) S.ref = refPadrao(S.tipo);
  }

  function desenharAbas() {
    const abas = [
      ["ranking", "🏆 Ranking"],
      ["comparar", "⚖ Comparar"],
      ["alertas", "⚠ Sem vendas"],
    ];
    host.querySelector("#rk-abas").innerHTML = abas
      .map(([id, nome]) => `<button type="button" class="rk-aba ${S.aba === id ? "ativa" : ""}" data-rk-aba="${id}">${nome}${id === "alertas" && alertasN ? `<span class="rk-n">${alertasN}</span>` : ""}</button>`)
      .join("");
  }

  function barraFiltros({ periodo = true, canal = true, ordem = true, busca = true } = {}) {
    const seg = (grupo, itens, atual) =>
      `<div class="rk-seg" data-grupo="${grupo}">${itens.map(([v, n]) => `<button type="button" data-v="${v}" class="${atual === v ? "ativo" : ""}">${n}</button>`).join("")}</div>`;
    return `<div class="rk-filtros">
      ${
        periodo
          ? `${seg("tipo", [["mes", "Mensal"], ["ano", "Anual"], ["dias", "Últimos dias"]], S.tipo)}
             <select data-rk-ref>${opcoesRef(S.tipo).map(([v, n]) => `<option value="${v}" ${v === S.ref ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>`
          : ""
      }
      ${canal ? seg("canal", [["todos", "Todos"], ["shopee", "Shopee"], ["ml", "Mercado Livre"]], S.canal) : ""}
      ${ordem ? seg("ordem", [["qtd", "Unidades"], ["valor", "Faturamento"]], S.ordem) : ""}
      ${busca ? `<input type="search" data-rk-busca placeholder="Buscar produto ou SKU" value="${esc(S.busca)}">` : ""}
    </div>`;
  }

  function textoCobertura(cob) {
    if (!cob) return "";
    const partes = [];
    for (const [canal, nome] of [["shopee", "Shopee"], ["ml", "Mercado Livre"]]) {
      const f = cob.canais?.[canal];
      const contas = (cob.contas || []).filter((c) => c.canal === canal);
      if (!contas.length) continue;
      const andamento = contas.filter((c) => !c.concluido);
      const pct = andamento.length ? Math.min(...andamento.map((c) => c.progresso)) : 100;
      partes.push(
        `<b>${nome}</b>: ${f ? `vendas desde ${dmy(f.de)}` : "ainda sem vendas coletadas"}${andamento.length ? ` · <span style="color:#b45309">buscando o histórico… ${pct}%</span>` : ""}`
      );
    }
    const erros = (cob.contas || []).filter((c) => c.erro);
    const ml = cob.ml?.pausado
      ? `<div class="rk-aviso" style="margin-bottom:6px">🛡 <b>Mercado Livre fora do ranking</b> — ${
          cob.ml.ate ? `pausa de segurança até ${new Date(cob.ml.ate).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} (${esc(cob.ml.motivo)})` : "a coleta de vendas do ML está desligada (variável RANKING_ML=off no Render). Por enquanto o ranking mostra só a Shopee."
        }</div>`
      : "";
    return `${ml}${partes.join(" · ")}${
      erros.length ? ` · <span style="color:#b91c1c" title="${esc(erros.map((c) => `${c.conta}: ${c.erro}`).join(" | "))}">⚠ ${erros.length} conta(s) com erro na coleta</span>` : ""
    }`;
  }

  // ---------- desenhar ----------
  function desenhar() {
    desenharAbas();
    if (S.aba === "comparar") return desenharComparar();
    if (S.aba === "alertas") return desenharAlertas();
    return desenharRanking();
  }
  const corpo = () => host.querySelector("#rk-corpo");
  const carregandoHtml = (msg = "Calculando…") => `<div class="rk-vazio">${msg}</div>`;
  const erroHtml = (err) => `<div class="rk-aviso erro">Não deu para carregar: ${esc(err.message)}</div>`;

  // ----- Ranking -----
  async function desenharRanking(forcar = false) {
    const url = `/api/ranking?${qs({ tipo: S.tipo, ref: S.ref, canal: S.canal, ordem: S.ordem, busca: S.busca, limite: S.limite })}`;
    const usado = url;
    corpo().innerHTML = barraFiltros() + `<div id="rk-res">${cache.has(url) ? "" : carregandoHtml()}</div>`;
    try {
      const d = await buscar(url, { forcar });
      if (S.aba !== "ranking" || usado !== `/api/ranking?${qs({ tipo: S.tipo, ref: S.ref, canal: S.canal, ordem: S.ordem, busca: S.busca, limite: S.limite })}`) return;
      const res = corpo().querySelector("#rk-res");
      if (res) res.innerHTML = htmlRanking(d);
    } catch (err) {
      const res = corpo()?.querySelector("#rk-res");
      if (res) res.innerHTML = erroHtml(err);
    }
  }

  function seta(atual, anterior) {
    if (!anterior) return atual ? `<span class="rk-tend novo">novo</span>` : "";
    const pct = Math.round(((atual - anterior) / anterior) * 100);
    if (pct === 0) return `<span class="rk-tend igual">= igual</span>`;
    return `<span class="rk-tend ${pct > 0 ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%</span>`;
  }
  const diasAtras = (iso) => Math.round((Date.parse(`${hoje()}T12:00:00Z`) - Date.parse(`${iso}T12:00:00Z`)) / 864e5);
  function ultimaTxt(iso) {
    if (!iso) return "—";
    const d = diasAtras(iso);
    return d <= 0 ? "hoje" : d === 1 ? "ontem" : `${dm(iso)} (${d}d)`;
  }

  function htmlRanking(d) {
    const t = d.total;
    const p = d.periodo;
    const totUn = t.qtdShopee + t.qtdMl || 1;
    const aviso =
      p.anteriorCoberto === false
        ? `<div class="rk-aviso">O histórico coletado ainda não chega ao período anterior (${dm(p.anterior.de)} a ${dm(p.anterior.ate)}), por isso não há setas de comparação por enquanto.</div>`
        : p.parcial
          ? `<div class="rk-aviso">Período em andamento: a seta compara com o mesmo número de dias do período anterior (${dm(p.anterior.de)} a ${dm(p.anterior.ate)}).</div>`
          : "";
    const cards = `<div class="rk-cards">
      <div class="rk-card"><span class="rk-card-r">Unidades vendidas</span><span class="rk-card-n">${int(t.qtd)}</span><span class="rk-card-s">${int(t.pedidos)} pedidos</span></div>
      <div class="rk-card"><span class="rk-card-r">Faturamento</span><span class="rk-card-n">${brlCurto(t.valor)}</span><span class="rk-card-s">só produtos, sem frete</span></div>
      <div class="rk-card"><span class="rk-card-r">Produtos vendidos</span><span class="rk-card-n">${int(t.produtos)}</span><span class="rk-card-s">${p.rotulo ? esc(rotuloPeriodo(p)) : ""}</span></div>
      <div class="rk-card"><span class="rk-card-r">Shopee × Mercado Livre</span>
        <div class="rk-div"><span class="rk-sp" style="width:${(100 * t.qtdShopee) / totUn}%"></span><span class="rk-ml" style="width:${(100 * t.qtdMl) / totUn}%"></span></div>
        <span class="rk-card-s"><b style="color:#c2410c">${int(t.qtdShopee)}</b> Shopee · <b style="color:#a16207">${int(t.qtdMl)}</b> ML (unidades)</span></div>
    </div>`;
    if (!d.itens.length) {
      return `${aviso}${cards}<div class="rk-vazio">Nenhuma venda encontrada neste período${S.busca ? " para essa busca" : ""}.<br><span class="small">${textoCobertura(d.cobertura)}</span></div>`;
    }
    const maxQ = Math.max(...d.itens.map((i) => (S.ordem === "valor" ? i.valor : i.qtd)), 1);
    const linhas = d.itens
      .map((i) => {
        const medalha = i.pos === 1 ? "🥇" : i.pos === 2 ? "🥈" : i.pos === 3 ? "🥉" : i.pos;
        const base = S.ordem === "valor" ? i.valor : i.qtd;
        const un = i.qtdShopee + i.qtdMl || 1;
        return `<tr>
          <td class="rk-pos ${i.pos <= 3 ? "top" : ""}">${medalha}</td>
          <td class="rk-prod"><b title="${esc(i.titulo)}">${esc(i.titulo)}</b>${i.sku ? `<small>${esc(i.sku)}</small>` : ""}</td>
          <td class="d rk-num">${int(i.qtd)}</td>
          <td class="d rk-num">${brl(i.valor)}</td>
          <td style="min-width:110px"><div class="rk-bar"><i style="width:${(100 * base) / maxQ}%"></i></div><small style="color:var(--muted);font-size:11px">${t.qtd ? ((100 * i.qtd) / t.qtd).toFixed(1).replace(".", ",") : 0}% das unidades</small></td>
          <td class="rk-canais"><div class="rk-div"><span class="rk-sp" style="width:${(100 * i.qtdShopee) / un}%"></span><span class="rk-ml" style="width:${(100 * i.qtdMl) / un}%"></span></div>
            <small><span class="s">Shopee ${int(i.qtdShopee)}</span><span class="m">ML ${int(i.qtdMl)}</span></small></td>
          <td>${p.anteriorCoberto === false ? '<span class="rk-tend igual" title="Ainda não há histórico do período anterior">—</span>' : seta(i.qtd, i.anterior)}</td>
          <td style="white-space:nowrap;color:var(--muted);font-size:12px">${ultimaTxt(i.ultimaVenda)}</td>
        </tr>`;
      })
      .join("");
    return `${aviso}${cards}
      <table class="rk-tabela"><thead><tr><th>#</th><th>Produto</th><th class="d">Unid.</th><th class="d">Faturamento</th><th>Peso no total</th><th>Canais</th><th>vs. anterior</th><th>Última venda</th></tr></thead><tbody>${linhas}</tbody></table>
      ${d.itens.length >= S.limite && S.limite < 500 ? `<button type="button" class="btn btn-ghost btn-sm rk-mais" data-rk-mais>Mostrar mais</button>` : ""}
      <div class="rk-cobertura">${textoCobertura(d.cobertura)}</div>`;
  }
  const rotuloPeriodo = (p) => {
    if (p.tipo === "mes") return new Date(`${p.ref}-15T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    return p.rotulo;
  };

  // ----- Comparar -----
  async function desenharComparar(forcar = false) {
    const modos = `<div class="rk-sub"><div class="rk-seg" data-grupo="cmpModo">
        <button type="button" data-v="canais" class="${S.cmpModo === "canais" ? "ativo" : ""}">Shopee × Mercado Livre</button>
        <button type="button" data-v="periodos" class="${S.cmpModo === "periodos" ? "ativo" : ""}">Período × período</button></div>
      ${S.cmpModo === "canais" ? `<label class="rk-ajuste"><input type="checkbox" data-rk-dois ${S.soNosDois ? "checked" : ""}> só quem vende nos dois</label>` : ""}</div>`;
    if (S.cmpModo === "periodos") {
      const refs = opcoesRef(S.tipo);
      const url = `/api/ranking/comparar?${qs({ tipo: S.tipo, a: S.ref, b: S.cmpB, canal: S.canal, busca: S.busca, limite: 200 })}`;
      corpo().innerHTML = `${modos}${barraFiltros({ ordem: false })}
        <div class="rk-ajuste">Comparar com: <select data-rk-cmpb><option value="">Período anterior (mesmos dias)</option>${refs.filter(([v]) => v !== S.ref).map(([v, n]) => `<option value="${v}" ${v === S.cmpB ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>
        <div id="rk-res">${cache.has(url) ? "" : carregandoHtml()}</div>`;
      try {
        const d = await buscar(url, { forcar });
        const res = corpo()?.querySelector("#rk-res");
        if (res && S.aba === "comparar" && S.cmpModo === "periodos") res.innerHTML = htmlPeriodos(d);
      } catch (err) {
        const res = corpo()?.querySelector("#rk-res");
        if (res) res.innerHTML = erroHtml(err);
      }
      return;
    }
    const url = `/api/ranking?${qs({ tipo: S.tipo, ref: S.ref, canal: "", ordem: S.ordem, busca: S.busca, limite: 300 })}`;
    corpo().innerHTML = `${modos}${barraFiltros({ canal: false })}<div id="rk-res">${cache.has(url) ? "" : carregandoHtml()}</div>`;
    try {
      const d = await buscar(url, { forcar });
      const res = corpo()?.querySelector("#rk-res");
      if (res && S.aba === "comparar" && S.cmpModo === "canais") res.innerHTML = htmlCanais(d);
    } catch (err) {
      const res = corpo()?.querySelector("#rk-res");
      if (res) res.innerHTML = erroHtml(err);
    }
  }

  function htmlCanais(d) {
    const t = d.total;
    let itens = d.itens;
    if (S.soNosDois) itens = itens.filter((i) => i.qtdShopee > 0 && i.qtdMl > 0);
    const resumo = `<div class="rk-cards" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <div class="rk-card" style="border-left:5px solid #ee4d2d"><span class="rk-card-r">Shopee</span><span class="rk-card-n">${int(t.qtdShopee)} <small style="font-size:13px;color:var(--muted)">unid.</small></span><span class="rk-card-s">${brl(t.valorShopee)}</span></div>
      <div class="rk-card" style="border-left:5px solid #ffd400"><span class="rk-card-r">Mercado Livre</span><span class="rk-card-n">${int(t.qtdMl)} <small style="font-size:13px;color:var(--muted)">unid.</small></span><span class="rk-card-s">${brl(t.valorMl)}</span></div>
    </div>`;
    if (!itens.length) return `${resumo}<div class="rk-vazio">Nada para comparar com esse filtro.</div>`;
    const max = Math.max(...itens.map((i) => Math.max(i.qtdShopee, i.qtdMl)), 1);
    const linhas = itens
      .map((i) => {
        const dif = i.qtdShopee - i.qtdMl;
        const vende = i.qtdShopee && i.qtdMl ? (dif === 0 ? "empate" : dif > 0 ? "shopee" : "ml") : i.qtdShopee ? "so-shopee" : "so-ml";
        const chip = { shopee: '<span class="rk-chip shopee">vende mais na Shopee</span>', ml: '<span class="rk-chip ml">vende mais no ML</span>', empate: '<span class="rk-chip">empate</span>', "so-shopee": '<span class="rk-chip shopee">só na Shopee</span>', "so-ml": '<span class="rk-chip ml">só no ML</span>' }[vende];
        return `<tr>
          <td class="rk-prod"><b title="${esc(i.titulo)}">${esc(i.titulo)}</b>${i.sku ? `<small>${esc(i.sku)}</small>` : ""}</td>
          <td class="d rk-num" style="color:#c2410c">${int(i.qtdShopee)}</td>
          <td><div class="rk-vs"><div class="e"><i style="width:${(100 * i.qtdShopee) / max}%"></i></div><div class="d"><i style="width:${(100 * i.qtdMl) / max}%"></i></div></div></td>
          <td class="rk-num" style="color:#a16207">${int(i.qtdMl)}</td>
          <td class="d rk-num" style="color:var(--muted)">${brl(i.valorShopee)}</td>
          <td class="d rk-num" style="color:var(--muted)">${brl(i.valorMl)}</td>
          <td>${chip}</td></tr>`;
      })
      .join("");
    return `${resumo}<table class="rk-tabela"><thead><tr><th>Produto</th><th class="d">Shopee</th><th></th><th>Mercado Livre</th><th class="d">R$ Shopee</th><th class="d">R$ ML</th><th>Onde vende mais</th></tr></thead><tbody>${linhas}</tbody></table>
      <div class="rk-cobertura">O mesmo produto nos dois canais é ligado pelo SKU (anúncio sem SKU não se junta). Período: ${esc(rotuloPeriodo(d.periodo))}.</div>`;
  }

  function htmlPeriodos(d) {
    if (!d.itens.length) return `<div class="rk-vazio">Nenhuma venda nesses períodos.</div>`;
    const max = Math.max(...d.itens.map((i) => Math.max(i.qtdA, i.qtdB)), 1);
    const linhas = d.itens
      .map((i) => {
        const dif = i.qtdA - i.qtdB;
        const pct = i.qtdB ? Math.round((dif / i.qtdB) * 100) : null;
        return `<tr>
          <td class="rk-prod"><b title="${esc(i.titulo)}">${esc(i.titulo)}</b>${i.sku ? `<small>${esc(i.sku)}</small>` : ""}</td>
          <td class="d rk-num">${int(i.qtdA)}</td><td class="d rk-num" style="color:var(--muted)">${int(i.qtdB)}</td>
          <td class="d rk-num"><span class="rk-tend ${dif > 0 ? "up" : dif < 0 ? "down" : "igual"}">${dif > 0 ? "+" : ""}${int(dif)}</span></td>
          <td class="d">${pct === null ? '<span class="rk-tend novo">novo</span>' : `<span class="rk-tend ${pct > 0 ? "up" : pct < 0 ? "down" : "igual"}">${pct > 0 ? "▲" : pct < 0 ? "▼" : "="} ${Math.abs(pct)}%</span>`}</td>
          <td style="min-width:140px"><div class="rk-bar"><i style="width:${(100 * i.qtdA) / max}%"></i></div><div class="rk-bar" style="margin-top:3px"><i style="width:${(100 * i.qtdB) / max}%;background:#cbd5e1"></i></div></td>
          <td class="d rk-num" style="color:var(--muted)">${brl(i.valorA)} <small>/ ${brl(i.valorB)}</small></td></tr>`;
      })
      .join("");
    const semB = d.b.coberto === false ? `<div class="rk-aviso">O período B começa antes do histórico coletado: os produtos "novos" e as diferenças podem estar exagerados.</div>` : "";
    return `${semB}<div class="rk-aviso" style="background:#f5f3ff;border-color:#ddd6fe;color:#5b21b6"><b>A</b> = ${esc(d.a.rotulo)} (${dm(d.a.de)} a ${dm(d.a.ate)}) · <b>B</b> = ${esc(d.b.rotulo)} (${dm(d.b.de)} a ${dm(d.b.ate)}). Ordenado pela maior diferença.</div>
      <table class="rk-tabela"><thead><tr><th>Produto</th><th class="d">A</th><th class="d">B</th><th class="d">Dif.</th><th class="d">%</th><th>A (roxo) × B (cinza)</th><th class="d">R$ A / R$ B</th></tr></thead><tbody>${linhas}</tbody></table>
      <div class="rk-cobertura">${textoCobertura(d.cobertura)}</div>`;
  }

  // ----- Alertas -----
  async function desenharAlertas(forcar = false) {
    const url = `/api/ranking/alertas?${qs({ dias: S.alDias, base: S.alBase, min: S.alMin, canal: S.canal, status: 1 })}`;
    corpo().innerHTML = `<div class="rk-filtros">
        <div class="rk-ajuste">Sem vender há <input class="rk-inp" type="number" min="1" max="90" value="${S.alDias}" data-rk-al="alDias"> dias, mas vendia pelo menos
          <input class="rk-inp" type="number" min="1" value="${S.alMin}" data-rk-al="alMin"> un. nos
          <input class="rk-inp" type="number" min="7" max="180" value="${S.alBase}" data-rk-al="alBase"> dias antes</div>
        <div class="rk-seg" data-grupo="canal">${[["todos", "Todos"], ["shopee", "Shopee"], ["ml", "Mercado Livre"]].map(([v, n]) => `<button type="button" data-v="${v}" class="${S.canal === v ? "ativo" : ""}">${n}</button>`).join("")}</div>
        <div class="rk-seg" data-grupo="alFiltro">${[["todos", "Todos"], ["problema", "Pausado / sem estoque"], ["ativo", "Ativos"]].map(([v, n]) => `<button type="button" data-v="${v}" class="${S.alFiltro === v ? "ativo" : ""}">${n}</button>`).join("")}</div>
        <button type="button" class="btn btn-ghost btn-sm" data-rk-recarregar>⟳ Conferir de novo</button>
      </div><div id="rk-res">${cache.has(url) ? "" : carregandoHtml("Conferindo vendas e situação dos anúncios…")}</div>`;
    try {
      const d = await buscar(url, { forcar, ttl: 5 * 60_000 });
      if (S.canal === "todos") {
        alertasN = d.itens.length;
        desenharAbas();
        ctx.definirBadge?.(alertasN);
      }
      const res = corpo()?.querySelector("#rk-res");
      if (res && S.aba === "alertas") res.innerHTML = htmlAlertas(d);
    } catch (err) {
      const res = corpo()?.querySelector("#rk-res");
      if (res) res.innerHTML = erroHtml(err);
    }
  }

  const grupoAlerta = (a) => {
    const cores = (a.itens || []).map((i) => i.cor).filter(Boolean);
    if (cores.some((c) => c === "vermelho" || c === "laranja")) return "problema";
    if (cores.length && cores.every((c) => c === "verde")) return "ativo";
    return "outro";
  };

  function htmlAlertas(d) {
    const susp = (d.suspensas || []).length
      ? `<div class="rk-aviso">Conta(s) sem atualização recente, por isso ficaram fora dos alertas: ${esc(d.suspensas.map((s) => `${s.canal === "ml" ? "ML" : "Shopee"} ${s.conta}`).join(", "))}. Ela volta sozinha assim que o painel conseguir buscar as vendas.</div>`
      : "";
    const todos = d.itens;
    const nProb = todos.filter((a) => grupoAlerta(a) === "problema").length;
    const nAtivo = todos.filter((a) => grupoAlerta(a) === "ativo").length;
    const lista = todos.filter((a) => S.alFiltro === "todos" || (S.alFiltro === "problema" ? grupoAlerta(a) === "problema" : grupoAlerta(a) !== "problema"));
    if (!todos.length) {
      return `${susp}<div class="rk-vazio">✓ Nenhum produto parou de vender nesse critério.<br><span class="small">Hoje vale: sem vender há ${d.parametros.dias} dias, mas vendia ${d.parametros.min}+ un. nos ${d.parametros.base} dias antes. Dá para afrouxar ou apertar nos campos acima.</span></div>`;
    }
    const resumo = `<div class="rk-cobertura"><b>${todos.length}</b> produto(s) parado(s): <b style="color:#b91c1c">${nProb}</b> com anúncio pausado/sem estoque/fora do ar · <b style="color:#b45309">${nAtivo}</b> com anúncio ativo (vale revisar preço e concorrência)${
      todos.length > 40 ? " · a situação do anúncio foi conferida nos 40 que mais vendiam" : ""
    }</div>`;
    const cards = lista
      .map((a) => {
        const g = grupoAlerta(a);
        const chips = (a.itens || [])
          .slice(0, 5)
          .map(
            (i) => `<div class="rk-item">
              ${i.situacao ? `<span class="rk-st ${i.cor || "cinza"}" title="${esc(i.detalhe || "")}">${esc(i.situacao)}</span>` : '<span class="rk-st cinza">sem consulta</span>'}
              <span class="conta">${esc(i.conta || "")}</span>
              ${i.estoque != null ? `<span class="conta">estoque ${int(i.estoque)}</span>` : ""}
              ${i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener">abrir anúncio ↗</a>` : ""}
              <button type="button" data-rk-copiar="${esc(i.produtoId)}" title="Copiar o ID do anúncio">copiar ID</button>
            </div>`
          )
          .join("");
        const mais = (a.itens || []).length > 5 ? `<div class="rk-item conta">+ ${(a.itens || []).length - 5} anúncio(s)</div>` : "";
        return `<div class="rk-alerta ${g}">
          <div><h4>${esc(a.titulo)}</h4>
            <div class="meta"><span class="rk-chip ${a.canal === "ml" ? "ml" : "shopee"}">${a.canal === "ml" ? "Mercado Livre" : "Shopee"}</span> ${a.sku ? `<span style="font-family:ui-monospace,Menlo,monospace">${esc(a.sku)}</span> · ` : ""}
              sem vender há <b>${a.diasSemVender} dia${a.diasSemVender === 1 ? "" : "s"}</b> (última venda ${dmy(a.ultimaVenda)})<br>
              vendia <b>${int(a.qtdBase)} un.</b> nos ${d.parametros.base} dias antes (~${String(a.mediaDia).replace(".", ",")} por dia)</div></div>
          <div class="rk-itens">${chips}${mais}</div></div>`;
      })
      .join("");
    return `${susp}${resumo}<div class="rk-alertas">${cards || '<div class="rk-vazio">Nenhum neste filtro.</div>'}</div>`;
  }

  // ---------- eventos ----------
  function aoClicar(e) {
    const seg = e.target.closest(".rk-seg button");
    if (seg) {
      const grupo = seg.closest(".rk-seg").dataset.grupo;
      const v = seg.dataset.v;
      if (grupo === "tipo") {
        S.tipo = v;
        S.ref = refPadrao(v);
        S.cmpB = "";
      } else if (grupo === "canal") S.canal = v;
      else if (grupo === "ordem") S.ordem = v;
      else if (grupo === "cmpModo") S.cmpModo = v;
      else if (grupo === "alFiltro") S.alFiltro = v;
      S.limite = 100;
      salvar();
      return desenhar();
    }
    if (e.target.closest("[data-rk-mais]")) {
      S.limite = Math.min(S.limite + 100, 500);
      return desenharRanking();
    }
    if (e.target.closest("[data-rk-recarregar]")) return desenharAlertas(true);
    const cp = e.target.closest("[data-rk-copiar]");
    if (cp) {
      navigator.clipboard?.writeText(cp.dataset.rkCopiar).catch(() => {});
      ctx.avisoRapido?.(`ID do anúncio copiado: <b>${esc(cp.dataset.rkCopiar)}</b>`, 3500);
    }
  }
  function aoMudar(e) {
    const t = e.target;
    if (t.matches("[data-rk-ref]")) {
      S.ref = t.value;
      S.limite = 100;
      return desenhar();
    }
    if (t.matches("[data-rk-cmpb]")) {
      S.cmpB = t.value;
      return desenhar();
    }
    if (t.matches("[data-rk-dois]")) {
      S.soNosDois = t.checked;
      return desenhar();
    }
    if (t.matches("[data-rk-al]")) {
      const v = Math.max(1, Number(t.value) || 1);
      S[t.dataset.rkAl] = v;
      salvar();
      return desenharAlertas(true);
    }
  }
  let digitando = null;
  function aoDigitar(e) {
    if (!e.target.matches("[data-rk-busca]")) return;
    S.busca = e.target.value;
    S.limite = 100;
    clearTimeout(digitando);
    digitando = setTimeout(() => {
      const pos = e.target.selectionStart;
      desenhar();
      const novo = corpo()?.querySelector("[data-rk-busca]");
      if (novo) {
        novo.focus();
        novo.setSelectionRange(pos, pos);
      }
    }, 350);
  }

  // ---------- API publica ----------
  window.RankingUI = {
    // Chamado pelo shopee.js a cada render da aba.
    montar(el, c) {
      if (!ctx) {
        const st = document.createElement("style");
        st.textContent = CSS;
        document.head.appendChild(st);
      }
      ctx = c;
      if (!S.ref) restaurar();
      if (host !== el || !el.querySelector(".rk-raiz")) {
        host = el;
        casca();
        desenhar();
      }
    },
    recarregar() {
      if (!host) return;
      cache.clear();
      desenhar();
    },
  };
})();
