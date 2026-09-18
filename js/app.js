"use strict";

const DEFAULT_SIGNALING_URL = "wss://ether-1-baqy.onrender.com";
const MAX_MESSAGE_LENGTH = 4000;
const PENDING_ACKS_LIMIT = 1000;
const OUTBOX_LIMIT = 500;
const SEEN_DELIVER_LIMIT = 500;
const PENDING_CALL_TIMEOUT_MS = 20000;
const OUTBOX_RETRY_INTERVAL_MS = 15000;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const RECEIPT_MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_CALL_LOG = 500;
const MAX_MESSAGES_PER_CHAT = 5000;
const TYPING_DEBOUNCE_MS = 1200;
const TYPING_AUTO_CLEAR_MS = 4000;
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const UNLOCK_ATTEMPTS_LIMIT = 5;
const P2P_FALLBACK_MS = 1500;

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
  get vapidPublicKey() { return localStorage.getItem("ether.vapidPublicKey") || ""; },
  set vapidPublicKey(v) { if (v) localStorage.setItem("ether.vapidPublicKey", v); },
  get pushSubscriptionJson() { return localStorage.getItem("ether.pushSubscription") || ""; },
  set pushSubscriptionJson(v) {
    if (v) localStorage.setItem("ether.pushSubscription", v);
    else localStorage.removeItem("ether.pushSubscription");
  },
  get notifBannerDismissed() { return localStorage.getItem("ether.notifBannerDismissed") === "1"; },
  set notifBannerDismissed(v) { localStorage.setItem("ether.notifBannerDismissed", v ? "1" : "0"); },
  get myPrivateKeyJwk() { try { const v = localStorage.getItem("ether.privKey"); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set myPrivateKeyJwk(v) { localStorage.setItem("ether.privKey", JSON.stringify(v)); },
  get myPublicKeyJwk() { try { const v = localStorage.getItem("ether.pubKey"); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set myPublicKeyJwk(v) { localStorage.setItem("ether.pubKey", JSON.stringify(v)); },
  get glassAlpha() { const raw = parseFloat(localStorage.getItem("ether.glassAlpha") || "0.5"); if (!Number.isFinite(raw)) return 0.5; return Math.min(0.85, Math.max(0.18, raw)); },
  set glassAlpha(v) { if (!Number.isFinite(v)) return; localStorage.setItem("ether.glassAlpha", String(Math.min(0.85, Math.max(0.18, v)))); },
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
  replyTo: null,
  activeMessageContext: null,
  activeContactContext: null,
  callLog: [],
  currentCallRecord: null,
  showArchived: false,
  searchQuery: "",
  chatSearchQuery: "",
  lastSeen: {},
  drafts: {},
  typingTimers: new Map(),
  typingSendingState: new Map(),
  unlockAttempts: 0,
};

let mesh = null;
let signaling = null;
let signalingCleanup = null;
let outboxRetryTimer = null;
let swRegistration = null;
let __lockWired = false;
let __appStarted = false;
const onlineSet = new Set();
const onlineRoster = new Map();
const autoConnectTimers = new Map();
const recentSignalNonces = new Set();
const pendingAcks = new Map();
const outbox = new Map();
const pendingNoKey = new Map();
const seenDeliverIds = new Set();

const pendingCall = { contactId: null, timer: null };
const pendingRemoteStreams = new Map();
let callTimerInterval = null;
let ringtoneCtx = null;
let ringtoneTimer = null;

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
function linkify(text) {
  const esc = escapeHtml(text);
  return esc.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/gi, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}
function highlight(text, query) {
  if (!query) return text;
  const q = query.toLowerCase(), lower = text.toLowerCase();
  let result = "", i = 0, idx = lower.indexOf(q, i);
  while (idx !== -1) {
    result += text.slice(i, idx) + `<mark class="search-hit">` + text.slice(idx, idx + q.length) + `</mark>`;
    i = idx + q.length; idx = lower.indexOf(q, i);
  }
  return result + text.slice(i);
}
function truncate(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function initials(name) { return String(name || "?").trim().slice(0, 2).toUpperCase() || "?"; }

function toast(message) {
  const el = $("#toast"); if (!el) return;
  el.textContent = message; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}
function formatTime(ts) { try { return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
function formatDay(ts) { try { return new Date(ts).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }); } catch (e) { return ""; } }
function formatDuration(ms) { const s = Math.max(0, Math.floor(ms / 1000)), mm = Math.floor(s / 60), ss = s % 60; return mm === 0 ? `${ss} сек` : `${mm}:${String(ss).padStart(2, "0")}`; }
function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60000) return "недавно";
  if (d < 3600000) return `${Math.floor(d / 60000)} мин назад`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} ч назад`;
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
async function hashPin(pin) { return sha256Hex("ether:pin:" + pin); }

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function isStandalone() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      || (window.navigator && window.navigator.standalone === true);
}

function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }

// ---------- Пин-код ----------
function showLockScreen() {
  $("#lock-screen").classList.remove("hidden");
  $("#onboarding").classList.add("hidden");
  $("#app-shell").classList.add("hidden");
  setTimeout(() => { const p = $("#lock-pin"); if (p) p.focus(); }, 100);
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
      if (confirm("Слишком много неудачных попыток ввода пин-кода. Очистить все данные приложения?")) {
        localStorage.clear();
        location.reload();
      }
      state.unlockAttempts = 0;
    } else toast("Неверный пин-код");
  }
}

function wireLockScreen() {
  if (__lockWired) return;
  __lockWired = true;
  const submit = $("#lock-submit"), pin = $("#lock-pin"), forgot = $("#lock-forgot");
  if (submit) submit.addEventListener("click", (e) => { e.preventDefault(); tryUnlock(pin ? pin.value : ""); });
  if (pin) pin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tryUnlock(pin.value); } });
  if (forgot) forgot.addEventListener("click", () => {
    if (confirm("Сбросить пин-код? Все данные приложения будут удалены.")) { localStorage.clear(); location.reload(); }
  });
}

// ---------- Онбординг ----------
function bootAfterUnlock() {
  if (__appStarted) return;
  if (Store.name && Store.myId) {
    Promise.all([
      ensureKeyPair().catch(() => {}),
      window.__etherIceReady || Promise.resolve(),
    ]).then(startApp).catch(() => startApp());
  } else {
    $("#onboarding").classList.remove("hidden");
    wireOnboardingOnce();
  }
}

function initBoot() {
  wireLockScreen();
  if (Store.pinEnabled && Store.pinHash) { showLockScreen(); return; }
  bootAfterUnlock();
}

let __onboardingWired = false;
function wireOnboardingOnce() {
  if (__onboardingWired) return;
  __onboardingWired = true;
  if (Store.name) { const el = $("#onboarding-name"); if (el) el.value = Store.name; }
  const form = $("#onboarding-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
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
    await (window.__etherIceReady || Promise.resolve());
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
  } catch (e) { console.error("[crypto] key pair:", e); }
}

// ---------- Запуск ----------
function startApp() {
  if (__appStarted) {
    $("#onboarding").classList.add("hidden");
    $("#lock-screen").classList.add("hidden");
    $("#app-shell").classList.remove("hidden");
    return;
  }
  __appStarted = true;

  $("#onboarding").classList.add("hidden");
  $("#lock-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");

  mesh = new MeshManager(Store.name);
  wireMeshEvents();
  wireTabBar();
  wireConnectScreen();
  wireChatScreen();
  wireCallScreen();
  wireSettingsScreen();
  wireSheetBackdrops();
  wireSearchHandlers();
  wireNotificationPermission();
  wireServiceWorker();
  wireRenameSheet();
  wireNotifBanner();

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

  loadContacts(); loadLastSeen(); loadDrafts();
  restoreOutbox(); restorePendingNoKey(); loadCallLog();

  const incoming = SignalingCodec.extractCodeFromLocation();
  history.replaceState(null, "", location.pathname + location.search);
  if (incoming) handleIncomingCode(incoming);

  renderTab();
  initSignaling();
  startOutboxRetryLoop();
  updateNotifBanner();
}

function wireServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    swRegistration = reg;
    // Автоматически проверяем/восстанавливаем push subscription
    setTimeout(() => { ensurePushSubscription().catch(() => {}); }, 1000);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (ev) => {
    const data = ev.data || {};
    if (data.type === "open-contact" && data.contactId) {
      window.focus();
      state.chatId = data.contactId;
      renderTab();
    }
    if (data.type === "push-subscription-changed") {
      ensurePushSubscription().catch(() => {});
    }
  });
}

// ---------- Web Push ----------
async function ensurePushSubscription() {
  if (!Store.notificationsEnabled) return null;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  if (!Store.vapidPublicKey) return null;

  let reg;
  try { reg = await navigator.serviceWorker.ready; }
  catch (e) { return null; }

  let sub = null;
  try { sub = await reg.pushManager.getSubscription(); }
  catch (e) { sub = null; }

  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(Store.vapidPublicKey),
      });
    } catch (e) {
      console.warn("[push] не удалось подписаться:", e);
      return null;
    }
  }

  const subJson = sub.toJSON ? sub.toJSON() : sub;
  Store.pushSubscriptionJson = JSON.stringify(subJson);

  if (signaling && signaling.connected) {
    signaling.sendPushSubscription(subJson);
  }
  return sub;
}

function showNotification(title, body, opts) {
  opts = opts || {};
  if (!Store.notificationsEnabled) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  // Если вкладка видима и это не звонок — не показываем баннер,
  // потому что пользователь и так видит чат.
  if (document.visibilityState === "visible" && !opts.force) return;

  const payload = {
    type: "show-notification",
    title,
    body,
    tag: opts.tag || "ether",
    contactId: opts.contactId || null,
    kind: opts.kind || "message",
  };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(payload);
    return;
  }
  if (swRegistration && swRegistration.active) {
    swRegistration.active.postMessage(payload);
    return;
  }
  try { new Notification(title, { body, tag: payload.tag }); } catch (e) {}
}

function wireNotificationPermission() {
  const el = $("#settings-notifications");
  if (!el) return;
  el.addEventListener("change", async (e) => {
    if (e.target.checked) {
      if (!("Notification" in window)) { toast("Уведомления не поддерживаются"); e.target.checked = false; return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Разрешение не выдано"); e.target.checked = false; return; }
      Store.notificationsEnabled = true;
      // Автоматическая подписка на push
      ensurePushSubscription().catch(() => {});
      toast("Уведомления включены");
      updateNotifBanner();
    } else {
      Store.notificationsEnabled = false;
      // Отписываемся
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch (e) {}
      Store.pushSubscriptionJson = "";
      if (signaling && signaling.connected) signaling.sendPushUnsubscribe();
      toast("Уведомления выключены");
    }
  });
}

function wireNotifBanner() {
  const enableBtn = $("#notif-enable-btn");
  const dismissBtn = $("#notif-dismiss-btn");
  if (enableBtn) enableBtn.addEventListener("click", async () => {
    if (!("Notification" in window)) { toast("Уведомления не поддерживаются"); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Разрешение не выдано"); return; }
    Store.notificationsEnabled = true;
    const cb = $("#settings-notifications"); if (cb) cb.checked = true;
    ensurePushSubscription().catch(() => {});
    toast("Уведомления включены");
    updateNotifBanner();
  });
  if (dismissBtn) dismissBtn.addEventListener("click", () => {
    Store.notifBannerDismissed = true;
    updateNotifBanner();
  });
}

function updateNotifBanner() {
  const banner = $("#notif-banner");
  if (!banner) return;
  const supported = ("Notification" in window) && ("serviceWorker" in navigator) && ("PushManager" in window);
  const granted = supported && Notification.permission === "granted";
  const enabled = Store.notificationsEnabled && granted;
  const dismissed = Store.notifBannerDismissed;
  if (!supported || enabled || dismissed) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
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
      archived: !!c.archived, muted: !!c.muted, blocked: !!c.blocked,
    });
  }
}
function persistContacts() {
  const arr = Array.from(state.contacts.values()).filter((c) => c.managed).map((c) => ({
    id: c.id, name: c.name, raw: c.raw, publicKey: c.publicKey,
    messages: c.messages, lastActivity: c.lastActivity,
    archived: c.archived, muted: c.muted, blocked: c.blocked,
  }));
  Store.contactsJson = JSON.stringify(arr);
}
function loadLastSeen() { try { state.lastSeen = JSON.parse(Store.lastSeenJson) || {}; } catch (e) { state.lastSeen = {}; } if (typeof state.lastSeen !== "object") state.lastSeen = {}; }
function persistLastSeen() { try { Store.lastSeenJson = JSON.stringify(state.lastSeen); } catch (e) {} }
function loadDrafts() { try { state.drafts = JSON.parse(Store.draftsJson) || {}; } catch (e) { state.drafts = {}; } if (typeof state.drafts !== "object") state.drafts = {}; }
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

// ---------- Навигация ----------
function wireTabBar() {
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      state.chatId = null;
      renderTab();
    });
  });
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest("#chat-back")) {
      ev.preventDefault();
      closeChatSafely();
    }
  });
}

function closeChatSafely() {
  const prevId = state.chatId;
  state.chatId = null;
  try { if (prevId) sendTypingStop(prevId); } catch (e) {}
  try { saveCurrentDraft(); } catch (e) {}
  try { cancelEditing(); } catch (e) {}
  try { cancelReply(); } catch (e) {}
  try { closeChatSearch(); } catch (e) {}
  try { renderTab(); } catch (e) {}
}

function renderTab() {
  try { renderTabInner(); }
  catch (e) { console.error("[renderTab] упал:", e); }
}
function renderTabInner() {
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
function unreadCount(c) { let n = 0; for (const m of c.messages) if (m.from === "them" && !m.readAckSent) n++; return n; }

function renderChatsList() {
  const list = $("#chats-list"), empty = $("#chats-empty"), archivedToggle = $("#chats-archived-toggle");
  if (!list) return;
  list.innerHTML = "";
  const query = state.searchQuery.toLowerCase();
  const all = Array.from(state.contacts.values());
  const withArchived = all.some((c) => c.archived);
  const visible = all.filter((c) => c.archived ? state.showArchived : true);
  const filtered = query
    ? visible.filter((c) => (c.name || "").toLowerCase().includes(query) || c.messages.some((m) => (m.text || "").toLowerCase().includes(query)))
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
    const aLive = isReachable(a) || a.online ? 1 : 0, bLive = isReachable(b) || b.online ? 1 : 0;
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
    if (query && last && (last.text || "").toLowerCase().includes(query)) preview = highlight(escapeHtml(truncate(last.text, 42)), state.searchQuery);
    row.innerHTML = `
      <div class="avatar" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div>
      <div class="chat-row-body">
        <div class="chat-row-top">
          <span class="chat-row-name">${escapeHtml(c.name || "Без имени")} ${muteIcon}${blockIcon}</span>
          <span class="chat-row-status ${contactStatusClass(c)}">●</span>
        </div>
        <div class="chat-row-sub">${preview}${badge}</div>
      </div>`;
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
  let h = 0; const s = String(name || "?");
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % palettes.length;
  return palettes[h];
}

function ackGlyph(ack) {
  if (ack === "failed") return `<span class="ack-tick ack-failed" title="Не доставлено">✓</span>`;
  if (ack === "read") return `<span class="ack-tick ack-read" title="Прочитано">✓</span>`;
  if (ack === "delivered") return `<span class="ack-tick ack-delivered" title="Доставлено">✓</span>`;
  return `<span class="ack-tick ack-sent" title="Отправлено">✓</span>`;
}

function renderChatThread() {
  try { renderChatThreadInner(); }
  catch (e) {
    console.error("[renderChatThread] упал:", e);
    const w = $("#chat-messages");
    if (w) w.innerHTML = `<div class="empty-state"><p>Не удалось отрисовать переписку.</p></div>`;
  }
}
function renderChatThreadInner() {
  const c = state.contacts.get(state.chatId);
  if (!c) { state.chatId = null; renderTab(); return; }
  $("#chat-peer-name").textContent = c.name || "Без имени";
  const statusEl = $("#chat-peer-status");
  const typing = state.typingTimers.has(c.id);
  statusEl.textContent = typing ? "печатает…" : contactStatusLabel(c);
  statusEl.classList.toggle("typing", typing);
  const canCall = isReachable(c) || (c.managed && c.online);
  $("#chat-call-btn").disabled = !canCall;
  const badge = $("#chat-transport-badge");
  const link = mesh.get(c.id);
  if (link && (link.status === "connected" || link.status === "in-call")) {
    badge.textContent = "P2P"; badge.classList.remove("hidden", "via-server");
  } else if (c.managed && c.online) {
    badge.textContent = "через сервер"; badge.classList.add("via-server"); badge.classList.remove("hidden");
  } else badge.classList.add("hidden");
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
    if (q && (m.text || "").toLowerCase().includes(q)) body = highlight(body, state.chatSearchQuery);
    let replyHtml = "";
    if (m.replyTo) replyHtml = `<div class="bubble-reply"><div class="bubble-reply-author">${escapeHtml(m.replyTo.authorName || "Ответ")}</div><div class="bubble-reply-text">${escapeHtml(truncate(m.replyTo.text || "", 80))}</div></div>`;
    const fwdMark = m.forwarded ? `<div class="bubble-forwarded">Переслано</div>` : "";
    let reactionsHtml = "";
    if (m.reactions && typeof m.reactions === "object") {
      const chips = Object.entries(m.reactions).filter(([, users]) => Array.isArray(users) && users.length > 0);
      if (chips.length > 0) reactionsHtml = `<div class="bubble-reactions">` + chips.map(([emoji, users]) => `<span class="bubble-reaction-chip">${escapeHtml(emoji)} ${users.length}</span>`).join("") + `</div>`;
    }
    inner.innerHTML = `${fwdMark}${replyHtml}${body}<span class="bubble-time">${formatTime(m.ts)}${editedMark}${tick}</span>${reactionsHtml}`;
    inner.addEventListener("click", () => { const sel = window.getSelection(); if (sel && sel.toString().length > 0) return; openMessageSheet(m.id, c.id); });
    bubble.appendChild(inner);
    frag.appendChild(bubble);
  }
  wrap.appendChild(frag);
  wrap.scrollTop = wrap.scrollHeight;
  const input = $("#chat-input");
  if (state.drafts[c.id] && !state.editingMessageId) input.value = state.drafts[c.id];
  markThreadRead(c);
}

function markThreadRead(c) {
  const toAck = [];
  for (const m of c.messages) if (m.from === "them" && !m.readAckSent) { m.readAckSent = true; toAck.push(m.id); }
  if (toAck.length === 0) return;
  persistContacts();
  sendAckBatch(c.id, toAck, "read");
}

function saveCurrentDraft() {
  if (!state.chatId) return;
  const input = $("#chat-input");
  if (!input) return;
  const v = input.value.trim();
  if (v) state.drafts[state.chatId] = v; else delete state.drafts[state.chatId];
  persistDrafts();
}

function wireChatScreen() {
  const form = $("#chat-form");
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text || !state.chatId) return;
    if (state.editingMessageId) { commitEdit(state.chatId, state.editingMessageId, text); cancelEditing(); }
    else { sendChatMessage(state.chatId, text, state.replyTo); cancelReply(); }
    input.value = "";
    delete state.drafts[state.chatId];
    persistDrafts();
    sendTypingStop(state.chatId);
  });
  const input = $("#chat-input");
  if (input) {
    let typingSendTimer = null;
    input.addEventListener("input", () => {
      if (!state.chatId) return;
      const v = input.value.trim();
      if (v) state.drafts[state.chatId] = v; else delete state.drafts[state.chatId];
      persistDrafts();
      sendTypingStart(state.chatId);
      clearTimeout(typingSendTimer);
      typingSendTimer = setTimeout(() => sendTypingStop(state.chatId), TYPING_DEBOUNCE_MS);
    });
    input.addEventListener("blur", () => { if (state.chatId) sendTypingStop(state.chatId); });
  }
  const callBtn = $("#chat-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => beginCall(state.chatId));
  const moreBtn = $("#chat-more-btn");
  if (moreBtn) moreBtn.addEventListener("click", () => openContactSheet(state.chatId));
  const editCancel = $("#edit-cancel-btn");
  if (editCancel) editCancel.addEventListener("click", () => {
    const id = state.chatId;
    cancelEditing();
    const inp = $("#chat-input");
    if (id && state.drafts[id]) inp.value = state.drafts[id]; else inp.value = "";
  });
  const replyCancel = $("#reply-cancel-btn");
  if (replyCancel) replyCancel.addEventListener("click", () => cancelReply());
}

async function sendChatMessage(contactId, text, replyTo) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  if (c.blocked) { toast("Контакт заблокирован"); return; }
  if (text.length > MAX_MESSAGE_LENGTH) { text = text.slice(0, MAX_MESSAGE_LENGTH); toast("Сообщение обрезано"); }
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

function trimMessages(c) { if (c.messages.length <= MAX_MESSAGES_PER_CHAT) return; c.messages = c.messages.slice(-MAX_MESSAGES_PER_CHAT); }

async function commitEdit(contactId, msgId, newText) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  const m = c.messages.find((x) => x.id === msgId);
  if (!m) return;
  newText = String(newText).slice(0, MAX_MESSAGE_LENGTH);
  m.text = newText; m.edited = true; m.ts = Date.now();
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
  const from = state.contacts.get(fromContactId), to = state.contacts.get(toContactId);
  if (!from || !to) return;
  const m = from.messages.find((x) => x.id === msgId);
  if (!m) return;
  const text = m.text;
  const msgId2 = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId2, from: "me", text, ts, ack: "sent", forwarded: true };
  to.messages.push(rec); trimMessages(to); to.lastActivity = ts; persistContacts();
  if (state.chatId === toContactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
  toast("Переслано");
  const payload = { kind: "chat", id: msgId2, text, ts, forwarded: true };
  await trySendOrQueue(to, msgId2, payload);
}

async function trySendOrQueue(contact, msgId, payloadObj) {
  const link = mesh.get(contact.id);
  const p2pSent = link && link.status === "connected" && link.send(payloadObj);
  addToOutbox(msgId, contact.id, payloadObj);
  if (p2pSent) {
    setTimeout(() => { if (!outbox.has(msgId)) return; flushOutboxItem(msgId); }, P2P_FALLBACK_MS);
    return;
  }
  await flushOutboxItem(msgId);
}

// ---------- Outbox ----------
function addToOutbox(msgId, to, payload) {
  if (outbox.has(msgId)) return;
  outbox.set(msgId, { msgId, to, payload, sentAt: Date.now(), attempts: 0, serverAcked: false });
  trimMap(outbox, OUTBOX_LIMIT);
  persistOutbox();
}
function persistOutbox() {
  const arr = Array.from(outbox.values()).map((e) => ({ msgId: e.msgId, to: e.to, payload: e.payload, sentAt: e.sentAt, attempts: e.attempts, serverAcked: !!e.serverAcked }));
  try { Store.outboxJson = JSON.stringify(arr); } catch (e) {}
}
function restoreOutbox() {
  let arr = []; try { arr = JSON.parse(Store.outboxJson) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  for (const e of arr) if (e && typeof e.msgId === "string" && typeof e.to === "string" && e.payload) {
    outbox.set(e.msgId, { msgId: e.msgId, to: e.to, payload: e.payload, sentAt: e.sentAt || Date.now(), attempts: e.attempts || 0, serverAcked: !!e.serverAcked });
  }
}
async function flushOutboxItem(msgId) {
  const entry = outbox.get(msgId);
  if (!entry) return;
  const contact = state.contacts.get(entry.to);
  if (!contact) { outbox.delete(msgId); persistOutbox(); return; }
  if (!contact.publicKey) {
    if (!pendingNoKey.has(contact.id)) pendingNoKey.set(contact.id, []);
    const list = pendingNoKey.get(contact.id);
    if (!list.some((x) => x.msgId === msgId)) { list.push({ msgId, payload: entry.payload }); persistPendingNoKey(); }
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
    if (!sent) markMessageAck(entry.to, msgId, "failed");
    else if (entry.payload.kind === "chat") {
      const c = state.contacts.get(entry.to);
      const m = c && c.messages.find((x) => x.id === msgId);
      if (m && m.ack === "failed") m.ack = "sent";
      persistContacts();
    }
  } catch (e) { console.error("[crypto] ошибка шифрования:", e); markMessageAck(entry.to, msgId, "failed"); }
}
async function flushOutbox() {
  if (!signaling || !signaling.connected) return;
  const ids = Array.from(outbox.keys());
  for (const id of ids) await flushOutboxItem(id);
  pruneOutbox();
}
function startOutboxRetryLoop() {
  if (outboxRetryTimer) clearInterval(outboxRetryTimer);
  outboxRetryTimer = setInterval(() => { if (outbox.size === 0) return; flushOutbox(); }, OUTBOX_RETRY_INTERVAL_MS);
}
function pruneOutbox() {
  const now = Date.now(); let changed = false;
  for (const [msgId, entry] of outbox) {
    if (now - entry.sentAt > OUTBOX_MAX_AGE_MS) { outbox.delete(msgId); changed = true; markMessageAck(entry.to, msgId, "failed"); }
    else if (entry.payload && entry.payload.kind === "ack-batch" && now - entry.sentAt > RECEIPT_MAX_AGE_MS) { outbox.delete(msgId); changed = true; }
  }
  if (changed) persistOutbox();
}
function trimMap(map, max) { while (map.size > max) map.delete(map.keys().next().value); }

function persistPendingNoKey() {
  const obj = {};
  for (const [cid, list] of pendingNoKey) { if (!list || list.length === 0) continue; obj[cid] = list.map((x) => ({ msgId: x.msgId, payload: x.payload })); }
  try { Store.pendingNoKeyJson = JSON.stringify(obj); } catch (e) {}
}
function restorePendingNoKey() {
  let obj = {}; try { obj = JSON.parse(Store.pendingNoKeyJson) || {}; } catch (e) { obj = {}; }
  if (!obj || typeof obj !== "object") return;
  for (const cid of Object.keys(obj)) { const list = obj[cid]; if (Array.isArray(list)) pendingNoKey.set(cid, list.filter((x) => x && x.msgId && x.payload)); }
}
function flushPendingNoKey(contactId) {
  const list = pendingNoKey.get(contactId);
  if (!list || list.length === 0) return;
  pendingNoKey.delete(contactId); persistPendingNoKey();
  for (const { msgId, payload } of list) { addToOutbox(msgId, contactId, payload); flushOutboxItem(msgId); }
}

function sendAckBatch(contactId, originalMsgIds, ackState) {
  const link = mesh.get(contactId);
  const actionId = crypto.randomUUID();
  const payload = { kind: "ack-batch", ids: originalMsgIds.slice(), state: ackState };
  if (link && link.status === "connected" && link.send(payload)) return;
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
  if (ack === "delivered" || ack === "read") { if (outbox.has(msgId)) { outbox.delete(msgId); persistOutbox(); } }
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
}

function sendTypingStart(contactId) {
  if (state.typingSendingState.get(contactId)) return;
  state.typingSendingState.set(contactId, true);
  const c = state.contacts.get(contactId); if (!c) return;
  const link = mesh.get(contactId);
  const payload = { kind: "typing", active: true };
  if (link && link.send(payload)) return;
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
  const c = state.contacts.get(contactId); if (!c) return;
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

async function toggleReaction(contactId, msgId, emoji) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  if (!m.reactions || typeof m.reactions !== "object") m.reactions = {};
  if (!Array.isArray(m.reactions[emoji])) m.reactions[emoji] = [];
  const meIdx = m.reactions[emoji].indexOf(Store.myId);
  let remove = false;
  if (meIdx >= 0) { m.reactions[emoji].splice(meIdx, 1); remove = true; if (m.reactions[emoji].length === 0) delete m.reactions[emoji]; }
  else m.reactions[emoji].push(Store.myId);
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  const actionId = crypto.randomUUID();
  const payload = { kind: "reaction", id: msgId, emoji, remove, ts: Date.now() };
  await trySendOrQueue(c, actionId, payload);
}
function applyReaction(contactId, payload) {
  const c = ensureContactEntry(contactId, null);
  const m = c.messages.find((x) => x.id === payload.id); if (!m) return;
  if (!m.reactions || typeof m.reactions !== "object") m.reactions = {};
  if (!Array.isArray(m.reactions[payload.emoji])) m.reactions[payload.emoji] = [];
  const idx = m.reactions[payload.emoji].indexOf(contactId);
  if (payload.remove) { if (idx >= 0) m.reactions[payload.emoji].splice(idx, 1); if (m.reactions[payload.emoji].length === 0) delete m.reactions[payload.emoji]; }
  else { if (idx < 0) m.reactions[payload.emoji].push(contactId); }
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
}

// ---------- Сигналинг ----------
function updateSignalingStatusUI(kind, text) {
  const dot = $("#signaling-status-dot"), label = $("#signaling-status-text");
  if (dot) dot.className = "status-dot " + kind;
  if (label) label.textContent = text;
}
function renderSignalingBanner() {
  const banner = $("#signaling-banner"); if (!banner) return;
  if (!signaling || !signaling.connected) {
    $("#signaling-banner-text").textContent = "Нет связи с сигнальным сервером — переподключаемся…";
    banner.classList.remove("hidden");
  } else banner.classList.add("hidden");
}

function initSignaling() {
  const url = effectiveSignalingUrl();
  if (signalingCleanup) { try { signalingCleanup(); } catch (e) {} signalingCleanup = null; }
  if (signaling) { signaling.stop(); signaling = null; }
  onlineSet.clear(); onlineRoster.clear();
  for (const c of state.contacts.values()) c.online = false;
  if (!url) { updateSignalingStatusUI("off", "Сервер не настроен"); renderSignalingBanner(); renderChatsList(); renderOnlineRosterList(); return; }
  updateSignalingStatusUI("connecting", "Подключение…");
  signaling = new SignalingClient(url, Store.myId, { name: Store.name, visible: Store.discoverable, publicKey: Store.myPublicKeyJwk });
  signalingCleanup = wireSignalingEvents(signaling);
  signaling.start();
  renderSignalingBanner();
}

function wireSignalingEvents(sig) {
  const on = (type, fn) => { const wrapped = (ev) => fn(ev); sig.addEventListener(type, wrapped); return { type, wrapped }; };
  const subs = [];

  subs.push(on("connected", () => {
    updateSignalingStatusUI("online", "Подключено");
    renderSignalingBanner();
    for (const id of Array.from(onlineSet)) scheduleAutoConnect(id);
    flushOutbox();
    for (const cid of Array.from(pendingNoKey.keys())) {
      const c = state.contacts.get(cid);
      if (c && c.publicKey) flushPendingNoKey(cid);
    }
    // Отправляем сохранённую push-подписку, если она есть
    try {
      if (Store.pushSubscriptionJson) {
        const sub = JSON.parse(Store.pushSubscriptionJson);
        sig.sendPushSubscription(sub);
      }
    } catch (e) {}
    // И попробуем обновить/создать подписку, если VAPID уже известен
    setTimeout(() => { ensurePushSubscription().catch(() => {}); }, 500);
  }));

  subs.push(on("disconnected", () => {
    updateSignalingStatusUI("off", "Нет соединения — переподключаемся…");
    for (const c of state.contacts.values()) if (c.managed) {
      if (c.online) { state.lastSeen[c.id] = Date.now(); persistLastSeen(); }
      c.online = false;
    }
    onlineRoster.clear();
    renderSignalingBanner();
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  }));

  subs.push(on("replaced", () => {
    updateSignalingStatusUI("off", "Отключено — тот же id в другом месте");
    toast("Этот же контакт подключён в другой вкладке");
    renderSignalingBanner();
  }));

  subs.push(on("vapid-key", (ev) => {
    const { key } = ev.detail;
    if (key) {
      Store.vapidPublicKey = key;
      ensurePushSubscription().catch(() => {});
    }
  }));

  subs.push(on("push-subscribed", () => {
    console.log("[push] сервер подтвердил подписку");
  }));

  subs.push(on("online-list", (ev) => {
    for (const u of ev.detail.users) {
      onlineSet.add(u.id);
      onlineRoster.set(u.id, { name: u.name, visible: u.visible !== false, publicKey: u.publicKey || null });
      const c = state.contacts.get(u.id);
      if (c && c.managed) {
        c.online = true;
        if (u.publicKey && keysDiffer(u.publicKey, c.publicKey)) { c.publicKey = u.publicKey; persistContacts(); flushPendingNoKey(u.id); }
        scheduleAutoConnect(u.id);
      }
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  }));

  subs.push(on("presence", (ev) => {
    const { id, online, name, visible, publicKey } = ev.detail;
    if (online) { onlineSet.add(id); onlineRoster.set(id, { name, visible: visible !== false, publicKey: publicKey || null }); }
    else { onlineSet.delete(id); onlineRoster.delete(id); state.lastSeen[id] = Date.now(); persistLastSeen(); }
    const c = state.contacts.get(id);
    if (c && c.managed) {
      c.online = online;
      if (online && publicKey && keysDiffer(publicKey, c.publicKey)) { c.publicKey = publicKey; persistContacts(); flushPendingNoKey(id); }
      if (online) scheduleAutoConnect(id); else clearAutoConnectTimer(id);
      if (state.chatId === id) renderChatThread();
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  }));

  subs.push(on("signal", async (ev) => {
    const { from, data: packet } = ev.detail;
    if (!packet || !packet.t) return;

    // Звонковые сигналы — обрабатываем без anti-duplicate, они идемпотентны
    if (packet.t === "call-invite") {
      ensureContactEntry(from, packet.n);
      if (state.callId !== from) {
        openCallScreen(from, "ringing");
        playRingtone();
        const c = state.contacts.get(from);
        if (c && !c.muted && Store.notificationsEnabled) {
          showNotification(`📞 ${packet.n || "Звонок"}`, "Входящий вызов", { tag: "ether-call-" + from, contactId: from, kind: "call", force: true });
        }
      }
      sig.signal(from, { t: "call-invite-ack" });
      return;
    }
    if (packet.t === "call-invite-ack") {
      if (state.callId === from && state.callPhase === "calling") {
        const p = $("#call-phase");
        if (p) p.textContent = "Гудки…";
      }
      return;
    }
    if (packet.t === "call-accepted") {
      if (state.callId === from) { stopRingtone(); setCallPhaseActive(); }
      return;
    }
    if (packet.t === "call-declined") {
      if (state.callId === from) {
        stopRingtone();
        toast("Собеседник отклонил вызов");
        const link = mesh.get(from); if (link) link.endCall();
        closeCallScreen("declined");
      }
      return;
    }
    if (packet.t === "call-ended") {
      if (state.callId === from) { stopRingtone(); closeCallScreen("completed"); }
      return;
    }

    // Остальные сигналы — обычные WebRTC SDP
    if (isDuplicateSignal(from, packet)) return;
    if (packet.t === "offer") {
      const existing = mesh.get(from);
      const iAmSupposedToOffer = Store.myId < from;
      if (existing && existing.role === "offerer" && iAmSupposedToOffer && existing.status !== "disconnected") return;
      if (existing) mesh.remove(from);
      ensureContactEntry(from, packet.n);
      const link = mesh.createIncomingLink(from);
      try { const answer = await link.acceptOfferAndCreateAnswer(packet); if (!answer) return; sig.signal(from, answer); }
      catch (e) {
        console.error("[webrtc] ответ на offer:", e);
        mesh.remove(from);
        const c = state.contacts.get(from); if (c) c.status = "disconnected";
        if (state.chatId === from) renderChatThread();
        if (state.tab === "chats") renderChatsList();
      }
    } else if (packet.t === "answer") {
      const link = mesh.get(from);
      if (link) {
        try { await link.acceptAnswer(packet); }
        catch (e) {
          console.error("[webrtc] accept answer:", e);
          mesh.remove(from);
          const c = state.contacts.get(from); if (c) c.status = "disconnected";
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
    if (sender && sender.blocked) { sendAckBatch(from, [msgId], "delivered"); return; }
    if (seenDeliverIds.has(msgId)) { sendAckBatch(from, [msgId], "delivered"); return; }
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
    } catch (e) { console.error("[crypto] decrypt:", e); return; }
    applyIncomingPayload(from, msgId, payload, true);
    sendAckBatch(from, [msgId], "delivered");
  }));

  return () => { for (const s of subs) sig.removeEventListener(s.type, s.wrapped); };
}

function applyIncomingPayload(from, envelopeMsgId, payload, fromServer) {
  if (payload.kind === "chat") {
    const c = ensureContactEntry(from, null);
    if (c.messages.some((m) => m.id === payload.id)) return;
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: payload.text, ts: payload.ts || Date.now(), readAckSent: isOpen };
    if (payload.replyTo) rec.replyTo = payload.replyTo;
    if (payload.forwarded) rec.forwarded = true;
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    if (isOpen) renderChatThread();
    else {
      toast(`${c.name}: ${truncate(payload.text, 40)}`);
      if (!c.muted) showNotification(c.name || "Эфир", truncate(payload.text, 80), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message" });
    }
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

// ---------- Автоподключение ----------
function clearAutoConnectTimer(id) { const t = autoConnectTimers.get(id); if (t) clearTimeout(t); autoConnectTimers.delete(id); }
function scheduleAutoConnect(id) {
  attemptConnect(id);
  if (autoConnectTimers.has(id)) return;
  autoConnectTimers.set(id, setTimeout(() => { autoConnectTimers.delete(id); attemptConnect(id, { force: true }); }, 4000));
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
    console.error("[webrtc] create offer:", e);
    mesh.remove(id);
    const c = state.contacts.get(id); if (c) c.status = "disconnected";
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

// ---------- Экран контактов ----------
function renderOnlineRosterList() {
  const wrap = $("#online-roster-list"), empty = $("#online-roster-empty");
  if (!wrap) return;
  wrap.innerHTML = "";
  const rows = Array.from(onlineRoster.entries()).filter(([id, u]) => id !== Store.myId && u.visible !== false && !state.contacts.has(id));
  if (rows.length === 0) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  for (const [id, u] of rows) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(u.name || id)}">${escapeHtml(initials(u.name || "?"))}</div>
      <span class="roster-name">${escapeHtml(u.name || "Без имени")}</span>
      <button type="button" class="btn-secondary roster-add-btn">Добавить</button>`;
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
  const addBtn = $("#add-contact-btn");
  if (addBtn) addBtn.addEventListener("click", async () => {
    const nameVal = $("#add-contact-name").value.trim();
    const raw = $("#add-contact-value").value.trim();
    if (!raw) { toast("Введите телефон или email"); return; }
    let identity;
    try { identity = await Identity.idFor(raw); }
    catch (e) { toast(e.message); return; }
    if (identity.id === Store.myId) { toast("Это ваш собственный идентификатор"); return; }
    if (state.contacts.has(identity.id)) toast("Этот контакт уже добавлен");
    else {
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
    state.tab = "chats"; renderTab();
  });

  const toggleManual = $("#toggle-manual-btn");
  if (toggleManual) toggleManual.addEventListener("click", () => {
    const sec = $("#manual-section");
    sec.classList.toggle("hidden");
    toggleManual.textContent = sec.classList.contains("hidden")
      ? "Ручное подключение без сервера, по коду ›"
      : "Скрыть ручное подключение ‹";
  });

  const createBtn = $("#create-invite-btn");
  if (createBtn) createBtn.addEventListener("click", createInvite);
  const copyCode = $("#copy-code-btn");
  if (copyCode) copyCode.addEventListener("click", () => copyText($("#invite-code-out").textContent, "Код скопирован"));
  const copyLink = $("#copy-link-btn");
  if (copyLink) copyLink.addEventListener("click", () => copyText($("#invite-link-out").textContent, "Ссылка скопирована"));
  const share = $("#share-link-btn");
  if (share) share.addEventListener("click", async () => {
    const url = $("#invite-link-out").textContent;
    if (navigator.share) { try { await navigator.share({ title: "Приглашение в Эфир", url }); } catch (e) {} }
    else copyText(url, "Ссылка скопирована");
  });
  const completeBtn = $("#complete-invite-btn");
  if (completeBtn) completeBtn.addEventListener("click", async () => {
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
  const replyBtn = $("#reply-btn");
  if (replyBtn) replyBtn.addEventListener("click", async () => {
    const code = $("#paste-code-in").value.trim();
    if (!code) return;
    await handleIncomingCode(code);
  });
  const newInvite = $("#new-invite-again");
  if (newInvite) newInvite.addEventListener("click", resetConnectScreen);
  const answerCopy = $("#answer-copy-btn");
  if (answerCopy) answerCopy.addEventListener("click", () => copyText($("#answer-out-code").textContent, "Код скопирован"));
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
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => toast("Не удалось скопировать"));
  else {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(msg); } catch (e) {}
    ta.remove();
  }
}

// ---------- Шиты ----------
function wireSheetBackdrops() {
  $$(".sheet-backdrop").forEach((el) => {
    el.addEventListener("click", () => { const s = el.closest(".sheet"); if (s) s.classList.add("hidden"); });
  });
  $$(".sheet-cancel").forEach((btn) => {
    btn.addEventListener("click", () => { const id = btn.dataset.closeSheet; if (id) $("#" + id).classList.add("hidden"); });
  });
}

function openMessageSheet(msgId, contactId) {
  state.activeMessageContext = { msgId, contactId };
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;

  const bar = $("#reaction-bar");
  bar.innerHTML = "";
  for (const emoji of REACTION_EMOJIS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "reaction-emoji"; b.textContent = emoji;
    b.addEventListener("click", () => {
      $("#message-sheet").classList.add("hidden");
      toggleReaction(contactId, msgId, emoji);
    });
    bar.appendChild(b);
  }

  const isOwn = m.from === "me";
  const body = $("#message-sheet-body");
  const actions = [];

  actions.push(`<button type="button" class="sheet-action" data-action="reply"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>Ответить</button>`);
  actions.push(`<button type="button" class="sheet-action" data-action="forward"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>Переслать</button>`);
  actions.push(`<button type="button" class="sheet-action" data-action="copy"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>Копировать текст</button>`);
  if (m.ack === "failed" && isOwn) actions.push(`<button type="button" class="sheet-action" data-action="retry"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>Отправить заново</button>`);
  if (isOwn) {
    actions.push(`<button type="button" class="sheet-action" data-action="edit"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>Редактировать</button>`);
    actions.push(`<button type="button" class="sheet-action destructive" data-action="delete-local"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 7h12l-1 13.1a2 2 0 0 1-2 1.9H9a2 2 0 0 1-2-1.9L6 7z"/></svg>Удалить у себя</button>`);
    actions.push(`<button type="button" class="sheet-action destructive" data-action="delete-both"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 7h12l-1 13.1a2 2 0 0 1-2 1.9H9a2 2 0 0 1-2-1.9L6 7z"/></svg>Удалить у всех</button>`);
  } else {
    actions.push(`<button type="button" class="sheet-action destructive" data-action="delete-local"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 7h12l-1 13.1a2 2 0 0 1-2 1.9H9a2 2 0 0 1-2-1.9L6 7z"/></svg>Удалить у себя</button>`);
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
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  if (action === "copy") copyText(m.text || "", "Текст скопирован");
  else if (action === "edit") startEditing(msgId);
  else if (action === "delete-local") deleteMessageLocal(contactId, msgId);
  else if (action === "delete-both") {
    if (!confirm("Удалить сообщение у вас и у собеседника?")) return;
    await deleteMessageForBoth(contactId, msgId);
  } else if (action === "reply") {
    state.replyTo = { msgId: m.id, text: m.text, from: m.from, authorName: m.from === "me" ? (Store.name || "Вы") : (c.name || "Собеседник") };
    showReplyBanner();
    const inp = $("#chat-input"); if (inp) inp.focus();
  } else if (action === "forward") openForwardSheet(msgId, contactId);
  else if (action === "retry") {
    if (outbox.has(msgId)) { flushOutboxItem(msgId); toast("Повторная отправка…"); }
    else { addToOutbox(msgId, contactId, { kind: "chat", id: msgId, text: m.text, ts: m.ts }); flushOutboxItem(msgId); toast("Повторная отправка…"); }
  }
}

function startEditing(msgId) {
  const c = state.contacts.get(state.chatId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m || m.from !== "me") return;
  state.editingMessageId = msgId;
  const banner = $("#edit-banner"); if (banner) banner.classList.remove("hidden");
  const inp = $("#chat-input");
  if (inp) { inp.value = m.text; inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {} }
}

function cancelEditing() {
  state.editingMessageId = null;
  const b = $("#edit-banner"); if (b) b.classList.add("hidden");
}

function showReplyBanner() {
  const b = $("#reply-banner"); if (!b) return;
  if (!state.replyTo) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden");
  const a = b.querySelector(".reply-banner-author"); if (a) a.textContent = state.replyTo.authorName;
  const t = b.querySelector(".reply-banner-text"); if (t) t.textContent = truncate(state.replyTo.text, 60);
}
function cancelReply() { state.replyTo = null; const b = $("#reply-banner"); if (b) b.classList.add("hidden"); }

function openForwardSheet(msgId, fromContactId) {
  const list = $("#forward-list"); list.innerHTML = "";
  const contacts = Array.from(state.contacts.values()).filter((c) => c.managed);
  if (contacts.length === 0) list.innerHTML = `<p class="muted">Нет других контактов</p>`;
  for (const c of contacts) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "forward-row";
    btn.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div><span class="forward-name">${escapeHtml(c.name || "Без имени")}</span>`;
    btn.addEventListener("click", async () => { $("#forward-sheet").classList.add("hidden"); await forwardMessage(msgId, fromContactId, c.id); });
    list.appendChild(btn);
  }
  $("#forward-sheet").classList.remove("hidden");
}

function openContactSheet(contactId) {
  state.activeContactContext = contactId;
  const c = state.contacts.get(contactId); if (!c) return;
  const body = $("#contact-sheet-body");
  body.innerHTML = `
    <button type="button" class="sheet-action" data-action="rename"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"/></svg>Переименовать</button>
    <button type="button" class="sheet-action" data-action="archive"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20.54 5.23 19.15 3.55A1.5 1.5 0 0 0 18 3H6a1.5 1.5 0 0 0-1.16.55L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5a2 2 0 0 0-.46-1.27z"/></svg>${c.archived ? "Разархивировать" : "В архив"}</button>
    <button type="button" class="sheet-action" data-action="mute"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16.5 12A4.5 4.5 0 0 0 14 7.97V2.5a2.5 2.5 0 0 0-5 0v5.47A4.5 4.5 0 0 0 7 12v4.5h9.5V12z"/></svg>${c.muted ? "Включить звук" : "Без звука"}</button>
    <button type="button" class="sheet-action ${c.blocked ? "" : "destructive"}" data-action="block"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM5.7 7.1l9.2 9.2a8 8 0 0 1-9.2-9.2zm12.6 9.8L9.1 7.7a8 8 0 0 1 9.2 9.2z"/></svg>${c.blocked ? "Разблокировать" : "Заблокировать"}</button>
    <button type="button" class="sheet-action" data-action="export"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>Экспорт переписки</button>
    <button type="button" class="sheet-action" data-action="clear"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>Очистить историю</button>
    <button type="button" class="sheet-action destructive" data-action="delete"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 7h12l-1 13.1a2 2 0 0 1-2 1.9H9a2 2 0 0 1-2-1.9L6 7z"/></svg>Удалить контакт</button>`;
  body.querySelectorAll(".sheet-action").forEach((btn) => {
    btn.addEventListener("click", () => { const action = btn.dataset.action; $("#contact-sheet").classList.add("hidden"); handleContactAction(action, contactId); });
  });
  $("#contact-sheet").classList.remove("hidden");
}

function handleContactAction(action, contactId) {
  const c = state.contacts.get(contactId); if (!c) return;
  if (action === "rename") {
    state.activeContactContext = contactId;
    $("#rename-input").value = c.name || "";
    $("#rename-sheet").classList.remove("hidden");
    setTimeout(() => $("#rename-input").focus(), 50);
  } else if (action === "archive") {
    c.archived = !c.archived; persistContacts(); renderChatsList();
    toast(c.archived ? "В архиве" : "Из архива");
  } else if (action === "mute") {
    c.muted = !c.muted; persistContacts(); renderChatsList();
    toast(c.muted ? "Уведомления выключены" : "Уведомления включены");
  } else if (action === "block") {
    c.blocked = !c.blocked; persistContacts(); renderChatsList();
    toast(c.blocked ? "Заблокирован" : "Разблокирован");
  } else if (action === "export") exportChat(contactId);
  else if (action === "clear") {
    if (!confirm(`Очистить всю переписку с «${c.name}»?`)) return;
    c.messages = []; c.lastActivity = Date.now(); persistContacts();
    if (state.chatId === contactId) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    toast("История очищена");
  } else if (action === "delete") {
    if (!confirm(`Удалить контакт «${c.name}»?`)) return;
    deleteContact(contactId);
  }
}

function wireRenameSheet() {
  const btn = $("#rename-save-btn"); if (!btn) return;
  btn.addEventListener("click", () => {
    const id = state.activeContactContext;
    const v = $("#rename-input").value.trim();
    if (!id || !v) return;
    const c = state.contacts.get(id); if (!c) return;
    c.name = v.slice(0, 40);
    persistContacts();
    $("#rename-sheet").classList.add("hidden");
    if (state.chatId === id) renderChatThread();
    renderChatsList();
    toast("Имя обновлено");
  });
}

function deleteContact(id) {
  clearAutoConnectTimer(id);
  mesh.remove(id);
  pendingNoKey.delete(id); persistPendingNoKey();
  for (const [msgId, entry] of outbox) if (entry.to === id) outbox.delete(msgId);
  persistOutbox();
  for (const [msgId, cid] of pendingAcks) if (cid === id) pendingAcks.delete(msgId);
  const audioEl = document.getElementById("remote-audio-" + id); if (audioEl) audioEl.remove();
  state.contacts.delete(id);
  persistContacts();
  if (state.callId === id) closeCallScreen();
  if (state.chatId === id) state.chatId = null;
  renderTab();
  toast("Контакт удалён");
}

function exportChat(contactId) {
  const c = state.contacts.get(contactId); if (!c) return;
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
    direction, status: direction === "out" ? "calling" : "ringing",
    startedAt: Date.now(), answeredAt: null, endedAt: null, durationMs: 0,
  };
  state.callLog.push(state.currentCallRecord);
  persistCallLog();
}
function updateCallRecordStatus(status) {
  const rec = state.currentCallRecord; if (!rec) return;
  rec.status = status;
  if (status === "active" && !rec.answeredAt) rec.answeredAt = Date.now();
  persistCallLog();
}
function endCallRecord(finalStatus) {
  const rec = state.currentCallRecord; if (!rec) return;
  rec.endedAt = Date.now();
  if (rec.answeredAt) { rec.durationMs = rec.endedAt - rec.answeredAt; rec.status = finalStatus || "completed"; }
  else { if (!finalStatus) finalStatus = rec.direction === "in" ? "missed" : "cancelled"; rec.status = finalStatus; }
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
  const list = $("#calls-list"), empty = $("#calls-empty");
  if (!list) return;
  list.innerHTML = "";
  if (state.callLog.length === 0) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  const items = state.callLog.slice().sort((a, b) => b.startedAt - a.startedAt);
  for (const rec of items) {
    const c = state.contacts.get(rec.contactId);
    const name = (c && c.name) || rec.contactName || "Без имени";
    const dirIcon = rec.direction === "in" ? (rec.status === "missed" ? "missed" : "in") : "out";
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
      </button>`;
    const backBtn = row.querySelector(".call-back-btn");
    if (backBtn && c) backBtn.addEventListener("click", (e) => { e.stopPropagation(); beginCall(rec.contactId); });
    row.addEventListener("click", () => { if (state.contacts.has(rec.contactId)) { state.chatId = rec.contactId; renderTab(); } });
    list.appendChild(row);
  }
}

function clearPendingCall() { if (pendingCall.timer) clearTimeout(pendingCall.timer); pendingCall.timer = null; pendingCall.contactId = null; }

function playRingtone() {
  stopRingtone();
  try {
    if (!ringtoneCtx) ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (ringtoneCtx.state === "suspended") ringtoneCtx.resume();
    const beep = () => {
      if (!ringtoneCtx) return;
      const osc = ringtoneCtx.createOscillator();
      const gain = ringtoneCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = 480;
      gain.gain.value = 0.0001;
      osc.connect(gain); gain.connect(ringtoneCtx.destination);
      const t = ringtoneCtx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      osc.start(t); osc.stop(t + 0.7);
    };
    beep();
    ringtoneTimer = setInterval(beep, 1500);
  } catch (e) { console.warn("ringtone:", e); }
}

function stopRingtone() {
  if (ringtoneTimer) { clearInterval(ringtoneTimer); ringtoneTimer = null; }
}

async function beginCall(id) {
  const c = state.contacts.get(id);
  if (!c) return;
  if (c.blocked) { toast("Контакт заблокирован"); return; }

  // Локально показываем экран вызова сразу
  openCallScreen(id, "calling");

  // Отправляем приглашение через сигнальный сервер — так собеседник
  // узнает о звонке, даже если P2P ещё не поднят.
  if (signaling && signaling.connected) {
    signaling.signal(id, { t: "call-invite", n: Store.name });
  } else {
    toast("Нет связи с сервером — звонок невозможен");
    closeCallScreen("failed");
    return;
  }

  // Если P2P уже есть — сразу стартуем передачу звука
  const link = mesh.get(id);
  if (link && isReachable(c)) {
    try { await link.startCall(); }
    catch (e) { toast("Нет доступа к микрофону"); closeCallScreen("failed"); return; }
    return;
  }

  // Иначе — пытаемся поднять P2P, а когда он поднимется, стартуем звонок.
  clearPendingCall();
  pendingCall.contactId = id;
  attemptConnect(id, { force: true });
  pendingCall.timer = setTimeout(() => {
    if (pendingCall.contactId !== id) return;
    const cur = state.contacts.get(id);
    if (cur && isReachable(cur)) return;
    clearPendingCall();
    toast("Не удалось установить P2P — звук недоступен");
    if (signaling && signaling.connected) signaling.signal(id, { t: "call-ended" });
    closeCallScreen("failed");
  }, PENDING_CALL_TIMEOUT_MS);
}

function openCallScreen(id, phase) {
  state.callId = id;
  state.callPhase = phase;
  const c = state.contacts.get(id); if (!c) return;
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
  clearInterval(callTimerInterval); callTimerInterval = null;
  clearPendingCall();
  stopRingtone();
  endCallRecord(reason);
  $("#call-screen").classList.add("hidden");
  $("#call-mute-btn").classList.remove("active");
  if (state.callId) pendingRemoteStreams.delete(state.callId);
  state.callId = null;
  state.callPhase = null;
  if (state.tab === "calls") renderCallsList();
}

function wireCallScreen() {
  const hangup = $("#call-hangup-btn");
  if (hangup) hangup.addEventListener("click", () => {
    const cid = state.callId;
    const link = mesh.get(cid); if (link) link.endCall();
    if (signaling && signaling.connected && cid) signaling.signal(cid, { t: "call-ended" });
    stopRingtone();
    closeCallScreen(state.currentCallRecord && state.currentCallRecord.answeredAt ? "completed" : "cancelled");
  });

  const mute = $("#call-mute-btn");
  if (mute) mute.addEventListener("click", () => {
    const link = mesh.get(state.callId);
    const muted = !mute.classList.contains("active");
    if (link) link.setMuted(muted);
    mute.classList.toggle("active", muted);
  });

  const accept = $("#call-accept-btn");
  if (accept) accept.addEventListener("click", async () => {
    const cid = state.callId;
    stopRingtone();
    if (signaling && signaling.connected && cid) signaling.signal(cid, { t: "call-accepted" });

    const link = mesh.get(cid);
    if (!link || !isReachable(state.contacts.get(cid))) {
      toast("Соединяемся — говорите, как только услышите");
      pendingCall.contactId = cid;
      attemptConnect(cid, { force: true });
      const waitTimer = setTimeout(() => {
        if (state.callId !== cid) return;
        const l2 = mesh.get(cid);
        if (l2 && isReachable(state.contacts.get(cid))) {
          l2.answerCall().then(setCallPhaseActive).catch(() => {});
        } else {
          toast("Не удалось установить связь");
          if (signaling && signaling.connected) signaling.signal(cid, { t: "call-ended" });
          closeCallScreen("failed");
        }
      }, PENDING_CALL_TIMEOUT_MS);
      pendingCall.timer = waitTimer;
      return;
    }
    try { await link.answerCall(); setCallPhaseActive(); }
    catch (e) { toast("Нет доступа к микрофону"); link.declineCall(); closeCallScreen("failed"); }
  });

  const decline = $("#call-decline-btn");
  if (decline) decline.addEventListener("click", () => {
    const cid = state.callId;
    const link = mesh.get(cid); if (link) link.declineCall();
    if (signaling && signaling.connected && cid) signaling.signal(cid, { t: "call-declined" });
    stopRingtone();
    closeCallScreen("declined");
  });
}

// ---------- Поиск ----------
function wireSearchHandlers() {
  const gs = $("#global-search");
  if (gs) gs.addEventListener("input", (e) => { state.searchQuery = e.target.value.trim(); renderChatsList(); });
  const ta = $("#toggle-archived");
  if (ta) ta.addEventListener("click", () => { state.showArchived = !state.showArchived; renderChatsList(); });
  const csb = $("#chat-search-btn");
  if (csb) csb.addEventListener("click", () => {
    const bar = $("#chat-search-bar");
    bar.classList.toggle("hidden");
    if (!bar.classList.contains("hidden")) setTimeout(() => $("#chat-search-input").focus(), 50);
    else closeChatSearch();
  });
  const csc = $("#chat-search-close");
  if (csc) csc.addEventListener("click", closeChatSearch);
  const csi = $("#chat-search-input");
  if (csi) csi.addEventListener("input", (e) => { state.chatSearchQuery = e.target.value.trim(); renderChatThread(); updateSearchCounter(); });
}

function closeChatSearch() {
  state.chatSearchQuery = "";
  const input = $("#chat-search-input"); if (input) input.value = "";
  const bar = $("#chat-search-bar"); if (bar) bar.classList.add("hidden");
  const counter = $("#chat-search-counter"); if (counter) counter.textContent = "";
}

function updateSearchCounter() {
  const c = state.contacts.get(state.chatId); if (!c) return;
  const q = state.chatSearchQuery.toLowerCase();
  if (!q) { const el = $("#chat-search-counter"); if (el) el.textContent = ""; return; }
  const n = c.messages.filter((m) => (m.text || "").toLowerCase().includes(q)).length;
  const el = $("#chat-search-counter");
  if (el) el.textContent = n > 0 ? `${n} найдено` : "нет совпадений";
}

// ---------- Настройки ----------
function wireSettingsScreen() {
  const nameEl = $("#settings-name");
  if (nameEl) nameEl.addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) { Store.name = v; toast("Имя обновлено"); initSignaling(); }
  });
  const idEl = $("#settings-identity");
  if (idEl) idEl.addEventListener("change", async (e) => {
    const v = e.target.value.trim(); if (!v) return;
    try {
      const identity = await Identity.idFor(v);
      Store.myIdentityRaw = identity.normalized;
      Store.myId = identity.id;
      toast("Идентификатор обновлён");
      initSignaling();
    } catch (err) { toast(err.message); e.target.value = Store.myIdentityRaw; }
  });
  const save = $("#save-signaling-btn");
  if (save) save.addEventListener("click", () => {
    Store.signalingUrl = $("#settings-signaling-url").value.trim();
    initSignaling(); toast("Сохранено");
  });
  const disc = $("#settings-discoverable");
  if (disc) disc.addEventListener("change", (e) => {
    Store.discoverable = e.target.checked; initSignaling();
    toast(e.target.checked ? "Вы видны в списке" : "Вы скрыты");
  });
  const pinlock = $("#settings-pinlock");
  if (pinlock) pinlock.addEventListener("change", (e) => {
    if (e.target.checked) {
      $("#set-pin-title").textContent = Store.pinHash ? "Введите текущий пин-код" : "Новый пин-код (4-8 цифр)";
      $("#set-pin-input").value = "";
      $("#set-pin-sheet").classList.remove("hidden");
      setTimeout(() => $("#set-pin-input").focus(), 50);
    } else {
      $("#set-pin-title").textContent = "Введите текущий пин-код";
      $("#set-pin-input").value = "";
      $("#set-pin-sheet").classList.remove("hidden");
      setTimeout(() => $("#set-pin-input").focus(), 50);
    }
  });
  const pinSave = $("#set-pin-save-btn");
  if (pinSave) pinSave.addEventListener("click", async () => {
    const v = $("#set-pin-input").value.trim();
    if (!v || v.length < 4) { toast("Минимум 4 цифры"); return; }
    if (!/^\d+$/.test(v)) { toast("Только цифры"); return; }
    if ($("#settings-pinlock").checked) {
      if (Store.pinHash) {
        const h = await hashPin(v);
        if (h !== Store.pinHash) { toast("Неверный пин-код"); return; }
        $("#set-pin-title").textContent = "Новый пин-код";
        $("#set-pin-input").value = "";
        return;
      }
      Store.pinHash = await hashPin(v);
      Store.pinEnabled = true;
      $("#set-pin-sheet").classList.add("hidden");
      toast("Пин-код включён");
    } else {
      const h = await hashPin(v);
      if (h !== Store.pinHash) { toast("Неверный пин-код"); return; }
      Store.pinEnabled = false;
      Store.pinHash = "";
      $("#settings-pinlock").checked = false;
      $("#set-pin-sheet").classList.add("hidden");
      toast("Пин-код отключён");
    }
  });
  const slider = $("#glass-slider");
  if (slider) slider.addEventListener("input", (e) => { const v = parseFloat(e.target.value); Store.glassAlpha = v; applyGlassAlpha(Store.glassAlpha); });
  $$(".theme-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      Store.theme = btn.dataset.theme;
      applyTheme(btn.dataset.theme);
      $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  const reset = $("#reset-all-btn");
  if (reset) reset.addEventListener("click", () => {
    if (!confirm("Разорвать все соединения и удалить контакты? История звонков тоже будет удалена.")) return;
    for (const id of Array.from(state.contacts.keys())) mesh.remove(id);
    for (const t of autoConnectTimers.values()) clearTimeout(t);
    autoConnectTimers.clear();
    onlineSet.clear(); pendingAcks.clear(); outbox.clear(); pendingNoKey.clear(); seenDeliverIds.clear();
    state.contacts.clear(); state.callLog = []; state.currentCallRecord = null;
    state.lastSeen = {}; state.drafts = {};
    Store.contactsJson = "[]"; Store.outboxJson = "[]"; Store.pendingNoKeyJson = "{}";
    Store.callLogJson = "[]"; Store.lastSeenJson = "{}"; Store.draftsJson = "{}";
    resetConnectScreen(); renderTab();
    toast("Все данные удалены");
  });
  const expBackup = $("#export-backup-btn");
  if (expBackup) expBackup.addEventListener("click", exportBackup);
  const impBackup = $("#import-backup-btn");
  if (impBackup) impBackup.addEventListener("click", () => $("#import-backup-input").click());
  const impInput = $("#import-backup-input");
  if (impInput) impInput.addEventListener("change", importBackup);
  const diag = $("#diagnostics-btn");
  if (diag) diag.addEventListener("click", () => { renderDiagnostics(); $("#diagnostics-sheet").classList.remove("hidden"); });
  const diagClose = $("#diagnostics-close");
  if (diagClose) diagClose.addEventListener("click", () => $("#diagnostics-sheet").classList.add("hidden"));
  const diagR = $("#diagnostics-refresh-btn");
  if (diagR) diagR.addEventListener("click", renderDiagnostics);
  const diagC = $("#diagnostics-copy-btn");
  if (diagC) diagC.addEventListener("click", () => copyText(buildDiagnosticsText(), "Диагностика скопирована"));
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
    for (const k of Object.keys(data)) if (k.startsWith("ether.")) localStorage.setItem(k, data[k]);
    toast("Данные импортированы — перезагрузка");
    setTimeout(() => location.reload(), 800);
  } catch (e) { toast("Не удалось импортировать: " + e.message); }
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
  lines.push("--- Push ---");
  lines.push("PWA (standalone): " + (isStandalone() ? "да" : "нет"));
  lines.push("Notification API: " + (("Notification" in window) ? "есть" : "нет"));
  lines.push("Разрешение: " + (("Notification" in window) ? Notification.permission : "—"));
  lines.push("PushManager: " + (("PushManager" in window) ? "есть" : "нет"));
  lines.push("VAPID-ключ: " + (Store.vapidPublicKey ? Store.vapidPublicKey.slice(0, 16) + "…" : "(не получен)"));
  lines.push("Подписка в localStorage: " + (Store.pushSubscriptionJson ? "есть" : "нет"));
  lines.push("");
  lines.push("--- ICE-серверы ---");
  try {
    if (typeof ICE_SERVERS !== "undefined") {
      for (const s of ICE_SERVERS) {
        const u = Array.isArray(s.urls) ? s.urls.join(",") : s.urls;
        const kind = String(u).startsWith("turn") ? "TURN" : "STUN";
        lines.push(`${kind}: ${u}`);
      }
    } else lines.push("(не инициализирован)");
  } catch (e) {}
  lines.push("");
  lines.push("--- Контакты ---");
  for (const c of state.contacts.values()) {
    const link = mesh && mesh.get(c.id);
    lines.push(`${c.name} | id=${String(c.id).slice(0, 10)}… | online=${c.online} | status=${c.status} | link=${link ? link.status : "—"} | сообщений=${c.messages.length}`);
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
  const turnCount = (typeof ICE_SERVERS !== "undefined")
    ? ICE_SERVERS.filter((s) => (s.urls || "").toString().startsWith("turn")).length
    : 0;
  const summary = $("#diagnostics-summary");
  if (summary) summary.innerHTML = `
    <div><b>Мой id:</b> ${idShort}</div>
    <div><b>Сервер:</b> ${escapeHtml(effectiveSignalingUrl())}</div>
    <div><b>Сигналинг:</b> ${signaling ? (signaling.connected ? "✅ подключён" : "⚠️ не подключён") : "⚠️ не инициализирован"}</div>
    <div><b>Онлайн:</b> ${onlineSet.size}</div>
    <div><b>Контактов:</b> ${state.contacts.size}</div>
    <div><b>В очереди:</b> ${outbox.size}</div>
    <div><b>TURN-серверов:</b> ${turnCount} ${turnCount > 0 ? "✅" : "⚠️"}</div>
    <div><b>Уведомления:</b> ${("Notification" in window && Notification.permission === "granted" && Store.notificationsEnabled) ? "✅" : "⚠️"}</div>
    <div><b>PWA:</b> ${isStandalone() ? "✅ установлено" : "не на домашний экран"}</div>
    <div><b>VAPID:</b> ${Store.vapidPublicKey ? "✅ получен" : "⚠️ нет"}</div>`;
  const log = $("#diagnostics-log"); if (log) log.textContent = buildDiagnosticsText();
}

// ---------- События mesh ----------
function wireMeshEvents() {
  mesh.addEventListener("link-status", (ev) => {
    const { id, status } = ev.detail;
    const c = state.contacts.get(id); if (!c) return;
    const wasConnected = c.status === "connected" || c.status === "in-call";
    c.status = status;
    if (status === "connected" && !wasConnected) {
      const link = mesh.get(id);
      if (link && link.remoteName) c.name = link.remoteName;
      if (c.managed) persistContacts();
      toast(`«${c.name}» на связи`);
      clearAutoConnectTimer(id);
      if (state.pendingOutgoing && state.pendingOutgoing.id === id) resetConnectScreen();
      // Отложенный звонок: если мы ждали соединения, стартуем передачу звука
      if (pendingCall.contactId === id && link) {
        clearPendingCall();
        link.startCall().catch(() => { toast("Нет доступа к микрофону"); closeCallScreen("failed"); });
      }
      // Или если мы приняли вызов и ждали P2P
      if (state.callId === id && state.callPhase !== "active" && link) {
        link.answerCall().then(setCallPhaseActive).catch(() => {});
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
    const c = state.contacts.get(id); if (!c) return;
    if (c.blocked) return;
    if (payload && payload.kind === "call-state") {
      // P2P-сигнал о звонке. Но основной канал звонка — через signaling.
      if (payload.state === "ringing" && state.callId !== id && state.callPhase !== "ringing") {
        openCallScreen(id, "ringing");
        playRingtone();
      }
      if (payload.state === "accepted" && state.callId === id) setCallPhaseActive();
      if (payload.state === "declined" && state.callId === id) {
        toast("Собеседник отклонил вызов");
        const link = mesh.get(id); if (link) link.endCall();
        closeCallScreen("declined");
      }
      if (payload.state === "ended" && state.callId === id) closeCallScreen("completed");
      return;
    }
    applyIncomingPayload(id, payload && payload.id, payload, false);
  });

  mesh.addEventListener("remote-track", (ev) => {
    const { id, stream } = ev.detail;
    if (state.callId === id && state.callPhase !== "active") { pendingRemoteStreams.set(id, stream); return; }
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
  const onH = document.getElementById("onboarding").classList.contains("hidden");
  const apH = document.getElementById("app-shell").classList.contains("hidden");
  const lkH = document.getElementById("lock-screen").classList.contains("hidden");
  const rcH = document.getElementById("boot-recovery").classList.contains("hidden");
  return onH && apH && lkH && rcH;
}
const bootWatchdog = setTimeout(() => { if (bootDidNotRender()) showBootRecovery(); }, 10000);
window.addEventListener("error", () => { if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); } });
window.addEventListener("unhandledrejection", () => { if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); } });

document.addEventListener("DOMContentLoaded", () => {
  try {
    initBoot();
    clearTimeout(bootWatchdog);
  } catch (e) { console.error("[boot]", e); showBootRecovery(); }
});

document.getElementById("boot-recovery-reset")?.addEventListener("click", () => {
  localStorage.clear();
  if ("caches" in window) caches.keys().then((names) => names.forEach((n) => caches.delete(n)));
  location.reload();
});

window.addEventListener("beforeunload", () => { try { saveCurrentDraft(); } catch (e) {} });