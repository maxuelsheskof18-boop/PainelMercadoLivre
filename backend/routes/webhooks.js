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
const { syncPack, reconcileAccount } = require("../sync");
const { parsePackResource, fetchMessageById } = require("../ml/api");
const { getValidAccessToken } = require("../ml/tokens");
const webhookLog = require("../webhookLog");
const { syncClaim } = require("../claimsSync");
const { syncQuestion } = require("../questionsSync");

const router = express.Router();

function isMessageTopic(topic) {
  return typeof topic === "string" && topic.toLowerCase().includes("message");
}

// O nome exato do topico de reclamacoes NUNCA foi confirmado com uma
// notificacao de verdade (a documentacao publica de webhooks e inconsistente
// sobre isso — as vezes aparece como "post_purchase", as vezes como
// "claims"). Por isso o filtro aceita os dois candidatos, e a tabela
// webhook_events (ver comentario em db.js) grava TODO topico recebido —
// depois que a primeira reclamacao real chegar, da pra conferir ali qual
// nome o Mercado Livre realmente usa e ajustar aqui se for diferente.
function isClaimTopic(topic) {
  if (typeof topic !== "string") return false;
  const t = topic.toLowerCase();
  return t.includes("claim") || t.includes("post_purchase") || t.includes("post-purchase");
}

function parseClaimResource(resource) {
  const match = /claims\/([^/?]+)/i.exec(resource || "");
  return match ? match[1] : null;
}

// Mesmo caso do topico de reclamacoes acima: o nome exato do topico de
// perguntas nunca foi confirmado com uma notificacao de verdade (a
// documentacao publica cita "questions" e "marketplace_questions" em
// lugares diferentes). O filtro aceita qualquer topico que contenha
// "question", e a tabela webhook_events grava tudo — depois que a primeira
// pergunta real chegar, da pra conferir ali o nome exato e ajustar aqui se
// for diferente.
function isQuestionTopic(topic) {
  return typeof topic === "string" && topic.toLowerCase().includes("question");
}

function parseQuestionResource(resource) {
  const match = /questions\/([^/?]+)/i.exec(resource || "");
  return match ? match[1] : null;
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

  if (isClaimTopic(topic)) {
    const claimId = parseClaimResource(resource);
    const claimSellerId = String(user_id || "");
    if (!claimId || !claimSellerId) {
      console.warn("[webhook] nao consegui identificar reclamacao/seller em:", resource);
      return;
    }
    (async () => {
      try {
        const { rows } = await db.query("SELECT 1 FROM accounts WHERE id = $1", [claimSellerId]);
        if (!rows.length) {
          console.warn(`[webhook] notificacao de reclamacao para conta nao conectada: ${claimSellerId}`);
          return;
        }
        await syncClaim(claimSellerId, claimId);
      } catch (err) {
        console.error(`[webhook] falha ao sincronizar reclamacao ${claimId}:`, err.message);
      }
    })();
    return;
  }

  if (isQuestionTopic(topic)) {
    const questionId = parseQuestionResource(resource);
    const questionSellerId = String(user_id || "");
    if (!questionId || !questionSellerId) {
      console.warn("[webhook] nao consegui identificar pergunta/seller em:", resource);
      return;
    }
    (async () => {
      try {
        const { rows } = await db.query("SELECT 1 FROM accounts WHERE id = $1", [questionSellerId]);
        if (!rows.length) {
          console.warn(`[webhook] notificacao de pergunta para conta nao conectada: ${questionSellerId}`);
          return;
        }
        await syncQuestion(questionSellerId, questionId);
      } catch (err) {
        console.error(`[webhook] falha ao sincronizar pergunta ${questionId}:`, err.message);
      }
    })();
    return;
  }

  if (!isMessageTopic(topic)) return;

  const parsed = parsePackResource(resource);
  const sellerId = String(parsed?.sellerId || user_id || "");
  let packId = parsed?.packId || null;

  if (!sellerId) {
    console.warn("[webhook] notificacao de mensagem sem seller:", resource);
    webhookLog.record({ resource, ok: false, motivo: "sem seller" });
    return;
  }

  (async () => {
    const log = { resource, sellerId, formato: packId ? "pack" : "outro" };
    try {
      const { rows } = await db.query("SELECT 1 FROM accounts WHERE id = $1", [sellerId]);
      if (!rows.length) {
        console.warn(`[webhook] notificacao para conta nao conectada: ${sellerId}`);
        webhookLog.record({ ...log, ok: false, motivo: "conta nao conectada" });
        return;
      }

      // O topico "messages" chega com o ID DA MENSAGEM (hash de 32 hex), nao
      // com "/packs/{id}/sellers/{id}" — achado real em webhook_events
      // (2026-09-22): por isso todo webhook de mensagem era descartado aqui
      // sem efeito nenhum. Resolve o pack consultando a propria mensagem.
      if (!packId) {
        try {
          const accessToken = await getValidAccessToken(sellerId);
          const msg = await fetchMessageById(accessToken, resource);
          packId = resolvePackFromMessage(msg);
          log.resolveuPor = packId ? "GET /messages/{id}" : null;
          if (!packId) log.respostaDaMensagem = JSON.stringify(msg).slice(0, 600);
        } catch (err) {
          log.erroBuscarMensagem = { status: err.status, body: err.body || err.message };
        }
      }

      if (packId) {
        await syncPack(sellerId, packId);
        webhookLog.record({ ...log, packId, ok: true });
        return;
      }

      // Nao deu pra descobrir o pack: em vez de perder a notificacao, roda uma
      // reconciliacao rapida da conta (no maximo 1 por minuto por conta, pra
      // uma enxurrada de notificacoes nao disparar varias ao mesmo tempo).
      const last = lastQuickReconcile.get(sellerId) || 0;
      if (Date.now() - last < 60_000) {
        webhookLog.record({ ...log, ok: false, motivo: "pack nao resolvido; reconciliacao rapida ja rodou ha pouco" });
        return;
      }
      lastQuickReconcile.set(sellerId, Date.now());
      await reconcileAccount(sellerId, { quick: true });
      webhookLog.record({ ...log, ok: true, motivo: "pack nao resolvido; rodou reconciliacao rapida da conta" });
    } catch (err) {
      console.error(`[webhook] falha ao processar notificacao de mensagem ${resource}:`, err.message);
      webhookLog.record({ ...log, ok: false, motivo: err.message });
    }
  })();
});

const lastQuickReconcile = new Map();

// Procura o pack na resposta de GET /messages/{id}. A documentacao diz que
// vem em "message_resources": [{ name: "packs", id: "..." }, { name:
// "sellers", id: "..." }], mas isso nunca foi confirmado neste painel — por
// isso tenta tambem outros formatos e, por ultimo, procura "packs/{id}" em
// qualquer lugar do JSON.
function resolvePackFromMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const resources = Array.isArray(msg.message_resources) ? msg.message_resources : [];
  const fromResources = resources.find((r) => String(r?.name).toLowerCase() === "packs");
  if (fromResources?.id) return String(fromResources.id);
  if (msg.pack_id) return String(msg.pack_id);
  const match = /packs\/(\d+)/i.exec(JSON.stringify(msg));
  return match ? match[1] : null;
}

module.exports = router;
