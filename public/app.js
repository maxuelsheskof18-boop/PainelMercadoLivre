const state = {
  module: "messages", // "messages" | "claims" | "history" — qual painel (menu lateral) esta ativo
  status: "pending", // aba dentro do modulo "messages"
  claimStatus: "pending", // aba dentro do modulo "claims": "pending" | "answered" | "closed"
  selectedPackId: null,
  selectedClaimId: null, // reclamacao aberta no momento (mutuamente exclusivo com selectedPackId)
  pollTimer: null,
  onlyCombinar: false,
  onlyPending: false, // "Só pendentes (a responder)" — vale pras duas telas (mensagens e reclamacoes)
  searchQuery: "",
  sellerId: "",
  sort: "recent", // "recent" | "oldest"
  lastPendingCount: null, // usado pra saber se aumentou (tocar som) sem tocar no primeiro carregamento
  melhorEnvio: { connected: false, originPostalCode: null },
};

const listEl = document.getElementById("conversation-list");
const bellCount = document.getElementById("bell-count");
const moduleNavItems = document.querySelectorAll(".module-nav-item");
const moduleBadgeMessages = document.getElementById("module-badge-messages");
const moduleBadgeClaims = document.getElementById("module-badge-claims");
const tabsMessages = document.getElementById("tabs-messages");
const tabsClaims = document.getElementById("tabs-claims");
const layoutEl = document.querySelector(".layout");
const moduleNav = document.getElementById("module-nav");
const moduleNavToggle = document.getElementById("module-nav-toggle");
const moduleNavToggleLabel = moduleNavToggle ? moduleNavToggle.querySelector(".module-nav-toggle-label") : null;
const tabCountPending = document.getElementById("tab-count-pending");
const tabCountNoContact = document.getElementById("tab-count-nocontact");
const tabCountDelivered = document.getElementById("tab-count-delivered");
const tabCountClaimsPending = document.getElementById("tab-count-claims-pending");
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
const threadShippingTag = document.getElementById("thread-shipping-tag");
const threadClaimStageTag = document.getElementById("thread-claim-stage-tag");
const claimDueBanner = document.getElementById("claim-due-banner");
const claimInfoCard = document.getElementById("claim-info-card");
const claimInfoTitle = document.getElementById("claim-info-title");
const claimInfoMeta = document.getElementById("claim-info-meta");
const claimInfoLink = document.getElementById("claim-info-link");
const threadMessages = document.getElementById("thread-messages");
const replyForm = document.getElementById("reply-form");
const replyText = document.getElementById("reply-text");
const replyAttachBtn = document.getElementById("reply-attach-btn");
const replyAttachmentInput = document.getElementById("reply-attachment");
const replyAttachmentNameEl = document.getElementById("reply-attachment-name");
const filterCombinar = document.getElementById("filter-combinar");
const filterOnlyPending = document.getElementById("filter-only-pending");
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

const evidenceBox = document.getElementById("evidence-box");
const evidenceToggle = document.getElementById("evidence-toggle");
const evidenceToggleArrow = document.getElementById("evidence-toggle-arrow");
const evidenceForm = document.getElementById("evidence-form");
const evidenceMethodSelect = document.getElementById("evidence-method");
const evidenceSendBtn = document.getElementById("evidence-send-btn");
const evidenceResults = document.getElementById("evidence-results");

const accountsBtn = document.getElementById("accounts-btn");
const accountsPanel = document.getElementById("accounts-panel");
const accountsList = document.getElementById("accounts-list");
const accountsCount = document.getElementById("accounts-count");

// Identificacao do operador (varias pessoas usando o mesmo login/senha).
const OPERATOR_STORAGE_KEY = "ml-painel-operator-name";
const operatorModal = document.getElementById("operator-modal");
const operatorModalForm = document.getElementById("operator-modal-form");
const operatorNameInput = document.getElementById("operator-name-input");
const operatorModalClose = document.getElementById("operator-modal-close");
const operatorChip = document.getElementById("operator-chip");
const operatorChipName = document.getElementById("operator-chip-name");

// Modulo "Histórico" (quem respondeu o que, e quando).
const listPaneEl = document.getElementById("list-pane");
const threadPaneEl = document.getElementById("thread-pane");
const historyPane = document.getElementById("history-pane");
const historyList = document.getElementById("history-list");
const historyOperatorFilter = document.getElementById("history-operator-filter");
const historyFrom = document.getElementById("history-from");
const historyTo = document.getElementById("history-to");
const historyRefreshBtn = document.getElementById("history-refresh-btn");

// Nao e login: nao ha senha por pessoa, e nao bloqueia nada no servidor —
// e so uma identificacao pra saber, depois, quem respondeu cada mensagem
// (mandada junto em cada envio; ver rotas /reply e /evidence no backend).
function getOperatorName() {
  try {
    return localStorage.getItem(OPERATOR_STORAGE_KEY) || "";
  } catch (e) {
    return "";
  }
}

function setOperatorName(name) {
  try {
    localStorage.setItem(OPERATOR_STORAGE_KEY, name);
  } catch (e) {
    // sem localStorage: continua funcionando nesta sessao, so nao lembra
    // da proxima vez que abrir o painel nesse aparelho.
  }
  if (operatorChipName) operatorChipName.textContent = name;
}

function openOperatorModal(mandatory) {
  operatorNameInput.value = mandatory ? "" : getOperatorName();
  if (operatorModalClose) operatorModalClose.classList.toggle("hidden", mandatory);
  operatorModal.classList.remove("hidden");
  setTimeout(() => operatorNameInput.focus(), 50);
}

function closeOperatorModal() {
  operatorModal.classList.add("hidden");
}

if (operatorModalForm) {
  operatorModalForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = operatorNameInput.value.trim();
    if (!name) return;
    setOperatorName(name);
    closeOperatorModal();
  });
}
if (operatorModalClose) {
  operatorModalClose.addEventListener("click", () => closeOperatorModal());
}
if (operatorChip) {
  // Deixa trocar de operador a qualquer momento (ex: troca de turno) sem
  // precisar limpar o navegador.
  operatorChip.addEventListener("click", () => openOperatorModal(false));
}

// Ao abrir o painel: se ninguem se identificou ainda neste aparelho, pede o
// nome antes de liberar o uso (sem senha nenhuma — so essa identificacao).
const existingOperatorName = getOperatorName();
if (existingOperatorName) {
  operatorChipName.textContent = existingOperatorName;
} else {
  openOperatorModal(true);
}

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

  if (data.claims > 0) {
    tabCountClaimsPending.textContent = data.claims;
    tabCountClaimsPending.classList.remove("hidden");
  } else {
    tabCountClaimsPending.classList.add("hidden");
  }

  // Os badges dos dois itens do menu lateral (modulos) somam tudo que
  // precisa de acao dentro de cada um, pra dar pra ver de relance qual dos
  // dois painéis tem coisa pendente sem precisar entrar em nenhum dos dois.
  const messagesPending = data.pending + data.delivered;
  if (messagesPending > 0) {
    moduleBadgeMessages.textContent = messagesPending;
    moduleBadgeMessages.classList.remove("hidden");
  } else {
    moduleBadgeMessages.classList.add("hidden");
  }

  if (data.claims > 0) {
    moduleBadgeClaims.textContent = data.claims;
    moduleBadgeClaims.classList.remove("hidden");
  } else {
    moduleBadgeClaims.classList.add("hidden");
  }

  // O sino conta tudo que ainda precisa de resposta do vendedor — inclui as
  // mensagens de pedidos ja entregues (aba "Entregues") e as reclamacoes
  // aguardando resposta, que tambem sao coisa pendente, so que em categorias
  // separadas.
  const totalPending = data.pending + data.delivered + (data.claims || 0);
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
  if (state.onlyPending) params.set("onlyPending", "1");
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
    const label = state.onlyPending ? "a responder" : statusLabel(state.status);
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
          ${conv.shipping_type ? `<span class="tag tag-shipping">${conv.shipping_type}</span>` : ""}
        </div>
      </div>
    `;
    div.addEventListener("click", () => openThread(conv));
    listEl.appendChild(div);
  }
}

// ---------- Reclamacoes (Central de Resolucoes/mediacao) ----------
// Sistema SEPARADO das conversas de mensagens pos-venda acima — tem seu
// proprio endpoint (/api/claims), formato de dado e regras (ver
// backend/claimsSync.js e backend/ml/claimsApi.js).
const CLAIM_TYPE_LABELS = {
  mediations: "Mediação",
  cancel_purchase: "Cancelamento de compra",
  return: "Devolução",
  cancel_sale: "Cancelamento de venda",
};
const CLAIM_STAGE_LABELS = {
  claim: "Reclamação",
  dispute: "Em mediação (Mercado Livre)",
  recontact: "Recontato",
  none: "Reclamação",
};

function claimTypeLabel(claim) {
  return CLAIM_TYPE_LABELS[claim.type] || claim.type || "Reclamação";
}
function claimStageLabel(claim) {
  return CLAIM_STAGE_LABELS[claim.stage] || claim.stage || "Reclamação";
}

function loadList() {
  return state.module === "claims" ? loadClaims() : loadConversations();
}

async function loadClaims() {
  listEl.innerHTML = '<p class="muted empty-msg">Carregando...</p>';
  const params = new URLSearchParams({ status: state.claimStatus });
  if (state.onlyPending) params.set("onlyPending", "1");
  if (state.sellerId) params.set("sellerId", state.sellerId);
  if (state.searchQuery) params.set("q", state.searchQuery);

  const res = await fetch(`/api/claims?${params.toString()}`);
  if (handleSessionExpired(res)) return;
  if (!res.ok) {
    listEl.innerHTML = '<p class="muted empty-msg">Erro ao carregar.</p>';
    return;
  }
  const items = await res.json();

  if (items.length === 0) {
    const label = state.onlyPending
      ? "a responder"
      : state.claimStatus === "closed"
      ? "fechada"
      : state.claimStatus === "answered"
      ? "respondida"
      : "pendente";
    listEl.innerHTML = `<p class="muted empty-msg">Nenhuma reclamação ${label}.</p>`;
    return;
  }

  listEl.innerHTML = "";
  for (const claim of items) {
    const div = document.createElement("div");
    const isUnread = claim.local_status === "pending";
    div.className =
      "conversation-item" +
      (claim.claim_id === state.selectedClaimId ? " selected" : "") +
      (isUnread ? " unread" : "");
    const label = claim.buyer_full_name || "Comprador #" + (claim.buyer_id || "?");
    const preview = claim.last_message_text
      ? claim.last_message_text.slice(0, 90)
      : "Reclamação aberta — nenhuma mensagem trocada ainda";
    div.innerHTML = `
      ${avatarHtml(label)}
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-buyer">${label}</span>
          <span class="ci-store">${claim.seller_nickname || ""}</span>
        </div>
        ${claim.product_title ? `<div class="ci-product">${claim.product_title}</div>` : ""}
        <div class="ci-preview">${preview}</div>
        <div class="ci-bottom">
          <span class="ci-date">${fmtDate(claim.last_message_date)}${claim.order_id ? ` · #${claim.order_id}` : ""}</span>
          ${claim.shipping_type ? `<span class="tag tag-shipping">${claim.shipping_type}</span>` : ""}
          <span class="tag tag-claim">${claimTypeLabel(claim)}</span>
        </div>
      </div>
    `;
    div.addEventListener("click", () => openClaimThread(claim));
    listEl.appendChild(div);
  }
}

function renderClaimThreadInfo(claim) {
  const label = claim.buyer_full_name || "Comprador #" + (claim.buyer_id || "?");
  threadBuyer.textContent = label;
  threadAvatar.innerHTML = "";
  threadAvatar.style.background = avatarColor(label);
  threadAvatar.textContent = avatarInitial(label);
  const accountBits = [];
  if (claim.seller_nickname) accountBits.push(`Loja: ${claim.seller_nickname}`);
  if (claim.order_id) accountBits.push(`Pedido #${claim.order_id}`);
  threadAccount.textContent = accountBits.join(" · ");

  // Tags/atalhos das conversas de mensagens nao fazem sentido aqui — exceto
  // o tipo de envio (Flex/Agência/etc.), que existe pras duas coisas.
  threadDeliveryTag.classList.add("hidden");
  threadDeliveredTag.classList.add("hidden");
  threadShippingTag.textContent = claim.shipping_type || "-";
  threadShippingTag.classList.toggle("hidden", !claim.shipping_type);
  quickTemplates.classList.add("hidden");
  freightBox.classList.add("hidden");
  orderCard.classList.add("hidden");

  threadClaimStageTag.textContent = claimStageLabel(claim);
  threadClaimStageTag.classList.remove("hidden");

  if (claim.mandatory_action && claim.due_date) {
    claimDueBanner.textContent = `⏰ Ação necessária até ${fmtDate(claim.due_date)} — responda ou envie o que for pedido antes do prazo.`;
    claimDueBanner.classList.remove("hidden");
  } else {
    claimDueBanner.classList.add("hidden");
  }

  claimInfoCard.classList.remove("hidden");
  claimInfoTitle.textContent = claim.product_title || claimTypeLabel(claim);
  const metaBits = [claimTypeLabel(claim)];
  if (claim.reason_id) metaBits.push(`Motivo: ${claim.reason_id}`);
  if (claim.order_id) metaBits.push(`Pedido #${claim.order_id}`);
  const totalLabel = fmtMoney(claim.order_total);
  if (totalLabel) metaBits.push(totalLabel);
  claimInfoMeta.textContent = metaBits.join(" · ");
  if (claim.order_id) {
    claimInfoLink.href = `https://www.mercadolivre.com.br/vendas/${claim.order_id}/detalhe`;
    claimInfoLink.classList.remove("hidden");
  } else {
    claimInfoLink.classList.add("hidden");
  }

  evidenceBox.classList.remove("hidden");
  evidenceForm.classList.add("hidden");
  evidenceToggleArrow.textContent = "▾";
  evidenceResults.innerHTML = "";

  replyAttachBtn.classList.remove("hidden");
  replyAttachBtn.title = "Anexar arquivo (JPG, PNG, PDF ou TXT, até 5MB)";
  replyAttachmentInput.value = "";
  replyAttachmentNameEl.classList.add("hidden");
}

function renderClaimMessages(messages) {
  threadMessages.innerHTML = "";
  if (messages.length === 0) {
    threadMessages.innerHTML =
      '<p class="muted centered">Nenhuma mensagem trocada ainda nesta reclamação.</p>';
    return;
  }
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = "msg " + (m.sender_role === "respondent" ? "msg-out" : "msg-in");
    const roleLabel =
      m.sender_role === "respondent" ? "Você" : m.sender_role === "mediator" ? "Mercado Livre" : "Comprador";
    div.innerHTML = `<div class="msg-text"></div><div class="msg-date">${roleLabel} · ${fmtDate(m.sent_date)}</div>`;
    div.querySelector(".msg-text").textContent = m.message || "";
    threadMessages.appendChild(div);
  }
  threadMessages.scrollTop = threadMessages.scrollHeight;
}

async function loadClaimMessages(claimId) {
  const res = await fetch(`/api/claims/${encodeURIComponent(claimId)}/messages`);
  if (handleSessionExpired(res)) return false;
  if (!res.ok) {
    threadMessages.innerHTML = '<p class="muted">Erro ao carregar as mensagens.</p>';
    return false;
  }
  const data = await res.json();
  if (data.claim) renderClaimThreadInfo(data.claim);
  renderClaimMessages(data.messages || []);
  return true;
}

async function openClaimThread(claim) {
  state.selectedClaimId = claim.claim_id;
  state.selectedPackId = null;
  document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("selected"));

  threadEmpty.classList.add("hidden");
  threadEl.classList.remove("hidden");
  renderClaimThreadInfo(claim);
  threadMessages.innerHTML = '<p class="muted">Carregando mensagens...</p>';
  replyForm.dataset.mode = "claim";
  replyForm.dataset.claimId = claim.claim_id;
  delete replyForm.dataset.packId;
  openMobileThread();

  await loadClaimMessages(claim.claim_id);
  await loadClaims();
}

replyAttachBtn.addEventListener("click", () => replyAttachmentInput.click());
replyAttachmentInput.addEventListener("change", () => {
  const f = replyAttachmentInput.files[0];
  if (f) {
    replyAttachmentNameEl.textContent = `📎 ${f.name} (${Math.ceil(f.size / 1024)} KB)`;
    replyAttachmentNameEl.classList.remove("hidden");
  } else {
    replyAttachmentNameEl.classList.add("hidden");
  }
});

async function submitClaimReply() {
  const claimId = replyForm.dataset.claimId;
  const text = replyText.value.trim();
  if (!claimId || !text) return;

  const btn = replyForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const formData = new FormData();
    formData.set("text", text);
    formData.set("operatorName", getOperatorName());
    if (replyAttachmentInput.files[0]) {
      formData.set("file", replyAttachmentInput.files[0]);
    }
    const res = await fetch(`/api/claims/${encodeURIComponent(claimId)}/reply`, {
      method: "POST",
      body: formData,
    });
    if (handleSessionExpired(res)) return;
    const data = await res.json();
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : "";
      alert((data.error || "Falha ao enviar a mensagem.") + (detail ? `\n\nMotivo: ${detail}` : ""));
      return;
    }
    replyText.value = "";
    replyAttachmentInput.value = "";
    replyAttachmentNameEl.classList.add("hidden");
    if (claimId === state.selectedClaimId) {
      await loadClaimMessages(claimId);
    }
    await Promise.all([loadClaims(), loadPendingCount()]);
  } finally {
    btn.disabled = false;
  }
}

// Converte um valor de <input type="date"> ("AAAA-MM-DD") pro formato ISO
// 8601 com horario que a API de evidencias espera, usando meio-dia no
// horario de Brasilia (o horario exato do dia nao importa pra essa
// finalidade, so a data).
function toEvidenceDateParam(dateStr) {
  if (!dateStr) return null;
  return `${dateStr}T12:00:00.000-03:00`;
}

evidenceToggle.addEventListener("click", () => {
  const willShow = evidenceForm.classList.contains("hidden");
  evidenceForm.classList.toggle("hidden", !willShow);
  evidenceToggleArrow.textContent = willShow ? "▴" : "▾";
});

evidenceMethodSelect.addEventListener("change", () => {
  document.querySelectorAll(".evidence-fields").forEach((el) => el.classList.add("hidden"));
  const target = document.getElementById(`evidence-fields-${evidenceMethodSelect.value}`);
  if (target) target.classList.remove("hidden");
});

evidenceSendBtn.addEventListener("click", async () => {
  const claimId = state.selectedClaimId;
  if (!claimId) return;
  const method = evidenceMethodSelect.value;
  const payload = { shipping_method: method, operatorName: getOperatorName() };

  if (method === "mail") {
    payload.shipping_company_name = document.getElementById("evidence-mail-company").value.trim();
    payload.date_shipped = toEvidenceDateParam(document.getElementById("evidence-mail-date").value);
  } else if (method === "courier") {
    payload.shipping_company_name = document.getElementById("evidence-courier-company").value.trim();
    payload.destination_agency = document.getElementById("evidence-courier-agency").value.trim();
    payload.date_shipped = toEvidenceDateParam(document.getElementById("evidence-courier-date").value);
    payload.receiver_name = document.getElementById("evidence-courier-receiver").value.trim();
  } else if (method === "personal") {
    payload.date_delivered = toEvidenceDateParam(document.getElementById("evidence-personal-date").value);
  } else if (method === "email") {
    payload.receiver_email = document.getElementById("evidence-email-receiver").value.trim();
    payload.date_shipped = toEvidenceDateParam(document.getElementById("evidence-email-date").value);
  }

  evidenceSendBtn.disabled = true;
  evidenceResults.innerHTML = '<p class="freight-msg muted">Enviando...</p>';
  try {
    const res = await fetch(`/api/claims/${encodeURIComponent(claimId)}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (handleSessionExpired(res)) return;
    const data = await res.json();
    if (!res.ok) {
      evidenceResults.innerHTML = `<p class="freight-msg freight-error">${data.error || "Falha ao enviar o comprovante."}</p>`;
      return;
    }
    evidenceResults.innerHTML = '<p class="freight-msg">Comprovante enviado!</p>';
    await loadClaimMessages(claimId);
  } catch (e) {
    evidenceResults.innerHTML = '<p class="freight-msg freight-error">Falha ao enviar o comprovante.</p>';
  } finally {
    evidenceSendBtn.disabled = false;
  }
});

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
  threadShippingTag.textContent = conv.shipping_type || "-";
  threadShippingTag.classList.toggle("hidden", !conv.shipping_type);
  // O atalho da mensagem padrao de "combinar entrega" so faz sentido pra
  // pedidos classificados assim — nos outros, fica escondido.
  quickTemplates.classList.toggle("hidden", !conv.is_combinar_entrega);

  // Elementos que so existem pra reclamacoes (ver renderClaimThreadInfo) —
  // sempre escondidos numa conversa de mensagens normal.
  threadClaimStageTag.classList.add("hidden");
  claimDueBanner.classList.add("hidden");
  claimInfoCard.classList.add("hidden");
  evidenceBox.classList.add("hidden");

  // Anexar arquivo tambem e permitido numa mensagem normal (pedido do
  // usuario) — o botao e compartilhado com a tela de reclamacoes, so limpa
  // a selecao anterior ao trocar de conversa.
  replyAttachBtn.classList.remove("hidden");
  replyAttachBtn.title = "Anexar arquivo (JPG, PNG, PDF ou TXT, até 25MB)";
  replyAttachmentInput.value = "";
  replyAttachmentNameEl.classList.add("hidden");

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
    div.innerHTML = `<div class="msg-text"></div>${
      m.attachment_name ? '<div class="msg-attachment"></div>' : ""
    }<div class="msg-date">${fmtDate(m.sent_date)}</div>`;
    div.querySelector(".msg-text").textContent = m.text || "";
    if (m.attachment_name) {
      div.querySelector(".msg-attachment").textContent = `📎 ${m.attachment_name}`;
    }
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
  state.selectedClaimId = null;
  document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("selected"));

  threadEmpty.classList.add("hidden");
  threadEl.classList.remove("hidden");
  renderThreadInfo(conv);
  threadMessages.innerHTML = '<p class="muted">Carregando mensagens...</p>';
  replyForm.dataset.mode = "conversation";
  replyForm.dataset.packId = conv.pack_id;
  delete replyForm.dataset.claimId;
  openMobileThread();

  await loadThreadMessages(conv.pack_id);
  await loadConversations();
}

threadBackBtn.addEventListener("click", () => {
  closeMobileThread();
});

replyForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (replyForm.dataset.mode === "claim") {
    await submitClaimReply();
    return;
  }

  const packId = replyForm.dataset.packId;
  const text = replyText.value.trim();
  if (!packId || !text) return;

  const btn = replyForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const formData = new FormData();
    formData.set("text", text);
    formData.set("operatorName", getOperatorName());
    if (replyAttachmentInput.files[0]) {
      formData.set("file", replyAttachmentInput.files[0]);
    }
    const res = await fetch(`/api/conversations/${encodeURIComponent(packId)}/reply`, {
      method: "POST",
      body: formData,
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
    replyAttachmentInput.value = "";
    replyAttachmentNameEl.classList.add("hidden");
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

const filterCombinarToggle = filterCombinar.closest(".filter-toggle");

// Menu lateral: alterna entre o modulo de Mensagens (conversas pos-venda), o
// de Reclamacoes (cada um com sua propria barra de abas por baixo — ver
// #tabs-messages/#tabs-claims) e o de Histórico (relatorio de largura
// inteira, sem lista+conversa — ver #history-pane). "Só combinar entrega" e
// a ordenacao so existem pra mensagens.
moduleNavItems.forEach((btn) => {
  btn.addEventListener("click", () => {
    moduleNavItems.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.module = btn.dataset.module;
    const isMessages = state.module === "messages";
    const isClaims = state.module === "claims";
    const isHistory = state.module === "history";

    tabsMessages.classList.toggle("hidden", !isMessages);
    tabsClaims.classList.toggle("hidden", !isClaims);
    filterCombinarToggle.classList.toggle("hidden", !isMessages);
    filterSortBtn.classList.toggle("hidden", !isMessages);

    listPaneEl.classList.toggle("hidden", isHistory);
    threadPaneEl.classList.toggle("hidden", isHistory);
    historyPane.classList.toggle("hidden", !isHistory);

    if (isHistory) {
      populateOperatorFilter();
      loadHistory();
    } else {
      loadList();
    }
  });
});

// ---------- Histórico de respostas ----------
const HISTORY_TYPE_LABELS = { message: "Mensagem", claim: "Reclamação" };

// Agrupa a lista de respostas por operador — em vez de uma lista unica
// enorme rolando a tela (reclamacao do usuario), cada operador vira uma
// secao que abre/fecha, com o total de respostas dele no cabecalho. A ordem
// dos grupos segue a ordem de chegada das linhas (que ja vem mais recentes
// primeiro do servidor), entao quem respondeu mais recentemente aparece
// primeiro.
function groupHistoryByOperator(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.operator_name || "-";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

function renderHistory(rows) {
  if (!rows.length) {
    historyList.innerHTML =
      '<p class="muted empty-msg">Nenhuma resposta registrada ainda com esses filtros.</p>';
    return;
  }

  const groups = groupHistoryByOperator(rows);
  // Um unico grupo (ex: filtro de operador ja aplicado) comeca aberto —
  // varios grupos comecam fechados, pra ver so a lista de nomes e quantos
  // cada um respondeu antes de entrar nos detalhes.
  const singleGroup = groups.size === 1;

  historyList.innerHTML = Array.from(groups.entries())
    .map(([operator, groupRows], gi) => {
      const rowsHtml = groupRows
        .map(
          (r) => `
        <div class="history-row">
          <div class="history-row-main">
            <span class="tag ${r.type === "claim" ? "tag-claim" : "tag-shipping"}">${
            HISTORY_TYPE_LABELS[r.type] || r.type
          }</span>
          </div>
          <div class="history-row-meta muted small">
            ${r.order_id ? `Pedido #${r.order_id} · ` : ""}${r.buyer_name || "Comprador"}${
            r.seller_nickname ? ` · ${r.seller_nickname}` : ""
          } · ${fmtDate(r.sent_date)}
          </div>
          <div class="history-row-text"></div>
        </div>
      `
        )
        .join("");
      return `
      <details class="history-group"${singleGroup ? " open" : ""} data-group-index="${gi}">
        <summary class="history-group-summary">
          <span class="history-operator-name"></span>
          <span class="history-group-count">${groupRows.length}</span>
        </summary>
        <div class="history-group-rows">${rowsHtml}</div>
      </details>
    `;
    })
    .join("");

  // Nome do operador (no cabecalho de cada grupo) e texto de cada mensagem
  // sao preenchidos via textContent (nao interpolados no HTML acima) porque
  // vem de digitacao livre.
  const groupEls = historyList.querySelectorAll(".history-group");
  Array.from(groups.entries()).forEach(([operator, groupRows], gi) => {
    groupEls[gi].querySelector(".history-operator-name").textContent = operator;
    const rowEls = groupEls[gi].querySelectorAll(".history-row-text");
    groupRows.forEach((r, i) => {
      rowEls[i].textContent = r.text || "";
    });
  });
}

async function populateOperatorFilter() {
  try {
    const res = await fetch("/api/operators");
    if (!res.ok) return;
    const names = await res.json();
    const current = historyOperatorFilter.value;
    historyOperatorFilter.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "Todos os operadores";
    historyOperatorFilter.appendChild(optAll);
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      historyOperatorFilter.appendChild(opt);
    }
    historyOperatorFilter.value = current;
  } catch (e) {
    // sem lista de operadores pro filtro nao impede o resto de funcionar
  }
}

async function loadHistory() {
  historyList.innerHTML = '<p class="muted empty-msg">Carregando...</p>';

  const params = new URLSearchParams();
  if (historyOperatorFilter.value) params.set("operator", historyOperatorFilter.value);
  if (historyFrom.value) params.set("from", historyFrom.value);
  if (historyTo.value) params.set("to", historyTo.value);

  try {
    const res = await fetch(`/api/operator-log?${params.toString()}`);
    if (handleSessionExpired(res)) return;
    if (!res.ok) {
      historyList.innerHTML = '<p class="muted">Erro ao carregar o histórico.</p>';
      return;
    }
    const data = await res.json();
    renderHistory(data.rows || []);
  } catch (e) {
    historyList.innerHTML = '<p class="muted">Erro ao carregar o histórico.</p>';
  }
}

if (historyRefreshBtn) historyRefreshBtn.addEventListener("click", () => loadHistory());
if (historyOperatorFilter) historyOperatorFilter.addEventListener("change", () => loadHistory());
if (historyFrom) historyFrom.addEventListener("change", () => loadHistory());
if (historyTo) historyTo.addEventListener("change", () => loadHistory());

// Menu lateral recolhivel: so afeta telas grandes (no celular o CSS ignora
// essas classes e mantem a barra horizontal de sempre). A preferencia fica
// salva no navegador pra o vendedor nao ter que recolher de novo toda vez
// que abrir o painel.
function applyNavCollapsed(collapsed) {
  if (moduleNav) moduleNav.classList.toggle("collapsed", collapsed);
  if (layoutEl) layoutEl.classList.toggle("nav-collapsed", collapsed);
  if (moduleNavToggle) moduleNavToggle.title = collapsed ? "Expandir menu" : "Recolher menu";
  if (moduleNavToggleLabel) moduleNavToggleLabel.textContent = collapsed ? "Expandir" : "Recolher";
}

let navCollapsed = false;
try {
  navCollapsed = localStorage.getItem("ml-painel-nav-collapsed") === "1";
} catch (e) {
  // navegador sem localStorage (raro) — so segue com o menu expandido
}
applyNavCollapsed(navCollapsed);

if (moduleNavToggle) {
  moduleNavToggle.addEventListener("click", () => {
    navCollapsed = !navCollapsed;
    applyNavCollapsed(navCollapsed);
    try {
      localStorage.setItem("ml-painel-nav-collapsed", navCollapsed ? "1" : "0");
    } catch (e) {
      // sem localStorage: so nao persiste entre sessoes, sem quebrar nada
    }
  });
}

document.querySelectorAll("#tabs-messages .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#tabs-messages .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.status = tab.dataset.status;
    loadList();
  });
});

document.querySelectorAll("#tabs-claims .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#tabs-claims .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.claimStatus = tab.dataset.claimStatus;
    loadList();
  });
});

filterCombinar.addEventListener("change", () => {
  state.onlyCombinar = filterCombinar.checked;
  loadList();
});

if (filterOnlyPending) {
  filterOnlyPending.addEventListener("change", () => {
    state.onlyPending = filterOnlyPending.checked;
    loadList();
  });
}

// Busca livre: espera o usuario parar de digitar (300ms) antes de recarregar
// a lista, pra nao mandar uma requisicao a cada letra.
let searchDebounceTimer = null;
filterSearch.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.searchQuery = filterSearch.value.trim();
    loadList();
  }, 300);
});

filterSeller.addEventListener("change", () => {
  state.sellerId = filterSeller.value;
  loadList();
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
  loadList();
});

document.getElementById("sync-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const label = btn.querySelector(".btn-label");
  if (label) label.textContent = "Atualizando...";
  try {
    // O mesmo botao atualiza conversas E reclamacoes — /api/sync ja
    // sincroniza as duas coisas do lado do servidor.
    await fetch("/api/sync", { method: "POST" });
    await Promise.all([loadList(), loadPendingCount()]);
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
  document.querySelector('.module-nav-item[data-module="messages"]').click();
  document.querySelector('#tabs-messages .tab[data-status="pending"]').click();
});

// Carga inicial + verificacao periodica (sem precisar de webhook/servidor
// mandando nada pro navegador: o proprio navegador pergunta de tempos em
// tempos enquanto a aba estiver aberta).
loadList();
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
  if (!state.selectedPackId && !state.selectedClaimId) loadList();
}, 30000);
