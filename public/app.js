const state = {
  status: "pending",
  selectedPackId: null,
  pollTimer: null,
  onlyCombinar: false,
  searchQuery: "",
  sellerId: "",
  sort: "recent", // "recent" | "oldest"
  lastPendingCount: null, // usado pra saber se aumentou (tocar som) sem tocar no primeiro carregamento
  melhorEnvio: { connected: false, originPostalCode: null },
};

const listEl = document.getElementById("conversation-list");
const bellCount = document.getElementById("bell-count");
const tabCountPending = document.getElementById("tab-count-pending");
const tabCountNoContact = document.getElementById("tab-count-nocontact");
const tabCountDelivered = document.getElementById("tab-count-delivered");
const threadEmpty = document.getElementById("thread-empty");
const threadEl = document.getElementById("thread");
const threadBuyer = document.getElementById("thread-buyer");
const threadAvatar = document.getElementById("thread-avatar");
const threadAccount = document.getElementById("thread-account");
const orderCard = document.getElementById("thread-order-card");
const orderCardProduct = document.getElementById("order-card-product");
const orderCardMeta = document.getElementById("order-card-meta");
const orderCardLink = document.getElementById("order-card-link");
const threadDeliveryTag = document.getElementById("thread-delivery-tag");
const threadDeliveredTag = document.getElementById("thread-delivered-tag");
const threadMessages = document.getElementById("thread-messages");
const replyForm = document.getElementById("reply-form");
const replyText = document.getElementById("reply-text");
const filterCombinar = document.getElementById("filter-combinar");
const filterSearch = document.getElementById("filter-search");
const filterSeller = document.getElementById("filter-seller");
const filterSortBtn = document.getElementById("filter-sort-btn");
const filterSortIcon = document.getElementById("filter-sort-icon");
const filterSortLabel = document.getElementById("filter-sort-label");
const threadBackBtn = document.getElementById("thread-back");

const freightAccountBtn = document.getElementById("freight-account-btn");
const freightAccountLabel = document.getElementById("freight-account-label");
const freightBox = document.getElementById("freight-box");
const freightToggle = document.getElementById("freight-toggle");
const freightToggleArrow = document.getElementById("freight-toggle-arrow");
const freightForm = document.getElementById("freight-form");
const freightCep = document.getElementById("freight-cep");
const freightWeight = document.getElementById("freight-weight");
const freightHeight = document.getElementById("freight-height");
const freightWidth = document.getElementById("freight-width");
const freightLength = document.getElementById("freight-length");
const freightCalcBtn = document.getElementById("freight-calc-btn");
const freightResults = document.getElementById("freight-results");

const quickTemplates = document.getElementById("quick-templates");
const templateCombinarBtn = document.getElementById("template-combinar-btn");

const accountsBtn = document.getElementById("accounts-btn");
const accountsPanel = document.getElementById("accounts-panel");
const accountsList = document.getElementById("accounts-list");
const accountsCount = document.getElementById("accounts-count");

// Prefere o nome real do comprador (quando o Mercado Livre libera esse
// dado pro pedido); cai pro apelido, e por ultimo pro numero do comprador.
function buyerLabel(conv) {
  return conv.buyer_full_name || conv.buyer_nickname || "Comprador #" + (conv.buyer_id || "?");
}

// Formata um valor numerico como "R$ 149,90". Aceita null/undefined/string
// (o Postgres devolve NUMERIC como string em JSON) e devolve "" se nao der
// pra converter, pra nunca mostrar "R$ NaN" na tela.
function fmtMoney(value) {
  const n = Number(value);
  if (value == null || Number.isNaN(n)) return "";
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
}

// ---------- Avatares (gerados, sem precisar de imagem) ----------
const AVATAR_COLORS = ["#2563eb", "#7c3aed", "#db2777", "#d97706", "#059669", "#0891b2", "#dc2626", "#4f46e5"];
function avatarColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function avatarInitial(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}
function avatarHtml(label, extraClass) {
  return `<div class="avatar${extraClass ? " " + extraClass : ""}" style="background:${avatarColor(label)}">${avatarInitial(label)}</div>`;
}

function fmtDate(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString("pt-BR");
  } catch {
    return d;
  }
}

function fmtDateShort(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString("pt-BR");
  } catch {
    return d;
  }
}

// ---------- Som de notificacao ----------
// Toca um "ding" curto usando Web Audio, sem precisar de nenhum arquivo de
// audio externo. Navegadores só liberam som depois de alguma interacao do
// usuario na pagina (clique, toque) — por isso "destravamos" o contexto de
// audio no primeiro clique, pra os sons automaticos (do polling) tocarem
// sem problema depois.
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}
document.addEventListener(
  "click",
  () => {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === "suspended") ctx.resume();
  },
  { once: true }
);

function playNotificationSound() {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [
      [880, now, 0.11],
      [1320, now + 0.11, 0.16],
    ].forEach(([freq, start, dur]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    });
  } catch (e) {
    console.warn("Nao foi possivel tocar o som de notificacao:", e);
  }
}

// Se a sessao do painel expirou (ou ficou invalida por algum motivo), o
// servidor responde 401. Em vez de deixar a tela travada ou dar erro de
// "JSON invalido" tentando ler uma pagina de login como se fosse dado,
// manda direto pra tela de login de novo.
function handleSessionExpired(res) {
  if (res.status === 401) {
    window.location.href = "/login.html";
    return true;
  }
  return false;
}

async function loadPendingCount() {
  const res = await fetch("/api/pending-count");
  if (handleSessionExpired(res)) return;
  if (!res.ok) return;
  const data = await res.json();

  if (data.pending > 0) {
    tabCountPending.textContent = data.pending;
    tabCountPending.classList.remove("hidden");
  } else {
    tabCountPending.classList.add("hidden");
  }

  if (data.noContact > 0) {
    tabCountNoContact.textContent = data.noContact;
    tabCountNoContact.classList.remove("hidden");
  } else {
    tabCountNoContact.classList.add("hidden");
  }

  if (data.delivered > 0) {
    tabCountDelivered.textContent = data.delivered;
    tabCountDelivered.classList.remove("hidden");
  } else {
    tabCountDelivered.classList.add("hidden");
  }

  // O sino conta tudo que ainda precisa de resposta do vendedor — inclui as
  // mensagens de pedidos ja entregues (aba "Entregues"), que tambem sao
  // coisa pendente de responder, so que numa categoria separada.
  const totalPending = data.pending + data.delivered;
  if (totalPending > 0) {
    bellCount.textContent = totalPending;
    bellCount.classList.remove("hidden");
  } else {
    bellCount.classList.add("hidden");
  }

  // Toca o som so quando o numero de pendencias SOBE em relacao a ultima
  // vez que checamos (ou seja, chegou mensagem nova) — nunca no primeiro
  // carregamento da pagina (lastPendingCount ainda null) nem quando o
  // numero cai (conversa foi respondida).
  if (state.lastPendingCount !== null && totalPending > state.lastPendingCount) {
    playNotificationSound();
  }
  state.lastPendingCount = totalPending;
}

// Rotulo do status em portugues, usado na mensagem de "lista vazia".
function statusLabel(status) {
  if (status === "no_contact") return "sem contato ainda";
  if (status === "answered") return "respondida";
  if (status === "delivered") return "de pedido já entregue";
  return "pendente";
}

async function loadConversations() {
  listEl.innerHTML = '<p class="muted empty-msg">Carregando...</p>';
  const params = new URLSearchParams({ status: state.status, sort: state.sort });
  if (state.onlyCombinar) params.set("combinar", "1");
  if (state.sellerId) params.set("sellerId", state.sellerId);
  if (state.searchQuery) params.set("q", state.searchQuery);

  const res = await fetch(`/api/conversations?${params.toString()}`);
  if (handleSessionExpired(res)) return;
  if (!res.ok) {
    listEl.innerHTML = '<p class="muted empty-msg">Erro ao carregar.</p>';
    return;
  }
  const items = await res.json();

  if (items.length === 0) {
    const label = statusLabel(state.status);
    const msg = state.onlyCombinar
      ? `Nenhuma conversa de "combinar entrega" ${label}.`
      : `Nenhuma conversa ${label}.`;
    listEl.innerHTML = `<p class="muted empty-msg">${msg}</p>`;
    return;
  }

  listEl.innerHTML = "";
  for (const conv of items) {
    const div = document.createElement("div");
    const isUnread = conv.status === "pending" || conv.status === "no_contact";
    div.className =
      "conversation-item" +
      (conv.pack_id === state.selectedPackId ? " selected" : "") +
      (isUnread ? " unread" : "");
    const label = buyerLabel(conv);
    const preview = conv.last_message_text
      ? conv.last_message_text.slice(0, 90)
      : conv.status === "no_contact"
      ? "Nenhuma mensagem trocada ainda — inicie o contato"
      : "";
    div.innerHTML = `
      ${avatarHtml(label)}
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-buyer">${label}</span>
          <span class="ci-store">${conv.seller_nickname || ""}</span>
        </div>
        ${conv.product_title ? `<div class="ci-product">${conv.product_title}</div>` : ""}
        <div class="ci-preview">${preview}</div>
        <div class="ci-bottom">
          <span class="ci-date">${fmtDate(conv.last_message_date)}${conv.order_id ? ` · #${conv.order_id}` : ""}${fmtMoney(conv.order_total) ? ` · ${fmtMoney(conv.order_total)}` : ""}</span>
          ${conv.is_delivered ? '<span class="tag tag-delivered">Pedido já entregue</span>' : conv.is_combinar_entrega ? '<span class="tag tag-delivery">Combinar entrega</span>' : ""}
        </div>
      </div>
    `;
    div.addEventListener("click", () => openThread(conv));
    listEl.appendChild(div);
  }
}

function openMobileThread() {
  document.body.classList.add("thread-open");
}
function closeMobileThread() {
  document.body.classList.remove("thread-open");
}

// Preenche o cabecalho e o card de detalhes do pedido a partir de um
// objeto de conversa. Chamada duas vezes: uma na hora (com o dado que ja
// tinhamos na lista) e outra depois que a resposta do servidor chega
// (que pode ter enriquecido produto/comprador/tipo de entrega na hora).
function renderThreadInfo(conv) {
  const label = buyerLabel(conv);
  threadBuyer.textContent = label;
  threadAvatar.innerHTML = "";
  threadAvatar.style.background = avatarColor(label);
  threadAvatar.textContent = avatarInitial(label);
  const accountBits = [];
  if (conv.seller_nickname) accountBits.push(`Loja: ${conv.seller_nickname}`);
  if (conv.order_id) accountBits.push(`Pedido #${conv.order_id}`);
  threadAccount.textContent = accountBits.join(" · ");
  threadDeliveryTag.classList.toggle("hidden", !conv.is_combinar_entrega);
  threadDeliveredTag.classList.toggle("hidden", !conv.is_delivered);
  // O atalho da mensagem padrao de "combinar entrega" so faz sentido pra
  // pedidos classificados assim — nos outros, fica escondido.
  quickTemplates.classList.toggle("hidden", !conv.is_combinar_entrega);

  if (conv.product_title || conv.order_id) {
    orderCard.classList.remove("hidden");
    orderCardProduct.textContent = conv.product_title || "Produto nao identificado";
    const orderMetaBits = [];
    if (conv.order_id) orderMetaBits.push(`Pedido #${conv.order_id}`);
    const orderTotalLabel = fmtMoney(conv.order_total);
    if (orderTotalLabel) orderMetaBits.push(orderTotalLabel);
    orderCardMeta.textContent = orderMetaBits.join(" · ");
    if (conv.order_id) {
      orderCardLink.href = `https://www.mercadolivre.com.br/vendas/${conv.order_id}/detalhe`;
      orderCardLink.classList.remove("hidden");
    } else {
      orderCardLink.classList.add("hidden");
    }
  } else {
    orderCard.classList.add("hidden");
  }

  // A caixa de calcular frete so aparece se o Melhor Envio ja foi
  // conectado. Toda vez que abre uma conversa (ou troca de conversa), a
  // caixa comeca fechada e limpa — o CEP de destino e sempre digitado na
  // hora, ja que nao vem estruturado do Mercado Livre pra pedidos de
  // "combinar entrega".
  freightBox.classList.toggle("hidden", !state.melhorEnvio.connected);
  freightForm.classList.add("hidden");
  freightToggleArrow.textContent = "▾";
  freightResults.innerHTML = "";
  freightCep.value = "";
}

async function loadMelhorEnvioStatus() {
  try {
    const res = await fetch("/api/melhorenvio/status");
    if (handleSessionExpired(res)) return;
    if (!res.ok) return;
    state.melhorEnvio = await res.json();
  } catch (e) {
    console.warn("Nao foi possivel checar o status do Melhor Envio:", e);
    return;
  }

  if (state.melhorEnvio.connected) {
    freightAccountLabel.textContent = "Melhor Envio ✓";
    freightAccountBtn.classList.add("btn-connected");
    freightAccountBtn.title = "Melhor Envio conectado — clique pra ver/editar o CEP de origem";
  } else {
    freightAccountLabel.textContent = "Melhor Envio";
    freightAccountBtn.classList.remove("btn-connected");
    freightAccountBtn.title = "Conectar Melhor Envio pra calcular frete";
  }

  // Se a conversa atual ja estiver aberta, atualiza a visibilidade da caixa
  // de frete sem precisar reabrir a conversa.
  if (!threadEl.classList.contains("hidden")) {
    freightBox.classList.toggle("hidden", !state.melhorEnvio.connected);
  }
}

// Lista as contas do Mercado Livre ja conectadas (o usuario perguntou como
// saber isso — antes so dava pra perceber pelo nome da loja em cada
// conversa). Atualiza o numero no botao e, se o painel estiver aberto,
// tambem a lista detalhada.
async function loadAccounts() {
  const res = await fetch("/api/accounts");
  if (handleSessionExpired(res)) return [];
  if (!res.ok) return [];
  const accounts = await res.json();

  if (accounts.length > 0) {
    accountsCount.textContent = accounts.length;
    accountsCount.classList.remove("hidden");
  } else {
    accountsCount.classList.add("hidden");
  }

  if (accounts.length === 0) {
    accountsList.innerHTML =
      '<p class="muted small" style="padding: 10px 14px;">Nenhuma conta conectada ainda.</p>';
  } else {
    accountsList.innerHTML = accounts
      .map(
        (a) => `
      <div class="account-row">
        <span class="account-row-name">${a.nickname || a.id}</span>
        <span class="account-row-since">Conectada em ${fmtDateShort(a.created_at)}</span>
      </div>`
      )
      .join("");
  }

  // Popula o filtro de "loja" na lista de conversas, preservando a opcao
  // ja selecionada (se ainda existir depois de recarregar).
  const previousSelection = filterSeller.value;
  filterSeller.innerHTML =
    '<option value="">Todas as lojas</option>' +
    accounts.map((a) => `<option value="${a.id}">${a.nickname || a.id}</option>`).join("");
  if (accounts.some((a) => String(a.id) === previousSelection)) {
    filterSeller.value = previousSelection;
  }

  return accounts;
}

accountsBtn.addEventListener("click", async () => {
  const willShow = accountsPanel.classList.contains("hidden");
  accountsPanel.classList.toggle("hidden", !willShow);
  if (willShow) await loadAccounts();
});

// Fecha o painel se o usuario clicar em qualquer outro lugar da tela.
document.addEventListener("click", (e) => {
  if (!accountsPanel.classList.contains("hidden") && !e.target.closest(".accounts-dropdown")) {
    accountsPanel.classList.add("hidden");
  }
});

freightAccountBtn.addEventListener("click", async () => {
  if (!state.melhorEnvio.connected) {
    window.location.href = "/melhorenvio/connect";
    return;
  }
  const current = state.melhorEnvio.originPostalCode || "";
  const novo = prompt(
    "CEP de origem (de onde os pacotes saem) pra calcular o frete no Melhor Envio:",
    current
  );
  if (novo === null) return; // cancelou
  await fetch("/api/melhorenvio/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ originPostalCode: novo.trim() }),
  });
  await loadMelhorEnvioStatus();
});

freightToggle.addEventListener("click", () => {
  const willShow = freightForm.classList.contains("hidden");
  freightForm.classList.toggle("hidden", !willShow);
  freightToggleArrow.textContent = willShow ? "▴" : "▾";
});

freightCalcBtn.addEventListener("click", async () => {
  const toPostalCode = freightCep.value.trim();
  if (!toPostalCode) {
    freightResults.innerHTML = '<p class="freight-msg freight-error">Informe o CEP de destino.</p>';
    return;
  }

  freightCalcBtn.disabled = true;
  freightResults.innerHTML = '<p class="freight-msg muted">Calculando...</p>';
  try {
    const res = await fetch("/api/melhorenvio/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toPostalCode,
        weight: freightWeight.value,
        height: freightHeight.value,
        width: freightWidth.value,
        length: freightLength.value,
      }),
    });
    if (handleSessionExpired(res)) return;
    const data = await res.json();
    if (!res.ok) {
      freightResults.innerHTML = `<p class="freight-msg freight-error">${data.error || "Falha ao calcular o frete."}</p>`;
      return;
    }
    if (!data.options || data.options.length === 0) {
      freightResults.innerHTML = '<p class="freight-msg muted">Nenhuma opcao de frete encontrada pra esse CEP/pacote.</p>';
      return;
    }
    freightResults.innerHTML = data.options
      .map(
        (o) => `
      <div class="freight-option" data-price="${o.price}" data-delivery="${o.deliveryTime ?? ""}" title="Clique para preencher a mensagem com esse valor">
        <span class="freight-option-name">${o.company ? o.company + " — " : ""}${o.name}</span>
        <span class="freight-option-time muted">${o.deliveryTime ? o.deliveryTime + " dia(s) util" : ""}</span>
        <span class="freight-option-price">R$ ${o.price.toFixed(2).replace(".", ",")}</span>
        <span class="freight-option-hint">usar ➜</span>
      </div>`
      )
      .join("");
  } catch (e) {
    freightResults.innerHTML = '<p class="freight-msg freight-error">Falha ao calcular o frete.</p>';
  } finally {
    freightCalcBtn.disabled = false;
  }
});

// Margem que o vendedor cobra em cima do valor cotado no Melhor Envio, em
// escalonamento por faixa de preco (pedido explicitamente pelo vendedor):
//   - ate R$ 50,00 de frete: soma R$ 10,00 fixos
//   - de R$ 50,01 ate R$ 100,00: soma 20% do valor do frete
//   - acima de R$ 100,00: soma 15% do valor do frete
// O valor final (ja com a margem) e o que entra na mensagem pro comprador.
function applyFreightMarkup(basePrice) {
  if (basePrice <= 50) return basePrice + 10;
  if (basePrice <= 100) return basePrice * 1.2;
  return basePrice * 1.15;
}

function pluralDias(n) {
  const num = Number(n);
  if (!num || Number.isNaN(num)) return "";
  return num === 1 ? "1 dia útil" : `${num} dias úteis`;
}

// Mensagem padrao que o vendedor usa pra avisar o comprador do frete
// combinado. Os campos "Prazo de entrega" e "Valor" vem da cotacao clicada
// (com a margem ja aplicada no valor).
function buildFreightMessage({ deliveryTime, finalPrice }) {
  const prazo = pluralDias(deliveryTime);
  return `Calculamos o frete para o seu endereço:
- Prazo de entrega: ${prazo}
- Valor: ${fmtMoney(finalPrice)}
Para fazer o pagamento verifique as opções disponíveis nos detalhes da compra ou confira o atalho nas mensagens do chat (Se disponível)
ATENÇÃO: Esperamos sua confirmação de pagamento`;
}

// Clicar numa cotacao ja calculada preenche a caixa de resposta com a
// mensagem padrao (com a margem escalonada ja aplicada) e fecha a
// calculadora — assim o vendedor so confere e clica "Enviar", e a tela
// volta a mostrar a conversa inteira (sem a calculadora ocupando espaco).
freightResults.addEventListener("click", (e) => {
  const optionEl = e.target.closest(".freight-option");
  if (!optionEl) return;

  const basePrice = Number(optionEl.dataset.price);
  if (!basePrice || Number.isNaN(basePrice)) return;
  const finalPrice = applyFreightMarkup(basePrice);

  replyText.value = buildFreightMessage({
    deliveryTime: optionEl.dataset.delivery,
    finalPrice,
  });
  replyText.focus();

  // Fecha a calculadora: o espaco todo volta pra conversa, que e o que o
  // vendedor precisa ver agora pra conferir e enviar a mensagem.
  freightForm.classList.add("hidden");
  freightToggleArrow.textContent = "▾";
});

// Mensagem padrao explicando a modalidade "combinar entrega" (retirada ou
// entrega com frete a parte) pro comprador que ainda nao sabe como
// prosseguir. Fixa, sem calculo nenhum — o vendedor pediu pra ter um atalho
// que preenche isso na hora, principalmente pros pedidos da aba "Sem
// contato" (que nunca receberam mensagem nenhuma).
const COMBINAR_ENTREGA_TEMPLATE = `Olá! Você comprou na modalidade *Combinar entrega com o vendedor*.
Você pode:
1. Retirar grátis no CEP 03055-000,Brás próximo ao Templo de Salomão; ou
2. Receber no seu endereço, com frete à parte.
Para cotação:
Cep:
N°:
Rua:
telefone:
Cpf:
Atendimento: seg. a sex., das 9h às 18h.
Qualquer duvida estamos a disposição.`;

templateCombinarBtn.addEventListener("click", () => {
  // So confirma antes de sobrescrever se ja tem algo digitado — assim nao
  // se perde uma resposta que o vendedor ja estava escrevendo por engano.
  if (replyText.value.trim() && !confirm("Isso vai substituir o texto que voce ja escreveu. Continuar?")) {
    return;
  }
  replyText.value = COMBINAR_ENTREGA_TEMPLATE;
  replyText.focus();
});

function renderMessages(messages) {
  threadMessages.innerHTML = "";
  if (messages.length === 0) {
    threadMessages.innerHTML =
      '<p class="muted centered">Nenhuma mensagem trocada ainda. Escreva abaixo pra iniciar o contato.</p>';
    return;
  }
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = "msg " + (m.direction === "out" ? "msg-out" : "msg-in");
    div.innerHTML = `<div class="msg-text"></div><div class="msg-date">${fmtDate(m.sent_date)}</div>`;
    div.querySelector(".msg-text").textContent = m.text || "";
    threadMessages.appendChild(div);
  }
  threadMessages.scrollTop = threadMessages.scrollHeight;
}

// Busca as mensagens (e o resto dos dados) de uma conversa e atualiza a
// tela do chat que ja esta aberta — usada tanto ao abrir uma conversa
// quanto para atualizar a mesma conversa depois de enviar uma resposta
// (sem fechar/trocar de tela, como um chat de verdade).
async function loadThreadMessages(packId) {
  const res = await fetch(`/api/conversations/${encodeURIComponent(packId)}/messages`);
  if (handleSessionExpired(res)) return false;
  if (!res.ok) {
    threadMessages.innerHTML = '<p class="muted">Erro ao carregar as mensagens.</p>';
    return false;
  }
  const data = await res.json();

  // O servidor pode ter descoberto produto/comprador/tipo de entrega na
  // hora (conversa antiga que ainda nao tinha esses dados) — atualiza o
  // cabecalho com essa versao mais completa.
  if (data.conversation) renderThreadInfo(data.conversation);

  renderMessages(data.messages || []);
  return true;
}

async function openThread(conv) {
  state.selectedPackId = conv.pack_id;
  document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("selected"));

  threadEmpty.classList.add("hidden");
  threadEl.classList.remove("hidden");
  renderThreadInfo(conv);
  threadMessages.innerHTML = '<p class="muted">Carregando mensagens...</p>';
  replyForm.dataset.packId = conv.pack_id;
  openMobileThread();

  await loadThreadMessages(conv.pack_id);
  await loadConversations();
}

threadBackBtn.addEventListener("click", () => {
  closeMobileThread();
});

replyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const packId = replyForm.dataset.packId;
  const text = replyText.value.trim();
  if (!packId || !text) return;

  const btn = replyForm.querySelector("button");
  btn.disabled = true;
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(packId)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (handleSessionExpired(res)) return;
    const data = await res.json();
    if (!res.ok) {
      if (data.blocked) {
        // Bloqueio permanente (reembolso, mediacao encerrada, etc.) — o
        // servidor ja marcou essa conversa como "blocked" no banco, entao
        // ela nao aparece mais em Pendentes nem Respondidas. Avisa e fecha
        // a tela do chat, em vez de deixar o usuario tentando de novo a toa.
        alert(
          `Este pedido foi bloqueado pelo Mercado Livre para novas mensagens (${
            data.blockReasonLabel || data.blockReason || "motivo nao informado"
          }) e foi removido da lista de pendentes.`
        );
        threadEl.classList.add("hidden");
        threadEmpty.classList.remove("hidden");
        state.selectedPackId = null;
        closeMobileThread();
        await Promise.all([loadConversations(), loadPendingCount()]);
        return;
      }
      const detail = typeof data.detail === "string" ? data.detail : "";
      alert((data.error || "Falha ao enviar a mensagem.") + (detail ? `\n\nMotivo: ${detail}` : ""));
      return;
    }
    replyText.value = "";
    // Continua na mesma conversa (igual um chat de verdade), so atualizando
    // as mensagens e a lista ao lado — nao fecha nem volta pra tela inicial.
    if (packId === state.selectedPackId) {
      await loadThreadMessages(packId);
    }
    await Promise.all([loadConversations(), loadPendingCount()]);
  } finally {
    btn.disabled = false;
  }
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.status = tab.dataset.status;
    loadConversations();
  });
});

filterCombinar.addEventListener("change", () => {
  state.onlyCombinar = filterCombinar.checked;
  loadConversations();
});

// Busca livre: espera o usuario parar de digitar (300ms) antes de recarregar
// a lista, pra nao mandar uma requisicao a cada letra.
let searchDebounceTimer = null;
filterSearch.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.searchQuery = filterSearch.value.trim();
    loadConversations();
  }, 300);
});

filterSeller.addEventListener("change", () => {
  state.sellerId = filterSeller.value;
  loadConversations();
});

filterSortBtn.addEventListener("click", () => {
  state.sort = state.sort === "recent" ? "oldest" : "recent";
  if (state.sort === "oldest") {
    filterSortIcon.textContent = "⬆";
    filterSortLabel.textContent = "Mais antigas";
  } else {
    filterSortIcon.textContent = "⬇";
    filterSortLabel.textContent = "Mais recentes";
  }
  loadConversations();
});

document.getElementById("sync-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const label = btn.querySelector(".btn-label");
  if (label) label.textContent = "Atualizando...";
  try {
    await fetch("/api/sync", { method: "POST" });
    await Promise.all([loadConversations(), loadPendingCount()]);
  } finally {
    btn.disabled = false;
    if (label) label.textContent = "Atualizar";
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/logout", { method: "POST" });
  window.location.href = "/login.html";
});

document.getElementById("bell").addEventListener("click", () => {
  document.querySelector('.tab[data-status="pending"]').click();
});

// Carga inicial + verificacao periodica (sem precisar de webhook/servidor
// mandando nada pro navegador: o proprio navegador pergunta de tempos em
// tempos enquanto a aba estiver aberta).
loadConversations();
loadPendingCount();
loadAccounts();
loadMelhorEnvioStatus().then(() => {
  // Acabou de voltar do OAuth do Melhor Envio (?me_connected=1) e ainda nao
  // tem CEP de origem configurado — pede de uma vez, pra nao precisar
  // lembrar de clicar no botao depois.
  const params = new URLSearchParams(window.location.search);
  if (params.get("me_connected") === "1") {
    window.history.replaceState({}, "", window.location.pathname);
    if (state.melhorEnvio.connected && !state.melhorEnvio.originPostalCode) {
      freightAccountBtn.click();
    } else {
      alert("Melhor Envio conectado!");
    }
  }
});
setInterval(loadPendingCount, 20000);
setInterval(() => {
  if (!state.selectedPackId) loadConversations();
}, 30000);
