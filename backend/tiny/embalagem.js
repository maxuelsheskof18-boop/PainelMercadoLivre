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
      // Forma de envio (Shopee Envios, TikTok Shipping...): ritmo por canal.
      .then(() => db.query("ALTER TABLE tiny_embalados ADD COLUMN IF NOT EXISTS forma TEXT"))
      // hora_real = visto na hora em que foi embalado (ciclo rapido); falso para o
      // que veio de varredura/primeira leitura (rajada sem hora de verdade).
      .then(() => db.query("ALTER TABLE tiny_embalados ADD COLUMN IF NOT EXISTS hora_real BOOLEAN DEFAULT true"))
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

// A busca por data do Tiny (dataInicial) filtra pela data de EMISSAO DA NOTA, nao
// pela data da embalagem, e vem em ordem de id (a mais antiga primeiro). Em
// 23/11 o painel olhava so "ontem": de 278 pacotes embalados hoje na conta
// Comercio, so ~30 apareciam (os demais tinham nota de 2 a 11 dias atras:
// envios programados, pedidos que esperaram). Janela por emissao ->
// embalados de hoje: 0d=18, 1d=30, 3d=169, 4d=233, 9d=273, 11d=277.
// Por isso, alem da leitura do dia: embalados dos ultimos 3 dias a cada ciclo
// (~6 paginas) e uma varredura de 12 dias a cada 30 min (~20 paginas).
const JANELA_RAPIDA_DIAS = 3;
const JANELA_COMPLETA_DIAS = 12;
const VARREDURA_COMPLETA_MS = 30 * 60 * 1000;
const varreduraCompletaEm = new Map(); // conta -> ms

// Le as paginas de separacao.pesquisa. Devolve { pausou } (limite da API).
async function lerPaginas(c, params, maxPaginas, aoItem, contagem) {
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const r = await chamar(c.token, "separacao.pesquisa.php", { ...params, pagina: String(pagina) });
    contagem.chamadas++;
    if (r.status !== "OK") {
      const msg = textoErros(r);
      if (/n[aã]o retornou registros/i.test(msg)) return { pausou: false }; // nenhuma separacao
      if (/bloquead|excedid|limite/i.test(msg)) {
        estado.contas[c.nome] = {
          ...(estado.contas[c.nome] || {}),
          ok: false,
          erro: `limite da API do Tiny — pausado 15 min (${msg})`,
          pausadoAte: Date.now() + PAUSA_LIMITE_MS,
          chamadas: contagem.chamadas,
        };
        return { pausou: true };
      }
      throw new Error(msg || `status ${r.status}`);
    }
    for (const x of r.separacoes || []) await aoItem(x.separacao || x);
    if (pagina >= Number(r.numero_paginas || 1)) break;
  }
  return { pausou: false };
}

async function coletarConta(c) {
  const info = estado.contas[c.nome] || {};
  if (info.pausadoAte && info.pausadoAte > Date.now()) return; // respeita o limite
  const vistosMkt = new Set();
  const vistos3 = new Set(); // separacoes embaladas (situacao 3) vistas neste ciclo
  const contagem = { chamadas: 0 };
  const novos = [];
  const completo = Date.now() - (varreduraCompletaEm.get(c.nome) || 0) > VARREDURA_COMPLETA_MS;
  // Hora de verdade so no ciclo rapido, depois do 1o ciclo da conta: a primeira
  // leitura e a varredura trazem centenas de uma vez (sem hora, e estragariam o ritmo).
  const horaReal = !completo && !!estado.contas[c.nome]?.atualizadoEm;

  // Embalado = situacao 3 (todas as que vi tem dataCheckout e embalador).
  const registrarEmbalado = async (s, num) => {
    vistos3.add(num);
    if (estado.embalados.has(num)) return;
    // Embalado em OUTRO dia (ex.: primeira leitura): sem hora, meio-dia
    // daquela data, para nao parecer que foi embalado agora.
    const [d, m, a] = String(s.dataCheckout || "").split("/");
    const outroDia = s.dataCheckout && s.dataCheckout !== dataBR(Date.now());
    const vistoEm = outroDia && a ? Date.parse(`${a}-${m}-${d}T12:00:00-03:00`) : Date.now();
    const forma = s.idFormaEnvio && s.idFormaEnvio !== "0" ? await nomeForma(c, s) : null;
    const e = { conta: c.nome, numero: s.numero, dataCheckout: s.dataCheckout || null, vistoEm, semHora: !!outroDia, forma, horaReal: horaReal && !outroDia };
    estado.embalados.set(num, e);
    novos.push([num, e]);
  };

  // 1) Separacao do dia (e de ontem), TODAS as situacoes: TikTok/Amazon + embalados recentes.
  let r1 = await lerPaginas(c, { dataInicial: dataBR(Date.now() - 864e5) }, MAX_PAGINAS, async (s) => {
    const num = String(s.numeroPedidoEcommerce || "").trim();
    if (!num) return;
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
    if (String(s.situacao) === "3") await registrarEmbalado(s, num);
  }, contagem);
  if (r1.pausou) return;

  // 2) Embalados com nota mais antiga (janela de 3 dias a cada ciclo; 12 dias a cada 30 min).
  const r2 = await lerPaginas(
    c,
    { situacao: "3", dataInicial: dataBR(Date.now() - (completo ? JANELA_COMPLETA_DIAS : JANELA_RAPIDA_DIAS) * 864e5) },
    completo ? 50 : 12,
    async (s) => {
      const num = String(s.numeroPedidoEcommerce || "").trim();
      if (num && String(s.situacao) === "3") await registrarEmbalado(s, num);
    },
    contagem
  );
  if (r2.pausou) return;
  if (completo) varreduraCompletaEm.set(c.nome, Date.now());

  for (const [num, e] of novos) {
    await db
      .query(
        `INSERT INTO tiny_embalados (numero_ecommerce, conta, numero, data_checkout, visto_em, forma, hora_real)
         VALUES ($1,$2,$3,$4,to_timestamp($5 / 1000.0),$6,$7) ON CONFLICT (numero_ecommerce) DO NOTHING`,
        [num, e.conta, e.numero, e.dataCheckout, e.vistoEm, e.forma, e.horaReal]
      )
      .catch(() => {});
  }
  // Esquece TikTok/Amazon desta conta que sairam da janela da consulta.
  for (const [num, p] of estado.mkt) if (p.conta === c.nome && !vistosMkt.has(num)) estado.mkt.delete(num);
  estado.contas[c.nome] = { ok: true, erro: null, total: vistos3.size, chamadas: contagem.chamadas, atualizadoEm: Date.now(), completoEm: varreduraCompletaEm.get(c.nome) || null };
}

// HISTORICO DE 15 DIAS (ideia do usuario, 19/11): o Tiny nao da a hora da
// embalagem, entao o ritmo de cada dia = (das 9h ate o fim da operacao) /
// pacotes embalados naquele dia. Aqui so juntamos QUANTOS foram embalados por
// dia e forma de envio; a conta fica na rota /api/pacotes-dia/ritmo.
// Roda 1x por dia (~20 chamadas nas 3 contas), guardado em tiny_embalados_dia.
let historicoFeitoEm = null; // "AAAA-MM-DD" do ultimo historico
async function historico15() {
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  if (historicoFeitoEm === hoje) return;
  await db.query(
    `CREATE TABLE IF NOT EXISTS tiny_embalados_dia (
       dia DATE NOT NULL,
       forma TEXT NOT NULL,
       qtd INT NOT NULL,
       PRIMARY KEY (dia, forma)
     )`
  );
  // Ja feito hoje (ex.: Render reiniciou)? Nao repete.
  const { rows: marca } = await db.query("SELECT 1 FROM tiny_embalados_dia WHERE dia = $1::date AND forma = '__historico__' LIMIT 1", [hoje]);
  if (marca.length) {
    historicoFeitoEm = hoje;
    return;
  }
  const contagem = new Map(); // "AAAA-MM-DD|forma" -> qtd
  for (const c of contas()) {
    const info = estado.contas[c.nome] || {};
    if (info.pausadoAte && info.pausadoAte > Date.now()) return; // tenta mais tarde
    for (let pagina = 1; pagina <= 40; pagina++) {
      const r = await chamar(c.token, "separacao.pesquisa.php", {
        situacao: "3",
        dataInicial: dataBR(Date.now() - 15 * 864e5),
        pagina: String(pagina),
      });
      if (r.status !== "OK") {
        const msg = textoErros(r);
        if (/n[aã]o retornou registros/i.test(msg)) break;
        if (/bloquead|excedid|limite/i.test(msg)) return; // tenta no proximo ciclo
        throw new Error(msg);
      }
      for (const x of r.separacoes || []) {
        const s = x.separacao || x;
        const dia = isoDeBR(s.dataCheckout);
        if (!dia || dia >= hoje) continue; // so dias completos
        const forma = s.idFormaEnvio && s.idFormaEnvio !== "0" ? await nomeForma(c, s) : "";
        const k = `${dia}|${forma || "?"}`;
        contagem.set(k, (contagem.get(k) || 0) + 1);
      }
      if (pagina >= Number(r.numero_paginas || 1)) break;
    }
  }
  for (const [k, qtd] of contagem) {
    const [dia, forma] = k.split("|");
    await db.query(
      "INSERT INTO tiny_embalados_dia (dia, forma, qtd) VALUES ($1,$2,$3) ON CONFLICT (dia, forma) DO UPDATE SET qtd = EXCLUDED.qtd",
      [dia, forma, qtd]
    );
  }
  await db.query("INSERT INTO tiny_embalados_dia (dia, forma, qtd) VALUES ($1, '__historico__', 0) ON CONFLICT DO NOTHING", [hoje]);
  await db.query("DELETE FROM tiny_embalados_dia WHERE dia < now() - interval '40 days'");
  historicoFeitoEm = hoje;
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
    await historico15().catch((err) => console.error("[tiny-historico]", err.message));
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

function embaladosHoje(conta) {
  const hoje = dataBR(Date.now());
  let n = 0;
  for (const e of estado.embalados.values()) if (e.conta === conta && e.dataCheckout === hoje) n++;
  return n;
}

function resumo() {
  return {
    configurado: configurado(),
    atualizadoEm: estado.atualizadoEm,
    contas: Object.fromEntries(
      Object.entries(estado.contas).map(([n, i]) => [
        n,
        { ok: i.ok, erro: i.erro, total: i.total, chamadas: i.chamadas, embaladosHoje: embaladosHoje(n) },
      ])
    ),
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
