// Prazos de despacho (coleta / agencia / Flex) — tela + alertas.
//
// Separado do app.js de proposito: se o index.html publicado ainda nao tiver
// o #prazos-pane (arquivos subidos em momentos diferentes no GitHub), este
// script simplesmente nao faz nada e o resto do painel segue funcionando.
//
// Layout: cartoes de resumo no topo (clicaveis) + uma visao por vez —
// "A imprimir" (3 colunas por modalidade), "Atrasados" (agrupados por idade),
// "Impressos" e "Proximos dias". Atrasado e a imprimir nunca dividem a tela:
// com muitos atrasados antigos, a lista do que ainda da tempo de imprimir
// sumia la embaixo (pedido do usuario em 06/10).
(function () {
  const pane = document.getElementById("prazos-pane");
  if (!pane) return;

  const $ = (id) => document.getElementById(id);
  // IDs reaproveitados do index.html da fase 2 (assim so este arquivo e o
  // style.css precisam subir): #prazos-atrasados vira o topo (resumo + abas)
  // e #prazos-colunas o corpo da visao escolhida.
  const topoEl = $("prazos-atrasados");
  const corpoEl = $("prazos-colunas");
  const statusEl = $("prazos-status");
  const contaSel = $("prazos-conta");
  const somBtn = $("prazos-som");
  const configForm = $("prazos-config");
  const badge = $("module-badge-prazos");

  topoEl.className = "prazos-topo";

  const relBtn = document.createElement("button");
  relBtn.type = "button";
  relBtn.className = "btn btn-ghost btn-sm";
  relBtn.textContent = "📄 Relatório do dia";
  relBtn.title = "Relatório detalhado de atrasos de um dia (imprimir/PDF ou planilha)";
  $("prazos-config-btn").before(relBtn);
  relBtn.addEventListener("click", () => abrirRelatorio(visao === "calendario" && calDia ? calDia : diaSP(new Date())));
  corpoEl.className = "prazos-corpo";

  const POLL_MS = 30_000;
  const MODALIDADES = [
    { id: "coleta", nome: "Coleta", lts: ["cross_docking"] },
    { id: "agencia", nome: "Agência", lts: ["xd_drop_off", "drop_off"] },
    { id: "flex", nome: "Flex", lts: [] },
  ];
  const NOME_MODALIDADE = { coleta: "Coleta", agencia: "Agência", flex: "Flex" };
  const SITUACAO = {
    atrasado: { rotulo: "Atrasado", ordem: 0 },
    estourou: { rotulo: "Passou do limite", ordem: 1 },
    risco: { rotulo: "Em risco", ordem: 2 },
    no_prazo: { rotulo: "No prazo", ordem: 3 },
    sem_prazo: { rotulo: "Sem prazo", ordem: 4 },
    impresso: { rotulo: "Impresso", ordem: 5 },
    proximos: { rotulo: "Próximos dias", ordem: 6 },
    // So no calendario (historico):
    tarde: { rotulo: "Impresso após o limite", ordem: 2 },
    cancelado: { rotulo: "Cancelado", ordem: 8 },
  };
  const PENDENTE = new Set(["estourou", "risco", "no_prazo", "sem_prazo"]);
  const VISOES = [
    { id: "imprimir", nome: "A imprimir" },
    { id: "atrasados", nome: "Atrasados" },
    { id: "impressos", nome: "Impressos" },
    { id: "proximos", nome: "Próximos dias" },
    { id: "calendario", nome: "Calendário" },
  ];

  let dados = null;
  let visivel = false;
  const tituloOriginal = document.title;

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch { /* sem storage: so nao lembra */ }
  }

  let visao = VISOES.some((v) => v.id === lsGet("prazos.visao")) ? lsGet("prazos.visao") : "imprimir";
  let alertasAtivos = lsGet("prazos.alertas") === "1";
  // shippingId:situacao ja avisados — um pedido avisa de novo so quando piora.
  const avisados = new Set();

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const TZ = "America/Sao_Paulo";
  const fmtHora = (iso) =>
    iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "—";
  const fmtDiaHora = (iso) =>
    iso
      ? new Date(iso).toLocaleString("pt-BR", {
          weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ,
        })
      : "—";
  const diaSP = (d) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  function dur(min) {
    if (min >= 2880) return `${Math.floor(min / 1440)} dias`;
    if (min >= 60) return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
    return `${min} min`;
  }
  function fmtFalta(iso) {
    if (!iso) return "";
    const min = Math.round((Date.parse(iso) - Date.now()) / 60000);
    return min >= 0 ? `faltam ${dur(min)}` : `passou há ${dur(-min)}`;
  }

  // Dias corridos (em Sao Paulo) entre o prazo e hoje: 0 = venceu hoje.
  function diasDeAtraso(e) {
    if (!e.prazo) return 0;
    const ms = Date.parse(diaSP(new Date())) - Date.parse(diaSP(new Date(e.prazo)));
    return Math.max(0, Math.round(ms / 86400000));
  }

  // O que exige acao hoje (selo do menu e titulo da aba). Atrasado de dias
  // atras fica de fora: sao pedidos travados, que nao mudam com mais aviso.
  const acionavel = (e) =>
    e.situacao === "risco" || e.situacao === "estourou" || (e.situacao === "atrasado" && diasDeAtraso(e) === 0);

  // ---------- Mostrar/esconder (o app.js cuida das outras telas) ----------
  document.querySelectorAll(".module-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      visivel = btn.dataset.module === "prazos";
      pane.classList.toggle("hidden", !visivel);
      if (visivel) render();
    });
  });

  // ---------- Dados ----------
  async function carregar({ forcar = false } = {}) {
    try {
      const res = await fetch(forcar ? "/api/prazos/atualizar" : "/api/prazos", {
        method: forcar ? "POST" : "GET",
      });
      if (res.status === 401) return; // sessao expirou: o app.js ja trata
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      dados = await res.json();
      atualizarFiltroContas();
      render();
      atualizarBadge();
      verificarAlertas();
    } catch (err) {
      statusEl.textContent = `Falha ao carregar: ${err.message}`;
    }
  }

  function enviosFiltrados() {
    const conta = contaSel.value;
    return (dados?.envios || []).filter((e) => !conta || e.sellerId === conta);
  }

  function atualizarFiltroContas() {
    const atual = contaSel.value;
    const opcoes = (dados?.contas || []).map(
      (c) => `<option value="${esc(c.sellerId)}">${esc(c.nickname)}</option>`
    );
    contaSel.innerHTML = `<option value="">Todas as contas</option>${opcoes.join("")}`;
    contaSel.value = atual;
  }

  // ---------- Render ----------
  // Visao "A imprimir" (pedido do usuario 06/10: "mais sofisticado", sem a
  // parede de linhas repetidas): linha do tempo do dia + um cartao por
  // modalidade (anel de progresso, contagem regressiva, barras por conta) +
  // detalhe da modalidade escolhida, agrupado por produto ou por pacote.
  let modSel = null; // modalidade aberta no detalhe (null = a mais urgente)
  let modoDetalhe = lsGet("prazos.modo") === "pacotes" ? "pacotes" : "produtos";
  // Produtos expandidos: a tela se redesenha a cada 30s e nao pode fechar
  // o que o operador abriu.
  const produtosAbertos = new Set();
  corpoEl.addEventListener(
    "toggle",
    (ev) => {
      const d = ev.target;
      if (!d.matches?.(".pz-produto")) return;
      if (d.open) produtosAbertos.add(d.dataset.chave);
      else produtosAbertos.delete(d.dataset.chave);
    },
    true
  );

  function render() {
    if (!dados || !visivel) return;
    const envios = enviosFiltrados();

    const erros = (dados.erros || [])
      .map((e) => `<span class="prazos-erro">⚠ ${esc(e.conta || "")}: ${esc(e.erro)}</span>`)
      .join(" ");
    statusEl.innerHTML =
      (dados.atualizadoEm
        ? `Atualizado às ${fmtHora(dados.atualizadoEm)} · busca automática a cada 3 min`
        : "Buscando no Mercado Livre...") + (erros ? `<br>${erros}` : "");

    const grupos = {
      imprimir: envios.filter((e) => PENDENTE.has(e.situacao)),
      atrasados: envios.filter((e) => e.situacao === "atrasado"),
      impressos: envios.filter((e) => e.situacao === "impresso"),
      proximos: envios.filter((e) => e.situacao === "proximos"),
    };
    topoEl.innerHTML = renderResumo(grupos) + renderAbas(grupos);

    const corpo = {
      imprimir: () => renderImprimir(grupos),
      atrasados: () => renderAtrasados(grupos.atrasados),
      impressos: () => renderImpressos(grupos),
      proximos: () => renderProximos(grupos.proximos),
      calendario: () => renderCalendario(),
    }[visao];
    corpoEl.innerHTML = corpo();
  }

  function renderResumo(g) {
    const conta = (s) => g.imprimir.filter((e) => e.situacao === s).length;
    const proxLimite = g.imprimir
      .filter((e) => e.situacao !== "estourou")
      .map((e) => e.limiteImpressao)
      .filter(Boolean)
      .sort()[0];
    const atrasHoje = g.atrasados.filter((e) => diasDeAtraso(e) === 0).length;
    const cartoes = [
      {
        visao: "imprimir", cls: "imprimir", n: g.imprimir.length, rotulo: "A imprimir",
        sub: proxLimite ? `próximo limite ${fmtHora(proxLimite)} · ${fmtFalta(proxLimite)}` : "nada com prazo hoje",
      },
      { visao: "imprimir", cls: "risco", n: conta("risco"), rotulo: "Em risco", sub: "menos de 1h para o limite" },
      { visao: "imprimir", cls: "estourou", n: conta("estourou"), rotulo: "Passou do limite", sub: "imprimir agora" },
      {
        visao: "atrasados", cls: "atrasado", n: g.atrasados.length, rotulo: "Atrasados",
        sub: `${atrasHoje} de hoje · ${g.atrasados.length - atrasHoje} antigos`,
      },
      { visao: "impressos", cls: "impresso", n: g.impressos.length, rotulo: "Impressos", sub: "aguardando despacho" },
    ];
    return `<div class="prazos-resumo">${cartoes
      .map(
        (c) => `<button type="button" class="prazos-kpi kpi-${c.cls}${c.n ? "" : " zerado"}" data-visao="${c.visao}">
          <span class="kpi-n">${c.n}</span>
          <span class="kpi-rotulo">${c.rotulo}</span>
          <span class="kpi-sub">${esc(c.sub)}</span>
        </button>`
      )
      .join("")}</div>`;
  }

  function renderAbas(g) {
    return `<div class="prazos-abas" role="tablist">${VISOES.map(
      (v) => `<button type="button" role="tab" class="prazos-aba aba-${v.id}${v.id === visao ? " ativa" : ""}" data-visao="${v.id}" aria-selected="${v.id === visao}">
        ${v.nome}${g[v.id] ? `<span class="prazos-aba-n">${g[v.id].length}</span>` : ""}</button>`
    ).join("")}</div>`;
  }

  // Clique nos cartoes/abas (delegado: o topo e recriado a cada render).
  topoEl.addEventListener("click", (ev) => {
    const alvo = ev.target.closest("[data-visao]");
    if (!alvo) return;
    visao = alvo.dataset.visao;
    lsSet("prazos.visao", visao);
    render();
  });

  // Cliques no corpo: escolher modalidade, trocar modo do detalhe.
  corpoEl.addEventListener("click", (ev) => {
    const rel = ev.target.closest("[data-relatorio]");
    if (rel) {
      if (rel.dataset.relatorio === "pdf") abrirRelatorio(calDia);
      else {
        carregarPeriodo(calDia, calDia)
          .then((d) => baixarCsv(linhasRelatorio(d.envios || []), calDia))
          .catch((err) => alert(`Não foi possível gerar a planilha: ${err.message}`));
      }
      return;
    }
    const alvo = ev.target.closest("[data-faixa],[data-cal-dia],[data-cal-mes],[data-cal-mod],[data-imp-mod]");
    if (alvo) {
      const d = alvo.dataset;
      if (d.impMod) impModSel = d.impMod;
      if (d.faixa) faixaSel = d.faixa;
      if (d.calDia) {
        calDia = d.calDia;
        calMes = d.calDia.slice(0, 7);
      }
      if (d.calMes) {
        const [a, m] = calMes.split("-").map(Number);
        const n = new Date(Date.UTC(a, m - 1 + Number(d.calMes), 1));
        calMes = n.toISOString().slice(0, 7);
      }
      if (d.calMod) calModSel = calModSel === d.calMod ? null : d.calMod;
      render();
      return;
    }
    const mod = ev.target.closest("[data-mod]");
    if (mod) {
      modSel = mod.dataset.mod;
      render();
      return;
    }
    const modo = ev.target.closest("[data-modo]");
    if (modo) {
      modoDetalhe = modo.dataset.modo;
      lsSet("prazos.modo", modoDetalhe);
      render();
    }
  });

  // ---------- Helpers de hora (minutos do dia em Sao Paulo) ----------
  function minutosSP(iso) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(iso))
        .map((x) => [x.type, x.value])
    );
    return +p.hour * 60 + +p.minute;
  }
  const hhmmParaMin = (s) => (/^\d{2}:\d{2}$/.test(s || "") ? +s.slice(0, 2) * 60 + +s.slice(3) : null);
  const minParaHhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  function nivelDe(itens, impressos) {
    if (itens.some((e) => e.situacao === "estourou")) return "estourou";
    if (itens.some((e) => e.situacao === "risco")) return "risco";
    if (itens.length) return "no_prazo";
    return impressos ? "concluido" : "vazio";
  }
  const ROTULO_NIVEL = {
    estourou: "Passou do limite",
    risco: "Em risco",
    no_prazo: "No prazo",
    concluido: "Tudo impresso",
    vazio: "Sem pedidos",
  };

  // Janelas de hoje por modalidade, de todas as contas visiveis.
  function janelasHoje(m) {
    const out = [];
    for (const c of dados.contas || []) {
      if (contaSel.value && c.sellerId !== contaSel.value) continue;
      for (const lt of m.lts) {
        if (!(lt in (c.janelasHoje || {}))) continue;
        out.push({ conta: c.nickname, j: c.janelasHoje[lt] });
      }
    }
    return out;
  }

  // ---------- Visao "A imprimir" ----------
  function renderImprimir(g) {
    const mods = MODALIDADES.map((m) => {
      const itens = g.imprimir.filter((e) => e.modalidade === m.id).sort(ordemUrgencia);
      const impressos = g.impressos.filter((e) => e.modalidade === m.id);
      return { ...m, itens, impressos, janelas: janelasHoje(m), nivel: nivelDe(itens, impressos.length) };
    }).filter((m) => m.itens.length || m.impressos.length || m.janelas.length);

    if (!mods.length) return '<p class="prazos-vazio grande">Nenhum pedido para imprimir hoje. ✓</p>';

    // Sem escolha do usuario (ou escolha sumiu): abre a mais urgente.
    const peso = { estourou: 0, risco: 1, no_prazo: 2, concluido: 3, vazio: 4 };
    if (!mods.some((m) => m.id === modSel)) {
      modSel = [...mods].sort(
        (a, b) =>
          peso[a.nivel] - peso[b.nivel] ||
          Date.parse(a.itens[0]?.limiteImpressao || "9999") - Date.parse(b.itens[0]?.limiteImpressao || "9999")
      )[0].id;
    }
    const sel = mods.find((m) => m.id === modSel);

    return `
      ${renderLinhaDoTempo(mods)}
      <div class="pz-cards">${mods.map(cardModalidade).join("")}</div>
      ${renderDetalhe(sel)}`;
  }

  // Linha do tempo do dia: uma faixa por modalidade, janela de coleta
  // sombreada, entrega na agencia como bandeira, limites de impressao como
  // bolhas com a quantidade e um marcador de "agora".
  // opts permite reaproveitar na visao "Impressos" (bolhas = horario de
  // saida em vez do limite de impressao).
  function renderLinhaDoTempo(mods, opts = {}) {
    const {
      campo = "limiteImpressao",
      itensDe = (m) => m.itens,
      sel = modSel,
      attr = "data-mod",
      legendaBolha = "limite de impressão",
      tituloBolha = (n, hh) => `${n} ${n === 1 ? "pacote" : "pacotes"} para imprimir até ${hh}`,
      vazio = (m) => (m.impressos.length ? "tudo impresso ✓" : "sem pedidos hoje"),
      nivelBolha = (b) =>
        b.itens.some((e) => e.situacao === "estourou") ? "estourou" : b.itens.some((e) => e.situacao === "risco") ? "risco" : "no_prazo",
    } = opts;
    const agora = minutosSP(new Date().toISOString());
    const marcos = [];
    const faixas = mods.map((m) => {
      const bolhas = new Map();
      for (const e of itensDe(m)) {
        if (!e[campo]) continue;
        const min = minutosSP(e[campo]);
        const b = bolhas.get(min) || { min, n: 0, itens: [] };
        b.n++;
        b.itens.push(e);
        bolhas.set(min, b);
        marcos.push(min);
      }
      const janelas = [];
      const bandeiras = new Map();
      for (const { conta, j } of m.janelas) {
        if (!j) continue;
        const de = hhmmParaMin(j.de);
        const ate = hhmmParaMin(j.ate);
        if (m.id === "coleta" && de != null && ate != null) {
          janelas.push({ de, ate, conta });
          marcos.push(de, ate);
        } else if (de != null) {
          const lista = bandeiras.get(de) || [];
          lista.push(conta);
          bandeiras.set(de, lista);
          marcos.push(de);
        }
      }
      return { m, bolhas: [...bolhas.values()], janelas, bandeiras: [...bandeiras.entries()] };
    });

    const ini = Math.max(0, Math.floor(Math.min(8 * 60, agora - 60, ...marcos.map((x) => x - 30)) / 60) * 60);
    const fim = Math.min(24 * 60, Math.ceil(Math.max(18 * 60, agora + 60, ...marcos.map((x) => x + 30)) / 60) * 60);
    const frac = (min) => ((Math.min(Math.max(min, ini), fim) - ini) / (fim - ini)).toFixed(4);
    const pos = (min) => `${(frac(min) * 100).toFixed(2)}%`;

    const horas = [];
    for (let h = ini; h <= fim; h += 60) horas.push(h);

    const linhas = faixas
      .map(({ m, bolhas, janelas, bandeiras }) => {
        return `
        <div class="pz-tl-faixa${m.id === sel ? " sel" : ""}" ${attr}="${m.id}">
          <div class="pz-tl-nome">${m.nome}</div>
          <div class="pz-tl-trilho">
            ${janelas
              .map(
                (j) => `<div class="pz-tl-janela" style="left:${pos(j.de)};width:calc(${pos(j.ate)} - ${pos(j.de)})"
                  title="${esc(j.conta)}: coleta ${minParaHhmm(j.de)}–${minParaHhmm(j.ate)}"><span>coleta ${minParaHhmm(j.de)}–${minParaHhmm(j.ate)}</span></div>`
              )
              .join("")}
            ${bandeiras
              .map(
                ([min, contas]) => `<div class="pz-tl-bandeira" style="left:${pos(min)}" title="Entregar na agência até ${minParaHhmm(min)}: ${esc(contas.join(", "))}">
                  ${bolhas.some((b) => Math.abs(b.min - min) < 20) ? "" : `<span>entrega ${minParaHhmm(min)}</span>`}</div>`
              )
              .join("")}
            ${bolhas
              .map(
                (b) => `<div class="pz-tl-bolha nivel-${nivelBolha(b)}" style="left:${pos(b.min)}"
                  title="${tituloBolha(b.n, minParaHhmm(b.min))}">
                  <b>${b.n}</b><span>${minParaHhmm(b.min)}</span></div>`
              )
              .join("")}
            ${!bolhas.length ? `<div class="pz-tl-ok">${vazio(m)}</div>` : ""}
          </div>
        </div>`;
      })
      .join("");

    return `
      <section class="pz-tl" aria-label="Linha do tempo de hoje">
        <div class="pz-tl-cabecalho">
          <span class="pz-titulo">Hoje</span>
          <span class="pz-legenda"><i class="lg-janela"></i>janela de coleta <i class="lg-bandeira"></i>entrega na agência <i class="lg-bolha"></i>${legendaBolha}</span>
        </div>
        <div class="pz-tl-corpo">
          <div class="pz-tl-grade">
            <div class="pz-tl-nome"></div>
            <div class="pz-tl-trilho pz-tl-horas">
              ${horas.map((h) => `<span style="left:${pos(h)}">${String(h / 60).padStart(2, "0")}h</span>`).join("")}
            </div>
          </div>
          ${linhas}
          <div class="pz-tl-passado" style="--x:${frac(agora)}"></div>
          <div class="pz-tl-agora" style="--x:${frac(agora)}"><span>agora ${minParaHhmm(agora)}</span></div>
        </div>
      </section>`;
  }

  // Janela de hoje + horario de corte de vendas, por conta (dados do ML).
  function janelasCartao(m) {
    if (m.id === "flex") {
      return `<div class="pz-card-janelas"><span><b>Limite do Flex</b> ${esc(dados.config?.flex?.limite || "—")} <small>(⚙ Ajustes)</small></span></div>`;
    }
    const linhas = (m.janelas || []).map(({ conta, j }) => {
      if (!j) return `<span><b>${esc(conta)}</b> não trabalha hoje</span>`;
      const janela = m.id === "coleta" ? `coleta ${j.de}–${j.ate}` : `entregar até ${j.de}`;
      return `<span><b>${esc(conta)}</b> ${janela}${j.corte ? ` · <em>vendas até ${esc(j.corte)}</em>` : ""}</span>`;
    });
    return linhas.length ? `<div class="pz-card-janelas">${linhas.join("")}</div>` : "";
  }

  function cardModalidade(m) {
    const total = m.itens.length + m.impressos.length;
    const pct = total ? Math.round((m.impressos.length / total) * 100) : 0;
    const prox = m.itens.map((e) => e.limiteImpressao).filter(Boolean).sort()[0];
    const min = prox ? Math.round((Date.parse(prox) - Date.now()) / 60000) : null;

    const porConta = new Map();
    for (const e of m.itens) porConta.set(e.conta, (porConta.get(e.conta) || 0) + 1);
    const contas = [...porConta.entries()].sort((a, b) => b[1] - a[1]);
    const maxConta = Math.max(1, ...contas.map((c) => c[1]));

    let relogio;
    if (min == null) relogio = `<div class="pz-relogio"><b>${m.itens.length ? "—" : "✓"}</b><span>${m.itens.length ? "sem prazo informado" : "nada pendente"}</span></div>`;
    else if (min < 0) relogio = `<div class="pz-relogio passou"><b>+${dur(-min)}</b><span>passou do limite das ${fmtHora(prox)}</span></div>`;
    else relogio = `<div class="pz-relogio"><b>${dur(min)}</b><span>para imprimir até ${fmtHora(prox)}</span></div>`;

    return `
      <button type="button" class="pz-card nivel-${m.nivel}${m.id === modSel ? " sel" : ""}" data-mod="${m.id}" aria-pressed="${m.id === modSel}">
        <div class="pz-card-topo">
          <span class="pz-card-nome">${m.nome}</span>
          <span class="pz-status nivel-${m.nivel}">${ROTULO_NIVEL[m.nivel]}</span>
        </div>
        <div class="pz-card-meio">
          <div class="pz-anel" style="--p:${pct}" role="img" aria-label="${pct}% impresso">
            <div><b>${m.itens.length}</b><span>a imprimir</span></div>
          </div>
          ${relogio}
        </div>
        ${janelasCartao(m)}
        <div class="pz-progresso-txt">${m.impressos.length} de ${total} impressos hoje · ${pct}%${(() => {
          const nf = m.itens.filter((e) => e.nfPendente).length;
          return nf ? `<br><span class="pz-nf-txt">${nf} aguardando nota fiscal — o ML só libera a etiqueta depois da NF</span>` : "";
        })()}</div>
        <div class="pz-contas">${
          contas.length
            ? contas
                .map(
                  ([nome, n]) => `<div class="pz-conta"><span class="pz-conta-nome">${esc(nome)}</span>
                    <span class="pz-conta-barra"><i style="width:${(n / maxConta) * 100}%"></i></span><b>${n}</b></div>`
                )
                .join("")
            : '<div class="pz-conta-vazio">Nenhuma conta com pendência</div>'
        }</div>
      </button>`;
  }

  // Detalhe: por produto (agrupa pacotes iguais) ou por pacote (tabela).
  // m: { nome, itens, ctx?, sub?, vazio?, modalidade?, colPrazo?, colGrupo? }
  function renderDetalhe(m) {
    const modos = `<div class="pz-seg" role="group" aria-label="Agrupar">
      <button type="button" data-modo="produtos" class="${modoDetalhe === "produtos" ? "on" : ""}">Por produto</button>
      <button type="button" data-modo="pacotes" class="${modoDetalhe === "pacotes" ? "on" : ""}">Por pacote</button>
    </div>`;
    const opcoes = { ctx: m.ctx || m.id, modalidade: m.modalidade, colPrazo: m.colPrazo, colGrupo: m.colGrupo };
    const corpo = !m.itens.length
      ? `<p class="prazos-vazio grande">${m.vazio || "Nada a imprimir nesta modalidade. ✓"}</p>`
      : modoDetalhe === "produtos"
      ? tabelaProdutos(m.itens, opcoes)
      : tabelaPacotes(m.itens, opcoes);
    return `
      <section class="pz-detalhe">
        <div class="pz-detalhe-topo">
          <div><span class="pz-titulo">${m.nome}</span> <span class="pz-sub">${m.itens.length} ${m.itens.length === 1 ? "pacote" : "pacotes"} ${m.sub || "a imprimir"}</span></div>
          ${modos}
        </div>
        ${corpo}
      </section>`;
  }

  function tabelaProdutos(itens, { ctx = "", modalidade = false, colPrazo, colGrupo } = {}) {
    const grupos = new Map();
    for (const e of itens) {
      for (const it of e.itens) {
        const chave = it.titulo || "(sem título)";
        const gr = grupos.get(chave) || { titulo: chave, un: 0, envios: new Map(), contas: new Set(), limite: null, pior: 9 };
        gr.un += it.qtd || 0;
        gr.envios.set(e.shippingId, e);
        gr.contas.add(e.conta);
        if (e.limiteImpressao && (!gr.limite || e.limiteImpressao < gr.limite)) gr.limite = e.limiteImpressao;
        gr.pior = Math.min(gr.pior, SITUACAO[e.situacao].ordem);
        grupos.set(chave, gr);
      }
    }
    const lista = [...grupos.values()].sort((a, b) => a.pior - b.pior || b.envios.size - a.envios.size);
    const situacaoPorOrdem = Object.fromEntries(Object.entries(SITUACAO).map(([k, v]) => [v.ordem, k]));
    return `<div class="pz-produtos">${lista
      .map((gr) => {
        const sit = situacaoPorOrdem[gr.pior];
        const vendas = [...gr.envios.values()];
        const chave = `${ctx}|${gr.titulo}`;
        const grupoCol = colGrupo
          ? colGrupo(vendas)
          : { b: gr.limite ? fmtHora(gr.limite) : "—", small: gr.limite ? fmtFalta(gr.limite) : "" };
        return `<details class="pz-produto sit-${sit}" data-chave="${esc(chave)}"${produtosAbertos.has(chave) ? " open" : ""}>
          <summary>
            <span class="pz-produto-qtd"><b>${gr.envios.size}</b><small>${gr.envios.size === 1 ? "pacote" : "pacotes"}</small></span>
            <span class="pz-produto-nome">${esc(gr.titulo)}<small>${esc([...gr.contas].join(" · "))}${(() => {
              const nf = vendas.filter((e) => e.nfPendente).length;
              return nf ? ` · <span class="pz-nf-txt">${nf} com NF pendente</span>` : "";
            })()}</small></span>
            <span class="pz-produto-un"><b>${gr.un}</b><small>unid.</small></span>
            <span class="pz-produto-limite"><b>${grupoCol.b}</b><small>${grupoCol.small}</small></span>
          </summary>
          ${tabelaPacotes(vendas, { compacta: true, modalidade, colPrazo })}
        </details>`;
      })
      .join("")}</div>`;
  }

  // Tabela de pacotes. colunas extras por visao (modalidade, prazo vencido...).
  function tabelaPacotes(lista, { compacta = false, modalidade = false, colPrazo } = {}) {
    const prazoCol = colPrazo || {
      titulo: "Imprimir até",
      valor: (e) =>
        e.limiteImpressao ? `<b>${fmtHora(e.limiteImpressao)}</b><small>${fmtFalta(e.limiteImpressao)}</small>` : "<b>—</b>",
    };
    return `<table class="pz-tabela${compacta ? " compacta" : ""}">
      <thead><tr>
        <th>Venda</th><th>Conta</th>${modalidade ? "<th>Modalidade</th>" : ""}<th>Produto</th><th class="num">Qtd</th><th>Comprador</th><th class="dir">${prazoCol.titulo}</th>
      </tr></thead>
      <tbody>${lista
        .map((e) => {
          const qtd = e.itens.reduce((s, i) => s + (i.qtd || 0), 0);
          const produto = e.itens.map((i) => i.titulo).join(" · ");
          return `<tr class="sit-${e.situacao}">
            <td data-label="Venda"><a href="https://www.mercadolivre.com.br/vendas/${encodeURIComponent(e.venda)}/detalhe" target="_blank" rel="noopener" title="Abrir no Mercado Livre">#${esc(e.venda)}</a></td>
            <td data-label="Conta">${esc(e.conta)}</td>
            ${modalidade ? `<td data-label="Modalidade">${NOME_MODALIDADE[e.modalidade] || ""}</td>` : ""}
            <td data-label="Produto" class="pz-td-produto" title="${esc(produto)}">${e.nfPendente ? '<span class="pz-tag-nf" title="Falta emitir a nota fiscal: o Mercado Livre só libera a etiqueta depois dela">NF pendente</span>' : ""}${esc(produto)}</td>
            <td data-label="Qtd" class="num">${qtd}</td>
            <td data-label="Comprador" class="pz-td-comprador">${esc(e.comprador || "")}</td>
            <td data-label="${prazoCol.titulo}" class="dir pz-td-prazo">${prazoCol.valor(e)}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
  }

  // ---------- Outras visoes ----------
  const ordemUrgencia = (a, b) =>
    SITUACAO[a.situacao].ordem - SITUACAO[b.situacao].ordem ||
    Date.parse(a.limiteImpressao || 0) - Date.parse(b.limiteImpressao || 0);

  function faixa(titulo, n, nota, conteudo) {
    return `<section class="pz-detalhe">
      <div class="pz-detalhe-topo">
        <div><span class="pz-titulo">${titulo}</span> <span class="pz-sub">${n} ${n === 1 ? "pacote" : "pacotes"}</span>${nota ? `<div class="pz-nota">${esc(nota)}</div>` : ""}</div>
      </div>
      ${conteudo}
    </section>`;
  }

  // ---------- Visao "Impressos" ----------
  // Mesma ideia das outras: o que importa aqui e a SAIDA — quanto falta para
  // a coleta passar, para levar na agencia ou para a rota do Flex.
  let impModSel = null;
  const SAIDA = { coleta: "para a coleta", agencia: "para levar na agência", flex: "para entregar ao cliente" };

  const nivelSaida = (iso) => {
    if (!iso) return "no_prazo";
    const min = (Date.parse(iso) - Date.now()) / 60000;
    return min < 0 ? "estourou" : min < 60 ? "risco" : "no_prazo";
  };

  function renderImpressos(g) {
    if (!g.impressos.length) {
      return `<div class="pz-vazio-bonito"><b>Nenhum pacote impresso aguardando despacho</b><span>Assim que uma etiqueta é impressa, o pacote aparece aqui até sair.</span></div>`;
    }
    const porPrazo = (a, b) => Date.parse(a.prazo || 0) - Date.parse(b.prazo || 0);
    const mods = MODALIDADES.map((m) => {
      const itens = g.impressos.filter((e) => e.modalidade === m.id).sort(porPrazo);
      return { ...m, itens, impressos: itens, pendentes: g.imprimir.filter((e) => e.modalidade === m.id), janelas: janelasHoje(m) };
    }).filter((m) => m.itens.length || m.pendentes.length);

    if (!mods.some((m) => m.id === impModSel && m.itens.length)) {
      impModSel = mods.filter((m) => m.itens.length).sort((a, b) => porPrazo(a.itens[0], b.itens[0]))[0].id;
    }
    const sel = mods.find((m) => m.id === impModSel);

    return `
      ${renderLinhaDoTempo(mods, {
        campo: "prazo",
        sel: impModSel,
        attr: "data-imp-mod",
        legendaBolha: "saída dos impressos",
        tituloBolha: (n, hh) => `${n} ${n === 1 ? "impresso" : "impressos"} para sair até ${hh}`,
        vazio: () => "nenhum impresso aguardando",
        nivelBolha: (b) => nivelSaida(b.itens.map((e) => e.prazo).sort()[0]),
      })}
      <div class="pz-cards">${mods.map(cardImpressos).join("")}</div>
      ${renderDetalhe({
        ctx: "imp-" + sel.id,
        nome: sel.nome,
        itens: sel.itens,
        sub: "prontos para despachar",
        vazio: "Nenhum pacote impresso nesta modalidade.",
        colPrazo: {
          titulo: "Saída até",
          valor: (e) =>
            `<b>${fmtHora(e.prazo)}</b><small>${
              e.impressoEm ? `impresso às ${fmtHora(e.impressoEm)}${e.impressoEstimado ? "*" : ""}` : fmtFalta(e.prazo)
            }</small>`,
        },
        colGrupo: (envs) => {
          const p = envs.map((e) => e.prazo).filter(Boolean).sort()[0];
          return { b: p ? fmtHora(p) : "—", small: p ? fmtFalta(p) : "" };
        },
      })}
      ${
        sel.itens.some((e) => e.impressoEstimado)
          ? '<div class="pz-nota pz-nota-rodape">* horário estimado: o pacote já estava impresso quando o monitor o viu pela primeira vez.</div>'
          : ""
      }`;
  }

  function cardImpressos(m) {
    const n = m.itens.length;
    const total = n + m.pendentes.length;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const prox = m.itens.map((e) => e.prazo).filter(Boolean).sort()[0];
    const min = prox ? Math.round((Date.parse(prox) - Date.now()) / 60000) : null;
    const nivel = !n ? "vazio" : nivelSaida(prox);
    const rotulo = { estourou: "Saída atrasada", risco: "Sai em breve", no_prazo: "Aguardando saída", vazio: "Nada impresso" }[nivel];

    const horas = m.itens.map((e) => e.impressoEm).filter(Boolean).sort();
    const impressaoTxt = horas.length
      ? fmtHora(horas[0]) === fmtHora(horas[horas.length - 1])
        ? `${horas.length === 1 ? "impresso" : "impressos"} às ${fmtHora(horas[0])}`
        : `impressos entre ${fmtHora(horas[0])} e ${fmtHora(horas[horas.length - 1])}`
      : "";

    const porConta = new Map();
    for (const e of m.itens) porConta.set(e.conta, (porConta.get(e.conta) || 0) + 1);
    const contas = [...porConta.entries()].sort((a, b) => b[1] - a[1]);
    const maxConta = Math.max(1, ...contas.map((c) => c[1]));

    let relogio;
    if (min == null) relogio = `<div class="pz-relogio"><b>—</b><span>${n ? "sem horário de saída" : `${m.pendentes.length} ainda a imprimir`}</span></div>`;
    else if (min < 0) relogio = `<div class="pz-relogio passou"><b>+${dur(-min)}</b><span>passou da saída das ${fmtHora(prox)}</span></div>`;
    else relogio = `<div class="pz-relogio"><b>${dur(min)}</b><span>${SAIDA[m.id]} até ${fmtHora(prox)}</span></div>`;

    return `
      <button type="button" class="pz-card nivel-${nivel}${m.id === impModSel ? " sel" : ""}" data-imp-mod="${m.id}" ${n ? "" : "disabled"}>
        <div class="pz-card-topo">
          <span class="pz-card-nome">${m.nome}</span>
          <span class="pz-status nivel-${nivel}">${rotulo}</span>
        </div>
        <div class="pz-card-meio">
          <div class="pz-anel" style="--p:${pct}" role="img" aria-label="${pct}% do dia já impresso">
            <div><b>${n}</b><span>${n === 1 ? "pronto" : "prontos"}</span></div>
          </div>
          ${relogio}
        </div>
        ${janelasCartao(m)}
        <div class="pz-progresso-txt">${n} de ${total} pacotes do dia já impressos · ${pct}%${impressaoTxt ? `<br>${impressaoTxt}` : ""}</div>
        <div class="pz-contas">${
          contas.length
            ? contas
                .map(
                  ([nome, q]) => `<div class="pz-conta"><span class="pz-conta-nome">${esc(nome)}</span>
                    <span class="pz-conta-barra"><i style="width:${(q / maxConta) * 100}%"></i></span><b>${q}</b></div>`
                )
                .join("")
            : '<div class="pz-conta-vazio">Nenhum pacote impresso ainda</div>'
        }</div>
      </button>`;
  }

  function renderProximos(lista) {
    if (!lista.length) return '<p class="prazos-vazio grande">Nenhum pedido para os próximos dias.</p>';
    const porDia = new Map();
    for (const e of [...lista].sort((a, b) => Date.parse(a.prazo || 0) - Date.parse(b.prazo || 0))) {
      const dia = e.prazo ? diaSP(new Date(e.prazo)) : "—";
      if (!porDia.has(dia)) porDia.set(dia, []);
      porDia.get(dia).push(e);
    }
    const colPrazo = {
      titulo: "Imprimir até",
      valor: (e) => `<b>${fmtHora(e.limiteImpressao)}</b><small>${e.impresso ? "já impresso" : "não impresso"}</small>`,
    };
    return [...porDia.entries()]
      .map(([dia, itens]) => {
        const titulo =
          dia === "—"
            ? "Sem data"
            : new Date(`${dia}T12:00:00-03:00`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", timeZone: TZ });
        return faixa(titulo.charAt(0).toUpperCase() + titulo.slice(1), itens.length, "", tabelaPacotes(itens, { modalidade: true, colPrazo }));
      })
      .join("");
  }

  // ---------- Visao "Atrasados" ----------
  // Mesma ideia da "A imprimir": grafico de envelhecimento (quantos dias de
  // atraso, por modalidade) + um cartao por faixa de idade + detalhe.
  const FAIXAS_ATRASO = [
    { id: "hoje", nome: "Venceu hoje", acao: "Despachar hoje", nivel: "estourou", de: 0, ate: 0 },
    { id: "ontem", nome: "Venceu ontem", acao: "Despachar agora", nivel: "atrasado", de: 1, ate: 1 },
    { id: "semana", nome: "2 a 7 dias", acao: "Conferir no ML", nivel: "risco", de: 2, ate: 7 },
    { id: "antigos", nome: "Mais de 7 dias", acao: "Provavelmente travado", nivel: "vazio", de: 8, ate: Infinity },
  ];
  let faixaSel = null;
  const COR_MOD = { coleta: "var(--mod-coleta)", agencia: "var(--mod-agencia)", flex: "var(--mod-flex)" };

  function renderAtrasados(lista) {
    if (!lista.length) {
      return `<div class="pz-vazio-bonito"><b>Nenhum envio atrasado</b><span>Tudo o que venceu já foi despachado. ✓</span></div>`;
    }
    const faixas = FAIXAS_ATRASO.map((f) => {
      const itens = lista
        .filter((e) => {
          const d = diasDeAtraso(e);
          return d >= f.de && d <= f.ate;
        })
        .sort((a, b) => Date.parse(b.prazo || 0) - Date.parse(a.prazo || 0));
      return { ...f, itens };
    });
    if (!faixas.some((f) => f.id === faixaSel && f.itens.length)) {
      faixaSel = faixas.find((f) => f.itens.length).id;
    }
    const sel = faixas.find((f) => f.id === faixaSel);
    const colPrazo = {
      titulo: "Venceu",
      valor: (e) => `<b>${fmtDiaHora(e.prazo)}</b><small>${idadeTexto(e)} · ${e.impresso ? "etiqueta impressa" : "não impresso"}</small>`,
    };
    return `
      ${graficoEnvelhecimento(lista)}
      <div class="pz-cards pz-cards-4">${faixas.map(cardFaixa).join("")}</div>
      ${renderDetalhe({
        ctx: "atr-" + sel.id,
        nome: sel.nome,
        itens: sel.itens,
        sub: "em atraso",
        vazio: "Nenhum envio nesta faixa.",
        modalidade: true,
        colPrazo,
        colGrupo: (envs) => {
          const maisAntigo = envs.reduce((a, e) => Math.max(a, diasDeAtraso(e)), 0);
          return { b: maisAntigo ? `${maisAntigo} ${maisAntigo === 1 ? "dia" : "dias"}` : "hoje", small: "mais antigo" };
        },
      })}`;
  }

  const idadeTexto = (e) => {
    const d = diasDeAtraso(e);
    return d === 0 ? "hoje" : d === 1 ? "ontem" : `há ${d} dias`;
  };

  function graficoEnvelhecimento(lista) {
    const colunas = [];
    for (let d = 0; d <= 14; d++) colunas.push({ rot: d === 0 ? "hoje" : `${d}d`, de: d, ate: d });
    colunas.push({ rot: "15d+", de: 15, ate: Infinity });
    for (const c of colunas) {
      c.porMod = { coleta: 0, agencia: 0, flex: 0 };
      for (const e of lista) {
        const d = diasDeAtraso(e);
        if (d >= c.de && d <= c.ate) c.porMod[e.modalidade] = (c.porMod[e.modalidade] || 0) + 1;
      }
      c.total = Object.values(c.porMod).reduce((a, b) => a + b, 0);
      c.faixa = FAIXAS_ATRASO.find((f) => c.de >= f.de && c.de <= f.ate).id;
    }
    const max = Math.max(1, ...colunas.map((c) => c.total));
    return `
      <section class="pz-tl">
        <div class="pz-tl-cabecalho">
          <span class="pz-titulo">Há quanto tempo estão atrasados</span>
          <span class="pz-legenda">${MODALIDADES.map((m) => `<i style="background:${COR_MOD[m.id]}"></i>${m.nome}`).join(" ")}</span>
        </div>
        <div class="pz-barras">
          ${colunas
            .map(
              (c) => `<button type="button" class="pz-barra${c.faixa === faixaSel ? " sel" : ""}" data-faixa="${c.faixa}"
                  title="${c.total} ${c.total === 1 ? "envio" : "envios"} · ${c.rot === "hoje" ? "venceu hoje" : c.rot === "15d+" ? "15 dias ou mais" : `há ${c.de} ${c.de === 1 ? "dia" : "dias"}`}">
                <span class="pz-barra-n">${c.total || ""}</span>
                <span class="pz-barra-pilha" style="height:${(c.total / max) * 100}%">
                  ${MODALIDADES.map((m) =>
                    c.porMod[m.id] ? `<i style="flex:${c.porMod[m.id]};background:${COR_MOD[m.id]}"></i>` : ""
                  ).join("")}
                </span>
                <span class="pz-barra-rot">${c.rot}</span>
              </button>`
            )
            .join("")}
        </div>
      </section>`;
  }

  function cardFaixa(f) {
    const n = f.itens.length;
    const impressos = f.itens.filter((e) => e.impresso).length;
    const pct = n ? Math.round((impressos / n) * 100) : 0;
    const porConta = new Map();
    for (const e of f.itens) porConta.set(e.conta, (porConta.get(e.conta) || 0) + 1);
    const contas = [...porConta.entries()].sort((a, b) => b[1] - a[1]);
    const maxConta = Math.max(1, ...contas.map((c) => c[1]));
    const nivel = n ? f.nivel : "concluido";
    return `
      <button type="button" class="pz-card nivel-${nivel}${f.id === faixaSel ? " sel" : ""}" data-faixa="${f.id}" ${n ? "" : "disabled"}>
        <div class="pz-card-topo">
          <span class="pz-card-nome">${f.nome}</span>
          <span class="pz-status nivel-${nivel}">${n ? f.acao : "Nenhum"}</span>
        </div>
        <div class="pz-card-meio">
          <div class="pz-anel" style="--p:${pct}" role="img" aria-label="${pct}% com etiqueta impressa">
            <div><b>${n}</b><span>${n === 1 ? "envio" : "envios"}</span></div>
          </div>
          <div class="pz-relogio"><b>${n - impressos}</b><span>sem etiqueta impressa<br>${impressos} já impressos</span></div>
        </div>
        <div class="pz-contas">${
          contas.length
            ? contas
                .map(
                  ([nome, q]) => `<div class="pz-conta"><span class="pz-conta-nome">${esc(nome)}</span>
                    <span class="pz-conta-barra"><i style="width:${(q / maxConta) * 100}%"></i></span><b>${q}</b></div>`
                )
                .join("")
            : '<div class="pz-conta-vazio">Nada nesta faixa ✓</div>'
        }</div>
      </button>`;
  }

  // ---------- Visao "Calendario" (historico gravado no banco) ----------
  const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  let calMes = null; // "AAAA-MM"
  let calDia = null; // "AAAA-MM-DD"
  let calModSel = null;
  const cacheCal = new Map(); // mes -> { em, dados } | { carregando }
  const cacheDia = new Map(); // dia -> { em, dados } | { carregando }
  const CAL_TTL = 60_000;

  const somaDias = (dia, n) => {
    const d = new Date(`${dia}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  function gradeDoMes(mes) {
    const primeiro = `${mes}-01`;
    const semana = new Date(`${primeiro}T12:00:00Z`).getUTCDay(); // 0 = domingo
    const inicio = somaDias(primeiro, -((semana + 6) % 7)); // comeca na segunda
    const dias = [];
    for (let i = 0; i < 42; i++) dias.push(somaDias(inicio, i));
    // Corta a ultima semana se ela for toda do mes seguinte.
    while (dias.length > 35 && dias.slice(-7).every((d) => d.slice(0, 7) !== mes)) dias.splice(-7);
    return dias;
  }

  async function buscarCache(cache, chave, url) {
    const c = cache.get(chave);
    if (c?.carregando || (c?.dados && Date.now() - c.em < CAL_TTL)) return;
    cache.set(chave, { ...c, carregando: true });
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cache.set(chave, { em: Date.now(), dados: await res.json() });
    } catch (err) {
      cache.set(chave, { em: Date.now(), erro: err.message, dados: c?.dados });
    }
    if (visivel && visao === "calendario") render();
  }

  function renderCalendario() {
    const hoje = diaSP(new Date());
    calDia = calDia || hoje;
    calMes = calMes || calDia.slice(0, 7);
    const grade = gradeDoMes(calMes);
    buscarCache(cacheCal, calMes, `/api/prazos/calendario?de=${grade[0]}&ate=${grade[grade.length - 1]}`);
    buscarCache(cacheDia, calDia, `/api/prazos/dia?data=${calDia}`);

    const cal = cacheCal.get(calMes);
    const porDia = new Map((cal?.dados?.dias || []).map((d) => [d.dia, d]));
    const inicio = cal?.dados?.inicio;
    const [ano, m] = calMes.split("-").map(Number);

    const celulas = grade
      .map((dia) => {
        const d = porDia.get(dia);
        const fora = dia.slice(0, 7) !== calMes;
        const futuro = dia > hoje;
        let nivel = "sem";
        let pct = null;
        if (d && d.total) {
          pct = Math.round((d.no_limite / d.total) * 100);
          // Cor = % impresso no limite; atraso aparece a parte (bolinha), senao
          // um unico atraso por dia pintaria o mes inteiro de vermelho.
          nivel = pct < 80 ? "ruim" : pct < 95 ? "atencao" : "bom";
        }
        return `<button type="button" class="pz-cal-dia nivel-${nivel}${fora ? " fora" : ""}${dia === hoje ? " hoje" : ""}${dia === calDia ? " sel" : ""}"
            data-cal-dia="${dia}" ${futuro ? "disabled" : ""} title="${d ? `${d.total} pacotes · ${pct ?? 0}% impressos no limite · ${d.atrasados} atrasados` : "sem registro"}">
          <span class="pz-cal-num">${Number(dia.slice(8))}</span>
          ${d && d.total ? `<span class="pz-cal-total">${d.total}</span><span class="pz-cal-barra"><i style="width:${pct}%"></i></span>` : ""}
          ${d && d.atrasados ? `<span class="pz-cal-atraso" aria-label="${d.atrasados} atrasados">${d.atrasados}</span>` : ""}
        </button>`;
      })
      .join("");

    const calendario = `
      <section class="pz-cal">
        <div class="pz-cal-topo">
          <button type="button" class="pz-cal-nav" data-cal-mes="-1" aria-label="Mês anterior">‹</button>
          <span class="pz-titulo">${MESES[m - 1]} ${ano}</span>
          <button type="button" class="pz-cal-nav" data-cal-mes="1" aria-label="Próximo mês" ${calMes >= hoje.slice(0, 7) ? "disabled" : ""}>›</button>
        </div>
        <div class="pz-cal-semana">${["seg", "ter", "qua", "qui", "sex", "sáb", "dom"].map((s) => `<span>${s}</span>`).join("")}</div>
        <div class="pz-cal-grade">${celulas}</div>
        <div class="pz-cal-legenda">
          <span><i class="bom"></i>95%+ no limite</span><span><i class="atencao"></i>80–94%</span><span><i class="ruim"></i>abaixo de 80%</span><span><b class="pz-cal-atraso">n</b>atrasados</span>
        </div>
        ${
          inicio
            ? `<div class="pz-nota">Histórico gravado desde ${inicio.split("-").reverse().join("/")}.</div>`
            : cal?.carregando || !cal
            ? '<div class="pz-nota">Carregando…</div>'
            : '<div class="pz-nota">O histórico começa a ser gravado a partir de agora.</div>'
        }
        ${cal?.erro ? `<div class="pz-nota prazos-erro">Falha ao carregar: ${esc(cal.erro)}</div>` : ""}
        <button type="button" class="btn btn-ghost btn-sm pz-cal-hoje" data-cal-dia="${hoje}">Ir para hoje</button>
      </section>`;

    return `<div class="pz-cal-layout">${calendario}<div class="pz-cal-relatorio">${relatorioDoDia(calDia)}</div></div>${renderHorariosSemana()}`;
  }

  // Situacao final de um envio do historico (cores iguais as da tela ao vivo).
  function situacaoHistorica(e) {
    if (e.statusFinal === "cancelled") return "cancelado";
    if (e.atrasou) return "atrasado";
    if (e.impressoEm) {
      return !e.limiteImpressao || e.impressoEm <= e.limiteImpressao ? "impresso" : "tarde";
    }
    if (e.limiteImpressao && Date.now() > Date.parse(e.limiteImpressao)) return "estourou";
    return "no_prazo";
  }

  function relatorioDoDia(dia) {
    const c = cacheDia.get(dia);
    const titulo = new Date(`${dia}T12:00:00-03:00`).toLocaleDateString("pt-BR", {
      weekday: "long", day: "2-digit", month: "long", timeZone: TZ,
    });
    const temDados = !!c?.dados?.envios?.length;
    const cabecalho = `<div class="pz-dia-topo"><span class="pz-titulo">${esc(titulo.charAt(0).toUpperCase() + titulo.slice(1))}</span>
      ${dia === diaSP(new Date()) ? '<span class="pz-status nivel-no_prazo">hoje · ao vivo</span>' : ""}
      ${
        temDados
          ? `<span class="pz-dia-acoes">
              <button type="button" class="btn btn-primary btn-sm" data-relatorio="pdf" title="Abre o relatório detalhado do dia para imprimir ou salvar em PDF">📄 Relatório de atrasos</button>
              <button type="button" class="btn btn-ghost btn-sm" data-relatorio="csv" title="Baixa todos os pacotes do dia em planilha (abre no Excel)">⬇ Planilha</button>
            </span>`
          : ""
      }</div>`;
    if (!c?.dados) {
      return cabecalho + `<div class="pz-vazio-bonito"><b>${c?.erro ? "Falha ao carregar" : "Carregando…"}</b>${c?.erro ? `<span>${esc(c.erro)}</span>` : ""}</div>`;
    }
    const conta = contaSel.value;
    const todos = c.dados.envios
      .filter((e) => !conta || e.sellerId === conta)
      .map((e) => ({ ...e, situacao: situacaoHistorica(e), impresso: !!e.impressoEm }));
    if (!todos.length) {
      return cabecalho + `<div class="pz-vazio-bonito"><b>Nenhum pacote registrado neste dia</b><span>O histórico só existe a partir do dia em que o monitor foi publicado.</span></div>`;
    }
    const ativos = todos.filter((e) => e.situacao !== "cancelado");
    const n = (s) => ativos.filter((e) => e.situacao === s).length;
    const noLimite = n("impresso");
    const pct = ativos.length ? Math.round((noLimite / ativos.length) * 100) : 0;
    const naoImpressos = ativos.filter((e) => !e.impressoEm).length;

    const kpis = [
      { cls: "imprimir", n: ativos.length, rot: "Pacotes do dia", sub: `${todos.length - ativos.length} cancelados` },
      { cls: "impresso", n: noLimite, rot: "Impressos no limite", sub: `${pct}% do dia` },
      { cls: "risco", n: n("tarde"), rot: "Após o limite", sub: "impressos em cima da hora" },
      { cls: "estourou", n: naoImpressos, rot: "Não impressos", sub: "sem etiqueta" },
      { cls: "atrasado", n: n("atrasado"), rot: "Atrasaram", sub: "após o prazo de despacho" },
    ];

    const mods = MODALIDADES.map((m) => ({ ...m, itens: ativos.filter((e) => e.modalidade === m.id) })).filter((m) => m.itens.length);
    if (calModSel && !mods.some((m) => m.id === calModSel)) calModSel = null;
    const detalheItens = calModSel ? todos.filter((e) => e.modalidade === calModSel) : todos;

    const colPrazo = {
      titulo: "Impresso às",
      valor: (e) => {
        const quando = e.impressoEm
          ? `<b>${fmtHora(e.impressoEm)}${e.impressoEstimado ? "*" : ""}</b>`
          : `<b>${e.statusFinal === "cancelled" ? "cancelado" : "—"}</b>`;
        const saida =
          e.statusFinal === "cancelled" ? "" : e.saiuEm ? ` · saiu ${fmtHora(e.saiuEm)}` : " · ainda na lista";
        return `${quando}<small>limite ${fmtHora(e.limiteImpressao)}${saida}</small>`;
      },
    };

    return `
      ${cabecalho}
      <div class="prazos-resumo pz-resumo-dia">${kpis
        .map(
          (k) => `<div class="prazos-kpi kpi-${k.cls}${k.n ? "" : " zerado"}"><span class="kpi-n">${k.n}</span>
            <span class="kpi-rotulo">${k.rot}</span><span class="kpi-sub">${esc(k.sub)}</span></div>`
        )
        .join("")}</div>
      ${graficoImpressoes(ativos)}
      <div class="pz-cards">${mods.map(cardModalidadeDia).join("")}</div>
      ${renderDetalhe({
        ctx: "dia-" + dia + (calModSel || ""),
        nome: calModSel ? NOME_MODALIDADE[calModSel] : "Todos os pacotes",
        itens: detalheItens,
        sub: calModSel ? "· clique no cartão de novo para ver todos" : "do dia",
        vazio: "Nenhum pacote.",
        modalidade: !calModSel,
        colPrazo,
        colGrupo: (envs) => {
          const ok = envs.filter((e) => e.situacao === "impresso").length;
          return { b: `${ok}/${envs.length}`, small: "no limite" };
        },
      })}
      <div class="pz-nota">* horário estimado: o pacote já estava impresso quando o monitor o viu pela primeira vez, ou saiu sem ser visto impresso. Os demais horários têm precisão de ~3 min.</div>`;
  }

  function graficoImpressoes(ativos) {
    const comHora = ativos.filter((e) => e.impressoEm && !e.impressoEstimado);
    const estimados = ativos.filter((e) => e.impressoEm && e.impressoEstimado).length;
    const horas = comHora.map((e) => Math.floor(minutosSP(e.impressoEm) / 60));
    const limites = new Map();
    for (const e of ativos) {
      if (!e.limiteImpressao) continue;
      const min = minutosSP(e.limiteImpressao);
      const chave = `${e.modalidade}-${min}`;
      if (!limites.has(chave)) limites.set(chave, { min, mod: e.modalidade });
    }
    const todasHoras = [...horas, ...[...limites.values()].map((l) => Math.floor(l.min / 60))];
    const ini = Math.min(7, ...todasHoras);
    const fim = Math.max(18, ...todasHoras);
    const barras = [];
    for (let h = ini; h <= fim; h++) {
      const daHora = comHora.filter((e) => Math.floor(minutosSP(e.impressoEm) / 60) === h);
      barras.push({ h, ok: daHora.filter((e) => e.situacao === "impresso").length, tarde: daHora.filter((e) => e.situacao !== "impresso").length });
    }
    const max = Math.max(1, ...barras.map((b) => b.ok + b.tarde));
    const pos = (min) => `${(((min - ini * 60) / ((fim + 1 - ini) * 60)) * 100).toFixed(2)}%`;
    return `
      <section class="pz-tl">
        <div class="pz-tl-cabecalho">
          <span class="pz-titulo">Impressões ao longo do dia</span>
          <span class="pz-legenda"><i style="background:var(--sit-ok)"></i>no limite <i style="background:var(--sit-risco)"></i>após o limite <i class="lg-bandeira"></i>limite de impressão</span>
        </div>
        ${
          comHora.length
            ? `<div class="pz-hist">
                <div class="pz-hist-barras">${barras
                  .map(
                    (b) => `<div class="pz-hist-col" title="${b.ok + b.tarde} impressos entre ${b.h}h e ${b.h + 1}h">
                      <span class="pz-barra-n">${b.ok + b.tarde || ""}</span>
                      <span class="pz-barra-pilha" style="height:${((b.ok + b.tarde) / max) * 100}%">
                        ${b.tarde ? `<i style="flex:${b.tarde};background:var(--sit-risco)"></i>` : ""}${b.ok ? `<i style="flex:${b.ok};background:var(--sit-ok)"></i>` : ""}
                      </span>
                      <span class="pz-barra-rot">${String(b.h).padStart(2, "0")}h</span>
                    </div>`
                  )
                  .join("")}</div>
                ${linhasDeLimite(limites, pos)}
              </div>`
            : '<p class="prazos-vazio">Nenhuma impressão com horário registrado neste dia.</p>'
        }
        ${estimados ? `<div class="pz-nota">+ ${estimados} ${estimados === 1 ? "pacote" : "pacotes"} com horário estimado (fora do gráfico).</div>` : ""}
      </section>`;
  }

  // Limites no mesmo horario viram um rotulo so ("Coleta · Flex 13:00");
  // rotulos vizinhos alternam de altura para nao se sobreporem.
  function linhasDeLimite(limites, pos) {
    const porMin = new Map();
    for (const l of limites.values()) {
      const nomes = porMin.get(l.min) || [];
      if (!nomes.includes(NOME_MODALIDADE[l.mod])) nomes.push(NOME_MODALIDADE[l.mod]);
      porMin.set(l.min, nomes);
    }
    return [...porMin.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([min, nomes], i) =>
          `<div class="pz-hist-limite" style="left:${pos(min)}"><span style="top:${(i % 2) * 16}px">${esc(nomes.join(" · "))} ${minParaHhmm(min)}</span></div>`
      )
      .join("");
  }

  function cardModalidadeDia(m) {
    const total = m.itens.length;
    const ok = m.itens.filter((e) => e.situacao === "impresso").length;
    const atr = m.itens.filter((e) => e.situacao === "atrasado").length;
    const tarde = m.itens.filter((e) => e.situacao === "tarde").length;
    const pct = total ? Math.round((ok / total) * 100) : 0;
    const nivel = atr ? "estourou" : pct >= 95 ? "concluido" : pct >= 80 ? "risco" : "estourou";
    const rotulo = atr ? `${atr} ${atr === 1 ? "atrasou" : "atrasaram"}` : pct >= 95 ? "Excelente" : pct >= 80 ? "Bom" : "Atenção";
    const porConta = new Map();
    for (const e of m.itens) porConta.set(e.conta, (porConta.get(e.conta) || 0) + 1);
    const contas = [...porConta.entries()].sort((a, b) => b[1] - a[1]);
    const maxConta = Math.max(1, ...contas.map((c) => c[1]));
    return `
      <button type="button" class="pz-card nivel-${nivel}${m.id === calModSel ? " sel" : ""}" data-cal-mod="${m.id}">
        <div class="pz-card-topo">
          <span class="pz-card-nome">${m.nome}</span>
          <span class="pz-status nivel-${nivel}">${rotulo}</span>
        </div>
        <div class="pz-card-meio">
          <div class="pz-anel" style="--p:${pct}" role="img" aria-label="${pct}% impressos no limite">
            <div><b>${pct}%</b><span>no limite</span></div>
          </div>
          <div class="pz-relogio"><b>${ok}/${total}</b><span>impressos no limite${tarde ? `<br>${tarde} após o limite` : ""}</span></div>
        </div>
        <div class="pz-contas">${contas
          .map(
            ([nome, q]) => `<div class="pz-conta"><span class="pz-conta-nome">${esc(nome)}</span>
              <span class="pz-conta-barra"><i style="width:${(q / maxConta) * 100}%"></i></span><b>${q}</b></div>`
          )
          .join("")}</div>
      </button>`;
  }

  // ---------- Horarios da semana (igual a tela "Coletas" do ML) ----------
  const DIAS_PT = { monday: "Seg", tuesday: "Ter", wednesday: "Qua", thursday: "Qui", friday: "Sex", saturday: "Sáb", sunday: "Dom" };
  const NOME_LT = { cross_docking: "Coleta", xd_drop_off: "Agência", drop_off: "Agência" };

  function renderHorariosSemana() {
    const hojeIdx = (new Date(`${diaSP(new Date())}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = segunda
    const linhas = [];
    for (const c of dados?.contas || []) {
      if (contaSel.value && c.sellerId !== contaSel.value) continue;
      for (const [lt, dias] of Object.entries(c.semana || {})) linhas.push({ conta: c.nickname, lt, dias });
    }
    if (!linhas.length) return "";
    // Domingo so aparece se alguma conta trabalha nele.
    const mostrarDom = linhas.some((l) => l.dias[6]?.trabalha);
    const idxs = [0, 1, 2, 3, 4, 5, ...(mostrarDom ? [6] : [])];
    const celula = (l, i) => {
      const d = l.dias[i];
      const cls = i === hojeIdx ? " hoje" : "";
      // Dia que ja passou: "finalizada", como na tela do ML (a API devolve
      // work=false para a segunda que passou).
      if ((d?.passou || (i < hojeIdx && i < 5)) && i !== hojeIdx) return `<td class="pz-hs-passou${cls}">finalizada</td>`;
      if (!d?.trabalha) return `<td class="pz-hs-nao${cls}">—</td>`;
      const horario = d.ate ? `${d.de}–${d.ate}` : `até ${d.de}`;
      return `<td class="${cls.trim()}"><b>${esc(horario)}</b>${d.corte ? `<small>vendas até ${esc(d.corte)}</small>` : ""}</td>`;
    };
    return `
      <section class="pz-detalhe pz-horarios">
        <div class="pz-detalhe-topo">
          <div><span class="pz-titulo">Horários desta semana</span> <span class="pz-sub">lidos do Mercado Livre · "vendas até" = horário de corte do dia</span></div>
        </div>
        <div class="pz-hs-rolagem">
          <table class="pz-hs">
            <thead><tr><th>Conta</th>${idxs.map((i) => `<th class="${i === hojeIdx ? "hoje" : ""}">${DIAS_PT[linhas[0].dias[i].dia]}${i === hojeIdx ? " · hoje" : ""}</th>`).join("")}</tr></thead>
            <tbody>${linhas
              .map((l) => `<tr><th><span>${esc(l.conta)}</span><small>${NOME_LT[l.lt] || l.lt}</small></th>${idxs.map((i) => celula(l, i)).join("")}</tr>`)
              .join("")}</tbody>
          </table>
        </div>
      </section>`;
  }

  // ---------- Relatorio de atrasos do dia (imprimir/PDF e planilha) ----------
  const DICA_SAIDA = {
    coleta: "a coleta não retirou dentro da janela?",
    agencia: "não foi levado à agência a tempo?",
    flex: "não saiu na rota a tempo?",
  };

  function motivoAtraso(e) {
    const est = e.impressoEstimado ? " (horário estimado)" : "";
    if (!e.impressoEm) {
      return e.nfPendente
        ? "Não foi impresso — estava com NF pendente (o ML só libera a etiqueta depois da nota)"
        : "Não foi impresso";
    }
    if (e.prazo && e.impressoEm > e.prazo) return `Impresso só às ${fmtHora(e.impressoEm)}${est}, depois do prazo de despacho`;
    if (e.limiteImpressao && e.impressoEm > e.limiteImpressao) {
      return `Impresso às ${fmtHora(e.impressoEm)}${est}, após o limite de ${fmtHora(e.limiteImpressao)} — sem tempo de separar`;
    }
    return `Impresso no prazo (${fmtHora(e.impressoEm)}${est}), mas não saiu a tempo — ${DICA_SAIDA[e.modalidade] || ""}`;
  }

  function minutosDeAtraso(e) {
    if (!e.prazo) return null;
    const fim = e.saiuEm ? Date.parse(e.saiuEm) : Date.now();
    return Math.max(0, Math.round((fim - Date.parse(e.prazo)) / 60000));
  }

  // Relatorio de um dia OU de um periodo (de/ate). Pedido do usuario em
  // 06/10: "clicar do 01 ao 06 e gerar o relatorio desses dias".
  const cachePeriodo = new Map(); // "de|ate" -> { em, dados }
  const dataBr = (d) => d.split("-").reverse().join("/");

  async function carregarPeriodo(de, ate) {
    const chave = `${de}|${ate}`;
    const c = cachePeriodo.get(chave);
    if (c?.dados && Date.now() - c.em < CAL_TTL) return c.dados;
    const res = await fetch(`/api/prazos/periodo?de=${de}&ate=${ate}`);
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(corpo.error || `HTTP ${res.status}`);
    cachePeriodo.set(chave, { em: Date.now(), dados: corpo });
    return corpo;
  }

  function linhasRelatorio(envios) {
    const conta = contaSel.value;
    return envios
      .filter((e) => !conta || e.sellerId === conta)
      .map((e) => {
        const situacao = situacaoHistorica(e);
        const qtd = e.itens.reduce((s, i) => s + (i.qtd || 0), 0);
        return {
          ...e,
          situacao,
          qtd,
          produto: e.itens.map((i) => `${i.qtd}× ${i.titulo}`).join(" · "),
          motivo: situacao === "atrasado" ? motivoAtraso(e) : "",
          atrasoMin: situacao === "atrasado" ? minutosDeAtraso(e) : null,
        };
      });
  }

  const ROTULO_SIT_REL = {
    impresso: "Impresso no limite",
    tarde: "Impresso após o limite",
    atrasado: "Atrasou",
    estourou: "Não impresso",
    no_prazo: "Pendente (no prazo)",
    cancelado: "Cancelado",
  };

  async function abrirRelatorio(de, ate = de) {
    if (de > ate) [de, ate] = [ate, de];
    let dados;
    try {
      dados = await carregarPeriodo(de, ate);
    } catch (err) {
      alert(`Não foi possível carregar o relatório: ${err.message}`);
      return;
    }
    const linhas = linhasRelatorio(dados.envios || []);
    const umDia = de === ate;
    const periodoTxt = umDia
      ? new Date(`${de}T12:00:00-03:00`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: TZ })
      : `${dataBr(de)} a ${dataBr(ate)}`;
    const noPeriodo = umDia ? "neste dia" : "no período";
    const contaNome = contaSel.value ? contaSel.options[contaSel.selectedIndex].text : "Todas as contas";
    const ativos = linhas.filter((e) => e.situacao !== "cancelado");
    const n = (s) => ativos.filter((e) => e.situacao === s).length;
    const atrasados = ativos
      .filter((e) => e.situacao === "atrasado")
      .sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : (b.atrasoMin || 0) - (a.atrasoMin || 0)));
    const tarde = ativos.filter((e) => e.situacao === "tarde");
    const pct = (x, t) => (t ? `${Math.round((x / t) * 100)}%` : "—");

    // Agrupa os motivos pela primeira parte ("Nao foi impresso", "Impresso apos o limite"...).
    const porMotivo = new Map();
    for (const e of atrasados) {
      const chave = !e.impressoEm
        ? e.nfPendente ? "Não impresso — NF pendente" : "Não impresso"
        : e.prazo && e.impressoEm > e.prazo ? "Impresso depois do prazo de despacho"
        : e.limiteImpressao && e.impressoEm > e.limiteImpressao ? "Impresso após o limite de impressão"
        : "Impresso no prazo, mas não saiu a tempo";
      porMotivo.set(chave, (porMotivo.get(chave) || 0) + 1);
    }
    const porConta = new Map();
    for (const e of ativos) {
      const r = porConta.get(e.conta) || { total: 0, ok: 0, atr: 0 };
      r.total++;
      if (e.situacao === "impresso") r.ok++;
      if (e.situacao === "atrasado") r.atr++;
      porConta.set(e.conta, r);
    }
    // Dia a dia (so no relatorio de periodo).
    const porDia = new Map();
    for (const e of linhas) {
      const r = porDia.get(e.dia) || { total: 0, ok: 0, tarde: 0, nao: 0, atr: 0, canc: 0 };
      if (e.situacao === "cancelado") r.canc++;
      else {
        r.total++;
        if (e.situacao === "impresso") r.ok++;
        if (e.situacao === "tarde") r.tarde++;
        if (!e.impressoEm) r.nao++;
        if (e.situacao === "atrasado") r.atr++;
      }
      porDia.set(e.dia, r);
    }
    const diaCurto = (d) =>
      new Date(`${d}T12:00:00-03:00`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ });

    const durTxt = (m) => (m == null ? "—" : m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`);
    const tabelaEnvios = (lista, comMotivo) => `
      <table>
        <thead><tr>${umDia ? "" : "<th>Dia</th>"}<th>Venda</th><th>Conta</th><th>Modalidade</th><th>Produto</th><th>Comprador</th>
          <th>Limite impr.</th><th>Impresso às</th><th>Prazo despacho</th><th>Saiu às</th>${comMotivo ? "<th>Atraso</th><th>Motivo provável</th>" : ""}</tr></thead>
        <tbody>${lista
          .map(
            (e) => `<tr>
              ${umDia ? "" : `<td class="mono">${diaCurto(e.dia)}</td>`}
              <td class="mono">#${esc(e.venda)}</td><td>${esc(e.conta)}</td><td>${NOME_MODALIDADE[e.modalidade] || ""}</td>
              <td>${esc(e.produto)}</td><td>${esc(e.comprador || "")}</td>
              <td class="mono">${fmtHora(e.limiteImpressao)}</td>
              <td class="mono">${e.impressoEm ? fmtHora(e.impressoEm) + (e.impressoEstimado ? "*" : "") : "—"}</td>
              <td class="mono">${fmtHora(e.prazo)}</td>
              <td class="mono">${e.saiuEm ? fmtDiaHora(e.saiuEm) : "ainda no CD"}</td>
              ${comMotivo ? `<td class="mono forte">${durTxt(e.atrasoMin)}</td><td>${esc(e.motivo)}</td>` : ""}
            </tr>`
          )
          .join("")}</tbody>
      </table>`;

    const secaoDiaADia = umDia
      ? ""
      : `<h2>Dia a dia</h2>
        ${porDia.size
          ? `<table><thead><tr><th>Dia</th><th>Pacotes</th><th>Impressos no limite</th><th style="width:28%"></th><th>Após o limite</th><th>Não impressos</th><th>Atrasaram</th><th>Cancelados</th></tr></thead><tbody>
            ${[...porDia.entries()]
              .sort((a, b) => (a[0] < b[0] ? -1 : 1))
              .map(([d, r]) => {
                const p = r.total ? Math.round((r.ok / r.total) * 100) : 0;
                const cor = p >= 95 ? "#16a34a" : p >= 80 ? "#d97706" : "#dc2626";
                const andamento = d === diaSP(new Date()) ? ' <small style="color:#2563eb">· em andamento</small>' : "";
                return `<tr><td class="mono">${diaCurto(d)}${andamento}</td><td class="mono">${r.total}</td><td class="mono">${r.ok} (${p}%)</td>
                  <td><div class="barra"><i style="width:${p}%;background:${cor}"></i></div></td>
                  <td class="mono">${r.tarde}</td><td class="mono">${r.nao}</td><td class="mono ${r.atr ? "forte" : ""}">${r.atr}</td><td class="mono">${r.canc}</td></tr>`;
              })
              .join("")}
          </tbody></table>`
          : '<div class="vazio">Sem registros no período.</div>'}`;

    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
      <title>Relatório de atrasos ${umDia ? dataBr(de) : `${dataBr(de)} a ${dataBr(ate)}`}</title>
      <style>
        * { box-sizing: border-box; }
        body { font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; margin: 24px; background: #fff; }
        h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
        h2 { font-size: 14px; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #111827; }
        .sub { color: #6b7280; margin: 2px 0 18px; }
        .kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
        .kpi { border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px; border-left: 4px solid #d1d5db; }
        .kpi b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
        .kpi span { color: #6b7280; font-size: 11px; }
        .k-ok { border-left-color: #16a34a; } .k-tarde { border-left-color: #d97706; } .k-nao { border-left-color: #dc2626; } .k-atr { border-left-color: #7f1d1d; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; }
        th { text-align: left; background: #f3f4f6; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #4b5563; }
        th, td { padding: 6px 7px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
        .mono { font-variant-numeric: tabular-nums; white-space: nowrap; }
        .forte { font-weight: 700; color: #b91c1c; }
        .duas { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .nota { color: #6b7280; font-size: 10.5px; margin-top: 8px; }
        .vazio { color: #16a34a; font-weight: 600; padding: 8px 0; }
        .barra { height: 8px; border-radius: 99px; background: #f3f4f6; overflow: hidden; margin-top: 3px; }
        .barra i { display: block; height: 100%; border-radius: 99px; }
        .aviso { padding: 10px 12px; background: #fef3c7; border-radius: 8px; }
        @media print { body { margin: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
        @page { size: A4 landscape; margin: 10mm; }
      </style></head><body>
      <h1>Relatório de atrasos — ${esc(periodoTxt)}</h1>
      <div class="sub">${esc(contaNome)}${umDia ? "" : ` · ${porDia.size} ${porDia.size === 1 ? "dia" : "dias"} com registro`} · gerado em ${new Date().toLocaleString("pt-BR", { timeZone: TZ })} · Painel de prazos (Mercado Livre)</div>
      ${linhas.length ? "" : `<p class="aviso">Nenhum pacote registrado ${noPeriodo}. O histórico só existe a partir do dia em que o monitor de prazos foi publicado.</p>`}

      <div class="kpis">
        <div class="kpi"><b>${ativos.length}</b><span>pacotes ${umDia ? "do dia" : "no período"}</span></div>
        <div class="kpi k-ok"><b>${n("impresso")}</b><span>impressos no limite (${pct(n("impresso"), ativos.length)})</span></div>
        <div class="kpi k-tarde"><b>${n("tarde")}</b><span>impressos após o limite</span></div>
        <div class="kpi k-nao"><b>${ativos.filter((e) => !e.impressoEm).length}</b><span>não impressos</span></div>
        <div class="kpi k-atr"><b>${atrasados.length}</b><span>atrasaram (${pct(atrasados.length, ativos.length)})</span></div>
        <div class="kpi"><b>${linhas.length - ativos.length}</b><span>cancelados</span></div>
      </div>

      ${secaoDiaADia}

      <div class="duas">
        <div>
          <h2>Atrasos por motivo</h2>
          ${porMotivo.size
            ? `<table><tbody>${[...porMotivo.entries()].sort((a, b) => b[1] - a[1]).map(([m, q]) => `<tr><td>${esc(m)}</td><td class="mono forte">${q}</td></tr>`).join("")}</tbody></table>`
            : `<div class="vazio">Nenhum atraso ${noPeriodo} ✓</div>`}
        </div>
        <div>
          <h2>Por conta</h2>
          <table><thead><tr><th>Conta</th><th>Pacotes</th><th>No limite</th><th>Atrasaram</th></tr></thead><tbody>
            ${[...porConta.entries()].map(([nome, r]) => `<tr><td>${esc(nome)}</td><td class="mono">${r.total}</td><td class="mono">${r.ok} (${pct(r.ok, r.total)})</td><td class="mono ${r.atr ? "forte" : ""}">${r.atr}</td></tr>`).join("")}
          </tbody></table>
        </div>
      </div>

      <h2>Por modalidade</h2>
      <table><thead><tr><th>Modalidade</th><th>Pacotes</th><th>Impressos no limite</th><th>Após o limite</th><th>Não impressos</th><th>Atrasaram</th></tr></thead><tbody>
        ${MODALIDADES.map((m) => {
          const l = ativos.filter((e) => e.modalidade === m.id);
          if (!l.length) return "";
          const ok = l.filter((e) => e.situacao === "impresso").length;
          return `<tr><td>${m.nome}</td><td class="mono">${l.length}</td><td class="mono">${ok} (${pct(ok, l.length)})</td>
            <td class="mono">${l.filter((e) => e.situacao === "tarde").length}</td><td class="mono">${l.filter((e) => !e.impressoEm).length}</td>
            <td class="mono ${l.some((e) => e.situacao === "atrasado") ? "forte" : ""}">${l.filter((e) => e.situacao === "atrasado").length}</td></tr>`;
        }).join("")}
      </tbody></table>

      <h2>Pacotes que atrasaram (${atrasados.length})</h2>
      ${atrasados.length ? tabelaEnvios(atrasados, true) : `<div class="vazio">Nenhum pacote atrasou ${noPeriodo} ✓</div>`}

      <h2>Impressos após o limite — não atrasaram, mas foram em cima da hora (${tarde.length})</h2>
      ${tarde.length ? tabelaEnvios(tarde, false) : '<div class="vazio">Nenhum ✓</div>'}

      <div class="nota">"Atraso" = tempo entre o prazo de despacho e a saída do pacote da lista "pronto para enviar" do Mercado Livre (ou até agora, se ainda está no CD).
      * horário de impressão estimado (o pacote já estava impresso quando o monitor o viu pela primeira vez). Demais horários com precisão de ~3 min.
      Coleta: prazo = fim da janela de coleta. O dia de cada pacote é o dia do prazo de despacho.</div>
      </body></html>`;
    mostrarRelatorio(html, `Relatório de atrasos — ${umDia ? dataBr(de) : `${dataBr(de)} a ${dataBr(ate)}`}`, de, ate, linhas);
  }

  // Abre por cima do painel (iframe) em vez de window.open: pop-up costuma
  // ser bloqueado pelo navegador.
  function mostrarRelatorio(html, titulo, de, ate, linhas) {
    document.getElementById("pz-rel-overlay")?.remove();
    const hoje = diaSP(new Date());
    const ov = document.createElement("div");
    ov.id = "pz-rel-overlay";
    ov.className = "pz-rel-overlay";
    ov.innerHTML = `
      <div class="pz-rel-caixa" role="dialog" aria-modal="true" aria-label="${esc(titulo)}">
        <div class="pz-rel-barra">
          <span class="pz-titulo">${esc(titulo)}</span>
          <span class="pz-rel-botoes">
            <span class="pz-rel-periodo">
              <label class="pz-rel-data">De <input type="date" value="${de}" max="${hoje}" data-rel="de" /></label>
              <label class="pz-rel-data">até <input type="date" value="${ate}" max="${hoje}" data-rel="ate" /></label>
              <span class="pz-seg pz-rel-atalhos">
                <button type="button" data-rel-atalho="hoje">Hoje</button>
                <button type="button" data-rel-atalho="7">7 dias</button>
                <button type="button" data-rel-atalho="mes">Este mês</button>
              </span>
            </span>
            <button type="button" class="btn btn-primary btn-sm" data-rel="imprimir">Imprimir / salvar PDF</button>
            <button type="button" class="btn btn-ghost btn-sm" data-rel="csv">⬇ Planilha</button>
            <button type="button" class="btn btn-ghost btn-sm" data-rel="fechar">Fechar</button>
          </span>
        </div>
        <iframe class="pz-rel-frame" title="${esc(titulo)}"></iframe>
      </div>`;
    document.body.appendChild(ov);
    const frame = ov.querySelector("iframe");
    frame.srcdoc = html;
    const fechar = () => {
      ov.remove();
      document.removeEventListener("keydown", esc_);
    };
    const esc_ = (ev) => ev.key === "Escape" && fechar();
    document.addEventListener("keydown", esc_);
    const reabrir = (d1, d2) => {
      document.removeEventListener("keydown", esc_);
      abrirRelatorio(d1, d2);
    };
    ov.addEventListener("click", (ev) => {
      if (ev.target === ov || ev.target.closest('[data-rel="fechar"]')) fechar();
      if (ev.target.closest('[data-rel="imprimir"]')) frame.contentWindow?.print();
      if (ev.target.closest('[data-rel="csv"]')) baixarCsv(linhas, de, ate);
      const at = ev.target.closest("[data-rel-atalho]")?.dataset.relAtalho;
      if (at === "hoje") reabrir(hoje, hoje);
      if (at === "7") reabrir(somaDias(hoje, -6), hoje);
      if (at === "mes") reabrir(`${hoje.slice(0, 7)}-01`, hoje);
    });
    const valido = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const inDe = ov.querySelector('[data-rel="de"]');
    const inAte = ov.querySelector('[data-rel="ate"]');
    for (const inp of [inDe, inAte]) {
      inp.addEventListener("change", () => {
        if (valido(inDe.value) && valido(inAte.value)) reabrir(inDe.value, inAte.value);
      });
    }
  }

  function baixarCsv(linhas, de, ate = de) {
    const cab = ["Data", "Venda", "Conta", "Modalidade", "Produto", "Qtd", "Comprador", "Situação", "Limite impressão",
      "Impresso às", "Horário estimado", "NF pendente", "Prazo despacho", "Saiu às", "Status final", "Atraso (min)", "Motivo provável"];
    const cel = (v) => {
      const t = v == null ? "" : String(v);
      return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const corpo = linhas.map((e) =>
      [
        e.dia ? dataBr(e.dia) : "", e.venda, e.conta, NOME_MODALIDADE[e.modalidade] || "", e.produto, e.qtd, e.comprador,
        ROTULO_SIT_REL[e.situacao] || e.situacao, fmtHora(e.limiteImpressao), e.impressoEm ? fmtHora(e.impressoEm) : "",
        e.impressoEstimado ? "sim" : "", e.nfPendente ? "sim" : "", fmtHora(e.prazo), e.saiuEm ? fmtDiaHora(e.saiuEm) : "",
        e.statusFinal || (e.aindaNaLista ? "no CD" : ""), e.atrasoMin ?? "", e.motivo,
      ].map(cel).join(";")
    );
    // BOM + ";" = abre certo no Excel em portugues.
    const blob = new Blob(["﻿" + [cab.join(";"), ...corpo].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `prazos-${de}${ate !== de ? "_a_" + ate : ""}${contaSel.value ? "-" + contaSel.value : ""}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function atualizarBadge() {
    const n = (dados?.envios || []).filter(acionavel).length;
    if (badge) {
      badge.textContent = n;
      badge.classList.toggle("hidden", !n);
    }
    document.title = n ? `(⚠ ${n}) ${tituloOriginal}` : tituloOriginal;
  }

  // ---------- Alertas (som + notificacao do navegador) ----------
  let audioCtx = null;

  function bipes(qtd, freq) {
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") audioCtx.resume();
    for (let i = 0; i < qtd; i++) {
      const t = audioCtx.currentTime + i * 0.35;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.26);
    }
  }

  // Navegadores so liberam audio depois de um clique na pagina.
  function prepararAudio() {
    if (audioCtx || !alertasAtivos) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  document.addEventListener("click", prepararAudio, { capture: true });

  function atualizarBotaoSom() {
    somBtn.textContent = alertasAtivos ? "🔔 Alertas ligados" : "🔕 Ativar alertas";
    somBtn.classList.toggle("ativo", alertasAtivos);
  }

  somBtn.addEventListener("click", async () => {
    alertasAtivos = !alertasAtivos;
    lsSet("prazos.alertas", alertasAtivos ? "1" : "0");
    atualizarBotaoSom();
    if (!alertasAtivos) return;
    prepararAudio();
    bipes(1, 880);
    if ("Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* ignora */ }
    }
    avisados.clear();
    verificarAlertas();
  });

  function verificarAlertas() {
    const novos = (dados?.envios || []).filter(
      (e) => acionavel(e) && !avisados.has(`${e.shippingId}:${e.situacao}`)
    );
    novos.forEach((e) => avisados.add(`${e.shippingId}:${e.situacao}`));
    if (!novos.length || !alertasAtivos) return;

    const grave = novos.some((e) => e.situacao !== "risco");
    bipes(grave ? 4 : 2, grave ? 1040 : 760);

    if ("Notification" in window && Notification.permission === "granted") {
      const porSit = {};
      novos.forEach((e) => (porSit[e.situacao] = (porSit[e.situacao] || 0) + 1));
      const titulo = Object.entries(porSit)
        .map(([s, n]) => `${n} ${SITUACAO[s].rotulo.toLowerCase()}`)
        .join(" · ");
      const corpo = novos
        .slice(0, 5)
        .map((e) => `#${e.venda} ${e.conta} (${NOME_MODALIDADE[e.modalidade]}) até ${fmtHora(e.limiteImpressao || e.prazo)}`)
        .join("\n");
      try {
        const n = new Notification(`Prazos: ${titulo}`, { body: corpo, tag: "prazos-ml" });
        n.onclick = () => {
          window.focus();
          document.querySelector('.module-nav-item[data-module="prazos"]')?.click();
        };
      } catch { /* alguns navegadores moveis exigem service worker */ }
    }
  }

  // ---------- Ajustes ----------
  $("prazos-config-btn").addEventListener("click", () => {
    const c = dados?.config;
    if (c) {
      configForm.elements["coleta.margemMin"].value = c.coleta.margemMin;
      configForm.elements["agencia.margemMin"].value = c.agencia.margemMin;
      configForm.elements["flex.limite"].value = c.flex.limite;
      configForm.elements["avisoMin"].value = c.avisoMin;
    }
    configForm.classList.toggle("hidden");
  });
  $("prazos-config-cancelar").addEventListener("click", () => configForm.classList.add("hidden"));

  configForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = configForm.elements;
    const body = {
      coleta: { margemMin: f["coleta.margemMin"].value },
      agencia: { margemMin: f["agencia.margemMin"].value },
      flex: { limite: f["flex.limite"].value },
      avisoMin: f["avisoMin"].value,
    };
    const btn = configForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await fetch("/api/prazos/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      dados = await res.json();
      configForm.classList.add("hidden");
      render();
      atualizarBadge();
    } catch (err) {
      alert(`Não foi possível salvar: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Inicio ----------
  $("prazos-atualizar").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "Buscando...";
    await carregar({ forcar: true });
    btn.disabled = false;
    btn.textContent = "⟳ Atualizar";
  });
  contaSel.addEventListener("change", render);

  atualizarBotaoSom();
  carregar();
  // Continua consultando mesmo com outra tela aberta: o alerta e o selo no
  // menu precisam funcionar enquanto o operador responde mensagens.
  setInterval(carregar, POLL_MS);
})();
