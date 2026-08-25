// Recebe as notificacoes (webhooks) do Mercado Livre.
// Doc oficial: https://developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes
//
// Ao criar/editar seu aplicativo em https://developers.mercadolivre.com.br/,
// cadastre esta URL como "Notifications callback URL":
//   <PUBLIC_BASE_URL>/webhooks/mercadolivre
// e marque o topico de mensagens na lista de topicos do app.
//
// IMPORTANTE: o nome exato do topico de mensagens pode aparecer como
// "messages" na tela de configuracao do seu app — confirme por la. Se vier
// com outro nome, ajuste o filtro `isMessageTopic` abaixo.
const express = require("express");
const db = require("../db");
const { syncPack } = require("../sync");

const router = express.Router();

function isMessageTopic(topic) {
  return typeof topic === "string" && topic.toLowerCase().includes("message");
}

// Extrai pack_id e seller_id de um resource do tipo
// "/messages/packs/{pack_id}/sellers/{seller_id}"
function parsePackResource(resource) {
  const match = /\/messages\/packs\/([^/]+)\/sellers\/([^/?]+)/i.exec(
    resource || ""
  );
  if (!match) return null;
  return { packId: match[1], sellerId: match[2] };
}

router.post("/webhooks/mercadolivre", express.json(), (req, res) => {
  // Responde rapido (o Mercado Livre espera confirmacao quase imediata) e
  // processa a notificacao depois, sem bloquear a resposta.
  res.status(200).send("ok");

  const { topic, resource, user_id } = req.body || {};
  console.log("[webhook] recebido:", { topic, resource, user_id });

  if (!isMessageTopic(topic)) return;

  const parsed = parsePackResource(resource);
  const sellerId = parsed?.sellerId || user_id;
  const packId = parsed?.packId;

  if (!packId || !sellerId) {
    console.warn("[webhook] nao consegui identificar pack/seller em:", resource);
    return;
  }

  const accountExists = db
    .prepare("SELECT 1 FROM accounts WHERE id = ?")
    .get(sellerId);
  if (!accountExists) {
    console.warn(`[webhook] notificacao para conta nao conectada: ${sellerId}`);
    return;
  }

  syncPack(sellerId, packId).catch((err) => {
    console.error(`[webhook] falha ao sincronizar pack ${packId}:`, err.message);
  });
});

module.exports = router;
