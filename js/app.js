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
const RESUME_MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_CALL_LOG = 500;
const MAX_MESSAGES_PER_CHAT = 5000;
const TYPING_DEBOUNCE_MS = 1200;
const TYPING_AUTO_CLEAR_MS = 4000;
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const UNLOCK_ATTEMPTS_LIMIT = 5;
const P2P_FALLBACK_MS = 1500;
const ONBOARDING_HINT_SHOWN = "ether.hintShown";
const PIN_ITERATIONS = 120000;

function effectiveSignalingUrl() {
  return (Store.signalingUrl || DEFAULT_SIGNALING_URL).trim();
}

// =====================================================================
// IndexedDB — страховка для iOS PWA.
// =====================================================================
const IDB = (() => {
  const DB_NAME = "ether-db";
  const STORE = "kv";
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("no idb"));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function set(key, value) {
    try {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { return null; }
  }

  async function get(key) {
    try {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(STORE, "readonly");
        const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch (e) { return null; }
  }

  return { open, set, get };
})();

const CRITICAL_LS_KEYS = [
  "ether.name", "ether.identityRaw", "ether.myId",
  "ether.privKey", "ether.pubKey",
  "ether.pinHash", "ether.pinSalt", "ether.pinEnabled",
  "ether.contacts",
  "ether.theme", "ether.glassAlpha",
  "ether.notifications", "ether.sounds",
  "ether.vapidPublicKey", "ether.pushSubscription",
  "ether.callLog", "ether.lastSeen", "ether.drafts",
];

async function backupToIDB() {
  for (const k of CRITICAL_LS_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) await IDB.set(k, v);
  }
}

async function restoreFromIDB() {
  for (const k of CRITICAL_LS_KEYS) {
    if (localStorage.getItem(k) !== null) continue;
    const v = await IDB.get(k);
    if (v !== null && v !== undefined) localStorage.setItem(k, v);
  }
}

let _idbBackupTimer = null;
function scheduleIDBBackup() {
  if (_idbBackupTimer) return;
  _idbBackupTimer = setTimeout(() => {
    _idbBackupTimer = null;
    backupToIDB().catch(() => {});
  }, 1500);
}

// =====================================================================
// Store
// =====================================================================
const Store = {
  get name() { return localStorage.getItem("ether.name") || ""; },
  set name(v) { localStorage.setItem("ether.name", v); scheduleIDBBackup(); },
  get myIdentityRaw() { return localStorage.getItem("ether.identityRaw") || ""; },
  set myIdentityRaw(v) { localStorage.setItem("ether.identityRaw", v); scheduleIDBBackup(); },
  get myId() { return localStorage.getItem("ether.myId") || ""; },
  set myId(v) { localStorage.setItem("ether.myId", v); scheduleIDBBackup(); },
  get signalingUrl() { return localStorage.getItem("ether.signalingUrl") || ""; },
  set signalingUrl(v) { localStorage.setItem("ether.signalingUrl", v); },
  get discoverable() { return localStorage.getItem("ether.discoverable") !== "0"; },
  set discoverable(v) { localStorage.setItem("ether.discoverable", v ? "1" : "0"); },
  get contactsJson() { return localStorage.getItem("ether.contacts") || "[]"; },
  set contactsJson(v) { localStorage.setItem("ether.contacts", v); scheduleIDBBackup(); },
  get outboxJson() { return localStorage.getItem("ether.outbox") || "[]"; },
  set outboxJson(v) { localStorage.setItem("ether.outbox", v); },
  get pendingNoKeyJson() { return localStorage.getItem("ether.pendingNoKey") || "{}"; },
  set pendingNoKeyJson(v) { localStorage.setItem("ether.pendingNoKey", v); },
  get callLogJson() { return localStorage.getItem("ether.callLog") || "[]"; },
  set callLogJson(v) { localStorage.setItem("ether.callLog", v); scheduleIDBBackup(); },
  get lastSeenJson() { return localStorage.getItem("ether.lastSeen") || "{}"; },
  set lastSeenJson(v) { localStorage.setItem("ether.lastSeen", v); scheduleIDBBackup(); },
  get draftsJson() { return localStorage.getItem("ether.drafts") || "{}"; },
  set draftsJson(v) { localStorage.setItem("ether.drafts", v); scheduleIDBBackup(); },
  get pinHash() { return localStorage.getItem("ether.pinHash") || ""; },
  set pinHash(v) { localStorage.setItem("ether.pinHash", v); scheduleIDBBackup(); },
  get pinSalt() { return localStorage.getItem("ether.pinSalt") || ""; },
  set pinSalt(v) { localStorage.setItem("ether.pinSalt", v); scheduleIDBBackup(); },
  get pinEnabled() { return localStorage.getItem("ether.pinEnabled") === "1"; },
  set pinEnabled(v) { localStorage.setItem("ether.pinEnabled", v ? "1" : "0"); scheduleIDBBackup(); },
  get notificationsEnabled() { return localStorage.getItem("ether.notifications") === "1"; },
  set notificationsEnabled(v) { localStorage.setItem("ether.notifications", v ? "1" : "0"); scheduleIDBBackup(); },
  get soundsEnabled() { return localStorage.getItem("ether.sounds") !== "0"; },
  set soundsEnabled(v) { localStorage.setItem("ether.sounds", v ? "1" : "0"); scheduleIDBBackup(); },
  get vapidPublicKey() { return localStorage.getItem("ether.vapidPublicKey") || ""; },
  set vapidPublicKey(v) { if (v) { localStorage.setItem("ether.vapidPublicKey", v); scheduleIDBBackup(); } },
  get pushSubscriptionJson() { return localStorage.getItem("ether.pushSubscription") || ""; },
  set pushSubscriptionJson(v) {
    if (v) { localStorage.setItem("ether.pushSubscription", v); scheduleIDBBackup(); }
    else localStorage.removeItem("ether.pushSubscription");
  },
  get notifBannerDismissed() { return localStorage.getItem("ether.notifBannerDismissed") === "1"; },
  set notifBannerDismissed(v) { localStorage.setItem("ether.notifBannerDismissed", v ? "1" : "0"); },
  get debugHidden() { return localStorage.getItem("ether.debugHidden") === "1"; },
  set debugHidden(v) { localStorage.setItem("ether.debugHidden", v ? "1" : "0"); },
  get myPrivateKeyJwk() { try { const v = localStorage.getItem("ether.privKey"); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set myPrivateKeyJwk(v) { localStorage.setItem("ether.privKey", JSON.stringify(v)); scheduleIDBBackup(); },
  get myPublicKeyJwk() { try { const v = localStorage.getItem("ether.pubKey"); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set myPublicKeyJwk(v) { localStorage.setItem("ether.pubKey", JSON.stringify(v)); scheduleIDBBackup(); },
  get glassAlpha() { const raw = parseFloat(localStorage.getItem("ether.glassAlpha") || "0.5"); if (!Number.isFinite(raw)) return 0.5; return Math.min(0.85, Math.max(0.18, raw)); },
  set glassAlpha(v) { if (!Number.isFinite(v)) return; localStorage.setItem("ether.glassAlpha", String(Math.min(0.85, Math.max(0.18, v)))); scheduleIDBBackup(); },
  get theme() { return localStorage.getItem("ether.theme") || "auto"; },
  set theme(v) { localStorage.setItem("ether.theme", v); scheduleIDBBackup(); },
};

// =====================================================================
// Состояние
// =====================================================================
const state = {
  tab: "chats",
  chatId: null,
  contactCardId: null,
  callId: null,
  callPhase: null,
  pendingOutgoing: null,
  contacts: new Map(),
  editingMessageId: null,
  replyTo: null,
  activeMessageContext: null,
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
let __navTitleTaps = [];
let __chatSearchScrollTimer = null;
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
let audioCtx = null;

// =====================================================================
// Утилиты
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Возвращает HTML, в котором:
//   * обычные URL обёрнуты в <a>
//   * вхождения query подсвечены <mark>
//   * текст экранирован, подстановка в HTML безопасна
function linkifyAndHighlight(text, query) {
  const esc = escapeHtml(text);
  const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/gi;
  let result = "";
  let lastIdx = 0;
  let m;
  urlRegex.lastIndex = 0;
  while ((m = urlRegex.exec(esc)) !== null) {
    if (m.index > lastIdx) {
      result += highlightRaw(esc.slice(lastIdx, m.index), query);
    }
    result += `<a href="${m[1]}" target="_blank" rel="noopener noreferrer">${highlightRaw(m[1], query)}</a>`;
    lastIdx = m.index + m[1].length;
  }
  if (lastIdx < esc.length) {
    result += highlightRaw(esc.slice(lastIdx), query);
  }
  return result;
}

function highlightRaw(escapedText, query) {
  if (!query) return escapedText;
  const q = query.toLowerCase();
  const lower = escapedText.toLowerCase();
  let result = "";
  let i = 0;
  let idx = lower.indexOf(q, i);
  if (idx === -1) return escapedText;
  while (idx !== -1) {
    result += escapedText.slice(i, idx) + `<mark class="search-hit">` + escapedText.slice(idx, idx + q.length) + `</mark>`;
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  return result + escapedText.slice(i);
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
function formatDayGroup(ts) {
  try {
    const d = new Date(ts);
    const now = new Date();
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return "Сегодня";
    if (d.toDateString() === yest.toDateString()) return "Вчера";
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  } catch (e) { return ""; }
}
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

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomSaltHex(len) {
  const a = crypto.getRandomValues(new Uint8Array(len));
  return bufToHex(a);
}

async function pbkdf2Hex(pin, saltHex, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(pin), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key, 256
  );
  return bufToHex(bits);
}

function isStandalone() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      || (window.navigator && window.navigator.standalone === true);
}
function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }

// =====================================================================
// Звуки и вибрация
// =====================================================================
function ensureAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}
function playMessageSound() {
  if (!Store.soundsEnabled) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 900;
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.start(t);
    osc.stop(t + 0.32);
  } catch (e) {}
}
function playOutgoingSound() {
  if (!Store.soundsEnabled) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 600;
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.start(t);
    osc.stop(t + 0.2);
  } catch (e) {}
}
function vibrate(pattern) {
  if (!Store.soundsEnabled) return;
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (e) {}
  }
}

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
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      osc.start(t); osc.stop(t + 0.7);
    };
    beep();
    ringtoneTimer = setInterval(beep, 1500);
    if (Store.soundsEnabled && navigator.vibrate) {
      try { navigator.vibrate([300, 200, 300, 200, 300]); } catch (e) {}
    }
  } catch (e) { console.warn("ringtone:", e); }
}
function stopRingtone() {
  if (ringtoneTimer) { clearInterval(ringtoneTimer); ringtoneTimer = null; }
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
}

// =====================================================================
// Пин-код
// =====================================================================
function showLockScreen() {
  $("#lock-screen").classList.remove("hidden");
  $("#onboarding").classList.add("hidden");
  $("#app-shell").classList.add("hidden");
  setTimeout(() => { const p = $("#lock-pin"); if (p) p.focus(); }, 100);
}
async function tryUnlock(pin) {
  if (!pin) return;
  if (!Store.pinSalt) { toast("Пин-код повреждён"); return; }
  const h = await pbkdf2Hex(pin, Store.pinSalt, PIN_ITERATIONS);
  if (h === Store.pinHash) {
    state.unlockAttempts = 0;
    $("#lock-pin").value = "";
    $("#lock-screen").classList.add("hidden");
    bootAfterUnlock();
  } else {
    state.unlockAttempts++;
    $("#lock-pin").value = "";
    if (state.unlockAttempts >= UNLOCK_ATTEMPTS_LIMIT) {
      if (confirm("Слишком много неудачных попыток. Очистить все данные?")) { localStorage.clear(); location.reload(); }
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

// =====================================================================
// Онбординг и запуск
// =====================================================================
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
    await backupToIDB().catch(() => {});
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
  wireDebugScreen();
  wireSheetBackdrops();
  wireSearchHandlers();
  wireNotificationPermission();
  wireServiceWorker();
  wireRenameSheet();
  wireNotifBanner();
  wireContactCard();
  wireNavTitleTaps();
  wireKeyboardFix();
  applyDebugTabVisibility();

  applyGlassAlpha(Store.glassAlpha);
  applyTheme(Store.theme);
  $("#glass-slider").value = Store.glassAlpha;
  $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === Store.theme));
  $("#settings-name").value = Store.name;
  $("#settings-identity").value = Store.myIdentityRaw;
  $("#settings-signaling-url").value = Store.signalingUrl || DEFAULT_SIGNALING_URL;
  $("#settings-discoverable").checked = Store.discoverable;
  $("#settings-notifications").checked = Store.notificationsEnabled;
  $("#settings-sounds").checked = Store.soundsEnabled;
  $("#settings-pinlock").checked = Store.pinEnabled;

  loadContacts(); loadLastSeen(); loadDrafts();
  restoreOutbox(); restorePendingNoKey(); loadCallLog();
  migrateServerAckedFlags();

  const incoming = SignalingCodec.extractCodeFromLocation();
  history.replaceState(null, "", location.pathname + location.search);
  if (incoming) handleIncomingCode(incoming);

  renderTab();
  initSignaling();
  startOutboxRetryLoop();
  updateNotifBanner();
  resumeUnsentMessages();
  updateAppBadge();
  maybeShowOnboardingHint();
}

function migrateServerAckedFlags() {
  let touched = false;
  for (const c of state.contacts.values()) {
    for (const m of c.messages) {
      if (m.from !== "me") continue;
      if (m.serverAcked) continue;
      if (m.ack === "delivered" || m.ack === "read") {
        m.serverAcked = true;
        touched = true;
      }
    }
  }
  if (touched) persistContacts();
}

function maybeShowOnboardingHint() {
  if (localStorage.getItem(ONBOARDING_HINT_SHOWN) === "1") return;
  localStorage.setItem(ONBOARDING_HINT_SHOWN, "1");
  setTimeout(() => toast("Долгое нажатие на сообщение — меню действий"), 1200);
}

function wireServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    swRegistration = reg;
    setTimeout(() => { ensurePushSubscription().catch(() => {}); }, 1000);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (ev) => {
    const data = ev.data || {};
    if (data.type === "open-contact" && data.contactId) {
      window.focus();
      if (data.kind === "call") {
        state.chatId = data.contactId;
        renderTab();
        toast("Входящий звонок был пропущен");
      } else {
        state.chatId = data.contactId;
        renderTab();
      }
    }
    if (data.type === "push-subscription-changed") {
      ensurePushSubscription().catch(() => {});
    }
  });
}

// =====================================================================
// Web Push
// =====================================================================
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
    } catch (e) { console.warn("[push] не удалось подписаться:", e); return null; }
  }
  const subJson = sub.toJSON ? sub.toJSON() : sub;
  Store.pushSubscriptionJson = JSON.stringify(subJson);
  if (signaling && signaling.connected) signaling.sendPushSubscription(subJson);
  return sub;
}
function showNotification(title, body, opts) {
  opts = opts || {};
  if (!Store.notificationsEnabled) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && !opts.force) return;
  const payload = {
    type: "show-notification", title, body,
    tag: opts.tag || "ether",
    contactId: opts.contactId || null,
    kind: opts.kind || "message",
    silent: !Store.soundsEnabled,
  };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(payload); return;
  }
  if (swRegistration && swRegistration.active) {
    swRegistration.active.postMessage(payload); return;
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
      ensurePushSubscription().catch(() => {});
      toast("Уведомления включены");
      updateNotifBanner();
    } else {
      Store.notificationsEnabled = false;
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
  if (!supported || enabled || dismissed) { banner.classList.add("hidden"); return; }
  banner.classList.remove("hidden");
}

// =====================================================================
// App Badge
// =====================================================================
function updateAppBadge() {
  try {
    if (!("setAppBadge" in navigator)) return;
    let total = 0;
    for (const c of state.contacts.values()) total += unreadCount(c);
    if (total > 0) navigator.setAppBadge(total);
    else if ("clearAppBadge" in navigator) navigator.clearAppBadge();
  } catch (e) {}
}

// =====================================================================
// Контакты
// =====================================================================
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

// =====================================================================
// Навигация
// =====================================================================
function wireTabBar() {
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      state.chatId = null;
      state.contactCardId = null;
      renderTab();
    });
  });
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest("#chat-back")) { ev.preventDefault(); closeChatSafely(); return; }
    if (t.closest("#contact-back")) { ev.preventDefault(); closeContactCardSafely(); return; }
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

function closeContactCardSafely() {
  state.contactCardId = null;
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

  if (state.contactCardId) {
    $("#screen-contact").classList.remove("hidden");
    $("#tab-bar").classList.add("hidden");
    renderContactCard();
    return;
  }

  $("#tab-bar").classList.remove("hidden");
  const map = { chats: "#screen-chats", calls: "#screen-calls", connect: "#screen-connect", settings: "#screen-settings", debug: "#screen-debug" };
  const el = $(map[state.tab]);
  if (el) el.classList.remove("hidden");
  const titles = { chats: "Чаты", calls: "Звонки", connect: "Контакты", settings: "Настройки", debug: "Отладка" };
  $("#nav-title").textContent = titles[state.tab] || "Эфир";
  if (state.tab === "chats") renderChatsList();
  if (state.tab === "calls") renderCallsList();
  if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
}

// =====================================================================
// Статусы
// =====================================================================
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

// =====================================================================
// Список чатов
// =====================================================================
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
    if (query && last && (last.text || "").toLowerCase().includes(query)) preview = highlightRaw(escapeHtml(truncate(last.text, 42)), state.searchQuery);
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

// =====================================================================
// Список всех контактов (в разделе «Контакты»)
// =====================================================================
function renderContactsList() {
  const wrap = $("#contacts-list");
  const empty = $("#contacts-empty");
  if (!wrap) return;
  wrap.innerHTML = "";
  const contacts = Array.from(state.contacts.values()).filter((c) => c.managed);
  if (contacts.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  contacts.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  for (const c of contacts) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div>
      <div class="roster-name-block" style="flex:1; min-width:0;">
        <div class="roster-name">${escapeHtml(c.name || "Без имени")}</div>
        <div class="fine muted">${escapeHtml(contactStatusLabel(c))}</div>
      </div>
      <button type="button" class="roster-add-btn" data-action="card">Открыть</button>
    `;
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-action]")) return;
      openContactCard(c.id);
    });
    row.querySelector('[data-action="card"]').addEventListener("click", (ev) => {
      ev.stopPropagation();
      openContactCard(c.id);
    });
    wrap.appendChild(row);
  }
}

// =====================================================================
// Карточка контакта
// =====================================================================
function openContactCard(contactId) {
  if (!state.contacts.has(contactId)) return;
  state.contactCardId = contactId;
  renderTab();
}

function renderContactCard() {
  const c = state.contacts.get(state.contactCardId);
  if (!c) { state.contactCardId = null; renderTab(); return; }
  const av = $("#contact-avatar");
  av.style.background = avatarGradient(c.name);
  av.textContent = initials(c.name);
  $("#contact-name").textContent = c.name || "Без имени";
  $("#contact-status").textContent = contactStatusLabel(c);
  $("#contact-info-id").textContent = c.raw || "—";
  $("#contact-info-muted").textContent = c.muted ? "без звука" : "со звуком";
  $("#contact-msg-btn").disabled = false;
  $("#contact-call-btn").disabled = false;
  $("#contact-block-btn").textContent = c.blocked ? "Разблокировать" : "Заблокировать";
  $("#contact-archive-btn").textContent = c.archived ? "Из архива" : "В архив";
  $("#contact-mute-btn").textContent = c.muted ? "Включить звук" : "Без звука";
}

function wireContactCard() {
  const msgBtn = $("#contact-msg-btn");
  if (msgBtn) msgBtn.addEventListener("click", () => {
    const id = state.contactCardId;
    if (!id) return;
    state.contactCardId = null;
    state.chatId = id;
    renderTab();
  });
  const callBtn = $("#contact-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => {
    const id = state.contactCardId;
    if (!id) return;
    beginCall(id);
  });
  const rename = $("#contact-rename-btn");
  if (rename) rename.addEventListener("click", () => {
    const id = state.contactCardId;
    const c = state.contacts.get(id);
    if (!c) return;
    state.activeContactContext = id;
    $("#rename-input").value = c.name || "";
    $("#rename-sheet").classList.remove("hidden");
    setTimeout(() => $("#rename-input").focus(), 50);
  });
  const mute = $("#contact-mute-btn");
  if (mute) mute.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId);
    if (!c) return;
    c.muted = !c.muted; persistContacts(); renderContactCard();
    toast(c.muted ? "Уведомления выключены" : "Уведомления включены");
  });
  const archive = $("#contact-archive-btn");
  if (archive) archive.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId);
    if (!c) return;
    c.archived = !c.archived; persistContacts(); renderContactCard();
    toast(c.archived ? "В архиве" : "Из архива");
  });
  const block = $("#contact-block-btn");
  if (block) block.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId);
    if (!c) return;
    c.blocked = !c.blocked; persistContacts(); renderContactCard();
    toast(c.blocked ? "Заблокирован" : "Разблокирован");
  });
  const exportBtn = $("#contact-export-btn");
  if (exportBtn) exportBtn.addEventListener("click", () => exportChat(state.contactCardId));
  const clear = $("#contact-clear-btn");
  if (clear) clear.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId);
    if (!c) return;
    if (!confirm(`Очистить всю переписку с «${c.name}»?`)) return;
    c.messages = []; c.lastActivity = Date.now(); persistContacts();
    toast("История очищена");
  });
  const del = $("#contact-delete-btn");
  if (del) del.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId);
    if (!c) return;
    if (!confirm(`Удалить контакт «${c.name}»?`)) return;
    deleteContact(state.contactCardId);
  });
}

// =====================================================================
// Тред
// =====================================================================
function ackGlyph(ack) {
  if (ack === "failed") return `<span class="ack-tick ack-failed" title="Не доставлено">✓</span>`;
  if (ack === "read") return `<span class="ack-tick ack-read" title="Прочитано">✓</span>`;
  if (ack === "delivered") return `<span class="ack-tick ack-delivered" title="Доставлено">✓</span>`;
  return `<span class="ack-tick ack-sent" title="Отправлено">✓</span>`;
}

const NEAR_BOTTOM_PX = 80;
function isNearBottom(el) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
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
  const wasAtBottom = isNearBottom(wrap);
  wrap.innerHTML = "";
  const frag = document.createDocumentFragment();
  const q = state.chatSearchQuery.toLowerCase();
  let lastDay = "";
  for (const m of c.messages) {
    const dayStr = formatDayGroup(m.ts);
    if (dayStr && dayStr !== lastDay) {
      const sep = document.createElement("div");
      sep.className = "date-sep";
      const inner = document.createElement("span");
      inner.textContent = dayStr;
      sep.appendChild(inner);
      frag.appendChild(sep);
      lastDay = dayStr;
    }
    const bubble = document.createElement("div");
    bubble.className = "bubble-row " + (m.from === "me" ? "mine" : "theirs");
    const tick = m.from === "me" ? ackGlyph(m.ack) : "";
    const editedMark = m.edited ? `<span class="bubble-edited">изм.</span>` : "";
    const inner = document.createElement("div");
    inner.className = "bubble " + (m.from === "me" ? "" : "glass-content");
    const body = linkifyAndHighlight(m.text, q);
    let replyHtml = "";
    if (m.replyTo) replyHtml = `<div class="bubble-reply"><div class="bubble-reply-author">${escapeHtml(m.replyTo.authorName || "Ответ")}</div><div class="bubble-reply-text">${escapeHtml(truncate(m.replyTo.text || "", 80))}</div></div>`;
    const fwdMark = m.forwarded ? `<div class="bubble-forwarded">Переслано</div>` : "";
    let reactionsHtml = "";
    if (m.reactions && typeof m.reactions === "object") {
      const chips = Object.entries(m.reactions).filter(([, users]) => Array.isArray(users) && users.length > 0);
      if (chips.length > 0) reactionsHtml = `<div class="bubble-reactions">` + chips.map(([emoji, users]) => `<span class="bubble-reaction-chip">${escapeHtml(emoji)} ${users.length}</span>`).join("") + `</div>`;
    }
    inner.innerHTML = `${fwdMark}${replyHtml}${body}<span class="bubble-time">${formatTime(m.ts)}${editedMark}${tick}</span>${reactionsHtml}`;
    inner.addEventListener("click", () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      openMessageSheet(m.id, c.id);
    });
    attachSwipeReply(inner, m, c);
    bubble.appendChild(inner);
    frag.appendChild(bubble);
  }
  wrap.appendChild(frag);
  if (wasAtBottom) wrap.scrollTop = wrap.scrollHeight;
  updateScrollBottomButton();

  const input = $("#chat-input");
  if (state.drafts[c.id] && !state.editingMessageId) input.value = state.drafts[c.id];
  markThreadRead(c);

  if (state.chatSearchQuery) {
    if (__chatSearchScrollTimer) clearTimeout(__chatSearchScrollTimer);
    __chatSearchScrollTimer = setTimeout(() => {
      const marks = wrap.querySelectorAll(".search-hit");
      if (marks.length > 0) {
        marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 200);
  }
}

function attachSwipeReply(el, m, c) {
  let startX = 0, startY = 0, swiping = false;
  el.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; swiping = false;
    el.style.transition = "none";
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);
    if (!swiping && Math.abs(dx) > 12 && Math.abs(dx) > dy) swiping = true;
    if (swiping && dx > 0) {
      el.style.transform = `translateX(${Math.min(dx * 0.5, 60)}px)`;
    }
  }, { passive: true });
  el.addEventListener("touchend", () => {
    el.style.transition = "";
    const tr = el.style.transform;
    el.style.transform = "";
    if (swiping) {
      const m1 = tr && tr.match(/translateX\((\d+(?:\.\d+)?)px\)/);
      if (m1 && parseFloat(m1[1]) > 40) {
        state.replyTo = {
          msgId: m.id, text: m.text, from: m.from,
          authorName: m.from === "me" ? (Store.name || "Вы") : (c.name || "Собеседник"),
        };
        showReplyBanner();
        const inp = $("#chat-input"); if (inp) inp.focus();
      }
    }
    swiping = false;
  });
}

function updateScrollBottomButton() {
  const wrap = $("#chat-messages");
  const btn = $("#scroll-bottom-btn");
  if (!wrap || !btn) return;
  const visible = !isNearBottom(wrap);
  btn.classList.toggle("hidden", !visible);
}

function markThreadRead(c) {
  const toAck = [];
  for (const m of c.messages) if (m.from === "them" && !m.readAckSent) { m.readAckSent = true; toAck.push(m.id); }
  if (toAck.length === 0) return;
  persistContacts();
  sendAckBatch(c.id, toAck, "read");
  updateAppBadge();
  if (state.tab === "chats") renderChatsList();
}

function saveCurrentDraft() {
  if (!state.chatId) return;
  const input = $("#chat-input");
  if (!input) return;
  const v = input.value.trim();
  if (v) state.drafts[state.chatId] = v; else delete state.drafts[state.chatId];
  persistDrafts();
}

// =====================================================================
// Клавиатура iOS + ширина строки ввода
// =====================================================================
function wireKeyboardFix() {
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  function update() {
    const screen = $("#screen-chat");
    if (!screen || screen.classList.contains("hidden")) return;
    const isKeyboardOpen = window.innerHeight - vv.height > 100;
    document.documentElement.style.setProperty("--kb-h", isKeyboardOpen ? (window.innerHeight - vv.height) + "px" : "0px");
    const bar = $(".chat-input-bar");
    if (bar) {
      if (isKeyboardOpen) {
        bar.style.transform = `translateY(-${window.innerHeight - vv.height - vv.offsetTop}px)`;
      } else {
        bar.style.transform = "";
      }
    }
    const wrap = $("#chat-messages");
    if (wrap) {
      if (isNearBottom(wrap)) wrap.scrollTop = wrap.scrollHeight;
    }
  }
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
}

// =====================================================================
// Отправка / редактирование / удаление / пересылка
// =====================================================================
async function sendChatMessage(contactId, text, replyTo) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  if (c.blocked) { toast("Контакт заблокирован"); return; }
  if (text.length > MAX_MESSAGE_LENGTH) { text = text.slice(0, MAX_MESSAGE_LENGTH); toast("Сообщение обрезано"); }
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId, from: "me", text, ts, ack: "sent", serverAcked: false };
  if (replyTo) rec.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  c.messages.push(rec);
  trimMessages(c);
  c.lastActivity = ts;
  persistContacts();
  if (state.chatId === contactId) {
    renderChatThreadInner();
    const wrap = $("#chat-messages");
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
  if (state.tab === "chats") renderChatsList();
  playOutgoingSound();
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
  const rec = { id: msgId2, from: "me", text, ts, ack: "sent", forwarded: true, serverAcked: false };
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

// =====================================================================
// Outbox
// =====================================================================
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
  if (entry.serverAcked) { outbox.delete(msgId); persistOutbox(); return; }
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
    const kind = (entry.payload && entry.payload.kind) || "chat";
    const sent = signaling && signaling.deliver(entry.to, entry.msgId, envelope, Store.myPublicKeyJwk, kind);
    if (!sent) markMessageAck(entry.to, msgId, "failed");
    else if (kind === "chat") {
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
    if (entry.serverAcked) { outbox.delete(msgId); changed = true; continue; }
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

function resumeUnsentMessages() {
  if (!Store.myPublicKeyJwk) return;
  const now = Date.now();
  for (const c of state.contacts.values()) {
    for (const m of c.messages) {
      if (m.from !== "me") continue;
      if (m.serverAcked) continue;
      if (m.ack !== "failed") continue;
      if (outbox.has(m.id)) continue;
      if (now - m.ts > RESUME_MAX_AGE_MS) continue;
      const payload = { kind: "chat", id: m.id, text: m.text, ts: m.ts };
      addToOutbox(m.id, c.id, payload);
      flushOutboxItem(m.id);
    }
  }
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
      .then((envelope) => signaling.deliver(contactId, crypto.randomUUID(), envelope, Store.myPublicKeyJwk, "typing"))
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
      .then((envelope) => signaling.deliver(contactId, crypto.randomUUID(), envelope, Store.myPublicKeyJwk, "typing"))
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

// =====================================================================
// Сигналинг
// =====================================================================
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
    try {
      if (Store.pushSubscriptionJson) {
        const sub = JSON.parse(Store.pushSubscriptionJson);
        sig.sendPushSubscription(sub);
      }
    } catch (e) {}
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
    if (key) { Store.vapidPublicKey = key; ensurePushSubscription().catch(() => {}); }
  }));

  subs.push(on("push-subscribed", () => { console.log("[push] сервер подтвердил подписку"); }));

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
    if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
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
      if (state.contactCardId === id) renderContactCard();
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
  }));

  subs.push(on("signal", async (ev) => {
    const { from, data: packet } = ev.detail;
    if (!packet || !packet.t) return;

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
    if (!entry) return;
    const c = state.contacts.get(entry.to);
    if (c) {
      const m = c.messages.find((x) => x.id === msgId && x.from === "me");
      if (m) { m.serverAcked = true; persistContacts(); }
    }
    outbox.delete(msgId);
    persistOutbox();
  }));

  subs.push(on("deliver", async (ev) => {
    const { from, msgId, envelope, fromPublicKey, kind, queued } = ev.detail;
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
    applyIncomingPayload(from, msgId, payload, true, kind);
    sendAckBatch(from, [msgId], "delivered");
  }));

  return () => { for (const s of subs) sig.removeEventListener(s.type, s.wrapped); };
}

function applyIncomingPayload(from, envelopeMsgId, payload, fromServer, openKind) {
  const kind = (payload && payload.kind) || openKind || "chat";
  if (kind === "chat") {
    const c = ensureContactEntry(from, null);
    if (c.messages.some((m) => m.id === payload.id)) return;
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: payload.text, ts: payload.ts || Date.now(), readAckSent: isOpen };
    if (payload.replyTo) rec.replyTo = payload.replyTo;
    if (payload.forwarded) rec.forwarded = true;
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    if (isOpen) {
      renderChatThread();
      playMessageSound();
      vibrate([80, 40, 80]);
    } else {
      toast(`${c.name}: ${truncate(payload.text, 40)}`);
      if (!c.muted) {
        showNotification(c.name || "Эфир", truncate(payload.text, 80), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message" });
      }
      playMessageSound();
      vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    if (isOpen) sendAckBatch(from, [payload.id], "read");
    updateAppBadge();
  } else if (kind === "edit") {
    const c = ensureContactEntry(from, null);
    const m = c.messages.find((x) => x.id === payload.id);
    if (m) {
      m.text = payload.text; m.edited = true; m.ts = payload.ts || m.ts;
      c.lastActivity = Date.now();
      persistContacts();
      if (state.chatId === from) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }
  } else if (kind === "delete") {
    const c = ensureContactEntry(from, null);
    const before = c.messages.length;
    c.messages = c.messages.filter((x) => x.id !== payload.id);
    if (c.messages.length !== before) {
      persistContacts();
      if (state.chatId === from) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }
  } else if (kind === "ack" || (kind === "ack-batch" && Array.isArray(payload.ids))) {
    const ids = Array.isArray(payload.ids) ? payload.ids : [payload.id];
    for (const id of ids) markMessageAck(from, id, payload.state);
  } else if (kind === "typing") {
    handleIncomingTyping(from, !!payload.active);
  } else if (kind === "reaction") {
    applyReaction(from, payload);
  }
}

// =====================================================================
// Автоподключение
// =====================================================================
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

// =====================================================================
// Список онлайн (в разделе Контакты)
// =====================================================================
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
      renderContactsList();
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

// =====================================================================
// Шиты
// =====================================================================
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
    m.serverAcked = false;
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
    if (state.contactCardId === id) renderContactCard();
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
  if (state.contactCardId === id) state.contactCardId = null;
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

// =====================================================================
// Звонки
// =====================================================================
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
  const rec = state.currentCallRecord;
  if (!rec) return;
  rec.endedAt = Date.now();
  if (rec.answeredAt) {
    rec.durationMs = rec.endedAt - rec.answeredAt;
    rec.status = finalStatus === "failed" ? "failed" : "completed";
  } else {
    if (!finalStatus || finalStatus === "completed") {
      finalStatus = rec.direction === "in" ? "missed" : "cancelled";
    }
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

async function beginCall(id) {
  const c = state.contacts.get(id);
  if (!c) return;
  if (c.blocked) { toast("Контакт заблокирован"); return; }
  openCallScreen(id, "calling");
  if (signaling && signaling.connected) {
    signaling.signal(id, { t: "call-invite", n: Store.name });
  } else {
    toast("Нет связи с сервером — звонок невозможен");
    closeCallScreen("failed");
    return;
  }
  const link = mesh.get(id);
  if (link && isReachable(c)) {
    try { await link.startCall(); }
    catch (e) { toast("Нет доступа к микрофону"); closeCallScreen("failed"); return; }
    return;
  }
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

// =====================================================================
// Поиск
// =====================================================================
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
  if (csi) csi.addEventListener("input", (e) => {
    state.chatSearchQuery = e.target.value.trim();
    renderChatThread();
    updateSearchCounter();
  });
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

// =====================================================================
// Настройки
// =====================================================================
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
  const sounds = $("#settings-sounds");
  if (sounds) sounds.addEventListener("change", (e) => {
    Store.soundsEnabled = e.target.checked;
    toast(e.target.checked ? "Звук и вибрация включены" : "Звук и вибрация выключены");
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
        const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
        if (h !== Store.pinHash) { toast("Неверный пин-код"); return; }
        $("#set-pin-title").textContent = "Новый пин-код";
        $("#set-pin-input").value = "";
        return;
      }
      Store.pinSalt = randomSaltHex(16);
      Store.pinHash = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      Store.pinEnabled = true;
      $("#set-pin-sheet").classList.add("hidden");
      toast("Пин-код включён");
    } else {
      const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      if (h !== Store.pinHash) { toast("Неверный пин-код"); return; }
      Store.pinEnabled = false;
      Store.pinHash = "";
      Store.pinSalt = "";
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
}

// =====================================================================
// Вкладка Отладка
// =====================================================================
function applyDebugTabVisibility() {
  const hidden = Store.debugHidden;
  const tab = document.getElementById("tab-debug");
  if (tab) tab.classList.toggle("hidden", hidden);
  const toggle = document.getElementById("debug-hide-toggle");
  if (toggle) toggle.checked = hidden;
  if (hidden && state.tab === "debug") { state.tab = "chats"; renderTab(); }
}

function wireNavTitleTaps() {
  const el = document.getElementById("nav-title");
  if (!el) return;
  el.addEventListener("click", () => {
    const now = Date.now();
    __navTitleTaps = __navTitleTaps.filter((t) => now - t < 2000);
    __navTitleTaps.push(now);
    if (__navTitleTaps.length >= 5) {
      __navTitleTaps = [];
      Store.debugHidden = false;
      applyDebugTabVisibility();
      toast("Вкладка «Отладка» включена");
    }
  });
}

function wireDebugScreen() {
  const diag = $("#diagnostics-btn");
  if (diag) diag.addEventListener("click", () => { renderDiagnostics(); $("#diagnostics-sheet").classList.remove("hidden"); });
  const diagClose = $("#diagnostics-close");
  if (diagClose) diagClose.addEventListener("click", () => $("#diagnostics-sheet").classList.add("hidden"));
  const diagR = $("#diagnostics-refresh-btn");
  if (diagR) diagR.addEventListener("click", renderDiagnostics);
  const diagC = $("#diagnostics-copy-btn");
  if (diagC) diagC.addEventListener("click", () => copyText(buildDiagnosticsText(), "Диагностика скопирована"));

  const logsBtn = $("#debug-logs-btn");
  if (logsBtn) logsBtn.addEventListener("click", () => {
    renderLogsSheet();
    $("#logs-sheet").classList.remove("hidden");
  });
  const logsClose = $("#logs-close");
  if (logsClose) logsClose.addEventListener("click", () => $("#logs-sheet").classList.add("hidden"));
  const logsCopy = $("#logs-copy-btn");
  if (logsCopy) logsCopy.addEventListener("click", () => copyText(buildLogsText(), "Журнал скопирован"));
  const logsClear = $("#logs-clear-btn");
  if (logsClear) logsClear.addEventListener("click", () => {
    window.__etherDiag = [];
    renderLogsSheet();
    toast("Журнал очищен");
  });

  const storageBtn = $("#debug-storage-btn");
  if (storageBtn) storageBtn.addEventListener("click", () => {
    renderStorageSheet();
    $("#storage-sheet").classList.remove("hidden");
  });
  const storageClose = $("#storage-close");
  if (storageClose) storageClose.addEventListener("click", () => $("#storage-sheet").classList.add("hidden"));

  const expBackup = $("#export-backup-btn");
  if (expBackup) expBackup.addEventListener("click", exportBackup);
  const impBackup = $("#import-backup-btn");
  if (impBackup) impBackup.addEventListener("click", () => $("#import-backup-input").click());
  const impInput = $("#import-backup-input");
  if (impInput) impInput.addEventListener("change", importBackup);

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

  const hard = $("#debug-hard-reset-btn");
  if (hard) hard.addEventListener("click", () => {
    if (!confirm("Полный сброс: удалит аккаунт, пин-код, ключи шифрования и все данные. Продолжить?")) return;
    if (!confirm("Точно? Восстановить не получится.")) return;
    localStorage.clear();
    if ("caches" in window) caches.keys().then((names) => names.forEach((n) => caches.delete(n)));
    if ("indexedDB" in window) try { indexedDB.deleteDatabase("ether-db"); } catch (e) {}
    location.reload();
  });

  const hideToggle = $("#debug-hide-toggle");
  if (hideToggle) hideToggle.addEventListener("change", (e) => {
    Store.debugHidden = e.target.checked;
    applyDebugTabVisibility();
    toast(e.target.checked ? "Вкладка скрыта" : "Вкладка показана");
  });
}

function renderLogsSheet() {
  const el = $("#logs-content");
  if (el) el.textContent = buildLogsText();
}
function buildLogsText() {
  const log = window.__etherDiag || [];
  const lines = [];
  for (const entry of log.slice(-200)) {
    const d = new Date(entry.ts);
    const stamp = `${d.toLocaleTimeString("ru-RU")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    lines.push(`[${stamp}] [${entry.level}] ${entry.line}`);
  }
  return lines.join("\n");
}

function renderStorageSheet() {
  const el = $("#storage-summary");
  if (!el) return;
  const items = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("ether.")) continue;
    const v = localStorage.getItem(k) || "";
    items.push({ key: k, size: v.length });
  }
  items.sort((a, b) => b.size - a.size);
  const totalBytes = items.reduce((s, x) => s + x.size, 0);
  let html = `<div><b>Всего в localStorage:</b> ${(totalBytes / 1024).toFixed(1)} КБ</div>`;
  html += `<div><b>Ключей:</b> ${items.length}</div><hr style="border:none;border-top:1px solid var(--hairline);margin:10px 0;">`;
  for (const it of items) {
    html += `<div style="display:flex;justify-content:space-between;gap:8px;"><span>${escapeHtml(it.key)}</span><span class="muted">${(it.size / 1024).toFixed(1)} КБ</span></div>`;
  }
  el.innerHTML = html;
}

// =====================================================================
// Диагностика
// =====================================================================
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
    <div><b>Звук/вибро:</b> ${Store.soundsEnabled ? "✅" : "⚠️"}</div>
    <div><b>PWA:</b> ${isStandalone() ? "✅ установлено" : "не на домашний экран"}</div>
    <div><b>VAPID:</b> ${Store.vapidPublicKey ? "✅ получен" : "⚠️ нет"}</div>
    <div><b>Пин-код:</b> ${Store.pinEnabled ? "✅ включён" : "⚠️ выключен"}</div>`;
  const log = $("#diagnostics-log"); if (log) log.textContent = buildDiagnosticsText();
}

// =====================================================================
// Экспорт/импорт бэкапа
// =====================================================================
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

// =====================================================================
// События mesh
// =====================================================================
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
      if (pendingCall.contactId === id && link) {
        clearPendingCall();
        link.startCall().catch(() => { toast("Нет доступа к микрофону"); closeCallScreen("failed"); });
      }
      if (state.callId === id && state.callPhase !== "active" && link) {
        link.answerCall().then(setCallPhaseActive).catch(() => {});
      }
      flushOutbox();
    }
    if (status === "disconnected") {
      if (state.callId === id) {
        const wasAnswered = state.currentCallRecord && state.currentCallRecord.answeredAt;
        closeCallScreen(wasAnswered ? "completed" : "missed");
      }
      if (c.managed && c.online) scheduleAutoConnect(id);
      sendTypingStop(id);
    }
    if (state.chatId === id) renderChatThread();
    if (state.contactCardId === id) renderContactCard();
    if (state.tab === "chats" && !state.chatId) renderChatsList();
  });
  mesh.addEventListener("message", (ev) => {
    const { id, payload } = ev.detail;
    const c = state.contacts.get(id); if (!c) return;
    if (c.blocked) return;
    if (payload && payload.kind === "call-state") {
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
    applyIncomingPayload(id, payload && payload.id, payload, false, payload && payload.kind);
  });
  mesh.addEventListener("remote-track", (ev) => {
    const { id, stream } = ev.detail;
    if (state.callId === id && state.callPhase !== "active") { pendingRemoteStreams.set(id, stream); return; }
    attachRemoteAudio(id, stream);
  });
}

// =====================================================================
// Boot-recovery
// =====================================================================
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

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await restoreFromIDB().catch(() => {});
    initBoot();
    clearTimeout(bootWatchdog);
  } catch (e) { console.error("[boot]", e); showBootRecovery(); }
});

document.getElementById("boot-recovery-reset")?.addEventListener("click", () => {
  localStorage.clear();
  if ("caches" in window) caches.keys().then((names) => names.forEach((n) => caches.delete(n)));
  if ("indexedDB" in window) try { indexedDB.deleteDatabase("ether-db"); } catch (e) {}
  location.reload();
});

window.addEventListener("beforeunload", () => {
  try { saveCurrentDraft(); } catch (e) {}
  try { backupToIDB(); } catch (e) {}
});

// Обновляем бейдж при возврате фокуса
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    updateAppBadge();
    if (state.chatId) markThreadRead(state.contacts.get(state.chatId));
  }
});

// Кнопка «вниз»
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("scroll-bottom-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const wrap = document.getElementById("chat-messages");
    if (wrap) wrap.scrollTo({ top: wrap.scrollHeight, behavior: "smooth" });
  });
  const wrap = document.getElementById("chat-messages");
  if (wrap) {
    wrap.addEventListener("scroll", () => { updateScrollBottomButton(); });
  }
});

// Обработчики формы чата (привязываются один раз)
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("chat-form");
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text || !state.chatId) return;
    if (state.editingMessageId) { commitEdit(state.chatId, state.editingMessageId, text); cancelEditing(); }
    else { sendChatMessage(state.chatId, text, state.replyTo); cancelReply(); }
    input.value = "";
    delete state.drafts[state.chatId];
    persistDrafts();
    sendTypingStop(state.chatId);
  });

  const input = document.getElementById("chat-input");
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

  const callBtn = document.getElementById("chat-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => beginCall(state.chatId));

  const moreBtn = document.getElementById("chat-more-btn");
  if (moreBtn) moreBtn.addEventListener("click", () => {
    const id = state.chatId;
    if (!id) return;
    openContactCard(id);
  });

  const peerTap = document.getElementById("chat-peer-tap");
  if (peerTap) peerTap.addEventListener("click", () => {
    const id = state.chatId;
    if (!id) return;
    openContactCard(id);
  });

  const editCancel = document.getElementById("edit-cancel-btn");
  if (editCancel) editCancel.addEventListener("click", () => {
    const id = state.chatId;
    cancelEditing();
    const inp = document.getElementById("chat-input");
    if (id && state.drafts[id]) inp.value = state.drafts[id]; else inp.value = "";
  });

  const replyCancel = document.getElementById("reply-cancel-btn");
  if (replyCancel) replyCancel.addEventListener("click", () => cancelReply());
});