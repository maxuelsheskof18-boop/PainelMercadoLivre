// Modulo Shopee — fase 1: lojas conectadas + sonda da API.
//
// Separado do app.js como o prazos.js: se o index.html publicado ainda nao
// tiver o #shopee-pane, este script nao faz nada. Os estilos ficam aqui
// mesmo (injetados) para nao depender de subir o style.css junto.
(function () {
  const pane = document.getElementById("shopee-pane");
  if (!pane) return;

  const css = `
  .shopee-pane .history-header { border-bottom: 1px solid var(--border); }
  .shopee-corpo { overflow: auto; padding: 20px 24px 32px; display: flex; flex-direction: column; gap: 20px; }
  .shopee-aviso { border: 1px solid #fde68a; background: #fffbeb; color: #78350f; border-radius: var(--radius-md); padding: 14px 16px; font-size: 13.5px; line-height: 1.5; }
  .shopee-aviso code { background: #fef3c7; padding: 1px 5px; border-radius: 4px; }
  .shopee-lojas { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .shopee-loja { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 14px 16px; background: var(--card); display: flex; flex-direction: column; gap: 6px; }
  .shopee-loja-nome { font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 8px; }
  .shopee-loja-nome::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #ee4d2d; flex: none; }
  .shopee-loja-acoes { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .shopee-selo { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-dark); }
  .shopee-selo.teste { background: #fef3c7; color: #92400e; }
  .shopee-vazio { border: 1px dashed var(--border-strong); border-radius: var(--radius-md); padding: 28px; text-align: center; color: var(--muted); }
  .shopee-sonda pre { margin: 0; max-height: 480px; overflow: auto; background: #0f172a; color: #e2e8f0; border-radius: var(--radius-md); padding: 14px; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .shopee-sonda-topo { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .shopee-titulo { font-size: 13px; font-weight: 600; color: var(--text-soft); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 10px; }
  @media (max-width: 900px) { .shopee-corpo { padding: 14px; } }

  /* ---- Identidade de cada marketplace ----
     Mercado Livre = amarelo, Shopee = laranja. O menu ganha dois grupos com
     titulo, e cada aba acende na cor da sua loja. */
  :root { --ml-cor: #ffe600; --ml-texto: #2d3277; --shopee-cor: #ee4d2d; --shopee-escuro: #d73211; --shopee-suave: #fff1ed; }
  .mkt-grupo { display: flex; align-items: center; gap: 8px; padding: 12px 11px 4px; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #8b97b1; white-space: nowrap; }
  .mkt-grupo:first-child { padding-top: 2px; }
  .mkt-grupo::before { content: ""; width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .mkt-grupo.ml::before { background: var(--ml-cor); box-shadow: 0 0 0 2px rgba(255,230,0,.18); }
  .mkt-grupo.shopee::before { background: var(--shopee-cor); box-shadow: 0 0 0 2px rgba(238,77,45,.22); }
  .mkt-grupo.shopee { margin-top: 10px; border-top: 1px solid rgba(255,255,255,.07); padding-top: 14px; }
  .module-nav-item[data-mkt="ml"].active { --nav-accent: var(--ml-cor); background: rgba(255,230,0,.13); }
  .module-nav-item[data-mkt="shopee"].active { --nav-accent: var(--shopee-cor); background: rgba(238,77,45,.2); }
  .module-nav-item[data-mkt="shopee"]:not(.active) .module-nav-icon { color: #f2836b; }
  .module-nav.collapsed .mkt-grupo { font-size: 0; gap: 0; justify-content: center; padding: 10px 0 4px; }
  .module-nav.collapsed .mkt-grupo.shopee { padding-top: 12px; }

  /* Selo "Mercado Livre" nos titulos das telas que so tratam do ML. */
  .mkt-selo { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; vertical-align: middle; margin-left: 8px; letter-spacing: 0; }
  .mkt-selo.ml { background: var(--ml-cor); color: var(--ml-texto); }

  /* Cabecalho da Shopee em laranja. */
  .shopee-pane .shopee-banner { background: linear-gradient(120deg, var(--shopee-cor) 0%, #ff7337 100%); color: #fff; border-bottom: none; position: relative; overflow: hidden; }
  .shopee-banner::after { content: ""; position: absolute; right: -40px; top: -60px; width: 220px; height: 220px; border-radius: 50%; background: rgba(255,255,255,.08); pointer-events: none; }
  .shopee-banner-marca { display: flex; align-items: center; gap: 12px; position: relative; z-index: 1; }
  .shopee-banner-icone { width: 40px; height: 40px; border-radius: 12px; background: rgba(255,255,255,.18); display: grid; place-items: center; flex: none; }
  .shopee-banner-icone svg { width: 22px; height: 22px; }
  .shopee-banner h2 { color: #fff; }
  .shopee-banner #shopee-status { color: rgba(255,255,255,.88); }
  .shopee-banner .shopee-selo { background: rgba(255,255,255,.22); color: #fff; }
  .shopee-banner .history-actions { position: relative; z-index: 1; }
  .shopee-banner #shopee-conectar { background: #fff; color: var(--shopee-escuro); border-color: #fff; }
  .shopee-banner #shopee-conectar:hover { background: var(--shopee-suave); }
  .shopee-loja { border-left: 3px solid var(--shopee-cor); }
  .shopee-titulo { color: var(--shopee-escuro); }
  @media (max-width: 900px) {
    .mkt-grupo { display: none; }
    .module-nav-item[data-mkt="shopee"] { margin-left: 6px; }
  }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // Menu: separa as abas em "Mercado Livre" e "Shopee".
  const navItens = document.querySelector(".module-nav-items");
  if (navItens && !navItens.querySelector(".mkt-grupo")) {
    navItens.querySelectorAll(".module-nav-item").forEach((b) => {
      b.dataset.mkt = b.dataset.module === "shopee" ? "shopee" : "ml";
    });
    const grupo = (classe, texto) => {
      const el = document.createElement("div");
      el.className = `mkt-grupo ${classe}`;
      el.textContent = texto;
      return el;
    };
    navItens.prepend(grupo("ml", "Mercado Livre"));
    navItens.querySelector('[data-module="shopee"]')?.before(grupo("shopee", "Shopee"));
  }
  // Selo amarelo nas telas de largura inteira que sao so do Mercado Livre.
  for (const id of ["prazos-pane", "history-pane"]) {
    const h2 = document.querySelector(`#${id} .history-header h2`);
    if (h2 && !h2.querySelector(".mkt-selo")) {
      h2.insertAdjacentHTML("beforeend", '<span class="mkt-selo ml">Mercado Livre</span>');
    }
  }

  pane.innerHTML = `
    <div class="history-header shopee-banner">
      <div class="shopee-banner-marca">
        <div class="shopee-banner-icone">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14l-1 13H6z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>
        </div>
        <div>
          <h2>Shopee</h2>
          <div id="shopee-status" class="small">Carregando...</div>
        </div>
      </div>
      <div class="history-actions">
        <a id="shopee-conectar" class="btn btn-primary btn-sm" href="/shopee/conectar">+ Conectar loja Shopee</a>
      </div>
    </div>
    <div class="shopee-corpo">
      <div id="shopee-aviso" class="shopee-aviso hidden"></div>
      <section>
        <h3 class="shopee-titulo">Lojas conectadas</h3>
        <div id="shopee-lojas" class="shopee-lojas"></div>
      </section>
      <section id="shopee-sonda" class="shopee-sonda hidden">
        <div class="shopee-sonda-topo">
          <h3 class="shopee-titulo" style="margin:0">Resultado da sonda</h3>
          <button type="button" id="shopee-copiar" class="btn btn-ghost btn-sm">Copiar resultado</button>
        </div>
        <pre id="shopee-sonda-saida"></pre>
      </section>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const statusEl = $("shopee-status");
  const avisoEl = $("shopee-aviso");
  const lojasEl = $("shopee-lojas");
  const conectarBtn = $("shopee-conectar");
  const sondaEl = $("shopee-sonda");
  const saidaEl = $("shopee-sonda-saida");

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const dataHora = (ms) =>
    new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  let estado = null;

  document.querySelectorAll(".module-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const visivel = btn.dataset.module === "shopee";
      pane.classList.toggle("hidden", !visivel);
      if (visivel) carregar();
    });
  });

  async function carregar() {
    try {
      const res = await fetch("/api/shopee/estado");
      if (res.status === 401) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      estado = await res.json();
      render();
    } catch (err) {
      statusEl.textContent = `Erro ao carregar: ${err.message}`;
    }
  }

  function render() {
    const teste = estado.ambiente !== "live";
    statusEl.innerHTML = estado.configurado
      ? `Ambiente: <span class="shopee-selo ${teste ? "teste" : ""}">${teste ? "Teste (sandbox)" : "Produção"}</span> · Partner ID ${esc(estado.partnerId)}`
      : "Chaves da Shopee ainda não configuradas";

    conectarBtn.classList.toggle("hidden", !estado.configurado);
    avisoEl.classList.toggle("hidden", estado.configurado && !teste);
    if (!estado.configurado) {
      avisoEl.innerHTML =
        "Faltam as chaves do app no Render: <code>SHOPEE_PARTNER_ID</code> e <code>SHOPEE_PARTNER_KEY</code> " +
        "(e <code>SHOPEE_ENV</code> = <code>test</code> ou <code>live</code>). Depois de salvar, o Render reinicia sozinho.";
    } else if (teste) {
      avisoEl.innerHTML =
        "Modo <b>teste</b>: só conecta loja de teste criada em <i>Tools › Test Account-Sandbox</i> no console da Shopee. " +
        "Para as lojas reais, troque para as chaves de produção e <code>SHOPEE_ENV=live</code> depois do Go-Live.";
    }

    if (!estado.contas.length) {
      lojasEl.innerHTML = `<div class="shopee-vazio">Nenhuma loja conectada ainda.${
        estado.configurado ? " Clique em <b>Conectar loja Shopee</b> e entre com a conta da loja." : ""
      }</div>`;
      return;
    }
    lojasEl.innerHTML = estado.contas
      .map((c) => {
        const vencida = c.reconectarAte && c.reconectarAte < Date.now();
        return `
        <div class="shopee-loja" data-shop="${esc(c.shopId)}">
          <div class="shopee-loja-nome">${esc(c.nome || `Loja ${c.shopId}`)}</div>
          <div class="muted small">ID ${esc(c.shopId)} · ${c.ambiente === "live" ? "produção" : "teste"}</div>
          <div class="muted small">${
            vencida
              ? '<span style="color:var(--danger)">Autorização vencida — conecte de novo</span>'
              : c.reconectarAte
                ? `Reconectar até ${dataHora(c.reconectarAte)}`
                : ""
          }</div>
          <div class="shopee-loja-acoes">
            <button type="button" class="btn btn-ghost btn-sm" data-acao="sonda">Rodar sonda</button>
            <button type="button" class="btn btn-ghost btn-sm" data-acao="renomear">Renomear</button>
            <button type="button" class="btn btn-ghost btn-sm" data-acao="remover">Desconectar</button>
          </div>
        </div>`;
      })
      .join("");
  }

  lojasEl.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-acao]");
    if (!btn) return;
    const shopId = btn.closest(".shopee-loja").dataset.shop;
    const acao = btn.dataset.acao;

    if (acao === "sonda") {
      btn.disabled = true;
      btn.textContent = "Rodando...";
      sondaEl.classList.remove("hidden");
      saidaEl.textContent = "Consultando a Shopee (pode levar alguns segundos)...";
      try {
        const res = await fetch(`/api/debug/probe-shopee?shopId=${encodeURIComponent(shopId)}`);
        const json = await res.json();
        saidaEl.textContent = JSON.stringify(json, null, 2);
      } catch (err) {
        saidaEl.textContent = `Falhou: ${err.message}`;
      } finally {
        btn.disabled = false;
        btn.textContent = "Rodar sonda";
      }
    } else if (acao === "renomear") {
      const nome = prompt("Nome da loja no painel:");
      if (!nome) return;
      await fetch(`/api/shopee/contas/${encodeURIComponent(shopId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome }),
      });
      carregar();
    } else if (acao === "remover") {
      if (!confirm("Desconectar esta loja do painel? (Para voltar, é só conectar de novo.)")) return;
      await fetch(`/api/shopee/contas/${encodeURIComponent(shopId)}`, { method: "DELETE" });
      carregar();
    }
  });

  $("shopee-copiar").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(saidaEl.textContent);
      $("shopee-copiar").textContent = "Copiado ✓";
      setTimeout(() => ($("shopee-copiar").textContent = "Copiar resultado"), 1500);
    } catch {
      alert("Não deu para copiar automaticamente — selecione o texto e copie.");
    }
  });

  // Voltando da autorizacao da Shopee (/?modulo=shopee): abre direto aqui.
  if (new URLSearchParams(location.search).get("modulo") === "shopee") {
    history.replaceState(null, "", "/");
    document.querySelector('.module-nav-item[data-module="shopee"]')?.click();
  }
})();
