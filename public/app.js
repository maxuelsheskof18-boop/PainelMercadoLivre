const state = {
  status: "pending",
  selectedPackId: null,
  pollTimer: null,
};

const listEl = document.getElementById("conversation-list");
const bellCount = document.getElementById("bell-count");
const threadEmpty = document.getElementById("thread-empty");
const threadEl = document.getElementById("thread");
const threadBuyer = document.getElementById("thread-buyer");
const threadAccount = document.getElementById("thread-account");
const threadMessages = document.getElementById("thread-messages");
const replyForm = document.getElementById("reply-form");
const replyText = document.getElementById("reply-text");

function fmtDate(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString("pt-BR");
  } catch {
    return d;
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
  } else {
    bellCount.classList.add("hidden");
  }
}

async function loadConversations() {
  listEl.innerHTML = '<p class="muted empty-msg">Carregando...</p>';
  const res = await fetch(`/api/conversations?status=${state.status}`);
  if (handleSessionExpired(res)) return;
  if (!res.ok) {
    listEl.innerHTML = '<p class="muted empty-msg">Erro ao carregar.</p>';
    return;
  }
  const items = await res.json();

  if (items.length === 0) {
    listEl.innerHTML = `<p class="muted empty-msg">Nenhuma conversa ${
      state.status === "pending" ? "pendente" : "respondida"
    }.</p>`;
    return;
  }

  listEl.innerHTML = "";
  for (const conv of items) {
    const div = document.createElement("div");
    div.className = "conversation-item" + (conv.pack_id === state.selectedPackId ? " selected" : "");
    div.innerHTML = `
      <div class="ci-top">
        <strong>${conv.buyer_nickname || "Comprador #" + (conv.buyer_id || "?")}</strong>
        <span class="muted small">${conv.seller_nickname || ""}</span>
      </div>
      <div class="ci-preview muted">${(conv.last_message_text || "").slice(0, 90)}</div>
      <div class="ci-date muted small">${fmtDate(conv.last_message_date)}</div>
    `;
    div.addEventListener("click", () => openThread(conv));
    listEl.appendChild(div);
  }
}

async function openThread(conv) {
  state.selectedPackId = conv.pack_id;
  document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("selected"));

  threadEmpty.classList.add("hidden");
  threadEl.classList.remove("hidden");
  threadBuyer.textContent = conv.buyer_nickname || "Comprador #" + (conv.buyer_id || "?");
  threadAccount.textContent = conv.seller_nickname ? `Loja: ${conv.seller_nickname}` : "";
  threadMessages.innerHTML = '<p class="muted">Carregando mensagens...</p>';
  replyForm.dataset.packId = conv.pack_id;

  const res = await fetch(`/api/conversations/${encodeURIComponent(conv.pack_id)}/messages`);
  if (handleSessionExpired(res)) return;
  if (!res.ok) {
    threadMessages.innerHTML = '<p class="muted">Erro ao carregar as mensagens.</p>';
    return;
  }
  const messages = await res.json();

  threadMessages.innerHTML = "";
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = "msg " + (m.direction === "out" ? "msg-out" : "msg-in");
    div.innerHTML = `<div class="msg-text"></div><div class="msg-date muted small">${fmtDate(m.sent_date)}</div>`;
    div.querySelector(".msg-text").textContent = m.text || "";
    threadMessages.appendChild(div);
  }
  threadMessages.scrollTop = threadMessages.scrollHeight;

  await loadConversations();
}

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
      alert(data.error || "Falha ao enviar a mensagem.");
      return;
    }
    replyText.value = "";
    threadEl.classList.add("hidden");
    threadEmpty.classList.remove("hidden");
    state.selectedPackId = null;
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

document.getElementById("sync-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Atualizando...";
  try {
    await fetch("/api/sync", { method: "POST" });
    await Promise.all([loadConversations(), loadPendingCount()]);
  } finally {
    btn.disabled = false;
    btn.textContent = "Atualizar";
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
setInterval(loadPendingCount, 20000);
setInterval(() => {
  if (!state.selectedPackId) loadConversations();
}, 30000);
