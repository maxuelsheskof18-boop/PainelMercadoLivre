// Rotas do painel pras RECLAMACOES (Central de Resolucoes/mediacao) —
// sistema separado das conversas de mensagens pos-venda (routes/conversations.js).
const express = require("express");
const multer = require("multer");
const db = require("../db");
const { requireLogin } = require("../authMiddleware");
const { getValidAccessToken } = require("../ml/tokens");
const {
  sendClaimMessage,
  uploadClaimAttachment,
  sendClaimMessageWithAttachments,
  sendShippingEvidence,
} = require("../ml/claimsApi");
const { decideReceiverRole, reconcileAllClaims, extractClaimInfo } = require("../claimsSync");
const { fetchClaims, fetchClaimMessages } = require("../ml/claimsApi");

const router = express.Router();
router.use(requireLogin);

// Mesmo limite documentado pela API do Mercado Livre pra anexos de
// reclamacao: ate 5MB, em JPG/PNG/PDF/TXT.
const ALLOWED_MIME = ["image/jpeg", "image/png", "application/pdf", "text/plain"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error("Formato nao suportado. Envie JPG, PNG, PDF ou TXT."));
    }
    cb(null, true);
  },
});

router.get("/claims/pending-count", async (req, res) => {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE local_status = 'pending')::int AS pending
       FROM claims`
  );
  res.json({ pending: rows[0].pending });
});

router.get("/claims", async (req, res) => {
  // "open" (padrao) = pending + answered juntos, ou seja, toda reclamacao
  // que ainda nao fechou — e o que importa pro vendedor acompanhar, ja que
  // mesmo depois de responder ela continua "em aberto" ate o Mercado Livre
  // ou o comprador encerrarem. "pending"/"answered"/"closed" filtram so um
  // status especifico quando precisar.
  const status = ["pending", "answered", "closed", "open"].includes(req.query.status)
    ? req.query.status
    : "open";

  const conditions = [];
  const params = [];
  if (status === "open") {
    conditions.push(`c.local_status IN ('pending', 'answered')`);
  } else {
    params.push(status);
    conditions.push(`c.local_status = $${params.length}`);
  }

  if (req.query.sellerId) {
    params.push(req.query.sellerId);
    conditions.push(`c.seller_id = $${params.length}`);
  }

  const q = (req.query.q || "").trim();
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    conditions.push(`(c.buyer_full_name ILIKE ${p} OR c.product_title ILIKE ${p} OR c.order_id ILIKE ${p})`);
  }

  const { rows } = await db.query(
    `SELECT c.*, a.nickname AS seller_nickname
       FROM claims c
       JOIN accounts a ON a.id = c.seller_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY c.last_message_date DESC NULLS LAST, c.updated_at DESC`,
    params
  );

  res.json(rows);
});

router.get("/claims/:claimId/messages", async (req, res) => {
  const claimId = req.params.claimId;

  const { rows: messages } = await db.query(
    "SELECT * FROM claim_messages WHERE claim_id = $1 ORDER BY id ASC",
    [claimId]
  );
  const { rows: claimRows } = await db.query(
    `SELECT c.*, a.nickname AS seller_nickname
       FROM claims c
       JOIN accounts a ON a.id = c.seller_id
      WHERE c.claim_id = $1`,
    [claimId]
  );

  res.json({ claim: claimRows[0] || null, messages });
});

// A mensagem pode chegar de duas formas: so texto (JSON, sem anexo) ou
// multipart/form-data (quando tem arquivo junto). express.json() so age
// quando o Content-Type e "application/json" (senao so passa adiante sem
// tocar em nada), e o multer so age quando e "multipart/form-data" — as duas
// coisas encadeadas cobrem os dois casos sem conflitar uma com a outra.
router.post("/claims/:claimId/reply", express.json(), (req, res) => {
  upload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || "Falha ao processar o anexo." });
    }

    const claimId = req.params.claimId;
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Mensagem vazia" });
    const operator = String(req.body?.operatorName || "").trim().slice(0, 60) || null;

    const { rows } = await db.query("SELECT * FROM claims WHERE claim_id = $1", [claimId]);
    const claim = rows[0];
    if (!claim) return res.status(404).json({ error: "Reclamacao nao encontrada" });

    const receiverRole = decideReceiverRole(claim.stage);

    try {
      const accessToken = await getValidAccessToken(claim.seller_id);

      if (req.file) {
        const uploadResult = await uploadClaimAttachment(
          accessToken,
          claimId,
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype
        );
        // O formato exato do identificador devolvido nao e 100% garantido
        // pela documentacao publica — tentamos os nomes de campo mais
        // prováveis, nessa ordem.
        const attachmentId =
          uploadResult?.filename || uploadResult?.id || uploadResult?.attachment_id || uploadResult?.raw;
        if (!attachmentId) {
          throw Object.assign(new Error("Nao recebi um identificador de anexo do Mercado Livre."), {
            body: uploadResult,
          });
        }
        await sendClaimMessageWithAttachments(
          accessToken,
          claimId,
          receiverRole,
          text,
          [attachmentId],
          process.env.ML_CLIENT_ID
        );
      } else {
        await sendClaimMessage(accessToken, claimId, receiverRole, text);
      }

      const nowIso = new Date().toISOString();
      await db.query(
        `INSERT INTO claim_messages (claim_id, sender_role, receiver_role, message, sent_date, operator_name)
         VALUES ($1, 'respondent', $2, $3, $4, $5)`,
        [claimId, receiverRole, text, nowIso, operator]
      );
      await db.query(
        `UPDATE claims SET local_status = 'answered', last_message_text = $1, last_message_date = $2, updated_at = now()
         WHERE claim_id = $3`,
        [text, nowIso, claimId]
      );

      res.json({ ok: true });
    } catch (err) {
      console.error("[claims/reply]", err.status, err.body || err.message);
      const mlMessage =
        err.body?.message || err.body?.cause?.[0]?.message || (typeof err.body === "string" ? err.body : null);
      res.status(502).json({
        error: "Falha ao enviar a mensagem para o Mercado Livre.",
        detail: mlMessage || err.message || "Sem detalhes do Mercado Livre.",
      });
    }
  });
});

// Campos obrigatorios por metodo de envio, conforme documentado pela API de
// evidencias de reclamacao — validamos aqui pra dar um erro claro no painel
// em vez de deixar o Mercado Livre recusar sem explicacao boa.
const EVIDENCE_REQUIRED_FIELDS = {
  mail: ["shipping_company_name", "date_shipped"],
  courier: ["shipping_company_name", "destination_agency", "date_shipped", "receiver_name"],
  personal: ["date_delivered"],
  email: ["receiver_email", "date_shipped"],
};

router.post("/claims/:claimId/evidence", express.json(), async (req, res) => {
  const claimId = req.params.claimId;
  const { shipping_method } = req.body || {};

  const requiredFields = EVIDENCE_REQUIRED_FIELDS[shipping_method];
  if (!requiredFields) {
    return res.status(400).json({
      error: `Metodo de envio invalido. Use um de: ${Object.keys(EVIDENCE_REQUIRED_FIELDS).join(", ")}.`,
    });
  }
  const missing = requiredFields.filter((f) => !req.body?.[f]);
  if (missing.length) {
    return res.status(400).json({ error: `Faltam os campos: ${missing.join(", ")}.` });
  }

  const { rows } = await db.query("SELECT * FROM claims WHERE claim_id = $1", [claimId]);
  const claim = rows[0];
  if (!claim) return res.status(404).json({ error: "Reclamacao nao encontrada" });

  try {
    const accessToken = await getValidAccessToken(claim.seller_id);
    const payload = { shipping_method };
    for (const f of requiredFields) payload[f] = req.body[f];
    await sendShippingEvidence(accessToken, claimId, payload);

    const operator = String(req.body?.operatorName || "").trim().slice(0, 60) || null;
    const nowIso = new Date().toISOString();
    const resumo = `Comprovante de envio registrado (${shipping_method}).`;
    await db.query(
      `INSERT INTO claim_messages (claim_id, sender_role, receiver_role, message, sent_date, operator_name)
       VALUES ($1, 'respondent', 'complainant', $2, $3, $4)`,
      [claimId, resumo, nowIso, operator]
    );
    await db.query(
      `UPDATE claims SET last_message_text = $1, last_message_date = $2, updated_at = now() WHERE claim_id = $3`,
      [resumo, nowIso, claimId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[claims/evidence]", err.status, err.body || err.message);
    const mlMessage =
      err.body?.message || err.body?.cause?.[0]?.message || (typeof err.body === "string" ? err.body : null);
    res.status(502).json({
      error: "Falha ao enviar o comprovante para o Mercado Livre.",
      detail: mlMessage || err.message || "Sem detalhes do Mercado Livre.",
    });
  }
});

// Mesma logica do botao "Atualizar" das conversas, so que pras reclamacoes.
router.post("/claims/sync", async (req, res) => {
  try {
    await reconcileAllClaims();
    res.json({ ok: true });
  } catch (err) {
    console.error("[claims/sync]", err.message);
    res.status(500).json({ error: "Falha ao sincronizar reclamacoes", detail: err.message });
  }
});

// Rota TEMPORARIA de diagnostico: busca as reclamacoes ABERTAS de cada
// conta direto na API (sem passar pelo processamento normal) e devolve o
// JSON cru, junto com o que extractClaimInfo entendeu disso — serve pra
// confirmar rapido, com uma reclamacao real, se os nomes de campo batem com
// a documentacao (ver comentario no topo de ml/claimsApi.js). Uso: abrir no
// navegador (ja logado no painel) /api/debug/probe-claims
router.get("/debug/probe-claims", async (req, res) => {
  const { rows: accounts } = await db.query("SELECT id, nickname FROM accounts");
  const report = [];

  for (const acc of accounts) {
    const entry = { sellerId: acc.id, nickname: acc.nickname };
    try {
      const accessToken = await getValidAccessToken(acc.id);
      const data = await fetchClaims(accessToken, { status: "opened", limit: 5 });
      const results = Array.isArray(data?.data) ? data.data : Array.isArray(data?.results) ? data.results : [];
      entry.totalReclamacoesAbertas = data?.paging?.total ?? null;
      entry.amostraBruta = results.slice(0, 2);
      entry.amostraInterpretada = results.slice(0, 2).map((c) => ({ id: c.id, ...extractClaimInfo(c) }));

      if (results[0]) {
        try {
          const messagesData = await fetchClaimMessages(accessToken, results[0].id);
          entry.mensagensDaPrimeiraBruto = messagesData;
        } catch (err) {
          entry.erroMensagens = { status: err.status, body: err.body || err.message };
        }
      }
    } catch (err) {
      entry.erro = { status: err.status, body: err.body || err.message };
    }
    report.push(entry);
  }

  res.json(report);
});

module.exports = router;
