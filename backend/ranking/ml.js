// Chamadas ao Mercado Livre usadas pelo Ranking de produtos.
//
// CUIDADO COM A CONTA (pedido do usuario, 24/11: nada que faca o ML derrubar a
// conta). Por isso este modulo e conservador de proposito:
//  - so GETs de leitura em api.mercadolibre.com (os mesmos tipos de chamada
//    que o painel ja faz: /orders/search, /users/{id}/items/search);
//  - User-Agent honesto do painel (termos do ML, clausula 12: nada de
//    disfarce nem de contornar bloqueio);
//  - RITMO: no maximo 1 chamada a cada 1,2 s (~50/min) e teto de 1500 por hora,
//    somando todas as contas — o historico de um ano leva horas, e tudo bem;
//  - PARA no primeiro sinal: 429 (limite de requisicoes) pausa tudo por 30 min;
//    403/bloqueio de politica pausa por 60 min. Nunca insiste nem tenta de
//    novo na hora;
//  - sem retentativa automatica, sem paralelismo.
//
// "API" aqui = o APP do painel registrado no Mercado Livre (o mesmo token OAuth
// das contas conectadas, as mesmas permissoes que o painel ja usa para
// /orders/search): tudo o que o ML libera para o app, e nada alem — sem
// raspar pagina, sem navegador automatico, sem disfarce (decisao do usuario,
// 24/11). Se o app nao tiver permissao para algo, o ML responde 403 e a gente
// so mostra "indisponivel".
// Interruptor: RANKING_ML=off desliga so a parte do ML (padrao: ligado).
// Outras variaveis (opcionais): RANKING_ML_ESPACO_MS, RANKING_ML_MAX_HORA.

const { getValidAccessToken } = require("../ml/tokens");

const API = "https://api.mercadolibre.com";
const USER_AGENT = "ml-painel/1.0 (+https://painelmercadolivre.onrender.com)";

const ESPACO_MS = Number(process.env.RANKING_ML_ESPACO_MS ?? 1200);
const MAX_POR_HORA = Number(process.env.RANKING_ML_MAX_HORA ?? 1500);
const PAUSA_429_MS = 30 * 60 * 1000;
const PAUSA_403_MS = 60 * 60 * 1000;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let pausadoAte = 0;
let motivoPausa = "";
let ultimaChamada = 0;
let fila = Promise.resolve();
const chamadasNaHora = []; // epoch ms das chamadas da ultima hora

const desligado = () => process.env.RANKING_ML === "off";
function pausado() {
  return desligado() || pausadoAte > Date.now();
}
function estadoPausa() {
  return { pausado: pausado(), ate: pausadoAte || null, motivo: desligado() ? "desligado (RANKING_ML=off)" : motivoPausa };
}
function pausar(ms, motivo) {
  pausadoAte = Date.now() + ms;
  motivoPausa = motivo;
  console.warn(`[ranking-ml] pausado por ${Math.round(ms / 60000)} min: ${motivo}`);
}

// Uma chamada por vez, com intervalo minimo entre elas.
function vez() {
  const minha = fila.then(async () => {
    const falta = ultimaChamada + ESPACO_MS - Date.now();
    if (falta > 0) await espera(falta);
    ultimaChamada = Date.now();
  });
  fila = minha.catch(() => {});
  return minha;
}

function erroPausa(msg) {
  const err = new Error(msg);
  err.pausa = true;
  return err;
}

async function get(path, accessToken) {
  if (pausado()) throw erroPausa(`Mercado Livre em pausa de seguranca (${desligado() ? "desligado" : motivoPausa})`);
  const corte = Date.now() - 3600e3;
  while (chamadasNaHora.length && chamadasNaHora[0] < corte) chamadasNaHora.shift();
  if (chamadasNaHora.length >= MAX_POR_HORA) {
    pausar(chamadasNaHora[0] + 3600e3 - Date.now() + 1000, `teto de ${MAX_POR_HORA} chamadas por hora atingido`);
    throw erroPausa("teto de chamadas por hora atingido");
  }
  await vez();
  if (pausado()) throw erroPausa("Mercado Livre em pausa de seguranca");
  chamadasNaHora.push(Date.now());

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
  if (!res.ok) {
    const err = new Error(`Mercado Livre API ${res.status} em ${path.split("?")[0]}`);
    err.status = res.status;
    err.body = dados;
    if (res.status === 429) pausar(PAUSA_429_MS, "limite de requisicoes (429)");
    else if (res.status === 403) pausar(PAUSA_403_MS, "acesso recusado (403)");
    throw err;
  }
  return dados;
}

// GET com o token da conta; se vier 401 (token vencido), renova e repete UMA vez.
async function mlConta(contaId, path) {
  // Desligado/em pausa: nem renova token (isso tambem seria uma chamada ao ML).
  if (pausado()) throw erroPausa(`Mercado Livre em pausa de seguranca (${desligado() ? "desligado" : motivoPausa})`);
  let token = await getValidAccessToken(contaId);
  try {
    return await get(path, token);
  } catch (err) {
    if (err?.status !== 401) throw err;
    token = await getValidAccessToken(contaId);
    return get(path, token);
  }
}

module.exports = { mlConta, espera, pausado, estadoPausa };
