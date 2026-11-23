// Situacao dos anuncios dos produtos em alerta ("sem vender ha N dias"):
// esta pausado? sem estoque? encerrado? ou ativo e so nao vendeu?
//
// Mercado Livre: /items/{id} e bloqueado para o servidor (PolicyAgent) e o
// painel nao contorna isso. Em vez dele, usa a lista de anuncios POR SITUACAO
// do vendedor (/users/{id}/items/search?status=paused ...), que devolve so os
// ids — e o que basta para saber se o anuncio esta numa dessas listas.
// Shopee: product/get_item_base_info (status do anuncio + estoque).
// Cache de 30 min para nao gastar chamadas a cada abertura da tela.

const { mlConta } = require("./ml");
const chat = require("../shopee/chat");

const CACHE_MS = 30 * 60 * 1000;
const cacheML = new Map(); // contaId -> { em, dados }
const cacheShopee = new Map(); // shop|item -> { em, dado }

async function idsPorStatus(contaId, status, subStatus) {
  const ids = new Set();
  for (let pagina = 0; pagina < 15; pagina++) {
    const q = new URLSearchParams({ status, limit: "100", offset: String(pagina * 100) });
    if (subStatus) q.set("sub_status", subStatus);
    const r = await mlConta(contaId, `/users/${contaId}/items/search?${q.toString()}`);
    for (const id of r.results || []) ids.add(String(id));
    const total = Number(r.paging?.total ?? 0);
    if (!(r.results || []).length || (pagina + 1) * 100 >= total) break;
  }
  return ids;
}

async function listasML(contaId) {
  const c = cacheML.get(contaId);
  if (c && Date.now() - c.em < CACHE_MS) return c.dados;
  const dados = { ok: true, pausados: new Set(), semEstoque: new Set(), encerrados: new Set(), revisao: new Set(), inativos: new Set(), erro: null };
  try {
    dados.pausados = await idsPorStatus(contaId, "paused");
    dados.encerrados = await idsPorStatus(contaId, "closed");
    // As demais sao complementares: se falharem, o resto continua valendo.
    dados.semEstoque = await idsPorStatus(contaId, "paused", "out_of_stock").catch(() => new Set());
    dados.revisao = await idsPorStatus(contaId, "under_review").catch(() => new Set());
    dados.inativos = await idsPorStatus(contaId, "inactive").catch(() => new Set());
  } catch (err) {
    dados.ok = false;
    dados.erro = err.status ? `Mercado Livre respondeu ${err.status}` : err.message;
  }
  cacheML.set(contaId, { em: Date.now(), dados });
  return dados;
}

function situacaoML(listas, produtoId) {
  if (!listas.ok) return { situacao: "Indisponível", cor: "cinza", detalhe: listas.erro || "não deu para consultar" };
  if (listas.semEstoque.has(produtoId)) return { situacao: "Sem estoque", cor: "laranja", detalhe: "anúncio pausado por falta de estoque" };
  if (listas.pausados.has(produtoId)) return { situacao: "Pausado", cor: "vermelho", detalhe: "anúncio pausado" };
  if (listas.revisao.has(produtoId)) return { situacao: "Em revisão", cor: "laranja", detalhe: "em revisão pelo Mercado Livre" };
  if (listas.inativos.has(produtoId)) return { situacao: "Inativo", cor: "vermelho", detalhe: "anúncio inativo" };
  if (listas.encerrados.has(produtoId)) return { situacao: "Encerrado", cor: "cinza", detalhe: "anúncio encerrado" };
  return { situacao: "Ativo", cor: "verde", detalhe: "ativo — se não vende, veja preço, estoque no Full e concorrência" };
}

const ROTULO_SHOPEE = {
  NORMAL: { situacao: "Ativo", cor: "verde", detalhe: "ativo — se não vende, veja preço e concorrência" },
  UNLIST: { situacao: "Despublicado", cor: "vermelho", detalhe: "anúncio oculto (despublicado)" },
  BANNED: { situacao: "Banido", cor: "vermelho", detalhe: "removido pela Shopee" },
  REVIEWING: { situacao: "Em revisão", cor: "laranja", detalhe: "em revisão pela Shopee" },
  SELLER_DELETE: { situacao: "Excluído", cor: "cinza", detalhe: "excluído por você" },
  SHOPEE_DELETE: { situacao: "Excluído", cor: "cinza", detalhe: "excluído pela Shopee" },
};

async function statusShopee(shopId, ids) {
  const out = new Map();
  const faltam = [];
  for (const id of ids) {
    const c = cacheShopee.get(`${shopId}|${id}`);
    if (c && Date.now() - c.em < CACHE_MS) out.set(id, c.dado);
    else faltam.push(id);
  }
  if (faltam.length) {
    try {
      const prods = await chat.produtos(shopId, faltam);
      for (const p of prods) {
        let s = ROTULO_SHOPEE[p.status] || { situacao: p.status || "Desconhecido", cor: "cinza", detalhe: "" };
        if (p.status === "NORMAL" && p.estoque === 0) s = { situacao: "Sem estoque", cor: "laranja", detalhe: "ativo, mas com estoque zerado" };
        const dado = { ...s, estoque: p.estoque, link: p.link };
        cacheShopee.set(`${shopId}|${p.itemId}`, { em: Date.now(), dado });
        out.set(String(p.itemId), dado);
      }
      // Anuncio que a Shopee nem devolve: foi apagado.
      for (const id of faltam) if (!out.has(String(id))) out.set(String(id), { situacao: "Não encontrado", cor: "cinza", detalhe: "a Shopee não devolveu este anúncio (apagado?)" });
    } catch (err) {
      for (const id of faltam) out.set(String(id), { situacao: "Indisponível", cor: "cinza", detalhe: err.message });
    }
  }
  return out;
}

// itens: [{ canal, contaId, produtoId }] -> Map "canal|contaId|produtoId" -> situacao
async function situacoes(itens) {
  const resultado = new Map();
  const ml = new Map();
  const sp = new Map();
  for (const it of itens) {
    const alvo = it.canal === "ml" ? ml : sp;
    if (!alvo.has(it.contaId)) alvo.set(it.contaId, new Set());
    alvo.get(it.contaId).add(it.produtoId);
  }
  for (const [contaId, ids] of ml) {
    const listas = await listasML(contaId);
    for (const id of ids) resultado.set(`ml|${contaId}|${id}`, situacaoML(listas, id));
  }
  for (const [shopId, ids] of sp) {
    const mapa = await statusShopee(shopId, [...ids]);
    for (const id of ids) resultado.set(`shopee|${shopId}|${id}`, mapa.get(id) || { situacao: "Desconhecido", cor: "cinza", detalhe: "" });
  }
  return resultado;
}

const linkAnuncio = (canal, contaId, produtoId) =>
  canal === "shopee"
    ? `https://shopee.com.br/product/${contaId}/${produtoId}`
    : `https://produto.mercadolivre.com.br/${String(produtoId).replace(/^([A-Z]{3})(\d+)$/, "$1-$2")}`;

module.exports = { situacoes, linkAnuncio };
