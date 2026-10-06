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
      imprimir: () => renderImprimir(grupos.imprimir),
      atrasados: () => renderAtrasados(grupos.atrasados),
      impressos: () => renderPorModalidade(grupos.impressos, "Nenhum pacote impresso aguardando despacho."),
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

  function janelasTexto(m) {
    if (m.id === "flex") return `<span>Limite configurado: ${esc(dados.config?.flex?.limite || "—")}</span>`;
    const linhas = [];
    for (const c of dados.contas || []) {
      if (contaSel.value && c.sellerId !== contaSel.value) continue;
      for (const lt of m.lts) {
        if (!(lt in (c.janelasHoje || {}))) continue;
        const j = c.janelasHoje[lt];
        const txt = !j
          ? "não trabalha hoje"
          : m.id === "coleta"
          ? `coleta ${j.de || "?"}–${j.ate || "?"}`
          : `entregar até ${j.de || "?"}`;
        linhas.push(`<span><b>${esc(c.nickname)}</b>: ${esc(txt)}</span>`);
      }
    }
    return linhas.join("");
  }

  const ordemUrgencia = (a, b) =>
    SITUACAO[a.situacao].ordem - SITUACAO[b.situacao].ordem ||
    Date.parse(a.limiteImpressao || 0) - Date.parse(b.limiteImpressao || 0);

  function renderImprimir(lista) {
    const colunas = MODALIDADES.map((m) => {
      const itens = lista.filter((e) => e.modalidade === m.id).sort(ordemUrgencia);
      const janelas = janelasTexto(m);
      // Modalidade que nenhuma conta usa e sem pedidos: nao ocupa espaco.
      if (!itens.length && !janelas) return "";
      const n = (s) => itens.filter((e) => e.situacao === s).length;
      const proxLimite = itens.map((e) => e.limiteImpressao).filter(Boolean).sort()[0];
      const nivel = n("estourou") ? "estourou" : n("risco") ? "risco" : itens.length ? "no_prazo" : "ok";
      return `
        <section class="prazos-coluna">
          <header class="prazos-coluna-topo nivel-${nivel}">
            <div class="prazos-coluna-linha">
              <span class="prazos-coluna-nome">${m.nome}</span>
              <span class="prazos-coluna-qtd">${itens.length} ${itens.length === 1 ? "pacote" : "pacotes"}</span>
            </div>
            <div class="prazos-coluna-limite">${
              proxLimite
                ? `Imprimir até <b>${fmtHora(proxLimite)}</b> <span>${fmtFalta(proxLimite)}</span>`
                : itens.length
                ? "Sem prazo informado"
                : "Tudo impresso ✓"
            }</div>
            <div class="prazos-janelas">${janelas}</div>
          </header>
          <div class="prazos-linhas">${itens.map((e) => linha(e)).join("") || '<p class="prazos-vazio">Nada a imprimir.</p>'}</div>
        </section>`;
    }).join("");
    return `<div class="prazos-colunas">${colunas}</div>`;
  }

  function renderAtrasados(lista) {
    if (!lista.length) return '<p class="prazos-vazio grande">Nenhum envio atrasado. ✓</p>';
    const faixas = [
      { titulo: "Venceu hoje", nota: "despachar o quanto antes", filtro: (d) => d === 0 },
      { titulo: "Venceu ontem", nota: "", filtro: (d) => d === 1 },
      {
        titulo: "Há 2 dias ou mais",
        nota: "provavelmente travados — conferir no Mercado Livre (cancelamento, mediação ou pacote que saiu sem ser lido)",
        filtro: (d) => d >= 2,
      },
    ];
    return faixas
      .map((f) => {
        const itens = lista
          .filter((e) => f.filtro(diasDeAtraso(e)))
          .sort((a, b) => Date.parse(b.prazo || 0) - Date.parse(a.prazo || 0));
        if (!itens.length) return "";
        return `<section class="prazos-faixa">
          <h3>${f.titulo} <span class="prazos-faixa-n">${itens.length}</span>${f.nota ? ` <small>${esc(f.nota)}</small>` : ""}</h3>
          <div class="prazos-linhas">${itens
            .map((e) =>
              linha(e, {
                modalidade: true,
                direita: `<b>venceu ${fmtDiaHora(e.prazo)}</b><span>${e.impresso ? "etiqueta impressa" : "não impresso"}</span>`,
              })
            )
            .join("")}</div>
        </section>`;
      })
      .join("");
  }

  function renderPorModalidade(lista, vazio) {
    if (!lista.length) return `<p class="prazos-vazio grande">${vazio}</p>`;
    return MODALIDADES.map((m) => {
      const itens = lista.filter((e) => e.modalidade === m.id);
      if (!itens.length) return "";
      return `<section class="prazos-faixa">
        <h3>${m.nome} <span class="prazos-faixa-n">${itens.length}</span></h3>
        <div class="prazos-linhas">${itens
          .map((e) => linha(e, { direita: `<b>despachar até ${fmtHora(e.prazo)}</b>` }))
          .join("")}</div>
      </section>`;
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
    return [...porDia.entries()]
      .map(([dia, itens]) => {
        const titulo =
          dia === "—"
            ? "Sem data"
            : new Date(`${dia}T12:00:00-03:00`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", timeZone: TZ });
        return `<section class="prazos-faixa">
          <h3>${esc(titulo)} <span class="prazos-faixa-n">${itens.length}</span></h3>
          <div class="prazos-linhas">${itens
            .map((e) =>
              linha(e, {
                modalidade: true,
                direita: `<b>imprimir até ${fmtHora(e.limiteImpressao)}</b><span>${e.impresso ? "já impresso" : "não impresso"}</span>`,
              })
            )
            .join("")}</div>
        </section>`;
      })
      .join("");
  }

  // Uma linha por pacote: venda + conta | produto | prazo + situacao.
  function linha(e, { modalidade = false, direita } = {}) {
    const produto = e.itens.map((i) => `${i.qtd}× ${i.titulo}`).join(" · ");
    const dir =
      direita ||
      (e.limiteImpressao
        ? `<b>até ${fmtHora(e.limiteImpressao)}</b><span>${fmtFalta(e.limiteImpressao)}</span>`
        : `<b>sem prazo</b>`);
    return `
      <article class="prazos-linha sit-${e.situacao}">
        <div class="pl-id">
          <a href="https://www.mercadolivre.com.br/vendas/${encodeURIComponent(e.venda)}/detalhe" target="_blank" rel="noopener" title="Abrir a venda no Mercado Livre">#${esc(e.venda)}</a>
          <span>${esc(e.conta)}${modalidade ? ` · ${NOME_MODALIDADE[e.modalidade] || ""}` : ""}</span>
        </div>
        <div class="pl-produto" title="${esc(produto)}">${esc(produto)}<span>${esc(e.comprador || "")}</span></div>
        <div class="pl-prazo">${dir}</div>
      </article>`;
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
