// Rotas do Ranking de produtos (Shopee + Mercado Livre).
// Montado dentro de routes/shopee.js (router.use) para nao mexer no server.js.

const express = require("express");
const { requireLogin } = require("../authMiddleware");
const consultas = require("../ranking/consultas");
const status = require("../ranking/status");

const router = express.Router();
const erro = (res, err) => res.status(500).json({ error: err.message });

router.get("/api/ranking", requireLogin, async (req, res) => {
  try {
    res.json(await consultas.ranking(req.query));
  } catch (err) {
    erro(res, err);
  }
});

router.get("/api/ranking/comparar", requireLogin, async (req, res) => {
  try {
    res.json(await consultas.compararPeriodos(req.query));
  } catch (err) {
    erro(res, err);
  }
});

router.get("/api/ranking/estado", requireLogin, async (req, res) => {
  try {
    res.json(await consultas.cobertura());
  } catch (err) {
    erro(res, err);
  }
});

// resumo=1  -> so a contagem (selo do menu)
// status=1  -> junta a situacao do anuncio (pausado, sem estoque, ativo...)
const cacheResumo = new Map();
router.get("/api/ranking/alertas", requireLogin, async (req, res) => {
  try {
    if (req.query.resumo === "1") {
      const chave = JSON.stringify([req.query.dias, req.query.base, req.query.min, req.query.canal]);
      const c = cacheResumo.get(chave);
      if (c && Date.now() - c.em < 5 * 60 * 1000) return res.json(c.dado);
      const r = await consultas.alertas(req.query);
      const dado = { total: r.itens.length, parametros: r.parametros, suspensas: r.suspensas };
      cacheResumo.set(chave, { em: Date.now(), dado });
      return res.json(dado);
    }
    const r = await consultas.alertas(req.query);
    if (req.query.status === "1") {
      const lista = r.itens.slice(0, Math.min(Number(req.query.limiteStatus) || 40, 100));
      const flat = lista.flatMap((a) => a.itens.map((i) => ({ canal: a.canal, contaId: i.contaId, produtoId: i.produtoId })));
      const sit = await status.situacoes(flat);
      for (const a of lista) {
        for (const i of a.itens) {
          const s = sit.get(`${a.canal}|${i.contaId}|${i.produtoId}`);
          if (s) Object.assign(i, s);
          i.link = status.linkAnuncio(a.canal, i.contaId, i.produtoId);
        }
        a.comStatus = true;
      }
    }
    res.json(r);
  } catch (err) {
    erro(res, err);
  }
});

module.exports = router;
