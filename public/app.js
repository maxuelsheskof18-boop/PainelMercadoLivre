const state = {
  status: "pending",
  selectedPackId: null,
  templates: [],
};

const listEl = document.getElementById("conversation-list");
const bellCount = document.getElementById("bell-count");
const threadEmpty = document.getElementById("thread-empty");
const threadEl = document.getElementById("thread");
const threadBuyer = document.getElementById("thread-buyer");
const threadAccount = document.getElementById("thread-account");
const threadOrder = document.getElementById("thread-order");
const threadMessages = document.getElementById("thread-messages");
const replyForm = document.getElementById("reply-form");
const replyText = document.getElementById("reply-text");
const templatePicker = document.getElementById("template-picker");

function fmtDate(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString("pt-BR");
  } catch {
    return d;
  }
}

function fmtMoney(value, currency) {
  if (value == null) return "";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency || "BRL",
    }).format(value);
  } catch {
    return `${currency || ""} ${value}`.trim();
  }
}

const SHIPPING_LABELS = {
  pending: "envio pendente",
  handling: "em preparacao",
  ready_to_ship: "pronto para envio",
  shipped: "enviado",
  delivered: "entregue",
  not_delivered: "nao entregue",
  cancelled: "envio cancelado",
};

function orderSummary(conv) {
  const parts = [];
  if (conv.item_title) {
    const qty = conv.item_quantity && conv.item_quantity > 1 ? `${conv.item_quantity}x ` : "";
    parts.push(`${qty}${conv.item_title}`);
  }
  if (conv.order_total != null) parts.push(fmtMoney(conv.order_total, conv.currency));
  if (conv.shipping_status) {
    parts.push(SHIPPING_LABELS[conv.shipping_status] || conv.shipping_status);
  }
  if (conv.order_id) parts.push(`pedido ${conv.order_id}`);
  return parts.join(" · ");
}

async function loadPendingCount() {
  const res = await fetch("/api/pending-count");
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
  if (!res.ok) {
    listEl.innerHTML = '<p class="muted empty-msg">Erro ao carregar.</p>';
    return;
  }
  const items = await res.json();

  if (items.length === 0) {
    listEl.textContent = "";
    const p = document.createElement("p");
    p.className = "muted empty-msg";
    p.textContent = `Nenhuma conversa ${state.status === "pending" ? "pendente" : "respondida"}.`;
    listEl.appendChild(p);
    return;
  }

  listEl.textContent = "";
  for (const conv of items) {
    const div = document.createElement("div");
    div.className =
      "conversation-item" + (conv.pack_id === state.selectedPackId ? " selected" : "");

    const top = document.createElement("div");
    top.className = "ci-top";
    const name = document.createElement("strong");
    name.textContent = conv.buyer_nickname || "Comprador #" + (conv.buyer_id || "?");
    const store = document.createElement("span");
    store.className = "muted small";
    store.textContent = conv.seller_nickname || "";
    top.append(name, store);

    const preview = document.createElement("div");
    preview.className = "ci-preview muted";
    preview.textContent = (conv.last_message_text || "").slice(0, 90);

    const date = document.createElement("div");
    date.className = "ci-date muted small";
    date.textContent = fmtDate(conv.last_message_date);

    div.append(top, preview);
    if (conv.item_title) {
      const item = document.createElement("div");
      item.className = "ci-item muted small";
      item.textContent = conv.item_title;
      div.appendChild(item);
    }
    div.appendChild(date);

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

  const summary = orderSummary(conv);
  if (summary) {
    threadOrder.textContent = summary;
    threadOrder.classList.remove("hidden");
  } else {
    threadOrder.classList.add("hidden");
  }

  threadMessages.innerHTML = '<p class="muted">Carregando mensagens...</p>';
  replyForm.dataset.packId = conv.pack_id;

  const res = await fetch(`/api/conversations/${encodeURIComponent(conv.pack_id)}/messages`);
  const messages = await res.json();

  threadMessages.textContent = "";
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = "msg " + (m.direction === "out" ? "msg-out" : "msg-in");
    const textDiv = document.createElement("div");
    textDiv.className = "msg-text";
    textDiv.textContent = m.text || "";
    const dateDiv = document.createElement("div");
    dateDiv.className = "msg-date muted small";
    dateDiv.textContent = fmtDate(m.sent_date);
    div.append(textDiv, dateDiv);
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

  const btn = replyForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(packId)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Falha ao enviar a mensagem.");
      return;
    }
    replyText.value = "";
    templatePicker.value = "";
    threadEl.classList.add("hidden");
    threadEmpty.classList.remove("hidden");
    state.selectedPackId = null;
    await Promise.all([loadConversations(), loadPendingCount()]);
  } finally {
    btn.disabled = false;
  }
});

// --- Respostas rapidas (templates) ------------------------------------------
async function loadTemplates() {
  const res = await fetch("/api/templates");
  if (!res.ok) return;
  state.templates = await res.json();
  renderTemplatePicker();
}

function renderTemplatePicker() {
  templatePicker.textContent = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = "Resposta rapida...";
  templatePicker.appendChild(first);
  for (const t of state.templates) {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    opt.textContent = t.title;
    templatePicker.appendChild(opt);
  }
}

templatePicker.addEventListener("change", () => {
  const t = state.templates.find((x) => String(x.id) === templatePicker.value);
  if (!t) return;
  const current = replyText.value;
  replyText.value = current && !current.endsWith("\n") ? `${current}\n${t.body}` : current + t.body;
  replyText.focus();
});

const modal = document.getElementById("templates-modal");
const templatesList = document.getElementById("templates-list");
const templateForm = document.getElementById("template-form");
const tId = document.getElementById("template-id");
const tTitle = document.getElementById("template-title");
const tBody = document.getElementById("template-body");
const tSave = document.getElementById("template-save");
const tCancel = document.getElementById("template-cancel");

function renderTemplatesList() {
  templatesList.textContent = "";
  if (state.templates.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Nenhuma resposta rapida ainda.";
    templatesList.appendChild(p);
    return;
  }
  for (const t of state.templates) {
    const row = document.createElement("div");
    row.className = "template-row";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = t.title;
    const body = document.createElement("div");
    body.className = "muted small";
    body.textContent = t.body;
    info.append(title, body);

    const actions = document.createElement("div");
    actions.className = "template-row-actions";
    const edit = document.createElement("button");
    edit.className = "ghost";
    edit.textContent = "Editar";
    edit.addEventListener("click", () => startEdit(t));
    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "Excluir";
    del.addEventListener("click", () => removeTemplate(t.id));
    actions.append(edit, del);

    row.append(info, actions);
    templatesList.appendChild(row);
  }
}

function startEdit(t) {
  tId.value = String(t.id);
  tTitle.value = t.title;
  tBody.value = t.body;
  tSave.textContent = "Salvar alteracoes";
  tCancel.classList.remove("hidden");
}

function resetTemplateForm() {
  tId.value = "";
  tTitle.value = "";
  tBody.value = "";
  tSave.textContent = "Adicionar";
  tCancel.classList.add("hidden");
}

async function removeTemplate(id) {
  if (!confirm("Excluir esta resposta rapida?")) return;
  await fetch(`/api/templates/${id}`, { method: "DELETE" });
  await loadTemplates();
  renderTemplatesList();
}

templateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = { title: tTitle.value.trim(), body: tBody.value.trim() };
  if (!payload.title || !payload.body) return;
  const editing = tId.value;
  const res = await fetch(editing ? `/api/templates/${editing}` : "/api/templates", {
    method: editing ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || "Falha ao salvar.");
    return;
  }
  resetTemplateForm();
  await loadTemplates();
  renderTemplatesList();
});

tCancel.addEventListener("click", resetTemplateForm);

document.getElementById("templates-btn").addEventListener("click", () => {
  renderTemplatesList();
  resetTemplateForm();
  modal.classList.remove("hidden");
});
document.getElementById("templates-close").addEventListener("click", () => {
  modal.classList.add("hidden");
});
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
});

// --- Abas, sync, logout, sino ---------------------------------------------
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

// Carga inicial + verificacao periodica.
loadConversations();
loadPendingCount();
loadTemplates();
setInterval(loadPendingCount, 20000);
setInterval(() => {
  if (!state.selectedPackId) loadConversations();
}, 30000);
