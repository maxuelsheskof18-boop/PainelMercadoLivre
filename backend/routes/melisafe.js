// Melisafe — custos e lucro das vendas, pela API oficial.
//
// A extensao Melisafe mostra, na lista de vendas do Mercado Livre, o lucro de
// cada venda e o resumo do periodo. Antes ela abria paginas escondidas do
// site (detalhe da venda, busca de anuncios, Metricas) e lia o texto — os
// termos do ML proibem essa raspagem. Agora ela pergunta aqui, e o painel
// responde com a API oficial e os tokens das contas conectadas:
//
//   GET /api/melisafe/venda/:id            tarifa, frete, receita, SKUs, cancelada
//   GET /api/melisafe/metricas?periodo=..&conta=..   vendas brutas e quantidade
//
// A extensao se identifica pelo cabecalho x-melisafe-token (MELISAFE_TOKEN
// no .env). Toda rota tem try/catch proprio, no padrao de routes/questions.js.

const crypto = require("crypto");
const express = require("express");
const { listAccounts, getValidAccessToken } = require("../ml/tokens");
const { fetchResource } = require("../ml/api");

const router = express.Router();

function exigirToken(req, res, next) {
  const esperado = process.env.MELISAFE_TOKEN;
  if (!esperado) return res.status(503).json({ error: "MELISAFE_TOKEN nao configurado no servidor" });
  const recebido = String(req.get("x-melisafe-token") || "");
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Token da extensao Melisafe invalido" });
  }
  next();
}

// A venda pode ser de qualquer conta conectada: tenta primeiro a ultima que
// acertou (a extensao roda numa conta por vez) e lembra de quem e cada pedido.
const donoDoPedido = new Map(); // pedido/pacote -> id da conta
let ultimaConta = null;

async function contasEmOrdem() {
  const contas = await listAccounts();
  return contas.sort((a, b) => (String(b.id) === String(ultimaConta)) - (String(a.id) === String(ultimaConta)));
}

// Busca `caminho(id)` em cada conta ate uma responder; 403/404 = nao e dela.
async function buscarEmAlgumaConta(id, caminho) {
  const conhecido = donoDoPedido.get(id);
  const contas = await contasEmOrdem();
  if (conhecido) contas.sort((a, b) => (String(b.id) === String(conhecido)) - (String(a.id) === String(conhecido)));
  for (const conta of contas) {
    let token;
    try {
      token = await getValidAccessToken(conta.id);
    } catch {
      continue; // conta desconectada: tenta as outras
    }
    try {
      const dados = await fetchResource(token, caminho);
      donoDoPedido.set(id, conta.id);
      ultimaConta = conta.id;
      return { conta, token, dados };
    } catch (err) {
      if (![400, 403, 404].includes(err.status)) throw err;
    }
  }
  return null;
}

async function custoDoEnvio(token, envioId, vendedorId) {
  if (!envioId) return { custo: 0, bonus: 0 };
  try {
    const c = await fetchResource(token, `/shipments/${envioId}/costs`);
    const remetentes = c.senders || [];
    const meu = remetentes.find((s) => String(s.user_id) === String(vendedorId)) || remetentes[0] || {};
    return { custo: Math.abs(Number(meu.cost) || 0), bonus: Math.abs(Number(meu.compensation) || 0) };
  } catch {
    return { custo: 0, bonus: 0 };
  }
}

// Mesmo formato que a extensao lia da tela de detalhe da venda.
async function resumoDaVenda(id) {
  let achado = await buscarEmAlgumaConta(id, `/orders/${id}`);
  let pedidos;
  if (achado) {
    pedidos = [achado.dados];
  } else {
    // O numero da lista pode ser de um pacote (carrinho com varios pedidos).
    achado = await buscarEmAlgumaConta(id, `/packs/${id}`);
    if (!achado) return null;
    const ids = (achado.dados.orders || []).map((o) => o.id);
    pedidos = [];
    for (const pid of ids) pedidos.push(await fetchResource(achado.token, `/orders/${pid}`));
  }

  const { conta, token } = achado;
  let taxas = 0;
  let receita = 0;
  const skus = [];
  const itens = [];
  const envios = new Set();
  for (const p of pedidos) {
    for (const it of p.order_items || []) {
      const qtd = Number(it.quantity) || 0;
      // sale_fee vem por unidade.
      taxas += (Number(it.sale_fee) || 0) * qtd;
      receita += (Number(it.unit_price) || 0) * qtd;
      const sku = it.item && (it.item.seller_sku || it.item.seller_custom_field);
      if (sku) skus.push(String(sku).trim());
      itens.push({ sku: sku || null, titulo: it.item && it.item.title, qtd, preco: Number(it.unit_price) || 0, tarifa: Number(it.sale_fee) || 0 });
    }
    if (p.shipping && p.shipping.id) envios.add(p.shipping.id);
  }
  let custoEnvio = 0;
  let bonusEnvio = 0;
  for (const envioId of envios) {
    const e = await custoDoEnvio(token, envioId, conta.id);
    custoEnvio += e.custo;
    bonusEnvio += e.bonus;
  }
  return {
    detailEncontrado: true,
    conta: { id: String(conta.id), nickname: conta.nickname },
    taxas: Math.round(taxas * 100) / 100,
    custoEnvio: Math.round(custoEnvio * 100) / 100,
    bonusEnvio: Math.round(bonusEnvio * 100) / 100,
    receitaGlobal: Math.round(receita * 100) / 100,
    skus,
    itens,
    cancelada: pedidos.every((p) => p.status === "cancelled"),
  };
}

router.get("/melisafe/venda/:id", exigirToken, async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^\d{6,25}$/.test(id)) return res.status(400).json({ error: "Numero de venda invalido" });
  try {
    const r = await resumoDaVenda(id);
    if (!r) return res.json({ detailEncontrado: false, erro: "Venda nao encontrada em nenhuma conta conectada" });
    res.json(r);
  } catch (err) {
    console.error("[melisafe] venda", id, err.status || "", err.message);
    res.status(502).json({ detailEncontrado: false, erro: err.message });
  }
});

// ---------- metricas do periodo ----------

const TZ_SP = "-03:00";
const PERIODOS = { today: 0, lastSevenDays: 6, lastFifteenDays: 14, lastMonth: 29 };
const cacheMetricas = new Map(); // `${conta}:${periodo}` -> { em, dados }
const CACHE_METRICAS_MS = 5 * 60 * 1000;

function inicioDoDiaSP(diasAtras) {
  const agoraSP = new Date(Date.now() - 3 * 3600 * 1000); // relogio de Sao Paulo em UTC
  const d = new Date(Date.UTC(agoraSP.getUTCFullYear(), agoraSP.getUTCMonth(), agoraSP.getUTCDate() - diasAtras));
  return `${d.toISOString().slice(0, 10)}T00:00:00.000${TZ_SP}`;
}

// "Vendas brutas" e "Quantidade de vendas" da tela de Metricas: soma dos
// pedidos nao cancelados do periodo (pacote conta como 1 venda).
async function metricas(contaId, periodo) {
  const chave = `${contaId}:${periodo}`;
  const guardado = cacheMetricas.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_METRICAS_MS) return guardado.dados;

  const token = await getValidAccessToken(contaId);
  const de = encodeURIComponent(inicioDoDiaSP(PERIODOS[periodo]));
  let vendasBrutas = 0;
  const vendas = new Set();
  for (let offset = 0; offset < 3000; offset += 50) {
    const r = await fetchResource(token, `/orders/search?seller=${contaId}&order.date_created.from=${de}&sort=date_desc&limit=50&offset=${offset}`);
    for (const p of r.results || []) {
      if (p.status === "cancelled") continue;
      vendasBrutas += Number(p.total_amount) || 0;
      vendas.add(p.pack_id || p.id);
    }
    const total = (r.paging && r.paging.total) || 0;
    if (!(r.results || []).length || offset + 50 >= total) break;
  }
  const dados = { vendasBrutas: Math.round(vendasBrutas * 100) / 100, qtdVendas: vendas.size };
  cacheMetricas.set(chave, { em: Date.now(), dados });
  return dados;
}

router.get("/melisafe/metricas", exigirToken, async (req, res) => {
  const periodo = String(req.query.periodo || "today");
  if (!(periodo in PERIODOS)) return res.status(400).json({ error: "Periodo invalido" });
  try {
    // A extensao manda a conta que achou nas vendas da tela; sem ela, usa a ultima.
    const contaId = String(req.query.conta || ultimaConta || "");
    if (!contaId) return res.json({ ok: false, erro: "Conta ainda nao identificada — abra a lista de vendas" });
    res.json({ ok: true, ...(await metricas(contaId, periodo)) });
  } catch (err) {
    console.error("[melisafe] metricas", err.status || "", err.message);
    res.status(502).json({ ok: false, erro: err.message });
  }
});

module.exports = router;
