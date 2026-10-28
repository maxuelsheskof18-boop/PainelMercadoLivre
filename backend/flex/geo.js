// Coordenada de cada endereco de entrega, na seguinte ordem:
//   1. a que o proprio envio do Mercado Livre ja traz (exata e de graca);
//   2. o endereco completo no Nominatim (acerta rua e numero, 1 req/s);
//   3. o Photon, quando o Nominatim recusa ou nao acha;
//   4. o CEP — que so da o CENTRO DA CIDADE, nao a rua: toda consulta de
//      CEP da capital volta no mesmo ponto (-23.5475,-46.63611). Por isso
//      essa opcao e a ultima e fica marcada como aproximada.
// O cache fica em flex_geocache: endereco repetido nao consulta de novo.

const db = require("../db");

let ultimoNominatim = 0;
let nominatimBloqueado = false;

const so = (s) => (s == null ? "" : String(s)).replace(/\D/g, "");

async function lerCache(chave) {
  const { rows } = await db.query("SELECT dados FROM flex_geocache WHERE chave = $1", [chave]);
  return rows[0]?.dados || null;
}

async function gravarCache(chave, dados) {
  await db.query(
    `INSERT INTO flex_geocache (chave, dados) VALUES ($1, $2)
     ON CONFLICT (chave) DO UPDATE SET dados = EXCLUDED.dados`,
    [chave, dados]
  );
}

async function geocodificar({ rua, bairro, cidade, uf, cep }) {
  const chave = ("v1:" + [rua, bairro, cidade, so(cep)].join("|")).toLowerCase();
  const emCache = await lerCache(chave);
  if (emCache) return emCache;

  const tentativas = [
    { texto: [rua, bairro, cidade, uf || "SP", "Brasil"].filter(Boolean).join(", "), fonte: "rua" },
    { texto: [rua, cidade, uf || "SP", "Brasil"].filter(Boolean).join(", "), fonte: "rua-sem-bairro" },
    { texto: [bairro, cidade, uf || "SP", "Brasil"].filter(Boolean).join(", "), fonte: "bairro", aprox: true },
  ];

  for (const t of tentativas) {
    if (!t.texto || t.texto.split(",").length < 3) continue;
    const ponto = await buscar(t.texto);
    if (ponto) {
      const res = { ...ponto, geoFonte: t.fonte, aprox: !!t.aprox };
      await gravarCache(chave, res);
      return res;
    }
  }

  const info = await consultarCep(so(cep));
  if (info.lat) {
    const res = { lat: info.lat, lng: info.lng, geoFonte: "centro-da-cidade", aprox: true };
    await gravarCache(chave, res);
    return res;
  }
  return null;
}

async function buscar(texto) {
  if (!texto) return null;

  if (!nominatimBloqueado) {
    // O servico gratuito pede no maximo 1 consulta por segundo.
    const espera = 1100 - (Date.now() - ultimoNominatim);
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultimoNominatim = Date.now();
    try {
      const u =
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=" +
        encodeURIComponent(texto);
      const r = await fetch(u, {
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/json", "User-Agent": "ml-painel-flex/1.0" },
      });
      if (r.status === 403 || r.status === 429) {
        nominatimBloqueado = true;
        console.warn(`[flex] Nominatim recusou (${r.status}); seguindo pelo Photon.`);
      } else if (r.ok) {
        const j = await r.json();
        if (j.length) return { lat: Number(j[0].lat), lng: Number(j[0].lon) };
        return null; // respondeu e nao achou: o Photon dificilmente acha
      }
    } catch {
      nominatimBloqueado = true;
    }
  }

  try {
    const u =
      "https://photon.komoot.io/api/?limit=1&lat=-23.55&lon=-46.63&q=" + encodeURIComponent(texto);
    const r = await fetch(u, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const c = j.features?.[0]?.geometry?.coordinates;
    return c ? { lat: Number(c[1]), lng: Number(c[0]) } : null;
  } catch {
    return null;
  }
}

// CEP define bairro/cidade com seguranca (serve para a zona); a coordenada
// que vem junto e so o centro do municipio.
async function consultarCep(cepDigits) {
  if (!cepDigits || cepDigits.length !== 8) return {};
  const chave = "cep:" + cepDigits;
  const emCache = await lerCache(chave);
  if (emCache) return emCache;

  let info = {};
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cepDigits}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const j = await r.json();
      const co = j.location?.coordinates || {};
      info = {
        bairro: j.neighborhood || "",
        cidade: j.city || "",
        uf: j.state || "",
        lat: co.latitude ? Number(co.latitude) : null,
        lng: co.longitude ? Number(co.longitude) : null,
      };
    }
  } catch {
    /* tenta o ViaCEP */
  }

  if (!info.cidade) {
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cepDigits}/json/`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        const j = await r.json();
        if (!j.erro) info = { bairro: j.bairro || "", cidade: j.localidade || "", uf: j.uf || "" };
      }
    } catch {
      /* segue sem bairro */
    }
  }

  await gravarCache(chave, info);
  return info;
}

module.exports = { geocodificar, buscar, consultarCep };
