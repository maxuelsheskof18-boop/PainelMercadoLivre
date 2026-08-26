const state = {
  status: "pending",
  selectedPackId: null,
  pollTimer: null,
  onlyCombinar: false,
  lastPendingCount: null, // usado pra saber se aumentou (tocar som) sem tocar no primeiro carregamento
  melhorEnvio: { connected: false, originPostalCode: null },
};

const listEl = document.getElementById("conversation-list");
const bellCount = document.getElementById("bell-count");
const tabCountPending = document.getElementById("tab-count-pending");
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
const threadMessages = document.getElementById("thread-messages");
const replyForm = document.getElementById("reply-form");
const replyText = document.getElementById("reply-text");
const filterCombinar = document.getElementById("filter-combinar");
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

// Prefere o nome real do comprador (quando o Mercado Livre libera esse
// dado pro pedido); cai pro apelido, e por ultimo pro numero do comprador.
function buyerLabel(conv) {
  return conv.buyer_full_name || conv.buyer_nickname || "Comprador #" + (conv.buyer_id || "?");
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
    bellCount.textContent = data.pending;
    bellCount.classList.remove("hidden");
    tabCountPending.textContent = data.pending;
    tabCountPending.classList.remove("hidden");
  } else {
    bellCount.classList.add("hidden");
    tabCountPending.classList.add("hidden");
  }

  // Toca o som so quando o numero de pendencias SOBE em relacao a ultima
  // vez que checamos (ou seja, chegou mensagem nova) — nunca no primeiro
  // carregamento da pagina (lastPendingCount ainda null) nem quando o
  // numero cai (conversa foi respondida).
  if (state.lastPendingCount !== null && data.pending > state.lastPendingCount) {
    playNotificationSound();
  }
  state.lastPendingCount = data.pending;
}

async function loadConversations() {
  listEl.innerHTML = '<p class="muted empty-msg">Carregando...</p>';
  const params = new URLSearchParams({ status: state.status });
  if (state.onlyCombinar) params.set("combinar", "1");

  const res = await fetch(`/api/conversations?${params.toString()}`);
  if (handleSessionExpired(res)) return;
  if (!res.ok) {
    listEl.innerHTML = '<p class="muted empty-msg">Erro ao carregar.</p>';
    return;
  }
  const items = await res.json();

  if (items.length === 0) {
    const msg = state.onlyCombinar
      ? `Nenhuma conversa de "combinar entrega" ${state.status === "pending" ? "pendente" : "respondida"}.`
      : `Nenhuma conversa ${state.status === "pending" ? "pendente" : "respondida"}.`;
    listEl.innerHTML = `<p class="muted empty-msg">${msg}</p>`;
    return;
  }

  listEl.innerHTML = "";
  for (const conv of items) {
    const div = document.createElement("div");
    const isUnread = conv.status === "pending";
    div.className =
      "conversation-item" +
      (conv.pack_id === state.selectedPackId ? " selected" : "") +
      (isUnread ? " unread" : "");
    const label = buyerLabel(conv);
    div.innerHTML = `
      ${avatarHtml(label)}
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-buyer">${label}</span>
          <span class="ci-store">${conv.seller_nickname || ""}</span>
        </div>
        ${conv.product_title ? `<div class="ci-product">${conv.product_title}</div>` : ""}
        <div class="ci-preview">${(conv.last_message_text || "").slice(0, 90)}</div>
        <div class="ci-bottom">
          <span class="ci-date">${fmtDate(conv.last_message_date)}${conv.order_id ? ` · #${conv.order_id}` : ""}</span>
          ${conv.is_combinar_entrega ? '<span class="tag tag-delivery">Combinar entrega</span>' : ""}
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

  if (conv.product_title || conv.order_id) {
    orderCard.classList.remove("hidden");
    orderCardProduct.textContent = conv.product_title || "Produto nao identificado";
    orderCardMeta.textContent = conv.order_id ? `Pedido #${conv.order_id}` : "";
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
      <div class="freight-option">
        <span class="freight-option-name">${o.company ? o.company + " — " : ""}${o.name}</span>
        <span class="freight-option-time muted">${o.deliveryTime ? o.deliveryTime + " dia(s) util" : ""}</span>
        <span class="freight-option-price">R$ ${o.price.toFixed(2).replace(".", ",")}</span>
      </div>`
      )
      .join("");
  } catch (e) {
    freightResults.innerHTML = '<p class="freight-msg freight-error">Falha ao calcular o frete.</p>';
  } finally {
    freightCalcBtn.disabled = false;
  }
});

function renderMessages(messages) {
  threadMessages.innerHTML = "";
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
