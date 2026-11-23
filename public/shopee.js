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
  /* Coluna com altura fixa: sem isto, blocos com overflow:hidden (ex.
     .pz-detalhe) eram espremidos ate sumir em vez de a coluna rolar. */
  .shopee-corpo > * { flex-shrink: 0; }
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
  .shopee-pane .shopee-banner { background: linear-gradient(120deg, var(--shopee-cor) 0%, #ff7337 100%); color: #fff; border-bottom: none; position: relative; overflow: hidden; row-gap: 10px; }
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
  .sp-msg.anexo { padding: 4px; background: var(--card); }
  .sp-msg.anexo.nossa { background: #ffe3d9; }
  .sp-anexo { position: relative; display: block; border-radius: 10px; overflow: hidden; cursor: zoom-in; }
  .sp-anexo img { max-width: 240px; max-height: 260px; object-fit: cover; }
  .sp-anexo.video { cursor: pointer; }
  .sp-anexo.video::after { content: "▶"; position: absolute; inset: 0; display: grid; place-items: center; font-size: 30px; color: #fff; background: rgba(0,0,0,.28); text-shadow: 0 2px 8px rgba(0,0,0,.4); }
  .sp-anexo-dur { position: absolute; right: 6px; bottom: 6px; z-index: 1; font-size: 11px; color: #fff; background: rgba(0,0,0,.55); padding: 1px 6px; border-radius: 999px; }
  .sp-msg-hora { padding: 0 4px; }
  /* Cartoes de produto/pedido dentro da conversa e no painel lateral */
  .sp-prod { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 10px; align-items: center; text-decoration: none; color: inherit; border: 1px solid var(--border); border-radius: 12px; padding: 8px; background: var(--card); white-space: normal; }
  .sp-prod img, .sp-prod .sp-prod-sem { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; background: var(--bg); display: grid; place-items: center; font-size: 22px; }
  .sp-prod-nome { font-size: 12.5px; font-weight: 650; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }
  .sp-prod-preco { font-size: 13.5px; font-weight: 800; color: var(--shopee-escuro); margin-top: 3px; }
  .sp-prod-preco s { font-size: 11px; font-weight: 500; color: var(--muted); margin-left: 4px; }
  .sp-prod-info { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .sp-msg .sp-prod { min-width: 240px; max-width: 300px; }
  .sp-thread-meio { flex: 1; min-height: 0; display: flex; }
  .sp-thread-meio .sp-msgs { flex: 1; min-width: 0; }
  .sp-ctx { width: 300px; flex: none; border-left: 1px solid var(--border); background: var(--card); overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
  .sp-ctx h4 { margin: 0 0 8px; font-size: 11px; font-weight: 750; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
  .sp-ctx-lista { display: flex; flex-direction: column; gap: 8px; }
  .sp-ctx-vazio { font-size: 12.5px; color: var(--muted); line-height: 1.5; }
  .sp-ped-card { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .sp-ped-card-topo { padding: 10px 12px; background: var(--shopee-suave); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .sp-ped-card-topo .sp-sn { font-size: 12px; }
  .sp-ped-st { font-size: 11px; font-weight: 700; color: var(--shopee-escuro); }
  .sp-ped-itens { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--border); }
  .sp-ped-item { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 12px; }
  .sp-ped-item img, .sp-ped-item .sp-prod-sem { width: 34px; height: 34px; border-radius: 6px; object-fit: cover; background: var(--bg); }
  .sp-ped-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-ped-dados { padding: 8px 12px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; font-size: 12px; }
  .sp-ped-dados dt { color: var(--muted); }
  .sp-ped-dados dd { margin: 0; color: var(--text); font-weight: 600; text-align: right; overflow-wrap: anywhere; }
  .sp-ped-msg { padding: 8px 12px; font-size: 12px; color: var(--text-soft); background: #fffbeb; border-top: 1px solid var(--border); white-space: pre-wrap; }
  .sp-mini-copiar { border: none; background: none; cursor: pointer; color: var(--muted); padding: 0 0 0 4px; font: inherit; }
  .sp-mini-copiar:hover { color: var(--shopee-escuro); }
  .sp-thread-acoes { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .sp-ctx-btn { display: none; }
  .sp-zoom { position: fixed; inset: 0; z-index: 1000; background: rgba(15,23,42,.82); display: grid; place-items: center; padding: 24px; cursor: zoom-out; }
  .sp-zoom img, .sp-zoom video { max-width: 100%; max-height: 100%; border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,.4); cursor: default; }
  @media (max-width: 1280px) {
    .sp-ctx-btn { display: inline-flex; }
    .sp-thread-meio { position: relative; }
    .sp-ctx { position: absolute; right: 0; top: 0; bottom: 0; z-index: 5; box-shadow: var(--shadow-lg); display: none; }
    .sp-thread.ctx-aberto .sp-ctx { display: flex; }
  }
  @media (max-width: 900px) { .sp-ctx { width: 100%; } }
  .sp-msg-hora { font-size: 10.5px; color: var(--muted); text-align: right; margin-top: 2px; }
  .sp-seg { flex-wrap: wrap; }
  .sp-cf-n { font-weight: 800; color: #7c3aed; }
  .sp-marca { display: inline-block; margin-left: 5px; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px; vertical-align: middle; }
  .sp-marca.tratativa { background: #f5f3ff; color: #6d28d9; border: 1px solid #ddd6fe; }
  .sp-marca.resolvido { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
  .sp-bt-marca.tratativa.ativo { background: #7c3aed !important; color: #fff !important; border-color: #7c3aed !important; }
  .sp-bt-marca.resolvido.ativo { background: #16a34a !important; color: #fff !important; border-color: #16a34a !important; }
  .sp-bt-marca.tratativa { color: #6d28d9; }
  .sp-bt-marca.resolvido { color: #15803d; }
  .sp-st-msg { margin-left: 6px; font-weight: 600; }
  .sp-st-msg.ok { color: #15803d; }
  .sp-st-msg.erro { color: #b91c1c; }
  .sp-msg.enviando { opacity: .72; }
  .sp-msg.erro { background: #fef2f2 !important; border: 1px solid #fecaca; }
  .sp-msg-erro { margin-top: 6px; font-size: 12px; color: #991b1b; white-space: normal; }
  .sp-msg-erro-bt { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .sp-msg-erro-bt button { border: 1px solid currentColor; background: #fff; color: #991b1b; border-radius: 999px; padding: 2px 10px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .sp-perfil { margin-left: 6px; font-size: 11px; color: var(--muted); }
  .sp-aviso-rapido { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 20px); background: #1f2937; color: #fff; padding: 12px 18px; border-radius: 12px; font-size: 13.5px; line-height: 1.5; box-shadow: 0 10px 30px rgba(0,0,0,.3); opacity: 0; pointer-events: none; transition: .25s; z-index: 9999; max-width: min(92vw, 460px); text-align: center; }
  .sp-aviso-rapido.on { opacity: 1; transform: translate(-50%, 0); }
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

  .sp-externo { border: 1px dashed #fdba9f; background: var(--shopee-suave); border-radius: var(--radius-md); padding: 14px 16px; }
  .sp-externo-linha { display: flex; gap: 8px; }
  .sp-externo-linha input { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #fff; }

  .shopee-pane {
    --accent: var(--shopee-cor); --accent-dark: var(--shopee-escuro); --accent-soft: var(--shopee-suave);
    --sit-atrasado: #7f1d1d; --sit-atrasado-soft: #fde8e8; --sit-estourou: var(--danger); --sit-estourou-soft: var(--danger-soft);
    --sit-risco: #d97706; --sit-risco-soft: #fef3c7; --sit-ok: var(--success); --sit-ok-soft: #dcfce7;
  }
  .shopee-pane .sp-select option { color: var(--text); background: #fff; }
  .shopee-pane .pz-cards { margin-top: 0; }
  .shopee-pane .prazos-abas { margin-top: 14px; border-bottom: 1px solid var(--border); }
  .sp-atualizado { font-size: 11.5px; color: var(--muted); margin-top: 8px; }
  .sp-ponto-loja { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 7px; vertical-align: 1px; }
  .sp-organizar-txt { color: #9a3412; font-weight: 600; }
  .sp-atraso-txt { color: var(--sit-atrasado); font-weight: 600; }
  .sp-transp { display: block; font-size: 10.5px; color: var(--muted); margin-top: 2px; }
  .shopee-pane .pz-tabela td[data-label="Etapa"] { white-space: normal; }
  /* O style.css esconde a penultima coluna (comprador, no ML) abaixo de
     1200px; aqui a penultima e "Etapa", que precisa aparecer. */
  .shopee-pane .pz-tabela th:nth-last-child(2) { display: table-cell; }
  .shopee-pane .pz-copiar.ok { color: var(--success); }
  .shopee-pane .pz-detalhe .sp-barra { gap: 8px; }

  /* ---- Pacotes do dia (ML + Shopee) ---- */
  .pd-faixa { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 18px; align-items: center; border: 1px solid var(--border); border-radius: 16px; padding: 14px 18px; background: linear-gradient(100deg, #fffdf0 0%, #fff 45%, #fff6f2 100%); }
  .prazos-pane > .pd-faixa { margin: 14px 20px 0; }
  .pd-total { display: flex; align-items: center; gap: 12px; padding-right: 18px; border-right: 1px solid var(--border); }
  .pd-total-num { font-size: 34px; font-weight: 800; letter-spacing: -.03em; line-height: 1; color: var(--text); font-variant-numeric: tabular-nums; }
  .pd-total-rot { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); line-height: 1.35; }
  .pd-total-rot b { display: block; color: var(--text-soft); text-transform: none; letter-spacing: 0; font-size: 12.5px; font-weight: 600; }
  .pd-equipes { display: flex; flex-direction: column; gap: 14px; }
  .mkt-grupo.op::before { background: linear-gradient(135deg, #2563eb, #7c3aed); }
  .mkt-grupo.op { margin-top: 10px; border-top: 1px solid rgba(255,255,255,.07); padding-top: 14px; }
  .module-nav.collapsed .mkt-grupo.op { padding-top: 12px; }
  .shopee-pane.sp-modo-eq .shopee-banner { background: linear-gradient(120deg, #1d4ed8 0%, #6d28d9 100%); }
  .shopee-pane.sp-modo-eq #sp-loja-filtro { display: none; }
  .sp-equipes .pd-eq { padding: 18px 20px; gap: 14px; border-left-width: 6px; }
  .eq-heroi { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
  .eq-relogio { position: relative; width: 230px; height: 230px; flex: none; }
  .eq-anel { width: 100%; height: 100%; transform: rotate(-90deg); }
  .eq-anel circle { fill: none; stroke-width: 14; }
  .eq-anel-fundo { stroke: color-mix(in srgb, var(--eq) 12%, #fff); }
  .eq-anel-arco { stroke-linecap: round; transition: stroke-dasharray .6s; }
  .eq-relogio-centro { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .eq-relogio-n { font-size: 44px; font-weight: 800; letter-spacing: -.03em; line-height: 1; color: var(--st); font-variant-numeric: tabular-nums; }
  .eq-relogio-rot { margin-top: 6px; font-size: 12px; color: var(--muted); line-height: 1.35; }
  .eq-relogio-rot b { color: var(--text); font-size: 15px; }
  .eq-st-estoura .eq-relogio-n, .eq-st-passou .eq-relogio-n { animation: eq-pisca 1.2s ease-in-out infinite; }
  @keyframes eq-pisca { 50% { opacity: .45; } }
  .eq-heroi-dir { flex: 1; min-width: 220px; display: flex; flex-direction: column; gap: 10px; }
  .eq-veredito { align-self: flex-start; font-size: 19px; font-weight: 800; color: #fff; background: var(--st); border-radius: 12px; padding: 9px 16px; box-shadow: 0 6px 18px color-mix(in srgb, var(--st) 30%, transparent); }
  .eq-precisa { font-size: 14px; color: var(--text-soft); }
  .eq-mini { display: flex; gap: 26px; }
  .eq-mini > div { display: flex; flex-direction: column; }
  .eq-mini-n { font-size: 28px; font-weight: 800; line-height: 1.05; color: var(--text); font-variant-numeric: tabular-nums; }
  .eq-mini-n.ok { color: #15803d; }
  .eq-mini small { font-size: 11.5px; color: var(--muted); }
  .pd-eq-cfg input[type="time"] { width: auto; }
  .pd-eq-grade.uma .eq-relogio { width: 300px; height: 300px; }
  .pd-eq-grade.uma .eq-relogio-n { font-size: 60px; }
  .pd-eq-grade.uma .eq-veredito { font-size: 24px; }
  @media (max-width: 700px) {
    .eq-relogio { width: 190px; height: 190px; margin: 0 auto; }
    .eq-relogio-n { font-size: 36px; }
    .eq-heroi { justify-content: center; }
  }
  .sp-equipes .pd-eq-topo b { font-size: 17px; }
  .sp-equipes .pd-eq-n { font-size: 32px; }
  .sp-equipes .pd-eq-nums { gap: 30px; }
  .sp-equipes .pd-eq-det { font-size: 13px; }
  .sp-eq-nota { margin-top: 14px; line-height: 1.5; }
  .rm-grade { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .rm-card { border: 1px solid var(--border); border-top: 5px solid var(--rm); border-radius: 14px; padding: 16px 18px; background: color-mix(in srgb, var(--rm) 3%, #fff); display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .rm-topo { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .rm-topo b { font-size: 18px; color: var(--rm); }
  .rm-totaldia { font-size: 13px; font-weight: 700; color: var(--text-soft); }
  .rm-linha { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; min-width: 0; grid-template-areas: "nome total ok falta" "st st st st"; gap: 6px 12px; align-items: center; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: #fff; }
  .rm-nome { grid-area: nome; display: flex; flex-direction: column; }
  .rm-nome b { font-size: 15px; }
  .rm-nome small, .rm-linha small { font-size: 11px; color: var(--muted); }
  .rm-total { grid-area: total; display: flex; flex-direction: column; }
  .rm-total span { font-size: 34px; font-weight: 800; line-height: 1; color: var(--rm); font-variant-numeric: tabular-nums; }
  .rm-num { display: flex; flex-direction: column; }
  .rm-num span { font-size: 20px; font-weight: 800; line-height: 1.1; color: var(--text); font-variant-numeric: tabular-nums; }
  .rm-num.ok span { color: #15803d; }
  .rm-st { grid-area: st; display: flex; flex-direction: column; gap: 6px; }
  .rm-chip { align-self: flex-start; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--bg); color: var(--muted); }
  .rm-chip.aberta { background: color-mix(in srgb, var(--rm) 12%, #fff); color: var(--rm); }
  .rm-chip.pend { background: #fff7ed; color: #c2410c; }
  .rm-chip.ok { background: #f0fdf4; color: #15803d; }
  .rm-rodape { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-soft); }
  .rm-alerta { color: #b91c1c; }
  .rm-emb { font-size: 12px; font-weight: 600; color: #7c3aed; }
  .sp-chip.embalado { background: #f5f3ff; border-color: #ddd6fe; color: #6d28d9; }
  @media (max-width: 900px) { .rm-grade { grid-template-columns: 1fr; } }
  .eq-remessas { display: flex; flex-direction: column; gap: 8px; }
  .eq-sub { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .pd-eq-grade:not(.uma) .eq-remessas .rm-grade { grid-template-columns: 1fr; }
  .eq-remessas .rm-card { padding: 12px 14px; gap: 8px; }
  .eq-remessas .rm-topo b { font-size: 15px; }
  .eq-remessas .rm-linha { padding: 8px 12px; }
  .eq-remessas .rm-total span { font-size: 26px; }
  .eq-remessas .sp-eq-nota { margin-top: 0; }
  .pd-eq-sel { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .pd-eq-sel button { border: 1px solid var(--border); background: var(--surface, #fff); border-radius: 999px; padding: 3px 11px; font: inherit; font-size: 12px; text-transform: none; letter-spacing: 0; color: var(--text-soft); cursor: pointer; }
  .pd-eq-sel button.ativo { background: var(--text); color: #fff; border-color: var(--text); }
  .pd-eq-grade { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .pd-eq-grade.uma { grid-template-columns: 1fr; }
  .pd-eq { border: 1px solid var(--border); border-left: 4px solid var(--eq); border-radius: 12px; padding: 10px 14px; background: color-mix(in srgb, var(--eq) 4%, #fff); display: flex; flex-direction: column; gap: 7px; min-width: 0; }
  .pd-eq-topo { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .pd-eq-topo b { color: var(--eq); font-size: 14px; }
  .pd-eq-topo span { font-size: 11.5px; color: var(--muted); }
  .pd-eq-nums { display: flex; gap: 22px; flex-wrap: wrap; }
  .pd-eq-nums > div { display: flex; flex-direction: column; }
  .pd-eq-n { font-size: 24px; font-weight: 800; line-height: 1.05; color: var(--text); font-variant-numeric: tabular-nums; }
  .pd-eq-n.ok { color: #15803d; }
  .pd-eq-nums small { font-size: 11px; color: var(--muted); }
  .pd-eq-tempo .pd-eq-n { color: var(--eq); }
  .pd-eq-tempo.estoura .pd-eq-n { color: #dc2626; }
  .pd-eq-det { font-size: 12px; color: var(--muted); }
  .pd-eq-canais .pronto { color: #7c3aed !important; }
  .rm-ritmo { font-size: 12px; color: var(--text-soft); }
  .rm-tempo { width: 100%; font-size: 12px; color: var(--text-soft); }
  .rm-recorde { margin-left: 4px; font-weight: 700; color: #b45309; }
  .rm-peds { font-size: 12px; }
  .rm-peds summary { cursor: pointer; font-weight: 600; color: var(--text-soft); }
  .rm-peds table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  .rm-peds th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); padding: 3px 6px; border-bottom: 1px solid var(--border); }
  .rm-peds td { padding: 4px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .rm-peds td:last-child { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rm-peds .pz-copiar { margin-left: 4px; border: none; background: none; cursor: pointer; color: var(--muted); }
  .rm-relogio { font-size: 12.5px; color: var(--text-soft); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; border-radius: 10px; background: var(--bg); }
  .rm-relogio.ok { background: color-mix(in srgb, var(--rm) 8%, #fff); }
  .rm-rel-grande { display: flex; align-items: center; gap: 14px; width: 100%; flex-wrap: wrap; }
  .rm-rel-n { font-size: 44px; font-weight: 800; line-height: 1; color: var(--rm); font-variant-numeric: tabular-nums; letter-spacing: -.03em; }
  .rm-rel-rot { font-size: 13px; line-height: 1.4; color: inherit; }
  .rm-relogio { padding: 12px 14px !important; }
  .rm-relogio.alerta .rm-rel-n { color: #ea580c; }
  .rm-relogio.atraso .rm-rel-n { color: #dc2626; animation: eq-pisca 1.2s ease-in-out infinite; }
  .rm-relogio.just .rm-rel-n { color: #b45309; }
  @media (max-width: 700px) { .rm-rel-n { font-size: 34px; } }
  .rm-relogio.fim { background: #f0fdf4; color: #15803d; }
  .rm-relogio.just { background: #fffbeb; color: #92400e; }
  .rm-relogio.alerta { background: #fff7ed; color: #9a3412; border: 2px solid #fb923c; }
  .rm-relogio.atraso { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  .rm-just { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; width: 100%; animation: none; }
  .rm-just span { font-weight: 700; }
  .rm-just button { border: 1px solid currentColor; background: #fff; color: inherit; border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .rm-just button:hover { filter: brightness(.93); box-shadow: 0 0 0 2px currentColor inset; }
  .pd-eq-canais { display: grid; grid-template-columns: minmax(90px, max-content) 64px 64px 72px; gap: 3px 14px; align-items: baseline; font-size: 13px; font-variant-numeric: tabular-nums; }
  .pd-eq-canais .cab { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .pd-eq-canais .nome { font-weight: 600; color: var(--text-soft); }
  .pd-eq-canais span:not(.nome):not(.cab) { font-weight: 700; color: var(--text); }
  .pd-eq-canais .ok { color: #15803d !important; }
  .pd-eq-canais .zero { color: var(--muted) !important; font-weight: 500 !important; }
  .pd-eq-canais .embreve { font-size: 11.5px; font-weight: 500 !important; color: var(--muted) !important; font-style: italic; }
  .pd-eq-alerta { color: #b91c1c; font-weight: 600; }
  .pd-eq-cfg { font-size: 11.5px; color: var(--muted); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .pd-eq-cfg input { width: 54px; padding: 2px 5px; border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 12px; }
  .pd-acum { display: flex; flex-direction: column; gap: 6px; padding-right: 18px; border-right: 1px solid var(--border); min-width: 170px; }
  .pd-acum-topo { display: flex; align-items: center; gap: 10px; }
  .pd-acum-num { font-size: 28px; font-weight: 800; letter-spacing: -.03em; line-height: 1; color: #15803d; font-variant-numeric: tabular-nums; }
  .pd-acum-rot { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); line-height: 1.3; }
  .pd-acum-barra { height: 7px; border-radius: 999px; background: var(--bg); overflow: hidden; }
  .pd-acum-barra span { display: block; height: 100%; background: #22c55e; transition: width .4s; }
  .pd-acum-det { font-size: 11.5px; color: var(--muted); }
  .pd-acum-det b { color: #15803d; }
  .pd-dir { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
  .pd-barra { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--bg); }
  .pd-barra span { display: block; height: 100%; transition: width .4s; }
  .pd-mkts { display: flex; gap: 10px 22px; flex-wrap: wrap; }
  .pd-mkt { border: none; background: none; padding: 0; font: inherit; text-align: left; cursor: pointer; display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .pd-mkt:hover .pd-mkt-nome { text-decoration: underline; }
  .pd-mkt-cor { width: 10px; height: 10px; border-radius: 3px; flex: none; align-self: center; }
  .pd-mkt-num { font-size: 19px; font-weight: 800; color: var(--text); font-variant-numeric: tabular-nums; }
  .pd-mkt-nome { font-size: 13px; font-weight: 700; color: var(--text-soft); }
  .pd-mkt-det { font-size: 12px; color: var(--muted); }
  .pd-nota { font-size: 11.5px; color: var(--muted); }
  @media (max-width: 700px) {
    .pd-faixa { grid-template-columns: 1fr; gap: 10px; }
    .pd-total, .pd-acum { border-right: none; padding-right: 0; }
    .pd-eq-grade { grid-template-columns: 1fr; }
    .prazos-pane > .pd-faixa { margin: 10px 12px 0; }
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
    .shopee-pane .shopee-banner { flex-direction: row; flex-wrap: wrap; align-items: center; padding: 12px 14px; }
    .shopee-banner .history-actions { flex: 1 1 100%; }
    .shopee-banner .history-actions .sp-select { flex: 1; min-width: 0; }
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
  // Cada categoria da Shopee e um item proprio no menu, igual ao Mercado
  // Livre (pedido do usuario, 18/11). O botao "shopee" do index.html vira
  // "Prazos"; Chat, Devolucoes e Lojas sao criados aqui. Os criados nao
  // passam pelo app.js (que so conhece os botoes do index.html): eles
  // "clicam" no botao original e depois trocam a categoria.
  const ABAS = [
    { id: "prazos", nome: "Prazos", titulo: "Prazos de despacho" },
    { id: "chat", nome: "Chat", titulo: "Chat com compradores" },
    { id: "devolucoes", nome: "Devoluções", titulo: "Devoluções e reembolsos" },
    { id: "lojas", nome: "Lojas", titulo: "Lojas conectadas" },
  ];
  const svg = (d) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICONES = {
    prazos: svg('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'),
    chat: svg('<path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12z"/>'),
    devolucoes: svg('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
    lojas: svg('<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>'),
  };
  const navAbas = {};
  let abaPedida = null;
  const irPara = (id) => {
    abaPedida = id;
    navShopee?.click();
  };
  if (navShopee && !navShopee.dataset.spAba) {
    navShopee.dataset.spAba = "prazos";
    navShopee.title = "Shopee · Prazos de despacho";
    navShopee.querySelector(".module-nav-icon").innerHTML = ICONES.prazos;
    navShopee.querySelector(".module-nav-label").textContent = "Prazos";
    navAbas.prazos = navShopee;
    let anterior = navShopee;
    for (const a of ABAS.slice(1)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "module-nav-item";
      b.dataset.mkt = "shopee";
      b.dataset.spAba = a.id;
      b.dataset.spExtra = "1";
      b.title = `Shopee · ${a.titulo}`;
      b.innerHTML = `<span class="module-nav-icon">${ICONES[a.id]}</span><span class="module-nav-label">${a.nome}</span>`;
      b.addEventListener("click", () => irPara(a.id));
      anterior.after(b);
      anterior = b;
      navAbas[a.id] = b;
    }
    // Equipes: item proprio, num grupo "Operacao" (junta ML + Shopee, nao e
    // de um marketplace so). Pedido do usuario em 18/11: "campo separado".
    const gOp = document.createElement("div");
    gOp.className = "mkt-grupo op";
    gOp.textContent = "Operação";
    anterior.after(gOp);
    const bEq = document.createElement("button");
    bEq.type = "button";
    bEq.className = "module-nav-item";
    bEq.dataset.mkt = "op";
    bEq.dataset.spAba = "equipes";
    bEq.dataset.spExtra = "1";
    bEq.title = "Operação · Equipes do dia";
    bEq.innerHTML = `<span class="module-nav-icon">${svg('<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M15 20a4.5 4.5 0 0 1 7-3.7"/>')}</span><span class="module-nav-label">Equipes</span>`;
    bEq.addEventListener("click", () => irPara("equipes"));
    gOp.after(bEq);
    navAbas.equipes = bEq;
    const bRem = document.createElement("button");
    bRem.type = "button";
    bRem.className = "module-nav-item";
    bRem.dataset.mkt = "op";
    bRem.dataset.spAba = "remessas";
    bRem.dataset.spExtra = "1";
    bRem.title = "Operação · Remessas do dia (por horário de venda)";
    bRem.innerHTML = `<span class="module-nav-icon">${svg('<rect x="3" y="4" width="18" height="5" rx="1"/><rect x="3" y="11" width="18" height="5" rx="1"/><path d="M7 20h10"/>')}</span><span class="module-nav-label">Remessas</span>`;
    bRem.addEventListener("click", () => irPara("remessas"));
    // Remessas nao tem item proprio: aparecem dentro de Equipes (pedido 18/11).
    void bRem;
    for (const a of ABAS) {
      const badge = document.createElement("span");
      badge.id = `sp-conta-${a.id}`;
      badge.className = "tab-count module-badge hidden";
      navAbas[a.id].appendChild(badge);
    }
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
          <h2><span id="sp-marca">Shopee</span> · <span id="sp-titulo">Prazos de despacho</span></h2>
          <div id="shopee-status" class="small">Carregando...</div>
        </div>
      </div>
      <div class="history-actions">
        <select id="sp-loja-filtro" class="sp-select sp-btn-vidro" title="Filtrar por loja"></select>
        <button type="button" id="sp-atualizar" class="btn btn-sm sp-btn-vidro" title="Buscar agora na Shopee">⟳ Atualizar</button>
      </div>
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
  let aba = "prazos";
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
  // So os botoes do index.html (os criados aqui ja chamam irPara).
  document.querySelectorAll(".module-nav-item:not([data-sp-extra])").forEach((btn) => {
    btn.addEventListener("click", () => {
      visivel = btn.dataset.module === "shopee";
      pane.classList.toggle("hidden", !visivel);
      if (visivel) {
        aba = abaPedida || "prazos";
        abaPedida = null;
      }
      // O app.js marca como ativo so os botoes que ele conhece.
      for (const [id, b] of Object.entries(navAbas)) b.classList.toggle("active", visivel && id === aba);
      if (visivel) {
        // Troca titulo e corpo na hora (o resto chega depois do fetch).
        $("sp-titulo").textContent = tituloAba();
        if (estado) render();
        abrir();
      }
    });
  });
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
    if (aba === "equipes" || aba === "remessas") return carregarPacotesDia().then(render);
    if (aba === "prazos") return carregarPrazos(opcoes);
    if (aba === "chat") return carregarChat(opcoes);
    if (aba === "devolucoes") return carregarDevolucoes(opcoes);
    return carregarEstado().then(render);
  }

  function tituloAba() {
    if (aba === "equipes") return "Equipes do dia";
    if (aba === "remessas") return "Remessas do dia";
    return ABAS.find((a) => a.id === aba)?.titulo || "";
  }

  function render() {
    $("sp-titulo").textContent = tituloAba();
    const eq = aba === "equipes" || aba === "remessas";
    pane.classList.toggle("sp-modo-eq", eq);
    $("sp-marca").textContent = eq ? "Operação" : "Shopee";
    $("sp-atualizar").classList.toggle("hidden", aba === "lojas");
    corpo.classList.toggle("sp-sem-rolagem", aba === "chat");
    if (aba === "remessas") return renderRemessas();
    if (eq) return renderEquipes();
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
  // Mesmo visual do Prazos do Mercado Livre (reaproveita as classes
  // prazos-*/pz-* do style.css), com conceitos da Shopee: um cartao por LOJA
  // (no ML e por modalidade), anel = quanto ja tem etiqueta gerada, relogio
  // ate o prazo da Shopee (ship_by_date) e barras por transportadora.
  let prazos = null;
  let spVisao = lerPref("prazosVisao", "hoje");
  let spLojaSel = null; // cartao escolhido na visao "Para hoje"
  let spModo = lerPref("prazosModo2", "produtos");
  const spAbertos = new Set(); // produtos abertos no detalhe (sobrevive ao re-render)

  async function carregarPrazos({ forcar = false } = {}) {
    try {
      prazos = await api(forcar ? "/api/shopee/prazos/atualizar" : "/api/shopee/prazos", { method: forcar ? "POST" : "GET" });
      if (!mlPrazos) api("/api/prazos").then((r) => ((mlPrazos = r), atualizarFaixas())).catch(() => {});
      if (aba === "prazos" && visivel) render();
      atualizarContas();
    } catch (err) {
      if (aba === "prazos") corpo.innerHTML = `<div class="shopee-aviso erro">Erro ao carregar os prazos: ${esc(err.message)}</div>`;
    }
  }

  const durMin = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`);
  const falta = (ms) => {
    const min = Math.round((ms - Date.now()) / 60000);
    return min < 0 ? `há ${durMin(-min)}` : `faltam ${durMin(min)}`;
  };
  const diasAtras = (ms) => Math.round((Date.parse(diaSP(Date.now())) - Date.parse(diaSP(ms))) / 864e5);

  function gruposPrazos() {
    const hoje = diaSP(Date.now());
    const todos = prazos.pedidos.filter((p) => passaLoja(p.shopId));
    return {
      hoje: todos.filter((p) => p.situacao !== "atrasado" && (!p.prazo || diaSP(p.prazo) === hoje)),
      atrasados: todos.filter((p) => p.situacao === "atrasado"),
      proximos: todos.filter((p) => p.situacao !== "atrasado" && p.prazo && diaSP(p.prazo) > hoje),
    };
  }

  function renderPrazos() {
    if (!prazos) {
      corpo.innerHTML = `<p class="prazos-vazio grande">Carregando pedidos da Shopee...</p>`;
      return;
    }
    const g = gruposPrazos();
    const errosLojas = Object.fromEntries(
      Object.entries(prazos.lojas || {}).filter(([, l]) => l.erro).map(([id, l]) => [id, l.erro])
    );
    const corpoVisao = {
      hoje: () => visaoHoje(g),
      atrasados: () => visaoAtrasados(g.atrasados),
      proximos: () => visaoProximos(g.proximos),
    }[spVisao] || (() => visaoHoje(g));
    corpo.innerHTML = `
      <div class="pd-faixa" data-pd>${htmlPacotesDia()}</div>
      ${errosDeLoja(errosLojas)}
      <div>
        ${resumoPrazos(g)}
        ${abasPrazos(g)}
        <div class="sp-atualizado">${prazos.atualizadoEm ? `Atualizado às ${hora(prazos.atualizadoEm)} · busca automática a cada 3 min` : "Buscando na Shopee..."}</div>
      </div>
      ${corpoVisao()}`;
  }

  function resumoPrazos(g) {
    const organizar = g.hoje.filter((p) => p.etapa === "organizar").length;
    const risco = g.hoje.filter((p) => p.situacao === "risco").length;
    const proxPrazo = g.hoje.map((p) => p.prazo).filter(Boolean).sort((a, b) => a - b)[0];
    const atrasHoje = g.atrasados.filter((p) => p.prazo && diasAtras(p.prazo) === 0).length;
    const cartoes = [
      {
        visao: "hoje", cls: "imprimir", n: g.hoje.length, rotulo: "Para enviar hoje",
        sub: proxPrazo ? `prazo ${hora(proxPrazo)} · ${falta(proxPrazo)}` : "nada com prazo hoje",
      },
      { visao: "hoje", cls: "risco", n: organizar, rotulo: "A organizar", sub: "falta gerar a etiqueta" },
      { visao: "hoje", cls: "estourou", n: risco, rotulo: "Em risco", sub: `menos de ${prazos.margemRiscoHoras}h para o prazo` },
      { visao: "atrasados", cls: "atrasado", n: g.atrasados.length, rotulo: "Atrasados", sub: `${atrasHoje} de hoje · ${g.atrasados.length - atrasHoje} antigos` },
      { visao: "proximos", cls: "impresso", n: g.proximos.length, rotulo: "Próximos dias", sub: "prazo amanhã ou depois" },
    ];
    return `<div class="prazos-resumo">${cartoes
      .map(
        (c) => `<button type="button" class="prazos-kpi kpi-${c.cls}${c.n ? "" : " zerado"}" data-sp-visao="${c.visao}">
          <span class="kpi-n">${c.n}</span><span class="kpi-rotulo">${c.rotulo}</span><span class="kpi-sub">${esc(c.sub)}</span>
        </button>`
      )
      .join("")}</div>`;
  }

  function abasPrazos(g) {
    const abas = [
      { id: "hoje", nome: "Para hoje", n: g.hoje.length },
      { id: "atrasados", nome: "Atrasados", n: g.atrasados.length },
      { id: "proximos", nome: "Próximos dias", n: g.proximos.length },
    ];
    return `<div class="prazos-abas" role="tablist">${abas
      .map(
        (a) => `<button type="button" role="tab" class="prazos-aba aba-${a.id}${a.id === spVisao ? " ativa" : ""}" data-sp-visao="${a.id}">
          ${a.nome}${a.n ? `<span class="prazos-aba-n">${a.n}</span>` : ""}</button>`
      )
      .join("")}</div>`;
  }

  // ---------- Para hoje: um cartao por loja ----------
  const ROTULO_NIVEL_SP = {
    atrasado: "Com atraso",
    risco: "Em risco",
    no_prazo: "No prazo",
    concluido: "Tudo com etiqueta",
    vazio: "Sem pedidos hoje",
  };

  function visaoHoje(g) {
    const lojas = (estado?.contas || [])
      .filter((c) => passaLoja(c.shopId))
      .map((c) => {
        const itens = g.hoje.filter((p) => p.shopId === c.shopId);
        const atrasHoje = g.atrasados.filter((p) => p.shopId === c.shopId && p.prazo && diasAtras(p.prazo) === 0).length;
        const nivel = atrasHoje
          ? "atrasado"
          : itens.some((p) => p.situacao === "risco")
            ? "risco"
            : itens.some((p) => p.etapa === "organizar")
              ? "no_prazo"
              : itens.length
                ? "concluido"
                : "vazio";
        return { id: c.shopId, nome: c.nome || `Loja ${c.shopId}`, itens, atrasHoje, nivel };
      });
    if (!lojas.some((l) => l.itens.length)) {
      return `<p class="prazos-vazio grande">${prazos.atualizadoEm ? "Nenhum pedido Shopee para enviar hoje. ✓" : "Buscando os pedidos na Shopee..."}</p>`;
    }
    const peso = { atrasado: 0, risco: 1, no_prazo: 2, concluido: 3, vazio: 4 };
    if (spLojaSel !== "todas" && !lojas.some((l) => l.id === spLojaSel && l.itens.length)) {
      spLojaSel = [...lojas].filter((l) => l.itens.length).sort((a, b) => peso[a.nivel] - peso[b.nivel] || b.itens.length - a.itens.length)[0].id;
    }
    const sel =
      spLojaSel === "todas"
        ? { nome: "Todas as lojas", itens: g.hoje }
        : lojas.find((l) => l.id === spLojaSel);
    return `
      <div class="pz-cards">${lojas.map(cartaoLoja).join("")}</div>
      ${detalhePrazos({
        nome: sel.nome,
        itens: sel.itens,
        sub: "para enviar hoje",
        extra: lojas.filter((l) => l.itens.length).length > 1
          ? `<button type="button" class="btn btn-ghost btn-sm" data-sp-loja="${spLojaSel === "todas" ? lojas[0].id : "todas"}">${spLojaSel === "todas" ? "Ver por loja" : "Ver todas as lojas juntas"}</button>`
          : "",
      })}`;
  }

  function cartaoLoja(l) {
    const total = l.itens.length;
    const prontos = l.itens.filter((p) => p.etapa === "aguardando").length;
    const organizar = total - prontos;
    const pct = total ? Math.round((prontos / total) * 100) : 0;
    const prox = l.itens.map((p) => p.prazo).filter(Boolean).sort((a, b) => a - b)[0];
    const min = prox ? Math.round((prox - Date.now()) / 60000) : null;
    let relogio;
    if (min == null) relogio = `<div class="pz-relogio"><b>${total ? "—" : "✓"}</b><span>${total ? "sem prazo informado" : "nada para hoje"}</span></div>`;
    else if (min < 0) relogio = `<div class="pz-relogio passou"><b>+${durMin(-min)}</b><span>passou do prazo das ${hora(prox)}</span></div>`;
    else relogio = `<div class="pz-relogio"><b>${durMin(min)}</b><span>para enviar até ${hora(prox)}</span></div>`;

    const porTransp = new Map();
    for (const p of l.itens) {
      const t = p.transportadora || "Sem transportadora";
      porTransp.set(t, (porTransp.get(t) || 0) + 1);
    }
    const transps = [...porTransp.entries()].sort((a, b) => b[1] - a[1]);
    const maxT = Math.max(1, ...transps.map((t) => t[1]));
    return `
      <button type="button" class="pz-card nivel-${l.nivel}${l.id === spLojaSel ? " sel" : ""}" data-sp-loja="${esc(l.id)}" ${l.itens.length ? "" : "disabled"}>
        <div class="pz-card-topo">
          <span class="pz-card-nome"><i class="sp-ponto-loja" style="background:${corLoja(l.id)}"></i>${esc(l.nome)}</span>
          <span class="pz-status nivel-${l.nivel}">${ROTULO_NIVEL_SP[l.nivel]}</span>
        </div>
        <div class="pz-card-meio">
          <div class="pz-anel" style="--p:${pct}" role="img" aria-label="${pct}% com etiqueta">
            <div><b>${total}</b><span>para hoje</span></div>
          </div>
          ${relogio}
        </div>
        <div class="pz-progresso-txt">${prontos} de ${total} com etiqueta gerada · ${pct}%${
          organizar ? `<br><span class="sp-organizar-txt">${organizar} ainda a organizar (gerar etiqueta)</span>` : ""
        }${l.atrasHoje ? `<br><span class="sp-atraso-txt">+ ${l.atrasHoje} atrasado${l.atrasHoje > 1 ? "s" : ""} de hoje</span>` : ""}</div>
        <div class="pz-contas">${
          transps.length
            ? transps
                .map(
                  ([nome, n]) => `<div class="pz-conta"><span class="pz-conta-nome">${esc(nome)}</span>
                    <span class="pz-conta-barra"><i style="width:${(n / maxT) * 100}%"></i></span><b>${n}</b></div>`
                )
                .join("")
            : '<div class="pz-conta-vazio">Nenhum pedido para hoje</div>'
        }</div>
      </button>`;
  }

  // ---------- Detalhe: por produto (o que separar) ou por pedido ----------
  function detalhePrazos({ nome, itens, sub, extra = "", vazio, colPrazo, chave = nome }) {
    const modos = `<div class="pz-seg" role="group" aria-label="Agrupar">
      <button type="button" data-sp-modo="produtos" class="${spModo === "produtos" ? "on" : ""}">Por produto</button>
      <button type="button" data-sp-modo="pedidos" class="${spModo === "pedidos" ? "on" : ""}">Por pedido</button>
    </div>`;
    const conteudo = !itens.length
      ? `<p class="prazos-vazio grande">${vazio || "Nada aqui. ✓"}</p>`
      : spModo === "produtos"
        ? tabelaProdutosSP(itens, chave, colPrazo)
        : tabelaPedidosSP(itens, colPrazo);
    return `
      <section class="pz-detalhe">
        <div class="pz-detalhe-topo">
          <div><span class="pz-titulo">${esc(nome)}</span> <span class="pz-sub">${itens.length} ${itens.length === 1 ? "pedido" : "pedidos"} ${sub}</span></div>
          <div class="sp-barra">${extra}${modos}</div>
        </div>
        ${conteudo}
      </section>`;
  }

  const SIT_ORDEM = { atrasado: 0, risco: 1, hoje: 2, no_prazo: 3, sem_prazo: 4 };
  const sitClasse = (s) => (s === "atrasado" ? "atrasado" : s === "risco" ? "risco" : "");

  const prazoPadrao = {
    titulo: "Enviar até",
    valor: (p) =>
      p.prazo
        ? `<b>${diaSP(p.prazo) === diaSP(Date.now()) ? hora(p.prazo) : dataHora(p.prazo)}</b><small>${falta(p.prazo)}</small>`
        : "<b>—</b>",
  };

  function tabelaProdutosSP(itens, ctx, colPrazo) {
    const grupos = new Map();
    for (const p of itens) {
      for (const it of p.itens) {
        const chave = `${it.nome}|${it.variacao}`;
        const gr = grupos.get(chave) || { nome: it.nome, variacao: it.variacao, sku: it.sku, un: 0, pedidos: new Map(), lojas: new Set(), prazo: null, pior: 9 };
        gr.un += it.qtd || 0;
        gr.pedidos.set(p.orderSn, p);
        gr.lojas.add(p.loja);
        if (p.prazo && (!gr.prazo || p.prazo < gr.prazo)) gr.prazo = p.prazo;
        gr.pior = Math.min(gr.pior, SIT_ORDEM[p.situacao] ?? 9);
        grupos.set(chave, gr);
      }
    }
    const lista = [...grupos.values()].sort((a, b) => a.pior - b.pior || b.un - a.un);
    const sitPorOrdem = Object.fromEntries(Object.entries(SIT_ORDEM).map(([k, v]) => [v, k]));
    return `<div class="pz-produtos">${lista
      .map((gr) => {
        const sit = sitClasse(sitPorOrdem[gr.pior]);
        const pedidos = [...gr.pedidos.values()];
        const chave = `${ctx}|${gr.nome}|${gr.variacao}`;
        return `<details class="pz-produto ${sit ? `sit-${sit === "atrasado" ? "estourou" : sit}` : ""}" data-sp-chave="${esc(chave)}"${spAbertos.has(chave) ? " open" : ""}>
          <summary>
            <span class="pz-produto-qtd"><b>${gr.un}</b><small>${gr.un === 1 ? "unid." : "unids."}</small></span>
            <span class="pz-produto-nome">${esc(gr.nome)}<small>${esc([gr.variacao, gr.sku && `SKU ${gr.sku}`, [...gr.lojas].join(" · ")].filter(Boolean).join(" · "))}</small></span>
            <span class="pz-produto-un"><b>${pedidos.length}</b><small>${pedidos.length === 1 ? "pedido" : "pedidos"}</small></span>
            <span class="pz-produto-limite"><b>${gr.prazo ? (diaSP(gr.prazo) === diaSP(Date.now()) ? hora(gr.prazo) : dataHora(gr.prazo)) : "—"}</b><small>${gr.prazo ? falta(gr.prazo) : ""}</small></span>
          </summary>
          ${tabelaPedidosSP(pedidos, colPrazo, true)}
        </details>`;
      })
      .join("")}</div>`;
  }

  function tabelaPedidosSP(lista, colPrazo = prazoPadrao, compacta = false) {
    const ordenada = [...lista].sort((a, b) => (SIT_ORDEM[a.situacao] ?? 9) - (SIT_ORDEM[b.situacao] ?? 9) || (a.prazo || Infinity) - (b.prazo || Infinity));
    return `<table class="pz-tabela${compacta ? " compacta" : ""}">
      <thead><tr><th>Pedido</th><th>Loja</th><th>Produto</th><th class="num">Qtd</th><th>Etapa</th><th class="dir">${colPrazo.titulo}</th></tr></thead>
      <tbody>${ordenada
        .map((p) => {
          const qtd = p.itens.reduce((s, i) => s + (i.qtd || 0), 0);
          const produto = p.itens.map((i) => `${i.nome}${i.variacao ? ` (${i.variacao})` : ""}`).join(" · ");
          const etapa = p.embaladoEm
            ? `<span class="sp-chip embalado" title="Embalado no Tiny (horário = quando o painel viu)">Embalado ✓ ${p.embaladoSemHora ? dataHora(p.embaladoEm).slice(0, 5) : hora(p.embaladoEm)}</span>`
            : p.etapa === "organizar"
              ? '<span class="sp-chip organizar">Organizar envio</span>'
              : `<span class="sp-chip aguardando">${p.modalidade === "agencia" ? "Levar na agência" : p.modalidade === "coleta" ? "Aguardando coleta" : "Etiqueta gerada"}</span>`;
          const s = sitClasse(p.situacao);
          return `<tr class="${s ? `sit-${s}` : ""}">
            <td data-label="Pedido"><span class="pz-venda"><span class="sp-sn">${esc(p.orderSn)}</span><button type="button" class="pz-copiar" data-sp-copiar="${esc(p.orderSn)}" title="Copiar número do pedido" aria-label="Copiar pedido ${esc(p.orderSn)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button type="button" class="pz-copiar" data-sp-abrir="${esc(p.orderSn)}" data-tipo="pedido" data-shop="${esc(p.shopId)}" data-loja="${esc(p.loja)}" title="Abrir a lista de pedidos na Shopee (copia o número)" aria-label="Abrir pedido ${esc(p.orderSn)} na Shopee">↗</button></span></td>
            <td data-label="Loja"><i class="sp-ponto-loja" style="background:${corLoja(p.shopId)}"></i>${esc(p.loja)}</td>
            <td data-label="Produto" class="pz-td-produto" title="${esc(produto)}">${esc(produto)}</td>
            <td data-label="Qtd" class="num">${qtd}</td>
            <td data-label="Etapa">${etapa}${p.transportadora ? `<small class="sp-transp">${esc(p.transportadora)}</small>` : ""}</td>
            <td data-label="${colPrazo.titulo}" class="dir pz-td-prazo">${colPrazo.valor(p)}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
  }

  // ---------- Atrasados: por idade ----------
  function visaoAtrasados(lista) {
    if (!lista.length) return '<p class="prazos-vazio grande">Nenhum pedido Shopee atrasado. ✓</p>';
    const faixas = [
      { nome: "Venceu hoje", f: (d) => d === 0, nota: "ainda dá para despachar hoje" },
      { nome: "Venceu ontem", f: (d) => d === 1 },
      { nome: "2 a 7 dias", f: (d) => d >= 2 && d <= 7 },
      { nome: "Mais de 7 dias", f: (d) => d > 7, nota: "provavelmente travados: conferir na Central do Vendedor" },
    ];
    const colAtraso = {
      titulo: "Venceu",
      valor: (p) => (p.prazo ? `<b>${dataHora(p.prazo)}</b><small>${falta(p.prazo)}</small>` : "<b>—</b>"),
    };
    return faixas
      .map((f) => {
        const itens = lista.filter((p) => f.f(p.prazo ? diasAtras(p.prazo) : 99));
        if (!itens.length) return "";
        return detalhePrazos({ nome: f.nome, itens, sub: f.nota ? `· ${f.nota}` : "atrasados", colPrazo: colAtraso, chave: `atr-${f.nome}` });
      })
      .join("");
  }

  // ---------- Proximos dias: por dia ----------
  function visaoProximos(lista) {
    if (!lista.length) return '<p class="prazos-vazio grande">Nenhum pedido com prazo nos próximos dias.</p>';
    const porDia = new Map();
    for (const p of lista) {
      const d = diaSP(p.prazo);
      if (!porDia.has(d)) porDia.set(d, []);
      porDia.get(d).push(p);
    }
    return [...porDia.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, itens]) => detalhePrazos({ nome: diaRotulo(itens[0].prazo), itens, sub: "com prazo neste dia", chave: `prox-${d}` }))
      .join("");
  }

  // Cliques da tela de prazos (delegado: o corpo e recriado a cada render).
  corpo.addEventListener("click", async (ev) => {
    if (aba !== "prazos") return;
    const copiar = ev.target.closest("[data-sp-copiar]");
    if (copiar) {
      ev.preventDefault();
      try {
        await navigator.clipboard.writeText(copiar.dataset.spCopiar);
        copiar.classList.add("ok");
        setTimeout(() => copiar.classList.remove("ok"), 1200);
      } catch {}
      return;
    }
    const alvo = ev.target.closest("[data-sp-visao],[data-sp-loja],[data-sp-modo]");
    if (!alvo) return;
    const d = alvo.dataset;
    if (d.spVisao) {
      spVisao = d.spVisao;
      salvarPref("prazosVisao", spVisao);
    }
    if (d.spLoja) spLojaSel = d.spLoja;
    if (d.spModo) {
      spModo = d.spModo;
      salvarPref("prazosModo2", spModo);
    }
    renderPrazos();
  });
  // Lembra quais produtos estavam abertos (o re-render a cada 30s fecharia).
  corpo.addEventListener(
    "toggle",
    (ev) => {
      const el = ev.target.closest?.("[data-sp-chave]");
      if (!el) return;
      if (el.open) spAbertos.add(el.dataset.spChave);
      else spAbertos.delete(el.dataset.spChave);
    },
    true
  );

  // =====================================================================
  // CHAT
  // =====================================================================
  let chat = null; // { conversas, erros }
  let conversaAberta = null; // { shopId, id, compradorId, comprador, loja, ultimaMensagemId }
  let msgsAbertas = [];
  let ctxAberto = null; // { produtos, produtosDosPedidos, pedidos } da conversa aberta
  let ctxChave = ""; // produtos/pedidos citados: so busca de novo se mudar
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

  // Selo da marca na lista e no cabecalho.
  function seloMarca(c) {
    const m = c.marca;
    if (!m) return "";
    const quem = m.quem ? ` · ${esc(m.quem)}` : "";
    return m.estado === "tratativa"
      ? `<span class="sp-marca tratativa" title="Cliente quer devolver — em tratativa${quem ? ` (${esc(m.quem)})` : ""}">↩ Em tratativa${m.novaMsg ? " · 💬 cliente respondeu" : ""}</span>`
      : `<span class="sp-marca resolvido" title="Marcada como resolvida${quem ? ` por ${esc(m.quem)}` : ""}">✓ Resolvido</span>`;
  }

  // Marcar / desmarcar (clicar de novo na marca atual tira). Atualiza na hora
  // e grava no servidor; se falhar, volta ao que estava.
  async function marcarConversa(c, estado) {
    const atual = c.marca?.estado || null;
    const novo = atual === estado ? null : estado;
    let quem = "";
    try {
      quem = localStorage.getItem("ml-painel-operator-name") || "";
    } catch {}
    const original = c.marca;
    const aplicar = (marca) => {
      for (const alvo of [c, conversaAberta, chat?.conversas.find((x) => x.shopId === c.shopId && x.id === c.id)]) {
        if (!alvo) continue;
        if (marca) alvo.marca = marca;
        else delete alvo.marca;
      }
    };
    aplicar(novo ? { estado: novo, quem, em: Date.now(), novaMsg: false } : null);
    renderListaConversas();
    atualizarBotoesMarca();
    atualizarContas();
    try {
      await api(`/api/shopee/chat/${encodeURIComponent(c.shopId)}/${encodeURIComponent(c.id)}/marca`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estado: novo, quem, ultimaEm: Math.max(c.ultimaEm || 0, chat?.conversas.find((x) => x.shopId === c.shopId && x.id === c.id)?.ultimaEm || 0) || Date.now() }),
      });
      avisoRapido(
        novo === "resolvido"
          ? `✓ <b>${esc(c.comprador)}</b> marcada como <b>resolvida</b>. Volta sozinha se o cliente escrever de novo.`
          : novo === "tratativa"
            ? `↩ <b>${esc(c.comprador)}</b> em <b>tratativa</b> (devolução). Fica até você tirar a marca.`
            : `Marca de <b>${esc(c.comprador)}</b> removida.`,
        5000
      );
    } catch (err) {
      aplicar(original || null);
      renderListaConversas();
      atualizarBotoesMarca();
      atualizarContas();
      alert(`Não foi possível salvar a marca: ${err.message}`);
    }
  }
  function atualizarBotoesMarca() {
    const e = conversaAberta?.marca?.estado || "";
    $("sp-marcar-resolvido")?.classList.toggle("ativo", e === "resolvido");
    $("sp-marcar-tratativa")?.classList.toggle("ativo", e === "tratativa");
    const alvo = $("sp-marca-topo");
    if (alvo && conversaAberta) alvo.innerHTML = seloMarca(conversaAberta);
  }

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
          <div class="sp-seg"><button type="button" data-cf="todas">Todas</button><button type="button" data-cf="naoLidas">Não lidas</button><button type="button" data-cf="semResposta">Sem resposta</button><button type="button" data-cf="tratativa">Tratativa <span class="sp-cf-n" id="sp-cf-tratativa"></span></button><button type="button" data-cf="resolvidas">Resolvidas</button></div>
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
    // Resolvidas ficam fora de Todas/Nao lidas/Sem resposta (mas aparecem na
    // busca e no filtro "Resolvidas"); Em tratativa tem filtro proprio e
    // continua aparecendo nas demais com o selo.
    const estadoDe = (c) => c.marca?.estado || "";
    const nTrat = chat.conversas.filter((c) => passaLoja(c.shopId) && estadoDe(c) === "tratativa").length;
    const elN = $("sp-cf-tratativa");
    if (elN) elN.textContent = nTrat ? `(${nTrat})` : "";
    const convs = chat.conversas.filter(
      (c) =>
        passaLoja(c.shopId) &&
        (chatFiltro === "tratativa"
          ? estadoDe(c) === "tratativa"
          : chatFiltro === "resolvidas"
            ? estadoDe(c) === "resolvido"
            : (busca || estadoDe(c) !== "resolvido") &&
              (chatFiltro !== "naoLidas" || c.naoLidas > 0) &&
              (chatFiltro !== "semResposta" || c.ultimaDoComprador)) &&
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
            <div style="margin-top:5px">${chipLoja(c.shopId, c.loja)}${seloMarca(c)}</div>
          </div>
          <div class="sp-conv-dir">${c.ultimaEm ? relativo(c.ultimaEm) : ""}${c.naoLidas ? `<span class="sp-nao-lidas">${c.naoLidas}</span>` : ""}</div>
        </div>`;
      })
      .join("");
  }

  async function abrirConversa(c) {
    conversaAberta = { ...c };
    rapidoOk = false;
    ultimoCompleto = 0;
    msgsAbertas = [];
    ctxAberto = null;
    ctxChave = "";
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

  // Atualizacao RAPIDA (so as 25 mensagens mais recentes) quando a Shopee
  // devolve a mais nova na 1a pagina; a cada 90 s (e ao abrir) le tudo.
  let rapidoOk = false;
  let ultimoCompleto = 0;
  const normTxt = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const casaLocal = (m, l) =>
    m.daLoja && ((l.idReal && m.id === l.idReal) || (m.tipo !== "image" && m.tipo !== "video" && normTxt(m.texto) === normTxt(l.texto) && Math.abs((m.em || 0) - l.em) < 5 * 60e3));

  async function carregarMensagens({ rolar = false, completo = false } = {}) {
    if (!conversaAberta) return;
    const alvo = conversaAberta;
    const rapido = !completo && rapidoOk && Date.now() - ultimoCompleto < 90_000;
    try {
      const r = await api(
        `/api/shopee/chat/${encodeURIComponent(alvo.shopId)}/${encodeURIComponent(alvo.id)}?comprador=${encodeURIComponent(alvo.compradorId)}${rapido ? "&rapido=1" : ""}`
      );
      if (conversaAberta !== alvo) return; // trocou de conversa no meio
      if (!rapido) {
        ultimoCompleto = Date.now();
        rapidoOk = r.rapidoOk !== false;
      }
      const antes = msgsAbertas;
      let reais = r.mensagens;
      if (rapido) {
        const porId = new Map(antes.filter((m) => !m.local).map((m) => [m.id, m]));
        for (const m of r.mensagens) porId.set(m.id, m);
        reais = [...porId.values()].sort((a, b) => (a.em || 0) - (b.em || 0));
      }
      // Mensagens enviadas agora e ainda nao vistas na lista da Shopee ficam
      // no fim, com o status; as confirmadas (ou velhas demais) saem.
      const usados = new Set();
      const pendentes = antes
        .filter((m) => m.local)
        .filter((l) => {
          const achou = reais.find((x) => !usados.has(x.id) && casaLocal(x, l));
          if (achou) {
            usados.add(achou.id);
            return false;
          }
          return !(l.status === "enviada" && Date.now() - l.em > 90_000);
        });
      msgsAbertas = [...reais, ...pendentes];
      const sig = (a) => `${a.length}|${a.at(-1)?.id}|${a.map((m) => m.status || "").join("")}`;
      if (sig(msgsAbertas) !== sig(antes) || rolar) renderMensagens(true);
      carregarContexto();
    } catch (err) {
      const box = $("sp-msgs");
      if (box && !msgsAbertas.length) box.innerHTML = `<div class="sp-thread-vazio">Não deu para abrir a conversa: ${esc(traduzErro(err.message))}</div>`;
    }
  }

  // Produtos e pedidos citados na conversa -> cartoes (no balao e na lateral).
  async function carregarContexto() {
    const alvo = conversaAberta;
    if (!alvo) return;
    const chave = JSON.stringify([
      msgsAbertas.flatMap((m) => [...(m.produtos || []), m.produtoRef].filter(Boolean)),
      msgsAbertas.flatMap((m) => [m.pedido, m.pedidoRef]).filter(Boolean),
    ]);
    if (chave === ctxChave && ctxAberto) return;
    ctxChave = chave;
    try {
      const r = await api(
        `/api/shopee/chat/${encodeURIComponent(alvo.shopId)}/${encodeURIComponent(alvo.id)}/contexto?comprador=${encodeURIComponent(alvo.compradorId)}`
      );
      if (conversaAberta !== alvo) return;
      ctxAberto = r;
    } catch (err) {
      if (conversaAberta !== alvo) return;
      ctxAberto = { produtos: [], produtosDosPedidos: [], pedidos: [], erros: [err.message] };
    }
    renderContexto();
    renderMensagens(false);
  }

  const acharProduto = (id) =>
    [...(ctxAberto?.produtos || []), ...(ctxAberto?.produtosDosPedidos || [])].find((p) => p.itemId === String(id));

  function cartaoProduto(p, { id } = {}) {
    if (!p) {
      return `<div class="sp-prod"><span class="sp-prod-sem">🛍️</span><div><div class="sp-prod-nome">Produto ${esc(id || "")}</div><div class="sp-prod-info">${ctxAberto ? "não foi possível carregar o anúncio" : "carregando anúncio..."}</div></div></div>`;
    }
    const preco = p.preco != null ? brl(p.preco) : p.temVariacao ? "preço por variação" : "";
    const info = [
      p.sku && `SKU ${p.sku}`,
      p.estoque != null && `estoque ${p.estoque}`,
      p.avaliacao && `★ ${Number(p.avaliacao).toFixed(1)}`,
      p.status && p.status !== "NORMAL" && `⚠ ${p.status === "UNLIST" ? "pausado" : p.status.toLowerCase()}`,
    ].filter(Boolean);
    return `<a class="sp-prod" href="${esc(p.link)}" target="_blank" rel="noopener" title="Abrir o anúncio na Shopee">
      ${p.imagem ? `<img src="${esc(p.imagem)}" alt="" loading="lazy">` : '<span class="sp-prod-sem">🛍️</span>'}
      <div style="min-width:0"><div class="sp-prod-nome">${esc(p.nome)}</div>
        ${preco ? `<div class="sp-prod-preco">${preco}${p.precoOriginal && p.precoOriginal > p.preco ? `<s>${brl(p.precoOriginal)}</s>` : ""}</div>` : ""}
        <div class="sp-prod-info">${esc(info.join(" · "))} · ver anúncio ↗</div></div>
    </a>`;
  }

  function cartaoPedido(o) {
    const linha = (rot, val) => (val ? `<dt>${rot}</dt><dd>${val}</dd>` : "");
    return `<div class="sp-ped-card">
      <div class="sp-ped-card-topo"><span><span class="sp-sn">${esc(o.orderSn)}</span><button type="button" class="sp-mini-copiar" data-sp-copiar-chat="${esc(o.orderSn)}" title="Copiar número do pedido">⧉</button><button type="button" class="sp-mini-copiar" data-sp-abrir="${esc(o.orderSn)}" data-tipo="pedido" data-shop="${esc(conversaAberta?.shopId || "")}" data-loja="${esc(conversaAberta?.loja || "")}" title="Abrir a lista de pedidos na Shopee (copia o número)">↗</button></span><span class="sp-ped-st">${esc(o.statusTexto)}</span></div>
      <div class="sp-ped-itens">${o.itens
        .map(
          (i) => `<div class="sp-ped-item">${i.imagem ? `<img src="${esc(i.imagem)}" alt="" loading="lazy">` : '<span class="sp-prod-sem"></span>'}
            <span title="${esc(i.nome)}${i.variacao ? ` (${esc(i.variacao)})` : ""}">${esc(i.nome)}${i.variacao ? ` <span class="muted">· ${esc(i.variacao)}</span>` : ""}</span><b>${i.qtd}×</b></div>`
        )
        .join("")}</div>
      <dl class="sp-ped-dados">
        ${linha("Total", o.total != null ? brl(o.total) : "")}
        ${linha("Pago em", o.pagoEm ? dataHora(o.pagoEm) : "")}
        ${linha("Enviar até", o.enviarAte && !o.saiuEm ? dataHora(o.enviarAte) : "")}
        ${linha("Saiu em", o.saiuEm ? dataHora(o.saiuEm) : "")}
        ${linha("Entrega prevista", o.entregaPrevista ? new Date(o.entregaPrevista).toLocaleDateString("pt-BR", { timeZone: TZ }) : "")}
        ${linha("Transportadora", esc(o.transportadora))}
        ${linha("Rastreio", o.rastreio ? `${esc(o.rastreio)}<button type="button" class="sp-mini-copiar" data-sp-copiar-chat="${esc(o.rastreio)}" title="Copiar rastreio">⧉</button>` : "")}
        ${linha("Pagamento", esc(o.pagamento || ""))}
        ${linha("Cancelamento", esc(o.cancelamento || ""))}
      </dl>
      ${o.mensagemComprador ? `<div class="sp-ped-msg">💬 ${esc(o.mensagemComprador)}</div>` : ""}
    </div>`;
  }

  function renderContexto() {
    const box = $("sp-ctx");
    if (!box) return;
    if (!ctxAberto) {
      box.innerHTML = `<div class="sp-ctx-vazio">Buscando produtos e pedidos citados...</div>`;
      return;
    }
    const prods = ctxAberto.produtos || [];
    const pedsProd = (ctxAberto.produtosDosPedidos || []).filter((p) => !prods.some((x) => x.itemId === p.itemId));
    const peds = ctxAberto.pedidos || [];
    const btn = $("sp-ctx-btn");
    if (btn) btn.textContent = `ℹ ${prods.length + peds.length ? `${peds.length ? `${peds.length} pedido${peds.length > 1 ? "s" : ""}` : ""}${peds.length && prods.length ? " · " : ""}${prods.length ? `${prods.length} produto${prods.length > 1 ? "s" : ""}` : ""}` : "Detalhes"}`;
    box.innerHTML = `
      <section><h4>Produto${prods.length > 1 ? "s" : ""} da conversa</h4>
        <div class="sp-ctx-lista">${prods.length ? prods.map((p) => cartaoProduto(p)).join("") : '<div class="sp-ctx-vazio">O comprador não enviou nenhum anúncio nesta conversa.</div>'}</div></section>
      <section><h4>Pedido${peds.length > 1 ? "s" : ""} da conversa</h4>
        <div class="sp-ctx-lista">${peds.length ? peds.map(cartaoPedido).join("") : '<div class="sp-ctx-vazio">Nenhum pedido citado nesta conversa.</div>'}</div></section>
      ${pedsProd.length ? `<section><h4>Anúncios dos pedidos</h4><div class="sp-ctx-lista">${pedsProd.map((p) => cartaoProduto(p)).join("")}</div></section>` : ""}
      ${(ctxAberto.erros || []).length ? `<div class="shopee-aviso erro" style="font-size:12px">${esc(traduzErro(ctxAberto.erros[0]))}</div>` : ""}
      ${conversaAberta ? `<a class="muted small" style="margin-top:auto" target="_blank" rel="noopener" href="/api/debug/shopee-conversa?shopId=${encodeURIComponent(conversaAberta.shopId)}&conversa=${encodeURIComponent(conversaAberta.id)}">Dados técnicos desta conversa ↗</a>` : ""}`;
  }

  function abrirZoom(url, video) {
    const div = document.createElement("div");
    div.className = "sp-zoom";
    div.innerHTML = video ? `<video src="${esc(url)}" controls autoplay></video>` : `<img src="${esc(url)}" alt="">`;
    div.addEventListener("click", (e) => {
      if (e.target === div) div.remove();
    });
    document.addEventListener("keydown", function fechar(e) {
      if (e.key === "Escape") {
        div.remove();
        document.removeEventListener("keydown", fechar);
      }
    });
    document.body.appendChild(div);
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
        <div style="min-width:0"><div style="font-weight:700;white-space:nowrap">${esc(c.comprador)}<button type="button" class="sp-mini-copiar" data-sp-copiar-chat="${esc(c.comprador)}" title="Copiar usuário do comprador">⧉</button></div><div style="margin-top:2px">${chipLoja(c.shopId, c.loja)}<span id="sp-marca-topo">${seloMarca(c)}</span>${perfilDe(c.shopId) ? `<span class="sp-perfil" title="Perfil do Chrome onde esta loja está logada">🌐 ${esc(perfilDe(c.shopId))}</span>` : ""}</div></div>
        <div class="sp-thread-acoes">
          <button type="button" class="btn btn-ghost btn-sm sp-bt-marca tratativa ${c.marca?.estado === "tratativa" ? "ativo" : ""}" id="sp-marcar-tratativa" title="O cliente quer devolver: fica em tratativa até alguém tirar a marca">↩ Em tratativa</button>
          <button type="button" class="btn btn-ghost btn-sm sp-bt-marca resolvido ${c.marca?.estado === "resolvido" ? "ativo" : ""}" id="sp-marcar-resolvido" title="Assunto resolvido: sai da lista; volta sozinha se o cliente escrever">✓ Resolvido</button>
          <button type="button" class="btn btn-ghost btn-sm" id="sp-abrir-shopee" title="Copia o usuário do comprador e abre o chat da Central do Vendedor; cole na busca (use o Chrome da loja ${esc(c.loja)})">Abrir chat na Shopee ↗</button>
          <button type="button" class="btn btn-ghost btn-sm sp-ctx-btn" id="sp-ctx-btn">ℹ Detalhes</button>
        </div>
      </div>
      <div class="sp-thread-meio">
        <div class="sp-msgs" id="sp-msgs"><div class="sp-thread-vazio">Carregando mensagens...</div></div>
        <aside class="sp-ctx" id="sp-ctx"></aside>
      </div>
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
    $("sp-enviar").addEventListener("click", () => enviar());
    $("sp-marcar-resolvido").addEventListener("click", () => marcarConversa(conversaAberta || c, "resolvido"));
    $("sp-marcar-tratativa").addEventListener("click", () => marcarConversa(conversaAberta || c, "tratativa"));
    $("sp-ctx-btn").addEventListener("click", () => t.classList.toggle("ctx-aberto"));
    // A Shopee nao publica link direto para uma conversa: abre o chat do
    // vendedor e deixa o usuario do comprador copiado para colar na busca.
    $("sp-abrir-shopee").addEventListener("click", () => abrirNaShopee({ shopId: c.shopId, loja: c.loja, tipo: "chat", texto: c.comprador }));
    // Anexos (zoom), copiar pedido/rastreio. #sp-thread so e recriado junto
    // com a tela do chat: registra uma vez por elemento.
    if (!t.dataset.ouvindo) {
      t.dataset.ouvindo = "1";
      t.addEventListener("click", async (e) => {
      const acaoMsg = e.target.closest("[data-sp-reenviar],[data-sp-editar],[data-sp-descartar]");
      if (acaoMsg) {
        const id = acaoMsg.dataset.spReenviar || acaoMsg.dataset.spEditar || acaoMsg.dataset.spDescartar;
        const m = msgsAbertas.find((x) => x.id === id);
        if (!m) return;
        if (acaoMsg.dataset.spReenviar) enviar(m.texto, m);
        else {
          msgsAbertas = msgsAbertas.filter((x) => x !== m);
          if (acaoMsg.dataset.spEditar) {
            const tx = $("sp-texto");
            if (tx) {
              tx.value = m.texto;
              tx.dispatchEvent(new Event("input"));
              tx.focus();
            }
          }
          renderMensagens(false);
        }
        return;
      }
      const anexo = e.target.closest("[data-sp-zoom]");
      if (anexo) {
        e.preventDefault();
        abrirZoom(anexo.dataset.spZoom, anexo.dataset.spVideo === "1");
        return;
      }
      const cp = e.target.closest("[data-sp-copiar-chat]");
      if (cp) {
        try {
          await navigator.clipboard.writeText(cp.dataset.spCopiarChat);
          cp.textContent = "✓";
          setTimeout(() => (cp.textContent = "⧉"), 1200);
        } catch {}
      }
    });
    }
    renderContexto();
    if (msgsAbertas.length) renderMensagens(true);
  }

  function renderMensagens(rolar) {
    const box = $("sp-msgs");
    if (!box) return;
    const noFim = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const topoAntes = box.scrollTop;
    if (!msgsAbertas.length) {
      const conv = conversaAberta && chat?.conversas.find((x) => x.shopId === conversaAberta.shopId && x.id === conversaAberta.id);
      box.innerHTML = `<div class="sp-thread-vazio" style="max-width:420px;margin:auto;line-height:1.5">
        <b>A Shopee não enviou nenhuma mensagem desta conversa.</b><br>
        <span class="small">Na Central do Vendedor ela mostra só cartões do que o cliente consultou (produto, variação) e avisos automáticos, como "conversa fechada automaticamente". Esses cartões ainda não aparecem aqui.</span>
        ${conv?.ultimaTexto ? `<div class="small" style="margin-top:10px">Último registro da lista: “${esc(conv.ultimaTexto)}”</div>` : ""}
        ${conversaAberta ? `<div class="small" style="margin-top:10px"><a target="_blank" rel="noopener" href="/api/debug/shopee-conversa?shopId=${encodeURIComponent(conversaAberta.shopId)}&conversa=${encodeURIComponent(conversaAberta.id)}">Ver dados técnicos desta conversa ↗</a></div>` : ""}
      </div>`;
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
        let corpoMsg;
        let anexo = false;
        if (m.tipo === "image" && (m.imagem || m.miniatura)) {
          anexo = true;
          corpoMsg = `<a class="sp-anexo" href="${esc(m.imagem || m.miniatura)}" target="_blank" rel="noopener" data-sp-zoom="${esc(m.imagem || m.miniatura)}" title="Ampliar"><img src="${esc(m.miniatura || m.imagem)}" alt="Foto enviada" loading="lazy"></a>`;
        } else if (m.tipo === "video" && m.video) {
          anexo = true;
          const dur = m.duracao ? `${Math.floor(m.duracao / 60)}:${String(m.duracao % 60).padStart(2, "0")}` : "";
          corpoMsg = `<a class="sp-anexo video" href="${esc(m.video)}" target="_blank" rel="noopener" data-sp-zoom="${esc(m.video)}" data-sp-video="1" title="Assistir">${
            m.miniatura ? `<img src="${esc(m.miniatura)}" alt="Vídeo enviado" loading="lazy">` : '<div style="width:220px;height:140px;background:#111"></div>'
          }${dur ? `<span class="sp-anexo-dur">${dur}</span>` : ""}</a>`;
        } else if (m.produtos?.length) {
          anexo = true;
          corpoMsg = `<div style="display:flex;flex-direction:column;gap:6px">${m.produtos.map((id) => cartaoProduto(acharProduto(id), { id })).join("")}</div>`;
        } else if (m.pedido) {
          const o = ctxAberto?.pedidos?.find((x) => x.orderSn === m.pedido);
          corpoMsg = `🧾 Pedido <b>${esc(m.pedido)}</b>${o ? `<br><span class="small">${esc(o.statusTexto)}${o.total != null ? ` · ${brl(o.total)}` : ""}</span>` : ""}`;
        } else corpoMsg = esc(m.texto);
        const st =
          m.status === "enviando"
            ? ' <span class="sp-st-msg">⏳ enviando…</span>'
            : m.status === "enviada"
              ? ' <span class="sp-st-msg ok">✓ enviada</span>'
              : m.status === "erro"
                ? ' <span class="sp-st-msg erro">⚠ não enviada</span>'
                : "";
        const erroBox =
          m.status === "erro"
            ? `<div class="sp-msg-erro">${esc(m.erro || "")}<div class="sp-msg-erro-bt">${
                m.censurada ? "" : `<button type="button" data-sp-reenviar="${esc(m.id)}">Tentar de novo</button>`
              }<button type="button" data-sp-editar="${esc(m.id)}">Editar</button><button type="button" data-sp-descartar="${esc(m.id)}">Descartar</button></div></div>`
            : "";
        return `${sep}<div class="sp-msg ${m.daLoja ? "nossa" : "dele"}${anexo ? " anexo" : ""}${m.status ? ` ${m.status}` : ""}">${corpoMsg}<div class="sp-msg-hora">${m.em ? hora(m.em) : ""}${st}</div>${erroBox}</div>`;
      })
      .join("");
    if (rolar || noFim) box.scrollTop = box.scrollHeight;
    else box.scrollTop = topoAntes;
  }

  // ---- Abrir na Central do Vendedor da loja certa (23/11) ----
  // O usuario tem uma loja por perfil do Chrome. O painel nao consegue trocar
  // de perfil, entao: copia o que buscar, abre a Central e avisa DE QUAL loja
  // (e perfil do Chrome, se informado na aba Lojas) e o que colar.
  const perfilDe = (shopId) => lerPref(`perfil_${shopId}`, "");
  const CENTRAL = { chat: "https://seller.shopee.com.br/webchat/conversations", pedido: "https://seller.shopee.com.br/portal/sale/order" };
  function avisoRapido(html, ms = 9000) {
    let el = document.getElementById("sp-aviso-rapido");
    if (!el) {
      el = document.createElement("div");
      el.id = "sp-aviso-rapido";
      el.className = "sp-aviso-rapido";
      document.body.appendChild(el);
    }
    el.innerHTML = html;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("on"), ms);
  }
  async function abrirNaShopee({ shopId, loja, tipo, texto }) {
    window.open(CENTRAL[tipo], "_blank", "noopener");
    try {
      await navigator.clipboard.writeText(texto);
    } catch {}
    const perfil = perfilDe(shopId);
    avisoRapido(
      `<b>${tipo === "chat" ? "Usuário" : "Pedido"} copiado:</b> ${esc(texto)}<br>` +
        `Use a loja <b>${esc(loja || `Loja ${shopId}`)}</b>${perfil ? ` · Chrome: <b>${esc(perfil)}</b>` : ""} e cole na busca.`
    );
  }
  corpo.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-sp-abrir]");
    if (!b) return;
    ev.preventDefault();
    const c = estado?.contas?.find((x) => x.shopId === b.dataset.shop);
    abrirNaShopee({ shopId: b.dataset.shop, loja: b.dataset.loja || c?.nome, tipo: b.dataset.tipo || "pedido", texto: b.dataset.spAbrir });
  });
  document.addEventListener("change", (ev) => {
    const i = ev.target.closest("[data-perfil]");
    if (i) salvarPref(`perfil_${i.dataset.perfil}`, i.value.trim());
  });

  // Envio OTIMISTA (23/11: "demora para enviar e para confirmar"): o balao
  // aparece na hora como "enviando", vira "enviada" quando a Shopee aceita e
  // some quando a mensagem de verdade chega na lista. Erro fica no balao,
  // com Tentar de novo / Editar / Descartar.
  async function enviar(textoForcado, localExistente) {
    const txt = $("sp-texto");
    const texto = String(textoForcado ?? txt?.value ?? "").trim();
    if (!texto || !conversaAberta) return;
    const c = conversaAberta;
    let local = localExistente;
    if (!local) {
      local = { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, local: true, daLoja: true, texto, em: Date.now(), status: "enviando" };
      msgsAbertas.push(local);
      if (txt && textoForcado === undefined) {
        txt.value = "";
        txt.dispatchEvent(new Event("input"));
        txt.focus();
      }
      const conv = chat?.conversas.find((x) => x.shopId === c.shopId && x.id === c.id);
      if (conv) {
        conv.ultimaTexto = texto;
        conv.ultimaDoComprador = false;
        conv.ultimaEm = Date.now();
        renderListaConversas();
      }
    } else {
      local.status = "enviando";
      local.erro = null;
      local.censurada = false;
    }
    if (conversaAberta === c) renderMensagens(true);
    try {
      const r = await api(`/api/shopee/chat/${encodeURIComponent(c.shopId)}/${encodeURIComponent(c.id)}/enviar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compradorId: c.compradorId, texto }),
      });
      local.status = "enviada";
      local.idReal = r.resposta?.message_id ? String(r.resposta.message_id) : null;
      if (conversaAberta === c) {
        renderMensagens(false);
        setTimeout(() => carregarMensagens(), 700);
      }
    } catch (err) {
      // A Shopee bloqueia palavras que ela entende como desvio da plataforma
      // (visto em 18/11 com uma resposta normal de atendimento).
      local.status = "erro";
      local.censurada = /message_is_censored|blacklist/i.test(err.message);
      local.erro = local.censurada
        ? "A Shopee bloqueou esta mensagem: tem alguma palavra proibida no chat (telefone, WhatsApp, e-mail, link, Pix, nome de outro site ou até a assinatura com o nome da empresa). Clique em Editar, ajuste e envie de novo."
        : `Não foi enviada: ${traduzErro(err.message)}`;
      if (conversaAberta === c) renderMensagens(true);
      else alert(`Mensagem para ${c.comprador} não foi enviada.\n\n${local.erro}`);
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
  // PACOTES DO DIA — soma Mercado Livre + Shopee (pedido do usuario, 18/11)
  // =====================================================================
  // Conta o que precisa sair HOJE: prazo de hoje (a imprimir/organizar,
  // impressos aguardando despacho) + atrasados de hoje. Atrasados de dias
  // anteriores ficam fora da soma (sao pedidos travados que inflariam o
  // numero do dia) e aparecem so como nota. Mostrado no topo dos dois Prazos.
  let mlPrazos = null; // /api/prazos (o mesmo que o prazos.js usa)
  let mlSaiuHoje = null; // acumulado do dia do ML (ja sairam hoje)
  let ritmo = null; // /api/pacotes-dia/ritmo (min por pacote medido, por canal)
  let ocorr = {}; // "cat|n" -> ocorrencia da remessa de hoje (justificativa/finalizada)
  const finalizadasEnviadas = new Set();
  let ritmoEm = 0;
  // Nome do canal na tela -> chave do ritmo medido.
  const RITMO_DE = { SPX: "shopee", Shopee: "shopee", Flex: "flex", "ML coleta": "coleta", "ML agência": "agencia", TikTok: "tiktok", Amazon: "amazon" };
  const RITMO_CAT = { spx: "shopee", xpress: "shopee", flex: "flex", coleta: "coleta", agencia: "agencia" };
  const minMedido = (chave) => ritmo?.canais?.[chave]?.minPorPacote || null;
  // Canais embalados no Tiny (sem hora medida ainda): usa o ritmo de embalagem
  // da equipe nos ultimos 15 dias (das 9h ate o fim / pacotes do dia).
  const CANAL_TINY = new Set(["shopee", "tiktok", "amazon"]);
  // Recorde (melhor dia, volume parecido) vale como meta; senao a media.
  function ritmoDe(chave, equipeId) {
    const rc = ritmo?.recordes?.[`canal:${chave}`];
    if (rc) return { m: rc.minPorPacote, recorde: rc };
    if (minMedido(chave)) return { m: minMedido(chave), recorde: null };
    if (CANAL_TINY.has(chave)) {
      const re = ritmo?.recordes?.[`equipe:${equipeId}`];
      if (re) return { m: re.minPorPacote, recorde: re };
      const me = ritmo?.equipes?.[equipeId]?.minPorPacote;
      if (me) return { m: me, recorde: null };
    }
    return { m: null, recorde: null };
  }
  const minCanal = (chave, equipeId) => ritmoDe(chave, equipeId).m;
  const minCanalAntigo = (chave, equipeId) =>
    minMedido(chave) || (CANAL_TINY.has(chave) ? ritmo?.equipes?.[equipeId]?.minPorPacote || null : null);
  const paneML = document.getElementById("prazos-pane");
  let faixaML = null;
  if (paneML) {
    faixaML = document.createElement("div");
    faixaML.className = "pd-faixa hidden";
    faixaML.dataset.pd = "";
    paneML.querySelector(".history-header")?.after(faixaML);
  }

  function contarML() {
    if (!mlPrazos?.envios) return null;
    const hoje = diaSP(Date.now());
    const doDia = (e) => e.prazo && diaSP(Date.parse(e.prazo)) === hoje;
    const r = { imprimir: 0, impressos: 0, atrasadosHoje: 0, antigos: 0 };
    for (const e of mlPrazos.envios) {
      if (e.situacao === "proximos") continue;
      if (e.situacao === "atrasado") {
        if (doDia(e)) r.atrasadosHoje++;
        else r.antigos++;
      } else if (e.situacao === "impresso") r.impressos++;
      else r.imprimir++;
    }
    r.total = r.imprimir + r.impressos + r.atrasadosHoje;
    return r;
  }

  function contarShopee() {
    if (!prazos?.pedidos) return null;
    const hoje = diaSP(Date.now());
    const r = { organizar: 0, aguardando: 0, atrasadosHoje: 0, antigos: 0 };
    for (const p of prazos.pedidos) {
      const dia = p.prazo ? diaSP(p.prazo) : null;
      if (p.situacao === "atrasado") {
        if (dia === hoje) r.atrasadosHoje++;
        else r.antigos++;
      } else if (dia === hoje || !p.prazo) {
        if (p.etapa === "organizar") r.organizar++;
        else r.aguardando++;
      }
    }
    r.total = r.organizar + r.aguardando + r.atrasadosHoje;
    return r;
  }

  // ---- EQUIPES (pedido de 18/11, mesmo esquema do app de separacao) ----
  // Bahia: SPX, Flex e Shopee. Mathias: ML coleta, ML agencia e TikTok.
  // TikTok ainda nao esta ligado ao painel (entra quando tiver a API).
  const EQUIPES = [
    { id: "bahia", nome: "Equipe Bahia", cor: "#2563eb", canais: "SPX · Flex · Shopee", ordem: ["SPX", "Flex", "Shopee"], mlModalidades: ["flex"], shopee: true },
    { id: "mathias", nome: "Equipe Mathias", cor: "#7c3aed", canais: "ML coleta · ML agência · TikTok · Amazon", ordem: ["ML coleta", "ML agência", "TikTok", "Amazon"], mlModalidades: ["coleta", "agencia"], shopee: false, tiny: ["tiktok", "amazon"] },
  ];
  const NOME_MOD = { flex: "Flex", coleta: "ML coleta", agencia: "ML agência" };
  let verEquipe = lerPref("verEquipe", "todas");
  function cfgEquipe(id) {
    let c = {};
    try {
      c = JSON.parse(lerPref(`equipe_${id}`, "{}")) || {};
    } catch {}
    return {
      // null = automatico (ritmo medido de cada canal; sem medida, 2 min)
      minPorPacote: Number(c.minPorPacote) > 0 ? Number(c.minPorPacote) : null,
      pessoas: Number(c.pessoas) > 0 ? Number(c.pessoas) : 1,
      meta: /^\d{2}:\d{2}$/.test(c.meta || "") ? c.meta : "",
    };
  }
  // "17:30" -> horario de hoje em SP (ms). Brasil sem horario de verao: -03:00.
  function metaHoje(meta) {
    if (!meta) return null;
    const ms = Date.parse(`${diaSP(Date.now())}T${meta}:00-03:00`);
    return Number.isFinite(ms) ? ms : null;
  }
  function contagem(ms) {
    const neg = ms < 0;
    const s = Math.floor(Math.abs(ms) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const txt = `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    return neg ? `-${txt}` : txt;
  }
  // Relogio vivo: atualiza os segundos sem redesenhar a tela.
  setInterval(() => {
    document.querySelectorAll("[data-contagem]").forEach((el) => {
      el.textContent = contagem(Number(el.dataset.contagem) - Date.now());
    });
    document.querySelectorAll("[data-desde]").forEach((el) => {
      el.textContent = `+${contagem(Date.now() - Number(el.dataset.desde))}`;
    });
  }, 1000);

  // O que falta hoje para uma equipe (mesmas regras do "Faltam sair hoje":
  // prazo de hoje + atrasados de hoje; atrasados antigos ficam como nota).
  function contarEquipe(eq) {
    const hoje = diaSP(Date.now());
    const r = { falta: 0, partes: {}, antigos: 0, primeiroLimite: null, saiu: 0, carregando: false, saiuPor: {}, prontoPor: {} };
    // Pronto = ja impresso (ML) ou ja embalado no Tiny (Shopee/TikTok/Amazon).
    const marcarPronto = (nome) => (r.prontoPor[nome] = (r.prontoPor[nome] || 0) + 1);
    const canalShopee = (transp) => (categoriaShopee(transp) === "spx" ? "SPX" : "Shopee");
    const somarLimite = (ms) => {
      // So limites que ainda vao vencer (o que ja venceu aparece como atrasado).
      if (ms && ms > Date.now() && (!r.primeiroLimite || ms < r.primeiroLimite)) r.primeiroLimite = ms;
    };
    if (mlPrazos?.envios) {
      for (const e of mlPrazos.envios) {
        if (!eq.mlModalidades.includes(e.modalidade) || e.situacao === "proximos") continue;
        const doDia = e.prazo && diaSP(Date.parse(e.prazo)) === hoje;
        if (e.situacao === "atrasado" && !doDia) {
          r.antigos++;
          continue;
        }
        r.falta++;
        const nome = NOME_MOD[e.modalidade] || e.modalidade;
        r.partes[nome] = (r.partes[nome] || 0) + 1;
        if (e.situacao === "impresso") marcarPronto(nome);
        if (e.situacao !== "impresso") somarLimite(Date.parse(e.limiteImpressao || e.prazo));
      }
      for (const m of eq.mlModalidades) {
        const q = mlSaiuHoje?.porModalidade?.[m] || 0;
        r.saiu += q;
        r.saiuPor[NOME_MOD[m]] = (r.saiuPor[NOME_MOD[m]] || 0) + q;
      }
    } else r.carregando = true;
    if (eq.shopee) {
      if (prazos?.pedidos) {
        for (const p of prazos.pedidos) {
          if (!passaLoja(p.shopId)) continue;
          const dia = p.prazo ? diaSP(p.prazo) : null;
          if (p.situacao === "atrasado" && dia !== hoje) {
            r.antigos++;
            continue;
          }
          if (dia !== hoje && p.prazo && p.situacao !== "atrasado") continue;
          r.falta++;
          // SPX = Shopee Xpress (transportadora); o resto e "Shopee".
          const nome = canalShopee(p.transportadora);
          r.partes[nome] = (r.partes[nome] || 0) + 1;
          if (p.embaladoEm) marcarPronto(nome);
          somarLimite(p.prazo);
        }
        for (const s of prazos.saidosHoje || []) {
          if (!passaLoja(s.shopId)) continue;
          r.saiu++;
          const nome = canalShopee(s.transportadora);
          r.saiuPor[nome] = (r.saiuPor[nome] || 0) + 1;
        }
      } else if (estado?.contas?.length) r.carregando = true;
    }
    // TikTok / Amazon pela separacao do Tiny (19/11).
    if (eq.tiny && prazos?.tinyMkt) {
      const NOME_TINY = { tiktok: "TikTok", amazon: "Amazon" };
      for (const p of prazos.tinyMkt) {
        if (!eq.tiny.includes(p.canal)) continue;
        const nome = NOME_TINY[p.canal];
        if (p.saiu) {
          if (p.saiuEm && diaSP(p.saiuEm) === hoje) {
            r.saiu++;
            r.saiuPor[nome] = (r.saiuPor[nome] || 0) + 1;
          }
        } else {
          r.falta++;
          r.partes[nome] = (r.partes[nome] || 0) + 1;
          if (p.embaladoEm) marcarPronto(nome);
        }
      }
    }
    return r;
  }

  const hhmm = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  function htmlEquipes() {
    const agora = Date.now();
    const lista = verEquipe === "todas" ? EQUIPES : EQUIPES.filter((e) => e.id === verEquipe);
    const seletor = `<div class="pd-eq-sel">Minha equipe:
      ${[["todas", "Ambas"], ...EQUIPES.map((e) => [e.id, e.nome.replace("Equipe ", "")])]
        .map(([id, n]) => `<button type="button" class="${verEquipe === id ? "ativo" : ""}" data-pd-eq="${id}">${esc(n)}</button>`)
        .join("")}</div>`;
    const cards = lista
      .map((eq) => {
        const c = contarEquipe(eq);
        const cfg = cfgEquipe(eq.id);
        // Precisa: com ritmo manual = faltam x min; automatico = soma de cada
        // canal (faltam x ritmo medido do canal; sem medida, 2 min).
        // Ja prontos (impressos/embalados) nao entram no trabalho que falta.
        const prontos = Object.values(c.prontoPor).reduce((s, q) => s + q, 0);
        const minutos = cfg.minPorPacote
          ? Math.ceil((Math.max(0, c.falta - prontos) * cfg.minPorPacote) / cfg.pessoas)
          : Math.ceil(
              Object.entries(c.partes).reduce((s, [n, q]) => s + Math.max(0, q - (c.prontoPor[n] || 0)) * (minCanal(RITMO_DE[n], eq.id) || 2), 0) / cfg.pessoas
            );
        const medidoEq = Object.keys(c.partes).map((n) => minCanal(RITMO_DE[n], eq.id)).filter(Boolean);
        const restam = Math.max(0, c.falta - prontos);
        const minAuto = restam ? Math.round((minutos * cfg.pessoas * 10) / restam) / 10 : null;
        const termina = agora + minutos * 60e3;
        const total = c.falta + c.saiu;
        const pct = total ? Math.round((100 * c.saiu) / total) : 0;
        // Por plataforma: quanto falta e quanto ja saiu de cada uma.
        const canais = [...new Set([...eq.ordem, ...Object.keys(c.partes), ...Object.keys(c.saiuPor)])];
        const tabelaCanais = `<div class="pd-eq-canais">
          <span></span><span class="cab">Faltam</span><span class="cab" title="Impressos (ML) ou embalados no Tiny (Shopee/TikTok/Amazon), entre os que faltam">Prontos</span><span class="cab">Já saíram</span>
          ${canais
            .map((n) =>
              (n === "TikTok" || n === "Amazon") && !prazos?.tiny?.configurado
                ? `<span class="nome">${n}</span><span class="embreve">ligar o Tiny</span><span></span><span></span>`
                : `<span class="nome">${esc(n)}</span><span class="${c.partes[n] ? "" : "zero"}">${c.carregando ? "–" : c.partes[n] || 0}</span><span class="pronto ${c.prontoPor[n] ? "" : "zero"}">${c.prontoPor[n] || 0}</span><span class="ok ${c.saiuPor[n] ? "" : "zero"}">${c.saiuPor[n] || 0}</span>`
            )
            .join("")}
        </div>`;
        // ---- RELOGIO: quanto tempo a equipe TEM para finalizar tudo ----
        // Alvo = "Terminar ate" que o lider definiu; sem isso, o primeiro
        // limite que ainda vai vencer. Precisa = faltam x ritmo.
        // Prioridade: horario definido pelo lider > o que vencer primeiro entre
        // o limite da plataforma e o corte da proxima remessa (so equipes com
        // Shopee). Assim o relogio conversa com as remessas.
        const candidatos = [
          c.primeiroLimite && { ms: c.primeiroLimite, rot: "limite da plataforma" },
          proximoCorte(eq),
        ].filter(Boolean);
        const alvoInfo = cfg.meta
          ? { ms: metaHoje(cfg.meta), rot: "horário definido" }
          : candidatos.sort((a, b) => a.ms - b.ms)[0] || null;
        const alvo = alvoInfo?.ms || null;
        const tem = alvo ? alvo - agora : null;
        const precisa = minutos * 60e3;
        const folga = tem !== null ? tem - precisa : null;
        const st = !c.falta ? "fim" : tem === null ? "sem" : tem <= 0 ? "passou" : folga < 0 ? "estoura" : folga < 15 * 60e3 ? "apertado" : "ok";
        const COR_ST = { fim: "#16a34a", sem: eq.cor, passou: "#dc2626", estoura: "#dc2626", apertado: "#f59e0b", ok: "#16a34a" };
        const corSt = COR_ST[st];
        const fmtDur = (ms) => {
          const m = Math.max(0, Math.round(ms / 60e3));
          return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
        };
        const veredito = {
          fim: "🎉 Tudo finalizado por hoje",
          sem: `⏱ ${fmtDur(precisa)} de trabalho · pronto ~${hhmm(termina)}`,
          passou: "⏰ O horário-alvo já passou",
          estoura: `⚠ Faltam ${fmtDur(-folga)} — reforce a equipe`,
          apertado: `⚡ Apertado: sobra só ${fmtDur(folga)}`,
          ok: `✓ Dá tempo — sobra ${fmtDur(folga)}`,
        }[st];
        // Anel: quanto do tempo disponivel o trabalho vai consumir.
        const R = 84;
        const CIRC = 2 * Math.PI * R;
        const uso = st === "fim" ? 1 : tem > 0 ? Math.min(1, precisa / tem) : 1;
        const anel = `<svg class="eq-anel" viewBox="0 0 200 200" aria-hidden="true">
            <circle cx="100" cy="100" r="${R}" class="eq-anel-fundo"/>
            <circle cx="100" cy="100" r="${R}" class="eq-anel-arco" style="stroke:${corSt};stroke-dasharray:${(uso * CIRC).toFixed(1)} ${CIRC.toFixed(1)}"/>
          </svg>`;
        const centro =
          st === "fim"
            ? `<div class="eq-relogio-n">✓</div><div class="eq-relogio-rot">tudo pronto</div>`
            : alvo
              ? `<div class="eq-relogio-n" data-contagem="${alvo}">${contagem(alvo - agora)}</div><div class="eq-relogio-rot">para finalizar tudo<br>até <b>${hhmm(alvo)}</b><br>${esc(alvoInfo.rot)}</div>`
              : `<div class="eq-relogio-n">${fmtDur(precisa)}</div><div class="eq-relogio-rot">de trabalho<br>no ritmo atual</div>`;
        return `<div class="pd-eq eq-st-${st}" style="--eq:${eq.cor};--st:${corSt}">
          <div class="pd-eq-topo"><b>${esc(eq.nome)}</b><span>${esc(eq.canais)}</span></div>
          <div class="eq-heroi">
            <div class="eq-relogio">${anel}<div class="eq-relogio-centro">${c.carregando ? `<div class="eq-relogio-n">–</div>` : centro}</div></div>
            <div class="eq-heroi-dir">
              <div class="eq-veredito">${c.carregando ? "Carregando..." : esc(veredito)}</div>
              ${
                c.falta && !c.carregando
                  ? `<div class="eq-precisa">Precisa de <b>${fmtDur(precisa)}</b> no ritmo atual · fica pronto ~<b>${hhmm(termina)}</b></div>`
                  : ""
              }
              <div class="eq-mini">
                <div><span class="eq-mini-n">${c.carregando ? "–" : c.falta}</span><small>faltam</small></div>
                <div><span class="eq-mini-n ok">${c.saiu}</span><small>já saíram</small></div>
                <div><span class="eq-mini-n">${pct}%</span><small>do dia feito</small></div>
              </div>
              <div class="pd-acum-barra"><span style="width:${pct}%;background:var(--eq)"></span></div>
            </div>
          </div>
          ${tabelaCanais}
          ${catsDaEquipe(eq).length ? `<div class="eq-remessas"><div class="eq-sub">Remessas (por horário da venda)</div>${htmlRemessas(eq)}</div>` : ""}
          ${c.antigos ? `<div class="pd-eq-det">+${c.antigos} atrasado(s) de dias anteriores fora da conta</div>` : ""}
          ${c.primeiroLimite && c.falta && cfg.meta ? `<div class="pd-eq-det">Próximo limite da plataforma: <b>${hhmm(c.primeiroLimite)}</b></div>` : ""}
          <div class="pd-eq-cfg">
            <label>Terminar até <input type="time" value="${esc(cfg.meta || "")}" data-eq-cfg="${eq.id}" data-campo="meta" title="Vazio = usa o próximo limite da plataforma"></label>
            <label title="Vazio = automático: usa o ritmo medido de cada canal nos últimos 15 dias"><input type="number" min="0.2" step="0.1" value="${cfg.minPorPacote || ""}" placeholder="${minAuto || "auto"}" data-eq-cfg="${eq.id}" data-campo="minPorPacote"> min por pacote ${
              cfg.minPorPacote ? "(manual)" : medidoEq.length ? "(medido)" : "(padrão)"
            }</label>
            <label><input type="number" min="1" step="1" value="${cfg.pessoas}" data-eq-cfg="${eq.id}" data-campo="pessoas"> pessoa(s)</label>
          </div>
        </div>`;
      })
      .join("");
    return `<div class="pd-equipes">${seletor}<div class="pd-eq-grade ${lista.length === 1 ? "uma" : ""}">${cards}</div></div>`;
  }

  // =====================================================================
  // REMESSAS (pedido de 18/11): pacotes por remessa, pelo HORARIO DA VENDA.
  //   SPX (Entrega Rapida): ate 07:00 = 1a remessa; 07:00-11:00 = 2a.
  //   Shopee Xpress:        ate 07:00 = 1a remessa; 07:00-13:00 = 2a.
  // Venda depois do ultimo corte entra na 1a remessa do dia seguinte.
  // Horarios editaveis na tela (salvos no navegador).
  // =====================================================================
  // Nome da transportadora -> categoria. Os textos exatos da Shopee ainda nao
  // foram confirmados com loja real: a tela lista os nomes vistos.
  function categoriaShopee(transp) {
    const t = transp || "";
    if (/r[aá]pida|same.?day|instant|express\s*delivery/i.test(t)) return "spx";
    if (/xpress|spx/i.test(t)) return "xpress";
    return "outras";
  }
  const CATEGORIAS_REM = [
    { id: "spx", nome: "SPX Entrega Rápida", equipe: "bahia", cor: "#ee4d2d", cortes: ["07:00", "11:00"] },
    { id: "xpress", nome: "Shopee Xpress", equipe: "bahia", cor: "#2563eb", cortes: ["07:00", "13:00"] },
    // Flex (19/11): faltava na Bahia. Mesmas regras do ML; corte padrao 13h
    // (ultimo envio do Flex) - ajustavel na tela.
    { id: "flex", nome: "ML Flex", equipe: "bahia", cor: "#16a34a", cortes: ["07:00", "13:00"] },
    // ML (19/11): coleta e agencia, ate 7h = 1a remessa, 7h-13h = 2a.
    { id: "coleta", nome: "ML coleta", equipe: "mathias", cor: "#ca8a04", cortes: ["07:00", "13:00"] },
    { id: "agencia", nome: "ML agência", equipe: "mathias", cor: "#0891b2", cortes: ["07:00", "13:00"] },
  ];
  const catsDaEquipe = (eq) => CATEGORIAS_REM.filter((c) => c.equipe === eq.id);
  function cortesDe(cat) {
    try {
      const salvo = JSON.parse(lerPref(`cortes_${cat.id}`, "null"));
      if (Array.isArray(salvo) && salvo.length && salvo.every((h) => /^\d{2}:\d{2}$/.test(h))) return salvo;
    } catch {}
    return cat.cortes;
  }
  // Inicio do trabalho da 1a remessa (as seguintes comecam quando fecham).
  function inicioDe(cat) {
    const v = lerPref(`inicio_${cat.id}`, "09:00");
    return /^\d{2}:\d{2}$/.test(v) ? v : "09:00";
  }
  const minutosSP = (ms) => {
    const [h, m] = new Date(ms).toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false }).split(":").map(Number);
    return (h % 24) * 60 + m;
  };
  const minDe = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const somaDia = (dia, n) => diaSP(Date.parse(`${dia}T12:00:00-03:00`) + n * 864e5);
  // Venda -> { dia, n } (n = numero da remessa daquele dia).
  function remessaDe(vendaMs, cortes) {
    const dia = diaSP(vendaMs);
    const m = minutosSP(vendaMs);
    for (let i = 0; i < cortes.length; i++) if (m < minDe(cortes[i])) return { dia, n: i + 1 };
    return { dia: somaDia(dia, 1), n: 1 };
  }
  const nomeRem = (n) => `${n}ª remessa`;

  // Proximo corte de remessa ainda por vir hoje (para o relogio das equipes).
  function proximoCorte(eq) {
    const agora = Date.now();
    const hoje = diaSP(agora);
    let melhor = null;
    for (const cat of catsDaEquipe(eq)) {
      const cortes = cortesDe(cat);
      for (let k = 0; k < cortes.length; k++) {
        const ms = Date.parse(`${hoje}T${cortes[k]}:00-03:00`);
        if (ms > agora) {
          if (!melhor || ms < melhor.ms) melhor = { ms, rot: `fecha ${nomeRem(k + 1)} ${cat.nome}` };
          break;
        }
      }
    }
    return melhor;
  }

  // RELOGIO DA REMESSA (19/11): "SPX, voce tem X para finalizar".
  // Inicio: 1a remessa = "Inicio do trabalho" (09:00); as seguintes, quando
  // fecham (a lista so fica completa no corte). Prazo = inicio + pacotes x
  // ritmo. Terminar = todos impressos/embalados ou ja saidos. Passou do prazo:
  // 15 min para justificar; depois, atraso sem justificativa.
  const MOTIVOS = ["Falta de produto", "Separação", "Produto não encontrado", "Outro"];
  const fmtMin = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`);
  // Pedidos que faltam na remessa (numero + conta), aberto/fechado lembrado
  // entre as atualizacoes da tela.
  const pendAbertos = new Set();
  document.addEventListener(
    "toggle",
    (ev) => {
      const d = ev.target;
      if (!d.matches?.("[data-rm-pend]")) return;
      d.open ? pendAbertos.add(d.dataset.rmPend) : pendAbertos.delete(d.dataset.rmPend);
    },
    true
  );
  function listaPendentes(cat, k, x, ehML) {
    if (!x.pend.length) return "";
    const chave = `${cat.id}|${k + 1}`;
    const verbo = ehML ? "imprimir" : "embalar";
    return `<details class="rm-peds" data-rm-pend="${chave}" ${pendAbertos.has(chave) ? "open" : ""}>
      <summary>Ver os ${x.pend.length} pedido${x.pend.length === 1 ? "" : "s"} que falta${x.pend.length === 1 ? "" : "m"} ${verbo}</summary>
      <table><thead><tr><th>Pedido</th><th>Conta / loja</th><th>Produto</th></tr></thead><tbody>${x.pend
        .map(
          (d) => `<tr><td><span class="sp-sn">${esc(d.num)}</span><button type="button" class="pz-copiar" data-sp-copiar="${esc(d.num)}" title="Copiar">⧉</button></td><td>${esc(d.conta || "")}</td><td title="${esc(d.sku)}">${esc(d.prod || "")}</td></tr>`
        )
        .join("")}</tbody></table>
    </details>`;
  }

  function relogioRemessa(cat, k, x, cortes, ehML) {
    const { m, recorde } = ritmoDe(RITMO_CAT[cat.id], cat.equipe);
    if (!m || !x.total) return "";
    const agora = Date.now();
    const hoje = diaSP(agora);
    const ini = Date.parse(`${hoje}T${k === 0 ? inicioDe(cat) : cortes[k]}:00-03:00`);
    const prazo = ini + Math.ceil(x.total * m) * 60e3;
    const resta = x.falta - x.embalado;
    const o = ocorr[`${cat.id}|${k + 1}`];
    const verbo = ehML ? "imprimir" : "embalar";
    // Tempo por pacote e total da remessa (sempre visivel).
    const dataBR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");
    const info = `<div class="rm-tempo">⏱ <b>${String(m).replace(".", ",")} min</b> por pacote · remessa toda: <b>${fmtMin(
      Math.ceil(x.total * m)
    )}</b>${resta > 0 ? ` · faltam ~<b>${fmtMin(Math.ceil(resta * m))}</b>` : ""}${
      recorde ? ` <span class="rm-recorde" title="Melhor dia: ${recorde.pacotes} pacotes">🏆 meta do recorde de ${dataBR(recorde.dia)}</span>` : ""
    }</div>`;
    if (resta <= 0) {
      if (!o?.finalizadaEm && !finalizadasEnviadas.has(`${cat.id}|${k + 1}`)) {
        finalizadasEnviadas.add(`${cat.id}|${k + 1}`);
        api("/api/remessas/finalizar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dia: hoje, cat: cat.id, n: k + 1, prazo }),
        })
          .then(carregarOcorrencias)
          .catch(() => {});
      }
      const atr = o?.atrasoMin || 0;
      return `<div class="rm-relogio fim">✓ Finalizada${o?.finalizadaEm ? ` às ${hhmm(o.finalizadaEm)}` : ""}${
        atr ? ` · <b>${fmtMin(atr)} de atraso</b>${o?.motivo ? ` (${esc(o.motivo)})` : " sem justificativa"}` : " no prazo"
      }</div>`;
    }
    // Cronometro grande (pedido 19/11: "igual o relogio da equipe").
    const grande = (num, rot, attr = "") =>
      `<div class="rm-rel-grande"><span class="rm-rel-n" ${attr}>${num}</span><span class="rm-rel-rot">${rot}</span></div>`;
    if (agora < ini) {
      return `<div class="rm-relogio">${grande(
        hhmm(ini),
        `começa às ${hhmm(ini)}<br>tem até <b>${hhmm(prazo)}</b> · ${resta} para ${verbo}`
      )}${info}</div>`;
    }
    if (agora < prazo) {
      return `<div class="rm-relogio ok">${grande(
        contagem(prazo - agora),
        `para finalizar<br>até <b>${hhmm(prazo)}</b> · ${resta} para ${verbo}`,
        `data-contagem="${prazo}"`
      )}${info}</div>`;
    }
    const atraso = Math.floor((agora - prazo) / 60e3);
    const botoes = (rotulo) => `<div class="rm-just"><span>${rotulo}</span>${MOTIVOS.map(
      (mo) => `<button type="button" data-rm-just="${cat.id}|${k + 1}|${mo}" data-prazo="${prazo}">${mo}</button>`
    ).join("")}</div>`;
    if (o?.motivo) {
      return `<div class="rm-relogio just">${grande(
        `+${contagem(agora - prazo)}`,
        `de atraso · justificado: <b>${esc(o.motivo)}</b>${o.obs ? ` — ${esc(o.obs)}` : ""}${o.quem ? ` (${esc(o.quem)})` : ""}<br>${resta} para ${verbo}`,
        `data-desde="${prazo}"`
      )}${info}</div>`;
    }
    const limiteJust = prazo + 15 * 60e3;
    if (agora < limiteJust) {
      return `<div class="rm-relogio alerta">${grande(
        contagem(limiteJust - agora),
        `⏰ <b>Passou do tempo!</b> ${resta} ainda para ${verbo}<br>justifique ou revise (procurar o produto, separação...)`,
        `data-contagem="${limiteJust}"`
      )}${info}${botoes("O que aconteceu?")}</div>`;
    }
    void atraso;
    return `<div class="rm-relogio atraso">${grande(
      `+${contagem(agora - prazo)}`,
      `🔴 <b>atraso sem justificativa</b><br>${resta} para ${verbo}`,
      `data-desde="${prazo}"`
    )}${info}${botoes("Justificar agora:")}</div>`;
  }

  function renderRemessas() {
    corpo.innerHTML = EQUIPES.map(htmlRemessas).join("");
  }

  function htmlRemessas(eq) {
    const cats = catsDaEquipe(eq);
    const temShopee = cats.some((c) => c.id === "spx" || c.id === "xpress");
    const ML_CATS = ["coleta", "agencia", "flex"];
    const temML = cats.some((c) => ML_CATS.includes(c.id));
    if (temShopee && !prazos?.pedidos) return `<div class="shopee-vazio">Carregando pedidos da Shopee...</div>`;
    if (temML && !mlPrazos?.envios) return `<div class="shopee-vazio">Carregando envios do Mercado Livre...</div>`;
    const agora = Date.now();
    const hoje = diaSP(agora);
    const amanha = somaDia(hoje, 1);
    // { cat, venda (ms), saiu }
    const itens = [];
    const vistas = {};
    if (temShopee) {
      for (const p of prazos.pedidos.filter((x) => passaLoja(x.shopId))) {
        itens.push({
          cat: categoriaShopee(p.transportadora),
          venda: p.criadoEm || p.pagoEm,
          saiu: false,
          embalado: !!p.embaladoEm,
          det: { num: p.orderSn, conta: p.loja, prod: (p.itens || []).map((i) => `${i.qtd}× ${i.nome}`).join(" · "), sku: (p.itens || []).map((i) => i.sku).filter(Boolean).join(", ") },
        });
        vistas[p.transportadora || "(sem transportadora)"] = (vistas[p.transportadora || "(sem transportadora)"] || 0) + 1;
      }
      for (const s of (prazos.saidosHoje || []).filter((x) => passaLoja(x.shopId))) {
        itens.push({ cat: categoriaShopee(s.transportadora), venda: s.criadoEm, saiu: true });
        vistas[s.transportadora || "(sem transportadora)"] = (vistas[s.transportadora || "(sem transportadora)"] || 0) + 1;
      }
    }
    if (temML) {
      for (const e of mlPrazos.envios) {
        if (!ML_CATS.includes(e.modalidade)) continue;
        itens.push({
          cat: e.modalidade,
          venda: e.criadoEm ? Date.parse(e.criadoEm) : null,
          saiu: false,
          ml: true,
          situacao: e.situacao,
          prazo: e.prazo,
          embalado: e.situacao === "impresso",
          det: { num: e.venda, conta: e.conta, prod: (e.itens || []).map((i) => `${i.qtd}× ${i.titulo}`).join(" · "), sku: "" },
        });
      }
      for (const e of mlSaiuHoje?.envios || []) itens.push({ cat: e.modalidade, venda: e.vendaAprox, saiu: true, ml: true });
    }

    const tinyLigado = temShopee && !!prazos?.tiny?.configurado;
    const cards = cats.map((cat) => {
      const cortes = cortesDe(cat);
      const meus = itens.filter((i) => i.cat === cat.id);
      const rem = cortes.map(() => ({ total: 0, saiu: 0, falta: 0, embalado: 0, pend: [] }));
      let paraAmanha = 0;
      let anteriores = 0;
      let semHora = 0;
      let programados = 0;
      for (const i of meus) {
        // ML tem envio com DATA PROGRAMADA (19/11): vendido dias atras, coleta
        // marcada para hoje. Regra: o que tem envio para hoje e foi vendido
        // antes do 1o corte de hoje entra na 1a remessa, seja de que dia for.
        // Programado para outro dia fica fora; atrasado de dia anterior vira alerta.
        if (i.ml && !i.saiu) {
          if (i.situacao === "proximos") {
            programados++;
            continue;
          }
          if (i.situacao === "atrasado" && i.prazo && diaSP(Date.parse(i.prazo)) < hoje) {
            anteriores++;
            continue;
          }
        }
        if (!i.venda) {
          semHora++;
          continue;
        }
        let r = remessaDe(i.venda, cortes);
        if (i.ml && r.dia < hoje) r = { dia: hoje, n: 1 };
        if (r.dia === hoje) {
          const x = rem[r.n - 1];
          x.total++;
          i.saiu ? x.saiu++ : x.falta++;
          if (!i.saiu && i.embalado) x.embalado++;
          if (!i.saiu && !i.embalado && i.det) x.pend.push(i.det);
        } else if (r.dia === amanha) paraAmanha++;
        else if (r.dia < hoje && !i.saiu) anteriores++;
      }
      const agoraMin = minutosSP(agora);
      const linhas = rem
        .map((x, k) => {
          const ehML = ML_CATS.includes(cat.id);
          const ini = k === 0 ? (ehML ? null : `${cortes[cortes.length - 1]} de ontem`) : cortes[k - 1];
          const fim = cortes[k];
          const fecha = Date.parse(`${hoje}T${fim}:00-03:00`);
          const aberta = agoraMin < minDe(fim);
          const pct = x.total ? Math.round((100 * x.saiu) / x.total) : 0;
          const chip = aberta
            ? `<span class="rm-chip aberta">recebendo vendas · fecha às ${fim} (<span data-contagem="${fecha}">${contagem(fecha - agora)}</span>)</span>`
            : x.falta
              ? `<span class="rm-chip pend">fechada · ${x.falta} para despachar</span>`
              : x.total
                ? `<span class="rm-chip ok">fechada · tudo despachado ✓</span>`
                : `<span class="rm-chip">fechada</span>`;
          return `<div class="rm-linha">
            <div class="rm-nome"><b>${nomeRem(k + 1)}</b><small>${
              ini ? `vendas de ${ini} até ${fim}` : `vendas até ${fim} de hoje, inclui envios programados para hoje`
            }</small></div>
            <div class="rm-total"><span>${x.total}</span><small>pacotes</small></div>
            <div class="rm-num ok"><span>${x.saiu}</span><small>já saíram</small></div>
            <div class="rm-num"><span>${x.falta}</span><small>faltam</small></div>
            <div class="rm-st">${chip}${
              ehML && x.falta
                ? `<span class="rm-emb">🖨 ${x.embalado} de ${x.falta} já impressos</span>`
                : tinyLigado && x.falta
                  ? `<span class="rm-emb">📦 ${x.embalado} de ${x.falta} já embalados no Tiny</span>`
                  : ""
            }${relogioRemessa(cat, k, x, cortes, ehML)}${listaPendentes(cat, k, x, ehML)}<div class="pd-acum-barra"><span style="width:${pct}%;background:var(--rm)"></span></div></div>
          </div>`;
        })
        .join("");
      const totalDia = rem.reduce((s, x) => s + x.total, 0);
      return `<div class="rm-card" style="--rm:${cat.cor}">
        <div class="rm-topo"><b>${esc(cat.nome)}</b><span class="rm-totaldia">${totalDia} pacote${totalDia === 1 ? "" : "s"} hoje</span></div>
        ${linhas}
        <div class="rm-rodape">
          ${paraAmanha ? `<span>➜ <b>${paraAmanha}</b> vendido${paraAmanha === 1 ? "" : "s"} depois das ${cortes[cortes.length - 1]} — já ${paraAmanha === 1 ? "entra" : "entram"} na 1ª remessa de amanhã</span>` : ""}
          ${anteriores ? `<span class="rm-alerta">⚠ <b>${anteriores}</b> de remessas de dias anteriores ainda não ${anteriores === 1 ? "saiu" : "saíram"}</span>` : ""}
          ${semHora ? `<span>${semHora} sem horário de venda</span>` : ""}
          ${programados ? `<span>📅 ${programados} programado${programados === 1 ? "" : "s"} para os próximos dias (fora da conta de hoje)</span>` : ""}
        </div>
        <div class="pd-eq-cfg"><label>Início do trabalho <input type="time" value="${inicioDe(cat)}" data-rm-inicio="${cat.id}"></label> Cortes:
          ${cortes
            .map((h, k) => `<label>${nomeRem(k + 1)} até <input type="time" value="${h}" data-rm-corte="${cat.id}" data-k="${k}"></label>`)
            .join("")}
        </div>
      </div>`;
    }).join("");

    const outras = itens.filter((i) => i.cat === "outras").length;
    return `
      <div class="rm-grade">${cards}</div>
      <div class="muted small sp-eq-nota">
        Contado pelo <b>horário da venda</b>: "já saíram" = coletados/postados hoje; "faltam" = ainda não saíram.
        ${temShopee && outras ? `${outras} pacote(s) da Shopee de outras transportadoras ficam fora das remessas.` : ""}
        ${temShopee ? `<br>Transportadoras Shopee vistas: ${Object.entries(vistas).map(([n, q]) => `${esc(n)} (${q})`).join(" · ") || "nenhuma"}` : ""}
      </div>`;
  }

  // Editar cortes de uma categoria.
  document.addEventListener("change", (ev) => {
    const ini = ev.target.closest("[data-rm-inicio]");
    if (ini && /^\d{2}:\d{2}$/.test(ini.value)) {
      salvarPref(`inicio_${ini.dataset.rmInicio}`, ini.value);
      atualizarFaixas();
      return;
    }
    const i = ev.target.closest("[data-rm-corte]");
    if (!i || !/^\d{2}:\d{2}$/.test(i.value)) return;
    const cat = CATEGORIAS_REM.find((c) => c.id === i.dataset.rmCorte);
    const cortes = [...cortesDe(cat)];
    cortes[Number(i.dataset.k)] = i.value;
    cortes.sort();
    salvarPref(`cortes_${cat.id}`, JSON.stringify(cortes));
    atualizarFaixas();
  });

  function renderEquipes() {
    corpo.innerHTML = `
      <div class="sp-equipes" data-eq>${htmlEquipes()}</div>
      <div class="muted small sp-eq-nota">Pacotes que precisam sair hoje (Mercado Livre + Shopee), divididos pelas equipes do app de separação.
        O relógio conta o tempo até o horário "Terminar até" (vazio = próximo limite da plataforma). "Precisa" = pacotes que faltam × minutos por pacote ÷ pessoas — ajuste em cada equipe (fica salvo neste navegador).
        TikTok e Amazon vêm da separação do dia no Tiny (o que já foi enviado para separação).</div>`;
  }

  function htmlPacotesDia() {
    const ml = contarML();
    const sp = contarShopee();
    const total = (ml?.total || 0) + (sp?.total || 0);
    const pct = (n) => (total ? (100 * n) / total : 0);
    const juntar = (partes) => partes.filter(Boolean).join(" · ") || "nada para hoje";
    const detML = ml
      ? juntar([ml.imprimir && `${ml.imprimir} a imprimir`, ml.impressos && `${ml.impressos} impressos`, ml.atrasadosHoje && `${ml.atrasadosHoje} atrasados`])
      : "carregando...";
    const detSP = sp
      ? juntar([sp.organizar && `${sp.organizar} a organizar`, sp.aguardando && `${sp.aguardando} aguardando saída`, sp.atrasadosHoje && `${sp.atrasadosHoje} atrasados`])
      : estado && !estado.contas?.length
        ? "sem loja conectada"
        : "carregando...";
    const antigos = (ml?.antigos || 0) + (sp?.antigos || 0);
    // Acumulado: o que ja saiu hoje + o que ainda falta sair hoje.
    const saiuML = mlSaiuHoje ? mlSaiuHoje.total : null;
    const saiuSP = prazos?.saidosHoje ? prazos.saidosHoje.filter((s) => passaLoja(s.shopId)).length : null;
    const temSaiu = saiuML !== null || saiuSP !== null;
    const saiu = (saiuML || 0) + (saiuSP || 0);
    const acumulado = saiu + total;
    const pctSaiu = acumulado ? Math.round((100 * saiu) / acumulado) : 0;
    const dataHoje = new Date().toLocaleDateString("pt-BR", { timeZone: TZ, weekday: "long", day: "2-digit", month: "2-digit" });
    return `
      <div class="pd-total">
        <div class="pd-total-num">${ml || sp ? total : "–"}</div>
        <div class="pd-total-rot">Faltam sair hoje<b>${esc(dataHoje)}</b></div>
      </div>
      <div class="pd-acum" title="Acumulado do dia = pacotes que já saíram hoje + os que ainda faltam sair">
        <div class="pd-acum-topo"><span class="pd-acum-num">${temSaiu ? acumulado : "–"}</span><span class="pd-acum-rot">Total do dia<br>(acumulado)</span></div>
        <div class="pd-acum-barra"><span style="width:${pctSaiu}%"></span></div>
        <div class="pd-acum-det">${
          temSaiu ? `<b>${saiu}</b> já saíram (${pctSaiu}%) · ML ${saiuML ?? "–"} · Shopee ${saiuSP ?? "–"}` : "carregando..."
        }</div>
      </div>
      <div class="pd-dir">
        <div class="pd-barra" title="Mercado Livre x Shopee">
          <span style="width:${pct(ml?.total || 0)}%;background:#ffd400"></span><span style="width:${pct(sp?.total || 0)}%;background:var(--shopee-cor)"></span>
        </div>
        <div class="pd-mkts">
          <button type="button" class="pd-mkt" data-pd-ir="ml"><span class="pd-mkt-cor" style="background:#ffd400"></span><span class="pd-mkt-num">${ml ? ml.total : "–"}</span><span><span class="pd-mkt-nome">Mercado Livre</span> <span class="pd-mkt-det">${esc(detML)}</span></span></button>
          <button type="button" class="pd-mkt" data-pd-ir="shopee"><span class="pd-mkt-cor" style="background:var(--shopee-cor)"></span><span class="pd-mkt-num">${sp ? sp.total : "–"}</span><span><span class="pd-mkt-nome">Shopee</span> <span class="pd-mkt-det">${esc(detSP)}</span></span></button>
        </div>
        ${antigos ? `<div class="pd-nota">+ ${antigos} ${antigos === 1 ? "atrasado antigo" : "atrasados antigos"} (de dias anteriores) fora da soma</div>` : ""}
      </div>`;
  }

  function atualizarFaixas() {
    const html = htmlPacotesDia();
    document.querySelectorAll("[data-pd]").forEach((el) => (el.innerHTML = html));
    if (visivel && aba === "remessas") renderRemessas();
    if (document.querySelector("[data-eq]")) {
      const h = htmlEquipes();
      document.querySelectorAll("[data-eq]").forEach((el) => (el.innerHTML = h));
    }
  }

  // Equipes: escolher "minha equipe" e ajustar o ritmo (fica salvo neste navegador).
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-pd-eq]");
    if (!b) return;
    verEquipe = b.dataset.pdEq;
    salvarPref("verEquipe", verEquipe);
    atualizarFaixas();
  });
  document.addEventListener("change", (ev) => {
    const i = ev.target.closest("[data-eq-cfg]");
    if (!i) return;
    const cfg = cfgEquipe(i.dataset.eqCfg);
    if (i.dataset.campo === "meta") cfg.meta = i.value || "";
    else if (i.dataset.campo === "minPorPacote" && !String(i.value).trim()) cfg.minPorPacote = null;
    else {
      const v = Number(String(i.value).replace(",", "."));
      if (v > 0) cfg[i.dataset.campo] = v;
    }
    salvarPref(`equipe_${i.dataset.eqCfg}`, JSON.stringify(cfg));
    atualizarFaixas();
  });

  // Clicar no nome do marketplace abre o Prazos dele.
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-pd-ir]");
    if (!b) return;
    if (b.dataset.pdIr === "ml") document.querySelector('.module-nav-item[data-module="prazos"]')?.click();
    else irPara("prazos");
  });

  async function carregarOcorrencias() {
    try {
      const r = await api(`/api/remessas/ocorrencias?dia=${diaSP(Date.now())}`);
      ocorr = Object.fromEntries(r.ocorrencias.map((o) => [`${o.cat}|${o.n}`, o]));
    } catch {}
  }

  // Justificar atraso de uma remessa (mini painel de revisao).
  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-rm-just]");
    if (!b) return;
    const [cat, n, motivo] = b.dataset.rmJust.split("|");
    let obs = "";
    if (motivo === "Outro") {
      obs = prompt("O que aconteceu com esta remessa?") || "";
      if (!obs.trim()) return;
    }
    let quem = "";
    try {
      quem = localStorage.getItem("ml-painel-operator-name") || "";
    } catch {}
    b.disabled = true;
    try {
      await api("/api/remessas/justificar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dia: diaSP(Date.now()), cat, n: Number(n), motivo, obs, quem, prazo: Number(b.dataset.prazo) }),
      });
      await carregarOcorrencias();
      atualizarFaixas();
    } catch (err) {
      alert(`Não foi salvo: ${err.message}`);
      b.disabled = false;
    }
  });

  async function carregarPacotesDia() {
    const [ml, sp, mlSaiu] = await Promise.allSettled([
      api("/api/prazos"),
      estado?.contas?.length ? api("/api/shopee/prazos") : null,
      api("/api/pacotes-dia/ml-saiu-hoje"),
    ]);
    if (ml.status === "fulfilled") mlPrazos = ml.value;
    if (mlSaiu.status === "fulfilled") mlSaiuHoje = mlSaiu.value;
    await carregarOcorrencias();
    // Ritmo medido muda devagar: busca a cada 30 min.
    if (Date.now() - ritmoEm > 30 * 60e3) {
      ritmoEm = Date.now();
      api("/api/pacotes-dia/ritmo")
        .then((r) => {
          ritmo = r;
          atualizarFaixas();
        })
        .catch(() => {});
    }
    if (sp.status === "fulfilled" && sp.value) {
      prazos = sp.value;
      atualizarContas();
    }
    atualizarFaixas();
  }

  // Na tela de Prazos do ML a faixa aparece ao abrir e se atualiza a cada 60s.
  let mlVisivel = false;
  document.querySelectorAll(".module-nav-item:not([data-sp-extra])").forEach((btn) => {
    btn.addEventListener("click", () => {
      mlVisivel = btn.dataset.module === "prazos";
      faixaML?.classList.toggle("hidden", !mlVisivel);
      if (mlVisivel) {
        atualizarFaixas();
        (estado ? Promise.resolve() : carregarEstado()).then(carregarPacotesDia);
      }
    });
  });
  setInterval(() => {
    if (document.hidden) return;
    if (mlVisivel || (visivel && ["prazos", "equipes", "remessas"].includes(aba))) carregarPacotesDia();
  }, 60_000);

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
          <label class="small muted" style="display:block;margin-top:6px">Perfil do Chrome desta loja <input type="text" data-perfil="${esc(c.shopId)}" value="${esc(perfilDe(c.shopId))}" placeholder="ex.: Samuel" style="margin-left:4px;padding:2px 6px;border:1px solid var(--border);border-radius:6px;width:130px"></label>
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
      ${estado.configurado ? `
      <section class="sp-externo">
        <h3 class="shopee-titulo">Conectar loja de outra empresa (outro CNPJ)</h3>
        <p class="muted small" style="margin:0 0 10px;line-height:1.55">Mande este link para o responsável pela loja. Ele abre, entra com a <b>conta de vendedor da loja</b> (Central do Vendedor — não a da Open Platform) e confirma. A loja aparece aqui sozinha.</p>
        <div class="sp-externo-linha"><input id="sp-link-externo" class="sp-busca" readonly value="carregando..."><button type="button" class="btn btn-sm sp-btn-shopee" data-copiar="sp-link-externo">Copiar link</button></div>
        <details style="margin-top:10px"><summary class="muted small" style="cursor:pointer">Prefere usar o botão Authorize do console da Shopee?</summary>
          <p class="muted small" style="margin:8px 0;line-height:1.55">No console: App List › Painel Vesco › <b>Authorize</b>. No campo Redirect URL, cole o endereço abaixo e mande o link que o console gerar.</p>
          <div class="sp-externo-linha"><input id="sp-redirect-externo" class="sp-busca" readonly value=""><button type="button" class="btn btn-ghost btn-sm" data-copiar="sp-redirect-externo">Copiar</button></div>
        </details>
      </section>` : ""}
      <section id="shopee-sonda" class="shopee-sonda hidden">
        <div class="shopee-sonda-topo">
          <h3 class="shopee-titulo" style="margin:0">Resultado da sonda</h3>
          <button type="button" id="shopee-copiar" class="btn btn-ghost btn-sm">Copiar resultado</button>
        </div>
        <pre id="shopee-sonda-saida"></pre>
      </section>`;

    $("shopee-lojas").addEventListener("click", acaoLoja);
    if (estado.configurado) {
      api("/api/shopee/link-externo")
        .then((r) => {
          if ($("sp-link-externo")) $("sp-link-externo").value = r.link;
          if ($("sp-redirect-externo")) $("sp-redirect-externo").value = r.redirect;
        })
        .catch(() => {});
      corpo.querySelectorAll("[data-copiar]").forEach((b) =>
        b.addEventListener("click", async () => {
          const campo = $(b.dataset.copiar);
          try {
            await navigator.clipboard.writeText(campo.value);
          } catch {
            campo.select();
            document.execCommand("copy");
          }
          const antes = b.textContent;
          b.textContent = "Copiado ✓";
          setTimeout(() => (b.textContent = antes), 1500);
        })
      );
    }
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
    const naoLidas = chat ? chat.conversas.filter((c) => c.naoLidas > 0 && c.marca?.estado !== "resolvido").length : resumo?.chatNaoLidas || 0;
    const devAbertas = devs ? devs.devolucoes.filter((d) => d.aberta).length : resumo?.devolucoesAbertas || 0;
    const set = (id, n) => {
      const el = $(`sp-conta-${id}`);
      if (!el) return;
      el.textContent = n > 99 ? "99+" : String(n);
      el.classList.toggle("hidden", !n);
    };
    set("prazos", urg);
    set("chat", naoLidas);
    set("devolucoes", devAbertas);
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
    irPara("lojas");
  }
})();
