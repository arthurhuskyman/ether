"use strict";

// Держать в синхроне с файлом VERSION в корне проекта и с CACHE_VERSION
// в sw.js при каждом повышении версии — здесь оно только для показа в
// "О приложении" (#about-version), больше нигде не участвует.
const APP_VERSION = "V.31.7";

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
  // Три тумблера приватности — независимы от discoverable (тот про
  // публичный ростер для незнакомцев, эти про то, что видят уже
  // добавленные контакты). Двусторонне: моё значение влияет на то, что
  // видят ОНИ (через P2P privacy-pref payload), не на то, что вижу я
  // сам про них — это решает уже ИХ собственное значение.
  get receiptsEnabled() { return localStorage.getItem("ether.receiptsEnabled") !== "0"; },
  set receiptsEnabled(v) { localStorage.setItem("ether.receiptsEnabled", v ? "1" : "0"); broadcastPrivacyPrefs(); },
  get lastSeenVisible() { return localStorage.getItem("ether.lastSeenVisible") !== "0"; },
  set lastSeenVisible(v) { localStorage.setItem("ether.lastSeenVisible", v ? "1" : "0"); broadcastPrivacyPrefs(); },
  get presenceVisible() { return localStorage.getItem("ether.presenceVisible") !== "0"; },
  set presenceVisible(v) { localStorage.setItem("ether.presenceVisible", v ? "1" : "0"); broadcastPrivacyPrefs(); },
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
  // Быстрые реакции — раньше меню реакций всегда показывало ВСЕ 110
  // эмодзи целиком, самая частая жалоба на перегруженность. Теперь
  // показываем недавно использованные, полная сетка — по кнопке "+".
  get recentReactions() {
    try { const v = JSON.parse(localStorage.getItem("ether.recentReactions") || "[]"); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  },
  set recentReactions(arr) { try { localStorage.setItem("ether.recentReactions", JSON.stringify(arr.slice(0, 6))); } catch (e) {} },
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
  chatsSegment: "chats", // "chats" | "calls" — сегмент внутри вкладки Chats; отдельной вкладки "Звонки" больше нет
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
// Контакт, которого удалили, но который всё ещё онлайн у СЕБЯ (не
// удалил меня в ответ), продолжает периодически слать offer через
// сигнальный сервер по своей собственной логике переподключения
// (scheduleAutoConnect у НЕГО). handleIncomingOffer у меня раньше
// безусловно вызывал ensureContactEntry на любой входящий offer —
// контакт "воскресал" молча при первом же таком пакете после удаления.
// Блокируем повторное создание для явно удалённых id, пока пользователь
// сам, осознанно, не добавит этот id заново через обычный флоу.
const recentlyDeletedIds = new Set();
const autoConnectTimers = new Map();
const recentSignalNonces = new Set();
const outbox = new Map();
const pendingNoKey = new Map();
const seenDeliverIds = new Set(); // ключ — "from|msgId", не голый msgId (см. ниже)
const _connectInFlight = new Set();

const pendingCall = { contactId: null, timer: null };
const pendingRemoteStreams = new Map();
// Отслеживание "новых" сообщений при входе в чат — id первого непрочитанного
// на момент открытия, contactId -> msgId. Пока запись есть, бейдж и
// разделитель "Непрочитанные сообщения" остаются на месте; снимается
// только когда пользователь реально долистал до конца (см. wireChatScreen
// обработчик scroll) — не сразу при открытии чата.
const unreadDividerFor = new Map();
const dividerScrolledFor = new Set(); // раньше scrollIntoView к разделителю срабатывал на КАЖДОМ рендере, пока он не снят — новое сообщение в чате откатывало прокрутку обратно к разделителю; теперь только один раз, на сам вход в чат
let __lastRenderedChatId = null;
let speakerOn = false; // по умолчанию — внутренний динамик (наушник); объявлена здесь, с остальными глобальными переменными, а не рядом с первым использованием
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
    // Уведомления и рингтон должны быть слышны сразу, громко — если ОС
    // по умолчанию направила бы их в наушник (как иногда бывает во время
    // активного звонка), явно просим динамик. Асинхронно, не блокируя
    // немедленное воспроизведение — на первый звук может не успеть,
    // но дальше (элементы переиспользуются из пула) точно сработает.
    if (typeof el.setSinkId === "function") {
      findAudioOutputDevice(/speaker|loud/i).then((deviceId) => {
        if (deviceId) el.setSinkId(deviceId).catch(() => {});
      }).catch(() => {});
    }
  }
  // Не только при создании — unlockSoundPool() на старте создаёт все звуки
  // с loop=false, а playRingtone()/playDialingSound() зовут getSoundEl(src,
  // true) уже НА ЗАКЕШИРОВАННЫЙ элемент. Без этой строки el.loop так и
  // остаётся false навсегда, и рингтон/гудки дозвона не зацикливаются.
  el.loop = !!loop;
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
    let url = m[1];
    let endIdx = m.index + url.length;
    // Regex нарочно не берёт ")" последним символом (чтобы не цеплять
    // закрывающую скобку самого предложения) — но это же обрезает
    // легитимный ")" в конце ссылок вида .../foo_(bar). Досчитываем: если
    // внутри совпадения больше "(" чем ")", а следующий символ в тексте —
    // ")", значит это была часть самого URL, а не пунктуация — включаем.
    while (esc[endIdx] === ")" && (url.match(/\(/g) || []).length > (url.match(/\)/g) || []).length) {
      url += ")";
      endIdx++;
    }
    result += `<a href="${url}" target="_blank" rel="noopener noreferrer">${highlightRaw(url, query)}</a>`;
    lastIdx = endIdx;
    urlRegex.lastIndex = endIdx;
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
const LINK_PREVIEW_CACHE_MAX = 500; // на сервере лимит уже есть, на клиенте — не было вовсе; активная переписка с разными ссылками за сессию иначе растила бы Map без конца
function capMapSize(map, max) {
  if (map.size <= max) return;
  const toRemove = map.size - Math.floor(max * 0.9);
  let removed = 0;
  for (const k of map.keys()) {
    if (removed >= toRemove) break;
    map.delete(k);
    removed++;
  }
}
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
  } finally {
    capMapSize(linkPreviewCache, LINK_PREVIEW_CACHE_MAX);
  }
}
function linkPreviewCardHtml(data) {
  if (!data) return "";
  // data.url приходит от сервера (сам сервер безопасен, но это его
  // scraping чужих страниц) — на случай, если туда просочится что-то
  // вроде javascript:, не полагаемся только на escapeHtml (он не
  // фильтрует схему), а явно проверяем, что это http(s).
  if (!/^https?:\/\//i.test(data.url || "")) return "";
  // <img src="..."> вместо background-image в инлайн-style: у style-строки
  // есть свой контекст парсинга CSS, и в нём escapeHtml('...') экранирует
  // HTML-спецсимволы, но кавычка внутри url('...') после HTML-парсинга
  // всё равно вернётся к CSS-парсеру как есть — теоретическая CSS-
  // инъекция через og:image с чужого сайта. У src атрибута такого
  // контекста нет вовсе.
  const img = data.image && /^https?:\/\//i.test(data.image) ? `<img class="link-preview-img" src="${escapeHtml(data.image)}" alt="" loading="lazy">` : "";
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
    // Раньше document.querySelectorAll сканировал ВЕСЬ документ на каждую
    // ссылку в чате — слоты превью живут только внутри #chat-messages,
    // так что при десятке ссылок это лишний O(N²) обход DOM без пользы.
    const wrap = document.getElementById("chat-messages");
    if (!wrap) return;
    const slots = wrap.querySelectorAll('.link-preview-slot[data-preview-for]');
    const ok = entry && entry.status === "done" && entry.data;
    const html = ok ? linkPreviewCardHtml(entry.data) : "";
    slots.forEach((slot) => {
      if (slot.getAttribute("data-preview-for") !== url) return;
      // Превью не получилось (не только "ещё не готово" — сюда попадаем
      // только после resolve, то есть это финальный статус — включая
      // случай, когда linkPreviewCardHtml() сама вернула пустую строку
      // из-за недопустимой схемы URL) — раньше пустой
      // <div class="link-preview-slot"> так и оставался в разметке
      // навсегда, занимая место (min-height: 2px в CSS) без видимой
      // причины. Теперь просто убираем слот.
      if (html) slot.innerHTML = html;
      else slot.remove();
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

// aria-live на самом #chat-messages спамил бы скринридеру весь список
// заново при КАЖДОЙ перерисовке (wrap.innerHTML пересобирается целиком
// на любое изменение, не только на новое сообщение) — отдельный
// скрытый узел с aria-live озвучивает только то, что реально нужно
// объявить, один раз, без переписывания рендера на инкрементальный.
function prefersReducedMotion() {
  try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
}
function announceToScreenReader(text) {
  const el = $("#sr-announcer"); if (!el || !text) return;
  el.textContent = "";
  // Пустая строка -> новый текст в следующем тике: одинаковый текст два
  // раза подряд иначе не был бы замечен как "изменение" для aria-live.
  setTimeout(() => { el.textContent = text; }, 30);
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
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  if (hh === 0 && mm === 0) return T("status.seconds", { n: ss });
  if (hh === 0) return `${mm}:${String(ss).padStart(2, "0")}`;
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60000) return T("status.ago.justNow");
  if (d < 3600000) return T("status.ago.minutes", { n: Math.floor(d / 60000) });
  if (d < 86400000) return T("status.ago.hours", { n: Math.floor(d / 3600000) });
  return formatDay(ts);
}

const GLASS_ALPHA_MIN = 0.18, GLASS_ALPHA_MAX = 0.85;
// Ползунок называется "Прозрачность стекла", но раньше его значение
// НАПРЯМУЮ шло в альфа-канал фона (--glass-alpha) — то есть показанный
// процент означал НЕПРОЗРАЧНОСТЬ, ровно противоположное подписи. Заодно
// блюр был сильнее у самой непрозрачной панели, хотя по смыслу
// frosted-glass должно быть наоборот: чем прозрачнее, тем сильнее нужен
// блюр, чтобы текст оставался читаемым на фоне того, что просвечивает.
// transparencyToAlpha/alphaToTransparency переводят между "что видит и
// крутит пользователь" (0..1, прозрачность) и "что реально идёт в CSS"
// (0.18..0.85, альфа) — раздельно, чтобы не путать эти два понятия снова.
function transparencyToAlpha(t) { return GLASS_ALPHA_MAX - t * (GLASS_ALPHA_MAX - GLASS_ALPHA_MIN); }
function alphaToTransparency(a) { return (GLASS_ALPHA_MAX - a) / (GLASS_ALPHA_MAX - GLASS_ALPHA_MIN); }
function applyGlassAlpha(v) {
  if (!Number.isFinite(v)) v = 0.55;
  v = Math.min(GLASS_ALPHA_MAX, Math.max(GLASS_ALPHA_MIN, v));
  document.documentElement.style.setProperty("--glass-alpha", v.toFixed(2));
  const transparency = alphaToTransparency(v); // 0 = полностью непрозрачно, 1 = максимально прозрачно
  document.documentElement.style.setProperty("--glass-blur", (14 + transparency * 26).toFixed(0) + "px");
  const label = document.getElementById("glass-slider-value");
  if (label) label.textContent = Math.round(transparency * 100) + "%";
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // theme-color был жёстко чёрным всегда — в светлой теме статус-бар/
  // рамка PWA у системы выглядели неуместно (тёмная полоса поверх
  // светлого интерфейса).
  const isLight = theme === "light" || (theme === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", isLight ? "#eef0f4" : "#000000");
}

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
let backgroundAudioEl = null;
const SILENT_WAV_DATA_URI = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
// Неофициальный, недокументированный приём для iOS: активная "медиасессия"
// с типом playback иногда продлевает время жизни PWA в фоне — достаточно,
// чтобы успел дойти push с входящим звонком. Не гарантирует ничего, но
// не вредит (звук абсолютно тихий) и не требует дополнительных разрешений
// сверх уже запрошенного разрешения на уведомления. Запускается только
// после настоящего пользовательского жеста — иначе браузер всё равно
// заблокирует автовоспроизведение, и раньше времени просить нет смысла.
function startBackgroundAudioSession() {
  if (backgroundAudioEl || !Store.notificationsEnabled) return;
  try {
    const el = document.createElement("audio");
    el.src = SILENT_WAV_DATA_URI;
    el.loop = true;
    el.volume = 0;
    el.setAttribute("playsinline", "");
    el.style.display = "none";
    document.body.appendChild(el);
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
    backgroundAudioEl = el;
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: (T("app.name") || "Эфир") + " — " + T("audio.background.title") });
        navigator.mediaSession.playbackState = "playing";
        navigator.mediaSession.setActionHandler("play", () => { try { el.play().catch(() => {}); } catch (e) {} });
        navigator.mediaSession.setActionHandler("pause", () => {}); // не даём системе трактовать паузу как повод освободить сессию
      } catch (e) {}
    }
  } catch (e) {}
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
    try { startBackgroundAudioSession(); } catch (e) {}
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
// Отдельная от vibrate() лёгкая haptic-обёртка для UI-действий (реакция,
// свайп-архив, ошибка отправки) — короткие, "тактильные" импульсы, не
// завязанные на настройку звука (это про ощущение нажатия, не про
// звуковые уведомления), но уважающие prefers-reduced-motion.
function haptic(kind) {
  if (prefersReducedMotion()) return;
  if (!navigator.vibrate) return;
  try { navigator.vibrate(kind === "light" ? 10 : kind === "medium" ? 20 : [40, 30, 40]); } catch (e) {}
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
  if (state._unlockLockedUntil && Date.now() < state._unlockLockedUntil) return; // поле заблокировано на паузу — попытки не считаем вовсе
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
      // Раньше при отказе от жёсткого сброса счётчик попыток тихо
      // обнулялся до нуля — лимит попыток был чистой формальностью,
      // отклонить диалог можно было бесконечно, каждый раз получая
      // полный новый запас попыток. Теперь при отказе поле блокируется
      // на паузу (растущую с каждым разом), а счётчик НЕ сбрасывается.
      if (confirm(T("toast.confirmHardReset"))) { localStorage.clear(); location.reload(); return; }
      const lockoutRounds = Math.floor(state.unlockAttempts / UNLOCK_ATTEMPTS_LIMIT);
      const lockoutMs = Math.min(30000 * lockoutRounds, 5 * 60 * 1000); // 30с, 60с, 90с... максимум 5 минут
      state._unlockLockedUntil = Date.now() + lockoutMs;
      lockPinInputFor(lockoutMs);
    } else toast(T("toast.pinWrong"));
  }
}
function lockPinInputFor(ms) {
  const p = $("#lock-pin"), s = $("#lock-submit");
  if (p) p.disabled = true;
  if (s) s.disabled = true;
  toast(T("toast.pinLockedOut", { n: Math.ceil(ms / 1000) }));
  setTimeout(() => {
    if (p) p.disabled = false;
    if (s) s.disabled = false;
  }, ms);
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
    catch (err) { toast(T(err.message)); return; }
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

  // I18N.init() уже вызван в DOMContentLoaded до initBoot() — startApp()
  // всегда достигается уже после этого, повторный вызов здесь был чистым
  // дублированием (идемпотентно, но лишний проход).

  etherLog("info", "[startApp] init, id=" + (Store.myId ? Store.myId.slice(0, 10) + "…" : "(none)"));
  mesh = new MeshManager(Store.name);

  safeCall(wireMeshEvents, "wireMeshEvents");
  safeCall(wireTabBar, "wireTabBar");
  safeCall(() => {
    // Если данные были полностью сброшены (localStorage.clear()) в ДРУГОЙ
    // открытой вкладке — эта вкладка иначе продолжала бы работать со
    // старыми данными в памяти, ничего не подозревая, до следующего
    // случайного действия. storage-событие с key===null — это именно
    // .clear() из другой вкладки того же origin (для set/remove
    // конкретного ключа key был бы непустым).
    window.addEventListener("storage", (e) => { if (e.key === null) location.reload(); });
  }, "wireCrossTabReset");
  safeCall(() => {
    const nav = $("#nav-conn-indicator");
    if (nav) nav.addEventListener("click", () => { state.tab = "settings"; state.chatId = null; state.contactCardId = null; renderTab(); });
  }, "wireNavConnIndicator");
  safeCall(wireConnectScreen, "wireConnectScreen");
  safeCall(wireQrButtons, "wireQrButtons");
  safeCall(wireGroupInfo, "wireGroupInfo");
  safeCall(wireChatScreen, "wireChatScreen");
  safeCall(wireCallScreen, "wireCallScreen");
  safeCall(wireSettingsScreen, "wireSettingsScreen");
  safeCall(wireDebugScreen, "wireDebugScreen");
  safeCall(wireSheetBackdrops, "wireSheetBackdrops");
  safeCall(wireCameraScreen, "wireCameraScreen");
  safeCall(wireSearchHandlers, "wireSearchHandlers");
  safeCall(wireNotificationPermission, "wireNotificationPermission");
  safeCall(wireServiceWorker, "wireServiceWorker");
  safeCall(wireRenameSheet, "wireRenameSheet");
  safeCall(wireNotifBanner, "wireNotifBanner");
  safeCall(wireContactCard, "wireContactCard");
  safeCall(wireNavTitleTaps, "wireNavTitleTaps");
  safeCall(wireKeyboardFix, "wireKeyboardFix");
  safeCall(wireNetworkListeners, "wireNetworkListeners");
  safeCall(wireViewportRecalc, "wireViewportRecalc");
  safeCall(wireMediaViewer, "wireMediaViewer");
  safeCall(wireLinkActionSheet, "wireLinkActionSheet");
  safeCall(applyDebugTabVisibility, "applyDebugTabVisibility");
  safeCall(() => { const el = $("#about-version"); if (el) el.textContent = APP_VERSION; }, "aboutVersion");
  safeCall(initAudioWarmup, "initAudioWarmup");
  safeCall(setupLanguageSelector, "setupLanguageSelector");
  safeCall(applyStaticTranslations, "applyStaticTranslations");

  try {
    applyGlassAlpha(Store.glassAlpha);
    applyTheme(Store.theme);
    const slider = $("#glass-slider"); if (slider) slider.value = alphaToTransparency(Store.glassAlpha).toFixed(2);
    $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === Store.theme));
    const sn = $("#settings-name"); if (sn) sn.value = Store.name;
    const si = $("#settings-identity"); if (si) si.value = Store.myIdentityRaw;
    const ss = $("#settings-signaling-url"); if (ss) ss.value = Store.signalingUrl || "";
    const sd = $("#settings-discoverable"); if (sd) sd.checked = Store.discoverable;
    const sr = $("#settings-receipts"); if (sr) sr.checked = Store.receiptsEnabled;
    const sls = $("#settings-last-seen"); if (sls) sls.checked = Store.lastSeenVisible;
    const sp = $("#settings-presence"); if (sp) sp.checked = Store.presenceVisible;
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

  try { handleNotificationNavigateParams(); } catch (e) { etherLog("error", "[startApp] notification params:", String(e)); }

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
  try { updateCallsBadge(); } catch (e) {}
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
  // <title> и meta description не переводились вовсе (нет data-i18n) —
  // пользователь видел английский заголовок вкладки/PWA-плитки и в
  // поиске браузера независимо от выбранного языка приложения.
  document.title = T("app.title");
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.setAttribute("content", T("app.description"));
}

function setupLanguageSelector() {
  const sel = $("#settings-language");
  if (!sel) return;
  sel.innerHTML = "";
  const langs = I18N.languages.slice().sort((a, b) => a.english.localeCompare(b.english, "en"));
  // Всегда показываем обе части (раньше пара пропадала для языков, где
  // native === english — English, Hausa, Filipino, Cebuano — совпадение
  // ошибочно трактовалось как "нечего добавлять"). Без искусственного
  // выравнивания через пробелы: на мобильных <select> рендерится через
  // нативный пикер ОС, который игнорирует шрифт и стили страницы —
  // padding только добавлял бы лишние видимые пробелы, не выравнивая
  // ничего на практике.
  for (const lang of langs) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.english + " · " + lang.native;
    sel.appendChild(opt);
  }
  sel.value = I18N.current;
  sel.addEventListener("change", () => {
    I18N.setLang(sel.value);
    applyStaticTranslations();
    try { renderTab(); } catch (e) {}
    if (state.chatId) renderChatThread();
    if (state.contactCardId) renderContactCard();
    if (state.tab === "chats" && state.chatsSegment === "calls") renderCallsList();
    refreshSignalingStatusText();
    renderOnlineRosterList();
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

// iOS Safari/PWA в standalone-режиме иногда "замораживает" значения
// env(safe-area-inset-*) и 100dvh на момент сворачивания приложения —
// при повторном открытии эти значения могут не пересчитаться, из-за
// чего футер визуально "плывёт" и растёт с каждым новым открытием.
// Обходной приём: на возврате в приложение принудительно вызываем
// перерасчёт layout, ненадолго переключая высоту #app-shell.
function forceViewportRecalc() {
  try {
    const shell = document.getElementById("app-shell");
    if (!shell) return;
    // Форсируем reflow тем же юнитом (100dvh), что задан в CSS — раньше
    // здесь временно ставился 100vh, а это ДРУГАЯ единица (не учитывает
    // схлопывание тулбара Safari так же, как dvh); переключение между
    // разными юнитами могло само по себе быть источником рассинхрона,
    // а не только чинить его. auto→100dvh безопаснее: инвалидирует
    // layout, но не подставляет отличающееся от CSS значение.
    shell.style.height = "auto";
    // eslint-disable-next-line no-unused-expressions
    shell.offsetHeight; // принудительный reflow между сбросом и восстановлением
    shell.style.height = "";
  } catch (e) {}
}
function wireViewportRecalc() {
  document.addEventListener("visibilitychange", () => { if (!document.hidden) forceViewportRecalc(); });
  window.addEventListener("pageshow", () => forceViewportRecalc());
  window.addEventListener("focus", () => forceViewportRecalc());
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

function openFromNotification(contactId, kind) {
  if (!contactId) return;
  window.focus();
  state.chatId = contactId;
  state.contactCardId = null; // иначе после закрытия этого чата могла неожиданно всплыть карточка контакта, на которой пользователь был до уведомления
  renderTab();
  if (kind === "call") {
    if (state.callId === contactId && state.callPhase === "ringing") {
      openCallScreen(contactId, "ringing");
      if (!ringtoneAudioEl || ringtoneAudioEl.paused) { try { ensureAudioCtx(); } catch (e) {} playRingtone(); }
    } else {
      toast(T("toast.missedCall"));
    }
  }
}
// Открытие по клику на декларативное push-уведомление (Safari/iOS): в
// этом случае notificationclick в sw.js не срабатывает вовсе — платформа
// сразу переходит по URL из поля "navigate", минуя Service Worker. Единственный
// канал передать, что именно открыть — сам URL, поэтому читаем его здесь.
function handleNotificationNavigateParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    const callId = params.get("call");
    const chatId = params.get("chat");
    if (callId) openFromNotification(callId, "call");
    else if (chatId) openFromNotification(chatId, "message");
    if (callId || chatId) {
      const url = new URL(window.location.href);
      url.search = "";
      window.history.replaceState({}, "", url.toString());
    }
  } catch (e) {}
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
      openFromNotification(data.contactId, data.kind);
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
      // Пользователь осознанно выключил уведомления через настройки — баннер
      // "включите уведомления" не должен тут же всплыть снова с призывом
      // включить то, что он только что сам выключил.
      Store.notifBannerDismissed = true;
      updateNotifBanner();
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
  let total = 0;
  for (const c of state.contacts.values()) total += unreadCount(c);
  const tabBadge = $("#tab-chats-badge");
  if (tabBadge) {
    if (total > 0) { tabBadge.textContent = total > 99 ? "99+" : String(total); tabBadge.classList.remove("hidden"); }
    else tabBadge.classList.add("hidden");
  }
  try {
    if (!("setAppBadge" in navigator)) return;
    if (total > 0) navigator.setAppBadge(total);
    else if ("clearAppBadge" in navigator) navigator.clearAppBadge();
  } catch (e) {}
}
// Пропущенные звонки нигде не бейджались, в отличие от чатов — по
// аналогии с другими мессенджерами: непросмотренные пропущенные
// (rec.seen === false) считаем и показываем на вкладке "Звонки".
function updateCallsBadge() {
  const missed = state.callLog.filter((r) => r.status === "missed" && !r.seen).length;
  // Раньше был один #tab-calls-badge на отдельной вкладке. Теперь два
  // индикатора: число на кнопке сегмента "Звонки" (видна, только когда
  // открыта вкладка Chats) и маленькая точка на иконке самой вкладки
  // Chats внизу — чтобы пропущенный звонок был заметен, даже если
  // пользователь сейчас смотрит сегмент "Чаты" или другую вкладку.
  const segBadge = $("#chats-segment-calls-badge");
  if (segBadge) {
    if (missed > 0) { segBadge.textContent = missed > 99 ? "99+" : String(missed); segBadge.classList.remove("hidden"); }
    else segBadge.classList.add("hidden");
  }
  const dot = $("#tab-chats-missed-dot");
  if (dot) dot.classList.toggle("hidden", missed === 0);
}
function markMissedCallsSeen() {
  let changed = false;
  for (const r of state.callLog) if (r.status === "missed" && !r.seen) { r.seen = true; changed = true; }
  if (changed) { persistCallLog(); updateCallsBadge(); }
}

// =====================================================================
// Контакты
// =====================================================================
let __quotaWarningShown = false;
// localStorage — общий лимит ~5-10 МБ на весь домен. Без try/catch
// QuotaExceededError при setItem() улетает как необработанное
// исключение, а данные (новое сообщение, черновик и т.д.) остаются
// только в памяти — при перезагрузке страницы теряются молча.
function handlePersistError(e, what) {
  etherLog("error", "[persist:" + what + "] setItem failed:", String(e && e.message || e));
  if (!__quotaWarningShown) {
    __quotaWarningShown = true;
    try { toast(T("toast.storageFull")); } catch (e2) {}
  }
}
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
      // Группы — без этих полей запись после перезагрузки превращается в
      // битый обычный контакт (isGroup(c) === false, участников нет).
      isGroup: !!c.isGroup,
      members: Array.isArray(c.members) ? c.members : undefined,
      createdBy: c.createdBy || undefined,
      disappearingTimer: c.disappearingTimer || 0,
    });
  }
}
function persistContacts() {
  const arr = Array.from(state.contacts.values()).filter((c) => c.managed).map((c) => ({
    id: c.id, name: c.name, raw: c.raw, publicKey: c.publicKey,
    messages: c.messages, lastActivity: c.lastActivity,
    archived: c.archived, muted: c.muted, blocked: c.blocked,
    isGroup: c.isGroup || undefined,
    members: c.isGroup ? c.members : undefined,
    createdBy: c.isGroup ? c.createdBy : undefined,
    disappearingTimer: c.disappearingTimer || undefined,
  }));
  try {
    Store.contactsJson = JSON.stringify(arr);
  } catch (e) {
    // QuotaExceededError и подобное — см. persistContactsSafe ниже.
    handlePersistError(e, "contacts");
  }
}
function loadLastSeen() { try { state.lastSeen = JSON.parse(Store.lastSeenJson) || {}; } catch (e) { state.lastSeen = {}; } if (typeof state.lastSeen !== "object") state.lastSeen = {}; }
function persistLastSeen() { try { Store.lastSeenJson = JSON.stringify(state.lastSeen); } catch (e) { handlePersistError(e, "lastSeen"); } }
function loadDrafts() { try { state.drafts = JSON.parse(Store.draftsJson) || {}; } catch (e) { state.drafts = {}; } if (typeof state.drafts !== "object") state.drafts = {}; }
function persistDrafts() { try { Store.draftsJson = JSON.stringify(state.drafts); } catch (e) { handlePersistError(e, "drafts"); } }
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
  $$("#chats-segment button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chatsSegment = btn.dataset.segment;
      if (state.chatsSegment === "calls") markMissedCallsSeen();
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
  cancelVoiceRecordingIfLeavingChat(null);
  pauseAllVoicePlayback();
  try { saveCurrentDraft(); } catch (e) {} // ДО обнуления chatId — иначе saveCurrentDraft() сразу выходит (проверяет state.chatId) и черновик теряется
  state.chatId = null;
  try { if (prevId) sendTypingStop(prevId); } catch (e) {}
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
  const tb = $("#tab-bar");
  if (tb) {
    // Пользователь явно попросил обратное решение: таб-бар должен
    // оставаться видимым ВСЕГДА, контролы чата/звонка — появляться НАД
    // ним, не вместо него. #call-screen уже переведён на обычный
    // flex-элемент (см. его CSS) специально для этого — но эта строка
    // всё ещё скрывала таб-бар отдельно для чата/карточки контакта,
    // хотя тот же принцип должен применяться и здесь. Раньше двойной
    // футер получался из-за position:absolute у #call-screen поверх
    // всего #app-shell — сейчас оба (#content и #call-screen) обычные
    // flex-сиблинги с явным order, лишнего наложения не будет.
    tb.classList.remove("hidden");
  }

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
  // "Звонки" больше не отдельная вкладка — сегмент внутри "Chats"
  // (Signal/WhatsApp/Telegram всё же держат звонки отдельной вкладкой,
  // но у нас, в отличие от них, было 4 видимых вкладки против их 3-4,
  // и сегмент внутри Chats снижает это число, не убирая звонки в
  // глубь навигации на лишний тап). Показываем нужный экран по
  // сегменту, а не по вкладке напрямую.
  const effectiveScreenKey = state.tab === "chats" ? state.chatsSegment : state.tab;
  const el = $(map[effectiveScreenKey]); if (el) el.classList.remove("hidden");
  const seg = $("#chats-segment");
  if (seg) {
    seg.classList.toggle("hidden", state.tab !== "chats");
    $$("#chats-segment button").forEach((b) => b.classList.toggle("active", b.dataset.segment === state.chatsSegment));
  }
  const titles = {
    chats: T("nav.chats"),
    calls: T("nav.calls"),
    connect: T("nav.contacts"),
    settings: T("nav.settings"),
    debug: T("nav.debug"),
  };
  const nt = $("#nav-title"); if (nt) nt.textContent = titles[state.tab] || T("app.name");
  if (state.tab === "chats" && state.chatsSegment === "chats") renderChatsList();
  if (state.tab === "chats" && state.chatsSegment === "calls") renderCallsList();
  if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
}

function contactStatusLabel(c) {
  if (c.isGroup) return T("group.memberCount", { n: c.members.length });
  if (c.status === "in-call") return T("status.inCall");
  if (c.status === "connected") return T("status.connected");
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return T("status.connecting");
  if (c.managed) {
    // Тумблеры приватности собеседника (пришли через P2P privacy-pref) —
    // отсутствие поля (старый клиент, ещё не подключался) трактуем как
    // "не скрыто". Онлайн-статус и время последнего визита — РАЗНЫЕ
    // тумблеры, каждый скрывается независимо.
    if (c.online && c.peerPresenceVisible !== false) return T("status.online");
    if (c.peerLastSeenVisible !== false) {
      const seen = state.lastSeen[c.id];
      if (seen) return T("status.lastSeen", { ago: timeAgo(seen) });
    }
    return T("status.offline");
  }
  return T("status.offline");
}
function contactStatusClass(c) {
  if (c.status === "connected" || c.status === "in-call") return "status-connected";
  if (c.managed && c.online && c.peerPresenceVisible !== false) return "status-connected";
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
    ? visible.filter((c) => (c.name || "").toLowerCase().includes(query) || c.messages.some((m) => (m.text || "").toLowerCase().includes(query) || (m.file && m.file.name || "").toLowerCase().includes(query) || (m.contactCard && m.contactCard.name || "").toLowerCase().includes(query)))
    : visible;
  if (filtered.length === 0) {
    if (empty) empty.classList.toggle("hidden", query.length > 0);
    if (archivedToggle) archivedToggle.classList.toggle("hidden", !withArchived);
    return;
  }
  if (empty) empty.classList.add("hidden");
  if (archivedToggle) archivedToggle.classList.toggle("hidden", !withArchived);
  const ta = $("#toggle-archived");
  if (ta) {
    ta.textContent = state.showArchived ? T("chats.archive.hide") : T("chats.archive.show");
    // Стрелка раньше была зашита прямо в переводимый текст (›/‹) — в RTL
    // браузер не разворачивает текстовые символы автоматически. Теперь
    // стрелка идёт через CSS ::after с учётом dir, а класс здесь только
    // выбирает направление "открыт/закрыт".
    ta.classList.toggle("is-open", state.showArchived);
  }
  const items = filtered.sort((a, b) => {
    const aLive = isReachable(a) || a.online ? 1 : 0, bLive = isReachable(b) || b.online ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
  for (const c of items) {
    const last = c.messages[c.messages.length - 1];
    const unread = unreadCount(c);
    const wrapper = document.createElement("div");
    wrapper.className = "chat-row-wrapper";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chat-row flat-content" + (c.archived ? " archived" : "");
    const badge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : "";
    const muteIcon = c.muted ? `<span class="muted-icon" title="Mute"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 5 5.9v4l1.6 2.4a1 1 0 0 1-.8 1.6H5.2a1 1 0 0 1-.8-1.6L6 13.5v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1zm-2 18a2 2 0 0 0 4 0h-4z"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>` : "";
    const blockIcon = c.blocked ? `<span class="muted-icon" title="Blocked"><svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>` : "";
    let preview = last
      ? (last.from === "system" && last.textKey ? escapeHtml(renderSystemMessageText(last)) : last.file ? escapeHtml(T("chat.file.preview." + last.file.kind)) : (last.contactCard ? escapeHtml(T("chat.contactCard.preview", { name: last.contactCard.name || T("sys.someone") })) : escapeHtml(truncate(last.text, 42))))
      : escapeHtml(contactStatusLabel(c));
    if (query && last && (last.text || "").toLowerCase().includes(query)) preview = highlightRaw(escapeHtml(truncate(last.text, 42)), state.searchQuery);
    // "Печатает…" перекрывает обычное превью — раньше это было видно
    // только в шапке уже открытого треда, хотя состояние (typingTimers)
    // уже отслеживалось и для списка чатов, просто не использовалось.
    const isTyping = !isGroup(c) && state.typingTimers.has(c.id);
    if (isTyping) preview = `<em class="chat-row-typing">${escapeHtml(T("chat.typing"))}</em>`;
    row.innerHTML = `
      <div class="avatar" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div>
      <div class="chat-row-body">
        <div class="chat-row-top">
          <span class="chat-row-name${unread > 0 ? " unread" : ""}">${escapeHtml(c.name || T("sys.someone"))} ${muteIcon}${blockIcon}</span>
          <span class="chat-row-status ${contactStatusClass(c)}"${isGroup(c) ? ' style="display:none;"' : ""}>●</span>
        </div>
        <div class="chat-row-sub"><span class="chat-row-preview-text">${preview}</span>${badge}</div>
      </div>`;
    // Свайп открывает фоновые действия (архив/удалить) — сама кнопка
    // строки едет поверх них через translateX. Раньше список чатов был
    // просто <button> без единого жеста — тап открывал чат, и больше
    // ничего. Структура: wrapper > [фон с действиями] + [сама строка].
    wrapper.innerHTML = `
      <div class="chat-row-actions chat-row-actions-start">
        <button type="button" class="chat-row-action-btn chat-row-action-archive" data-action="archive">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20.5 4h-17A1.5 1.5 0 0 0 2 5.5v2A1.5 1.5 0 0 0 3.5 9H4v9.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9h.5A1.5 1.5 0 0 0 22 7.5v-2A1.5 1.5 0 0 0 20.5 4zM18 18.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V9h12v9.5zM20 7H4V6h16v1z"/><path fill="currentColor" d="M9.5 13h5a.5.5 0 0 0 0-1h-5a.5.5 0 0 0 0 1z"/></svg>
          <span>${escapeHtml(c.archived ? T("chats.action.unarchive") : T("chats.action.archive"))}</span>
        </button>
      </div>
      <div class="chat-row-actions chat-row-actions-end">
        <button type="button" class="chat-row-action-btn chat-row-action-delete" data-action="delete">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 7h12l-1 13.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 20.5L6 7zm3.5-4h5l1 2H19v1.5H5V5h4.5l1-2z"/></svg>
          <span>${escapeHtml(T("chats.action.delete"))}</span>
        </button>
      </div>`;
    wrapper.appendChild(row);
    row.addEventListener("click", () => { cancelVoiceRecordingIfLeavingChat(c.id); state.chatId = c.id; renderTab(); });
    attachChatRowSwipe(wrapper, row, c);
    list.appendChild(wrapper);
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
      <button type="button" class="roster-add-btn" data-action="card">${escapeHtml(T("contact.openCard"))}</button>`;
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
  const idEl = $("#contact-info-id"); if (idEl) idEl.textContent = c.raw || T("chat.contact.identifier.unknown");
  const mutedEl = $("#contact-info-muted");
  if (mutedEl) {
    const bellPath = '<path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 5 5.9v4l1.6 2.4a1 1 0 0 1-.8 1.6H5.2a1 1 0 0 1-.8-1.6L6 13.5v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1zm-2 18a2 2 0 0 0 4 0h-4z"/>';
    const slash = '<line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    mutedEl.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16">${bellPath}${c.muted ? slash : ""}</svg>`;
  }
  const blockBtn = $("#contact-block-btn"); if (blockBtn) blockBtn.textContent = c.blocked ? T("chat.contact.unblock") : T("chat.contact.block");
  const archBtn = $("#contact-archive-btn"); if (archBtn) archBtn.textContent = T("chat.contact.archive");
  const muteBtn = $("#contact-mute-btn"); if (muteBtn) muteBtn.textContent = T("chat.contact.mute");
  const disSel = $("#contact-disappearing-select"); if (disSel) disSel.value = String(c.disappearingTimer || 0);
}
function wireContactCard() {
  const msgBtn = $("#contact-msg-btn");
  if (msgBtn) msgBtn.addEventListener("click", () => {
    const id = state.contactCardId; if (!id) return;
    cancelVoiceRecordingIfLeavingChat(id);
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
  const safetyBtn = $("#contact-safety-btn");
  if (safetyBtn) safetyBtn.addEventListener("click", async () => {
    const cid = state.contactCardId; const c = cid && state.contacts.get(cid); if (!c) return;
    if (!c.publicKey || !Store.myPublicKeyJwk) { toast(T("toast.safetyNumberNoKey")); return; }
    const digitsEl = $("#safety-number-digits");
    if (digitsEl) digitsEl.textContent = "…";
    const sheet = $("#safety-number-sheet"); if (sheet) sheet.classList.remove("hidden");
    try {
      const groups = await CryptoHelper.computeSafetyNumber(Store.myPublicKeyJwk, c.publicKey);
      if (digitsEl) digitsEl.innerHTML = groups.map((g) => `<span>${escapeHtml(g)}</span>`).join("");
    } catch (e) {
      if (digitsEl) digitsEl.textContent = "";
      toast(T("toast.safetyNumberNoKey"));
    }
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
  // 5 состояний, различимых по ФОРМЕ, не только по цвету (важно для
  // дальтоников и ч/б скриншотов): pending — вращающийся ободок,
  // sent/delivered — контурные галочки (через -webkit-text-stroke в
  // CSS), read — та же ✓✓, но залитая и чуть крупнее, failed — "!" в
  // кружке, кликабельна. У каждой role="img" и локализованный
  // aria-label — раньше скринридер читал их как "галочка галочка".
  const lbl = (k) => `role="img" aria-label="${escapeHtml(T("ack." + k))}"`;
  if (ack === "failed") return `<span class="ack-tick ack-failed" ${lbl("failed")} data-retry="1">!</span>`;
  if (ack === "read") return `<span class="ack-tick ack-read" ${lbl("read")}>✓✓</span>`;
  if (ack === "delivered") return `<span class="ack-tick ack-delivered" ${lbl("delivered")}>✓✓</span>`;
  if (ack === "pending") return `<span class="ack-tick ack-pending" ${lbl("pending")}>◷</span>`;
  return `<span class="ack-tick ack-sent" ${lbl("sent")}>✓</span>`;
}
const NEAR_BOTTOM_PX = 80;
function isNearBottom(el) { if (!el) return true; return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX; }

function renderChatThread() { try { renderChatThreadInner(); } catch (e) { etherLog("error", "[renderChatThread]", String(e)); const w = $("#chat-messages"); if (w) w.innerHTML = `<div class="empty-state"><p>Error.</p></div>`; } }

function renderChatThreadInner() {
  const c = state.contacts.get(state.chatId);
  if (!c) { state.chatId = null; renderTab(); return; }
  const screenEl = $("#screen-chat"); if (screenEl) screenEl.setAttribute("aria-label", c.name || T("sys.someone"));
  if (state.chatId !== __lastRenderedChatId) {
    // Тот же баг, что и в closeChatSafely — переключение МЕЖДУ чатами
    // не останавливало играющее голосовое из предыдущего чата.
    pauseAllVoicePlayback();
    // Свежий вход в чат (а не повторный рендер того же самого) — если
    // есть непрочитанные, запоминаем id первого из них один раз здесь.
    // Дальше, пока пользователь не долистает вниз, ни бейдж, ни
    // разделитель не трогаем — специально НЕ зовём markThreadRead тут.
    if (!unreadDividerFor.has(c.id)) {
      const firstUnread = c.messages.find((m) => m.from === "them" && !m.readAckSent);
      if (firstUnread) unreadDividerFor.set(c.id, firstUnread.id);
    }
    __lastRenderedChatId = state.chatId;
  }
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
  const ccb = $("#chat-call-btn");
  if (ccb) { ccb.disabled = isGroup(c) ? false : !canCall; ccb.classList.toggle("call-unavailable", isGroup(c)); }
  const vcb = $("#chat-video-call-btn");
  if (vcb) { vcb.disabled = isGroup(c) ? false : !canCall; vcb.classList.toggle("call-unavailable", isGroup(c)); }
  // Файлы в группах не поддерживаются — раньше это выяснялось только
  // ПОСЛЕ выбора файла, когда sendFileMessage сам отказывал. Честнее не
  // показывать кнопку как рабочую вовсе. Кнопка микрофона решается в
  // updateSendVsMic() (там же учитывается видимость от текста в поле —
  // два независимых переключателя одного и того же .hidden конфликтовали бы).
  const attachBtn = $("#chat-attach-btn"); if (attachBtn) attachBtn.classList.toggle("hidden", isGroup(c));
  const cameraBtn = $("#chat-camera-btn"); if (cameraBtn) cameraBtn.classList.toggle("hidden", isGroup(c) || !__cameraAvailable);

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
  const savedScrollTop = wrap.scrollTop; // для случая "читал старое, не внизу, разделителя нет" — см. ниже
  // Якорь на первом видимом сообщении — savedScrollTop сам по себе
  // корректен, только если контент ВЫШЕ текущей позиции не меняется по
  // высоте между рендерами. Это верно для новых входящих (они всегда
  // добавляются в конец), но НЕ верно, если сообщения сверху исчезли
  // (TTL-очистка просроченных, обрезка истории) — тогда тот же
  // scrollTop указывал бы на другой контент, пользователя дёрнуло бы.
  let anchorMsgId = null, anchorTopBefore = 0;
  if (!wasAtBottom) {
    const wrapRect = wrap.getBoundingClientRect();
    for (const el of wrap.querySelectorAll("[data-msg-id]")) {
      const r = el.getBoundingClientRect();
      if (r.bottom > wrapRect.top) { anchorMsgId = el.getAttribute("data-msg-id"); anchorTopBefore = r.top; break; }
    }
  }
  wrap.innerHTML = "";
  const frag = document.createDocumentFragment();
  const q = state.chatSearchQuery.toLowerCase();
  let lastDay = "";
  const urlsToFetch = new Set();
  let prevMsg = null;
  const unreadAnchorId = unreadDividerFor.get(c.id);
  let unreadDividerEl = null;
  for (const m of c.messages) {
    if (unreadAnchorId && m.id === unreadAnchorId) {
      const div = document.createElement("div");
      div.className = "unread-divider";
      const span = document.createElement("span");
      span.textContent = T("chat.unreadDivider");
      div.appendChild(span);
      frag.appendChild(div);
      unreadDividerEl = div;
      prevMsg = null; // разделитель тоже разрывает визуальную группировку подряд идущих сообщений
    }
    if (m.from === "system") {
      const sys = document.createElement("div");
      sys.className = "system-message";
      const label = document.createElement("span");
      // Новые системные сообщения хранят ключ+параметры перевода и
      // переводятся здесь, при показе — на текущем языке, а не на том,
      // что был активен в момент создания сообщения. m.text остаётся как
      // запасной вариант для уже сохранённых старых записей (обратная
      // совместимость) и на случай, если ключ вдруг не найдётся.
      label.textContent = renderSystemMessageText(m);
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
    const tick = m.from === "me" ? ackGlyph(m.ack) : "";
    const editedMark = m.edited ? `<span class="bubble-edited">${escapeHtml(T("chat.edit"))}</span>` : "";
    const ttlMark = m.ttl ? `<span class="bubble-ttl" title="${escapeHtml(disappearingTimerLabel(m.ttl))}">⏳</span>` : "";
    const inner = document.createElement("div");
    inner.className = "bubble " + (m.from === "me" ? "" : "glass-content");
    inner.setAttribute("data-msg-id", m.id); // для прокрутки к оригиналу по тапу на цитате ответа
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
    if (m.replyTo) replyHtml = `<div class="bubble-reply" data-reply-to-id="${escapeHtml(m.replyTo.msgId || "")}"><div class="bubble-reply-author">${escapeHtml(m.replyTo.authorName || "")}</div><div class="bubble-reply-text">${escapeHtml(truncate(m.replyTo.text || "", 80))}</div></div>`;
    const fwdMark = m.forwarded ? `<div class="bubble-forwarded">${escapeHtml(T("chat.forward"))}</div>` : "";
    let reactionsHtml = "";
    if (m.reactions && typeof m.reactions === "object") {
      const chips = Object.entries(m.reactions).filter(([, users]) => Array.isArray(users) && users.length > 0);
      if (chips.length > 0) reactionsHtml = `<div class="bubble-reactions">` + chips.map(([emoji, users]) => `<span class="bubble-reaction-chip">${escapeHtml(emoji)} ${users.length}</span>`).join("") + `</div>`;
    }
    inner.innerHTML = `${senderLabel}${fwdMark}${replyHtml}${body}${previewSlotHtml}<span class="bubble-time">${ttlMark}${formatTime(m.ts)}${editedMark}${tick}</span>${reactionsHtml}`;
    // Долгое нажатие — открывает обычное меню действий (ответить/
    // переслать/удалить), для ЛЮБОГО типа сообщения, как в большинстве
    // мессенджеров. Обычный тап при этом делает контентно-зависимое
    // действие по умолчанию (см. ниже) вместо меню.
    let longPressFired = false;
    let longPressTimer = null;
    let longPressMoved = false;
    let lpStartX = 0, lpStartY = 0;
    function startLongPress(x, y) {
      longPressMoved = false;
      lpStartX = x; lpStartY = y;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        if (!longPressMoved) {
          longPressFired = true;
          try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
          openMessageSheet(m.id, c.id);
        }
      }, 500);
    }
    function moveLongPress(x, y) {
      if (Math.abs(x - lpStartX) > 10 || Math.abs(y - lpStartY) > 10) { longPressMoved = true; clearTimeout(longPressTimer); }
    }
    function endLongPress() { clearTimeout(longPressTimer); }
    inner.addEventListener("touchstart", (e) => { const t = e.touches[0]; startLongPress(t.clientX, t.clientY); }, { passive: true });
    inner.addEventListener("touchmove", (e) => { const t = e.touches[0]; moveLongPress(t.clientX, t.clientY); }, { passive: true });
    inner.addEventListener("touchend", endLongPress);
    inner.addEventListener("touchcancel", endLongPress);
    inner.addEventListener("mousedown", (e) => startLongPress(e.clientX, e.clientY));
    inner.addEventListener("mousemove", (e) => { if (longPressTimer) moveLongPress(e.clientX, e.clientY); });
    inner.addEventListener("mouseup", endLongPress);
    inner.addEventListener("mouseleave", endLongPress);

    inner.addEventListener("click", (ev) => {
      if (longPressFired) { longPressFired = false; return; } // меню уже открыто долгим нажатием — не открываем ещё и обычное действие следом
      const addBtn = ev.target.closest(".contact-card-add-btn");
      if (addBtn) {
        ev.stopPropagation();
        const cardId = addBtn.getAttribute("data-add-contact-id");
        const cardName = addBtn.getAttribute("data-add-contact-name") || "";
        if (cardId) addContactFromCard(cardId, cardName);
        return;
      }
      // Тап по цитате ответа — прокрутка к оригинальному сообщению, а
      // не общее меню поверх него. Проверяем раньше остальных веток,
      // т.к. цитата может быть частью пузыря любого типа (текст, файл).
      // Тап по "!" (недоставленное) сразу открывает меню сообщения —
      // раньше "Повторить" было спрятано в шите, куда добирается
      // меньшинство пользователей; статус-иконка была мёртвым маркером.
      const retryEl = ev.target.closest(".ack-failed[data-retry]");
      if (retryEl) { ev.stopPropagation(); openMessageSheet(m.id, c.id); return; }
      const replyQuoteEl = ev.target.closest(".bubble-reply[data-reply-to-id]");
      if (replyQuoteEl) {
        ev.stopPropagation();
        const targetId = replyQuoteEl.getAttribute("data-reply-to-id");
        const targetEl = targetId && wrap.querySelector(`[data-msg-id="${CSS.escape(targetId)}"]`);
        if (targetEl) {
          targetEl.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
          targetEl.classList.add("highlight-origin");
          setTimeout(() => targetEl.classList.remove("highlight-origin"), 1500);
        } else {
          toast(T("chat.replyOriginalGone"));
        }
        return;
      }
      // Ссылка (обычный текст со ссылкой или карточка превью) — своё
      // меню выбора действия, а не переход напрямую и не общее меню
      // сообщения одновременно (раньше срабатывало и то, и другое).
      const linkEl = ev.target.closest("a[href]");
      if (linkEl) {
        ev.preventDefault();
        ev.stopPropagation();
        openLinkActionSheet(linkEl.href);
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      if (ev.target.closest(".voice-play-btn")) return; // у кнопки уже есть свой обработчик — тут просто не открываем меню поверх него
      if (m.file && m.file.kind === "audio" && !m.file.pending) {
        toggleVoicePlaybackFor(inner);
        return;
      }
      if (m.file && (m.file.kind === "image" || m.file.kind === "video") && !m.file.pending) {
        getFileBlobUrl(m.id).then((url) => { if (url) openMediaViewer(url, m.file.kind); });
        return;
      }
      // Двойной тап по обычному тексту пузыря — быстрая реакция (❤️ или
      // последняя использованная), без открытия меню сообщения. Открытие
      // меню по одиночному тапу откладывается на короткое окно (220мс),
      // достаточное, чтобы отличить один тап от двух, но не заметное на
      // глаз как задержка.
      if (!isGroup(c)) {
        const prev = __bubbleTapState.get(m.id);
        if (prev && Date.now() - prev.time < 320) {
          clearTimeout(prev.timer);
          __bubbleTapState.delete(m.id);
          const quickEmoji = (Store.recentReactions[0]) || "❤️";
          toggleReaction(c.id, m.id, quickEmoji);
          return;
        }
        const timer = setTimeout(() => { __bubbleTapState.delete(m.id); if (state.chatId === c.id) openMessageSheet(m.id, c.id); }, 220);
        __bubbleTapState.set(m.id, { time: Date.now(), timer });
        return;
      }
      openMessageSheet(m.id, c.id);
    });
    attachSwipeReply(inner, m, c);
    bubble.appendChild(inner);
    frag.appendChild(bubble);
    prevMsg = m;
  }
  wrap.appendChild(frag);
  urlsToFetch.forEach((u) => renderLinkPreviewInto(u));
  hydrateFileSlots(wrap);
  if (unreadDividerEl && !dividerScrolledFor.has(c.id)) {
    // Свежий вход в чат с непрочитанными — показываем место, где они
    // начинаются, а не сразу прыгаем в самый низ (иначе пользователь
    // никогда бы не увидел разделитель). Только один раз — не на каждый
    // повторный рендер, пока пользователь ещё не долистал.
    unreadDividerEl.scrollIntoView({ block: "center" });
    dividerScrolledFor.add(c.id);
  } else if (!unreadDividerEl && wasAtBottom) {
    wrap.scrollTop = wrap.scrollHeight;
  } else if (!unreadDividerEl) {
    // Пользователь читал старую переписку (не у низа, разделителя нет —
    // либо уже снят, либо его и не было). wrap.innerHTML = "" выше
    // полностью пересобирает DOM на КАЖДЫЙ рендер. Если есть якорное
    // сообщение и оно всё ещё существует после пересборки — подгоняем
    // scrollTop так, чтобы оно осталось в той же позиции на экране
    // (компенсирует изменение высоты контента выше, если сверху что-то
    // исчезло — TTL, обрезка истории). Если якоря нет или само якорное
    // сообщение тоже пропало — откатываемся на старое поведение.
    const anchorEl = anchorMsgId ? wrap.querySelector(`[data-msg-id="${CSS.escape(anchorMsgId)}"]`) : null;
    if (anchorEl) {
      const anchorTopAfter = anchorEl.getBoundingClientRect().top;
      wrap.scrollTop += anchorTopAfter - anchorTopBefore;
    } else {
      wrap.scrollTop = savedScrollTop;
    }
  }
  updateScrollBottomButton();
  const input = $("#chat-input");
  if (input && state.drafts[c.id] && !state.editingMessageId) input.value = state.drafts[c.id];
  updateSendVsMic();
  // markThreadRead — только если сейчас реально видно низ переписки. Раньше
  // условие было "нет разделителя ИЛИ у низа" — но разделитель ставится
  // ТОЛЬКО при свежем входе в чат (state.chatId меняется), а не когда новое
  // сообщение приходит в уже открытый и полностью прочитанный чат. В этом
  // случае unreadDividerFor.has() всегда false, и старое условие срабатывало
  // независимо от прокрутки — новое сообщение помечалось прочитанным, даже
  // если пользователь в этот момент листал старую переписку выше. Оставляем
  // только реальную проверку прокрутки.
  if (isNearBottom(wrap)) {
    unreadDividerFor.delete(c.id);
    dividerScrolledFor.delete(c.id);
    markThreadRead(c);
  }

  if (state.chatSearchQuery) {
    if (__chatSearchScrollTimer) clearTimeout(__chatSearchScrollTimer);
    __chatSearchScrollTimer = setTimeout(() => {
      const marks = wrap.querySelectorAll(".search-hit");
      if (marks.length > 0) marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }, 200);
  }
}
const __bubbleTapState = new Map(); // msgId -> { time, timer } — для различения одиночного/двойного тапа по пузырю
let __openChatRowWrapper = null; // только одна открытая свайпом строка одновременно — стандартный паттерн (iOS Mail, Gmail)
function closeOpenChatRow() {
  if (__openChatRowWrapper) {
    const r = __openChatRowWrapper.querySelector(".chat-row");
    if (r) r.style.transform = "";
    __openChatRowWrapper.classList.remove("swiped-start", "swiped-end");
    __openChatRowWrapper = null;
  }
}
const CHAT_ROW_REVEAL_PX = 84;
function attachChatRowSwipe(wrapper, row, c) {
  let startX = 0, startY = 0, dragging = false, currentX = 0;
  const isRtl = document.documentElement.dir === "rtl";
  // .chat-row-actions-start (архив) — inset-inline-start: физически
  // слева в LTR, физически СПРАВА в RTL (логические CSS-свойства сами
  // разворачиваются). Перетаскивание всегда 1:1 следует за пальцем без
  // единой инверсии — это единственный вариант, который не выглядит
  // сломанным ни в LTR, ни в RTL. RTL влияет ТОЛЬКО на то, какую панель
  // означает положительный/отрицательный сдвиг — это решается один раз,
  // в момент отпускания, а не размазано по вычислению координат.
  row.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    dragging = false;
    if (__openChatRowWrapper && __openChatRowWrapper !== wrapper) closeOpenChatRow();
    currentX = wrapper.classList.contains("swiped-start") ? CHAT_ROW_REVEAL_PX : wrapper.classList.contains("swiped-end") ? -CHAT_ROW_REVEAL_PX : 0;
    row.style.transition = "none";
  }, { passive: true });
  row.addEventListener("touchmove", (e) => {
    const rawDx = e.touches[0].clientX - startX + currentX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (!dragging && Math.abs(rawDx - currentX) > 10 && Math.abs(rawDx - currentX) > dy) dragging = true;
    if (!dragging) return;
    const dx = Math.max(-CHAT_ROW_REVEAL_PX * 1.3, Math.min(CHAT_ROW_REVEAL_PX * 1.3, rawDx));
    row.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  row.addEventListener("touchend", () => {
    row.style.transition = "";
    if (!dragging) return;
    const m1 = row.style.transform.match(/translateX\((-?\d+(?:\.\d+)?)px\)/);
    const dx = m1 ? parseFloat(m1[1]) : 0;
    // Положительный сдвиг открывает панель, которая физически СЛЕВА —
    // это "start" в LTR, но "end" в RTL (см. комментарий выше).
    const wantsPhysicalLeftPanel = dx > CHAT_ROW_REVEAL_PX / 2;
    const wantsPhysicalRightPanel = dx < -CHAT_ROW_REVEAL_PX / 2;
    const opensStart = isRtl ? wantsPhysicalRightPanel : wantsPhysicalLeftPanel;
    const opensEnd = isRtl ? wantsPhysicalLeftPanel : wantsPhysicalRightPanel;
    if (opensStart) {
      row.style.transform = `translateX(${CHAT_ROW_REVEAL_PX}px)`;
      wrapper.classList.add("swiped-start"); wrapper.classList.remove("swiped-end");
      __openChatRowWrapper = wrapper;
      haptic("light");
    } else if (opensEnd) {
      row.style.transform = `translateX(${-CHAT_ROW_REVEAL_PX}px)`;
      wrapper.classList.add("swiped-end"); wrapper.classList.remove("swiped-start");
      __openChatRowWrapper = wrapper;
      haptic("light");
    } else {
      row.style.transform = "";
      wrapper.classList.remove("swiped-start", "swiped-end");
      if (__openChatRowWrapper === wrapper) __openChatRowWrapper = null;
    }
    dragging = false;
  });
  // Если строка открыта свайпом, тап по НЕЙ САМОЙ закрывает её вместо
  // перехода в чат — навигация возвращается только когда строка закрыта.
  row.addEventListener("click", (ev) => {
    if (wrapper.classList.contains("swiped-start") || wrapper.classList.contains("swiped-end")) {
      ev.stopImmediatePropagation();
      closeOpenChatRow();
    }
  }, true);
  wrapper.querySelector(".chat-row-action-archive").addEventListener("click", () => {
    closeOpenChatRow();
    c.archived = !c.archived; persistContacts(); haptic("light"); renderChatsList();
  });
  wrapper.querySelector(".chat-row-action-delete").addEventListener("click", () => {
    if (!confirm(T("toast.confirmDeleteContact", { name: c.name }))) { closeOpenChatRow(); return; }
    closeOpenChatRow();
    deleteContact(c.id);
  });
}
function attachSwipeReply(el, m, c) {
  let startX = 0, startY = 0, swiping = false;
  const isRtl = document.documentElement.dir === "rtl";
  el.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; swiping = false;
    el.style.transition = "none";
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    let dx = t.clientX - startX;
    // В RTL естественный жест "ответить" — свайп ВЛЕВО (визуально к
    // началу строки), не вправо. dir="rtl" меняет визуальную сторону
    // текста/стрелок, но раньше не менял ожидаемое направление свайпа.
    if (isRtl) dx = -dx;
    const dy = Math.abs(t.clientY - startY);
    if (!swiping && Math.abs(dx) > 12 && Math.abs(dx) > dy) swiping = true;
    if (swiping && dx > 0) el.style.transform = `translateX(${(isRtl ? -1 : 1) * Math.min(dx * 0.5, 60)}px)`;
  }, { passive: true });
  el.addEventListener("touchend", () => {
    el.style.transition = "";
    const tr = el.style.transform;
    el.style.transform = "";
    if (swiping) {
      const m1 = tr && tr.match(/translateX\((-?\d+(?:\.\d+)?)px\)/);
      if (m1 && Math.abs(parseFloat(m1[1])) > 40) {
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
  // Раньше кружок-бейдж существовал в разметке, но никогда не
  // заполнялся — просто пустой видимый кружок в углу кнопки. Теперь
  // показывает реальное число непрочитанных, если чат ещё не долистан.
  const countEl = $("#scroll-bottom-count");
  if (countEl) {
    const c = state.chatId ? state.contacts.get(state.chatId) : null;
    const n = c ? unreadCount(c) : 0;
    if (n > 0) { countEl.textContent = n > 99 ? "99+" : String(n); countEl.classList.remove("hidden"); }
    else countEl.classList.add("hidden");
  }
}
function markThreadRead(c) {
  const toAck = [];
  for (const m of c.messages) if (m.from === "them" && !m.readAckSent) { m.readAckSent = true; toAck.push(m); }
  if (toAck.length === 0) return;
  persistContacts();
  // receiptsEnabled=false — не отправляем read-квитанции вовсе (но
  // readAckSent выше всё равно проставлен: это ЛОКАЛЬНЫЙ учёт для
  // счётчика непрочитанных, не сигнал собеседнику).
  if (Store.receiptsEnabled) {
    if (isGroup(c)) {
      // У группы нет своего mesh-линка — это набор отдельных P2P-связей с
      // каждым участником. sendAckBatch(groupId, ...) тут ничего не находит
      // (mesh.get(groupId) === undefined) и запись просто зависает в
      // pendingNoKey навсегда. Правильно — слать квитанцию РЕАЛЬНОМУ АВТОРУ
      // каждого сообщения (m.fromId), а не группе как единому адресату;
      // разные сообщения в одной группе могли написать разные люди.
      const byAuthor = new Map();
      for (const m of toAck) {
        const authorId = m.fromId; if (!authorId) continue;
        if (!byAuthor.has(authorId)) byAuthor.set(authorId, []);
        byAuthor.get(authorId).push(m.deliveryId || m.id);
      }
      for (const [authorId, ids] of byAuthor) sendAckBatch(authorId, ids, "read");
    } else {
      sendAckBatch(c.id, toAck.map((m) => m.deliveryId || m.id), "read");
    }
  }
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
    const kb = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0));
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
  haptic("light");
  const payload = { kind: "chat", id: msgId, text, ts };
  if (replyTo) payload.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
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
  recentlyDeletedIds.delete(id); // осознанное повторное добавление снимает блокировку из deleteContact
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
// Единая точка перевода системных сообщений при показе (не при создании) —
// используется и в ленте чата, и в превью списка чатов, чтобы язык всегда
// был текущим, а не тем, что был активен в момент создания записи.
function renderSystemMessageText(m) {
  if (!m.textKey) return m.text;
  let params = m.textParams;
  if (m.textKey === "chat.disappearing.systemOnYou" || m.textKey === "chat.disappearing.systemOnThem") {
    params = Object.assign({}, m.textParams, { duration: disappearingTimerLabel((m.textParams && m.textParams.msValue) || 0) });
  }
  const translated = T(m.textKey, params);
  // Если для textKey вдруг нет перевода (например, ключ добавили в код,
  // но забыли в словаре), T() возвращает сырой ключ как есть —
  // пользователь увидел бы "group.systemAdded" вместо текста. m.text
  // хранит текст, переведённый УЖЕ работавшим переводом в момент
  // создания сообщения — используем его как подстраховку.
  return translated === m.textKey && m.text ? m.text : translated;
}
function disappearingTimerLabel(ms) {
  if (ms === 3600000) return T("chat.disappearing.1h");
  if (ms === 86400000) return T("chat.disappearing.1d");
  if (ms === 604800000) return T("chat.disappearing.1w");
  return T("chat.disappearing.off");
}
function addDisappearingSystemMessage(c, ms, byMe) {
  const key = ms
    ? (byMe ? "chat.disappearing.systemOnYou" : "chat.disappearing.systemOnThem")
    : (byMe ? "chat.disappearing.systemOffYou" : "chat.disappearing.systemOffThem");
  // duration — вложенный перевод (зависит от текущего языка на момент
  // показа, не создания), поэтому не кладём готовую строку в params —
  // держим сырое значение таймера и досчитываем duration при рендере
  // (см. ветку system-message в renderChatThreadInner).
  const params = ms ? { name: c.name || T("sys.someone"), msValue: ms } : { name: c.name || T("sys.someone") };
  const text = ms
    ? (byMe ? T("chat.disappearing.systemOnYou", { duration: disappearingTimerLabel(ms) }) : T("chat.disappearing.systemOnThem", { name: c.name || T("sys.someone"), duration: disappearingTimerLabel(ms) }))
    : (byMe ? T("chat.disappearing.systemOffYou") : T("chat.disappearing.systemOffThem", { name: c.name || T("sys.someone") }));
  c.messages.push({ id: crypto.randomUUID(), from: "system", text, textKey: key, textParams: params, ts: Date.now() });
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
const FILE_BLOB_URL_CACHE_MAX = 300; // выше, чем у превью ссылок: если "on-screen" картинка/видео ссылается на blob URL, а мы его отзовём — она сломается, поэтому вытесняем осторожнее и только при реальном избытке

// Файлы/голосовые требовали, чтобы P2P-связь была уже установлена ДО
// вызова — в отличие от текста (который через trySendOrQueue сам
// пытается подключиться), это падало сразу, даже если собеседник
// онлайн и связь установилась бы за пару секунд, просто рукопожатие
// ещё не завершилось. Активно пытаемся подключиться и ждём немного,
// прежде чем сдаться.
async function ensureLiveLink(contactId, timeoutMs) {
  let link = mesh.get(contactId);
  if (link && (link.status === "connected" || link.status === "in-call")) return link;
  scheduleAutoConnect(contactId);
  attemptConnectViaRelay(contactId).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    link = mesh.get(contactId);
    if (link && (link.status === "connected" || link.status === "in-call")) return link;
  }
  return null;
}
async function sendFileMessage(contactId, file) {
  const c = state.contacts.get(contactId); if (!c) return;
  if (isGroup(c)) { toast(T("toast.fileGroupsUnsupported")); return; }
  if (c.blocked) { toast(T("toast.blocked")); return; }
  if (file.size > MAX_FILE_SIZE) { toast(T("toast.fileTooLarge", { size: formatFileSize(MAX_FILE_SIZE) })); return; }
  const existingLink = mesh.get(contactId);
  const alreadyLive = existingLink && (existingLink.status === "connected" || existingLink.status === "in-call");
  if (!alreadyLive) toast(T("toast.connecting"));
  const link = alreadyLive ? existingLink : await ensureLiveLink(contactId, 8000);
  if (!link) { toast(T("toast.fileNeedsLive")); return; }

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
  const existingLink2 = mesh.get(contactId);
  const alreadyLive2 = existingLink2 && (existingLink2.status === "connected" || existingLink2.status === "in-call");
  if (!alreadyLive2) toast(T("toast.connecting"));
  const link = alreadyLive2 ? existingLink2 : await ensureLiveLink(contactId, 8000);
  if (!link) { toast(T("toast.fileNeedsLive")); return; }

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
let voiceRecordStarting = false;
let voiceRecordTargetChatId = null; // чат, в котором НАЧАЛАСЬ запись — используется при остановке, а не state.chatId в тот момент (пользователь мог переключиться в другой чат за время записи)
async function startVoiceRecording() {
  if (!state.chatId) return;
  if (voiceRecorder || voiceRecordStarting) return; // защита и от повторного вызова, и от гонки — getUserMedia асинхронный, voiceRecorder присваивается только после него
  voiceRecordStarting = true;
  voiceRecordTargetChatId = state.chatId;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast(T("toast.voiceUnsupported")); voiceRecordStarting = false; return;
  }
  try {
    voiceRecordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast(T("toast.voiceNoMic")); voiceRecordStarting = false; return;
  }
  const mimeType = pickVoiceMimeType();
  try {
    voiceRecorder = mimeType ? new MediaRecorder(voiceRecordStream, { mimeType }) : new MediaRecorder(voiceRecordStream);
  } catch (e) {
    toast(T("toast.voiceUnsupported"));
    voiceRecordStream.getTracks().forEach((t) => t.stop()); voiceRecordStream = null;
    voiceRecordStarting = false;
    return;
  }
  voiceRecordStarting = false;
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
// Запись привязана к конкретному чату (voiceRecordTargetChatId) — если
// пользователь уходит из этого чата, не дожидаясь окончания записи,
// честнее отменить её совсем, чем оставлять полоску записи висеть
// поверх экрана другого чата, создавая путаницу насчёт того, куда
// голосовое реально уйдёт.
function cancelVoiceRecordingIfLeavingChat(newChatId) {
  if (voiceRecorder && voiceRecordTargetChatId && newChatId !== voiceRecordTargetChatId) {
    stopVoiceRecording(false);
  }
}
function stopVoiceRecording(send) {
  const contactId = voiceRecordTargetChatId;
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
const MAX_INCOMING_FILE_TRANSFERS = 20; // одновременных незавершённых приёмов файлов
const INCOMING_FILE_BUFFER_TTL_MS = 3 * 60 * 1000; // брошенная (недокачанная) запись живёт не дольше этого
function sweepIncomingFileBuffers() {
  const now = Date.now();
  for (const [id, buf] of incomingFileBuffers) {
    if (now - (buf.receivedAt || 0) > INCOMING_FILE_BUFFER_TTL_MS) incomingFileBuffers.delete(id);
  }
}
function handleFilePayload(from, payload) {
  if (payload.kind === "file-meta") {
    // Без верхней границы недобросовестный/сбойный пир мог прислать много
    // мелких file-meta и никогда не прислать file-done — Map росла бы
    // без предела. Также отклоняем заведомо нереалистичный totalChunks
    // (легитимный максимум — 15 МБ / 48 КБ ≈ 320 кусков), чтобы не
    // аллоцировать под него огромный массив заранее.
    const totalChunks = payload.totalChunks;
    if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 500) return;
    sweepIncomingFileBuffers();
    if (incomingFileBuffers.size >= MAX_INCOMING_FILE_TRANSFERS && !incomingFileBuffers.has(payload.id)) return;
    incomingFileBuffers.set(payload.id, { name: payload.name, mime: payload.mime, size: payload.size, totalChunks, chunks: new Array(totalChunks).fill(null), from, receivedAt: Date.now() });
    const c = ensureContactEntry(from, null);
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: "", ts: Date.now(), readAckSent: false,
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
  if (buf.chunks.some((ch) => ch === null)) {
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
// =====================================================================
// Полноэкранный просмотр медиа / меню для ссылок — открываются по
// обычному тапу на сообщении, в зависимости от типа содержимого
// (голосовое → воспроизведение, картинка/видео → во весь экран,
// ссылка → выбор действия). Долгое нажатие на ЛЮБОЕ сообщение по-
// прежнему открывает обычное меню (ответить/переслать/удалить и т.д.)
// — как в большинстве мессенджеров.
function openMediaViewer(url, kind) {
  const viewer = $("#media-viewer"); if (!viewer) return;
  const img = $("#media-viewer-img");
  const video = $("#media-viewer-video");
  if (kind === "video") {
    if (img) img.classList.add("hidden");
    if (video) { video.classList.remove("hidden"); video.src = url; video.play().catch(() => {}); }
  } else {
    if (video) { video.classList.add("hidden"); video.pause(); video.removeAttribute("src"); }
    if (img) { img.classList.remove("hidden"); img.src = url; }
  }
  viewer.classList.remove("hidden");
}
function closeMediaViewer() {
  const viewer = $("#media-viewer"); if (!viewer) return;
  viewer.classList.add("hidden");
  const video = $("#media-viewer-video"); if (video) { video.pause(); video.removeAttribute("src"); }
  const img = $("#media-viewer-img"); if (img) img.removeAttribute("src");
}
function wireMediaViewer() {
  const closeBtn = $("#media-viewer-close");
  if (closeBtn) closeBtn.addEventListener("click", closeMediaViewer);
  const viewer = $("#media-viewer");
  if (viewer) viewer.addEventListener("click", (ev) => { if (ev.target === viewer) closeMediaViewer(); });
}

let linkActionTargetUrl = "";
function openLinkActionSheet(url) {
  linkActionTargetUrl = url;
  const urlEl = $("#link-action-url"); if (urlEl) urlEl.textContent = url;
  const sheet = $("#link-action-sheet"); if (sheet) sheet.classList.remove("hidden");
}
function wireLinkActionSheet() {
  const openBtn = $("#link-action-open");
  if (openBtn) openBtn.addEventListener("click", () => {
    const sheet = $("#link-action-sheet"); if (sheet) sheet.classList.add("hidden");
    if (linkActionTargetUrl && /^https?:\/\//i.test(linkActionTargetUrl)) window.open(linkActionTargetUrl, "_blank", "noopener,noreferrer");
  });
  const copyBtn = $("#link-action-copy");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    const sheet = $("#link-action-sheet"); if (sheet) sheet.classList.add("hidden");
    try { await navigator.clipboard.writeText(linkActionTargetUrl); toast(T("toast.linkCopied")); } catch (e) {}
  });
}

// Переиспользуемое воспроизведение голосового — раньше плей-кнопка сама
// заводила <audio> и слушала клик только на СЕБЕ, а тап по всему пузырю
// (за пределами кнопки) уходил в общий обработчик и открывал меню
// сообщения ОДНОВРЕМЕННО с воспроизведением. Теперь голосовые элементы
// (созданные в hydrateFileSlots) хранят свой <audio> прямо на DOM-узле
// пузыря — эта функция находит его и дёргает тот же toggle.
function toggleVoicePlaybackFor(bubbleEl) {
  const btn = bubbleEl.querySelector(".voice-play-btn");
  if (btn && !btn.disabled) btn.click();
}
async function getFileBlobUrl(msgId) {
  if (fileBlobUrlCache.has(msgId)) return fileBlobUrlCache.get(msgId);
  const blob = await IDB.get("file:" + msgId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  fileBlobUrlCache.set(msgId, url);
  if (fileBlobUrlCache.size > FILE_BLOB_URL_CACHE_MAX) {
    const toRemove = fileBlobUrlCache.size - Math.floor(FILE_BLOB_URL_CACHE_MAX * 0.9);
    let removed = 0;
    for (const [k, u] of fileBlobUrlCache) {
      if (removed >= toRemove) break;
      // Раньше вытеснение шло вслепую по возрасту записи — если URL в
      // этот момент реально отображается в DOM (<img>/<video> в открытом
      // чате), revokeObjectURL() ломает уже показанную картинку (у
      // пользователя с длинной перепиской с фото это выглядело как
      // внезапно пропавшее превью). Пропускаем то, что сейчас на экране,
      // и вытесняем следующую по возрасту запись вместо неё.
      if (document.querySelector(`[data-file-id="${CSS.escape(k)}"]`)) continue;
      URL.revokeObjectURL(u);
      fileBlobUrlCache.delete(k);
      removed++;
    }
  }
  return url;
}
function fileBubbleHtml(msgId, fileInfo) {
  if (fileInfo.pending) {
    return `<div class="file-bubble file-bubble-pending"><div class="file-spinner"></div><span>${escapeHtml(T("chat.file.sending"))}</span></div>`;
  }
  if (fileInfo.failed) {
    return `<div class="file-bubble file-bubble-failed"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2 1 21h22L12 2zm0 6 6.5 11h-13L12 8zm-1 2.5v4h2v-4h-2zm0 5.5v2h2v-2h-2z"/></svg> <span>${escapeHtml(T("chat.file.failed"))}</span></div>`;
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
    <span class="file-doc-icon"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L14 3.5zM7 12h10v1.5H7V12zm0 4h10v1.5H7V16zm0-8h5v1.5H7V8z"/></svg></span>
    <span class="file-doc-info"><span class="file-doc-name">${escapeHtml(fileInfo.name)}</span><span class="file-doc-size">${escapeHtml(sizeStr)}</span></span>
  </a>`;
}
function formatVoiceDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}
const voiceAudioCache = new Map(); // msgId -> { audio, playing } — переиспользуем между рендерами
// Раньше при уходе из чата (в список чатов или в другой чат) голосовое,
// если оно играло, продолжало звучать в фоне — кнопки для остановки
// уже не было, а сам Audio() из кеша никто не ставил на паузу.
function pauseAllVoicePlayback() {
  for (const entry of voiceAudioCache.values()) {
    if (entry.playing) { entry.audio.pause(); entry.playing = false; }
  }
  document.querySelectorAll(".voice-play-btn").forEach((b) => { b.textContent = "▶"; });
}
function hydrateFileSlots(root) {
  root.querySelectorAll(".file-media-slot[data-file-id], .file-bubble-doc[data-file-id]").forEach((el) => {
    const msgId = el.getAttribute("data-file-id");
    const kind = el.getAttribute("data-file-kind");
    getFileBlobUrl(msgId).then((url) => {
      if (!url) {
        // Раньше при неудаче (файл не докачан/удалён/ошибка IDB) слот
        // так и оставался с "Загрузка…" навсегда — пользователь не мог
        // понять, что происходит.
        const loadingEl = el.querySelector(".file-media-loading");
        if (loadingEl) loadingEl.textContent = T("chat.file.unavailable");
        else if (el.classList.contains("file-bubble-doc")) el.textContent = T("chat.file.unavailable");
        return;
      }
      if (kind === "image") el.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`;
      else if (kind === "video") el.innerHTML = `<video src="${escapeHtml(url)}" controls playsinline></video>`;
      else if (kind === "file") { el.href = url; el.setAttribute("download", ""); }
    }).catch(() => {
      const loadingEl = el.querySelector(".file-media-loading");
      if (loadingEl) loadingEl.textContent = T("chat.file.unavailable");
    });
  });
  root.querySelectorAll(".voice-bubble[data-file-id]").forEach((el) => {
    const msgId = el.getAttribute("data-file-id");
    const playBtn = el.querySelector(".voice-play-btn");
    const fill = el.querySelector(".voice-progress-fill");
    const durEl = el.querySelector(".voice-duration");
    const knownDuration = parseFloat(el.getAttribute("data-duration")) || 0;
    getFileBlobUrl(msgId).then((url) => {
      if (!url || !playBtn) {
        // Та же проблема для голосовых — кнопка play оставалась
        // disabled навсегда без единого объяснения.
        if (durEl) durEl.textContent = T("chat.file.unavailable");
        return;
      }
      // Раньше тут создавался НОВЫЙ Audio() на каждый рендер чата (wrap.innerHTML
      // пересобирает DOM целиком при любом новом сообщении) — старый объект,
      // если в этот момент играл, продолжал играть в фоне без возможности
      // остановить (кнопка/обработчики принадлежали уже уничтоженному узлу).
      // Кешируем по msgId и переиспользуем один и тот же Audio между рендерами,
      // перепривязывая обработчики к актуальным (пересозданным) DOM-элементам.
      let entry = voiceAudioCache.get(msgId);
      if (!entry) {
        entry = { audio: new Audio(url), playing: false };
        voiceAudioCache.set(msgId, entry);
        // fileBlobUrlCache и linkPreviewCache уже ограничены по размеру,
        // а voiceAudioCache — нет: рос на каждый когда-либо проигранный
        // голосовой за сессию, чистился только при удалении сообщения.
        // За долгую активную переписку с голосовыми — сотни живых
        // HTMLAudioElement. Вытесняем только НЕ играющие сейчас записи.
        if (voiceAudioCache.size > 200) {
          const toRemove = voiceAudioCache.size - 180;
          let removed = 0;
          for (const [k, v] of voiceAudioCache) {
            if (removed >= toRemove) break;
            if (v.playing) continue; // не вытесняем то, что сейчас реально играет
            try { v.audio.pause(); } catch (e) {}
            voiceAudioCache.delete(k);
            removed++;
          }
        }
      }
      const audio = entry.audio;
      playBtn.disabled = false;
      playBtn.textContent = entry.playing ? "⏸" : "▶";
      // ontimeupdate/onended — присвоение свойства, а не addEventListener:
      // корректно ЗАМЕНЯЕТ предыдущий обработчик (указывавший на элементы
      // прошлого рендера) вместо накопления дублей при каждом ре-рендере.
      audio.ontimeupdate = () => {
        const dur = audio.duration || knownDuration;
        if (fill && dur) fill.style.width = Math.min(100, (audio.currentTime / dur) * 100) + "%";
        if (durEl) durEl.textContent = formatVoiceDuration(dur - audio.currentTime);
      };
      audio.onended = () => {
        entry.playing = false; playBtn.textContent = "▶";
        if (fill) fill.style.width = "0%";
        if (durEl) durEl.textContent = formatVoiceDuration(knownDuration || audio.duration || 0);
      };
      playBtn.onclick = () => {
        // Не играть несколько голосовых хором — раньше это пытались делать
        // через document.querySelectorAll("audio.ether-voice-playing"), но
        // эти Audio() никогда не прикреплены к DOM документа, и querySelectorAll
        // их попросту не находил — реально играло сразу несколько. Теперь через
        // собственный кеш, который видит все созданные объекты по-настоящему.
        for (const [otherId, other] of voiceAudioCache) {
          if (otherId !== msgId && other.playing) { other.audio.pause(); other.playing = false; }
        }
        if (entry.playing) { audio.pause(); entry.playing = false; playBtn.textContent = "▶"; }
        else { audio.play().catch(() => {}); entry.playing = true; playBtn.textContent = "⏸"; }
      };
    });
  });
}

function cleanupExpiredFileBlobs(removedMessages) {
  for (const m of removedMessages) {
    if (!m.file) continue;
    IDB.del("file:" + m.id).catch(() => {});
    const url = fileBlobUrlCache.get(m.id);
    if (url) { URL.revokeObjectURL(url); fileBlobUrlCache.delete(m.id); }
    const cached = voiceAudioCache.get(m.id);
    if (cached) { try { cached.audio.pause(); } catch (e) {} voiceAudioCache.delete(m.id); }
  }
}
function updateSendVsMic() {
  const input = $("#chat-input"); if (!input) return;
  const hasText = input.value.trim().length > 0;
  const sendBtn = $(".send-btn[type=submit]");
  const micBtn = $("#voice-record-btn");
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  const inGroup = !!(c && isGroup(c));
  if (sendBtn) sendBtn.classList.toggle("hidden", !hasText);
  // Голосовые сообщения не поддерживаются в группах — кнопка микрофона
  // не должна становиться видимой даже при пустом поле ввода.
  if (micBtn) micBtn.classList.toggle("hidden", hasText || inGroup);
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
  if (replyTo) payload.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
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
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemAdded", { name: (c && c.name) || T("sys.someone") }), textKey: "group.systemAdded", textParams: { name: (c && c.name) || T("sys.someone") }, ts: Date.now() });
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
  g.lastActivity = Date.now();
  if (leftBySelf && memberId === Store.myId) {
    // Уход из группы — не полу-рабочее состояние (группа с текстом "вы
    // вышли", в которую всё ещё можно писать и которая продолжает висеть
    // в списке чатов), а полное локальное удаление, как у обычного
    // контакта.
    broadcastGroupRoster(g); // сначала уведомляем оставшихся, пока g.members ещё доступен
    state.contacts.delete(groupId);
    delete state.drafts[groupId]; persistDrafts();
    unreadDividerFor.delete(groupId);
    dividerScrolledFor.delete(groupId);
    persistContacts();
    if (state.chatId === groupId) { state.chatId = null; renderTab(); }
    else if (state.tab === "chats") renderChatsList();
    return;
  }
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: leftBySelf ? T("group.systemLeft", { name: removedName }) : T("group.systemRemoved", { name: removedName }), textKey: leftBySelf ? "group.systemLeft" : "group.systemRemoved", textParams: { name: removedName }, ts: Date.now() });
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
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemRenamed", { name }), textKey: "group.systemRenamed", textParams: { name }, ts: Date.now() });
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
  // Раньше ack сразу оптимистично выставлялся в "sent" при создании
  // записи — это была маленькая ложь: на плохой сети между "нажал
  // отправить" и реальной отправкой (P2P или через сервер) может пройти
  // 2-5 секунд. Честный pending-статус на этот момент.
  const mPending = contact.messages.find((x) => x.id === msgId);
  if (mPending && mPending.ack === "sent") {
    mPending.ack = "pending";
    if (state.chatId === contact.id) renderChatThread();
  }
  const link = mesh.get(contact.id);
  const p2pSent = link && (link.status === "connected" || link.status === "in-call") && link.send(payloadObj);
  addToOutbox(msgId, contact.id, payloadObj);
  if (p2pSent) {
    if (mPending && mPending.ack === "pending") {
      mPending.ack = "sent";
      persistContacts();
      if (state.chatId === contact.id) renderChatThread();
    }
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
  try { Store.outboxJson = JSON.stringify(arr); } catch (e) { handlePersistError(e, "outbox"); }
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
      if (m && (m.ack === "failed" || m.ack === "pending")) m.ack = "sent";
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
  try { Store.pendingNoKeyJson = JSON.stringify(obj); } catch (e) { handlePersistError(e, "pendingNoKey"); }
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
    if (isGroup(c)) continue; // групповой fan-out ретраев не поддержан — некуда слать одному "получателю"-группе
    for (const m of c.messages) {
      if (m.from !== "me") continue;
      if (m.serverAcked) continue;
      if (m.ack !== "failed") continue;
      if (outbox.has(m.id)) continue;
      if (now - m.ts > RESUME_MAX_AGE_MS) continue;
      const payload = { kind: "chat", id: m.id, text: m.text, ts: m.ts };
      if (m.replyTo) payload.replyTo = { id: m.replyTo.id, text: m.replyTo.text, authorName: m.replyTo.authorName };
      if (m.ttl) payload.ttl = m.ttl;
      addToOutbox(m.id, c.id, payload);
      flushOutboxItem(m.id);
    }
  }
}

const _recentAckSent = new Map();
function sendAckBatch(contactId, originalMsgIds, ackState) {
  if (!Array.isArray(originalMsgIds) || originalMsgIds.length === 0) return;
  const key = contactId + ":" + ackState + ":" + originalMsgIds.join(",");
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
  if (link && (link.status === "connected" || link.status === "in-call") && link.send(payload)) return;
  const c = state.contacts.get(contactId); if (!c) return;
  addToOutbox(actionId, contactId, payload);
  flushOutboxItem(actionId);
}

function markMessageAck(contactId, msgId, ack) {
  if (ack === "failed") haptic("medium");
  // Симметрично markThreadRead: если МОИ receipts выключены, я не вижу
  // read-статус на СВОИХ сообщениях, даже если собеседник его всё-таки
  // прислал (у него могло быть включено). Это тот же принцип, что в
  // Signal — тумблер симметричен по эффекту, не только по отправке.
  if (ack === "read" && !Store.receiptsEnabled) ack = "delivered";
  const rank = { failed: -1, sent: 0, delivered: 1, read: 2 };
  // Для групповых сообщений msgId, который приходит в ack, — это id
  // ДОСТАВКИ (свой у каждого участника, чтобы не сталкивались ключи в
  // outbox), а само сообщение хранится в списке ГРУППЫ и ключуется по
  // payload.id (общий для всех получателей id содержимого). Раньше
  // здесь искали msgId в списке contactId (конкретного участника) —
  // совпадения никогда не было, и групповые сообщения навсегда
  // оставались "✓ отправлено". Пока запись ещё жива в outbox (до
  // удаления ниже), в ней есть и payload.id, и payload.groupId —
  // используем их, чтобы найти настоящую запись сообщения.
  const entry = outbox.get(msgId);
  const groupId = entry && entry.payload && entry.payload.groupId;
  const contentId = entry && entry.payload && entry.payload.id;
  if (groupId && contentId) {
    const g = state.contacts.get(groupId);
    const m = g && g.messages.find((mm) => mm.id === contentId && mm.from === "me");
    if (m && ((rank[ack] ?? 0) >= (rank[m.ack] ?? 0) || ack === "failed")) m.ack = ack;
    if (m) { persistContacts(); if (state.chatId === groupId) renderChatThread(); }
  } else {
    const c = state.contacts.get(contactId);
    const m = c && c.messages.find((mm) => mm.id === msgId && mm.from === "me");
    if (m && ((rank[ack] ?? 0) >= (rank[m.ack] ?? 0) || ack === "failed")) m.ack = ack;
    persistContacts();
    if (state.chatId === contactId) renderChatThread();
  }
  if (ack === "delivered" || ack === "read") { if (outbox.has(msgId)) { outbox.delete(msgId); persistOutbox(); } }
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
// Три тумблера приватности сообщаются собеседнику через P2P (тот же
// принцип, что и typing-статус) — сервер тут ни при чём, это прямое
// сообщение между уже связанными пирами.
function sendPrivacyPrefsTo(contactId) {
  const link = mesh.get(contactId);
  if (!link || (link.status !== "connected" && link.status !== "in-call")) return;
  link.send({ kind: "privacy-pref", receiptsEnabled: Store.receiptsEnabled, lastSeenVisible: Store.lastSeenVisible, presenceVisible: Store.presenceVisible });
}
function broadcastPrivacyPrefs() {
  for (const c of state.contacts.values()) if (!isGroup(c)) sendPrivacyPrefsTo(c.id);
}
function handleIncomingTyping(contactId, active) {
  const t = state.typingTimers.get(contactId);
  if (t) { clearTimeout(t); state.typingTimers.delete(contactId); }
  if (active) {
    state.typingTimers.set(contactId, setTimeout(() => {
      state.typingTimers.delete(contactId);
      if (state.chatId === contactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }, TYPING_AUTO_CLEAR_MS));
  }
  if (state.chatId === contactId) renderChatThread();
  // Раньше "печатает…" было видно только в шапке открытого треда —
  // список чатов ничего не показывал, хотя состояние уже отслеживается.
  if (state.tab === "chats") renderChatsList();
}
// Использованная реакция становится самой первой в "недавних" —
// дедуп, кап на 6.
function recordRecentReaction(emoji) {
  const cur = Store.recentReactions.filter((e) => e !== emoji);
  cur.unshift(emoji);
  Store.recentReactions = cur;
}
async function toggleReaction(contactId, msgId, emoji) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  haptic("light");
  if (!m.reactions || typeof m.reactions !== "object") m.reactions = {};
  if (!Array.isArray(m.reactions[emoji])) m.reactions[emoji] = [];
  const meIdx = m.reactions[emoji].indexOf(Store.myId);
  let remove = false;
  if (meIdx >= 0) { m.reactions[emoji].splice(meIdx, 1); remove = true; if (m.reactions[emoji].length === 0) delete m.reactions[emoji]; }
  else { m.reactions[emoji].push(Store.myId); recordRecentReaction(emoji); }
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
  // Раньше статус связи с сервером был виден только внутри настроек —
  // на главном экране список чатов просто "ждал" без единого намёка на
  // то, что сервер отвалился. Небольшой индикатор в шапке — только когда
  // что-то не так, при "online" скрыт совсем, чтобы не шуметь попусту.
  const nav = $("#nav-conn-indicator");
  if (nav) {
    if (kind === "online") nav.classList.add("hidden");
    else { nav.textContent = text; nav.classList.remove("hidden"); }
  }
}
// При смене языка статусная строка ("в сети"/"офлайн"/...) раньше не
// перерисовывалась — показывала текст на СТАРОМ языке до следующего
// реального события статуса (могло не случиться ещё долго). Здесь же
// просто заново определяем текущее состояние и переводим его текст.
function refreshSignalingStatusText() {
  if (!effectiveSignalingUrl()) { updateSignalingStatusUI("off", "—"); return; }
  if (signaling && signaling.connected) { updateSignalingStatusUI("online", T("status.online")); return; }
  updateSignalingStatusUI("off", T("status.offline"));
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
  // Удалённый (но всё ещё онлайн у себя) контакт продолжает слать offer
  // по своей логике переподключения — не даём ему молча воскреснуть.
  if (recentlyDeletedIds.has(from)) return;
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
    for (const [id, link] of Array.from(mesh.links)) {
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
  subs.push(on("register-rate-limited", () => {
    updateSignalingStatusUI("off", T("status.rateLimited"));
    toast(T("toast.registerRateLimited"));
  }));
  subs.push(on("disconnected", () => {
    updateSignalingStatusUI("off", T("status.offline"));
    for (const c of state.contacts.values()) if (c.managed) {
      if (c.online) { state.lastSeen[c.id] = Date.now(); persistLastSeen(); }
      c.online = false;
    }
    onlineSet.clear();
    onlineRoster.clear();
    relayAttemptCooldown.clear(); // после реконнекта старый "недавно не получилось через релей" неактуален
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
      // Сообщения от заблокированных уже фильтруются (и в mesh-обработчике,
      // и в deliver), а сигнал входящего звонка — нет. Заблокировав
      // человека, пользователь продолжал бы получать от него звонки.
      const existingBlocked = state.contacts.get(from);
      if (existingBlocked && existingBlocked.blocked) return;
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
    const { from, msgId, envelope, fromPublicKey, kind } = ev.detail;
    sig.mailboxAck(msgId);
    const sender = state.contacts.get(from);
    if (sender && sender.blocked) {
      if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
      return;
    }
    if (seenDeliverIds.has(from + "|" + msgId)) {
      if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
      return;
    }
    seenDeliverIds.add(from + "|" + msgId);
    // Раньше ключом был голый msgId — два РАЗНЫХ контакта, приславшие
    // сообщение с одинаковым msgId (в теории UUID-коллизия исключена,
    // но нарочный спам совпадающими id уже нет — прежняя схема просто
    // отбросила бы второе сообщение от другого человека), теперь не
    // мешают друг другу: ключ включает отправителя.
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
    const rec = { id: payload.id, from: "them", text: payload.text, ts: payload.ts || Date.now(), readAckSent: false, deliveryId: envelopeMsgId };
    if (groupId) { rec.fromId = from; rec.fromName = payload.senderName || (state.contacts.get(from) && state.contacts.get(from).name) || T("sys.someone"); }
    if (payload.replyTo) rec.replyTo = payload.replyTo;
    if (payload.forwarded) rec.forwarded = true;
    if (payload.ttl) rec.ttl = payload.ttl;
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    const displayName = c.name;
    const previewPrefix = groupId ? `${rec.fromName}: ` : "";
    if (isOpen) {
      renderChatThread(); playMessageSound(); vibrate([80, 40, 80]);
      // aria-live на #chat-messages спамил бы весь список на каждую
      // перерисовку — объявляем только реально новое сообщение через
      // отдельный скрытый узел.
      announceToScreenReader(T("sr.newMessage", { name: groupId ? rec.fromName : displayName, text: truncate(payload.text, 80) }));
    } else {
      toast(`${displayName}: ${previewPrefix}${truncate(payload.text, 40)}`);
      if (!c.muted) showNotification(displayName || T("app.name"), previewPrefix + truncate(payload.text, 80), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message" });
      playMessageSound();
      vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    // Раньше здесь был немедленный sendAckBatch(..., "read") независимо от
    // того, долистал ли пользователь до этого сообщения — обходил всю
    // логику отложенной пометки прочитанным (markThreadRead внутри
    // renderChatThread, которая честно проверяет прокрутку). Теперь
    // полагаемся только на неё — она сама решит, когда действительно
    // отправить квитанцию, и корректно учтёт группы (см. markThreadRead).
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
      g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemCreated", { name: g.name }), textKey: "group.systemCreated", textParams: { name: g.name }, ts: Date.now() });
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
    // Ветка "ack" (в отличие от "ack-batch") в проекте никем не
    // отправляется — но если такой payload всё же придёт (испорченный
    // или от другого клиента) без payload.state, markMessageAck(...,
    // undefined) мог тихо испортить уже верный ack "sent" на более
    // низкий ранг. Не действуем без явного state.
    if (payload.state) {
      const ids = Array.isArray(payload.ids) ? payload.ids : [payload.id];
      for (const id of ids) markMessageAck(from, id, payload.state);
    }
  } else if (kind === "typing") {
    handleIncomingTyping(from, !!payload.active);
  } else if (kind === "privacy-pref") {
    const c = state.contacts.get(from);
    if (c) {
      // Значения собеседника о ТРЁХ тумблерах приватности — влияют на
      // то, что я вижу про НЕГО (моё отображение), а не на мои
      // собственные значения. Отсутствие поля (старый клиент, ещё не
      // успел прислать) трактуем как "не скрыто" — разрешительно по
      // умолчанию, а не наоборот.
      c.peerReceiptsEnabled = payload.receiptsEnabled !== false;
      c.peerLastSeenVisible = payload.lastSeenVisible !== false;
      c.peerPresenceVisible = payload.presenceVisible !== false;
      if (state.chatId === from || state.tab === "chats") renderTab();
    }
  } else if (kind === "reaction") {
    applyReaction(from, payload);
  } else if (kind === "contact-card") {
    const c = ensureContactEntry(from, null);
    if (c.messages.some((m) => m.id === payload.id)) return;
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: "", ts: payload.ts || Date.now(), readAckSent: false, deliveryId: envelopeMsgId, contactCard: { id: payload.contactId, name: payload.contactName || "" } };
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
const relayAttemptCooldown = new Map(); // targetId -> когда в последний раз безуспешно пробовали (ms)
const RELAY_COOLDOWN_MS = 15000;
async function attemptConnectViaRelay(targetId) {
  const existing = mesh.get(targetId);
  if (existing && existing.status !== "disconnected") return;
  if (_connectInFlight.has(targetId)) return;
  // renderChatThreadInner дёргает эту функцию очень часто (на каждый presence/
  // typing/link-status), а если релеев пока нет — смысла пересканировать
  // mesh.links на каждый вызов нет. Ограничиваем частоту попыток.
  const lastTry = relayAttemptCooldown.get(targetId);
  if (lastTry && Date.now() - lastTry < RELAY_COOLDOWN_MS) return;
  const relays = Array.from(mesh.links.entries()).filter(([rid, l]) => rid !== targetId && l.status === "connected");
  if (relays.length === 0) { relayAttemptCooldown.set(targetId, Date.now()); return; }
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
      recentlyDeletedIds.delete(id); // осознанное повторное добавление снимает блокировку из deleteContact
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
  const callBtn = $("#group-info-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => toast(T("toast.callGroupsUnsupported")));
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
    catch (e) { toast(T(e.message)); return; }
    if (identity.id === Store.myId) { toast(T("toast.ownId")); return; }
    if (state.contacts.has(identity.id)) toast(T("toast.alreadyAdded"));
    else {
      recentlyDeletedIds.delete(identity.id); // осознанное повторное добавление снимает блокировку из deleteContact
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
      if (packet.t !== "answer") throw new Error("toast.badInviteCode");
      const link = mesh.get(state.pendingOutgoing.id);
      if (!link) { resetConnectScreen(); return; }
      await link.acceptAnswer(packet);
      $("#answer-code-in").value = "";
      toast(T("toast.callAccepted"));
    } catch (e) { toast(T("toast.badInviteCode")); }
  });
  const replyBtn = $("#reply-btn");
  if (replyBtn) replyBtn.addEventListener("click", async () => {
    const code = $("#paste-code-in").value.trim();
    if (!code) return;
    try { await handleIncomingCode(code); } catch (e) { toast(T("toast.badInviteCode")); }
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
  if (!packet) {
    // createInitialOffer() может вернуть null, если соединение уже
    // закрыто в процессе — без этой проверки SignalingCodec.encode(null)
    // не падает, а тихо кодирует мусор из строки "null", и пользователь
    // получает нерабочее приглашение без единого сообщения об ошибке.
    mesh.remove(id);
    toast(T("toast.inviteFailed"));
    return;
  }
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
const __camera = { stream: null, facing: "environment", capturedBlob: null, contactId: null };
async function openCameraScreen(contactId) {
  const screen = $("#camera-screen"); if (!screen) return;
  __camera.contactId = contactId;
  __camera.capturedBlob = null;
  screen.classList.remove("hidden");
  showCameraLiveState();
  await startCameraStream(__camera.facing);
}
async function startCameraStream(facing) {
  stopCameraStream();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
    __camera.stream = stream;
    __camera.facing = facing;
    const video = $("#camera-preview");
    if (video) video.srcObject = stream;
  } catch (e) {
    // Отказ в доступе или отсутствие камеры — тот же честный подход,
    // что и для микрофона при звонке: не молчим и не показываем общую
    // ошибку "нет связи с сервером".
    const name = e && e.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") toast(T("toast.cameraPermissionDenied"));
    else if (name === "NotFoundError" || name === "DevicesNotFoundError") toast(T("toast.cameraNotFound"));
    else toast(T("toast.cameraPermissionDenied"));
    closeCameraScreen();
  }
}
function stopCameraStream() {
  if (__camera.stream) { try { __camera.stream.getTracks().forEach((t) => t.stop()); } catch (e) {} __camera.stream = null; }
}
function closeCameraScreen() {
  stopCameraStream();
  __camera.capturedBlob = null;
  const screen = $("#camera-screen"); if (screen) screen.classList.add("hidden");
}
function showCameraLiveState() {
  const video = $("#camera-preview"), img = $("#camera-captured-img");
  const live = $("#camera-controls-live"), preview = $("#camera-controls-preview");
  if (video) video.classList.remove("hidden");
  if (img) img.classList.add("hidden");
  if (live) live.classList.remove("hidden");
  if (preview) preview.classList.add("hidden");
}
function capturePhoto() {
  const video = $("#camera-preview"), canvas = $("#camera-canvas");
  if (!video || !canvas || !video.videoWidth) return;
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  // Фронтальная камера превью зеркалится для привычного вида "как в
  // зеркале" — сам снимок сохраняем НЕзеркальным (как его видит
  // собеседник, а не как видел себя отправитель).
  if (__camera.facing === "user") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) return;
    __camera.capturedBlob = blob;
    const img = $("#camera-captured-img");
    if (img) { img.src = URL.createObjectURL(blob); img.classList.remove("hidden"); }
    const video2 = $("#camera-preview"); if (video2) video2.classList.add("hidden");
    const live = $("#camera-controls-live"), preview = $("#camera-controls-preview");
    if (live) live.classList.add("hidden");
    if (preview) preview.classList.remove("hidden");
  }, "image/jpeg", 0.9);
}
let __cameraAvailable = true;
function wireCameraScreen() {
  const openBtn = $("#chat-camera-btn");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    __cameraAvailable = false;
    if (openBtn) openBtn.classList.add("hidden");
    return;
  }
  if (openBtn) openBtn.addEventListener("click", () => { if (state.chatId) openCameraScreen(state.chatId); });
  const closeBtn = $("#camera-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeCameraScreen);
  const switchBtn = $("#camera-switch-btn");
  if (switchBtn) switchBtn.addEventListener("click", () => { haptic("light"); startCameraStream(__camera.facing === "environment" ? "user" : "environment"); });
  const shutterBtn = $("#camera-shutter-btn");
  if (shutterBtn) shutterBtn.addEventListener("click", () => { haptic("medium"); capturePhoto(); });
  const retakeBtn = $("#camera-retake-btn");
  if (retakeBtn) retakeBtn.addEventListener("click", () => {
    const img = $("#camera-captured-img");
    if (img && img.src) { URL.revokeObjectURL(img.src); img.src = ""; }
    __camera.capturedBlob = null;
    showCameraLiveState();
  });
  const sendBtn = $("#camera-send-btn");
  if (sendBtn) sendBtn.addEventListener("click", () => {
    if (!__camera.capturedBlob || !__camera.contactId) return;
    const file = new File([__camera.capturedBlob], "photo-" + Date.now() + ".jpg", { type: "image/jpeg" });
    const contactId = __camera.contactId;
    closeCameraScreen();
    sendFileMessage(contactId, file);
  });
}
function wireSheetBackdrops() {
  $$(".sheet-backdrop").forEach((el) => {
    el.addEventListener("click", () => { const s = el.closest(".sheet"); if (s) s.classList.add("hidden"); });
  });
  $$(".sheet-cancel").forEach((btn) => {
    btn.addEventListener("click", () => { const id = btn.dataset.closeSheet; if (id) { const el = $("#" + id); if (el) el.classList.add("hidden"); } });
  });
  // Ручка (.sheet-handle) была чисто декоративной — визуально обещает
  // "потяни, чтобы закрыть" (знакомый паттерн из iOS/Telegram/WhatsApp),
  // но ничего не делала. Жест только на самой ручке (не на всей панели)
  // — безопасно, не может конфликтовать со скроллом контента внутри
  // шторки (.sheet-panel сам по себе прокручиваемый).
  $$(".sheet-handle").forEach((handle) => {
    let startY = 0, dragging = false, panel = null;
    handle.addEventListener("touchstart", (e) => {
      startY = e.touches[0].clientY;
      dragging = true;
      panel = handle.closest(".sheet-panel");
      if (panel) panel.style.transition = "none";
    }, { passive: true });
    handle.addEventListener("touchmove", (e) => {
      if (!dragging || !panel) return;
      const dy = Math.max(0, e.touches[0].clientY - startY);
      panel.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    handle.addEventListener("touchend", (e) => {
      if (!dragging) return;
      dragging = false;
      const dy = Math.max(0, (e.changedTouches[0] ? e.changedTouches[0].clientY : startY) - startY);
      if (panel) {
        panel.style.transition = "";
        panel.style.transform = "";
      }
      if (dy > 60) { const s = handle.closest(".sheet"); if (s) s.classList.add("hidden"); }
    });
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
      const DEFAULT_QUICK_REACTIONS = ["❤️", "👍", "👎", "😂", "😮", "😢"];
      const recent = Store.recentReactions;
      const quickSet = (recent.length > 0 ? recent : DEFAULT_QUICK_REACTIONS).slice(0, 6);
      const renderEmojiBtn = (emoji) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "reaction-emoji"; b.textContent = emoji;
        b.addEventListener("click", () => { const ms = $("#message-sheet"); if (ms) ms.classList.add("hidden"); toggleReaction(contactId, msgId, emoji); });
        return b;
      };
      quickSet.forEach((emoji) => bar.appendChild(renderEmojiBtn(emoji)));
      // "+" открывает полную сетку из 110 — раньше она была видна
      // ВСЕГДА целиком, теперь только по явному запросу.
      const expandBtn = document.createElement("button");
      expandBtn.type = "button"; expandBtn.className = "reaction-emoji reaction-expand";
      expandBtn.setAttribute("aria-label", T("chat.reactionMore"));
      expandBtn.textContent = "+";
      expandBtn.addEventListener("click", () => {
        bar.innerHTML = "";
        bar.classList.add("reaction-bar-expanded");
        REACTION_EMOJIS.forEach((emoji) => bar.appendChild(renderEmojiBtn(emoji)));
      });
      bar.appendChild(expandBtn);
      bar.classList.remove("reaction-bar-expanded");
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
  if (m.ack === "failed" && isOwn && !groupCtx) actions.push(`<button type="button" class="sheet-action" data-action="retry">${escapeHtml(T("chat.retry"))}</button>`);
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
    m.ack = "sent";
    // Раньше retry шёл СРАЗУ через outbox/flushOutboxItem — то есть
    // только релей через сервер, минуя прямой P2P, даже если связь к
    // этому моменту уже восстановилась. trySendOrQueue — та же логика,
    // что использует обычная отправка: сначала пробует P2P напрямую,
    // и только при неудаче падает на сервер.
    if (outbox.has(msgId)) outbox.delete(msgId);
    const payload = { kind: "chat", id: msgId, text: m.text, ts: m.ts };
    if (m.replyTo) payload.replyTo = { id: m.replyTo.id, text: m.replyTo.text, authorName: m.replyTo.authorName };
    if (m.ttl) payload.ttl = m.ttl;
    trySendOrQueue(c, msgId, payload);
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
  // Если удаляют контакт прямо во время звонка с ним — раньше это
  // полагалось на побочный эффект mesh.remove() ниже, а не на настоящий
  // closeCallScreen(). pendingRemoteStreams и другая очистка (audio-
  // элемент, таймеры) живут именно в closeCallScreen — вызываем его
  // явно и первым, до разрыва mesh-связи.
  if (state.callId === id) closeCallScreen("failed");
  clearAutoConnectTimer(id);
  mesh.remove(id);
  const c0 = state.contacts.get(id);
  if (c0) cleanupExpiredFileBlobs(c0.messages);
  pendingNoKey.delete(id); persistPendingNoKey();
  for (const [msgId, entry] of outbox) if (entry.to === id) outbox.delete(msgId);
  persistOutbox();
  delete state.lastSeen[id]; persistLastSeen();
  delete state.drafts[id]; persistDrafts();
  unreadDividerFor.delete(id);
  dividerScrolledFor.delete(id);
  relayAttemptCooldown.delete(id);
  if (state.activeContactContext === id) state.activeContactContext = null;
  const audioEl = document.getElementById("remote-audio-" + id); if (audioEl) audioEl.remove();
  state.contacts.delete(id);
  recentlyDeletedIds.add(id);
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
  // Старые записи (сохранённые до появления бейджа непросмотренных
  // пропущенных) не имеют поля seen вовсе — без этой нормализации все
  // они разом стали бы "непросмотренными" при первом запуске после
  // обновления. Считаем их уже просмотренными.
  for (const r of state.callLog) if (r.seen === undefined) r.seen = true;
}
function persistCallLog() { try { Store.callLogJson = JSON.stringify(state.callLog.slice(-MAX_CALL_LOG)); } catch (e) { handlePersistError(e, "callLog"); } }
function startCallRecord(contactId, direction) {
  const c = state.contacts.get(contactId);
  state.currentCallRecord = {
    id: crypto.randomUUID(), contactId,
    contactName: c ? c.name : "",
    direction, status: direction === "out" ? "calling" : "ringing",
    startedAt: Date.now(), answeredAt: null, endedAt: null, durationMs: 0,
    seen: direction === "out", // исходящие не считаются "пропущенными", входящие — непросмотренными, пока не открыта вкладка "Звонки"
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
  updateCallsBadge();
}
function callStatusLabel(rec) {
  if (rec.status === "completed") {
    const key = rec.direction === "out" ? "calls.systemCompletedOut" : "calls.systemCompletedIn";
    return T(key, { duration: formatDuration(rec.durationMs) });
  }
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
    // Раньше любой неуспешный статус (busy/declined/failed/cancelled)
    // красился как "пропущенный" (красный) — в том числе отменённый
    // САМИМ пользователем исходящий звонок, будто ему не ответили.
    const isMissed = rec.status === "missed";
    const dirIcon = isMissed ? "missed" : (rec.direction === "in" ? "in" : "out");
    const arrowSvg = rec.direction === "in"
      ? `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4v-2z"/></svg>`;
    const row = document.createElement("div");
    row.className = "call-row flat-content";
    const canOpen = state.contacts.has(rec.contactId);
    row.innerHTML = `
      <button type="button" class="call-row-main"${canOpen ? "" : " disabled"}>
        <div class="call-direction-icon ${dirIcon}">${arrowSvg}</div>
        <div class="call-body">
          <div class="call-name">${escapeHtml(name)}</div>
          <div class="call-sub">${escapeHtml(callStatusLabel(rec))} · ${escapeHtml(formatDay(rec.startedAt))} ${escapeHtml(formatTime(rec.startedAt))}</div>
        </div>
      </button>
      <button type="button" class="call-back-btn" aria-label="${escapeHtml(T("chat.call"))}" ${c ? "" : "disabled"}>
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.7 21 3 13.3 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8z"/></svg>
      </button>`;
    const backBtn = row.querySelector(".call-back-btn");
    if (backBtn && c) backBtn.addEventListener("click", (e) => { e.stopPropagation(); beginCall(rec.contactId); });
    // Раньше вся строка была <div> с click-обработчиком — без role, tabindex
    // или клавиатурного управления пользователь с клавиатурой/Switch Control
    // не мог открыть чат из истории звонков. Кнопка-обёртка для "открыть
    // чат" отдельно от кнопки "перезвонить" — вложенные <button> внутри
    // <button> невалидны и ведут себя непредсказуемо в браузерах.
    const mainBtn = row.querySelector(".call-row-main");
    if (mainBtn) mainBtn.addEventListener("click", () => { if (state.contacts.has(rec.contactId)) { state.chatId = rec.contactId; renderTab(); } });
    list.appendChild(row);
  }
}
function clearPendingCall() { if (pendingCall.timer) clearTimeout(pendingCall.timer); pendingCall.timer = null; pendingCall.contactId = null; }

async function beginCall(id, withVideo) {
  const c = state.contacts.get(id);
  if (!c) return;
  if (isGroup(c)) { toast(T("toast.callGroupsUnsupported")); return; }
  if (c.blocked) { toast(T("toast.blocked")); return; }
  if (state.callId && state.callId !== id) { toast(T("toast.alreadyInCall")); return; }
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

  signaling.signal(id, { t: "call-invite", n: Store.name, x: crypto.randomUUID() });

  const link = mesh.get(id);
  // Раньше здесь проверялся c.status (кэшированное поле контакта,
  // обновляемое отдельным обработчиком) вместо link.status
  // (актуальное состояние самого соединения) — при рассинхроне между
  // ними звонок мог либо пытаться стартовать на мёртвой связи, либо
  // ждать нового подключения, хотя рабочая связь уже была.
  if (link && (link.status === "connected" || link.status === "in-call")) {
    try { await link.startCall(withVideo); if (withVideo) showLocalVideoPreview(link); }
    catch (e) {
      // Раньше тут ВСЕГДА показывался toast.noServer, даже когда причина —
      // отказ в доступе к микрофону/камере (NotAllowedError) или их
      // отсутствие (NotFoundError). Пользователь видел "нет связи с
      // сервером" при полностью рабочем сервере — совершенно не по адресу.
      const name = e && e.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") toast(T("toast.callPermissionDenied"));
      else if (name === "NotFoundError" || name === "DevicesNotFoundError") toast(T("toast.voiceNoMic"));
      else toast(T("toast.noServer"));
      closeCallScreen("failed"); return;
    }
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
  // media-viewer, будучи position:fixed поверх всего окна, всё равно
  // закрыл бы обзор звонка, даже когда #call-screen стал обычным
  // flex-элементом (а не оверлеем, как раньше) — закрываем его.
  const mv = $("#media-viewer"); if (mv && !mv.classList.contains("hidden")) mv.classList.add("hidden");
  // #call-screen теперь обычный flex-элемент рядом с #content, а не
  // абсолютный оверлей поверх всего #app-shell — таб-бар остаётся
  // виден снизу, контролы звонка появляются НАД ним. Но #content и
  // #call-screen делят одну и ту же flex-ячейку по очереди: пока виден
  // звонок, список чатов/экраны должны быть скрыты явно, иначе оба
  // одновременно заняли бы по половине места.
  const contentEl = $("#content"); if (contentEl) contentEl.classList.add("hidden");
  if (state.callId !== id) {
    state._callUserAccepted = false;
    state._callAcceptInFlight = false;
    state._callMuteOnAnswer = false;
    speakerOn = false; // новый звонок всегда начинается с внутреннего динамика
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
  const cv = $(".call-volume"); if (cv) cv.classList.toggle("hidden", incoming);
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
  const cv = $(".call-volume"); if (cv) cv.classList.remove("hidden");
  startCallTimer();
  updateCallRecordStatus("active");
  if (state.callId && pendingRemoteStreams.has(state.callId)) {
    const stream = pendingRemoteStreams.get(state.callId);
    attachRemoteAudio(state.callId, stream);
    if (stream.getVideoTracks().length > 0) attachRemoteVideo(state.callId, stream);
    pendingRemoteStreams.delete(state.callId);
  }
}

async function findAudioOutputDevice(pattern) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const found = devices.find((d) => d.kind === "audiooutput" && pattern.test(d.label || ""));
    return found ? found.deviceId : null;
  } catch (e) { return null; }
}
// Веб-платформа не даёт напрямую переключить "наушник vs громкая связь" —
// единственный стандартный механизм — Audio Output Devices API
// (setSinkId), и то он выбирает КОНКРЕТНОЕ устройство вывода, а не
// абстрактный "режим". Поддержка сильно зависит от браузера/ОС — там,
// где API недоступен, честно сообщаем об этом, а не делаем вид, что
// переключили.
async function toggleSpeaker() {
  const id = state.callId; if (!id) return;
  const audioEl = document.getElementById("remote-audio-" + id);
  if (!audioEl || typeof audioEl.setSinkId !== "function") {
    toast(T("toast.speakerUnsupported"));
    return;
  }
  const wantSpeaker = !speakerOn;
  try {
    const deviceId = wantSpeaker
      ? (await findAudioOutputDevice(/speaker|loud/i)) || "default"
      : (await findAudioOutputDevice(/earpiece|receiver/i)) || "default";
    await audioEl.setSinkId(deviceId);
    speakerOn = wantSpeaker;
    const btn = $("#call-speaker-btn"); if (btn) btn.classList.toggle("active", speakerOn);
  } catch (e) {
    toast(T("toast.speakerUnsupported"));
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
    return { key: isOut ? "calls.systemCompletedOut" : "calls.systemCompletedIn", params: { duration: d } };
  }
  if (reason === "missed") return { key: isOut ? "calls.noAnswer" : "calls.missed" };
  if (reason === "cancelled") return { key: "calls.cancelled" };
  if (reason === "declined") return { key: "calls.declined" };
  if (reason === "busy") return { key: "calls.busy" };
  if (reason === "failed") return { key: "calls.failed" };
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
  const contentEl = $("#content"); if (contentEl) contentEl.classList.remove("hidden");
  const cm = $("#call-mute-btn"); if (cm) cm.classList.remove("active");
  const spkBtn = $("#call-speaker-btn"); if (spkBtn) spkBtn.classList.remove("active");
  speakerOn = false;
  const lbl = $("#call-mute-label"); if (lbl) lbl.textContent = T("call.mute");
  if (state.callId) {
    pendingRemoteStreams.delete(state.callId);
    // attachRemoteAudio() создаёт <audio id="remote-audio-*"> с живым
    // srcObject и никогда его не удаляла — раньше элемент чистился только
    // при deleteContact(). За много звонков подряд накапливались висящие
    // DOM-узлы и MediaStream'ы.
    const audioEl = document.getElementById("remote-audio-" + state.callId);
    if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl.srcObject = null; audioEl.remove(); }
  }
  state.callId = null;
  state.callPhase = null;
  if (state.tab === "chats" && state.chatsSegment === "calls") renderCallsList();

  if (rec && rec.contactId) {
    const c = state.contacts.get(rec.contactId);
    if (c) {
      const sysMsg = systemMessageForCall(rec, reason);
      if (sysMsg) {
        c.messages.push({ id: crypto.randomUUID(), from: "system", text: T(sysMsg.key, sysMsg.params), textKey: sysMsg.key, textParams: sysMsg.params, ts: Date.now() });
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
      // mesh.remove(cid) тут был лишним и единственным местом, где он
      // вызывается после завершения звонка — endCall() уже сам корректно
      // восстанавливает status в "connected", если data channel остался
      // открыт. Разрыв mesh-связи здесь означал, что после КАЖДОГО
      // исходящего "отбоя" P2P рвался без причины: следующее сообщение
      // уходило через сервер, а scheduleAutoConnect пересобирал связь
      // заново через 4 секунды — пользователь видел это как "после
      // звонка связь на секунду пропала".
      try { link.endCall(); } catch (e) {}
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
  const speakerBtn = $("#call-speaker-btn");
  if (speakerBtn) speakerBtn.addEventListener("click", () => toggleSpeaker());
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

    // Тот же фикс, что и в beginCall — проверяем актуальное link.status
    // напрямую, а не кэшированное c.status.
    if (link && (link.status === "connected" || link.status === "in-call")) {
      try {
        // Передаём state.callWantsVideo — теперь корректно выставлен из
        // payload.video входящего сигнала "ringing" (см. выше), вместо
        // того чтобы вызывать answerCall() без аргумента вовсе.
        await link.answerCall(state.callWantsVideo);
        if (state.callWantsVideo) showLocalVideoPreview(link);
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
        // Раньше пользователь тут не видел вообще ничего — экран звонка
        // просто зависал в состоянии "подключение", без единого
        // объяснения, пока другая сторона не получит таймаут.
        const name = e && e.name;
        if (name === "NotAllowedError" || name === "PermissionDeniedError") toast(T("toast.callPermissionDenied"));
        else if (name === "NotFoundError" || name === "DevicesNotFoundError") toast(T("toast.voiceNoMic"));
        else toast(T("toast.noServer"));
        closeCallScreen("failed");
        return;
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
  const helpBtn = $("#help-btn");
  if (helpBtn) helpBtn.addEventListener("click", () => {
    renderHelp();
    const el = $("#help-sheet"); if (el) el.classList.remove("hidden");
  });
  const nameEl = $("#settings-name");
  if (nameEl) nameEl.addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) {
      Store.name = v; toast(T("toast.nameUpdated"));
      // initSignaling() полностью пересоздаёт WebSocket — если сейчас идёт
      // звонок, лучше не рисковать кратким окном недоступности сигналинга
      // (может понадобиться ICE restart и т.п.) ради обновления имени.
      // Сервер узнает новое имя при следующем естественном переподключении.
      if (!state.callId) initSignaling();
    }
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
    } catch (err) { toast(T(err.message)); e.target.value = Store.myIdentityRaw; }
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
  const rcpt = $("#settings-receipts");
  if (rcpt) rcpt.addEventListener("change", (e) => { Store.receiptsEnabled = e.target.checked; });
  const lsv = $("#settings-last-seen");
  if (lsv) lsv.addEventListener("change", (e) => { Store.lastSeenVisible = e.target.checked; });
  const pv = $("#settings-presence");
  if (pv) pv.addEventListener("change", (e) => { Store.presenceVisible = e.target.checked; });
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
  let pinSheetMode = "new"; // "new" | "verify-old" | "enter-new" | "disable"
  function updateChangePinBtnVisibility() {
    const btn = $("#change-pin-btn"); if (btn) btn.classList.toggle("hidden", !Store.pinEnabled);
  }
  updateChangePinBtnVisibility();
  const pinlock = $("#settings-pinlock");
  if (pinlock) pinlock.addEventListener("change", (e) => {
    if (e.target.checked) {
      pinSheetMode = "new";
      const st = $("#set-pin-title"); if (st) st.textContent = T("pin.newTitle");
    } else {
      pinSheetMode = "disable";
      const st = $("#set-pin-title"); if (st) st.textContent = T("pin.confirmTitle");
    }
    const si = $("#set-pin-input"); if (si) si.value = "";
    const ss = $("#set-pin-sheet"); if (ss) ss.classList.remove("hidden");
    setTimeout(() => { const i = $("#set-pin-input"); if (i) i.focus(); }, 50);
  });
  const changePinBtn = $("#change-pin-btn");
  if (changePinBtn) changePinBtn.addEventListener("click", () => {
    pinSheetMode = "verify-old";
    const st = $("#set-pin-title"); if (st) st.textContent = T("pin.confirmTitle");
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

    if (pinSheetMode === "new") {
      Store.pinSalt = randomSaltHex(16);
      Store.pinHash = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      Store.pinEnabled = true;
      updateChangePinBtnVisibility();
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
      toast(T("toast.pinOn"));
      return;
    }
    if (pinSheetMode === "disable") {
      const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      if (h !== Store.pinHash) { toast(T("toast.pinWrong")); return; }
      Store.pinEnabled = false;
      Store.pinHash = "";
      Store.pinSalt = "";
      updateChangePinBtnVisibility();
      const pl = $("#settings-pinlock"); if (pl) pl.checked = false;
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
      toast(T("toast.pinOff"));
      return;
    }
    if (pinSheetMode === "verify-old") {
      const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      if (h !== Store.pinHash) { toast(T("toast.pinWrong")); return; }
      // Старый PIN подтверждён — переходим ко ВТОРОЙ фазе: ввод НОВОГО
      // PIN. Раньше этой фазы не было вообще: экран просто закрывался,
      // и сменить PIN через интерфейс было физически невозможно.
      pinSheetMode = "enter-new";
      const st = $("#set-pin-title"); if (st) st.textContent = T("pin.newTitle");
      inp.value = "";
      inp.focus();
      return;
    }
    if (pinSheetMode === "enter-new") {
      Store.pinSalt = randomSaltHex(16);
      Store.pinHash = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
      toast(T("toast.pinChanged"));
      return;
    }
  });
  const slider = $("#glass-slider");
  if (slider) slider.addEventListener("input", (e) => { const t = parseFloat(e.target.value); const v = transparencyToAlpha(t); Store.glassAlpha = v; applyGlassAlpha(v); });
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
const HELP_SECTIONS = [
  "start", "contacts", "messaging", "media", "disappearing", "groups", "calls", "privacy", "settingsHelp",
];
function renderHelp() {
  const el = $("#help-content"); if (!el) return;
  el.innerHTML = HELP_SECTIONS.map((key) => {
    const title = T("help." + key + ".title");
    const body = T("help." + key + ".body");
    return `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`;
  }).join("");
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
  const exportDiag = $("#export-diagnostics-btn");
  if (exportDiag) exportDiag.addEventListener("click", exportFullDiagnostics);

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
    onlineSet.clear(); outbox.clear(); pendingNoKey.clear(); seenDeliverIds.clear(); recentlyDeletedIds.clear();
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
function buildStorageText() {
  const items = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("ether.")) continue;
    const v = localStorage.getItem(k) || "";
    items.push({ key: k, size: v.length });
  }
  items.sort((a, b) => b.size - a.size);
  const totalBytes = items.reduce((s, x) => s + x.size, 0);
  const lines = [`localStorage: ${(totalBytes / 1024).toFixed(1)} KB, ${items.length} keys`];
  for (const it of items) lines.push(`  ${it.key}: ${it.size} B`);
  lines.push("UA: " + navigator.userAgent);
  return lines.join("\n");
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
function buildFullDiagnosticsText() {
  const sections = [
    ["=== " + T("debug.diagnostics") + " ===", buildDiagnosticsText()],
    ["=== " + T("debug.webrtc") + " ===", buildWebRtcText()],
    ["=== " + T("debug.storage") + " ===", buildStorageText()],
    ["=== " + T("debug.eventLog") + " ===", buildLogsText()],
  ];
  return sections.map(([title, body]) => title + "\n" + body).join("\n\n");
}
function exportFullDiagnostics() {
  const blob = new Blob([buildFullDiagnosticsText()], { type: "text/plain" });
  downloadBlob(blob, `ether-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`);
  toast(T("toast.diagnosticsSaved"));
}
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
        sendPrivacyPrefsTo(id);

        if (state.callId === id && link) {
          if (state.callPhase === "calling") {
            // Раньше видео зависело от !link._audioAdded — если аудио
            // УЖЕ было добавлено (например, после повторной попытки
            // соединения), весь блок пропускался целиком, и видео НЕ
            // включалось вовсе, хотя пользователь просил видеозвонок.
            // Аудио и видео — независимые проверки.
            if (!link._audioAdded) {
              link.startCall(state.callWantsVideo).then(() => { if (state.callWantsVideo) showLocalVideoPreview(link); }).catch((e) => etherLog("error", "[call] caller startCall failed:", String(e)));
            } else if (state.callWantsVideo && !link._videoAdded) {
              link.enableVideo().then((ok) => { if (ok) showLocalVideoPreview(link); }).catch((e) => etherLog("error", "[call] caller enableVideo failed:", String(e)));
            }
          } else if (state._callUserAccepted && state.callPhase !== "active") {
            // Тот же пропущенный video-флаг, что и в acceptCall().
            link.answerCall(state.callWantsVideo).then(() => {
              if (state.callWantsVideo) showLocalVideoPreview(link);
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
          // Раньше payload.video (отправляется звонящим в startCall)
          // тут вообще не читался — сигнал "это видеозвонок" терялся
          // на принимающей стороне, и answerCall() дальше вызывался без
          // аргумента, то есть видео никогда не включалось у того, кто
          // принимает, даже если звонили именно с видео.
          state.callWantsVideo = !!payload.video;
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
    if (state.editingMessageId) {
      commitEdit(state.chatId, state.editingMessageId, text);
      cancelEditing();
      // Черновик (если был) всё это время не трогался — восстанавливаем
      // его в поле, а не стираем: пользователь редактировал ЧУЖОЕ
      // сообщение, а не своё недописанное.
      const savedDraft = state.drafts[state.chatId];
      input.value = savedDraft || "";
      updateSendVsMic();
      return;
    }
    const cc = state.contacts.get(state.chatId);
    if (isGroup(cc)) sendGroupMessage(state.chatId, text, state.replyTo);
    else sendChatMessage(state.chatId, text, state.replyTo);
    cancelReply();
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
      if (state.editingMessageId) return; // не затираем черновик текстом редактируемого сообщения
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
  if (wrap) wrap.addEventListener("scroll", () => {
    updateScrollBottomButton();
    if (state.chatId && unreadDividerFor.has(state.chatId) && isNearBottom(wrap)) {
      const c = state.contacts.get(state.chatId);
      if (c) {
        unreadDividerFor.delete(state.chatId);
        dividerScrolledFor.delete(state.chatId);
        markThreadRead(c);
        const div = wrap.querySelector(".unread-divider");
        if (div) div.remove();
      }
    }
  });
}

// =====================================================================
// Boot-recovery
// =====================================================================
function showBootRecovery() {
  const o = document.getElementById("onboarding"); if (o) o.classList.add("hidden");
  const a = document.getElementById("app-shell"); if (a) a.classList.add("hidden");
  const l = document.getElementById("lock-screen"); if (l) l.classList.add("hidden");
  const r = document.getElementById("boot-recovery"); if (r) r.classList.remove("hidden");
  // На случай, если сбой случился настолько рано, что I18N.init()/
  // applyStaticTranslations() ещё не успели отработать (например,
  // ошибка ДО DOMContentLoaded) — заголовок иначе остался бы на
  // английском независимо от языка устройства.
  // Раньше тут стояла проверка !I18N.current — она никогда не истинна:
  // current инициализируется как DEFAULT_LANG на уровне модуля, до
  // всякого реального init(), так что I18N.init() по факту никогда не
  // вызывался этим путём. init() безопасен для повторного вызова
  // (просто перечитывает сохранённый язык из localStorage) — вызываем
  // безусловно, чтобы при раннем крэше (до нормального boot) заголовок
  // всё равно перевёлся на реальный язык пользователя, а не остался
  // на DEFAULT_LANG.
  try { if (typeof I18N !== "undefined") I18N.init(); } catch (e) {}
  try { applyStaticTranslations(); } catch (e) {}
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
    try { applyStaticTranslations(); } catch (e) {} // экран блокировки показывается ДО startApp() — переводим его до этого момента, а не после
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
    if (state.chatId) {
      const c = state.contacts.get(state.chatId);
      const wrap = $("#chat-messages");
      // Как и при открытии чата — помечаем прочитанным только если сейчас
      // реально виден низ переписки, а не потому что приложение просто
      // вернулось на передний план. Та же ошибка, что и в
      // renderChatThreadInner: "нет разделителя" не означает "видно всё" —
      // новое сообщение в уже прочитанном открытом чате не создаёт
      // разделитель вовсе, и старое условие срабатывало вне зависимости
      // от прокрутки.
      if (c && isNearBottom(wrap)) {
        unreadDividerFor.delete(state.chatId);
        dividerScrolledFor.delete(state.chatId);
        markThreadRead(c);
      }
    }
  }
});