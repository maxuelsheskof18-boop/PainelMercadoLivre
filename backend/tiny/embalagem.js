// Tiny -> "embalado" (no lugar do "impresso", que a API da Shopee nao da).
//
// A equipe embala pelo checkout de embalagem do Tiny. A API v2 tem isso:
// separacao.pesquisa.php com situacao=3 (embalada) traz dataCheckout (so a
// DATA) e numeroPedidoEcommerce (= order_sn da Shopee / pack do ML). Visto em
// 19/11/2026 nas 3 contas, so leitura.
// A hora da embalagem nao vem: guardamos a primeira vez que o painel viu a
// separacao embalada (precisao = intervalo do ciclo).
//
// LIMITE DE CHAMADAS (pedido do usuario): o token do Tiny e dividido com a
// bipagem/romaneio, a extensao de separacao e a recompra. Por isso:
//   - no maximo 1 chamada a cada 2,5 s por conta, uma conta de cada vez;
//   - ciclo a cada 5 min, so das 06:00 as 21:00 (horario de SP);
//   - "API Bloqueada"/"Excedido" -> para a conta no ciclo e espera 15 min;
//   - le so situacao=3 e so separacoes criadas de anteontem para ca.
// ~4-8 chamadas por conta a cada 5 min = menos de 2 por minuto (plano mais
// baixo do Tiny permite 30/min).
//
// Configuracao no Render (mesmos nomes do bipagem-romaneio):
//   TINY_CONTA_1_NOME / TINY_CONTA_1_TOKEN  (ate _5)

const db = require("../db");

const INTERVALO_MS = 5 * 60 * 1000;
const ESPACO_MS = 2500;
const PAUSA_LIMITE_MS = 15 * 60 * 1000;
const MAX_PAGINAS = 15;

// TikTok e Amazon (19/11): as APIs deles nao liberaram, mas os pedidos estao
// no Tiny. Sugestao do usuario para economizar chamadas: ler SO a separacao do
// dia. A mesma consulta (separacao.pesquisa, todas as situacoes) ja traz:
//   - idFormaEnvio -> "TikTok Shipping" / "Amazon DBA" (nome via separacao.obter,
//     1 chamada por forma nova, guardado no banco);
//   - situacao 3 = embalada;
//   - situacaoVenda (codigos do Tiny: 3 aprovado, 1 faturado, 7 pronto para
//     envio, 5 enviado, 6 entregue, 2 cancelado) -> 5/6 = ja saiu.
// Ou seja: embalados + TikTok/Amazon com 1 consulta por conta.
const SAIU = new Set(["5", "6"]);
const CANCELADO = "2";
const canalDaForma = (nome) => (/tik\s*tok/i.test(nome || "") ? "tiktok" : /amazon/i.test(nome || "") ? "amazon" : null);

const estado = {
  atualizadoEm: null,
  formas: new Map(), // "conta:idFormaEnvio" -> nome
  mkt: new Map(), // numeroPedidoEcommerce -> pedido TikTok/Amazon da separacao
  rodando: false,
  embalados: new Map(), // numeroPedidoEcommerce -> { conta, dataCheckout, vistoEm, numero }
  contas: {}, // nome -> { ok, erro, total, paginas, chamadas, pausadoAte }
};

function contas() {
  const out = [];
  for (let i = 1; i <= 5; i++) {
    let token = (process.env[`TINY_CONTA_${i}_TOKEN`] || "").trim();
    let nome = process.env[`TINY_CONTA_${i}_NOME`] || "";
    // Tambem aceita o formato criado no Render em 19/11:
    // TINY_CONTA_1_COMERCIO = <token>  (o nome da conta no lugar de TOKEN).
    if (!token) {
      const chave = Object.keys(process.env).find((k) => new RegExp(`^TINY_CONTA_${i}_(?!NOME$|TOKEN$)\\w+$`).test(k));
      if (chave) {
        token = (process.env[chave] || "").trim();
        const s = chave.replace(`TINY_CONTA_${i}_`, "").toLowerCase();
        nome = nome || s.charAt(0).toUpperCase() + s.slice(1);
      }
    }
    if (token) out.push({ nome: nome || `Conta ${i}`, token });
  }
  return out;
}
const configurado = () => contas().length > 0;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const ultimaChamada = new Map(); // token -> ms

async function chamar(token, metodo, params) {
  const falta = (ultimaChamada.get(token) || 0) + ESPACO_MS - Date.now();
  if (falta > 0) await espera(falta);
  ultimaChamada.set(token, Date.now());
  const corpo = new URLSearchParams({ token, formato: "json", ...params });
  const res = await fetch(`https://api.tiny.com.br/api2/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: corpo,
  });
  const json = await res.json().catch(() => ({}));
  return json.retorno || {};
}

const textoErros = (r) =>
  []
    .concat(r.erros || [])
    .map((e) => e?.erro || e)
    .join("; ");

function dataBR(ms) {
  return new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}
function horaSP(ms = Date.now()) {
  return Number(new Date(ms).toLocaleString("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }));
}

let tabela = null;
function garantirTabela() {
  if (!tabela) {
    tabela = db
      .query(
        `CREATE TABLE IF NOT EXISTS tiny_embalados (
           numero_ecommerce TEXT PRIMARY KEY,
           conta TEXT,
           numero TEXT,
           data_checkout TEXT,
           visto_em TIMESTAMPTZ NOT NULL
         )`
      )
      .then(() =>
        db.query(
          `CREATE TABLE IF NOT EXISTS tiny_formas_envio (
             chave TEXT PRIMARY KEY,
             nome TEXT
           )`
        )
      )
      .then(async () => {
        const { rows: formas } = await db.query("SELECT chave, nome FROM tiny_formas_envio");
        for (const f of formas) estado.formas.set(f.chave, f.nome);
        // Recarrega o que ja foi visto (a hora sobrevive ao Render dormir).
        await db.query("DELETE FROM tiny_embalados WHERE visto_em < now() - interval '10 days'");
        const { rows } = await db.query("SELECT * FROM tiny_embalados");
        for (const r of rows) {
          estado.embalados.set(r.numero_ecommerce, {
            conta: r.conta,
            numero: r.numero,
            dataCheckout: r.data_checkout,
            vistoEm: new Date(r.visto_em).getTime(),
            semHora: !!r.data_checkout && new Date(r.visto_em).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) !== r.data_checkout,
          });
        }
      })
      .catch((err) => {
        tabela = null;
        throw err;
      });
  }
  return tabela;
}

// Nome da forma de envio (cache; so chama o Tiny para forma nunca vista).
async function nomeForma(c, s) {
  const chave = `${c.nome}:${s.idFormaEnvio}`;
  if (estado.formas.has(chave)) return estado.formas.get(chave);
  const r = await chamar(c.token, "separacao.obter.php", { idSeparacao: s.id });
  const nome = r.separacao?.formaEnvio || "";
  estado.formas.set(chave, nome);
  await db.query("INSERT INTO tiny_formas_envio (chave, nome) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET nome = EXCLUDED.nome", [chave, nome]).catch(() => {});
  return nome;
}

const isoDeBR = (br) => {
  const [d, m, a] = String(br || "").split("/");
  return a ? `${a}-${m}-${d}` : null;
};

async function coletarConta(c) {
  const info = estado.contas[c.nome] || {};
  if (info.pausadoAte && info.pausadoAte > Date.now()) return; // respeita o limite
  // Separacao do dia (e de ontem, para o que sobrou), TODAS as situacoes.
  const desde = dataBR(Date.now() - 864e5);
  const vistosMkt = new Set();
  let chamadas = 0;
  let total = 0;
  const novos = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const r = await chamar(c.token, "separacao.pesquisa.php", { dataInicial: desde, pagina: String(pagina) });
    chamadas++;
    if (r.status !== "OK") {
      const msg = textoErros(r);
      if (/n[aã]o retornou registros/i.test(msg)) break; // nenhuma separacao
      if (/bloquead|excedid|limite/i.test(msg)) {
        estado.contas[c.nome] = { ...info, ok: false, erro: `limite da API do Tiny — pausado 15 min (${msg})`, pausadoAte: Date.now() + PAUSA_LIMITE_MS, chamadas };
        return;
      }
      throw new Error(msg || `status ${r.status}`);
    }
    for (const x of r.separacoes || []) {
      const s = x.separacao || x;
      const num = String(s.numeroPedidoEcommerce || "").trim();
      if (!num) continue;
      // TikTok / Amazon
      if (s.idFormaEnvio && s.idFormaEnvio !== "0") {
        const canal = canalDaForma(await nomeForma(c, s));
        if (canal && String(s.situacaoVenda) !== CANCELADO) {
          const antes = estado.mkt.get(num);
          const saiu = SAIU.has(String(s.situacaoVenda));
          // Hora de saida = quando o painel viu virar enviado. Se ja chegou
          // enviado na 1a leitura, so conta como "hoje" se a separacao e de hoje.
          let saiuEm = antes?.saiuEm || null;
          if (saiu && !saiuEm) saiuEm = antes ? Date.now() : s.dataCriacao === dataBR(Date.now()) ? Date.now() : -1;
          estado.mkt.set(num, {
            canal,
            conta: c.nome,
            numero: s.numero,
            numeroEcommerce: num,
            situacao: String(s.situacao),
            situacaoVenda: String(s.situacaoVenda),
            dataSeparacao: isoDeBR(s.dataCriacao),
            saiu,
            saiuEm: saiu ? saiuEm : null,
          });
          vistosMkt.add(num);
        }
      }
      if (String(s.situacao) !== "3") continue;
      total++;
      if (!estado.embalados.has(num)) {
        // Embalado em OUTRO dia (ex.: primeira leitura): sem hora, meio-dia
        // daquela data, para nao parecer que foi embalado agora.
        const [d, m, a] = String(s.dataCheckout || "").split("/");
        const outroDia = s.dataCheckout && s.dataCheckout !== dataBR(Date.now());
        const vistoEm = outroDia && a ? Date.parse(`${a}-${m}-${d}T12:00:00-03:00`) : Date.now();
        const e = { conta: c.nome, numero: s.numero, dataCheckout: s.dataCheckout || null, vistoEm, semHora: !!outroDia };
        estado.embalados.set(num, e);
        novos.push([num, e]);
      }
    }
    if (pagina >= Number(r.numero_paginas || 1)) break;
  }
  for (const [num, e] of novos) {
    await db
      .query(
        `INSERT INTO tiny_embalados (numero_ecommerce, conta, numero, data_checkout, visto_em)
         VALUES ($1,$2,$3,$4,to_timestamp($5 / 1000.0)) ON CONFLICT (numero_ecommerce) DO NOTHING`,
        [num, e.conta, e.numero, e.dataCheckout, e.vistoEm]
      )
      .catch(() => {});
  }
  // Esquece TikTok/Amazon desta conta que sairam da janela da consulta.
  for (const [num, p] of estado.mkt) if (p.conta === c.nome && !vistosMkt.has(num)) estado.mkt.delete(num);
  estado.contas[c.nome] = { ok: true, erro: null, total, chamadas, atualizadoEm: Date.now() };
}

async function coletar({ forcar = false } = {}) {
  if (estado.rodando || !configurado()) return;
  const h = horaSP();
  if (!forcar && (h < 6 || h >= 21)) return; // fora do horario de operacao
  estado.rodando = true;
  try {
    await garantirTabela();
    for (const c of contas()) {
      try {
        await coletarConta(c);
      } catch (err) {
        estado.contas[c.nome] = { ...(estado.contas[c.nome] || {}), ok: false, erro: err.message };
      }
    }
    estado.atualizadoEm = Date.now();
  } catch (err) {
    console.error("[tiny-embalagem]", err.message);
  } finally {
    estado.rodando = false;
  }
}

// Para a tela: numero do pedido no marketplace -> embalado?
function embalado(numeroEcommerce) {
  return estado.embalados.get(String(numeroEcommerce || "").trim()) || null;
}

function resumo() {
  return {
    configurado: configurado(),
    atualizadoEm: estado.atualizadoEm,
    contas: Object.fromEntries(Object.entries(estado.contas).map(([n, i]) => [n, { ok: i.ok, erro: i.erro, total: i.total, chamadas: i.chamadas }])),
  };
}

let timer = null;
function iniciar() {
  if (timer || !configurado()) return;
  setTimeout(() => coletar().catch(() => {}), 45_000);
  timer = setInterval(() => coletar().catch(() => {}), INTERVALO_MS);
}

// TikTok/Amazon da separacao (para Equipes). embaladoEm vem do mesmo ciclo.
function mkt() {
  return [...estado.mkt.values()].map((p) => ({
    ...p,
    saiuEm: p.saiuEm > 0 ? p.saiuEm : null,
    embaladoEm: estado.embalados.get(p.numeroEcommerce)?.vistoEm || null,
  }));
}

module.exports = { iniciar, coletar, embalado, mkt, resumo, configurado };
