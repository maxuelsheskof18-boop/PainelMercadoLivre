// Coleta dos pedidos Flex das contas conectadas no painel.
// Reaproveita o que o painel ja tem: lista de contas, renovacao de token e
// busca de pedidos. O unico pedaco proprio e a leitura do envio, porque o
// recurso /shipments quer o cabecalho "x-format-new" — o mlFetch de
// ml/api.js nao manda esse cabecalho e preferi nao mexer nele (mesmo
// motivo do rawGet em routes/prazos.js).
//
// Pipeline: pedido pago -> envio -> endereco do destinatario -> coordenada
// -> zona. O resultado fica em flex_estado para a tela ler.

const db = require("../db");
const { listAccounts, getValidAccessToken } = require("../ml/tokens");
const { fetchRecentOrders } = require("../ml/api");
const { geocodificar, consultarCep } = require("./geo");
const { classificarZona, extrairCidade } = require("./zonas");

const API_BASE = "https://api.mercadolibre.com";
const so = (s) => (s == null ? "" : String(s)).replace(/\D/g, "");

function tiposFlex() {
  return (process.env.FLEX_LOGISTIC_TYPES || "self_service")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function buscarEnvio(accessToken, shipmentId) {
  const res = await fetch(`${API_BASE}/shipments/${shipmentId}`, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "x-format-new": "true",
      // Mesmo motivo documentado em ml/api.js: sem User-Agent de navegador o
      // ML bloqueia como "robo" (403 PolicyAgent).
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "pt-BR,pt;q=0.9",
    },
  });
  const texto = await res.text();
  let dados = {};
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = {};
  }
  if (!res.ok) {
    const err = new Error(`shipments/${shipmentId} -> ${res.status} ${texto.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  return dados;
}

/* ---------------- estado (o que a tela le) ---------------- */
async function lerEstado() {
  const { rows } = await db.query("SELECT dados FROM flex_estado WHERE id = 'ultimo'");
  return rows[0]?.dados || { estado: "vazio", registros: [], mensagem: "Nenhuma coleta ainda." };
}

async function salvarEstado(dados) {
  await db.query(
    `INSERT INTO flex_estado (id, dados, atualizado_em) VALUES ('ultimo', $1, now())
     ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now()`,
    [dados]
  );
}

async function lerConfig() {
  const { rows } = await db.query("SELECT dados FROM flex_estado WHERE id = 'config'");
  return rows[0]?.dados || {};
}

async function salvarConfig(patch) {
  const novo = { ...(await lerConfig()), ...patch };
  await db.query(
    `INSERT INTO flex_estado (id, dados, atualizado_em) VALUES ('config', $1, now())
     ON CONFLICT (id) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now()`,
    [novo]
  );
  return novo;
}

/* ---------------- endereco do envio ----------------
   Com o cabecalho "x-format-new" o /shipments devolve o endereco em
   destination.shipping_address (e o nome/telefone em destination); o
   formato antigo usa receiver_address direto na raiz. Lemos os dois, e o
   diagnostico mostra qual veio — assim nao dependemos de adivinhar. */
// O telefone aparece como texto ("11 98888-7777") ou como objeto
// ({ area_code, number }) dependendo do formato. Juntar DDD + numero
// importa: so o numero reprovaria na validacao de 10/11 digitos e o
// telefone seria descartado em silencio.
function telefoneDe(v) {
  if (!v) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  const ddd = v.area_code || v.areaCode || "";
  const num = v.number || v.phone_number || "";
  return [ddd, num].filter(Boolean).join("");
}

function enderecoDoEnvio(envio) {
  const dest = envio.destination || {};
  const novo = dest.shipping_address || dest.receiver_address || null;
  const antigo = envio.receiver_address || null;
  const end = novo || antigo || {};
  return {
    end,
    formato: novo ? "destination.shipping_address" : antigo ? "receiver_address" : "nao encontrado",
    receiverName: dest.receiver_name || end.receiver_name || "",
    receiverPhone:
      telefoneDe(dest.receiver_phone) ||
      telefoneDe(end.receiver_phone) ||
      telefoneDe(end.phone) ||
      telefoneDe(dest.phone) ||
      "",
  };
}

/* ---------------- montagem de um pedido ---------------- */
async function montarRegistro(conta, pedido, envio, flexTypes) {
  const { end, receiverName, receiverPhone } = enderecoDoEnvio(envio);
  const logistic = String(envio.logistic_type || envio.logistic?.type || "").toLowerCase();

  const bairro = end.neighborhood?.name || end.neighborhood || "";
  const cidade = end.city?.name || end.city || "";
  const uf = String(end.state?.id || end.state?.name || end.state || "").replace(/^BR-/, "");
  const cep = end.zip_code || "";
  const rua =
    [end.street_name, end.street_number].filter(Boolean).join(", ") || end.address_line || "";

  let telefone = so(receiverPhone || telefoneDe(pedido.buyer?.phone) || "");
  if (telefone.length > 11 && telefone.startsWith("55")) telefone = telefone.slice(2);
  if (![10, 11].includes(telefone.length)) telefone = "";

  const itens = (pedido.order_items || []).map((it) => ({
    titulo: it.item?.title || "Produto",
    qtd: String(it.quantity ?? 1),
    sku: it.item?.seller_sku || it.item?.seller_custom_field || "",
    preco: it.unit_price != null ? String(it.unit_price) : "",
  }));

  const lat = end.latitude != null ? Number(end.latitude) : null;
  const lng = end.longitude != null ? Number(end.longitude) : null;

  let info = {};
  if (!bairro || !cidade) info = await consultarCep(so(cep));

  const region = [bairro || info.bairro, cidade || info.cidade].filter(Boolean).join(" - ") +
    (uf || info.uf ? "/" + (uf || info.uf) : "");

  return {
    pedido: String(pedido.id),
    pack: pedido.pack_id ? String(pedido.pack_id) : "",
    envio_id: String(envio.id || ""),
    conta: conta.nickname,
    conta_id: String(conta.id),
    valor: Number(pedido.total_amount) || null,
    nome:
      [pedido.buyer?.first_name, pedido.buyer?.last_name].filter(Boolean).join(" ") ||
      receiverName ||
      "",
    user: pedido.buyer?.nickname || "",
    quem: receiverName || "",
    telefone,
    whatsapp: telefone ? "55" + telefone : "",
    rua,
    comp: end.comment || end.delivery_preference || "",
    cep,
    bairro: bairro || info.bairro || "",
    cidade: cidade || info.cidade || "",
    uf: uf || info.uf || "SP",
    region,
    enderecoCompleto: [rua, region, cep, "Brasil"].filter(Boolean).join(", "),
    itens,
    prodComp: itens
      .map((p, k) => `${k + 1}_${p.titulo}_Q:${p.qtd}_Pr:${p.preco}-SKU:${p.sku}`)
      .join("| "),
    prodLala: itens.map((p) => `${p.qtd}x${p.titulo.substring(0, 15)}_${p.sku}`).join("|"),
    nome_loja: conta.nickname,
    flex: flexTypes.includes(logistic),
    logistic_type: logistic,
    tipoEnvio: logistic + (envio.substatus ? " · " + envio.substatus : ""),
    statusEnvio: envio.status || "",
    statusLista: [envio.status, envio.substatus].filter(Boolean).join(" / "),
    cancelado: envio.status === "cancelled" || pedido.status === "cancelled",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    geoFonte: Number.isFinite(lat) ? "mercado-livre" : "",
  };
}

/* ---------------- pipeline ---------------- */
let rodando = false;

async function coletar({ dias = Number(process.env.FLEX_DIAS) || 3 } = {}) {
  if (rodando) return await lerEstado();
  rodando = true;

  const flexTypes = tiposFlex();
  const registros = [];
  const falhas = [];
  const resumoContas = [];

  const progresso = (mensagem, estado = "coletando") =>
    salvarEstado({
      estado,
      mensagem,
      registros,
      falhas,
      contas: resumoContas,
      gerado_em: new Date().toISOString(),
    });

  try {
    const contas = await listAccounts();
    if (!contas.length) {
      await salvarEstado({
        estado: "erro",
        registros: [],
        mensagem: "Nenhuma conta conectada. Conecte as contas na tela principal do painel.",
      });
      return await lerEstado();
    }

    const desde = new Date(Date.now() - dias * 86400000).toISOString();

    for (const conta of contas) {
      await progresso(`Lendo pedidos de ${conta.nickname}...`);
      try {
        const token = await getValidAccessToken(conta.id);
        const limite = Number(process.env.FLEX_MAX_PEDIDOS) || 400;
        const pedidos = [];
        let offset = 0;
        let total = 0;

        while (offset < limite) {
          const r = await fetchRecentOrders(token, conta.id, {
            limit: 50,
            offset,
            dateCreatedFrom: desde,
          });
          const lote = r.results || [];
          total = r.paging?.total || 0;
          pedidos.push(...lote);
          offset += lote.length;
          if (lote.length < 50 || offset >= total) break;
        }

        const envios = new Map(); // pedidos do mesmo pacote dividem o envio
        let doFlex = 0;

        for (let i = 0; i < pedidos.length; i++) {
          const pedido = pedidos[i];
          if (pedido.status !== "paid") continue;
          const shipId = pedido.shipping?.id;
          if (!shipId) continue;
          if (i % 5 === 0) {
            await progresso(`${conta.nickname}: pedido ${i + 1} de ${pedidos.length}...`);
          }
          try {
            if (!envios.has(shipId)) envios.set(shipId, await buscarEnvio(token, shipId));
            const reg = await montarRegistro(conta, pedido, envios.get(shipId), flexTypes);
            registros.push(reg);
            if (reg.flex) doFlex++;
          } catch (e) {
            falhas.push({
              conta: conta.nickname,
              pedido: String(pedido.id),
              erro: String(e?.message || e),
            });
          }
        }

        resumoContas.push({
          nickname: conta.nickname,
          pedidos: pedidos.length,
          flex: doFlex,
          // Conta movimentada tem mais pedidos na janela do que o limite:
          // pegamos os mais recentes (a busca vem ordenada por data desc).
          truncado: total > pedidos.length ? total : 0,
        });
      } catch (e) {
        resumoContas.push({ nickname: conta.nickname, erro: String(e?.message || e) });
      }
    }

    /* Coordenada: so para os Flex, que sao os que vao para o mapa. O
       servico gratuito aceita 1 consulta por segundo — geocodificar os 800+
       pedidos de todos os tipos levaria mais de dez minutos a toa. */
    const paraLocalizar = registros.filter((r) => r.flex);
    await progresso(`Localizando ${paraLocalizar.length} enderecos Flex...`, "geocodificando");

    for (let i = 0; i < paraLocalizar.length; i++) {
      const reg = paraLocalizar[i];
      if (i % 5 === 0) {
        await progresso(
          `Localizando endereco ${i + 1} de ${paraLocalizar.length}...`,
          "geocodificando"
        );
      }
      if (!reg.lat) {
        try {
          const p = await geocodificar(reg);
          if (p) Object.assign(reg, p);
        } catch (e) {
          reg.geoErro = String(e?.message || e);
        }
      }
    }
    for (const reg of registros) {
      if (!reg.flex && !reg.geoFonte) reg.geoFonte = "nao-flex";
      reg.zona = classificarZona(reg);
    }

    const semGeo = paraLocalizar.filter((r) => !r.lat).length;
    const totalFlex = paraLocalizar.length;
    await salvarEstado({
      estado: "pronto",
      registros,
      falhas,
      contas: resumoContas,
      gerado_em: new Date().toISOString(),
      mensagem:
        `${registros.length} pedidos (${totalFlex} Flex) de ${resumoContas.length} conta(s) | ` +
        `${totalFlex - semGeo} Flex no mapa | ${semGeo} sem localizacao | ${falhas.length} falhas`,
    });
  } catch (e) {
    await salvarEstado({
      estado: "erro",
      registros,
      falhas,
      mensagem: String(e?.message || e),
    });
  } finally {
    rodando = false;
  }

  return await lerEstado();
}

/* ---------------------------------------------------------------
   DIAGNOSTICO — roda primeiro, com poucos pedidos, e responde:
   a API devolve telefone? devolve coordenada? qual logistic_type e o Flex?
   --------------------------------------------------------------- */
async function diagnosticar(conta, quantos = 10, dias = 7) {
  const token = await getValidAccessToken(conta.id);
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const r = await fetchRecentOrders(token, conta.id, { limit: quantos, dateCreatedFrom: desde });

  const linhas = [];
  const tipos = {};

  for (const pedido of r.results || []) {
    const shipId = pedido.shipping?.id;
    if (!shipId) continue;
    try {
      const envio = await buscarEnvio(token, shipId);
      const { end, formato, receiverPhone } = enderecoDoEnvio(envio);
      const logistic = String(envio.logistic_type || "").toLowerCase();
      tipos[logistic || "(vazio)"] = (tipos[logistic || "(vazio)"] || 0) + 1;

      const tel = so(receiverPhone);
      linhas.push({
        pedido: String(pedido.id),
        logistic_type: logistic,
        formato_do_endereco: formato,
        chaves_do_envio: Object.keys(envio).join(", "),
        chaves_do_endereco: Object.keys(end).join(", "),
        status: [envio.status, envio.substatus].filter(Boolean).join(" / "),
        tem_telefone: !!tel,
        telefone_mascarado: tel ? tel.slice(0, 2) + "*****" + tel.slice(-2) : "",
        tem_coordenada: end.latitude != null && end.longitude != null,
        tem_rua_e_numero: !!(end.street_name && end.street_number),
        bairro: end.neighborhood?.name || "",
        cidade: end.city?.name || "",
      });
    } catch (e) {
      linhas.push({ pedido: String(pedido.id), erro: String(e?.message || e) });
    }
  }

  return {
    conta: conta.nickname,
    pedidos_analisados: linhas.length,
    logistic_types_encontrados: tipos,
    flex_configurado_como: tiposFlex(),
    com_telefone: linhas.filter((l) => l.tem_telefone).length,
    com_coordenada: linhas.filter((l) => l.tem_coordenada).length,
    detalhe: linhas,
  };
}

module.exports = {
  coletar,
  diagnosticar,
  lerEstado,
  lerConfig,
  salvarConfig,
  montarRegistro,
  tiposFlex,
};
