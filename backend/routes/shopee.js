// Modulo Shopee: conectar lojas (OAuth), sonda da API, prazos de despacho,
// chat e devolucoes.
//
// Rotas (todas exigem login no painel):
//   GET    /shopee/conectar            manda para a tela de autorizacao da Shopee
//   GET    /shopee/callback            volta da Shopee com ?code=&shop_id=
//   GET    /api/shopee/estado          chaves configuradas? ambiente? lojas conectadas
//   PUT    /api/shopee/contas/:shopId  { nome } — apelido da loja
//   DELETE /api/shopee/contas/:shopId  desconecta (apaga os tokens daqui)
//   GET    /api/debug/probe-shopee     sonda (?shopId= para uma loja so)
//   GET    /api/shopee/resumo          numeros para o selo do menu
//   GET    /api/shopee/prazos          pedidos a despachar (POST .../atualizar forca)
//   GET    /api/shopee/chat            conversas de todas as lojas (?forcar=1)
//   GET    /api/shopee/chat/:shopId/:conversa            mensagens
//   POST   /api/shopee/chat/:shopId/:conversa/enviar     { compradorId, texto }
//   POST   /api/shopee/chat/:shopId/:conversa/lida       { ultimaMensagemId }
//   GET    /api/shopee/devolucoes      devolucoes/reembolsos (?forcar=1)
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
const db = require("../db");
const pedidos = require("../shopee/pedidos");
const chat = require("../shopee/chat");
const devolucoes = require("../shopee/devolucoes");

const router = express.Router();

function baseUrl(req) {
  return (process.env.SHOPEE_REDIRECT_BASE || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function urlRetorno(req, nonce) {
  return `${baseUrl(req)}/shopee/callback?st=${nonce}`;
}

// ---------- Link para lojas de OUTRO CNPJ ----------
// O app Seller In House autoriza lojas proprias de CNPJs diferentes, mas
// quem autoriza e o responsavel de cada loja, entrando com a conta de
// VENDEDOR dela (resposta do suporte da Shopee, 18/11). Essa pessoa nao tem
// login no painel, entao o retorno normal (/shopee/callback, que exige
// login + nonce da sessao) nao serve. Este link leva uma chave fixa,
// derivada do SESSION_SECRET (nao precisa de variavel nova): so quem
// recebeu o link consegue usar o retorno sem login.
function chaveExterna() {
  return crypto
    .createHmac("sha256", process.env.SESSION_SECRET || "troque-este-segredo")
    .update("shopee-autorizar-loja-externa")
    .digest("hex")
    .slice(0, 24);
}

function chaveConfere(k) {
  const certa = Buffer.from(chaveExterna());
  const recebida = Buffer.from(String(k || ""));
  return recebida.length === certa.length && crypto.timingSafeEqual(recebida, certa);
}

const urlRetornoExterno = (req) => `${baseUrl(req)}/shopee/retorno-loja?k=${chaveExterna()}`;
const urlLinkExterno = (req) => `${baseUrl(req)}/shopee/autorizar-loja?k=${chaveExterna()}`;

// Troca o code e grava a(s) loja(s). Usado pelos dois retornos.
async function conectarComCodigo(code, shopId, mainAccountId) {
  const lojas = shopId
    ? await shopee.trocarCodigo(code, shopId)
    : await shopee.trocarCodigoContaPrincipal(code, mainAccountId);
  const nomes = [];
  // Nome da loja e so conveniencia: se falhar, a loja fica conectada igual.
  for (const id of lojas) {
    try {
      const info = await shopee.chamarLoja(id, "/api/v2/shop/get_shop_info");
      if (info.shop_name) await shopee.definirNome(id, info.shop_name);
      nomes.push(info.shop_name || `Loja ${id}`);
    } catch (err) {
      console.warn(`[shopee] get_shop_info da loja ${id} falhou depois de conectar:`, err.message);
      nomes.push(`Loja ${id}`);
    }
  }
  if (lojas.length) pedidos.coletar().catch(() => {}); // loja nova ja aparece nos prazos
  return nomes;
}

function paginaSimples(res, status, titulo, texto) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  res.status(status).send(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff6f2;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2937;padding:16px}
.c{max-width:440px;background:#fff;border-radius:18px;padding:32px 28px;box-shadow:0 12px 32px rgba(238,77,45,.15);text-align:center;border-top:6px solid #ee4d2d}
h1{font-size:21px;margin:12px 0 8px}p{color:#4b5563;line-height:1.55;margin:0}.i{font-size:44px}</style></head>
<body><div class="c"><div class="i">${status < 300 ? "✅" : "⚠️"}</div><h1>${esc(titulo)}</h1><p>${esc(texto)}</p></div></body></html>`);
}

// Link que voce manda para o responsavel da outra loja (sem login no painel).
// Gera na hora o link assinado da Shopee (a assinatura leva o horario, por
// isso nao da para mandar o link da Shopee pronto — ele venceria).
router.get("/shopee/autorizar-loja", (req, res) => {
  if (!chaveConfere(req.query.k)) return paginaSimples(res, 403, "Link inválido", "Peça um link novo a quem enviou.");
  if (!shopee.configurado()) return paginaSimples(res, 500, "Integração indisponível", "A Shopee ainda não está configurada no painel.");
  res.redirect(shopee.linkAutorizacao(urlRetornoExterno(req)));
});

router.get("/shopee/retorno-loja", async (req, res) => {
  const { code, shop_id: shopId, main_account_id: mainAccountId, k } = req.query;
  if (!chaveConfere(k)) return paginaSimples(res, 403, "Link inválido", "Peça um link novo a quem enviou.");
  if (!code || (!shopId && !mainAccountId)) {
    return paginaSimples(res, 400, "Autorização não concluída", "A Shopee não confirmou a autorização. Abra o link de novo e conclua com a conta de vendedor da loja.");
  }
  try {
    const nomes = await conectarComCodigo(code, shopId, mainAccountId);
    if (!nomes.length) {
      return paginaSimples(res, 400, "Nenhuma loja autorizada", "Abra o link de novo e marque a loja na tela da Shopee.");
    }
    console.log(`[shopee] loja(s) conectada(s) pelo link externo: ${nomes.join(", ")}`);
    paginaSimples(res, 200, "Loja conectada!", `${nomes.join(", ")} já aparece no painel. Pode fechar esta página.`);
  } catch (err) {
    console.error("[shopee] falha no retorno externo:", err.message);
    paginaSimples(res, 502, "Não deu certo", `A Shopee recusou a autorização (${err.message}). Abra o link de novo; se continuar, avise quem enviou.`);
  }
});

// Para a tela Lojas: o link para compartilhar e a Redirect URL (caso use o
// botao Authorize do console da Shopee).
router.get("/api/shopee/link-externo", requireLogin, (req, res) => {
  res.json({ link: urlLinkExterno(req), redirect: urlRetornoExterno(req) });
});

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
    const nomes = await conectarComCodigo(code, shopId, mainAccountId);
    if (!nomes.length) {
      return res.status(400).send("A Shopee autorizou a conta principal, mas nenhuma loja veio junto. Marque as lojas na tela de autorizacao.");
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
  "user",
  "username",
  "email",
  "portrait",
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
    r[rotulo] = { http: status, ...resumir(corpo) }; // "http" e nao "status": get_shop_info tem um "status" proprio (NORMAL)
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
    const det = await chamar("detalhePedidos", "/api/v2/order/get_order_detail", {
      query: {
        order_sn_list: amostra.join(","),
        response_optional_fields:
          "pay_time,package_list,shipping_carrier,checkout_shipping_carrier,fulfillment_flag,pickup_done_time,item_list,edt",
      },
    });
    // Cartao do anuncio no chat: confere se a API de produto esta liberada
    // e quais campos vem (foto, preco, estoque).
    const itemId = det.response?.order_list?.[0]?.item_list?.[0]?.item_id;
    if (itemId) {
      await chamar("produto", "/api/v2/product/get_item_base_info", {
        query: { item_id_list: itemId, need_tax_info: false, need_complaint_policy: false },
      });
    }
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
  // Sem filtro a Shopee devolveu as de 2022 primeiro (18/11). Esta confere
  // se o filtro por data de criacao (ultimos 15 dias) funciona.
  await chamar("devolucoes15dias", "/api/v2/returns/get_return_list", {
    query: { page_no: 0, page_size: 10, create_time_from: fim - 15 * DIA + 60, create_time_to: fim },
  });

  // Chat: costuma exigir permissao a parte. 403/"error_permission" aqui =
  // pedir liberacao do SellerChat no console.
  const conversas = await chamar("chatConversas", "/api/v2/sellerchat/get_conversation_list", {
    query: { direction: "older", type: "all", page_size: 5 },
  });
  const primeira = conversas.response?.conversations?.[0];
  if (primeira) {
    // Formato das mensagens (quem e "da loja": from_id x from_shop_id).
    const msgs = await chamar("chatMensagens", "/api/v2/sellerchat/get_message", {
      query: { conversation_id: primeira.conversation_id, page_size: 6 },
    });
    r.chatMensagens.compradorId = primeira.to_id;
    void msgs;
  }

  return r;
}

// Mensagens cruas de UMA conversa (formato de tipos desconhecidos).
// Uso: /api/debug/shopee-conversa?shopId=...&conversa=...  (o painel mostra o link)
router.get("/api/debug/shopee-conversa", requireLogin, async (req, res) => {
  try {
    const { mensagens: msgs, paginas } = await chat.mensagensCruas(req.query.shopId, req.query.conversa);
    // + registro da conversa (onde a Shopee guarda produto/variacao consultados)
    const conversa = await chat.conversaCrua(req.query.shopId, req.query.conversa);
    res.json({ total: msgs.length, paginas, conversa: resumir(conversa), mensagens: msgs.map((m) => resumir(m)) });
  } catch (err) {
    erro500(res, err);
  }
});

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

// ---------- Prazos, chat e devolucoes ----------

const json = express.json({ limit: "64kb" });
const erro500 = (res, err) => res.status(500).json({ error: err.message });

// ---- Marcas do chat (23/11): "Resolvido" e "Em tratativa" (cliente quer
// devolver). Guardadas no banco: valem para todos os computadores.
//  - resolvido: some das listas normais; se o COMPRADOR escrever depois, a
//    conversa reabre sozinha (a marca cai). Nunca esconde mensagem nova.
//  - tratativa: fica ate alguem tirar; se o comprador escrever depois, ganha
//    o aviso "cliente respondeu".
let tabelaMarcas = null;
function garantirTabelaMarcas() {
  if (!tabelaMarcas) {
    tabelaMarcas = db
      .query(
        `CREATE TABLE IF NOT EXISTS shopee_chat_marcas (
           shop_id TEXT NOT NULL,
           conversa TEXT NOT NULL,
           estado TEXT NOT NULL,
           quem TEXT,
           atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
           ultima_em BIGINT NOT NULL DEFAULT 0,
           PRIMARY KEY (shop_id, conversa)
         )`
      )
      .catch((err) => {
        tabelaMarcas = null;
        throw err;
      });
  }
  return tabelaMarcas;
}

// Devolve COPIAS das conversas com .marca (a lista do chat.js e cacheada:
// nao pode ser alterada no lugar).
async function comMarcas(conversas) {
  try {
    await garantirTabelaMarcas();
    const { rows } = await db.query(
      "SELECT shop_id, conversa, estado, quem, ultima_em, extract(epoch FROM atualizado_em) * 1000 AS em FROM shopee_chat_marcas"
    );
    const porChave = new Map(rows.map((r) => [`${r.shop_id}|${r.conversa}`, r]));
    const reabrir = [];
    const out = conversas.map((c) => {
      const m = porChave.get(`${c.shopId}|${c.id}`);
      if (!m) return c;
      const compradorEscreveu = c.ultimaDoComprador && Number(c.ultimaEm) > Number(m.ultima_em);
      if (m.estado === "resolvido" && compradorEscreveu) {
        reabrir.push([c.shopId, c.id]);
        return c;
      }
      return { ...c, marca: { estado: m.estado, quem: m.quem || "", em: Number(m.em), novaMsg: m.estado === "tratativa" && compradorEscreveu } };
    });
    for (const [shopId, conversa] of reabrir) {
      db.query("DELETE FROM shopee_chat_marcas WHERE shop_id = $1 AND conversa = $2 AND estado = 'resolvido'", [shopId, conversa]).catch(() => {});
    }
    return out;
  } catch (err) {
    console.error("[shopee-marcas]", err.message);
    return conversas;
  }
}

router.post("/api/shopee/chat/:shopId/:conversa/marca", requireLogin, json, async (req, res) => {
  try {
    const { estado, quem, ultimaEm } = req.body || {};
    if (estado !== null && !["resolvido", "tratativa"].includes(estado)) return res.status(400).json({ error: "estado invalido" });
    await garantirTabelaMarcas();
    if (estado === null) {
      await db.query("DELETE FROM shopee_chat_marcas WHERE shop_id = $1 AND conversa = $2", [req.params.shopId, req.params.conversa]);
    } else {
      await db.query(
        `INSERT INTO shopee_chat_marcas (shop_id, conversa, estado, quem, atualizado_em, ultima_em)
         VALUES ($1,$2,$3,$4,now(),$5)
         ON CONFLICT (shop_id, conversa) DO UPDATE SET estado = EXCLUDED.estado, quem = EXCLUDED.quem, atualizado_em = now(), ultima_em = EXCLUDED.ultima_em`,
        [req.params.shopId, req.params.conversa, estado, String(quem || "").slice(0, 60), Math.max(0, Math.floor(Number(ultimaEm) || 0))]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    erro500(res, err);
  }
});

router.get("/api/shopee/resumo", requireLogin, async (req, res) => {
  try {
    const p = pedidos.snapshot().pedidos;
    const resumo = {
      atrasados: p.filter((x) => x.situacao === "atrasado").length,
      urgentes: p.filter((x) => x.situacao === "risco" || x.situacao === "hoje").length,
      chatNaoLidas: 0,
      devolucoesAbertas: 0,
    };
    try {
      const { conversas } = await chat.listarConversas();
      resumo.chatNaoLidas = (await comMarcas(conversas)).filter((c) => c.naoLidas > 0 && c.marca?.estado !== "resolvido").length;
    } catch {}
    try {
      resumo.devolucoesAbertas = (await devolucoes.listar()).devolucoes.filter((d) => d.aberta).length;
    } catch {}
    res.json(resumo);
  } catch (err) {
    erro500(res, err);
  }
});

router.get("/api/shopee/prazos", requireLogin, async (req, res) => {
  try {
    await pedidos.garantirAtual();
  } catch {}
  res.json(pedidos.snapshot());
});

// Acumulado do dia do MERCADO LIVRE (faixa "Pacotes do dia"). Fica aqui e nao
// em routes/prazos.js para nao mexer no modulo do ML: le o historico que o
// Prazos do ML ja grava (prazos_envios). Conta os envios que sairam da lista
// de pendentes hoje (horario de SP), menos cancelados. saiu_em = ciclo em que
// o painel percebeu a saida (~3 min de precisao).
// RITMO MEDIDO (19/11): quantos minutos a operacao leva por pacote, por canal,
// nos ultimos 15 dias. O Tiny so informa a DATA da embalagem; a hora vem de
//   - ML: prazos_envios.impresso_em (hora vista impressa, ~3 min, historico
//     de semanas; ignora impresso_estimado);
//   - Shopee/TikTok/Amazon: tiny_embalados.visto_em (hora vista embalada,
//     ~5 min; comeca a juntar historico em 19/11).
// Conta: por dia e canal, ordena os horarios e quebra em "sessoes" quando
// passa 30 min sem nenhum pacote; tempo da sessao / intervalos = min por
// pacote. Sessao com menos de 3 horarios distintos (ex.: o Render acordou e
// viu tudo de uma vez) e descartada. E o ritmo da EQUIPE inteira.
function medirRitmo(linhas) {
  const porCanal = {};
  const porDiaAcc = {}; // "canal|dia" -> { ms, intervalos, pacotes }
  const grupos = new Map();
  for (const l of linhas) {
    const k = `${l.canal}|${l.dia}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(Number(l.t));
  }
  for (const [k, ts] of grupos) {
    const canal = k.split("|")[0];
    ts.sort((a, b) => a - b);
    if (!porCanal[canal]) porCanal[canal] = { ms: 0, intervalos: 0, pacotes: 0, dias: new Set() };
    const acc = porCanal[canal];
    let ini = 0;
    const fechar = (fim) => {
      const sessao = ts.slice(ini, fim + 1);
      if (new Set(sessao).size >= 3) {
        const d = (porDiaAcc[k] = porDiaAcc[k] || { ms: 0, intervalos: 0, pacotes: 0 });
        d.ms += sessao[sessao.length - 1] - sessao[0];
        d.intervalos += sessao.length - 1;
        d.pacotes += sessao.length;
        acc.ms += sessao[sessao.length - 1] - sessao[0];
        acc.intervalos += sessao.length - 1;
        acc.pacotes += sessao.length;
        acc.dias.add(k.split("|")[1]);
      }
    };
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] - ts[i - 1] > 30 * 60e3) {
        fechar(i - 1);
        ini = i;
      }
    }
    fechar(ts.length - 1);
  }
  const out = {};
  for (const [canal, a] of Object.entries(porCanal)) {
    if (a.intervalos < 20 || !a.ms) continue; // pouco dado
    out[canal] = { minPorPacote: Math.round((a.ms / a.intervalos / 60e3) * 100) / 100, pacotes: a.pacotes, dias: a.dias.size };
  }
  const porDia = Object.entries(porDiaAcc)
    .filter(([, d]) => d.intervalos >= 10 && d.ms)
    .map(([k, d]) => {
      const [canal, dia] = k.split("|");
      return { chave: `canal:${canal}`, dia, minPorPacote: d.ms / d.intervalos / 60e3, pacotes: d.pacotes };
    });
  return { media: out, porDia };
}

// RECORDE (pedido do usuario, 19/11): o dia em que a equipe foi mais rapida
// vira a meta, "se conseguiu aquele dia consegue outro". Fica guardado para
// sempre (nao so 15 dias). Um dia novo so vira recorde se for mais rapido E
// com volume parecido (pelo menos 70% dos pacotes do recorde) — dia de pouco
// pacote nao vale. Abaixo de 0,2 min/pacote (12 s) e descartado (erro).
async function atualizarRecordes(candidatos) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ritmo_recordes (
       chave TEXT PRIMARY KEY,
       min_por_pacote NUMERIC NOT NULL,
       pacotes INT NOT NULL,
       dia DATE NOT NULL
     )`
  );
  const { rows } = await db.query("SELECT chave, min_por_pacote, pacotes, to_char(dia, 'YYYY-MM-DD') AS dia FROM ritmo_recordes");
  const rec = Object.fromEntries(rows.map((r) => [r.chave, { min: Number(r.min_por_pacote), pacotes: r.pacotes, dia: r.dia }]));
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  for (const c of candidatos) {
    if (c.dia >= hoje || c.pacotes < 20 || !(c.minPorPacote >= 0.2)) continue; // so dias completos
    const atual = rec[c.chave];
    if (atual && !(c.minPorPacote < atual.min && c.pacotes >= 0.7 * atual.pacotes)) continue;
    rec[c.chave] = { min: c.minPorPacote, pacotes: c.pacotes, dia: c.dia };
    await db.query(
      `INSERT INTO ritmo_recordes (chave, min_por_pacote, pacotes, dia) VALUES ($1,$2,$3,$4)
       ON CONFLICT (chave) DO UPDATE SET min_por_pacote = EXCLUDED.min_por_pacote, pacotes = EXCLUDED.pacotes, dia = EXCLUDED.dia`,
      [c.chave, Math.round(c.minPorPacote * 100) / 100, c.pacotes, c.dia]
    );
  }
  return Object.fromEntries(
    Object.entries(rec).map(([k, r]) => [k, { minPorPacote: Math.round(r.min * 100) / 100, pacotes: r.pacotes, dia: r.dia }])
  );
}

// Ritmo de EMBALAGEM por equipe nos ultimos 15 dias (ideia do usuario):
// por dia, (fim da operacao - 09:00) / pacotes embalados no Tiny pela equipe.
// Fim = ultima etiqueta impressa do dia nas modalidades ML da equipe (hora
// real gravada pelo Prazos); sem isso, 17:00.
//   Bahia: Shopee Envios + Mercado Envios Flex
//   Mathias: Mercado Envios (coleta/agencia) + TikTok + Amazon
const INICIO_TRABALHO = process.env.RITMO_INICIO || "09:00";
const FIM_PADRAO = process.env.RITMO_FIM_PADRAO || "17:00";
function equipeDaForma(forma) {
  const f = forma || "";
  if (/shopee|flex/i.test(f)) return "bahia";
  if (/tik\s*tok|amazon|mercado\s*envios/i.test(f)) return "mathias";
  return null;
}
async function ritmoEquipes15(candidatos = []) {
  const { rows: tem } = await db.query("SELECT to_regclass('tiny_embalados_dia') AS t");
  if (!tem[0]?.t) return {};
  const { rows } = await db.query(
    `SELECT to_char(dia, 'YYYY-MM-DD') AS dia, forma, qtd
       FROM tiny_embalados_dia
      WHERE dia >= current_date - 14 AND dia < current_date AND forma <> '__historico__'`
  );
  // Fim da operacao por dia e equipe (ultima impressao do ML).
  const fins = {};
  const { rows: temML } = await db.query("SELECT to_regclass('prazos_envios') AS t");
  if (temML[0]?.t) {
    const { rows: f } = await db.query(
      `SELECT to_char(impresso_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
              CASE WHEN modalidade = 'flex' THEN 'bahia' ELSE 'mathias' END AS equipe,
              to_char(max(impresso_em AT TIME ZONE 'America/Sao_Paulo'), 'HH24:MI') AS fim
         FROM prazos_envios
        WHERE impresso_em > now() - interval '16 days' AND NOT impresso_estimado
        GROUP BY 1, 2`
    );
    for (const x of f) fins[`${x.dia}|${x.equipe}`] = x.fim;
  }
  const min = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const acc = {};
  const porDia = {};
  for (const r of rows) {
    const eq = equipeDaForma(r.forma);
    if (!eq) continue;
    const k = `${r.dia}|${eq}`;
    porDia[k] = (porDia[k] || 0) + Number(r.qtd);
  }
  for (const [k, qtd] of Object.entries(porDia)) {
    const [dia, eq] = k.split("|");
    if (qtd < 5) continue;
    let fim = fins[k] || FIM_PADRAO;
    if (min(fim) <= min(INICIO_TRABALHO) + 30) fim = FIM_PADRAO; // fim estranho
    const minutos = min(fim) - min(INICIO_TRABALHO);
    candidatos.push({ chave: `equipe:${eq}`, dia, minPorPacote: minutos / qtd, pacotes: qtd });
    if (!acc[eq]) acc[eq] = { minutos: 0, pacotes: 0, dias: 0 };
    acc[eq].minutos += minutos;
    acc[eq].pacotes += qtd;
    acc[eq].dias++;
  }
  const out = {};
  for (const [eq, a] of Object.entries(acc)) {
    out[eq] = {
      minPorPacote: Math.round((a.minutos / a.pacotes) * 100) / 100,
      pacotes: a.pacotes,
      dias: a.dias,
      pacotesPorDia: Math.round(a.pacotes / a.dias),
      inicio: INICIO_TRABALHO,
    };
  }
  return out;
}

// ---- RELOGIO POR REMESSA: atraso e justificativa (pedido de 19/11) ----
// Prazo da remessa = inicio + pacotes x ritmo (calculado na tela). Passou do
// prazo sem terminar: a equipe tem 15 min para justificar (falta de produto,
// separacao, produto nao encontrado, outro); senao conta como atraso sem
// justificativa. Tudo por dia/canal/remessa, para relatorio depois.
let tabelaRemessas = null;
function garantirTabelaRemessas() {
  if (!tabelaRemessas) {
    tabelaRemessas = db
      .query(
        `CREATE TABLE IF NOT EXISTS remessa_ocorrencias (
           dia DATE NOT NULL,
           cat TEXT NOT NULL,
           n INT NOT NULL,
           prazo TIMESTAMPTZ,
           motivo TEXT,
           obs TEXT,
           quem TEXT,
           justificado_em TIMESTAMPTZ,
           finalizada_em TIMESTAMPTZ,
           atraso_min INT,
           PRIMARY KEY (dia, cat, n)
         )`
      )
      .catch((err) => {
        tabelaRemessas = null;
        throw err;
      });
  }
  return tabelaRemessas;
}
const MOTIVOS_REMESSA = ["Falta de produto", "Separação", "Produto não encontrado", "Outro"];
const DIA_OK = /^\d{4}-\d{2}-\d{2}$/;

router.get("/api/remessas/ocorrencias", requireLogin, async (req, res) => {
  try {
    if (!DIA_OK.test(req.query.dia || "")) return res.status(400).json({ error: "dia=AAAA-MM-DD" });
    await garantirTabelaRemessas();
    const { rows } = await db.query(
      `SELECT cat, n, motivo, obs, quem,
              extract(epoch FROM prazo) * 1000 AS prazo,
              extract(epoch FROM justificado_em) * 1000 AS "justificadoEm",
              extract(epoch FROM finalizada_em) * 1000 AS "finalizadaEm",
              atraso_min AS "atrasoMin"
         FROM remessa_ocorrencias WHERE dia = $1`,
      [req.query.dia]
    );
    res.json({ ocorrencias: rows.map((r) => ({ ...r, prazo: Number(r.prazo) || null, justificadoEm: Number(r.justificadoEm) || null, finalizadaEm: Number(r.finalizadaEm) || null })) });
  } catch (err) {
    erro500(res, err);
  }
});

router.post("/api/remessas/justificar", requireLogin, express.json(), async (req, res) => {
  try {
    const { dia, cat, n, motivo, obs, quem, prazo } = req.body || {};
    if (!DIA_OK.test(dia || "") || !cat || !Number(n) || !MOTIVOS_REMESSA.includes(motivo)) {
      return res.status(400).json({ error: "dados invalidos" });
    }
    await garantirTabelaRemessas();
    await db.query(
      `INSERT INTO remessa_ocorrencias (dia, cat, n, prazo, motivo, obs, quem, justificado_em, atraso_min)
       VALUES ($1,$2,$3,to_timestamp($4 / 1000.0),$5,$6,$7,now(), GREATEST(0, round(extract(epoch FROM now() - to_timestamp($4 / 1000.0)) / 60)))
       ON CONFLICT (dia, cat, n) DO UPDATE SET
         motivo = EXCLUDED.motivo, obs = EXCLUDED.obs, quem = EXCLUDED.quem,
         justificado_em = now(), prazo = COALESCE(remessa_ocorrencias.prazo, EXCLUDED.prazo)`,
      [dia, String(cat).slice(0, 20), Number(n), Number(prazo) || Date.now(), motivo, String(obs || "").slice(0, 300), String(quem || "").slice(0, 60)]
    );
    res.json({ ok: true });
  } catch (err) {
    erro500(res, err);
  }
});

// Primeira vez que alguma tela viu a remessa terminada: guarda a hora e o
// atraso final (0 se terminou no prazo).
router.post("/api/remessas/finalizar", requireLogin, express.json(), async (req, res) => {
  try {
    const { dia, cat, n, prazo } = req.body || {};
    if (!DIA_OK.test(dia || "") || !cat || !Number(n)) return res.status(400).json({ error: "dados invalidos" });
    await garantirTabelaRemessas();
    await db.query(
      `INSERT INTO remessa_ocorrencias (dia, cat, n, prazo, finalizada_em, atraso_min)
       VALUES ($1,$2,$3,to_timestamp($4 / 1000.0),now(), GREATEST(0, round(extract(epoch FROM now() - to_timestamp($4 / 1000.0)) / 60)))
       ON CONFLICT (dia, cat, n) DO UPDATE SET
         finalizada_em = COALESCE(remessa_ocorrencias.finalizada_em, now()),
         prazo = COALESCE(remessa_ocorrencias.prazo, EXCLUDED.prazo),
         atraso_min = CASE WHEN remessa_ocorrencias.finalizada_em IS NULL
                           THEN GREATEST(0, round(extract(epoch FROM now() - COALESCE(remessa_ocorrencias.prazo, EXCLUDED.prazo)) / 60))
                           ELSE remessa_ocorrencias.atraso_min END`,
      [dia, String(cat).slice(0, 20), Number(n), Number(prazo) || Date.now()]
    );
    res.json({ ok: true });
  } catch (err) {
    erro500(res, err);
  }
});

let cacheRitmo = null;
router.get("/api/pacotes-dia/ritmo", requireLogin, async (req, res) => {
  try {
    if (cacheRitmo && Date.now() - cacheRitmo.em < 30 * 60e3) return res.json(cacheRitmo.dados);
    const linhas = [];
    const { rows: temML } = await db.query("SELECT to_regclass('prazos_envios') AS t");
    if (temML[0]?.t) {
      const { rows } = await db.query(
        `SELECT modalidade AS canal,
                to_char(impresso_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
                extract(epoch FROM impresso_em) * 1000 AS t
           FROM prazos_envios
          WHERE impresso_em > now() - interval '15 days'
            AND NOT impresso_estimado
            AND modalidade IN ('coleta', 'agencia', 'flex')`
      );
      linhas.push(...rows);
    }
    const { rows: temTiny } = await db.query("SELECT to_regclass('tiny_embalados') AS t");
    if (temTiny[0]?.t) {
      const { rows } = await db.query(
        `SELECT CASE WHEN forma ILIKE '%shopee%' THEN 'shopee'
                     WHEN forma ILIKE '%tik%tok%' THEN 'tiktok'
                     WHEN forma ILIKE '%amazon%' THEN 'amazon' END AS canal,
                to_char(visto_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
                extract(epoch FROM visto_em) * 1000 AS t
           FROM tiny_embalados
          WHERE visto_em > now() - interval '15 days'
            AND forma IS NOT NULL
            -- so o que foi visto no MESMO dia da embalagem (hora real)
            AND to_char(visto_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') = data_checkout`
      );
      linhas.push(...rows.filter((r) => r.canal));
    }
    const medido = medirRitmo(linhas);
    const candidatos = [...medido.porDia];
    const equipes = await ritmoEquipes15(candidatos);
    const recordes = await atualizarRecordes(candidatos).catch((err) => {
      console.error("[ritmo-recordes]", err.message);
      return {};
    });
    const dados = { canais: medido.media, equipes, recordes, calculadoEm: Date.now() };
    cacheRitmo = { em: Date.now(), dados };
    res.json(dados);
  } catch (err) {
    erro500(res, err);
  }
});

router.get("/api/pacotes-dia/ml-saiu-hoje", requireLogin, async (req, res) => {
  try {
    const { rows: tem } = await db.query("SELECT to_regclass('prazos_envios') AS t");
    if (!tem[0]?.t) return res.json({ total: 0, porConta: [], semHistorico: true });
    const { rows } = await db.query(
      `SELECT conta, modalidade, count(*)::int AS total
         FROM prazos_envios
        WHERE saiu_em >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
          AND status_final IS DISTINCT FROM 'cancelled'
        GROUP BY conta, modalidade`
    );
    // porModalidade: as equipes se dividem por modalidade (flex x coleta/agencia).
    const porModalidade = {};
    for (const r of rows) porModalidade[r.modalidade || "?"] = (porModalidade[r.modalidade || "?"] || 0) + r.total;
    // Remessas do ML: cada envio que saiu hoje com a hora aproximada da venda.
    // A tabela nao guarda a data da venda: visto_em = primeira vez que o
    // painel viu o envio (coleta a cada 3 min; se o Render estava dormindo,
    // pode cair na remessa seguinte).
    const { rows: envios } = await db.query(
      `SELECT modalidade, visto_em
         FROM prazos_envios
        WHERE saiu_em >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
          AND status_final IS DISTINCT FROM 'cancelled'
          AND modalidade IN ('coleta', 'agencia', 'flex')`
    );
    res.json({
      total: rows.reduce((s, r) => s + r.total, 0),
      porConta: rows,
      porModalidade,
      envios: envios.map((e) => ({ modalidade: e.modalidade, vendaAprox: new Date(e.visto_em).getTime() })),
    });
  } catch (err) {
    erro500(res, err);
  }
});

router.post("/api/shopee/prazos/atualizar", requireLogin, async (req, res) => {
  try {
    await pedidos.coletar();
    res.json(pedidos.snapshot());
  } catch (err) {
    erro500(res, err);
  }
});

router.get("/api/shopee/chat", requireLogin, async (req, res) => {
  try {
    const r = await chat.listarConversas({ forcar: req.query.forcar === "1" });
    res.json({ ...r, conversas: await comMarcas(r.conversas) });
  } catch (err) {
    erro500(res, err);
  }
});

router.get("/api/shopee/chat/:shopId/:conversa", requireLogin, async (req, res) => {
  try {
    // ?rapido=1: so as 25 mais recentes (a tela mescla com o que ja tem).
    const r = await chat.mensagensComMeta(req.params.shopId, req.params.conversa, req.query.comprador, {
      maxPaginas: req.query.rapido === "1" ? 1 : undefined,
    });
    res.json({ mensagens: r.lista, rapidoOk: r.primeiraPaginaRecente });
  } catch (err) {
    erro500(res, err);
  }
});

// Produtos e pedidos citados na conversa (cartoes do painel lateral).
router.get("/api/shopee/chat/:shopId/:conversa/contexto", requireLogin, async (req, res) => {
  try {
    res.json(await chat.contexto(req.params.shopId, req.params.conversa, req.query.comprador));
  } catch (err) {
    erro500(res, err);
  }
});

router.post("/api/shopee/chat/:shopId/:conversa/enviar", requireLogin, json, async (req, res) => {
  try {
    const texto = String(req.body?.texto || "").trim();
    const compradorId = String(req.body?.compradorId || "");
    if (!texto) return res.status(400).json({ error: "Mensagem vazia." });
    if (texto.length > 1000) return res.status(400).json({ error: "Mensagem muito longa (máx. 1000 caracteres)." });
    if (!/^\d+$/.test(compradorId)) return res.status(400).json({ error: "Comprador inválido." });
    res.json({ ok: true, resposta: await chat.enviar(req.params.shopId, compradorId, texto) });
  } catch (err) {
    erro500(res, err);
  }
});

router.post("/api/shopee/chat/:shopId/:conversa/lida", requireLogin, json, async (req, res) => {
  try {
    await chat.marcarLida(req.params.shopId, req.params.conversa, req.body?.ultimaMensagemId);
    res.json({ ok: true });
  } catch (err) {
    erro500(res, err);
  }
});

router.get("/api/shopee/devolucoes", requireLogin, async (req, res) => {
  try {
    res.json(await devolucoes.listar({ forcar: req.query.forcar === "1" }));
  } catch (err) {
    erro500(res, err);
  }
});

// Coletor de prazos sobe junto com o modulo (assim server.js nao precisa
// de mais nenhuma linha). Sem chaves configuradas, cada ciclo so retorna.
if (process.env.NODE_ENV !== "test") {
  pedidos.iniciar();
  require("../tiny/embalagem").iniciar();
}

module.exports = router;
