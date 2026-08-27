// Recebe as notificacoes (webhooks) do Mercado Livre.
// Doc oficial: https://developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes
//
// Ao criar/editar seu aplicativo em https://developers.mercadolivre.com.br/,
// cadastre esta URL como "URL de retorno de chamada de notificacao":
//   <PUBLIC_BASE_URL>/webhooks/mercadolivre
// (repare que e uma URL DIFERENTE da "URI de redirecionamento", que e
// usada so no login/OAuth) e marque o topico de mensagens na lista de
// topicos do app.
//
// IMPORTANTE: o nome exato do topico de mensagens pode aparecer como
// "messages" na tela de configuracao do seu app — confirme por la. Se vier
// com outro nome, ajuste o filtro `isMessageTopic` abaixo.
const express = require("express");
const db = require("../db");
const { syncPack } = require("../sync");
const { parsePackResource } = require("../ml/api");

const router = express.Router();

function isMessageTopic(topic) {
  return typeof topic === "string" && topic.toLowerCase().includes("message");
}

router.post("/webhooks/mercadolivre", express.json(), (req, res) => {
  // Responde rapido (o Mercado Livre espera confirmacao quase imediata) e
  // processa a notificacao depois, sem bloquear a resposta.
  res.status(200).send("ok");

  const { topic, resource, user_id } = req.body || {};
  console.log("[webhook] recebido:", { topic, resource, user_id });

  // Grava TODA notificacao (de qualquer topico) pra diagnostico — ver
  // comentario da tabela webhook_events em db.js. Isso roda mesmo pra
  // topicos que a gente ignora, de proposito: e a unica forma de responder
  // "o Mercado Livre chegou a mandar ALGUMA notificacao pra essa conta?".
  db.query(
    `INSERT INTO webhook_events (topic, seller_id, resource) VALUES ($1, $2, $3)`,
    [topic || null, String(user_id || "") || null, resource || null]
  ).catch((err) => console.error("[webhook] falha ao gravar webhook_events:", err.message));

  if (!isMessageTopic(topic)) return;

  const parsed = parsePackResource(resource);
  const sellerId = String(parsed?.sellerId || user_id || "");
  const packId = parsed?.packId;

  if (!packId || !sellerId) {
    console.warn("[webhook] nao consegui identificar pack/seller em:", resource);
    return;
  }

  (async () => {
    try {
      const { rows } = await db.query("SELECT 1 FROM accounts WHERE id = $1", [
        sellerId,
      ]);
      if (!rows.length) {
        console.warn(`[webhook] notificacao para conta nao conectada: ${sellerId}`);
        return;
      }
      await syncPack(sellerId, packId);
    } catch (err) {
      console.error(`[webhook] falha ao sincronizar pack ${packId}:`, err.message);
    }
  })();
});

module.exports = router;
