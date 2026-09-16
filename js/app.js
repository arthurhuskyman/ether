"use strict";

// Сервер, прописанный по умолчанию — можно изменить в Настройках.
const DEFAULT_SIGNALING_URL = "wss://ether-1-baqy.onrender.com";

function effectiveSignalingUrl() {
  return (Store.signalingUrl || DEFAULT_SIGNALING_URL).trim();
}

// ---------- Хранилище ----------

const Store = {
  get name() { return localStorage.getItem("ether.name") || ""; },
  set name(v) { localStorage.setItem("ether.name", v); },

  get myIdentityRaw() { return localStorage.getItem("ether.identityRaw") || ""; },
  set myIdentityRaw(v) { localStorage.setItem("ether.identityRaw", v); },

  get myId() { return localStorage.getItem("ether.myId") || ""; },
  set myId(v) { localStorage.setItem("ether.myId", v); },

  get signalingUrl() { return localStorage.getItem("ether.signalingUrl") || ""; },
  set signalingUrl(v) { localStorage.setItem("ether.signalingUrl", v); },

  get discoverable() { return localStorage.getItem("ether.discoverable") !== "0"; },
  set discoverable(v) { localStorage.setItem("ether.discoverable", v ? "1" : "0"); },

  get contactsJson() { return localStorage.getItem("ether.contacts") || "[]"; },
  set contactsJson(v) { localStorage.setItem("ether.contacts", v); },

  get glassAlpha() { return parseFloat(localStorage.getItem("ether.glassAlpha") || "0.5"); },
  set glassAlpha(v) { localStorage.setItem("ether.glassAlpha", String(v)); },

  get theme() { return localStorage.getItem("ether.theme") || "auto"; },
  set theme(v) { localStorage.setItem("ether.theme", v); },
};

// ---------- Состояние ----------

const state = {
  tab: "chats",
  chatId: null,
  callId: null,
  pendingOutgoing: null, // ручной поток (без сервера)
  contacts: new Map(), // id -> { id, name, raw, managed, online, status, messages, lastActivity }
};

let mesh;
let signaling = null;
const onlineSet = new Set();
const onlineRoster = new Map(); // id -> { name, visible } — все, кто сейчас зарегистрирован на сервере
const autoConnectTimers = new Map();

// ---------- Утилиты интерфейса ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function applyGlassAlpha(v) {
  document.documentElement.style.setProperty("--glass-alpha", v.toFixed(2));
  document.documentElement.style.setProperty("--glass-blur", (14 + v * 26).toFixed(0) + "px");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

// ---------- Онбординг ----------

function initOnboarding() {
  if (Store.name && Store.myId) {
    $("#onboarding").classList.add("hidden");
    startApp();
    return;
  }
  $("#onboarding").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
  if (Store.name) $("#onboarding-name").value = Store.name;

  $("#onboarding-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameVal = $("#onboarding-name").value.trim();
    const idVal = $("#onboarding-identity").value.trim();
    if (!nameVal || !idVal) return;
    let identity;
    try {
      identity = await Identity.idFor(idVal);
    } catch (err) {
      toast(err.message);
      return;
    }
    Store.name = nameVal;
    Store.myIdentityRaw = identity.normalized;
    Store.myId = identity.id;
    $("#onboarding").classList.add("hidden");
    startApp();
  });
}

// ---------- Запуск приложения ----------

function startApp() {
  $("#onboarding").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  mesh = new MeshManager(Store.name);
  wireMeshEvents();
  wireTabBar();
  wireConnectScreen();
  wireChatScreen();
  wireCallScreen();
  wireSettingsScreen();

  applyGlassAlpha(Store.glassAlpha);
  applyTheme(Store.theme);
  $("#glass-slider").value = Store.glassAlpha;
  $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === Store.theme));
  $("#settings-name").value = Store.name;
  $("#settings-identity").value = Store.myIdentityRaw;
  $("#settings-signaling-url").value = Store.signalingUrl || DEFAULT_SIGNALING_URL;
  $("#settings-discoverable").checked = Store.discoverable;

  loadContacts();

  const incoming = SignalingCodec.extractCodeFromLocation();
  history.replaceState(null, "", location.pathname + location.search);
  if (incoming) handleIncomingCode(incoming, true);

  renderTab();
  initSignaling();
  registerServiceWorker();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

// ---------- Контакты (персистентные, по телефону/email) ----------

function loadContacts() {
  let arr = [];
  try { arr = JSON.parse(Store.contactsJson) || []; } catch (e) {}
  for (const c of arr) {
    state.contacts.set(c.id, {
      id: c.id, name: c.name, raw: c.raw || "", managed: true,
      online: false, status: "disconnected", messages: [], lastActivity: 0,
    });
  }
}

function persistContacts() {
  const arr = Array.from(state.contacts.values())
    .filter((c) => c.managed)
    .map((c) => ({ id: c.id, name: c.name, raw: c.raw }));
  Store.contactsJson = JSON.stringify(arr);
}

function ensureContactEntry(id, suggestedName) {
  let c = state.contacts.get(id);
  if (!c) {
    c = { id, name: suggestedName || "Новый контакт", raw: "", managed: true, online: true, status: "new", messages: [], lastActivity: Date.now() };
    state.contacts.set(id, c);
    persistContacts();
  } else if (suggestedName && (!c.name || c.name === "Новый контакт")) {
    c.name = suggestedName;
    persistContacts();
  }
  return c;
}

// ---------- Таб-бар ----------

function wireTabBar() {
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      state.chatId = null;
      renderTab();
    });
  });
  $("#chat-back").addEventListener("click", () => {
    state.chatId = null;
    renderTab();
  });
}

function renderTab() {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $$(".screen").forEach((s) => s.classList.add("hidden"));

  if (state.chatId) {
    $("#screen-chat").classList.remove("hidden");
    $("#tab-bar").classList.add("hidden");
    renderChatThread();
    return;
  }

  $("#tab-bar").classList.remove("hidden");
  const map = { chats: "#screen-chats", connect: "#screen-connect", settings: "#screen-settings" };
  $(map[state.tab]).classList.remove("hidden");
  const titles = { chats: "Чаты", connect: "Контакты", settings: "Настройки" };
  $("#nav-title").textContent = titles[state.tab];

  if (state.tab === "chats") renderChatsList();
  if (state.tab === "connect") { renderSignalingBanner(); renderOnlineRosterList(); }
}

// ---------- Статусы контактов ----------

function contactStatusLabel(c) {
  if (c.status === "in-call") return "разговор";
  if (c.status === "connected") return "на связи";
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return "соединяемся…";
  if (c.managed) return c.online ? "в сети" : "офлайн";
  return "офлайн";
}

function contactStatusClass(c) {
  if (c.status === "connected" || c.status === "in-call") return "status-connected";
  if (c.managed && c.online) return "status-connected";
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return "status-connecting";
  return "status-disconnected";
}

function isReachable(c) {
  return c.status === "connected" || c.status === "in-call";
}

// ---------- Список чатов ----------

function renderChatsList() {
  const list = $("#chats-list");
  const empty = $("#chats-empty");
  list.innerHTML = "";

  if (state.contacts.size === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const items = Array.from(state.contacts.entries()).sort((a, b) => {
    const aLive = isReachable(a[1]) || a[1].online ? 1 : 0;
    const bLive = isReachable(b[1]) || b[1].online ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return (b[1].lastActivity || 0) - (a[1].lastActivity || 0);
  });

  for (const [id, c] of items) {
    const last = c.messages[c.messages.length - 1];
    const row = document.createElement("button");
    row.className = "chat-row glass-content";
    row.innerHTML = `
      <div class="avatar" style="background:${avatarGradient(c.name)}">${initials(c.name)}</div>
      <div class="chat-row-body">
        <div class="chat-row-top">
          <span class="chat-row-name">${escapeHtml(c.name || "Без имени")}</span>
          <span class="chat-row-status ${contactStatusClass(c)}">●</span>
        </div>
        <div class="chat-row-sub">${last ? escapeHtml(truncate(last.text, 42)) : contactStatusLabel(c)}</div>
      </div>
    `;
    row.addEventListener("click", () => {
      state.chatId = id;
      renderTab();
    });
    list.appendChild(row);
  }
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function initials(name) { return (name || "?").trim().slice(0, 2).toUpperCase(); }

function avatarGradient(name) {
  const palettes = [
    "linear-gradient(160deg,#0A84FF,#5E5CE6)",
    "linear-gradient(160deg,#FF9F0A,#FF375F)",
    "linear-gradient(160deg,#30D158,#0A84FF)",
    "linear-gradient(160deg,#BF5AF2,#FF375F)",
    "linear-gradient(160deg,#64D2FF,#5E5CE6)",
  ];
  let h = 0;
  for (const c of name || "?") h = (h * 31 + c.charCodeAt(0)) % palettes.length;
  return palettes[h];
}

// ---------- Тред чата ----------

function renderChatThread() {
  const c = state.contacts.get(state.chatId);
  if (!c) {
    state.chatId = null;
    renderTab();
    return;
  }
  $("#chat-peer-name").textContent = c.name || "Без имени";
  $("#chat-peer-status").textContent = contactStatusLabel(c);
  $("#chat-call-btn").disabled = !isReachable(c);

  const wrap = $("#chat-messages");
  wrap.innerHTML = "";
  for (const m of c.messages) {
    const bubble = document.createElement("div");
    bubble.className = "bubble-row " + (m.from === "me" ? "mine" : "theirs");
    bubble.innerHTML = `<div class="bubble ${m.from === "me" ? "" : "glass-content"}">${escapeHtml(m.text)}<span class="bubble-time">${formatTime(m.ts)}</span></div>`;
    wrap.appendChild(bubble);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function wireChatScreen() {
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text || !state.chatId) return;
    const c = state.contacts.get(state.chatId);
    const link = mesh.get(state.chatId);
    const sent = link && link.send({ kind: "chat", text, ts: Date.now() });
    c.messages.push({ from: "me", text, ts: Date.now() });
    c.lastActivity = Date.now();
    if (!sent) {
      if (c.managed && c.online) {
        toast("Соединяемся — отправьте ещё раз через секунду");
        attemptConnect(c.id, { force: true });
      } else if (c.managed) {
        toast("Контакт сейчас не в сети");
      } else {
        toast("Сообщение не доставлено — собеседник офлайн");
      }
    }
    input.value = "";
    renderChatThread();
  });

  $("#chat-call-btn").addEventListener("click", () => beginCall(state.chatId));

  $("#chat-delete-btn").addEventListener("click", () => {
    const c = state.contacts.get(state.chatId);
    if (!c) return;
    if (!confirm(`Удалить контакт «${c.name}»? Переписка будет потеряна.`)) return;
    deleteContact(state.chatId);
  });
}

function deleteContact(id) {
  clearAutoConnectTimer(id);
  mesh.remove(id);
  const audioEl = document.getElementById("remote-audio-" + id);
  if (audioEl) audioEl.remove();
  state.contacts.delete(id);
  persistContacts();
  if (state.callId === id) closeCallScreen();
  if (state.chatId === id) state.chatId = null;
  renderTab();
  toast("Контакт удалён");
}

// ---------- Идентификатор и сигнальный сервер ----------

function updateSignalingStatusUI(kind, text) {
  const dot = $("#signaling-status-dot");
  dot.className = "status-dot " + kind;
  $("#signaling-status-text").textContent = text;
}

function renderSignalingBanner() {
  const banner = $("#signaling-banner");
  if (!signaling || !signaling.connected) {
    $("#signaling-banner-text").textContent = "Нет связи с сигнальным сервером — переподключаемся… Бесплатный хостинг сервера может «просыпаться» до 30 секунд после простоя.";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function initSignaling() {
  const url = effectiveSignalingUrl();
  if (signaling) { signaling.stop(); signaling = null; }
  onlineSet.clear();
  onlineRoster.clear();
  for (const c of state.contacts.values()) c.online = false;

  if (!url) {
    updateSignalingStatusUI("off", "Сервер не настроен");
    renderSignalingBanner();
    renderChatsList();
    renderOnlineRosterList();
    return;
  }
  updateSignalingStatusUI("connecting", "Подключение…");
  signaling = new SignalingClient(url, Store.myId, { name: Store.name, visible: Store.discoverable });
  wireSignalingEvents();
  signaling.start();
  renderSignalingBanner();
}

function wireSignalingEvents() {
  signaling.addEventListener("connected", () => {
    updateSignalingStatusUI("online", "Подключено");
    renderSignalingBanner();
  });

  signaling.addEventListener("disconnected", () => {
    updateSignalingStatusUI("off", "Нет соединения — переподключаемся…");
    for (const c of state.contacts.values()) if (c.managed) c.online = false;
    onlineRoster.clear();
    renderSignalingBanner();
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  });

  signaling.addEventListener("online-list", (ev) => {
    for (const u of ev.detail.users) {
      onlineSet.add(u.id);
      onlineRoster.set(u.id, { name: u.name, visible: u.visible !== false });
      const c = state.contacts.get(u.id);
      if (c && c.managed) { c.online = true; scheduleAutoConnect(u.id); }
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  });

  signaling.addEventListener("presence", (ev) => {
    const { id, online, name, visible } = ev.detail;
    if (online) { onlineSet.add(id); onlineRoster.set(id, { name, visible: visible !== false }); }
    else { onlineSet.delete(id); onlineRoster.delete(id); }

    const c = state.contacts.get(id);
    if (c && c.managed) {
      c.online = online;
      if (online) scheduleAutoConnect(id); else clearAutoConnectTimer(id);
      if (state.chatId === id) renderChatThread();
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  });

  signaling.addEventListener("signal", async (ev) => {
    const { from, data: packet } = ev.detail;
    if (!packet || !packet.t) return;

    if (packet.t === "offer") {
      const existing = mesh.get(from);
      const iAmSupposedToOffer = Store.myId < from;
      if (existing && existing.role === "offerer" && iAmSupposedToOffer && existing.status !== "disconnected") {
        return; // ждём свой offer/answer, входящий игнорируем (защита от гонки)
      }
      if (existing) mesh.remove(from);
      ensureContactEntry(from, packet.n);
      const link = mesh.createIncomingLink(from);
      try {
        const answer = await link.acceptOfferAndCreateAnswer(packet);
        signaling.signal(from, answer);
      } catch (e) {}
    } else if (packet.t === "answer") {
      const link = mesh.get(from);
      if (link) {
        try { await link.acceptAnswer(packet); } catch (e) {}
      }
    }
  });

  signaling.addEventListener("unreachable", (ev) => {
    const c = state.contacts.get(ev.detail.to);
    if (c) { c.online = false; if (state.tab === "chats") renderChatsList(); }
  });
}

function clearAutoConnectTimer(id) {
  const t = autoConnectTimers.get(id);
  if (t) clearTimeout(t);
  autoConnectTimers.delete(id);
}

function scheduleAutoConnect(id) {
  attemptConnect(id);
  clearAutoConnectTimer(id);
  autoConnectTimers.set(id, setTimeout(() => attemptConnect(id, { force: true }), 4000));
}

async function attemptConnect(id, { force = false } = {}) {
  if (!signaling || !signaling.connected) return;
  const existing = mesh.get(id);
  if (existing && existing.status !== "disconnected") return;
  if (!onlineSet.has(id)) return;
  if (!force && !(Store.myId < id)) return; // даём собеседнику шанс быть инициатором первым
  if (existing) mesh.remove(id);
  const link = mesh.createOutgoingLink(id);
  try {
    const packet = await link.createInitialOffer("");
    signaling.signal(id, packet);
  } catch (e) {}
}

// ---------- Экран "Контакты" ----------

// ---------- Экран "Контакты" ----------

function renderOnlineRosterList() {
  const wrap = $("#online-roster-list");
  const empty = $("#online-roster-empty");
  if (!wrap) return;
  wrap.innerHTML = "";

  const rows = Array.from(onlineRoster.entries()).filter(
    ([id, u]) => id !== Store.myId && u.visible !== false && !state.contacts.has(id)
  );

  if (rows.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  for (const [id, u] of rows) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(u.name || id)}">${initials(u.name || "?")}</div>
      <span class="roster-name">${escapeHtml(u.name || "Без имени")}</span>
      <button class="btn-secondary roster-add-btn">Добавить</button>
    `;
    row.querySelector(".roster-add-btn").addEventListener("click", () => {
      state.contacts.set(id, {
        id, name: u.name || "Без имени", raw: "", managed: true,
        online: true, status: "disconnected", messages: [], lastActivity: Date.now(),
      });
      persistContacts();
      toast("Контакт добавлен");
      scheduleAutoConnect(id);
      renderOnlineRosterList();
      state.tab = "chats";
      renderTab();
    });
    wrap.appendChild(row);
  }
}

function wireConnectScreen() {
  $("#add-contact-btn").addEventListener("click", async () => {
    const nameVal = $("#add-contact-name").value.trim();
    const raw = $("#add-contact-value").value.trim();
    if (!raw) { toast("Введите телефон или email"); return; }
    let identity;
    try { identity = await Identity.idFor(raw); }
    catch (e) { toast(e.message); return; }

    if (identity.id === Store.myId) { toast("Это ваш собственный идентификатор"); return; }

    if (state.contacts.has(identity.id)) {
      toast("Этот контакт уже добавлен");
    } else {
      state.contacts.set(identity.id, {
        id: identity.id, name: nameVal || identity.normalized, raw: identity.normalized,
        managed: true, online: onlineSet.has(identity.id), status: "disconnected",
        messages: [], lastActivity: Date.now(),
      });
      persistContacts();
      toast("Контакт добавлен");
      if (onlineSet.has(identity.id)) scheduleAutoConnect(identity.id);
    }
    $("#add-contact-name").value = "";
    $("#add-contact-value").value = "";
    state.tab = "chats";
    renderTab();
  });

  $("#toggle-manual-btn").addEventListener("click", () => {
    const sec = $("#manual-section");
    sec.classList.toggle("hidden");
    $("#toggle-manual-btn").textContent = sec.classList.contains("hidden")
      ? "Ручное подключение без сервера, по коду ›"
      : "Скрыть ручное подключение ‹";
  });

  // ---- Ручной поток (полностью без сервера), как раньше ----

  $("#create-invite-btn").addEventListener("click", createInvite);
  $("#copy-code-btn").addEventListener("click", () => copyText($("#invite-code-out").textContent, "Код скопирован"));
  $("#copy-link-btn").addEventListener("click", () => copyText($("#invite-link-out").textContent, "Ссылка скопирована"));
  $("#share-link-btn").addEventListener("click", async () => {
    const url = $("#invite-link-out").textContent;
    if (navigator.share) {
      try { await navigator.share({ title: "Приглашение в Эфир", text: "Подключимся напрямую без серверов", url }); } catch (e) {}
    } else {
      copyText(url, "Ссылка скопирована");
    }
  });

  $("#complete-invite-btn").addEventListener("click", async () => {
    const code = $("#answer-code-in").value.trim();
    if (!code || !state.pendingOutgoing) return;
    try {
      const packet = await SignalingCodec.decode(code);
      if (packet.t !== "answer") throw new Error("Это не код ответа");
      const link = mesh.get(state.pendingOutgoing.id);
      await link.acceptAnswer(packet);
      $("#answer-code-in").value = "";
      toast("Код принят — соединяемся…");
    } catch (e) {
      toast("Не удалось прочитать код: " + e.message);
    }
  });

  $("#reply-btn").addEventListener("click", async () => {
    const code = $("#paste-code-in").value.trim();
    if (!code) return;
    await handleIncomingCode(code, false);
  });

  $("#new-invite-again").addEventListener("click", resetConnectScreen);
  $("#answer-copy-btn").addEventListener("click", () => copyText($("#answer-out-code").textContent, "Код скопирован"));

  wireContactSend({
    smsBtnId: "invite-send-sms", mailBtnId: "invite-send-email", inputId: "invite-contact",
    textGetter: () =>
      `${Store.name} приглашает вас в Эфир — приложение для прямой связи без серверов. ` +
      `Откройте ссылку на устройстве, где установлено (или откроется) приложение: ${$("#invite-link-out").textContent}`,
  });

  wireContactSend({
    smsBtnId: "answer-send-sms", mailBtnId: "answer-send-email", inputId: "answer-contact",
    textGetter: () => `Код ответа для подключения в Эфир: ${$("#answer-out-code").textContent}`,
  });
}

function resetConnectScreen() {
  state.pendingOutgoing = null;
  $("#invite-idle").classList.remove("hidden");
  $("#invite-active").classList.add("hidden");
  $("#answer-code-in").value = "";
  $("#paste-code-in").value = "";
  $("#incoming-banner").classList.add("hidden");
}

async function createInvite() {
  const id = crypto.randomUUID();
  const link = mesh.createOutgoingLink(id);
  const packet = await link.createInitialOffer("");
  const code = await SignalingCodec.encode(packet);
  const shareLink = SignalingCodec.buildShareLink(code);

  state.pendingOutgoing = { id, code, shareLink };
  state.contacts.set(id, { id, name: "Приглашение…", raw: "", managed: false, online: false, status: "awaiting-answer", messages: [], lastActivity: Date.now() });

  $("#invite-idle").classList.add("hidden");
  $("#invite-active").classList.remove("hidden");
  $("#invite-code-out").textContent = code;
  $("#invite-link-out").textContent = shareLink;
}

async function handleIncomingCode(code, fromLink) {
  let packet;
  try { packet = await SignalingCodec.decode(code); }
  catch (e) { toast("Код повреждён или неполный"); return; }

  if (packet.t === "offer") {
    const id = crypto.randomUUID();
    const link = mesh.createIncomingLink(id);
    const answerPacket = await link.acceptOfferAndCreateAnswer(packet);
    const answerCode = await SignalingCodec.encode(answerPacket);
    state.contacts.set(id, { id, name: packet.n || "Собеседник", raw: "", managed: false, online: false, status: "connecting", messages: [], lastActivity: Date.now() });

    state.tab = "connect";
    renderTab();
    $("#manual-section").classList.remove("hidden");
    $("#toggle-manual-btn").textContent = "Скрыть ручное подключение ‹";
    $("#incoming-banner").classList.remove("hidden");
    $("#incoming-banner-text").textContent = `Приглашение от «${packet.n || "без имени"}» принято`;
    $("#answer-out-code").textContent = answerCode;
    $("#answer-out-wrap").classList.remove("hidden");
    $("#paste-code-wrap").classList.add("hidden");
  } else {
    toast("Это приглашение, а не код ответа — вставьте его в поле «У меня есть код»");
  }
}

function copyText(text, msg) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast(msg));
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast(msg);
  }
}

function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }

function openSmsWith(number, body) {
  if (!number) { toast("Введите номер телефона"); return; }
  const sep = isIOS() ? "&" : "?";
  location.href = `sms:${encodeURIComponent(number)}${sep}body=${encodeURIComponent(body)}`;
}

function openMailWith(email, body) {
  if (!email) { toast("Введите email"); return; }
  const subject = encodeURIComponent("Приглашение в Эфир");
  location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${encodeURIComponent(body)}`;
}

function wireContactSend({ smsBtnId, mailBtnId, inputId, textGetter }) {
  const smsBtn = document.getElementById(smsBtnId);
  const mailBtn = document.getElementById(mailBtnId);
  if (smsBtn) smsBtn.addEventListener("click", () => openSmsWith($(`#${inputId}`).value.trim(), textGetter()));
  if (mailBtn) mailBtn.addEventListener("click", () => openMailWith($(`#${inputId}`).value.trim(), textGetter()));
}

// ---------- Звонки ----------

async function beginCall(id) {
  const c = state.contacts.get(id);
  let link = mesh.get(id);
  if (!c) return;
  if (!link || !isReachable(c)) {
    if (c.managed && c.online) { toast("Соединяемся…"); attemptConnect(id, { force: true }); }
    else toast("Контакт сейчас не на связи");
    return;
  }
  try { await link.startCall(); }
  catch (e) { toast("Нет доступа к микрофону"); return; }
  openCallScreen(id, "calling");
}

function openCallScreen(id, phase) {
  state.callId = id;
  const c = state.contacts.get(id);
  $("#call-screen").classList.remove("hidden");
  $("#call-peer-name").textContent = c.name || "Без имени";
  $("#call-peer-avatar").style.background = avatarGradient(c.name);
  $("#call-peer-avatar").textContent = initials(c.name);
  $("#call-phase").textContent = phase === "calling" ? "Вызов…" : phase === "ringing" ? "Входящий вызов" : "На связи";
  startCallTimer();
}

let callTimerInterval = null;
function startCallTimer() {
  const started = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    $("#call-phase").textContent = `${mm}:${ss}`;
  }, 1000);
}

function closeCallScreen() {
  clearInterval(callTimerInterval);
  $("#call-screen").classList.add("hidden");
  $("#call-mute-btn").classList.remove("active");
  state.callId = null;
}

function wireCallScreen() {
  $("#call-hangup-btn").addEventListener("click", () => {
    const link = mesh.get(state.callId);
    if (link) link.endCall();
    closeCallScreen();
  });
  $("#call-mute-btn").addEventListener("click", () => {
    const btn = $("#call-mute-btn");
    const link = mesh.get(state.callId);
    const muted = !btn.classList.contains("active");
    if (link) link.setMuted(muted);
    btn.classList.toggle("active", muted);
  });
}

// ---------- Настройки ----------

function wireSettingsScreen() {
  $("#settings-name").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) { Store.name = v; toast("Имя обновлено"); initSignaling(); }
  });

  $("#settings-identity").addEventListener("change", async (e) => {
    const v = e.target.value.trim();
    if (!v) return;
    try {
      const identity = await Identity.idFor(v);
      Store.myIdentityRaw = identity.normalized;
      Store.myId = identity.id;
      toast("Идентификатор обновлён — переподключаемся");
      initSignaling();
    } catch (err) {
      toast(err.message);
      e.target.value = Store.myIdentityRaw;
    }
  });

  $("#save-signaling-btn").addEventListener("click", () => {
    Store.signalingUrl = $("#settings-signaling-url").value.trim();
    initSignaling();
    toast("Сохранено, подключаемся");
  });

  $("#settings-discoverable").addEventListener("change", (e) => {
    Store.discoverable = e.target.checked;
    initSignaling();
    toast(e.target.checked ? "Вы видны в общем списке онлайн" : "Вы скрыты из общего списка онлайн");
  });

  $("#glass-slider").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    Store.glassAlpha = v;
    applyGlassAlpha(v);
  });

  $$(".theme-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      Store.theme = btn.dataset.theme;
      applyTheme(btn.dataset.theme);
      $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  $("#reset-all-btn").addEventListener("click", () => {
    if (!confirm("Разорвать все соединения и удалить контакты?")) return;
    for (const id of Array.from(state.contacts.keys())) mesh.remove(id);
    for (const t of autoConnectTimers.values()) clearTimeout(t);
    autoConnectTimers.clear();
    onlineSet.clear();
    state.contacts.clear();
    Store.contactsJson = "[]";
    resetConnectScreen();
    renderTab();
    toast("Все соединения и контакты удалены");
  });

  $("#how-it-works-btn").addEventListener("click", () => $("#how-it-works-sheet").classList.remove("hidden"));
  $("#how-it-works-close").addEventListener("click", () => $("#how-it-works-sheet").classList.add("hidden"));
}

// ---------- События mesh (WebRTC-соединения) ----------

function wireMeshEvents() {
  mesh.addEventListener("link-status", (ev) => {
    const { id, status } = ev.detail;
    const c = state.contacts.get(id);
    if (!c) return;
    const wasConnected = c.status === "connected" || c.status === "in-call";
    c.status = status;

    if (status === "connected" && !wasConnected) {
      const link = mesh.get(id);
      if (link.remoteName) c.name = link.remoteName;
      if (c.managed) persistContacts();
      toast(`«${c.name}» на связи`);
      clearAutoConnectTimer(id);
      if (state.pendingOutgoing && state.pendingOutgoing.id === id) resetConnectScreen();
    }
    if (status === "disconnected") {
      if (state.callId === id) closeCallScreen();
      if (c.managed && c.online) scheduleAutoConnect(id);
    }

    if (state.chatId === id) renderChatThread();
    if (state.tab === "chats" && !state.chatId) renderChatsList();
  });

  mesh.addEventListener("message", (ev) => {
    const { id, payload } = ev.detail;
    const c = state.contacts.get(id);
    if (!c) return;

    if (payload.kind === "chat") {
      c.messages.push({ from: "them", text: payload.text, ts: payload.ts || Date.now() });
      c.lastActivity = Date.now();
      if (state.chatId === id) renderChatThread();
      else toast(`${c.name}: ${truncate(payload.text, 40)}`);
      if (state.tab === "chats") renderChatsList();
    }

    if (payload.kind === "call-state") {
      if (payload.state === "ringing" && state.callId !== id) openCallScreen(id, "ringing");
      if (payload.state === "ended" && state.callId === id) closeCallScreen();
    }
  });

  mesh.addEventListener("remote-track", (ev) => {
    const { id, stream } = ev.detail;
    let audioEl = document.getElementById("remote-audio-" + id);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = "remote-audio-" + id;
      audioEl.autoplay = true;
      audioEl.hidden = true;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
    if (state.callId === id) $("#call-phase").textContent = "На связи";
  });
}

// ---------- Старт ----------

document.addEventListener("DOMContentLoaded", initOnboarding);
