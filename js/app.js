"use strict";

const DEFAULT_SIGNALING_URL = "wss://ether-1-baqy.onrender.com";
const MAX_MESSAGE_LENGTH = 4000;
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
const DEBUG_KEY = "ether.debugHidden";
const CONNECT_STUCK_MS = 30000;
const WATCH_CONNECT_TIMEOUT_MS = 20000;
const ACK_DEDUP_WINDOW_MS = 5000;
// Если активный звонок остаётся без живого P2P дольше этого времени —
// закрываем принудительно, чтобы UI не висел вечно.
const CALL_DEAD_LINK_TIMEOUT_MS = 30000;
// Сколько ждём «принятия» входящего, прежде чем пометить его пропущенным.
const INCOMING_CALL_TIMEOUT_MS = 40000;

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
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
    return dbPromise;
  }
  async function set(key, value) {
    try {
      const db = await open();
      return new Promise((res) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
        tx.onabort = () => res();
      });
    } catch (e) { return null; }
  }
  async function get(key) {
    try {
      const db = await open();
      return new Promise((res) => {
        const tx = db.transaction(STORE, "readonly");
        const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(undefined);
      });
    } catch (e) { return undefined; }
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
  get debugHidden() { return localStorage.getItem(DEBUG_KEY) !== "0"; },
  set debugHidden(v) { localStorage.setItem(DEBUG_KEY, v ? "1" : "0"); },
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
// Логирование
// =====================================================================
window.__etherDiag = window.__etherDiag || [];
if (typeof window.etherLog !== "function") {
  window.etherLog = function (level, ...args) {
    const line = args.map((a) => (typeof a === "string" ? a : safeJsonArg(a))).join(" ");
    window.__etherDiag.push({ ts: Date.now(), level, line });
    if (window.__etherDiag.length > 500) window.__etherDiag.shift();
    (console[level] || console.log).apply(console, args);
  };
}
function safeJsonArg(a) { try { return JSON.stringify(a); } catch (e) { return String(a); } }
var etherLog = window.etherLog;

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
  // Служебное для звонков.
  _callAcceptInFlight: false,
  _callDeadSeconds: 0,
};

let mesh = null;
let signaling = null;
let signalingCleanup = null;
let outboxRetryTimer = null;
let swRegistration = null;
let __lockWired = false;
let __appStarted = false;
let __chatWired = false;
let __navTitleTaps = [];
let __chatSearchScrollTimer = null;
const onlineSet = new Set();
const onlineRoster = new Map();
const autoConnectTimers = new Map();
// Дедупликация сигнальных пакетов по паре from + packet.x.
const recentSignalNonces = new Set();
const outbox = new Map();
const pendingNoKey = new Map();
const seenDeliverIds = new Set();

// Защита от одновременного создания двух PeerLink для одного и того же id.
const _connectInFlight = new Set();

const pendingCall = { contactId: null, timer: null };
const pendingRemoteStreams = new Map();
let callTimerInterval = null;
// Один общий AudioContext: iOS плохо относится к нескольким параллельным.
let globalAudioCtx = null;
let ringtoneTimer = null;
// Резервный HTMLAudio-элемент для рингтона — на iOS Web Audio может
// не разбудиться, если пользователь ещё ни разу не тапал по экрану.
let ringtoneAudioEl = null;

// =====================================================================
// Утилиты
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function safeCall(fn, label) {
  try { fn(); }
  catch (e) { etherLog("error", "[wire]", label || "unknown", String(e && e.message || e)); }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function linkifyAndHighlight(text, query) {
  const esc = escapeHtml(text);
  const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/gi;
  let result = "";
  let lastIdx = 0;
  let m;
  urlRegex.lastIndex = 0;
  while ((m = urlRegex.exec(esc)) !== null) {
    if (m.index > lastIdx) result += highlightRaw(esc.slice(lastIdx, m.index), query);
    result += `<a href="${m[1]}" target="_blank" rel="noopener noreferrer">${highlightRaw(m[1], query)}</a>`;
    lastIdx = m.index + m[1].length;
  }
  if (lastIdx < esc.length) result += highlightRaw(esc.slice(lastIdx), query);
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
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), { name: "PBKDF2" }, false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return bufToHex(bits);
}

function isStandalone() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      || (window.navigator && window.navigator.standalone === true);
}
function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }

// Дедупликация сигнальных пакетов по необязательному полю packet.x.
// Если у пакета нет x — считаем, что дедуп не нужен, и возвращаем false.
function isDuplicateSignal(from, packet) {
  if (!packet || typeof packet !== "object") return false;
  const tag = packet.x;
  if (!tag) return false;
  const key = String(from) + ":" + String(tag);
  if (recentSignalNonces.has(key)) return true;
  recentSignalNonces.add(key);
  if (recentSignalNonces.size > 200) {
    const first = recentSignalNonces.values().next().value;
    recentSignalNonces.delete(first);
  }
  return false;
}

// =====================================================================
// Аудио-разогрев (iOS)
// =====================================================================
function ensureGlobalAudioCtx() {
  if (!globalAudioCtx) {
    try { globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { globalAudioCtx = null; }
  }
  return globalAudioCtx;
}
function initAudioWarmup() {
  const warm = () => {
    try {
      const ctx = ensureGlobalAudioCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") {
        ctx.resume().then(() => {
          etherLog("info", "[audio] ctx resumed, state=" + ctx.state);
        }).catch(() => {});
      }
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.01);
      } catch (e) {}
    } catch (e) {
      etherLog("warn", "[audio] warmup failed:", String(e));
    }
  };
  document.addEventListener("touchstart", warm, { passive: true });
  document.addEventListener("click", warm);
  document.addEventListener("keydown", warm);
  warm();
}

// =====================================================================
// Звуки и вибрация
// =====================================================================
function ensureAudioCtx() {
  const ctx = ensureGlobalAudioCtx();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
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
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.start(t);
    osc.stop(t + 0.32);
  } catch (e) { etherLog("warn", "[sound] message:", String(e)); }
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
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
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
    const ctx = ensureAudioCtx();
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      etherLog("info", "[ringtone] start, ctx.state=" + ctx.state);
      const playTone = (freq, delay, dur, vol) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        const t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      };
      const ringCycle = () => {
        playTone(880, 0, 0.18, 0.4);
        playTone(660, 0.18, 0.18, 0.4);
        playTone(880, 0.4, 0.18, 0.4);
        playTone(660, 0.58, 0.18, 0.4);
      };
      ringCycle();
      ringtoneTimer = setInterval(ringCycle, 2000);
    }
  } catch (e) { etherLog("error", "[ringtone] Web Audio failed:", String(e)); }

  try {
    if (!ringtoneAudioEl) {
      ringtoneAudioEl = document.createElement("audio");
      ringtoneAudioEl.setAttribute("playsinline", "");
      ringtoneAudioEl.loop = true;
      ringtoneAudioEl.preload = "auto";
      ringtoneAudioEl.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
      document.body.appendChild(ringtoneAudioEl);
    }
    const pp = ringtoneAudioEl.play();
    if (pp && pp.catch) pp.catch(() => {});
  } catch (e) {}

  if (navigator.vibrate) {
    try { navigator.vibrate([400, 200, 400, 200, 400, 1000]); } catch (e) {}
  }
}
function stopRingtone() {
  if (ringtoneTimer) { clearInterval(ringtoneTimer); ringtoneTimer = null; }
  if (ringtoneAudioEl) {
    try { ringtoneAudioEl.pause(); ringtoneAudioEl.currentTime = 0; } catch (e) {}
  }
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
}

// =====================================================================
// Пин-код
// =====================================================================
function showLockScreen() {
  const l = $("#lock-screen"); if (l) l.classList.remove("hidden");
  const o = $("#onboarding"); if (o) o.classList.add("hidden");
  const a = $("#app-shell"); if (a) a.classList.add("hidden");
  setTimeout(() => { const p = $("#lock-pin"); if (p) p.focus(); }, 100);
}
async function tryUnlock(pin) {
  if (!pin) return;
  if (!Store.pinSalt) {
    if (confirm("Пин-код повреждён. Сбросить все данные приложения?")) { localStorage.clear(); location.reload(); }
    return;
  }
  const h = await pbkdf2Hex(pin, Store.pinSalt, PIN_ITERATIONS);
  if (h === Store.pinHash) {
    state.unlockAttempts = 0;
    const p = $("#lock-pin"); if (p) p.value = "";
    const l = $("#lock-screen"); if (l) l.classList.add("hidden");
    bootAfterUnlock();
  } else {
    state.unlockAttempts++;
    const p = $("#lock-pin"); if (p) p.value = "";
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
    ]).then(() => {
      try { startApp(); }
      catch (e) { etherLog("error", "[startApp]", String(e)); }
    }).catch(() => {
      try { startApp(); } catch (e) {}
    });
  } else {
    const o = $("#onboarding"); if (o) o.classList.remove("hidden");
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
    await ensureKeyPair().catch(() => {});
    await (window.__etherIceReady || Promise.resolve()).catch(() => {});
    await backupToIDB().catch(() => {});
    const o = $("#onboarding"); if (o) o.classList.add("hidden");
    try { startApp(); } catch (e) { etherLog("error", "[startApp]", String(e)); }
  });
}
async function ensureKeyPair() {
  try {
    if (Store.myPrivateKeyJwk && Store.myPublicKeyJwk) return;
    const { publicKeyJwk, privateKeyJwk } = await CryptoHelper.generateKeyPair();
    Store.myPrivateKeyJwk = privateKeyJwk;
    Store.myPublicKeyJwk = publicKeyJwk;
  } catch (e) { etherLog("error", "[crypto] key pair:", String(e)); }
}

function startApp() {
  if (__appStarted) {
    const o = $("#onboarding"); if (o) o.classList.add("hidden");
    const l = $("#lock-screen"); if (l) l.classList.add("hidden");
    const a = $("#app-shell"); if (a) a.classList.remove("hidden");
    return;
  }
  __appStarted = true;
  const o = $("#onboarding"); if (o) o.classList.add("hidden");
  const l = $("#lock-screen"); if (l) l.classList.add("hidden");
  const a = $("#app-shell"); if (a) a.classList.remove("hidden");

  etherLog("info", "[startApp] init, id=" + (Store.myId ? Store.myId.slice(0, 10) + "…" : "(none)"));
  mesh = new MeshManager(Store.name);

  safeCall(wireMeshEvents, "wireMeshEvents");
  safeCall(wireTabBar, "wireTabBar");
  safeCall(wireConnectScreen, "wireConnectScreen");
  safeCall(wireChatScreen, "wireChatScreen");
  safeCall(wireCallScreen, "wireCallScreen");
  safeCall(wireSettingsScreen, "wireSettingsScreen");
  safeCall(wireDebugScreen, "wireDebugScreen");
  safeCall(wireSheetBackdrops, "wireSheetBackdrops");
  safeCall(wireSearchHandlers, "wireSearchHandlers");
  safeCall(wireNotificationPermission, "wireNotificationPermission");
  safeCall(wireServiceWorker, "wireServiceWorker");
  safeCall(wireRenameSheet, "wireRenameSheet");
  safeCall(wireNotifBanner, "wireNotifBanner");
  safeCall(wireContactCard, "wireContactCard");
  safeCall(wireNavTitleTaps, "wireNavTitleTaps");
  safeCall(wireKeyboardFix, "wireKeyboardFix");
  safeCall(wireNetworkListeners, "wireNetworkListeners");
  safeCall(applyDebugTabVisibility, "applyDebugTabVisibility");
  safeCall(initAudioWarmup, "initAudioWarmup");

  try {
    applyGlassAlpha(Store.glassAlpha);
    applyTheme(Store.theme);
    const slider = $("#glass-slider"); if (slider) slider.value = Store.glassAlpha;
    $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === Store.theme));
    const sn = $("#settings-name"); if (sn) sn.value = Store.name;
    const si = $("#settings-identity"); if (si) si.value = Store.myIdentityRaw;
    const ss = $("#settings-signaling-url"); if (ss) ss.value = Store.signalingUrl || DEFAULT_SIGNALING_URL;
    const sd = $("#settings-discoverable"); if (sd) sd.checked = Store.discoverable;
    const snn = $("#settings-notifications"); if (snn) snn.checked = Store.notificationsEnabled;
    const ssn = $("#settings-sounds"); if (ssn) ssn.checked = Store.soundsEnabled;
    const spl = $("#settings-pinlock"); if (spl) spl.checked = Store.pinEnabled;
  } catch (e) { etherLog("error", "[startApp] settings init:", String(e)); }

  try {
    loadContacts(); loadLastSeen(); loadDrafts();
    restoreOutbox(); restorePendingNoKey(); loadCallLog();
    migrateServerAckedFlags();
  } catch (e) { etherLog("error", "[startApp] load data:", String(e)); }

  try {
    const incoming = SignalingCodec.extractCodeFromLocation();
    history.replaceState(null, "", location.pathname + location.search);
    if (incoming) handleIncomingCode(incoming);
  } catch (e) { etherLog("error", "[startApp] incoming code:", String(e)); }

  try { renderTab(); } catch (e) { etherLog("error", "[startApp] renderTab:", String(e)); }
  try { initSignaling(); } catch (e) { etherLog("error", "[startApp] initSignaling:", String(e)); }
  try { startOutboxRetryLoop(); } catch (e) {}
  try { updateNotifBanner(); } catch (e) {}
  try { resumeUnsentMessages(); } catch (e) {}
  try { updateAppBadge(); } catch (e) {}
  try { maybeShowOnboardingHint(); } catch (e) {}
  // Никаких «зависших» звонков из прошлой сессии.
  try { state.callId = null; state.callPhase = null; state._callAcceptInFlight = false; state._callDeadSeconds = 0; } catch (e) {}
}

function wireNetworkListeners() {
  window.addEventListener("online", () => etherLog("info", "[net] online"));
  window.addEventListener("offline", () => etherLog("warn", "[net] offline"));
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    conn.addEventListener("change", () => {
      etherLog("info", "[net] connection change: " + conn.effectiveType + ", downlink=" + conn.downlink);
    });
  }
}

function migrateServerAckedFlags() {
  let touched = false;
  for (const c of state.contacts.values()) {
    for (const m of c.messages) {
      if (m.from !== "me") continue;
      if (m.serverAcked) continue;
      if (m.ack === "delivered" || m.ack === "read") { m.serverAcked = true; touched = true; }
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
      state.chatId = data.contactId;
      renderTab();
      if (data.kind === "call") toast("Входящий звонок был пропущен");
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
    } catch (e) { etherLog("warn", "[push] subscribe failed:", String(e)); return null; }
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
function closeContactCardSafely() { state.contactCardId = null; try { renderTab(); } catch (e) {} }
function renderTab() { try { renderTabInner(); } catch (e) { etherLog("error", "[renderTab]", String(e)); } }
function renderTabInner() {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $$(".screen").forEach((s) => s.classList.add("hidden"));

  if (state.chatId) {
    const sc = $("#screen-chat"); if (sc) sc.classList.remove("hidden");
    const tb = $("#tab-bar"); if (tb) tb.classList.add("hidden");
    renderChatThread();
    return;
  }
  if (state.contactCardId) {
    const sc = $("#screen-contact"); if (sc) sc.classList.remove("hidden");
    const tb = $("#tab-bar"); if (tb) tb.classList.add("hidden");
    renderContactCard();
    return;
  }
  const tb = $("#tab-bar"); if (tb) tb.classList.remove("hidden");
  const map = { chats: "#screen-chats", calls: "#screen-calls", connect: "#screen-connect", settings: "#screen-settings", debug: "#screen-debug" };
  const el = $(map[state.tab]); if (el) el.classList.remove("hidden");
  const titles = { chats: "Чаты", calls: "Звонки", connect: "Контакты", settings: "Настройки", debug: "Отладка" };
  const nt = $("#nav-title"); if (nt) nt.textContent = titles[state.tab] || "Эфир";
  if (state.tab === "chats") renderChatsList();
  if (state.tab === "calls") renderCallsList();
  if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
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
    if (empty) empty.classList.toggle("hidden", query.length > 0);
    if (archivedToggle) archivedToggle.classList.toggle("hidden", !withArchived);
    return;
  }
  if (empty) empty.classList.add("hidden");
  if (archivedToggle) archivedToggle.classList.toggle("hidden", !withArchived);
  const ta = $("#toggle-archived"); if (ta) ta.textContent = state.showArchived ? "Скрыть архив ‹" : "Показать архив ›";
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

function renderContactsList() {
  const wrap = $("#contacts-list");
  const empty = $("#contacts-empty");
  if (!wrap) return;
  wrap.innerHTML = "";
  const contacts = Array.from(state.contacts.values()).filter((c) => c.managed);
  if (contacts.length === 0) { if (empty) empty.classList.remove("hidden"); return; }
  if (empty) empty.classList.add("hidden");
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
      <button type="button" class="roster-add-btn" data-action="card">Открыть</button>`;
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

function openContactCard(contactId) { if (!state.contacts.has(contactId)) return; state.contactCardId = contactId; renderTab(); }
function renderContactCard() {
  const c = state.contacts.get(state.contactCardId);
  if (!c) { state.contactCardId = null; renderTab(); return; }
  const av = $("#contact-avatar");
  if (av) { av.style.background = avatarGradient(c.name); av.textContent = initials(c.name); }
  const n = $("#contact-name"); if (n) n.textContent = c.name || "Без имени";
  const st = $("#contact-status"); if (st) st.textContent = contactStatusLabel(c);
  const idEl = $("#contact-info-id"); if (idEl) idEl.textContent = c.raw || "—";
  const mutedEl = $("#contact-info-muted"); if (mutedEl) mutedEl.textContent = c.muted ? "без звука" : "со звуком";
  const blockBtn = $("#contact-block-btn"); if (blockBtn) blockBtn.textContent = c.blocked ? "Разблокировать" : "Заблокировать";
  const archBtn = $("#contact-archive-btn"); if (archBtn) archBtn.textContent = c.archived ? "Из архива" : "В архив";
  const muteBtn = $("#contact-mute-btn"); if (muteBtn) muteBtn.textContent = c.muted ? "Включить звук" : "Без звука";
}
function wireContactCard() {
  const msgBtn = $("#contact-msg-btn");
  if (msgBtn) msgBtn.addEventListener("click", () => {
    const id = state.contactCardId; if (!id) return;
    state.contactCardId = null; state.chatId = id; renderTab();
  });
  const callBtn = $("#contact-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => { const id = state.contactCardId; if (!id) return; beginCall(id); });
  const rename = $("#contact-rename-btn");
  if (rename) rename.addEventListener("click", () => {
    const id = state.contactCardId;
    const c = state.contacts.get(id); if (!c) return;
    state.activeContactContext = id;
    const ri = $("#rename-input"); if (ri) ri.value = c.name || "";
    const rs = $("#rename-sheet"); if (rs) rs.classList.remove("hidden");
    setTimeout(() => { const ri2 = $("#rename-input"); if (ri2) ri2.focus(); }, 50);
  });
  const mute = $("#contact-mute-btn");
  if (mute) mute.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.muted = !c.muted; persistContacts(); renderContactCard();
    toast(c.muted ? "Уведомления выключены" : "Уведомления включены");
  });
  const archive = $("#contact-archive-btn");
  if (archive) archive.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.archived = !c.archived; persistContacts(); renderContactCard();
    toast(c.archived ? "В архиве" : "Из архива");
  });
  const block = $("#contact-block-btn");
  if (block) block.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.blocked = !c.blocked; persistContacts(); renderContactCard();
    toast(c.blocked ? "Заблокирован" : "Разблокирован");
  });
  const exportBtn = $("#contact-export-btn");
  if (exportBtn) exportBtn.addEventListener("click", () => exportChat(state.contactCardId));
  const clear = $("#contact-clear-btn");
  if (clear) clear.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (!confirm(`Очистить всю переписку с «${c.name}»?`)) return;
    c.messages = []; c.lastActivity = Date.now(); persistContacts();
    toast("История очищена");
  });
  const del = $("#contact-delete-btn");
  if (del) del.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
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
function isNearBottom(el) { if (!el) return true; return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX; }

function renderChatThread() { try { renderChatThreadInner(); } catch (e) { etherLog("error", "[renderChatThread]", String(e)); const w = $("#chat-messages"); if (w) w.innerHTML = `<div class="empty-state"><p>Не удалось отрисовать переписку.</p></div>`; } }

function renderChatThreadInner() {
  const c = state.contacts.get(state.chatId);
  if (!c) { state.chatId = null; renderTab(); return; }
  const nm = $("#chat-peer-name"); if (nm) nm.textContent = c.name || "Без имени";
  const statusEl = $("#chat-peer-status");
  const typing = state.typingTimers.has(c.id);
  if (statusEl) {
    statusEl.textContent = typing ? "печатает…" : contactStatusLabel(c);
    statusEl.classList.toggle("typing", typing);
  }
  const canCall = isReachable(c) || (c.managed && c.online);
  const ccb = $("#chat-call-btn"); if (ccb) ccb.disabled = !canCall;

  const badge = $("#chat-transport-badge");
  const link = mesh ? mesh.get(c.id) : null;
  if (badge) {
    if (link && (link.status === "connected" || link.status === "in-call")) {
      badge.textContent = "P2P"; badge.classList.remove("hidden", "via-server");
    } else if (link && link.status === "connecting") {
      badge.textContent = "соединяемся…"; badge.classList.add("via-server"); badge.classList.remove("hidden");
    } else if (c.managed && c.online) {
      badge.textContent = "через сервер"; badge.classList.add("via-server"); badge.classList.remove("hidden");
    } else badge.classList.add("hidden");
  }

  const wrap = $("#chat-messages");
  if (!wrap) return;
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
  if (input && state.drafts[c.id] && !state.editingMessageId) input.value = state.drafts[c.id];
  markThreadRead(c);

  if (state.chatSearchQuery) {
    if (__chatSearchScrollTimer) clearTimeout(__chatSearchScrollTimer);
    __chatSearchScrollTimer = setTimeout(() => {
      const marks = wrap.querySelectorAll(".search-hit");
      if (marks.length > 0) marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
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
    if (swiping && dx > 0) el.style.transform = `translateX(${Math.min(dx * 0.5, 60)}px)`;
  }, { passive: true });
  el.addEventListener("touchend", () => {
    el.style.transition = "";
    const tr = el.style.transform;
    el.style.transform = "";
    if (swiping) {
      const m1 = tr && tr.match(/translateX\((\d+(?:\.\d+)?)px\)/);
      if (m1 && parseFloat(m1[1]) > 40) {
        state.replyTo = { msgId: m.id, text: m.text, from: m.from, authorName: m.from === "me" ? (Store.name || "Вы") : (c.name || "Собеседник") };
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
  btn.classList.toggle("hidden", isNearBottom(wrap));
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
  const input = $("#chat-input"); if (!input) return;
  const v = input.value.trim();
  if (v) state.drafts[state.chatId] = v; else delete state.drafts[state.chatId];
  persistDrafts();
}
function wireKeyboardFix() {
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  function update() {
    const screen = document.getElementById("screen-chat");
    if (!screen || screen.classList.contains("hidden")) return;
    const bar = document.querySelector(".chat-input-bar"); if (!bar) return;
    const kb = Math.max(0, window.innerHeight - vv.height);
    if (kb > 60) bar.style.transform = `translateY(-${kb}px)`;
    else bar.style.transform = "";
    const wrap = document.getElementById("chat-messages");
    if (wrap) { if (isNearBottom(wrap)) wrap.scrollTop = wrap.scrollHeight; }
  }
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
}

// =====================================================================
// Отправка/редактирование/удаление
// =====================================================================
async function sendChatMessage(contactId, text, replyTo) {
  const c = state.contacts.get(contactId); if (!c) return;
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
    const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
  if (state.tab === "chats") renderChatsList();
  playOutgoingSound();
  const payload = { kind: "chat", id: msgId, text, ts };
  if (replyTo) payload.replyTo = { id: replyTo.msgId, text: replyTo.text, from: replyTo.from };
  await trySendOrQueue(c, msgId, payload);
}
function trimMessages(c) { if (c.messages.length <= MAX_MESSAGES_PER_CHAT) return; c.messages = c.messages.slice(-MAX_MESSAGES_PER_CHAT); }
async function commitEdit(contactId, msgId, newText) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
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
  const c = state.contacts.get(contactId); if (!c) return;
  c.messages = c.messages.filter((x) => x.id !== msgId);
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
async function deleteMessageForBoth(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  deleteMessageLocal(contactId, msgId);
  const actionId = crypto.randomUUID();
  const payload = { kind: "delete", id: msgId, ts: Date.now() };
  await trySendOrQueue(c, actionId, payload);
}
async function forwardMessage(msgId, fromContactId, toContactId) {
  const from = state.contacts.get(fromContactId), to = state.contacts.get(toContactId);
  if (!from || !to) return;
  const m = from.messages.find((x) => x.id === msgId); if (!m) return;
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
  const entry = outbox.get(msgId); if (!entry) return;
  if (entry.serverAcked) { outbox.delete(msgId); persistOutbox(); return; }
  const contact = state.contacts.get(entry.to);
  if (!contact) { outbox.delete(msgId); persistOutbox(); return; }
  if (!contact.publicKey) {
    if (!pendingNoKey.has(contact.id)) pendingNoKey.set(contact.id, []);
    const list = pendingNoKey.get(contact.id);
    if (!list.some((x) => x.msgId === msgId)) { list.push({ msgId, payload: entry.payload }); persistPendingNoKey(); }
    outbox.delete(msgId); persistOutbox(); return;
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
  } catch (e) { etherLog("error", "[crypto] ошибка шифрования:", String(e)); markMessageAck(entry.to, msgId, "failed"); }
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
  const list = pendingNoKey.get(contactId); if (!list || list.length === 0) return;
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

// --- sendAckBatch с защитой от лавины ---
const _recentAckSent = new Map();
function sendAckBatch(contactId, originalMsgIds, ackState) {
  if (!Array.isArray(originalMsgIds) || originalMsgIds.length === 0) return;
  const key = contactId + ":" + ackState + ":" + originalMsgIds.slice(0, 3).join(",");
  const now = Date.now();
  const last = _recentAckSent.get(key);
  if (last && now - last < ACK_DEDUP_WINDOW_MS) {
    return;
  }
  _recentAckSent.set(key, now);
  if (_recentAckSent.size > 200) {
    const first = _recentAckSent.keys().next().value;
    _recentAckSent.delete(first);
  }

  const link = mesh.get(contactId);
  const actionId = crypto.randomUUID();
  const payload = { kind: "ack-batch", ids: originalMsgIds.slice(), state: ackState };
  if (link && link.status === "connected" && link.send(payload)) return;
  const c = state.contacts.get(contactId); if (!c) return;
  addToOutbox(actionId, contactId, payload);
  flushOutboxItem(actionId);
}

function markMessageAck(contactId, msgId, ack) {
  const c = state.contacts.get(contactId); if (!c) return;
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
    const t = $("#signaling-banner-text"); if (t) t.textContent = "Нет связи с сигнальным сервером — переподключаемся…";
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
  etherLog("info", "[signaling] connecting to " + url);
  signaling = new SignalingClient(url, Store.myId, { name: Store.name, visible: Store.discoverable, publicKey: Store.myPublicKeyJwk });
  signalingCleanup = wireSignalingEvents(signaling);
  signaling.start();
  renderSignalingBanner();
}
function wireSignalingEvents(sig) {
  const on = (type, fn) => {
    const wrapped = (ev) => {
      try { fn(ev); }
      catch (e) { etherLog("error", "[signaling:" + type + "]", String(e && e.stack || e)); }
    };
    sig.addEventListener(type, wrapped);
    return { type, wrapped };
  };
  const subs = [];

  subs.push(on("connected", () => {
    updateSignalingStatusUI("online", "Подключено");
    renderSignalingBanner();
    for (const [id, link] of mesh.links) {
      if (link.status === "disconnected" && link._closed !== true) {
        etherLog("info", "[reconnect] dropping dead link to " + String(id).slice(0, 10) + "…");
        mesh.remove(id);
      }
    }
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
  subs.push(on("push-subscribed", () => { etherLog("info", "[push] server confirmed subscription"); }));
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
    etherLog("info", "[signal] from " + String(from).slice(0, 10) + "…", "t=" + packet.t);

    if (packet.t === "call-invite") {
      if (isDuplicateSignal(from, packet)) return;
      etherLog("info", "[call] incoming invite from " + String(from).slice(0, 10) + "…");
      ensureContactEntry(from, packet.n);
      if (state.callId !== from) {
        openCallScreen(from, "ringing");
        // iOS: пробуем разбудить аудио-контекст немедленно, до playRingtone().
        try { ensureAudioCtx(); } catch (e) {}
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
        const p = $("#call-phase"); if (p) p.textContent = "Гудки…";
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
    // Для offer/answer фильтр дубликатов НЕ применяем: SDP-машина сама
    // отбросит невалидные повторы через setRemoteDescription.
    if (packet.t === "offer") {
      etherLog("info", "[offer] processing — from=" + String(from).slice(0, 10) + "…");
      const existing = mesh.get(from);
      if (existing && existing.role === "answerer" && existing.status === "connected") {
        etherLog("info", "[offer] ignoring, already connected as answerer");
        return;
      }
      if (existing) {
        etherLog("warn", "[offer] removing existing link before creating new one");
        mesh.remove(from);
      }
      ensureContactEntry(from, packet.n);
      etherLog("info", "[offer] creating incoming link");
      const link = mesh.createIncomingLink(from);
      try {
        etherLog("info", "[offer] calling acceptOfferAndCreateAnswer");
        const answer = await link.acceptOfferAndCreateAnswer(packet);
        if (!answer) {
          etherLog("warn", "[offer] acceptOfferAndCreateAnswer returned null");
          return;
        }
        etherLog("info", "[offer] answer created, sending back");
        const sent = sig.signal(from, answer);
        etherLog("info", "[offer] answer sent, result=" + sent);
      } catch (e) {
        etherLog("error", "[offer] answer FAILED:", String(e && e.message || e));
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
          etherLog("error", "[webrtc] acceptAnswer failed:", String(e));
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
    if (sender && sender.blocked) {
      if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
      return;
    }
    if (seenDeliverIds.has(msgId)) {
      if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
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
    } catch (e) { etherLog("error", "[crypto] decrypt failed:", String(e)); return; }

    applyIncomingPayload(from, msgId, payload, true, kind);

    if (kind === "chat") {
      sendAckBatch(from, [msgId], "delivered");
    }
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
    if (isOpen) { renderChatThread(); playMessageSound(); vibrate([80, 40, 80]); }
    else {
      toast(`${c.name}: ${truncate(payload.text, 40)}`);
      if (!c.muted) showNotification(c.name || "Эфир", truncate(payload.text, 80), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message" });
      playMessageSound();
      vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    if (isOpen) sendAckBatch(from, [payload.id], "read");
    updateAppBadge();
  } else if (kind === "edit") {
    const c = ensureContactEntry(from, null);
    const m = c.messages.find((x) => x.id === payload.id);
    if (m) { m.text = payload.text; m.edited = true; m.ts = payload.ts || m.ts; c.lastActivity = Date.now(); persistContacts();
      if (state.chatId === from) renderChatThread(); if (state.tab === "chats") renderChatsList(); }
  } else if (kind === "delete") {
    const c = ensureContactEntry(from, null);
    const before = c.messages.length;
    c.messages = c.messages.filter((x) => x.id !== payload.id);
    if (c.messages.length !== before) { persistContacts();
      if (state.chatId === from) renderChatThread(); if (state.tab === "chats") renderChatsList(); }
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
  autoConnectTimers.set(id, setTimeout(() => { autoConnectTimers.delete(id); attemptConnect(id); }, 4000));
}
async function attemptConnect(id) {
  const tag = String(id).slice(0, 10) + "…";
  if (!signaling || !signaling.connected) return;
  if (!onlineSet.has(id)) return;

  const iShouldOffer = Store.myId < id;
  if (!iShouldOffer) {
    etherLog("info", "[connect] " + tag, "not my turn — waiting for peer's offer");
    return;
  }

  if (_connectInFlight.has(id)) {
    etherLog("info", "[connect] " + tag, "already in flight — skipping");
    return;
  }
  _connectInFlight.add(id);

  try {
    const existing = mesh.get(id);
    if (existing) {
      const age = Date.now() - (existing._createdAt || 0);
      if (existing.status === "connected" || existing.status === "in-call") return;
      if (existing.status === "connecting" && age < CONNECT_STUCK_MS) {
        etherLog("info", "[connect] " + tag, "waiting — link connecting, age=" + Math.round(age / 1000) + "s");
        return;
      }
      etherLog("warn", "[connect] " + tag, "resetting stuck link (age=" + Math.round(age / 1000) + "s, status=" + existing.status + ")");
      mesh.remove(id);
    }

    etherLog("info", "[connect] " + tag, "creating offer");
    const link = mesh.createOutgoingLink(id);
    try {
      const packet = await link.createInitialOffer("");
      if (!packet) return;
      signaling.signal(id, packet);
      etherLog("info", "[connect] " + tag, "offer sent");
      watchConnectionTimeout(id);
    } catch (e) {
      etherLog("error", "[connect] " + tag, "offer failed:", String(e));
      mesh.remove(id);
      const c = state.contacts.get(id); if (c) c.status = "disconnected";
      if (state.chatId === id) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }
  } finally {
    _connectInFlight.delete(id);
  }
}
function watchConnectionTimeout(id) {
  setTimeout(() => {
    const link = mesh.get(id);
    if (!link || link.status === "connected" || link.status === "in-call" || link.status === "disconnected") return;
    etherLog("warn", "[connect] " + String(id).slice(0, 10) + "…", "connection timed out, resetting");
    mesh.remove(id);
    const c = state.contacts.get(id);
    if (c) {
      c.status = "disconnected";
      if (state.chatId === id) renderChatThread();
      if (state.tab === "chats") renderChatsList();
      if (c.managed && c.online) scheduleAutoConnect(id);
    }
  }, WATCH_CONNECT_TIMEOUT_MS);
}

// =====================================================================
// Онлайн-список
// =====================================================================
function renderOnlineRosterList() {
  const wrap = $("#online-roster-list"), empty = $("#online-roster-empty");
  if (!wrap) return;
  wrap.innerHTML = "";
  const rows = Array.from(onlineRoster.entries()).filter(([id, u]) => id !== Store.myId && u.visible !== false && !state.contacts.has(id));
  if (rows.length === 0) { if (empty) empty.classList.remove("hidden"); return; }
  if (empty) empty.classList.add("hidden");
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
        messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false,
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
  if (copyCode) copyCode.addEventListener("click", () => { const el = $("#invite-code-out"); if (el) copyText(el.textContent, "Код скопирован"); });
  const copyLink = $("#copy-link-btn");
  if (copyLink) copyLink.addEventListener("click", () => { const el = $("#invite-link-out"); if (el) copyText(el.textContent, "Ссылка скопирована"); });
  const share = $("#share-link-btn");
  if (share) share.addEventListener("click", async () => {
    const el = $("#invite-link-out"); if (!el) return;
    const url = el.textContent;
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
      if (!link) { toast("Соединение потеряно — начните заново"); resetConnectScreen(); return; }
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
  if (answerCopy) answerCopy.addEventListener("click", () => { const el = $("#answer-out-code"); if (el) copyText(el.textContent, "Код скопирован"); });
}
function resetConnectScreen() {
  state.pendingOutgoing = null;
  const ii = $("#invite-idle"); if (ii) ii.classList.remove("hidden");
  const ia = $("#invite-active"); if (ia) ia.classList.add("hidden");
  const ac = $("#answer-code-in"); if (ac) ac.value = "";
  const pc = $("#paste-code-in"); if (pc) pc.value = "";
  const ib = $("#incoming-banner"); if (ib) ib.classList.add("hidden");
}
async function createInvite() {
  const id = crypto.randomUUID();
  const link = mesh.createOutgoingLink(id);
  const packet = await link.createInitialOffer("");
  const code = await SignalingCodec.encode(packet);
  const shareLink = SignalingCodec.buildShareLink(code);
  state.pendingOutgoing = { id, code, shareLink };
  state.contacts.set(id, { id, name: "Приглашение…", raw: "", managed: false, online: false, status: "awaiting-answer", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false });
  const ii = $("#invite-idle"); if (ii) ii.classList.add("hidden");
  const ia = $("#invite-active"); if (ia) ia.classList.remove("hidden");
  const co = $("#invite-code-out"); if (co) co.textContent = code;
  const lo = $("#invite-link-out"); if (lo) lo.textContent = shareLink;
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
    const ms = $("#manual-section"); if (ms) ms.classList.remove("hidden");
    const tm = $("#toggle-manual-btn"); if (tm) tm.textContent = "Скрыть ручное подключение ‹";
    const ib = $("#incoming-banner"); if (ib) ib.classList.remove("hidden");
    const ibt = $("#incoming-banner-text"); if (ibt) ibt.textContent = `Приглашение от «${packet.n || "без имени"}» принято`;
    const aoc = $("#answer-out-code"); if (aoc) aoc.textContent = answerCode;
    const aow = $("#answer-out-wrap"); if (aow) aow.classList.remove("hidden");
    const pcw = $("#paste-code-wrap"); if (pcw) pcw.classList.add("hidden");
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
    btn.addEventListener("click", () => { const id = btn.dataset.closeSheet; if (id) { const el = $("#" + id); if (el) el.classList.add("hidden"); } });
  });
}
function openMessageSheet(msgId, contactId) {
  state.activeMessageContext = { msgId, contactId };
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  const bar = $("#reaction-bar");
  if (bar) {
    bar.innerHTML = "";
    for (const emoji of REACTION_EMOJIS) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "reaction-emoji"; b.textContent = emoji;
      b.addEventListener("click", () => { const ms = $("#message-sheet"); if (ms) ms.classList.add("hidden"); toggleReaction(contactId, msgId, emoji); });
      bar.appendChild(b);
    }
  }
  const isOwn = m.from === "me";
  const body = $("#message-sheet-body"); if (!body) return;
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
      const ms = $("#message-sheet"); if (ms) ms.classList.add("hidden");
      handleMessageAction(action, msgId, contactId);
    });
  });
  const ms = $("#message-sheet"); if (ms) ms.classList.remove("hidden");
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
function cancelEditing() { state.editingMessageId = null; const b = $("#edit-banner"); if (b) b.classList.add("hidden"); }
function showReplyBanner() {
  const b = $("#reply-banner"); if (!b) return;
  if (!state.replyTo) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden");
  const a = b.querySelector(".reply-banner-author"); if (a) a.textContent = state.replyTo.authorName;
  const t = b.querySelector(".reply-banner-text"); if (t) t.textContent = truncate(state.replyTo.text, 60);
}
function cancelReply() { state.replyTo = null; const b = $("#reply-banner"); if (b) b.classList.add("hidden"); }
function openForwardSheet(msgId, fromContactId) {
  const list = $("#forward-list"); if (!list) return;
  list.innerHTML = "";
  const contacts = Array.from(state.contacts.values()).filter((c) => c.managed);
  if (contacts.length === 0) list.innerHTML = `<p class="muted">Нет других контактов</p>`;
  for (const c of contacts) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "forward-row";
    btn.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div><span class="forward-name">${escapeHtml(c.name || "Без имени")}</span>`;
    btn.addEventListener("click", async () => { const fs = $("#forward-sheet"); if (fs) fs.classList.add("hidden"); await forwardMessage(msgId, fromContactId, c.id); });
    list.appendChild(btn);
  }
  const fs = $("#forward-sheet"); if (fs) fs.classList.remove("hidden");
}
function wireRenameSheet() {
  const btn = $("#rename-save-btn"); if (!btn) return;
  btn.addEventListener("click", () => {
    const id = state.activeContactContext;
    const ri = $("#rename-input"); if (!ri) return;
    const v = ri.value.trim();
    if (!id || !v) return;
    const c = state.contacts.get(id); if (!c) return;
    c.name = v.slice(0, 40);
    persistContacts();
    const rs = $("#rename-sheet"); if (rs) rs.classList.add("hidden");
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
  delete state.lastSeen[id]; persistLastSeen();
  delete state.drafts[id]; persistDrafts();
  if (state.activeContactContext === id) state.activeContactContext = null;
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
  const rec = state.currentCallRecord; if (!rec) return;
  rec.endedAt = Date.now();
  if (rec.answeredAt) {
    rec.durationMs = rec.endedAt - rec.answeredAt;
    rec.status = finalStatus === "failed" ? "failed" : "completed";
  } else {
    if (!finalStatus || finalStatus === "completed") finalStatus = rec.direction === "in" ? "missed" : "cancelled";
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
  if (state.callLog.length === 0) { if (empty) empty.classList.remove("hidden"); return; }
  if (empty) empty.classList.add("hidden");
  const items = state.callLog.slice().sort((a, b) => b.startedAt - a.startedAt);
  for (const rec of items) {
    const c = state.contacts.get(rec.contactId);
    const name = (c && c.name) || rec.contactName || "Без имени";
    const isFailed = rec.status !== "completed";
    const dirIcon = isFailed ? "missed" : (rec.direction === "in" ? "in" : "out");
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
  etherLog("info", "[call] beginCall to " + String(id).slice(0, 10) + "…");
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
  attemptConnect(id);
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
  try { ensureAudioCtx(); } catch (e) {}
  const muteBtn = $("#call-mute-btn");
  if (muteBtn) {
    muteBtn.classList.remove("active");
    const lbl = $("#call-mute-label");
    if (lbl) lbl.textContent = "Микрофон";
  }
  const c = state.contacts.get(id); if (!c) return;
  const cs = $("#call-screen"); if (cs) cs.classList.remove("hidden");
  const pn = $("#call-peer-name"); if (pn) pn.textContent = c.name || "Без имени";
  const pa = $("#call-peer-avatar"); if (pa) { pa.style.background = avatarGradient(c.name); pa.textContent = initials(c.name); }
  const cp = $("#call-phase"); if (cp) cp.textContent = phase === "calling" ? "Вызов…" : phase === "ringing" ? "Входящий вызов" : "На связи";
  const incoming = phase === "ringing";
  const ci = $("#call-controls-incoming"); if (ci) ci.classList.toggle("hidden", !incoming);
  const ca = $("#call-controls-active"); if (ca) ca.classList.toggle("hidden", incoming);
  clearInterval(callTimerInterval);
  if (phase === "active") startCallTimer();

  // Пока «звонит» — держим таймер «никто не ответил». Если через
  // INCOMING_CALL_TIMEOUT_MS никто ничего не сделал — считаем пропущенным.
  if (phase === "ringing") {
    clearPendingCall();
    pendingCall.contactId = id;
    pendingCall.timer = setTimeout(() => {
      if (state.callId !== id) return;
      if (state.callPhase !== "ringing") return;
      etherLog("info", "[call] ringing timeout — missed");
      try { const l = mesh.get(id); if (l) l.endCall(); } catch (e) {}
      if (signaling && signaling.connected) {
        try { signaling.signal(id, { t: "call-ended" }); } catch (e) {}
      }
      toast("Пропущенный звонок");
      closeCallScreen("missed");
    }, INCOMING_CALL_TIMEOUT_MS);
  }

  if (!state.currentCallRecord) {
    if (phase === "calling") startCallRecord(id, "out");
    else if (phase === "ringing") startCallRecord(id, "in");
  }
}
function setCallPhaseActive() {
  state.callPhase = "active";
  clearPendingCall();
  const ci = $("#call-controls-incoming"); if (ci) ci.classList.add("hidden");
  const ca = $("#call-controls-active"); if (ca) ca.classList.remove("hidden");
  startCallTimer();
  updateCallRecordStatus("active");
  if (state.callId && pendingRemoteStreams.has(state.callId)) {
    attachRemoteAudio(state.callId, pendingRemoteStreams.get(state.callId));
    pendingRemoteStreams.delete(state.callId);
  }
}
function attachRemoteAudio(id, stream) {
  if (!stream) { etherLog("warn", "[audio] attachRemoteAudio: пустой stream, id=" + String(id).slice(0, 10) + "…"); return; }
  let audioEl = document.getElementById("remote-audio-" + id);
  if (!audioEl) {
    audioEl = document.createElement("audio");
    audioEl.id = "remote-audio-" + id;
    audioEl.autoplay = true;
    audioEl.setAttribute("playsinline", "");
    audioEl.hidden = true;
    document.body.appendChild(audioEl);
  }
  audioEl.srcObject = stream;
  const p = audioEl.play();
  if (p && typeof p.then === "function") {
    p.then(() => {
      etherLog("info", "[audio] attachRemoteAudio: play() ok, id=" + String(id).slice(0, 10) + "…, tracks=" + (stream.getAudioTracks ? stream.getAudioTracks().length : "?"));
    }).catch((e) => {
      etherLog("warn", "[audio] play() отклонён:", String(e));
      const resume = () => { try { audioEl.play().catch(() => {}); } catch (e2) {} };
      document.addEventListener("touchstart", resume, { once: true });
      document.addEventListener("click", resume, { once: true });
    });
  } else {
    etherLog("info", "[audio] attachRemoteAudio: play() без Promise, id=" + String(id).slice(0, 10) + "…");
  }
}
function startCallTimer() {
  const started = Date.now();
  clearInterval(callTimerInterval);
  state._callDeadSeconds = 0;
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    const cp = $("#call-phase"); if (cp) cp.textContent = `${mm}:${ss}`;

    // Health-check: если звонок активен, а P2P-линк мёртв дольше
    // CALL_DEAD_LINK_TIMEOUT_MS — принудительно закрываем экран.
    const cid = state.callId;
    if (!cid) { state._callDeadSeconds = 0; return; }
    const link = mesh.get(cid);
    const alive = link && (link.status === "connected" || link.status === "in-call");
    if (alive) { state._callDeadSeconds = 0; return; }
    state._callDeadSeconds = (state._callDeadSeconds || 0) + 1;
    if (state._callDeadSeconds * 1000 >= CALL_DEAD_LINK_TIMEOUT_MS) {
      etherLog("warn", "[call] dead P2P for " + state._callDeadSeconds + "s — closing call UI");
      closeCallScreen("completed");
    }
  }, 1000);
}
function closeCallScreen(reason) {
  clearInterval(callTimerInterval); callTimerInterval = null;
  state._callDeadSeconds = 0;
  state._callAcceptInFlight = false;
  clearPendingCall();
  stopRingtone();
  endCallRecord(reason);
  const cs = $("#call-screen"); if (cs) cs.classList.add("hidden");
  const cm = $("#call-mute-btn"); if (cm) cm.classList.remove("active");
  const lbl = $("#call-mute-label"); if (lbl) lbl.textContent = "Микрофон";
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
    const lbl = $("#call-mute-label");
    if (lbl) lbl.textContent = muted ? "Микрофон выкл" : "Микрофон";
  });
  const accept = $("#call-accept-btn");
  if (accept) accept.addEventListener("click", async () => {
    if (state._callAcceptInFlight) return;
    state._callAcceptInFlight = true;
    const cid = state.callId;
    try {
      stopRingtone();
      if (signaling && signaling.connected && cid) signaling.signal(cid, { t: "call-accepted" });
      const c = state.contacts.get(cid);
      if (!c) { closeCallScreen("failed"); return; }

      // Если P2P уже установлен — принимаем напрямую.
      const link = mesh.get(cid);
      if (link && isReachable(c)) {
        try {
          await link.answerCall();
          setCallPhaseActive();
        } catch (e) {
          // НЕ отклоняем звонок из-за локальной ошибки (например, нет
          // разрешения на микрофон) — оставляем экран открытым, чтобы
          // пользователь мог повторить.
          etherLog("error", "[call] answerCall failed:", String(e));
          toast("Не удалось включить микрофон. Разрешите доступ и попробуйте ещё раз.");
        }
        return;
      }

      // Иначе — ждём, пока P2P установится, и потом отвечаем.
      toast("Соединяемся — говорите, как только услышите");
      clearPendingCall();
      pendingCall.contactId = cid;
      attemptConnect(cid);
      pendingCall.timer = setTimeout(() => {
        if (state.callId !== cid) return;
        const l2 = mesh.get(cid);
        if (l2 && isReachable(state.contacts.get(cid))) {
          l2.answerCall().then(setCallPhaseActive).catch((e) => {
            etherLog("error", "[call] deferred answerCall failed:", String(e));
          });
        } else {
          toast("Не удалось установить связь");
          if (signaling && signaling.connected) signaling.signal(cid, { t: "call-ended" });
          closeCallScreen("failed");
        }
      }, PENDING_CALL_TIMEOUT_MS);
    } catch (e) {
      etherLog("error", "[call] accept handler failed:", String(e));
      toast("Ошибка при приёме звонка");
    } finally {
      state._callAcceptInFlight = false;
    }
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
    const bar = $("#chat-search-bar"); if (!bar) return;
    bar.classList.toggle("hidden");
    if (!bar.classList.contains("hidden")) setTimeout(() => { const i = $("#chat-search-input"); if (i) i.focus(); }, 50);
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
  const el = $("#chat-search-counter"); if (!el) return;
  if (!q) { el.textContent = ""; return; }
  const n = c.messages.filter((m) => (m.text || "").toLowerCase().includes(q)).length;
  el.textContent = n > 0 ? `${n} найдено` : "нет совпадений";
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
    const el = $("#settings-signaling-url");
    if (el) Store.signalingUrl = el.value.trim();
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
    const st = $("#set-pin-title"); if (st) st.textContent = Store.pinHash ? "Введите текущий пин-код" : "Новый пин-код (4-8 цифр)";
    const si = $("#set-pin-input"); if (si) si.value = "";
    const ss = $("#set-pin-sheet"); if (ss) ss.classList.remove("hidden");
    setTimeout(() => { const i = $("#set-pin-input"); if (i) i.focus(); }, 50);
  });
  const pinSave = $("#set-pin-save-btn");
  if (pinSave) pinSave.addEventListener("click", async () => {
    const inp = $("#set-pin-input"); if (!inp) return;
    const v = inp.value.trim();
    if (!v || v.length < 4) { toast("Минимум 4 цифры"); return; }
    if (!/^\d+$/.test(v)) { toast("Только цифры"); return; }
    if ($("#settings-pinlock").checked) {
      if (Store.pinHash) {
        const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
        if (h !== Store.pinHash) { toast("Неверный пин-код"); return; }
        const st = $("#set-pin-title"); if (st) st.textContent = "Новый пин-код";
        inp.value = "";
        return;
      }
      Store.pinSalt = randomSaltHex(16);
      Store.pinHash = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      Store.pinEnabled = true;
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
      toast("Пин-код включён");
    } else {
      const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      if (h !== Store.pinHash) { toast("Неверный пин-код"); return; }
      Store.pinEnabled = false;
      Store.pinHash = "";
      Store.pinSalt = "";
      const pl = $("#settings-pinlock"); if (pl) pl.checked = false;
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
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
// Отладка
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
  if (diag) diag.addEventListener("click", () => { renderDiagnostics(); const el = $("#diagnostics-sheet"); if (el) el.classList.remove("hidden"); });
  const diagClose = $("#diagnostics-close");
  if (diagClose) diagClose.addEventListener("click", () => { const el = $("#diagnostics-sheet"); if (el) el.classList.add("hidden"); });
  const diagR = $("#diagnostics-refresh-btn");
  if (diagR) diagR.addEventListener("click", renderDiagnostics);
  const diagC = $("#diagnostics-copy-btn");
  if (diagC) diagC.addEventListener("click", () => copyText(buildDiagnosticsText(), "Диагностика скопирована"));

  const webrtcBtn = $("#webrtc-debug-btn");
  if (webrtcBtn) webrtcBtn.addEventListener("click", () => { renderWebRtcSheet(); const el = $("#webrtc-sheet"); if (el) el.classList.remove("hidden"); });
  const webrtcClose = $("#webrtc-close");
  if (webrtcClose) webrtcClose.addEventListener("click", () => { const el = $("#webrtc-sheet"); if (el) el.classList.add("hidden"); });
  const webrtcRefresh = $("#webrtc-refresh-btn");
  if (webrtcRefresh) webrtcRefresh.addEventListener("click", renderWebRtcSheet);
  const webrtcCopy = $("#webrtc-copy-btn");
  if (webrtcCopy) webrtcCopy.addEventListener("click", () => copyText(buildWebRtcText(), "Скопировано"));

  const logsBtn = $("#debug-logs-btn");
  if (logsBtn) logsBtn.addEventListener("click", () => { renderLogsSheet(); const el = $("#logs-sheet"); if (el) el.classList.remove("hidden"); });
  const logsClose = $("#logs-close");
  if (logsClose) logsClose.addEventListener("click", () => { const el = $("#logs-sheet"); if (el) el.classList.add("hidden"); });
  const logsCopy = $("#logs-copy-btn");
  if (logsCopy) logsCopy.addEventListener("click", () => copyText(buildLogsText(), "Журнал скопирован"));
  const logsClear = $("#logs-clear-btn");
  if (logsClear) logsClear.addEventListener("click", () => { window.__etherDiag = []; renderLogsSheet(); toast("Журнал очищен"); });

  const storageBtn = $("#debug-storage-btn");
  if (storageBtn) storageBtn.addEventListener("click", () => { renderStorageSheet(); const el = $("#storage-sheet"); if (el) el.classList.remove("hidden"); });
  const storageClose = $("#storage-close");
  if (storageClose) storageClose.addEventListener("click", () => { const el = $("#storage-sheet"); if (el) el.classList.add("hidden"); });

  const expBackup = $("#export-backup-btn");
  if (expBackup) expBackup.addEventListener("click", exportBackup);
  const impBackup = $("#import-backup-btn");
  if (impBackup) impBackup.addEventListener("click", () => { const el = $("#import-backup-input"); if (el) el.click(); });
  const impInput = $("#import-backup-input");
  if (impInput) impInput.addEventListener("change", importBackup);

  const reset = $("#reset-all-btn");
  if (reset) reset.addEventListener("click", () => {
    if (!confirm("Разорвать все соединения и удалить контакты? История звонков тоже будет удалена.")) return;
    for (const id of Array.from(state.contacts.keys())) mesh.remove(id);
    for (const t of autoConnectTimers.values()) clearTimeout(t);
    autoConnectTimers.clear();
    onlineSet.clear(); outbox.clear(); pendingNoKey.clear(); seenDeliverIds.clear();
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
function renderLogsSheet() { const el = $("#logs-content"); if (el) el.textContent = buildLogsText(); }
function buildLogsText() {
  const log = window.__etherDiag || [];
  const lines = [];
  for (const entry of log.slice(-300)) {
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
  const listHtml = items.map((it) => `<div style="display:flex;justify-content:space-between;gap:8px;"><span>${escapeHtml(it.key)}</span><span class="muted">${(it.size / 1024).toFixed(1)} КБ</span></div>`).join("");
  const baseHtml = `<div><b>localStorage:</b> ${(totalBytes / 1024).toFixed(1)} КБ, ${items.length} ключей</div>`
    + `<hr style="border:none;border-top:1px solid var(--hairline);margin:10px 0;">`
    + listHtml
    + buildEnvText();
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((est) => {
      const usage = Number.isFinite(est && est.usage) ? (est.usage / 1024 / 1024).toFixed(2) + " МБ" : "?";
      const quota = Number.isFinite(est && est.quota) ? (est.quota / 1024 / 1024).toFixed(0) + " МБ" : "?";
      el.innerHTML = `<div><b>Storage API:</b> использовано ${usage} из ${quota}</div>` + baseHtml;
    }).catch(() => { el.innerHTML = baseHtml; });
  } else {
    el.innerHTML = baseHtml;
  }
}
function buildEnvText() {
  const lines = [];
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  lines.push(`<hr style="border:none;border-top:1px solid var(--hairline);margin:10px 0;">`);
  lines.push(`<div><b>User agent:</b> <span class="fine muted">${escapeHtml(navigator.userAgent)}</span></div>`);
  lines.push(`<div><b>Платформа:</b> ${escapeHtml(navigator.platform || "—")}</div>`);
  lines.push(`<div><b>Язык:</b> ${escapeHtml(navigator.language || "—")}</div>`);
  lines.push(`<div><b>Online:</b> ${navigator.onLine ? "да" : "нет"}</div>`);
  lines.push(`<div><b>PWA standalone:</b> ${isStandalone() ? "да" : "нет"}</div>`);
  lines.push(`<div><b>iOS:</b> ${isIOS() ? "да" : "нет"}</div>`);
  lines.push(`<div><b>Vibration API:</b> ${navigator.vibrate ? "есть" : "НЕТ (iOS не поддерживает)"}</div>`);
  if (conn) {
    lines.push(`<div><b>Сеть:</b> ${conn.effectiveType || "?"}, downlink ${conn.downlink || "?"} Мбит/с, RTT ${conn.rtt || "?"} мс</div>`);
  }
  return lines.join("");
}
function buildDiagnosticsText() {
  const lines = [];
  lines.push("=== Эфир — диагностика ===");
  lines.push("Время: " + new Date().toLocaleString("ru-RU"));
  lines.push("Мой id: " + (Store.myId ? Store.myId.slice(0, 16) + "…" : "(не задан)"));
  lines.push("Сигнальный сервер: " + effectiveSignalingUrl());
  lines.push("Статус: " + (signaling ? (signaling.connected ? "подключён" : "не подключён") : "не инициализирован"));
  lines.push("Онлайн: " + onlineSet.size + " (roster: " + onlineRoster.size + ")");
  lines.push("outbox: " + outbox.size + ", pendingNoKey: " + pendingNoKey.size);
  lines.push("");
  lines.push("--- Push ---");
  lines.push("PWA: " + (isStandalone() ? "да" : "нет"));
  lines.push("Notification API: " + (("Notification" in window) ? "есть" : "нет"));
  lines.push("Разрешение: " + (("Notification" in window) ? Notification.permission : "—"));
  lines.push("PushManager: " + (("PushManager" in window) ? "есть" : "нет"));
  lines.push("VAPID-ключ: " + (Store.vapidPublicKey ? Store.vapidPublicKey.slice(0, 16) + "…" : "(не получен)"));
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
  const turnCount = (typeof ICE_SERVERS !== "undefined") ? ICE_SERVERS.filter((s) => (s.urls || "").toString().startsWith("turn")).length : 0;
  const summary = $("#diagnostics-summary");
  if (summary) summary.innerHTML = `
    <div><b>Мой id:</b> ${idShort}</div>
    <div><b>Сервер:</b> ${escapeHtml(effectiveSignalingUrl())}</div>
    <div><b>Сигналинг:</b> ${signaling ? (signaling.connected ? "✅ подключён" : "⚠️ не подключён") : "⚠️"}</div>
    <div><b>Онлайн:</b> ${onlineSet.size}</div>
    <div><b>Контактов:</b> ${state.contacts.size}</div>
    <div><b>P2P links:</b> ${mesh ? mesh.links.size : 0}</div>
    <div><b>В очереди:</b> ${outbox.size}</div>
    <div><b>TURN-серверов:</b> ${turnCount} ${turnCount > 0 ? "✅" : "⚠️"}</div>`;
  const log = $("#diagnostics-log"); if (log) log.textContent = buildDiagnosticsText();
}
function renderWebRtcSheet() { const el = $("#webrtc-content"); if (el) el.textContent = buildWebRtcText(); }
function buildWebRtcText() {
  const lines = [];
  lines.push("=== WebRTC соединения ===");
  if (!mesh || mesh.links.size === 0) {
    lines.push("(нет активных PeerLink)");
    return lines.join("\n");
  }
  for (const link of mesh.links.values()) {
    const d = link.getDiagnostics();
    lines.push("");
    lines.push("--- " + String(d.id).slice(0, 14) + "… ---");
    lines.push("role: " + d.role);
    lines.push("status: " + d.status);
    lines.push("pc.connectionState: " + d.pcState);
    lines.push("iceConnectionState: " + d.iceState);
    lines.push("iceGatheringState: " + d.iceGather);
    lines.push("signalingState: " + d.signalingState);
    lines.push("dataChannel: " + d.dcState);
    lines.push("candidates (" + d.candidates.length + "):");
    for (const c of d.candidates) {
      lines.push(`  • ${c.type} ${c.protocol} ${c.address}:${c.port}${c.tcpType ? " tcpType=" + c.tcpType : ""}`);
    }
    if (d.errors.length > 0) {
      lines.push("ICE errors (" + d.errors.length + "):");
      for (const e of d.errors.slice(0, 10)) {
        lines.push(`  ! code=${e.errorCode} ${e.errorText || ""} url=${e.url || ""}`);
      }
    }
  }
  return lines.join("\n");
}

// =====================================================================
// Экспорт/импорт
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
// Mesh события
// =====================================================================
function wireMeshEvents() {
  mesh.addEventListener("link-status", (ev) => {
    try {
      const { id, status } = ev.detail;
      const c = state.contacts.get(id); if (!c) return;
      const wasConnected = c.status === "connected" || c.status === "in-call";
      c.status = status;
      etherLog("info", "[link] " + String(id).slice(0, 10) + "…", "status=" + status);
      if (status === "connected" && !wasConnected) {
        const link = mesh.get(id);
        if (link && link.remoteName) c.name = link.remoteName;
        if (c.managed) persistContacts();
        toast(`«${c.name}» на связи`);
        clearAutoConnectTimer(id);
        if (state.pendingOutgoing && state.pendingOutgoing.id === id) resetConnectScreen();
        if (pendingCall.contactId === id && link && state.callId === id) {
          clearPendingCall();
          link.startCall().catch(() => { toast("Нет доступа к микрофону"); closeCallScreen("failed"); });
        }
        if (state.callId === id && state.callPhase !== "active" && link) {
          link.answerCall().then(setCallPhaseActive).catch((e) => {
            etherLog("error", "[call] deferred answerCall failed:", String(e));
          });
        }
        flushOutbox();
      }
      if (status === "disconnected") {
        sendTypingStop(id);
        // Не пересоздаём P2P сразу — даём PeerLink попытку restartIce().
        if (c.managed && c.online) {
          setTimeout(() => {
            const stillGone = !mesh.get(id) || mesh.get(id).status === "disconnected";
            if (stillGone && state.contacts.get(id)) scheduleAutoConnect(id);
          }, 10000);
        }
      }
      if (state.chatId === id) renderChatThread();
      if (state.contactCardId === id) renderContactCard();
      if (state.tab === "chats" && !state.chatId) renderChatsList();
    } catch (e) {
      etherLog("error", "[link-status] handler failed:", String(e && e.stack || e));
    }
  });
  mesh.addEventListener("message", (ev) => {
    try {
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
    } catch (e) {
      etherLog("error", "[message] handler failed:", String(e && e.stack || e));
    }
  });
  mesh.addEventListener("remote-track", (ev) => {
    try {
      const { id, stream } = ev.detail;
      etherLog("info", "[audio] remote-track id=" + String(id).slice(0, 10) + "…, callId=" + (state.callId ? String(state.callId).slice(0, 10) + "…" : "—") + ", phase=" + state.callPhase);
      if (state.callId === id && state.callPhase !== "active") { pendingRemoteStreams.set(id, stream); return; }
      attachRemoteAudio(id, stream);
    } catch (e) {
      etherLog("error", "[remote-track] handler failed:", String(e && e.stack || e));
    }
  });
}

// =====================================================================
// Форма чата
// =====================================================================
function wireChatScreen() {
  if (__chatWired) return;
  __chatWired = true;
  const form = $("#chat-form");
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input"); if (!input) return;
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
  if (moreBtn) moreBtn.addEventListener("click", () => { const id = state.chatId; if (id) openContactCard(id); });
  const peerTap = $("#chat-peer-tap");
  if (peerTap) peerTap.addEventListener("click", () => { const id = state.chatId; if (id) openContactCard(id); });
  const editCancel = $("#edit-cancel-btn");
  if (editCancel) editCancel.addEventListener("click", () => {
    const id = state.chatId;
    cancelEditing();
    const inp = $("#chat-input"); if (!inp) return;
    if (id && state.drafts[id]) inp.value = state.drafts[id]; else inp.value = "";
  });
  const replyCancel = $("#reply-cancel-btn");
  if (replyCancel) replyCancel.addEventListener("click", () => cancelReply());
  const scrollBtn = $("#scroll-bottom-btn");
  if (scrollBtn) scrollBtn.addEventListener("click", () => {
    const wrap = $("#chat-messages"); if (wrap) wrap.scrollTo({ top: wrap.scrollHeight, behavior: "smooth" });
  });
  const wrap = $("#chat-messages");
  if (wrap) wrap.addEventListener("scroll", () => updateScrollBottomButton());
}

// =====================================================================
// Boot-recovery
// =====================================================================
function showBootRecovery() {
  const o = document.getElementById("onboarding"); if (o) o.classList.add("hidden");
  const a = document.getElementById("app-shell"); if (a) a.classList.add("hidden");
  const l = document.getElementById("lock-screen"); if (l) l.classList.add("hidden");
  const r = document.getElementById("boot-recovery"); if (r) r.classList.remove("hidden");
}
function bootDidNotRender() {
  const on = document.getElementById("onboarding");
  const ap = document.getElementById("app-shell");
  const lk = document.getElementById("lock-screen");
  const rc = document.getElementById("boot-recovery");
  if (!on || !ap || !lk || !rc) return false;
  return on.classList.contains("hidden") && ap.classList.contains("hidden")
      && lk.classList.contains("hidden") && rc.classList.contains("hidden");
}
const bootWatchdog = setTimeout(() => { if (bootDidNotRender()) showBootRecovery(); }, 10000);
window.addEventListener("error", () => { if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); } });
window.addEventListener("unhandledrejection", () => { if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); } });

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await restoreFromIDB().catch(() => {});
    initBoot();
    clearTimeout(bootWatchdog);
  } catch (e) { etherLog("error", "[boot]", String(e)); showBootRecovery(); }
});

const brReset = document.getElementById("boot-recovery-reset");
if (brReset) brReset.addEventListener("click", () => {
  localStorage.clear();
  if ("caches" in window) caches.keys().then((names) => names.forEach((n) => caches.delete(n)));
  if ("indexedDB" in window) try { indexedDB.deleteDatabase("ether-db"); } catch (e) {}
  location.reload();
});

function shutdownCallIfActive() {
  try {
    const cid = state.callId;
    if (!cid) return;
    if (signaling && signaling.connected) {
      try { signaling.signal(cid, { t: "call-ended" }); } catch (e) {}
    }
    try {
      const link = mesh && mesh.get(cid);
      if (link) link.endCall();
    } catch (e) {}
    try { closeCallScreen("completed"); } catch (e) {}
  } catch (e) {}
}
window.addEventListener("beforeunload", () => {
  try { saveCurrentDraft(); } catch (e) {}
  try { backupToIDB(); } catch (e) {}
  shutdownCallIfActive();
});
window.addEventListener("pagehide", () => {
  try { saveCurrentDraft(); } catch (e) {}
  try { backupToIDB(); } catch (e) {}
  shutdownCallIfActive();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    try { updateAppBadge(); } catch (e) {}
    try {
      if (globalAudioCtx && globalAudioCtx.state === "suspended") globalAudioCtx.resume().catch(() => {});
    } catch (e) {}
    if (state.chatId) { const c = state.contacts.get(state.chatId); if (c) markThreadRead(c); }
  }
});