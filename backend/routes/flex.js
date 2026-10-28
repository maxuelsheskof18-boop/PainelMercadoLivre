// Flex — mapa e rotas por zona.
// Rotas: GET /api/flex/estado, POST /api/flex/coletar,
//        GET /api/flex/diagnostico, GET /api/flex/geocodificar,
//        GET|PUT /api/flex/config
//
// Toda rota aqui tem try/catch proprio: o server.js tem uma rede de
// seguranca para promessa rejeitada, mas ela so evita derrubar o processo —
// a chamada ficaria pendurada sem resposta. O padrao do painel (ver
// routes/questions.js) e tratar o erro na rota e devolver JSON de verdade.

const express = require("express");
const { requireLogin } = require("../authMiddleware");
const { listAccounts } = require("../ml/tokens");
const {
  coletar,
  diagnosticar,
  sondarTelefone,
  lerEstado,
  lerConfig,
  salvarConfig,
} = require("../flex/coleta");
const { buscar } = require("../flex/geo");

const router = express.Router();
router.use(requireLogin);

router.get("/flex/estado", async (req, res) => {
  try {
    res.json(await lerEstado());
  } catch (err) {
    console.error("[flex/estado]", err);
    res.status(500).json({ estado: "erro", mensagem: String(err?.message || err), registros: [] });
  }
});

// Dispara a coleta e responde na hora: a tela acompanha o andamento pelo
// /flex/estado (a coleta de varias contas leva minutos e estouraria o
// tempo da requisicao).
// express.json() por rota: o painel nao usa parser global (ver routes/questions.js).
router.post("/flex/coletar", express.json(), async (req, res) => {
  try {
    const dias = Number(req.body?.dias) || undefined;
    coletar({ dias }).catch((err) => console.error("[flex/coletar]", err));
    res.json({ ok: true, mensagem: "coleta iniciada" });
  } catch (err) {
    console.error("[flex/coletar]", err);
    res.status(500).json({ ok: false, erro: String(err?.message || err) });
  }
});

router.get("/flex/diagnostico", async (req, res) => {
  try {
    const contas = await listAccounts();
    if (!contas.length) return res.json({ erro: "Nenhuma conta conectada." });

    const alvo = req.query.conta
      ? contas.find(
          (c) => String(c.id) === String(req.query.conta) || c.nickname === req.query.conta
        )
      : contas[0];
    if (!alvo) return res.status(404).json({ erro: "Conta nao encontrada." });

    const quantos = Math.min(Number(req.query.n) || 10, 30);
    const dias = Math.min(Number(req.query.dias) || 7, 30);
    res.json(await diagnosticar(alvo, quantos, dias));
  } catch (err) {
    console.error("[flex/diagnostico]", err);
    res.status(500).json({ erro: String(err?.message || err) });
  }
});

// Sonda: tenta todas as fontes de telefone no mesmo pedido Flex.
// Use ?conta=<nickname>&pedido=<id opcional>&dias=7
router.get("/flex/sonda-telefone", async (req, res) => {
  try {
    const contas = await listAccounts();
    if (!contas.length) return res.json({ erro: "Nenhuma conta conectada." });
    const alvo = req.query.conta
      ? contas.find(
          (c) => String(c.id) === String(req.query.conta) || c.nickname === req.query.conta
        )
      : contas[0];
    if (!alvo) return res.status(404).json({ erro: "Conta nao encontrada." });

    res.json(
      await sondarTelefone(alvo, {
        pedidoId: req.query.pedido,
        dias: Math.min(Number(req.query.dias) || 7, 30),
      })
    );
  } catch (err) {
    console.error("[flex/sonda-telefone]", err);
    res.status(500).json({ erro: String(err?.message || err) });
  }
});

router.get("/flex/geocodificar", async (req, res) => {
  try {
    const ponto = await buscar(String(req.query.q || ""));
    res.json({ ok: !!ponto, ponto });
  } catch (err) {
    console.error("[flex/geocodificar]", err);
    res.status(500).json({ ok: false, erro: String(err?.message || err) });
  }
});

router.get("/flex/config", async (req, res) => {
  try {
    res.json(await lerConfig());
  } catch (err) {
    console.error("[flex/config]", err);
    res.status(500).json({ erro: String(err?.message || err) });
  }
});

router.put("/flex/config", express.json(), async (req, res) => {
  try {
    res.json(await salvarConfig(req.body || {}));
  } catch (err) {
    console.error("[flex/config]", err);
    res.status(500).json({ erro: String(err?.message || err) });
  }
});

module.exports = router;
