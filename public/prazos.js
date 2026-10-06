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
  };
  const PENDENTE = new Set(["estourou", "risco", "no_prazo", "sem_prazo"]);
  const VISOES = [
    { id: "imprimir", nome: "A imprimir" },
    { id: "atrasados", nome: "Atrasados" },
    { id: "impressos", nome: "Impressos" },
    { id: "proximos", nome: "Próximos dias" },
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
      impressos: () => renderPorModalidade(grupos.impressos),
      proximos: () => renderProximos(grupos.proximos),
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
        ${v.nome}<span class="prazos-aba-n">${g[v.id].length}</span></button>`
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
  function renderLinhaDoTempo(mods) {
    const agora = minutosSP(new Date().toISOString());
    const marcos = [];
    const faixas = mods.map((m) => {
      const bolhas = new Map();
      for (const e of m.itens) {
        if (!e.limiteImpressao) continue;
        const min = minutosSP(e.limiteImpressao);
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
        const nivelBolha = (b) =>
          b.itens.some((e) => e.situacao === "estourou") ? "estourou" : b.itens.some((e) => e.situacao === "risco") ? "risco" : "no_prazo";
        return `
        <div class="pz-tl-faixa${m.id === modSel ? " sel" : ""}" data-mod="${m.id}">
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
                  <span>entrega ${minParaHhmm(min)}</span></div>`
              )
              .join("")}
            ${bolhas
              .map(
                (b) => `<div class="pz-tl-bolha nivel-${nivelBolha(b)}" style="left:${pos(b.min)}"
                  title="${b.n} ${b.n === 1 ? "pacote" : "pacotes"} para imprimir até ${minParaHhmm(b.min)}">
                  <b>${b.n}</b><span>${minParaHhmm(b.min)}</span></div>`
              )
              .join("")}
            ${!bolhas.length ? `<div class="pz-tl-ok">${m.impressos.length ? "tudo impresso ✓" : "sem pedidos hoje"}</div>` : ""}
          </div>
        </div>`;
      })
      .join("");

    return `
      <section class="pz-tl" aria-label="Linha do tempo de hoje">
        <div class="pz-tl-cabecalho">
          <span class="pz-titulo">Hoje</span>
          <span class="pz-legenda"><i class="lg-janela"></i>janela de coleta <i class="lg-bandeira"></i>entrega na agência <i class="lg-bolha"></i>limite de impressão</span>
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
        <div class="pz-progresso-txt">${m.impressos.length} de ${total} impressos hoje · ${pct}%</div>
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
  function renderDetalhe(m) {
    const modos = `<div class="pz-seg" role="group" aria-label="Agrupar">
      <button type="button" data-modo="produtos" class="${modoDetalhe === "produtos" ? "on" : ""}">Por produto</button>
      <button type="button" data-modo="pacotes" class="${modoDetalhe === "pacotes" ? "on" : ""}">Por pacote</button>
    </div>`;
    const corpo = !m.itens.length
      ? '<p class="prazos-vazio grande">Nada a imprimir nesta modalidade. ✓</p>'
      : modoDetalhe === "produtos"
      ? tabelaProdutos(m.itens)
      : tabelaPacotes(m.itens);
    return `
      <section class="pz-detalhe">
        <div class="pz-detalhe-topo">
          <div><span class="pz-titulo">${m.nome}</span> <span class="pz-sub">${m.itens.length} ${m.itens.length === 1 ? "pacote" : "pacotes"} a imprimir</span></div>
          ${modos}
        </div>
        ${corpo}
      </section>`;
  }

  function tabelaProdutos(itens) {
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
        return `<details class="pz-produto sit-${sit}" data-chave="${esc(gr.titulo)}"${produtosAbertos.has(gr.titulo) ? " open" : ""}>
          <summary>
            <span class="pz-produto-qtd"><b>${gr.envios.size}</b><small>${gr.envios.size === 1 ? "pacote" : "pacotes"}</small></span>
            <span class="pz-produto-nome">${esc(gr.titulo)}<small>${esc([...gr.contas].join(" · "))}</small></span>
            <span class="pz-produto-un"><b>${gr.un}</b><small>unid.</small></span>
            <span class="pz-produto-limite"><b>${gr.limite ? fmtHora(gr.limite) : "—"}</b><small>${gr.limite ? fmtFalta(gr.limite) : ""}</small></span>
          </summary>
          ${tabelaPacotes(vendas, { compacta: true })}
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
            <td data-label="Produto" class="pz-td-produto" title="${esc(produto)}">${esc(produto)}</td>
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

  function renderAtrasados(lista) {
    if (!lista.length) return '<p class="prazos-vazio grande">Nenhum envio atrasado. ✓</p>';
    const faixas = [
      { titulo: "Venceu hoje", nota: "Despachar o quanto antes.", filtro: (d) => d === 0 },
      { titulo: "Venceu ontem", nota: "", filtro: (d) => d === 1 },
      {
        titulo: "Há 2 dias ou mais",
        nota: "Provavelmente travados: conferir no Mercado Livre (cancelamento, mediação ou pacote que saiu sem ser lido).",
        filtro: (d) => d >= 2,
      },
    ];
    const colPrazo = {
      titulo: "Venceu",
      valor: (e) => `<b>${fmtDiaHora(e.prazo)}</b><small>${e.impresso ? "etiqueta impressa" : "não impresso"}</small>`,
    };
    return faixas
      .map((f) => {
        const itens = lista
          .filter((e) => f.filtro(diasDeAtraso(e)))
          .sort((a, b) => Date.parse(b.prazo || 0) - Date.parse(a.prazo || 0));
        return itens.length ? faixa(f.titulo, itens.length, f.nota, tabelaPacotes(itens, { modalidade: true, colPrazo })) : "";
      })
      .join("");
  }

  function renderPorModalidade(lista) {
    if (!lista.length) return '<p class="prazos-vazio grande">Nenhum pacote impresso aguardando despacho.</p>';
    const colPrazo = { titulo: "Despachar até", valor: (e) => `<b>${fmtHora(e.prazo)}</b><small>${fmtFalta(e.prazo)}</small>` };
    return MODALIDADES.map((m) => {
      const itens = lista.filter((e) => e.modalidade === m.id);
      return itens.length ? faixa(m.nome, itens.length, "", tabelaPacotes(itens, { colPrazo })) : "";
    }).join("");
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
