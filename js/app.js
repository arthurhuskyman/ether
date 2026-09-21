"use strict";

const DEFAULT_SIGNALING_URL = "wss://ether-1-baqy.onrender.com";
const MAX_MESSAGE_LENGTH = 4000;
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 МБ — см. README: файлы идут только "вживую" через P2P, без офлайн-очереди
const FILE_CHUNK_SIZE = 48 * 1024; // кратно 3 — ровные base64-куски без паддинга внутри потока
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
// 110 эмодзи для реакций.
const REACTION_EMOJIS = [
  "👍","👎","❤️","🔥","😂","🤣","😊","😍","🥰","😘","😗","😙","😚","🙂","🤗","🤩",
  "😎","🥳","😏","😌","😔","😞","😟","😢","😭","😤","😠","😡","🤬","😱","😨","😰",
  "😥","😓","🤔","🤨","😐","😑","😶","🙄","😯","😦","😧","😮","😲","🥺","🤯","🤪",
  "😜","😝","😛","🤤","🤢","🤮","🤧","😷","🤒","🤕","🥵","🥶","😴","🤫","🤭","🧐",
  "🙏","👏","👌","✌️","🤞","🤟","🤘","👊","✊","💪","🤝","👋","🖐️","☝️","💯","✨",
  "⭐","🌟","⚡","💥","💫","🎉","🎊","🎁","🎈","🍀","🌸","🌹","🌺","🌻","☀️","🌙",
  "⛅","🌈","❄️","💧","🌊","🍕","🍔","🍟","🍩","🍪","☕","🍺","🍷","🍎"
];

const UNLOCK_ATTEMPTS_LIMIT = 5;
const P2P_FALLBACK_MS = 1500;
const ONBOARDING_HINT_SHOWN = "ether.hintShown";
const PIN_ITERATIONS = 120000;
const DEBUG_KEY = "ether.debugHidden";
const CONNECT_STUCK_MS = 30000;
const WATCH_CONNECT_TIMEOUT_MS = 20000;
const ACK_DEDUP_WINDOW_MS = 5000;
const CALL_DEAD_LINK_TIMEOUT_MS = 30000;
const INCOMING_CALL_TIMEOUT_MS = PENDING_CALL_TIMEOUT_MS - 2000; // должен истекать НЕ ПОЗЖЕ, чем звонящий сдастся — иначе у принимающего экран "входящий" висит, когда звонящий уже положил трубку
// Громкость удалённого потока по умолчанию — 33,33%.
const DEFAULT_CALL_VOLUME = 0.3333;

function effectiveSignalingUrl() {
  return (Store.signalingUrl || DEFAULT_SIGNALING_URL).trim();
}

// =====================================================================
// IndexedDB
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
  async function del(key) {
    try {
      const db = await open();
      return new Promise((res) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
        tx.onabort = () => res();
      });
    } catch (e) { return null; }
  }
  return { open, set, get, del };
})();

const CRITICAL_LS_KEYS = [
  "ether.name", "ether.identityRaw", "ether.myId",
  "ether.privKey", "ether.pubKey",
  "ether.pinHash", "ether.pinSalt", "ether.pinEnabled",
  "ether.contacts",
  "ether.outbox", "ether.pendingNoKey",
  "ether.theme", "ether.glassAlpha",
  "ether.notifications", "ether.sounds", "ether.ringtone", "ether.linkPreviews",
  "ether.vapidPublicKey", "ether.pushSubscription",
  "ether.callLog", "ether.lastSeen", "ether.drafts",
  "ether.callVolume", "ether.lang",
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
  get linkPreviewsEnabled() { return localStorage.getItem("ether.linkPreviews") !== "0"; },
  set linkPreviewsEnabled(v) { localStorage.setItem("ether.linkPreviews", v ? "1" : "0"); scheduleIDBBackup(); },
  get contactsJson() { return localStorage.getItem("ether.contacts") || "[]"; },
  set contactsJson(v) { localStorage.setItem("ether.contacts", v); scheduleIDBBackup(); },
  get outboxJson() { return localStorage.getItem("ether.outbox") || "[]"; },
  set outboxJson(v) { localStorage.setItem("ether.outbox", v); scheduleIDBBackup(); },
  get pendingNoKeyJson() { return localStorage.getItem("ether.pendingNoKey") || "{}"; },
  set pendingNoKeyJson(v) { localStorage.setItem("ether.pendingNoKey", v); scheduleIDBBackup(); },
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
  get ringtone() { return localStorage.getItem("ether.ringtone") || "ring-classic"; },
  set ringtone(v) { localStorage.setItem("ether.ringtone", v); scheduleIDBBackup(); },
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
  get glassAlpha() { const raw = parseFloat(localStorage.getItem("ether.glassAlpha") || "0.55"); if (!Number.isFinite(raw)) return 0.55; return Math.min(0.85, Math.max(0.18, raw)); },
  set glassAlpha(v) { if (!Number.isFinite(v)) return; localStorage.setItem("ether.glassAlpha", String(Math.min(0.85, Math.max(0.18, v)))); scheduleIDBBackup(); },
  get theme() { return localStorage.getItem("ether.theme") || "auto"; },
  set theme(v) { localStorage.setItem("ether.theme", v); scheduleIDBBackup(); },
  get callVolume() {
    const raw = parseFloat(localStorage.getItem("ether.callVolume") || String(DEFAULT_CALL_VOLUME));
    if (!Number.isFinite(raw)) return DEFAULT_CALL_VOLUME;
    return Math.min(1, Math.max(0, raw));
  },
  set callVolume(v) {
    if (!Number.isFinite(v)) return;
    localStorage.setItem("ether.callVolume", String(Math.min(1, Math.max(0, v))));
    scheduleIDBBackup();
  },
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
  _callUserAccepted: false,
  _callAcceptInFlight: false,
  _callMuteOnAnswer: false,
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
const recentSignalNonces = new Set();
const outbox = new Map();
const pendingNoKey = new Map();
const seenDeliverIds = new Set();
const _connectInFlight = new Set();

const pendingCall = { contactId: null, timer: null };
const pendingRemoteStreams = new Map();
let callTimerInterval = null;
let globalAudioCtx = null;
let ringtoneTimer = null;
let ringtoneAudioEl = null;

// Настоящие аудиофайлы вместо синтезированных на лету осцилляторов —
// на iPhone Web Audio-осцилляторы, запущенные из асинхронного события
// (а не прямо внутри обработчика клика), нередко просто не звучат:
// заблокированы политикой автовоспроизведения или переключателем
// "Звонок/Бесшумно". Обычные <audio>-элементы, один раз "разблокированные"
// внутри настоящего пользовательского жеста, гораздо надёжнее для звука,
// который должен запускаться позже, сам по себе.
const RINGTONES = {
  "ring-classic": "sounds/ring-classic.mp3",
  "ring-soft": "sounds/ring-soft.mp3",
  "ring-bell": "sounds/ring-bell.mp3",
};
const SOUND_FILES = {
  message: "sounds/msg-icq-style.mp3",
  dialing: "sounds/call-dialing.mp3",
  busy: "sounds/call-busy.mp3",
  noanswer: "sounds/call-noanswer.mp3",
};
const soundPool = new Map(); // ключ -> <audio>, создаются один раз и переиспользуются
let dialingAudioEl = null;

function getSoundEl(src, loop) {
  let el = soundPool.get(src);
  if (!el) {
    el = document.createElement("audio");
    el.src = src;
    el.preload = "auto";
    el.loop = !!loop;
    el.setAttribute("playsinline", "");
    document.body.appendChild(el);
    soundPool.set(src, el);
  }
  return el;
}

// Разблокировка звука на iOS: должна произойти строго внутри настоящего
// пользовательского жеста (клик/тап) — тогда все элементы из пула потом
// смогут запускаться сами, из любого асинхронного события (входящий
// звонок, сообщение), без нового жеста.
function unlockSoundPool() {
  for (const src of [...Object.values(RINGTONES), ...Object.values(SOUND_FILES)]) {
    const el = getSoundEl(src, false);
    if (el.dataset.unlocked) continue;
    const wasMuted = el.muted;
    el.muted = true;
    const p = el.play();
    if (p && p.catch) {
      p.then(() => { el.pause(); el.currentTime = 0; el.muted = wasMuted; el.dataset.unlocked = "1"; }).catch(() => { el.muted = wasMuted; });
    }
  }
}


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
// =====================================================================
// Превью ссылок
// =====================================================================
// Сервер видит саму ссылку (не текст сообщения) при первом запросе
// превью для неё — см. README. Кеш и на клиенте, и на сервере, поэтому
// повторный показ той же ссылки повторного запроса не делает.
function extractFirstUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/i);
  return m ? m[0] : null;
}
function signalingHttpBase() {
  let url = "";
  try { url = (Store.signalingUrl || "").trim(); } catch (e) {}
  if (!url) url = DEFAULT_SIGNALING_URL;
  return url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://").replace(/\/+$/, "");
}
const linkPreviewCache = new Map(); // url -> { status: "pending"|"done"|"none", data }
async function fetchLinkPreview(url) {
  const cached = linkPreviewCache.get(url);
  if (cached) return cached.status === "pending" ? null : cached;
  linkPreviewCache.set(url, { status: "pending", data: null });
  try {
    const base = signalingHttpBase();
    if (!base) throw new Error("no signaling server configured");
    const r = await fetch(base + "/link-preview?url=" + encodeURIComponent(url), { cache: "default" });
    if (r.status === 204) { linkPreviewCache.set(url, { status: "none", data: null }); return null; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    const entry = { status: "done", data };
    linkPreviewCache.set(url, entry);
    return entry;
  } catch (e) {
    linkPreviewCache.set(url, { status: "none", data: null });
    return null;
  }
}
function linkPreviewCardHtml(data) {
  if (!data) return "";
  const img = data.image ? `<div class="link-preview-img" style="background-image:url('${escapeHtml(data.image)}')"></div>` : "";
  const title = data.title ? `<div class="link-preview-title">${escapeHtml(data.title)}</div>` : "";
  const desc = data.description ? `<div class="link-preview-desc">${escapeHtml(data.description)}</div>` : "";
  const site = data.siteName ? `<div class="link-preview-site">${escapeHtml(data.siteName)}</div>` : "";
  return `<a class="link-preview-card" href="${escapeHtml(data.url)}" target="_blank" rel="noopener noreferrer">${img}<div class="link-preview-text">${title}${desc}${site}</div></a>`;
}
// Заполняет слот превью для конкретной ссылки, когда данные готовы —
// может обновить сразу несколько пузырей, если одна и та же ссылка
// присылалась несколько раз и всё ещё видна на экране.
function renderLinkPreviewInto(url) {
  fetchLinkPreview(url).then((entry) => {
    if (!entry || entry.status !== "done" || !entry.data) return;
    const slots = document.querySelectorAll('.link-preview-slot[data-preview-for]');
    slots.forEach((slot) => {
      if (slot.getAttribute("data-preview-for") === url) slot.innerHTML = linkPreviewCardHtml(entry.data);
    });
  });
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

function formatTime(ts) { try { return new Date(ts).toLocaleTimeString(I18N.current, { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
function formatDay(ts) { try { return new Date(ts).toLocaleDateString(I18N.current, { day: "2-digit", month: "2-digit", year: "2-digit" }); } catch (e) { return ""; } }
function formatDayGroup(ts) {
  try {
    const d = new Date(ts);
    const now = new Date();
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return T("status.today");
    if (d.toDateString() === yest.toDateString()) return T("status.yesterday");
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(I18N.current, { day: "numeric", month: "long" });
    return d.toLocaleDateString(I18N.current, { day: "numeric", month: "long", year: "numeric" });
  } catch (e) { return ""; }
}
function formatDuration(ms) { const s = Math.max(0, Math.floor(ms / 1000)), mm = Math.floor(s / 60), ss = s % 60; return mm === 0 ? T("status.seconds", { n: ss }) : `${mm}:${String(ss).padStart(2, "0")}`; }
function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60000) return T("status.ago.justNow");
  if (d < 3600000) return T("status.ago.minutes", { n: Math.floor(d / 60000) });
  if (d < 86400000) return T("status.ago.hours", { n: Math.floor(d / 3600000) });
  return formatDay(ts);
}

function applyGlassAlpha(v) {
  if (!Number.isFinite(v)) v = 0.55;
  document.documentElement.style.setProperty("--glass-alpha", v.toFixed(2));
  document.documentElement.style.setProperty("--glass-blur", (14 + v * 26).toFixed(0) + "px");
  const label = document.getElementById("glass-slider-value");
  if (label) label.textContent = Math.round(v * 100) + "%";
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
    try { unlockSoundPool(); } catch (e) {}
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
  try {
    const el = getSoundEl(SOUND_FILES.message, false);
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch((e) => etherLog("warn", "[sound] message:", String(e)));
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

function currentRingtoneSrc() {
  return RINGTONES[Store.ringtone] || RINGTONES["ring-classic"];
}

function playRingtone() {
  stopRingtone();
  if (!Store.soundsEnabled) { if (navigator.vibrate) { try { navigator.vibrate([400, 200, 400, 200, 400, 1000]); } catch (e) {} } return; }
  try {
    ringtoneAudioEl = getSoundEl(currentRingtoneSrc(), true);
    ringtoneAudioEl.currentTime = 0;
    const p = ringtoneAudioEl.play();
    if (p && p.catch) p.catch((e) => etherLog("warn", "[ringtone] play failed:", String(e)));
  } catch (e) { etherLog("warn", "[ringtone] failed:", String(e)); }

  if (navigator.vibrate) {
    try { navigator.vibrate([400, 200, 400, 200, 400, 1000]); } catch (e) {}
  }
  // Дублируем ту же мелодию через Web Audio — на устройствах, где
  // audio-элемент почему-то не разблокировался, есть шанс, что сработает
  // осциллятор (и наоборот) — два независимых пути надёжнее одного.
  try {
    const ctx = ensureAudioCtx();
    if (ctx) {
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
        playTone(880, 0, 0.18, 0.35);
        playTone(660, 0.18, 0.18, 0.35);
        playTone(880, 0.4, 0.18, 0.35);
        playTone(660, 0.58, 0.18, 0.35);
      };
      ringCycle();
      ringtoneTimer = setInterval(ringCycle, 2000);
    }
  } catch (e) {}
}
function stopRingtone() {
  if (ringtoneTimer) { clearInterval(ringtoneTimer); ringtoneTimer = null; }
  if (ringtoneAudioEl) {
    try { ringtoneAudioEl.pause(); ringtoneAudioEl.currentTime = 0; } catch (e) {}
    ringtoneAudioEl = null;
  }
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
}

// Звуки для звонящей стороны: дозваниваемся / занято / не дозвонились.
function playDialingSound() {
  stopCallSounds();
  if (!Store.soundsEnabled) return;
  try {
    dialingAudioEl = getSoundEl(SOUND_FILES.dialing, true);
    dialingAudioEl.currentTime = 0;
    const p = dialingAudioEl.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function playBusySound() {
  stopCallSounds();
  if (!Store.soundsEnabled) return;
  try {
    const el = getSoundEl(SOUND_FILES.busy, false);
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function playNoAnswerSound() {
  stopCallSounds();
  if (!Store.soundsEnabled) return;
  try {
    const el = getSoundEl(SOUND_FILES.noanswer, false);
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function stopCallSounds() {
  if (dialingAudioEl) {
    try { dialingAudioEl.pause(); dialingAudioEl.currentTime = 0; } catch (e) {}
    dialingAudioEl = null;
  }
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
    if (confirm(T("toast.confirmHardReset"))) { localStorage.clear(); location.reload(); }
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
      if (confirm(T("toast.confirmHardReset"))) { localStorage.clear(); location.reload(); }
      state.unlockAttempts = 0;
    } else toast(T("toast.pinWrong"));
  }
}
function wireLockScreen() {
  if (__lockWired) return;
  __lockWired = true;
  const submit = $("#lock-submit"), pin = $("#lock-pin"), forgot = $("#lock-forgot");
  if (submit) submit.addEventListener("click", (e) => { e.preventDefault(); tryUnlock(pin ? pin.value : ""); });
  if (pin) pin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tryUnlock(pin.value); } });
  if (forgot) forgot.addEventListener("click", () => {
    if (confirm(T("toast.confirmHardReset"))) { localStorage.clear(); location.reload(); }
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

  try { I18N.init(); } catch (e) {}

  etherLog("info", "[startApp] init, id=" + (Store.myId ? Store.myId.slice(0, 10) + "…" : "(none)"));
  mesh = new MeshManager(Store.name);

  safeCall(wireMeshEvents, "wireMeshEvents");
  safeCall(wireTabBar, "wireTabBar");
  safeCall(wireConnectScreen, "wireConnectScreen");
  safeCall(wireQrButtons, "wireQrButtons");
  safeCall(wireGroupInfo, "wireGroupInfo");
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
  safeCall(setupLanguageSelector, "setupLanguageSelector");
  safeCall(applyStaticTranslations, "applyStaticTranslations");

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
    const slp = $("#settings-link-previews"); if (slp) slp.checked = Store.linkPreviewsEnabled;
    const ssn = $("#settings-sounds"); if (ssn) ssn.checked = Store.soundsEnabled;
    const srt = $("#settings-ringtone"); if (srt) srt.value = Store.ringtone;
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
  try { setInterval(sweepExpiredMessages, 30000); sweepExpiredMessages(); } catch (e) {}
  try { updateNotifBanner(); } catch (e) {}
  try { resumeUnsentMessages(); } catch (e) {}
  try { updateAppBadge(); } catch (e) {}
  try { maybeShowOnboardingHint(); } catch (e) {}
  try { maybeOfferSystemLanguage(); } catch (e) {}
  try {
    state.callId = null; state.callPhase = null;
    state._callUserAccepted = false; state._callAcceptInFlight = false;
    state._callMuteOnAnswer = false;
    state._callDeadSeconds = 0;
  } catch (e) {}
}

function applyStaticTranslations() {
  $$("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    if (!k) return;
    el.textContent = T(k);
  });
  $$("[data-i18n-ph]").forEach((el) => {
    const k = el.getAttribute("data-i18n-ph");
    if (k) el.setAttribute("placeholder", T(k));
  });
  $$("[data-i18n-aria]").forEach((el) => {
    const k = el.getAttribute("data-i18n-aria");
    if (k) el.setAttribute("aria-label", T(k));
  });
}

function setupLanguageSelector() {
  const sel = $("#settings-language");
  if (!sel) return;
  sel.innerHTML = "";
  const langs = I18N.languages.slice().sort((a, b) => a.english.localeCompare(b.english, "en"));
  for (const lang of langs) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.native + (lang.english !== lang.native ? " · " + lang.english : "");
    sel.appendChild(opt);
  }
  sel.value = I18N.current;
  sel.addEventListener("change", () => {
    I18N.setLang(sel.value);
    applyStaticTranslations();
    try { renderTab(); } catch (e) {}
    if (state.chatId) renderChatThread();
    if (state.contactCardId) renderContactCard();
    if (state.tab === "calls") renderCallsList();
  });
}

function maybeOfferSystemLanguage() {
  const sys = I18N.shouldOfferSystem();
  if (!sys) return;
  const banner = $("#lang-offer");
  if (!banner) return;
  banner.classList.remove("hidden");
  const title = $("#lang-offer-title"); if (title) title.textContent = T("lang.offer.title");
  const txt = $("#lang-offer-text"); if (txt) txt.textContent = T("lang.offer.text", { lang: I18N.nativeName(sys) });
  const yes = $("#lang-offer-yes");
  if (yes) {
    yes.textContent = T("lang.offer.yes");
    yes.addEventListener("click", () => {
      I18N.setLang(sys);
      I18N.markOfferShown();
      banner.classList.add("hidden");
      applyStaticTranslations();
      try { renderTab(); } catch (e) {}
      const sel = $("#settings-language"); if (sel) sel.value = I18N.current;
    });
  }
  const no = $("#lang-offer-no");
  if (no) no.addEventListener("click", () => {
    I18N.markOfferShown();
    banner.classList.add("hidden");
  });
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
      if (data.kind === "call") {
        if (state.callId === data.contactId && state.callPhase === "ringing") {
          openCallScreen(data.contactId, "ringing");
        } else {
          toast(T("toast.missedCall"));
        }
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
      if (!("Notification" in window)) { toast("!"); e.target.checked = false; return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("!"); e.target.checked = false; return; }
      Store.notificationsEnabled = true;
      ensurePushSubscription().catch(() => {});
      toast(T("toast.notificationsOn"));
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
      toast(T("toast.notificationsOff"));
    }
  });
}
function wireNotifBanner() {
  const enableBtn = $("#notif-enable-btn");
  const dismissBtn = $("#notif-dismiss-btn");
  if (enableBtn) enableBtn.addEventListener("click", async () => {
    if (!("Notification" in window)) { toast("!"); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("!"); return; }
    Store.notificationsEnabled = true;
    const cb = $("#settings-notifications"); if (cb) cb.checked = true;
    ensurePushSubscription().catch(() => {});
    toast(T("toast.notificationsOn"));
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
      id, name: suggestedName || T("sys.someone"), raw: "", managed: true,
      publicKey: null, online: onlineSet.has(id), status: "new",
      messages: [], lastActivity: Date.now(),
      archived: false, muted: false, blocked: false,
    };
    state.contacts.set(id, c);
    persistContacts();
  } else if (suggestedName && (!c.name || c.name === T("sys.someone"))) {
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
      if (state.callId) {
        const cs = $("#call-screen"); if (cs) cs.classList.remove("hidden");
        return;
      }
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
function setNavMode(mode) {
  const list = $("#nav-list-mode"), chat = $("#nav-chat-mode"), contact = $("#nav-contact-mode");
  if (list) list.classList.toggle("hidden", mode !== "list");
  if (chat) chat.classList.toggle("hidden", mode !== "chat");
  if (contact) contact.classList.toggle("hidden", mode !== "contact");
}
function renderTabInner() {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $$(".screen").forEach((s) => s.classList.add("hidden"));
  const tb = $("#tab-bar"); if (tb) tb.classList.remove("hidden"); // нижняя навигация теперь видна всегда

  if (state.chatId) {
    const sc = $("#screen-chat"); if (sc) sc.classList.remove("hidden");
    setNavMode("chat");
    renderChatThread();
    return;
  }
  if (state.contactCardId) {
    const sc = $("#screen-contact"); if (sc) sc.classList.remove("hidden");
    setNavMode("contact");
    renderContactCard();
    return;
  }
  setNavMode("list");
  const map = { chats: "#screen-chats", calls: "#screen-calls", connect: "#screen-connect", settings: "#screen-settings", debug: "#screen-debug" };
  const el = $(map[state.tab]); if (el) el.classList.remove("hidden");
  const titles = {
    chats: T("nav.chats"),
    calls: T("nav.calls"),
    connect: T("nav.contacts"),
    settings: T("nav.settings"),
    debug: T("nav.debug"),
  };
  const nt = $("#nav-title"); if (nt) nt.textContent = titles[state.tab] || T("app.name");
  if (state.tab === "chats") renderChatsList();
  if (state.tab === "calls") renderCallsList();
  if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
}

function contactStatusLabel(c) {
  if (c.isGroup) return T("group.memberCount", { n: c.members.length });
  if (c.status === "in-call") return T("status.inCall");
  if (c.status === "connected") return T("status.connected");
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return T("status.connecting");
  if (c.managed) {
    if (c.online) return T("status.online");
    const seen = state.lastSeen[c.id];
    if (seen) return T("status.lastSeen", { ago: timeAgo(seen) });
    return T("status.offline");
  }
  return T("status.offline");
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
  const ta = $("#toggle-archived"); if (ta) ta.textContent = state.showArchived ? T("chats.archive.hide") : T("chats.archive.show");
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
    const muteIcon = c.muted ? `<span class="muted-icon" title="Mute">🔕</span>` : "";
    const blockIcon = c.blocked ? `<span class="muted-icon" title="Blocked">🚫</span>` : "";
    let preview = last
      ? (last.file ? escapeHtml(T("chat.file.preview." + last.file.kind)) : (last.contactCard ? escapeHtml(T("chat.contactCard.preview", { name: last.contactCard.name || T("sys.someone") })) : escapeHtml(truncate(last.text, 42))))
      : escapeHtml(contactStatusLabel(c));
    if (query && last && (last.text || "").toLowerCase().includes(query)) preview = highlightRaw(escapeHtml(truncate(last.text, 42)), state.searchQuery);
    row.innerHTML = `
      <div class="avatar" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div>
      <div class="chat-row-body">
        <div class="chat-row-top">
          <span class="chat-row-name">${escapeHtml(c.name || T("sys.someone"))} ${muteIcon}${blockIcon}</span>
          <span class="chat-row-status ${contactStatusClass(c)}"${isGroup(c) ? ' style="display:none;"' : ""}>●</span>
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
  const contacts = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c));
  if (contacts.length === 0) { if (empty) empty.classList.remove("hidden"); return; }
  if (empty) empty.classList.add("hidden");
  contacts.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  for (const c of contacts) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div>
      <div class="roster-name-block" style="flex:1; min-width:0;">
        <div class="roster-name">${escapeHtml(c.name || T("sys.someone"))}</div>
        <div class="fine muted">${escapeHtml(contactStatusLabel(c))}</div>
      </div>
      <button type="button" class="roster-add-btn" data-action="card">${escapeHtml(T("chat.peer.placeholder"))}</button>`;
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

function openContactCard(contactId) {
  if (!state.contacts.has(contactId)) return;
  const c = state.contacts.get(contactId);
  if (isGroup(c)) { openGroupInfo(contactId); return; }
  state.chatId = null;
  state.contactCardId = contactId;
  renderTab();
}
function openGroupInfo(groupId) {
  const g = state.contacts.get(groupId); if (!g || !isGroup(g)) return;
  state.activeGroupContext = groupId;
  const nameInput = $("#group-info-name"); if (nameInput) nameInput.value = g.name || "";
  const list = $("#group-info-members");
  if (list) {
    list.innerHTML = "";
    for (const m of g.members) {
      const row = document.createElement("div");
      row.className = "forward-row";
      const isMe = m.id === Store.myId;
      const canRemove = g.createdBy === Store.myId && !isMe;
      row.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(m.name)}">${escapeHtml(initials(m.name))}</div><span class="forward-name">${escapeHtml(m.name)}${isMe ? " " + escapeHtml(T("group.you")) : ""}</span>`;
      if (canRemove) {
        const rm = document.createElement("button");
        rm.type = "button"; rm.className = "icon-btn"; rm.textContent = "✕";
        rm.addEventListener("click", (ev) => { ev.stopPropagation(); removeGroupMember(groupId, m.id, false); openGroupInfo(groupId); });
        row.appendChild(rm);
      }
      list.appendChild(row);
    }
  }
  const sheet = $("#group-info-sheet"); if (sheet) sheet.classList.remove("hidden");
}
function renderContactCard() {
  const c = state.contacts.get(state.contactCardId);
  if (!c) { state.contactCardId = null; renderTab(); return; }
  const av = $("#contact-avatar");
  if (av) { av.style.background = avatarGradient(c.name); av.textContent = initials(c.name); }
  const n = $("#contact-name"); if (n) n.textContent = c.name || T("sys.someone");
  const navT = $("#nav-contact-title"); if (navT) navT.textContent = c.name || T("sys.someone");
  const st = $("#contact-status"); if (st) st.textContent = contactStatusLabel(c);
  const idEl = $("#contact-info-id"); if (idEl) idEl.textContent = c.raw || "—";
  const mutedEl = $("#contact-info-muted"); if (mutedEl) mutedEl.textContent = c.muted ? "🔕" : "🔔";
  const blockBtn = $("#contact-block-btn"); if (blockBtn) blockBtn.textContent = c.blocked ? T("chat.contact.unblock") : T("chat.contact.block");
  const archBtn = $("#contact-archive-btn"); if (archBtn) archBtn.textContent = T("chat.contact.archive");
  const muteBtn = $("#contact-mute-btn"); if (muteBtn) muteBtn.textContent = T("chat.contact.mute");
  const disSel = $("#contact-disappearing-select"); if (disSel) disSel.value = String(c.disappearingTimer || 0);
}
function wireContactCard() {
  const msgBtn = $("#contact-msg-btn");
  if (msgBtn) msgBtn.addEventListener("click", () => {
    const id = state.contactCardId; if (!id) return;
    state.contactCardId = null; state.chatId = id; renderTab();
  });
  const callBtn = $("#contact-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => {
    const id = state.contactCardId;
    if (!id) { toast("!"); return; }
    beginCall(id);
  });
  const rename = $("#contact-rename-btn");
  if (rename) rename.addEventListener("click", () => {
    const id = state.contactCardId;
    const c = state.contacts.get(id); if (!c) return;
    state.activeContactContext = id;
    const ri = $("#rename-input"); if (ri) ri.value = c.name || "";
    const rs = $("#rename-sheet"); if (rs) rs.classList.remove("hidden");
    setTimeout(() => { const ri2 = $("#rename-input"); if (ri2) ri2.focus(); }, 50);
  });
  const disSel = $("#contact-disappearing-select");
  if (disSel) disSel.addEventListener("change", (e) => {
    const id = state.contactCardId; if (!id) return;
    setDisappearingTimer(id, parseInt(e.target.value, 10) || 0);
  });
  const mute = $("#contact-mute-btn");
  if (mute) mute.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.muted = !c.muted; persistContacts(); renderContactCard();
    toast(c.muted ? T("toast.muted") : T("toast.unmuted"));
  });
  const archive = $("#contact-archive-btn");
  if (archive) archive.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.archived = !c.archived; persistContacts(); renderContactCard();
    toast(c.archived ? T("toast.archived") : T("toast.unarchived"));
  });
  const block = $("#contact-block-btn");
  if (block) block.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.blocked = !c.blocked; persistContacts(); renderContactCard();
    toast(c.blocked ? T("toast.blocked") : T("toast.unblocked"));
  });
  const exportBtn = $("#contact-export-btn");
  if (exportBtn) exportBtn.addEventListener("click", () => exportChat(state.contactCardId));
  const forwardContactBtn = $("#contact-forward-btn");
  if (forwardContactBtn) forwardContactBtn.addEventListener("click", () => {
    const fromId = state.contactCardId; if (!fromId) return;
    openForwardSheet((toId) => forwardContact(fromId, toId));
  });
  const clear = $("#contact-clear-btn");
  if (clear) clear.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (!confirm(T("toast.confirmDeleteChat", { name: c.name }))) return;
    cleanupExpiredFileBlobs(c.messages);
    c.messages = []; c.lastActivity = Date.now(); persistContacts();
    toast(T("toast.historyCleared"));
  });
  const del = $("#contact-delete-btn");
  if (del) del.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (!confirm(T("toast.confirmDeleteContact", { name: c.name }))) return;
    deleteContact(state.contactCardId);
  });
}

// =====================================================================
// Тред
// =====================================================================
function ackGlyph(ack) {
  if (ack === "failed") return `<span class="ack-tick ack-failed">✓</span>`;
  if (ack === "read") return `<span class="ack-tick ack-read">✓</span>`;
  if (ack === "delivered") return `<span class="ack-tick ack-delivered">✓</span>`;
  return `<span class="ack-tick ack-sent">✓</span>`;
}
const NEAR_BOTTOM_PX = 80;
function isNearBottom(el) { if (!el) return true; return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX; }

function renderChatThread() { try { renderChatThreadInner(); } catch (e) { etherLog("error", "[renderChatThread]", String(e)); const w = $("#chat-messages"); if (w) w.innerHTML = `<div class="empty-state"><p>Error.</p></div>`; } }

function renderChatThreadInner() {
  const c = state.contacts.get(state.chatId);
  if (!c) { state.chatId = null; renderTab(); return; }
  if (c.messages.some((m) => m.ttl && Date.now() > m.ts + m.ttl)) {
    const expired = c.messages.filter((m) => m.ttl && Date.now() > m.ts + m.ttl);
    cleanupExpiredFileBlobs(expired);
    c.messages = c.messages.filter((m) => !(m.ttl && Date.now() > m.ts + m.ttl));
    persistContacts();
  }
  if (isGroup(c)) {
    ensureGroupConnections(c);
  } else if (c.managed && !isReachable(c)) {
    attemptConnectViaRelay(c.id).catch(() => {}); // на всякий случай — вдруг найдётся общий контакт, даже если сервер цель не видит
  }
  const nm = $("#chat-peer-name"); if (nm) nm.textContent = c.name || T("sys.someone");
  const statusEl = $("#chat-peer-status");
  const typing = !isGroup(c) && state.typingTimers.has(c.id);
  if (statusEl) {
    if (isGroup(c)) { statusEl.textContent = T("group.memberCount", { n: c.members.length }); statusEl.classList.remove("typing"); }
    else { statusEl.textContent = typing ? T("chat.typing") : contactStatusLabel(c); statusEl.classList.toggle("typing", typing); }
  }
  const canCall = !isGroup(c) && (isReachable(c) || (c.managed && c.online));
  const ccb = $("#chat-call-btn"); if (ccb) ccb.disabled = !canCall;
  const vcb = $("#chat-video-call-btn"); if (vcb) vcb.disabled = !canCall;

  const badge = $("#chat-transport-badge");
  const link = (mesh && !isGroup(c)) ? mesh.get(c.id) : null;
  if (badge) {
    if (isGroup(c)) { badge.classList.add("hidden"); }
    else if (link && (link.status === "connected" || link.status === "in-call")) {
      badge.textContent = "P2P"; badge.classList.remove("hidden", "via-server");
    } else if (link && link.status === "connecting") {
      badge.textContent = "…"; badge.classList.add("via-server"); badge.classList.remove("hidden");
    } else if (c.managed && c.online) {
      badge.textContent = "S"; badge.classList.add("via-server"); badge.classList.remove("hidden");
    } else badge.classList.add("hidden");
  }

  const wrap = $("#chat-messages");
  if (!wrap) return;
  const wasAtBottom = isNearBottom(wrap);
  wrap.innerHTML = "";
  const frag = document.createDocumentFragment();
  const q = state.chatSearchQuery.toLowerCase();
  let lastDay = "";
  const urlsToFetch = new Set();
  let prevMsg = null;
  for (const m of c.messages) {
    if (m.from === "system") {
      const sys = document.createElement("div");
      sys.className = "system-message";
      const label = document.createElement("span");
      label.textContent = m.text;
      const time = document.createElement("span");
      time.className = "system-message-time";
      time.textContent = formatTime(m.ts);
      sys.appendChild(label);
      sys.appendChild(time);
      frag.appendChild(sys);
      prevMsg = null; // системное сообщение всегда разрывает визуальную группу
      continue;
    }
    const dayStr = formatDayGroup(m.ts);
    if (dayStr && dayStr !== lastDay) {
      const sep = document.createElement("div");
      sep.className = "date-sep";
      const inner = document.createElement("span");
      inner.textContent = dayStr;
      sep.appendChild(inner);
      frag.appendChild(sep);
      lastDay = dayStr;
      prevMsg = null; // новый день — тоже новая группа
    }
    // Подряд идущие сообщения одного собеседника (в пределах 5 минут) визуально
    // сближаем — так делают WhatsApp/Telegram/iMessage: понятно, что это одна
    // "реплика", а не череда отдельных сообщений.
    const grouped = !!(prevMsg && prevMsg.from === m.from && (m.from !== "them" || !isGroup(c) || prevMsg.fromId === m.fromId) && m.ts - prevMsg.ts < 5 * 60 * 1000);
    const bubble = document.createElement("div");
    bubble.className = "bubble-row " + (m.from === "me" ? "mine" : "theirs") + (grouped ? " grouped" : "");
    prevMsg = m;
    const tick = m.from === "me" ? ackGlyph(m.ack) : "";
    const editedMark = m.edited ? `<span class="bubble-edited">${escapeHtml(T("chat.edit"))}</span>` : "";
    const ttlMark = m.ttl ? `<span class="bubble-ttl" title="${escapeHtml(disappearingTimerLabel(m.ttl))}">⏳</span>` : "";
    const inner = document.createElement("div");
    inner.className = "bubble " + (m.from === "me" ? "" : "glass-content");
    const body = m.file ? fileBubbleHtml(m.id, m.file) : (m.contactCard ? contactCardBubbleHtml(m.contactCard) : linkifyAndHighlight(m.text, q));
    const senderLabel = (isGroup(c) && m.from === "them" && m.fromId && (!prevMsg || prevMsg.fromId !== m.fromId || prevMsg.from !== "them"))
      ? `<div class="bubble-sender">${escapeHtml(m.fromName || T("sys.someone"))}</div>` : "";
    let previewSlotHtml = "";
    let previewUrl = null;
    if (Store.linkPreviewsEnabled && !m.deleted) {
      previewUrl = extractFirstUrl(m.text);
      if (previewUrl) {
        const cached = linkPreviewCache.get(previewUrl);
        if (cached && cached.status === "done" && cached.data) {
          previewSlotHtml = linkPreviewCardHtml(cached.data);
        } else if (!cached || cached.status !== "none") {
          previewSlotHtml = `<div class="link-preview-slot" data-preview-for="${escapeHtml(previewUrl)}"></div>`;
          urlsToFetch.add(previewUrl);
        }
      }
    }
    let replyHtml = "";
    if (m.replyTo) replyHtml = `<div class="bubble-reply"><div class="bubble-reply-author">${escapeHtml(m.replyTo.authorName || "")}</div><div class="bubble-reply-text">${escapeHtml(truncate(m.replyTo.text || "", 80))}</div></div>`;
    const fwdMark = m.forwarded ? `<div class="bubble-forwarded">${escapeHtml(T("chat.forward"))}</div>` : "";
    let reactionsHtml = "";
    if (m.reactions && typeof m.reactions === "object") {
      const chips = Object.entries(m.reactions).filter(([, users]) => Array.isArray(users) && users.length > 0);
      if (chips.length > 0) reactionsHtml = `<div class="bubble-reactions">` + chips.map(([emoji, users]) => `<span class="bubble-reaction-chip">${escapeHtml(emoji)} ${users.length}</span>`).join("") + `</div>`;
    }
    inner.innerHTML = `${senderLabel}${fwdMark}${replyHtml}${body}${previewSlotHtml}<span class="bubble-time">${ttlMark}${formatTime(m.ts)}${editedMark}${tick}</span>${reactionsHtml}`;
    inner.addEventListener("click", (ev) => {
      const addBtn = ev.target.closest(".contact-card-add-btn");
      if (addBtn) {
        ev.stopPropagation();
        const cardId = addBtn.getAttribute("data-add-contact-id");
        const cardName = addBtn.getAttribute("data-add-contact-name") || "";
        if (cardId) addContactFromCard(cardId, cardName);
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      openMessageSheet(m.id, c.id);
    });
    attachSwipeReply(inner, m, c);
    bubble.appendChild(inner);
    frag.appendChild(bubble);
  }
  wrap.appendChild(frag);
  urlsToFetch.forEach((u) => renderLinkPreviewInto(u));
  hydrateFileSlots(wrap);
  if (wasAtBottom) wrap.scrollTop = wrap.scrollHeight;
  updateScrollBottomButton();
  const input = $("#chat-input");
  if (input && state.drafts[c.id] && !state.editingMessageId) input.value = state.drafts[c.id];
  updateSendVsMic();
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
        state.replyTo = { msgId: m.id, text: m.text, from: m.from, authorName: m.from === "me" ? (Store.name || "") : (m.fromName || c.name || "") };
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
  if (c.blocked) { toast(T("toast.blocked")); return; }
  if (text.length > MAX_MESSAGE_LENGTH) { text = text.slice(0, MAX_MESSAGE_LENGTH); toast(T("toast.messageCut")); }
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId, from: "me", text, ts, ack: "sent", serverAcked: false };
  if (replyTo) rec.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  if (c.disappearingTimer) rec.ttl = c.disappearingTimer;
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
  if (c.disappearingTimer) payload.ttl = c.disappearingTimer;
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
  const m = c.messages.find((x) => x.id === msgId);
  if (m && m.file) {
    IDB.del("file:" + msgId).catch(() => {});
    const url = fileBlobUrlCache.get(msgId);
    if (url) { URL.revokeObjectURL(url); fileBlobUrlCache.delete(msgId); }
  }
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
// Пересылка контакта другому контакту — карточка со своим видом в
// пузыре сообщения (имя + кнопка "Добавить"), не обычный текст.
function contactCardBubbleHtml(card) {
  const name = card.name || T("sys.someone");
  const already = state.contacts.has(card.id);
  const btn = already
    ? `<span class="contact-card-already">${escapeHtml(T("toast.alreadyAdded"))}</span>`
    : `<button type="button" class="contact-card-add-btn" data-add-contact-id="${escapeHtml(card.id)}" data-add-contact-name="${escapeHtml(name)}">${escapeHtml(T("chat.contactCard.add"))}</button>`;
  return `<div class="contact-card-bubble">
    <div class="avatar avatar-sm" style="background:${avatarGradient(name)}">${escapeHtml(initials(name))}</div>
    <div class="contact-card-info"><div class="contact-card-name">${escapeHtml(name)}</div>${btn}</div>
  </div>`;
}
function addContactFromCard(id, name) {
  if (id === Store.myId) { toast(T("toast.ownId")); return; }
  if (state.contacts.has(id)) { toast(T("toast.alreadyAdded")); renderChatThread(); return; }
  ensureContactEntry(id, name);
  persistContacts();
  toast(T("toast.contactAdded"));
  if (onlineSet.has(id)) scheduleAutoConnect(id);
  else attemptConnectViaRelay(id).catch(() => {}); // вдруг отправитель карточки — их общий знакомый и уже к ним подключён
  renderChatThread();
}
// =====================================================================
// Исчезающие сообщения
// =====================================================================
const DISAPPEARING_PRESETS = [0, 3600000, 86400000, 604800000]; // выкл, 1ч, 1д, 1нед
function disappearingTimerLabel(ms) {
  if (ms === 3600000) return T("chat.disappearing.1h");
  if (ms === 86400000) return T("chat.disappearing.1d");
  if (ms === 604800000) return T("chat.disappearing.1w");
  return T("chat.disappearing.off");
}
function addDisappearingSystemMessage(c, ms, byMe) {
  const text = ms
    ? (byMe ? T("chat.disappearing.systemOnYou", { duration: disappearingTimerLabel(ms) }) : T("chat.disappearing.systemOnThem", { name: c.name || T("sys.someone"), duration: disappearingTimerLabel(ms) }))
    : (byMe ? T("chat.disappearing.systemOffYou") : T("chat.disappearing.systemOffThem", { name: c.name || T("sys.someone") }));
  c.messages.push({ id: crypto.randomUUID(), from: "system", text, ts: Date.now() });
  trimMessages(c);
}
async function setDisappearingTimer(contactId, ms) {
  const c = state.contacts.get(contactId); if (!c) return;
  ms = ms || 0;
  if (c.disappearingTimer === ms) return;
  c.disappearingTimer = ms;
  addDisappearingSystemMessage(c, ms, true);
  c.lastActivity = Date.now();
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
  const actionId = crypto.randomUUID();
  await trySendOrQueue(c, actionId, { kind: "disappearing-timer", id: actionId, timer: ms });
}
// =====================================================================
// Отправка файлов/изображений/видео
// =====================================================================
// Работает только "вживую", через уже установленное P2P-соединение — как
// звонки. Офлайн-очереди через сервер для файлов нет: серверный почтовый
// ящик рассчитан на короткие текстовые конверты, а не на мегабайты
// вложений (см. README). Сами файлы хранятся в IndexedDB (не в
// localStorage вместе с остальными данными — квота localStorage на весь
// домен обычно всего 5-10 МБ, один файл её бы полностью исчерпал).

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // порциями — иначе String.fromCharCode(...bytes) падает на больших массивах
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function fileKindFromMime(mime) {
  if (!mime) return "file";
  if (mime.indexOf("image/") === 0) return "image";
  if (mime.indexOf("video/") === 0) return "video";
  if (mime.indexOf("audio/") === 0) return "audio";
  return "file";
}
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
const fileBlobUrlCache = new Map(); // msgId -> object URL, чтобы не пересоздавать при каждом ре-рендере

async function sendFileMessage(contactId, file) {
  const c = state.contacts.get(contactId); if (!c) return;
  if (isGroup(c)) { toast(T("toast.fileGroupsUnsupported")); return; }
  if (c.blocked) { toast(T("toast.blocked")); return; }
  if (file.size > MAX_FILE_SIZE) { toast(T("toast.fileTooLarge", { size: formatFileSize(MAX_FILE_SIZE) })); return; }
  const link = mesh.get(contactId);
  if (!link || link.status !== "connected") { toast(T("toast.fileNeedsLive")); return; }

  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false,
    file: { name: file.name, mime: file.type || "application/octet-stream", size: file.size, kind: fileKindFromMime(file.type), pending: true },
  };
  c.messages.push(rec); trimMessages(c); c.lastActivity = ts; persistContacts();
  if (state.chatId === contactId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();

  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (e) { rec.file.pending = false; rec.ack = "failed"; persistContacts(); if (state.chatId === contactId) renderChatThreadInner(); return; }

  try { await IDB.set("file:" + msgId, new Blob([buffer], { type: rec.file.mime })); } catch (e) {}

  const chunks = [];
  for (let offset = 0; offset < buffer.byteLength; offset += FILE_CHUNK_SIZE) {
    chunks.push(arrayBufferToBase64(buffer.slice(offset, offset + FILE_CHUNK_SIZE)));
  }
  const ok = await link.sendFile({ id: msgId, name: file.name, mime: rec.file.mime, size: file.size }, chunks);
  rec.file.pending = false;
  rec.ack = ok ? "sent" : "failed";
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
  if (!ok) toast(T("toast.fileSendFailed"));
}

// =====================================================================
// Голосовые сообщения
// =====================================================================
// Переиспользует ровно ту же инфраструктуру, что и обычные файлы (P2P
// только "вживую", хранение блоба в IndexedDB) — отличается только UI
// записи и типом отрисовки пузыря (проигрыватель вместо файла).
async function sendVoiceMessage(contactId, blob, durationSec) {
  const c = state.contacts.get(contactId); if (!c) return;
  if (isGroup(c)) { toast(T("toast.fileGroupsUnsupported")); return; }
  if (c.blocked) { toast(T("toast.blocked")); return; }
  if (blob.size > MAX_FILE_SIZE) { toast(T("toast.fileTooLarge", { size: formatFileSize(MAX_FILE_SIZE) })); return; }
  const link = mesh.get(contactId);
  if (!link || link.status !== "connected") { toast(T("toast.fileNeedsLive")); return; }

  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const mime = blob.type || "audio/webm";
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false,
    file: { name: "voice-message", mime, size: blob.size, kind: "audio", duration: durationSec, pending: true },
  };
  c.messages.push(rec); trimMessages(c); c.lastActivity = ts; persistContacts();
  if (state.chatId === contactId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();

  let buffer;
  try { buffer = await blob.arrayBuffer(); }
  catch (e) { rec.file.pending = false; rec.ack = "failed"; persistContacts(); if (state.chatId === contactId) renderChatThreadInner(); return; }

  try { await IDB.set("file:" + msgId, new Blob([buffer], { type: mime })); } catch (e) {}

  const chunks = [];
  for (let offset = 0; offset < buffer.byteLength; offset += FILE_CHUNK_SIZE) {
    chunks.push(arrayBufferToBase64(buffer.slice(offset, offset + FILE_CHUNK_SIZE)));
  }
  const ok = await link.sendFile({ id: msgId, name: "voice-message", mime, size: blob.size, duration: durationSec }, chunks);
  rec.file.pending = false;
  rec.ack = ok ? "sent" : "failed";
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
  if (!ok) toast(T("toast.fileSendFailed"));
}

function pickVoiceMimeType() {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}
let voiceRecorder = null, voiceRecordStream = null, voiceRecordChunks = [], voiceRecordStartedAt = 0, voiceRecordTimerId = null;
async function startVoiceRecording() {
  if (!state.chatId) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast(T("toast.voiceUnsupported")); return;
  }
  try {
    voiceRecordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast(T("toast.voiceNoMic")); return;
  }
  const mimeType = pickVoiceMimeType();
  try {
    voiceRecorder = mimeType ? new MediaRecorder(voiceRecordStream, { mimeType }) : new MediaRecorder(voiceRecordStream);
  } catch (e) {
    toast(T("toast.voiceUnsupported"));
    voiceRecordStream.getTracks().forEach((t) => t.stop()); voiceRecordStream = null;
    return;
  }
  voiceRecordChunks = [];
  voiceRecorder.addEventListener("dataavailable", (ev) => { if (ev.data && ev.data.size > 0) voiceRecordChunks.push(ev.data); });
  voiceRecorder.start();
  voiceRecordStartedAt = Date.now();
  const form = $("#chat-form"); if (form) form.classList.add("hidden");
  const bar = $("#voice-recording-bar"); if (bar) bar.classList.remove("hidden");
  const timeEl = $("#voice-recording-time");
  voiceRecordTimerId = setInterval(() => {
    if (timeEl) timeEl.textContent = formatVoiceDuration((Date.now() - voiceRecordStartedAt) / 1000);
  }, 200);
}
function stopVoiceRecording(send) {
  const contactId = state.chatId;
  const durationSec = (Date.now() - voiceRecordStartedAt) / 1000;
  if (voiceRecordTimerId) { clearInterval(voiceRecordTimerId); voiceRecordTimerId = null; }
  const form = $("#chat-form"); if (form) form.classList.remove("hidden");
  const bar = $("#voice-recording-bar"); if (bar) bar.classList.add("hidden");
  if (!voiceRecorder) return;
  const recorder = voiceRecorder;
  const mimeType = recorder.mimeType || "audio/webm";
  voiceRecorder = null;
  recorder.addEventListener("stop", () => {
    if (voiceRecordStream) { voiceRecordStream.getTracks().forEach((t) => t.stop()); voiceRecordStream = null; }
    if (!send || durationSec < 0.6) { voiceRecordChunks = []; return; } // случайное короткое нажатие — не отправляем пустышку
    const blob = new Blob(voiceRecordChunks, { type: mimeType });
    voiceRecordChunks = [];
    if (contactId) sendVoiceMessage(contactId, blob, durationSec);
  });
  try { recorder.stop(); } catch (e) {}
}

const incomingFileBuffers = new Map(); // id -> { name, mime, size, totalChunks, chunks: [] }
function handleFilePayload(from, payload) {
  if (payload.kind === "file-meta") {
    incomingFileBuffers.set(payload.id, { name: payload.name, mime: payload.mime, size: payload.size, totalChunks: payload.totalChunks, chunks: new Array(payload.totalChunks), from });
    const c = ensureContactEntry(from, null);
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: "", ts: Date.now(), readAckSent: isOpen,
      file: { name: payload.name, mime: payload.mime, size: payload.size, kind: fileKindFromMime(payload.mime), duration: payload.duration || 0, pending: true } };
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now(); persistContacts();
    if (isOpen) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    return;
  }
  if (payload.kind === "file-chunk") {
    const buf = incomingFileBuffers.get(payload.id);
    if (!buf || payload.index == null || payload.index < 0 || payload.index >= buf.totalChunks) return;
    buf.chunks[payload.index] = payload.data;
    return;
  }
  if (payload.kind === "file-done") {
    const buf = incomingFileBuffers.get(payload.id);
    incomingFileBuffers.delete(payload.id);
    if (!buf) return;
    finishIncomingFile(payload.id, buf, from);
  }
}
async function finishIncomingFile(msgId, buf, from) {
  const c = state.contacts.get(from);
  const rec = c && c.messages.find((m) => m.id === msgId);
  if (buf.chunks.some((ch) => ch === undefined)) {
    // какой-то кусок не долетел — не собираем повреждённый файл
    if (rec) { rec.file.pending = false; rec.file.failed = true; persistContacts(); if (state.chatId === from) renderChatThread(); }
    return;
  }
  try {
    const byteArrays = buf.chunks.map(base64ToUint8Array);
    const blob = new Blob(byteArrays, { type: buf.mime });
    await IDB.set("file:" + msgId, blob);
  } catch (e) {
    if (rec) { rec.file.pending = false; rec.file.failed = true; persistContacts(); if (state.chatId === from) renderChatThread(); }
    return;
  }
  if (rec) {
    rec.file.pending = false;
    persistContacts();
    const isOpen = state.chatId === from;
    if (isOpen) { renderChatThread(); playMessageSound(); vibrate([80, 40, 80]); }
    else {
      const label = T("chat.file.preview." + rec.file.kind);
      toast(`${c.name}: ${label}`);
      if (!c.muted) showNotification(c.name || T("app.name"), label, { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message" });
      playMessageSound();
      vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    if (isOpen) sendAckBatch(from, [msgId], "read");
    updateAppBadge();
  }
}
async function getFileBlobUrl(msgId) {
  if (fileBlobUrlCache.has(msgId)) return fileBlobUrlCache.get(msgId);
  const blob = await IDB.get("file:" + msgId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  fileBlobUrlCache.set(msgId, url);
  return url;
}
function fileBubbleHtml(msgId, fileInfo) {
  if (fileInfo.pending) {
    return `<div class="file-bubble file-bubble-pending"><div class="file-spinner"></div><span>${escapeHtml(T("chat.file.sending"))}</span></div>`;
  }
  if (fileInfo.failed) {
    return `<div class="file-bubble file-bubble-failed">⚠️ <span>${escapeHtml(T("chat.file.failed"))}</span></div>`;
  }
  const sizeStr = formatFileSize(fileInfo.size);
  if (fileInfo.kind === "image") {
    return `<div class="file-media-slot" data-file-id="${escapeHtml(msgId)}" data-file-kind="image"><div class="file-media-loading">${escapeHtml(T("chat.file.loading"))}</div></div>`;
  }
  if (fileInfo.kind === "video") {
    return `<div class="file-media-slot" data-file-id="${escapeHtml(msgId)}" data-file-kind="video"><div class="file-media-loading">${escapeHtml(T("chat.file.loading"))}</div></div>`;
  }
  if (fileInfo.kind === "audio") {
    const durLabel = fileInfo.duration ? formatVoiceDuration(fileInfo.duration) : "";
    return `<div class="voice-bubble" data-file-id="${escapeHtml(msgId)}" data-file-kind="audio" data-duration="${fileInfo.duration || 0}">
      <button type="button" class="voice-play-btn" disabled>▶</button>
      <div class="voice-progress"><div class="voice-progress-fill"></div></div>
      <span class="voice-duration">${escapeHtml(durLabel)}</span>
    </div>`;
  }
  return `<a class="file-bubble file-bubble-doc" data-file-id="${escapeHtml(msgId)}" data-file-kind="file" href="#">
    <span class="file-doc-icon">📄</span>
    <span class="file-doc-info"><span class="file-doc-name">${escapeHtml(fileInfo.name)}</span><span class="file-doc-size">${escapeHtml(sizeStr)}</span></span>
  </a>`;
}
function formatVoiceDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}
function hydrateFileSlots(root) {
  root.querySelectorAll(".file-media-slot[data-file-id], .file-bubble-doc[data-file-id]").forEach((el) => {
    const msgId = el.getAttribute("data-file-id");
    const kind = el.getAttribute("data-file-kind");
    getFileBlobUrl(msgId).then((url) => {
      if (!url) return;
      if (kind === "image") el.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`;
      else if (kind === "video") el.innerHTML = `<video src="${escapeHtml(url)}" controls playsinline></video>`;
      else if (kind === "file") { el.href = url; el.setAttribute("download", ""); }
    });
  });
  root.querySelectorAll(".voice-bubble[data-file-id]").forEach((el) => {
    const msgId = el.getAttribute("data-file-id");
    const playBtn = el.querySelector(".voice-play-btn");
    const fill = el.querySelector(".voice-progress-fill");
    const durEl = el.querySelector(".voice-duration");
    const knownDuration = parseFloat(el.getAttribute("data-duration")) || 0;
    getFileBlobUrl(msgId).then((url) => {
      if (!url || !playBtn) return;
      const audio = new Audio(url);
      playBtn.disabled = false;
      let playing = false;
      audio.addEventListener("timeupdate", () => {
        const dur = audio.duration || knownDuration;
        if (fill && dur) fill.style.width = Math.min(100, (audio.currentTime / dur) * 100) + "%";
        if (durEl) durEl.textContent = formatVoiceDuration(dur - audio.currentTime);
      });
      audio.addEventListener("ended", () => {
        playing = false; playBtn.textContent = "▶";
        if (fill) fill.style.width = "0%";
        if (durEl) durEl.textContent = formatVoiceDuration(knownDuration || audio.duration || 0);
      });
      playBtn.addEventListener("click", () => {
        // На случай нескольких голосовых в чате — не играть их хором.
        document.querySelectorAll(".voice-play-btn").forEach((b) => { if (b !== playBtn) b.textContent = "▶"; });
        document.querySelectorAll("audio.ether-voice-playing").forEach((a) => { if (a !== audio) a.pause(); });
        audio.classList.add("ether-voice-playing");
        if (playing) { audio.pause(); playing = false; playBtn.textContent = "▶"; }
        else { audio.play().catch(() => {}); playing = true; playBtn.textContent = "⏸"; }
      });
    });
  });
}

function cleanupExpiredFileBlobs(removedMessages) {
  for (const m of removedMessages) {
    if (!m.file) continue;
    IDB.del("file:" + m.id).catch(() => {});
    const url = fileBlobUrlCache.get(m.id);
    if (url) { URL.revokeObjectURL(url); fileBlobUrlCache.delete(m.id); }
  }
}
function updateSendVsMic() {
  const input = $("#chat-input"); if (!input) return;
  const hasText = input.value.trim().length > 0;
  const sendBtn = $(".send-btn[type=submit]");
  const micBtn = $("#voice-record-btn");
  if (sendBtn) sendBtn.classList.toggle("hidden", !hasText);
  if (micBtn) micBtn.classList.toggle("hidden", hasText);
}
function sweepExpiredMessages() {
  const now = Date.now();
  let anyChanged = false;
  for (const c of state.contacts.values()) {
    const expired = c.messages.filter((m) => m.ttl && now > m.ts + m.ttl);
    if (expired.length === 0) continue;
    cleanupExpiredFileBlobs(expired);
    c.messages = c.messages.filter((m) => !(m.ttl && now > m.ts + m.ttl));
    anyChanged = true;
  }
  if (!anyChanged) return;
  persistContacts();
  if (state.chatId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}

// =====================================================================
// Групповые чаты (полносвязная mesh, до MAX_GROUP_MEMBERS участников)
// =====================================================================
// Каждый участник напрямую P2P-подключён к каждому другому — группового
// сервера нет, сообщение просто рассылается N-1 раз через уже
// существующий 1-к-1 канал каждому (P2P если на связи, иначе — через тот
// же зашифрованный почтовый ящик, что и обычные сообщения). Поэтому
// группа наследует ту же гарантию доставки офлайн-участникам, что и
// обычная переписка — почти бесплатно. Сознательное ограничение
// масштаба: 10 участников, дальше mesh перестаёт быть практичной.
const MAX_GROUP_MEMBERS = 10;

function isGroup(c) { return !!(c && c.isGroup); }

function createGroup(name, memberIds) {
  if (memberIds.length + 1 > MAX_GROUP_MEMBERS) { toast(T("toast.groupTooBig", { max: MAX_GROUP_MEMBERS })); return null; }
  if (memberIds.length === 0) { toast(T("toast.groupNeedsMembers")); return null; }
  const groupId = crypto.randomUUID();
  const members = memberIds.map((id) => {
    const c = state.contacts.get(id);
    return { id, name: (c && c.name) || T("sys.someone") };
  });
  members.push({ id: Store.myId, name: Store.name || T("sys.someone") });
  const g = {
    id: groupId, isGroup: true, name: (name || "").trim() || T("group.defaultName"),
    members, messages: [], lastActivity: Date.now(), archived: false, muted: false,
    createdBy: Store.myId, managed: true,
  };
  state.contacts.set(groupId, g);
  persistContacts();
  broadcastGroupRoster(g);
  for (const m of members) {
    if (m.id === Store.myId) continue;
    attemptConnect(m.id);
    attemptConnectViaRelay(m.id).catch(() => {});
  }
  return groupId;
}
// Рассылает текущий состав/название группы всем участникам — при
// создании, добавлении/удалении участника или переименовании.
function broadcastGroupRoster(g) {
  const payload = { kind: "group-invite", id: crypto.randomUUID(), groupId: g.id, groupName: g.name, members: g.members };
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const mc = ensureContactEntry(m.id, m.name);
    trySendOrQueue(mc, crypto.randomUUID(), payload).catch(() => {});
  }
}
async function sendGroupMessage(groupId, text, replyTo) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId, from: "me", text, ts, ack: "sent" };
  if (replyTo) rec.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  if (g.disappearingTimer) rec.ttl = g.disappearingTimer;
  g.messages.push(rec); trimMessages(g); g.lastActivity = ts; persistContacts();
  if (state.chatId === groupId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();
  playOutgoingSound();
  const payload = { kind: "chat", id: msgId, text, ts, groupId, senderName: Store.name || T("sys.someone") };
  if (replyTo) payload.replyTo = { id: replyTo.msgId, text: replyTo.text, from: replyTo.from };
  if (g.disappearingTimer) payload.ttl = g.disappearingTimer;
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const mc = ensureContactEntry(m.id, m.name);
    // Отдельный id доставки на каждого получателя — outbox в проекте
    // ключуется только по msgId, без адресата; один и тот же msgId на
    // нескольких получателей потерял бы все копии кроме первой.
    await trySendOrQueue(mc, crypto.randomUUID(), payload);
  }
}
function addGroupMember(groupId, memberId) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (g.members.some((m) => m.id === memberId)) return;
  if (g.members.length >= MAX_GROUP_MEMBERS) { toast(T("toast.groupTooBig", { max: MAX_GROUP_MEMBERS })); return; }
  const c = state.contacts.get(memberId);
  g.members.push({ id: memberId, name: (c && c.name) || T("sys.someone") });
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemAdded", { name: (c && c.name) || T("sys.someone") }), ts: Date.now() });
  g.lastActivity = Date.now();
  persistContacts();
  broadcastGroupRoster(g);
  attemptConnect(memberId);
  attemptConnectViaRelay(memberId).catch(() => {});
  if (state.chatId === groupId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
function removeGroupMember(groupId, memberId, leftBySelf) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  const wasIn = g.members.some((m) => m.id === memberId);
  if (!wasIn) return;
  const removedName = (g.members.find((m) => m.id === memberId) || {}).name || T("sys.someone");
  g.members = g.members.filter((m) => m.id !== memberId);
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: leftBySelf ? T("group.systemLeft", { name: removedName }) : T("group.systemRemoved", { name: removedName }), ts: Date.now() });
  g.lastActivity = Date.now();
  persistContacts();
  // И при добровольном выходе (чтобы остальные узнали, что меня больше
  // нет), и при исключении кем-то другим — рассылаем новый состав
  // оставшимся участникам. Исключение: самого исключённого в новом
  // составе уже нет, поэтому отдельным сообщением он о выходе не узнает
  // этим путём — известное упрощение v1.
  broadcastGroupRoster(g);
  if (state.chatId === groupId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
function renameGroup(groupId, name) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  name = (name || "").trim(); if (!name || name === g.name) return;
  g.name = name;
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemRenamed", { name }), ts: Date.now() });
  g.lastActivity = Date.now();
  persistContacts();
  broadcastGroupRoster(g);
  if (state.chatId === groupId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
function ensureGroupConnections(g) {
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    ensureContactEntry(m.id, m.name);
    if (!isReachable(state.contacts.get(m.id))) {
      attemptConnect(m.id);
      attemptConnectViaRelay(m.id).catch(() => {});
    }
  }
}

async function forwardContact(fromContactId, toContactId) {
  const shared = state.contacts.get(fromContactId), to = state.contacts.get(toContactId);
  if (!shared || !to) return;
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false, contactCard: { id: shared.id, name: shared.name || T("sys.someone") } };
  to.messages.push(rec); trimMessages(to); to.lastActivity = ts; persistContacts();
  if (state.chatId === toContactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
  toast(T("toast.contactForwarded"));
  const payload = { kind: "contact-card", id: msgId, ts, contactId: shared.id, contactName: shared.name || "" };
  await trySendOrQueue(to, msgId, payload);
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
  toast(T("toast.forwarded"));
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
  } catch (e) { etherLog("error", "[crypto] encrypt:", String(e)); markMessageAck(entry.to, msgId, "failed"); }
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

const _recentAckSent = new Map();
function sendAckBatch(contactId, originalMsgIds, ackState) {
  if (!Array.isArray(originalMsgIds) || originalMsgIds.length === 0) return;
  const key = contactId + ":" + ackState + ":" + originalMsgIds.slice(0, 3).join(",");
  const now = Date.now();
  const last = _recentAckSent.get(key);
  if (last && now - last < ACK_DEDUP_WINDOW_MS) return;
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
function initSignaling() {
  const url = effectiveSignalingUrl();
  if (signalingCleanup) { try { signalingCleanup(); } catch (e) {} signalingCleanup = null; }
  if (signaling) { signaling.stop(); signaling = null; }
  onlineSet.clear(); onlineRoster.clear();
  for (const c of state.contacts.values()) c.online = false;
  if (!url) { updateSignalingStatusUI("off", "—"); renderChatsList(); renderOnlineRosterList(); return; }
  updateSignalingStatusUI("connecting", "…");
  etherLog("info", "[signaling] connecting to " + url);
  signaling = new SignalingClient(url, Store.myId, { name: Store.name, visible: Store.discoverable, publicKey: Store.myPublicKeyJwk });
  signalingCleanup = wireSignalingEvents(signaling);
  signaling.start();
}
// Общая обработка входящего offer/answer — используется и для сигнального
// сервера, и для релея через общий контакт (см. ниже): сама логика
// WebRTC-рукопожатия не должна знать и не знает, через какой транспорт
// пришёл пакет.
async function handleIncomingOffer(from, packet, replySignal) {
  const existing = mesh.get(from);
  if (existing && existing.role === "answerer" && existing.status === "connected") return;
  if (existing) mesh.remove(from);
  ensureContactEntry(from, packet.n);
  const link = mesh.createIncomingLink(from);
  try {
    const answer = await link.acceptOfferAndCreateAnswer(packet);
    if (!answer) return;
    replySignal(answer);
  } catch (e) {
    etherLog("error", "[offer] FAILED:", String(e && e.message || e));
    mesh.remove(from);
  }
}
async function handleIncomingAnswer(from, packet) {
  const link = mesh.get(from);
  if (link) {
    try { await link.acceptAnswer(packet); }
    catch (e) { mesh.remove(from); }
  }
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
    updateSignalingStatusUI("online", T("status.online"));
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
    updateSignalingStatusUI("off", T("status.offline"));
    for (const c of state.contacts.values()) if (c.managed) {
      if (c.online) { state.lastSeen[c.id] = Date.now(); persistLastSeen(); }
      c.online = false;
    }
    onlineRoster.clear();
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  }));
  subs.push(on("replaced", () => {
    updateSignalingStatusUI("off", T("status.offline"));
    toast(T("status.offline"));
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
      ensureContactEntry(from, packet.n);
      if (state.callId && state.callId !== from) {
        try { sig.signal(from, { t: "call-busy" }); } catch (e) {}
        return;
      }
      if (state.callId === from) {
        try { sig.signal(from, { t: "call-invite-ack" }); } catch (e) {}
        return;
      }
      openCallScreen(from, "ringing");
      try { ensureAudioCtx(); } catch (e) {}
      playRingtone();
      const c = state.contacts.get(from);
      if (c && !c.muted && Store.notificationsEnabled) {
        showNotification(T("call.incoming"), packet.n || "", { tag: "ether-call-" + from, contactId: from, kind: "call", force: true });
      }
      try { sig.signal(from, { t: "call-invite-ack" }); } catch (e) {}
      return;
    }
    if (packet.t === "call-busy") {
      if (state.callId === from) {
        stopRingtone();
        toast(T("toast.peerBusy"));
        closeCallScreen("busy");
      }
      return;
    }
    if (packet.t === "call-invite-ack") {
      if (state.callId === from && state.callPhase === "calling") {
        const p = $("#call-phase"); if (p) p.textContent = T("call.ringing");
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
        try { const l = mesh.get(from); if (l) l.endCall(); } catch (e) {}
        closeCallScreen("declined");
      }
      return;
    }
    if (packet.t === "call-ended") {
      if (state.callId === from) {
        stopRingtone();
        try { const l = mesh.get(from); if (l) l.endCall(); } catch (e) {}
        closeCallScreen("completed");
      }
      return;
    }
    if (packet.t === "offer") {
      await handleIncomingOffer(from, packet, (answer) => sig.signal(from, answer));
    } else if (packet.t === "answer") {
      await handleIncomingAnswer(from, packet);
    }
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
      if (!theirKey) throw new Error("no key");
      const sharedKey = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, theirKey);
      payload = await CryptoHelper.decryptJson(sharedKey, envelope);
      if (fromPublicKey) {
        const c = state.contacts.get(from);
        if (c && keysDiffer(fromPublicKey, c.publicKey)) { c.publicKey = fromPublicKey; persistContacts(); }
      }
    } catch (e) { etherLog("error", "[crypto] decrypt failed:", String(e)); return; }

    applyIncomingPayload(from, msgId, payload, true, kind);

    if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
  }));
  return () => { for (const s of subs) sig.removeEventListener(s.type, s.wrapped); };
}
function applyIncomingPayload(from, envelopeMsgId, payload, fromServer, openKind) {
  const kind = (payload && payload.kind) || openKind || "chat";
  if (kind === "chat") {
    const groupId = payload.groupId;
    const c = groupId ? state.contacts.get(groupId) : ensureContactEntry(from, null);
    if (!c) return; // сообщение в группу, о которой нам ничего не известно (приглашение не дошло) — не с чем сопоставить
    if (c.messages.some((m) => m.id === payload.id)) return;
    const routeId = groupId || from;
    const isOpen = state.chatId === routeId;
    const rec = { id: payload.id, from: "them", text: payload.text, ts: payload.ts || Date.now(), readAckSent: isOpen };
    if (groupId) { rec.fromId = from; rec.fromName = payload.senderName || (state.contacts.get(from) && state.contacts.get(from).name) || T("sys.someone"); }
    if (payload.replyTo) rec.replyTo = payload.replyTo;
    if (payload.forwarded) rec.forwarded = true;
    if (payload.ttl) rec.ttl = payload.ttl;
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    const displayName = c.name;
    const previewPrefix = groupId ? `${rec.fromName}: ` : "";
    if (isOpen) { renderChatThread(); playMessageSound(); vibrate([80, 40, 80]); }
    else {
      toast(`${displayName}: ${previewPrefix}${truncate(payload.text, 40)}`);
      if (!c.muted) showNotification(displayName || T("app.name"), previewPrefix + truncate(payload.text, 80), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message" });
      playMessageSound();
      vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    if (isOpen && !groupId) sendAckBatch(from, [payload.id], "read");
    updateAppBadge();
  } else if (kind === "group-invite") {
    if (!Array.isArray(payload.members) || payload.members.length === 0 || payload.members.length > MAX_GROUP_MEMBERS) return;
    if (!payload.members.some((m) => m.id === Store.myId)) return; // меня из группы вывели или пригласили по ошибке не туда
    let g = state.contacts.get(payload.groupId);
    const isNew = !g;
    if (isNew) {
      g = { id: payload.groupId, isGroup: true, name: payload.groupName || T("group.defaultName"),
        members: payload.members, messages: [], lastActivity: Date.now(), archived: false, muted: false,
        createdBy: from, managed: true };
      state.contacts.set(payload.groupId, g);
      g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemCreated", { name: g.name }), ts: Date.now() });
    } else {
      g.members = payload.members;
      if (payload.groupName) g.name = payload.groupName;
    }
    g.lastActivity = Date.now();
    persistContacts();
    ensureGroupConnections(g);
    if (state.chatId === payload.groupId) renderChatThread();
    if (state.tab === "chats") renderChatsList();
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
  } else if (kind === "contact-card") {
    const c = ensureContactEntry(from, null);
    if (c.messages.some((m) => m.id === payload.id)) return;
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: "", ts: payload.ts || Date.now(), readAckSent: isOpen, contactCard: { id: payload.contactId, name: payload.contactName || "" } };
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    const previewText = T("chat.contactCard.preview", { name: payload.contactName || T("sys.someone") });
    if (isOpen) { renderChatThread(); playMessageSound(); vibrate([80, 40, 80]); }
    else {
      toast(`${c.name}: ${previewText}`);
      if (!c.muted) showNotification(c.name || T("app.name"), previewText, { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message" });
      playMessageSound();
      vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    if (isOpen) sendAckBatch(from, [payload.id], "read");
    updateAppBadge();
  } else if (kind === "disappearing-timer") {
    const c = ensureContactEntry(from, null);
    const ms = payload.timer || 0;
    if (c.disappearingTimer === ms) return;
    c.disappearingTimer = ms;
    addDisappearingSystemMessage(c, ms, false);
    c.lastActivity = Date.now();
    persistContacts();
    if (state.chatId === from) renderChatThread();
    if (state.tab === "chats") renderChatsList();
  }
}
function clearAutoConnectTimer(id) { const t = autoConnectTimers.get(id); if (t) clearTimeout(t); autoConnectTimers.delete(id); }
// =====================================================================
// Relay-сигналинг через общий контакт (без сигнального сервера)
// =====================================================================
//
// Если я уже P2P-подключён к X, а X уже P2P-подключён к T (тому, кого я
// хочу добавить) — X может разово передать между нами offer/answer прямо
// по уже открытым зашифрованным каналам, без сигнального сервера вообще.
// Пересылка — ровно на один хоп (я → X → T и обратно), без дальнейшей
// маршрутизации по цепочке: так надёжнее и не нужно думать про циклы.
//
//   relay-request           я → X:  "передай этот offer контакту T"
//   relay-deliver           X → T:  "вот offer от меня-через-X"
//   relay-deliver-response  T → X:  "вот ответ, верни его обратно"
//   relay-response          X → я:  "вот ответ от T"

function handleRelayPayload(viaId, payload) {
  if (payload.kind === "relay-request") {
    const target = mesh.get(payload.to);
    if (target && target.status === "connected") {
      target.send({ kind: "relay-deliver", from: viaId, packet: payload.packet });
    }
    // Если T через меня недостижим — молча ничего не делаем: запрашивающий
    // либо получит ответ от другого общего контакта, либо не получит вовсе.
    return;
  }
  if (payload.kind === "relay-deliver") {
    if (isDuplicateSignal(payload.from, payload.packet)) return;
    handleIncomingOffer(payload.from, payload.packet, (answer) => {
      const backToRelay = mesh.get(viaId);
      if (backToRelay) backToRelay.send({ kind: "relay-deliver-response", to: payload.from, packet: answer });
    });
    return;
  }
  if (payload.kind === "relay-deliver-response") {
    const requester = mesh.get(payload.to);
    if (requester) requester.send({ kind: "relay-response", from: viaId, packet: payload.packet });
    return;
  }
  if (payload.kind === "relay-response") {
    if (isDuplicateSignal(payload.from, payload.packet)) return;
    handleIncomingAnswer(payload.from, payload.packet);
  }
}

// Пробуем достучаться до contactId через ЛЮБОЙ из уже подключённых
// контактов — полезно, когда цель не видна через сигнальный сервер
// (свой/другой сервер, временно офлайн на сервере), но у нас есть общий
// знакомый, который сейчас с ней на связи.
async function attemptConnectViaRelay(targetId) {
  const existing = mesh.get(targetId);
  if (existing && existing.status !== "disconnected") return;
  if (_connectInFlight.has(targetId)) return;
  const relays = Array.from(mesh.links.entries()).filter(([rid, l]) => rid !== targetId && l.status === "connected");
  if (relays.length === 0) return;
  _connectInFlight.add(targetId);
  try {
    const link = mesh.createOutgoingLink(targetId);
    const packet = await link.createInitialOffer("");
    if (!packet) { mesh.remove(targetId); return; }
    for (const [, relayLink] of relays) relayLink.send({ kind: "relay-request", to: targetId, packet });
    watchConnectionTimeout(targetId);
  } catch (e) {
    etherLog("error", "[relay] createInitialOffer failed:", String(e));
    mesh.remove(targetId);
  } finally {
    _connectInFlight.delete(targetId);
  }
}

function scheduleAutoConnect(id) {
  attemptConnect(id);
  attemptConnectViaRelay(id).catch(() => {});
  if (autoConnectTimers.has(id)) return;
  autoConnectTimers.set(id, setTimeout(() => { autoConnectTimers.delete(id); attemptConnect(id); attemptConnectViaRelay(id).catch(() => {}); }, 4000));
}
async function attemptConnect(id) {
  const tag = String(id).slice(0, 10) + "…";
  if (!signaling || !signaling.connected) return;
  if (!onlineSet.has(id)) return;
  const iShouldOffer = Store.myId < id;
  if (!iShouldOffer) { etherLog("info", "[connect] " + tag, "not my turn"); return; }
  if (_connectInFlight.has(id)) return;
  _connectInFlight.add(id);
  try {
    const existing = mesh.get(id);
    if (existing) {
      const age = Date.now() - (existing._createdAt || 0);
      if (existing.status === "connected" || existing.status === "in-call") return;
      if (existing.status === "connecting" && age < CONNECT_STUCK_MS) return;
      mesh.remove(id);
    }
    const link = mesh.createOutgoingLink(id);
    try {
      const packet = await link.createInitialOffer("");
      if (!packet) return;
      signaling.signal(id, packet);
      watchConnectionTimeout(id);
    } catch (e) {
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
      <span class="roster-name">${escapeHtml(u.name || T("sys.someone"))}</span>
      <button type="button" class="btn-secondary roster-add-btn">${escapeHtml(T("connect.addButton"))}</button>`;
    row.querySelector(".roster-add-btn").addEventListener("click", () => {
      state.contacts.set(id, {
        id, name: u.name || T("sys.someone"), raw: "", managed: true,
        publicKey: u.publicKey || null, online: true, status: "disconnected",
        messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false,
      });
      persistContacts();
      toast(T("toast.contactAdded"));
      scheduleAutoConnect(id);
      renderOnlineRosterList();
      renderContactsList();
      state.tab = "chats";
      renderTab();
    });
    wrap.appendChild(row);
  }
}

// =====================================================================
// QR-код для добавления контакта
// =====================================================================
function renderMyQrCode() {
  const canvas = $("#my-qr-canvas");
  if (!canvas || typeof qrcode !== "function") return;
  const payload = "ether://add?id=" + encodeURIComponent(Store.myId) + "&name=" + encodeURIComponent(Store.name || "");
  const qr = qrcode(0, "M"); // typeNumber 0 = автоподбор размера под данные
  qr.addData(payload);
  qr.make();
  const n = qr.getModuleCount();
  const size = canvas.width;
  const scale = size / n;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000000";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) ctx.fillRect(Math.round(x * scale), Math.round(y * scale), Math.ceil(scale), Math.ceil(scale));
    }
  }
}
function parseQrAddPayload(text) {
  try {
    if (!text || text.indexOf("ether://add?") !== 0) return null;
    const qs = new URLSearchParams(text.slice(text.indexOf("?")));
    const id = qs.get("id");
    if (!id) return null;
    return { id, name: qs.get("name") || "" };
  } catch (e) { return null; }
}
let qrScanStream = null, qrScanRafId = null, qrScanCanvas = null;
async function startQrScan() {
  const sheet = $("#scan-qr-sheet"); if (sheet) sheet.classList.remove("hidden");
  const video = $("#qr-scan-video");
  const statusEl = $("#qr-scan-status");
  if (!video || typeof jsQR !== "function") return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (statusEl) statusEl.textContent = T("connect.qr.scan.unsupported");
    return;
  }
  try {
    qrScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch (e) {
    if (statusEl) statusEl.textContent = T("connect.qr.scan.noCamera");
    etherLog("warn", "[qr] getUserMedia failed:", String(e));
    return;
  }
  video.srcObject = qrScanStream;
  await video.play().catch(() => {});
  if (!qrScanCanvas) qrScanCanvas = document.createElement("canvas");
  const tick = () => {
    if (!qrScanStream) return; // сканирование уже остановлено
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      qrScanCanvas.width = video.videoWidth;
      qrScanCanvas.height = video.videoHeight;
      const ctx = qrScanCanvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, qrScanCanvas.width, qrScanCanvas.height);
      let imageData;
      try { imageData = ctx.getImageData(0, 0, qrScanCanvas.width, qrScanCanvas.height); } catch (e) { imageData = null; }
      if (imageData) {
        const result = jsQR(imageData.data, imageData.width, imageData.height);
        if (result && result.data) {
          const parsed = parseQrAddPayload(result.data);
          if (parsed) {
            stopQrScan();
            if (sheet) sheet.classList.add("hidden");
            addContactFromCard(parsed.id, parsed.name);
            return;
          }
        }
      }
    }
    qrScanRafId = requestAnimationFrame(tick);
  };
  qrScanRafId = requestAnimationFrame(tick);
}
function stopQrScan() {
  if (qrScanRafId) { cancelAnimationFrame(qrScanRafId); qrScanRafId = null; }
  if (qrScanStream) { qrScanStream.getTracks().forEach((t) => t.stop()); qrScanStream = null; }
  const video = $("#qr-scan-video"); if (video) video.srcObject = null;
}
function wireQrButtons() {
  const showBtn = $("#show-my-qr-btn");
  if (showBtn) showBtn.addEventListener("click", () => {
    const sheet = $("#my-qr-sheet"); if (sheet) sheet.classList.remove("hidden");
    renderMyQrCode();
  });
  const scanBtn = $("#scan-qr-btn");
  if (scanBtn) scanBtn.addEventListener("click", () => { startQrScan(); });
  const scanSheet = $("#scan-qr-sheet");
  if (scanSheet) {
    scanSheet.querySelectorAll(".sheet-cancel, .sheet-backdrop").forEach((el) => {
      el.addEventListener("click", stopQrScan);
    });
  }
}

function wireGroupInfo() {
  const renameInput = $("#group-info-name");
  const renameBtn = $("#group-info-rename-btn");
  if (renameBtn) renameBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; if (!groupId) return;
    renameGroup(groupId, renameInput ? renameInput.value : "");
    toast(T("toast.saved"));
  });
  const addBtn = $("#group-info-add-btn");
  if (addBtn) addBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; const g = state.contacts.get(groupId);
    if (!g) return;
    if (g.members.length >= MAX_GROUP_MEMBERS) { toast(T("toast.groupTooBig", { max: MAX_GROUP_MEMBERS })); return; }
    const list = $("#forward-list"); if (!list) return;
    list.innerHTML = "";
    const memberIds = new Set(g.members.map((m) => m.id));
    const candidates = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c) && !memberIds.has(c.id));
    for (const c of candidates) {
      const row = document.createElement("button");
      row.type = "button"; row.className = "forward-row";
      row.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div><span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span>`;
      row.addEventListener("click", () => {
        const fs = $("#forward-sheet"); if (fs) fs.classList.add("hidden");
        addGroupMember(groupId, c.id);
        openGroupInfo(groupId);
      });
      list.appendChild(row);
    }
    const gis = $("#group-info-sheet"); if (gis) gis.classList.add("hidden");
    const fs = $("#forward-sheet"); if (fs) fs.classList.remove("hidden");
  });
  const leaveBtn = $("#group-info-leave-btn");
  if (leaveBtn) leaveBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; const g = state.contacts.get(groupId);
    if (!g) return;
    if (!confirm(T("group.confirmLeave", { name: g.name }))) return;
    removeGroupMember(groupId, Store.myId, true);
    const gis = $("#group-info-sheet"); if (gis) gis.classList.add("hidden");
    if (state.chatId === groupId) { state.chatId = null; renderTab(); }
  });
}

function wireConnectScreen() {
  const newGroupBtn = $("#new-group-btn");
  if (newGroupBtn) newGroupBtn.addEventListener("click", () => {
    const nameInput = $("#new-group-name"); if (nameInput) nameInput.value = "";
    const list = $("#new-group-members");
    if (list) {
      list.innerHTML = "";
      const candidates = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c));
      if (candidates.length === 0) {
        const p = document.createElement("p");
        p.className = "fine muted";
        p.textContent = T("group.noContacts");
        list.appendChild(p);
      }
      for (const c of candidates) {
        const row = document.createElement("label");
        row.className = "forward-row";
        row.innerHTML = `<input type="checkbox" value="${escapeHtml(c.id)}" class="group-member-check" /><div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div><span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span>`;
        list.appendChild(row);
      }
    }
    const sheet = $("#new-group-sheet"); if (sheet) sheet.classList.remove("hidden");
  });
  const newGroupCreateBtn = $("#new-group-create-btn");
  if (newGroupCreateBtn) newGroupCreateBtn.addEventListener("click", () => {
    const name = ($("#new-group-name") || {}).value || "";
    const checked = $$(".group-member-check:checked").map((el) => el.value);
    if (checked.length === 0) { toast(T("toast.groupNeedsMembers")); return; }
    if (checked.length > MAX_GROUP_MEMBERS - 1) { toast(T("toast.groupTooBig", { max: MAX_GROUP_MEMBERS })); return; }
    const groupId = createGroup(name, checked);
    if (!groupId) return;
    const sheet = $("#new-group-sheet"); if (sheet) sheet.classList.add("hidden");
    state.chatId = groupId;
    renderTab();
  });
  const addBtn = $("#add-contact-btn");
  if (addBtn) addBtn.addEventListener("click", async () => {
    const nameVal = $("#add-contact-name").value.trim();
    const raw = $("#add-contact-value").value.trim();
    if (!raw) { toast(T("toast.emptyId")); return; }
    let identity;
    try { identity = await Identity.idFor(raw); }
    catch (e) { toast(e.message); return; }
    if (identity.id === Store.myId) { toast(T("toast.ownId")); return; }
    if (state.contacts.has(identity.id)) toast(T("toast.alreadyAdded"));
    else {
      state.contacts.set(identity.id, {
        id: identity.id, name: nameVal || identity.normalized, raw: identity.normalized,
        managed: true, publicKey: null, online: onlineSet.has(identity.id),
        status: "disconnected", messages: [], lastActivity: Date.now(),
        archived: false, muted: false, blocked: false,
      });
      persistContacts();
      toast(T("toast.contactAdded"));
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
    toggleManual.textContent = sec.classList.contains("hidden") ? T("connect.manual") : T("connect.manual.hide");
  });
  const createBtn = $("#create-invite-btn");
  if (createBtn) createBtn.addEventListener("click", createInvite);
  const copyCode = $("#copy-code-btn");
  if (copyCode) copyCode.addEventListener("click", () => { const el = $("#invite-code-out"); if (el) copyText(el.textContent, T("toast.codeCopied")); });
  const copyLink = $("#copy-link-btn");
  if (copyLink) copyLink.addEventListener("click", () => { const el = $("#invite-link-out"); if (el) copyText(el.textContent, T("toast.linkCopied")); });
  const share = $("#share-link-btn");
  if (share) share.addEventListener("click", async () => {
    const el = $("#invite-link-out"); if (!el) return;
    const url = el.textContent;
    if (navigator.share) { try { await navigator.share({ title: T("app.name"), url }); } catch (e) {} }
    else copyText(url, T("toast.linkCopied"));
  });
  const completeBtn = $("#complete-invite-btn");
  if (completeBtn) completeBtn.addEventListener("click", async () => {
    const code = $("#answer-code-in").value.trim();
    if (!code || !state.pendingOutgoing) return;
    try {
      const packet = await SignalingCodec.decode(code);
      if (packet.t !== "answer") throw new Error("not answer");
      const link = mesh.get(state.pendingOutgoing.id);
      if (!link) { resetConnectScreen(); return; }
      await link.acceptAnswer(packet);
      $("#answer-code-in").value = "";
      toast(T("toast.callAccepted"));
    } catch (e) { toast(String(e.message)); }
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
  if (answerCopy) answerCopy.addEventListener("click", () => { const el = $("#answer-out-code"); if (el) copyText(el.textContent, T("toast.codeCopied")); });
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
  state.contacts.set(id, { id, name: "…", raw: "", managed: false, online: false, status: "awaiting-answer", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false });
  const ii = $("#invite-idle"); if (ii) ii.classList.add("hidden");
  const ia = $("#invite-active"); if (ia) ia.classList.remove("hidden");
  const co = $("#invite-code-out"); if (co) co.textContent = code;
  const lo = $("#invite-link-out"); if (lo) lo.textContent = shareLink;
}
async function handleIncomingCode(code) {
  let packet;
  try { packet = await SignalingCodec.decode(code); }
  catch (e) { return; }
  if (packet.t === "offer") {
    const id = crypto.randomUUID();
    const link = mesh.createIncomingLink(id);
    const answerPacket = await link.acceptOfferAndCreateAnswer(packet);
    const answerCode = await SignalingCodec.encode(answerPacket);
    state.contacts.set(id, { id, name: packet.n || T("sys.someone"), raw: "", managed: false, online: false, status: "connecting", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false });
    state.tab = "connect"; renderTab();
    const ms = $("#manual-section"); if (ms) ms.classList.remove("hidden");
    const tm = $("#toggle-manual-btn"); if (tm) tm.textContent = T("connect.manual.hide");
    const ib = $("#incoming-banner"); if (ib) ib.classList.remove("hidden");
    const ibt = $("#incoming-banner-text"); if (ibt) ibt.textContent = packet.n || "";
    const aoc = $("#answer-out-code"); if (aoc) aoc.textContent = answerCode;
    const aow = $("#answer-out-wrap"); if (aow) aow.classList.remove("hidden");
    const pcw = $("#paste-code-wrap"); if (pcw) pcw.classList.add("hidden");
  }
}
function copyText(text, msg) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => toast(T("toast.copyFailed")));
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
  const groupCtx = isGroup(c);
  const bar = $("#reaction-bar");
  if (bar) {
    bar.innerHTML = "";
    if (!groupCtx) {
      for (const emoji of REACTION_EMOJIS) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "reaction-emoji"; b.textContent = emoji;
        b.addEventListener("click", () => { const ms = $("#message-sheet"); if (ms) ms.classList.add("hidden"); toggleReaction(contactId, msgId, emoji); });
        bar.appendChild(b);
      }
    }
  }
  const isOwn = m.from === "me";
  const body = $("#message-sheet-body"); if (!body) return;
  const actions = [];
  actions.push(`<button type="button" class="sheet-action" data-action="reply">${escapeHtml(T("chat.reply"))}</button>`);
  // Пересылка, редактирование-с-уведомлением, "удалить у обоих" и
  // реакции рассчитаны на одного получателя (используют тот же путь
  // доставки, что обычные 1-к-1 сообщения) — на группу с несколькими
  // получателями это не рассчитано, честно не предлагаем, а не ломаем
  // тихо. Локальные действия (копировать, удалить у себя) — безопасны
  // всегда.
  if (!groupCtx) actions.push(`<button type="button" class="sheet-action" data-action="forward">${escapeHtml(T("chat.forward"))}</button>`);
  actions.push(`<button type="button" class="sheet-action" data-action="copy">${escapeHtml(T("chat.copy"))}</button>`);
  if (m.ack === "failed" && isOwn) actions.push(`<button type="button" class="sheet-action" data-action="retry">${escapeHtml(T("chat.retry"))}</button>`);
  if (isOwn) {
    if (!groupCtx) actions.push(`<button type="button" class="sheet-action" data-action="edit">${escapeHtml(T("chat.edit"))}</button>`);
    actions.push(`<button type="button" class="sheet-action destructive" data-action="delete-local">${escapeHtml(T("chat.delete.local"))}</button>`);
    if (!groupCtx) actions.push(`<button type="button" class="sheet-action destructive" data-action="delete-both">${escapeHtml(T("chat.delete.both"))}</button>`);
  } else {
    actions.push(`<button type="button" class="sheet-action destructive" data-action="delete-local">${escapeHtml(T("chat.delete.local"))}</button>`);
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
  if (action === "copy") copyText(m.text || "", T("toast.msgCopied"));
  else if (action === "edit") startEditing(msgId);
  else if (action === "delete-local") deleteMessageLocal(contactId, msgId);
  else if (action === "delete-both") {
    if (!confirm(T("chat.delete.both") + "?")) return;
    await deleteMessageForBoth(contactId, msgId);
  } else if (action === "reply") {
    state.replyTo = { msgId: m.id, text: m.text, from: m.from, authorName: m.from === "me" ? (Store.name || "") : (m.fromName || c.name || "") };
    showReplyBanner();
    const inp = $("#chat-input"); if (inp) inp.focus();
  } else if (action === "forward") openForwardSheet((toId) => forwardMessage(msgId, contactId, toId));
  else if (action === "retry") {
    m.serverAcked = false;
    if (outbox.has(msgId)) { flushOutboxItem(msgId); }
    else { addToOutbox(msgId, contactId, { kind: "chat", id: msgId, text: m.text, ts: m.ts }); flushOutboxItem(msgId); }
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
function openForwardSheet(onPick) {
  const list = $("#forward-list"); if (!list) return;
  list.innerHTML = "";
  const contacts = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c));
  for (const c of contacts) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "forward-row";
    btn.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div><span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span>`;
    btn.addEventListener("click", async () => { const fs = $("#forward-sheet"); if (fs) fs.classList.add("hidden"); await onPick(c.id); });
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
    toast(T("toast.nameUpdated"));
  });
}
function deleteContact(id) {
  clearAutoConnectTimer(id);
  mesh.remove(id);
  const c0 = state.contacts.get(id);
  if (c0) cleanupExpiredFileBlobs(c0.messages);
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
  toast(T("toast.contactDeleted"));
}
function exportChat(contactId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const lines = c.messages.map((m) => {
    const who = m.from === "me" ? (Store.name || "") : (c.name || "");
    const date = new Date(m.ts).toLocaleString(I18N.current);
    const react = m.reactions ? " " + Object.keys(m.reactions).join("") : "";
    return `[${date}] ${who}: ${m.text}${react}`;
  });
  const text = (c.name || "") + "\n\n" + lines.join("\n");
  downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `ether-${contactId.slice(0, 8)}-${Date.now()}.txt`);
  toast(T("toast.exportDone"));
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
  if (rec.status === "completed") return `${T("status.inCall")} · ${formatDuration(rec.durationMs)}`;
  if (rec.status === "declined") return T("calls.declined");
  if (rec.status === "missed") return T("calls.missed");
  if (rec.status === "cancelled") return T("calls.cancelled");
  if (rec.status === "failed") return T("calls.failed");
  if (rec.status === "busy") return T("calls.busy");
  if (rec.status === "ringing") return T("calls.noAnswer");
  return T("calls.incoming");
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
    const name = (c && c.name) || rec.contactName || T("sys.someone");
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
      <button type="button" class="call-back-btn" aria-label="Call" ${c ? "" : "disabled"}>
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.7 21 3 13.3 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8z"/></svg>
      </button>`;
    const backBtn = row.querySelector(".call-back-btn");
    if (backBtn && c) backBtn.addEventListener("click", (e) => { e.stopPropagation(); beginCall(rec.contactId); });
    row.addEventListener("click", () => { if (state.contacts.has(rec.contactId)) { state.chatId = rec.contactId; renderTab(); } });
    list.appendChild(row);
  }
}
function clearPendingCall() { if (pendingCall.timer) clearTimeout(pendingCall.timer); pendingCall.timer = null; pendingCall.contactId = null; }

async function beginCall(id, withVideo) {
  const c = state.contacts.get(id);
  if (!c) return;
  if (isGroup(c)) { toast(T("toast.callGroupsUnsupported")); return; }
  if (c.blocked) { toast(T("toast.blocked")); return; }
  if (state.callId && state.callId !== id) { return; }
  if (state.callId === id) { openCallScreen(id, state.callPhase || "calling"); return; }

  etherLog("info", "[call] beginCall to " + String(id).slice(0, 10) + "…");
  state._callUserAccepted = false;
  state._callAcceptInFlight = false;
  state._callMuteOnAnswer = false;
  state._callDeadSeconds = 0;
  state.callWantsVideo = !!withVideo;

  openCallScreen(id, "calling");
  playDialingSound();

  if (!signaling || !signaling.connected) {
    toast(T("toast.noServer"));
    closeCallScreen("failed");
    return;
  }

  signaling.signal(id, { t: "call-invite", n: Store.name });

  const link = mesh.get(id);
  if (link && isReachable(c)) {
    try { await link.startCall(withVideo); if (withVideo) showLocalVideoPreview(link); }
    catch (e) { toast(T("toast.noServer")); closeCallScreen("failed"); return; }
    return;
  }

  clearPendingCall();
  pendingCall.contactId = id;
  attemptConnect(id);
  pendingCall.timer = setTimeout(() => {
    if (pendingCall.contactId !== id) return;
    if (state.callId !== id) return;
    if (state.callPhase === "active") return;
    clearPendingCall();
    const l = mesh.get(id);
    if (l) l.endCall();
    if (signaling && signaling.connected) {
      try { signaling.signal(id, { t: "call-ended" }); } catch (e) {}
    }
    toast(T("calls.noAnswer"));
    playNoAnswerSound();
    closeCallScreen("cancelled");
  }, PENDING_CALL_TIMEOUT_MS);
}

function openCallScreen(id, phase) {
  if (state.callId !== id) {
    state._callUserAccepted = false;
    state._callAcceptInFlight = false;
    state._callMuteOnAnswer = false;
  }
  state.callId = id;
  state.callPhase = phase;
  try { ensureAudioCtx(); } catch (e) {}
  const muteBtn = $("#call-mute-btn");
  if (muteBtn) {
    muteBtn.classList.remove("active");
    const lbl = $("#call-mute-label");
    if (lbl) lbl.textContent = T("call.mute");
  }
  const c = state.contacts.get(id);
  const cs = $("#call-screen"); if (cs) cs.classList.remove("hidden");
  const pn = $("#call-peer-name"); if (pn) pn.textContent = (c && c.name) || T("sys.someone");
  const pa = $("#call-peer-avatar"); if (pa) { pa.style.background = avatarGradient((c && c.name) || "?"); pa.textContent = initials((c && c.name) || "?"); }
  const cp = $("#call-phase"); if (cp) cp.textContent = phase === "calling" ? T("call.calling") : phase === "ringing" ? T("call.incoming") : T("call.active");
  const incoming = phase === "ringing";
  const ci = $("#call-controls-incoming"); if (ci) ci.classList.toggle("hidden", !incoming);
  const ca = $("#call-controls-active"); if (ca) ca.classList.toggle("hidden", incoming);
  // Уровень громкости.
  const vs = $("#call-volume-slider"); if (vs) vs.value = String(Store.callVolume);
  clearInterval(callTimerInterval);
  if (phase === "active") startCallTimer();

  if (phase === "ringing") {
    clearPendingCall();
    pendingCall.contactId = id;
    pendingCall.timer = setTimeout(() => {
      if (state.callId !== id) return;
      if (state.callPhase !== "ringing") return;
      try { const l = mesh.get(id); if (l) l.endCall(); } catch (e) {}
      if (signaling && signaling.connected) {
        try { signaling.signal(id, { t: "call-ended" }); } catch (e) {}
      }
      toast(T("toast.missedCall"));
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
  state._callUserAccepted = true;
  clearPendingCall();
  stopCallSounds();
  const ci = $("#call-controls-incoming"); if (ci) ci.classList.add("hidden");
  const ca = $("#call-controls-active"); if (ca) ca.classList.remove("hidden");
  startCallTimer();
  updateCallRecordStatus("active");
  if (state.callId && pendingRemoteStreams.has(state.callId)) {
    const stream = pendingRemoteStreams.get(state.callId);
    attachRemoteAudio(state.callId, stream);
    if (stream.getVideoTracks().length > 0) attachRemoteVideo(state.callId, stream);
    pendingRemoteStreams.delete(state.callId);
  }
}

function attachRemoteAudio(id, stream) {
  if (!stream) { etherLog("warn", "[audio] empty stream"); return; }
  let audioEl = document.getElementById("remote-audio-" + id);
  if (!audioEl) {
    audioEl = document.createElement("audio");
    audioEl.id = "remote-audio-" + id;
    audioEl.autoplay = true;
    audioEl.setAttribute("playsinline", "");
    audioEl.hidden = true;
    document.body.appendChild(audioEl);
  }
  audioEl.volume = Store.callVolume;
  audioEl.srcObject = stream;
  const p = audioEl.play();
  if (p && p.catch) p.catch(() => {
    const resume = () => { try { audioEl.play().catch(() => {}); } catch (e) {} };
    document.addEventListener("touchstart", resume, { once: true });
    document.addEventListener("click", resume, { once: true });
  });
  const sl = $("#call-volume-slider"); if (sl) sl.value = String(Store.callVolume);
}
function attachRemoteVideo(id, stream) {
  if (state.callId !== id) return;
  const videoTracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
  if (videoTracks.length === 0) return;
  const v = $("#call-remote-video");
  if (!v) return;
  v.srcObject = stream;
  v.classList.remove("hidden");
  const cs = $("#call-screen"); if (cs) cs.classList.add("video-active");
  const p = v.play(); if (p && p.catch) p.catch(() => {});
}
function showLocalVideoPreview(link) {
  const v = $("#call-local-video");
  if (!v || !link || !link.localStream) return;
  v.srcObject = link.localStream;
  v.classList.remove("hidden");
  const cs = $("#call-screen"); if (cs) cs.classList.add("video-active");
  const p = v.play(); if (p && p.catch) p.catch(() => {});
  const switchBtn = $("#call-switch-camera-btn"); if (switchBtn) switchBtn.classList.remove("hidden");
  const videoBtn = $("#call-video-btn"); if (videoBtn) videoBtn.classList.add("active");
}
function hideCallVideo() {
  const rv = $("#call-remote-video"); if (rv) { rv.classList.add("hidden"); rv.srcObject = null; }
  const lv = $("#call-local-video"); if (lv) { lv.classList.add("hidden"); lv.srcObject = null; }
  const cs = $("#call-screen"); if (cs) cs.classList.remove("video-active");
  const switchBtn = $("#call-switch-camera-btn"); if (switchBtn) switchBtn.classList.add("hidden");
  const videoBtn = $("#call-video-btn"); if (videoBtn) videoBtn.classList.remove("active");
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
    const cid = state.callId;
    if (!cid) { state._callDeadSeconds = 0; return; }
    const link = mesh.get(cid);
    const alive = link && (link.status === "connected" || link.status === "in-call");
    if (alive) { state._callDeadSeconds = 0; return; }
    state._callDeadSeconds = (state._callDeadSeconds || 0) + 1;
    if (state._callDeadSeconds * 1000 >= CALL_DEAD_LINK_TIMEOUT_MS) {
      closeCallScreen("completed");
    }
  }, 1000);
}

// Системные сообщения обо ВСЕХ звонках — в обе стороны.
function systemMessageForCall(rec, reason) {
  if (!rec) return null;
  const isOut = rec.direction === "out";
  if (reason === "completed" && rec.answeredAt) {
    const d = formatDuration(rec.durationMs || 0);
    return `${isOut ? T("calls.outgoing") : T("calls.incoming")} · ${d}`;
  }
  if (reason === "missed") {
    return isOut ? T("calls.noAnswer") : T("calls.missed");
  }
  if (reason === "cancelled") return T("calls.cancelled");
  if (reason === "declined") return T("calls.declined");
  if (reason === "busy") return T("calls.busy");
  if (reason === "failed") return T("calls.failed");
  return null;
}

function closeCallScreen(reason) {
  const rec = state.currentCallRecord;
  clearInterval(callTimerInterval); callTimerInterval = null;
  state._callDeadSeconds = 0;
  state._callAcceptInFlight = false;
  state._callUserAccepted = false;
  state._callMuteOnAnswer = false;
  state.callWantsVideo = false;
  clearPendingCall();
  stopRingtone();
  stopCallSounds();
  hideCallVideo();
  endCallRecord(reason);
  const cs = $("#call-screen"); if (cs) cs.classList.add("hidden");
  const cm = $("#call-mute-btn"); if (cm) cm.classList.remove("active");
  const lbl = $("#call-mute-label"); if (lbl) lbl.textContent = T("call.mute");
  if (state.callId) pendingRemoteStreams.delete(state.callId);
  state.callId = null;
  state.callPhase = null;
  if (state.tab === "calls") renderCallsList();

  if (rec && rec.contactId) {
    const c = state.contacts.get(rec.contactId);
    if (c) {
      const text = systemMessageForCall(rec, reason);
      if (text) {
        c.messages.push({ id: crypto.randomUUID(), from: "system", text, ts: Date.now() });
        c.lastActivity = Date.now();
        persistContacts();
        if (state.chatId === rec.contactId) renderChatThread();
        if (state.tab === "chats") renderChatsList();
      }
    }
  }
}
function wireCallScreen() {
  const hangup = $("#call-hangup-btn");
  if (hangup) hangup.addEventListener("click", () => {
    const cid = state.callId;
    const link = mesh.get(cid);
    if (link) {
      try { link.endCall(); } catch (e) {}
      try { mesh.remove(cid); } catch (e) {}
    }
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
    if (lbl) lbl.textContent = muted ? T("call.mute.off") : T("call.mute");
  });
  const videoBtn = $("#call-video-btn");
  if (videoBtn) videoBtn.addEventListener("click", async () => {
    const link = mesh.get(state.callId); if (!link) return;
    const turningOn = !videoBtn.classList.contains("active");
    if (turningOn) {
      const ok = await link.enableVideo();
      if (ok) { state.callWantsVideo = true; showLocalVideoPreview(link); }
      else toast(T("toast.videoNoCamera"));
    } else {
      link.disableVideo();
      const lv = $("#call-local-video"); if (lv) { lv.classList.add("hidden"); lv.srcObject = null; }
      videoBtn.classList.remove("active");
      const switchBtn = $("#call-switch-camera-btn"); if (switchBtn) switchBtn.classList.add("hidden");
    }
  });
  const switchCamBtn = $("#call-switch-camera-btn");
  if (switchCamBtn) switchCamBtn.addEventListener("click", () => {
    const link = mesh.get(state.callId); if (link) link.switchCamera();
  });
  const accept = $("#call-accept-btn");
  if (accept) accept.addEventListener("click", () => acceptCall(false));
  const muteAccept = $("#call-mute-accept-btn");
  if (muteAccept) muteAccept.addEventListener("click", () => acceptCall(true));
  const decline = $("#call-decline-btn");
  if (decline) decline.addEventListener("click", () => {
    const cid = state.callId;
    const link = mesh.get(cid); if (link) link.declineCall();
    if (signaling && signaling.connected && cid) signaling.signal(cid, { t: "call-declined" });
    stopRingtone();
    closeCallScreen("declined");
  });
  const vs = $("#call-volume-slider");
  if (vs) {
    vs.value = String(Store.callVolume);
    vs.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      Store.callVolume = v;
      const cid = state.callId;
      if (cid) {
        const link = mesh.get(cid);
        if (link && link.setRemoteVolume) link.setRemoteVolume(v);
        const el = document.getElementById("remote-audio-" + cid);
        if (el) el.volume = v;
      }
    });
  }
}

async function acceptCall(withMute) {
  if (state._callUserAccepted) return;
  if (state._callAcceptInFlight) return;
  const cid = state.callId;
  if (!cid) return;

  state._callAcceptInFlight = true;
  state._callUserAccepted = true;
  state._callMuteOnAnswer = !!withMute;

  try {
    stopRingtone();
    if (signaling && signaling.connected) {
      try { signaling.signal(cid, { t: "call-accepted" }); } catch (e) {}
    }
    const c = state.contacts.get(cid);
    const link = mesh.get(cid);

    if (link && c && isReachable(c)) {
      try {
        await link.answerCall();
        if (withMute) {
          link.setMuted(true);
          const mb = $("#call-mute-btn");
          if (mb) {
            mb.classList.add("active");
            const lbl = $("#call-mute-label");
            if (lbl) lbl.textContent = T("call.mute.off");
          }
        }
        setCallPhaseActive();
      } catch (e) {
        etherLog("error", "[call] answerCall failed:", String(e));
      }
      return;
    }
    // Соединение недоступно ровно в момент принятия — не показываем ложный
    // "звонок принят", а честно закрываем экран как несостоявшийся звонок.
    toast(T("calls.failed"));
    closeCallScreen("failed");
  } catch (e) {
    etherLog("error", "[call] accept handler failed:", String(e));
  } finally {
    state._callAcceptInFlight = false;
  }
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
  el.textContent = n > 0 ? String(n) : "—";
}

// =====================================================================
// Настройки
// =====================================================================
function wireSettingsScreen() {
  const nameEl = $("#settings-name");
  if (nameEl) nameEl.addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) { Store.name = v; toast(T("toast.nameUpdated")); initSignaling(); }
  });
  const idEl = $("#settings-identity");
  if (idEl) idEl.addEventListener("change", async (e) => {
    const v = e.target.value.trim(); if (!v) return;
    try {
      const identity = await Identity.idFor(v);
      Store.myIdentityRaw = identity.normalized;
      Store.myId = identity.id;
      toast(T("toast.idUpdated"));
      initSignaling();
    } catch (err) { toast(err.message); e.target.value = Store.myIdentityRaw; }
  });
  const save = $("#save-signaling-btn");
  if (save) save.addEventListener("click", () => {
    const el = $("#settings-signaling-url");
    if (el) Store.signalingUrl = el.value.trim();
    initSignaling(); toast(T("toast.saved"));
  });
  const disc = $("#settings-discoverable");
  if (disc) disc.addEventListener("change", (e) => {
    Store.discoverable = e.target.checked; initSignaling();
  });
  const sounds = $("#settings-sounds");
  if (sounds) sounds.addEventListener("change", (e) => {
    Store.soundsEnabled = e.target.checked;
  });
  const ringtoneSel = $("#settings-ringtone");
  if (ringtoneSel) {
    ringtoneSel.value = Store.ringtone;
    ringtoneSel.addEventListener("change", (e) => { Store.ringtone = e.target.value; });
  }
  const ringtonePreview = $("#settings-ringtone-preview");
  if (ringtonePreview) ringtonePreview.addEventListener("click", () => {
    try {
      const el = getSoundEl(currentRingtoneSrc(), false);
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
      setTimeout(() => { try { el.pause(); el.currentTime = 0; } catch (e) {} }, 3000);
    } catch (e) {}
  });
  const linkPreviews = $("#settings-link-previews");
  if (linkPreviews) linkPreviews.addEventListener("change", (e) => {
    Store.linkPreviewsEnabled = e.target.checked;
  });
  const pinlock = $("#settings-pinlock");
  if (pinlock) pinlock.addEventListener("change", (e) => {
    const st = $("#set-pin-title"); if (st) st.textContent = T("pin.newTitle");
    const si = $("#set-pin-input"); if (si) si.value = "";
    const ss = $("#set-pin-sheet"); if (ss) ss.classList.remove("hidden");
    setTimeout(() => { const i = $("#set-pin-input"); if (i) i.focus(); }, 50);
  });
  const pinSave = $("#set-pin-save-btn");
  if (pinSave) pinSave.addEventListener("click", async () => {
    const inp = $("#set-pin-input"); if (!inp) return;
    const v = inp.value.trim();
    if (!v || v.length < 4) { toast(T("toast.pinShort")); return; }
    if (!/^\d+$/.test(v)) { toast(T("toast.pinDigits")); return; }
    if ($("#settings-pinlock").checked) {
      if (Store.pinHash) {
        const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
        if (h !== Store.pinHash) { toast(T("toast.pinWrong")); return; }
        const st = $("#set-pin-title"); if (st) st.textContent = T("pin.newTitle");
        inp.value = "";
        return;
      }
      Store.pinSalt = randomSaltHex(16);
      Store.pinHash = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      Store.pinEnabled = true;
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
      toast(T("toast.pinOn"));
    } else {
      const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      if (h !== Store.pinHash) { toast(T("toast.pinWrong")); return; }
      Store.pinEnabled = false;
      Store.pinHash = "";
      Store.pinSalt = "";
      const pl = $("#settings-pinlock"); if (pl) pl.checked = false;
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
      toast(T("toast.pinOff"));
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
  if (diagC) diagC.addEventListener("click", () => copyText(buildDiagnosticsText(), T("toast.msgCopied")));

  const webrtcBtn = $("#webrtc-debug-btn");
  if (webrtcBtn) webrtcBtn.addEventListener("click", () => { renderWebRtcSheet(); const el = $("#webrtc-sheet"); if (el) el.classList.remove("hidden"); });
  const webrtcClose = $("#webrtc-close");
  if (webrtcClose) webrtcClose.addEventListener("click", () => { const el = $("#webrtc-sheet"); if (el) el.classList.add("hidden"); });
  const webrtcRefresh = $("#webrtc-refresh-btn");
  if (webrtcRefresh) webrtcRefresh.addEventListener("click", renderWebRtcSheet);
  const webrtcCopy = $("#webrtc-copy-btn");
  if (webrtcCopy) webrtcCopy.addEventListener("click", () => copyText(buildWebRtcText(), T("toast.msgCopied")));

  const logsBtn = $("#debug-logs-btn");
  if (logsBtn) logsBtn.addEventListener("click", () => { renderLogsSheet(); const el = $("#logs-sheet"); if (el) el.classList.remove("hidden"); });
  const logsClose = $("#logs-close");
  if (logsClose) logsClose.addEventListener("click", () => { const el = $("#logs-sheet"); if (el) el.classList.add("hidden"); });
  const logsCopy = $("#logs-copy-btn");
  if (logsCopy) logsCopy.addEventListener("click", () => copyText(buildLogsText(), T("toast.msgCopied")));
  const logsClear = $("#logs-clear-btn");
  if (logsClear) logsClear.addEventListener("click", () => { window.__etherDiag = []; renderLogsSheet(); });

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
    if (!confirm(T("toast.confirmDeleteContact", { name: "?" }))) return;
    for (const id of Array.from(state.contacts.keys())) mesh.remove(id);
    for (const t of autoConnectTimers.values()) clearTimeout(t);
    autoConnectTimers.clear();
    onlineSet.clear(); outbox.clear(); pendingNoKey.clear(); seenDeliverIds.clear();
    state.contacts.clear(); state.callLog = []; state.currentCallRecord = null;
    state.lastSeen = {}; state.drafts = {};
    Store.contactsJson = "[]"; Store.outboxJson = "[]"; Store.pendingNoKeyJson = "{}";
    Store.callLogJson = "[]"; Store.lastSeenJson = "{}"; Store.draftsJson = "{}";
    resetConnectScreen(); renderTab();
  });
  const hard = $("#debug-hard-reset-btn");
  if (hard) hard.addEventListener("click", () => {
    if (!confirm(T("toast.confirmHardReset"))) return;
    localStorage.clear();
    if ("caches" in window) caches.keys().then((names) => names.forEach((n) => caches.delete(n)));
    if ("indexedDB" in window) try { indexedDB.deleteDatabase("ether-db"); } catch (e) {}
    location.reload();
  });
  const hideToggle = $("#debug-hide-toggle");
  if (hideToggle) hideToggle.addEventListener("change", (e) => {
    Store.debugHidden = e.target.checked;
    applyDebugTabVisibility();
  });
}
function renderLogsSheet() { const el = $("#logs-content"); if (el) el.textContent = buildLogsText(); }
function buildLogsText() {
  const log = window.__etherDiag || [];
  const lines = [];
  for (const entry of log.slice(-300)) {
    const d = new Date(entry.ts);
    const stamp = `${d.toLocaleTimeString(I18N.current)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    lines.push(`[${stamp}] [${entry.level}] ${entry.line}`);
  }
  return lines.join("\n");
}
function renderStorageSheet() {
  const el = $("#storage-summary"); if (!el) return;
  const items = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("ether.")) continue;
    const v = localStorage.getItem(k) || "";
    items.push({ key: k, size: v.length });
  }
  items.sort((a, b) => b.size - a.size);
  const totalBytes = items.reduce((s, x) => s + x.size, 0);
  el.innerHTML = `<div>localStorage: ${(totalBytes / 1024).toFixed(1)} KB, ${items.length} keys</div>` + buildEnvText();
}
function buildEnvText() {
  return `<hr><div>UA: ${escapeHtml(navigator.userAgent)}</div>`;
}
function buildDiagnosticsText() {
  const lines = [];
  lines.push("Ether — diagnostics");
  lines.push("Time: " + new Date().toLocaleString(I18N.current));
  lines.push("Lang: " + I18N.current + " / sys " + I18N.systemLang());
  lines.push("My id: " + (Store.myId ? Store.myId.slice(0, 16) + "…" : "—"));
  lines.push("Signaling: " + effectiveSignalingUrl());
  lines.push("Status: " + (signaling ? (signaling.connected ? "on" : "off") : "—"));
  lines.push("Online: " + onlineSet.size);
  lines.push("outbox: " + outbox.size + ", pendingNoKey: " + pendingNoKey.size);
  lines.push("Call: " + (state.callId ? state.callId.slice(0, 10) + " phase=" + state.callPhase : "—"));
  return lines.join("\n");
}
function renderDiagnostics() {
  const log = $("#diagnostics-log"); if (log) log.textContent = buildDiagnosticsText();
}
function renderWebRtcSheet() { const el = $("#webrtc-content"); if (el) el.textContent = buildWebRtcText(); }
function buildWebRtcText() {
  const lines = [];
  if (!mesh || mesh.links.size === 0) { lines.push("(no peers)"); return lines.join("\n"); }
  for (const link of mesh.links.values()) {
    const d = link.getDiagnostics();
    lines.push("--- " + String(d.id).slice(0, 14) + "… ---");
    lines.push("role: " + d.role + ", status: " + d.status);
    lines.push("pc: " + d.pcState + ", ice: " + d.iceState + ", dc: " + d.dcState);
    lines.push("");
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
  toast(T("toast.backupSaved"));
}
async function importBackup(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("bad");
    if (!confirm(T("toast.confirmHardReset"))) return;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("ether.")) localStorage.removeItem(k);
    }
    for (const k of Object.keys(data)) if (k.startsWith("ether.")) localStorage.setItem(k, data[k]);
    toast(T("toast.imported"));
    setTimeout(() => location.reload(), 800);
  } catch (e) { toast(String(e.message)); }
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
        toast(T("toast.peerOnline", { name: c.name }));
        clearAutoConnectTimer(id);
        if (state.pendingOutgoing && state.pendingOutgoing.id === id) resetConnectScreen();

        if (state.callId === id && link) {
          if (state.callPhase === "calling") {
            if (!link._audioAdded) {
              link.startCall(state.callWantsVideo).then(() => { if (state.callWantsVideo) showLocalVideoPreview(link); }).catch((e) => etherLog("error", "[call] caller startCall failed:", String(e)));
            }
          } else if (state._callUserAccepted && state.callPhase !== "active") {
            link.answerCall().then(() => {
              if (state._callMuteOnAnswer) {
                link.setMuted(true);
                const mb = $("#call-mute-btn");
                if (mb) {
                  mb.classList.add("active");
                  const lbl = $("#call-mute-label");
                  if (lbl) lbl.textContent = T("call.mute.off");
                }
                state._callMuteOnAnswer = false;
              }
              setCallPhaseActive();
            }).catch((e) => etherLog("error", "[call] deferred answerCall failed:", String(e)));
          }
        }

        flushOutbox();
      }
      if (status === "disconnected") {
        sendTypingStop(id);
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
          if (state.callId) {
            const l = mesh.get(id);
            if (l) { try { l.declineCall("busy"); } catch (e) {} }
            return;
          }
          openCallScreen(id, "ringing");
          try { ensureAudioCtx(); } catch (e) {}
          playRingtone();
        }
        if (payload.state === "accepted" && state.callId === id) setCallPhaseActive();
        if (payload.state === "declined" && state.callId === id) {
          toast(T("calls.declined"));
          if (payload.reason === "busy") playBusySound(); else playNoAnswerSound();
          const link = mesh.get(id); if (link) link.endCall();
          closeCallScreen("declined");
        }
        if (payload.state === "ended" && state.callId === id) {
          try { const l = mesh.get(id); if (l) l.endCall(); } catch (e) {}
          closeCallScreen("completed");
        }
        return;
      }
      if (payload && payload.kind && String(payload.kind).indexOf("relay-") === 0) {
        handleRelayPayload(id, payload);
        return;
      }
      if (payload && payload.kind && String(payload.kind).indexOf("file-") === 0) {
        handleFilePayload(id, payload);
        return;
      }
      applyIncomingPayload(id, payload && payload.id, payload, false, payload && payload.kind);
    } catch (e) {
      etherLog("error", "[message] handler failed:", String(e && e.stack || e));
    }
  });
  mesh.addEventListener("remote-track", (ev) => {
    try {
      const { id, stream, track } = ev.detail;
      if (state.callId === id && state.callPhase !== "active") { pendingRemoteStreams.set(id, stream); return; }
      attachRemoteAudio(id, stream);
      if (track && track.kind === "video") attachRemoteVideo(id, stream);
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
    else {
      const cc = state.contacts.get(state.chatId);
      if (isGroup(cc)) sendGroupMessage(state.chatId, text, state.replyTo);
      else sendChatMessage(state.chatId, text, state.replyTo);
      cancelReply();
    }
    input.value = "";
    delete state.drafts[state.chatId];
    persistDrafts();
    sendTypingStop(state.chatId);
    updateSendVsMic();
  });
  const attachBtn = $("#chat-attach-btn");
  const fileInput = $("#chat-file-input");
  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => {
      if (!state.chatId) return;
      fileInput.value = "";
      fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file && state.chatId) sendFileMessage(state.chatId, file);
      fileInput.value = "";
    });
  }
  const input = $("#chat-input");
  if (input) {
    let typingSendTimer = null;
    updateSendVsMic();
    input.addEventListener("input", () => {
      updateSendVsMic();
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
  const micBtn = $("#voice-record-btn");
  if (micBtn) micBtn.addEventListener("click", () => { startVoiceRecording(); });
  const voiceCancelBtn = $("#voice-cancel-btn");
  if (voiceCancelBtn) voiceCancelBtn.addEventListener("click", () => stopVoiceRecording(false));
  const voiceSendBtn = $("#voice-send-btn");
  if (voiceSendBtn) voiceSendBtn.addEventListener("click", () => stopVoiceRecording(true));
  const callBtn = $("#chat-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => {
    if (!state.chatId) return;
    beginCall(state.chatId);
  });
  const videoCallBtn = $("#chat-video-call-btn");
  if (videoCallBtn) videoCallBtn.addEventListener("click", () => {
    if (!state.chatId) return;
    beginCall(state.chatId, true);
  });
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
    updateSendVsMic();
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
    try { I18N.init(); } catch (e) {}
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

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    try { updateAppBadge(); } catch (e) {}
    try {
      if (globalAudioCtx && globalAudioCtx.state === "suspended") globalAudioCtx.resume().catch(() => {});
    } catch (e) {}
    if (state.callId) {
      const cs = $("#call-screen");
      if (cs && cs.classList.contains("hidden")) cs.classList.remove("hidden");
      const ci = $("#call-controls-incoming");
      const ca = $("#call-controls-active");
      if (state.callPhase === "ringing") {
        if (ci) ci.classList.remove("hidden");
        if (ca) ca.classList.add("hidden");
      } else if (state.callPhase === "active") {
        if (ci) ci.classList.add("hidden");
        if (ca) ca.classList.remove("hidden");
      }
    }
    if (state.chatId) { const c = state.contacts.get(state.chatId); if (c) markThreadRead(c); }
  }
});