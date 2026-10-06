// Prazos de despacho (coleta / agencia / Flex) — tela + alertas.
//
// Separado do app.js de proposito: se o index.html publicado ainda nao tiver
// o #prazos-pane (arquivos subidos em momentos diferentes no GitHub), este
// script simplesmente nao faz nada e o resto do painel segue funcionando.
(function () {
  const pane = document.getElementById("prazos-pane");
  if (!pane) return;

  const $ = (id) => document.getElementById(id);
  const colunasEl = $("prazos-colunas");
  const atrasadosEl = $("prazos-atrasados");
  const statusEl = $("prazos-status");
  const contaSel = $("prazos-conta");
  const somBtn = $("prazos-som");
  const configForm = $("prazos-config");
  const badge = $("module-badge-prazos");

  const POLL_MS = 30_000;
  const MODALIDADES = [
    { id: "coleta", nome: "Coleta", lts: ["cross_docking"] },
    { id: "agencia", nome: "Agência", lts: ["xd_drop_off", "drop_off"] },
    { id: "flex", nome: "Flex", lts: [] },
  ];
  const SITUACAO = {
    atrasado: { rotulo: "Atrasado", ordem: 0 },
    estourou: { rotulo: "Passou do limite", ordem: 1 },
    risco: { rotulo: "Em risco", ordem: 2 },
    no_prazo: { rotulo: "No prazo", ordem: 3 },
    sem_prazo: { rotulo: "Sem prazo", ordem: 4 },
    impresso: { rotulo: "Impresso", ordem: 5 },
    proximos: { rotulo: "Próximos dias", ordem: 6 },
  };
  const ALERTA = new Set(["risco", "estourou", "atrasado"]);

  let dados = null;
  let visivel = false;
  const tituloOriginal = document.title;

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch { /* sem storage: so nao lembra */ }
  }

  let alertasAtivos = lsGet("prazos.alertas") === "1";
  // shippingId:situacao ja avisados — um pedido avisa de novo so quando piora.
  const avisados = new Set();

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtHora = (iso) =>
    iso
      ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })
      : "—";
  const fmtDiaHora = (iso) =>
    iso
      ? new Date(iso).toLocaleString("pt-BR", {
          weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
          timeZone: "America/Sao_Paulo",
        })
      : "—";

  function fmtFalta(iso) {
    if (!iso) return "";
    const min = Math.round((Date.parse(iso) - Date.now()) / 60000);
    const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`);
    return min >= 0 ? `faltam ${dur(min)}` : `passou há ${dur(-min)}`;
  }

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

    renderAtrasados(envios.filter((e) => e.situacao === "atrasado"));
    colunasEl.innerHTML = MODALIDADES.map((m) =>
      renderColuna(m, envios.filter((e) => e.modalidade === m.id && e.situacao !== "atrasado"))
    ).join("");
  }

  function renderAtrasados(lista) {
    atrasadosEl.classList.toggle("hidden", !lista.length);
    if (!lista.length) return;
    atrasadosEl.innerHTML = `
      <div class="prazos-atrasados-titulo">⚠ ${lista.length} ${lista.length === 1 ? "envio atrasado" : "envios atrasados"} — o Mercado Livre já conta contra a reputação</div>
      <div class="prazos-cards">${lista
        .sort((a, b) => Date.parse(a.prazo || 0) - Date.parse(b.prazo || 0))
        .map((e) => card(e, `Prazo era ${fmtDiaHora(e.prazo)} · ${e.impresso ? "impresso" : "não impresso"}`))
        .join("")}</div>`;
  }

  function janelasTexto(m) {
    if (m.id === "flex") return `Limite configurado: ${esc(dados.config?.flex?.limite || "—")}`;
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
        linhas.push(`<span><b>${esc(c.nickname)}</b>: ${esc(txt)}${j?.corte ? ` · corte ${esc(j.corte)}` : ""}</span>`);
      }
    }
    return linhas.join("") || "Nenhuma conta com essa modalidade";
  }

  function renderColuna(m, lista) {
    const conta = (s) => lista.filter((e) => e.situacao === s).length;
    const pendentes = lista
      .filter((e) => ["estourou", "risco", "no_prazo", "sem_prazo"].includes(e.situacao))
      .sort(
        (a, b) =>
          SITUACAO[a.situacao].ordem - SITUACAO[b.situacao].ordem ||
          Date.parse(a.limiteImpressao || 0) - Date.parse(b.limiteImpressao || 0)
      );
    const impressos = lista.filter((e) => e.situacao === "impresso");
    const proximos = lista.filter((e) => e.situacao === "proximos");

    // Limite mais proximo entre os nao impressos de hoje.
    const proxLimite = pendentes
      .map((e) => e.limiteImpressao)
      .filter(Boolean)
      .sort()[0];
    const nivel = conta("estourou") ? "estourou" : conta("risco") ? "risco" : pendentes.length ? "no_prazo" : "ok";

    return `
      <section class="prazos-coluna">
        <header class="prazos-coluna-topo nivel-${nivel}">
          <div class="prazos-coluna-nome">${esc(m.nome)}</div>
          <div class="prazos-coluna-limite">${
            proxLimite
              ? `Imprimir até <b>${fmtHora(proxLimite)}</b> <span>${fmtFalta(proxLimite)}</span>`
              : pendentes.length
              ? "Sem prazo informado"
              : "Nada a imprimir hoje ✓"
          }</div>
          <div class="prazos-janelas">${janelasTexto(m)}</div>
          <div class="prazos-contadores">
            <span class="cont"><b>${pendentes.length}</b> a imprimir</span>
            <span class="cont sit-risco"><b>${conta("risco")}</b> em risco</span>
            <span class="cont sit-estourou"><b>${conta("estourou")}</b> passou do limite</span>
            <span class="cont sit-impresso"><b>${impressos.length}</b> impressos</span>
          </div>
        </header>
        <div class="prazos-cards">
          ${pendentes.map((e) => card(e)).join("") || '<p class="muted empty-msg">Nenhum pedido aguardando impressão.</p>'}
        </div>
        ${grupo("Impressos hoje", impressos)}
        ${grupo("Próximos dias", proximos, (e) => `Prazo ${fmtDiaHora(e.prazo)}`)}
      </section>`;
  }

  function grupo(titulo, lista, detalhe) {
    if (!lista.length) return "";
    return `<details class="prazos-grupo"><summary>${esc(titulo)} (${lista.length})</summary>
      <div class="prazos-cards">${lista.map((e) => card(e, detalhe?.(e))).join("")}</div></details>`;
  }

  function card(e, detalhe) {
    const itens = e.itens
      .slice(0, 3)
      .map((i) => `${i.qtd}× ${esc(i.titulo)}`)
      .join("<br>");
    const mais = e.itens.length > 3 ? `<br><span class="muted">+${e.itens.length - 3} itens</span>` : "";
    const linhaPrazo =
      detalhe ||
      (e.limiteImpressao
        ? `Imprimir até ${fmtHora(e.limiteImpressao)} · ${fmtFalta(e.limiteImpressao)}`
        : "Mercado Livre não informou prazo");
    return `
      <article class="prazos-card sit-${e.situacao}">
        <div class="prazos-card-topo">
          <a href="https://www.mercadolivre.com.br/vendas/${encodeURIComponent(e.venda)}/detalhe" target="_blank" rel="noopener">#${esc(e.venda)}</a>
          <span class="prazos-pill sit-${e.situacao}">${SITUACAO[e.situacao]?.rotulo || esc(e.situacao)}</span>
        </div>
        <div class="prazos-card-conta">${esc(e.conta)}${e.comprador ? ` · ${esc(e.comprador)}` : ""}</div>
        <div class="prazos-card-itens">${itens}${mais}</div>
        <div class="prazos-card-prazo">${linhaPrazo}</div>
      </article>`;
  }

  function atualizarBadge() {
    const n = (dados?.envios || []).filter((e) => ALERTA.has(e.situacao)).length;
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
      (e) => ALERTA.has(e.situacao) && !avisados.has(`${e.shippingId}:${e.situacao}`)
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
        .map((e) => `#${e.venda} ${e.conta} (${e.modalidade}) até ${fmtHora(e.limiteImpressao || e.prazo)}`)
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
