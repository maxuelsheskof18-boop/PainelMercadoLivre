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
  salvarHistorico,
  listarHistorico,
  lerHistorico,
  apagarHistorico,
  diagnosticar,
  sondarTelefone,
  lerEstado,
  lerConfig,
  salvarConfig,
} = require("../flex/coleta");
const { buscar } = require("../flex/geo");

const router = express.Router();
router.use(requireLogin);

/* =====================================================================
   COLETA AUTOMATICA
   O painel busca sozinho, de tempos em tempos, como ja faz com prazos,
   mensagens e reclamacoes. Dois cuidados:

   1) O ciclo e INCREMENTAL (so pedidos alterados desde a ultima rodada).
      Uma coleta cheia sao centenas de chamadas de envio; repetir isso a
      cada ciclo estouraria a cota do ML. Uma vez a cada 12h, ou quando
      nao ha nada guardado, ele faz a cheia para nao acumular buraco.

   2) No plano gratuito do Render o servico dorme e o setInterval para.
      Por isso a leitura do estado tambem dispara o ciclo quando o dado
      esta velho: quem abre a tela ja acorda a coleta.
   ===================================================================== */
const CICLO_MS = Math.max(5, Number(process.env.FLEX_INTERVALO_MIN) || 15) * 60_000;
const COLETA_CHEIA_MS = 12 * 60 * 60_000;

// Horario comercial de Sao Paulo (o servidor roda em UTC): nao adianta
// gastar chamada de madrugada, quando nao entra pedido Flex para entregar.
function dentroDoHorario() {
  const faixa = String(process.env.FLEX_HORARIO || "6-22");
  const [ini, fim] = faixa.split("-").map((n) => Number(n.trim()));
  if (!Number.isFinite(ini) || !Number.isFinite(fim)) return true;
  const hora = Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
  return hora >= ini && hora < fim;
}

let ultimoCiclo = 0;

async function cicloAutomatico(forcado = false) {
  if (!forcado && !dentroDoHorario()) return;
  ultimoCiclo = Date.now();
  try {
    const estado = await lerEstado();
    const temDados = Array.isArray(estado?.registros) && estado.registros.length > 0;
    const idade = estado?.gerado_em ? Date.now() - Date.parse(estado.gerado_em) : Infinity;
    const incremental = temDados && idade < COLETA_CHEIA_MS;
    await coletar({ incremental });
  } catch (err) {
    console.error("[flex/ciclo]", err);
  }
}

function iniciarColetorFlex() {
  setTimeout(() => cicloAutomatico(), 60_000);
  setInterval(() => cicloAutomatico(), CICLO_MS);
}

router.get("/flex/estado", async (req, res) => {
  try {
    const estado = await lerEstado();

    // Dado velho (servico dormiu, ou primeira visita do dia): dispara a
    // coleta em segundo plano e devolve o que ja tem — a tela se atualiza
    // sozinha pelo proprio polling.
    const idade = estado?.gerado_em ? Date.now() - Date.parse(estado.gerado_em) : Infinity;
    const rodandoAgora = estado?.estado === "coletando" || estado?.estado === "geocodificando";
    if (!rodandoAgora && idade > CICLO_MS + 60_000 && Date.now() - ultimoCiclo > 60_000) {
      cicloAutomatico(true).catch((err) => console.error("[flex/estado->ciclo]", err));
    }

    res.json(estado);
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
    // incremental: so o que mudou (rapido, e o que a tela pede ao abrir).
    // Sem a flag, coleta cheia — o botao "Recarregar tudo".
    const incremental = req.body?.incremental === true;
    coletar({ dias, incremental }).catch((err) => console.error("[flex/coletar]", err));
    res.json({ ok: true, mensagem: incremental ? "atualizacao iniciada" : "coleta iniciada" });
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

/* ---------------- memoria do dia ---------------- */
router.post("/flex/historico", express.json({ limit: "4mb" }), async (req, res) => {
  try {
    const { dia, nome, motorista, rotas } = req.body || {};
    if (!Array.isArray(rotas) || !rotas.length) {
      return res.status(400).json({ erro: "Nenhuma rota para guardar." });
    }
    res.json(await salvarHistorico({ dia, nome, motorista, rotas }));
  } catch (err) {
    console.error("[flex/historico post]", err);
    res.status(500).json({ erro: String(err?.message || err) });
  }
});

router.get("/flex/historico", async (req, res) => {
  try {
    res.json(await listarHistorico(Math.min(Number(req.query.dias) || 60, 365)));
  } catch (err) {
    console.error("[flex/historico list]", err);
    res.status(500).json({ erro: String(err?.message || err) });
  }
});

router.get("/flex/historico/:id", async (req, res) => {
  try {
    const item = await lerHistorico(req.params.id);
    if (!item) return res.status(404).json({ erro: "Nao encontrado." });
    res.json(item);
  } catch (err) {
    console.error("[flex/historico get]", err);
    res.status(500).json({ erro: String(err?.message || err) });
  }
});

router.delete("/flex/historico/:id", async (req, res) => {
  try {
    await apagarHistorico(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[flex/historico delete]", err);
    res.status(500).json({ erro: String(err?.message || err) });
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
// Mesmo padrao do prazos: o server.js chama isto depois do listen.
module.exports.iniciarColetorFlex = iniciarColetorFlex;
