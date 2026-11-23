// Chamadas ao Mercado Livre usadas pelo Ranking de produtos.
//
// Proprio deste modulo (nao mexe em ml/api.js): so GETs na api.mercadolibre.com,
// com o User-Agent honesto do painel (termos do ML, clausula 12: nada de
// disfarce nem de contornar bloqueio — se vier 403 a gente aceita).

const { getValidAccessToken } = require("../ml/tokens");

const API = "https://api.mercadolibre.com";
const USER_AGENT = "ml-painel/1.0 (+https://painelmercadolivre.onrender.com)";

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, accessToken) {
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const res = await fetch(`${API}${path}`, {
      signal: AbortSignal.timeout(25_000),
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": USER_AGENT },
    });
    const texto = await res.text();
    let dados;
    try {
      dados = texto ? JSON.parse(texto) : {};
    } catch {
      dados = { raw: texto.slice(0, 300) };
    }
    if (res.status === 429 && tentativa < 3) {
      await espera(4000 * (tentativa + 1)); // limite de requisicoes: espera e tenta de novo
      continue;
    }
    if (!res.ok) {
      const err = new Error(`Mercado Livre API ${res.status} em ${path.split("?")[0]}`);
      err.status = res.status;
      err.body = dados;
      throw err;
    }
    return dados;
  }
}

// GET com o token da conta; se vier 401, renova e repete.
async function mlConta(contaId, path) {
  let token = await getValidAccessToken(contaId);
  try {
    return await get(path, token);
  } catch (err) {
    if (err?.status !== 401) throw err;
    token = await getValidAccessToken(contaId);
    return get(path, token);
  }
}

module.exports = { mlConta, espera };
