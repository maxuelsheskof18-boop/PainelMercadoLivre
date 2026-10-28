// Classificacao de zona de Sao Paulo para as rotas do Flex.
// Bairro conhecido manda; se o bairro nao estiver na tabela, o rumo a
// partir da Praca da Se decide. Fora da capital, cada cidade vira seu
// proprio grupo (ex: "Grande SP - Guarulhos"), porque juntar Guarulhos
// com a Zona Norte da capital produz rota ruim na pratica.

const CENTRO_SP = { lat: -23.5505, lng: -46.6333 };

function extrairCidade(region) {
  if (!region) return "";
  const semUf = region.replace(/\s*[\/-]\s*[A-Z]{2}\s*$/, "").trim();
  const partes = semUf.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  return partes.length > 1 ? partes[partes.length - 1] : partes[0] || "";
}

const BAIRRO_ZONA = {
  // Centro
  "se": "Centro", "republica": "Centro", "bela vista": "Centro", "liberdade": "Centro",
  "consolacao": "Centro", "santa cecilia": "Centro", "bom retiro": "Centro", "cambuci": "Centro",
  "centro": "Centro", "higienopolis": "Centro",
  // Norte
  "santana": "Norte", "tucuruvi": "Norte", "jacana": "Norte", "tremembe": "Norte",
  "vila guilherme": "Norte", "vila maria": "Norte", "casa verde": "Norte", "limao": "Norte",
  "freguesia do o": "Norte", "brasilandia": "Norte", "pirituba": "Norte", "jaragua": "Norte",
  "perus": "Norte", "anhanguera": "Norte", "cachoeirinha": "Norte", "mandaqui": "Norte",
  "imirim": "Norte", "vila medeiros": "Norte", "parada inglesa": "Norte", "carandiru": "Norte",
  "lauzane paulista": "Norte", "horto florestal": "Norte", "vila nova cachoeirinha": "Norte",
  // Leste
  "tatuape": "Leste", "penha": "Leste", "vila formosa": "Leste", "mooca": "Leste",
  "belem": "Leste", "agua rasa": "Leste", "carrao": "Leste", "vila carrao": "Leste",
  "aricanduva": "Leste", "vila matilde": "Leste", "itaquera": "Leste", "cidade lider": "Leste",
  "guaianases": "Leste", "lajeado": "Leste", "sao mateus": "Leste", "sao rafael": "Leste",
  "iguatemi": "Leste", "sapopemba": "Leste", "vila prudente": "Leste", "sao lucas": "Leste",
  "artur alvim": "Leste", "cangaiba": "Leste", "ermelino matarazzo": "Leste", "ponte rasa": "Leste",
  "sao miguel paulista": "Leste", "jardim helena": "Leste", "vila jacui": "Leste",
  "itaim paulista": "Leste", "vila curuca": "Leste", "cidade tiradentes": "Leste",
  "parque do carmo": "Leste", "jose bonifacio": "Leste", "vila esperanca": "Leste",
  // Sul
  "vila mariana": "Sul", "moema": "Sul", "saude": "Sul", "ipiranga": "Sul", "jabaquara": "Sul",
  "sacoma": "Sul", "cursino": "Sul", "santo amaro": "Sul", "campo belo": "Sul",
  "campo grande": "Sul", "campo limpo": "Sul", "capao redondo": "Sul", "jardim sao luis": "Sul",
  "jardim angela": "Sul", "grajau": "Sul", "parelheiros": "Sul", "marsilac": "Sul",
  "cidade dutra": "Sul", "socorro": "Sul", "pedreira": "Sul", "interlagos": "Sul",
  "cidade ademar": "Sul", "vila andrade": "Sul", "brooklin": "Sul", "vila olimpia": "Sul",
  "chacara santo antonio": "Sul", "veleiros": "Sul", "americanopolis": "Sul",
  "vila guarani": "Sul", "bosque da saude": "Sul", "jardim da saude": "Sul",
  // Oeste
  "pinheiros": "Oeste", "butanta": "Oeste", "lapa": "Oeste", "perdizes": "Oeste",
  "vila leopoldina": "Oeste", "jaguare": "Oeste", "rio pequeno": "Oeste",
  "raposo tavares": "Oeste", "vila sonia": "Oeste", "morumbi": "Oeste",
  "alto de pinheiros": "Oeste", "jardim paulista": "Oeste", "itaim bibi": "Oeste",
  "barra funda": "Oeste", "agua branca": "Oeste", "pompeia": "Oeste", "sumare": "Oeste",
  "vila romana": "Oeste", "jaguara": "Oeste", "vila jaguara": "Oeste", "city america": "Oeste",
};

const semAcento = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// O Centro nao vira "Zona Centro": o resto do codigo (cores, filtros) usa "Centro".
const nomeZona = (z) => (z === "Centro" ? "Centro" : "Zona " + z);

function classificarZona(reg) {
  const cidade = semAcento(reg.cidade || extrairCidade(reg.region));

  if (cidade && cidade !== "sao paulo") {
    return "Grande SP - " + (reg.cidade || extrairCidade(reg.region));
  }

  const bairro = semAcento(reg.bairro);
  if (bairro && BAIRRO_ZONA[bairro]) return nomeZona(BAIRRO_ZONA[bairro]);

  if (bairro) {
    for (const chave of Object.keys(BAIRRO_ZONA)) {
      if (bairro.includes(chave)) return nomeZona(BAIRRO_ZONA[chave]);
    }
  }

  if (reg.lat && reg.lng) {
    const dLat = reg.lat - CENTRO_SP.lat;
    const dLng = (reg.lng - CENTRO_SP.lng) * Math.cos((CENTRO_SP.lat * Math.PI) / 180);
    const dist = Math.hypot(dLat, dLng) * 111; // km aproximados
    if (dist < 3.5) return "Centro";
    let ang = (Math.atan2(dLng, dLat) * 180) / Math.PI; // 0 = norte, 90 = leste
    if (ang < 0) ang += 360;
    if (ang >= 315 || ang < 45) return "Zona Norte";
    if (ang < 135) return "Zona Leste";
    if (ang < 225) return "Zona Sul";
    return "Zona Oeste";
  }

  return "Sem zona";
}

module.exports = { classificarZona, extrairCidade, semAcento };
