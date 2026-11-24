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
        // "Desfazer a caminho": a varredura nao marca de novo por links ANTERIORES a isto.
        "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS enviado_desfeito_em TIMESTAMPTZ",
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

// Varredura (24/11): marca "a caminho" as conversas de combinar entrega em que
// o vendedor JA mandou o link — as de antes desta funcao existir e as que
// ele mandou fora do painel (app/site do ML). Usa a mensagem gravada
// (direction 'out') mais antiga com link de rastreio: a data dela vira
// "enviado em". Nao mexe em conversa ja entregue/confirmada nem em uma que
// foi desfeita a mao (so conta links mandados depois do "desfazer").
let varrendo = false;
async function varrerEnviados() {
  if (varrendo) return 0;
  varrendo = true;
  try {
    await garantirColunas();
    const { rows } = await db.query(
      `SELECT m.pack_id, m.text, m.sent_date, m.operator_name
         FROM messages m
         JOIN conversations c ON c.pack_id = m.pack_id
        WHERE m.direction = 'out' AND m.text ~* 'https?://'
          AND c.is_combinar_entrega = true AND c.status IN ('pending', 'answered')
          AND c.is_delivered IS NOT TRUE AND c.entrega_confirmada_em IS NULL AND c.enviado_em IS NULL
          AND c.updated_at > now() - interval '180 days'
          AND (c.enviado_desfeito_em IS NULL
               OR (CASE WHEN m.sent_date ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN m.sent_date::timestamptz END) > c.enviado_desfeito_em)
        ORDER BY m.pack_id, m.id`
    );
    const achados = new Map(); // pack_id -> { link, quando, quem } (a 1a mensagem com link de rastreio)
    for (const r of rows) {
      if (achados.has(r.pack_id)) continue;
      const link = linkDeEnvio(r.text);
      if (!link) continue;
      const d = new Date(r.sent_date);
      achados.set(r.pack_id, { link, quando: Number.isNaN(d.getTime()) ? new Date() : d, quem: r.operator_name || null });
    }
    let n = 0;
    for (const [pack, a] of achados) {
      const r = await db.query(
        `UPDATE conversations SET enviado_em = $2, enviado_por = $3, enviado_link = $4
          WHERE pack_id = $1 AND enviado_em IS NULL AND entrega_confirmada_em IS NULL`,
        [pack, a.quando, a.quem, a.link]
      );
      n += r.rowCount || 0;
    }
    if (n) console.log(`[conversasExtras] ${n} conversa(s) marcadas como "a caminho" pelo historico de mensagens`);
    return n;
  } catch (err) {
    console.error("[conversasExtras] varredura:", err.message);
    return 0;
  } finally {
    varrendo = false;
  }
}

let timer = null;
function iniciarVarredura() {
  if (timer || process.env.NODE_ENV === "test") return;
  setTimeout(() => varrerEnviados(), 40_000);
  timer = setInterval(() => varrerEnviados(), 10 * 60 * 1000);
}

module.exports = { garantirColunas, emTransito, entregue, linkDeEnvio, varrerEnviados, iniciarVarredura };
