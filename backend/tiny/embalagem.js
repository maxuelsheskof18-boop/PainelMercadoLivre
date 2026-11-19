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

const estado = {
  atualizadoEm: null,
  rodando: false,
  embalados: new Map(), // numeroPedidoEcommerce -> { conta, dataCheckout, vistoEm, numero }
  contas: {}, // nome -> { ok, erro, total, paginas, chamadas, pausadoAte }
};

function contas() {
  const out = [];
  for (let i = 1; i <= 5; i++) {
    const token = (process.env[`TINY_CONTA_${i}_TOKEN`] || "").trim();
    if (token) out.push({ nome: process.env[`TINY_CONTA_${i}_NOME`] || `Conta ${i}`, token });
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
      .then(async () => {
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

async function coletarConta(c) {
  const info = estado.contas[c.nome] || {};
  if (info.pausadoAte && info.pausadoAte > Date.now()) return; // respeita o limite
  const desde = dataBR(Date.now() - 2 * 864e5);
  let chamadas = 0;
  let total = 0;
  const novos = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const r = await chamar(c.token, "separacao.pesquisa.php", { situacao: "3", dataInicial: desde, pagina: String(pagina) });
    chamadas++;
    if (r.status !== "OK") {
      const msg = textoErros(r);
      if (/n[aã]o retornou registros/i.test(msg)) break; // nenhuma embalada
      if (/bloquead|excedid|limite/i.test(msg)) {
        estado.contas[c.nome] = { ...info, ok: false, erro: `limite da API do Tiny — pausado 15 min (${msg})`, pausadoAte: Date.now() + PAUSA_LIMITE_MS, chamadas };
        return;
      }
      throw new Error(msg || `status ${r.status}`);
    }
    for (const x of r.separacoes || []) {
      const s = x.separacao || x;
      const num = String(s.numeroPedidoEcommerce || "").trim();
      if (!num || String(s.situacao) !== "3") continue;
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

module.exports = { iniciar, coletar, embalado, resumo, configurado };
