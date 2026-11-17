// Shopee — devolucoes e reembolsos (Returns API).
//
// So leitura nesta fase: lista as solicitacoes dos ultimos 60 dias com o
// prazo para o vendedor responder. Aceitar/contestar continua sendo feito
// na Central do Vendedor (acao irreversivel — melhor nao automatizar antes
// de ver o formato real).
//
// get_return_list respondeu 200 no sandbox (17/11/2026, lista vazia);
// campos de cada devolucao vem da doc v2, NAO confirmados.

const shopee = require("./api");

const DIA = 24 * 60 * 60;
const CACHE_MS = 2 * 60 * 1000;
let cache = null;

// Status que pedem acao do vendedor.
const ABERTOS = new Set(["REQUESTED", "PROCESSING", "JUDGING", "SELLER_DISPUTE"]);

async function daLoja(conta) {
  const shopId = String(conta.shop_id);
  const fim = Math.floor(Date.now() / 1000);
  const lista = [];
  // Janela maxima da API: 15 dias por consulta -> 4 janelas = 60 dias.
  for (let j = 0; j < 4; j++) {
    const to = fim - j * 15 * DIA;
    for (let pagina = 0; pagina < 10; pagina++) {
      const r = await shopee.chamarLoja(shopId, "/api/v2/returns/get_return_list", {
        query: { page_no: pagina, page_size: 100, create_time_from: to - 15 * DIA + 1, create_time_to: to },
      });
      const resp = r.response || {};
      for (const d of resp.return || []) {
        const itens = (d.item || []).map((i) => ({
          nome: i.name || i.item_name || `Item ${i.item_id}`,
          qtd: Number(i.amount || 1),
          preco: Number(i.item_price || 0),
          imagem: (i.images || [])[0] || null,
        }));
        lista.push({
          shopId,
          loja: conta.nome || `Loja ${shopId}`,
          returnSn: String(d.return_sn),
          orderSn: d.order_sn,
          status: d.status,
          aberta: ABERTOS.has(d.status),
          motivo: d.reason || "",
          textoComprador: d.text_reason || "",
          valor: Number(d.refund_amount || 0),
          moeda: d.currency || "BRL",
          criadaEm: d.create_time ? d.create_time * 1000 : null,
          atualizadaEm: d.update_time ? d.update_time * 1000 : null,
          responderAte: d.due_date ? d.due_date * 1000 : null,
          negociacao: d.negotiation?.negotiation_status || null,
          fotos: (d.image || d.images || []).length,
          itens,
        });
      }
      if (!resp.more) break;
    }
  }
  return lista;
}

async function listar({ forcar = false } = {}) {
  if (!forcar && cache && Date.now() - cache.em < CACHE_MS) return cache.dados;
  const contas = (await shopee.listarContas()).filter((c) => c.ambiente === shopee.ambiente());
  const devolucoes = [];
  const erros = {};
  for (const c of contas) {
    try {
      devolucoes.push(...(await daLoja(c)));
    } catch (err) {
      erros[String(c.shop_id)] = err.message;
    }
  }
  devolucoes.sort((a, b) => {
    if (a.aberta !== b.aberta) return a.aberta ? -1 : 1;
    return (a.responderAte || Infinity) - (b.responderAte || Infinity) || (b.criadaEm || 0) - (a.criadaEm || 0);
  });
  const dados = { atualizadoEm: Date.now(), devolucoes, erros };
  cache = { em: Date.now(), dados };
  return dados;
}

module.exports = { listar };
