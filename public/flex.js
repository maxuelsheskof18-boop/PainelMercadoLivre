/* =====================================================================
   MAPA + ROTAS
   Lê o resultado da coleta (/api/flex/estado), desenha os pedidos
   num mapa de SP com tiles do OpenStreetMap (sem biblioteca externa,
   porque o CSP do MV3 bloqueia script de CDN), agrupa por zona e monta
   as rotas de carro na ordem de visita.
   ===================================================================== */

const TILE = 256;

/*  Base do mapa: o tile.openstreetmap.org bloqueia requisição vinda de
    extensão (403, "not following the tile usage policy") e a CARTO passou a
    exigir chave (devolve o tile com marca d'água). O Esri serve sem chave.
    Se um provedor falhar, a página passa sozinha para o próximo e grava
    qual funcionou. */
const PROVEDORES = [
  {
    nome: "Esri",
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
    credito: "© Esri · OpenStreetMap contributors"
  },
  {
    nome: "OSM-DE",
    url: (z, x, y) => `https://tile.openstreetmap.de/${z}/${x}/${y}.png`,
    credito: "© OpenStreetMap contributors"
  },
  {
    nome: "OSM",
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    credito: "© OpenStreetMap contributors"
  }
];

let provedorAtual = Math.max(0, PROVEDORES.findIndex(p => p.nome === localStorage.getItem("flex_tiles")));
if (provedorAtual < 0) provedorAtual = 0;
let falhasTile = 0;

function trocarProvedor() {
  if (provedorAtual >= PROVEDORES.length - 1) {
    $("credito").textContent = "Mapa base indisponível — os pinos e as rotas continuam funcionando.";
    return;
  }
  provedorAtual++;
  falhasTile = 0;
  localStorage.setItem("flex_tiles", PROVEDORES[provedorAtual].nome);
  for (const [chave, img] of tilesCache) { img.remove(); tilesCache.delete(chave); }
  $("credito").textContent = PROVEDORES[provedorAtual].credito;
  render();
}
const CORES_FIXAS = {
  "Centro": "#6b7280",
  "Zona Norte": "#d97706",
  "Zona Leste": "#dc2626",
  "Zona Sul": "#2563eb",
  "Zona Oeste": "#16a34a",
  "Sem zona": "#9ca3af"
};
const PALETA = ["#7c3aed", "#0891b2", "#be185d", "#4d7c0f", "#b45309", "#1d4ed8", "#9333ea"];

const estado = {
  run: null,
  registros: [],
  paradas: [],
  zonasOcultas: new Set(),
  contasOcultas: new Set(),
  rotas: [],
  manual: { ativo: false, chaves: [] },
  partida: null,
  centro: { lat: -23.5505, lng: -46.6333 },
  zoom: 11,
  selecionada: null
};

const $ = id => document.getElementById(id);
const semAcento = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/* =====================================================================
   PROJEÇÃO (Web Mercator)
   ===================================================================== */
const escala = z => Math.pow(2, z) * TILE;
const lng2x = (lng, z) => (lng + 180) / 360 * escala(z);
const lat2y = (lat, z) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * escala(z);
};
const x2lng = (x, z) => x / escala(z) * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI - 2 * Math.PI * y / escala(z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/* =====================================================================
   DADOS
   ===================================================================== */
function corDaZona(zona) {
  if (CORES_FIXAS[zona]) return CORES_FIXAS[zona];
  const zonas = [...new Set(estado.paradas.map(p => p.zona))].filter(z => !CORES_FIXAS[z]).sort();
  const i = zonas.indexOf(zona);
  // Nome que nao vem das paradas (a rota "Zonas ligadas", por exemplo) daria
  // indice -1 e cor "undefined" — a linha some do mapa sem erro nenhum.
  return i < 0 ? "#111827" : PALETA[i % PALETA.length];
}

// agrupa pedidos do mesmo endereço numa única parada
function montarParadas(registros) {
  const mapa = new Map();
  for (const r of registros) {
    const chave = semAcento(r.rua) + "|" + (r.cep || "").replace(/\D/g, "");
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        chave,
        rua: r.rua,
        comp: r.comp,
        cep: r.cep,
        bairro: r.bairro || "",
        cidade: r.cidade || "",
        region: r.region,
        zona: r.zona || "Sem zona",
        lat: r.lat || null,
        lng: r.lng || null,
        geoFonte: r.geoFonte,
        geoErro: r.geoErro,
        aprox: !!r.aprox,
        pedidos: []
      });
    }
    const p = mapa.get(chave);
    p.pedidos.push(r);
    if (!p.lat && r.lat) { p.lat = r.lat; p.lng = r.lng; }
  }
  for (const p of mapa.values()) {
    p.valorTotal = p.pedidos.reduce((s, r) => s + (Number(r.valor) || 0), 0);
    p.valorMax = p.pedidos.reduce((s, r) => Math.max(s, Number(r.valor) || 0), 0);
    p.enderecoTexto = [p.rua, p.bairro, p.cidade || "São Paulo", p.cep].filter(Boolean).join(", ");
  }
  return [...mapa.values()];
}

/*  Filtro no nível do pedido: tipo de envio, status e valor.
    "Somente Flex" usa o rótulo da listagem e o bloco "Dados do envio"
    do detalhe — basta um dos dois dizer Flex. */
function filtrarRegistros() {
  const min = Number($("valor-min").value) || 0;
  const soFlex = $("so-flex").checked;
  const semCancelados = $("sem-cancelados").checked;
  return (estado.registros || []).filter(r =>
    !estado.contasOcultas.has(r.conta) &&
    (!soFlex || r.flex) &&
    (!semCancelados || !r.cancelado) &&
    (Number(r.valor) || 0) >= min
  );
}

function recalcular() {
  estado.paradas = montarParadas(filtrarRegistros());
  estado.rotas = [];
  desenharResumoFiltro();
  desenharZonas();
  desenharProblemas();
  desenharRotas();
  render();
}

function desenharResumoFiltro() {
  const total = (estado.registros || []).length;
  const passam = filtrarRegistros().length;
  const naoFlex = (estado.registros || []).filter(r => !r.flex).length;
  const cancelados = (estado.registros || []).filter(r => r.cancelado).length;
  $("resumo-filtro").textContent = total
    ? `${passam} de ${total} pedidos no mapa` +
      (naoFlex ? ` · ${naoFlex} fora do Flex` : "") +
      (cancelados ? ` · ${cancelados} cancelada(s)` : "")
    : "";
}

function paradasVisiveis() {
  return estado.paradas.filter(p => !estado.zonasOcultas.has(p.zona) && p.lat && p.lng);
}

/* =====================================================================
   MAPA
   ===================================================================== */
const tilesCache = new Map();

function render() {
  const wrap = $("mapa");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const z = estado.zoom;
  const cx = lng2x(estado.centro.lng, z), cy = lat2y(estado.centro.lat, z);
  const left = cx - w / 2, top = cy - h / 2;

  // --- tiles ---
  const usados = new Set();
  const n = Math.pow(2, z);
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      const chave = `${z}/${wx}/${ty}`;
      usados.add(chave);
      let img = tilesCache.get(chave);
      if (!img) {
        img = document.createElement("img");
        img.referrerPolicy = "no-referrer";
        img.alt = "";
        img.onerror = () => { if (++falhasTile > 3) trocarProvedor(); };
        img.src = PROVEDORES[provedorAtual].url(z, wx, ty);
        tilesCache.set(chave, img);
        $("tiles").appendChild(img);
      }
      img.style.left = (tx * TILE - left) + "px";
      img.style.top = (ty * TILE - top) + "px";
    }
  }
  for (const [chave, img] of tilesCache) {
    if (!usados.has(chave)) { img.remove(); tilesCache.delete(chave); }
  }

  const px = p => ({ x: lng2x(p.lng, z) - left, y: lat2y(p.lat, z) - top });

  // --- linhas das rotas ---
  const svg = $("linhas");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  const linhaManual = (() => {
    const pts = [];
    if (estado.partida) pts.push(px(estado.partida));
    for (const c of estado.manual.chaves) {
      const p = estado.paradas.find(x => x.chave === c);
      if (p && p.lat) pts.push(px(p));
    }
    if (pts.length < 2) return "";
    const d = pts.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="#111827" stroke-width="3"
             stroke-dasharray="7 5" stroke-linejoin="round"/>`;
  })();

  svg.innerHTML = linhaManual + estado.rotas.map(rota => {
    const pts = [];
    if (estado.partida) pts.push(px(estado.partida));
    rota.paradas.forEach(p => pts.push(px(p)));
    if (pts.length < 2) return "";
    const d = pts.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${corDaZona(rota.zona)}" stroke-width="3"
             stroke-opacity=".65" stroke-linejoin="round"/>`;
  }).join("");

  // --- pinos ---
  const ordem = new Map();
  estado.rotas.forEach(rota => rota.paradas.forEach((p, i) => ordem.set(p.chave, i + 1)));
  const manual = new Map();
  estado.manual.chaves.forEach((c, i) => manual.set(c, i + 1));

  const pins = paradasVisiveis().map(p => {
    const q = px(p);
    const num = manual.get(p.chave) || ordem.get(p.chave) || p.pedidos.length;
    const escolhido = manual.has(p.chave) ? " escolhido" : "";
    return `<div class="pin${p.aprox ? " aprox" : ""}${escolhido}" data-chave="${p.chave}"
            title="${p.aprox ? "Localização aproximada" : ""}"
            style="left:${q.x}px;top:${q.y}px;background:${corDaZona(p.zona)}"><b>${num}</b></div>`;
  });

  if (estado.partida) {
    const q = px(estado.partida);
    pins.push(`<div class="pin partida" style="left:${q.x}px;top:${q.y}px" title="Partida"><b>CD</b></div>`);
  }
  $("pins").innerHTML = pins.join("");
}

function enquadrar() {
  const pts = paradasVisiveis();
  if (estado.partida) pts.push(estado.partida);
  if (!pts.length) { render(); return; }

  const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  estado.centro = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };

  const w = $("mapa").clientWidth, h = $("mapa").clientHeight;
  let z = 17;
  while (z > 8) {
    const dx = Math.abs(lng2x(maxLng, z) - lng2x(minLng, z));
    const dy = Math.abs(lat2y(minLat, z) - lat2y(maxLat, z));
    if (dx < w - 80 && dy < h - 80) break;
    z--;
  }
  estado.zoom = z;
  render();
}

/* --- interação --- */
let arrastando = null;

$("mapa").addEventListener("pointerdown", e => {
  arrastando = { x: e.clientX, y: e.clientY, movido: false };
  $("mapa").classList.add("arrastando");
});

window.addEventListener("pointermove", e => {
  if (!arrastando) return;
  const dx = e.clientX - arrastando.x, dy = e.clientY - arrastando.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) arrastando.movido = true;
  arrastando.x = e.clientX;
  arrastando.y = e.clientY;

  const z = estado.zoom;
  const cx = lng2x(estado.centro.lng, z) - dx;
  const cy = lat2y(estado.centro.lat, z) - dy;
  estado.centro = { lat: y2lat(cy, z), lng: x2lng(cx, z) };
  render();
});

window.addEventListener("pointerup", () => {
  $("mapa").classList.remove("arrastando");
  arrastando = null;
});

$("mapa").addEventListener("wheel", e => {
  e.preventDefault();
  const passo = e.deltaY < 0 ? 1 : -1;
  const z2 = Math.max(8, Math.min(18, estado.zoom + passo));
  if (z2 === estado.zoom) return;

  const r = $("mapa").getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const z = estado.zoom;
  const left = lng2x(estado.centro.lng, z) - r.width / 2;
  const top = lat2y(estado.centro.lat, z) - r.height / 2;
  const alvo = { lat: y2lat(top + my, z), lng: x2lng(left + mx, z) };

  // mantém o ponto sob o cursor fixo
  const left2 = lng2x(alvo.lng, z2) - mx;
  const top2 = lat2y(alvo.lat, z2) - my;
  estado.zoom = z2;
  estado.centro = {
    lat: y2lat(top2 + r.height / 2, z2),
    lng: x2lng(left2 + r.width / 2, z2)
  };
  render();
}, { passive: false });

$("pins").addEventListener("click", e => {
  const pin = e.target.closest(".pin");
  if (!pin || !pin.dataset.chave) return;

  // No modo manual o clique entra/sai da rota em vez de abrir a ficha —
  // a ordem dos cliques e a ordem de visita.
  if (estado.manual.ativo) {
    const chave = pin.dataset.chave;
    const i = estado.manual.chaves.indexOf(chave);
    if (i >= 0) estado.manual.chaves.splice(i, 1);
    else estado.manual.chaves.push(chave);
    desenharManual();
    render();
    return;
  }
  abrirPopup(estado.paradas.find(p => p.chave === pin.dataset.chave));
});

$("btn-mais").onclick = () => { estado.zoom = Math.min(18, estado.zoom + 1); render(); };
$("btn-menos").onclick = () => { estado.zoom = Math.max(8, estado.zoom - 1); render(); };
$("btn-fit").onclick = enquadrar;

/* =====================================================================
   POPUP
   ===================================================================== */
function abrirPopup(p) {
  if (!p) return;
  const pedidos = p.pedidos.map(r => `
    <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #e5e7eb">
      <b>#${r.pedido}</b> ${r.valor ? "— R$ " + r.valor.toFixed(2) : ""}<br>
      ${escapar(r.quem || r.nome)} ${r.telefone ? "· " + formatarTel(r.telefone) : "· sem telefone"}<br>
      <span style="color:#6b7280">${escapar(r.itens.map(i => i.qtd + "x " + i.titulo).join(" | "))}</span>
    </div>`).join("");

  const wa = p.pedidos.find(r => r.whatsapp)?.whatsapp;
  $("popup").innerHTML = `
    <button class="fechar" id="popup-fechar">×</button>
    <h3>${escapar(p.rua)}</h3>
    <dl>
      <dt>Bairro</dt><dd>${escapar(p.bairro || "—")}</dd>
      <dt>Zona</dt><dd>${escapar(p.zona)}</dd>
      <dt>Envio</dt><dd>${escapar(p.pedidos[0].tipoEnvio || (p.pedidos[0].flex ? "Flex" : "—"))}</dd>
      <dt>CEP</dt><dd>${escapar(p.cep)}</dd>
      ${p.comp ? `<dt>Compl.</dt><dd>${escapar(p.comp)}</dd>` : ""}
    </dl>
    ${pedidos}
    <div class="acoes">
      <a class="botao-link" target="_blank" rel="noreferrer"
         href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.enderecoTexto)}&travelmode=driving">Rota até aqui</a>
      <a class="botao-link secundario" target="_blank" rel="noreferrer"
         href="https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes">Waze</a>
      ${wa ? `<a class="botao-link secundario" target="_blank" rel="noreferrer"
         href="https://wa.me/${wa}">WhatsApp</a>` : ""}
    </div>`;
  $("popup").hidden = false;
  $("popup-fechar").onclick = () => { $("popup").hidden = true; };
}

const escapar = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const formatarTel = t => t && t.length >= 10 ? `(${t.slice(0, 2)}) ${t.slice(2, -4)}-${t.slice(-4)}` : (t || "");

/* =====================================================================
   ROTAS
   ===================================================================== */
const R_TERRA = 6371;
function distKm(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_TERRA * Math.asin(Math.sqrt(x));
}

// vizinho mais próximo + 2-opt: ordem de visita curta sem depender de API paga
function ordenar(paradas, origem) {
  const restantes = [...paradas];
  const ordem = [];
  let atual = origem || restantes[0];

  while (restantes.length) {
    let melhor = 0;
    for (let i = 1; i < restantes.length; i++) {
      if (distKm(atual, restantes[i]) < distKm(atual, restantes[melhor])) melhor = i;
    }
    atual = restantes.splice(melhor, 1)[0];
    ordem.push(atual);
  }

  const custo = seq => {
    let t = 0;
    let ant = origem || seq[0];
    for (const p of seq) { t += distKm(ant, p); ant = p; }
    return t;
  };

  let melhorou = true, voltas = 0;
  while (melhorou && voltas++ < 40) {
    melhorou = false;
    for (let i = 0; i < ordem.length - 1; i++) {
      for (let j = i + 1; j < ordem.length; j++) {
        const nova = ordem.slice(0, i).concat(ordem.slice(i, j + 1).reverse(), ordem.slice(j + 1));
        if (custo(nova) < custo(ordem) - 0.0001) {
          ordem.splice(0, ordem.length, ...nova);
          melhorou = true;
        }
      }
    }
  }
  return ordem;
}

function gerarRotas() {
  const visiveis = paradasVisiveis();
  const porZona = new Map();

  if ($("juntar-zonas").checked) {
    // Zona vizinha no mesmo sentido vira a mesma rota: ordena tudo junto e
    // deixa a proximidade decidir os trechos, em vez da divisao por zona.
    porZona.set("Zonas ligadas", visiveis);
  } else {
    for (const p of visiveis) {
      if (!porZona.has(p.zona)) porZona.set(p.zona, []);
      porZona.get(p.zona).push(p);
    }
  }

  const maxParadas = Math.max(2, Math.min(23, Number($("max-paradas").value) || 9));
  estado.rotas = [];

  for (const [zona, paradas] of [...porZona].sort((a, b) => b[1].length - a[1].length)) {
    const ordenadas = ordenar(paradas, estado.partida);
    for (let i = 0; i < ordenadas.length; i += maxParadas) {
      const trecho = ordenadas.slice(i, i + maxParadas);
      const anterior = i > 0 ? ordenadas[i - 1] : null;
      estado.rotas.push({
        zona,
        nome: zona + (ordenadas.length > maxParadas ? ` — trecho ${Math.floor(i / maxParadas) + 1}` : ""),
        paradas: trecho,
        origem: i === 0 ? estado.partida : anterior,
        km: kmTotal(trecho, i === 0 ? estado.partida : anterior)
      });
    }
  }

  desenharRotas();
  render();
}

function kmTotal(paradas, origem) {
  let t = 0, ant = origem || paradas[0];
  for (const p of paradas) { t += distKm(ant, p); ant = p; }
  return t;
}

function linkGoogleDe(paradas, origemPonto) {
  const pontos = paradas.map(p => p.enderecoTexto);
  const origem = origemPonto
    ? origemPonto.enderecoTexto || `${origemPonto.lat},${origemPonto.lng}`
    : pontos.shift();
  const destino = pontos.pop();
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("travelmode", "driving");
  u.searchParams.set("origin", origem);
  u.searchParams.set("destination", destino || origem);
  if (pontos.length) u.searchParams.set("waypoints", pontos.join("|"));
  return u.toString();
}

function linkGoogle(rota) {
  return linkGoogleDe(rota.paradas, rota.origem);
}

/*  O Waze nao aceita varias paradas num link — so destino unico. Entao o
    botao da rota abre a PRIMEIRA parada, e cada parada da lista tem o seu
    proprio link para o motorista ir tocando conforme entrega. */
function linkWaze(parada) {
  return parada && parada.lat
    ? `https://waze.com/ul?ll=${parada.lat},${parada.lng}&navigate=yes`
    : "#";
}

/* ---------- rota manual: o proprio usuario clica a ordem ---------- */
function paradasManuais() {
  return estado.manual.chaves
    .map(c => estado.paradas.find(p => p.chave === c))
    .filter(Boolean);
}

function moverManual(i, passo) {
  const j = i + passo;
  if (j < 0 || j >= estado.manual.chaves.length) return;
  const c = estado.manual.chaves;
  [c[i], c[j]] = [c[j], c[i]];
  desenharManual();
  render();
}

function desenharManual() {
  const alvo = $("rota-manual");
  if (!estado.manual.ativo) {
    alvo.innerHTML = "";
    return;
  }

  const paradas = paradasManuais();
  if (!paradas.length) {
    alvo.innerHTML = `<p class="dica">Clique nos pinos do mapa na ordem em que vai entregar.
      Pode misturar zonas a vontade. Clicar de novo tira a parada da rota.</p>`;
    return;
  }

  const km = kmTotal(paradas, estado.partida);
  alvo.innerHTML = `
    <div class="manual">
      <header>Rota manual <span class="contagem">${paradas.length} paradas · ${km.toFixed(1)} km</span></header>
      <ol>
        ${paradas.map((p, i) => `
          <li>${escapar(p.rua)}
            <span>${escapar(p.bairro || "")} · ${escapar(p.zona)}
              ${p.pedidos[0].telefone ? " · " + formatarTel(p.pedidos[0].telefone) : ""}
              <button class="mini-btn" data-sobe="${i}" title="Subir">↑</button>
              <button class="mini-btn" data-desce="${i}" title="Descer">↓</button>
              <button class="mini-btn" data-tira="${i}" title="Tirar da rota">×</button>
              <a class="mini-btn" target="_blank" rel="noreferrer" href="${linkWaze(p)}">Waze</a>
            </span>
          </li>`).join("")}
      </ol>
      <div class="acoes">
        <a class="botao-link" target="_blank" rel="noreferrer"
           href="${escapar(linkGoogleDe(paradas, estado.partida))}">Abrir no Google Maps</a>
        <a class="botao-link waze" target="_blank" rel="noreferrer"
           href="${linkWaze(paradas[0])}">Waze (1ª parada)</a>
        <button id="btn-otimizar">Otimizar ordem</button>
        <button id="btn-limpar-manual">Limpar</button>
      </div>
    </div>`;

  alvo.querySelectorAll("[data-sobe]").forEach(b => (b.onclick = () => moverManual(+b.dataset.sobe, -1)));
  alvo.querySelectorAll("[data-desce]").forEach(b => (b.onclick = () => moverManual(+b.dataset.desce, 1)));
  alvo.querySelectorAll("[data-tira]").forEach(b => (b.onclick = () => {
    estado.manual.chaves.splice(+b.dataset.tira, 1);
    desenharManual();
    render();
  }));
  $("btn-otimizar").onclick = () => {
    estado.manual.chaves = ordenar(paradasManuais(), estado.partida).map(p => p.chave);
    desenharManual();
    render();
  };
  $("btn-limpar-manual").onclick = () => {
    estado.manual.chaves = [];
    desenharManual();
    render();
  };
}

function desenharRotas() {
  if (!estado.rotas.length) {
    $("rotas").innerHTML = `<p class="mini">Sem paradas localizadas para montar rota.</p>`;
    return;
  }

  $("rotas").innerHTML = estado.rotas.map((rota, idx) => `
    <div class="rota">
      <header>
        <span class="bolinha" style="background:${corDaZona(rota.zona)}"></span>
        ${escapar(rota.nome)}
        <span class="contagem">${rota.paradas.length} paradas · ${rota.km.toFixed(1)} km</span>
      </header>
      <ol>
        ${rota.paradas.map(p => `
          <li>${escapar(p.rua)}
            <span>${escapar(p.bairro || p.region || "")} · ${escapar(p.zona)}
            ${p.pedidos[0].telefone ? " · " + formatarTel(p.pedidos[0].telefone) : ""}
            <a class="mini-btn" target="_blank" rel="noreferrer" href="${linkWaze(p)}">Waze</a></span>
          </li>`).join("")}
      </ol>
      <div class="acoes">
        <a class="botao-link" target="_blank" rel="noreferrer" href="${escapar(linkGoogle(rota))}">Abrir no Google Maps</a>
        <a class="botao-link waze" target="_blank" rel="noreferrer" href="${linkWaze(rota.paradas[0])}">Waze (1ª parada)</a>
        <button class="btn-centrar" data-rota="${idx}">Ver no mapa</button>
      </div>
    </div>`).join("");

  $("rotas").querySelectorAll(".btn-centrar").forEach(b => {
    b.onclick = () => {
      const rota = estado.rotas[Number(b.dataset.rota)];
      const lats = rota.paradas.map(p => p.lat), lngs = rota.paradas.map(p => p.lng);
      estado.centro = {
        lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        lng: (Math.min(...lngs) + Math.max(...lngs)) / 2
      };
      estado.zoom = 13;
      render();
    };
  });
}

/* =====================================================================
   PAINEL
   ===================================================================== */
function desenharZonas() {
  const cont = new Map();
  for (const p of estado.paradas) {
    const atual = cont.get(p.zona) || { paradas: 0, pedidos: 0, semGeo: 0 };
    atual.paradas++;
    atual.pedidos += p.pedidos.length;
    if (!p.lat) atual.semGeo++;
    cont.set(p.zona, atual);
  }

  $("zonas-filtro").innerHTML = [...cont].sort((a, b) => b[1].pedidos - a[1].pedidos).map(([zona, c]) => `
    <label class="zona-item">
      <input type="checkbox" data-zona="${escapar(zona)}" ${estado.zonasOcultas.has(zona) ? "" : "checked"}>
      <span class="bolinha" style="background:${corDaZona(zona)}"></span>
      ${escapar(zona)}
      <span class="contagem">${c.pedidos} ped.${c.semGeo ? " · " + c.semGeo + " s/ local" : ""}</span>
    </label>`).join("");

  $("zonas-filtro").querySelectorAll("input").forEach(chk => {
    chk.onchange = () => {
      if (chk.checked) estado.zonasOcultas.delete(chk.dataset.zona);
      else estado.zonasOcultas.add(chk.dataset.zona);
      estado.rotas = [];
      desenharRotas();
      render();
    };
  });
}

function desenharProblemas() {
  const semGeo = estado.paradas.filter(p => !p.lat);
  const falhas = estado.run?.falhas || [];
  const partes = [];

  if (semGeo.length) {
    partes.push(`<div class="aviso"><b>${semGeo.length} endereço(s) sem localização</b>
      ${semGeo.map(p => escapar(p.rua + " — CEP " + p.cep)).join("<br>")}</div>`);
  }
  const aprox = estado.paradas.filter(p => p.lat && p.aprox);
  if (aprox.length) {
    partes.push(`<div class="aviso"><b>${aprox.length} pino(s) em local aproximado</b>
      Não foi possível achar o número exato; o pino caiu no bairro ou no centro da cidade.<br>
      ${aprox.map(p => escapar(p.rua + " — " + (p.bairro || p.cep))).join("<br>")}</div>`);
  }
  if (falhas.length) {
    partes.push(`<div class="aviso"><b>${falhas.length} pedido(s) não lido(s)</b>
      ${falhas.map(f => escapar("#" + f.pedido + " — " + f.erro)).join("<br>")}</div>`);
  }
  $("problemas").innerHTML = partes.join("") || `<p class="mini">Nada pendente.</p>`;
}

function desenharStatus() {
  const run = estado.run;
  const el = $("status");
  el.className = "status" + (run?.estado === "erro" ? " erro" : run?.estado === "pronto" ? " ok" : "");
  el.textContent = run?.mensagem || "Clique em “Puxar pedidos das contas”.";

  $("btn-rodar").disabled = run?.estado === "coletando" || run?.estado === "geocodificando";

  $("contas-resumo").innerHTML = (run?.contas || []).map(c =>
    `${escapar(c.nickname)} — ${c.erro ? "erro: " + escapar(c.erro)
      : `${c.pedidos} pedidos (${c.flex} Flex)` +
        (c.truncado ? ` <b>— só os ${c.pedidos} mais recentes de ${c.truncado}</b>` : "")}`
  ).join("<br>");
}

/* lista das contas conectadas, com liga/desliga por conta */
async function desenharContas() {
  const contas = await (await fetch("/api/accounts")).json();
  if (!contas.length) {
    $("contas").innerHTML = `<p class="vazio">Nenhuma conta conectada ainda.</p>`;
    return;
  }
  const porConta = {};
  for (const r of estado.registros || []) porConta[r.conta] = (porConta[r.conta] || 0) + 1;

  $("contas").innerHTML = contas.map(c => `
    <label class="conta-item">
      <input type="checkbox" data-conta="${escapar(c.nickname)}" ${estado.contasOcultas.has(c.nickname) ? "" : "checked"}>
      ${escapar(c.nickname)}
      <span class="contagem">${porConta[c.nickname] || 0} ped.</span>
    </label>`).join("");

  $("contas").querySelectorAll("input").forEach(chk => {
    chk.onchange = () => {
      if (chk.checked) estado.contasOcultas.delete(chk.dataset.conta);
      else estado.contasOcultas.add(chk.dataset.conta);
      recalcular();
    };
  });
}

/* =====================================================================
   EXPORTAR
   ===================================================================== */
const CABECALHO = ["endereco", "titulo", "nome_lalamove", "telefone", "complemento_lalamove",
  "complemento", "produto_completo", "ordem", "nome", "username", "pedido", "nome_loja",
  "frete", "cep", "quem_recebe", "whatsapp", "zona", "rota", "ordem_na_rota"];

function baixarCSV() {
  const posicao = new Map();
  estado.rotas.forEach(rota => rota.paradas.forEach((p, i) =>
    posicao.set(p.chave, { rota: rota.nome, ordem: i + 1 })));

  const linhas = [];
  const visiveis = new Set(paradasVisiveis().map(p => p.chave));

  for (const p of estado.paradas) {
    if (!visiveis.has(p.chave) && estado.rotas.length) continue;
    const pos = posicao.get(p.chave);
    for (const r of p.pedidos) {
      linhas.push([
        r.enderecoCompleto,
        `${r.user} - #${r.pedido}`,
        `${r.nome} - ${r.user}`,
        r.telefone,
        `${r.comp || ""}|#${r.pedido}|${r.prodLala}${r.nome_loja}`,
        r.comp || "",
        r.prodComp,
        pos?.ordem || "1",
        r.nome,
        r.user,
        "#" + r.pedido,
        r.nome_loja,
        "0.00",
        "'" + (r.cep || "").replace(/\D/g, ""),
        r.quem,
        r.whatsapp,
        p.zona,
        pos?.rota || "",
        pos?.ordem || ""
      ]);
    }
  }

  const csv = [CABECALHO, ...linhas]
    .map(l => l.map(v => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(","))
    .join("\n");

  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }));
  a.download = `${linhas.length}_FLEX_${new Date().toLocaleDateString("pt-BR").replace(/\//g, "-")}.csv`;
  a.click();
}

/* =====================================================================
   PARTIDA (ponto de saída do CD)
   ===================================================================== */
async function definirPartida() {
  const texto = $("partida").value.trim();
  if (!texto) {
    estado.partida = null;
    await fetch("/api/flex/config", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partida: null }) });
    $("partida-info").textContent = "Sem partida definida — a rota começa na parada mais próxima.";
    estado.rotas = [];
    desenharRotas();
    render();
    return;
  }

  $("partida-info").textContent = "Localizando...";
  const resp = await (await fetch("/api/flex/geocodificar?q=" + encodeURIComponent(texto))).json();
  if (!resp?.ok || !resp.ponto) {
    $("partida-info").textContent = "Não foi possível localizar esse endereço.";
    return;
  }

  estado.partida = { ...resp.ponto, enderecoTexto: texto, chave: "__partida__" };
  await fetch("/api/flex/config", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partida: estado.partida }) });
  $("partida-info").textContent = `Partida: ${texto}`;
  estado.rotas = [];
  desenharRotas();
  render();
}

/* =====================================================================
   CICLO DE VIDA
   ===================================================================== */
function aplicarRun(run) {
  estado.run = run;
  estado.registros = run?.registros || [];
  estado.paradas = montarParadas(filtrarRegistros());
  desenharStatus();
  desenharResumoFiltro();
  desenharZonas();
  desenharProblemas();
  if (!estado.rotas.length) desenharRotas();
  render();
}

async function iniciar() {
  $("credito").textContent = PROVEDORES[provedorAtual].credito;

  const cfg = await (await fetch("/api/flex/config")).json();
  if (cfg.partida) {
    estado.partida = cfg.partida;
    $("partida").value = cfg.partida.enderecoTexto || "";
    $("partida-info").textContent = `Partida: ${cfg.partida.enderecoTexto || ""}`;
  }

  await atualizar(true);
  setInterval(() => {
    const rodando = estado.run?.estado === "coletando" || estado.run?.estado === "geocodificando";
    if (rodando) atualizar(false);
  }, 2000);
}

/*  Enquanto a coleta roda no servidor, a tela se atualiza sozinha a cada
    2 segundos; parada, não fica batendo à toa. */
async function atualizar(primeira) {
  const antes = estado.paradas.filter(p => p.lat).length;
  const run = await (await fetch("/api/flex/estado")).json();
  aplicarRun(run);
  await desenharContas();
  const agora = estado.paradas.filter(p => p.lat).length;
  if ((primeira && agora) || (!antes && agora)) enquadrar();
}

$("btn-rodar").onclick = async () => {
  estado.rotas = [];
  $("btn-rodar").disabled = true;
  await fetch("/api/flex/coletar", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  setTimeout(() => atualizar(false), 600);
};
$("btn-rotas").onclick = gerarRotas;
$("juntar-zonas").onchange = () => { if (estado.rotas.length) gerarRotas(); };
$("btn-manual").onclick = () => {
  estado.manual.ativo = !estado.manual.ativo;
  $("btn-manual").textContent = estado.manual.ativo ? "Sair do modo manual" : "Montar rota manual";
  $("btn-manual").classList.toggle("primario", estado.manual.ativo);
  $("mapa").classList.toggle("escolhendo", estado.manual.ativo);
  desenharManual();
  render();
};
$("btn-csv").onclick = baixarCSV;
$("btn-json").onclick = async () => {
  await navigator.clipboard.writeText(JSON.stringify(estado.run?.registros || [], null, 2));
  $("btn-json").textContent = "Copiado!";
  setTimeout(() => ($("btn-json").textContent = "Copiar JSON"), 1500);
};
$("btn-partida").onclick = definirPartida;
$("valor-min").onchange = recalcular;
$("so-flex").onchange = recalcular;
$("sem-cancelados").onchange = recalcular;
window.addEventListener("resize", render);

iniciar();
