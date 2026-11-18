// Modulo Shopee: Prazos de despacho, Chat, Devolucoes e Lojas (conexao +
// sonda).
//
// Separado do app.js como o prazos.js: se o index.html publicado ainda nao
// tiver o #shopee-pane, este script nao faz nada. Os estilos ficam aqui
// mesmo (injetados) para nao depender de subir o style.css junto.
(function () {
  const pane = document.getElementById("shopee-pane");
  if (!pane) return;

  const css = `
  .shopee-pane .history-header { border-bottom: 1px solid var(--border); }
  .shopee-corpo { overflow: auto; padding: 20px 24px 32px; display: flex; flex-direction: column; gap: 20px; flex: 1; min-height: 0; }
  .shopee-corpo.sp-sem-rolagem { overflow: hidden; padding: 0; }
  .shopee-aviso { border: 1px solid #fde68a; background: #fffbeb; color: #78350f; border-radius: var(--radius-md); padding: 14px 16px; font-size: 13.5px; line-height: 1.5; }
  .shopee-aviso code { background: #fef3c7; padding: 1px 5px; border-radius: 4px; }
  .shopee-aviso.erro { border-color: #fecaca; background: #fef2f2; color: #991b1b; }
  .shopee-lojas { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .shopee-loja { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 14px 16px; background: var(--card); display: flex; flex-direction: column; gap: 6px; }
  .shopee-loja-nome { font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 8px; }
  .shopee-loja-nome::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #ee4d2d; flex: none; }
  .shopee-loja-acoes { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .shopee-selo { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-dark); }
  .shopee-selo.teste { background: #fef3c7; color: #92400e; }
  .shopee-vazio { border: 1px dashed var(--border-strong); border-radius: var(--radius-md); padding: 28px; text-align: center; color: var(--muted); line-height: 1.6; }
  .shopee-vazio b { color: var(--text-soft); }
  .shopee-sonda pre { margin: 0; max-height: 480px; overflow: auto; background: #0f172a; color: #e2e8f0; border-radius: var(--radius-md); padding: 14px; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .shopee-sonda-topo { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .shopee-titulo { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 10px; }
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
  .module-nav-item[data-mkt="shopee"] .module-badge { background: var(--shopee-cor); color: #fff; }
  .module-nav.collapsed .mkt-grupo { font-size: 0; gap: 0; justify-content: center; padding: 10px 0 4px; }
  .module-nav.collapsed .mkt-grupo.shopee { padding-top: 12px; }

  .mkt-selo { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; vertical-align: middle; margin-left: 8px; letter-spacing: 0; }
  .mkt-selo.ml { background: var(--ml-cor); color: var(--ml-texto); }

  /* Cabecalho laranja com as abas do modulo. */
  .shopee-pane .shopee-banner { background: linear-gradient(120deg, var(--shopee-cor) 0%, #ff7337 100%); color: #fff; border-bottom: none; position: relative; overflow: hidden; padding-bottom: 0; row-gap: 10px; }
  .shopee-banner::after { content: ""; position: absolute; right: -40px; top: -60px; width: 220px; height: 220px; border-radius: 50%; background: rgba(255,255,255,.08); pointer-events: none; }
  .shopee-banner-marca { display: flex; align-items: center; gap: 12px; position: relative; z-index: 1; }
  .shopee-banner-icone { width: 40px; height: 40px; border-radius: 12px; background: rgba(255,255,255,.18); display: grid; place-items: center; flex: none; }
  .shopee-banner-icone svg { width: 22px; height: 22px; }
  .shopee-banner h2 { color: #fff; }
  .shopee-banner #shopee-status { color: rgba(255,255,255,.88); }
  .shopee-banner .shopee-selo { background: rgba(255,255,255,.22); color: #fff; }
  .shopee-banner .history-actions { position: relative; z-index: 1; display: flex; gap: 8px; align-items: center; }
  .shopee-banner .sp-btn-claro { background: #fff; color: var(--shopee-escuro); border-color: #fff; }
  .shopee-banner .sp-btn-claro:hover { background: var(--shopee-suave); }
  .shopee-banner .sp-btn-vidro { background: rgba(255,255,255,.16); color: #fff; border-color: rgba(255,255,255,.3); }
  .shopee-banner .sp-btn-vidro:hover { background: rgba(255,255,255,.26); }
  .sp-abas { flex-basis: 100%; display: flex; gap: 4px; position: relative; z-index: 1; overflow-x: auto; scrollbar-width: none; }
  .sp-abas::-webkit-scrollbar { display: none; }
  .sp-aba { border: none; background: transparent; color: rgba(255,255,255,.85); font: inherit; font-size: 13.5px; font-weight: 600; padding: 9px 14px 11px; border-radius: 10px 10px 0 0; cursor: pointer; display: flex; align-items: center; gap: 7px; white-space: nowrap; }
  .sp-aba:hover { background: rgba(255,255,255,.12); color: #fff; }
  .sp-aba.ativa { background: var(--card); color: var(--shopee-escuro); }
  .sp-aba .sp-conta { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: rgba(255,255,255,.25); color: #fff; font-size: 11px; display: inline-grid; place-items: center; }
  .sp-aba.ativa .sp-conta { background: var(--shopee-cor); }
  .sp-aba .sp-conta:empty { display: none; }
  .shopee-loja { border-left: 3px solid var(--shopee-cor); }
  .shopee-titulo { color: var(--shopee-escuro); }

  /* ---- Barra de ferramentas ---- */
  .sp-barra { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sp-barra .sp-esp { flex: 1; }
  .sp-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 10px; padding: 2px; background: var(--bg); }
  .sp-seg button { border: none; background: transparent; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--muted); padding: 5px 11px; border-radius: 8px; cursor: pointer; }
  .sp-seg button.ativo { background: var(--card); color: var(--text); box-shadow: var(--shadow-sm); }
  .sp-select { border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; font: inherit; font-size: 13px; background: var(--card); color: var(--text); }

  /* ---- Cartoes de resumo ---- */
  .sp-cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .sp-cartao { border: 1px solid var(--border); border-radius: 14px; padding: 13px 14px; background: var(--card); text-align: left; font: inherit; cursor: pointer; position: relative; overflow: hidden; transition: transform .12s, box-shadow .12s; }
  .sp-cartao:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }
  .sp-cartao::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--sp-cor, var(--border)); }
  .sp-cartao.ativo { border-color: var(--sp-cor); box-shadow: 0 0 0 2px color-mix(in srgb, var(--sp-cor) 22%, transparent); }
  .sp-cartao-num { font-size: 26px; font-weight: 750; letter-spacing: -.02em; color: var(--text); line-height: 1.1; }
  .sp-cartao-rot { font-size: 12.5px; color: var(--muted); font-weight: 600; margin-top: 3px; }
  .sp-cartao-sub { font-size: 11.5px; color: var(--muted); margin-top: 6px; }
  .sp-cartao.zero .sp-cartao-num { color: var(--border-strong); }

  /* ---- Prazos: grupos e linhas ---- */
  .sp-grupo-tit { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-soft); margin: 4px 0 8px; }
  .sp-grupo-tit .sp-bolinha { width: 9px; height: 9px; border-radius: 50%; background: var(--sp-cor); }
  .sp-grupo-tit .sp-qtd { color: var(--muted); font-weight: 600; letter-spacing: 0; text-transform: none; }
  .sp-lista { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; background: var(--card); }
  .sp-ped { display: grid; grid-template-columns: 112px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 11px 14px; border-top: 1px solid var(--border); }
  .sp-ped:first-child { border-top: none; }
  .sp-prazo { border-radius: 10px; padding: 6px 8px; text-align: center; background: color-mix(in srgb, var(--sp-cor) 12%, transparent); color: color-mix(in srgb, var(--sp-cor) 80%, #000); }
  .sp-prazo b { display: block; font-size: 14px; font-variant-numeric: tabular-nums; }
  .sp-prazo span { font-size: 11px; opacity: .85; }
  .sp-ped-meio { min-width: 0; }
  .sp-ped-topo { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sp-sn { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; font-weight: 600; color: var(--text); }
  .sp-itens { font-size: 13px; color: var(--text-soft); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sp-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 650; padding: 2px 8px; border-radius: 999px; background: var(--bg); color: var(--text-soft); border: 1px solid var(--border); white-space: nowrap; }
  .sp-chip.loja { background: color-mix(in srgb, var(--sp-loja) 12%, #fff); border-color: color-mix(in srgb, var(--sp-loja) 30%, #fff); color: color-mix(in srgb, var(--sp-loja) 75%, #000); }
  .sp-chip.organizar { background: #fff7ed; border-color: #fed7aa; color: #9a3412; }
  .sp-chip.aguardando { background: #eff6ff; border-color: #bfdbfe; color: #1e40af; }
  .sp-ped-dir { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; font-size: 12px; color: var(--muted); text-align: right; }
  .sp-tabela { width: 100%; border-collapse: collapse; font-size: 13px; }
  .sp-tabela th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 650; padding: 10px 14px; background: var(--bg); }
  .sp-tabela td { padding: 10px 14px; border-top: 1px solid var(--border); }
  .sp-tabela td.num { font-weight: 750; font-size: 15px; font-variant-numeric: tabular-nums; }
  @media (max-width: 700px) {
    .sp-ped { grid-template-columns: 88px minmax(0, 1fr); }
    .sp-ped-dir { grid-column: 1 / -1; flex-direction: row; justify-content: flex-start; }
  }

  /* ---- Chat ---- */
  .sp-chat { display: grid; grid-template-columns: 340px minmax(0, 1fr); height: 100%; min-height: 0; }
  .sp-chat-lista { border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  .sp-chat-filtros { padding: 12px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--border); }
  .sp-busca { border: 1px solid var(--border); border-radius: 10px; padding: 8px 11px; font: inherit; font-size: 13px; width: 100%; background: var(--bg); }
  .sp-conversas { overflow-y: auto; flex: 1; }
  .sp-conv { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 10px; padding: 11px 12px; border-bottom: 1px solid var(--border); cursor: pointer; align-items: center; }
  .sp-conv:hover { background: var(--bg); }
  .sp-conv.ativa { background: var(--shopee-suave); }
  .sp-avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; color: #fff; background: var(--sp-loja, var(--shopee-cor)); overflow: hidden; font-size: 15px; }
  .sp-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .sp-conv-nome { font-weight: 650; font-size: 13.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sp-conv.nao-lida .sp-conv-nome { font-weight: 800; }
  .sp-conv-prev { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .sp-conv.nao-lida .sp-conv-prev { color: var(--text-soft); font-weight: 600; }
  .sp-conv-dir { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; font-size: 11px; color: var(--muted); }
  .sp-nao-lidas { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--shopee-cor); color: #fff; font-weight: 700; font-size: 11px; display: grid; place-items: center; }
  .sp-thread { display: flex; flex-direction: column; min-height: 0; background: #faf7f5; }
  .sp-thread-topo { padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--card); display: flex; align-items: center; gap: 10px; }
  .sp-thread-topo .sp-voltar { display: none; }
  .sp-msgs { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
  .sp-dia { align-self: center; font-size: 11px; font-weight: 650; color: var(--muted); background: var(--card); border: 1px solid var(--border); padding: 2px 10px; border-radius: 999px; margin: 8px 0; }
  .sp-msg { max-width: min(72%, 520px); padding: 8px 11px 6px; border-radius: 14px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; box-shadow: var(--shadow-sm); }
  .sp-msg.dele { align-self: flex-start; background: var(--card); border-bottom-left-radius: 4px; }
  .sp-msg.nossa { align-self: flex-end; background: #ffe3d9; border-bottom-right-radius: 4px; }
  .sp-msg img { max-width: 220px; border-radius: 8px; display: block; }
  .sp-msg-hora { font-size: 10.5px; color: var(--muted); text-align: right; margin-top: 2px; }
  .sp-composer { border-top: 1px solid var(--border); background: var(--card); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .sp-rapidas { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .sp-rapidas button { border: 1px solid #fed7c9; background: var(--shopee-suave); color: var(--shopee-escuro); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .sp-composer-linha { display: flex; gap: 8px; align-items: flex-end; }
  .sp-composer textarea { flex: 1; resize: none; border: 1px solid var(--border); border-radius: 12px; padding: 9px 11px; font: inherit; font-size: 13.5px; min-height: 42px; max-height: 140px; }
  .sp-btn-shopee { background: var(--shopee-cor); border-color: var(--shopee-cor); color: #fff; }
  .sp-btn-shopee:hover { background: var(--shopee-escuro); border-color: var(--shopee-escuro); }
  .sp-thread-vazio { margin: auto; color: var(--muted); text-align: center; padding: 30px; }
  @media (max-width: 900px) {
    .sp-chat { grid-template-columns: 1fr; }
    .sp-chat.com-conversa .sp-chat-lista { display: none; }
    .sp-chat:not(.com-conversa) .sp-thread { display: none; }
    .sp-thread-topo .sp-voltar { display: inline-flex; }
    .sp-msg { max-width: 85%; }
  }

  /* ---- Devolucoes ---- */
  .sp-dev { border: 1px solid var(--border); border-radius: 14px; background: var(--card); padding: 14px 16px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; }
  .sp-dev + .sp-dev { margin-top: 10px; }
  .sp-dev.aberta { border-left: 4px solid var(--shopee-cor); }
  .sp-dev-motivo { font-weight: 700; color: var(--text); font-size: 14px; }
  .sp-dev-texto { font-size: 13px; color: var(--text-soft); margin-top: 4px; font-style: italic; }
  .sp-dev-itens { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
  .sp-dev-dir { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .sp-valor { font-size: 17px; font-weight: 750; color: var(--text); font-variant-numeric: tabular-nums; }
  .sp-st { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; }
  @media (max-width: 700px) { .sp-dev { grid-template-columns: 1fr; } .sp-dev-dir { align-items: flex-start; text-align: left; } }

  @media (max-width: 900px) {
    /* No celular o .history-header vira coluna (style.css): flex-basis 100%
       viraria ALTURA 100% e espremia as abas num canto. */
    .shopee-pane .shopee-banner { flex-direction: row; flex-wrap: wrap; align-items: center; padding: 12px 14px 0; }
    .shopee-banner .history-actions { flex: 1 1 100%; }
    .shopee-banner .history-actions .sp-select { flex: 1; min-width: 0; }
    .sp-abas { flex: 1 1 100%; }
    .sp-aba { padding: 8px 12px 10px; }
    .mkt-grupo { display: none; }
    .module-nav-item[data-mkt="shopee"] { margin-left: 6px; }
  }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // Menu: separa as abas em "Mercado Livre" e "Shopee".
  const navItens = document.querySelector(".module-nav-items");
  const navShopee = document.querySelector('.module-nav-item[data-module="shopee"]');
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
    navShopee?.before(grupo("shopee", "Shopee"));
  }
  let badgeNav = document.getElementById("module-badge-shopee");
  if (navShopee && !badgeNav) {
    badgeNav = document.createElement("span");
    badgeNav.id = "module-badge-shopee";
    badgeNav.className = "tab-count module-badge hidden";
    navShopee.appendChild(badgeNav);
  }
  // Selo amarelo nas telas de largura inteira que sao so do Mercado Livre.
  for (const id of ["prazos-pane", "history-pane"]) {
    const h2 = document.querySelector(`#${id} .history-header h2`);
    if (h2 && !h2.querySelector(".mkt-selo")) {
      h2.insertAdjacentHTML("beforeend", '<span class="mkt-selo ml">Mercado Livre</span>');
    }
  }

  const ABAS = [
    { id: "prazos", nome: "Prazos" },
    { id: "chat", nome: "Chat" },
    { id: "devolucoes", nome: "Devoluções" },
    { id: "lojas", nome: "Lojas" },
  ];

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
        <select id="sp-loja-filtro" class="sp-select sp-btn-vidro" title="Filtrar por loja"></select>
        <button type="button" id="sp-atualizar" class="btn btn-sm sp-btn-vidro" title="Buscar agora na Shopee">⟳ Atualizar</button>
      </div>
      <nav class="sp-abas">${ABAS.map(
        (a) => `<button type="button" class="sp-aba" data-aba="${a.id}">${a.nome}<span class="sp-conta" id="sp-conta-${a.id}"></span></button>`
      ).join("")}</nav>
    </div>
    <div id="sp-corpo" class="shopee-corpo"></div>`;

  const $ = (id) => document.getElementById(id);
  const statusEl = $("shopee-status");
  const corpo = $("sp-corpo");
  const lojaSel = $("sp-loja-filtro");

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const TZ = "America/Sao_Paulo";
  const dataHora = (ms) =>
    new Date(ms).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const hora = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const diaSP = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
  const diaRotulo = (ms) => {
    const d = diaSP(ms);
    if (d === diaSP(Date.now())) return "Hoje";
    if (d === diaSP(Date.now() - 864e5)) return "Ontem";
    if (d === diaSP(Date.now() + 864e5)) return "Amanhã";
    return new Date(ms).toLocaleDateString("pt-BR", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
  };
  const brl = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const duracao = (ms) => {
    const neg = ms < 0;
    const m = Math.round(Math.abs(ms) / 60000);
    const t = m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${Math.round(m / 1440)} dias`;
    return neg ? `há ${t}` : t;
  };
  const relativo = (ms) => {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return "agora";
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (diaSP(ms) === diaSP(Date.now())) return hora(ms);
    return new Date(ms).toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
  };

  // Uma cor por loja (sempre a mesma para o mesmo shopId).
  const CORES_LOJA = ["#ee4d2d", "#7c3aed", "#0891b2", "#16a34a", "#db2777", "#ca8a04"];
  const corLoja = (shopId) => {
    const ids = (estado?.contas || []).map((c) => c.shopId);
    const i = ids.indexOf(String(shopId));
    return CORES_LOJA[(i < 0 ? 0 : i) % CORES_LOJA.length];
  };
  const chipLoja = (shopId, nome) =>
    `<span class="sp-chip loja" style="--sp-loja:${corLoja(shopId)}">${esc(nome)}</span>`;

  const lerPref = (k, padrao) => {
    try {
      return localStorage.getItem(`shopee.${k}`) || padrao;
    } catch {
      return padrao;
    }
  };
  const salvarPref = (k, v) => {
    try {
      localStorage.setItem(`shopee.${k}`, v);
    } catch {}
  };

  let visivel = false;
  let aba = lerPref("aba", "prazos");
  let lojaFiltro = "";
  let estado = null; // /api/shopee/estado
  const passaLoja = (shopId) => !lojaFiltro || String(shopId) === lojaFiltro;

  async function api(url, opcoes) {
    const res = await fetch(url, opcoes);
    if (res.status === 401) throw new Error("Sessão expirou — entre de novo no painel.");
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  // ---------- Mostrar/esconder ----------
  document.querySelectorAll(".module-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      visivel = btn.dataset.module === "shopee";
      pane.classList.toggle("hidden", !visivel);
      if (visivel) abrir();
    });
  });

  pane.querySelectorAll(".sp-aba").forEach((b) =>
    b.addEventListener("click", () => {
      aba = b.dataset.aba;
      salvarPref("aba", aba);
      render();
      carregarAba();
    })
  );
  lojaSel.addEventListener("change", () => {
    lojaFiltro = lojaSel.value;
    render();
  });
  $("sp-atualizar").addEventListener("click", () => carregarAba({ forcar: true }));

  async function abrir() {
    await carregarEstado();
    render();
    carregarAba();
  }

  async function carregarEstado() {
    try {
      estado = await api("/api/shopee/estado");
    } catch (err) {
      statusEl.textContent = `Erro ao carregar: ${err.message}`;
      return;
    }
    const teste = estado.ambiente !== "live";
    const n = estado.contas.length;
    statusEl.innerHTML = estado.configurado
      ? `<span class="shopee-selo ${teste ? "teste" : ""}">${teste ? "Teste (sandbox)" : "Produção"}</span> · ${n} loja${n === 1 ? "" : "s"} conectada${n === 1 ? "" : "s"}`
      : "Chaves da Shopee ainda não configuradas";
    const atual = lojaFiltro;
    lojaSel.innerHTML =
      `<option value="">Todas as lojas</option>` +
      estado.contas.map((c) => `<option value="${esc(c.shopId)}">${esc(c.nome || `Loja ${c.shopId}`)}</option>`).join("");
    lojaSel.value = estado.contas.some((c) => c.shopId === atual) ? atual : "";
    lojaFiltro = lojaSel.value;
    lojaSel.classList.toggle("hidden", n < 2);
  }

  function carregarAba(opcoes = {}) {
    if (aba === "prazos") return carregarPrazos(opcoes);
    if (aba === "chat") return carregarChat(opcoes);
    if (aba === "devolucoes") return carregarDevolucoes(opcoes);
    return carregarEstado().then(render);
  }

  function render() {
    pane.querySelectorAll(".sp-aba").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === aba));
    $("sp-atualizar").classList.toggle("hidden", aba === "lojas");
    corpo.classList.toggle("sp-sem-rolagem", aba === "chat");
    if (!estado) return;
    // Sem loja conectada, as abas de dados so explicam o que falta.
    if (aba !== "lojas" && (!estado.configurado || !estado.contas.length)) {
      corpo.innerHTML = `<div class="shopee-vazio">Nenhuma loja Shopee conectada ainda.<br>Abra a aba <b>Lojas</b> e clique em <b>Conectar loja Shopee</b>.</div>`;
      return;
    }
    if (aba === "prazos") renderPrazos();
    else if (aba === "chat") renderChat();
    else if (aba === "devolucoes") renderDevolucoes();
    else renderLojas();
  }

  function errosDeLoja(erros) {
    const lista = Object.entries(erros || {});
    if (!lista.length) return "";
    const nome = (id) => estado.contas.find((c) => c.shopId === id)?.nome || `Loja ${id}`;
    return `<div class="shopee-aviso erro">${lista
      .map(([id, e]) => `<b>${esc(nome(id))}:</b> ${esc(traduzErro(e))}`)
      .join("<br>")}</div>`;
  }
  function traduzErro(e) {
    if (/permission/i.test(e)) return "a Shopee ainda não liberou esta função para o app (permissão). Peça a liberação no console.";
    if (/invalid_access_token|invalid_acceess_token|error_auth/i.test(e)) return "autorização da loja expirou — conecte a loja de novo na aba Lojas.";
    if (/invalid_partner_id/i.test(e)) return "chave do app não confere com a loja (confira SHOPEE_ENV e as chaves no Render).";
    return e;
  }

  // =====================================================================
  // PRAZOS
  // =====================================================================
  const SIT = {
    atrasado: { nome: "Atrasados", cor: "#dc2626" },
    risco: { nome: "Em risco", cor: "#ea580c" },
    hoje: { nome: "Vencem hoje", cor: "#d97706" },
    no_prazo: { nome: "No prazo", cor: "#16a34a" },
    sem_prazo: { nome: "Sem prazo", cor: "#6b7280" },
  };
  let prazos = null;
  let prazosFiltro = lerPref("prazosFiltro", "");
  let prazosModo = lerPref("prazosModo", "pedido");

  async function carregarPrazos({ forcar = false } = {}) {
    try {
      prazos = await api(forcar ? "/api/shopee/prazos/atualizar" : "/api/shopee/prazos", { method: forcar ? "POST" : "GET" });
      if (aba === "prazos" && visivel) render();
      atualizarContas();
    } catch (err) {
      if (aba === "prazos") corpo.innerHTML = `<div class="shopee-aviso erro">Erro ao carregar os prazos: ${esc(err.message)}</div>`;
    }
  }

  function renderPrazos() {
    if (!prazos) {
      corpo.innerHTML = `<div class="shopee-vazio">Carregando pedidos...</div>`;
      return;
    }
    const agora = Date.now();
    const todos = prazos.pedidos.filter((p) => passaLoja(p.shopId));
    const conta = (f) => todos.filter(f).length;
    const cartoes = [
      { id: "atrasado", nome: "Atrasados", cor: SIT.atrasado.cor, n: conta((p) => p.situacao === "atrasado"), sub: "prazo da Shopee já passou" },
      { id: "risco", nome: "Em risco", cor: SIT.risco.cor, n: conta((p) => p.situacao === "risco"), sub: `vencem em menos de ${prazos.margemRiscoHoras}h` },
      { id: "hoje", nome: "Vencem hoje", cor: SIT.hoje.cor, n: conta((p) => p.situacao === "hoje"), sub: "ainda dá tempo" },
      { id: "organizar", nome: "A organizar", cor: "#9a3412", n: conta((p) => p.etapa === "organizar"), sub: "falta gerar a etiqueta" },
      { id: "aguardando", nome: "Aguardando saída", cor: "#1e40af", n: conta((p) => p.etapa === "aguardando"), sub: "coleta ou postagem" },
    ];
    const filtrados = todos.filter((p) =>
      !prazosFiltro ? true : prazosFiltro === "organizar" || prazosFiltro === "aguardando" ? p.etapa === prazosFiltro : p.situacao === prazosFiltro
    );
    const atualizado = prazos.atualizadoEm ? `atualizado às ${hora(prazos.atualizadoEm)}` : "primeira busca em andamento...";
    const errosLojas = Object.fromEntries(
      Object.entries(prazos.lojas || {}).filter(([, l]) => l.erro).map(([id, l]) => [id, l.erro])
    );

    let html = errosDeLoja(errosLojas);
    html += `<div class="sp-cartoes">${cartoes
      .map(
        (c) => `<button type="button" class="sp-cartao ${c.n ? "" : "zero"} ${prazosFiltro === c.id ? "ativo" : ""}" data-filtro="${c.id}" style="--sp-cor:${c.cor}">
          <div class="sp-cartao-num">${c.n}</div><div class="sp-cartao-rot">${c.nome}</div><div class="sp-cartao-sub">${c.sub}</div>
        </button>`
      )
      .join("")}</div>`;
    html += `<div class="sp-barra">
      <div class="sp-seg"><button type="button" data-modo="pedido" class="${prazosModo === "pedido" ? "ativo" : ""}">Por pedido</button><button type="button" data-modo="produto" class="${prazosModo === "produto" ? "ativo" : ""}">O que separar</button></div>
      ${prazosFiltro ? `<button type="button" class="btn btn-ghost btn-sm" data-filtro="">✕ ${esc(cartoes.find((c) => c.id === prazosFiltro)?.nome || "")}</button>` : ""}
      <span class="sp-esp"></span><span class="muted small">${filtrados.length} pedido${filtrados.length === 1 ? "" : "s"} · ${atualizado}</span>
    </div>`;

    if (!todos.length) {
      html += `<div class="shopee-vazio">${prazos.atualizadoEm ? "🎉 Nenhum pedido esperando envio." : "Buscando os pedidos na Shopee..."}</div>`;
    } else if (!filtrados.length) {
      html += `<div class="shopee-vazio">Nada neste filtro.</div>`;
    } else if (prazosModo === "produto") {
      html += tabelaProdutos(filtrados);
    } else {
      const grupos = [
        { nome: "Atrasados", cor: SIT.atrasado.cor, f: (p) => p.situacao === "atrasado" },
        { nome: "Hoje", cor: SIT.hoje.cor, f: (p) => p.prazo && p.situacao !== "atrasado" && diaSP(p.prazo) === diaSP(agora) },
        { nome: "Amanhã", cor: "#2563eb", f: (p) => p.prazo && diaSP(p.prazo) === diaSP(agora + 864e5) },
        { nome: "Próximos dias", cor: SIT.no_prazo.cor, f: (p) => p.prazo && p.prazo > agora && diaSP(p.prazo) > diaSP(agora + 864e5) },
        { nome: "Sem prazo informado", cor: SIT.sem_prazo.cor, f: (p) => !p.prazo },
      ];
      for (const g of grupos) {
        const lista = filtrados.filter(g.f);
        if (!lista.length) continue;
        html += `<section><div class="sp-grupo-tit" style="--sp-cor:${g.cor}"><span class="sp-bolinha"></span>${g.nome}<span class="sp-qtd">${lista.length}</span></div>
          <div class="sp-lista">${lista.map(linhaPedido).join("")}</div></section>`;
      }
    }
    corpo.innerHTML = html;
    corpo.querySelectorAll("[data-filtro]").forEach((b) =>
      b.addEventListener("click", () => {
        prazosFiltro = prazosFiltro === b.dataset.filtro ? "" : b.dataset.filtro;
        salvarPref("prazosFiltro", prazosFiltro);
        renderPrazos();
      })
    );
    corpo.querySelectorAll("[data-modo]").forEach((b) =>
      b.addEventListener("click", () => {
        prazosModo = b.dataset.modo;
        salvarPref("prazosModo", prazosModo);
        renderPrazos();
      })
    );
  }

  function linhaPedido(p) {
    const cor = SIT[p.situacao]?.cor || "#6b7280";
    const falta = p.prazo ? p.prazo - Date.now() : null;
    const prazoHtml = p.prazo
      ? `<b>${falta < 0 ? duracao(falta) : duracao(falta)}</b><span>${falta < 0 ? "atrasado" : "até " + (diaSP(p.prazo) === diaSP(Date.now()) ? hora(p.prazo) : dataHora(p.prazo))}</span>`
      : `<b>—</b><span>sem prazo</span>`;
    const itens = p.itens.map((i) => `${i.qtd}× ${i.nome}${i.variacao ? ` (${i.variacao})` : ""}`).join(" · ") || "—";
    const etapa =
      p.etapa === "organizar"
        ? `<span class="sp-chip organizar">Organizar envio</span>`
        : `<span class="sp-chip aguardando">${p.modalidade === "agencia" ? "Aguardando postagem" : p.modalidade === "coleta" ? "Aguardando coleta" : "Aguardando saída"}</span>`;
    const modalidade = p.modalidade === "coleta" ? "🚚 Coleta" : p.modalidade === "agencia" ? "🏪 Agência" : "";
    return `<div class="sp-ped">
      <div class="sp-prazo" style="--sp-cor:${cor}">${prazoHtml}</div>
      <div class="sp-ped-meio">
        <div class="sp-ped-topo"><span class="sp-sn">${esc(p.orderSn)}</span>${chipLoja(p.shopId, p.loja)}${etapa}</div>
        <div class="sp-itens" title="${esc(itens)}">${esc(itens)}</div>
      </div>
      <div class="sp-ped-dir">${modalidade ? `<span>${modalidade}</span>` : ""}${p.transportadora ? `<span>${esc(p.transportadora)}</span>` : ""}${
        p.coletaTexto ? `<span>coleta: ${esc(p.coletaTexto)}</span>` : ""
      }</div>
    </div>`;
  }

  // "O que separar": soma os itens dos pedidos filtrados por produto.
  function tabelaProdutos(lista) {
    const mapa = new Map();
    for (const p of lista) {
      for (const i of p.itens) {
        const chave = `${i.nome}|${i.variacao}|${i.sku}`;
        const atual = mapa.get(chave) || { ...i, qtd: 0, pedidos: 0, prazo: Infinity };
        atual.qtd += i.qtd;
        atual.pedidos += 1;
        if (p.prazo && p.prazo < atual.prazo) atual.prazo = p.prazo;
        mapa.set(chave, atual);
      }
    }
    const linhas = [...mapa.values()].sort((a, b) => a.prazo - b.prazo || b.qtd - a.qtd);
    return `<div class="sp-lista"><table class="sp-tabela">
      <thead><tr><th>Produto</th><th>SKU</th><th>Qtd</th><th>Pedidos</th><th>Primeiro prazo</th></tr></thead>
      <tbody>${linhas
        .map(
          (l) => `<tr><td>${esc(l.nome)}${l.variacao ? `<div class="muted small">${esc(l.variacao)}</div>` : ""}</td>
          <td class="muted">${esc(l.sku || "—")}</td><td class="num">${l.qtd}</td><td>${l.pedidos}</td>
          <td>${Number.isFinite(l.prazo) ? (l.prazo < Date.now() ? `<b style="color:${SIT.atrasado.cor}">atrasado</b>` : dataHora(l.prazo)) : "—"}</td></tr>`
        )
        .join("")}</tbody></table></div>`;
  }

  // =====================================================================
  // CHAT
  // =====================================================================
  let chat = null; // { conversas, erros }
  let conversaAberta = null; // { shopId, id, compradorId, comprador, loja, ultimaMensagemId }
  let msgsAbertas = [];
  let chatFiltro = lerPref("chatFiltro", "todas");
  let chatBusca = "";
  let enviando = false;
  const RAPIDAS = [
    "Olá! Obrigado pela mensagem 😊 Já vamos verificar e te respondemos.",
    "Seu pedido já está sendo separado e será enviado dentro do prazo.",
    "Seu pedido foi enviado! Você pode acompanhar pelo rastreio na página do pedido.",
    "Temos sim! Pode finalizar a compra que enviamos rapidinho.",
    "Obrigado pela compra! Qualquer dúvida estamos à disposição.",
  ];

  async function carregarChat({ forcar = false } = {}) {
    try {
      chat = await api(`/api/shopee/chat${forcar ? "?forcar=1" : ""}`);
      if (aba === "chat" && visivel) {
        if (!corpo.querySelector(".sp-chat")) render();
        else renderListaConversas();
      }
      atualizarContas();
      if (conversaAberta && forcar) carregarMensagens();
    } catch (err) {
      if (aba === "chat") corpo.innerHTML = `<div class="shopee-aviso erro" style="margin:16px">Erro ao carregar o chat: ${esc(err.message)}</div>`;
    }
  }

  function renderChat() {
    corpo.innerHTML = `<div class="sp-chat ${conversaAberta ? "com-conversa" : ""}">
      <div class="sp-chat-lista">
        <div class="sp-chat-filtros">
          <input type="search" class="sp-busca" id="sp-busca" placeholder="Buscar comprador ou mensagem..." value="${esc(chatBusca)}">
          <div class="sp-seg"><button type="button" data-cf="todas">Todas</button><button type="button" data-cf="naoLidas">Não lidas</button><button type="button" data-cf="semResposta">Sem resposta</button></div>
        </div>
        <div id="sp-chat-erros"></div>
        <div class="sp-conversas" id="sp-conversas"></div>
      </div>
      <div class="sp-thread" id="sp-thread"></div>
    </div>`;
    $("sp-busca").addEventListener("input", (e) => {
      chatBusca = e.target.value;
      renderListaConversas();
    });
    corpo.querySelectorAll("[data-cf]").forEach((b) =>
      b.addEventListener("click", () => {
        chatFiltro = b.dataset.cf;
        salvarPref("chatFiltro", chatFiltro);
        renderListaConversas();
      })
    );
    $("sp-conversas").addEventListener("click", (e) => {
      const el = e.target.closest(".sp-conv");
      if (!el) return;
      const c = chat.conversas.find((x) => x.shopId === el.dataset.shop && x.id === el.dataset.id);
      if (c) abrirConversa(c);
    });
    renderListaConversas();
    renderThread();
  }

  function renderListaConversas() {
    const lista = $("sp-conversas");
    if (!lista) return;
    corpo.querySelectorAll("[data-cf]").forEach((b) => b.classList.toggle("ativo", b.dataset.cf === chatFiltro));
    $("sp-chat-erros").innerHTML = chat ? errosDeLoja(chat.erros).replace("shopee-aviso", 'shopee-aviso" style="margin:10px 12px') : "";
    if (!chat) {
      lista.innerHTML = `<div class="sp-thread-vazio">Carregando conversas...</div>`;
      return;
    }
    const busca = chatBusca.trim().toLowerCase();
    const convs = chat.conversas.filter(
      (c) =>
        passaLoja(c.shopId) &&
        (chatFiltro !== "naoLidas" || c.naoLidas > 0) &&
        (chatFiltro !== "semResposta" || c.ultimaDoComprador) &&
        (!busca || c.comprador.toLowerCase().includes(busca) || c.ultimaTexto.toLowerCase().includes(busca))
    );
    if (!convs.length) {
      lista.innerHTML = `<div class="sp-thread-vazio">${chat.conversas.length ? "Nenhuma conversa neste filtro." : "Nenhuma conversa ainda."}</div>`;
      return;
    }
    lista.innerHTML = convs
      .map((c) => {
        const ativa = conversaAberta && conversaAberta.shopId === c.shopId && conversaAberta.id === c.id;
        const inicial = esc((c.comprador || "?").trim().charAt(0).toUpperCase());
        return `<div class="sp-conv ${ativa ? "ativa" : ""} ${c.naoLidas ? "nao-lida" : ""}" data-shop="${esc(c.shopId)}" data-id="${esc(c.id)}">
          <div class="sp-avatar" style="--sp-loja:${corLoja(c.shopId)}">${c.avatar ? `<img src="${esc(c.avatar)}" alt="" loading="lazy" onerror="this.remove()">` : ""}${c.avatar ? "" : inicial}</div>
          <div style="min-width:0">
            <div class="sp-conv-nome">${esc(c.comprador)}</div>
            <div class="sp-conv-prev">${c.ultimaDoComprador === false ? "Você: " : ""}${esc(c.ultimaTexto)}</div>
            <div style="margin-top:5px">${chipLoja(c.shopId, c.loja)}</div>
          </div>
          <div class="sp-conv-dir">${c.ultimaEm ? relativo(c.ultimaEm) : ""}${c.naoLidas ? `<span class="sp-nao-lidas">${c.naoLidas}</span>` : ""}</div>
        </div>`;
      })
      .join("");
  }

  async function abrirConversa(c) {
    conversaAberta = { ...c };
    msgsAbertas = [];
    corpo.querySelector(".sp-chat")?.classList.add("com-conversa");
    renderListaConversas();
    renderThread();
    await carregarMensagens({ rolar: true });
    if (c.naoLidas > 0) {
      api(`/api/shopee/chat/${encodeURIComponent(c.shopId)}/${encodeURIComponent(c.id)}/lida`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ultimaMensagemId: c.ultimaMensagemId }),
      })
        .then(() => {
          c.naoLidas = 0;
          renderListaConversas();
          atualizarContas();
        })
        .catch(() => {});
    }
  }

  async function carregarMensagens({ rolar = false } = {}) {
    if (!conversaAberta) return;
    const alvo = conversaAberta;
    try {
      const r = await api(`/api/shopee/chat/${encodeURIComponent(alvo.shopId)}/${encodeURIComponent(alvo.id)}?comprador=${encodeURIComponent(alvo.compradorId)}`);
      if (conversaAberta !== alvo) return; // trocou de conversa no meio
      const mudou = r.mensagens.length !== msgsAbertas.length || r.mensagens.at(-1)?.id !== msgsAbertas.at(-1)?.id;
      msgsAbertas = r.mensagens;
      if (mudou || rolar) renderMensagens(true);
    } catch (err) {
      const box = $("sp-msgs");
      if (box) box.innerHTML = `<div class="sp-thread-vazio">Não deu para abrir a conversa: ${esc(traduzErro(err.message))}</div>`;
    }
  }

  function renderThread() {
    const t = $("sp-thread");
    if (!t) return;
    if (!conversaAberta) {
      t.innerHTML = `<div class="sp-thread-vazio">💬<br>Escolha uma conversa à esquerda.<br><span class="small">Perguntas sobre anúncios também chegam por aqui.</span></div>`;
      return;
    }
    const c = conversaAberta;
    t.innerHTML = `
      <div class="sp-thread-topo">
        <button type="button" class="btn btn-ghost btn-sm sp-voltar" id="sp-voltar">←</button>
        <div class="sp-avatar" style="--sp-loja:${corLoja(c.shopId)};width:34px;height:34px;font-size:13px">${esc(c.comprador.charAt(0).toUpperCase())}</div>
        <div style="min-width:0"><div style="font-weight:700">${esc(c.comprador)}</div><div style="margin-top:2px">${chipLoja(c.shopId, c.loja)}</div></div>
      </div>
      <div class="sp-msgs" id="sp-msgs"><div class="sp-thread-vazio">Carregando mensagens...</div></div>
      <div class="sp-composer">
        <div class="sp-rapidas">${RAPIDAS.map((r, i) => `<button type="button" data-rapida="${i}" title="${esc(r)}">${esc(r.split(/[!.?]/)[0].slice(0, 32))}</button>`).join("")}</div>
        <div class="sp-composer-linha">
          <textarea id="sp-texto" rows="1" maxlength="1000" placeholder="Escreva a resposta... (Ctrl+Enter envia)"></textarea>
          <button type="button" class="btn sp-btn-shopee" id="sp-enviar">Enviar</button>
        </div>
      </div>`;
    $("sp-voltar").addEventListener("click", () => {
      conversaAberta = null;
      corpo.querySelector(".sp-chat")?.classList.remove("com-conversa");
      renderListaConversas();
      renderThread();
    });
    const txt = $("sp-texto");
    txt.addEventListener("input", () => {
      txt.style.height = "auto";
      txt.style.height = `${Math.min(txt.scrollHeight, 140)}px`;
    });
    txt.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        enviar();
      }
    });
    t.querySelectorAll("[data-rapida]").forEach((b) =>
      b.addEventListener("click", () => {
        txt.value = RAPIDAS[Number(b.dataset.rapida)];
        txt.dispatchEvent(new Event("input"));
        txt.focus();
      })
    );
    $("sp-enviar").addEventListener("click", enviar);
    if (msgsAbertas.length) renderMensagens(true);
  }

  function renderMensagens(rolar) {
    const box = $("sp-msgs");
    if (!box) return;
    if (!msgsAbertas.length) {
      box.innerHTML = `<div class="sp-thread-vazio">Nenhuma mensagem nesta conversa.</div>`;
      return;
    }
    let ultimoDia = "";
    box.innerHTML = msgsAbertas
      .map((m) => {
        let sep = "";
        if (m.em && diaSP(m.em) !== ultimoDia) {
          ultimoDia = diaSP(m.em);
          sep = `<div class="sp-dia">${diaRotulo(m.em)}</div>`;
        }
        const corpoMsg = m.imagem ? `<img src="${esc(m.imagem)}" alt="imagem" loading="lazy">` : esc(m.texto);
        return `${sep}<div class="sp-msg ${m.daLoja ? "nossa" : "dele"}">${corpoMsg}<div class="sp-msg-hora">${m.em ? hora(m.em) : ""}</div></div>`;
      })
      .join("");
    if (rolar) box.scrollTop = box.scrollHeight;
  }

  async function enviar() {
    const txt = $("sp-texto");
    const texto = txt?.value.trim();
    if (!texto || enviando || !conversaAberta) return;
    enviando = true;
    const btn = $("sp-enviar");
    btn.disabled = true;
    btn.textContent = "Enviando...";
    const c = conversaAberta;
    try {
      await api(`/api/shopee/chat/${encodeURIComponent(c.shopId)}/${encodeURIComponent(c.id)}/enviar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compradorId: c.compradorId, texto }),
      });
      txt.value = "";
      txt.dispatchEvent(new Event("input"));
      msgsAbertas.push({ id: `local-${Date.now()}`, daLoja: true, texto, em: Date.now() });
      renderMensagens(true);
      const conv = chat?.conversas.find((x) => x.shopId === c.shopId && x.id === c.id);
      if (conv) {
        conv.ultimaTexto = texto;
        conv.ultimaDoComprador = false;
        conv.ultimaEm = Date.now();
        renderListaConversas();
      }
      setTimeout(() => carregarMensagens(), 1500);
    } catch (err) {
      alert(`Não foi enviado: ${traduzErro(err.message)}`);
    } finally {
      enviando = false;
      btn.disabled = false;
      btn.textContent = "Enviar";
    }
  }

  // =====================================================================
  // DEVOLUCOES
  // =====================================================================
  const STATUS_DEV = {
    REQUESTED: { nome: "Aguardando sua resposta", cor: "#ea580c" },
    PROCESSING: { nome: "Em andamento", cor: "#2563eb" },
    SELLER_DISPUTE: { nome: "Em disputa", cor: "#dc2626" },
    JUDGING: { nome: "Em análise da Shopee", cor: "#7c3aed" },
    ACCEPTED: { nome: "Aceita", cor: "#16a34a" },
    REFUND_PAID: { nome: "Reembolsada", cor: "#16a34a" },
    CLOSED: { nome: "Encerrada", cor: "#6b7280" },
    CANCELLED: { nome: "Cancelada", cor: "#6b7280" },
  };
  const MOTIVO = {
    NONE: "Sem motivo",
    NOT_RECEIPT: "Não recebeu o pedido",
    WRONG_ITEM: "Produto errado",
    ITEM_DAMAGED: "Produto danificado",
    DIFFERENT_DESCRIPTION: "Diferente do anúncio",
    MUTUAL_AGREE: "Acordo com o vendedor",
    OTHER: "Outro motivo",
    CHANGE_MIND: "Desistiu da compra",
    ITEM_MISSING: "Faltou item no pacote",
    EXPECTATION_FAILED: "Não atendeu à expectativa",
    ITEM_FAKE: "Produto falsificado",
    PHYSICAL_DMG: "Dano físico",
    FUNCTIONAL_DMG: "Não funciona",
    ITEM_WRONGDAMAGED: "Errado ou danificado",
    DAMAGED_OTHERS: "Danificado (outros)",
  };
  let devs = null;
  let devFiltro = lerPref("devFiltro", "abertas");

  async function carregarDevolucoes({ forcar = false } = {}) {
    try {
      devs = await api(`/api/shopee/devolucoes${forcar ? "?forcar=1" : ""}`);
      if (aba === "devolucoes" && visivel) render();
      atualizarContas();
    } catch (err) {
      if (aba === "devolucoes") corpo.innerHTML = `<div class="shopee-aviso erro">Erro ao carregar devoluções: ${esc(err.message)}</div>`;
    }
  }

  function renderDevolucoes() {
    if (!devs) {
      corpo.innerHTML = `<div class="shopee-vazio">Carregando devoluções...</div>`;
      return;
    }
    const agora = Date.now();
    const todas = devs.devolucoes.filter((d) => passaLoja(d.shopId));
    const abertas = todas.filter((d) => d.aberta);
    const urgentes = abertas.filter((d) => d.responderAte && d.responderAte - agora < 24 * 3600e3);
    const valorAberto = abertas.reduce((s, d) => s + d.valor, 0);
    const cartoes = [
      { id: "abertas", nome: "Pedem atenção", cor: "#ea580c", n: abertas.length, sub: "aguardando você ou a Shopee" },
      { id: "urgentes", nome: "Responder em 24h", cor: "#dc2626", n: urgentes.length, sub: "prazo de resposta acabando" },
      { id: "todas", nome: "Últimos 60 dias", cor: "#6b7280", n: todas.length, sub: "todas as solicitações" },
    ];
    const lista = devFiltro === "urgentes" ? urgentes : devFiltro === "abertas" ? abertas : todas;
    let html = errosDeLoja(devs.erros);
    html += `<div class="sp-cartoes">${cartoes
      .map(
        (c) => `<button type="button" class="sp-cartao ${c.n ? "" : "zero"} ${devFiltro === c.id ? "ativo" : ""}" data-df="${c.id}" style="--sp-cor:${c.cor}">
        <div class="sp-cartao-num">${c.n}</div><div class="sp-cartao-rot">${c.nome}</div><div class="sp-cartao-sub">${c.sub}</div></button>`
      )
      .join("")}
      <div class="sp-cartao" style="--sp-cor:#ee4d2d;cursor:default"><div class="sp-cartao-num" style="font-size:20px">${brl(valorAberto)}</div><div class="sp-cartao-rot">Valor em aberto</div><div class="sp-cartao-sub">reembolsos ainda não decididos</div></div>
    </div>`;
    html += `<div class="sp-barra"><span class="muted small">Aceitar ou contestar continua sendo feito na Central do Vendedor da Shopee.</span><span class="sp-esp"></span>
      <a class="btn btn-ghost btn-sm" href="https://seller.shopee.com.br/" target="_blank" rel="noopener">Abrir Central do Vendedor ↗</a></div>`;
    if (!lista.length) {
      html += `<div class="shopee-vazio">${devFiltro === "todas" ? "Nenhuma devolução nos últimos 60 dias. 🎉" : "Nenhuma devolução pedindo atenção agora. 🎉"}</div>`;
    } else {
      html += `<div>${lista.map(cartaoDevolucao).join("")}</div>`;
    }
    corpo.innerHTML = html;
    corpo.querySelectorAll("[data-df]").forEach((b) =>
      b.addEventListener("click", () => {
        devFiltro = b.dataset.df;
        salvarPref("devFiltro", devFiltro);
        renderDevolucoes();
      })
    );
  }

  function cartaoDevolucao(d) {
    const st = STATUS_DEV[d.status] || { nome: d.status, cor: "#6b7280" };
    const falta = d.responderAte ? d.responderAte - Date.now() : null;
    const itens = d.itens.map((i) => `${i.qtd}× ${i.nome}`).join(" · ");
    return `<div class="sp-dev ${d.aberta ? "aberta" : ""}">
      <div style="min-width:0">
        <div class="sp-ped-topo"><span class="sp-st" style="background:color-mix(in srgb, ${st.cor} 13%, #fff);color:${st.cor}">${esc(st.nome)}</span>${chipLoja(d.shopId, d.loja)}</div>
        <div class="sp-dev-motivo" style="margin-top:8px">${esc(MOTIVO[d.motivo] || d.motivo || "Motivo não informado")}</div>
        ${d.textoComprador ? `<div class="sp-dev-texto">“${esc(d.textoComprador)}”</div>` : ""}
        ${d.contestacao ? `<div class="sp-dev-itens"><b>Sua contestação:</b> ${esc(d.contestacao)}</div>` : ""}
        <div class="sp-dev-itens">${esc(itens)}${d.fotos ? ` · 📷 ${d.fotos} foto${d.fotos > 1 ? "s" : ""}` : ""}</div>
        <div class="sp-dev-itens">Devolução <span class="sp-sn">${esc(d.returnSn)}</span> · Pedido <span class="sp-sn">${esc(d.orderSn)}</span>${d.criadaEm ? ` · aberta em ${dataHora(d.criadaEm)}` : ""}</div>
      </div>
      <div class="sp-dev-dir">
        <div class="sp-valor">${brl(d.valor)}</div>
        ${
          d.aberta && falta !== null
            ? `<span class="sp-chip" style="${falta < 24 * 3600e3 ? "background:#fef2f2;border-color:#fecaca;color:#b91c1c" : ""}">${falta < 0 ? "prazo vencido" : `responder em ${duracao(falta)}`}</span>`
            : ""
        }
      </div>
    </div>`;
  }

  // =====================================================================
  // LOJAS (conexao + sonda)
  // =====================================================================
  function renderLojas() {
    const teste = estado.ambiente !== "live";
    let aviso = "";
    if (!estado.configurado) {
      aviso =
        "Faltam as chaves do app no Render: <code>SHOPEE_PARTNER_ID</code> e <code>SHOPEE_PARTNER_KEY</code> " +
        "(e <code>SHOPEE_ENV</code> = <code>test</code> ou <code>live</code>). Depois de salvar, o Render reinicia sozinho.";
    } else if (teste) {
      aviso =
        "Modo <b>teste</b>: só conecta loja de teste criada em <i>Tools › Test Account-Sandbox</i> no console da Shopee. " +
        "Para as lojas reais, troque para as chaves de produção e <code>SHOPEE_ENV=live</code> depois do Go-Live.";
    }
    const cartoes = estado.contas.length
      ? estado.contas
          .map((c) => {
            const vencida = c.reconectarAte && c.reconectarAte < Date.now();
            // Loja conectada num modo e painel rodando no outro: toda chamada
            // volta "invalid_partner_id" (aconteceu em 17/11 com SHOPEE_ENV=live
            // antes do Go-Live).
            const modoTrocado = c.ambiente !== estado.ambiente;
            return `
        <div class="shopee-loja" data-shop="${esc(c.shopId)}" style="border-left-color:${corLoja(c.shopId)}">
          <div class="shopee-loja-nome">${esc(c.nome || `Loja ${c.shopId}`)}</div>
          <div class="muted small">ID ${esc(c.shopId)} · ${c.ambiente === "live" ? "produção" : "teste"}</div>
          ${
            modoTrocado
              ? `<div class="small" style="color:var(--danger)">Loja de ${c.ambiente === "live" ? "produção" : "teste"}, mas o painel está em modo ${
                  estado.ambiente === "live" ? "produção" : "teste"
                } — confira SHOPEE_ENV no Render.</div>`
              : ""
          }
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
          .join("")
      : `<div class="shopee-vazio">Nenhuma loja conectada ainda.${
          estado.configurado ? " Clique em <b>Conectar loja Shopee</b> e entre com a conta da loja." : ""
        }</div>`;

    corpo.innerHTML = `
      ${aviso ? `<div class="shopee-aviso">${aviso}</div>` : ""}
      <section>
        <div class="sp-barra" style="margin-bottom:10px">
          <h3 class="shopee-titulo" style="margin:0">Lojas conectadas</h3><span class="sp-esp"></span>
          ${estado.configurado ? `<a class="btn btn-sm sp-btn-shopee" href="/shopee/conectar">+ Conectar loja Shopee</a>` : ""}
        </div>
        <div class="shopee-lojas" id="shopee-lojas">${cartoes}</div>
        ${estado.contas.length > 0 && estado.contas.length < 3 ? `<p class="muted small" style="margin:10px 0 0">Para conectar outra loja: clique em Conectar de novo e, na tela da Shopee, saia da loja atual antes de entrar na próxima.</p>` : ""}
      </section>
      <section id="shopee-sonda" class="shopee-sonda hidden">
        <div class="shopee-sonda-topo">
          <h3 class="shopee-titulo" style="margin:0">Resultado da sonda</h3>
          <button type="button" id="shopee-copiar" class="btn btn-ghost btn-sm">Copiar resultado</button>
        </div>
        <pre id="shopee-sonda-saida"></pre>
      </section>`;

    $("shopee-lojas").addEventListener("click", acaoLoja);
    $("shopee-copiar").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("shopee-sonda-saida").textContent);
        $("shopee-copiar").textContent = "Copiado ✓";
        setTimeout(() => ($("shopee-copiar").textContent = "Copiar resultado"), 1500);
      } catch {
        alert("Não deu para copiar automaticamente — selecione o texto e copie.");
      }
    });
  }

  async function acaoLoja(ev) {
    const btn = ev.target.closest("button[data-acao]");
    if (!btn) return;
    const shopId = btn.closest(".shopee-loja").dataset.shop;
    const acao = btn.dataset.acao;
    if (acao === "sonda") {
      btn.disabled = true;
      btn.textContent = "Rodando...";
      $("shopee-sonda").classList.remove("hidden");
      const saida = $("shopee-sonda-saida");
      saida.textContent = "Consultando a Shopee (pode levar alguns segundos)...";
      try {
        const res = await fetch(`/api/debug/probe-shopee?shopId=${encodeURIComponent(shopId)}`);
        saida.textContent = JSON.stringify(await res.json(), null, 2);
      } catch (err) {
        saida.textContent = `Falhou: ${err.message}`;
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
      await carregarEstado();
      render();
    } else if (acao === "remover") {
      if (!confirm("Desconectar esta loja do painel? (Para voltar, é só conectar de novo.)")) return;
      await fetch(`/api/shopee/contas/${encodeURIComponent(shopId)}`, { method: "DELETE" });
      await carregarEstado();
      render();
    }
  }

  // =====================================================================
  // Contadores (abas + selo do menu) e atualizacao automatica
  // =====================================================================
  let resumo = null;
  function atualizarContas() {
    const urg = prazos
      ? prazos.pedidos.filter((p) => p.situacao === "atrasado" || p.situacao === "risco" || p.situacao === "hoje").length
      : resumo
        ? resumo.atrasados + resumo.urgentes
        : 0;
    const naoLidas = chat ? chat.conversas.filter((c) => c.naoLidas > 0).length : resumo?.chatNaoLidas || 0;
    const devAbertas = devs ? devs.devolucoes.filter((d) => d.aberta).length : resumo?.devolucoesAbertas || 0;
    const set = (id, n) => {
      const el = $(`sp-conta-${id}`);
      if (el) el.textContent = n ? String(n) : "";
    };
    set("prazos", urg);
    set("chat", naoLidas);
    set("devolucoes", devAbertas);
    const total = urg + naoLidas + devAbertas;
    if (badgeNav) {
      badgeNav.textContent = total > 99 ? "99+" : String(total);
      badgeNav.classList.toggle("hidden", !total);
    }
  }

  async function atualizarResumo() {
    if (document.hidden) return;
    try {
      resumo = await api("/api/shopee/resumo");
      atualizarContas();
    } catch {}
  }

  // Selo do menu mesmo com a aba fechada (1/min).
  fetch("/api/shopee/estado")
    .then((r) => (r.ok ? r.json() : null))
    .then((e) => {
      if (e?.configurado && e.contas?.length) {
        atualizarResumo();
        setInterval(atualizarResumo, 60_000);
      }
    })
    .catch(() => {});

  // Com a aba aberta: prazos a cada 60s (o servidor coleta a cada 3 min),
  // lista do chat a cada 20s, conversa aberta a cada 8s, devolucoes 2 min.
  setInterval(() => {
    if (!visivel || document.hidden || !estado?.contas?.length) return;
    if (aba === "prazos") carregarPrazos();
  }, 60_000);
  setInterval(() => {
    if (!visivel || document.hidden || aba !== "chat" || !estado?.contas?.length) return;
    carregarChat();
  }, 20_000);
  setInterval(() => {
    if (!visivel || document.hidden || aba !== "chat" || !conversaAberta) return;
    carregarMensagens();
  }, 8_000);
  setInterval(() => {
    if (!visivel || document.hidden || aba !== "devolucoes" || !estado?.contas?.length) return;
    carregarDevolucoes();
  }, 120_000);
  // Contagem regressiva dos prazos andando sem buscar de novo.
  setInterval(() => {
    if (visivel && aba === "prazos" && prazos) renderPrazos();
  }, 30_000);

  // Voltando da autorizacao da Shopee (/?modulo=shopee): abre na aba Lojas.
  if (new URLSearchParams(location.search).get("modulo") === "shopee") {
    history.replaceState(null, "", "/");
    aba = "lojas";
    navShopee?.click();
  }
})();
