// Modulo Shopee — fase 1: conectar lojas (OAuth) + sonda da API.
//
// Rotas (todas exigem login no painel):
//   GET    /shopee/conectar            manda para a tela de autorizacao da Shopee
//   GET    /shopee/callback            volta da Shopee com ?code=&shop_id=
//   GET    /api/shopee/estado          chaves configuradas? ambiente? lojas conectadas
//   PUT    /api/shopee/contas/:shopId  { nome } — apelido da loja
//   DELETE /api/shopee/contas/:shopId  desconecta (apaga os tokens daqui)
//   GET    /api/debug/probe-shopee     sonda (?shopId= para uma loja so)
//
// Montado na raiz (app.use(shopeeRoutes)), por isso NAO usa
// router.use(requireLogin): isso barraria tudo que passa por este router,
// inclusive a tela de login. Cada rota pede login individualmente.
//
// Mesmo metodo do Mercado Livre: nada de endpoint da Shopee e tratado como
// certo antes de a sonda rodar contra a loja real. A sonda NAO pede campos
// de dados pessoais (endereco, CPF, nome do comprador).

const crypto = require("crypto");
const express = require("express");
const { requireLogin } = require("../authMiddleware");
const shopee = require("../shopee/api");

const router = express.Router();

function urlRetorno(req, nonce) {
  const base = process.env.SHOPEE_REDIRECT_BASE || `${req.protocol}://${req.get("host")}`;
  return `${base.replace(/\/$/, "")}/shopee/callback?st=${nonce}`;
}

router.get("/shopee/conectar", requireLogin, (req, res) => {
  if (!shopee.configurado()) {
    return res.status(500).send("Faltam SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY nas variaveis de ambiente.");
  }
  const nonce = crypto.randomBytes(12).toString("hex");
  req.session.shopeeNonce = nonce;
  res.redirect(shopee.linkAutorizacao(urlRetorno(req, nonce)));
});

router.get("/shopee/callback", requireLogin, async (req, res) => {
  const { code, shop_id: shopId, main_account_id: mainAccountId, st } = req.query;
  const nonce = req.session.shopeeNonce;
  req.session.shopeeNonce = null;
  if (!nonce || st !== nonce) {
    return res.status(400).send("Retorno da Shopee invalido ou expirado. Volte ao painel e clique em Conectar de novo.");
  }
  if (!code || (!shopId && !mainAccountId)) {
    return res
      .status(400)
      .send(`A Shopee nao devolveu code/shop_id. Recebido: ${Object.keys(req.query).join(", ")}`);
  }
  try {
    const lojas = shopId
      ? await shopee.trocarCodigo(code, shopId)
      : await shopee.trocarCodigoContaPrincipal(code, mainAccountId);
    if (!lojas.length) {
      return res.status(400).send("A Shopee autorizou a conta principal, mas nenhuma loja veio junto. Marque as lojas na tela de autorizacao.");
    }
    // Nome da loja e so conveniencia: se falhar, a loja fica conectada igual.
    for (const id of lojas) {
      try {
        const info = await shopee.chamarLoja(id, "/api/v2/shop/get_shop_info");
        if (info.shop_name) await shopee.definirNome(id, info.shop_name);
      } catch (err) {
        console.warn(`[shopee] get_shop_info da loja ${id} falhou depois de conectar:`, err.message);
      }
    }
    res.redirect("/?modulo=shopee");
  } catch (err) {
    console.error("[shopee] falha ao trocar o code:", err.message);
    res.status(502).send(`Falha ao conectar a loja na Shopee: ${err.message}`);
  }
});

router.get("/api/shopee/estado", requireLogin, async (req, res) => {
  try {
    const { partnerId, ambiente } = shopee.config();
    const contas = shopee.configurado() ? await shopee.listarContas() : [];
    res.json({
      configurado: shopee.configurado(),
      ambiente,
      partnerId: partnerId || null,
      chave: shopee.diagnosticoChave(),
      horaServidor: Math.floor(Date.now() / 1000),
      contas: contas.map((c) => ({
        shopId: String(c.shop_id),
        nome: c.nome,
        ambiente: c.ambiente,
        tokenVenceEm: Number(c.expires_at),
        reconectarAte: c.refresh_expires_at ? Number(c.refresh_expires_at) : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/shopee/contas/:shopId", requireLogin, express.json(), async (req, res) => {
  try {
    const nome = String(req.body?.nome || "").trim().slice(0, 80);
    if (!nome) return res.status(400).json({ error: "Informe um nome." });
    await shopee.definirNome(req.params.shopId, nome);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/shopee/contas/:shopId", requireLogin, async (req, res) => {
  try {
    await shopee.removerConta(req.params.shopId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Sonda ----------

// Campos que nunca devem aparecer no resultado (vai ser colado no chat).
const CAMPOS_PESSOAIS = new Set([
  "recipient_address",
  "buyer_cpf_id",
  "buyer_username",
  "buyer_user_id",
  "invoice_data",
  "dropshipper",
  "dropshipper_phone",
  "to_name",
  "to_avatar",
  "phone",
  "full_address",
]);

// Mostra so o formato: listas cortadas em 3 itens, textos longos cortados,
// dados pessoais trocados por "[oculto]".
function resumir(valor, nivel = 0) {
  if (Array.isArray(valor)) {
    const itens = valor.slice(0, 3).map((v) => resumir(v, nivel + 1));
    if (valor.length > 3) itens.push(`… +${valor.length - 3} itens`);
    return itens;
  }
  if (valor && typeof valor === "object") {
    if (nivel > 6) return "{…}";
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      out[k] = CAMPOS_PESSOAIS.has(k) ? "[oculto]" : resumir(v, nivel + 1);
    }
    return out;
  }
  if (typeof valor === "string" && valor.length > 200) return `${valor.slice(0, 200)}…`;
  return valor;
}

const DIA = 24 * 60 * 60;

async function sondarLoja(shopId) {
  const r = {};
  const chamar = async (rotulo, path, opcoes) => {
    const { status, corpo } = await shopee.chamarLojaCru(shopId, path, opcoes);
    r[rotulo] = { status, ...resumir(corpo) };
    return corpo;
  };

  await chamar("shopInfo", "/api/v2/shop/get_shop_info");

  // Pedidos: a Shopee limita a janela a 15 dias por consulta.
  const fim = Math.floor(Date.now() / 1000);
  const inicio = fim - 15 * DIA + 60;
  const listar = (status) =>
    chamar(`pedidos_${status}`, "/api/v2/order/get_order_list", {
      query: {
        time_range_field: "create_time",
        time_from: inicio,
        time_to: fim,
        page_size: 20,
        order_status: status,
        response_optional_fields: "order_status",
      },
    });
  const aEnviar = await listar("READY_TO_SHIP"); // pago, ainda nao "organizado"
  const processados = await listar("PROCESSED"); // envio organizado/etiqueta gerada
  await listar("SHIPPED");

  const snsAEnviar = (aEnviar.response?.order_list || []).map((o) => o.order_sn);
  const snsProcessados = (processados.response?.order_list || []).map((o) => o.order_sn);
  const amostra = [...snsAEnviar.slice(0, 3), ...snsProcessados.slice(0, 2)];

  if (amostra.length) {
    // ship_by_date / days_to_ship: o prazo de despacho (o que mais importa
    // para o modulo de Prazos). Confirmar se vem por padrao.
    await chamar("detalhePedidos", "/api/v2/order/get_order_detail", {
      query: {
        order_sn_list: amostra.join(","),
        response_optional_fields:
          "pay_time,package_list,shipping_carrier,checkout_shipping_carrier,fulfillment_flag,pickup_done_time,item_list,edt",
      },
    });
  } else {
    r.detalhePedidos = { pulado: "nenhum pedido READY_TO_SHIP/PROCESSED nos ultimos 15 dias" };
  }

  if (snsAEnviar[0]) {
    // Coleta x entrega na agencia (pickup / dropoff) e horarios de coleta.
    await chamar("parametrosEnvio", "/api/v2/logistics/get_shipping_parameter", {
      query: { order_sn: snsAEnviar[0] },
    });
  }
  if (snsProcessados[0]) {
    await chamar("rastreio", "/api/v2/logistics/get_tracking_number", {
      query: { order_sn: snsProcessados[0] },
    });
  }
  await chamar("canaisLogisticos", "/api/v2/logistics/get_channel_list");

  // Devolucoes (vira "Reclamacoes" do painel).
  await chamar("devolucoes", "/api/v2/returns/get_return_list", {
    query: { page_no: 0, page_size: 10 },
  });

  // Chat: costuma exigir permissao a parte. 403/"error_permission" aqui =
  // pedir liberacao do SellerChat no console.
  await chamar("chatConversas", "/api/v2/sellerchat/get_conversation_list", {
    query: { direction: "older", type: "all", page_size: 5 },
  });

  return r;
}

router.get("/api/debug/probe-shopee", requireLogin, async (req, res) => {
  if (!shopee.configurado()) {
    return res.status(500).json({ error: "Faltam SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY." });
  }
  try {
    let contas = await shopee.listarContas();
    if (req.query.shopId) contas = contas.filter((c) => String(c.shop_id) === String(req.query.shopId));
    if (!contas.length) return res.status(404).json({ error: "Nenhuma loja Shopee conectada." });

    const resultado = { ambiente: shopee.ambiente(), geradoEm: new Date().toISOString(), lojas: [] };
    for (const c of contas) {
      try {
        resultado.lojas.push({ shopId: String(c.shop_id), nome: c.nome, ...(await sondarLoja(c.shop_id)) });
      } catch (err) {
        resultado.lojas.push({ shopId: String(c.shop_id), nome: c.nome, erro: err.message });
      }
    }
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
