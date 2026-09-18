"use strict";

const DEFAULT_SIGNALING_URL = "wss://ether-1-baqy.onrender.com";
const MAX_MESSAGE_LENGTH = 4000;
const PENDING_ACKS_LIMIT = 1000;
const OUTBOX_LIMIT = 500;
const SEEN_DELIVER_LIMIT = 500;
const PENDING_CALL_TIMEOUT_MS = 20000;
const OUTBOX_RETRY_INTERVAL_MS = 30000;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const RECEIPT_MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_CALL_LOG = 500;
const MAX_MESSAGES_PER_CHAT = 5000;
const TYPING_DEBOUNCE_MS = 1500;
const TYPING_AUTO_CLEAR_MS = 4000;
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const UNLOCK_ATTEMPTS_LIMIT = 5;

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
  get outboxJson() { return localStorage.getItem("ether.outbox") || "[]"; },
  set outboxJson(v) { localStorage.setItem("ether.outbox", v); },
  get pendingNoKeyJson() { return localStorage.getItem("ether.pendingNoKey") || "{}"; },
  set pendingNoKeyJson(v) { localStorage.setItem("ether.pendingNoKey", v); },
  get callLogJson() { return localStorage.getItem("ether.callLog") || "[]"; },
  set callLogJson(v) { localStorage.setItem("ether.callLog", v); },
  get lastSeenJson() { return localStorage.getItem("ether.lastSeen") || "{}"; },
  set lastSeenJson(v) { localStorage.setItem("ether.lastSeen", v); },
  get draftsJson() { return localStorage.getItem("ether.drafts") || "{}"; },
  set draftsJson(v) { localStorage.setItem("ether.drafts", v); },
  get pinHash() { return localStorage.getItem("ether.pinHash") || ""; },
  set pinHash(v) { localStorage.setItem("ether.pinHash", v); },
  get pinEnabled() { return localStorage.getItem("ether.pinEnabled") === "1"; },
  set pinEnabled(v) { localStorage.setItem("ether.pinEnabled", v ? "1" : "0"); },
  get notificationsEnabled() { return localStorage.getItem("ether.notifications") === "1"; },
  set notificationsEnabled(v) { localStorage.setItem("ether.notifications", v ? "1" : "0"); },
  get myPrivateKeyJwk() {
    try { const v = localStorage.getItem("ether.privKey"); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  },
  set myPrivateKeyJwk(v) { localStorage.setItem("ether.privKey", JSON.stringify(v)); },
  get myPublicKeyJwk() {
    try { const v = localStorage.getItem("ether.pubKey"); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  },
  set myPublicKeyJwk(v) { localStorage.setItem("ether.pubKey", JSON.stringify(v)); },
  get glassAlpha() {
    const raw = parseFloat(localStorage.getItem("ether.glassAlpha") || "0.5");
    if (!Number.isFinite(raw)) return 0.5;
    return Math.min(0.85, Math.max(0.18, raw));
  },
  set glassAlpha(v) {
    if (!Number.isFinite(v)) return;
    localStorage.setItem("ether.glassAlpha", String(Math.min(0.85, Math.max(0.18, v))));
  },
  get theme() { return localStorage.getItem("ether.theme") || "auto"; },
  set theme(v) { localStorage.setItem("ether.theme", v); },
};

// ---------- Состояние ----------
const state = {
  tab: "chats",
  chatId: null,
  callId: null,
  callPhase: null,
  pendingOutgoing: null,
  contacts: new Map(),
  editingMessageId: null,
  replyTo: null,                  // { msgId, text, from, authorName }
  activeMessageContext: null,
  activeContactContext: null,
  callLog: [],
  currentCallRecord: null,
  showArchived: false,
  searchQuery: "",
  chatSearchQuery: "",
  lastSeen: {},                   // contactId -> timestamp
  drafts: {},                     // contactId -> text
  typingTimers: new Map(),        // contactId -> timeout для сброса "печатает"
  typingSendingState: new Map(),  // contactId -> bool, чтобы не спамить
  unlockAttempts: 0,
};

let mesh;
let signaling = null;
let signalingCleanup = null;
let outboxRetryTimer = null;
const onlineSet = new Set();
const onlineRoster = new Map();
const autoConnectTimers = new Map();
const recentSignalNonces = new Set();

const pendingAcks = new Map();
const outbox = new Map();
const pendingNoKey = new Map();
const seenDeliverIds = new Set();

function isDuplicateSignal(from, packet) {
  if (!packet || !packet.x) return false;
  const key = from + ":" + packet.x;
  if (recentSignalNonces.has(key)) return true;
  recentSignalNonces.add(key);
  if (recentSignalNonces.size > 200) recentSignalNonces.delete(recentSignalNonces.values().next().value);
  return false;
}

// ---------- Утилиты ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Ссылки-автолинковка. Сначала экранируем, потом находим URL и оборачиваем в <a>.
function linkify(text) {
  const esc = escapeHtml(text);
  return esc.replace(
    /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/gi,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

// Подсветка для поиска. Безопасно: применяется к уже отрендеренной разметке через
// разбиение текста, не затрагивая HTML.
function highlight(text, query) {
  if (!query) return text;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  let result = "";
  let i = 0;
  let idx = lower.indexOf(q, i);
  while (idx !== -1) {
    result += text.slice(i, idx) + `<mark class="search-hit">` + text.slice(idx, idx + q.length) + `</mark>`;
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  result += text.slice(i);
  return result;
}

function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function initials(name) {
  return String(name || "?").trim().slice(0, 2).toUpperCase() || "?";
}

function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function formatTime(ts) {
  try { return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return ""; }
}
function formatDay(ts) {
  try { return new Date(ts).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }); }
  catch (e) { return ""; }
}
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm === 0) return `${ss} сек`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60 * 1000) return "недавно";
  if (d < 3600 * 1000) return `${Math.floor(d / 60000)} мин назад`;
  if (d < 86400 * 1000) return `${Math.floor(d / 3600000)} ч назад`;
  return formatDay(ts);
}

function applyGlassAlpha(v) {
  if (!Number.isFinite(v)) v = 0.5;
  document.documentElement.style.setProperty("--glass-alpha", v.toFixed(2));
  document.documentElement.style.setProperty("--glass-blur", (14 + v * 26).toFixed(0) + "px");
}
function applyTheme(theme) { document.documentElement.dataset.theme = theme; }

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Пин-код ----------
async function hashPin(pin) {
  return sha256Hex("ether:pin:" + pin);
}

function showLockScreen() {
  $("#lock-screen").classList.remove("hidden");
  $("#onboarding").classList.add("hidden");
  $("#app-shell").classList.add("hidden");
  setTimeout(() => $("#lock-pin").focus(), 100);
}

async function tryUnlock(pin) {
  if (!pin) return;
  const h = await hashPin(pin);
  if (h === Store.pinHash) {
    state.unlockAttempts = 0;
    $("#lock-pin").value = "";
    $("#lock-screen").classList.add("hidden");
    bootAfterUnlock();
  } else {
    state.unlockAttempts++;
    $("#lock-pin").value = "";
    if (state.unlockAttempts >= UNLOCK_ATTEMPTS_LIMIT) {
      toast("Слишком много попыток. Очистить данные?");
      if (confirm("Слишком много неудачных попыток ввода пин-кода. Очистить все данные приложения?")) {
        localStorage.clear();
        location.reload();
      }
      state.unlockAttempts = 0;
    } else {
      toast("Неверный пин-код");
    }
  }
}

function bootAfterUnlock() {
  if (Store.name && Store.myId) {
    ensureKeyPair().then(startApp).catch(() => startApp());
  } else {
    $("#onboarding").classList.remove("hidden");
  }
}

// ---------- Онбординг ----------
function initBoot() {
  if (Store.pinEnabled && Store.pinHash) {
    showLockScreen();
    return;
  }
  bootAfterUnlock();
}

function initOnboarding() {
  if (Store.name && Store.myId) return; // startApp вызывается из bootAfterUnlock

  if (Store.name) $("#onboarding-name").value = Store.name;

  $("#onboarding-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameVal = $("#onboarding-name").value.trim();
    const idVal = $("#onboarding-identity").value.trim();
    if (!nameVal || !idVal) return;
    let identity;
    try { identity = await Identity.idFor(idVal); }
    catch (err) { toast(err.message); return; }
    Store.name = nameVal;
    Store.myIdentityRaw = identity.normalized;
    Store.myId = identity.id;
    await ensureKeyPair();
    $("#onboarding").classList.add("hidden");
    startApp();
  });
}

async function ensureKeyPair() {
  try {
    if (Store.myPrivateKeyJwk && Store.myPublicKeyJwk) return;
    const { publicKeyJwk, privateKeyJwk } = await CryptoHelper.generateKeyPair();
    Store.myPrivateKeyJwk = privateKeyJwk;
    Store.myPublicKeyJwk = publicKeyJwk;
  } catch (e) {
    etherLog("error", "[crypto] не удалось создать ключевую пару:", String(e));
  }
}

// ---------- Запуск ----------
function startApp() {
  $("#onboarding").classList.add("hidden");
  $("#lock-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  if (mesh) return; // защита от повторного запуска
  mesh = new MeshManager(Store.name);
  wireMeshEvents();
  wireTabBar();
  wireConnectScreen();
  wireChatScreen();
  wireCallScreen();
  wireSettingsScreen();
  wireSheetBackdrops();
  wireLockScreen();
  wireSearchHandlers();
  wireNotificationPermission();

  applyGlassAlpha(Store.glassAlpha);
  applyTheme(Store.theme);
  $("#glass-slider").value = Store.glassAlpha;
  $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === Store.theme));
  $("#settings-name").value = Store.name;
  $("#settings-identity").value = Store.myIdentityRaw;
  $("#settings-signaling-url").value = Store.signalingUrl || DEFAULT_SIGNALING_URL;
  $("#settings-discoverable").checked = Store.discoverable;
  $("#settings-notifications").checked = Store.notificationsEnabled;
  $("#settings-pinlock").checked = Store.pinEnabled;

  loadContacts();
  loadLastSeen();
  loadDrafts();
  restoreOutbox();
  restorePendingNoKey();
  loadCallLog();

  const incoming = SignalingCodec.extractCodeFromLocation();
  history.replaceState(null, "", location.pathname + location.search);
  if (incoming) handleIncomingCode(incoming, true);

  renderTab();
  initSignaling();
  startOutboxRetryLoop();
  registerServiceWorker();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function wireLockScreen() {
  $("#lock-submit").addEventListener("click", () => tryUnlock($("#lock-pin").value));
  $("#lock-pin").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock($("#lock-pin").value); });
  $("#lock-forgot").addEventListener("click", () => {
    if (confirm("Сбросить пин-код? Все данные приложения будут удалены, включая переписку.")) {
      localStorage.clear();
      location.reload();
    }
  });
}

// ---------- Контакты ----------
function loadContacts() {
  let arr = [];
  try { arr = JSON.parse(Store.contactsJson) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  for (const c of arr) {
    if (!c || typeof c.id !== "string") continue;
    state.contacts.set(c.id, {
      id: c.id, name: c.name || "", raw: c.raw || "",
      managed: true, publicKey: c.publicKey || null,
      online: false, status: "disconnected",
      messages: Array.isArray(c.messages) ? c.messages : [],
      lastActivity: c.lastActivity || 0,
      archived: !!c.archived,
      muted: !!c.muted,
      blocked: !!c.blocked,
    });
  }
}

function persistContacts() {
  const arr = Array.from(state.contacts.values())
    .filter((c) => c.managed)
    .map((c) => ({
      id: c.id, name: c.name, raw: c.raw, publicKey: c.publicKey,
      messages: c.messages, lastActivity: c.lastActivity,
      archived: c.archived, muted: c.muted, blocked: c.blocked,
    }));
  Store.contactsJson = JSON.stringify(arr);
}

function loadLastSeen() {
  try { state.lastSeen = JSON.parse(Store.lastSeenJson) || {}; } catch (e) { state.lastSeen = {}; }
  if (typeof state.lastSeen !== "object") state.lastSeen = {};
}
function persistLastSeen() { try { Store.lastSeenJson = JSON.stringify(state.lastSeen); } catch (e) {} }

function loadDrafts() {
  try { state.drafts = JSON.parse(Store.draftsJson) || {}; } catch (e) { state.drafts = {}; }
  if (typeof state.drafts !== "object") state.drafts = {};
}
function persistDrafts() { try { Store.draftsJson = JSON.stringify(state.drafts); } catch (e) {} }

function keysDiffer(a, b) { return JSON.stringify(a || null) !== JSON.stringify(b || null); }

function ensureContactEntry(id, suggestedName) {
  let c = state.contacts.get(id);
  if (!c) {
    c = {
      id, name: suggestedName || "Новый контакт", raw: "", managed: true,
      publicKey: null, online: onlineSet.has(id), status: "new",
      messages: [], lastActivity: Date.now(),
      archived: false, muted: false, blocked: false,
    };
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
    saveCurrentDraft();
    cancelEditing();
    cancelReply();
    closeChatSearch();
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
  const map = { chats: "#screen-chats", calls: "#screen-calls", connect: "#screen-connect", settings: "#screen-settings" };
  const el = $(map[state.tab]);
  if (el) el.classList.remove("hidden");
  const titles = { chats: "Чаты", calls: "Звонки", connect: "Контакты", settings: "Настройки" };
  $("#nav-title").textContent = titles[state.tab] || "Эфир";

  if (state.tab === "chats") renderChatsList();
  if (state.tab === "calls") renderCallsList();
  if (state.tab === "connect") { renderSignalingBanner(); renderOnlineRosterList(); }
}

// ---------- Статусы ----------
function contactStatusLabel(c) {
  if (c.status === "in-call") return "разговор";
  if (c.status === "connected") return "на связи";
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return "соединяемся…";
  if (c.managed) {
    if (c.online) return "в сети";
    const seen = state.lastSeen[c.id];
    if (seen) return "был(а) " + timeAgo(seen);
    return "офлайн";
  }
  return "офлайн";
}
function contactStatusClass(c) {
  if (c.status === "connected" || c.status === "in-call") return "status-connected";
  if (c.managed && c.online) return "status-connected";
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return "status-connecting";
  return "status-disconnected";
}
function isReachable(c) { return c.status === "connected" || c.status === "in-call"; }
function unreadCount(c) {
  let n = 0;
  for (const m of c.messages) if (m.from === "them" && !m.readAckSent) n++;
  return n;
}

// ---------- Список чатов ----------
function renderChatsList() {
  const list = $("#chats-list");
  const empty = $("#chats-empty");
  const archivedToggle = $("#chats-archived-toggle");
  list.innerHTML = "";

  const query = state.searchQuery.toLowerCase();
  const all = Array.from(state.contacts.values());
  const withArchived = all.some((c) => c.archived);
  const visible = all.filter((c) => {
    if (c.archived && !state.showArchived) return false;
    if (!c.archived && state.showArchived) {
      // в режиме "показать архив" — только архив? Нет, показываем всё, но с пометкой.
      return true;
    }
    return true;
  });

  const filtered = query
    ? visible.filter((c) => {
        if ((c.name || "").toLowerCase().includes(query)) return true;
        return c.messages.some((m) => (m.text || "").toLowerCase().includes(query));
      })
    : visible;

  if (filtered.length === 0) {
    empty.classList.toggle("hidden", query.length > 0);
    archivedToggle.classList.toggle("hidden", !withArchived);
    return;
  }
  empty.classList.add("hidden");
  archivedToggle.classList.toggle("hidden", !withArchived);
  $("#toggle-archived").textContent = state.showArchived ? "Скрыть архив ‹" : "Показать архив ›";

  const items = filtered.sort((a, b) => {
    const aLive = isReachable(a) || a.online ? 1 : 0;
    const bLive = isReachable(b) || b.online ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });

  for (const c of items) {
    const last = c.messages[c.messages.length - 1];
    const unread = unreadCount(c);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chat-row glass-content" + (c.archived ? " archived" : "");
    const badge = unread > 0 ? `<span class="unread-badge">${unread}</span>` : "";
    const muteIcon = c.muted ? `<span class="muted-icon" title="Без звука">🔕</span>` : "";
    const blockIcon = c.blocked ? `<span class="muted-icon" title="Заблокирован">🚫</span>` : "";
    let preview = last ? escapeHtml(truncate(last.text, 42)) : escapeHtml(contactStatusLabel(c));
    if (query && last && (last.text || "").toLowerCase().includes(query)) {
      preview = highlight(escapeHtml(truncate(last.text, 42)), state.searchQuery);
    }
    row.innerHTML = `
      <div class="avatar" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div>
      <div class="chat-row-body">
        <div class="chat-row-top">
          <span class="chat-row-name">${escapeHtml(c.name || "Без имени")} ${muteIcon}${blockIcon}</span>
          <span class="chat-row-status ${contactStatusClass(c)}">●</span>
        </div>
        <div class="chat-row-sub">${preview}${badge}</div>
      </div>
    `;
    row.addEventListener("click", () => { state.chatId = c.id; renderTab(); });
    list.appendChild(row);
  }
}

function avatarGradient(name) {
  const palettes = [
    "linear-gradient(160deg,#0A84FF,#5E5CE6)",
    "linear-gradient(160deg,#FF9F0A,#FF375F)",
    "linear-gradient(160deg,#30D158,#0A84FF)",
    "linear-gradient(160deg,#BF5AF2,#FF375F)",
    "linear-gradient(160deg,#64D2FF,#5E5CE6)",
  ];
  let h = 0;
  const s = String(name || "?");
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % palettes.length;
  return palettes[h];
}

// ---------- Тред чата ----------
function ackGlyph(ack) {
  if (ack === "failed") return `<span class="ack-tick ack-failed" title="Не доставлено — повторим">✓</span>`;
  if (ack === "read") return `<span class="ack-tick ack-read" title="Прочитано">✓</span>`;
  if (ack === "delivered") return `<span class="ack-tick ack-delivered" title="Доставлено">✓</span>`;
  return `<span class="ack-tick ack-sent" title="Отправлено">✓</span>`;
}

function renderChatThread() {
  const c = state.contacts.get(state.chatId);
  if (!c) { state.chatId = null; renderTab(); return; }
  $("#chat-peer-name").textContent = c.name || "Без имени";

  const statusEl = $("#chat-peer-status");
  const typing = state.typingTimers.has(c.id);
  if (typing) {
    statusEl.textContent = "печатает…";
    statusEl.classList.add("typing");
  } else {
    statusEl.textContent = contactStatusLabel(c);
    statusEl.classList.remove("typing");
  }

  const canCall = isReachable(c) || (c.managed && c.online);
  $("#chat-call-btn").disabled = !canCall;

  // Индикатор транспорта
  const badge = $("#chat-transport-badge");
  const link = mesh.get(c.id);
  if (link && (link.status === "connected" || link.status === "in-call")) {
    badge.textContent = "P2P";
    badge.classList.remove("hidden", "via-server");
  } else if (c.managed && c.online) {
    badge.textContent = "через сервер";
    badge.classList.add("via-server");
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

  const wrap = $("#chat-messages");
  wrap.innerHTML = "";
  const frag = document.createDocumentFragment();
  const q = state.chatSearchQuery.toLowerCase();

  for (const m of c.messages) {
    const bubble = document.createElement("div");
    bubble.className = "bubble-row " + (m.from === "me" ? "mine" : "theirs");
    const tick = m.from === "me" ? ackGlyph(m.ack) : "";
    const editedMark = m.edited ? `<span class="bubble-edited">изм.</span>` : "";
    const inner = document.createElement("div");
    inner.className = "bubble " + (m.from === "me" ? "" : "glass-content");

    let body = linkify(m.text);
    if (q && (m.text || "").toLowerCase().includes(q)) {
      body = highlight(body, state.chatSearchQuery);
    }

    let replyHtml = "";
    if (m.replyTo) {
      replyHtml = `<div class="bubble-reply"><div class="bubble-reply-author">${escapeHtml(m.replyTo.authorName || "Ответ")}</div><div class="bubble-reply-text">${escapeHtml(truncate(m.replyTo.text || "", 80))}</div></div>`;
    }
    const fwdMark = m.forwarded ? `<div class="bubble-forwarded">Переслано</div>` : "";

    let reactionsHtml = "";
    if (m.reactions && typeof m.reactions === "object") {
      const chips = Object.entries(m.reactions).filter(([, users]) => Array.isArray(users) && users.length > 0);
      if (chips.length > 0) {
        reactionsHtml = `<div class="bubble-reactions">` + chips.map(([emoji, users]) => `<span class="bubble-reaction-chip">${escapeHtml(emoji)} ${users.length}</span>`).join("") + `</div>`;
      }
    }

    inner.innerHTML = `${fwdMark}${replyHtml}${body}<span class="bubble-time">${formatTime(m.ts)}${editedMark}${tick}</span>${reactionsHtml}`;
    inner.addEventListener("click", () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      openMessageSheet(m.id, c.id);
    });
    bubble.appendChild(inner);
    frag.appendChild(bubble);
  }
  wrap.appendChild(frag);
  wrap.scrollTop = wrap.scrollHeight;

  // Восстановить черновик
  const input = $("#chat-input");
  if (state.drafts[c.id] && !state.editingMessageId) input.value = state.drafts[c.id];

  markThreadRead(c);
}

function markThreadRead(c) {
  const toAck = [];
  for (const m of c.messages) {
    if (m.from === "them" && !m.readAckSent) {
      m.readAckSent = true;
      toAck.push(m.id);
    }
  }
  if (toAck.length === 0) return;
  persistContacts();
  sendAckBatch(c.id, toAck, "read");
}

function saveCurrentDraft() {
  if (!state.chatId) return;
  const input = $("#chat-input");
  const v = input.value.trim();
  if (v) state.drafts[state.chatId] = v;
  else delete state.drafts[state.chatId];
  persistDrafts();
}

function wireChatScreen() {
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text || !state.chatId) return;
    if (state.editingMessageId) {
      commitEdit(state.chatId, state.editingMessageId, text);
      cancelEditing();
    } else {
      sendChatMessage(state.chatId, text, state.replyTo);
      cancelReply();
    }
    input.value = "";
    delete state.drafts[state.chatId];
    persistDrafts();
    sendTypingStop(state.chatId);
  });

  const input = $("#chat-input");
  let typingSendTimer = null;
  input.addEventListener("input", () => {
    if (!state.chatId) return;
    const v = input.value.trim();
    // Черновик
    if (v) state.drafts[state.chatId] = v;
    else delete state.drafts[state.chatId];
    persistDrafts();

    // Индикатор набора
    sendTypingStart(state.chatId);
    clearTimeout(typingSendTimer);
    typingSendTimer = setTimeout(() => sendTypingStop(state.chatId), TYPING_DEBOUNCE_MS);
  });

  input.addEventListener("blur", () => {
    if (state.chatId) sendTypingStop(state.chatId);
  });

  $("#chat-call-btn").addEventListener("click", () => beginCall(state.chatId));
  $("#chat-more-btn").addEventListener("click", () => openContactSheet(state.chatId));
  $("#edit-cancel-btn").addEventListener("click", () => { cancelEditing(); $("#chat-input").value = ""; });
  $("#reply-cancel-btn").addEventListener("click", () => { cancelReply(); });
}

// ---------- Отправка/редактирование/удаление/пересылка ----------
async function sendChatMessage(contactId, text, replyTo) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  if (c.blocked) { toast("Контакт заблокирован"); return; }

  if (text.length > MAX_MESSAGE_LENGTH) {
    text = text.slice(0, MAX_MESSAGE_LENGTH);
    toast("Сообщение обрезано до " + MAX_MESSAGE_LENGTH + " символов");
  }

  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId, from: "me", text, ts, ack: "sent" };
  if (replyTo) rec.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  c.messages.push(rec);
  trimMessages(c);
  c.lastActivity = ts;
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();

  const payload = { kind: "chat", id: msgId, text, ts };
  if (replyTo) payload.replyTo = { id: replyTo.msgId, text: replyTo.text, from: replyTo.from };
  await trySendOrQueue(c, msgId, payload);
}

function trimMessages(c) {
  if (c.messages.length <= MAX_MESSAGES_PER_CHAT) return;
  c.messages = c.messages.slice(-MAX_MESSAGES_PER_CHAT);
}

async function commitEdit(contactId, msgId, newText) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  const m = c.messages.find((x) => x.id === msgId);
  if (!m) return;
  newText = String(newText).slice(0, MAX_MESSAGE_LENGTH);
  m.text = newText;
  m.edited = true;
  m.ts = Date.now();
  c.lastActivity = m.ts;
  persistContacts();
  if (state.chatId === contactId) renderChatThread();

  const actionId = crypto.randomUUID();
  const payload = { kind: "edit", id: msgId, text: newText, ts: m.ts };
  await trySendOrQueue(c, actionId, payload);
}

function deleteMessageLocal(contactId, msgId) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  c.messages = c.messages.filter((x) => x.id !== msgId);
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}

async function deleteMessageForBoth(contactId, msgId) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  deleteMessageLocal(contactId, msgId);
  const actionId = crypto.randomUUID();
  const payload = { kind: "delete", id: msgId, ts: Date.now() };
  await trySendOrQueue(c, actionId, payload);
}

async function forwardMessage(msgId, fromContactId, toContactId) {
  const from = state.contacts.get(fromContactId);
  const to = state.contacts.get(toContactId);
  if (!from || !to) return;
  const m = from.messages.find((x) => x.id === msgId);
  if (!m) return;
  const text = m.text;
  const msgId2 = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId2, from: "me", text, ts, ack: "sent", forwarded: true };
  to.messages.push(rec);
  trimMessages(to);
  to.lastActivity = ts;
  persistContacts();
  toast("Переслано");
  const payload = { kind: "chat", id: msgId2, text, ts, forwarded: true };
  await trySendOrQueue(to, msgId2, payload);
}

// ---------- Outbox ----------
async function trySendOrQueue(contact, msgId, payloadObj) {
  const link = mesh.get(contact.id);
  if (link && link.send(payloadObj)) {
    addToOutbox(msgId, contact.id, payloadObj);
    setTimeout(() => {
      if (!outbox.has(msgId)) return;
      flushOutboxItem(msgId);
    }, 5000);
    return;
  }
  addToOutbox(msgId, contact.id, payloadObj);
  await flushOutboxItem(msgId);
}

function addToOutbox(msgId, to, payload) {
  if (outbox.has(msgId)) return;
  outbox.set(msgId, { msgId, to, payload, sentAt: Date.now(), attempts: 0, serverAcked: false });
  trimMap(outbox, OUTBOX_LIMIT);
  persistOutbox();
}

function persistOutbox() {
  const arr = Array.from(outbox.values()).map((e) => ({
    msgId: e.msgId, to: e.to, payload: e.payload,
    sentAt: e.sentAt, attempts: e.attempts, serverAcked: !!e.serverAcked,
  }));
  try { Store.outboxJson = JSON.stringify(arr); } catch (e) {}
}

function restoreOutbox() {
  let arr = [];
  try { arr = JSON.parse(Store.outboxJson) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  for (const e of arr) {
    if (e && typeof e.msgId === "string" && typeof e.to === "string" && e.payload) {
      outbox.set(e.msgId, {
        msgId: e.msgId, to: e.to, payload: e.payload,
        sentAt: e.sentAt || Date.now(),
        attempts: e.attempts || 0,
        serverAcked: !!e.serverAcked,
      });
    }
  }
}

async function flushOutboxItem(msgId) {
  const entry = outbox.get(msgId);
  if (!entry) return;
  const contact = state.contacts.get(entry.to);
  if (!contact) {
    outbox.delete(msgId); persistOutbox(); return;
  }
  if (!contact.publicKey) {
    if (!pendingNoKey.has(contact.id)) pendingNoKey.set(contact.id, []);
    const list = pendingNoKey.get(contact.id);
    if (!list.some((x) => x.msgId === msgId)) {
      list.push({ msgId, payload: entry.payload });
      persistPendingNoKey();
    }
    outbox.delete(msgId); persistOutbox();
    return;
  }
  try {
    const sharedKey = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, contact.publicKey);
    const envelope = await CryptoHelper.encryptJson(sharedKey, entry.payload);
    entry.attempts = (entry.attempts || 0) + 1;
    entry.lastAttemptAt = Date.now();
    persistOutbox();
    const sent = signaling && signaling.deliver(entry.to, entry.msgId, envelope, Store.myPublicKeyJwk);
    if (!sent) {
      markMessageAck(entry.to, msgId, "failed");
    } else if (entry.payload.kind === "chat") {
      const c = state.contacts.get(entry.to);
      const m = c && c.messages.find((x) => x.id === msgId);
      if (m && m.ack === "failed") m.ack = "sent";
      persistContacts();
    }
  } catch (e) {
    etherLog("error", "[crypto] ошибка шифрования:", String(e));
    markMessageAck(entry.to, msgId, "failed");
  }
}

async function flushOutbox() {
  if (!signaling || !signaling.connected) return;
  const ids = Array.from(outbox.keys());
  for (const id of ids) await flushOutboxItem(id);
  pruneOutbox();
}

function startOutboxRetryLoop() {
  if (outboxRetryTimer) clearInterval(outboxRetryTimer);
  outboxRetryTimer = setInterval(() => {
    if (outbox.size === 0) return;
    flushOutbox();
  }, OUTBOX_RETRY_INTERVAL_MS);
}

function pruneOutbox() {
  const now = Date.now();
  let changed = false;
  for (const [msgId, entry] of outbox) {
    if (now - entry.sentAt > OUTBOX_MAX_AGE_MS) {
      outbox.delete(msgId); changed = true;
      const c = state.contacts.get(entry.to);
      if (c) markMessageAck(entry.to, msgId, "failed");
    } else if (entry.payload && entry.payload.kind === "ack-batch" && now - entry.sentAt > RECEIPT_MAX_AGE_MS) {
      outbox.delete(msgId); changed = true;
    }
  }
  if (changed) persistOutbox();
}

// ---------- PendingNoKey ----------
function persistPendingNoKey() {
  const obj = {};
  for (const [cid, list] of pendingNoKey) {
    if (!list || list.length === 0) continue;
    obj[cid] = list.map((x) => ({ msgId: x.msgId, payload: x.payload }));
  }
  try { Store.pendingNoKeyJson = JSON.stringify(obj); } catch (e) {}
}

function restorePendingNoKey() {
  let obj = {};
  try { obj = JSON.parse(Store.pendingNoKeyJson) || {}; } catch (e) { obj = {}; }
  if (!obj || typeof obj !== "object") return;
  for (const cid of Object.keys(obj)) {
    const list = obj[cid];
    if (Array.isArray(list)) {
      pendingNoKey.set(cid, list.filter((x) => x && x.msgId && x.payload));
    }
  }
}

function flushPendingNoKey(contactId) {
  const list = pendingNoKey.get(contactId);
  if (!list || list.length === 0) return;
  pendingNoKey.delete(contactId);
  persistPendingNoKey();
  for (const { msgId, payload } of list) {
    addToOutbox(msgId, contactId, payload);
    flushOutboxItem(msgId);
  }
}

// ---------- Квитанции ----------
function sendAckBatch(contactId, originalMsgIds, ackState) {
  const link = mesh.get(contactId);
  const actionId = crypto.randomUUID();
  const payload = { kind: "ack-batch", ids: originalMsgIds.slice(), state: ackState };
  if (link && link.send(payload)) return;
  const c = state.contacts.get(contactId);
  if (!c) return;
  addToOutbox(actionId, contactId, payload);
  flushOutboxItem(actionId);
}

function markMessageAck(contactId, msgId, ack) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  const m = c.messages.find((mm) => mm.id === msgId && mm.from === "me");
  if (m) {
    const rank = { failed: -1, sent: 0, delivered: 1, read: 2 };
    if ((rank[ack] ?? 0) >= (rank[m.ack] ?? 0) || ack === "failed") m.ack = ack;
  }
  if (ack === "delivered" || ack === "read") {
    if (outbox.has(msgId)) {
      outbox.delete(msgId);
      persistOutbox();
    }
  }
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
}

// ---------- Typing ----------
function sendTypingStart(contactId) {
  if (state.typingSendingState.get(contactId)) return;
  state.typingSendingState.set(contactId, true);
  const c = state.contacts.get(contactId);
  if (!c) return;
  const link = mesh.get(contactId);
  const payload = { kind: "typing", active: true };
  if (link && link.send(payload)) return;
  // через сервер — без outbox, чтобы не мусорить
  if (c.publicKey && signaling && signaling.connected) {
    CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, c.publicKey)
      .then((k) => CryptoHelper.encryptJson(k, payload))
      .then((envelope) => signaling.deliver(contactId, crypto.randomUUID(), envelope, Store.myPublicKeyJwk))
      .catch(() => {});
  }
}

function sendTypingStop(contactId) {
  if (!state.typingSendingState.get(contactId)) return;
  state.typingSendingState.set(contactId, false);
  const c = state.contacts.get(contactId);
  if (!c) return;
  const link = mesh.get(contactId);
  const payload = { kind: "typing", active: false };
  if (link && link.send(payload)) return;
  if (c.publicKey && signaling && signaling.connected) {
    CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, c.publicKey)
      .then((k) => CryptoHelper.encryptJson(k, payload))
      .then((envelope) => signaling.deliver(contactId, crypto.randomUUID(), envelope, Store.myPublicKeyJwk))
      .catch(() => {});
  }
}

function handleIncomingTyping(contactId, active) {
  const t = state.typingTimers.get(contactId);
  if (t) { clearTimeout(t); state.typingTimers.delete(contactId); }
  if (active) {
    state.typingTimers.set(contactId, setTimeout(() => {
      state.typingTimers.delete(contactId);
      if (state.chatId === contactId) renderChatThread();
    }, TYPING_AUTO_CLEAR_MS));
  }
  if (state.chatId === contactId) renderChatThread();
}

// ---------- Реакции ----------
async function toggleReaction(contactId, msgId, emoji) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  const m = c.messages.find((x) => x.id === msgId);
  if (!m) return;
  if (!m.reactions || typeof m.reactions !== "object") m.reactions = {};
  if (!Array.isArray(m.reactions[emoji])) m.reactions[emoji] = [];
  const meIdx = m.reactions[emoji].indexOf(Store.myId);
  let remove = false;
  if (meIdx >= 0) {
    m.reactions[emoji].splice(meIdx, 1);
    remove = true;
    if (m.reactions[emoji].length === 0) delete m.reactions[emoji];
  } else {
    m.reactions[emoji].push(Store.myId);
  }
  persistContacts();
  if (state.chatId === contactId) renderChatThread();

  const actionId = crypto.randomUUID();
  const payload = { kind: "reaction", id: msgId, emoji, remove, ts: Date.now() };
  await trySendOrQueue(c, actionId, payload);
}

function applyReaction(contactId, payload) {
  const c = ensureContactEntry(contactId, null);
  const m = c.messages.find((x) => x.id === payload.id);
  if (!m) return;
  if (!m.reactions || typeof m.reactions !== "object") m.reactions = {};
  if (!Array.isArray(m.reactions[payload.emoji])) m.reactions[payload.emoji] = [];
  const idx = m.reactions[payload.emoji].indexOf(contactId);
  if (payload.remove) {
    if (idx >= 0) m.reactions[payload.emoji].splice(idx, 1);
    if (m.reactions[payload.emoji].length === 0) delete m.reactions[payload.emoji];
  } else {
    if (idx < 0) m.reactions[payload.emoji].push(contactId);
  }
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
}

// ---------- Сигнальный сервер ----------
function updateSignalingStatusUI(kind, text) {
  const dot = $("#signaling-status-dot");
  const label = $("#signaling-status-text");
  if (dot) dot.className = "status-dot " + kind;
  if (label) label.textContent = text;
}

function renderSignalingBanner() {
  const banner = $("#signaling-banner");
  if (!banner) return;
  if (!signaling || !signaling.connected) {
    $("#signaling-banner-text").textContent = "Нет связи с сигнальным сервером — переподключаемся…";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function initSignaling() {
  const url = effectiveSignalingUrl();
  if (signalingCleanup) { try { signalingCleanup(); } catch (e) {} signalingCleanup = null; }
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
  signaling = new SignalingClient(url, Store.myId, { name: Store.name, visible: Store.discoverable, publicKey: Store.myPublicKeyJwk });
  signalingCleanup = wireSignalingEvents(signaling);
  signaling.start();
  renderSignalingBanner();
}

function wireSignalingEvents(sig) {
  const on = (type, fn) => {
    const wrapped = (ev) => fn(ev);
    sig.addEventListener(type, wrapped);
    return { type, wrapped };
  };
  const subs = [];

  subs.push(on("connected", () => {
    updateSignalingStatusUI("online", "Подключено");
    renderSignalingBanner();
    flushOutbox();
    for (const cid of Array.from(pendingNoKey.keys())) {
      const c = state.contacts.get(cid);
      if (c && c.publicKey) flushPendingNoKey(cid);
    }
  }));

  subs.push(on("disconnected", () => {
    updateSignalingStatusUI("off", "Нет соединения — переподключаемся…");
    for (const c of state.contacts.values()) if (c.managed) {
      if (c.online) {
        state.lastSeen[c.id] = Date.now();
        persistLastSeen();
      }
      c.online = false;
    }
    onlineRoster.clear();
    renderSignalingBanner();
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  }));

  subs.push(on("replaced", () => {
    updateSignalingStatusUI("off", "Отключено — тот же id открыт в другом месте");
    toast("Этот же контакт подключён в другой вкладке");
    renderSignalingBanner();
  }));

  subs.push(on("online-list", (ev) => {
    for (const u of ev.detail.users) {
      onlineSet.add(u.id);
      onlineRoster.set(u.id, { name: u.name, visible: u.visible !== false, publicKey: u.publicKey || null });
      const c = state.contacts.get(u.id);
      if (c && c.managed) {
        c.online = true;
        if (u.publicKey && keysDiffer(u.publicKey, c.publicKey)) {
          c.publicKey = u.publicKey; persistContacts();
          flushPendingNoKey(u.id);
        }
        scheduleAutoConnect(u.id);
      }
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  }));

  subs.push(on("presence", (ev) => {
    const { id, online, name, visible, publicKey } = ev.detail;
    if (online) { onlineSet.add(id); onlineRoster.set(id, { name, visible: visible !== false, publicKey: publicKey || null }); }
    else {
      onlineSet.delete(id);
      onlineRoster.delete(id);
      state.lastSeen[id] = Date.now();
      persistLastSeen();
    }

    const c = state.contacts.get(id);
    if (c && c.managed) {
      c.online = online;
      if (online && publicKey && keysDiffer(publicKey, c.publicKey)) {
        c.publicKey = publicKey; persistContacts();
        flushPendingNoKey(id);
      }
      if (online) scheduleAutoConnect(id); else clearAutoConnectTimer(id);
      if (state.chatId === id) renderChatThread();
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  }));

  subs.push(on("signal", async (ev) => {
    const { from, data: packet } = ev.detail;
    if (!packet || !packet.t) return;
    if (isDuplicateSignal(from, packet)) return;

    if (packet.t === "offer") {
      const existing = mesh.get(from);
      const iAmSupposedToOffer = Store.myId < from;
      if (existing && existing.role === "offerer" && iAmSupposedToOffer && existing.status !== "disconnected") return;
      if (existing) mesh.remove(from);
      ensureContactEntry(from, packet.n);
      const link = mesh.createIncomingLink(from);
      try {
        const answer = await link.acceptOfferAndCreateAnswer(packet);
        if (!answer) return;
        sig.signal(from, answer);
      } catch (e) {
        etherLog("error", "[webrtc] не удалось ответить на offer:", String(e));
        mesh.remove(from);
        const c = state.contacts.get(from);
        if (c) c.status = "disconnected";
        if (state.chatId === from) renderChatThread();
        if (state.tab === "chats") renderChatsList();
      }
    } else if (packet.t === "answer") {
      const link = mesh.get(from);
      if (link) {
        try { await link.acceptAnswer(packet); }
        catch (e) {
          etherLog("error", "[webrtc] не удалось принять answer:", String(e));
          mesh.remove(from);
          const c = state.contacts.get(from);
          if (c) c.status = "disconnected";
          if (state.chatId === from) renderChatThread();
          if (state.tab === "chats") renderChatsList();
        }
      }
    }
  }));

  subs.push(on("unreachable", (ev) => {
    const c = state.contacts.get(ev.detail.to);
    if (c) { c.online = false; if (state.tab === "chats") renderChatsList(); }
  }));

  subs.push(on("deliver-ack", (ev) => {
    const { msgId } = ev.detail;
    const entry = outbox.get(msgId);
    if (entry) { entry.serverAcked = true; persistOutbox(); }
  }));

  subs.push(on("deliver", async (ev) => {
    const { from, msgId, envelope, fromPublicKey, queued } = ev.detail;
    sig.mailboxAck(msgId);
    const sender = state.contacts.get(from);
    if (sender && sender.blocked) {
      sendAckBatch(from, [msgId], "delivered"); // тихо подтверждаем, но игнорируем
      return;
    }
    if (seenDeliverIds.has(msgId)) {
      sendAckBatch(from, [msgId], "delivered");
      return;
    }
    seenDeliverIds.add(msgId);
    if (seenDeliverIds.size > SEEN_DELIVER_LIMIT) seenDeliverIds.delete(seenDeliverIds.values().next().value);

    let payload;
    try {
      const theirKey = fromPublicKey || (state.contacts.get(from) || {}).publicKey;
      if (!theirKey) throw new Error("нет публичного ключа отправителя");
      const sharedKey = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, theirKey);
      payload = await CryptoHelper.decryptJson(sharedKey, envelope);
      if (fromPublicKey) {
        const c = state.contacts.get(from);
        if (c && keysDiffer(fromPublicKey, c.publicKey)) { c.publicKey = fromPublicKey; persistContacts(); }
      }
    } catch (e) {
      etherLog("error", "[crypto] не удалось расшифровать конверт:", String(e));
      return;
    }

    applyIncomingPayload(from, msgId, payload, true);
    sendAckBatch(from, [msgId], "delivered");
  }));

  return () => { for (const s of subs) sig.removeEventListener(s.type, s.wrapped); };
}

// ---------- Обработка входящего ----------
function applyIncomingPayload(from, envelopeMsgId, payload, fromServer) {
  if (payload.kind === "chat") {
    const c = ensureContactEntry(from, null);
    if (c.messages.some((m) => m.id === payload.id)) return;
    const isOpen = state.chatId === from;
    const rec = {
      id: payload.id, from: "them",
      text: payload.text, ts: payload.ts || Date.now(),
      readAckSent: isOpen,
    };
    if (payload.replyTo) rec.replyTo = payload.replyTo;
    if (payload.forwarded) rec.forwarded = true;
    c.messages.push(rec);
    trimMessages(c);
    c.lastActivity = Date.now();
    persistContacts();
    if (isOpen) renderChatThread();
    else showIncomingNotification(c, payload.text);
    if (state.tab === "chats") renderChatsList();
    if (isOpen) sendAckBatch(from, [payload.id], "read");
  } else if (payload.kind === "edit") {
    const c = ensureContactEntry(from, null);
    const m = c.messages.find((x) => x.id === payload.id);
    if (m) {
      m.text = payload.text; m.edited = true; m.ts = payload.ts || m.ts;
      c.lastActivity = Date.now();
      persistContacts();
      if (state.chatId === from) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }
  } else if (payload.kind === "delete") {
    const c = ensureContactEntry(from, null);
    const before = c.messages.length;
    c.messages = c.messages.filter((x) => x.id !== payload.id);
    if (c.messages.length !== before) {
      persistContacts();
      if (state.chatId === from) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }
  } else if (payload.kind === "ack") {
    markMessageAck(from, payload.id, payload.state);
  } else if (payload.kind === "ack-batch" && Array.isArray(payload.ids)) {
    for (const id of payload.ids) markMessageAck(from, id, payload.state);
  } else if (payload.kind === "typing") {
    handleIncomingTyping(from, !!payload.active);
  } else if (payload.kind === "reaction") {
    applyReaction(from, payload);
  }
}

function showIncomingNotification(c, text) {
  if (!Store.notificationsEnabled) return;
  if (c.muted) return;
  if (!("Notification" in window)) return;
  if (document.visibilityState === "visible") return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(c.name || "Эфир", { body: truncate(text, 80), tag: "ether-" + c.id, silent: false });
    n.onclick = () => { window.focus(); state.chatId = c.id; renderTab(); n.close(); };
  } catch (e) {}
}

function wireNotificationPermission() {
  const el = $("#settings-notifications");
  el.addEventListener("change", async (e) => {
    if (e.target.checked) {
      if (!("Notification" in window)) { toast("Уведомления не поддерживаются"); e.target.checked = false; return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Разрешение не выдано"); e.target.checked = false; return; }
      Store.notificationsEnabled = true;
      toast("Уведомления включены");
    } else {
      Store.notificationsEnabled = false;
      toast("Уведомления выключены");
    }
  });
}

// ---------- Автоподключение ----------
function clearAutoConnectTimer(id) {
  const t = autoConnectTimers.get(id);
  if (t) clearTimeout(t);
  autoConnectTimers.delete(id);
}

function scheduleAutoConnect(id) {
  attemptConnect(id);
  if (autoConnectTimers.has(id)) return;
  autoConnectTimers.set(id, setTimeout(() => {
    autoConnectTimers.delete(id);
    attemptConnect(id, { force: true });
  }, 4000));
}

async function attemptConnect(id, { force = false } = {}) {
  if (!signaling || !signaling.connected) return;
  const existing = mesh.get(id);
  if (existing && existing.status !== "disconnected") return;
  if (!onlineSet.has(id)) return;
  const iShouldOffer = Store.myId < id;
  if (!force && !iShouldOffer) return;
  if (force && !iShouldOffer && existing && existing.role === "answerer") return;

  if (existing) mesh.remove(id);
  const link = mesh.createOutgoingLink(id);
  try {
    const packet = await link.createInitialOffer("");
    if (!packet) return;
    signaling.signal(id, packet);
    watchConnectionTimeout(id);
  } catch (e) {
    etherLog("error", "[webrtc] не удалось создать offer:", String(e));
    mesh.remove(id);
    const c = state.contacts.get(id);
    if (c) c.status = "disconnected";
    if (state.chatId === id) renderChatThread();
    if (state.tab === "chats") renderChatsList();
  }
}

function watchConnectionTimeout(id) {
  setTimeout(() => {
    const link = mesh.get(id);
    if (!link || link.status === "connected" || link.status === "in-call" || link.status === "disconnected") return;
    mesh.remove(id);
    const c = state.contacts.get(id);
    if (c) {
      c.status = "disconnected";
      if (state.chatId === id) renderChatThread();
      if (state.tab === "chats") renderChatsList();
      if (c.managed && c.online) scheduleAutoConnect(id);
    }
  }, 10000);
}

// ---------- Экран "Контакты" ----------
function renderOnlineRosterList() {
  const wrap = $("#online-roster-list");
  const empty = $("#online-roster-empty");
  if (!wrap) return;
  wrap.innerHTML = "";
  const rows = Array.from(onlineRoster.entries()).filter(
    ([id, u]) => id !== Store.myId && u.visible !== false && !state.contacts.has(id)
  );
  if (rows.length === 0) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  for (const [id, u] of rows) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(u.name || id)}">${escapeHtml(initials(u.name || "?"))}</div>
      <span class="roster-name">${escapeHtml(u.name || "Без имени")}</span>
      <button type="button" class="btn-secondary roster-add-btn">Добавить</button>
    `;
    row.querySelector(".roster-add-btn").addEventListener("click", () => {
      state.contacts.set(id, {
        id, name: u.name || "Без имени", raw: "", managed: true,
        publicKey: u.publicKey || null, online: true, status: "disconnected",
        messages: [], lastActivity: Date.now(),
        archived: false, muted: false, blocked: false,
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
        managed: true, publicKey: null, online: onlineSet.has(identity.id),
        status: "disconnected", messages: [], lastActivity: Date.now(),
        archived: false, muted: false, blocked: false,
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

  $("#create-invite-btn").addEventListener("click", createInvite);
  $("#copy-code-btn").addEventListener("click", () => copyText($("#invite-code-out").textContent, "Код скопирован"));
  $("#copy-link-btn").addEventListener("click", () => copyText($("#invite-link-out").textContent, "Ссылка скопирована"));
  $("#share-link-btn").addEventListener("click", async () => {
    const url = $("#invite-link-out").textContent;
    if (navigator.share) { try { await navigator.share({ title: "Приглашение в Эфир", url }); } catch (e) {} }
    else copyText(url, "Ссылка скопирована");
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
    } catch (e) { toast("Не удалось прочитать код: " + e.message); }
  });

  $("#reply-btn").addEventListener("click", async () => {
    const code = $("#paste-code-in").value.trim();
    if (!code) return;
    await handleIncomingCode(code);
  });

  $("#new-invite-again").addEventListener("click", resetConnectScreen);
  $("#answer-copy-btn").addEventListener("click", () => copyText($("#answer-out-code").textContent, "Код скопирован"));
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
  state.contacts.set(id, { id, name: "Приглашение…", raw: "", managed: false, online: false, status: "awaiting-answer", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false });
  $("#invite-idle").classList.add("hidden");
  $("#invite-active").classList.remove("hidden");
  $("#invite-code-out").textContent = code;
  $("#invite-link-out").textContent = shareLink;
}

async function handleIncomingCode(code) {
  let packet;
  try { packet = await SignalingCodec.decode(code); }
  catch (e) { toast("Код повреждён или неполный"); return; }
  if (packet.t === "offer") {
    const id = crypto.randomUUID();
    const link = mesh.createIncomingLink(id);
    const answerPacket = await link.acceptOfferAndCreateAnswer(packet);
    const answerCode = await SignalingCodec.encode(answerPacket);
    state.contacts.set(id, { id, name: packet.n || "Собеседник", raw: "", managed: false, online: false, status: "connecting", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false });
    state.tab = "connect"; renderTab();
    $("#manual-section").classList.remove("hidden");
    $("#toggle-manual-btn").textContent = "Скрыть ручное подключение ‹";
    $("#incoming-banner").classList.remove("hidden");
    $("#incoming-banner-text").textContent = `Приглашение от «${packet.n || "без имени"}» принято`;
    $("#answer-out-code").textContent = answerCode;
    $("#answer-out-wrap").classList.remove("hidden");
    $("#paste-code-wrap").classList.add("hidden");
  } else toast("Это приглашение, а не код ответа");
}

function copyText(text, msg) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => toast("Не удалось скопировать"));
  } else {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(msg); } catch (e) {}
    ta.remove();
  }
}

// ---------- Шиты ----------
function wireSheetBackdrops() {
  $$(".sheet-backdrop").forEach((el) => {
    el.addEventListener("click", () => {
      const sheet = el.closest(".sheet");
      if (sheet) sheet.classList.add("hidden");
    });
  });
  $$(".sheet-cancel").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.closeSheet;
      if (id) $("#" + id).classList.add("hidden");
    });
  });
}

function openMessageSheet(msgId, contactId) {
  state.activeMessageContext = { msgId, contactId };
  const c = state.contacts.get(contactId);
  if (!c) return;
  const m = c.messages.find((x) => x.id === msgId);
  if (!m) return;

  const bar = $("#reaction-bar");
  bar.innerHTML = "";
  for (const emoji of REACTION_EMOJIS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "reaction-emoji";
    b.textContent = emoji;
    b.addEventListener("click", () => {
      $("#message-sheet").classList.add("hidden");
      toggleReaction(contactId, msgId, emoji);
    });
    bar.appendChild(b);
  }

  const isOwn = m.from === "me";
  const body = $("#message-sheet-body");
  const actions = [];

  actions.push(`<button type="button" class="sheet-action" data-action="reply">
    <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
    Ответить</button>`);
  actions.push(`<button type="button" class="sheet-action" data-action="forward">
    <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>
    Переслать</button>`);
  actions.push(`<button type="button" class="sheet-action" data-action="copy">
    <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>
    Копировать текст</button>`);
  if (m.ack === "failed" && isOwn) {
    actions.push(`<button type="button" class="sheet-action" data-action="retry">
      <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
      Отправить заново</button>`);
  }
  if (isOwn) {
    actions.push(`<button type="button" class="sheet-action" data-action="edit">
      <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      Редактировать</button>`);
    actions.push(`<button type="button" class="sheet-action destructive" data-action="delete-local">
      <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 7h12l-1 13.1a2 2 0 0 1-2 1.9H9a2 2 0 0 1-2-1.9L6 7z"/></svg>
      Удалить у себя</button>`);
    actions.push(`<button type="button" class="sheet-action destructive" data-action="delete-both">
      <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 7h12l-1 13.1a2 2 0 0 1-2 1.9H9a2 2 0 0 1-2-1.9L6 7z"/></svg>
      Удалить у всех</button>`);
  } else {
    actions.push(`<button type="button" class="sheet-action destructive" data-action="delete-local">
      <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 7h12l-1 13.1a2 2 0 0 1-2 1.9H9a2 2 0 0 1-2-1.9L6 7z"/></svg>
      Удалить у себя</button>`);
  }
  body.innerHTML = actions.join("");
  body.querySelectorAll(".sheet-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      $("#message-sheet").classList.add("hidden");
      handleMessageAction(action, msgId, contactId);
    });
  });
  $("#message-sheet").classList.remove("hidden");
}

async function handleMessageAction(action, msgId, contactId) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  const m = c.messages.find((x) => x.id === msgId);
  if (!m) return;
  if (action === "copy") copyText(m.text || "", "Текст скопирован");
  else if (action === "edit") startEditing(msgId);
  else if (action === "delete-local") deleteMessageLocal(contactId, msgId);
  else if (action === "delete-both") {
    if (!confirm("Удалить сообщение у вас и у собеседника?")) return;
    await deleteMessageForBoth(contactId, msgId);
  } else if (action === "reply") {
    state.replyTo = {
      msgId: m.id,
      text: m.text,
      from: m.from,
      authorName: m.from === "me" ? (Store.name || "Вы") : (c.name || "Собеседник"),
    };
    showReplyBanner();
    $("#chat-input").focus();
  } else if (action === "forward") {
    openForwardSheet(msgId, contactId);
  } else if (action === "retry") {
    // повторная отправка из очереди или заново
    if (outbox.has(msgId)) { flushOutboxItem(msgId); toast("Повторная отправка…"); }
    else {
      addToOutbox(msgId, contactId, { kind: "chat", id: msgId, text: m.text, ts: m.ts });
      flushOutboxItem(msgId);
      toast("Повторная отправка…");
    }
  }
}

function openForwardSheet(msgId, fromContactId) {
  const list = $("#forward-list");
  list.innerHTML = "";
  const contacts = Array.from(state.contacts.values()).filter((c) => c.managed);
  if (contacts.length === 0) {
    list.innerHTML = `<p class="muted">Нет других контактов</p>`;
  }
  for (const c of contacts) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "forward-row";
    btn.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div>
      <span class="forward-name">${escapeHtml(c.name || "Без имени")}</span>
    `;
    btn.addEventListener("click", async () => {
      $("#forward-sheet").classList.add("hidden");
      await forwardMessage(msgId, fromContactId, c.id);
    });
    list.appendChild(btn);
  }
  $("#forward-sheet").classList.remove("hidden");
}

function showReplyBanner() {
  if (!state.replyTo) { $("#reply-banner").classList.add("hidden"); return; }
  $("#reply-banner").classList.remove("hidden");
  $(".reply-banner-author", $("#reply-banner")).textContent = state.replyTo.authorName;
  $(".reply-banner-text", $("#reply-banner")).textContent = truncate(state.replyTo.text, 60);
}
function cancelReply() {
  state.replyTo = null;
  $("#reply-banner").classList.add("hidden");
}

function openContactSheet(contactId) {
  state.activeContactContext = contactId;
  const c = state.contacts.get(contactId);
  if (!c) return;
  const body = $("#contact-sheet-body");
  body.innerHTML = `
    <button type="button" class="sheet-action" data-action="rename"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"/></svg>Переименовать</button>
    <button type="button" class="sheet-action" data-action="archive"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20.54 5.23 19.15 3.55A1.5 1.5 0 0 0 18 3H6a1.5 1.5 0 0 0-1.16.55L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.46-1.27zM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5z"/></svg>${c.archived ? "Разархивировать" : "В архив"}</button>
    <button type="button" class="sheet-action" data-action="mute"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16.5 12A4.5 4.5 0 0 0 14 7.97V2.5a2.5 2.5 0 0 0-5 0v5.47A4.5 4.5 0 0 0 7 12v4.5h9.5V12z"/></svg>${c.muted ? "Включить звук" : "Без звука"}</button>
    <button type="button" class="sheet-action ${c.blocked ? "" : "destructive"}" data-action="block"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM5.7 7.1l9.2 9.2a8 8 0 0 1-9.2-9.2zm12.6 9.8L9.1 7.7a8 8 0 0 1 9.2 9.2z"/></svg>${c.blocked ? "Разблокировать" : "Заблокировать"}</button>
    <button type="button" class="sheet-action" data-action="export"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>Экспорт переписки</button>
    <button type="button" class="sheet-action" data-action="clear"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>Очистить историю</button>
    <button type="button" class="sheet-action destructive" data-action="delete"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 7h12l-1 13.1a2 2 0 0 1-2 1.9H9a2 2 0 0 1-2-1.9L6 7z"/></svg>Удалить контакт</button>
  `;
  body.querySelectorAll(".sheet-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      $("#contact-sheet").classList.add("hidden");
      handleContactAction(action, contactId);
    });
  });
  $("#contact-sheet").classList.remove("hidden");
}

function handleContactAction(action, contactId) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  if (action === "rename") {
    state.activeContactContext = contactId;
    $("#rename-input").value = c.name || "";
    $("#rename-sheet").classList.remove("hidden");
    setTimeout(() => $("#rename-input").focus(), 50);
  } else if (action === "archive") {
    c.archived = !c.archived;
    persistContacts();
    renderChatsList();
    toast(c.archived ? "В архиве" : "Из архива");
  } else if (action === "mute") {
    c.muted = !c.muted;
    persistContacts();
    renderChatsList();
    toast(c.muted ? "Уведомления выключены" : "Уведомления включены");
  } else if (action === "block") {
    c.blocked = !c.blocked;
    persistContacts();
    renderChatsList();
    toast(c.blocked ? "Заблокирован" : "Разблокирован");
  } else if (action === "export") {
    exportChat(contactId);
  } else if (action === "clear") {
    if (!confirm(`Очистить всю переписку с «${c.name}»?`)) return;
    c.messages = [];
    c.lastActivity = Date.now();
    persistContacts();
    if (state.chatId === contactId) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    toast("История очищена");
  } else if (action === "delete") {
    if (!confirm(`Удалить контакт «${c.name}»?`)) return;
    deleteContact(contactId);
  }
}

function deleteContact(id) {
  clearAutoConnectTimer(id);
  mesh.remove(id);
  pendingNoKey.delete(id); persistPendingNoKey();
  for (const [msgId, entry] of outbox) if (entry.to === id) outbox.delete(msgId);
  persistOutbox();
  for (const [msgId, cid] of pendingAcks) if (cid === id) pendingAcks.delete(msgId);
  const audioEl = document.getElementById("remote-audio-" + id);
  if (audioEl) audioEl.remove();
  state.contacts.delete(id);
  persistContacts();
  if (state.callId === id) closeCallScreen();
  if (state.chatId === id) state.chatId = null;
  renderTab();
  toast("Контакт удалён");
}

function exportChat(contactId) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  const lines = c.messages.map((m) => {
    const who = m.from === "me" ? "Я" : (c.name || "Собеседник");
    const date = new Date(m.ts).toLocaleString("ru-RU");
    const react = m.reactions ? " " + Object.keys(m.reactions).join("") : "";
    return `[${date}] ${who}: ${m.text}${react}`;
  });
  const text = `Переписка с ${c.name}\n\n` + lines.join("\n");
  downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `ether-${contactId.slice(0, 8)}-${Date.now()}.txt`);
  toast("Экспортировано");
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Звонки ----------
function loadCallLog() {
  let arr = [];
  try { arr = JSON.parse(Store.callLogJson) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  state.callLog = arr.filter((e) => e && typeof e.id === "string" && typeof e.contactId === "string");
}
function persistCallLog() { try { Store.callLogJson = JSON.stringify(state.callLog.slice(-MAX_CALL_LOG)); } catch (e) {} }
function startCallRecord(contactId, direction) {
  const c = state.contacts.get(contactId);
  state.currentCallRecord = {
    id: crypto.randomUUID(), contactId,
    contactName: c ? c.name : "",
    direction,
    status: direction === "out" ? "calling" : "ringing",
    startedAt: Date.now(),
    answeredAt: null, endedAt: null, durationMs: 0,
  };
  state.callLog.push(state.currentCallRecord);
  persistCallLog();
}
function updateCallRecordStatus(status) {
  const rec = state.currentCallRecord;
  if (!rec) return;
  rec.status = status;
  if (status === "active" && !rec.answeredAt) rec.answeredAt = Date.now();
  persistCallLog();
}
function endCallRecord(finalStatus) {
  const rec = state.currentCallRecord;
  if (!rec) return;
  rec.endedAt = Date.now();
  if (rec.answeredAt) {
    rec.durationMs = rec.endedAt - rec.answeredAt;
    rec.status = finalStatus || "completed";
  } else {
    if (!finalStatus) finalStatus = rec.direction === "in" ? "missed" : "cancelled";
    rec.status = finalStatus;
  }
  state.currentCallRecord = null;
  persistCallLog();
}
function callStatusLabel(rec) {
  if (rec.status === "completed") return `Разговор · ${formatDuration(rec.durationMs)}`;
  if (rec.status === "declined") return "Отклонён";
  if (rec.status === "missed") return "Пропущен";
  if (rec.status === "cancelled") return "Отменён";
  if (rec.status === "failed") return "Не удалось";
  if (rec.status === "ringing") return "Не принят";
  return "Звонок";
}

function renderCallsList() {
  const list = $("#calls-list");
  const empty = $("#calls-empty");
  if (!list) return;
  list.innerHTML = "";
  if (state.callLog.length === 0) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  const items = state.callLog.slice().sort((a, b) => b.startedAt - a.startedAt);
  for (const rec of items) {
    const c = state.contacts.get(rec.contactId);
    const name = (c && c.name) || rec.contactName || "Без имени";
    const dirIcon = rec.direction === "in"
      ? (rec.status === "missed" ? "missed" : "in") : "out";
    const arrowSvg = rec.direction === "in"
      ? `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4v-2z"/></svg>`;
    const row = document.createElement("div");
    row.className = "call-row glass-content";
    row.innerHTML = `
      <div class="call-direction-icon ${dirIcon}">${arrowSvg}</div>
      <div class="call-body">
        <div class="call-name">${escapeHtml(name)}</div>
        <div class="call-sub">${escapeHtml(callStatusLabel(rec))} · ${escapeHtml(formatDay(rec.startedAt))} ${escapeHtml(formatTime(rec.startedAt))}</div>
      </div>
      <button type="button" class="call-back-btn" aria-label="Позвонить" ${c ? "" : "disabled"}>
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.7 21 3 13.3 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8z"/></svg>
      </button>
    `;
    const backBtn = row.querySelector(".call-back-btn");
    if (backBtn && c) {
      backBtn.addEventListener("click", (e) => { e.stopPropagation(); beginCall(rec.contactId); });
    }
    row.addEventListener("click", () => {
      if (state.contacts.has(rec.contactId)) { state.chatId = rec.contactId; renderTab(); }
    });
    list.appendChild(row);
  }
}

const pendingCall = { contactId: null, timer: null };
function clearPendingCall() {
  if (pendingCall.timer) clearTimeout(pendingCall.timer);
  pendingCall.timer = null;
  pendingCall.contactId = null;
}

async function beginCall(id) {
  const c = state.contacts.get(id);
  if (!c) return;
  if (c.blocked) { toast("Контакт заблокирован"); return; }
  const link = mesh.get(id);
  if (link && isReachable(c)) {
    try { await link.startCall(); }
    catch (e) { toast("Нет доступа к микрофону"); return; }
    openCallScreen(id, "calling");
    return;
  }
  if (!c.managed || !c.online) {
    toast("Контакт сейчас не на связи — звонок возможен только когда оба в сети");
    return;
  }
  clearPendingCall();
  pendingCall.contactId = id;
  openCallScreen(id, "calling");
  toast("Соединяемся — звонок начнётся автоматически");
  attemptConnect(id, { force: true });
  pendingCall.timer = setTimeout(() => {
    if (pendingCall.contactId !== id) return;
    const cur = state.contacts.get(id);
    if (cur && isReachable(cur)) return;
    clearPendingCall();
    toast("Не удалось установить связь");
    closeCallScreen("failed");
  }, PENDING_CALL_TIMEOUT_MS);
}

function openCallScreen(id, phase) {
  state.callId = id;
  state.callPhase = phase;
  const c = state.contacts.get(id);
  if (!c) return;
  $("#call-screen").classList.remove("hidden");
  $("#call-peer-name").textContent = c.name || "Без имени";
  $("#call-peer-avatar").style.background = avatarGradient(c.name);
  $("#call-peer-avatar").textContent = initials(c.name);
  $("#call-phase").textContent = phase === "calling" ? "Вызов…" : phase === "ringing" ? "Входящий вызов" : "На связи";
  const incoming = phase === "ringing";
  $("#call-controls-incoming").classList.toggle("hidden", !incoming);
  $("#call-controls-active").classList.toggle("hidden", incoming);
  clearInterval(callTimerInterval);
  if (phase === "active") startCallTimer();
  if (!state.currentCallRecord) {
    if (phase === "calling") startCallRecord(id, "out");
    else if (phase === "ringing") startCallRecord(id, "in");
  }
}

function setCallPhaseActive() {
  state.callPhase = "active";
  $("#call-controls-incoming").classList.add("hidden");
  $("#call-controls-active").classList.remove("hidden");
  startCallTimer();
  updateCallRecordStatus("active");
  if (state.callId && pendingRemoteStreams.has(state.callId)) {
    attachRemoteAudio(state.callId, pendingRemoteStreams.get(state.callId));
    pendingRemoteStreams.delete(state.callId);
  }
}

let callTimerInterval = null;
const pendingRemoteStreams = new Map();

function attachRemoteAudio(id, stream) {
  let audioEl = document.getElementById("remote-audio-" + id);
  if (!audioEl) {
    audioEl = document.createElement("audio");
    audioEl.id = "remote-audio-" + id;
    audioEl.autoplay = true; audioEl.hidden = true;
    document.body.appendChild(audioEl);
  }
  audioEl.srcObject = stream;
  audioEl.play().catch(() => {});
}
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
function closeCallScreen(reason) {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  clearPendingCall();
  endCallRecord(reason);
  $("#call-screen").classList.add("hidden");
  $("#call-mute-btn").classList.remove("active");
  if (state.callId) pendingRemoteStreams.delete(state.callId);
  state.callId = null;
  state.callPhase = null;
  if (state.tab === "calls") renderCallsList();
}

function wireCallScreen() {
  $("#call-hangup-btn").addEventListener("click", () => {
    const link = mesh.get(state.callId);
    if (link) link.endCall();
    closeCallScreen(state.currentCallRecord && state.currentCallRecord.answeredAt ? "completed" : "cancelled");
  });
  $("#call-mute-btn").addEventListener("click", () => {
    const btn = $("#call-mute-btn");
    const link = mesh.get(state.callId);
    const muted = !btn.classList.contains("active");
    if (link) link.setMuted(muted);
    btn.classList.toggle("active", muted);
  });
  $("#call-accept-btn").addEventListener("click", async () => {
    const link = mesh.get(state.callId);
    if (!link) return;
    try { await link.answerCall(); setCallPhaseActive(); }
    catch (e) { toast("Нет доступа к микрофону"); link.declineCall(); closeCallScreen("failed"); }
  });
  $("#call-decline-btn").addEventListener("click", () => {
    const link = mesh.get(state.callId);
    if (link) link.declineCall();
    closeCallScreen("declined");
  });
}

// ---------- Поиск ----------
function wireSearchHandlers() {
  const gs = $("#global-search");
  if (gs) gs.addEventListener("input", (e) => {
    state.searchQuery = e.target.value.trim();
    renderChatsList();
  });
  $("#toggle-archived").addEventListener("click", () => {
    state.showArchived = !state.showArchived;
    renderChatsList();
  });

  $("#chat-search-btn").addEventListener("click", () => {
    $("#chat-search-bar").classList.toggle("hidden");
    if (!$("#chat-search-bar").classList.contains("hidden")) setTimeout(() => $("#chat-search-input").focus(), 50);
    else closeChatSearch();
  });
  $("#chat-search-close").addEventListener("click", closeChatSearch);
  $("#chat-search-input").addEventListener("input", (e) => {
    state.chatSearchQuery = e.target.value.trim();
    renderChatThread();
    updateSearchCounter();
  });
}

function closeChatSearch() {
  state.chatSearchQuery = "";
  const input = $("#chat-search-input");
  if (input) input.value = "";
  $("#chat-search-bar").classList.add("hidden");
  if (state.chatId) renderChatThread();
}

function updateSearchCounter() {
  const c = state.contacts.get(state.chatId);
  if (!c) return;
  const q = state.chatSearchQuery.toLowerCase();
  if (!q) { $("#chat-search-counter").textContent = ""; return; }
  const n = c.messages.filter((m) => (m.text || "").toLowerCase().includes(q)).length;
  $("#chat-search-counter").textContent = n > 0 ? `${n} найдено` : "нет совпадений";
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
    } catch (err) { toast(err.message); e.target.value = Store.myIdentityRaw; }
  });
  $("#save-signaling-btn").addEventListener("click", () => {
    Store.signalingUrl = $("#settings-signaling-url").value.trim();
    initSignaling(); toast("Сохранено");
  });
  $("#settings-discoverable").addEventListener("change", (e) => {
    Store.discoverable = e.target.checked;
    initSignaling();
    toast(e.target.checked ? "Вы видны в списке" : "Вы скрыты");
  });
  $("#settings-pinlock").addEventListener("change", (e) => {
    if (e.target.checked) {
      state.activeContactContext = null;
      $("#set-pin-title").textContent = Store.pinHash ? "Введите пин-код для подтверждения" : "Новый пин-код (4-8 цифр)";
      $("#set-pin-input").value = "";
      $("#set-pin-sheet").classList.remove("hidden");
      setTimeout(() => $("#set-pin-input").focus(), 50);
    } else {
      // подтверждение — снять пин
      $("#set-pin-title").textContent = "Введите текущий пин-код";
      $("#set-pin-sheet").classList.remove("hidden");
      $("#set-pin-input").value = "";
      setTimeout(() => $("#set-pin-input").focus(), 50);
    }
  });
  $("#set-pin-save-btn").addEventListener("click", async () => {
    const v = $("#set-pin-input").value.trim();
    if (!v || v.length < 4) { toast("Минимум 4 цифры"); return; }
    if (!/^\d+$/.test(v)) { toast("Только цифры"); return; }
    if ($("#settings-pinlock").checked) {
      // Включение
      if (Store.pinHash) {
        // требуется подтвердить существующий
        const h = await hashPin(v);
        if (h !== Store.pinHash) { toast("Неверный пин-код"); return; }
        // перенастроить
        $("#set-pin-title").textContent = "Новый пин-код";
        $("#set-pin-input").value = "";
        return;
      }
      Store.pinHash = await hashPin(v);
      Store.pinEnabled = true;
      $("#set-pin-sheet").classList.add("hidden");
      toast("Пин-код включён");
    } else {
      // Выключение — подтвердить текущий
      const h = await hashPin(v);
      if (h !== Store.pinHash) { toast("Неверный пин-код"); return; }
      Store.pinEnabled = false;
      Store.pinHash = "";
      $("#settings-pinlock").checked = false;
      $("#set-pin-sheet").classList.add("hidden");
      toast("Пин-код отключён");
    }
  });
  $("#glass-slider").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    Store.glassAlpha = v;
    applyGlassAlpha(Store.glassAlpha);
  });
  $$(".theme-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      Store.theme = btn.dataset.theme;
      applyTheme(btn.dataset.theme);
      $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  $("#reset-all-btn").addEventListener("click", () => {
    if (!confirm("Разорвать все соединения и удалить контакты? История звонков тоже будет удалена.")) return;
    for (const id of Array.from(state.contacts.keys())) mesh.remove(id);
    for (const t of autoConnectTimers.values()) clearTimeout(t);
    autoConnectTimers.clear();
    onlineSet.clear();
    pendingAcks.clear();
    outbox.clear();
    pendingNoKey.clear();
    seenDeliverIds.clear();
    state.contacts.clear();
    state.callLog = [];
    state.currentCallRecord = null;
    state.lastSeen = {};
    state.drafts = {};
    Store.contactsJson = "[]";
    Store.outboxJson = "[]";
    Store.pendingNoKeyJson = "{}";
    Store.callLogJson = "[]";
    Store.lastSeenJson = "{}";
    Store.draftsJson = "{}";
    resetConnectScreen();
    renderTab();
    toast("Все данные удалены");
  });
  $("#export-backup-btn").addEventListener("click", exportBackup);
  $("#import-backup-btn").addEventListener("click", () => $("#import-backup-input").click());
  $("#import-backup-input").addEventListener("change", importBackup);
  $("#how-it-works-btn").addEventListener("click", () => $("#how-it-works-sheet").classList.remove("hidden"));
  $("#how-it-works-close").addEventListener("click", () => $("#how-it-works-sheet").classList.add("hidden"));
  $("#diagnostics-btn").addEventListener("click", () => { renderDiagnostics(); $("#diagnostics-sheet").classList.remove("hidden"); });
  $("#diagnostics-close").addEventListener("click", () => $("#diagnostics-sheet").classList.add("hidden"));
  $("#diagnostics-refresh-btn").addEventListener("click", renderDiagnostics);
  $("#diagnostics-copy-btn").addEventListener("click", () => copyText(buildDiagnosticsText(), "Диагностика скопирована"));
}

function exportBackup() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("ether.")) data[k] = localStorage.getItem(k);
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  downloadBlob(blob, `ether-backup-${new Date().toISOString().slice(0, 10)}.json`);
  toast("Резервная копия сохранена");
}

async function importBackup(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("Неверный формат");
    if (!confirm("Импорт заменит все текущие данные. Продолжить?")) return;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("ether.")) localStorage.removeItem(k);
    }
    for (const k of Object.keys(data)) {
      if (k.startsWith("ether.")) localStorage.setItem(k, data[k]);
    }
    toast("Данные импортированы — перезагрузка");
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    toast("Не удалось импортировать: " + e.message);
  }
}

function buildDiagnosticsText() {
  const lines = [];
  lines.push("=== Эфир — диагностика ===");
  lines.push("Время: " + new Date().toLocaleString("ru-RU"));
  lines.push("Мой id: " + (Store.myId ? Store.myId.slice(0, 16) + "…" : "(не задан)"));
  lines.push("Сигнальный сервер: " + effectiveSignalingUrl());
  lines.push("Статус: " + (signaling ? (signaling.connected ? "подключён" : "не подключён") : "не инициализирован"));
  lines.push("Онлайн: " + onlineSet.size + " (roster: " + onlineRoster.size + ")");
  lines.push("outbox: " + outbox.size + ", pendingAcks: " + pendingAcks.size + ", pendingNoKey: " + pendingNoKey.size);
  lines.push("Звонков: " + state.callLog.length);
  lines.push("");
  lines.push("--- Контакты ---");
  for (const c of state.contacts.values()) {
    lines.push(`${c.name} | id=${String(c.id).slice(0, 10)}… | online=${c.online} | status=${c.status} | сообщений=${c.messages.length} | arch=${c.archived} mute=${c.muted} block=${c.blocked}`);
  }
  lines.push("");
  lines.push("--- Журнал ---");
  const log = window.__etherDiag || [];
  for (const entry of log.slice(-80)) {
    const d = new Date(entry.ts);
    const stamp = `${d.toLocaleTimeString("ru-RU")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    lines.push(`[${stamp}] [${entry.level}] ${entry.line}`);
  }
  return lines.join("\n");
}

function renderDiagnostics() {
  const idShort = Store.myId ? escapeHtml(String(Store.myId).slice(0, 16)) + "…" : "не задан";
  $("#diagnostics-summary").innerHTML = `
    <div><b>Мой id:</b> ${idShort}</div>
    <div><b>Сервер:</b> ${escapeHtml(effectiveSignalingUrl())}</div>
    <div><b>Статус:</b> ${signaling ? (signaling.connected ? "✅ подключён" : "⚠️ не подключён") : "⚠️ не инициализирован"}</div>
    <div><b>Онлайн:</b> ${onlineSet.size}</div>
    <div><b>Контактов:</b> ${state.contacts.size}</div>
    <div><b>В очереди:</b> ${outbox.size}</div>
  `;
  $("#diagnostics-log").textContent = buildDiagnosticsText();
}

// ---------- Mesh события ----------
function wireMeshEvents() {
  mesh.addEventListener("link-status", (ev) => {
    const { id, status } = ev.detail;
    const c = state.contacts.get(id);
    if (!c) return;
    const wasConnected = c.status === "connected" || c.status === "in-call";
    c.status = status;

    if (status === "connected" && !wasConnected) {
      const link = mesh.get(id);
      if (link && link.remoteName) c.name = link.remoteName;
      if (c.managed) persistContacts();
      toast(`«${c.name}» на связи`);
      clearAutoConnectTimer(id);
      if (state.pendingOutgoing && state.pendingOutgoing.id === id) resetConnectScreen();
      if (pendingCall.contactId === id && link) {
        clearPendingCall();
        link.startCall().catch(() => { toast("Нет доступа к микрофону"); closeCallScreen("failed"); });
      }
      flushOutbox();
    }
    if (status === "disconnected") {
      if (state.callId === id) closeCallScreen("missed");
      if (c.managed && c.online) scheduleAutoConnect(id);
      sendTypingStop(id);
    }
    if (state.chatId === id) renderChatThread();
    if (state.tab === "chats" && !state.chatId) renderChatsList();
  });

  mesh.addEventListener("message", (ev) => {
    const { id, payload } = ev.detail;
    const c = state.contacts.get(id);
    if (!c) return;
    if (c.blocked) return;
    applyIncomingPayload(id, payload && payload.id, payload, false);
  });

  mesh.addEventListener("remote-track", (ev) => {
    const { id, stream } = ev.detail;
    if (state.callId === id && state.callPhase !== "active") {
      pendingRemoteStreams.set(id, stream);
      return;
    }
    attachRemoteAudio(id, stream);
  });
}

// ---------- Boot-recovery ----------
function showBootRecovery() {
  document.getElementById("onboarding").classList.add("hidden");
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("lock-screen").classList.add("hidden");
  document.getElementById("boot-recovery").classList.remove("hidden");
}
function bootDidNotRender() {
  const onboardingHidden = document.getElementById("onboarding").classList.contains("hidden");
  const appHidden = document.getElementById("app-shell").classList.contains("hidden");
  const lockHidden = document.getElementById("lock-screen").classList.contains("hidden");
  const recoveryHidden = document.getElementById("boot-recovery").classList.contains("hidden");
  return onboardingHidden && appHidden && lockHidden && recoveryHidden;
}
const bootWatchdog = setTimeout(() => { if (bootDidNotRender()) showBootRecovery(); }, 8000);
window.addEventListener("error", () => { if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); } });
window.addEventListener("unhandledrejection", () => { if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); } });

document.addEventListener("DOMContentLoaded", () => {
  try {
    initOnboarding();
    initBoot();
    clearTimeout(bootWatchdog);
  } catch (e) { showBootRecovery(); }
});

document.getElementById("boot-recovery-reset")?.addEventListener("click", () => {
  localStorage.clear();
  if ("caches" in window) caches.keys().then((names) => names.forEach((n) => caches.delete(n)));
  location.reload();
});

// Регистрируем обработчики, зависящие от DOM, после загрузки
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("rename-save-btn");
  if (btn) btn.addEventListener("click", () => {
    const id = state.activeContactContext;
    const v = $("#rename-input").value.trim();
    if (!id || !v) return;
    const c = state.contacts.get(id);
    if (!c) return;
    c.name = v.slice(0, 40);
    persistContacts();
    $("#rename-sheet").classList.add("hidden");
    if (state.chatId === id) renderChatThread();
    renderChatsList();
    toast("Имя обновлено");
  });
});

// Автосохранение черновика при уходе со страницы
window.addEventListener("beforeunload", () => {
  try { saveCurrentDraft(); } catch (e) {}
});