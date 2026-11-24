// Extras das conversas do Mercado Livre (24/11): "Em tratativa" e "Enviado".
//
//  - Em tratativa: marca manual (ex.: cliente quer devolver). A conversa
//    continua em Pendentes/Respondidas (nao esconde mensagem nova) e ganha um
//    selo + a aba "Tratativa".
//  - Enviado (combinar entrega): ao mandar o LINK (rastreio) para o comprador,
//    a conversa vai para a aba "Enviados" e fica la ate a entrega ser
//    confirmada — pelo botao "Entrega confirmada" ou quando o proprio Mercado
//    Livre marcar o pedido como entregue (is_delivered).
//    Se o comprador escrever enquanto esta em Enviados, ela continua la, mas
//    aparece como pendente (contador vermelho) para nao passar batido.
//
// As colunas sao criadas aqui (ALTER ... IF NOT EXISTS), sem mexer no db.js.

const db = require("./db");

let colunas = null;
function garantirColunas() {
  if (!colunas) {
    colunas = (async () => {
      for (const sql of [
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS em_tratativa BOOLEAN NOT NULL DEFAULT false",
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tratativa_por TEXT",
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tratativa_em TIMESTAMPTZ",
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS enviado_em TIMESTAMPTZ",
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS enviado_por TEXT",
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS enviado_link TEXT",
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entrega_confirmada_em TIMESTAMPTZ",
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entrega_confirmada_por TEXT",
      ]) {
        await db.query(sql);
      }
    })().catch((err) => {
      colunas = null;
      throw err;
    });
  }
  return colunas;
}

// Fragmentos de SQL (com o alias da tabela, ex.: "c").
const pre = (a) => (a ? `${a}.` : "");
// Link enviado e entrega ainda nao confirmada (nem pelo ML nem por nos).
const emTransito = (a = "") => `(${pre(a)}enviado_em IS NOT NULL AND ${pre(a)}entrega_confirmada_em IS NULL AND ${pre(a)}is_delivered IS NOT TRUE)`;
// Entregue: pelo Mercado Livre (tag delivered) ou confirmado por nos.
const entregue = (a = "") => `(${pre(a)}is_delivered = true OR ${pre(a)}entrega_confirmada_em IS NOT NULL)`;

// Primeiro link da mensagem que NAO seja mapa/whatsapp/anuncio/rede social
// (esses nao indicam envio). Os demais (rastreio da transportadora, Melhor
// Rastreio, Correios, etc.) contam. Devolve null se nao achar nenhum.
const IGNORAR_LINK =
  /(maps\.google|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl|waze\.com|wa\.me|whatsapp\.com|produto\.mercadolivre|mercadolivre\.com\.br\/(p|vendas|perguntas|ajuda)|youtube\.com|youtu\.be|instagram\.com|facebook\.com)/i;
function linkDeEnvio(texto) {
  const urls = (String(texto || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || []).map((u) => u.replace(/[.,;:!?]+$/, ""));
  return urls.find((u) => !IGNORAR_LINK.test(u)) || null;
}

module.exports = { garantirColunas, emTransito, entregue, linkDeEnvio };
