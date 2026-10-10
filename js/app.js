"use strict";

// Держать в синхроне с файлом VERSION в корне проекта и с CACHE_VERSION
// в sw.js при каждом повышении версии — здесь оно только для показа в
// "О приложении" (#about-version), больше нигде не участвует.
const APP_VERSION = "V.62.0.8";

const DEFAULT_SIGNALING_URL = "wss://ether-1-baqy.onrender.com";
// Сервер перевода по умолчанию (LibreTranslate-совместимый). Официальный публичный инстанс обычно
// требует API-ключ — его можно указать в Настройках; свой сервер можно задать там же.
const DEFAULT_TRANSLATE_ENDPOINT = "https://libretranslate.com/translate";
const MAX_MESSAGE_LENGTH = 4000;
// Два разных числа: щедрый входной потолок (что можно ВЫБРАТЬ — есть что
// сжимать) и строгий целевой (что РЕАЛЬНО уйдёт получателю). Целевой
// потолок 2МБ меньше серверного MAX_PAYLOAD (8МБ, см. server.js) с
// большим запасом даже на base64-накладные расходы, поэтому отдельный,
// больший потолок специально для офлайн-очереди не нужен — один и тот же
// 2МБ работает и для живой P2P, и для очереди через сервер.
const MAX_FILE_SIZE_INPUT = 20 * 1024 * 1024; // 20 МБ — что можно ВЫБРАТЬ (даёт сжатию картинок что уменьшать)
// MAX_FILE_SIZE читается из js/file-limits.js — единственного источника
// правды, общего с тестом (test-file-size-validation.js), чтобы значение
// и условия валидации не могли разойтись между реальным кодом и тестом.
const MAX_FILE_SIZE = EtherFileLimits.MAX_FILE_SIZE; // 2 МБ — целевой потолок того, что РЕАЛЬНО отправляется
const FILE_CHUNK_SIZE = 48 * 1024; // кратно 3 — ровные base64-куски без паддинга внутри потока
const OUTBOX_LIMIT = 500;
const GROUP_DELIVERY_MAP_LIMIT = 2000;
const SEEN_DELIVER_LIMIT = 500;
const PENDING_CALL_TIMEOUT_MS = 25000;
// Контакт не в сети: ему уходит push, а приложение на телефоне ещё нужно запустить и подключить к серверу
// (холодный старт «спящего» сервера — десятки секунд), поэтому звоним заметно дольше.
const CALL_PUSH_TIMEOUT_MS = 55000;
const CALL_ACCEPT_CONNECT_MS = 25000; // сколько ждём P2P после нажатия «Принять»
const CALL_INVITE_RESEND_MS = 4000;   // пока звоним без P2P, повторяем call-invite: получатель мог ещё не подключиться к серверу
const CALL_SERVER_WAIT_MS = 10000;    // сколько ждём подключения к серверу перед тем как сдаться
const OUTBOX_RETRY_INTERVAL_MS = 15000;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const RECEIPT_MAX_AGE_MS = 24 * 3600 * 1000;
const RESUME_MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_CALL_LOG = 500;
const MAX_MESSAGES_PER_CHAT = 5000;
const TYPING_DEBOUNCE_MS = 1200;
const TYPING_AUTO_CLEAR_MS = 4000;
// Один набор эмодзи (js/emoji-data.js) и для ввода сообщений, и для реакций: EMOJI_GROUPS — категории, EMOJI_NAMES / EMOJI_RU — для поиска.
const EMOJI_CATEGORIES = EMOJI_GROUPS.map((g) => ({ id: g.id, icon: g.icon, emojis: g.list.split(" ") }));

// Раздел 9 роадмапа — категории Settings с back-навигацией вместо
// плоского списка ~13 секций. Каждая категория — это ПОДМНОЖЕСТВО уже
// существующих .settings-group (см. data-settings-category на них в
// index.html), сгруппированных по смыслу; внутри самих групп ничего не
// менялось — только добавлен уровень навигации сверху. iconPath — один
// SVG path (без обёртки <svg>, чтобы не плодить 6 почти одинаковых
// строк разметки в renderSettingsCategories()).
const SETTINGS_CATEGORIES = [
  { id: "profile", labelKey: "settings.category.profile", iconPath: "M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.2-8 5v3h16v-3c0-2.8-3.6-5-8-5z" },
  { id: "privacy", labelKey: "settings.category.privacy", iconPath: "M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3zm0 9.99h6c-.5 3.6-2.9 6.8-6 8-3.1-1.2-5.5-4.4-6-8h6V4.2l6 2.2v4.6l-6-1.03z" },
  { id: "notifications", labelKey: "settings.category.notifications", iconPath: "M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5a6 6 0 0 0-4-5.66V5a2 2 0 1 0-4 0v.34A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z" },
  { id: "appearance", labelKey: "settings.category.appearance", iconPath: "M12 2a10 10 0 1 0 0 20c.8 0 1.4-.6 1.4-1.4 0-.4-.2-.7-.4-1-.3-.3-.4-.6-.4-1 0-.8.6-1.4 1.4-1.4h1.7a5.3 5.3 0 0 0 5.3-5.3C21 6.6 17 2 12 2zM6.5 11a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" },
  { id: "data", labelKey: "settings.category.data", iconPath: "M4 6a8 3 0 1 0 16 0 8 3 0 1 0-16 0zm0 0v12a8 3 0 0 0 16 0V6M4 11a8 3 0 0 0 16 0" },
  { id: "help", labelKey: "settings.category.help", iconPath: "M11 18h2v-2h-2v2zm1-16a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm0 3a3.5 3.5 0 0 0-3.5 3.5h2a1.5 1.5 0 1 1 3 0c0 .8-.4 1.2-1.1 1.8-.8.7-1.9 1.6-1.9 3.2h2c0-.8.4-1.2 1.1-1.8.8-.7 1.9-1.6 1.9-3.2A3.5 3.5 0 0 0 12 7z" },
];
// Раздел 6 роадмапа — skin-tone selector для inline-эмодзи-пикера.
// Полноценный выезд пикера как inline-панели (вместо текущего
// bottom-sheet) остаётся отдельной отложенной задачей — слишком крупная
// переделка разметки/жестов для одного PR; сам skin-tone selector,
// наоборот, самодостаточен и не зависит от того, как показан пикер.
// SKIN_TONE_MODIFIERS — порядок и ID тонов; "none" не добавляет модификатор
// (классический жёлтый эмодзи-дефолт), остальные пять — стандартные
// Unicode Fitzpatrick-модификаторы (U+1F3FB..U+1F3FF). swatch — только для
// рендера круглой кнопки-превью в самом пикере, не влияет на сам эмодзи.
const SKIN_TONE_MODIFIERS = [
  { id: "none", mod: "", swatch: "#ffcc4d" },
  { id: "light", mod: "\u{1F3FB}", swatch: "#fadcbc" },
  { id: "mediumLight", mod: "\u{1F3FC}", swatch: "#e0bb95" },
  { id: "medium", mod: "\u{1F3FD}", swatch: "#bf8f68" },
  { id: "mediumDark", mod: "\u{1F3FE}", swatch: "#9b643d" },
  { id: "dark", mod: "\u{1F3FF}", swatch: "#594539" },
];
// Тон кожи применяется ко ВСЕМ эмодзи, которые его допускают (свойство Unicode Emoji_Modifier_Base: руки, жесты, люди и т.д.) —
// определяем по самому символу, а не по ручному списку; в каждой категории, где такие эмодзи есть. Для 🤝 дополнительно есть
// выбор двух разных тонов (долгое нажатие, см. buildHandshakeEmoji ниже).
const SKIN_TONE_BASE_RE = /^\p{Emoji_Modifier_Base}\uFE0F?$/u;
function emojiSupportsSkinTone(emoji) { try { return SKIN_TONE_BASE_RE.test(emoji); } catch (e) { return false; } }
// Официальная RGI-последовательность Unicode для рукопожатия с ДВУМЯ
// разными тонами кожи (см. комментарий к SKIN_TONE_MODIFIABLE выше):
// U+1FAF1 (rightwards hand) + модификатор + ZWJ + U+1FAF2 (leftwards hand)
// + модификатор. Если оба тона совпадают (или оба "none") — используется
// обычная одиночная форма 🤝<модификатор>, она короче и надёжнее
// отрисовывается на старых системах, чем ZWJ-последовательность с
// одинаковыми половинками.
const HANDSHAKE_RIGHTWARDS_HAND = "\u{1FAF1}";
const HANDSHAKE_LEFTWARDS_HAND = "\u{1FAF2}";
function buildHandshakeEmoji(toneAId, toneBId) {
  const a = SKIN_TONE_MODIFIERS.find((t) => t.id === toneAId) || SKIN_TONE_MODIFIERS[0];
  const b = SKIN_TONE_MODIFIERS.find((t) => t.id === toneBId) || SKIN_TONE_MODIFIERS[0];
  if (toneAId === toneBId) return "🤝" + a.mod;
  return HANDSHAKE_RIGHTWARDS_HAND + a.mod + "‍" + HANDSHAKE_LEFTWARDS_HAND + b.mod;
}
function applySkinTone(emoji) {
  if (!emojiSupportsSkinTone(emoji)) return emoji;
  const tone = Store.emojiSkinTone;
  if (tone === "none") return emoji;
  const entry = SKIN_TONE_MODIFIERS.find((t) => t.id === tone);
  return entry ? emoji.replace(/\uFE0F/g, "") + entry.mod : emoji;
}
// Поиск по английскому названию символа Unicode и по русским ключевым словам — по всему набору, а не только по текущей категории.
function emojiSearchResults(query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const seen = new Set(), out = [];
  for (const cat of EMOJI_CATEGORIES) for (const e of cat.emojis) {
    if (seen.has(e)) continue;
    if (((EMOJI_NAMES[e] || "") + " " + (EMOJI_RU[e] || "")).includes(q)) { seen.add(e); out.push(e); }
  }
  return out;
}

const UNLOCK_ATTEMPTS_LIMIT = 5;
const P2P_FALLBACK_MS = 1500;
const ONBOARDING_HINT_SHOWN = "ether.hintShown";
const PIN_ITERATIONS = 120000;
const DEBUG_KEY = "ether.debugHidden";
const CONNECT_STUCK_MS = 30000;
const WATCH_CONNECT_TIMEOUT_MS = 10000;  // базовое ожидание подключения; при повторных неудачах растёт (см. connectWaitMs)
// Чем больше подряд неудач с контактом, тем дольше ждём очередную попытку и тем реже стартуем новую: на плохой сети (3G/2G, LTE-модем)
// ICE и TURN просто не успевают за 10 секунд, а бесконечный цикл «создать — убить через 10 с» только мусорит и жжёт квоту TURN.
const connectFails = new Map();
function connectWaitMs(id) { const n = connectFails.get(id) || 0; return [10000, 16000, 24000, 32000][Math.min(n, 3)]; }
function connectRetryDelayMs(id) { const n = connectFails.get(id) || 0; return Math.min(800 * Math.pow(2, n), 20000); }
const ACK_DEDUP_WINDOW_MS = 5000;
const CALL_DEAD_LINK_TIMEOUT_MS = 10000;
const INCOMING_CALL_TIMEOUT_MS = PENDING_CALL_TIMEOUT_MS - 2000;
const INCOMING_PUSH_CALL_TIMEOUT_MS = CALL_PUSH_TIMEOUT_MS - 5000; // экран «входящий», открытый по нажатию на push // должен истекать НЕ ПОЗЖЕ, чем звонящий сдастся — иначе у принимающего экран "входящий" висит, когда звонящий уже положил трубку
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
  "ether.outbox", "ether.pendingNoKey", "ether.recentlyDeleted",
  "ether.theme", "ether.glassAlpha",
  "ether.notifications", "ether.sounds", "ether.ringtone", "ether.linkPreviews",
  "ether.vapidPublicKey", "ether.pushSubscription",
  "ether.callLog", "ether.lastSeen", "ether.drafts",
  "ether.callVolume", "ether.lang", "ether.recentReactions",
  "ether.chatFolders", "ether.emojiSkinTone", "ether.recentEmoji", "ether.myAvatar",
  "ether.translateEndpoint", "ether.translateApiKey",
  "ether.deadManEnabled", "ether.deadManThresholdDays", "ether.deadManContactId", "ether.deadManLastSentAt",
  "ether.panicShakeEnabled", "ether.fx", "ether.sigKey", "ether.fx.aurora", "ether.keyInfo",
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
  // "Перевести" (раздел 5 роадмапа) — честно пусто по умолчанию, НЕ
  // захардкожен публичный LibreTranslate-эндпоинт: текст сообщения ушёл
  // бы на сторонний сервер без явного согласия пользователя на то, какому
  // серверу он доверяет (симметрично предупреждению про link-previews
  // чуть выше в Settings).
  get translateEndpoint() { return localStorage.getItem("ether.translateEndpoint") || DEFAULT_TRANSLATE_ENDPOINT; },
  get translateApiKey() { return localStorage.getItem("ether.translateApiKey") || ""; },
  set translateApiKey(v) { localStorage.setItem("ether.translateApiKey", (v || "").trim()); scheduleIDBBackup(); },
  set translateEndpoint(v) { localStorage.setItem("ether.translateEndpoint", (v || "").trim()); scheduleIDBBackup(); },
  // killer-features-backlog 0.5 — "мягкий" Dead Man's Switch: честно не
  // обещаем настоящий фоновый триггер (Periodic Background Sync не работает
  // на iOS и сильно троттлится даже в Chrome) — вместо этого при каждом
  // открытии приложения отправляем доверенному контакту heartbeat
  // ("я жив"), а получатель при СВОЁМ открытии приложения сравнивает время
  // последнего полученного heartbeat с порогом. Срабатывает только если
  // кто-то из двоих реально откроет Эфир — это предел того, что может
  // честно гарантировать чистый PWA без сервера.
  get deadManEnabled() { return localStorage.getItem("ether.deadManEnabled") === "1"; },
  set deadManEnabled(v) { localStorage.setItem("ether.deadManEnabled", v ? "1" : "0"); scheduleIDBBackup(); },
  get deadManThresholdDays() { const n = parseInt(localStorage.getItem("ether.deadManThresholdDays") || "7", 10); return Number.isFinite(n) && n > 0 ? n : 7; },
  set deadManThresholdDays(v) { localStorage.setItem("ether.deadManThresholdDays", String(parseInt(v, 10) || 7)); scheduleIDBBackup(); },
  get deadManContactId() { return localStorage.getItem("ether.deadManContactId") || ""; },
  set deadManContactId(v) { localStorage.setItem("ether.deadManContactId", v || ""); scheduleIDBBackup(); },
  get deadManLastSentAt() { return parseInt(localStorage.getItem("ether.deadManLastSentAt") || "0", 10) || 0; },
  set deadManLastSentAt(v) { localStorage.setItem("ether.deadManLastSentAt", String(v || 0)); },
  // killer-features-backlog 1.7 — Panic Clean (встряхнуть телефон → очистка).
  // DeviceMotion на iOS 13+ требует явный permission-промпт по жесту
  // пользователя и ненадёжен в фоне — честно не "silent background
  // trigger", включается явным тумблером с предупреждением в UI.
  get panicShakeEnabled() { return localStorage.getItem("ether.panicShakeEnabled") === "1"; },
  set panicShakeEnabled(v) { localStorage.setItem("ether.panicShakeEnabled", v ? "1" : "0"); scheduleIDBBackup(); },
  get contactsJson() { return localStorage.getItem("ether.contacts") || "[]"; },
  set contactsJson(v) { localStorage.setItem("ether.contacts", v); scheduleIDBBackup(); },
  get outboxJson() { return localStorage.getItem("ether.outbox") || "[]"; },
  set outboxJson(v) { localStorage.setItem("ether.outbox", v); scheduleIDBBackup(); },
  // Отдельная (от outbox) персистентная карта "deliveryId получателя
  // группового сообщения -> {groupId, contentId}". outbox-запись
  // удаляется сразу по приходу deliver-ack с сервера (подтверждение,
  // что конверт лёг в mailbox получателя) — а настоящая квитанция
  // "доставлено"/"прочитано" от самого получателя может прийти намного
  // позже, когда он сам окажется онлайн. К этому моменту outbox уже
  // пуст, и markMessageAck не может сопоставить deliveryId с тем
  // сообщением в группе, которое надо пометить — см. groupDeliveryMap.
  get groupDeliveryMapJson() { return localStorage.getItem("ether.groupDeliveryMap") || "[]"; },
  set groupDeliveryMapJson(v) { localStorage.setItem("ether.groupDeliveryMap", v); scheduleIDBBackup(); },
  get pendingNoKeyJson() { return localStorage.getItem("ether.pendingNoKey") || "{}"; },
  set pendingNoKeyJson(v) { localStorage.setItem("ether.pendingNoKey", v); scheduleIDBBackup(); },
  get recentlyDeletedJson() { return localStorage.getItem("ether.recentlyDeleted") || "{}"; },
  set recentlyDeletedJson(v) { localStorage.setItem("ether.recentlyDeleted", v); scheduleIDBBackup(); },
  get callLogJson() { return localStorage.getItem("ether.callLog") || "[]"; },
  set callLogJson(v) { localStorage.setItem("ether.callLog", v); scheduleIDBBackup(); },
  get lastSeenJson() { return localStorage.getItem("ether.lastSeen") || "{}"; },
  set lastSeenJson(v) { localStorage.setItem("ether.lastSeen", v); scheduleIDBBackup(); },
  get draftsJson() { return localStorage.getItem("ether.drafts") || "{}"; },
  set draftsJson(v) { localStorage.setItem("ether.drafts", v); scheduleIDBBackup(); },
  get scheduledMessagesJson() { return localStorage.getItem("ether.scheduledMessages") || "[]"; },
  set scheduledMessagesJson(v) { localStorage.setItem("ether.scheduledMessages", v); scheduleIDBBackup(); },
  // Раздел 4 роадмапа: кастомные папки чатов (Работа/Семья/...) —
  // именованные наборы id контактов, хранятся как плоский массив
  // {id, name, contactIds[]}, тот же паттерн, что scheduledMessages.
  get chatFoldersJson() { return localStorage.getItem("ether.chatFolders") || "[]"; },
  set chatFoldersJson(v) { localStorage.setItem("ether.chatFolders", v); scheduleIDBBackup(); },
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
  // P2.39 — автозамена текстовых смайликов на эмодзи при отправке. Вкл. по
  // умолчанию (большинство мессенджеров делают так же), но можно отключить.
  get autoEmoji() { return localStorage.getItem("ether.autoEmoji") !== "0"; },
  set autoEmoji(v) { localStorage.setItem("ether.autoEmoji", v ? "1" : "0"); scheduleIDBBackup(); },
  // Раздел 6 роадмапа — skin-tone selector для эмодзи-пикера. Храним ID
  // тона ("none"/"light"/"mediumLight"/"medium"/"mediumDark"/"dark"), а не
  // сам Unicode-модификатор, — удобнее сверяться с SKIN_TONE_MODIFIERS и
  // не завязываться на конкретные кодпойнты при чтении из хранилища.
  get emojiSkinTone() { return localStorage.getItem("ether.emojiSkinTone") || "none"; },
  set emojiSkinTone(v) { localStorage.setItem("ether.emojiSkinTone", v); scheduleIDBBackup(); },
  get recentEmojiJson() { return localStorage.getItem("ether.recentEmoji") || "[]"; },
  set recentEmojiJson(v) { localStorage.setItem("ether.recentEmoji", v); scheduleIDBBackup(); },
  // Раздел 6 роадмапа — "кнопка «+» для композера" прямо в формулировке
  // задачи помечена риском для мышечной памяти существующих пользователей,
  // поэтому реализована как переключаемый эксперимент (выключен по
  // умолчанию), а не тихая замена трёх кнопок — см. wireComposerPlusMode().
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
  // Скрывать текст сообщения в системных уведомлениях (остаётся только
  // имя контакта и факт "новое сообщение") — для тех, кто не хочет,
  // чтобы содержимое мелькало на экране блокировки.
  get hideNotifContent() { return localStorage.getItem("ether.hideNotifContent") === "1"; },
  set hideNotifContent(v) { localStorage.setItem("ether.hideNotifContent", v ? "1" : "0"); },
  get chatWallpaper() { return localStorage.getItem("ether.chatWallpaper") || "none"; },
  set chatWallpaper(v) { localStorage.setItem("ether.chatWallpaper", v); scheduleIDBBackup(); },
  get bubbleSize() { return localStorage.getItem("ether.bubbleSize") || "normal"; },
  set bubbleSize(v) { localStorage.setItem("ether.bubbleSize", v); scheduleIDBBackup(); },
  // Отдельно от bubbleSize: тот меняет только размер/паддинг ПУЗЫРЕЙ
  // сообщений, этот — размер ВСЕГО текста приложения (доступность).
  get fontSize() { return localStorage.getItem("ether.fontSize") || "normal"; },
  set fontSize(v) { localStorage.setItem("ether.fontSize", v); scheduleIDBBackup(); },
  get calmMode() { return localStorage.getItem("ether.calmMode") === "1"; },
  set calmMode(v) { localStorage.setItem("ether.calmMode", v ? "1" : "0"); scheduleIDBBackup(); },
  get myAvatar() { return localStorage.getItem("ether.myAvatar") || ""; },
  set myAvatar(v) { if (v) localStorage.setItem("ether.myAvatar", v); else localStorage.removeItem("ether.myAvatar"); scheduleIDBBackup(); broadcastPrivacyPrefs(); },
  get myStatus() { return localStorage.getItem("ether.myStatus") || ""; },
  set myStatus(v) { localStorage.setItem("ether.myStatus", v || ""); scheduleIDBBackup(); broadcastPrivacyPrefs(); },
};

// =====================================================================
// Логирование
// =====================================================================
window.__etherDiag = window.__etherDiag || [];
if (typeof window.etherLog !== "function") {
  // Дублирует фильтр из signaling-client.js (которая обычно грузится
  // первой и на практике и определяет активную etherLog) — если
  // порядок скриптов когда-нибудь поменяется, поведение должно
  // остаться тем же: "info" не идёт в консоль вне localhost/debug-режима.
  window.etherLog = function (level, ...args) {
    const line = args.map((a) => (typeof a === "string" ? a : safeJsonArg(a))).join(" ");
    window.__etherDiag.push({ ts: Date.now(), level, line });
    if (window.__etherDiag.length > 500) window.__etherDiag.shift();
    let shouldPrint = true;
    if (level === "info") {
      shouldPrint = false;
      try {
        if (location.hostname === "localhost" || location.hostname === "127.0.0.1") shouldPrint = true;
        else if (typeof Store !== "undefined" && Store.debugHidden === false) shouldPrint = true;
      } catch (e) {}
    }
    if (shouldPrint) (console[level] || console.log).apply(console, args);
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
  contactsSearchQuery: "",
  lastSeen: {},
  drafts: {},
  scheduledMessages: [],
  folders: [], // раздел 4 роадмапа: кастомные папки чатов {id, name, contactIds[]}
  typingTimers: new Map(),
  typingSendingState: new Map(),
  unlockAttempts: 0,
  _callUserAccepted: false,
  _callAcceptInFlight: false,
  _callMuteOnAnswer: false,
  _callDeadSeconds: 0,
  _lastCallFailedAt: 0,   // ← новое
  chatFilter: "all", // "all" | "unread" | "groups" | "direct" — чипы-фильтры над списком чатов
  _firstRenderDone: false, // снимается через 400мс после старта — пока false, список чатов рисует skeleton вместо "пусто"
  multiSelect: null, // Set<id> выбранных сообщений в режиме мультивыбора, либо null вне режима
  mentionedChats: new Set(), // id чатов, где есть непрочитанное упоминание @меня
  settingsCategory: null, // раздел 9 роадмапа: null = список категорий Settings, иначе id открытой категории (см. SETTINGS_CATEGORIES)
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
let __panicTaps = []; // P3.47 — 5 тапов по логотипу в "О приложении"
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
// Раньше это был чисто in-memory Set — после перезапуска страницы/приложения
// он пустел, и настойчивый (или несработавший deleteContact у) собеседник,
// продолжающий слать offer'ы, снова "воскрешал" удалённого контакта.
// Теперь это Map<id, deletedAtTs> с персистентностью в localStorage и TTL:
// вечно висящая блокировка не нужна (если через 7 дней от того же id
// придёт offer — это, скорее всего, уже не "воскрешение", а осознанное
// повторное появление), а .delete(id) при явном повторном добавлении (см.
// addContactById/acceptPendingRequest) снимает блокировку немедленно, как
// и раньше.
const RECENTLY_DELETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const recentlyDeletedIds = new Map();
function persistRecentlyDeleted() {
  const obj = {}; for (const [id, ts] of recentlyDeletedIds) obj[id] = ts;
  try { Store.recentlyDeletedJson = JSON.stringify(obj); } catch (e) { handlePersistError(e, "recentlyDeleted"); }
}
function restoreRecentlyDeleted() {
  let obj = {}; try { obj = JSON.parse(Store.recentlyDeletedJson) || {}; } catch (e) { obj = {}; }
  if (!obj || typeof obj !== "object") return;
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(obj)) {
    const ts = obj[id];
    if (typeof ts !== "number" || !Number.isFinite(ts) || now - ts > RECENTLY_DELETED_TTL_MS) { changed = true; continue; }
    recentlyDeletedIds.set(id, ts);
  }
  if (changed) persistRecentlyDeleted(); // чистим протухшие записи сразу, а не ждём следующего add()
}
const autoConnectTimers = new Map();
const recentSignalNonces = new Set();
const outbox = new Map();
// deliveryId (случайный UUID на каждого получателя группового
// сообщения, см. sendGroupMessage) -> { groupId, contentId }. Переживает
// удаление соответствующей записи из outbox — см. комментарий у
// Store.groupDeliveryMapJson и resolveGroupDelivery().
const groupDeliveryMap = new Map();
const pendingNoKey = new Map();
const seenGroupInviteIds = new Set(); // отдельно от seenDeliverIds, чтобы инвайты не вытесняли обычные id
const seenDeliverIds = new Set(); // ключ — "from|msgId", не голый msgId (см. ниже)
const _connectInFlight = new Set();
// Недавно завершённые звонки — id собеседника -> timestamp. Защита от
// повторного "звонка" от того же человека в течение короткого окна
// после отбоя: WebRTC пересогласование после endCall() отправляет
// call-state:ringing по data channel, и без этой защиты можно снова
// услышать рингтон через 5-10 секунд после того, как уже положил трубку.
const recentlyEndedCalls = new Map();
const RECENTLY_ENDED_CALL_MS = 5000;

const pendingCall = { contactId: null, timer: null };
const pendingRemoteStreams = new Map();
// Отслеживание "новых" сообщений при входе в чат — id первого непрочитанного
// на момент открытия, contactId -> msgId. Пока запись есть, бейдж и
// разделитель "Непрочитанные сообщения" остаются на месте; снимается
// только когда пользователь реально долистал до конца (см. wireChatScreen
// обработчик scroll) — не сразу при открытии чата.
const unreadDividerFor = new Map();
const dividerScrolledFor = new Set(); // раньше scrollIntoView к разделителю срабатывал на КАЖДОМ рендере, пока он не снят — новое сообщение в чате откатывало прокрутку обратно к разделителю; теперь только один раз, на сам вход в чат
// ICE-кандидаты, пришедшие РАНЬШЕ offer/answer. С trickle ICE это
// нормальная гонка: offerer начинает gathering сразу после
// setLocalDescription, и его первый кандидат может долететь быстрее,
// чем сам SDP. Пока link для этого собеседника не создан —
// складываем в буфер, разбираем при создании (см. flushPendingIceFor).
const pendingIceCandidates = new Map(); // fromId -> [candidateJson]

function flushPendingIceFor(id, link) {
  const buf = pendingIceCandidates.get(id);
  if (!buf || buf.length === 0) return;
  pendingIceCandidates.delete(id);
  for (const c of buf) {
    link.addIceCandidate(c).catch(() => {});
  }
}
let __lastRenderedChatId = null;
// Набор id сообщений, отрендеренных при предыдущем рендере. Нужны
// только для того, чтобы понять, какие сообщения появились ТОЛЬКО
// ЧТО — им одним вешается класс just-sent/just-received, который
// запускает анимацию появления. При перерендере старого контента
// анимации быть не должно.
let __prevRenderedMsgIds = new Set();
let speakerOn = false; // по умолчанию — внутренний динамик (наушник); объявлена здесь, с остальными глобальными переменными, а не рядом с первым использованием
let callTimerInterval = null;
let globalAudioCtx = null;
let ringtoneTimer = null;
let ringtoneAudioEl = null;

// Screen Wake Lock API — удерживает экран включённым во время
// видеозвонка (на Android экран иначе гаснет через ~30с бездействия,
// что обрывает видеопревью у собеседника тёмным кадром). Для
// аудиозвонка НЕ запрашиваем — экран должен гаснуть сам, иначе ухо,
// поднесённое к телефону, нажимает кнопки на экране.
let wakeLock = null;
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (e) {
    etherLog("warn", "[wakelock] failed:", String(e));
  }
}
function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
}

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
  message: "sounds/msg.mp3",
  dialing: "sounds/call-dialing.mp3",
  busy: "sounds/call-busy.mp3",
  noanswer: "sounds/call-noanswer.mp3",
};
// P2.34 — разные звуки уведомления на контакт. Набор именованных стилей:
// у каждого свой mp3-файл (для фонового HTMLAudioElement-пути) И свой
// паттерн синтеза в Web Audio (для переднего плана, см. MESSAGE_TONE_PATTERNS
// в playMessageSound) — чтобы оба пути звучали одинаково узнаваемо.
const MESSAGE_SOUND_FILES = {
  default: "sounds/msg.mp3",
  chime: "sounds/msg-chime.mp3",
  pop: "sounds/msg-pop.mp3",
  bell: "sounds/msg-bell.mp3",
};
function messageSoundStyleForContact(contactId) {
  const c = contactId ? state.contacts.get(contactId) : null;
  const style = c && c.notificationSound;
  return (style && MESSAGE_SOUND_FILES[style]) ? style : "default";
}
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
  for (const src of [...Object.values(RINGTONES), ...Object.values(SOUND_FILES), ...Object.values(MESSAGE_SOUND_FILES)]) {
    const el = getSoundEl(src, false);
    if (el.dataset.unlocked) continue;
    if (el.dataset.unlocking) continue; // уже разблокируем прямо сейчас
    el.dataset.unlocking = "1";
    // Раньше тут использовался el.muted=true на время разблокировки — но
    // initAudioWarmup() вешает ОДИН И ТОТ ЖЕ обработчик сразу на touchstart
    // и click. Один тап пользователя генерирует оба события подряд, функция
    // вызывается дважды с интервалом в пару миллисекунд. Второй вызов читал
    // уже выставленный первым вызовом el.muted=true как "исходное" значение
    // и восстанавливал его же — элемент оставался muted НАВСЕГДА.
    const originalVolume = el.volume;
    // el.volume = 0 (как было раньше) на iOS НЕ считается за "реальное
    // воспроизведение" — браузер не помечает элемент как разрешённый к
    // автоплею, и следующий .play() из асинхронного события (входящий
    // звонок) падает с NotAllowedError. 0.01 достаточно, чтобы iOS
    // зачла это как звук, но на слух — почти неслышно.
    el.volume = 0.01;
    let p;
    try { p = el.play(); }
    catch (e) { el.volume = originalVolume; delete el.dataset.unlocking; continue; }
    const finish = () => {
      el.pause();
      el.currentTime = 0;
      el.volume = 1;
      el.dataset.unlocked = "1";
      delete el.dataset.unlocking;
    };
    if (p && typeof p.then === "function") {
      p.then(finish).catch(() => {
        el.volume = originalVolume || 1;
        delete el.dataset.unlocking;
      });
    } else {
      finish();
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
// Подсветка @упоминаний в тексте — раньше @Имя попадало в m.mentionMe
// (сам факт "меня упомянули" уже работал, см. isMentioned ниже), но
// визуально @Имя ничем не отличалось от обычного текста внутри самого
// сообщения. Чисто косметический проход: оборачивает ЛЮБОЙ "@слово" в
// span, не только реальных участников группы — так же делает подсветка
// в большинстве мессенджеров (разбор по факту существования контакта
// избыточен для простой визуальной подсказки).
function highlightMentions(html) {
  if (!html || html.indexOf("@") === -1) return html;
  return html.replace(/(^|[\s(])@([\p{L}\p{N}_]{1,32})/gu, (m, pre, name) => `${pre}<span class="mention">@${name}</span>`);
}
function linkifyAndHighlight(text, query) {
  const esc = escapeHtml(text);
  // Работаем с НЕэкранированным текстом для поиска (escapeHtml меняет
  // индексы из-за &amp; и т.п.), а на выходе экранируем каждый кусок
  // отдельно — так же, как делал старый код для нессылочных частей.
  const found = findAllUrls(text);
  let result = "";
  let lastIdx = 0;
  for (const u of found) {
    if (u.start > lastIdx) result += applyMarkdown(highlightMentions(highlightRaw(escapeHtml(text.slice(lastIdx, u.start)), query)));
    const hrefUrl = u.normalized; // https://... даже для "голого" домена — иначе браузер трактует как относительный путь
    const displayText = escapeHtml(u.raw); // показываем то, что пользователь реально написал (без добавленного https://)
    result += `<a href="${escapeHtml(hrefUrl)}" target="_blank" rel="noopener noreferrer">${highlightRaw(displayText, query)}</a>`;
    lastIdx = u.end;
  }
  if (lastIdx < text.length) result += applyMarkdown(highlightMentions(highlightRaw(escapeHtml(text.slice(lastIdx)), query)));
  return result || esc;
}
// P2.39 — автозамена текстовых смайликов на эмодзи при отправке (:) → 🙂
// и т.п.). Срабатывает один раз, в момент отправки — меняется реально
// отправляемый текст (как делают большинство мессенджеров), а не только
// отображение. Паттерны отсортированы длинными вариантами (":-)" и т.п.)
// ПЕРЕД короткими (":)"), чтобы альтернация регулярки не "откусывала"
// только короткий префикс длинного токена. Правая граница — lookahead
// (?=\s|$) (НЕ lookbehind — тот не везде поддерживается, см. комментарий
// у applyMarkdown); левая граница — обычная захватывающая группа
// (начало строки или пробел), которую возвращаем на место в замене.
const EMOJI_AUTO_REPLACE_MAP = [
  ["<3", "❤️"],
  [":'(", "😢"],
  [":-D", "😄"], [":D", "😄"],
  [":-P", "😛"], [":-p", "😛"], [":P", "😛"], [":p", "😛"],
  [":-O", "😮"], [":-o", "😮"], [":O", "😮"], [":o", "😮"],
  [";-)", "😉"], [";)", "😉"],
  [":-(", "🙁"], [":(", "🙁"],
  [":-)", "🙂"], [":)", "🙂"],
];
const EMOJI_AUTO_REPLACE_RE = new RegExp(
  "(^|\\s)(" + EMOJI_AUTO_REPLACE_MAP.map(([token]) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?=\\s|$)",
  "g"
);
const EMOJI_AUTO_REPLACE_LOOKUP = new Map(EMOJI_AUTO_REPLACE_MAP);
function applyEmojiAutoReplace(text) {
  if (!text || !Store.autoEmoji) return text;
  return text.replace(EMOJI_AUTO_REPLACE_RE, (m, prefix, token) => prefix + (EMOJI_AUTO_REPLACE_LOOKUP.get(token) || token));
}
// P2 — простое inline-форматирование: **bold**, *italic*, `code`.
// Применяется ПОСЛЕ escapeHtml И ПОСЛЕ highlightRaw (а не до) — иначе
// вставленные <mark> search-hit теги ломали бы индексы подсветки поиска
// (highlightRaw ищет indexOf по уже готовой строке; если бы markdown
// вставил теги раньше, запрос поиска мог бы случайно "попасть" внутрь
// имени тега). Делая это последним шагом, markdown-теги просто
// оборачивают уже готовый HTML (включая вложенный <mark>, если он есть)
// — вложение получается корректным в любом случае, потому что мы не
// трогаем символы '<'/'>' специально, просто ищем *…*, **…**, `…`.
// Код — первым (иначе звёздочки/подчёркивания внутри `code` были бы
// тоже разобраны как форматирование).
function applyMarkdown(html) {
  if (!html) return html;
  // Код — ПЕРВЫЙ проход, но содержимое `...` затем защищаем плейсхолдерами
  // перед bold/italic: раньше `**bold**` внутри code-спана сначала
  // становился <code>**bold**</code>, а второй проход (bold) находил
  // "**...**" ВНУТРИ уже вставленного <code> и подменял его на <strong> —
  // то есть markdown-разметка внутри кода рендерилась, хотя код по
  // определению должен показываться буквально, как есть. Вынимаем
  // содержимое code-спанов во временный массив на время bold/italic и
  // возвращаем обратно их точный текст в конце.
  const codeSpans = [];
  let out = html.replace(/`([^`\n]+?)`/g, (m, inner) => {
    codeSpans.push(inner);
    return "\u0000CODE" + (codeSpans.length - 1) + "\u0000";
  });
  // Без lookbehind (?<=...) намеренно — не все мобильные движки (старый
  // Safari/iOS) его поддерживают, а это код рендеринга КАЖДОГО сообщения.
  // ** съедается первым проходом, поэтому ко второму проходу (курсив)
  // одиночные "*" уже гарантированно не являются половинками "**".
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => "<code>" + codeSpans[Number(i)] + "</code>");
  return out;
}
// =====================================================================
// Превью ссылок
// =====================================================================
// Сервер видит саму ссылку (не текст сообщения) при первом запросе
// превью для неё — см. README. Кеш и на клиенте, и на сервере, поэтому
// повторный показ той же ссылки повторного запроса не делает.
// Раньше распознавались ТОЛЬКО ссылки с явным http(s):// — реальные
// пользователи чаще пишут просто "ya.ru" или "github.com" без протокола,
// и такие сообщения не распознавались как ссылки ВООБЩЕ: ни превью, ни
// кликабельность. Единая регулярка на три альтернативы (используется и
// здесь, и в linkifyAndHighlight — не дублируем логику):
//   1) явный http(s)://...
//   2) www.domain... (сам префикs www. — надёжный сигнал)
//   3) bareword.TLD — только по списку распознанных доменных зон, с
//      границей слова, чтобы не путать с версиями (3.14), сокращениями
//      (т.д., e.g.) и т.п.
// рф убран из списка: третья альтернатива URL_RE_SRC требует ASCII-метку
// перед TLD ([a-zA-Z0-9][a-zA-Z0-9-]*), поэтому "пример.рф" всё равно не
// распознавался бы — наличие рф в списке создавало ложное ощущение
// поддержки кириллических доменов без реальной функциональности.
// Расширение класса метки до [\p{L}\p{N}-] с флагом u решило бы это, но
// влияет на производительность regex-сканирования при каждом рендере
// сообщений — не делаем без явного запроса.
const URL_TLDS = "com|org|net|edu|gov|io|co|me|info|biz|ru|su|uk|de|fr|es|it|nl|pl|se|no|dk|fi|ch|at|be|pt|gr|cz|hu|ro|bg|hr|si|sk|lt|lv|ee|ua|by|kz|cn|jp|kr|in|au|nz|ca|br|mx|il|tr|ae|id|th|vn|ph|my|sg|hk|tw|app|dev|xyz|online|site|club|store|tech|shop|news|live|tv|fm|cc|to|gg|ai|link";
const URL_RE_SRC = "(https?://[^\\s<]+[^\\s<.,;:!?)])" +
  "|((?:^|[\\s(])((?:www\\.)[a-zA-Z0-9][a-zA-Z0-9-]*(?:\\.[a-zA-Z0-9][a-zA-Z0-9-]*)+(?:/[^\\s<.,;:!?)]*)?))" +
  "|((?:^|[\\s(])([a-zA-Z0-9][a-zA-Z0-9-]*(?:\\.[a-zA-Z0-9][a-zA-Z0-9-]*)*\\.(?:" + URL_TLDS + ")(?:/[^\\s<.,;:!?)]*)?)(?=[\\s).,;:!?]|$))";
// Находит ВСЕ ссылки в тексте (для linkifyAndHighlight). Каждый элемент:
// {start, end, raw, normalized} — raw как в тексте, normalized — с
// подставленным https:// для домена без протокола (для fetch/href).
function findAllUrls(text) {
  const re = new RegExp(URL_RE_SRC, "gi");
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] || m[3] || m[5];
    if (!raw) continue;
    const start = m.index + (m[0].length - raw.length);
    const normalized = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    results.push({ start, end: start + raw.length, raw, normalized });
    re.lastIndex = start + raw.length; // избегаем зацикливания/двойного счёта на группах 2/4 с ведущим пробелом
  }
  return results;
}
function extractFirstUrl(text) {
  const found = findAllUrls(String(text || ""));
  return found.length ? found[0].normalized : null;
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
    // Раньше здесь не было таймаута вовсе — на медленном/холодном сервере
    // (Render.com бесплатного тарифа засыпает при простое) fetch мог
    // зависнуть практически бесконечно. Слот превью (min-height: 2px)
    // так и оставался пустым и незаметным НАВСЕГДА — пользователь видел
    // только сырую ссылку без единого признака ошибки. Явный таймаут
    // гарантирует, что попытка рано или поздно завершится — либо успехом,
    // либо честным исчезновением слота (см. renderLinkPreviewInto).
    const r = await fetch(base + "/link-preview?url=" + encodeURIComponent(url), { cache: "default", signal: AbortSignal.timeout(10000) });
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
// Раньше renderChatThreadInner вызывал renderLinkPreviewInto (= реальный
// fetch) для КАЖДОЙ ссылки в чате сразу при рендере, независимо от того,
// видна ли она на экране. Для старого чата с сотней сообщений со ссылками
// это означало десятки параллельных запросов к /link-preview при первом
// открытии — а у сервера на этот эндпоинт стоит rate limit (30/мин на IP),
// в который легко попасть при активном использовании. Теперь слоты
// наблюдаются через IntersectionObserver, и фетчится только то, что
// реально прокручено во вьюпорт (с небольшим запасом по rootMargin, чтобы
// превью успевало подгрузиться чуть раньше, чем пользователь долистает).
// Один наблюдатель на всё приложение (root пересчитывается лениво, при
// первом использовании) — элементы наблюдаются и снимаются с наблюдения
// по ходу рендеров, а не пересоздаются целиком.
let linkPreviewObserver = null;
function observeLinkPreviewSlot(el) {
  if (!linkPreviewObserver) {
    linkPreviewObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        linkPreviewObserver.unobserve(entry.target);
        const url = entry.target.getAttribute("data-preview-for");
        if (url) renderLinkPreviewInto(url);
      }
    }, { root: document.getElementById("chat-messages"), rootMargin: "400px 0px" });
  }
  linkPreviewObserver.observe(el);
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
    const wrap = document.getElementById("chat-messages");
    if (!wrap) return;
    // entry === null означает "запрос ещё в полёте" — это не "превью
    // не существует", а "жди". Раньше на этот null мы УДАЛЯЛИ слот
    // (else slot.remove() ниже), и когда исходный fetch наконец
    // завершался — заполнять было уже нечего. Именно поэтому
    // собственное отправленное сообщение со ссылкой показывало
    // превью только после выхода из чата и повторного входа (тогда
    // данные уже в кэше и рендерятся сразу карточкой, без слота).
    // Первый вызов (тот, что реально делает HTTP-запрос) свой слот
    // дозаполнит сам — его `.then` сработает уже после этого.
    if (entry === null) return;
    const slots = wrap.querySelectorAll('.link-preview-slot[data-preview-for]');
    const ok = entry && entry.status === "done" && entry.data;
    const html = ok ? linkPreviewCardHtml(entry.data) : "";
    slots.forEach((slot) => {
      if (slot.getAttribute("data-preview-for") !== url) return;
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
// Инициалы: у имени из нескольких слов — первые буквы слов (до трёх: «Иван Петров» → ИП), у одного слова — первые две буквы
function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const words = s.split(/[\s\u00A0]+/).filter((w) => /^[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(w));
  if (words.length > 1) return words.slice(0, 3).map((w) => Array.from(w)[0]).join("").toUpperCase();
  return Array.from(s).slice(0, 2).join("").toUpperCase() || "?";
}
// Аватар-кружок для контакта/группы: если у группы загружена картинка
// (g.avatar, dataURL) — показываем её, иначе как раньше — градиент по
// имени с инициалами. sizeClass — доп. класс ("avatar-sm" и т.п.).
// c.avatar у группы может прийти из недоверенного входящего group-invite
// (applyIncomingPayload), не только из локально сжатого canvas.toDataURL.
// Раньше в avatarCircleHtml был escapeHtml(c.avatar) — но escapeHtml кодирует
// ' как &#39;, а HTML-парсер ДЕКОДИРУЕТ &#39; обратно в ' до того, как
// строка попадёт в CSS-парсер внутри style="...". То есть escapeHtml
// защищает от HTML-инъекции (закрытия атрибута кавычкой), но не от
// CSS-инъекции внутри уже открытого style — groupAvatar вида
// "'); position:fixed; width:100vw; height:100vh; z-index:9999; /*"
// после HTML-декодирования ломает style на новую декларацию и превращает
// аватар в полноэкранный оверлей (UI-redressing/фишинг), не исполняя JS, но
// и не блокируясь экранированием HTML-сущностей.
// Правильная защита — whitelist формата, а не экранирование: легитимный
// аватар (локальный canvas.toDataURL ИЛИ провалидированный при приёме
// group-invite, см. applyIncomingPayload) — всегда data:image/...;base64,
// с алфавитом [A-Za-z0-9+/=], в котором нет ни ', ни ;, ни пробелов —
// ничего, что могло бы вырваться из url('...'). Что не прошло whitelist —
// просто не рисуется как фон (остаются инициалы). Вынесено в константу
// модуля — avatarCircleHtml зовётся на каждый рендер списка чатов.
const AVATAR_DATAURL_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
function avatarCircleHtml(c, sizeClass, extraInner) {
  const cls = "avatar" + (sizeClass ? " " + sizeClass : "");
  const extra = extraInner || "";
  const shownAvatar = c && (c.avatar || c.peerAvatar); // своё фото контакта важнее присланного им самим
  if (shownAvatar && AVATAR_DATAURL_RE.test(shownAvatar)) {
    return `<div class="${cls}" style="background-image:url('${shownAvatar}')">${extra}</div>`;
  }
  return `<div class="${cls}" style="background:${avatarGradient(c && c.name)}">${escapeHtml(initials(c && c.name))}${extra}</div>`;
}

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
  // OLED — отдельная тема для выбора пользователем (настоящий чёрный фон
  // экономит заряд на AMOLED-экранах), но на уровне CSS-переменных она
  // работает как тёмная: html[data-theme="oled"] переопределяет только
  // --bg-0/--bg-1 в styles.css, остального (акценты, текст) не трогает.
  document.documentElement.dataset.theme = theme;
  __isLightCache = null; // инвалидируем кэш — тема поменялась
  const isLight = theme === "light" || (theme === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  // Обновлено под новую палитру: --bg-0 тёмный и --bg-0 светлый
  // совпадают с meta[theme-color] — статус-бар iOS теперь всегда
  // сливается с фоном приложения.
  if (meta) meta.setAttribute("content", isLight ? "#fafafc" : (theme === "oled" ? "#000000" : "#08080a"));
}
function applyChatAppearancePrefs() {
  const messages = $("#chat-messages");
  if (messages) messages.dataset.wallpaper = Store.chatWallpaper || "none";
  document.documentElement.dataset.bubbleSize = Store.bubbleSize || "normal";
  document.documentElement.dataset.fontSize = Store.fontSize || "normal";
}
// «Спокойный режим» — отключает анимацию фона и снижает блюр для тех,
// кому текущая эстетика (glass + градиентные волны) кажется отвлекающей
// при долгом чтении. Один флаг на html[data-calm-mode], вся логика — в CSS.
function applyCalmMode() {
  document.documentElement.dataset.calmMode = Store.calmMode ? "1" : "0";
}

try {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", () => { if (Store.theme === "auto") applyTheme("auto"); });
} catch (e) {}

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
let __nextSoundAt = 0;
// Флаг «разогрев уже сделан» — до этого три события одного тапа
// (touchstart + click + keydown) генерировали три параллельных
// ctx.resume(). На iPhone в логе видно ровно это:
//   22:13:39.061 [audio] ctx resumed, state=running
//   22:13:39.061 [audio] ctx resumed, state=running
//   22:13:39.061 [audio] ctx resumed, state=running
// Каждое resume() видело ctx.state === "suspended" ДО того, как
// предыдущее успевало его разбудить — три наложившихся запроса
// на один и тот же AudioContext. Не критично по эффекту, но грязно
// в логах и мешает диагностике. После первого успешного resume
// (или если ctx уже running) снимаем все слушатели — повторять
// смысла нет.
let __warmDone = false;
let __pendingMessageSound = false;
let __warmInProgress = false;
function initAudioWarmup() {
  const warm = () => {
    if (__warmDone || __warmInProgress) return;
    const ctx = ensureGlobalAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      // __warmInProgress ставим ДО ctx.resume(): пока промис не
      // разрешится, ctx.state всё ещё "suspended", и без этого флага
      // обработчики одного тапа (touchstart+click+keydown) параллельно
      // запускают resume — ровно то, что видно в логе 4 раза подряд.
      __warmInProgress = true;
      ctx.resume().then(() => {
        etherLog("info", "[audio] ctx resumed, state=" + ctx.state);
        __warmDone = true;
        __warmInProgress = false;
        document.removeEventListener("touchstart", warm);
        document.removeEventListener("click", warm);
        document.removeEventListener("keydown", warm);
          if (__pendingMessageSound) {
      __pendingMessageSound = false;
      try { playMessageSound(); } catch (e) {}
    }
    }).catch(() => { __warmInProgress = false; });
    } else if (ctx.state === "running") {
      __warmDone = true;
      document.removeEventListener("touchstart", warm);
      document.removeEventListener("click", warm);
      document.removeEventListener("keydown", warm);
    }
    try {
      // Пробный беззвучный осциллятор — это НЕ «разбудить ctx», а
      // проверить, что цепочка createOscillator → connect → start
      // вообще работает в текущем контексте (на iOS в standalone-PWA
      // бывают состояния, когда ctx.running, но звук всё равно
      // заблокирован политикой автовоспроизведения). Оставляем как
      // было — стоимость нулевая, польза от подтверждения есть.
      if (ctx.state === "running") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.01);
      }
    } catch (e) {}
    try { unlockSoundPool(); } catch (e) {}
    // startBackgroundAudioSession — по-прежнему закомментирован
    // (см. комментарий у самой функции).
    // try { startBackgroundAudioSession(); } catch (e) {}
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
function playMessageSound(contactId) {
  if (!Store.soundsEnabled) return;
  const style = messageSoundStyleForContact(contactId);
  // Гибридная схема: в foreground (приложение видно) играем через Web Audio
  // — быстро, точно, не зависит от разблокировки пула. В background — через
  // HTMLAudioElement, потому что Web Audio на iOS в фоне НЕ резюмируется:
  // ctx.resume() без user gesture молча не срабатывает, осцилляторы копятся
  // в очереди спящего контекста и выстреливают пачкой при следующем тапе.
  // Это ровно то, что видел пользователь: "звук не с первого раза, потом
  // сразу много".
  //
  // Ключевое отличие от прежнего кода: проверяем ctx.state === "running",
  // а не просто наличие ctx. Если контекст suspended — НЕ пытаемся играть
  // через него и НЕ вызываем resume() (в фоне он всё равно не сработает,
  // а в foreground следующий пользовательский жест всё равно проснёт его
  // через initAudioWarmup). Сразу падаем в HTMLAudioElement.
  const isForeground = document.visibilityState === "visible";
  const ctx = isForeground ? ensureGlobalAudioCtx() : null;
  if (ctx && ctx.state === "running") {
    try {
      const playTone = (freq, at, dur, vol) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(vol, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.start(at);
        osc.stop(at + dur + 0.05);
      };
      // __nextSoundAt ограничиваем "не дальше 500 мс от now" — если
      // контекст долго был suspended, __nextSoundAt мог уйти в далёкое
      // будущее, и следующий звук "улетел" бы за пределы слышимого.
      const now = ctx.currentTime;
      const startAt = Math.max(now + 0.01, Math.min(__nextSoundAt, now + 0.5));
      // Паттерн синтеза подобран так, чтобы звучать узнаваемо похоже на
      // соответствующий mp3-файл из MESSAGE_SOUND_FILES (фоновый фолбэк
      // ниже) — один и тот же "стиль" должен звучать одинаково что на
      // переднем плане (Web Audio), что в фоне (HTMLAudioElement).
      let dur2 = 0.26;
      if (style === "chime") { playTone(1046.5, startAt, 0.14, 0.15); playTone(1318.5, startAt + 0.1, 0.18, 0.13); dur2 = 0.28; }
      else if (style === "pop") { playTone(330, startAt, 0.1, 0.18); dur2 = 0.1; }
      else if (style === "bell") { playTone(1760, startAt, 0.5, 0.15); dur2 = 0.5; }
      else { playTone(880, startAt, 0.12, 0.15); playTone(1175, startAt + 0.08, 0.16, 0.13); }
      __nextSoundAt = startAt + dur2;
      return;
    } catch (e) { etherLog("warn", "[sound] message (webaudio):", String(e)); }
  }
  // Fallback — HTMLAudioElement. Единственный надёжный путь для фона
  // (и для foreground, если ctx почему-то suspended). Элемент разблокирован
  // unlockSoundPool() в первом user gesture.
  try {
    const el = getSoundEl(MESSAGE_SOUND_FILES[style] || SOUND_FILES.message, false);
    el.muted = false;
    el.volume = 1;
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch((e) => {
      const name = e && e.name;
      if (name === "NotAllowedError") {
        // iOS заблокировал play() до первого жеста пользователя —
        // это ОЖИДАЕМОЕ поведение при холодном старте, не ошибка.
        // Запоминаем флаг: initAudioWarmup проиграет отложенный звук
        // при первом touchstart/click/keydown.
        __pendingMessageSound = true;
        etherLog("info", "[sound] message: NotAllowedError — откладываю до первого жеста");
      } else {
        etherLog("warn", "[sound] message (audio):", String(e));
      }
    });
  } catch (e) { etherLog("warn", "[sound] message (audio):", String(e)); }
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
  // Форсируем resume() аудио-контекста — если пользователь уже
  // взаимодействовал с приложением хотя бы раз за сессию, на iOS
  // контекст в running, и осцилляторный фолбэк ниже сработает. Если
  // ещё не взаимодействовал — просто no-op, ничего не ломает.
  try { ensureAudioCtx(); } catch (e) {}
  if (!Store.soundsEnabled) { if (navigator.vibrate) { try { navigator.vibrate([400, 200, 400, 200, 400, 1000]); } catch (e) {} } return; }
  // Основной путь — HTMLAudioElement (mp3-файл рингтона). Он работает и в
  // foreground, и в background. Явно сбрасываем muted/volume перед play:
  // stopRingtone() мог оставить элемент в промежуточном состоянии, а
  // предыдущий проигрыш мог не завершиться корректно — оба приводили к
  // "второй звонок не сработал".
  try {
    ringtoneAudioEl = getSoundEl(currentRingtoneSrc(), true);
    ringtoneAudioEl.muted = false;
    ringtoneAudioEl.volume = 1;
    ringtoneAudioEl.currentTime = 0;
    const p = ringtoneAudioEl.play();
    if (p && p.catch) p.catch((e) => etherLog("warn", "[ringtone] play failed:", String(e)));
  } catch (e) { etherLog("warn", "[ringtone] failed:", String(e)); }

  if (navigator.vibrate) {
    try { navigator.vibrate([400, 200, 400, 200, 400, 1000]); } catch (e) {}
  }
  // Web Audio-дублирование — ТОЛЬКО если ctx реально running. Раньше здесь
  // было if (ctx) — и в момент, когда ctx был suspended (например,
  // приложение только что ушло в фон и звонок приходит уже в фоне),
  // планировались осцилляторы, которые никуда не звучали и накапливались,
  // а потом "выстреливали" при следующем пользовательском жесте. Плюс
  // setInterval создавал параллельный таймер, который продолжал работать
  // и после stopRingtone() — второй звонок накладывался на первый.
  try {
    const ctx = ensureGlobalAudioCtx();
    if (ctx && ctx.state === "running") {
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
  if (state._unlockLockedUntil && Date.now() < state._unlockLockedUntil) return;
  if (!Store.pinSalt) {
    if (await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) { localStorage.clear(); location.reload(); }
    return;
  }
  // pbkdf2Hex с 120000 итерациями занимает 200-500мс на мобильном.
  // Кнопка в это время не отвечает — показываем спиннер поверх неё,
  // чтобы не казалось, что нажатие не сработало.
  const btn = $("#lock-submit");
  if (btn) btn.classList.add("loading");
  let h;
  try {
    h = await pbkdf2Hex(pin, Store.pinSalt, PIN_ITERATIONS);
  } finally {
    if (btn) btn.classList.remove("loading");
  }
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
      if (await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) { localStorage.clear(); location.reload(); return; }
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
  if (forgot) forgot.addEventListener("click", async () => {
    if (await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) { localStorage.clear(); location.reload(); }
  });
}

// =====================================================================
// Онбординг и запуск
// =====================================================================
function bootAfterUnlock() {
  if (__appStarted) return;
  if (Store.name && Store.myId) {
    // Раньше здесь ЖДАЛИ window.__etherIceReady (ответ /ice с сервера)
    // ПЕРЕД тем, как вообще показать приложение — хотя ICE-серверы
    // нужны только в момент РЕАЛЬНОГО соединения (звонок, автоподключение
    // к чату), не для того, чтобы просто открыть список чатов. Если
    // сервер "холодный" (спит после простоя), это превращалось в
    // многосекундную задержку самого ПОКАЗА приложения — пользователь
    // видел пустой экран, хотя список чатов и все настройки уже давно
    // доступны локально. PeerLink теперь сам подстрахуется резервным
    // STUN, если ICE_SERVERS к моменту реального соединения ещё пуст
    // (см. webrtc.js) — ждать здесь стало не нужно вовсе.
    ensureKeyPair().catch(() => {}).then(() => {
      try { startApp(); }
      catch (e) { etherLog("error", "[startApp]", String(e)); }
    }).catch(() => {
      try { startApp(); } catch (e) {}
    });
  } else {
    // Предложение сменить язык теперь вызывается ЗДЕСЬ, до показа формы
    // регистрации — раньше maybeOfferSystemLanguage() вызывалась только
    // внутри startApp(), которая для нового пользователя срабатывает
    // уже ПОСЛЕ заполнения формы. #lang-offer вынесен из #app-shell
    // специально для этого (см. комментарий в CSS) — иначе физически
    // не мог бы показаться раньше.
    try { maybeOfferSystemLanguage(); } catch (e) {}
    const o = $("#onboarding"); if (o) o.classList.remove("hidden");
    wireOnboardingOnce();
  }
}
function initBoot() {
  // confirmSheet() используется и на экране блокировки (забыли PIN →
  // жёсткий сброс) — то есть ДО bootAfterUnlock()/основного safeCall-
  // списка, где эта шторка обычно подключалась бы. Подключаем здесь же,
  // раньше show/hide lock-screen, иначе на confirmSheet() с экрана
  // блокировки некому было бы ответить (шторка в DOM статична и есть
  // всегда, не хватало бы только обработчиков кнопок).
  wireConfirmSheet();
  wireLockScreen();
  if (Store.pinEnabled && Store.pinHash) { showLockScreen(); return; }
  bootAfterUnlock();
}
let __onboardingWired = false;
// Подключение change-обработчика для #import-backup-input — раньше
// жило только внутри wireDebugScreen(), которая запускается лишь
// ПОСЛЕ startApp(). На экране онбординга (до входа в приложение,
// сразу после переустановки) startApp() ещё не вызывался — кнопка
// импорта там открыла бы выбор файла, но сам выбор ничего бы не делал.
// Отдельная идемпотентная функция — вызывается и из онбординга, и из
// wireDebugScreen, но обработчик вешается не больше одного раза.
let __importBackupInputWired = false;
function wireImportBackupInput() {
  if (__importBackupInputWired) return;
  __importBackupInputWired = true;
  const impInput = $("#import-backup-input");
  if (impInput) impInput.addEventListener("change", importBackup);
}
// Раздел 2 роадмапа — флоу онбординга из 4 слайдов. Навигация — кнопки
// Next/Back (не свайп): для разового 4-шагового флоу это надёжнее, чем
// вводить ещё один жест, который пришлось бы отличать от уже существующих
// в приложении (свайп табов V.38.0.0, свайп строки чата и т.п.).
const ONBOARDING_SLIDE_COUNT = 4;
let __onboardingSlide = 0;
let __onboardingKeyPairPromise = null;
// 8 "популярных" языков для сетки на слайде 1 — не претендуют на
// исчерпывающий охват (как и EMOJI_CATEGORIES, который тоже не покрывает
// все ~3000 эмодзи): это быстрый путь для большинства, полный список из
// всех 72 языков доступен тут же через обычный <select> ниже сетки.
const ONBOARDING_POPULAR_LANG_CODES = ["ru", "en", "es", "pt", "de", "fr", "ar", "zh"];
function goToOnboardingSlide(idx) {
  __onboardingSlide = Math.max(0, Math.min(ONBOARDING_SLIDE_COUNT - 1, idx));
  $$(".onboarding-slide").forEach((el) => {
    el.classList.toggle("hidden", Number(el.dataset.slide) !== __onboardingSlide);
  });
  $$(".onboarding-dot").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.dot) === __onboardingSlide);
  });
  if (__onboardingSlide === 3) renderOnboardingReadySlide();
}
function renderOnboardingLangGrid() {
  const grid = $("#onboarding-lang-grid"); if (!grid) return;
  grid.innerHTML = "";
  const byCode = new Map(I18N.languages.map((l) => [l.code, l]));
  for (const code of ONBOARDING_POPULAR_LANG_CODES) {
    const lang = byCode.get(code); if (!lang) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "onboarding-lang-btn" + (code === I18N.current ? " active" : "");
    btn.dataset.lang = code;
    btn.textContent = lang.native;
    btn.addEventListener("click", () => applyOnboardingLanguage(code));
    grid.appendChild(btn);
  }
}
function populateOnboardingLangSelect() {
  const sel = $("#onboarding-lang-select"); if (!sel) return;
  sel.innerHTML = "";
  const langs = I18N.languages.slice().sort((a, b) => a.english.localeCompare(b.english, "en"));
  for (const lang of langs) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.english + " · " + lang.native;
    sel.appendChild(opt);
  }
  sel.value = I18N.current;
  sel.addEventListener("change", () => applyOnboardingLanguage(sel.value));
}
// Смена языка прямо на слайде онбординга — минимальная версия того, что
// делает setupLanguageSelector() в Settings: до startApp() ещё не
// существует ни открытого чата, ни списка контактов, которые пришлось бы
// перерисовывать, так что нужны только ensureLoaded+setLang+применение
// статичных переводов (они покрывают и текст самого онбординга).
function applyOnboardingLanguage(code) {
  const sel = $("#onboarding-lang-select");
  if (sel) sel.disabled = true;
  I18N.ensureLoaded(code, (ok) => {
    if (sel) sel.disabled = false;
    if (!ok) { toast(T("toast.langLoadFailed")); return; }
    I18N.setLang(code);
    applyStaticTranslations();
    $$(".onboarding-lang-btn").forEach((b) => b.classList.toggle("active", b.dataset.lang === code));
    if (sel) sel.value = code;
  });
}
function renderOnboardingReadySlide() {
  const name = Store.name || "";
  const av = $("#onboarding-avatar");
  if (av) { av.style.background = avatarGradient(name); av.textContent = initials(name); }
  const nameEl = $("#onboarding-ready-name"); if (nameEl) nameEl.textContent = name;
  renderQrToCanvas($("#onboarding-qr-canvas"));
  const codeEl = $("#onboarding-invite-code"); if (codeEl) codeEl.textContent = Store.myIdentityRaw || Store.myId || "";
}
function wireOnboardingOnce() {
  if (__onboardingWired) return;
  __onboardingWired = true;
  if (Store.name) { const el = $("#onboarding-name"); if (el) el.value = Store.name; }
  // Восстановление из файла бэкапа прямо с экрана регистрации — раньше
  // это было спрятано в скрытом Debug-экране (5 тапов по заголовку),
  // куда обычный пользователь никогда бы не попал, особенно СРАЗУ после
  // переустановки, когда он ещё даже не внутри приложения. importBackup
  // сама перезагружает страницу после успешного импорта — онбординг
  // корректно пропустится, раз Store.name/myId уже заполнены из бэкапа.
  // Доступно с первого (Welcome) слайда — обходит весь флоу целиком.
  wireImportBackupInput();
  wireBackupPasswordSheet();
  const impBtn = $("#onboarding-import-backup-btn");
  if (impBtn) impBtn.addEventListener("click", () => { const el = $("#import-backup-input"); if (el) el.click(); });
  // Drag-and-drop файла бэкапа — висит на самой карточке (а не на
  // конкретном слайде), поэтому работает независимо от того, какой слайд
  // сейчас показан. Актуально в первую очередь для desktop-сценария.
  const card = document.querySelector(".onboarding-card");
  if (card) {
    const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
    ["dragenter", "dragover"].forEach((evt) => card.addEventListener(evt, (e) => { prevent(e); card.classList.add("drag-over"); }));
    ["dragleave", "dragend"].forEach((evt) => card.addEventListener(evt, (e) => { prevent(e); card.classList.remove("drag-over"); }));
    card.addEventListener("drop", (e) => {
      prevent(e);
      card.classList.remove("drag-over");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) importBackupFile(file);
    });
  }
  renderOnboardingLangGrid();
  populateOnboardingLangSelect();
  $$(".onboarding-next").forEach((btn) => btn.addEventListener("click", () => goToOnboardingSlide(__onboardingSlide + 1)));
  $$(".onboarding-back").forEach((btn) => btn.addEventListener("click", () => goToOnboardingSlide(__onboardingSlide - 1)));
  const form = $("#onboarding-form");
  if (!form) return;
  // Живая ✓-индикация валидности (раздел 2 роадмапа) вместо исключительно
  // красной обводки при ошибке, как было на едином экране раньше. idFor()
  // тут вызывается только ради проверки формата — результат (id/хэш)
  // отбрасывается, сама проверка достаточно дешёвая для запуска на
  // каждый ввод.
  const idField = $("#onboarding-identity");
  const idCheck = $("#onboarding-id-check");
  if (idField) {
    idField.addEventListener("input", () => {
      const v = idField.value.trim();
      if (!v) { idField.classList.remove("input-invalid"); if (idCheck) idCheck.classList.add("hidden"); return; }
      Identity.idFor(v).then(
        () => { idField.classList.remove("input-invalid"); if (idCheck) idCheck.classList.remove("hidden"); },
        () => { idField.classList.add("input-invalid"); if (idCheck) idCheck.classList.add("hidden"); }
      );
    });
  }
  // Переход слайд 2 → 3: вычисляем идентичность и запускаем генерацию
  // ключевой пары В ФОНЕ (не блокируя переход на слайд с аватаром/QR —
  // они используют Store.myId/Store.name, которые уже установлены ниже,
  // а не сам факт готовности ключей). Сам запуск приложения — отдельное
  // действие на слайде 4 (#onboarding-start-btn), которое дожидается эту
  // же Promise перед тем, как продолжить — порядок асинхронных шагов
  // идентичен тому, что было на едином экране, просто разнесён по двум
  // UI-шагам вместо одного.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameVal = $("#onboarding-name").value.trim();
    const idVal = $("#onboarding-identity").value.trim();
    if (!nameVal) return;
    // killer-features-backlog 0.1 — Анонимная identity как default UX:
    // телефон/email больше не обязателен. Если поле пустое — профиль
    // анонимный: id генерируется случайно (crypto.randomUUID()) и НЕ
    // выводится из телефона/email, значит найти такого пользователя по
    // номеру/почте нельзя — добавить его можно только по инвайт-коду/QR.
    if (idVal) {
      let identity;
      try { identity = await Identity.idFor(idVal); }
      catch (err) { toast(T(err.message)); idField && idField.classList.add("input-invalid"); return; }
      Store.myIdentityRaw = identity.normalized;
      Store.myId = identity.id;
    } else {
      Store.myIdentityRaw = "";
      Store.myId = crypto.randomUUID();
    }
    Store.name = nameVal;
    __onboardingKeyPairPromise = ensureKeyPair().catch(() => {});
    goToOnboardingSlide(3);
  });
  const startBtn = $("#onboarding-start-btn");
  if (startBtn) startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    await (__onboardingKeyPairPromise || Promise.resolve()).catch(() => {});
    await (window.__etherIceReady || Promise.resolve()).catch(() => {});
    await backupToIDB().catch(() => {});
    const o = $("#onboarding"); if (o) o.classList.add("hidden");
    try { startApp(); } catch (e) { etherLog("error", "[startApp]", String(e)); }
  });
}
async function ensureKeyPair() {
  try {
    if (Store.myPrivateKeyJwk && Store.myPublicKeyJwk) return;
    const hadProfile = !!Store.myId;
    // Перед созданием новой пары — ещё раз пробуем достать старую из резервной копии в IndexedDB (руна и safety number не должны
    // меняться из-за того, что localStorage на устройстве оказался пуст, а копия ключей цела).
    try {
      const pv = await IDB.get("ether.privKey"), pb = await IDB.get("ether.pubKey");
      if (pv && pb) {
        JSON.parse(pv); JSON.parse(pb);
        localStorage.setItem("ether.privKey", pv); localStorage.setItem("ether.pubKey", pb);
        etherLog("warn", "[crypto] ключи восстановлены из резервной копии IndexedDB");
        return;
      }
    } catch (e) {}
    const { publicKeyJwk, privateKeyJwk } = await CryptoHelper.generateKeyPair();
    Store.myPrivateKeyJwk = privateKeyJwk;
    Store.myPublicKeyJwk = publicKeyJwk;
    let info = {}; try { info = JSON.parse(localStorage.getItem("ether.keyInfo") || "{}") || {}; } catch (e) {}
    info = { at: Date.now(), count: (info.count || 0) + 1, existing: hadProfile };
    try { localStorage.setItem("ether.keyInfo", JSON.stringify(info)); scheduleIDBBackup(); } catch (e) {}
    if (hadProfile) {
      etherLog("warn", "[crypto] ключи СОЗДАНЫ ЗАНОВО для существующего профиля (в хранилище и в копии IndexedDB их не было); руна изменилась");
      setTimeout(() => { try { toast(T("toast.keysRegenerated")); } catch (e) {} }, 2500);
    }
  } catch (e) { etherLog("error", "[crypto] key pair:", String(e)); }
}

// Блокировка поворота экрана — приложение не рассчитано на альбомную
// раскладку вовсе. screen.orientation.lock() поддерживается лишь
// частично (Chrome/Firefox на Android — то есть НЕ iOS Safari, где
// этот API отсутствует физически, Apple ещё в 2020 отказалась его
// реализовывать) и требует режима fullscreen на большинстве платформ
// — который сам по себе достаточно навязчивая смена интерфейса для
// обычного мессенджера, так что fullscreen тут НЕ запрашиваем,
// пробуем только сам lock() напрямую. Там, где не поддерживается
// (в первую очередь iOS) — тихо ничего не происходит, honest best-effort.
function tryLockPortraitOrientation() {
  try {
    if (screen.orientation && typeof screen.orientation.lock === "function") {
      screen.orientation.lock("portrait").catch(() => {});
    }
  } catch (e) {}
}
function startApp() {
  if (__appStarted) {
    const o = $("#onboarding"); if (o) o.classList.add("hidden");
    const l = $("#lock-screen"); if (l) l.classList.add("hidden");
    const a = $("#app-shell"); if (a) a.classList.remove("hidden");
    return;
  }
  __appStarted = true;
  tryLockPortraitOrientation();
  const o = $("#onboarding"); if (o) o.classList.add("hidden");
  const l = $("#lock-screen"); if (l) l.classList.add("hidden");
  const a = $("#app-shell"); if (a) a.classList.remove("hidden");

  // I18N.init() уже вызван в DOMContentLoaded до initBoot() — startApp()
  // всегда достигается уже после этого, повторный вызов здесь был чистым
  // дублированием (идемпотентно, но лишний проход).

  etherLog("info", "[startApp] init, id=" + (Store.myId ? Store.myId.slice(0, 10) + "…" : "(none)"));
  mesh = new MeshManager(Store.name);
  // ⚠️ УБРАНО: navigator.audioSession.type = "playback".
  // На iOS установка категории "playback" ЗАПРЕЩАЕТ захват звука с
  // микрофона: любой getUserMedia({audio:true}) падает с
  // InvalidStateError: "AudioSession category is not compatible with
  // audio capture". Из-за этого вызов answerCall()/startCall() в
  // звонке ВСЕГДА падал с ошибкой, и звонки были полностью
  // невозможны. Попытка была направлена на улучшение фонового
  // рингтона, но такой ценой она не оправдана — откатываем.
  safeCall(wireMeshEvents, "wireMeshEvents");
  safeCall(wireTabBar, "wireTabBar");
  safeCall(wireTabSwipe, "wireTabSwipe");
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
    // Раньше тап по индикатору соединения переключал на вкладку
    // настроек — единственный способ понять, что происходит с
    // соединением, был "иди в настройки и смотри". Теперь он открывает
    // очередь отправки (P1.14): что именно зависло и почему. Настройки
    // остаются на расстоянии одного тапа через нижнюю вкладку Settings.
    const nav = $("#nav-conn-indicator");
    if (nav) nav.addEventListener("click", () => { if (state._replaced) reclaimSignaling(); else openOutboxSheet(); });
  }, "wireNavConnIndicator");
  safeCall(wireConnectScreen, "wireConnectScreen");
  safeCall(wireQrButtons, "wireQrButtons");
  safeCall(wireGroupInfo, "wireGroupInfo");
  safeCall(wireChatScreen, "wireChatScreen");
  safeCall(wireScheduleSend, "wireScheduleSend");
  safeCall(wireMuteSheet, "wireMuteSheet");
  safeCall(wireCallScreen, "wireCallScreen");
  safeCall(wireSettingsScreen, "wireSettingsScreen");
  safeCall(wireGlobalSearch, "wireGlobalSearch");
  safeCall(wireEscCloseAnySheet, "wireEscCloseAnySheet");
  safeCall(wireSheetFocusManagement, "wireSheetFocusManagement");
  safeCall(wireDebugScreen, "wireDebugScreen");
  safeCall(wireSheetBackdrops, "wireSheetBackdrops");
  safeCall(wireCameraButton, "wireCameraButton");
  safeCall(wireSearchHandlers, "wireSearchHandlers");
  safeCall(wireChatFolders, "wireChatFolders");
  safeCall(wirePullToRefresh, "wirePullToRefresh");
  safeCall(wireMediaComposeSheet, "wireMediaComposeSheet");
  safeCall(wireJumpToDateSheet, "wireJumpToDateSheet");
  safeCall(wireEmojiPicker, "wireEmojiPicker");
  safeCall(wireComposerPlusMode, "wireComposerPlusMode");
  safeCall(wireBackupPasswordSheet, "wireBackupPasswordSheet");
  safeCall(wireHandshakeToneSheet, "wireHandshakeToneSheet");
  safeCall(wireNotificationPermission, "wireNotificationPermission");
  safeCall(wireServiceWorker, "wireServiceWorker");
  safeCall(wireRenameSheet, "wireRenameSheet");
  safeCall(wireNotifBanner, "wireNotifBanner");
  safeCall(wireContactCard, "wireContactCard");
  safeCall(wireContactGallery, "wireContactGallery");
  safeCall(wireNavTitleTaps, "wireNavTitleTaps");
  safeCall(wirePanicButton, "wirePanicButton");
  safeCall(wirePanicShakeBanner, "wirePanicShakeBanner");
  safeCall(() => { if (Store.panicShakeEnabled) wirePanicShake(); }, "wirePanicShakeAutostart");
  safeCall(wireShakeUndoGuard, "wireShakeUndoGuard");
  safeCall(wireKeyboardFix, "wireKeyboardFix");
  safeCall(wireKeepKeyboard, "wireKeepKeyboard");
  safeCall(wireNetworkListeners, "wireNetworkListeners");
  safeCall(wireViewportRecalc, "wireViewportRecalc");
  safeCall(wireMediaViewer, "wireMediaViewer");
  safeCall(wireLinkActionSheet, "wireLinkActionSheet");
  safeCall(applyDebugTabVisibility, "applyDebugTabVisibility");
  safeCall(() => { const el = $("#about-version"); if (el) el.textContent = APP_VERSION; }, "aboutVersion");
  safeCall(initAudioWarmup, "initAudioWarmup");
  safeCall(applyChatAppearancePrefs, "applyChatAppearancePrefs");
  safeCall(applyCalmMode, "applyCalmMode");
  safeCall(setupLanguageSelector, "setupLanguageSelector");
  safeCall(applyStaticTranslations, "applyStaticTranslations");

  try {
    applyGlassAlpha(Store.glassAlpha);
    applyTheme(Store.theme);
    const slider = $("#glass-slider"); if (slider) slider.value = alphaToTransparency(Store.glassAlpha).toFixed(2);
    $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === Store.theme));
    const sn = $("#settings-name"); if (sn) sn.value = Store.name;
    const si = $("#settings-identity"); if (si) si.value = Store.myIdentityRaw;
    const sms = $("#settings-my-status"); if (sms) sms.value = Store.myStatus;
    const ss = $("#settings-signaling-url"); if (ss) ss.value = Store.signalingUrl || "";
    const sd = $("#settings-discoverable"); if (sd) sd.checked = Store.discoverable;
    const sr = $("#settings-receipts"); if (sr) sr.checked = Store.receiptsEnabled;
    const sls = $("#settings-last-seen"); if (sls) sls.checked = Store.lastSeenVisible;
    const sp = $("#settings-presence"); if (sp) sp.checked = Store.presenceVisible;
    const snn = $("#settings-notifications"); if (snn) snn.checked = Store.notificationsEnabled;
    const shn = $("#settings-hide-notif"); if (shn) shn.checked = Store.hideNotifContent;
    const slp = $("#settings-link-previews"); if (slp) slp.checked = Store.linkPreviewsEnabled;
    const ste = $("#settings-translate-endpoint"); if (ste) ste.value = Store.translateEndpoint;
    const stk = $("#settings-translate-key"); if (stk) stk.value = Store.translateApiKey;
    const ssn = $("#settings-sounds"); if (ssn) ssn.checked = Store.soundsEnabled;
    const srt = $("#settings-ringtone"); if (srt) srt.value = Store.ringtone;
    const spl = $("#settings-pinlock"); if (spl) spl.checked = Store.pinEnabled;
    const sae = $("#settings-auto-emoji"); if (sae) sae.checked = Store.autoEmoji;
    const dme = $("#settings-deadman-enabled"); if (dme) dme.checked = Store.deadManEnabled;
    const dmt = $("#settings-deadman-threshold"); if (dmt) dmt.value = String(Store.deadManThresholdDays);
    const psEl = $("#settings-panic-shake"); if (psEl) psEl.checked = Store.panicShakeEnabled;
  } catch (e) { etherLog("error", "[startApp] settings init:", String(e)); }

  try {
    loadContacts(); loadLastSeen(); loadDrafts(); loadScheduledMessages(); loadChatFolders();
    restoreOutbox(); restoreGroupDeliveryMap(); restorePendingNoKey(); restoreRecentlyDeleted(); loadCallLog();
    migrateServerAckedFlags();
    // Контакты теперь загружены — можно подставить имя уже выбранного
    // доверенного контакта для Dead Man's Switch (до этой точки
    // state.contacts был бы ещё пуст, см. settings init выше).
    const dmcName = $("#settings-deadman-contact-name");
    if (dmcName) {
      const dmc = state.contacts.get(Store.deadManContactId);
      dmcName.textContent = dmc ? (dmc.name || T("sys.someone")) : "";
    }
  } catch (e) { etherLog("error", "[startApp] load data:", String(e)); }

  try { handleNotificationNavigateParams(); } catch (e) { etherLog("error", "[startApp] notification params:", String(e)); }

  try { handleShareTargetParams(); } catch (e) { etherLog("error", "[startApp] share target params:", String(e)); }

  try { checkDeadManSwitch(); } catch (e) { etherLog("error", "[startApp] dead man switch:", String(e)); }

  try {
    const incoming = SignalingCodec.extractCodeFromLocation();
    if (incoming) {
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
      handleIncomingCode(incoming);
    }
  } catch (e) { etherLog("error", "[startApp] incoming code:", String(e)); }

  try { renderTab(); } catch (e) { etherLog("error", "[startApp] renderTab:", String(e)); }
  // Снимаем skeleton-флаг чуть погодя: на холодном старте contacts ещё
  // могла не успеть восстановиться из IndexedDB-бэкапа в этот самый тик,
  // 400мс достаточно, чтобы это не мигало на быстрых устройствах, но
  // хватило на медленных, чтобы показать skeleton, а не пустой экран.
  setTimeout(() => {
    state._firstRenderDone = true;
    if (state.tab === "chats" && !state.chatId) { try { renderChatsList(); } catch (e) {} }
  }, 400);
  try { initSignaling(); } catch (e) { etherLog("error", "[startApp] initSignaling:", String(e)); }
  try { startOutboxRetryLoop(); } catch (e) {}
  try { setInterval(sweepExpiredMessages, 30000); sweepExpiredMessages(); } catch (e) {}
  // Проверяем раз в 30с + сразу при старте (не ждём первого тика) — так
  // отложенное сообщение, время которого уже прошло пока приложение было
  // закрыто, уходит немедленно при следующем запуске, а не теряется.
  try { setInterval(sweepScheduledMessages, 30000); sweepScheduledMessages(); } catch (e) {}
  try { setInterval(sweepIncomingFileBuffers, 60000); } catch (e) {}
  try { document.addEventListener("visibilitychange", () => { if (!document.hidden) sweepScheduledMessages(); }); } catch (e) {}
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
  // Смена языка меняет ширину подписей вкладок (а значит и центр
  // иконки) — индикатор нужно пересчитать уже после реального реflow.
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.setAttribute("content", T("app.description"));
  // Список категорий Настроек строится из JS (не из data-i18n) — без перерисовки после смены языка
  // подписи оставались на языке, действовавшем в момент старта приложения.
  try { renderSettingsCategories(); updateSettingsCategoryView(); } catch (e) {}
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
    const code = sel.value;
    // Словарь новой (ещё не выбранной) вкладки может быть не загружен —
    // подгружаем лениво (js/lang/<code>.js, обычно 15-30КБ, а не все
    // 72 языка разом) и только после этого переключаемся.
    sel.disabled = true;
    I18N.ensureLoaded(code, (ok) => {
      sel.disabled = false;
      if (!ok) { toast(T("toast.langLoadFailed")); sel.value = I18N.current; return; }
      I18N.setLang(code);
      applyStaticTranslations();
      try { renderTab(); } catch (e) {}
      if (state.chatId) renderChatThread();
      if (state.contactCardId) renderContactCard();
      if (state.tab === "chats" && state.chatsSegment === "calls") renderCallsList();
      refreshSignalingStatusText();
      renderOnlineRosterList();
    });
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
      I18N.ensureLoaded(sys, (ok) => {
        if (!ok) { toast(T("toast.langLoadFailed")); return; }
        I18N.setLang(sys);
        I18N.markOfferShown();
        banner.classList.add("hidden");
        try { updateNotifBanner(); } catch (e) {}
        applyStaticTranslations();
        try { renderTab(); } catch (e) {}
        const sel = $("#settings-language"); if (sel) sel.value = I18N.current;
      });
    });
  }
  const no = $("#lang-offer-no");
  if (no) no.addEventListener("click", () => {
    I18N.markOfferShown();
    banner.classList.add("hidden");
    try { updateNotifBanner(); } catch (e) {}
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
    // Переключение #app-shell на height:auto и обратно (нужно, чтобы
    // форсировать у iOS Safari пересчёт 100dvh после возврата из
    // фона — реальный, задокументированный баг WebKit) попутно СБРАСЫВАЛО
    // scrollTop у #chat-messages в 0 — дочерний элемент временно
    // оказывается в другом по размеру родителе, и браузер теряет
    // позицию прокрутки. Явно сохраняем и восстанавливаем её вокруг
    // переключения, а не полагаемся на то, что браузер сам её удержит.
    const wrap = document.getElementById("chat-messages");
    const savedScroll = wrap ? wrap.scrollTop : null;
    shell.style.height = "auto";
    // eslint-disable-next-line no-unused-expressions
    shell.offsetHeight; // принудительный reflow между сбросом и восстановлением
    shell.style.height = "";
    if (wrap && savedScroll !== null) wrap.scrollTop = savedScroll;
  } catch (e) {}
}
// Запрет масштабирования и поворота. iOS Safari игнорирует user-scalable=no для щипка, поэтому
// блокируем жесты явно; ориентацию пытаемся зафиксировать API (iOS его не поддерживает — там
// портретный режим держит оверлей #rotate-lock, см. CSS).
function lockViewportGestures() {
  ["gesturestart", "gesturechange", "gestureend"].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    // двойной тап = зум; но на заголовке (5 быстрых тапов открывают «Отладку») click должен доходить
    const onTitle = e.target && e.target.closest && e.target.closest("#nav-title, #about-app-logo");
    if (now - lastTouchEnd < 300 && e.cancelable && !onTitle) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock("portrait").catch(() => {}); } catch (e) {}
}
function wireViewportRecalc() {
  lockViewportGestures();
  try { document.documentElement.classList.toggle("is-standalone", isStandalone()); } catch (e) {}
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { forceViewportRecalc(); } });
  window.addEventListener("pageshow", () => { forceViewportRecalc(); });
  window.addEventListener("focus", () => { forceViewportRecalc(); });
}
// Закрытие вкладки/приложения посреди звонка: успеваем сказать собеседнику «звонок завершён», а не оставлять его висеть.
function hangupOnPageClose() {
  const cid = state.callId; if (!cid || !state.callPhase) return;
  try { const l = mesh.get(cid); if (l) { l.send({ kind: "call-state", state: "ended", ts: Date.now() }); } } catch (e) {}
  try { if (signaling && signaling.connected) signaling.signal(cid, { t: "call-ended" }); } catch (e) {}
}
window.addEventListener("pagehide", hangupOnPageClose);
window.addEventListener("beforeunload", hangupOnPageClose);
function wireNetworkListeners() {
  const resumeSignaling = () => {
    try {
      if (state._replaced && !document.hidden) { reclaimSignaling(); return; }
      if (signaling && typeof signaling.resume === "function") signaling.resume();
    } catch (e) {}
  };
  window.addEventListener("online", () => { etherLog("info", "[net] online"); resumeSignaling(); });
  window.addEventListener("pageshow", resumeSignaling);
  window.addEventListener("focus", resumeSignaling);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeSignaling(); });
  window.addEventListener("offline", () => etherLog("warn", "[net] offline"));
  // Поворот экрана/ресайз окна сдвигает позиции кнопок таб-бара —
  // индикатор иначе остался бы на старых координатах до следующего
  // переключения вкладки.
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
  // Небольшая задержка — чтобы подсказка не всплыла поверх самого
  // первого рендера (пока ещё идёт анимация появления экрана чатов),
  // а появилась через чуть погодя, когда пользователь уже освоился
  // с интерфейсом.
  // Отдельный ключ от "onboarding.hint" (тот уже занят текстом про
  // восстановление личности на экране входа) — здесь подсказка про
  // жесты в самом интерфейсе чата.
  setTimeout(() => { try { toast(T("onboarding.gestureHint")); } catch (e) {} }, 1500);
}

// Push о входящем звонке «живёт» недолго: если нажали на него позже минуты, звонящий уже сдался.
function isCallPushFresh(ts) {
  const t = Number(ts);
  return !t || (Date.now() - t >= 0 && Date.now() - t < 60000);
}
function openFromNotification(contactId, kind, focusInput, meta) {
  try { closeChatSearch(); } catch (e) {}
  if (!contactId) return;
  window.focus();
  state.chatId = contactId;
  __lastRenderedChatId = null;
  state.multiSelect = null;
  state.contactCardId = null; // иначе после закрытия этого чата могла неожиданно всплыть карточка контакта, на которой пользователь был до уведомления
  renderTab();
  if (kind === "call") {
    if (state.callId === contactId && state.callPhase === "ringing") {
      openCallScreen(contactId, "ringing");
      if (!ringtoneAudioEl || ringtoneAudioEl.paused) { try { ensureAudioCtx(); } catch (e) {} playRingtone(); }
    } else if (!state.callId && isCallPushFresh(meta && meta.ts)) {
      // Приложение запустили (или развернули) нажатием на push о звонке, а серверное приглашение к нам ещё не дошло:
      // сервер/соединение только поднимаются. Раньше здесь показывалось «пропущенный звонок», а звонящий продолжал
      // звонить. Теперь сразу открываем экран «входящий» и подключаемся к звонящему; принять можно уже сейчас.
      state.callWantsVideo = false;
      openCallScreen(contactId, "ringing", { timeoutMs: INCOMING_PUSH_CALL_TIMEOUT_MS });
      try { ensureAudioCtx(); } catch (e) {}
      playRingtone();
      if (signaling && signaling.connected) scheduleAutoConnect(contactId);
    } else {
      toast(T("toast.missedCall"));
    }
  } else if (focusInput) {
    // P2.37 (урезанный вариант) — клик по кнопке "Ответить" в уведомлении:
    // полноценного инлайн-ответа веб-API не даёт (см. showNotification),
    // но можно хотя бы сразу поставить курсор в поле ввода, не заставляя
    // пользователя ещё и тапать по нему самому. renderTab() выше рендерит
    // асинхронно/синхронно в зависимости от перехода — small delay, чтобы
    // #chat-input гарантированно уже был в DOM.
    setTimeout(() => { const inp = $("#chat-input"); if (inp) inp.focus(); }, 50);
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
    if (callId) openFromNotification(callId, "call", false, { ts: params.get("ts") });
    else if (chatId) openFromNotification(chatId, "message");
    if (callId || chatId) {
      const url = new URL(window.location.href);
      url.search = "";
      window.history.replaceState({}, "", url.toString());
    }
  } catch (e) {}
}
// killer-features-backlog 0.4 — Share Target (Android "Поделиться" → Эфир).
// GET-метод, только text/url (см. manifest.webmanifest "share_target") —
// без POST/файлов, чтобы не усложнять sw.js перехватом multipart-запроса.
// Открываем список контактов (переиспользуя forward-sheet) — пользователь
// сам выбирает, кому отправить, текст подставляется в поле ввода, но НЕ
// отправляется автоматически — так его можно проверить/дополнить перед отправкой.
function handleShareTargetParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    const title = params.get("share_title") || "";
    const text = params.get("share_text") || "";
    const url = params.get("share_url") || "";
    const combined = [title, text, url].filter(Boolean).join("\n").trim();
    if (!combined) return;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = "";
    window.history.replaceState({}, "", cleanUrl.toString());
    openForwardSheet((contactId) => {
      state.contactCardId = null; state.chatId = contactId; renderTab();
      const inp = $("#chat-input");
      if (inp) { inp.value = combined; inp.dispatchEvent(new Event("input")); setTimeout(() => inp.focus(), 50); }
    }, "shareTarget.pickChat");
  } catch (e) {}
}
// killer-features-backlog 0.5 — "мягкий" Dead Man's Switch. Два независимых
// направления в одной функции, обе стороны вызывают её при каждом СВОЁМ
// открытии приложения — никакого фонового таймера нет и не может быть
// (см. Store.deadManEnabled выше):
//  1) отправить: если я настроил наблюдение за мной (включил тумблер и
//     выбрал доверенный контакт) — шлю ему heartbeat, но не чаще раза в
//     12 часов (не на каждый перезапуск подряд).
//  2) проверить: для ЛЮБОГО контакта, от которого я когда-либо получал
//     heartbeat (значит, он когда-то настроил наблюдение, где доверенным
//     указан я), если с последнего heartbeat прошло больше заявленного
//     порога — предупреждаю один раз (не на каждый повторный запуск,
//     пока не придёт новый heartbeat или не истечёт сутки).
function checkDeadManSwitch() {
  try {
    const now = Date.now();
    if (Store.deadManEnabled && Store.deadManContactId) {
      const target = state.contacts.get(Store.deadManContactId);
      if (target && now - Store.deadManLastSentAt > 12 * 60 * 60 * 1000) {
        Store.deadManLastSentAt = now;
        trySendOrQueue(target, crypto.randomUUID(), { kind: "heartbeat", ts: now, thresholdDays: Store.deadManThresholdDays }).catch(() => {});
      }
    }
    for (const c of state.contacts.values()) {
      if (!c.lastHeartbeatAt || !c.heartbeatThresholdDays) continue;
      const staleMs = c.heartbeatThresholdDays * 24 * 60 * 60 * 1000;
      if (now - c.lastHeartbeatAt <= staleMs) continue;
      if (c.heartbeatAlertedAt && now - c.heartbeatAlertedAt < 24 * 60 * 60 * 1000) continue; // уже предупреждали за последние сутки
      c.heartbeatAlertedAt = now;
      persistContacts();
      toast(T("toast.deadManAlert", { name: c.name || T("sys.someone"), days: c.heartbeatThresholdDays }));
    }
  } catch (e) {}
}

function wireServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.register("./sw.js").then((reg) => {
    swRegistration = reg;
    setTimeout(() => { ensurePushSubscription().catch(() => {}); }, 1000);
    watchForWaitingSW(reg);
  }).catch(() => {});

  // Проверка обновлений при возврате в приложение и раз в 30 минут.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && swRegistration) {
      swRegistration.update().catch(() => {});
    }
  });
  setInterval(() => {
    if (swRegistration) swRegistration.update().catch(() => {});
  }, 30 * 60 * 1000);

  // Раз в час проверяем, не истекла ли push-подписка. На iOS подписка
  // иногда «протухает» после долгого неиспользования — тогда Web Push
  // перестаёт работать без единого сигнала пользователю. Признак —
  // expirationTime в подписке.
  setInterval(() => {
    if (!Store.pushSubscriptionJson) return;
    try {
      const sub = JSON.parse(Store.pushSubscriptionJson);
      if (sub.expirationTime && sub.expirationTime * 1000 < Date.now() + 24 * 3600 * 1000) {
        ensurePushSubscription().catch(() => {});
      }
    } catch (e) {}
  }, 60 * 60 * 1000);

  navigator.serviceWorker.addEventListener("message", (ev) => {
    const data = ev.data || {};
    if (data.type === "open-contact" && data.contactId) {
      openFromNotification(data.contactId, data.kind, data.focusInput, { ts: data.ts });
    }
    if (data.type === "mark-read" && data.contactId) {
      const c = state.contacts.get(data.contactId);
      if (c) {
        markThreadRead(c);
        if (state.tab === "chats" && state.chatsSegment === "chats" && !state.chatId) renderChatsList();
        if (state.chatId === data.contactId) renderChatThreadInner();
      }
    }
    if (data.type === "push-subscription-changed") {
      ensurePushSubscription().catch(() => {});
    }
  });

  // Когда новый SW активировался после SKIP_WAITING — перезагружаем
  // страницу, чтобы весь UI подхватил новые ресурсы. sessionStorage
  // защищает от петли перезагрузок.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (sessionStorage.getItem("ether.reloadingForUpdate")) return;
    sessionStorage.setItem("ether.reloadingForUpdate", "1");
    location.reload();
  });
}

// Подписка на события конкретной регистрации: либо SW уже waiting
// (пользователь вернулся, когда обновление скачалось в прошлой сессии),
// либо ещё в процессе install — ждём statechange.
function watchForWaitingSW(reg) {
  if (reg.waiting) { showUpdateBanner(reg); return; }
  reg.addEventListener("updatefound", () => {
    const newSW = reg.installing;
    if (!newSW) return;
    newSW.addEventListener("statechange", () => {
      if (newSW.state === "installed" && navigator.serviceWorker.controller) {
        showUpdateBanner(reg);
      }
    });
  });
}

// Баннер «Доступно обновление». Кнопка «Обновить» шлёт waiting-SW
// сообщение SKIP_WAITING — он активируется, сработает controllerchange,
// страница перезагрузится. Кнопка «Позже» скрывает баннер на час
// (sessionStorage — не localStorage: закрыл вкладку — и следующая сессия
// снова покажет).
function showUpdateBanner(reg) {
  if (document.getElementById("update-banner")) return;
  try {
    const dismissedAt = parseInt(sessionStorage.getItem("ether.updateDismissedAt") || "0", 10);
    if (dismissedAt && Date.now() - dismissedAt < 60 * 60 * 1000) return;
  } catch (e) {}
  // Снимаем флаг "reloading" при каждом показе баннера. Без этого после
  // первого обновления (клик "Обновить" → SW активировался →
  // controllerchange → reload) флаг оставался "1" в sessionStorage до
  // конца сессии, и при следующем баннере controllerchange видел
  // залипший флаг и делал return — reload не происходил. Именно поэтому
  // кнопка "Нажать, чтобы получить новую версию" срабатывала только со
  // второго раза (второй клик шёл по ветке else — reg.waiting уже был
  // null после первого клика — и перезагружал напрямую).
  try { sessionStorage.removeItem("ether.reloadingForUpdate"); } catch (e) {}

  const el = document.createElement("div");
  el.id = "update-banner";
  el.className = "notif-banner glass-content";
  el.innerHTML = `
    <div class="notif-banner-text">
      <strong>${escapeHtml(T("update.available.title"))}</strong>
      <span>${escapeHtml(T("update.available.text"))}</span>
    </div>
    <button type="button" class="btn-primary notif-banner-btn" data-act="reload">${escapeHtml(T("update.reload"))}</button>
    <button type="button" class="icon-btn small" data-act="dismiss" aria-label="${escapeHtml(T("sys.close"))}">
      <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
    </button>`;
  document.body.appendChild(el);

  el.querySelector('[data-act="reload"]').addEventListener("click", () => {
    if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
    else location.reload();
  });
  el.querySelector('[data-act="dismiss"]').addEventListener("click", () => {
    el.remove();
    try { sessionStorage.setItem("ether.updateDismissedAt", String(Date.now())); } catch (e) {}
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
  // P1.17 — скрывает ТЕКСТ сообщения в уведомлении (экран блокировки
  // виден кому угодно), но не имя контакта: иначе непонятно, кто вообще
  // написал. Звонки не трогаем — там body уже не содержит произвольного
  // пользовательского текста.
  if (Store.hideNotifContent && opts.kind !== "call") {
    body = T("notif.newMessage");
  }
  const payload = {
    type: "show-notification", title, body,
    tag: opts.tag || "ether",
    contactId: opts.contactId || null,
    kind: opts.kind || "message",
    // Per-contact "только вибрация" (opts.forceSilent) перебивает общий
    // звуковой тоггл — специфичнее настройка должна выигрывать у общей.
    silent: opts.forceSilent || !Store.soundsEnabled,
  };
  // P2.37 (урезанный вариант) — настоящего инлайн-ответа (текстовое поле
  // прямо в уведомлении) в вебе не существует — это нативный API
  // (Android RemoteInput и т.п.), у Notification API есть только
  // кнопки-действия. Поэтому кнопка "Ответить" не отправляет текст сама,
  // а открывает чат уже с фокусом в поле ввода (см. notificationclick в
  // sw.js и openFromNotification(..., focusInput) в app.js) — на один тап
  // ближе к ответу, чем просто разворачивание уведомления.
  if (payload.kind !== "call" && payload.contactId) {
    // Notification.actions ограничены 2 видимыми кнопками на большинстве
    // платформ (см. комментарий у showNotification в sw.js) — "Ответить"
    // уже занимает одну, вторая — "Прочитано" (переиспользуем T("ack.read"),
    // он уже переведён на все 72 языка, отдельный ключ не нужен).
    payload.actions = [
      { action: "reply", title: T("notif.action.reply") },
      { action: "mark-read", title: T("ack.read") },
    ];
  }
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
  // #lang-offer — фиксированный оверлей ВНЕ #app-shell (см. комментарий
  // в CSS), показывается тем же вызовом startApp(), что и этот баннер,
  // для уже зарегистрированного пользователя с системным языком,
  // отличным от сохранённого. Оба претендуют на верх экрана —
  // #notif-banner в обычном потоке документа оказывался ПОД фиксированным
  // #lang-offer, физически перекрытым им. Сдвигаем баннер ниже, пока
  // предложение смены языка не закрыто.
  const langOffer = $("#lang-offer");
  const langOfferVisible = langOffer && !langOffer.classList.contains("hidden");
  banner.style.marginTop = langOfferVisible ? "96px" : "";
}
function updateAppBadge() {
  let total = 0;
  for (const c of state.contacts.values()) { if (c.isSelf) continue; total += unreadCount(c); }
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
  let loadFailed = false;
  try { arr = JSON.parse(Store.contactsJson) || []; } catch (e) { arr = []; loadFailed = true; }
  if (!Array.isArray(arr)) { arr = []; loadFailed = true; }
  if (loadFailed) { try { toast(T("toast.contactsLoadFailed")); } catch (e) {} }
  for (const c of arr) {
    if (!c || typeof c.id !== "string") continue;
    state.contacts.set(c.id, {
      id: c.id, name: c.name || "", raw: c.raw || "",
      managed: true, publicKey: c.publicKey || null,
      online: false, status: "disconnected",
      messages: Array.isArray(c.messages) ? c.messages : [],
      lastActivity: c.lastActivity || 0,
      archived: !!c.archived, muted: !!c.muted, muteUntil: c.muteUntil || null, blocked: !!c.blocked, vibrateOnly: !!c.vibrateOnly,
      pinned: !!c.pinned, pinnedMessageId: c.pinnedMessageId || null,
      pinOrder: typeof c.pinOrder === "number" ? c.pinOrder : null,
      // Группы — без этих полей запись после перезагрузки превращается в
      // битый обычный контакт (isGroup(c) === false, участников нет).
      isGroup: !!c.isGroup,
      members: Array.isArray(c.members) ? c.members : undefined,
      createdBy: c.createdBy || undefined,
      avatar: c.avatar || undefined,
      peerAvatar: typeof c.peerAvatar === "string" && AVATAR_DATAURL_RE.test(c.peerAvatar) ? c.peerAvatar : undefined,
      description: c.description || undefined,
      disappearingTimer: c.disappearingTimer || 0,
      notificationSound: c.notificationSound || undefined,
      // killer-features-backlog 0.5 — Dead Man's Switch: когда пришёл
      // последний heartbeat от этого контакта и при каком пороге (дней)
      // его просили следить, плюс отметка уже показанного предупреждения.
      lastHeartbeatAt: c.lastHeartbeatAt || undefined,
      birthday: typeof c.birthday === "string" ? c.birthday : undefined, birthdayCelebrated: c.birthdayCelebrated || undefined,
      heartbeatThresholdDays: c.heartbeatThresholdDays || undefined,
      heartbeatAlertedAt: c.heartbeatAlertedAt || undefined,
      isSelf: c.id === SELF_CHAT_ID,
    });
  }
  ensureSelfChatContact();
  // Миграция для drag-to-reorder (раздел 4 роадмапа): раньше у закреплённых
  // чатов не было собственного порядка — они сортировались как обычные
  // чаты (онлайн → lastActivity). Чатам, уже закреплённым ДО этого
  // релиза (pinOrder ещё не записан), присваиваем номер по их текущему
  // видимому порядку — так обновление не дёргает уже привычную
  // последовательность, а drag просто начинает работать поверх неё.
  const legacyPinned = Array.from(state.contacts.values()).filter((c) => c.pinned && typeof c.pinOrder !== "number");
  if (legacyPinned.length) {
    legacyPinned.sort((a, b) => {
      const aLive = a.online ? 1 : 0, bLive = b.online ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });
    let next = nextPinOrder();
    for (const c of legacyPinned) c.pinOrder = next++;
  }
}
// Следующий свободный pinOrder — новый закреплённый чат всегда уходит в
// конец списка закреплённых, а не в случайное место.
function nextPinOrder() {
  let max = -1;
  for (const c of state.contacts.values()) {
    if (c.pinned && typeof c.pinOrder === "number" && c.pinOrder > max) max = c.pinOrder;
  }
  return max + 1;
}
// «Заметки себе» — локальный pinned self-chat. Зарезервированный id не
// пересекается с реальными контактами (idFor() всегда нормализует
// телефон/email, а не возвращает "__self__" дословно). Никогда не
// регистрируется на сигнальном сервере, не участвует в mesh/presence —
// единственная точка, которая вообще знает про сеть для этого "контакта",
// это trySendOrQueue(), и там для isSelf стоит ранний выход.
const SELF_CHAT_ID = "__self__";
function ensureSelfChatContact() {
  let c = state.contacts.get(SELF_CHAT_ID);
  if (c) { c.isSelf = true; c.managed = true; return c; }
  c = {
    id: SELF_CHAT_ID, name: T("chats.selfChat.name"), raw: "",
    managed: true, publicKey: null,
    online: false, status: "self",
    messages: [], lastActivity: 0,
    archived: false, muted: false, blocked: false,
    pinned: true, pinnedMessageId: null,
    isGroup: false, disappearingTimer: 0,
    isSelf: true,
  };
  state.contacts.set(SELF_CHAT_ID, c);
  return c;
}
// persistContacts() вызывается очень часто (на каждое отправленное/
// полученное сообщение, реакцию, ack и т.д.) — сериализация ВСЕХ
// контактов с историей в JSON и синхронная запись в localStorage на
// каждый такой вызов ощутимо бьёт по главному потоку при пакетном
// приёме сообщений. Дебаунсим запись на 200мс по тому же паттерну, что
// уже применяется для черновиков (scheduleDraftPersist). state.contacts
// в памяти обновляется вызывающим кодом сразу — риск потери данных
// только в окне до 200мс при аварийном завершении процесса, поэтому
// принудительно сбрасываем очередь перед unload/уходом в фон и перед
// экспортом бэкапа (exportBackup читает localStorage напрямую).
let __contactsPersistTimer = null;
let __contactsPersistPending = null;
function persistContactsNow() {
  if (__contactsPersistTimer) { clearTimeout(__contactsPersistTimer); __contactsPersistTimer = null; }
  if (__contactsPersistPending === null) return;
  const arr = __contactsPersistPending;
  __contactsPersistPending = null;
  try {
    // Страховка от «пропали все сообщения»: если число сообщений резко упало, пишем в журнал откуда это пришло
    // и сохраняем предыдущий снимок в IndexedDB (ключ contactsPrev), чтобы данные можно было вернуть.
    const total = arr.reduce((n, c) => n + (c.messages ? c.messages.length : 0), 0);
    if (__lastPersistMsgCount >= 8 && total < __lastPersistMsgCount * 0.5) {
      etherLog("warn", "[persist] число сообщений упало " + __lastPersistMsgCount + " → " + total + "; снимок прежнего состояния сохранён (contactsPrev). Стек: " + String(new Error().stack).split("\n").slice(1, 6).join(" | "));
      try { if (__lastContactsJson) IDB.set("contactsPrev", __lastContactsJson).catch(() => {}); } catch (e) {}
    }
    const json = JSON.stringify(arr);
    Store.contactsJson = json;
    __lastPersistMsgCount = total; __lastContactsJson = json;
  } catch (e) {
    // QuotaExceededError и подобное — см. persistContactsSafe ниже.
    handlePersistError(e, "contacts");
  }
}
let __lastPersistMsgCount = 0, __lastContactsJson = "";
function persistContacts() {
  __contactsPersistPending = Array.from(state.contacts.values()).filter((c) => c.managed).map((c) => ({
    id: c.id, name: c.name, raw: c.raw, publicKey: c.publicKey,
    messages: c.messages, lastActivity: c.lastActivity,
    archived: c.archived, muted: c.muted, muteUntil: c.muteUntil || undefined, blocked: c.blocked, vibrateOnly: c.vibrateOnly || undefined,
    pinned: c.pinned || undefined, pinnedMessageId: c.pinnedMessageId || undefined,
    pinOrder: typeof c.pinOrder === "number" ? c.pinOrder : undefined,
    isGroup: c.isGroup || undefined,
    members: c.isGroup ? c.members : undefined,
    createdBy: c.isGroup ? c.createdBy : undefined,
    // killer-features-backlog 0.7 — локальный аватар контакта: раньше
    // persistContacts() сохранял avatar только для групп, т.к. у обычных
    // контактов не было UI для его установки. Теперь c.avatar может быть
    // задан и для 1:1 контакта (см. setContactAvatar) — сохраняем всегда.
    avatar: c.avatar || undefined,
    peerAvatar: c.peerAvatar || undefined,
    description: c.isGroup ? (c.description || undefined) : undefined,
    disappearingTimer: c.disappearingTimer || undefined,
    notificationSound: c.notificationSound || undefined,
    lastHeartbeatAt: c.lastHeartbeatAt || undefined,
    birthday: c.birthday || undefined, birthdayCelebrated: c.birthdayCelebrated || undefined,
    heartbeatThresholdDays: c.heartbeatThresholdDays || undefined,
    heartbeatAlertedAt: c.heartbeatAlertedAt || undefined,
  }));
  if (__contactsPersistTimer) return;
  __contactsPersistTimer = setTimeout(() => {
    __contactsPersistTimer = null;
    persistContactsNow();
  }, 200);
}
function loadLastSeen() { try { state.lastSeen = JSON.parse(Store.lastSeenJson) || {}; } catch (e) { state.lastSeen = {}; } if (typeof state.lastSeen !== "object") state.lastSeen = {}; }
function persistLastSeen() { try { Store.lastSeenJson = JSON.stringify(state.lastSeen); } catch (e) { handlePersistError(e, "lastSeen"); } }
function loadDrafts() { try { state.drafts = JSON.parse(Store.draftsJson) || {}; } catch (e) { state.drafts = {}; } if (typeof state.drafts !== "object") state.drafts = {}; }
function persistDrafts() { try { Store.draftsJson = JSON.stringify(state.drafts); } catch (e) { handlePersistError(e, "drafts"); } }
// "Отправить позже" — каждая запись { id, contactId, isGroup, text, replyTo, sendAt }.
// sendAt — абсолютный ms-timestamp, поэтому «приложение было закрыто
// дольше таймера» не теряет сообщение: sweepScheduledMessages() при
// следующем запуске увидит sendAt в прошлом и отправит немедленно,
// а не ждёт, что таймер «досчитает» с момента планирования.
function loadScheduledMessages() { try { state.scheduledMessages = JSON.parse(Store.scheduledMessagesJson) || []; } catch (e) { state.scheduledMessages = []; } if (!Array.isArray(state.scheduledMessages)) state.scheduledMessages = []; }
function persistScheduledMessages() { try { Store.scheduledMessagesJson = JSON.stringify(state.scheduledMessages); } catch (e) { handlePersistError(e, "scheduledMessages"); } }
function loadChatFolders() {
  try { state.folders = JSON.parse(Store.chatFoldersJson) || []; } catch (e) { state.folders = []; }
  if (!Array.isArray(state.folders)) state.folders = [];
  // Защита от повреждённых/чужеродных записей — каждая папка обязана
  // иметь строковые id/name и массив contactIds (иначе рендер чипов и
  // фильтрация ниже упадут на мусорных данных из ручного редактирования
  // localStorage или повреждённого бэкапа).
  state.folders = state.folders.filter((f) => f && typeof f.id === "string" && typeof f.name === "string" && Array.isArray(f.contactIds));
}
function persistChatFolders() { try { Store.chatFoldersJson = JSON.stringify(state.folders); } catch (e) { handlePersistError(e, "chatFolders"); } }
// При быстрой печати обработчик "input" дёргает persistDrafts() на
// каждый символ — 5-10 localStorage.setItem в секунду. Дебаунс в
// 250мс группирует их в одну запись за паузу в наборе текста.
// saveCurrentDraft() (срабатывает при выходе из чата) остаётся
// синхронным — там нужна гарантия, что черновик лёг ДО размонтирования.
let __draftPersistTimer = null;
function scheduleDraftPersist() {
  if (__draftPersistTimer) return;
  __draftPersistTimer = setTimeout(() => {
    __draftPersistTimer = null;
    persistDrafts();
  }, 250);
}
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
        // Раньше тап по любой вкладке во время звонка просто возвращал
        // на #call-screen — уйти в чаты/контакты было нельзя иначе как
        // завершив звонок. Теперь сворачиваем его в полоску и даём
        // перейти на нужную вкладку, как и просил отчёт.
        minimizeCallScreen();
      }
      state.tab = btn.dataset.tab;
      state.chatId = null;
      __lastRenderedChatId = null;
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
// Свайп между Chats/Contacts/Settings — тот же жест, которым уже умеют
// пользоваться строка чата (архив/mute) и пузырь (ответ), поэтому
// намеренно НЕ навешан глобально на весь #content без разбора: старт
// касания внутри .chat-row/.chat-filters/.emoji-tabs (у них у самих уже
// есть горизонтальные жесты) полностью исключает элемент из кандидатов
// на свайп табов, чтобы не конкурировать за один и тот же touchmove.
// Debug-вкладка не входит в список — туда попадают секретными тапами по
// заголовку, свайпом до неё добираться не предполагалось.
function wireTabSwipe() {
  const content = $("#content");
  if (!content) return;
  const TABS = ["chats", "connect", "settings"];
  const SWIPE_TAB_THRESHOLD = 60;
  let startX = 0, startY = 0, swiping = false, blocked = false;
  content.addEventListener("touchstart", (e) => {
    if (state.chatId || state.contactCardId || state.callId || e.touches.length !== 1) { blocked = true; return; }
    const t = e.target;
    if (t && t.closest && t.closest(".chat-row, .chat-filters, .emoji-tabs, input, textarea")) { blocked = true; return; }
    blocked = false;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    swiping = false;
  }, { passive: true });
  content.addEventListener("touchmove", (e) => {
    if (blocked) return;
    const dx = e.touches[0].clientX - startX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (!swiping && Math.abs(dx) > 24 && Math.abs(dx) > dy * 1.5) swiping = true;
  }, { passive: true });
  content.addEventListener("touchend", (e) => {
    if (blocked || !swiping) { swiping = false; return; }
    swiping = false;
    const touch = e.changedTouches && e.changedTouches[0];
    const dx = (touch ? touch.clientX : startX) - startX;
    const isRtl = document.documentElement.dir === "rtl";
    const dir = isRtl ? dx : -dx; // > 0 — "вперёд" по порядку вкладок (следующая), с учётом RTL
    const idx = TABS.indexOf(state.tab);
    if (idx === -1) return;
    if (dir > SWIPE_TAB_THRESHOLD && idx < TABS.length - 1) state.tab = TABS[idx + 1];
    else if (dir < -SWIPE_TAB_THRESHOLD && idx > 0) state.tab = TABS[idx - 1];
    else return;
    haptic("light");
    renderTab();
  });
}
function closeChatSafely() {
  const prevId = state.chatId;
  cancelVoiceRecordingIfLeavingChat(null);
  pauseAllVoicePlayback();
  try { saveCurrentDraft(); } catch (e) {}
  state._inputDraftChatId = null;
  state.chatId = null;
  // Сброс __lastRenderedChatId — иначе при повторном входе в ТОТ ЖЕ
  // чат в renderChatThreadInner срабатывает условие
  // state.chatId === __lastRenderedChatId, «свежая» логика
  // (unreadDividerFor.set) не отрабатывает, и разделитель
  // «Непрочитанные сообщения» не появляется.
  __lastRenderedChatId = null;
  try { if (prevId) sendTypingStop(prevId); } catch (e) {}
  try { cancelEditing(); } catch (e) {}
  try { cancelReply(); } catch (e) {}
  try { closeChatSearch(); } catch (e) {}
  // Режим мультивыбора — состояние ОДНОГО конкретного треда, а не
  // приложения в целом. Без сброса здесь: вошли в мультивыбор в чате A,
  // вышли (‹ или edge-свайп-назад) — state.multiSelect остаётся
  // непустым, и первый же тап по пузырю в ЛЮБОМ другом чате B тихо
  // переключает выбор вместо обычного действия (открыть меню/лайтбокс).
  state.multiSelect = null;
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
let __searchTab = null;
function renderTabInner() {
  if (state.chatId || state.contactCardId) document.documentElement.classList.remove("inline-search-open");
  if (__searchTab !== state.tab) { if (__searchTab !== null) { try { setInlineSearchOpen(false); } catch (e) {} } __searchTab = state.tab; }
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $$(".screen").forEach((s) => s.classList.add("hidden"));
  const cf0 = $("#chat-filters"); if (cf0) cf0.classList.add("hidden");
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
  if (state.tab === "chats" && cf0) cf0.classList.remove("hidden");
  if (state.tab === "settings") updateFavoritesCount();
  // Чип "Звонки" в #chat-filters синхронизируется с тем же state.chatsSegment,
  // которым раньше управлял отдельный #chats-segment переключатель (теперь
  // удалённый — см. комментарий в wireSearchHandlers()).
  $$("#chat-filters .chat-filter-chip").forEach((b) => {
    const f = b.dataset.filter;
    b.classList.toggle("active", state.chatsSegment === "calls" ? f === "calls" : f === state.chatFilter);
  });
  const titles = {
    // Раньше тут стоял T("nav.chats") ("Чаты") — но сама нижняя вкладка
    // была переименована в "Общение" (nav.hub) ещё раньше в этой сессии,
    // и заголовок страницы должен называться так же, как вкладка, а не
    // расходиться с ней. nav.chats остаётся отдельным ключом — он же
    // используется для подписи кнопки-сегмента "Чаты" внутри вкладки.
    chats: T("nav.hub"),
    calls: T("nav.calls"),
    connect: T("nav.contacts"),
    settings: T("nav.settings"),
    debug: T("nav.debug"),
  };
  const nt = $("#nav-title"); if (nt) nt.textContent = titles[state.tab] || T("app.name");
  if (state.tab === "chats" && state.chatsSegment === "chats") renderChatsList();
  if (state.tab === "chats" && state.chatsSegment === "calls") { markMissedCallsSeen(); renderCallsList(); }
  if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
}

// «Mute for 1h» (из раздела 10 роадмапа) — временный мьют поверх уже
// существующего постоянного c.muted. c.muteUntil — абсолютный timestamp
// (как и у «Отправить позже»): истекает сам по себе при следующей проверке,
// отдельный таймер на снятие не нужен — isContactMuted() всегда считает
// актуальное состояние на момент вызова.
function isContactMuted(c) {
  return !!(c && (c.muted || (c.muteUntil && c.muteUntil > Date.now())));
}
function contactStatusLabel(c) {
  if (c.isGroup) return T("group.memberCount", { n: c.members.length });
  if (c.isSelf) return T("chats.selfChat.hint");
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

function renderChatsSkeleton(list) {
  list.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    row.innerHTML = `
      <div class="skeleton-avatar"></div>
      <div class="skeleton-lines">
        <div class="skeleton-line" style="width:${55 + (i % 3) * 10}%"></div>
        <div class="skeleton-line short"></div>
      </div>`;
    list.appendChild(row);
  }
}
function formatChatListTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatTime(ts);
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return T("status.yesterday");
  if (d.getFullYear() === now.getFullYear()) { try { return d.toLocaleDateString(I18N.current, { day: "2-digit", month: "2-digit" }); } catch (e) { return formatDay(ts); } }
  return formatDay(ts);
}
function renderChatsList() {
  const list = $("#chats-list"), empty = $("#chats-empty"), archivedToggle = $("#chats-archived-toggle");
  if (!list) return;
  list.innerHTML = "";
  const query = state.searchQuery.toLowerCase();
  const all = Array.from(state.contacts.values());
  // Холодный старт: пока не прошло ~400мс с запуска (см. startApp), и
  // контактов ещё нет в памяти — показываем skeleton вместо пустого
  // экрана, чтобы не мигать "No one is online yet" на долю секунды,
  // пока состояние только восстанавливается из хранилища.
  if (!state._firstRenderDone && all.length === 0 && !query) {
    if (empty) empty.classList.add("hidden");
    if (archivedToggle) archivedToggle.classList.add("hidden");
    renderChatsSkeleton(list);
    return;
  }
  const activeFolder = state.chatFilter.startsWith("folder:") ? state.folders.find((f) => f.id === state.chatFilter.slice(7)) : null;
  const passesChatFilter = (c) => {
    if (state.chatFilter === "unread") return unreadCount(c) > 0;
    if (state.chatFilter === "groups") return isGroup(c);
    if (state.chatFilter === "direct") return !isGroup(c);
    if (state.chatFilter.startsWith("folder:")) return !!activeFolder && activeFolder.contactIds.includes(c.id);
    return true;
  };
  // Тумблер архива виден, только если в архиве есть чат, подходящий под текущий фильтр.
  const withArchived = all.some((c) => c.archived && passesChatFilter(c));
  const visible = all.filter((c) => (c.archived ? state.showArchived : true) && passesChatFilter(c));
  const filtered = query
    ? visible.filter((c) => (c.name || "").toLowerCase().includes(query) || c.messages.some((m) => (m.text || "").toLowerCase().includes(query) || (m.file && m.file.name || "").toLowerCase().includes(query) || (m.contactCard && m.contactCard.name || "").toLowerCase().includes(query)))
    : visible;
  if (filtered.length === 0) {
    if (empty) empty.classList.toggle("hidden", query.length > 0 || state.chatFilter !== "all");
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
  // Sticky секция "Непрочитанные": группируем непрочитанные чаты (кроме
  // закреплённых — те и так всегда наверху) в отдельный блок с заголовком.
  // Включаем только когда это реально что-то разделяет (есть и
  // непрочитанные, и прочитанные среди незакреплённых) и только во вкладке
  // "Все" без поиска — во вкладке "Unread" и так показаны только
  // непрочитанные, а при поиске заголовок был бы лишним шумом.
  const showUnreadSection = state.chatFilter === "all" && !query && (() => {
    const rest = filtered.filter((c) => !c.pinned);
    return rest.some((c) => unreadCount(c) > 0) && rest.some((c) => unreadCount(c) === 0);
  })();
  const items = filtered.sort((a, b) => {
    const aPinned = a.pinned ? 1 : 0, bPinned = b.pinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    // Среди закреплённых — явный ручной порядок (раздел 4 роадмапа,
    // drag-to-reorder), а не online/lastActivity, как у обычных чатов:
    // пользователь сам расставил их руками, пересортировка по активности
    // на каждый новый входящий чат сделала бы drag бессмысленным.
    if (a.pinned && b.pinned) return (a.pinOrder || 0) - (b.pinOrder || 0);
    if (showUnreadSection && !a.pinned && !b.pinned) {
      const aUnread = unreadCount(a) > 0 ? 1 : 0, bUnread = unreadCount(b) > 0 ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
    }
    const aLive = isReachable(a) || a.online ? 1 : 0, bLive = isReachable(b) || b.online ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
  // Drag-to-reorder закреплённых (раздел 4) доступен только там, где видимый
  // порядок закреплённых чатов совпадает с их реальным pinOrder "начисто" —
  // то есть во вкладке "Все" без поиска и без включённого "показать
  // архивные" (архивный+закреплённый чат — редкий краевой случай, в этом
  // релизе сознательно не усложняем). pinnedPairs заполняется по ходу
  // рендера и используется один раз после цикла, чтобы навесить обработчики
  // перетаскивания на уже готовые DOM-узлы.
  const canReorderPins = state.chatFilter === "all" && !query && !state.showArchived;
  const pinnedCountTotal = items.filter((c) => c.pinned).length;
  const pinnedPairs = [];
  let unreadHeaderShown = false;
  for (const c of items) {
    if (showUnreadSection && !c.pinned && !unreadHeaderShown && unreadCount(c) > 0) {
      const header = document.createElement("div");
      header.className = "chats-section-header";
      header.textContent = T("chats.section.unread");
      list.appendChild(header);
      unreadHeaderShown = true;
    }
    const last = c.messages[c.messages.length - 1];
    const unread = unreadCount(c);
    const wrapper = document.createElement("div");
    wrapper.className = "chat-row-wrapper";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chat-row flat-content" + (c.archived ? " archived" : "");
    const badge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : "";
    const mentionIcon = state.mentionedChats.has(c.id) ? `<span class="chat-row-mention" title="${escapeHtml(T("chats.mentioned"))}">@</span>` : "";
    // Раньше title у этих двух иконок был захардкожен на английском ("Mute"/
    // "Blocked") — единственное место в списке чатов, где подсказка не шла
    // через T(). При смене языка подсказка оставалась английской.
    const __rowMuted = isContactMuted(c);
    const muteIcon = __rowMuted ? `<span class="muted-icon" title="${escapeHtml(c.muted ? T("chat.contact.mute") : T("chat.mute.until", { time: formatChatListTime(c.muteUntil) }))}"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 5 5.9v4l1.6 2.4a1 1 0 0 1-.8 1.6H5.2a1 1 0 0 1-.8-1.6L6 13.5v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1zm-2 18a2 2 0 0 0 4 0h-4z"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>` : "";
    const blockIcon = c.blocked ? `<span class="muted-icon" title="${escapeHtml(T("chat.contact.block"))}"><svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>` : "";
    const pinIcon = c.pinned ? `<span class="muted-icon" title="${escapeHtml(T("chats.pin"))}"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M14 2 22 10l-3 3-1-1-4 4 1 5-2 2-5-5-5 5-1-1 5-5-5-5 2-2 5 1 4-4-1-1z"/></svg></span>` : "";
    let preview = last
      ? (last.from === "system" && last.textKey ? escapeHtml(renderSystemMessageText(last)) : last.file ? escapeHtml(T("chat.file.preview." + last.file.kind)) : (last.contactCard ? escapeHtml(T("chat.contactCard.preview", { name: last.contactCard.name || T("sys.someone") })) : escapeHtml(truncate(last.text, 42))))
      : escapeHtml(contactStatusLabel(c));
    if (query && last && (last.text || "").toLowerCase().includes(query)) preview = highlightRaw(escapeHtml(truncate(last.text, 42)), state.searchQuery);
    // "Печатает…" перекрывает обычное превью — раньше это было видно
    // только в шапке уже открытого треда, хотя состояние (typingTimers)
    // уже отслеживалось и для списка чатов, просто не использовалось.
    const isTyping = !isGroup(c) && state.typingTimers.has(c.id);
    if (isTyping) {
      preview = `<span class="chat-row-typing"><span class="typing-dots" aria-label="${escapeHtml(T("chat.typing"))}"><span></span><span></span><span></span></span></span>`;
    } else {
      // Черновик перекрывает обычное превью (но не "печатает") — только
      // если он не пуст. Хранится отдельно от самого текста сообщения,
      // поэтому не влияет на последнее реальное сообщение в чате.
      const draft = state.drafts[c.id];
      if (draft && draft.trim()) {
        preview = `<span class="chat-row-draft">${escapeHtml(T("chats.draft"))}:</span> ` + escapeHtml(truncate(draft, 34));
      }
    }
    // "Не доставлено" — последнее МОЁ сообщение в чате зависло в ack=failed.
    const lastMine = c.messages.length ? [...c.messages].reverse().find((m) => m.from === "me") : null;
    const failIcon = lastMine && lastMine.ack === "failed"
      ? `<span class="muted-icon chat-row-fail-icon" title="${escapeHtml(T("ack.failed"))}"><svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M11 7h2v6h-2zm0 8h2v2h-2z"/></svg></span>`
      : "";

    // Статус онлайн теперь точкой прямо на аватаре (как Signal/WhatsApp),
    // а не текстовым символом ● справа от имени. У групп точку не
    // показываем — там статус не про presence одного человека.
    const showDot = !isGroup(c) && c.managed && !c.isSelf; // self-chat не "онлайн"/"офлайн" — у него просто нет такого понятия
    const statusDot = showDot ? `<span class="avatar-status-dot ${contactStatusClass(c)}"></span>` : "";
    const timeLabel = last ? escapeHtml(formatChatListTime(last.ts)) : "";
    // Ручка drag-to-reorder (раздел 4) — только у закреплённых чатов, и
    // только когда их больше одного (тащить единственный закреплённый чат
    // некуда) и видимый порядок надёжен (см. canReorderPins выше). Это
    // <span>, а не <button>: row сам уже <button>, а вложенные кнопки в
    // кнопке — невалидный HTML и в некоторых браузерах теряют pointer-события.
    const showDragHandle = c.pinned && canReorderPins && pinnedCountTotal > 1;
    const dragHandle = showDragHandle
      ? `<span class="chat-row-drag-handle" aria-hidden="true"><svg viewBox="0 0 12 20" width="12" height="20"><circle cx="3" cy="3" r="1.4" fill="currentColor"/><circle cx="9" cy="3" r="1.4" fill="currentColor"/><circle cx="3" cy="10" r="1.4" fill="currentColor"/><circle cx="9" cy="10" r="1.4" fill="currentColor"/><circle cx="3" cy="17" r="1.4" fill="currentColor"/><circle cx="9" cy="17" r="1.4" fill="currentColor"/></svg></span>`
      : "";
    row.innerHTML = `
      ${avatarCircleHtml(c, null, statusDot)}
      <div class="chat-row-body">
        <div class="chat-row-top">
          <span class="chat-row-name${unread > 0 ? " unread" : ""}">${pinIcon}${escapeHtml(c.name || T("sys.someone"))} ${muteIcon}${blockIcon}</span>
          <span class="chat-row-time">${timeLabel}</span>
        </div>
        <div class="chat-row-sub"><span class="chat-row-preview-text">${preview}</span>${failIcon}${mentionIcon}${badge}${dragHandle}</div>
      </div>`;
    // Свайп открывает фоновые действия (pin/архив слева, удалить справа)
    // — сама кнопка строки едет поверх них через translateX. Структура:
    // wrapper > [фон с действиями] + [сама строка].
    wrapper.innerHTML = `
      <div class="chat-row-actions chat-row-actions-start">
        <button type="button" class="chat-row-action-btn chat-row-action-archive" data-action="archive">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20.5 4h-17A1.5 1.5 0 0 0 2 5.5v2A1.5 1.5 0 0 0 3.5 9H4v9.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9h.5A1.5 1.5 0 0 0 22 7.5v-2A1.5 1.5 0 0 0 20.5 4zM18 18.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V9h12v9.5zM20 7H4V6h16v1z"/><path fill="currentColor" d="M9.5 13h5a.5.5 0 0 0 0-1h-5a.5.5 0 0 0 0 1z"/></svg>
          <span>${escapeHtml(c.archived ? T("chats.action.unarchive") : T("chats.action.archive"))}</span>
        </button>
        <button type="button" class="chat-row-action-btn chat-row-action-mute" data-action="mute">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 5 5.9v4l1.6 2.4a1 1 0 0 1-.8 1.6H5.2a1 1 0 0 1-.8-1.6L6 13.5v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1zm-2 18a2 2 0 0 0 4 0h-4z"/>${__rowMuted ? `<line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` : ""}</svg>
          <span>${escapeHtml(__rowMuted ? T("chats.action.unmute") : T("chats.action.mute"))}</span>
        </button>
      </div>
      <div class="chat-row-actions chat-row-actions-end">
        <button type="button" class="chat-row-action-btn chat-row-action-pin" data-action="pin">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14 2 22 10l-3 3-1-1-4 4 1 5-2 2-5-5-5 5-1-1 5-5-5-5 2-2 5 1 4-4-1-1z"/></svg>
          <span>${escapeHtml(c.pinned ? T("chats.unpin") : T("chats.pin"))}</span>
        </button>
        <button type="button" class="chat-row-action-btn chat-row-action-delete" data-action="delete">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 7h12l-1 13.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 20.5L6 7zm3.5-4h5l1 2H19v1.5H5V5h4.5l1-2z"/></svg>
          <span>${escapeHtml(T("chats.action.delete"))}</span>
        </button>
      </div>`;
    wrapper.appendChild(row);
    row.addEventListener("click", () => { try { closeChatSearch(); } catch (e) {} cancelVoiceRecordingIfLeavingChat(c.id); state.multiSelect = null; state.chatId = c.id; renderTab(); });
    attachChatRowSwipe(wrapper, row, c);
    if (showDragHandle) pinnedPairs.push({ wrapper, c });
    list.appendChild(wrapper);
  }
  // Навешиваем обработчики перетаскивания одним проходом после того, как
  // все строки закреплённых чатов уже в DOM — attachPinDragHandle нужны
  // itemBoundingClientRect() соседних строк, а они известны только когда
  // все уже отрендерены.
  if (pinnedPairs.length > 1) {
    pinnedPairs.forEach((pair, i) => {
      const handle = pair.wrapper.querySelector(".chat-row-drag-handle");
      if (handle) attachPinDragHandle(handle, pair.wrapper, pinnedPairs, i);
    });
  }
}
// Drag-to-reorder закреплённых чатов (раздел 4 роадмапа). Решение в пользу
// простоты: во время перетаскивания строка просто едет за пальцем по
// вертикали (translateY), соседние строки визуально НЕ "расступаются" —
// итоговый порядок пересчитывается целиком только в момент отпускания, по
// тому, какая из исходных позиций закреплённых строк (снятых ДО начала
// жеста) оказалась ближе к пальцу. Дороже в UX, чем live-реордер соседей,
// но сильно меньше кода и площади для регрессии — ничего в существующем
// свайпе строки (attachChatRowSwipe) не трогается, обработчики полностью
// изолированы на отдельном маленьком элементе-ручке.
function attachPinDragHandle(handle, wrapper, pinnedPairs, startIndex) {
  let dragging = false, startY = 0, rects = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    startY = e.clientY;
    rects = pinnedPairs.map((p) => p.wrapper.getBoundingClientRect());
    wrapper.classList.add("pin-dragging");
    haptic("light");
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    wrapper.style.transform = `translateY(${e.clientY - startY}px)`;
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    wrapper.classList.remove("pin-dragging");
    wrapper.style.transform = "";
    let targetIndex = startIndex, bestDist = Infinity;
    rects.forEach((r, i) => {
      const d = Math.abs((r.top + r.height / 2) - e.clientY);
      if (d < bestDist) { bestDist = d; targetIndex = i; }
    });
    if (targetIndex !== startIndex) {
      const ids = pinnedPairs.map((p) => p.c.id);
      const movedId = ids.splice(startIndex, 1)[0];
      ids.splice(targetIndex, 0, movedId);
      ids.forEach((id, i) => { const cc = state.contacts.get(id); if (cc) cc.pinOrder = i; });
      persistContacts();
      haptic("light");
      renderChatsList();
    }
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  // Сам клик по ручке (без перетаскивания) не должен открывать чат — row
  // это <button>, клик на вложенном <span> всплывёт на него, если не
  // остановить.
  handle.addEventListener("click", (e) => { e.stopPropagation(); });
}

// Кэш «сейчас светлая тема?» — matchMedia и чтение dataset дорогие
// при вызове на каждый рендер каждого контакта. Сбрасывается в
// applyTheme() и в слушателе prefers-color-scheme.
let __isLightCache = null;
function isLightTheme() {
  if (__isLightCache !== null) return __isLightCache;
  const t = document.documentElement.dataset.theme;
  __isLightCache = (t === "light") || (t === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  return __isLightCache;
}

// Генерация аватара: вместо пяти пресетов — уникальный HSL-градиент
// от хэша имени. В тёмной теме — приглушённее (light 42%), в светлой
// — наоборот светлее (52%). Два угла градиента берутся из одного
// оттенка с комплементарным сдвигом +40°.
// P2: кэш по имени+теме — список чатов/контактов пересчитывал один и
// тот же градиент на каждый renderChatsList (и это не только hsl()
// строка, а ещё и цикл по символам имени на хэш). Инвалидируется вместе
// с __isLightCache, тем же local reset в applyTheme()/слушателе
// prefers-color-scheme — ключ сам включает признак темы, так что даже
// без явной чистки старые записи просто не совпадут по ключу.
const _avatarGradientCache = new Map();
function avatarGradient(name) {
  const s = String(name || "?");
  const light = isLightTheme();
  const cacheKey = (light ? "L:" : "D:") + s;
  const cached = _avatarGradientCache.get(cacheKey);
  if (cached) return cached;
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const hue = ((h % 360) + 360) % 360;
  const hue2 = (hue + 40) % 360;
  const sat = 65 + (h % 15);
  const lt = light ? 52 : 42;
  const grad = `linear-gradient(150deg, hsl(${hue}, ${sat}%, ${lt + 8}%), hsl(${hue2}, ${sat}%, ${lt - 6}%))`;
  // Защита от неограниченного роста — на практике число разных имён в
  // одном клиенте мало (контакты + участники групп), но на всякий
  // случай не копим бесконечно (например, если имя меняется часто).
  // Раньше при переполнении карта чистилась ПОЛНОСТЬЮ (.clear()) — это
  // не LRU, а просто сброс всего кэша разом: на следующей же перерисовке
  // списка чатов все контакты заново считают градиент. Map хранит ключи
  // в порядке вставки, так что первые ключи — самые старые; вытесняем
  // только их, как и в fileBlobUrlCache.
  if (_avatarGradientCache.size > 500) {
    const toRemove = _avatarGradientCache.size - 450;
    let removed = 0;
    for (const k of _avatarGradientCache.keys()) {
      if (removed >= toRemove) break;
      _avatarGradientCache.delete(k);
      removed++;
    }
  }
  _avatarGradientCache.set(cacheKey, grad);
  return grad;
}

function renderContactsList() {
  const wrap = $("#contacts-list");
  const empty = $("#contacts-empty");
  const indexNav = $("#contacts-index");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (indexNav) { indexNav.innerHTML = ""; indexNav.classList.add("hidden"); }
  let contacts = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c) && !c.isSelf);
  const q = (state.contactsSearchQuery || "").trim().toLowerCase();
  if (q) contacts = contacts.filter((c) => (c.name || "").toLowerCase().includes(q));
  if (contacts.length === 0) { if (empty) empty.classList.remove("hidden"); return; }
  if (empty) empty.classList.add("hidden");
  // A-Z вместо "по активности" — список контактов, в отличие от списка
  // чатов, это адресная книга: там ищут по имени, не по тому, кто
  // недавно писал (для этого есть отдельный экран чатов).
  contacts.sort((a, b) => (a.name || "").localeCompare(b.name || "", I18N.current, { sensitivity: "base" }));
  // Буквенный индекс показываем только при длинном списке и без активного
  // поиска (во время поиска список и так короткий, а якоря "прыгали" бы
  // следом за фильтром) — >20 контактов порог из отчёта.
  const showIndex = contacts.length > 20 && !q;
  const seenLetters = new Set();
  for (const c of contacts) {
    const row = document.createElement("div");
    row.className = "roster-row";
    const letter = (c.name || "").trim().charAt(0).toUpperCase() || "#";
    if (showIndex) row.dataset.letter = letter;
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
    seenLetters.add(letter);
  }
  if (showIndex && indexNav) {
    indexNav.classList.remove("hidden");
    for (const letter of seenLetters) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "contacts-index-btn"; btn.textContent = letter; btn.tabIndex = -1;
      btn.addEventListener("click", () => {
        const target = Array.from(wrap.children).find((el) => el.dataset.letter === letter);
        if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      indexNav.appendChild(btn);
    }
  }
}

function openContactCard(contactId) {
  if (!state.contacts.has(contactId)) return;
  const c = state.contacts.get(contactId);
  if (isGroup(c)) { openGroupInfo(contactId); return; }
  state.chatId = null;
  __lastRenderedChatId = null;
  state.multiSelect = null; // см. комментарий в closeChatSafely — этот путь выхода из чата её не вызывает
  state.contactCardId = contactId;
  renderTab();
}
function openGroupInfo(groupId) {
  const g = state.contacts.get(groupId); if (!g || !isGroup(g)) return;
  state.activeGroupContext = groupId;
  const avatarBtn = $("#group-info-avatar-btn");
  if (avatarBtn) {
    if (g.avatar) { avatarBtn.style.backgroundImage = `url('${g.avatar}')`; avatarBtn.style.background = ""; avatarBtn.textContent = ""; }
    else { avatarBtn.style.backgroundImage = ""; avatarBtn.style.background = avatarGradient(g.name); avatarBtn.textContent = initials(g.name); }
  }
  const nameInput = $("#group-info-name"); if (nameInput) nameInput.value = g.name || "";
  const descInput = $("#group-info-description"); if (descInput) descInput.value = g.description || "";
  const list = $("#group-info-members");
  const myIsAdmin = isGroupAdmin(g, Store.myId);
  if (list) {
    list.innerHTML = "";
    for (const m of g.members) {
      const row = document.createElement("div");
      row.className = "forward-row";
      const isMe = m.id === Store.myId;
      const memberIsAdmin = isGroupAdmin(g, m.id);
      const canRemove = myIsAdmin && !isMe;
      const roleBadge = memberIsAdmin ? `<span class="group-role-badge">${escapeHtml(T("group.admin"))}</span>` : "";
      row.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(m.name)}">${escapeHtml(initials(m.name))}</div><span class="forward-name">${escapeHtml(m.name)}${isMe ? " " + escapeHtml(T("group.you")) : ""}</span>${roleBadge}`;
      if (myIsAdmin && !isMe && g.createdBy !== m.id) {
        const toggle = document.createElement("button");
        toggle.type = "button"; toggle.className = "icon-btn small";
        toggle.textContent = memberIsAdmin ? T("group.demote") : T("group.promote");
        toggle.addEventListener("click", (ev) => { ev.stopPropagation(); setGroupMemberRole(groupId, m.id, memberIsAdmin ? "member" : "admin"); openGroupInfo(groupId); });
        row.appendChild(toggle);
      }
      if (canRemove) {
        const rm = document.createElement("button");
        rm.type = "button"; rm.className = "icon-btn"; rm.setAttribute("aria-label", T("group.remove"));
        rm.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>';
        rm.addEventListener("click", (ev) => { ev.stopPropagation(); removeGroupMember(groupId, m.id, false); openGroupInfo(groupId); });
        row.appendChild(rm);
      }
      list.appendChild(row);
    }
  }
  const renameBtnEl = $("#group-info-rename-btn"); if (renameBtnEl) renameBtnEl.classList.toggle("hidden", !myIsAdmin);
  const nameInputEl = $("#group-info-name"); if (nameInputEl) nameInputEl.disabled = !myIsAdmin;
  const descBtnEl = $("#group-info-description-btn"); if (descBtnEl) descBtnEl.classList.toggle("hidden", !myIsAdmin);
  const descInputEl = $("#group-info-description"); if (descInputEl) descInputEl.disabled = !myIsAdmin;
  const addBtnEl = $("#group-info-add-btn"); if (addBtnEl) addBtnEl.classList.toggle("hidden", !myIsAdmin);
  const avatarBtnEl = $("#group-info-avatar-btn"); if (avatarBtnEl) avatarBtnEl.disabled = !myIsAdmin;
  const writeRestrictedEl = $("#group-info-write-restricted");
  if (writeRestrictedEl) { writeRestrictedEl.checked = !!g.writeRestricted; writeRestrictedEl.disabled = !myIsAdmin; }
  // Раздел 8/18 роадмапа — invite-ссылка в группу: создавать её может
  // только админ (см. комментарий у buildGroupInviteCode выше по файлу) —
  // участнику без прав added бы не смог обработать join-request, который
  // придёт в ответ на его же ссылку.
  const inviteLinkBtnEl = $("#group-info-invite-link-btn"); if (inviteLinkBtnEl) inviteLinkBtnEl.classList.toggle("hidden", !myIsAdmin);
  const sheet = $("#group-info-sheet"); if (sheet) sheet.classList.remove("hidden");
}
// Раздел 8 роадмапа — "права группы": единственное право, которое есть
// смысл делать без сервера-арбитра — "писать могут только админы".
// Полноценный "медленный режим" (таймер между сообщениями у каждого
// участника) требует доверенного источника времени/состояния — в чистом
// P2P без сервера это легко обойти, подделав локальные часы, так что
// давать на это ложную гарантию хуже, чем не делать вовсе. Этот тумблер —
// честная версия задачи, которую можно реально обеспечить.
function isGroupWriteAllowed(g, userId) {
  if (!g || !g.writeRestricted) return true;
  return isGroupAdmin(g, userId);
}
function setGroupWriteRestricted(groupId, restricted) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  g.writeRestricted = !!restricted;
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T(restricted ? "group.systemWriteRestricted" : "group.systemWriteOpen"), textKey: restricted ? "group.systemWriteRestricted" : "group.systemWriteOpen", ts: Date.now() });
  trimMessages(g);
  g.lastActivity = Date.now();
  persistContacts();
  if (state.chatId === groupId) { renderChatThreadInner(); updateSendVsMic(); }
  // Рассылаем новое состояние всем участникам — иначе их композер и
  // (что важнее) приёмная проверка в applyIncomingPayload остались бы
  // со старым значением writeRestricted, не зная о решении админа.
  const payload = { kind: "group-settings", id: crypto.randomUUID(), groupId, writeRestricted: g.writeRestricted };
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const mc = ensureContactEntry(m.id, m.name);
    trySendOrQueue(mc, crypto.randomUUID(), payload).catch(() => {});
  }
}
function renderContactCard() {
  const c = state.contacts.get(state.contactCardId);
  if (!c) { state.contactCardId = null; renderTab(); return; }
  const av = $("#contact-avatar");
  if (av) {
    // Раньше после backgroundImage шло присваивание av.style.background = "" — сокращённое свойство сбрасывало и картинку,
    // поэтому выбранное фото никогда не показывалось. Теперь сначала фон-заготовка, затем (если есть фото) только backgroundImage.
    const shown = c.avatar || c.peerAvatar;
    if (shown && AVATAR_DATAURL_RE.test(shown)) { av.style.background = ""; av.style.backgroundImage = `url('${shown}')`; av.style.backgroundSize = "cover"; av.style.backgroundPosition = "center"; av.textContent = ""; }
    else { av.style.backgroundImage = ""; av.style.backgroundSize = ""; av.style.background = avatarGradient(c.name); av.textContent = initials(c.name); }
  }
  const n = $("#contact-name"); if (n) n.textContent = c.name || T("sys.someone");
  const navT = $("#nav-contact-title"); if (navT) navT.textContent = c.name || T("sys.someone");
  const st = $("#contact-status"); if (st) st.textContent = contactStatusLabel(c);
  const aboutEl = $("#contact-about-status");
  if (aboutEl) {
    const about = (c.peerStatus || "").trim();
    aboutEl.textContent = about;
    aboutEl.classList.toggle("hidden", !about);
  }
  const idEl = $("#contact-info-id"); if (idEl) idEl.textContent = c.raw || T("chat.contact.identifier.unknown");
  const contactIsMuted = isContactMuted(c);
  const mutedEl = $("#contact-info-muted");
  if (mutedEl) {
    const bellPath = '<path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 5 5.9v4l1.6 2.4a1 1 0 0 1-.8 1.6H5.2a1 1 0 0 1-.8-1.6L6 13.5v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1zm-2 18a2 2 0 0 0 4 0h-4z"/>';
    const slash = '<line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    mutedEl.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16">${bellPath}${contactIsMuted ? slash : ""}</svg>`;
    mutedEl.title = contactIsMuted && !c.muted ? T("chat.mute.until", { time: formatChatListTime(c.muteUntil) }) : "";
  }
  const vibrateOnlyEl = $("#contact-vibrate-only"); if (vibrateOnlyEl) vibrateOnlyEl.checked = !!c.vibrateOnly;
  const blockBtn = $("#contact-block-btn"); if (blockBtn) blockBtn.textContent = c.blocked ? T("chat.contact.unblock") : T("chat.contact.block");
  const archBtn = $("#contact-archive-btn");
  if (archBtn) {
    // Подпись переключается «В архив» ↔ «Из архива»; меняем только первый <span> (стрелка-шеврон остаётся) и его data-i18n,
    // иначе applyStaticTranslations() вернёт старую подпись.
    const key = c.archived ? "chat.contact.unarchive" : "chat.contact.archive";
    const lb = archBtn.querySelector("span");
    if (lb) { lb.textContent = T(key); lb.setAttribute("data-i18n", key); } else archBtn.textContent = T(key);
  }
  // Раньше здесь было muteBtn.textContent = T(...), что стирало ВСЮ
  // разметку кнопки (включая <span class="chevron"> со стрелкой) — textContent
  // заменяет все дети одним текстовым узлом. Теперь трогаем только первый
  // <span> (подпись), чеврон остаётся на месте; подпись дополнительно
  // отражает реальный статус (постоянный/временный мьют), а не всегда "Mute".
  const muteBtn = $("#contact-mute-btn");
  if (muteBtn) {
    const muteLabel = muteBtn.querySelector("span");
    if (muteLabel) muteLabel.textContent = contactIsMuted ? T("chats.action.unmute") : T("chat.contact.mute");
  }
  const pinBtnLbl = $("#contact-pin-btn span"); if (pinBtnLbl) pinBtnLbl.textContent = c.pinned ? T("chats.unpin") : T("chats.pin");
  const disSel = $("#contact-disappearing-select"); if (disSel) disSel.value = String(c.disappearingTimer || 0);
  const soundSel = $("#contact-sound-select"); if (soundSel) soundSel.value = c.notificationSound || "";
  renderContactGallery(c);
}
// P2 — галерея медиа контакта: мини-грид последних фото/видео из переписки,
// в карточке контакта. Загружаем object URL лениво, только когда карточка
// открыта (getFileBlobUrl уже кеширует и ограничивает размер кеша).
function renderContactGallery(c) {
  const group = $("#contact-gallery-group");
  const grid = $("#contact-gallery-grid");
  const countEl = $("#contact-gallery-count");
  if (!group || !grid) return;
  const media = c.messages.filter((m) => m.file && !m.file.pending && !m.file.failed && (m.file.kind === "image" || m.file.kind === "video")).slice(-24).reverse();
  if (media.length === 0) { group.classList.add("hidden"); grid.innerHTML = ""; return; }
  group.classList.remove("hidden");
  if (countEl) countEl.textContent = String(media.length);
  grid.innerHTML = media.map((m) => `<button type="button" class="contact-gallery-item" data-msg-id="${escapeHtml(m.id)}" data-kind="${escapeHtml(m.file.kind)}"><div class="contact-gallery-loading"></div></button>`).join("");
  for (const m of media) {
    const btn = grid.querySelector(`[data-msg-id="${CSS.escape(m.id)}"]`);
    if (!btn) continue;
    getFileBlobUrl(m.id).then((url) => {
      if (!url || !btn.isConnected) return;
      if (m.file.kind === "video") {
        btn.innerHTML = `<video src="${escapeHtml(url)}" muted playsinline></video><span class="contact-gallery-play"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></span>`;
      } else {
        btn.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`;
      }
    }).catch(() => {});
  }
}
function wireContactGallery() {
  const grid = $("#contact-gallery-grid");
  if (!grid) return;
  grid.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".contact-gallery-item");
    if (!btn) return;
    const msgId = btn.dataset.msgId;
    const url = await getFileBlobUrl(msgId);
    if (url) window.open(url, "_blank");
  });
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
  // killer-features-backlog 0.7 — тап по аватару контакта открывает выбор
  // локального фото (см. setContactAvatar — никогда не уходит пиру).
  const avatarBtn = $("#contact-avatar");
  const avatarInput = $("#contact-avatar-input");
  if (avatarBtn && avatarInput) {
    avatarBtn.addEventListener("click", () => avatarInput.click());
    avatarInput.addEventListener("change", async () => {
      const file = avatarInput.files && avatarInput.files[0];
      avatarInput.value = "";
      const id = state.contactCardId; if (!file || !id) return;
      try {
        const dataUrl = await readImageAsAvatarDataUrl(file);
        setContactAvatar(id, dataUrl);
      } catch (e) { toast(T("toast.avatarFailed")); }
    });
  }
  const disSel = $("#contact-disappearing-select");
  if (disSel) disSel.addEventListener("change", (e) => {
    const id = state.contactCardId; if (!id) return;
    setDisappearingTimer(id, parseInt(e.target.value, 10) || 0);
  });
  const soundSel = $("#contact-sound-select");
  if (soundSel) soundSel.addEventListener("change", (e) => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    const v = e.target.value;
    if (v) c.notificationSound = v; else delete c.notificationSound; // "" = убрать override, снова использовать общий дефолт
    persistContacts();
  });
  const mute = $("#contact-mute-btn");
  if (mute) mute.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (isContactMuted(c)) {
      // Уже заглушен (постоянно или временно) — тап просто снимает мьют,
      // без шторки. Шторка с длительностью нужна только для ВКЛЮЧЕНИЯ мьюта.
      c.muted = false; c.muteUntil = null; persistContacts(); renderContactCard();
      toast(T("toast.unmuted"));
    } else {
      const sheet = $("#mute-sheet"); if (sheet) sheet.classList.remove("hidden");
    }
  });
  const vibrateOnly = $("#contact-vibrate-only");
  if (vibrateOnly) vibrateOnly.addEventListener("change", (e) => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.vibrateOnly = e.target.checked; persistContacts();
  });
  const pinBtn = $("#contact-pin-btn");
  if (pinBtn) pinBtn.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.pinned = !c.pinned;
    // Новый pinOrder — только когда чат ЗАКРЕПЛЯЕТСЯ (уходит в конец
    // текущего списка закреплённых); при снятии закрепления обнуляем, чтобы
    // повторное закрепление снова уходило в конец, а не возвращалось на
    // старое место (раздел 4 роадмапа — drag-to-reorder).
    if (c.pinned) c.pinOrder = nextPinOrder(); else c.pinOrder = null;
    persistContacts(); renderContactCard();
    try { renderChatsList(); } catch (e) {}
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
  if (clear) clear.addEventListener("click", async () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (!await confirmSheet(T("toast.confirmDeleteChat", { name: c.name }), { destructive: true })) return;
    cleanupExpiredFileBlobs(c.messages);
    c.messages = []; c.lastActivity = Date.now(); persistContacts();
    toast(T("toast.historyCleared"));
  });
  const del = $("#contact-delete-btn");
  if (del) del.addEventListener("click", async () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (!await confirmSheet(T("toast.confirmDeleteContact", { name: c.name }), { destructive: true })) return;
    deleteContact(state.contactCardId);
  });
}

// =====================================================================
// Тред
// =====================================================================
function ackGlyph(ack) {
  // 5 состояний на основе единой SVG-формы (Вариант B — «Эфирная
  // прогрессия»). Отличие от старой версии: не текст-символы ✓/◷/!,
  // а тонкие SVG-галочки — одинаковый размер во всех состояниях,
  // никакой зависимости от -webkit-text-stroke. Различие между
  // состояниями — через opacity, толщину обводки и цвет:
  //   pending   — пульсирующая точка 4px (рисуется CSS ::before)
  //   sent      — одна галочка, 55% opacity
  //   delivered — две галочки, 55% opacity
  //   read      — две галочки, 100% белый + белое свечение
  //   failed    — «!» в тонком контуре круга, красный
  // Вторая галочка выезжает справа через CSS-анимацию.
  const lbl = (k) => `role="img" aria-label="${escapeHtml(T("ack." + k))}"`;
  const tick = `<svg class="ack-svg" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M2 7.5 L5.2 10.7 L12 3"/></svg>`;
  const tick2 = `<svg class="ack-svg ack-svg-2" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M2 7.5 L5.2 10.7 L12 3"/></svg>`;

  if (ack === "failed") {
    return `<span class="ack-tick ack-failed" ${lbl("failed")} data-retry="1"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M7 3.6 V7.4 M7 10 V10.5"/></svg></span>`;
  }
  if (ack === "read")      return `<span class="ack-tick ack-read" ${lbl("read")}>${tick}${tick2}</span>`;
  if (ack === "delivered") return `<span class="ack-tick ack-delivered" ${lbl("delivered")}>${tick}${tick2}</span>`;
  if (ack === "pending")   return `<span class="ack-tick ack-pending" ${lbl("pending")}></span>`;
  return `<span class="ack-tick ack-sent" ${lbl("sent")}>${tick}</span>`;
}

const NEAR_BOTTOM_PX = 80;
function isNearBottom(el) { if (!el) return true; return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX; }

function renderChatThread() { try { renderChatThreadInner(); } catch (e) { __lastChatSig = ""; etherLog("error", "[renderChatThread]", String(e)); const w = $("#chat-messages"); if (w) w.innerHTML = `<div class="empty-state"><p>Error.</p></div>`; } }

let __lastChatSig = "";
// «Подпись» содержимого переписки: если с прошлой отрисовки ничего видимого не изменилось, DOM не пересобираем —
// раньше каждый заход в чат и каждое событие (статус, набор текста, соединение) перерисовывали ленту 2–3 раза, и это было видно глазом.
function chatRenderSig(c, q) {
  let h = c.id + "|" + q + "|" + (state.multiSelect ? Array.from(state.multiSelect).join(",") : "") + "|" + (unreadDividerFor.get(c.id) || "")
    + "|" + document.documentElement.lang + "|" + Store.linkPreviewsEnabled + "|" + linkPreviewCache.size + "|" + (c.pinnedMessageId || "") + "|" + (isGroup(c) ? "g" : "p") + "|" + (function () { try { return localStorage.getItem("ether.fx") || ""; } catch (e) { return ""; } })();
  for (const m of c.messages) {
    h += "\n" + m.id + ":" + (m.ack || "") + (m.edited ? "e" : "") + (m.deleted ? "d" : "") + (m.favorite ? "f" : "") + (m.ttl || "") + (m.forwarded ? "w" : "") + ":" + (m.text || "")
      + (m.translation ? m.translation.text : "") + (m.reactions ? JSON.stringify(m.reactions) : "")
      + (m.file ? [m.file.pending ? 1 : 0, m.file.failed ? 1 : 0, m.file.progress || "", m.file.w || ""].join("") : "") + (m.replyTo ? "r" : "");
  }
  return h;
}
function renderChatThreadInner() {
  const c = state.contacts.get(state.chatId);
  if (!c) { state.chatId = null; renderTab(); return; }
  const screenEl = $("#screen-chat"); if (screenEl) screenEl.setAttribute("aria-label", c.name || T("sys.someone"));
  const freshEntry = state.chatId !== __lastRenderedChatId;
  if (state.chatId !== __lastRenderedChatId) {
    // Тот же баг, что и в closeChatSafely — переключение МЕЖДУ чатами
    // не останавливало играющее голосовое из предыдущего чата.
    pauseAllVoicePlayback();
    closeQuickReactionFlyout(); // иначе плывущая панель реакций осталась бы висеть над уже другим чатом под ней

    // Свежий вход в чат — сбрасываем набор отрендеренных ранее id,
    // иначе новые сообщения в этом чате будут сравниваться с id из
    // ПРЕДЫДУЩЕГО чата и все получат "just-sent".
    __prevRenderedMsgIds = new Set();
    renderScheduleBanner();
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
  const avEl = $("#chat-peer-avatar"); if (avEl) avEl.innerHTML = avatarCircleHtml(c, null, "");
  const statusEl = $("#chat-peer-status");
  const typing = !isGroup(c) && state.typingTimers.has(c.id);
  if (statusEl) {
    if (isGroup(c)) { statusEl.textContent = T("group.memberCount", { n: c.members.length }); statusEl.classList.remove("typing"); }
    else if (typing) {
      statusEl.innerHTML = `<span class="typing-dots" aria-label="${escapeHtml(T("chat.typing"))}"><span></span><span></span><span></span></span>`;
      statusEl.classList.add("typing");
    } else {
      statusEl.textContent = contactStatusLabel(c);
      statusEl.classList.remove("typing");
    }
  }
  const retryAllBtn = $("#chat-retry-all-btn");
  if (retryAllBtn) retryAllBtn.classList.toggle("hidden", !c.messages.some((m) => m.from === "me" && m.ack === "failed"));
  updateMultiSelectBanner();
  const pinnedBanner = $("#pinned-msg-banner");
  if (pinnedBanner) {
    const pinnedMsg = c.pinnedMessageId ? c.messages.find((m) => m.id === c.pinnedMessageId) : null;
    pinnedBanner.classList.toggle("hidden", !pinnedMsg);
    if (pinnedMsg) {
      const textEl = $("#pinned-msg-text");
      if (textEl) textEl.textContent = pinnedMsg.file ? T("chat.file.preview." + pinnedMsg.file.kind) : truncate(pinnedMsg.text || "", 60);
    } else if (c.pinnedMessageId) {
      // Сообщение удалено — чистим висячую ссылку. Раньше это не
      // сохранялось через persistContacts(): после перезагрузки страницы
      // c.pinnedMessageId читался из storage снова ненулевым и каждый
      // renderChatThreadInner заново его обнулял — чисто косметическая
      // гонка, но лишняя работа и теоретически мигающий баннер на долю
      // кадра до следующего рендера. Персистим один раз, когда реально
      // меняем значение (не на каждый рендер, когда оно уже null).
      c.pinnedMessageId = null;
      persistContacts();
    }
  }
  // Звонить можно и контакту не в сети: ему уйдёт push с приглашением (нужен только идентификатор, т.е. managed).
  const canCall = !isGroup(c) && !c.isSelf && (isReachable(c) || !!c.managed);
  const ccb = $("#chat-call-btn");
  if (ccb) { ccb.disabled = isGroup(c) ? false : !canCall; ccb.classList.remove("call-unavailable"); }
  const vcb = $("#chat-video-call-btn");
  if (vcb) { vcb.disabled = isGroup(c) ? false : !canCall; vcb.classList.remove("call-unavailable"); }
  // Файлы в группах не поддерживаются — раньше это выяснялось только
  // ПОСЛЕ выбора файла, когда sendFileMessage сам отказывал. Честнее не
  // показывать кнопку как рабочую вовсе. Кнопка микрофона решается в
  // updateSendVsMic() (там же учитывается видимость от текста в поле —
  // два независимых переключателя одного и того же .hidden конфликтовали бы).
  // Композер одинаковый в личных чатах и группах: вложения, камера и голосовые работают и там (в группе — до 1 МБ на файл)
  const attachBtn = $("#chat-attach-btn"); if (attachBtn) attachBtn.classList.remove("hidden");
  const cameraBtn = $("#chat-camera-btn"); if (cameraBtn) cameraBtn.classList.remove("hidden");
  // Раздел 8 — "права группы": не-админ видит явно закрытый композер
  // (с подсказкой), а не узнаёт о запрете только по тосту после попытки
  // отправить — так понятнее сразу, не трогая поле вообще.
  const writeBlocked = isGroup(c) && !isGroupWriteAllowed(c, Store.myId);
  const chatInputEl = $("#chat-input");
  if (chatInputEl) {
    chatInputEl.disabled = writeBlocked;
    chatInputEl.placeholder = writeBlocked ? T("chat.composerRestricted") : "";
  }

  const badge = $("#chat-transport-badge");
  const link = (mesh && !isGroup(c)) ? mesh.get(c.id) : null;
  if (badge) {
    // Три SVG-иконки вместо текстовых P2P / S / …: пользователю
    // непонятны эти аббревиатуры, а две встречные стрелки / облако /
    // пунктирный круг читаются интуитивно. Пояснение — в aria-label
    // (озвучивается скринридером, видно при долгом нажатии).
    if (isGroup(c)) {
      badge.classList.add("hidden");
      badge.innerHTML = "";
    } else if (link && (link.status === "connected" || link.status === "in-call")) {
      badge.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M2 8h12 M9.5 3.5 14 8l-4.5 4.5 M6.5 3.5 2 8l4.5 4.5"/></svg>`;
      badge.setAttribute("aria-label", T("chat.transport.direct"));
      badge.classList.remove("hidden", "via-server");
    } else if (link && link.status === "connecting") {
      badge.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="3.5 3.5" stroke-linecap="round"/></svg>`;
      badge.setAttribute("aria-label", T("chat.transport.connecting"));
      badge.classList.add("via-server"); badge.classList.remove("hidden");
    } else if (c.managed && c.online) {
      badge.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M4.7 11.5a3.2 3.2 0 0 1 0-6.4 4.7 4.7 0 0 1 8.9 1.4 2.6 2.6 0 0 1-.5 5z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M5.7 8.3h4.6"/></svg>`;
      badge.setAttribute("aria-label", T("chat.transport.server"));
      badge.classList.add("via-server"); badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
      badge.innerHTML = "";
      badge.removeAttribute("aria-label");
    }
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
  const q = state.chatSearchQuery.toLowerCase();
  const sig = chatRenderSig(c, q);
  if (sig === __lastChatSig && wrap.dataset.renderedChat === c.id && wrap.childElementCount > 0) {
    // Ничего видимого не изменилось — DOM оставляем, только приводим в порядок прокрутку/поле ввода
    const dv = wrap.querySelector(".unread-divider");
    if (dv && freshEntry && !dividerScrolledFor.has(c.id)) { dv.scrollIntoView({ block: "center" }); dividerScrolledFor.add(c.id); }
    else if (freshEntry) wrap.scrollTop = wrap.scrollHeight;
    const inp = $("#chat-input");
    if (inp && !state.editingMessageId && state._inputDraftChatId !== c.id) { inp.value = state.drafts[c.id] || ""; state._inputDraftChatId = c.id; }
    updateScrollBottomButton(); updateSendVsMic();
    if (isNearBottom(wrap)) { unreadDividerFor.delete(c.id); dividerScrolledFor.delete(c.id); markThreadRead(c); }
    return;
  }
  __lastChatSig = sig; wrap.dataset.renderedChat = c.id;
  wrap.innerHTML = "";
  const frag = document.createDocumentFragment();
  let lastDay = "";
  const urlsToFetch = new Set();
  let prevMsg = null;
  const unreadAnchorId = unreadDividerFor.get(c.id);
  let unreadDividerEl = null;
  // Набор id сообщений текущего рендера + признаки "только что
  // появившееся" для запуска анимации send/receive. Если при предыдущем
  // рендере в этом же чате уже были какие-то сообщения (prev.size > 0),
  // то всё, чего там не было, — новое. На самом первом рендере чата
  // prev пуст → ничего не считаем новым, иначе при открытии чата все
  // пузыри разом анимировались бы.
  const prevMsgIds = __prevRenderedMsgIds;
  const freshEnabled = prevMsgIds.size > 0 || !freshEntry;
  const nextMsgIds = new Set();
  for (const m of c.messages) {
    nextMsgIds.add(m.id);
    const freshnessClass = (freshEnabled && !prevMsgIds.has(m.id))
      ? (m.from === "me" ? " just-sent" : " just-received")
      : "";
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
      sep.className = "date-sep date-sep-clickable";
      const inner = document.createElement("span");
      inner.textContent = dayStr;
      sep.appendChild(inner);
      // P2 — тап по разделителю даты открывает пикер даты, чтобы
      // прыгнуть в произвольный день переписки (а не просто подпись).
      sep.addEventListener("click", () => openJumpToDateSheet(state.chatId));
      frag.appendChild(sep);
      lastDay = dayStr;
      prevMsg = null; // новый день — тоже новая группа
    }
    // Подряд идущие сообщения одного собеседника (в пределах 5 минут) визуально
    // сближаем — так делают WhatsApp/Telegram/iMessage: понятно, что это одна
    // "реплика", а не череда отдельных сообщений.
    const grouped = !!(prevMsg && prevMsg.from === m.from && (m.from !== "them" || !isGroup(c) || prevMsg.fromId === m.fromId) && m.ts - prevMsg.ts < 5 * 60 * 1000);
    const bubble = document.createElement("div");
    const msIsOn = !!state.multiSelect;
    const msSelected = msIsOn && state.multiSelect.has(m.id);
    bubble.className = "bubble-row " + (m.from === "me" ? "mine" : "theirs") + (grouped ? " grouped" : "") + freshnessClass + (msIsOn ? " multiselect-active" : "") + (msSelected ? " multiselect-selected" : "");
    if (msIsOn) {
      const check = document.createElement("div");
      check.className = "multiselect-checkbox" + (msSelected ? " checked" : "");
      bubble.appendChild(check);
    }
    const tick = m.from === "me" ? ackGlyph(m.ack) : "";
    const editedMark = m.edited ? `<span class="bubble-edited">${escapeHtml(T("chat.edit"))}</span>` : "";
    const ttlMark = m.ttl ? `<span class="bubble-ttl" title="${escapeHtml(disappearingTimerLabel(m.ttl))}"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 2h12v2l-4.5 5L18 14v2H6v-2l4.5-5L6 4V2zm2.2 2L11 7.5h2L15.8 4H8.2zM11 13.5 8.2 17h7.6L13 13.5h-2z"/></svg></span>` : "";
    const favMark = m.favorite ? `<span class="bubble-favorite" title="${escapeHtml(T("chat.favorite"))}"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M12 2 9.2 8.6 2 9.2l5.5 4.7L5.8 21 12 17.3 18.2 21l-1.7-7.1L22 9.2l-7.2-.6z"/></svg></span>` : "";
    const inner = document.createElement("div");
    // Класс glass-content убран с чужих пузырей: новый дизайн — матовый
    // фон --bg-2 + тонкий border (см. styles.css). Стекло на десятках
    // пузырей одновременно и перегружало визуально, и нагружало
    // композитинг (20+ blur-слоёв).
    inner.className = "bubble" + (m.mentionMe ? " bubble-mentioned" : "");
    inner.setAttribute("data-msg-id", m.id); // для прокрутки к оригиналу по тапу на цитате ответа
    const body = m.file ? fileBubbleHtml(m.id, m.file) : (m.contactCard ? contactCardBubbleHtml(m.contactCard) : linkifyAndHighlight(m.text, q));
    const isFirstOfGroupBlock = !prevMsg || prevMsg.fromId !== m.fromId || prevMsg.from !== "them";
    const senderLabel = (isGroup(c) && m.from === "them" && m.fromId && isFirstOfGroupBlock)
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
if (m.replyTo) {
  // Поле переименовано у отправителя: rec.replyTo.id (не msgId). Читаем
  // оба варианта — для старых сообщений, сохранённых ещё с msgId.
  const rtId = m.replyTo.id || m.replyTo.msgId || "";
  replyHtml = `<div class="bubble-reply" data-reply-to-id="${escapeHtml(rtId)}"><div class="bubble-reply-author">${escapeHtml(m.replyTo.authorName || "")}</div><div class="bubble-reply-text">${escapeHtml(truncate(m.replyTo.text || "", 80))}</div></div>`;
}
    const fwdMark = m.forwarded ? `<div class="bubble-forwarded">${escapeHtml(m.forwardedFrom ? T("chat.forwardedFrom", { name: m.forwardedFrom }) : T("chat.forwarded"))}</div>` : "";
    let reactionsHtml = "";
    if (m.reactions && typeof m.reactions === "object") {
      const chips = Object.entries(m.reactions).filter(([, users]) => Array.isArray(users) && users.length > 0);
      if (chips.length > 0) reactionsHtml = `<div class="bubble-reactions">` + chips.map(([emoji, users]) => `<span class="bubble-reaction-chip" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)} ${typeof fxReactionStack === "function" ? fxReactionStack(users) : ""}${users.length}</span>`).join("") + `</div>`;
    }
    // Перевод (раздел 5 роадмапа) — показывается ПОД оригинальным текстом,
    // не заменяет его: честно видно и то, что собеседник написал сам, и
    // то, во что это превратил сторонний сервер перевода.
    const translationHtml = (m.translation && m.translation.text)
      ? `<div class="bubble-translation"><span class="bubble-translation-label">${escapeHtml(T("chat.translated"))}</span> ${linkifyAndHighlight(m.translation.text, q)}</div>` : "";
    inner.innerHTML = `${senderLabel}${fwdMark}${replyHtml}${body}${translationHtml}${previewSlotHtml}<span class="bubble-time">${ttlMark}${favMark}${formatTime(m.ts)}${editedMark}${tick}</span>${reactionsHtml}`;
    // Долгое нажатие — открывает обычное меню действий (ответить/
    // переслать/удалить), для ЛЮБОГО типа сообщения, как в большинстве
    // мессенджеров. Обычный тап при этом делает контентно-зависимое
    // действие по умолчанию (см. ниже) вместо меню.
    let longPressFired = false;
    let longPressTimer = null;
    let longPressLiftTimer = null;
    let longPressMoved = false;
    let lpStartX = 0, lpStartY = 0;
    function startLongPress(x, y) {
      longPressMoved = false;
      lpStartX = x; lpStartY = y;
      clearTimeout(longPressTimer);
      clearTimeout(longPressLiftTimer);
      // Раньше пузырь неподвижно стоял все 500мс до открытия меню — на
      // ощупь это "залипание", а не нажатие. "Приподнимаем" его уже
      // через 100мс как лёгкий отклик на палец, до того как решится,
      // долгое это нажатие или нет.
      longPressLiftTimer = setTimeout(() => { if (!longPressMoved) inner.classList.add("bubble-pressing"); }, 100);
      longPressTimer = setTimeout(() => {
        if (!longPressMoved && !state.multiSelect) {
          longPressFired = true;
          try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
          // Группы не поддерживают реакции (см. комментарий в
          // openMessageSheet) — там долгое нажатие ведёт прямо в старую
          // полную шторку действий, без промежуточной плывущей панели,
          // которой для этого чата всё равно было бы нечего показывать.
          if (isGroup(c)) openMessageSheet(m.id, c.id);
          else openQuickReactionFlyout(inner, m.id, c.id);
        }
        inner.classList.remove("bubble-pressing");
      }, 500);
    }
    function moveLongPress(x, y) {
      if (Math.abs(x - lpStartX) > 10 || Math.abs(y - lpStartY) > 10) {
        longPressMoved = true; clearTimeout(longPressTimer); clearTimeout(longPressLiftTimer);
        inner.classList.remove("bubble-pressing");
      }
    }
    function endLongPress() { clearTimeout(longPressTimer); clearTimeout(longPressLiftTimer); inner.classList.remove("bubble-pressing"); }
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
      if (state.multiSelect) { ev.stopPropagation(); toggleMultiSelectMsg(m.id); return; }
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
      const docLink = ev.target.closest("a.file-bubble-doc[data-file-id]");
      if (docLink) {
        // отдаём браузеру скачать blob — не перехватываем
        return;
      }
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
          spawnReactionBurst(inner, quickEmoji);
          return;
        }
        const timer = setTimeout(() => { __bubbleTapState.delete(m.id); if (state.chatId === c.id) openMessageSheet(m.id, c.id); }, 220);
        __bubbleTapState.set(m.id, { time: Date.now(), timer });
        return;
      }
      openMessageSheet(m.id, c.id);
    });
    attachSwipeReply(inner, m, c);
    if (isGroup(c) && m.from === "them") {
      // Аватар собеседника в групповом чате — иначе посреди блока
      // одинаковых по стилю "чужих" пузырей непонятно, кто именно
      // написал, не читая имя в самом верху блока.
      const avatarSlot = document.createElement("div");
      avatarSlot.className = "bubble-row-avatar" + (isFirstOfGroupBlock ? " avatar-visible" : "");
      if (isFirstOfGroupBlock) {
        const senderContact = state.contacts.get(m.fromId) || { name: m.fromName };
        avatarSlot.innerHTML = avatarCircleHtml(senderContact, null, "");
      }
      bubble.appendChild(avatarSlot);
    }
    bubble.appendChild(inner);
    frag.appendChild(bubble);
    prevMsg = m;
  }
  wrap.appendChild(frag);
  // Пустой чат (ни одного сообщения) — вместо голой пустоты объясняем,
  // что это E2E-переписка, и даём быстрый старт одним тапом.
  if (c.messages.length === 0 && !isGroup(c)) {
    const es = document.createElement("div");
    es.className = "chat-thread-empty";
    es.innerHTML = `
      <div class="chat-thread-empty-icon"><svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M12 2a9 9 0 0 0-9 9c0 1.6.42 3.1 1.15 4.4L3 21l5.75-1.1A9 9 0 1 0 12 2zm-4 8a1.2 1.2 0 1 1 0 2.4A1.2 1.2 0 0 1 8 10zm4 0a1.2 1.2 0 1 1 0 2.4A1.2 1.2 0 0 1 12 10zm4 0a1.2 1.2 0 1 1 0 2.4A1.2 1.2 0 0 1 16 10z"/></svg></div>
      <p class="chat-thread-empty-title">${escapeHtml(T("chat.thread.empty.title"))}</p>
      <button type="button" class="btn-secondary chat-thread-empty-wave" id="chat-thread-empty-wave-btn">${escapeHtml(T("chat.thread.empty.wave"))}</button>`;
    wrap.appendChild(es);
    const waveBtn = es.querySelector("#chat-thread-empty-wave-btn");
    if (waveBtn) waveBtn.addEventListener("click", () => { sendChatMessage(c.id, T("chat.thread.empty.waveText")); });
  }
  // Сохраняем набор отрендеренных id — при следующем рендере только
  // сообщения, которых тут не было, получат анимацию появления.
  __prevRenderedMsgIds = nextMsgIds;
  // Лениво: не фетчим всё сразу (см. observeLinkPreviewSlot) — наблюдаем
  // только реально созданные в этом рендере слоты, а не вызываем
  // renderLinkPreviewInto(u) для каждого url из urlsToFetch напрямую.
  if (urlsToFetch.size > 0) {
    wrap.querySelectorAll('.link-preview-slot[data-preview-for]').forEach((slot) => {
      if (urlsToFetch.has(slot.getAttribute("data-preview-for"))) observeLinkPreviewSlot(slot);
    });
  }
  hydrateFileSlots(wrap);
  // Hydrate асинхронно подгружает картинки/видео из IDB и заметно
  // увеличивает высоту контента. Если пользователь был у низа — дожимаем
  // скролл вниз после того, как всё подгрузилось, иначе layout shift
  // оставляет его «выше низа» на высоту новых картинок, а следующий
  // рендер (например, sweepExpiredMessages раз в 30с) улетает в середину
  // списка, потому что wasAtBottom уже false.
  if (wasAtBottom) {
    const keepBottom = () => { if (isNearBottom(wrap) || wasAtBottom) wrap.scrollTop = wrap.scrollHeight; };
    requestAnimationFrame(keepBottom);
    setTimeout(keepBottom, 300);
    setTimeout(keepBottom, 900);
  }
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
  if (input && !state.editingMessageId) {
    // Черновик привязан к чату: при смене чата поле ЗАМЕНЯЕТСЯ его черновиком или очищается.
    // Раньше, если у нового чата черновика не было, в поле оставался текст предыдущего чата.
    // Перерисовка того же чата (входящее сообщение) поле не трогает — иначе сбивался бы ввод.
    if (state._inputDraftChatId !== c.id) {
      // Поле всё ещё содержит текст ПРЕДЫДУЩЕГО чата (смена чата в обход closeChatSafely, например из
      // глобального поиска) — сохраняем его как черновик того чата, прежде чем заменить.
      const prevId = state._inputDraftChatId;
      if (prevId && state.contacts.has(prevId)) {
        const pv = input.value.trim();
        if (pv) state.drafts[prevId] = pv; else delete state.drafts[prevId];
        persistDrafts();
      }
      input.value = state.drafts[c.id] || "";
      state._inputDraftChatId = c.id;
    }
  }
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
const CHAT_ROW_REVEAL_PX = 168; // две кнопки слева (mute + архив), см. комментарий у END_PX
const CHAT_ROW_REVEAL_END_PX = 168; // две кнопки (pin + удалить, справа)
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
  // Панели асимметричны (start — 1 кнопка, end — 2 кнопки: pin+delete),
  // поэтому дистанция "полного открытия" разная для каждой стороны.
  row.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    dragging = false;
    if (__openChatRowWrapper && __openChatRowWrapper !== wrapper) closeOpenChatRow();
    currentX = wrapper.classList.contains("swiped-start") ? CHAT_ROW_REVEAL_PX : wrapper.classList.contains("swiped-end") ? -CHAT_ROW_REVEAL_END_PX : 0;
    row.style.transition = "none";
  }, { passive: true });
  row.addEventListener("touchmove", (e) => {
    const rawDx = e.touches[0].clientX - startX + currentX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (!dragging && Math.abs(rawDx - currentX) > 10 && Math.abs(rawDx - currentX) > dy) dragging = true;
    if (!dragging) return;
    const dx = Math.max(-CHAT_ROW_REVEAL_END_PX * 1.3, Math.min(CHAT_ROW_REVEAL_PX * 1.3, rawDx));
    row.style.transform = `translateX(${dx}px)`;
    // кнопки действий показываем только с той стороны, в которую тянут (иначе они просвечивают сквозь полупрозрачную плашку)
    wrapper.classList.toggle("drag-start", dx > 4); wrapper.classList.toggle("drag-end", dx < -4);
  }, { passive: true });
  row.addEventListener("touchend", () => {
    row.style.transition = "";
    if (!dragging) return;
    setTimeout(() => wrapper.classList.remove("drag-start", "drag-end"), 260);
    const m1 = row.style.transform.match(/translateX\((-?\d+(?:\.\d+)?)px\)/);
    const dx = m1 ? parseFloat(m1[1]) : 0;
    // Положительный сдвиг открывает панель, которая физически СЛЕВА —
    // это "start" в LTR, но "end" в RTL (см. комментарий выше).
    const wantsPhysicalLeftPanel = dx > CHAT_ROW_REVEAL_PX / 2;
    const wantsPhysicalRightPanel = dx < -CHAT_ROW_REVEAL_END_PX / 2;
    const opensStart = isRtl ? wantsPhysicalRightPanel : wantsPhysicalLeftPanel;
    const opensEnd = isRtl ? wantsPhysicalLeftPanel : wantsPhysicalRightPanel;
    if (opensStart) {
      row.style.transform = `translateX(${CHAT_ROW_REVEAL_PX}px)`;
      wrapper.classList.add("swiped-start"); wrapper.classList.remove("swiped-end");
      __openChatRowWrapper = wrapper;
      haptic("light");
    } else if (opensEnd) {
      row.style.transform = `translateX(${-CHAT_ROW_REVEAL_END_PX}px)`;
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
  wrapper.querySelector(".chat-row-action-mute").addEventListener("click", () => {
    closeOpenChatRow();
    // Свайп-мьют из списка чатов — всегда постоянный (без шторки выбора
    // длительности, см. #mute-sheet в карточке контакта): это
    // быстрое действие на одну строку, а не отдельный флоу.
    if (isContactMuted(c)) { c.muted = false; c.muteUntil = null; }
    else { c.muted = true; }
    persistContacts(); haptic("light");
    toast(c.muted ? T("toast.muted") : T("toast.unmuted"));
    renderChatsList();
  });
  wrapper.querySelector(".chat-row-action-pin").addEventListener("click", () => {
    closeOpenChatRow();
    c.pinned = !c.pinned;
    if (c.pinned) c.pinOrder = nextPinOrder(); else c.pinOrder = null;
    persistContacts(); haptic("light"); renderChatsList();
  });
  wrapper.querySelector(".chat-row-action-delete").addEventListener("click", async () => {
    if (!await confirmSheet(T("toast.confirmDeleteContact", { name: c.name }), { destructive: true })) { closeOpenChatRow(); return; }
    closeOpenChatRow();
    deleteContact(c.id);
  });
}
function attachSwipeReply(el, m, c) {
  let startX = 0, startY = 0, swiping = false, thresholdCrossed = false;
  const isRtl = document.documentElement.dir === "rtl";
  const SWIPE_REPLY_THRESHOLD = 40; // в единицах уже отмасштабированного (dx*0.5) смещения — см. ниже
  el.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; swiping = false; thresholdCrossed = false;
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
    if (swiping && dx > 0) {
      const scaled = Math.min(dx * 0.5, 60);
      el.style.transform = `translateX(${(isRtl ? -1 : 1) * scaled}px)`;
      // Раньше о пороге "достаточно для ответа" пользователь узнавал
      // только ПОСЛЕ отпускания пальца (сработало/не сработало) — теперь
      // лёгкий haptic-тик + визуальный отклик (подсветка пузыря) ровно в
      // момент пересечения порога, один раз на жест, а не на каждый пиксель.
      const ready = scaled >= SWIPE_REPLY_THRESHOLD;
      if (ready && !thresholdCrossed) { thresholdCrossed = true; haptic("light"); el.classList.add("swipe-ready"); }
      else if (!ready && thresholdCrossed) { thresholdCrossed = false; el.classList.remove("swipe-ready"); }
    }
  }, { passive: true });
  el.addEventListener("touchend", () => {
    el.style.transition = "";
    el.classList.remove("swipe-ready");
    const tr = el.style.transform;
    el.style.transform = "";
    if (swiping && thresholdCrossed) {
      const m1 = tr && tr.match(/translateX\((-?\d+(?:\.\d+)?)px\)/);
      if (m1 && Math.abs(parseFloat(m1[1])) > SWIPE_REPLY_THRESHOLD) {
        state.replyTo = { msgId: m.id, text: m.text, from: m.from, authorName: m.from === "me" ? (Store.name || "") : (m.fromName || c.name || "") };
        showReplyBanner();
        const inp = $("#chat-input"); if (inp) inp.focus();
      }
    }
    swiping = false; thresholdCrossed = false;
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
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  const n = c ? unreadCount(c) : 0;
  if (countEl) {
    if (n > 0) { countEl.textContent = n > 99 ? "99+" : String(n); countEl.classList.remove("hidden"); }
    else countEl.classList.add("hidden");
  }
  // Акцентный "↓ к новым" только когда реально есть непрочитанные выше —
  // просьба отличать от нейтрального "просто вернуться вниз".
  btn.classList.toggle("has-unread", n > 0);
  btn.setAttribute("aria-label", T(n > 0 ? "a11y.toNewMessages" : "a11y.toLast"));
}
function markThreadRead(c) {
  const toAck = [];
  for (const m of c.messages) if (m.from === "them" && !m.readAckSent) { m.readAckSent = true; toAck.push(m); }
  state.mentionedChats.delete(c.id); // весь тред помечен прочитанным выше — упоминания в нём больше не "непрочитанные"
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
  // Выход из чата — пишем ГАРАНТИРОВАННО синхронно (не через
  // scheduleDraftPersist), иначе на быстром уходе из чата отложенная
  // запись может не успеть сработать до размонтирования. Отменяем
  // отложенный вызов, чтобы не писать то же самое дважды.
  if (__draftPersistTimer) { clearTimeout(__draftPersistTimer); __draftPersistTimer = null; }
  persistDrafts();
}
// Внимание: .chat-input-bar двигается через transform — position: sticky у баннеров
// внутри/рядом с ним работать не будет; учитывайте это при добавлении sticky-элементов.
let __kbBaseH = 0;
// Нажатия на «+», эмодзи, камеру, скрепку, отправку и т.п. не должны убирать системную клавиатуру: кнопка перехватывает фокус у поля ввода.
// Отменяем сдвиг фокуса на mousedown и, если фокус всё-таки потерян, возвращаем его в поле сразу после действия.
function wireKeepKeyboard() {
  const sel = ".chat-input-bar button:not(#chat-emoji-btn), #composer-fan button:not(#chat-emoji-btn)";
  let had = false;
  const inp = () => $("#chat-input");
  document.addEventListener("pointerdown", (e) => { had = document.activeElement === inp(); }, true);
  // Панель эмодзи выезжает вместо клавиатуры: при её открытии клавиатуру убираем
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("#chat-emoji-btn")) { const i = inp(); if (i && document.activeElement === i) i.blur(); }
  }, true);
  document.addEventListener("mousedown", (e) => {
    if (had && e.target.closest && e.target.closest(sel) && !e.target.closest("#emoji-search-input")) e.preventDefault();
  }, true);
  document.addEventListener("click", (e) => {
    if (!had || !e.target.closest || !e.target.closest(sel)) return;
    setTimeout(() => {
      const i = inp(); const ae = document.activeElement;
      const otherField = ae && ae !== document.body && ae !== i && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
      if (i && !i.disabled && !otherField && state.chatId) { try { i.focus({ preventScroll: true }); } catch (er) {} }
    }, 0);
  }, true);
}
function wireKeyboardFix() {
  if (!window.visualViewport) return;
  __kbBaseH = Math.round(window.visualViewport.height || window.innerHeight || 0);
  const vv = window.visualViewport;
  let kbWasOpen = false;
  // iOS при открытии клавиатуры НЕ меняет layout-viewport, а прокручивает visual viewport вверх (offsetTop > 0):
  // всё приложение "уезжало" наверх вместе с шапкой, а поле ввода дёргалось из-за собственного transform.
  // Теперь оболочка приложения привязывается к ВИДИМОЙ области: высота = vv.height, сдвиг = vv.offsetTop.
  // Шапка остаётся наверху видимой области, поле ввода — прямо над клавиатурой, переписка сжимается,
  // последние сообщения остаются на экране.
  function update() {
    const shell = document.getElementById("app-shell"); if (!shell) return;
    const root = document.documentElement;
    // Эталон «полной» высоты — максимум, который мы видели без клавиатуры (на iOS innerHeight иногда тоже уменьшается вместе с клавиатурой)
    const ae = document.activeElement;
    const typing = !!(ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT"));
    const layoutH = Math.max(window.innerHeight || 0, __kbBaseH);
    if (!typing && vv.height > __kbBaseH - 80) __kbBaseH = Math.max(__kbBaseH, Math.round(vv.height));
    const kbOpen = layoutH - vv.height > 100; // клавиатура — это >100px разницы; мелкие колебания (панель Safari) игнорируем
    if (kbOpen) {
      shell.style.height = Math.round(vv.height) + "px";
      shell.style.transform = vv.offsetTop > 0 ? "translateY(" + Math.round(vv.offsetTop) + "px)" : "";
      root.classList.add("kb-open"); // убирает нижнюю safe-area у таб-бара, пока клавиатура открыта
    } else {
      shell.style.height = ""; shell.style.transform = "";
      root.classList.remove("kb-open");
      // iOS после закрытия клавиатуры иногда оставляет страницу прокрученной — возвращаем в 0
      if (window.scrollY || vv.offsetTop) { try { window.scrollTo(0, 0); } catch (e) {} }
    }
    const wrap = document.getElementById("chat-messages");
    const chatVisible = wrap && !wrap.closest(".hidden");
    if (chatVisible && (kbOpen !== kbWasOpen || isNearBottom(wrap))) {
      requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
    }
    kbWasOpen = kbOpen;
  }
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  // iOS анимирует клавиатуру ~300 мс и шлёт resize с опозданием — досчитываем несколько раз после фокуса
  document.addEventListener("focusin", () => { for (const d of [60, 200, 400, 700]) setTimeout(update, d); });
  // Страница не должна оставаться смещённой после ухода фокуса с поля ввода.
  document.addEventListener("focusout", () => setTimeout(() => {
    update();
    if (window.scrollY || (window.visualViewport && window.visualViewport.offsetTop && !document.documentElement.classList.contains("kb-open"))) { try { window.scrollTo(0, 0); } catch (e) {} }
  }, 80));
}

// =====================================================================
// Отправка/редактирование/удаление
// =====================================================================
async function sendChatMessage(contactId, text, replyTo) {
  const c = state.contacts.get(contactId); if (!c) return;
  if (c.blocked) { toast(T("toast.blocked")); return; }
  text = applyEmojiAutoReplace(text);
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
// "Отправить позже" — реально отправляем через тот же sendChatMessage/
// sendGroupMessage, которые использует обычная форма, а не отдельный
// путь доставки: отложенное сообщение технически ничем не отличается от
// обычного, просто момент вызова сдвинут.
function sweepScheduledMessages() {
  if (!state.scheduledMessages || state.scheduledMessages.length === 0) return;
  const now = Date.now();
  const due = state.scheduledMessages.filter((s) => s.sendAt <= now);
  if (due.length === 0) return;
  state.scheduledMessages = state.scheduledMessages.filter((s) => s.sendAt > now);
  persistScheduledMessages();
  for (const s of due) {
    const c = state.contacts.get(s.contactId);
    if (!c) continue; // контакт удалён за время ожидания — молча пропускаем, не ошибка
    if (s.isGroup) sendGroupMessage(s.contactId, s.text, s.replyTo || null);
    else sendChatMessage(s.contactId, s.text, s.replyTo || null);
  }
  renderScheduleBanner();
}
function scheduledCountFor(contactId) {
  return state.scheduledMessages.filter((s) => s.contactId === contactId).length;
}
function renderScheduleBanner() {
  const banner = $("#schedule-banner"); if (!banner) return;
  const n = state.chatId ? scheduledCountFor(state.chatId) : 0;
  banner.classList.toggle("hidden", n === 0);
  const countEl = $("#schedule-banner-count"); if (countEl) countEl.textContent = String(n);
}
function openScheduleSheet() {
  const sheet = $("#schedule-sheet"); if (!sheet) return;
  const input = $("#schedule-custom-input");
  if (input) { const d = new Date(Date.now() + 3600000); d.setSeconds(0, 0); input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  sheet.classList.remove("hidden");
}
function queueScheduledMessage(sendAt) {
  if (!state.chatId) return;
  const c = state.contacts.get(state.chatId); if (!c) return;
  const input = $("#chat-input"); if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const rec = { id: crypto.randomUUID(), contactId: state.chatId, isGroup: isGroup(c), text, replyTo: state.replyTo || null, sendAt };
  state.scheduledMessages.push(rec);
  persistScheduledMessages();
  input.value = "";
  delete state.drafts[state.chatId]; persistDrafts();
  cancelReply();
  updateSendVsMic();
  const sheet = $("#schedule-sheet"); if (sheet) sheet.classList.add("hidden");
  toast(T("toast.scheduled"));
  renderScheduleBanner();
}
function openScheduleListSheet() {
  const list = $("#schedule-list"); if (!list) return;
  list.innerHTML = "";
  const rows = state.scheduledMessages.filter((s) => s.contactId === state.chatId).sort((a, b) => a.sendAt - b.sendAt);
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "forward-row";
    const snippet = truncate(row.text || "", 60);
    item.innerHTML = `<span class="forward-name">${escapeHtml(snippet)}<br><span class="fine muted">${escapeHtml(formatChatListTime(row.sendAt))}</span></span>`;
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "icon-btn small schedule-row-cancel-btn"; cancelBtn.setAttribute("aria-label", T("sys.cancel"));
    cancelBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>`;
    cancelBtn.addEventListener("click", () => {
      state.scheduledMessages = state.scheduledMessages.filter((s) => s.id !== row.id);
      persistScheduledMessages();
      renderScheduleBanner();
      openScheduleListSheet();
    });
    item.appendChild(cancelBtn);
    list.appendChild(item);
  }
  const sheet = $("#schedule-list-sheet"); if (sheet) sheet.classList.remove("hidden");
}
// «Mute for Nh» (из раздела 10 роадмапа, реклассифицировано как опция
// карточки контакта, не кнопка уведомления — нет места в лимите в 2 кнопки
// вместе с «Ответить»/«Прочитано», см. V.38.0.0/V.40.0.0). Шторка открывается
// из #contact-mute-btn только когда контакт ещё НЕ заглушен (см. wireContactCard).
function wireMuteSheet() {
  function apply(muteUntil, forever) {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (forever) { c.muted = true; c.muteUntil = null; }
    else { c.muted = false; c.muteUntil = muteUntil; }
    persistContacts();
    const sheet = $("#mute-sheet"); if (sheet) sheet.classList.add("hidden");
    renderContactCard();
    toast(forever ? T("toast.muted") : T("chat.mute.until", { time: formatChatListTime(muteUntil) }));
  }
  const h1 = $("#mute-preset-1h"); if (h1) h1.addEventListener("click", () => apply(Date.now() + 3600000, false));
  const h8 = $("#mute-preset-8h"); if (h8) h8.addEventListener("click", () => apply(Date.now() + 8 * 3600000, false));
  const tmr = $("#mute-preset-tomorrow"); if (tmr) tmr.addEventListener("click", () => {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    apply(d.getTime(), false);
  });
  const forever = $("#mute-preset-forever"); if (forever) forever.addEventListener("click", () => apply(null, true));
}
function wireScheduleSend() {
  const btn = document.querySelector('#chat-form button[type="submit"].send-btn');
  if (!btn) return;
  let timer = null, fired = false;
  function start() {
    fired = false;
    clearTimeout(timer);
    const input = $("#chat-input");
    if (!input || !input.value.trim() || !state.chatId || state.editingMessageId) return;
    timer = setTimeout(() => {
      fired = true;
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
      openScheduleSheet();
    }, 500);
  }
  function cancelTimer() { clearTimeout(timer); }
  btn.addEventListener("touchstart", start, { passive: true });
  btn.addEventListener("touchend", cancelTimer);
  btn.addEventListener("touchmove", cancelTimer);
  btn.addEventListener("touchcancel", cancelTimer);
  btn.addEventListener("mousedown", start);
  btn.addEventListener("mouseup", cancelTimer);
  btn.addEventListener("mouseleave", cancelTimer);
  // Долгое нажатие уже открыло шторку — гасим клик/submit, который иначе
  // отправил бы сообщение немедленно сразу после отпускания.
  btn.addEventListener("click", (e) => { if (fired) { e.preventDefault(); fired = false; } }, true);
  const banner = $("#schedule-banner"); if (banner) banner.addEventListener("click", openScheduleListSheet);
  const preset1h = $("#schedule-preset-1h"); if (preset1h) preset1h.addEventListener("click", () => queueScheduledMessage(Date.now() + 3600000));
  const presetTomorrow = $("#schedule-preset-tomorrow"); if (presetTomorrow) presetTomorrow.addEventListener("click", () => {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    queueScheduledMessage(d.getTime());
  });
  const customBtn = $("#schedule-custom-confirm-btn"); if (customBtn) customBtn.addEventListener("click", () => {
    const input = $("#schedule-custom-input"); if (!input || !input.value) return;
    const ms = new Date(input.value).getTime();
    if (!Number.isFinite(ms)) return;
    queueScheduledMessage(Math.max(ms, Date.now() + 1000));
  });
}
async function commitEdit(contactId, msgId, newText) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  newText = applyEmojiAutoReplace(String(newText)).slice(0, MAX_MESSAGE_LENGTH);
  m.text = newText; m.edited = true; m.ts = Date.now();
  c.lastActivity = m.ts;
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  const actionId = crypto.randomUUID();
  const payload = { kind: "edit", id: msgId, text: newText, ts: m.ts };
  await trySendOrQueue(c, actionId, payload);
}
function deleteMessageLocal(contactId, msgId, batch) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId);
  if (m && m.file) {
    IDB.del("file:" + msgId).catch(() => {});
    const url = fileBlobUrlCache.get(msgId);
    if (url) { URL.revokeObjectURL(url); fileBlobUrlCache.delete(msgId); }
  }
  c.messages = c.messages.filter((x) => x.id !== msgId);
  if (batch) return; // пакетное удаление: сохранение и перерисовка — один раз после цикла
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
  if (recentlyDeletedIds.delete(id)) persistRecentlyDeleted(); // осознанное повторное добавление снимает блокировку из deleteContact
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
// Сжатие изображений перед отправкой — canvas, прогрессивное снижение
// качества/разрешения, пока не уложится в целевой размер (или пока не
// кончатся попытки). PNG с прозрачностью тоже конвертируется в JPEG
// (белая подложка вместо прозрачности) — для типичного случая "отправить
// фото" это подходящий компромисс; если после этого всё равно больше
// целевого размера, возвращаем null — вызывающий код решает, что делать
// (отклонить с понятной ошибкой, а не молча отправить гигантский файл).
async function compressImageToTarget(file, maxBytes) {
  if (!file.type || file.type.indexOf("image/") !== 0) return null;
  if (file.type === "image/svg+xml" || file.type === "image/gif") return null; // векторные/анимация — сжимать растрово нет смысла
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch (e) { return null; }
  const MAX_DIM = 1920; // разумное разрешение для сообщения в чате, не для печати
  let { width, height } = bitmap;
  if (width > MAX_DIM || height > MAX_DIM) {
    const scale = MAX_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); // подложка под прозрачность
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close && bitmap.close();
  const qualities = [0.85, 0.7, 0.55, 0.4];
  for (const q of qualities) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
    if (blob && blob.size <= maxBytes) return blob;
  }
  // Качество исчерпано — последняя попытка: уменьшаем ещё разрешение
  // вдвое. КРИТИЧНО: раньше здесь переиспользовался ТОТ ЖЕ canvas —
  // присвоение canvas.width/height стирает его содержимое по спецификации
  // HTML, а следующая строка пыталась рисовать ИЗ этого canvas В НЕГО ЖЕ,
  // уже пустого. На выходе — чистый белый прямоугольник вместо сжатого
  // фото. Если это "пустое" изображение укладывалось в maxBytes (а
  // укладывалось почти всегда — кодировать нечего), оно тихо уходило
  // получателю как якобы успешно сжатый результат. Реальный эффект: любое
  // обычное фото с телефона (3-4МБ, где q=0.4 уже не хватает) получало
  // либо пустую картинку, либо отказ — рабочего пути не было вовсе.
  // Фикс: отдельный, новый canvas для уменьшенной копии.
  if (width > 640 && height > 640) {
    const temp = document.createElement("canvas");
    temp.width = Math.round(width / 2);
    temp.height = Math.round(height / 2);
    const ctx2 = temp.getContext("2d");
    ctx2.fillStyle = "#fff"; ctx2.fillRect(0, 0, temp.width, temp.height);
    ctx2.drawImage(canvas, 0, 0, width, height, 0, 0, temp.width, temp.height);
    const blob = await new Promise((resolve) => temp.toBlob(resolve, "image/jpeg", 0.6));
    if (blob && blob.size <= maxBytes) return blob;
  }
  return null;
}
// Единая точка входа для файлов, выбранных через скрепку ИЛИ системную
// камеру (P1.11 мультивыбор + P1.12 превью с подписью перед отправкой).
// Один файл-изображение/видео — превью-шит с полем подписи. Несколько
// файлов сразу, или один файл другого типа — отправляются как раньше,
// без промежуточного экрана (для документов подпись не так полезна,
// а шит на 10 файлов подряд был бы утомителен).
let __pendingComposeFile = null;
function handlePickedFiles(files) {
  if (!files.length || !state.chatId) return;
  if (files.length === 1) {
    const kind = fileKindFromMime(files[0].type);
    if (kind === "image" || kind === "video") { openMediaComposeSheet(files[0]); return; }
    sendFileMessage(state.chatId, files[0]);
    return;
  }
  // Несколько файлов — та же логика, что для одного, но без тостов на
  // каждый (sendFileMessage(..., {silent:true})), иначе 10 файлов дают
  // 10 "Connecting…" тостов подряд.
  const contactId = state.chatId;
  (async () => {
    for (const f of files) { try { await sendFileMessage(contactId, f, { silent: true }); } catch (e) {} }
  })();
}
function openMediaComposeSheet(file) {
  __pendingComposeFile = file;
  const preview = $("#media-compose-preview");
  const captionInput = $("#media-compose-caption");
  if (captionInput) captionInput.value = "";
  if (preview) {
    preview.innerHTML = "";
    const url = URL.createObjectURL(file);
    const isVideo = fileKindFromMime(file.type) === "video";
    const el = document.createElement(isVideo ? "video" : "img");
    el.src = url;
    if (isVideo) { el.controls = true; el.playsInline = true; } else { el.alt = ""; }
    // Шит может быть закрыт без отправки (Cancel/backdrop) — освобождаем
    // object URL при следующем открытии, а не копим их бесконечно.
    preview.dataset.objectUrl = url;
    preview.appendChild(el);
  }
  const sheet = $("#media-compose-sheet"); if (sheet) sheet.classList.remove("hidden");
  setTimeout(() => { if (captionInput) captionInput.focus(); }, 50);
}
function closeMediaComposeSheet() {
  const preview = $("#media-compose-preview");
  if (preview && preview.dataset.objectUrl) { try { URL.revokeObjectURL(preview.dataset.objectUrl); } catch (e) {} delete preview.dataset.objectUrl; }
  __pendingComposeFile = null;
  const sheet = $("#media-compose-sheet"); if (sheet) sheet.classList.add("hidden");
}
function wireMediaComposeSheet() {
  const sendBtn = $("#media-compose-send");
  if (sendBtn) sendBtn.addEventListener("click", () => {
    const file = __pendingComposeFile;
    const contactId = state.chatId;
    const captionInput = $("#media-compose-caption");
    const caption = captionInput ? captionInput.value.trim() : "";
    closeMediaComposeSheet();
    if (file && contactId) sendFileMessage(contactId, file, { caption });
  });
  const sheet = $("#media-compose-sheet");
  if (sheet) {
    // Доп. к общему wireSheetBackdrops (который просто прячет шторку) —
    // освобождаем object URL превью, иначе он утекает до следующего
    // открытия шита.
    const backdrop = sheet.querySelector(".sheet-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeMediaComposeSheet);
    const cancelBtn = sheet.querySelector(".sheet-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", closeMediaComposeSheet);
  }
}
// В группе вложение уходит каждому участнику отдельной копией (один зашифрованный конверт на человека), поэтому потолок
// ниже, чем в личном чате: 1 МБ вместо 2 МБ (картинки сжимаются под него автоматически).
const GROUP_FILE_MAX = 1024 * 1024;
async function sendFileMessage(contactId, file, opts) {
  opts = opts || {};
  const caption = typeof opts.caption === "string" ? opts.caption.trim().slice(0, 200) : "";
  const silent = !!opts.silent; // при массовой отправке (P1.11) не плодим тост на каждый файл
  const c = state.contacts.get(contactId); if (!c) return;
  const inGroup = isGroup(c);
  const sizeCap = inGroup ? GROUP_FILE_MAX : MAX_FILE_SIZE;
  if (!inGroup && c.blocked) { toast(T("toast.blocked")); return; }
  // Раньше нижней границы не было вовсе — пустой (0 байт) файл
  // отправитель видел как "отправлено", а handleFilePayload на
  // стороне получателя (через EtherFileLimits.isValidFileMetaSize,
  // где size > 0) молча его отбрасывал. Симметрично отклоняем уже
  // здесь, с понятным сообщением, а не тихим расхождением.
  if (file.size === 0) { toast(T("toast.fileEmpty")); return; }
  if (file.size > MAX_FILE_SIZE_INPUT) { toast(T("toast.fileTooLarge", { size: formatFileSize(MAX_FILE_SIZE_INPUT) })); return; }
  // Целевой потолок того, что реально уходит — 2МБ. Если исходник
  // больше и это изображение — пробуем сжать автоматически, вместо
  // того чтобы сразу отказывать. Итоговый Blob подменяет исходный
  // file для всего остального пути (P2P/офлайн-очередь его не
  // различают — им важен только размер и содержимое).
  if (file.size > sizeCap) {
    const compressed = await compressImageToTarget(file, sizeCap);
    if (compressed) {
      const origName = file.name || "photo.jpg";
      const newName = origName.replace(/\.[^.]+$/, "") + ".jpg";
      file = new File([compressed], newName, { type: "image/jpeg" });
    } else {
      toast(T("toast.fileTooLarge", { size: formatFileSize(sizeCap) }));
      return;
    }
  }
  if (inGroup) { await sendGroupFile(contactId, file, { caption }); return; }
  const existingLink = mesh.get(contactId);
  const alreadyLive = existingLink && (existingLink.status === "connected" || existingLink.status === "in-call");
  if (!alreadyLive && !silent) toast(T("toast.connecting"));
  const link = alreadyLive ? existingLink : await ensureLiveLink(contactId, 8000);
  if (!link) {
    // Раньше тут просто отказывали — теперь, поскольку file гарантированно
    // уже ≤ MAX_FILE_SIZE (2МБ, с большим запасом до серверного
    // MAX_PAYLOAD в 8МБ даже с учётом base64), шлём через тот же
    // зашифрованный почтовый ящик сервера, что и текст (sendFileOffline
    // ниже), вместо жёсткого отказа.
    await sendFileOffline(contactId, file, { caption });
    return;
  }

  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false,
    file: { name: file.name, mime: file.type || "application/octet-stream", size: file.size, kind: fileKindFromMime(file.type), pending: true, progress: 0 },
  };
  if (caption) rec.file.caption = caption;
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
  const ok = await link.sendFile({ id: msgId, name: file.name, mime: rec.file.mime, size: file.size, caption: caption || undefined }, chunks, (done, total) => {
    rec.file.progress = total > 0 ? done / total : 0;
    const el = document.querySelector(`.file-bubble[data-msg-id="${CSS.escape(msgId)}"] .file-progress-fill`);
    if (el) el.style.width = (rec.file.progress * 100).toFixed(1) + "%";
  });
  rec.file.pending = false;
  rec.ack = ok ? "sent" : "failed";
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
  if (!ok) toast(T("toast.fileSendFailed"));
}

// Вложение или голосовое в группу: одна запись в ленте группы + отдельный зашифрованный конверт каждому участнику
// (тот же путь, что у sendGroupMessage: свой deliveryId на получателя, ack сопоставляется через groupDeliveryMap).
async function sendGroupFile(groupId, file, meta) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupWriteAllowed(g, Store.myId)) { toast(T("toast.groupWriteRestricted")); return; }
  meta = meta || {};
  if (!file || file.size === 0) { toast(T("toast.fileEmpty")); return; }
  if (file.size > GROUP_FILE_MAX) { toast(T("toast.fileTooLarge", { size: formatFileSize(GROUP_FILE_MAX) })); return; }
  const mime = file.type || meta.mime || "application/octet-stream";
  const name = meta.name || file.name || "file";
  const caption = typeof meta.caption === "string" ? meta.caption.trim().slice(0, 200) : "";
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent",
    file: { name, mime, size: file.size, kind: fileKindFromMime(mime), pending: true },
  };
  if (meta.duration) rec.file.duration = meta.duration;
  if (caption) rec.file.caption = caption;
  if (g.disappearingTimer) rec.ttl = g.disappearingTimer;
  g.messages.push(rec); trimMessages(g); g.lastActivity = ts; persistContacts();
  if (state.chatId === groupId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();
  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (e) { rec.file.pending = false; rec.ack = "failed"; persistContacts(); if (state.chatId === groupId) renderChatThreadInner(); return; }
  try { await IDB.set("file:" + msgId, new Blob([buffer], { type: mime })); } catch (e) {}
  const payload = { kind: "file", id: msgId, ts, name, mime, size: file.size, dataB64: arrayBufferToBase64(buffer), groupId, senderName: Store.name || T("sys.someone") };
  if (meta.duration) payload.duration = meta.duration;
  if (caption) payload.caption = caption;
  if (g.disappearingTimer) payload.ttl = g.disappearingTimer;
  playOutgoingSound();
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const mc = ensureContactEntry(m.id, m.name);
    const deliveryId = crypto.randomUUID();
    groupDeliveryMap.set(deliveryId, { groupId, contentId: msgId, to: m.id });
    trimMap(groupDeliveryMap, GROUP_DELIVERY_MAP_LIMIT);
    persistGroupDeliveryMap();
    await trySendOrQueue(mc, deliveryId, payload);
  }
  rec.file.pending = false;
  persistContacts();
  if (state.chatId === groupId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
}

// Путь через почтовый ящик сервера для небольших файлов, когда
// собеседник офлайн (P2P недоступен даже после ensureLiveLink). Один
// зашифрованный payload одним сообщением — БЕЗ чанкования, в отличие
// от живой P2P-передачи (там chunks через link.sendFile). Переиспользует
// ровно тот же trySendOrQueue/почтовый ящик, что и текстовые сообщения
// — сервер не видит содержимого файла, только зашифрованный envelope,
// как и для текста.
async function sendFileOffline(contactId, file, opts) {
  opts = opts || {};
  const caption = typeof opts.caption === "string" ? opts.caption.trim().slice(0, 200) : "";
  const c = state.contacts.get(contactId); if (!c) return;
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false,
    file: { name: file.name, mime: file.type || "application/octet-stream", size: file.size, kind: fileKindFromMime(file.type), pending: true },
  };
  if (caption) rec.file.caption = caption;
  c.messages.push(rec); trimMessages(c); c.lastActivity = ts; persistContacts();
  if (state.chatId === contactId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();

  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (e) { rec.file.pending = false; rec.ack = "failed"; persistContacts(); if (state.chatId === contactId) renderChatThreadInner(); return; }
  try { await IDB.set("file:" + msgId, new Blob([buffer], { type: rec.file.mime })); } catch (e) {}

  const payload = { kind: "file", id: msgId, name: file.name, mime: rec.file.mime, size: file.size, dataB64: arrayBufferToBase64(buffer) };
  if (caption) payload.caption = caption;
  await trySendOrQueue(c, msgId, payload);
  rec.file.pending = false;
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
}
// Переиспользует ровно ту же инфраструктуру, что и обычные файлы (P2P
// только "вживую", хранение блоба в IndexedDB) — отличается только UI
// записи и типом отрисовки пузыря (проигрыватель вместо файла).
async function sendVoiceMessage(contactId, blob, durationSec) {
  const c = state.contacts.get(contactId); if (!c) return;
  const inGroup = isGroup(c);
  if (!inGroup && c.blocked) { toast(T("toast.blocked")); return; }
  // Та же симметрия, что в sendFileMessage — на всякий случай, если
  // запись почему-то дала пустой blob (получатель бы его всё равно
  // молча отбросил через isValidFileMetaSize).
  if (blob.size === 0) { toast(T("toast.fileEmpty")); return; }
  const voiceCap = inGroup ? GROUP_FILE_MAX : MAX_FILE_SIZE;
  if (blob.size > voiceCap) { toast(T("toast.fileTooLarge", { size: formatFileSize(voiceCap) })); return; }
  if (inGroup) { await sendGroupFile(contactId, blob, { name: "voice-message", duration: durationSec, mime: blob.type || "audio/webm" }); return; }
  const existingLink2 = mesh.get(contactId);
  const alreadyLive2 = existingLink2 && (existingLink2.status === "connected" || existingLink2.status === "in-call");
  if (!alreadyLive2) toast(T("toast.connecting"));
  const link = alreadyLive2 ? existingLink2 : await ensureLiveLink(contactId, 8000);
  if (!link) {
    // Размер уже гарантированно ≤ MAX_FILE_SIZE (проверка чуть выше) —
    // офлайн-путь всегда доступен, отдельная проверка не нужна.
    await sendVoiceOffline(contactId, blob, durationSec);
    return;
  }

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
// Голосовой аналог sendFileOffline — тот же принцип (один зашифрованный
// payload через почтовый ящик сервера, без чанкования), плюс duration
// в записи для правильной отрисовки плеера.
async function sendVoiceOffline(contactId, blob, durationSec) {
  const c = state.contacts.get(contactId); if (!c) return;
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

  const payload = { kind: "file", id: msgId, name: "voice-message", mime, size: blob.size, duration: durationSec, dataB64: arrayBufferToBase64(buffer) };
  await trySendOrQueue(c, msgId, payload);
  rec.file.pending = false;
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
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
let voiceRecordCancelPending = false; // чат покинули, пока висел getUserMedia
let voiceRecordTargetChatId = null; // чат, в котором НАЧАЛАСЬ запись — используется при остановке, а не state.chatId в тот момент (пользователь мог переключиться в другой чат за время записи)
// Реальный level meter поверх MediaRecorder (раздел 6 роадмапа) — раньше
// 5 столбиков .voice-recording-wave просто бесконечно крутили одну и ту же
// CSS @keyframes-анимацию (честно задокументировано как "декоративный
// эффект" в комментарии в styles.css). Теперь, если Web Audio доступен,
// AnalyserNode читает РЕАЛЬНУЮ громкость микрофона и двигает те же самые
// столбики через requestAnimationFrame; если AudioContext недоступен (или
// браузер запретил) — тихо остаёмся на старой декоративной CSS-анимации,
// см. комментарий в startVoiceLevelMeter.
let voiceAudioCtx = null, voiceAnalyser = null, voiceLevelRaf = null;
let voiceLevelHistory = [0, 0, 0, 0, 0]; // 5 последних замеров громкости — по одному на столбик, "скользящее окно" примерно последних ~450мс
function startVoiceLevelMeter(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // progressive enhancement — без Web Audio столбики просто продолжают крутить старую CSS-анимацию
    voiceAudioCtx = new AC();
    const source = voiceAudioCtx.createMediaStreamSource(stream);
    voiceAnalyser = voiceAudioCtx.createAnalyser();
    voiceAnalyser.fftSize = 256;
    // source подключается ТОЛЬКО к analyser, не к voiceAudioCtx.destination —
    // иначе пользователь услышал бы собственный голос эхом через динамики
    // прямо во время записи.
    source.connect(voiceAnalyser);
    const data = new Uint8Array(voiceAnalyser.fftSize);
    const bars = document.querySelectorAll("#voice-recording-bar .voice-recording-wave span");
    bars.forEach((b) => { b.style.animation = "none"; });
    let lastSampleAt = 0;
    const tick = (now) => {
      voiceLevelRaf = requestAnimationFrame(tick);
      if (!voiceAnalyser) return;
      if (now - lastSampleAt < 90) return; // ~11 замеров/сек — глазу достаточно, не гоняем лишний раз getByteTimeDomainData+DOM на каждый rAF (обычно 60/сек)
      lastSampleAt = now;
      voiceAnalyser.getByteTimeDomainData(data);
      let sumSq = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSq += v * v; }
      const rms = Math.sqrt(sumSq / data.length); // ~0..1, обычная речь даёт 0.05–0.2
      voiceLevelHistory.push(rms);
      voiceLevelHistory.shift();
      bars.forEach((b, i) => {
        const level = Math.min(1, voiceLevelHistory[i] * 3.5); // усиление — иначе столбики почти не двигались бы на тихой речи
        b.style.transform = `scaleY(${(0.35 + level * 1.15).toFixed(2)})`;
        b.style.opacity = (0.55 + level * 0.45).toFixed(2);
      });
    };
    voiceLevelRaf = requestAnimationFrame(tick);
  } catch (e) {
    // AnalyserNode недоступен/запрещён политикой браузера — тихо остаёмся
    // на декоративной CSS-анимации, это не критическая ошибка записи.
  }
}
function stopVoiceLevelMeter() {
  if (voiceLevelRaf) { cancelAnimationFrame(voiceLevelRaf); voiceLevelRaf = null; }
  voiceAnalyser = null;
  if (voiceAudioCtx) { try { voiceAudioCtx.close(); } catch (e) {} voiceAudioCtx = null; }
  voiceLevelHistory = [0, 0, 0, 0, 0];
  const bars = document.querySelectorAll("#voice-recording-bar .voice-recording-wave span");
  bars.forEach((b) => { b.style.animation = ""; b.style.transform = ""; b.style.opacity = ""; });
}
async function startVoiceRecording() {
  if (!state.chatId) return;
  if (voiceRecorder || voiceRecordStarting) return; // защита и от повторного вызова, и от гонки — getUserMedia асинхронный, voiceRecorder присваивается только после него
  voiceRecordStarting = true;
  voiceRecordCancelPending = false;
  voiceRecordTargetChatId = state.chatId;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast(T("toast.voiceUnsupported")); voiceRecordStarting = false; return;
  }
  try {
    // Голос для записи: шумоподавление и АРУ включены, эхоподавление не нужно (нет собеседника) — оно «дышит» и даёт артефакты
    try { voiceRecordStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: { ideal: 48000 } } }); }
    catch (e0) { voiceRecordStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  } catch (e) {
    toast(T("toast.voiceNoMic")); voiceRecordStarting = false; return;
  }
  if (voiceRecordCancelPending) {
    voiceRecordCancelPending = false; voiceRecordStarting = false;
    voiceRecordStream.getTracks().forEach((t) => t.stop()); voiceRecordStream = null;
    return;
  }
  const mimeType = pickVoiceMimeType();
  try {
    const recOpts = { audioBitsPerSecond: 96000 };
    if (mimeType) recOpts.mimeType = mimeType;
    try { voiceRecorder = new MediaRecorder(voiceRecordStream, recOpts); }
    catch (e1) { voiceRecorder = mimeType ? new MediaRecorder(voiceRecordStream, { mimeType }) : new MediaRecorder(voiceRecordStream); }
  } catch (e) {
    toast(T("toast.voiceUnsupported"));
    voiceRecordStream.getTracks().forEach((t) => t.stop()); voiceRecordStream = null;
    voiceRecordStarting = false;
    return;
  }
  // Даём микрофону/АРУ «прогреться» ~150 мс: сразу после getUserMedia первые кадры содержат щелчок и нестабильный уровень — это и были «артефакты в начале записи»
  await new Promise((r) => setTimeout(r, 150));
  if (voiceRecordCancelPending) {
    voiceRecordCancelPending = false; voiceRecordStarting = false;
    try { voiceRecordStream.getTracks().forEach((t) => t.stop()); } catch (e) {} voiceRecordStream = null; voiceRecorder = null;
    return;
  }
  voiceRecordStarting = false;
  voiceRecordChunks = [];
  voiceRecorder.addEventListener("dataavailable", (ev) => { if (ev.data && ev.data.size > 0) voiceRecordChunks.push(ev.data); });
  // start(200): запрашиваем чанк каждые 200мс вместо одного финального
  // при stop(). На iOS одиночный stop() в конце длинной записи может
  // занимать 1-2 секунды, пока весь кодек-буфер дойдёт до JS. С
  // периодическими чанками stop() завершается практически мгновенно.
  voiceRecorder.start(200);
  voiceRecordStartedAt = Date.now();
  const form = $("#chat-form"); if (form) form.classList.add("hidden");
  const bar = $("#voice-recording-bar"); if (bar) bar.classList.remove("hidden");
  const timeEl = $("#voice-recording-time");
  voiceRecordTimerId = setInterval(() => {
    if (timeEl) timeEl.textContent = formatVoiceDuration((Date.now() - voiceRecordStartedAt) / 1000);
  }, 200);
  // AudioContext для индикатора уровня создаём не в момент старта записи — иначе на iOS смена частоты аудиосессии даёт щелчок в записи
  setTimeout(() => { if (voiceRecorder && voiceRecordStream) startVoiceLevelMeter(voiceRecordStream); }, 600);
}
// Запись привязана к конкретному чату (voiceRecordTargetChatId) — если
// пользователь уходит из этого чата, не дожидаясь окончания записи,
// честнее отменить её совсем, чем оставлять полоску записи висеть
// поверх экрана другого чата, создавая путаницу насчёт того, куда
// голосовое реально уйдёт.
function cancelVoiceRecordingIfLeavingChat(newChatId) {
  if (voiceRecordTargetChatId && newChatId !== voiceRecordTargetChatId) {
    if (voiceRecorder) stopVoiceRecording(false);
    else if (voiceRecordStarting) voiceRecordCancelPending = true;
  }
}
function stopVoiceRecording(send) {
  if (voiceRecordStarting) { voiceRecordCancelPending = true; return; } // отпустили в момент прогрева микрофона — запись ещё не началась
  const contactId = voiceRecordTargetChatId;
  const durationSec = (Date.now() - voiceRecordStartedAt) / 1000;
  if (voiceRecordTimerId) { clearInterval(voiceRecordTimerId); voiceRecordTimerId = null; }
  stopVoiceLevelMeter();
  const form = $("#chat-form"); if (form) form.classList.remove("hidden");
  const bar = $("#voice-recording-bar"); if (bar) bar.classList.add("hidden");
  if (!voiceRecorder) return;
  const recorder = voiceRecorder;
  const mimeType = recorder.mimeType || "audio/webm";
  // Снимки локально, ДО того, как снимем voiceRecorder — recorder.stop()
  // асинхронный ("stop" может сработать через 50-300мс), и если
  // пользователь успеет нажать "Записать" снова до этого момента,
  // startVoiceRecording() (её guard смотрит только на voiceRecorder,
  // который мы уже обнулили) перезапишет voiceRecordStream и
  // voiceRecordChunks живыми данными НОВОЙ записи. Без снимков этот
  // обработчик "stop" остановил бы поток новой записи и отправил бы
  // чанки новой записи под длительностью старой.
  const streamSnapshot = voiceRecordStream;
  const chunksSnapshot = voiceRecordChunks;
  voiceRecorder = null;
  voiceRecordStream = null;
  voiceRecordChunks = [];
  recorder.addEventListener("stop", () => {
    if (streamSnapshot) streamSnapshot.getTracks().forEach((t) => t.stop());
    if (!send || durationSec < 0.6) return; // случайное короткое нажатие — не отправляем пустышку
    const blob = new Blob(chunksSnapshot, { type: mimeType });
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
    // (легитимный максимум — 2 МБ / 48 КБ ≈ 43 куска; 500 — с большим
    // запасом), чтобы не аллоцировать под него огромный массив заранее.
    const totalChunks = payload.totalChunks;
    if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 500) return;
    // payload.size раньше сохранялся как есть, без проверки вообще —
    // отправляющая сторона (sendFileMessage) никогда не пропустит
    // файл больше MAX_FILE_SIZE, но НЕДОБРОСОВЕСТНЫЙ пир мог заявить
    // любой размер и следом прислать totalChunks (до 500) реальных
    // мегабайтных кусков — несоответствие size не проверялось вовсе,
    // только количество кусков. До ~500МБ на одну передачу,
    // MAX_INCOMING_FILE_TRANSFERS=20 одновременных — до ~10ГБ.
    if (!EtherFileLimits.isValidFileMetaSize(payload.size)) return;
    sweepIncomingFileBuffers();
    // Повторный file-meta (ретрай через сервер, fallback после P2P) —
    // не пересоздаём буфер и не дублируем сообщение.
    if (incomingFileBuffers.has(payload.id)) return;
    if (incomingFileBuffers.size >= MAX_INCOMING_FILE_TRANSFERS) return;
    {
      const existing = state.contacts.get(from);
      const prev = existing && existing.messages.find((m) => m.id === payload.id);
      if (prev) {
        // Приём брошенной (буфер вычищен по TTL) передачи, которую пир повторил:
        // заводим буфер заново, но сообщение не дублируем.
        if (prev.file && prev.file.pending) {
          incomingFileBuffers.set(payload.id, { name: payload.name, mime: payload.mime, size: payload.size, totalChunks, chunks: new Array(totalChunks).fill(null), from, receivedAt: Date.now() });
        }
        return;
      }
    }
    incomingFileBuffers.set(payload.id, { name: payload.name, mime: payload.mime, size: payload.size, totalChunks, chunks: new Array(totalChunks).fill(null), from, receivedAt: Date.now() });
    const c = ensureContactEntry(from, null);
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: "", ts: Date.now(), readAckSent: false,
      file: { name: payload.name, mime: payload.mime, size: payload.size, kind: fileKindFromMime(payload.mime), duration: payload.duration || 0, pending: true } };
    if (payload.ttl) rec.ttl = payload.ttl;
    if (payload.forwarded) { rec.forwarded = true; if (typeof payload.fwdFrom === "string" && payload.fwdFrom) rec.forwardedFrom = payload.fwdFrom.slice(0, 40); }
    if (typeof payload.caption === "string" && payload.caption) rec.file.caption = payload.caption.slice(0, 200);
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now(); persistContacts();
    if (isOpen) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    return;
  }
  if (payload.kind === "file-chunk") {
    const buf = incomingFileBuffers.get(payload.id);
    if (!buf || payload.index == null || payload.index < 0 || payload.index >= buf.totalChunks) return;
    // Заявленный payload.size (проверен выше, при file-meta) — это
    // размер ИСХОДНОГО файла, а не то, сколько реально байт может
    // прийти в чанках: totalChunks сам по себе допускает до 500
    // кусков, и НИЧТО раньше не мешало прислать кусков суммарно
    // намного больше заявленного size (пир мог соврать в file-meta
    // про маленький размер, а потом закачать чанками мегабайты).
    // Считаем накопленный объём base64 и обрываем приём, если он
    // заметно превышает то, что даёт исходный size после base64
    // (~4/3) с разумным запасом.
    const chunkLen = typeof payload.data === "string" ? payload.data.length : 0;
    const alreadyReceived = buf.receivedBytes || 0;
    if (EtherFileLimits.chunkExceedsBudget(alreadyReceived, chunkLen, buf.size)) { incomingFileBuffers.delete(payload.id); return; }
    buf.receivedBytes = alreadyReceived + chunkLen;
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
    if (isOpen) { renderChatThread(); playMessageSound(from); vibrate([80, 40, 80]); }
    else {
      const label = T("chat.file.preview." + rec.file.kind);
      toast(`${c.name}: ${label}`);
      if (!isContactMuted(c)) showNotification(c.name || T("app.name"), label, { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
      playMessageSound(from);
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
function mediaTagHtml(kind, url) {
  return kind === "video"
    ? `<video src="${escapeHtml(url)}#t=0.1" controls playsinline preload="metadata"></video>`
    : `<img src="${escapeHtml(url)}" alt="" decoding="async" />`;
}
// Запоминаем реальные пропорции медиа — при следующих отрисовках слот сразу нужного размера
function rememberMediaSize(msgId, w, h) {
  if (!w || !h) return;
  for (const c of state.contacts.values()) {
    const m = c.messages.find((x) => x.id === msgId);
    if (m && m.file && !m.file.w) { m.file.w = w; m.file.h = h; return; }
  }
}
function fileBubbleHtml(msgId, fileInfo) {
  if (fileInfo.pending) {
    // Если известен точный прогресс (живая P2P-передача даёт его через
    // onProgress в sendFile) — показываем честный процент. Если нет
    // (офлайн-путь через почтовый ящик сервера, где файл уходит одним
    // payload без чанкования) — бегущая полоска без цифр, чтобы не
    // врать нулём или вечными 0%.
    const bar = typeof fileInfo.progress === "number"
      ? `<div class="file-progress"><div class="file-progress-fill" style="width:${(fileInfo.progress * 100).toFixed(1)}%"></div></div>`
      : `<div class="file-progress-indeterminate"></div>`;
    return `<div class="file-bubble file-bubble-pending" data-msg-id="${escapeHtml(msgId)}"><div class="file-spinner"></div><span>${escapeHtml(T("chat.file.sending"))}</span>${bar}</div>`;
  }
  if (fileInfo.failed) {
    return `<div class="file-bubble file-bubble-failed"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2 1 21h22L12 2zm0 6 6.5 11h-13L12 8zm-1 2.5v4h2v-4h-2zm0 5.5v2h2v-2h-2z"/></svg> <span>${escapeHtml(T("chat.file.failed"))}</span></div>`;
  }
  const sizeStr = formatFileSize(fileInfo.size);
  // Подпись (P1.12) — под медиа-слотом, отдельной строкой. Применима к
  // фото/видео (где и есть кнопка "Превью с подписью" при отправке);
  // для голосовых/документов caption в UI пока не предлагается, но
  // если пришла (например, от будущей версии клиента) — тоже покажем.
  const captionHtml = fileInfo.caption ? `<div class="file-caption">${escapeHtml(fileInfo.caption)}</div>` : "";
  if (fileInfo.kind === "image" || fileInfo.kind === "video") {
    // Место под медиа резервируется сразу (известные пропорции или 4:3 / 16:9 по умолчанию), а уже загруженный blob-URL
    // подставляется синхронно — иначе список «прыгал» при каждой перерисовке и подгрузке картинок/видео.
    const ar = (fileInfo.w && fileInfo.h) ? (fileInfo.w + " / " + fileInfo.h) : (fileInfo.kind === "video" ? "16 / 9" : "4 / 3");
    const cached = fileBlobUrlCache.get(msgId);
    const inner = cached ? mediaTagHtml(fileInfo.kind, cached) : `<div class="file-media-loading">${escapeHtml(T("chat.file.loading"))}</div>`;
    return `<div class="file-media-wrap"><div class="file-media-slot" style="aspect-ratio:${ar}" data-file-id="${escapeHtml(msgId)}" data-file-kind="${fileInfo.kind}">${inner}</div>${captionHtml}</div>`;
  }
  if (fileInfo.kind === "audio") {
    const durLabel = fileInfo.duration ? formatVoiceDuration(fileInfo.duration) : "";
    // .voice-live-wave — раздел 7 роадмапа, "real waveform ПРИ ПРОСЛУШИВАНИИ
    // у всех участников" (не путать с V.45.0.0 — там же про запись). 5
    // столбиков, без анимации в разметке — высота/прозрачность управляются
    // инлайн-стилями из JS (см. startVoicePlaybackWaveLoop), ровно как у
    // уже существующей волны записи (#voice-recording-bar), просто
    // применительно к AnalyserNode на MediaElementSource воспроизводимого
    // <audio>, а не на живом микрофонном MediaStream.
    return `<div class="voice-bubble" data-file-id="${escapeHtml(msgId)}" data-file-kind="audio" data-duration="${fileInfo.duration || 0}">
      <button type="button" class="voice-play-btn" disabled><span class="vp-ico">${VOICE_PLAY_ICON_SVG}</span></button>
      <span class="voice-live-wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span>
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
  // floor, не round: 59.6с реально длится 59.6с — round дал бы "1:00",
  // хотя запись ещё не дотянула до минуты. Для таймера записи и длины
  // готового голосового это обманывает пользователя в большую сторону.
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}
// Единая иконография — play/pause голосового сообщения раньше были
// текстовыми символами ▶/⏸ (textContent), теперь те же SVG, что и
// везде в приложении (viewBox 24×24, currentColor).
const VOICE_PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
// Значок play/pause живёт в своём <span class="vp-ico"> — рисунок кассеты/пластинки (features.js) лежит рядом в той же кнопке и не затирается
function setVoiceIcon(btn, svg) {
  if (!btn) return;
  let ico = btn.querySelector(".vp-ico");
  if (!ico) { ico = document.createElement("span"); ico.className = "vp-ico"; btn.appendChild(ico); }
  ico.innerHTML = svg;
}
const VOICE_PAUSE_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const voiceAudioCache = new Map(); // msgId -> { audio, playing, analyser? } — переиспользуем между рендерами
// Раньше при уходе из чата (в список чатов или в другой чат) голосовое,
// если оно играло, продолжало звучать в фоне — кнопки для остановки
// уже не было, а сам Audio() из кеша никто не ставил на паузу.
function pauseAllVoicePlayback() {
  for (const entry of voiceAudioCache.values()) {
    if (entry.playing) { entry.audio.pause(); entry.playing = false; }
  }
  document.querySelectorAll(".voice-play-btn").forEach((b) => { setVoiceIcon(b, VOICE_PLAY_ICON_SVG); });
  stopVoicePlaybackWaveLoop();
}
// === Раздел 7 роадмапа — real waveform ПРИ ПРОСЛУШИВАНИИ голосовых (а не
// только при их записи, см. V.45.0.0 startVoiceLevelMeter/AnalyserNode на
// микрофонном MediaStream — здесь тот же приём, но источник — уже
// ЗАПИСАННЫЙ и воспроизводимый <audio>, то есть работает у ЛЮБОГО
// участника переписки, который слушает голосовое, не только у того, кто
// его записывал). ===
// Один общий AudioContext на все голосовые — отдельный контекст на каждое
// сообщение был бы расточительным (и часть браузеров ограничивает их
// количество на странице).
let __voicePlaybackCtx = null;
function getVoicePlaybackAudioCtx() {
  if (__voicePlaybackCtx) return __voicePlaybackCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    __voicePlaybackCtx = new AC();
  } catch (e) { return null; }
  return __voicePlaybackCtx;
}
let __voiceWaveRaf = null;
let __voiceWaveLastSampleAt = 0;
let __voiceWaveHistory = [0, 0, 0, 0, 0];
function resetVoiceWaveBars() {
  document.querySelectorAll(".voice-live-wave span").forEach((b) => { b.style.transform = ""; b.style.opacity = ""; });
}
// Один rAF-цикл на всё приложение (а не по циклу на голосовое) — голосовые
// и так проигрываются по одному за раз (см. "не играть несколько хором"
// в hydrateFileSlots), так что достаточно на каждый тик найти ТО единственное
// играющее сообщение и обновить именно его столбики. DOM-узлы бара ищутся
// заново на каждый тик (не кешируются) — после ре-рендера чата старые
// ссылки на .voice-live-wave были бы мёртвыми, а голосовое могло продолжать
// играть через уже пересозданную разметку.
function startVoicePlaybackWaveLoop() {
  if (__voiceWaveRaf) return;
  const tick = (now) => {
    __voiceWaveRaf = requestAnimationFrame(tick);
    let playingMsgId = null, playingEntry = null;
    for (const [id, entry] of voiceAudioCache) {
      if (entry.playing) { playingMsgId = id; playingEntry = entry; break; }
    }
    if (!playingEntry || !playingEntry.analyser) { resetVoiceWaveBars(); return; }
    if (now - __voiceWaveLastSampleAt < 90) return; // ~11 замеров/сек, как и у волны записи — getByteTimeDomainData+DOM не нужно гонять на каждый из 60 кадров/сек
    __voiceWaveLastSampleAt = now;
    if (!playingEntry.waveformData) playingEntry.waveformData = new Uint8Array(playingEntry.analyser.fftSize);
    playingEntry.analyser.getByteTimeDomainData(playingEntry.waveformData);
    let sumSq = 0;
    for (let i = 0; i < playingEntry.waveformData.length; i++) { const v = (playingEntry.waveformData[i] - 128) / 128; sumSq += v * v; }
    const rms = Math.sqrt(sumSq / playingEntry.waveformData.length);
    __voiceWaveHistory.push(rms);
    __voiceWaveHistory.shift();
    const bars = document.querySelectorAll(`.voice-bubble[data-file-id="${CSS.escape(playingMsgId)}"] .voice-live-wave span`);
    bars.forEach((b, i) => {
      const level = Math.min(1, __voiceWaveHistory[i] * 3.5);
      b.style.transform = `scaleY(${(0.4 + level * 1.1).toFixed(2)})`;
      b.style.opacity = (0.4 + level * 0.6).toFixed(2);
    });
  };
  __voiceWaveRaf = requestAnimationFrame(tick);
}
function stopVoicePlaybackWaveLoop() {
  if (__voiceWaveRaf) { cancelAnimationFrame(__voiceWaveRaf); __voiceWaveRaf = null; }
  __voiceWaveHistory = [0, 0, 0, 0, 0];
  resetVoiceWaveBars();
}
// Останавливает цикл ТОЛЬКО если вообще никто больше не играет — вызывается
// после паузы/окончания одного голосового, когда в принципе мог начать
// играть другое (хотя в этом приложении одновременно играет не больше
// одного — проверка на всякий случай, дешевле, чем предполагать).
function stopVoicePlaybackWaveLoopIfIdle() {
  for (const entry of voiceAudioCache.values()) if (entry.playing) return;
  stopVoicePlaybackWaveLoop();
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
      if (kind === "image" || kind === "video") {
        if (!el.querySelector("img, video")) el.innerHTML = mediaTagHtml(kind, url);
        const mediaEl = el.querySelector("img, video");
        if (mediaEl) {
          const onSize = () => rememberMediaSize(msgId, mediaEl.naturalWidth || mediaEl.videoWidth, mediaEl.naturalHeight || mediaEl.videoHeight);
          mediaEl.addEventListener(kind === "video" ? "loadedmetadata" : "load", onSize, { once: true });
          if (kind === "image" && mediaEl.complete) onSize();
        }
      }
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
        // Воспроизведение — обычный <audio> напрямую, без Web Audio: раньше звук шёл через MediaElementSource в
        // AudioContext, который стартует «suspended», и первое нажатие молчало (приходилось жать второй раз).
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
      setVoiceIcon(playBtn, entry.playing ? VOICE_PAUSE_ICON_SVG : VOICE_PLAY_ICON_SVG);
      el.classList.toggle("fx-playing", !!entry.playing);
      el.classList.toggle("is-playing", !!entry.playing);
      const durOf = () => (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : knownDuration;
      const setUi = (playing) => {
        entry.playing = playing;
        setVoiceIcon(playBtn, playing ? VOICE_PAUSE_ICON_SVG : VOICE_PLAY_ICON_SVG);
        el.classList.toggle("fx-playing", playing); el.classList.toggle("is-playing", playing);
      };
      // ontimeupdate/onended/onplay/onpause — присвоение свойств: ЗАМЕНЯЕТ обработчики прошлого рендера, а не копит дубли.
      audio.ontimeupdate = () => {
        const dur = durOf();
        if (fill && dur) fill.style.width = Math.min(100, (audio.currentTime / dur) * 100) + "%";
        if (durEl && dur) durEl.textContent = formatVoiceDuration(Math.max(0, dur - audio.currentTime));
      };
      audio.onplay = () => setUi(true);
      audio.onpause = () => setUi(false);
      audio.onended = () => {
        setUi(false);
        try { audio.currentTime = 0; } catch (e) {} // следующее прослушивание — всегда с начала
        if (fill) fill.style.width = "0%";
        if (durEl) durEl.textContent = formatVoiceDuration(knownDuration || durOf() || 0);
      };
      playBtn.onclick = (ev) => {
        if (ev) { ev.stopPropagation(); }
        // Не играть несколько голосовых хором — только через собственный кеш (эти Audio() не лежат в DOM).
        for (const [otherId, other] of voiceAudioCache) {
          if (otherId !== msgId && other.playing) { try { other.audio.pause(); } catch (e) {} }
        }
        if (!audio.paused) { audio.pause(); return; }
        // Закончившееся (или записанное MediaRecorder'ом без длительности в заголовке) голосовое играем с начала
        if (audio.ended || (isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.05)) { try { audio.currentTime = 0; } catch (e) {} }
        audio.play().catch(() => { setUi(false); });
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
  const writeBlocked = inGroup && !isGroupWriteAllowed(c, Store.myId);
  if (sendBtn) sendBtn.classList.toggle("hidden", !hasText || writeBlocked);
  // Голосовые сообщения не поддерживаются в группах — кнопка микрофона
  // не должна становиться видимой даже при пустом поле ввода. Также
  // скрыта, если писать в группу запрещено ("только админы").
  if (micBtn) micBtn.classList.toggle("hidden", hasText || writeBlocked);
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

// Роли в группе: создатель группы (g.createdBy) всегда админ, даже если
// запись об этом потерялась при синхронизации — остальные становятся
// админами только явно (m.role === "admin"), назначаются другим админом.
function isGroupAdmin(g, userId) {
  if (!g || !userId) return false;
  if (g.createdBy === userId) return true;
  const m = g.members.find((x) => x.id === userId);
  return !!(m && m.role === "admin");
}
function setGroupMemberRole(groupId, memberId, role) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  const m = g.members.find((x) => x.id === memberId); if (!m) return;
  m.role = role;
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T(role === "admin" ? "group.systemPromoted" : "group.systemDemoted", { name: m.name }), textKey: role === "admin" ? "group.systemPromoted" : "group.systemDemoted", textParams: { name: m.name }, ts: Date.now() });
  trimMessages(g);
  persistContacts();
  broadcastGroupRoster(g);
  if (state.chatId === groupId) renderChatThread();
}

// @упоминания в группах: ищем "@" + имя как отдельное слово, без учёта
// регистра. Простая, но достаточная эвристика — полноценный токенайзер
// избыточен для мессенджера на 10 участников.
function isMentioned(text, name) {
  if (!text || !name) return false;
  const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  const re = new RegExp("@" + escaped + "(?![\\wа-яА-ЯёЁ])", "iu");
  return re.test(text);
}

function createGroup(name, memberIds, avatar) {
  if (memberIds.length + 1 > MAX_GROUP_MEMBERS) { toast(T("toast.groupTooBig", { max: MAX_GROUP_MEMBERS })); return null; }
  if (memberIds.length === 0) { toast(T("toast.groupNeedsMembers")); return null; }
  const groupId = crypto.randomUUID();
  const members = memberIds.map((id) => {
    const c = state.contacts.get(id);
    return { id, name: (c && c.name) || T("sys.someone") };
  });
  members.push({ id: Store.myId, name: Store.name || T("sys.someone"), role: "admin" });
  const g = {
    id: groupId, isGroup: true, name: (name || "").trim() || T("group.defaultName"),
    members, messages: [], lastActivity: Date.now(), archived: false, muted: false,
    createdBy: Store.myId, managed: true,
  };
  if (avatar) g.avatar = avatar; // dataURL, уменьшенный до компактного размера на клиенте перед сохранением
  state.contacts.set(groupId, g);
  persistContacts();
  g.messages.push({
    id: crypto.randomUUID(), from: "system",
    text: T("group.systemCreated", { name: g.name }),
    textKey: "group.systemCreated",
    textParams: { name: g.name },
    ts: Date.now()
  });
  trimMessages(g);
  persistContacts();
  broadcastGroupRoster(g);
  for (const m of members) {
    if (m.id === Store.myId) continue;
    attemptConnect(m.id);
    attemptConnectViaRelay(m.id).catch(() => {});
  }
  etherLog("info", "[group] createGroup:", "id=" + groupId.slice(0, 8) + "…", "name=" + JSON.stringify(g.name), "members=" + members.length);
  return groupId;
}
// Рассылает текущий состав/название группы всем участникам — при
// создании, добавлении/удалении участника или переименовании.
function broadcastGroupRoster(g) {
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    sendGroupRosterTo(g, m.id);
  }
}
// Единственная точка отправки ростера ОДНОМУ конкретному участнику —
// переиспользуется и явной рассылкой всем (выше), и авто-восстановлением
// при переподключении (ниже). Раньше группа синхронизировалась только
// при явном действии (добавили/убрали участника) — если у ОРГАНИЗАТОРА
// (или любого участника) локальные данные исчезли (переустановка
// приложения — своего сервер-бэкапа контактов/групп у приложения нет),
// НИЧЕГО не пересылало ему ростер заново, пока кто-то не совершит новое
// действие в группе. Группа просто не появлялась у него снова.
function sendGroupRosterTo(g, memberId) {
  const payload = { kind: "group-invite", id: crypto.randomUUID(), groupId: g.id, groupName: g.name, members: g.members, groupAvatar: g.avatar || undefined, groupDescription: g.description || undefined };
  etherLog("info", "[group] roster →", String(memberId).slice(0, 8) + "…", "groupId=" + String(g.id).slice(0, 8) + "…", "payload.id=" + String(payload.id).slice(0, 8) + "…");
  const mc = ensureContactEntry(memberId, (g.members.find((m) => m.id === memberId) || {}).name);
  trySendOrQueue(mc, crypto.randomUUID(), payload).catch(() => {});
}
async function sendGroupMessage(groupId, text, replyTo) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupWriteAllowed(g, Store.myId)) { toast(T("toast.groupWriteRestricted")); return; }
  text = applyEmojiAutoReplace(text);
  // Симметрично sendChatMessage — иначе длинное сообщение, отправленное
  // программно (retry, вставка через JS), а не через <input maxlength>
  // обычным набором текста, уходит без обрезки.
  if (text.length > MAX_MESSAGE_LENGTH) { text = text.slice(0, MAX_MESSAGE_LENGTH); toast(T("toast.messageCut")); }
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId, from: "me", text, ts, ack: "sent" };
  if (replyTo) rec.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  if (g.disappearingTimer) rec.ttl = g.disappearingTimer;
  g.messages.push(rec); trimMessages(g); g.lastActivity = ts; persistContacts();
  if (state.chatId === groupId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();
  playOutgoingSound();
  haptic("light"); // симметрично sendChatMessage — раньше в группах не вибрировало при отправке
  const payload = { kind: "chat", id: msgId, text, ts, groupId, senderName: Store.name || T("sys.someone") };
  if (replyTo) payload.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  if (g.disappearingTimer) payload.ttl = g.disappearingTimer;
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const mc = ensureContactEntry(m.id, m.name);
    // Отдельный id доставки на каждого получателя — outbox в проекте
    // ключуется только по msgId, без адресата; один и тот же msgId на
    // нескольких получателей потерял бы все копии кроме первой.
    const deliveryId = crypto.randomUUID();
    // Фиксируем deliveryId -> {groupId, contentId} ДО отправки — ack от
    // этого получателя (в т.ч. "доставлено"/"прочитано" через много
    // часов, когда outbox-запись давно удалена по deliver-ack с
    // сервера) должен находить именно это сообщение в группе. См.
    // groupDeliveryMap / resolveGroupDelivery.
    groupDeliveryMap.set(deliveryId, { groupId, contentId: msgId, to: m.id });
    trimMap(groupDeliveryMap, GROUP_DELIVERY_MAP_LIMIT);
    persistGroupDeliveryMap();
    await trySendOrQueue(mc, deliveryId, payload);
  }
}
function addGroupMember(groupId, memberId) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  if (g.members.some((m) => m.id === memberId)) return;
  if (g.members.length >= MAX_GROUP_MEMBERS) { toast(T("toast.groupTooBig", { max: MAX_GROUP_MEMBERS })); return; }
  const c = state.contacts.get(memberId);
  g.members.push({ id: memberId, name: (c && c.name) || T("sys.someone") });
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemAdded", { name: (c && c.name) || T("sys.someone") }), textKey: "group.systemAdded", textParams: { name: (c && c.name) || T("sys.someone") }, ts: Date.now() });
  trimMessages(g);
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
  if (!leftBySelf && !isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
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
    state.mentionedChats.delete(groupId); // иначе бейдж @упоминания переживает удаление группы до перезагрузки
    persistContacts();
    if (state.chatId === groupId) { state.chatId = null; __lastRenderedChatId = null; state.multiSelect = null; renderTab(); }
    else if (state.tab === "chats") renderChatsList();
    return;
  }
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: leftBySelf ? T("group.systemLeft", { name: removedName }) : T("group.systemRemoved", { name: removedName }), textKey: leftBySelf ? "group.systemLeft" : "group.systemRemoved", textParams: { name: removedName }, ts: Date.now() });
  trimMessages(g);
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
function setGroupAvatar(groupId, dataUrl) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  g.avatar = dataUrl || null;
  persistContacts();
  if (state.chatId === groupId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
  if (state.contactCardId === groupId) renderContactCard();
}
// killer-features-backlog 0.7 — локальный аватар 1:1 контакта. ПРИНЦИПИАЛЬНО
// локальный: в отличие от группового аватара (который рассылается всем
// участникам через group-invite/roster), этот dataURL никогда не уходит по
// сети — ни пиру, ни на сигнальный сервер. Это просто то, как контакт
// выглядит у МЕНЯ, независимо от того, что показывает он сам.
function setContactAvatar(contactId, dataUrl) {
  const c = state.contacts.get(contactId); if (!c || c.isGroup) return;
  c.avatar = dataUrl || null;
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
  if (state.contactCardId === contactId) renderContactCard();
}
// Сжимаем выбранное фото до маленького квадратного аватара (как иконки
// контактов) — иначе dataURL из телефона в несколько МБ разбухал бы
// persistContacts() (localStorage) на каждую группу.
function readImageAsAvatarDataUrl(file, size = 160) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => { img.onerror = () => reject(new Error("img")); img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    }; img.src = reader.result; };
    reader.readAsDataURL(file);
  });
}
function renameGroup(groupId, name) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  name = (name || "").trim(); if (!name || name === g.name) return;
  g.name = name;
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemRenamed", { name }), textKey: "group.systemRenamed", textParams: { name }, ts: Date.now() });
  trimMessages(g);
  g.lastActivity = Date.now();
  persistContacts();
  broadcastGroupRoster(g);
  if (state.chatId === groupId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
function setGroupDescription(groupId, description) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  description = (description || "").trim().slice(0, 200);
  if (description === (g.description || "")) return;
  g.description = description || undefined;
  g.lastActivity = Date.now();
  persistContacts();
  broadcastGroupRoster(g);
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

// =====================================================================
// Invite-ссылка в группу (раздел 8/18 роадмапа)
// =====================================================================
// Новый участник изначально не контакт НИКОМУ в группе — "ether://add?"
// тут не поможет (он добавляет только того, кто выдал код, себе в
// контакты, но не добавляет получателя кода В ГРУППУ). Поэтому код
// приглашения кодирует ещё и того, кто его выдал (referrer, уже
// состоящий в группе) и сам groupId — трёхсторонний обмен:
//   1. Я (приглашённый) parse-ю код → добавляю referrer-а в контакты
//      (если его ещё нет) и пытаюсь к нему подключиться.
//   2. Как только есть связь (или через очередь/relay, см.
//      trySendOrQueue) — шлю referrer-у payload "group-join-request".
//   3. Если referrer — админ группы, обычный addGroupMember() добавляет
//      меня: это само рассылает новый ростер всем участникам и пытается
//      подключиться ко мне, без дополнительного кода.
// Генерировать ссылку может только админ (кнопка скрыта у остальных в
// openGroupInfo) — иначе join-request пришёл бы участнику без прав его
// обработать, и приглашённый молча не узнал бы, что приглашение зависло.
function buildGroupInviteCode(groupId) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return null;
  const qs = new URLSearchParams();
  qs.set("gid", groupId);
  qs.set("ref", Store.myId);
  qs.set("rn", Store.name || "");
  qs.set("gn", g.name || "");
  return "ether://group?" + qs.toString();
}
function parseGroupInviteCode(text) {
  try {
    if (!text || text.indexOf("ether://group?") !== 0) return null;
    const qs = new URLSearchParams(text.slice(text.indexOf("?")));
    const groupId = qs.get("gid"), refId = qs.get("ref");
    if (!groupId || !refId) return null;
    return { groupId, refId, refName: qs.get("rn") || "", groupName: qs.get("gn") || "" };
  } catch (e) { return null; }
}
async function joinGroupViaInvite(text) {
  const parsed = parseGroupInviteCode(text);
  if (!parsed) { toast(T("toast.badInviteCode")); return; }
  const { groupId, refId, refName, groupName } = parsed;
  if (refId === Store.myId) { toast(T("toast.ownId")); return; }
  const existing = state.contacts.get(groupId);
  if (existing && existing.isGroup) { toast(T("toast.groupAlreadyJoined")); return; }
  if (recentlyDeletedIds.delete(refId)) persistRecentlyDeleted(); // осознанное повторное добавление снимает блокировку из deleteContact
  ensureContactEntry(refId, refName || null);
  persistContacts();
  if (onlineSet.has(refId)) scheduleAutoConnect(refId);
  else attemptConnectViaRelay(refId).catch(() => {});
  const refC = state.contacts.get(refId);
  await trySendOrQueue(refC, crypto.randomUUID(), { kind: "group-join-request", groupId, groupName, requesterName: Store.name || "" });
  toast(T("toast.groupJoinRequested", { name: groupName || T("group.defaultName") }));
}
function openGroupInviteSheet(groupId) {
  const code = buildGroupInviteCode(groupId); if (!code) return;
  const out = $("#group-invite-code-out"); if (out) out.textContent = code;
  renderQrToCanvas($("#group-invite-qr-canvas"), code);
  const sheet = $("#group-invite-sheet"); if (sheet) sheet.classList.remove("hidden");
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
// Пересылка в группу: каждому участнику уходит своя копия (как у обычных групповых сообщений), с пометкой «Переслано»
async function forwardIntoGroup(g, rec, m, srcMsgId) {
  const payload = { id: rec.id, ts: rec.ts, groupId: g.id, senderName: Store.name || T("sys.someone"), forwarded: true };
  if (rec.forwardedFrom) payload.fwdFrom = rec.forwardedFrom;
  if (g.disappearingTimer) { payload.ttl = g.disappearingTimer; rec.ttl = g.disappearingTimer; }
  const fail = (msgKey) => {
    if (rec.file) { rec.file.pending = false; rec.file.failed = true; }
    rec.ack = "failed"; persistContacts();
    if (state.chatId === g.id) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    toast(msgKey);
  };
  if (m.file) {
    let blob = null;
    try { blob = await IDB.get("file:" + srcMsgId); } catch (e) {}
    if (!blob) return fail(T("chat.file.unavailable"));
    if (blob.size > GROUP_FILE_MAX) return fail(T("toast.fileTooLarge", { size: formatFileSize(GROUP_FILE_MAX) }));
    try { await IDB.set("file:" + rec.id, blob); } catch (e) {}
    let b64;
    try { b64 = arrayBufferToBase64(await blob.arrayBuffer()); } catch (e) { return fail(T("chat.file.unavailable")); }
    Object.assign(payload, { kind: "file", name: m.file.name, mime: m.file.mime, size: m.file.size, dataB64: b64 });
    if (m.file.duration != null) payload.duration = m.file.duration;
    if (m.file.caption) payload.caption = m.file.caption;
  } else {
    Object.assign(payload, { kind: "chat", text: rec.text || "" });
  }
  for (const mem of g.members) {
    if (mem.id === Store.myId) continue;
    const mc = ensureContactEntry(mem.id, mem.name);
    const deliveryId = crypto.randomUUID();
    groupDeliveryMap.set(deliveryId, { groupId: g.id, contentId: rec.id, to: mem.id });
    trimMap(groupDeliveryMap, GROUP_DELIVERY_MAP_LIMIT);
    persistGroupDeliveryMap();
    await trySendOrQueue(mc, deliveryId, payload);
  }
  if (rec.file) rec.file.pending = false;
  persistContacts();
  if (state.chatId === g.id) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
async function forwardMessage(msgId, fromContactId, toContactId) {
  const from = state.contacts.get(fromContactId), to = state.contacts.get(toContactId);
  if (!from || !to) return;
  const m = from.messages.find((x) => x.id === msgId); if (!m) return;
  if (to.isGroup && !isGroupWriteAllowed(to, Store.myId)) { toast(T("toast.groupWriteRestricted")); return; }
  const msgId2 = crypto.randomUUID();
  const ts = Date.now();
  // Автор оригинала: «Переслано от …» (если сообщение уже пересылали — остаётся первый автор)
  const origName = String(m.forwardedFrom || (m.from === "me" ? (Store.name || "") : (m.fromName || from.name || ""))).slice(0, 40);
  const rec = {
    id: msgId2, from: "me", text: m.text || "", ts,
    ack: "sent", forwarded: true, serverAcked: false,
  };
  if (origName) rec.forwardedFrom = origName;
  if (to.isGroup && m.contactCard) { rec.contactCard = undefined; rec.text = "📇 " + (m.contactCard.name || ""); }

  // ── Копируем метаданные файла (если это файл/фото/видео/голосовое) ──
  // Раньше здесь было только text — для файловых сообщений получался
  // пустой пузырь «Переслано» без содержимого. Именно это и было
  // «пересылка не работает».
  if (m.file) {
    rec.file = {
      name: m.file.name,
      mime: m.file.mime,
      size: m.file.size,
      kind: m.file.kind,
      pending: true,
    };
    if (m.file.duration != null) rec.file.duration = m.file.duration;
    // retryMessage сохраняет caption при повторной отправке — forwardMessage
    // раньше его терял: подпись к фото/видео пропадала при пересылке.
    if (m.file.caption) rec.file.caption = m.file.caption;
  }
  // ── Копируем карточку контакта ──
  if (m.contactCard) {
    rec.contactCard = { id: m.contactCard.id, name: m.contactCard.name };
  }

  to.messages.push(rec); trimMessages(to); to.lastActivity = ts; persistContacts();
  if (state.chatId === toContactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
  toast(T("toast.forwarded"));

  if (to.isGroup) { await forwardIntoGroup(to, rec, m, msgId); return; }

  // ── 1. ФАЙЛЫ (фото/видео/документ/голосовое) ──
  if (m.file) {
    let blob;
    try { blob = await IDB.get("file:" + msgId); }
    catch (e) { blob = null; }
    if (!blob) {
      // Исходный blob уже удалён (TTL, ручная очистка, IDB сбой) —
      // пересылать нечего. Показываем честно «недоступно».
      rec.file.pending = false;
      rec.file.failed = true;
      rec.ack = "failed";
      persistContacts();
      if (state.chatId === toContactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
      toast(T("chat.file.unavailable"));
      return;
    }
    // Копируем blob под новым ID — иначе исходное сообщение и копия
    // указывали бы на один и тот же ключ IDB, и удаление оригинала
    // утащило бы за собой и пересланную копию.
    try { await IDB.set("file:" + msgId2, blob); }
    catch (e) { etherLog("error", "[forward] IDB.set failed:", String(e)); }

    const link = mesh.get(toContactId);
    const liveLink = link && (link.status === "connected" || link.status === "in-call");

    if (liveLink) {
      // P2P-путь: быстро, не грузит сервер, работает для любых размеров
      // через чанкование (sendFile).
      try {
        const buffer = await blob.arrayBuffer();
        const chunks = [];
        for (let offset = 0; offset < buffer.byteLength; offset += FILE_CHUNK_SIZE) {
          chunks.push(arrayBufferToBase64(buffer.slice(offset, offset + FILE_CHUNK_SIZE)));
        }
        const meta = { id: msgId2, name: m.file.name, mime: m.file.mime, size: m.file.size, forwarded: true };
        if (rec.forwardedFrom) meta.fwdFrom = rec.forwardedFrom;
        if (m.file.duration != null) meta.duration = m.file.duration;
        if (m.file.caption) meta.caption = m.file.caption;
        const ok = await link.sendFile(meta, chunks);
        rec.file.pending = false;
        rec.ack = ok ? "sent" : "failed";
      } catch (e) {
        etherLog("error", "[forward] P2P sendFile failed:", String(e));
        rec.file.pending = false;
        rec.ack = "failed";
      }
      persistContacts();
      if (state.chatId === toContactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
      return;
    }

    // Офлайн-путь: через зашифрованный почтовый ящик сервера — тот же
    // путь, что и sendFileOffline. trySendOrQueue сам всё сделает:
    // зашифрует, положит в outbox, отправит.
    try {
      const buffer = await blob.arrayBuffer();
      const payload = {
        kind: "file", id: msgId2,
        name: m.file.name, mime: m.file.mime, size: m.file.size,
        dataB64: arrayBufferToBase64(buffer),
        forwarded: true,
      };
      if (rec.forwardedFrom) payload.fwdFrom = rec.forwardedFrom;
      if (m.file.duration != null) payload.duration = m.file.duration;
      if (m.file.caption) payload.caption = m.file.caption;
      await trySendOrQueue(to, msgId2, payload);
      rec.file.pending = false;
      persistContacts();
      if (state.chatId === toContactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    } catch (e) {
      etherLog("error", "[forward] offline file failed:", String(e));
      rec.file.pending = false;
      rec.file.failed = true;
      rec.ack = "failed";
      persistContacts();
      if (state.chatId === toContactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }
    return;
  }

  // ── 2. КАРТОЧКА КОНТАКТА ──
  if (m.contactCard) {
    const payload = {
      kind: "contact-card", id: msgId2, ts,
      contactId: m.contactCard.id,
      contactName: m.contactCard.name || "",
      forwarded: true,
    };
    if (rec.forwardedFrom) payload.fwdFrom = rec.forwardedFrom;
    await trySendOrQueue(to, msgId2, payload);
    return;
  }

  // ── 3. ОБЫЧНЫЙ ТЕКСТ ──
  const payload = { kind: "chat", id: msgId2, text: m.text || "", ts, forwarded: true };
  if (rec.forwardedFrom) payload.fwdFrom = rec.forwardedFrom;
  await trySendOrQueue(to, msgId2, payload);
}
async function trySendOrQueue(contact, msgId, payloadObj) {
  // «Заметки себе» — локальный self-chat без второй стороны: ему некуда
  // отправлять, нет ни peer-соединения, ни смысла класть в outbox (там
  // бы это зависло навсегда и зря дёргало flushOutboxItem). Любое
  // действие над сообщением в нём (отправка/правка/удаление/пересылка)
  // считается мгновенно доставленным и прочитанным.
  if (contact.isSelf) {
    const mSelf = contact.messages.find((x) => x.id === msgId);
    if (mSelf) { mSelf.ack = "read"; mSelf.serverAcked = true; }
    return;
  }
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
// Вложение целиком (base64) в очереди отправки раздувало localStorage (квота ~5–10 МБ на всё приложение, а в группе копия
// на каждого участника). В сохранённой очереди вместо dataB64 лежит ключ IndexedDB, откуда файл достаётся перед отправкой.
function slimPayload(payload) {
  if (!payload || typeof payload.dataB64 !== "string") return payload;
  const { dataB64, ...rest } = payload;
  rest.idbKey = "file:" + payload.id;
  return rest;
}
async function hydratePayload(payload) {
  if (!payload || payload.dataB64 || !payload.idbKey) return payload;
  const blob = await IDB.get(payload.idbKey);
  if (!blob || typeof blob.arrayBuffer !== "function") return null;
  const { idbKey, ...rest } = payload;
  rest.dataB64 = arrayBufferToBase64(await blob.arrayBuffer());
  return rest;
}
function persistOutbox() {
  const arr = Array.from(outbox.values()).map((e) => ({ msgId: e.msgId, to: e.to, payload: slimPayload(e.payload), sentAt: e.sentAt, attempts: e.attempts, serverAcked: !!e.serverAcked }));
  try { Store.outboxJson = JSON.stringify(arr); } catch (e) { handlePersistError(e, "outbox"); }
}
function restoreOutbox() {
  let arr = []; try { arr = JSON.parse(Store.outboxJson) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  for (const e of arr) if (e && typeof e.msgId === "string" && typeof e.to === "string" && e.payload) {
    outbox.set(e.msgId, { msgId: e.msgId, to: e.to, payload: e.payload, sentAt: e.sentAt || Date.now(), attempts: e.attempts || 0, serverAcked: !!e.serverAcked });
  }
}
// См. комментарий у Store.groupDeliveryMapJson и groupDeliveryMap: эта
// карта — единственный надёжный способ сопоставить deliveryId (ack,
// пришедший от конкретного получателя группового сообщения, в том
// числе через много часов после отправки) с самим сообщением в группе,
// независимо от того, жива ли ещё соответствующая запись в outbox.
function persistGroupDeliveryMap() {
  const arr = Array.from(groupDeliveryMap.entries()).map(([deliveryId, v]) => ({ deliveryId, groupId: v.groupId, contentId: v.contentId, to: v.to }));
  try { Store.groupDeliveryMapJson = JSON.stringify(arr); } catch (e) { handlePersistError(e, "groupDeliveryMap"); }
}
function restoreGroupDeliveryMap() {
  let arr = []; try { arr = JSON.parse(Store.groupDeliveryMapJson) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  for (const e of arr) if (e && typeof e.deliveryId === "string" && typeof e.groupId === "string" && typeof e.contentId === "string") {
    groupDeliveryMap.set(e.deliveryId, { groupId: e.groupId, contentId: e.contentId, to: e.to });
  }
}
// Резолвит deliveryId в { ownerChat, targetMsg } для группового
// сообщения "от меня", независимо от состояния outbox. Возвращает null,
// если deliveryId не относится к группе (личные сообщения через эту
// карту не проходят) или сама запись сообщения не найдена (например,
// группу уже удалили).
function resolveGroupDelivery(deliveryId) {
  const entry = groupDeliveryMap.get(deliveryId);
  if (!entry) return null;
  const g = state.contacts.get(entry.groupId);
  const m = g && g.messages.find((mm) => mm.id === entry.contentId && mm.from === "me");
  if (!g || !m) return null;
  return { ownerChat: g, targetMsg: m };
}
async function flushOutboxItem(msgId) {
  const entry = outbox.get(msgId); if (!entry) return;
  if (entry.serverAcked) { outbox.delete(msgId); persistOutbox(); return; }
  const contact = state.contacts.get(entry.to);
  if (!contact) { outbox.delete(msgId); persistOutbox(); return; }
  if (!contact.publicKey) {
    // Нет публичного ключа получателя — зашифровать нечем. Кладём в
    // pendingNoKey (уйдёт автоматически, когда ключ появится), НО
    // помечаем сообщение статусом "failed", а не оставляем вечный
    // "pending". Именно это было причиной «голосовые висят с крутящимся
    // спиннером бесконечно, пока собеседник не появится онлайн»: файлы
    // и голосовые имеют свойство file.pending = true, которое никто
    // не сбрасывал — запись в outbox удалялась, а UI продолжал
    // показывать "отправка идёт". Теперь сразу переводим UI в честное
    // "не отправлено" (!), а не держим пользователя в неведении.
    const isFirstTime = !pendingNoKey.has(contact.id) || !pendingNoKey.get(contact.id).some((x) => x.msgId === msgId);
    if (!pendingNoKey.has(contact.id)) pendingNoKey.set(contact.id, []);
    const list = pendingNoKey.get(contact.id);
    if (!list.some((x) => x.msgId === msgId)) { list.push({ msgId, payload: entry.payload }); persistPendingNoKey(); }
    outbox.delete(msgId); persistOutbox();
    // КРИТИЧНО: помечаем сообщение "failed" явно. Без этого ack
    // остаётся "pending" навсегда — в UI это символ ◷ с CSS-
    // анимацией вращения, ровно то, что видел пользователь: "иконка
    // отправки крутится бесконечно, пока второй абонент не
    // подключится". Сообщение уйдёт автоматически, когда ключ
    // появится (flushPendingNoKey), и там ack уже обновится в "sent".
    // Снимаем также file.pending, если это вложение — иначе
    // file-bubble-pending держит спиннер поверх.
    const c0 = state.contacts.get(contact.id);
    if (c0) {
      const m0 = c0.messages.find((x) => x.id === msgId);
      if (m0 && m0.file) m0.file.pending = false;
    }
    markMessageAck(contact.id, msgId, "failed");
    if (isFirstTime) toast(T("toast.waitingForKey", { name: contact.name || T("sys.someone") }));
    return;
  }
  try {
    if (entry.payload && entry.payload.idbKey && !entry.payload.dataB64) {
      const full = await hydratePayload(entry.payload);
      if (!full) { outbox.delete(msgId); persistOutbox(); markMessageAck(entry.to, msgId, "failed"); return; } // файл пропал из IndexedDB — отправить нечего
      entry.payload = full;
    }
    const sharedKey = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, contact.publicKey);
    const envelope = await CryptoHelper.encryptJson(sharedKey, entry.payload);
    entry.attempts = (entry.attempts || 0) + 1;
    entry.lastAttemptAt = Date.now();
    persistOutbox();
    const kind = (entry.payload && entry.payload.kind) || "chat";
    const sent = signaling && signaling.deliver(entry.to, entry.msgId, envelope, Store.myPublicKeyJwk, kind);
    if (!sent) markMessageAck(entry.to, msgId, "failed");
    else if (kind === "chat" || kind === "file") {
      // Раньше здесь стояло только `kind === "chat"` — для kind
      // === "file" (голосовые и любые вложения, ушедшие офлайн-путём
      // через сервер) ack НЕ обновлялся, и сообщение навсегда
      // оставалось в состоянии "pending" — с точки зрения UI это
      // вечно крутящийся символ ◷. Именно поэтому голосовое,
      // успешно принятое сервером, визуально висело "отправляется".
      // Комментарий про группы ниже остаётся в силе — markMessageAck
      // уже корректно резолвит группу через outbox-запись.
      markMessageAck(entry.to, msgId, "sent");
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
  for (const [cid, list] of pendingNoKey) { if (!list || list.length === 0) continue; obj[cid] = list.map((x) => ({ msgId: x.msgId, payload: slimPayload(x.payload) })); }
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
      // Файлы, голосовые и карточки контактов НЕ восстанавливаем автоматом:
      // для них нужен исходный Blob из IndexedDB и полный payload, а не
      // просто text. Иначе на сервер уйдёт пустой текстовый конверт, а
      // получатель увидит пустой пузырь — файл потерян. Ручной повтор —
      // через "Повторить" в меню сообщения (см. handleMessageAction).
      if (m.file || m.contactCard) continue;
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
  // JSON.stringify, не join(",") — id'шники здесь обычные crypto.
  // randomUUID() без запятых, но join() молча склеил бы два разных
  // набора id в один и тот же ключ, если в массив когда-нибудь попадёт
  // строка с запятой (например, ручной retry через консоль).
  const key = contactId + ":" + ackState + ":" + JSON.stringify(originalMsgIds);
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
  if (ack === "read" && !Store.receiptsEnabled) ack = "delivered";
  const rank = { failed: -1, sent: 0, delivered: 1, read: 2 };

  const entry = outbox.get(msgId);
  const groupId = entry && entry.payload && entry.payload.groupId;
  const contentId = entry && entry.payload && entry.payload.id;

  // Ищем сообщение и его чат-«владелец» (личный или групповой).
  // 1) Сначала — прямой путь через outbox-entry, если запись ещё жива.
  // 2) Затем — groupDeliveryMap: переживает удаление outbox-записи по
  //    deliver-ack с сервера, и это ЕДИНСТВЕННЫЙ надёжный путь для
  //    группового сообщения, доставленного через офлайн-mailbox —
  //    настоящая квитанция "доставлено"/"прочитано" от получателя может
  //    прийти через много часов после того, как deliver-ack (просто
  //    подтверждение, что конверт лёг на сервер) уже удалил outbox-
  //    запись. См. resolveGroupDelivery.
  // 3) Затем — личный чат с contactId.
  // 4) В конце — fallback для P2P-групповых ack'ов: при P2P-доставке
  //    deliveryId, который получатель возвращает в ack'е, совпадает с
  //    contentId самого сообщения (см. applyIncomingPayload — там для
  //    P2P-пути envelopeMsgId = payload.id), так что достаточно простого
  //    поиска по id. Без этого fallback'а P2P-групповое сообщение
  //    навсегда осталось бы с одной галочкой.
  let ownerChat = null, targetMsg = null;

  if (groupId && contentId) {
    const g = state.contacts.get(groupId);
    const m = g && g.messages.find((mm) => mm.id === contentId && mm.from === "me");
    if (m) { ownerChat = g; targetMsg = m; }
  }
  if (!targetMsg) {
    const resolved = resolveGroupDelivery(msgId);
    if (resolved) { ownerChat = resolved.ownerChat; targetMsg = resolved.targetMsg; }
  }
  if (!targetMsg) {
    const c = state.contacts.get(contactId);
    const m = c && c.messages.find((mm) => mm.id === msgId && mm.from === "me");
    if (m) { ownerChat = c; targetMsg = m; }
  }
  if (!targetMsg) {
    for (const g of state.contacts.values()) {
      if (!g.isGroup) continue;
      const m = g.messages.find((mm) => mm.id === msgId && mm.from === "me");
      if (m) { ownerChat = g; targetMsg = m; break; }
    }
  }

  if (targetMsg && ((rank[ack] ?? 0) >= (rank[targetMsg.ack] ?? 0) || ack === "failed")) {
    targetMsg.ack = ack;
    persistContacts();
    if (ownerChat && state.chatId === ownerChat.id) renderChatThread();
  }

  if (ack === "delivered" || ack === "read") {
    if (outbox.has(msgId)) { outbox.delete(msgId); persistOutbox(); }
  }
  // "read" — старший статус (rank 2), выше него квитанций не бывает,
  // так что groupDeliveryMap-запись для этого deliveryId больше не
  // нужна — убираем, чтобы карта не росла бессмысленно до лимита.
  if (ack === "read" && groupDeliveryMap.has(msgId)) { groupDeliveryMap.delete(msgId); persistGroupDeliveryMap(); }
}
function sendTypingStart(contactId) {
  if (state.typingSendingState.get(contactId)) return;
  state.typingSendingState.set(contactId, true);
  const c = state.contacts.get(contactId); if (!c) return;
  const link = mesh.get(contactId);
  // Typing — временный статус. Если P2P-связи нет, отправлять его через
  // сервер (в офлайн-очередь mailbox) смысла нет: получатель получит
  // "печатает…" уже когда собеседник давно закрыл приложение. Раньше
  // typing уходил в офлайн-очередь наравне с обычными сообщениями —
  // видно в логах сервера: "[deliver] ... kind=typing online=false".
  // Просто ничего не отправляем, если P2P нет.
  if (link && (link.status === "connected" || link.status === "in-call")) {
    link.send({ kind: "typing", active: true });
  }
}
function sendTypingStop(contactId) {
  if (!state.typingSendingState.get(contactId)) return;
  state.typingSendingState.delete(contactId);
  const c = state.contacts.get(contactId); if (!c) return;
  const link = mesh.get(contactId);
  if (link && (link.status === "connected" || link.status === "in-call")) {
    link.send({ kind: "typing", active: false });
  }
}
// Три тумблера приватности сообщаются собеседнику через P2P (тот же
// принцип, что и typing-статус) — сервер тут ни при чём, это прямое
// сообщение между уже связанными пирами.
function sendPrivacyPrefsTo(contactId) {
  const link = mesh.get(contactId);
  if (!link || (link.status !== "connected" && link.status !== "in-call")) return;
  link.send({ kind: "privacy-pref", receiptsEnabled: Store.receiptsEnabled, lastSeenVisible: Store.lastSeenVisible, presenceVisible: Store.presenceVisible, status: Store.myStatus || "", avatar: Store.myAvatar || "" });
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
// Визуальный отклик на быструю реакцию двойным тапом — раньше тап
// просто молча ставил реакцию без какой-либо анимации на экране.
function spawnReactionBurst(bubbleEl, emoji) {
  try {
    const burst = document.createElement("span");
    burst.className = "reaction-burst";
    burst.textContent = emoji;
    bubbleEl.appendChild(burst);
    const cleanup = () => { try { burst.remove(); } catch (e) {} };
    burst.addEventListener("animationend", cleanup, { once: true });
    setTimeout(cleanup, 600); // страховка, если animationend не пришёл (reduced-motion и т.п.)
  } catch (e) {}
}
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
let __lastReclaimAt = 0;
let __replacedHits = [];
function reclaimSignaling() {
  if (Date.now() - __lastReclaimAt < 4000) return; // два окна рядом не должны бесконечно отбирать соединение друг у друга
  __lastReclaimAt = Date.now();
  state._replaced = false;
  etherLog("info", "[signaling] забираю соединение в этом окне");
  initSignaling();
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
  signaling.addEventListener("slow-connect", () => { if (!signaling.connected) updateSignalingStatusUI("connecting", T("status.waking")); });
  signaling.start();
}
// Общая обработка входящего offer/answer — используется и для сигнального
// сервера, и для релея через общий контакт (см. ниже): сама логика
// WebRTC-рукопожатия не должна знать и не знает, через какой транспорт
// пришёл пакет.
async function handleIncomingOffer(from, packet, replySignal) {
  if (recentlyDeletedIds.has(from)) return;
  // Заблокированный собеседник не должен устанавливать P2P-соединение.
  // Сообщения от него отсекаются в mesh-обработчике (if (c.blocked) return),
  // но сам линк уже создаётся, тратит ICE, виден в диагностике как
  // "connected", приглашает к дальнейшим пересогласованиям.
  const blockedContact = state.contacts.get(from);
  if (blockedContact && blockedContact.blocked) return;
  clearUnreachable(from);
  const existing = mesh.get(from);
  // Любой живой линк (offerer или answerer, connected или in-call) —
  // игнорируем встречный offer. Раньше проверялась только пара
  // "answerer + connected": если мы были offerer'ом и уже connected,
  // повторный offer убивал рабочее соединение. Проявляется как раз
  // при renegotiation (оба одновременно увидели negotiationneeded).
  if (existing && (existing.status === "connected" || existing.status === "in-call")) {
    etherLog("info", "[offer] " + String(from).slice(0, 10) + "…", "уже live, игнорирую повторный offer");
    return;
  }
  // Оба конца могут одновременно слать offer (звонок с force). Тай-брейк как в attemptConnect: offerer — тот, у кого id меньше.
  // Если мы — этот offerer и наш линк ещё подключается, встречный offer игнорируем: собеседник примет наш и ответит.
  if (existing && existing.role === "offerer" && existing.status === "connecting" && Store.myId < from && Date.now() - (existing._createdAt || 0) < CONNECT_STUCK_MS) {
    etherLog("info", "[offer] " + String(from).slice(0, 10) + "…", "встречный offer: я offerer по тай-брейку, игнорирую");
    return;
  }
  if (existing) mesh.remove(from);
  ensureContactEntry(from, packet.n);
  if (packet.rl) markRelayOnly(from); // собеседник обнаружил, что UDP «глухой» — отвечаем тоже только через TURN
  const link = mesh.createIncomingLink(from);
  flushPendingIceFor(from, link);
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
    // ПЕРЕОТПРАВЛЯЕМ подписку при каждом переподключении к серверу.
    // Раньше подписка отправлялась только при первом subscribe — а сервер
    // на Render хранит её в файле, который теряется при каждом рестарте
    // инстанса (бесплатный тариф — перезапуск после 15 минут простоя и
    // при каждом деплое). После первого же перезапуска push переставал
    // работать вообще, потому что сервер просто не знал о подписке.
    // Явное пересоздание подписки гарантирует, что она всегда актуальна.
    try {
      if (Store.pushSubscriptionJson) {
        const sub = JSON.parse(Store.pushSubscriptionJson);
        sig.sendPushSubscription(sub);
      }
    } catch (e) {}
    // Полное пересоздание подписки (getSubscription → subscribe) — не
    // только переиспользование сохранённого JSON. Это лечит случаи, когда
    // сохранённый JSON устарел или сама подписка на стороне браузера
    // истекла.
    setTimeout(() => { ensurePushSubscription().catch(() => {}); }, 500);

    // Периодическая переотправка push-подписки — обход той же эфемерной
    // ФС Render (free tier теряет .ether-push-subs.json при каждом
    // рестарте инстанса, в т.ч. простое 15 минут). Переотправка выше
    // срабатывает только при "connected" (новое WS-соединение) — но
    // если телефон не закрывал приложение и WS не переподключался,
    // а сервер за это время перезапустился, клиент никогда не узнает,
    // что сервер "забыл" подписку. Раз в час подчищаем и это. Таймер
    // ставим один раз на весь жизненный цикл страницы — обработчик
    // "connected" может сработать многократно за сессию.
    if (!window.__etherPushResendTimer) {
      window.__etherPushResendTimer = setInterval(() => {
        if (signaling && signaling.connected && Store.pushSubscriptionJson) {
          try {
            const sub = JSON.parse(Store.pushSubscriptionJson);
            signaling.sendPushSubscription(sub);
          } catch (e) {}
        }
      }, 60 * 60 * 1000);
    }
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
  subs.push(on("unreachable", (ev) => {
    const { to } = ev.detail;
    if (!to) return;
    // Сервер явно сказал: получатель не зарегистрирован. Линк, который
    // мы пытались поднять, точно мёртв — закрываем СРАЗУ, не ждём
    // WATCH_CONNECT_TIMEOUT_MS (20 секунд, все они — мусор в логе и
    // в диагностике). Раньше это событие dispatch'илось, но никто его
    // не слушал.
    const link = mesh.get(to);
    if (link && link.status === "connecting") {
      etherLog("info", "[connect] " + String(to).slice(0, 10) + "…", "unreachable → закрываю линк");
      mesh.remove(to);
    }
    // Прогрессивный cooldown: 60с → 5мин → 30мин при повторных отказах.
    markUnreachable(to);
  }));
  subs.push(on("replaced", () => {
    // Тот же идентификатор открыт в другом окне/вкладке (часто — забытая старая вкладка). Сервер оставляет только одно соединение,
    // и «лишнее» окно раньше навсегда оставалось офлайн. Теперь оно ждёт: как только вы вернётесь в это окно (или нажмёте
    // индикатор «офлайн»), оно заберёт соединение себе — побеждает окно, которым пользуются сейчас.
    state._replaced = true;
    updateSignalingStatusUI("off", T("status.replaced"));
    // Выбросить могло и «призрачное» соединение (старый сокет после перезагрузки страницы, переключения сети). Поэтому, если окно
    // на виду, забираем соединение обратно сами через пару секунд; если за минуту выбрасывало трижды — это настоящее второе окно,
    // и ждём действия пользователя (фокус или нажатие на индикатор), чтобы два окна не отнимали соединение друг у друга бесконечно.
    const now = Date.now();
    __replacedHits = __replacedHits.filter((t) => now - t < 60000); __replacedHits.push(now);
    if (__replacedHits.length < 3) {
      setTimeout(() => { if (state._replaced && !document.hidden) reclaimSignaling(); }, 1500 + Math.random() * 1500);
    } else {
      toast(T("status.replaced"));
    }
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
    if (online) {
      onlineSet.add(id);
      onlineRoster.set(id, { name, visible: visible !== false, publicKey: publicKey || null });
      clearUnreachable(id); // target снова онлайн — сбрасываем backoff
    }
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
      // Раньше тут стояла защита "игнорирую повторный call-invite после
      // недавнего отбоя" — она ошибочно блокировала и осознанные новые
      // звонки от того же человека в течение 15 секунд после отбоя
      // (пользователь нажимал "Позвонить снова" — звонок молча не
      // шёл). Авто-генерируемые call-state:ringing теперь фильтруются
      // ТОЛЬКО в mesh-обработчике по data channel (там же им и место),
      // а call-invite через сервер — это всегда явное действие
      // собеседника, его фильтровать нельзя.
      // Сообщения от заблокированных уже фильтруются (и в mesh-обработчике,
      // и в deliver), а сигнал входящего звонка — нет. Заблокировав
      // человека, пользователь продолжал бы получать от него звонки.
      const existingBlocked = state.contacts.get(from);
      if (existingBlocked && existingBlocked.blocked) return;
      ensureContactEntry(from, packet.n);
      if (state.callId && state.callId !== from) {
        const busySent = sig.signal(from, { t: "call-busy" });
        if (!busySent) etherLog("warn", "[call] не удалось отправить call-busy (сигналинг недоступен)");
        return;
      }
      if (state.callId === from) {
        const ackSent = sig.signal(from, { t: "call-invite-ack" });
        if (!ackSent) etherLog("warn", "[call] повторный call-invite — не удалось подтвердить (сигналинг недоступен)");
        return;
      }
      openCallScreen(from, "ringing");
      try { ensureAudioCtx(); } catch (e) {}
      playRingtone();
      const c = state.contacts.get(from);
      if (c && !isContactMuted(c) && Store.notificationsEnabled) {
        // Раньше тут был force: true — уведомление показывалось, даже когда
        // приложение активно. В этом случае звонок уже отрисован на экране
        // (openCallScreen выше), рингтон и вибрация играют (playRingtone
        // выше) — системный баннер только дублировал видимое. Убрали force:
        // showNotification() сам проверит document.visibilityState.
        showNotification(T("call.incoming"), packet.n || "", { tag: "ether-call-" + from, contactId: from, kind: "call" });
      }
      // Раньше ошибка молча проглатывалась. На практике сигналинг
      // почти наверняка жив (иначе call-invite не дошёл бы до нас),
      // но если он отвалился в промежутке — звонящий не узнает, что
      // его вызов дошёл. Логируем для диагностики: при разборе багов
      // будет видно, почему звонящий висит в "Вызов…" до таймаута.
      const ackSent = sig.signal(from, { t: "call-invite-ack" });
      if (!ackSent) {
        etherLog("warn", "[call] " + String(from).slice(0, 10) + "…",
          "call-invite-ack не отправлен (сигналинг недоступен) — звонящий узнает о дозвоне только после установки P2P");
      }
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
    } else if (packet.t === "ice") {
      // Trickle ICE: кандидат от собеседника. Если link уже создан —
      // отдаём напрямую, он сам разберётся (буферизует, если
      // remoteDescription ещё не установлен). Если link'а ещё нет
      // (offer/answer в пути) — копим глобально, разберём в
      // handleIncomingOffer/attemptConnect через flushPendingIceFor.
      // recentlyDeletedIds — та же защита, что в handleIncomingOffer:
      // удалённый контакт, который продолжает слать ICE-кандидаты
      // (например, не узнал об удалении и ретраит переподключение),
      // не должен копить их здесь — без link'а эти кандидаты никогда
      // никому не передадутся, просто занимают память до следующего
      // удаления или до перезагрузки.
      if (packet.candidate && !recentlyDeletedIds.has(from)) {
        const link = mesh.get(from);
        if (link) {
          link.addIceCandidate(packet.candidate).catch(() => {});
        } else {
          if (!pendingIceCandidates.has(from)) pendingIceCandidates.set(from, []);
          const buf = pendingIceCandidates.get(from);
          buf.push(packet.candidate);
          if (buf.length > 200) buf.shift();
        }
      }
      return;
    }
  }));
  subs.push(on("deliver-ack", (ev) => {
    const { msgId } = ev.detail;
    const entry = outbox.get(msgId);
    if (!entry) return;
    // Тот же баг, что был в flushOutboxItem (см. markMessageAck) — для
    // ГРУППОВЫХ сообщений entry.to это id участника, а не группы, и
    // сообщение лежит в списке ГРУППЫ под другим (contentId) id.
    // Поиск по entry.to никогда не находил совпадение для групп —
    // serverAcked так и оставался false навсегда. Сейчас это не даёт
    // видимых симптомов (resumeUnsentMessages явно пропускает группы),
    // но это скрытая мина на будущее — резолвим группу так же, как
    // markMessageAck, а не оставляем расхождение.
    const groupId = entry.payload && entry.payload.groupId;
    const contentId = entry.payload && entry.payload.id;
    if (groupId && contentId) {
      const g = state.contacts.get(groupId);
      const m = g && g.messages.find((x) => x.id === contentId && x.from === "me");
      if (m) { m.serverAcked = true; persistContacts(); }
    } else {
      const c = state.contacts.get(entry.to);
      if (c) {
        const m = c.messages.find((x) => x.id === msgId && x.from === "me");
        if (m) { m.serverAcked = true; persistContacts(); }
      }
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
  // group-invite дедуплицируется отдельно, по payload.id (см.
  // applyIncomingPayload) — там же ключ "grp-inv:". Раньше мы добавляли
  // ещё и "from|msgId", и Set рос вдвое быстрее (по 2 записи на
  // каждый group-invite), из-за чего окно дедупликации сжималось.
  if (kind !== "group-invite") {
    if (seenDeliverIds.has(from + "|" + msgId)) {
      if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
      return;
    }
    seenDeliverIds.add(from + "|" + msgId);
    if (seenDeliverIds.size > SEEN_DELIVER_LIMIT) seenDeliverIds.delete(seenDeliverIds.values().next().value);
  }
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
    if (!c) return; // сообщение в группу, о которой нам ничего не известно (приглашение не дошло) — сопоставляем именно с группой (c = state.contacts.get(groupId)), а не с отправителем from; группы нет локально — некуда класть сообщение
    // Защита на стороне получателя, а не только запрет в UI отправителя —
    // иначе достаточно отправить сообщение программно (минуя композер),
    // чтобы "только админы пишут" оказалось чисто декоративным. Без
    // доверенного сервера это не защита от модифицированного клиента
    // самого отправителя, но она гарантирует, что ЧЕСТНЫЕ клиенты всех
    // остальных участников согласованно скрывают такое сообщение.
    if (groupId && c.writeRestricted && !isGroupAdmin(c, from)) return;
    if (c.messages.some((m) => m.id === payload.id)) return;
    const routeId = groupId || from;
    const isOpen = state.chatId === routeId;
    const rec = { id: payload.id, from: "them", text: payload.text, ts: payload.ts || Date.now(), readAckSent: false, deliveryId: envelopeMsgId };
    if (groupId) { rec.fromId = from; rec.fromName = payload.senderName || (state.contacts.get(from) && state.contacts.get(from).name) || T("sys.someone"); }
    if (payload.replyTo) rec.replyTo = payload.replyTo;
    if (payload.forwarded) { rec.forwarded = true; if (typeof payload.fwdFrom === "string" && payload.fwdFrom) rec.forwardedFrom = payload.fwdFrom.slice(0, 40); }
    if (payload.ttl) rec.ttl = payload.ttl;
    if (groupId && Store.name && typeof payload.text === "string" && isMentioned(payload.text, Store.name)) {
      rec.mentionMe = true;
      state.mentionedChats.add(groupId);
    }
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    const displayName = c.name;
    const previewPrefix = groupId ? `${rec.fromName}: ` : "";
    if (isOpen) {
      renderChatThread(); playMessageSound(routeId); vibrate([80, 40, 80]);
      // aria-live на #chat-messages спамил бы весь список на каждую
      // перерисовку — объявляем только реально новое сообщение через
      // отдельный скрытый узел.
      announceToScreenReader(T("sr.newMessage", { name: groupId ? rec.fromName : displayName, text: truncate(payload.text, 80) }));
    } else {
      toast(`${displayName}: ${previewPrefix}${truncate(payload.text, 40)}`);
      if (!isContactMuted(c)) showNotification(displayName || T("app.name"), previewPrefix + truncate(payload.text, 80), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
      playMessageSound(routeId);
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
  } else if (kind === "file") {
    // Файл/голосовое, пришедшее ЦЕЛИКОМ одним payload'ом — путь через
    // почтовый ящик сервера (sendFileOffline/sendVoiceOffline), в
    // отличие от чанкованного P2P-протокола (kind начинается с "file-",
    // см. handleFilePayload/finishIncomingFile — та запись сначала
    // "pending", потом дозаполняется). Тут вся информация уже есть
    // сразу, собирать по частям нечего.
    const fileGroupId = payload.groupId;
    const c = fileGroupId ? state.contacts.get(fileGroupId) : ensureContactEntry(from, null);
    if (!c) return; // файл в группу, о которой мы ничего не знаем
    if (fileGroupId) {
      // Только участник группы; режим «пишут только админы» проверяется и здесь, как для текста
      if (!isGroup(c) || !c.members.some((m) => m.id === from)) return;
      if (c.writeRestricted && !isGroupAdmin(c, from)) return;
    }
    const fileRouteId = fileGroupId || from;
    if (c.messages.some((m) => m.id === payload.id)) return;
    // Симметрично handleFilePayload (чанкованный P2P-путь) — там
    // payload.size проверяется EtherFileLimits.isValidFileMetaSize ещё до
    // того, как собирать чанки. Этот офлайн-путь получает файл целиком
    // одним payload'ом через почтовый ящик сервера, и раньше размер вообще
    // не проверялся. Эксплуатация ограничена isValidEnvelope на сервере и
    // SCTP-лимитами P2P, но для согласованности проверка нужна и тут.
    if (!EtherFileLimits.isValidFileMetaSize(payload.size)) return;
    let blob;
    try { blob = new Blob([base64ToUint8Array(payload.dataB64)], { type: payload.mime || "application/octet-stream" }); }
    catch (e) { etherLog("error", "[file] decode failed:", String(e)); return; }
    const rec = {
      id: payload.id, from: "them", text: "", ts: payload.ts || Date.now(), readAckSent: false, deliveryId: envelopeMsgId,
      file: { name: payload.name || "file", mime: payload.mime || "application/octet-stream", size: payload.size || blob.size, kind: fileKindFromMime(payload.mime), duration: payload.duration, pending: false },
    };
    if (payload.forwarded) { rec.forwarded = true; if (typeof payload.fwdFrom === "string" && payload.fwdFrom) rec.forwardedFrom = payload.fwdFrom.slice(0, 40); }
    if (typeof payload.caption === "string" && payload.caption) rec.file.caption = payload.caption.slice(0, 200);
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    // Раньше IDB.set не дожидались: renderChatThread → hydrateFileSlots →
    // getFileBlobUrl → IDB.get мог выполниться раньше, чем put
    // завершится, и слот на секунду показывал «недоступно». Явно
    // дожидаемся записи, весь хвост ветки (тосты/нотификации/рендер)
    // переносим внутрь .then.
    IDB.set("file:" + payload.id, blob)
      .then(() => {
        const isOpen = state.chatId === fileRouteId;
        if (isOpen) { renderChatThread(); playMessageSound(fileRouteId); vibrate([80, 40, 80]); }
        else {
          const label = (fileGroupId ? rec.fromName + ": " : "") + T("chat.file.preview." + rec.file.kind);
          toast(`${c.name}: ${label}`);
          if (!isContactMuted(c)) showNotification(c.name || T("app.name"), label, { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
          playMessageSound(fileRouteId);
          vibrate([80, 40, 80]);
        }
        if (state.tab === "chats") renderChatsList();
        updateAppBadge();
      })
      .catch((e) => {
        etherLog("error", "[file] IDB.set failed:", String(e));
        // даже без сохранённого блоба пузырь уже добавлен — при
        // следующем рендере слот покажет «недоступно»
        const isOpen = state.chatId === fileRouteId;
        if (isOpen) renderChatThread();
        if (state.tab === "chats") renderChatsList();
        updateAppBadge();
      });
   } else if (kind === "group-invite") {
    // Дедупликация по payload.id. group-invite — особый случай: у него
    // нет ack-механизма (получатель не отвечает "получил"), поэтому
    // отправитель всегда дублирует отправку через сервер через
    // P2P_FALLBACK_MS — это видно в логах: один и тот же msgId с
    // kind=group-invite приходит дважды подряд. Без этой проверки
    // получатель видел каждый групповой инвайт как два отдельных
    // события.
    const gDedupKey = "grp-inv:" + payload.id;
    if (seenGroupInviteIds.has(gDedupKey)) return;
    seenGroupInviteIds.add(gDedupKey);
    if (seenGroupInviteIds.size > SEEN_DELIVER_LIMIT) seenGroupInviteIds.delete(seenGroupInviteIds.values().next().value);

    if (!Array.isArray(payload.members) || payload.members.length === 0 || payload.members.length > MAX_GROUP_MEMBERS) return;
    if (!payload.members.some((m) => m.id === Store.myId)) return;
  // Ищем группу по payload.groupId. Дополнительно, если по id её нет —
  // ищем по «логической идентичности»: тот же состав участников + то же
  // имя. Нужно как страховка от бага, когда прилетает group-invite с
  // ДРУГИМ groupId, но это на самом деле та же группа (тот же набор
  // людей и имя). Без этой проверки создавался бы дубликат: одна
  // группа с системным сообщением «создана», вторая — без него.
  let g = state.contacts.get(payload.groupId);
  etherLog("info", "[group] invite in:", "from=" + String(from).slice(0, 8) + "…", "payload.groupId=" + String(payload.groupId).slice(0, 8) + "…", "isNew=" + (!g), "existingKeys=" + Array.from(state.contacts.keys()).filter((k) => state.contacts.get(k).isGroup).length);
  if (!g) {
    const incomingIds = payload.members.map((m) => m.id).sort().join("|");
    const incomingName = (payload.groupName || "").trim();
    for (const other of state.contacts.values()) {
      if (!other.isGroup) continue;
      const otherIds = other.members.map((m) => m.id).sort().join("|");
      if (otherIds !== incomingIds) continue;
      if (incomingName && other.name && other.name !== incomingName) continue;
      // Тот же состав участников (+ то же имя) — считаем это той же группой.
      // Указываем её локально под payload.groupId, чтобы последующие
      // инвайты с тем же groupId (но другим именем) нашли её по id.
      etherLog("info", "[group] invite от " + String(from).slice(0, 8) + "…: id не совпал, но состав совпадает с существующей группой — считаю той же группой");
      state.contacts.delete(other.id);
      other.id = payload.groupId;
      state.contacts.set(payload.groupId, other);
      g = other;
      break;
    }
  }
  const isNew = !g;
  if (isNew) {
      g = { id: payload.groupId, isGroup: true, name: payload.groupName || T("group.defaultName"),
        members: payload.members, messages: [], lastActivity: Date.now(), archived: false, muted: false,
        createdBy: from, managed: true };
      // Валидируем формат ДО записи в g.avatar — тогда "заражённый" аватар
      // (CSS-инъекция через background-image, см. AVATAR_DATAURL_RE выше
      // avatarCircleHtml) просто не попадёт в localStorage вовсе, а не
      // будет каждый раз отфильтровываться только на рендере.
      if (payload.groupAvatar && AVATAR_DATAURL_RE.test(payload.groupAvatar)) g.avatar = payload.groupAvatar;
      if (payload.groupDescription) g.description = String(payload.groupDescription).slice(0, 200);
      state.contacts.set(payload.groupId, g);
      g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemCreated", { name: g.name }), textKey: "group.systemCreated", textParams: { name: g.name }, ts: Date.now() });
      trimMessages(g);
    } else {
      g.members = payload.members;
      if (payload.groupName) g.name = payload.groupName;
      if (payload.groupAvatar !== undefined) g.avatar = (payload.groupAvatar && AVATAR_DATAURL_RE.test(payload.groupAvatar)) ? payload.groupAvatar : null;
      if (payload.groupDescription !== undefined) g.description = String(payload.groupDescription || "").slice(0, 200) || undefined;
    }
    g.lastActivity = Date.now();
    persistContacts();
    ensureGroupConnections(g);
    if (state.chatId === payload.groupId) renderChatThread();
    if (state.tab === "chats") renderChatsList();
  } else if (kind === "group-settings") {
    // Применяем новое состояние ("только админы пишут") только если его
    // прислал реально действующий админ этой группы на момент получения
    // — иначе разжалованный или выгнанный участник мог бы продолжать
    // рассылать изменения настроек задним числом.
    const g = state.contacts.get(payload.groupId);
    if (!g || !g.isGroup || !isGroupAdmin(g, from)) return;
    if (typeof payload.writeRestricted === "boolean" && g.writeRestricted !== payload.writeRestricted) {
      g.writeRestricted = payload.writeRestricted;
      persistContacts();
      if (state.chatId === payload.groupId) { renderChatThread(); updateSendVsMic(); }
      if (state.activeGroupContext === payload.groupId) openGroupInfo(payload.groupId);
    }
  } else if (kind === "edit") {
    const c = resolveEditDeleteTarget(from, payload);
    if (!c) return;
    const m = c.messages.find((x) => x.id === payload.id && (c.isGroup ? x.fromId === from : x.from === "them"));
    if (m) { m.text = payload.text; m.edited = true; m.ts = payload.ts || m.ts; c.lastActivity = Date.now(); persistContacts();
      if (state.chatId === c.id) renderChatThread(); if (state.tab === "chats") renderChatsList(); }
  } else if (kind === "delete") {
    const c = resolveEditDeleteTarget(from, payload);
    if (!c) return;
    const before = c.messages.length;
    c.messages = c.messages.filter((x) => !(x.id === payload.id && (c.isGroup ? x.fromId === from : x.from === "them")));
    if (c.messages.length !== before) { persistContacts();
      if (state.chatId === c.id) renderChatThread(); if (state.tab === "chats") renderChatsList(); }
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
      if (typeof payload.status === "string") c.peerStatus = payload.status;
      // Собственное фото собеседника (до ~20 КБ, строгая проверка формата): показывается, пока вы не выбрали контакту своё
      if (typeof payload.avatar === "string") {
        if (payload.avatar === "") delete c.peerAvatar;
        else if (payload.avatar.length <= 40000 && AVATAR_DATAURL_RE.test(payload.avatar)) c.peerAvatar = payload.avatar;
        persistContacts();
      }
      if (state.chatId === from || state.tab === "chats") renderTab();
    }
  } else if (kind === "reaction") {
    applyReaction(from, payload);
  } else if (kind === "contact-card") {
    const c = ensureContactEntry(from, null);
    if (c.messages.some((m) => m.id === payload.id)) return;
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: "", ts: payload.ts || Date.now(), readAckSent: false, deliveryId: envelopeMsgId, contactCard: { id: payload.contactId, name: payload.contactName || "" } };
    if (payload.forwarded) { rec.forwarded = true; if (typeof payload.fwdFrom === "string" && payload.fwdFrom) rec.forwardedFrom = payload.fwdFrom.slice(0, 40); }
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    const previewText = T("chat.contactCard.preview", { name: payload.contactName || T("sys.someone") });
    if (isOpen) { renderChatThread(); playMessageSound(from); vibrate([80, 40, 80]); }
    else {
      toast(`${c.name}: ${previewText}`);
      if (!isContactMuted(c)) showNotification(c.name || T("app.name"), previewText, { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
      playMessageSound(from);
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
  } else if (kind === "group-join-request") {
    // Приглашённый по invite-ссылке (см. joinGroupViaInvite) просит
    // добавить его в группу. Генерировать ссылку мог только админ (кнопка
    // скрыта у остальных в openGroupInfo), но проверяем права здесь ещё
    // раз — на случай старого клиента/модифицированного кода, а не
    // доверяем одной лишь UI-видимости кнопки на другой стороне.
    const g = state.contacts.get(payload.groupId);
    if (!g || !g.isGroup || !isGroupAdmin(g, Store.myId)) return;
    if (g.members.some((m) => m.id === from)) return; // уже участник — дублирующийся запрос
    if (g.members.length >= MAX_GROUP_MEMBERS) return;
    ensureContactEntry(from, payload.requesterName || null);
    addGroupMember(payload.groupId, from);
    try { if (typeof fxReferralInviterHit === "function") fxReferralInviterHit(from); } catch (e) {}
  } else if (kind === "heartbeat") {
    // killer-features-backlog 0.5 — "мягкий" Dead Man's Switch: "я жив",
    // отправляется из checkDeadManSwitch() при каждом запуске отправителя.
    // Полностью тихо — ни сообщения в ленте, ни тоста, ни бейджа
    // непрочитанного: получатель узнаёт об этом только если сам
    // настроил наблюдение и у него сработает проверка в checkDeadManSwitch().
    const c = state.contacts.get(from); if (!c) return;
    c.lastHeartbeatAt = payload.ts || Date.now();
    if (payload.thresholdDays) c.heartbeatThresholdDays = payload.thresholdDays;
    delete c.heartbeatAlertedAt; // новый heartbeat пришёл — отправитель снова "на связи", сбрасываем отметку уже показанного предупреждения
    persistContacts();
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
const relayAttemptCooldown = new Map();
// Прогрессивный cooldown для цели, которую сигнальный сервер только что
// назвал недоступной. Раньше был только плоский relayAttemptCooldown=60с,
// и в группах с офлайн-участниками это давало лавину попыток каждые
// несколько секунд (видно в логах: [signaling] недоступен: dd7315da01…
// раз в 200мс). Теперь cooldown растёт: 60с → 5мин → 30мин.
const _unreachableCooldown = new Map(); // id -> { until, failures }
function isUnreachableCooldown(id) {
  const entry = _unreachableCooldown.get(id);
  if (!entry) return false;
  return Date.now() < entry.until;
}
function markUnreachable(id) {
  const now = Date.now();
  const entry = _unreachableCooldown.get(id) || { failures: 0 };
  entry.failures = (entry.failures || 0) + 1;
  const delay = entry.failures === 1 ? 60_000
              : entry.failures === 2 ? 5 * 60_000
              : 30 * 60_000;
  entry.until = now + delay;
  _unreachableCooldown.set(id, entry);
}
function clearUnreachable(id) {
  if (_unreachableCooldown.delete(id)) {
    etherLog("info", "[connect] " + String(id).slice(0, 10) + "…", "cooldown сброшен (presence online)");
  }
}
// Увеличено с 15с до 60с: реальный провал relay (цель не в сети у хаба)
// выясняется за 10-20 секунд. Пока не пройдёт минута, повторять
// бессмысленно — только плодим мёртвые PeerLink'и, которые висят в
// "connecting" и засоряют diagnostics.
const RELAY_COOLDOWN_MS = 60000;

async function attemptConnectViaRelay(targetId) {
  const existing = mesh.get(targetId);
  if (existing && existing.status !== "disconnected") return;
  if (_connectInFlight.has(targetId)) return;
  const lastTry = relayAttemptCooldown.get(targetId);
  if (lastTry && Date.now() - lastTry < RELAY_COOLDOWN_MS) return;
  // Помечаем попытку СРАЗУ — раньше cooldown ставился только когда
  // не было ни одного relay-контакта, а при НАЛИЧИИ relay мы пробовали
  // снова и снова каждые 4 секунды (scheduleAutoConnect), плодя
  // PeerLink'и на заведомо недостижимые цели.
  relayAttemptCooldown.set(targetId, Date.now());
  const relays = Array.from(mesh.links.entries()).filter(([rid, l]) => rid !== targetId && l.status === "connected");
  if (relays.length === 0) return;
  _connectInFlight.add(targetId);
  try {
    const link = mesh.createOutgoingLink(targetId);
    flushPendingIceFor(targetId, link);
    const packet = await link.createInitialOffer("");
    if (!packet) { mesh.remove(targetId); return; }
    // Сначала просто send relay-request всем connected-relay'ям.
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
  const delay = connectRetryDelayMs(id);
  // Только одна отложенная попытка на контакт (было: немедленная +
  // ещё одна через 4с). Короткая задержка нужна, чтобы дать встречной
  // стороне тоже увидеть presence — тогда тай-брейк по id отработает
  // за нас и мы избежим столкновения двух offer'ов. При presence
  // нескольких контактов одновременно (например, сразу после
  // входа в группу) немедленный вызов давал всплеск PeerLink'ов.
  if (autoConnectTimers.has(id)) return;
  autoConnectTimers.set(id, setTimeout(() => {
    autoConnectTimers.delete(id);
    attemptConnect(id);
    attemptConnectViaRelay(id).catch(() => {});
  }, delay));
}
const _notMyTurnLogAt = new Map();

async function attemptConnect(id, force) {
  const tag = String(id).slice(0, 10) + "…";
  if (!signaling || !signaling.connected) return;
  if (!onlineSet.has(id) && !force) return;
  if (!force && isUnreachableCooldown(id)) return;
  const iShouldOffer = Store.myId < id;
  if (!iShouldOffer && !force) {
    const last = _notMyTurnLogAt.get(id);
    if (!last || Date.now() - last > 30000) {
      _notMyTurnLogAt.set(id, Date.now());
      etherLog("info", "[connect] " + tag, "not my turn");
    }
    return;
  }
  if (_connectInFlight.has(id)) return;
  _connectInFlight.add(id);
  try {
    const existing = mesh.get(id);
    if (existing) {
      const age = Date.now() - (existing._createdAt || 0);
      if (existing.status === "connected" || existing.status === "in-call") return;
      if (!force && existing.status === "connecting" && age < CONNECT_STUCK_MS) return;
      mesh.remove(id);
    }
    const link = mesh.createOutgoingLink(id);
    flushPendingIceFor(id, link);
    try {
      const packet = await link.createInitialOffer("");
      if (!packet) return;
      // Результат signal() раньше игнорировался молча — если WS в этот
      // момент отвалился, offer просто терялся без следа в диагностике,
      // и единственным симптомом было "почему-то не подключается".
      if (!signaling.signal(id, packet)) etherLog("warn", "[connect] " + tag, "signal офера не отправлен (WS не готов)");
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
  // Следим именно за ЭТИМ экземпляром линка. Раньше таймер смотрел на mesh.get(id) в момент срабатывания:
  // если за 10 с линк уже был заменён новой попыткой, таймер убивал свежий, ещё нормально
  // подключающийся линк — отсюда пары «offer, и через 0,8 с ещё один» и вечный цикл переподключений.
  const watched = mesh.get(id);
  setTimeout(() => {
    const link = mesh.get(id);
    if (!link || link !== watched || link.status === "connected" || link.status === "in-call" || link.status === "disconnected") return;
    connectFails.set(id, (connectFails.get(id) || 0) + 1);
    etherLog("info", "[connect] " + String(id).slice(0, 10) + "…", "не подключились, неудач подряд: " + connectFails.get(id) + "; следующая попытка через " + Math.round(connectRetryDelayMs(id) / 1000) + " с");
    mesh.remove(id);
    const c = state.contacts.get(id);
    if (c) {
      c.status = "disconnected";
      if (state.chatId === id) renderChatThread();
      if (state.tab === "chats") renderChatsList();
      if (c.managed && c.online) scheduleAutoConnect(id);
    }
  }, connectWaitMs(id) + (watched && watched._relayOnly ? 14000 : 0));
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
      if (recentlyDeletedIds.delete(id)) persistRecentlyDeleted(); // осознанное повторное добавление снимает блокировку из deleteContact
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
// Вынесено из renderMyQrCode() в V.52.0.0 — та же отрисовка нужна и на
// слайде 4 онбординга (см. renderOnboardingReadySlide), не только в
// шторке "My QR code". По умолчанию кодирует свой собственный add-код
// (как и раньше); необязательный payload (V.55.0.0) позволяет рисовать
// QR с произвольной полезной нагрузкой — используется для invite-ссылки
// в группу (см. openGroupInviteSheet), которая кодирует не "свой" код.
function renderQrToCanvas(canvas, payload) {
  if (!canvas || typeof qrcode !== "function") return;
  if (!payload) payload = "ether://add?id=" + encodeURIComponent(Store.myId) + "&name=" + encodeURIComponent(Store.name || "");
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
function renderMyQrCode() { renderQrToCanvas($("#my-qr-canvas")); }
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
          // Invite-ссылка в группу (раздел 8/18) — та же камера сканирует
          // и её, не только обычный add-код; см. parseGroupInviteCode.
          if (parseGroupInviteCode(result.data)) {
            stopQrScan();
            if (sheet) sheet.classList.add("hidden");
            joinGroupViaInvite(result.data);
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
  const avatarBtn = $("#group-info-avatar-btn");
  const avatarInput = $("#group-info-avatar-input");
  if (avatarBtn && avatarInput) {
    avatarBtn.addEventListener("click", () => avatarInput.click());
    avatarInput.addEventListener("change", async () => {
      const file = avatarInput.files && avatarInput.files[0];
      avatarInput.value = "";
      const groupId = state.activeGroupContext; if (!file || !groupId) return;
      try {
        const dataUrl = await readImageAsAvatarDataUrl(file);
        setGroupAvatar(groupId, dataUrl);
        avatarBtn.style.backgroundImage = `url('${dataUrl}')`; avatarBtn.style.background = ""; avatarBtn.textContent = "";
      } catch (e) { toast(T("toast.avatarFailed")); }
    });
  }
  const renameInput = $("#group-info-name");
  const renameBtn = $("#group-info-rename-btn");
  if (renameBtn) renameBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; if (!groupId) return;
    renameGroup(groupId, renameInput ? renameInput.value : "");
    toast(T("toast.saved"));
  });
  const descInput = $("#group-info-description");
  const descBtn = $("#group-info-description-btn");
  if (descBtn) descBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; if (!groupId) return;
    setGroupDescription(groupId, descInput ? descInput.value : "");
    toast(T("toast.saved"));
  });
  const callBtn = $("#group-info-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => { const gid = state.activeGroupContext; if (gid && typeof startGroupCall === "function") startGroupCall(gid, false); else toast(T("toast.callGroupsUnsupported")); });
  const writeRestrictedEl = $("#group-info-write-restricted");
  if (writeRestrictedEl) writeRestrictedEl.addEventListener("change", () => {
    const groupId = state.activeGroupContext; if (!groupId) return;
    setGroupWriteRestricted(groupId, writeRestrictedEl.checked);
  });
  const addBtn = $("#group-info-add-btn");
  if (addBtn) addBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; const g = state.contacts.get(groupId);
    if (!g) return;
    if (g.members.length >= MAX_GROUP_MEMBERS) { toast(T("toast.groupTooBig", { max: MAX_GROUP_MEMBERS })); return; }
    const list = $("#forward-list"); if (!list) return;
    list.innerHTML = "";
    const memberIds = new Set(g.members.map((m) => m.id));
    const candidates = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c) && !c.isSelf && !memberIds.has(c.id));
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
  if (leaveBtn) leaveBtn.addEventListener("click", async () => {
    const groupId = state.activeGroupContext; const g = state.contacts.get(groupId);
    if (!g) return;
    if (!await confirmSheet(T("group.confirmLeave", { name: g.name }))) return;
    removeGroupMember(groupId, Store.myId, true);
    const gis = $("#group-info-sheet"); if (gis) gis.classList.add("hidden");
    if (state.chatId === groupId) { state.chatId = null; state.multiSelect = null; renderTab(); }
  });
  const inviteLinkBtn = $("#group-info-invite-link-btn");
  if (inviteLinkBtn) inviteLinkBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; if (!groupId) return;
    openGroupInviteSheet(groupId);
  });
  const giCopyCode = $("#group-invite-copy-btn");
  if (giCopyCode) giCopyCode.addEventListener("click", () => { const el = $("#group-invite-code-out"); if (el) copyText(el.textContent, T("toast.codeCopied")); });
}

function wireConnectScreen() {
  state._newGroupAvatar = null;
  const newGroupAvatarBtn = $("#new-group-avatar-btn");
  const newGroupAvatarInput = $("#new-group-avatar-input");
  if (newGroupAvatarBtn && newGroupAvatarInput) {
    newGroupAvatarBtn.addEventListener("click", () => newGroupAvatarInput.click());
    newGroupAvatarInput.addEventListener("change", async () => {
      const file = newGroupAvatarInput.files && newGroupAvatarInput.files[0];
      newGroupAvatarInput.value = "";
      if (!file) return;
      try {
        const dataUrl = await readImageAsAvatarDataUrl(file);
        state._newGroupAvatar = dataUrl;
        newGroupAvatarBtn.style.backgroundImage = `url('${dataUrl}')`; newGroupAvatarBtn.style.background = ""; newGroupAvatarBtn.innerHTML = "";
      } catch (e) { toast(T("toast.avatarFailed")); }
    });
  }
  const contactsSearch = $("#contacts-search");
  if (contactsSearch) contactsSearch.addEventListener("input", (e) => { state.contactsSearchQuery = e.target.value; renderContactsList(); });
  // Импорт из адресной книги (раздел 8/18 роадмапа) — navigator.contacts
  // (Contact Picker API) экспериментальный и доступен не везде (в основном
  // Chrome/Edge на Android) — классический progressive enhancement: кнопка
  // скрыта по умолчанию и появляется только там, где API реально есть, а
  // не обещана как гарантированная. У «Эфира» нет справочника
  // телефон↔публичный ключ (контакт добавляется только по его
  // invite-коду/QR) — поэтому выбор из телефонной книги подставляет
  // ТОЛЬКО имя, не сам id; это честно объясняется тостом сразу после
  // выбора, а не выдаётся за полноценное "добавить одним тапом".
  const importContactBtn = $("#import-contact-btn");
  if (importContactBtn && navigator.contacts && navigator.contacts.select) {
    importContactBtn.classList.remove("hidden");
    importContactBtn.addEventListener("click", async () => {
      let picked;
      try { picked = await navigator.contacts.select(["name"], { multiple: false }); }
      catch (e) { return; } // отмена выбора или отказ в доступе — ожидаемый путь, не ошибка
      const contact = picked && picked[0];
      const name = contact && Array.isArray(contact.name) && contact.name[0];
      if (!name) return;
      const nameInput = $("#add-contact-name"); if (nameInput) nameInput.value = name;
      toast(T("toast.importContactNameOnly"));
      const valueInput = $("#add-contact-value"); if (valueInput) valueInput.focus();
    });
  }
  const newGroupBtn = $("#new-group-btn");
  if (newGroupBtn) newGroupBtn.addEventListener("click", () => {
    state._newGroupAvatar = null;
    if (newGroupAvatarBtn) { newGroupAvatarBtn.style.backgroundImage = ""; newGroupAvatarBtn.style.background = "var(--accent)"; newGroupAvatarBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M11 5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5z"/></svg>'; }
    const nameInput = $("#new-group-name"); if (nameInput) nameInput.value = "";
    const list = $("#new-group-members");
    if (list) {
      list.innerHTML = "";
      const candidates = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c) && !c.isSelf);
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
    const groupId = createGroup(name, checked, state._newGroupAvatar);
    if (!groupId) return;
    const sheet = $("#new-group-sheet"); if (sheet) sheet.classList.add("hidden");
    state.chatId = groupId;
    renderTab();
  });
  const addBtn = $("#add-contact-btn");
  const addValEl = $("#add-contact-value");
  if (addValEl) addValEl.addEventListener("input", () => {
    const v = addValEl.value.trim();
    if (!v) { addValEl.classList.remove("input-invalid"); return; }
    // Invite-ссылка в группу (раздел 8/18) вставляется в то же самое
    // поле, что и обычный id/email/телефон — она заведомо не пройдёт
    // Identity.idFor (это не контактный идентификатор), так что проверяем
    // её отдельно, иначе поле подсвечивалось бы красным на валидном коде.
    if (v.indexOf("ether://group?") === 0) { addValEl.classList.remove("input-invalid"); return; }
    Identity.idFor(v).then(
      () => addValEl.classList.remove("input-invalid"),
      () => addValEl.classList.add("input-invalid")
    );
  });
  if (addBtn) addBtn.addEventListener("click", async () => {
    const nameVal = $("#add-contact-name").value.trim();
    const raw = $("#add-contact-value").value.trim();
    if (!raw) { toast(T("toast.emptyId")); return; }
    if (raw.indexOf("ether://group?") === 0) {
      await joinGroupViaInvite(raw);
      $("#add-contact-name").value = ""; $("#add-contact-value").value = "";
      return;
    }
    let identity;
    try { identity = await Identity.idFor(raw); }
    catch (e) { toast(T(e.message)); if (addValEl) addValEl.classList.add("input-invalid"); return; }
    if (identity.id === Store.myId) { toast(T("toast.ownId")); return; }
    if (state.contacts.has(identity.id)) toast(T("toast.alreadyAdded"));
    else {
      if (recentlyDeletedIds.delete(identity.id)) persistRecentlyDeleted(); // осознанное повторное добавление снимает блокировку из deleteContact
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
  // Временный контакт (managed:false, status:"awaiting-answer"/"connecting")
  // создаётся в createInvite() под тем же id, что лежит в
  // state.pendingOutgoing. Раньше при отмене приглашения ("Начать
  // заново") эта запись просто оставалась висеть в state.contacts
  // навсегда (в памяти — на persist она и так не шла, но накапливалась
  // при многократных отменах). Проверяем именно status !== "connected":
  // этот же resetConnectScreen() вызывается и при УСПЕШНОМ подключении
  // (см. wireMeshEvents), где контакт уже настоящий — его трогать нельзя.
  if (state.pendingOutgoing) {
    const c = state.contacts.get(state.pendingOutgoing.id);
    if (c && !c.managed && c.status !== "connected" && c.status !== "in-call") {
      state.contacts.delete(state.pendingOutgoing.id);
    }
  }
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
  if (navigator.clipboard) {
    try { navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => toast(T("toast.copyFailed"))); }
    catch (e) { toast(T("toast.copyFailed")); }
  }
  else {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = !!(document.execCommand && document.execCommand("copy")); } catch (e) {}
    // execCommand не бросает при неудаче, а возвращает false — раньше тут всегда показывалось «скопировано».
    toast(ok ? msg : T("toast.copyFailed"));
    ta.remove();
  }
}

// =====================================================================
// Шиты
// =====================================================================
function wireCameraButton() {
  // Кнопка "Камера" в чате открывает СИСТЕМНУЮ камеру через
  // <input type="file" accept="image/*" capture="environment">
  // (обработчик change для #chat-camera-input подключён отдельно, в
  // startApp). Самодельный виджет-камера (запись видео, flip, таймер)
  // был удалён как мёртвый код: он нигде не вызывался, а видеозвонки
  // используют PeerLink.enableVideo() напрямую, без этого виджета.
  const openBtn = $("#chat-camera-btn");
  const cameraInput = $("#chat-camera-input");
  if (!cameraInput || !openBtn) return;
  openBtn.addEventListener("click", () => {
    if (!state.chatId) return;
    cameraInput.value = "";
    cameraInput.click();
  });
}
// =====================================================================
// Единое подтверждение необратимых действий (раздел 15 роадмапа, "мои
// добавления" — "единообразный паттерн подтверждающего шторки, а не
// confirm()"). native confirm() блокирует весь поток JS, выглядит
// по-разному на каждой платформе и не поддаётся кастомному стилю — заменён
// везде в этом релизе на один переиспользуемый #confirm-sheet. Промис-
// обёртка — тот же приём, что уже был у openBackupPasswordSheet() (см.
// ниже по файлу): MutationObserver перехватывает закрытие ЛЮБЫМ путём
// (backdrop, Esc через общий wireEscCloseAnySheet, фокус-менеджмент), а
// не только через свои кнопки — иначе промис мог бы повиснуть навечно,
// если пользователь закрыл шторку мимо кнопок.
let __confirmSheetResolve = null;
function confirmSheet(message, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const sheet = $("#confirm-sheet");
    if (!sheet) { resolve(false); return; } // шторки нет в DOM (не должно случаться) — не блокируем действие молча навсегда
    __confirmSheetResolve = resolve;
    const msgEl = $("#confirm-sheet-message"); if (msgEl) msgEl.textContent = message;
    const okBtn = $("#confirm-sheet-ok"); if (okBtn) okBtn.classList.toggle("destructive", !!opts.destructive);
    sheet.classList.remove("hidden");
  });
}
let __confirmSheetWired = false;
// edit/delete с payload.groupId применяются к группе (и только если
// отправитель — её участник), иначе — к 1:1 чату с отправителем.
function resolveEditDeleteTarget(from, payload) {
  if (payload && payload.groupId) {
    const g = state.contacts.get(payload.groupId);
    if (!g || !isGroup(g) || !Array.isArray(g.members) || !g.members.some((m) => m.id === from)) return null;
    return g;
  }
  return ensureContactEntry(from, null);
}
function wireConfirmSheet() {
  if (__confirmSheetWired) return;
  __confirmSheetWired = true;
  const sheet = $("#confirm-sheet"); if (!sheet) return;
  const okBtn = $("#confirm-sheet-ok");
  const cancelBtn = $("#confirm-sheet-cancel");
  const settle = (result) => {
    const resolve = __confirmSheetResolve;
    if (!resolve) return; // уже резолвлено
    __confirmSheetResolve = null;
    sheet.classList.add("hidden");
    resolve(result);
  };
  if (okBtn) okBtn.addEventListener("click", () => settle(true));
  if (cancelBtn) cancelBtn.addEventListener("click", () => settle(false));
  // wireSheetBackdrops/wireEscCloseAnySheet подключаются только в
  // startApp() — на экране блокировки их ещё нет.
  const backdrop = sheet.querySelector(".sheet-backdrop");
  if (backdrop) backdrop.addEventListener("click", () => settle(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.classList.contains("hidden")) settle(false);
  });
  new MutationObserver(() => {
    if (sheet.classList.contains("hidden")) settle(false); // любое другое закрытие — считаем отменой, не подтверждением
  }).observe(sheet, { attributes: true, attributeFilter: ["class"] });
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
let __quickReactionOutsideHandler = null;
function closeQuickReactionFlyout() {
  const el = $("#quick-reaction-flyout"); if (!el) return;
  el.classList.remove("quick-reaction-flyout-show");
  el.classList.add("hidden");
  el.innerHTML = "";
  if (__quickReactionOutsideHandler) { document.removeEventListener("pointerdown", __quickReactionOutsideHandler, true); __quickReactionOutsideHandler = null; }
}
// Лёгкая плывущая панель реакций над пузырём — см. комментарий у
// #quick-reaction-flyout в index.html. Открывается ТОЛЬКО из long-press
// в 1-к-1 чатах (группы по-прежнему идут прямо в openMessageSheet).
function openQuickReactionFlyout(anchorEl, msgId, contactId) {
  const el = $("#quick-reaction-flyout"); if (!el || !anchorEl) return;
  closeQuickReactionFlyout();
  const DEFAULT_QUICK_REACTIONS = ["❤️", "👍", "👎", "😂", "😮", "😢"];
  const recent = Store.recentReactions;
  const quickSet = (recent.length > 0 ? recent : DEFAULT_QUICK_REACTIONS).slice(0, 6);
  quickSet.forEach((emoji) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "reaction-emoji"; b.textContent = emoji;
    b.addEventListener("click", () => {
      closeQuickReactionFlyout();
      toggleReaction(contactId, msgId, emoji);
      spawnReactionBurst(anchorEl, emoji);
    });
    el.appendChild(b);
  });
  const moreBtn = document.createElement("button");
  moreBtn.type = "button"; moreBtn.className = "reaction-emoji reaction-more";
  moreBtn.setAttribute("aria-label", T("chat.moreActions"));
  moreBtn.textContent = "…";
  moreBtn.addEventListener("click", () => { closeQuickReactionFlyout(); openMessageSheet(msgId, contactId); });
  el.appendChild(moreBtn);

  // Позиционирование: по умолчанию прямо над пузырём, по центру; если
  // сверху не хватает места (сообщение у самого верха экрана) — под
  // пузырём. Горизонтально зажато в границы #app-shell — на десктопной
  // раскладке (см. @media min-width:640px выше) это не весь экран, а
  // центрированная «рамка телефона».
  el.classList.remove("hidden");
  const shell = $("#app-shell");
  const shellRect = shell ? shell.getBoundingClientRect() : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
  const anchorRect = anchorEl.getBoundingClientRect();
  const flyoutRect = el.getBoundingClientRect();
  let top = anchorRect.top - flyoutRect.height - 10;
  if (top < shellRect.top + 8) top = anchorRect.bottom + 10;
  let left = anchorRect.left + anchorRect.width / 2 - flyoutRect.width / 2;
  left = Math.max(shellRect.left + 8, Math.min(left, shellRect.right - flyoutRect.width - 8));
  el.style.top = top + "px";
  el.style.left = left + "px";
  requestAnimationFrame(() => el.classList.add("quick-reaction-flyout-show"));

  // capture + отдельный тик: иначе тот самый pointerdown, которым
  // закончилось долгое нажатие, немедленно закрыл бы панель, которую он
  // только что открыл.
  __quickReactionOutsideHandler = (e) => { if (!el.contains(e.target)) closeQuickReactionFlyout(); };
  setTimeout(() => { document.addEventListener("pointerdown", __quickReactionOutsideHandler, true); }, 0);
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
        // «+» открывает тот же полный пикер, что и в композере (общий набор, поиск, тон кожи) — выбранный эмодзи ставится реакцией
        const ms = $("#message-sheet"); if (ms) ms.classList.add("hidden");
        openEmojiPicker({ closeOnPick: true, onPick: (emoji) => { recordRecentReaction(emoji); toggleReaction(contactId, msgId, emoji); } });
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
  if (true) actions.push(`<button type="button" class="sheet-action" data-action="forward">${escapeHtml(T("chat.forward"))}</button>`);
  actions.push(`<button type="button" class="sheet-action" data-action="pin">${escapeHtml(c.pinnedMessageId === msgId ? T("chat.unpinMsg") : T("chat.pinMsg"))}</button>`);
  actions.push(`<button type="button" class="sheet-action" data-action="favorite">${escapeHtml(m.favorite ? T("chat.unfavorite") : T("chat.favorite"))}</button>`);
  // Перевод — чисто локальное действие (fetch на сервер, выбранный самим
  // пользователем, никакого P2P-payload) — доступно и в группах, и для
  // своих, и для чужих сообщений, было бы текста. Файлы/карточки контакта
  // переводить нечего.
  if (m.text && !m.file && !m.contactCard) actions.push(`<button type="button" class="sheet-action" data-action="translate">${escapeHtml(m.translation ? T("chat.translate.hide") : T("chat.translate"))}</button>`);
  actions.push(`<button type="button" class="sheet-action" data-action="copy">${escapeHtml(T("chat.copy"))}</button>`);
  actions.push(`<button type="button" class="sheet-action" data-action="select">${escapeHtml(T("chat.selectMsgs"))}</button>`);
  if (m.ack === "failed" && isOwn && !groupCtx) actions.push(`<button type="button" class="sheet-action" data-action="retry">${escapeHtml(T("chat.retry"))}</button>`);
  if (isOwn) {
    if (!groupCtx && !m.file && !m.contactCard) actions.push(`<button type="button" class="sheet-action" data-action="edit">${escapeHtml(T("chat.edit"))}</button>`);
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
    if (!await confirmSheet(T("chat.delete.both") + "?", { destructive: true })) return;
    await deleteMessageForBoth(contactId, msgId);
  } else if (action === "reply") {
    state.replyTo = { msgId: m.id, text: m.text, from: m.from, authorName: m.from === "me" ? (Store.name || "") : (m.fromName || c.name || "") };
    showReplyBanner();
    const inp = $("#chat-input"); if (inp) inp.focus();
  } else if (action === "forward") openForwardSheet((toId) => forwardMessage(msgId, contactId, toId));
  else if (action === "retry") retryMessage(contactId, msgId);
  else if (action === "pin") togglePinnedMessage(contactId, msgId);
  else if (action === "select") enterMultiSelect(msgId);
  else if (action === "favorite") toggleMessageFavorite(contactId, msgId);
  else if (action === "translate") translateMessage(contactId, msgId);
}
function toggleMessageFavorite(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  m.favorite = !m.favorite;
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  updateFavoritesCount();
  toast(m.favorite ? T("toast.favoriteAdded") : T("toast.favoriteRemoved"));
}
// =====================================================================
// Перевод сообщений через сервер (раздел 5 роадмапа)
// =====================================================================
// On-device перевод (Chrome Translator API) — Chrome-only экспериментальный
// API за флагом, недоступен в Safari/Firefox/большинстве мобильных
// браузеров (см. раздел 14/16) — не годится как основной путь для
// приложения на 72 языках. Поэтому основной путь — серверный, через любой
// LibreTranslate-совместимый эндпоинт, который пользователь укажет сам в
// Settings (по умолчанию DEFAULT_TRANSLATE_ENDPOINT, см. Store.translateEndpoint) — текст
// сообщения уходит именно на этот сервер в открытом виде, точно так же,
// как ссылка уходит на сигнальный сервер для link-preview, и это явно
// объясняется рядом с полем в Settings, а не скрывается.
const _translateInFlight = new Set();
async function translateMessage(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m || !m.text) return;
  if (m.translation) { // повторный тап на уже переведённом — скрыть перевод, не перезапрашивать
    delete m.translation;
    if (state.chatId === contactId) renderChatThreadInner();
    return;
  }
  const endpoint = Store.translateEndpoint;
  if (!endpoint) { toast(T("toast.translateNoServer")); return; }
  if (_translateInFlight.has(msgId)) return;
  _translateInFlight.add(msgId);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ q: m.text, source: "auto", target: (I18N.current || "en").split("-")[0], format: "text" }, Store.translateApiKey ? { api_key: Store.translateApiKey } : {})),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error("http " + res.status);
    const data = await res.json();
    const translated = data && (data.translatedText || data.translated_text);
    if (!translated || typeof translated !== "string") throw new Error("empty");
    m.translation = { text: translated };
    if (state.chatId === contactId) renderChatThreadInner();
  } catch (e) {
    toast(T("toast.translateFailed"));
  } finally {
    _translateInFlight.delete(msgId);
  }
}
function updateFavoritesCount() {
  const el = $("#settings-favorites-count"); if (!el) return;
  let n = 0;
  for (const c of state.contacts.values()) for (const m of c.messages) if (m.favorite) n++;
  el.textContent = n > 0 ? String(n) : "";
}
// Шторка "Избранные сообщения" в Settings — собирает m.favorite из ВСЕХ
// чатов (не только текущего), иначе звёздочка на пузыре была бы
// фичей без единой точки, где эти сообщения реально можно найти позже.
function openFavoritesSheet() {
  const list = $("#favorites-list"); if (!list) return;
  list.innerHTML = "";
  const rows = [];
  for (const c of state.contacts.values()) {
    for (const m of c.messages) {
      if (m.favorite) rows.push({ contactId: c.id, contactName: c.name || T("sys.someone"), msg: m });
    }
  }
  rows.sort((a, b) => b.msg.ts - a.msg.ts);
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fine muted";
    empty.textContent = T("settings.favorites.empty");
    list.appendChild(empty);
  }
  for (const row of rows) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "forward-row";
    const snippet = row.msg.file ? T("chat.file.preview." + row.msg.file.kind) : truncate(row.msg.text || "", 60);
    btn.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(row.contactName)}">${escapeHtml(initials(row.contactName))}</div><span class="forward-name">${escapeHtml(row.contactName)}<br><span class="fine muted">${escapeHtml(snippet)}</span></span>`;
    btn.addEventListener("click", () => {
      const fs = $("#favorites-sheet"); if (fs) fs.classList.add("hidden");
      jumpToMessageInChat(row.contactId, row.msg.id);
    });
    list.appendChild(btn);
  }
  const fs = $("#favorites-sheet"); if (fs) fs.classList.remove("hidden");
}
function jumpToMessageInChat(contactId, msgId) {
  state.chatId = contactId;
  state.contactCardId = null;
  state.tab = "chats";
  renderTab();
  requestAnimationFrame(() => {
    const wrap = $("#chat-messages");
    const targetEl = wrap && wrap.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      targetEl.classList.add("highlight-origin");
      setTimeout(() => targetEl.classList.remove("highlight-origin"), 1500);
    }
  });
}
// P2 — мультивыбор сообщений: долгое нажатие → меню → "Выбрать" входит в
// режим, дальнейшие тапы по пузырям переключают выбор вместо обычного
// действия. Шапка (#multiselect-banner) показывает счётчик и действия
// над выбранными разом (удалить у себя / переслать).
function enterMultiSelect(firstMsgId) {
  state.multiSelect = new Set([firstMsgId]);
  renderChatThreadInner();
}
function exitMultiSelect() {
  state.multiSelect = null;
  renderChatThreadInner();
}
function toggleMultiSelectMsg(msgId) {
  if (!state.multiSelect) return;
  if (state.multiSelect.has(msgId)) state.multiSelect.delete(msgId); else state.multiSelect.add(msgId);
  if (state.multiSelect.size === 0) { exitMultiSelect(); return; }
  renderChatThreadInner();
}
function updateMultiSelectBanner() {
  const banner = $("#multiselect-banner");
  if (!banner) return;
  const active = !!state.multiSelect;
  banner.classList.toggle("hidden", !active);
  if (active) { const countEl = $("#multiselect-count"); if (countEl) countEl.textContent = String(state.multiSelect.size); }
}
// P2 — закреплённое сообщение чата (в отличие от уже реализованного
// закрепления ЧАТА в списке — chats.pin). Одно закреплённое сообщение на
// чат, показывается плашкой над лентой; тап по плашке прокручивает к
// оригиналу.
function togglePinnedMessage(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  c.pinnedMessageId = c.pinnedMessageId === msgId ? null : msgId;
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
}
// Вынесена из handleMessageAction("retry", ...) в отдельную функцию —
// нужна и для одиночного повтора из меню сообщения, и для кнопки
// "Повторить всё" в шапке чата (P1.15), которая обходит все failed
// сообщения разом.
async function retryMessage(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  m.serverAcked = false;
  m.ack = "sent";
  if (outbox.has(msgId)) outbox.delete(msgId);

  // Файл/голосовое: собираем Blob из IndexedDB и формируем полный
  // file-payload (тот же формат, что в sendFileOffline/sendVoiceOffline).
  // Пустой text тут не годится — собеседник получил бы пустышку.
  if (m.file) {
    try {
      const blob = await IDB.get("file:" + msgId);
      if (!blob) {
        toast(T("chat.file.unavailable"));
        m.ack = "failed"; persistContacts();
        if (state.chatId === contactId) renderChatThread();
        return;
      }
      const buffer = await blob.arrayBuffer();
      const payload = {
        kind: "file", id: msgId,
        name: m.file.name || "file",
        mime: m.file.mime || "application/octet-stream",
        size: (Number.isFinite(m.file.size) && m.file.size > 0) ? m.file.size : blob.size,
        dataB64: arrayBufferToBase64(buffer),
      };
      if (m.file.duration != null) payload.duration = m.file.duration;
      if (m.file.caption) payload.caption = m.file.caption;
      await trySendOrQueue(c, msgId, payload);
    } catch (e) {
      etherLog("error", "[retry] file failed:", String(e));
      m.ack = "failed"; persistContacts();
      if (state.chatId === contactId) renderChatThread();
    }
    return;
  }

  // Карточка контакта: повторяем как contact-card, не текстом.
  if (m.contactCard) {
    const payload = {
      kind: "contact-card", id: msgId, ts: m.ts,
      contactId: m.contactCard.id,
      contactName: m.contactCard.name || "",
    };
    trySendOrQueue(c, msgId, payload);
    return;
  }

  // Обычный текст.
  const payload = { kind: "chat", id: msgId, text: m.text, ts: m.ts };
  if (m.replyTo) payload.replyTo = { id: m.replyTo.id, text: m.replyTo.text, authorName: m.replyTo.authorName };
  if (m.ttl) payload.ttl = m.ttl;
  trySendOrQueue(c, msgId, payload);
}
// P1.15 — обходит все failed-сообщения "от меня" в чате и повторяет
// каждое. Отправляются не параллельно, а последовательно (await в
// цикле) — иначе N одновременных retry одного и того же канала наперегонки
// друг с другом ничего хорошего не даёт, а trySendOrQueue и так не
// бесплатен (шифрование на сообщение).
async function retryAllFailed(contactId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const failedIds = c.messages.filter((m) => m.from === "me" && m.ack === "failed").map((m) => m.id);
  for (const id of failedIds) { try { await retryMessage(contactId, id); } catch (e) {} }
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
function openForwardSheet(onPick, titleKey) {
  const list = $("#forward-list"); if (!list) return;
  list.innerHTML = "";
  // Пересылать можно и в группы (где разрешено писать) — раньше список содержал только личные чаты
  const contacts = Array.from(state.contacts.values()).filter((c) => c.managed && (!isGroup(c) || isGroupWriteAllowed(c, Store.myId)));
  for (const c of contacts) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "forward-row";
    btn.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div><span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span>`;
    btn.addEventListener("click", async () => { const fs = $("#forward-sheet"); if (fs) fs.classList.add("hidden"); await onPick(c.id); });
    list.appendChild(btn);
  }
  const fs = $("#forward-sheet"); if (fs) fs.classList.remove("hidden");
  // killer-features-backlog 0.4 (Share Target) переиспользует этот же лист
  // контактов с другим заголовком, вместо отдельной шторки — заголовок
  // возвращаем обратно к "Forward" через data-i18n, поэтому следующий
  // обычный вызов (без titleKey) снова покажет правильный текст сам.
  const titleEl = fs ? fs.querySelector("h2") : null;
  if (titleEl) {
    const key = titleKey || "chat.forward";
    titleEl.setAttribute("data-i18n", key);
    titleEl.textContent = T(key);
  }
}
// P1.14 — что именно сейчас застряло в очереди отправки и почему: две
// разные причины, два разных источника данных. outbox — сообщение ушло
// на сервер-посредник, но ещё нет deliver-ack (сервер его не подтвердил:
// контакт пока не в сети или сам сервер недоступен). pendingNoKey —
// сообщение вообще не могло быть зашифровано, потому что публичный ключ
// собеседника ещё не получен (ждём его следующего выхода на связь).
function renderOutboxSheet() {
  const list = $("#outbox-list"), empty = $("#outbox-empty");
  if (!list) return;
  list.innerHTML = "";
  const rows = [];
  for (const entry of outbox.values()) {
    const c = state.contacts.get(entry.to);
    rows.push({ contactId: entry.to, name: c ? (c.name || T("sys.someone")) : T("sys.someone"), sentAt: entry.sentAt, reasonKey: "outbox.reason.offline" });
  }
  for (const [contactId, items] of pendingNoKey) {
    if (!items || items.length === 0) continue;
    const c = state.contacts.get(contactId);
    rows.push({ contactId, name: c ? (c.name || T("sys.someone")) : T("sys.someone"), sentAt: null, reasonKey: "outbox.reason.noKey", count: items.length });
  }
  rows.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
  if (empty) empty.classList.toggle("hidden", rows.length > 0);
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "outbox-row";
    const timeLabel = row.sentAt ? formatChatListTime(row.sentAt) : "";
    const countLabel = row.count ? ` (${row.count})` : "";
    el.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(row.name)}">${escapeHtml(initials(row.name))}</div>
      <div class="outbox-row-body">
        <span class="outbox-row-name">${escapeHtml(row.name)}${countLabel}</span>
        <span class="outbox-row-meta">${escapeHtml(T(row.reasonKey))}${timeLabel ? " · " + escapeHtml(timeLabel) : ""}</span>
      </div>`;
    list.appendChild(el);
  }
}
function openOutboxSheet() {
  renderOutboxSheet();
  const sheet = $("#outbox-sheet"); if (sheet) sheet.classList.remove("hidden");
}
// P2 — "Прыжок к дате": открывает <input type="date"> в шите, затем
// скроллит к первому сообщению того дня. contactId запоминается на
// шите (data-attribute), потому что к моменту нажатия "Go" пользователь
// теоретически мог успеть закрыть чат (в теории, не на практике — шит
// модальный, но дешевле перестраховаться, чем гадать).
function openJumpToDateSheet(contactId) {
  if (!contactId) return;
  const sheet = $("#jump-date-sheet"); if (!sheet) return;
  sheet.dataset.contactId = contactId;
  const input = $("#jump-date-input");
  if (input) { try { input.valueAsDate = new Date(); } catch (e) {} }
  sheet.classList.remove("hidden");
}
// Долгое нажатие (500мс, тот же тайминг, что и у long-press на пузыре
// сообщения) с отменой при уходе пальца/курсора дальше 8px — сетка эмодзи
// находится внутри скроллящейся шторки, так что наивный таймер без
// отмены на движение ложно срабатывал бы при обычном скролле пальцем.
// Pointer Events — тот же механизм, что уже используется для drag-to-
// reorder закреплённых чатов (V.44.0.0), работает одинаково для мыши
// и тач-экрана без дублирования обработчиков.
function wireHandshakeLongPress(btn, onFire) {
  let timer = null, startX = 0, startY = 0, moved = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  btn.addEventListener("pointerdown", (e) => {
    moved = false;
    startX = e.clientX; startY = e.clientY;
    clear();
    timer = setTimeout(() => { if (!moved) onFire(); }, 500);
  });
  btn.addEventListener("pointermove", (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) { moved = true; clear(); }
  });
  btn.addEventListener("pointerup", clear);
  btn.addEventListener("pointercancel", clear);
}
let __emojiTab = "smileys";      // id категории или "recent"
let __emojiPickHandler = null;   // кто получает выбранный эмодзи: композер (по умолчанию) или реакция на сообщение
let __emojiCloseOnPick = false;
const RECENT_EMOJI_MAX = 32;
function recentEmojiList() {
  try { const a = JSON.parse(Store.recentEmojiJson); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch (e) { return []; }
}
function recordRecentEmoji(base) {
  const cur = recentEmojiList().filter((e) => e !== base);
  cur.unshift(base);
  try { Store.recentEmojiJson = JSON.stringify(cur.slice(0, RECENT_EMOJI_MAX)); } catch (e) {}
}
function emojiTabSource(tab) {
  if (tab === "recent") return recentEmojiList();
  const cat = EMOJI_CATEGORIES.find((x) => x.id === tab);
  return cat ? cat.emojis : [];
}
function pickEmoji(base, rendered) {
  recordRecentEmoji(base);
  const h = __emojiPickHandler;
  if (h) h(rendered, base); else insertEmojiAtCursor(rendered);
  if (__emojiCloseOnPick) { const sh = $("#emoji-picker-sheet"); if (sh) sh.classList.add("hidden"); }
}
function renderEmojiGrid(emojis) {
  const grid = $("#emoji-grid"); if (!grid) return;
  setTimeout(() => { try { updateEmojiToneButton(); } catch (e) {} }, 0);
  const search = $("#emoji-search-input");
  const searching = !!(search && search.value.trim());
  const title = $("#emoji-section-title");
  if (title) title.textContent = searching ? T("emoji.search.results") : T("emoji.cat." + __emojiTab);
  grid.innerHTML = "";
  if (!emojis.length) {
    const p = document.createElement("p"); p.className = "muted emoji-empty"; p.textContent = T(searching ? "emoji.search.none" : "emoji.recent.empty");
    grid.appendChild(p); return;
  }
  for (const e of emojis) {
    // Тон кожи применяется и к отображению, и к вставляемому символу (превью в сетке = то, что получит собеседник);
    // базовый «e» остаётся ключом для поиска и для списка недавних.
    const rendered = applySkinTone(e);
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "emoji-grid-btn"; btn.textContent = rendered;
    if (e === "🤝") {
      // Обычный tap — единый текущий тон; долгое нажатие — шторка выбора ДВУХ разных тонов (buildHandshakeEmoji)
      let longPressFired = false;
      wireHandshakeLongPress(btn, () => { longPressFired = true; openHandshakeToneSheet(); });
      btn.addEventListener("click", () => {
        if (longPressFired) { longPressFired = false; return; }
        pickEmoji(e, rendered);
      });
    } else {
      btn.addEventListener("click", () => pickEmoji(e, rendered));
    }
    grid.appendChild(btn);
  }
}
// Выбор тона кожи: кнопка с рукой справа от поиска раскрывает строку из 6 свотчей; выбор применяется ко всем категориям
// (ко всем эмодзи, которые тон допускают) и сворачивает строку. onChange перерисовывает текущий режим (категория или поиск).
function updateEmojiToneButton() {
  const b = $("#emoji-tone-btn"); if (!b) return;
  b.textContent = applySkinTone("👋");
  // Тон кожи бывает только у эмодзи с людьми и жестами (руки, лица-люди). В «Смайликах», «Еде», «Символах» и т.д. таких нет —
  // кнопку показываем только там, где она реально что-то меняет, чтобы не создавать впечатление «сломанного» переключателя.
  let any = true;
  try { const src = currentEmojiGridSource(); any = Array.isArray(src) ? src.some((e) => emojiSupportsSkinTone(typeof e === "string" ? e : (e && e.e) || "")) : true; } catch (e) {}
  b.classList.toggle("hidden", !any);
  if (!any) { const row = $("#emoji-skin-tone-row"); if (row) row.classList.add("hidden"); b.setAttribute("aria-expanded", "false"); }
}
function renderSkinToneRow(onChange) {
  const row = $("#emoji-skin-tone-row"); if (!row) return;
  row.innerHTML = "";
  const current = Store.emojiSkinTone;
  for (const tone of SKIN_TONE_MODIFIERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skin-tone-swatch" + (tone.id === current ? " active" : "");
    btn.style.background = tone.swatch;
    btn.setAttribute("aria-label", T("chat.emoji.skinTone." + tone.id));
    btn.addEventListener("click", () => {
      Store.emojiSkinTone = tone.id;
      renderSkinToneRow(onChange);
      updateEmojiToneButton();
      row.classList.add("hidden");
      const tb = $("#emoji-tone-btn"); if (tb) tb.setAttribute("aria-expanded", "false");
      onChange();
    });
    row.appendChild(btn);
  }
}
// Раздел 11 роадмапа — двусторонний skin-tone для 🤝. Общая функция для
// обеих рук (параметр which: "a"/"b") — ровно тот же паттерн свотчей, что
// и renderSkinToneRow(), только пишет в локальное состояние шторки
// (__handshakeToneA/B), а не в Store, потому что это одноразовый выбор
// для конкретной вставки эмодзи, а не постоянная глобальная настройка.
let __handshakeToneA = "none";
let __handshakeToneB = "none";
function renderHandshakeToneRow(which) {
  const row = $("#handshake-tone-row-" + which); if (!row) return;
  row.innerHTML = "";
  const current = which === "a" ? __handshakeToneA : __handshakeToneB;
  for (const tone of SKIN_TONE_MODIFIERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skin-tone-swatch" + (tone.id === current ? " active" : "");
    btn.style.background = tone.swatch;
    btn.setAttribute("aria-label", T("chat.emoji.skinTone." + tone.id));
    btn.addEventListener("click", () => {
      if (which === "a") __handshakeToneA = tone.id; else __handshakeToneB = tone.id;
      renderHandshakeToneRow(which);
      updateHandshakeTonePreview();
    });
    row.appendChild(btn);
  }
}
function updateHandshakeTonePreview() {
  const prev = $("#handshake-tone-preview"); if (prev) prev.textContent = buildHandshakeEmoji(__handshakeToneA, __handshakeToneB);
}
// Открывается долгим нажатием на 🤝 в сетке (см. renderEmojiGrid). Каждая
// рука по умолчанию стартует с уже выбранного общего тона (Store.emojiSkinTone)
// — большинству пользователей, скорее всего, нужен всего один "неодинаковый"
// случай, а не обе руки с нуля на "none" при каждом открытии.
function openHandshakeToneSheet() {
  __handshakeToneA = Store.emojiSkinTone;
  __handshakeToneB = Store.emojiSkinTone;
  renderHandshakeToneRow("a");
  renderHandshakeToneRow("b");
  updateHandshakeTonePreview();
  const sheet = $("#handshake-tone-sheet"); if (sheet) sheet.classList.remove("hidden");
}
let __handshakeToneSheetWired = false;
function wireHandshakeToneSheet() {
  if (__handshakeToneSheetWired) return;
  __handshakeToneSheetWired = true;
  const sheet = $("#handshake-tone-sheet"); if (!sheet) return;
  const insertBtn = $("#handshake-tone-insert");
  if (insertBtn) insertBtn.addEventListener("click", () => {
    pickEmoji("🤝", buildHandshakeEmoji(__handshakeToneA, __handshakeToneB));
    sheet.classList.add("hidden");
  });
}
function renderEmojiTabs() {
  const tabs = $("#emoji-tabs"); if (!tabs) return;
  tabs.innerHTML = "";
  const list = [{ id: "recent", icon: "🕘" }].concat(EMOJI_CATEGORIES);
  for (const cat of list) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "emoji-tab-btn" + (cat.id === __emojiTab ? " active" : "");
    btn.textContent = cat.icon;
    btn.setAttribute("role", "tab"); btn.setAttribute("aria-selected", cat.id === __emojiTab ? "true" : "false");
    btn.setAttribute("aria-label", T("emoji.cat." + cat.id));
    btn.addEventListener("click", () => {
      __emojiTab = cat.id;
      const search = $("#emoji-search-input"); if (search) search.value = "";
      renderEmojiTabs();
      renderEmojiGrid(emojiTabSource(cat.id));
      const grid = $("#emoji-grid"); if (grid) grid.scrollTop = 0;
    });
    tabs.appendChild(btn);
  }
}
// Вставляет эмодзи в позицию курсора (а не всегда в конец — пользователь
// может редактировать середину текста) и держит фокус в поле ввода,
// чтобы можно было вставить несколько эмодзи подряд без лишних тапов.
// @упоминания в группах — автодополнение имени участника при вводе "@".
// Находим незакрытый токен "@partial" от последнего "@" до каретки (без
// пробелов внутри), ищем совпадающих по префиксу участников группы.
function currentMentionToken(input) {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const token = before.slice(at + 1);
  if (/\s/.test(token)) return null; // пробел закрывает токен
  return { start: at, end: pos, partial: token };
}
function updateMentionAutocomplete() {
  const input = $("#chat-input");
  const box = $("#mention-autocomplete");
  if (!input || !box) return;
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  if (!c || !isGroup(c)) { closeMentionAutocomplete(); return; }
  const tok = currentMentionToken(input);
  if (!tok) { closeMentionAutocomplete(); return; }
  const q = tok.partial.toLowerCase();
  const candidates = c.members.filter((m) => m.id !== Store.myId && (m.name || "").toLowerCase().startsWith(q));
  if (candidates.length === 0) { closeMentionAutocomplete(); return; }
  box.innerHTML = candidates.slice(0, 6).map((m) => `<button type="button" class="mention-autocomplete-item" data-member-id="${escapeHtml(m.id)}" data-member-name="${escapeHtml(m.name || "")}">${escapeHtml(m.name || T("sys.someone"))}</button>`).join("");
  box.classList.remove("hidden");
  state._mentionTokenRange = { start: tok.start, end: tok.end };
}
function closeMentionAutocomplete() {
  const box = $("#mention-autocomplete");
  if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
  state._mentionTokenRange = null;
}
function applyMentionChoice(name) {
  const input = $("#chat-input");
  const range = state._mentionTokenRange;
  if (!input || !range) return;
  const insert = name + " ";
  input.value = input.value.slice(0, range.start) + "@" + insert + input.value.slice(range.end);
  const newPos = range.start + 1 + insert.length;
  closeMentionAutocomplete();
  input.focus();
  input.setSelectionRange(newPos, newPos);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function wireMentionAutocomplete() {
  const box = $("#mention-autocomplete");
  if (!box) return;
  box.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".mention-autocomplete-item");
    if (!btn) return;
    applyMentionChoice(btn.dataset.memberName || "");
  });
}
function insertEmojiAtCursor(emoji) {
  const input = $("#chat-input"); if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
  const newPos = start + emoji.length;
  input.setSelectionRange(newPos, newPos);
  // пока открыта панель эмодзи, клавиатуру не поднимаем
  const pk = $("#emoji-picker-sheet");
  if (!pk || pk.classList.contains("hidden")) input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
// Общая точка для "что сейчас должно быть в сетке" — используется и
// обработчиком поиска, и колбэком выбора тона кожи (renderSkinToneRow),
// чтобы смена тона перерисовывала ТЕКУЩИЙ режим пикера (активная категория
// или текущие результаты поиска), а не всегда сбрасывала на категорию.
function currentEmojiGridSource() {
  const search = $("#emoji-search-input");
  const q = search ? search.value : "";
  const results = emojiSearchResults(q);
  return results === null ? emojiTabSource(__emojiTab) : results;
}
// Высота композера зависит от того, какие баннеры сейчас видны (ответ,
// редактирование, "отправить позже") и от safe-area-inset-bottom — её
// нельзя захардкодить в CSS один раз, нужно измерять непосредственно
// перед открытием. #app-shell — containing block для .sheet (см.
// `contain: layout` на #app-shell), поэтому отступ считаем от его края,
// а не от окна браузера: на десктопной раскладке (см. @media выше)
// #app-shell — не весь экран, а центрированная «рамка телефона».
function positionEmojiFlyout() {
  const panel = $("#emoji-picker-sheet .sheet-panel");
  const shell = $("#app-shell");
  const form = $("#chat-form");
  if (!panel || !shell || !form) return;
  const shellRect = shell.getBoundingClientRect();
  const formRect = form.getBoundingClientRect();
  const gap = 8;
  const bottomOffset = Math.max(gap, Math.round(shellRect.bottom - formRect.top + gap));
  panel.style.marginBottom = bottomOffset + "px";
}
// Один пикер на всё приложение: из композера (вставка в поле ввода, шторка остаётся открытой) и из реакций на сообщение
// (opts.onPick — выбранный эмодзи уходит в реакцию, шторка закрывается).
function openEmojiPicker(opts) {
  const sheet = $("#emoji-picker-sheet"); if (!sheet) return;
  __emojiPickHandler = (opts && typeof opts.onPick === "function") ? opts.onPick : null;
  __emojiCloseOnPick = !!(opts && opts.closeOnPick);
  const search = $("#emoji-search-input"); if (search) search.value = "";
  if (!EMOJI_CATEGORIES.some((c) => c.id === __emojiTab) && __emojiTab !== "recent") __emojiTab = "smileys";
  if (__emojiTab === "recent" && recentEmojiList().length === 0) __emojiTab = "smileys";
  const tr = $("#emoji-skin-tone-row"); if (tr) tr.classList.add("hidden");
  const tb = $("#emoji-tone-btn"); if (tb) tb.setAttribute("aria-expanded", "false");
  renderEmojiTabs();
  renderSkinToneRow(() => renderEmojiGrid(currentEmojiGridSource()));
  updateEmojiToneButton();
  renderEmojiGrid(emojiTabSource(__emojiTab));
  sheet.classList.remove("hidden");
  positionEmojiFlyout();
  // Фокус в поле поиска открывал бы экранную клавиатуру и сразу прятал половину пикера — ставим его только по нажатию на поиск
}
function wireEmojiPicker() {
  const btn = $("#chat-emoji-btn");
  if (btn) btn.addEventListener("click", () => { if (state.chatId) openEmojiPicker(); });
  const search = $("#emoji-search-input");
  if (search) search.addEventListener("input", () => renderEmojiGrid(currentEmojiGridSource()));
  const toneBtn = $("#emoji-tone-btn");
  if (toneBtn) toneBtn.addEventListener("click", () => {
    const row = $("#emoji-skin-tone-row"); if (!row) return;
    const open = row.classList.contains("hidden");
    row.classList.toggle("hidden", !open);
    toneBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
// Кнопка «+» композера — постоянная. По нажатию вверх «выезжают» три кружка: (1) эмодзи, (2) камера, (3) скрепка;
// «+» при этом поворачивается в «×». Любое действие, нажатие мимо, Esc, смена чата и отправка сообщения сворачивают веер.
// Прежний экспериментальный тумблер «+» в Настройках убран: теперь так выглядит композер всегда (и в личных чатах, и в группах).
function setComposerFan(open) {
  const form = $("#chat-form"); if (!form) return;
  form.classList.toggle("fan-open", !!open);
  const plus = $("#chat-plus-btn"); if (plus) plus.setAttribute("aria-expanded", open ? "true" : "false");
  const fan = $("#composer-fan"); if (fan) fan.setAttribute("aria-hidden", open ? "false" : "true");
}
function collapseComposerPlus() { setComposerFan(false); }
function wireComposerPlusMode() {
  const plusBtn = $("#chat-plus-btn"); if (!plusBtn) return;
  plusBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const form = $("#chat-form");
    setComposerFan(!(form && form.classList.contains("fan-open")));
  });
  // Выбор любого из трёх действий сворачивает веер (capture — раньше, чем сработают обработчики самих кнопок)
  for (const id of ["#chat-attach-btn", "#chat-emoji-btn", "#chat-camera-btn"]) {
    const btn = $(id);
    if (btn) btn.addEventListener("click", collapseComposerPlus, { capture: true });
  }
  document.addEventListener("pointerdown", (e) => {
    const form = $("#chat-form");
    if (form && form.classList.contains("fan-open") && !form.contains(e.target)) collapseComposerPlus();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") collapseComposerPlus(); });
  const form = $("#chat-form");
  if (form) form.addEventListener("submit", collapseComposerPlus);
}
function wireJumpToDateSheet() {
  const goBtn = $("#jump-date-go-btn");
  if (!goBtn) return;
  goBtn.addEventListener("click", () => {
    const sheet = $("#jump-date-sheet");
    const input = $("#jump-date-input");
    const contactId = sheet ? sheet.dataset.contactId : null;
    if (sheet) sheet.classList.add("hidden");
    if (!contactId || !input || !input.value) return;
    const target = new Date(input.value + "T00:00:00");
    const c = state.contacts.get(contactId); if (!c) return;
    const match = c.messages.find((m) => {
      const d = new Date(m.ts);
      return d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth() && d.getDate() === target.getDate();
    });
    if (!match) { toast(T("toast.noMessagesOnDate")); return; }
    if (state.chatId !== contactId) { state.chatId = contactId; renderTab(); }
    // renderChatThread уже отрисовала DOM синхронно выше — ищем элемент
    // сообщения по data-msg-id, который проставляется в разметке пузыря.
    setTimeout(() => {
      const el = document.querySelector(`#chat-messages [data-msg-id="${CSS.escape(match.id)}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "auto" });
        el.classList.add("jump-highlight");
        setTimeout(() => el.classList.remove("jump-highlight"), 1500);
      }
    }, 50);
  });
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
// Общая логика "снести всё и перезапуститься с чистого листа" — раньше
// была только в debug-hard-reset-btn; вынесена сюда, чтобы «Удалить
// аккаунт» в обычных настройках делала ровно то же самое, без
// расхождения поведения между скрытой Debug-кнопкой и видимой.
function performFullAccountWipe() {
  localStorage.clear();
  if ("caches" in window) caches.keys().then((names) => names.forEach((n) => caches.delete(n)));
  if ("indexedDB" in window) try { indexedDB.deleteDatabase("ether-db"); } catch (e) {}
  location.reload();
}
function deleteContact(id) {
  // Карточка контакта сегодня никогда не открывает эту функцию для
  // группы (openContactCard редиректит в openGroupInfo) — но функция
  // остаётся вызываемой напрямую (консоль, будущий код), и без этой
  // проверки она удалила бы группу молча ЛОКАЛЬНО: mesh.remove(groupId)
  // — no-op (у группы нет своего линка), state.contacts.delete(groupId)
  // убирает её у меня, но остальные участники ничего не узнают и
  // продолжат считать меня в группе. removeGroupMember(.., Store.myId,
  // true) — тот же путь, что и обычный "Выйти из группы": оповещает
  // оставшихся через broadcastGroupRoster ДО удаления.
  const cg = state.contacts.get(id);
  if (isGroup(cg)) { removeGroupMember(id, Store.myId, true); return; }
  if (cg && cg.isSelf) { toast(T("toast.cantDeleteSelfChat")); return; }
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
  { let gdChanged = false;
    for (const [dId, e] of groupDeliveryMap) if (e.to === id) { groupDeliveryMap.delete(dId); gdChanged = true; }
    if (gdChanged) persistGroupDeliveryMap(); }
  for (const [msgId, entry] of outbox) if (entry.to === id) outbox.delete(msgId);
  persistOutbox();
  delete state.lastSeen[id]; persistLastSeen();
  delete state.drafts[id]; persistDrafts();
  if (state.scheduledMessages.some((s) => s.contactId === id)) {
    state.scheduledMessages = state.scheduledMessages.filter((s) => s.contactId !== id);
    persistScheduledMessages();
  }
  if (state.folders.some((f) => f.contactIds.includes(id))) {
    for (const f of state.folders) f.contactIds = f.contactIds.filter((cid) => cid !== id);
    persistChatFolders();
    renderChatFolderChips();
  }
  unreadDividerFor.delete(id);
  dividerScrolledFor.delete(id);
  relayAttemptCooldown.delete(id);
  // До 200 непримененных ICE-кандидатов на контакт (см. лимит в
  // handleIncomingOffer) иначе остаются в памяти до перезагрузки —
  // этот контакт уже удалён, они больше никогда не будут востребованы.
  pendingIceCandidates.delete(id);
  if (state.activeContactContext === id) state.activeContactContext = null;
  state.mentionedChats.delete(id); // на прямые контакты не вешается, но безопасно и симметрично остальной чистке
  const audioEl = document.getElementById("remote-audio-" + id); if (audioEl) audioEl.remove();
  state.contacts.delete(id);
  recentlyDeletedIds.set(id, Date.now());
  // .keys().next().value — самый старый id по порядку вставки (Map, как и
  // Set, сохраняет порядок вставки); .values() здесь дал бы timestamp, а не
  // id, раз recentlyDeletedIds стал Map<id, ts>.
  if (recentlyDeletedIds.size > 500) recentlyDeletedIds.delete(recentlyDeletedIds.keys().next().value);
  persistRecentlyDeleted();
  persistContacts();
  // Раньше здесь была повторная проверка if (state.callId === id)
  // closeCallScreen() — мёртвый код: closeCallScreen("failed") уже
  // вызван выше (строка с комментарием про pendingRemoteStreams/аудио) и
  // безусловно обнуляет state.callId внутри себя, так что к этому месту
  // state.callId уже не может быть равен id.
  if (state.chatId === id) { state.chatId = null; __lastRenderedChatId = null; state.multiSelect = null; }
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
  if (rec.status === "missed") return T("calls.missed");
  if (rec.status === "declined") return T("calls.declined");
  // Группировка синонимов (Группа 1 «Умная группировка»): cancelled,
  // failed, busy, ringing/noAnswer — для пользователя это одно
  // состояние «не дозвонились». Разные слова (всего их было 4 разных
  // варианта для одного и того же исхода) создавали путаницу и
  // заставляли думать, что между ними есть разница. Сами состояния
  // в callLog не трогаем — они полезны для диагностики.
  return T("calls.unreachable");
}
// Метаданные иконки звонка: цвет + SVG по статусу. Раньше иконка
// была только по направлению (стрелка внутрь/наружу), а цвет менялся
// только для missed — пять «отменённых» и «пропущенных» подряд
// выглядели почти одинаково. Теперь тип результата видно сразу:
// завершённый = зелёный, пропущенный = красный, отклонённый = оранжевый,
// всё остальное = нейтрально-серое.
function callStatusMeta(rec) {
  const isOut = rec.direction === "out";
  const arrowIn  = "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z";
  const arrowOut = "M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4v-2z";
  const svgArrow = (path) => `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="${path}"/></svg>`;
  if (rec.status === "completed") return { cls: "completed", svg: svgArrow(isOut ? arrowOut : arrowIn) };
  if (rec.status === "missed")    return { cls: "missed",    svg: svgArrow(arrowIn) };
  if (rec.status === "declined")  return { cls: "declined",  svg: svgArrow(arrowIn) };
  return { cls: isOut ? "out" : "in", svg: svgArrow(isOut ? arrowOut : arrowIn) };
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
    const statusMeta = callStatusMeta(rec);
    const row = document.createElement("div");
    row.className = "call-row flat-content";
    const canOpen = state.contacts.has(rec.contactId);
    row.innerHTML = `
      <button type="button" class="call-row-main"${canOpen ? "" : " disabled"}>
        <div class="call-direction-icon ${statusMeta.cls}">${statusMeta.svg}</div>
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
let callInviteTimer = null;
function clearPendingCall() {
  if (pendingCall.timer) clearTimeout(pendingCall.timer); pendingCall.timer = null; pendingCall.contactId = null;
  if (callInviteTimer) { clearInterval(callInviteTimer); callInviteTimer = null; }
}
// Ждём, пока клиент сигнального сервера подключится (на мобильной сети и «спящем» сервере это занимает секунды).
function waitForSignaling(ms) {
  if (signaling && signaling.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const sig = signaling; if (!sig) { resolve(false); return; }
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); sig.removeEventListener("connected", onC); resolve(v); };
    const onC = () => finish(true);
    const t = setTimeout(() => finish(!!(signaling && signaling.connected)), ms);
    sig.addEventListener("connected", onC);
  });
}
// Звонок без готового P2P: шлём приглашение (на сервере оно превращается в push), повторяем его, пока идёт
// набор, и пытаемся поднять P2P, как только контакт появится в сети.
function startCallInviteResend(id, invite) {
  if (callInviteTimer) clearInterval(callInviteTimer);
  callInviteTimer = setInterval(() => {
    if (state.callId !== id || state.callPhase !== "calling") { clearInterval(callInviteTimer); callInviteTimer = null; return; }
    if (signaling && signaling.connected) {
      try { signaling.signal(id, invite); } catch (e) {}
      const l = mesh.get(id);
      if (!l || l.status === "disconnected") attemptConnect(id, true);
    }
  }, CALL_INVITE_RESEND_MS);
}

async function beginCall(id, withVideo) {
  const c = state.contacts.get(id);
  if (!c) return;
  if (isGroup(c)) { if (typeof startGroupCall === "function") startGroupCall(id, !!withVideo); else toast(T("toast.callGroupsUnsupported")); return; }
  if (typeof gcallBusy === "function" && gcallBusy()) { toast(T("toast.alreadyInCall")); return; }
  if (c.isSelf) return; // звонить себе некуда — у "Заметок себе" нет peer-соединения
  if (c.blocked) { toast(T("toast.blocked")); return; }
  if (state.callId && state.callId !== id) { toast(T("toast.alreadyInCall")); return; }
  if (state.callId === id) { openCallScreen(id, state.callPhase || "calling"); return; }

  // Debounce: не даём запустить новый звонок в течение 1.5с после
  // предыдущего провала — иначе пользователь, быстро тапая «Позвонить»,
  // плодит лавину системных сообщений «Звонок не состоялся».
  // 4с вместо 1.5с: в логе видно три beginCall подряд с интервалами
  // 1.7с и 2.6с — старый debounce их не покрывал.
  if (state._lastCallFailedAt && Date.now() - state._lastCallFailedAt < 4000) {
    return;
  }

  etherLog("info", "[call] beginCall to " + String(id).slice(0, 10) + "…");
  state._callUserAccepted = false;
  state._callAcceptInFlight = false;
  state._callMuteOnAnswer = false;
  state._callDeadSeconds = 0;
  state.callWantsVideo = !!withVideo;
  if (withVideo) requestWakeLock();

  openCallScreen(id, "calling");
  playDialingSound();

  // ============================================================
  // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ.
  // Сначала проверяем ЖИВОЙ P2P-канал. Если он уже есть — сигнальный
  // сервер для звонка НЕ НУЖЕН вовсе: call-state:ringing, accepted,
  // ended и медиа-треки идут напрямую через data channel WebRTC.
  // Сервер нужен только для ПЕРВИЧНОГО рукопожатия, и то не всегда
  // (relay через общий контакт тоже работает).
  // Раньше проверка signaling.connected шла ПЕРВОЙ и молча блокировала
  // звонок при живом P2P — именно это видно на скриншоте (P2P зелёный,
  // а тост «нет связи с сервером»).
  // ============================================================
  const link = mesh.get(id);
  const p2pReady = link && (link.status === "connected" || link.status === "in-call");

  if (p2pReady) {
    try {
      await link.startCall(withVideo);
      if (withVideo) showLocalVideoPreview(link);
    } catch (e) {
      const name = e && e.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") toast(T("toast.callPermissionDenied"));
      else if (name === "NotFoundError" || name === "DevicesNotFoundError") toast(T("toast.voiceNoMic"));
      else toast(T("calls.failed"));
      state._lastCallFailedAt = Date.now();
      closeCallScreen("failed");
      return;
    }

    // Best-effort: даже если сервер жив — уведомим собеседника через
    // сигналинг. Это лишь дублирует data-channel сигнал call-state
    // (нужно для push-уведомления и записи в истории звонков у
    // получателя, если приложение свёрнуто). Если сервер недоступен —
    // просто пропускаем, звонок уже идёт через P2P.
    if (signaling && signaling.connected) {
      try {
        signaling.signal(id, { t: "call-invite", n: Store.name, x: crypto.randomUUID() });
      } catch (e) {}
    }
    return;
  }

  // P2P пока нет — нужен сигнальный сервер. Он может ещё просыпаться (холодный старт), ждём до CALL_SERVER_WAIT_MS.
  if (!signaling || !signaling.connected) {
    const cp = $("#call-phase"); if (cp) cp.textContent = T("status.waking");
    const ok = await waitForSignaling(CALL_SERVER_WAIT_MS);
    if (state.callId !== id) return; // пока ждали, звонок отменили
    if (!ok) {
      toast(T("toast.noServer"));
      state._lastCallFailedAt = Date.now();
      closeCallScreen("failed");
      return;
    }
  }

  const offline = !onlineSet.has(id);
  const invite = { t: "call-invite", n: Store.name, x: crypto.randomUUID() };
  signaling.signal(id, invite);
  const phaseEl = $("#call-phase");
  if (phaseEl) phaseEl.textContent = offline ? T("call.viaPush") : T("call.calling");

  clearPendingCall();
  pendingCall.contactId = id;
  startCallInviteResend(id, invite);
  attemptConnect(id, true);
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
    state._lastCallFailedAt = Date.now();
    closeCallScreen("cancelled");
  }, offline ? CALL_PUSH_TIMEOUT_MS : PENDING_CALL_TIMEOUT_MS);
}

// Сворачивание звонка в тонкую полоску над таб-баром — звонок (и его
// таймер/WebRTC-соединение) продолжается, просто #call-screen больше не
// занимает единолично #content, можно вернуться в чаты/контакты/настройки.
// Разворот — тапом по самой полоске (restoreCallScreen).
function minimizeCallScreen() {
  if (!state.callId) return;
  const cs = $("#call-screen"); if (cs) cs.classList.add("hidden");
  const contentEl = $("#content"); if (contentEl) contentEl.classList.remove("hidden");
  const c = state.contacts.get(state.callId);
  const nameEl = $("#mini-call-name"); if (nameEl) nameEl.textContent = (c && c.name) || T("sys.someone");
  const avEl = $("#mini-call-avatar"); if (avEl) avEl.innerHTML = avatarCircleHtml(c, null, "");
  const miniBar = $("#mini-call-bar"); if (miniBar) miniBar.classList.remove("hidden");
  renderTab();
}
function restoreCallScreen() {
  if (!state.callId) return;
  const miniBar = $("#mini-call-bar"); if (miniBar) miniBar.classList.add("hidden");
  const contentEl = $("#content"); if (contentEl) contentEl.classList.add("hidden");
  const cs = $("#call-screen"); if (cs) cs.classList.remove("hidden");
}
function openCallScreen(id, phase, opts) {
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
  const miniBar = $("#mini-call-bar"); if (miniBar) miniBar.classList.add("hidden");
  if (state.callId !== id) {
    state._callUserAccepted = false;
    state._callAcceptInFlight = false;
    state._callMuteOnAnswer = false;
    speakerOn = false; // новый звонок всегда начинается с внутреннего динамика
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch (e) {}
  }
  state.callId = id;
  state.callPhase = phase;
  try { ensureAudioCtx(); } catch (e) {}
  updateCallButtonsSupport();
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
    }, (opts && opts.timeoutMs) || INCOMING_CALL_TIMEOUT_MS);
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
  if (!isMobileDevice() && !navigator.audioSession) { await openAudioOutputPicker(); return; }
  const audioEl = document.getElementById("remote-audio-" + id);
  const wantSpeaker = !speakerOn;
  // iOS Safari 16.4+: Audio Session API — "play-and-record" во время звонка ведёт звук в
  // наушник (ресивер), "playback" — на громкую связь. setSinkId на iPhone до iOS 26 нет вовсе.
  if (navigator.audioSession && !(audioEl && typeof audioEl.setSinkId === "function")) {
    try {
      navigator.audioSession.type = wantSpeaker ? "playback" : "play-and-record";
      speakerOn = wantSpeaker;
      const btn = $("#call-speaker-btn"); if (btn) btn.classList.toggle("active", speakerOn);
    } catch (e) { toast(T("toast.speakerUnsupported")); }
    return;
  }
  if (!audioEl || typeof audioEl.setSinkId !== "function") {
    toast(T("toast.speakerUnsupported"));
    return;
  }
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
// Единая точка изменения громкости собеседника: GainNode (работает и на iOS) либо element.volume,
// если звук идёт напрямую без Web Audio.
function ensureRelayGain(audioEl, stream) {
  if (audioEl._relayGain) return audioEl._relayGain;
  const ctx = ensureGlobalAudioCtx();
  if (!ctx || !stream) return null;
  try {
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
    const source = ctx.createMediaStreamSource(stream);
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = Store.callVolume;
    source.connect(gain); gain.connect(dest);
    audioEl._relaySource = source; audioEl._relayDest = dest; audioEl._relayGain = gain;
    audioEl.srcObject = dest.stream;
    const p = audioEl.play(); if (p && p.catch) p.catch(() => {});
    return gain;
  } catch (e) { etherLog("warn", "[audio] GainNode недоступен:", String(e)); return null; }
}
function applyCallVolume(id, v) {
  const vol = Math.max(0, Math.min(1, Number(v) || 0));
  const el = document.getElementById("remote-audio-" + id);
  if (!el) return;
  if (el._volReadOnly) {
    const g = el._relayGain || (vol < 0.99 ? ensureRelayGain(el, el._relayStream) : null);
    if (g) { try { g.gain.value = vol; } catch (e) {} }
    return;
  }
  try { el.volume = vol; } catch (e) {}
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
  // Повторный remote-track (например, когда следом приходит видеотрек того же потока) не должен
  // пересобирать цепочку Web Audio — это даёт щелчок и дублирует источник.
  if (audioEl._relayStream === stream && audioEl.srcObject) {
    try { const c0 = ensureGlobalAudioCtx(); if (c0 && c0.state === "suspended") c0.resume(); } catch (e) {}
    applyCallVolume(id, Store.callVolume);
    return;
  }
  // Звук собеседника играет НАПРЯМУЮ из WebRTC-потока. Раньше он шёл через Web Audio (MediaStreamSource → Gain →
  // MediaStreamDestination → <audio>): лишняя передискретизация и задержка давали «плывущий» звук с артефактами, а в
  // Chrome/Edge MediaStreamSource от удалённого потока без <audio> на нём вообще молчит — «звуковой канал не налаживается».
  audioEl._relayStream = stream;
  audioEl.muted = false;
  audioEl.srcObject = stream;
  audioEl.volume = Store.callVolume;
  { const out = savedAudioOutput(); if (out && audioEl.setSinkId) audioEl.setSinkId(out).catch(() => {}); }
  // iOS: HTMLMediaElement.volume только для чтения. Звук играет напрямую (лучшее качество), а когда пользователь уменьшает громкость
  // слайдером, поток один раз пропускается через GainNode (см. ensureRelayGain). На полной громкости Web Audio не участвует.
  try {
    const keep = audioEl.volume; audioEl.volume = keep > 0.5 ? 0.4 : 0.6;
    audioEl._volReadOnly = Math.abs(audioEl.volume - keep) < 0.01;
    audioEl.volume = keep;
    if (audioEl._volReadOnly && Store.callVolume < 0.99) ensureRelayGain(audioEl, stream);
  } catch (e) {}
  const p = audioEl.play();
  if (p && p.catch) p.catch(() => {
    const resume = () => { try { audioEl.play().catch(() => {}); } catch (e) {} };
    document.addEventListener("touchstart", resume, { once: true });
    document.addEventListener("click", resume, { once: true });
  });
  const sl = $("#call-volume-slider"); if (sl) sl.value = String(Store.callVolume);
  // На iOS видеозвонки (в отличие от чисто голосовых) переключаются
  // системой на громкую связь по своей же внутренней эвристике —
  // независимо от того, что говорит speakerOn в JS. Явно возвращаем на
  // наушник, если пользователь ничего вручную не переключал — но не
  // трогаем, если он сам переключился на громкую (speakerOn === true).
  // Best-effort: если setSinkId недоступен/бросит ошибку (нет
  // подходящего контекста пользовательского жеста на некоторых
  // платформах) — тихо оставляем как есть, ничего не ломаем.
  if (!speakerOn && typeof audioEl.setSinkId === "function") {
    findAudioOutputDevice(/earpiece|receiver/i).then((deviceId) => {
      if (deviceId) audioEl.setSinkId(deviceId).catch(() => {});
    }).catch(() => {});
  }
}
// Доступность Picture-in-Picture: requestPictureInPicture (Chrome/Edge,
// большинство Android-браузеров) ИЛИ webkitSetPresentationMode (старый
// Safari/iOS). document.pictureInPictureEnabled === false означает, что
// браузер явно отключил API (например, через Permissions-Policy) —
// в этом случае кнопку не показываем вовсе, а не оставляем декоративной.
// Телефон/планшет (экран касанием, есть переключаемые камеры): здесь нужны «задняя камера» и динамик/наушник,
// а картинка-в-картинке не нужна. На десктопе — наоборот. Недоступные кнопки не показываем вообще.
function isMobileDevice() {
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}
function speakerToggleSupported() {
  if (navigator.audioSession) return true; // iOS: playback ↔ play-and-record
  // Android: динамик/наушник; десктоп: выбор устройства вывода (колонки/наушники/гарнитура) через setSinkId
  return typeof HTMLMediaElement !== "undefined" && typeof HTMLMediaElement.prototype.setSinkId === "function";
}
function savedAudioOutput() { try { return localStorage.getItem("ether.audioOut") || ""; } catch (e) { return ""; } }
async function setAudioOutput(deviceId) {
  try { localStorage.setItem("ether.audioOut", deviceId || ""); } catch (e) {}
  for (const el of document.querySelectorAll("audio[id^=remote-audio-]")) { try { if (el.setSinkId) await el.setSinkId(deviceId || "default"); } catch (e) {} }
  for (const el of soundPool.values()) { try { if (el.setSinkId) await el.setSinkId(deviceId || "default"); } catch (e) {} }
}
// Десктоп: выбор устройства вывода звука из списка (колонки, наушники, гарнитура…)
async function openAudioOutputPicker() {
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput"); } catch (e) {}
  const old = $("#audio-out-menu"); if (old) { old.remove(); return; }
  if (devices.length < 2) { toast(T("toast.noOtherOutput")); return; }
  const cur = savedAudioOutput() || "default";
  const menu = document.createElement("div"); menu.id = "audio-out-menu"; menu.className = "call-more-menu"; menu.setAttribute("role", "menu");
  devices.forEach((d, i) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "call-menu-item"; b.setAttribute("role", "menuitem");
    const label = d.label || (T("call.speaker") + " " + (i + 1));
    b.innerHTML = `<span>${escapeHtml(label)}</span>${(d.deviceId === cur || (cur === "default" && d.deviceId === "default")) ? " ✓" : ""}`;
    b.addEventListener("click", async () => { menu.remove(); await setAudioOutput(d.deviceId); toast(label); const spk = $("#call-speaker-btn"); if (spk) spk.classList.toggle("active", d.deviceId !== "default"); });
    menu.appendChild(b);
  });
  const host = $("#call-controls-active"); if (!host) return;
  host.appendChild(menu);
  setTimeout(() => document.addEventListener("pointerdown", function close(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", close, true); } }, true), 0);
}
function updateCallButtonsSupport() {
  const mobile = isMobileDevice();
  const spk = $("#call-speaker-btn"); if (spk) spk.classList.toggle("hidden", !speakerToggleSupported());
  const lnk = state.callId ? mesh.get(state.callId) : null;
  const flip = $("#call-flip-overlay-btn");
  if (flip) flip.classList.toggle("hidden", !(mobile && lnk && lnk.localVideoTrack && !lnk._screenSharing));
  const pip = $("#call-pip-overlay-btn");
  if (pip) pip.classList.toggle("hidden", mobile || !pipSupported());
  const ov = $("#call-video-overlays");
  if (ov) {
    const any = ["#call-flip-overlay-btn", "#call-pip-overlay-btn"].some((q) => { const b = $(q); return b && !b.classList.contains("hidden"); });
    if (!any) ov.classList.add("hidden");
  }
}
function pipSupported() {
  const v = document.createElement("video");
  if (typeof document.pictureInPictureEnabled === "boolean" && document.pictureInPictureEnabled && typeof v.requestPictureInPicture === "function") return true;
  if (typeof v.webkitSetPresentationMode === "function") return true;
  return false;
}
function attachRemoteVideo(id, stream) {
  if (state.callId !== id) return;
  const videoTracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
  if (videoTracks.length === 0) return;
  const v = $("#call-remote-video");
  if (!v) return;
  // Звук собеседника играет ТОЛЬКО через #remote-audio-<id> (громкость, динамик/наушник).
  // Не заглушённый <video> с тем же потоком проигрывал бы ту же дорожку второй раз — на
  // видеозвонке это давало эхо/двойной звук, не подчинялось слайдеру громкости и
  // переключению динамика.
  v.muted = true; v.defaultMuted = true; v.volume = 0;
  v.srcObject = stream;
  v.classList.remove("hidden");
  const cs = $("#call-screen"); if (cs) cs.classList.add("video-active");
  // Собеседник убрал видео (остановил показ экрана без камеры, выключил камеру с удалением трека) —
  // трек получает mute/ended, и без реакции на это остался бы замороженный последний кадр.
  for (const t of videoTracks) {
    if (t.__etherWatched || !t.addEventListener) continue;
    t.__etherWatched = true;
    const setVisible = (visible) => {
      if (state.callId !== id) return;
      const rv = $("#call-remote-video"); if (!rv || rv.srcObject !== stream) return;
      rv.classList.toggle("hidden", !visible);
      const c2 = $("#call-screen");
      const localOn = !!$("#call-local-video") && !$("#call-local-video").classList.contains("hidden");
      if (c2) c2.classList.toggle("video-active", visible || localOn);
    };
    t.addEventListener("mute", () => setVisible(false));
    t.addEventListener("unmute", () => setVisible(true));
    t.addEventListener("ended", () => setVisible(false));
  }
  const p = v.play(); if (p && p.catch) p.catch(() => {});
  // Раньше здесь была отдельная кнопка PiP (#call-pip-btn), показываемая
  // независимо от showLocalVideoPreview — именно для случая "смотрю
  // видео собеседника, свою камеру не включал". Теперь PiP и flip —
  // один оверлей-контейнер (#call-video-overlays), и его включает только
  // showLocalVideoPreview — без этой строки контейнер остался бы скрыт,
  // пока пользователь не включит СВОЮ камеру, хотя PiP для чужого видео
  // уже осмысленен. flip в этом случае — безопасный no-op
  // (PeerLink.switchCamera() сам проверяет наличие localVideoTrack).
  const overlays = $("#call-video-overlays"); if (overlays) overlays.classList.remove("hidden");
  updateCallButtonsSupport();
}
function showLocalVideoPreview(link) {
  const v = $("#call-local-video");
  if (!v || !link || !link.localStream) return;
  v.srcObject = link.localStream;
  v.classList.remove("hidden");
  const cs = $("#call-screen"); if (cs) cs.classList.add("video-active");
  const p = v.play(); if (p && p.catch) p.catch(() => {});
  // Раньше тут были отдельные #call-switch-camera-btn (в основном ряду) и
  // #call-flip-overlay-btn (сам по себе поверх видео) плюс #call-pip-btn
  // в основном ряду — три кнопки управления видео вперемешку с
  // микрофоном/громкой связью/завершением звонка. Теперь flip и PiP —
  // единый оверлей-контейнер над превью (#call-video-overlays), а
  // основной ряд всегда состоит из 4 кнопок (микрофон/громкая связь/
  // видео/завершить). PiP-кнопка внутри оверлея видна всегда — нажатие
  // при неподдерживаемом PiP показывает toast (см. wireCallScreen).
  const overlays = $("#call-video-overlays"); if (overlays) overlays.classList.remove("hidden");
  // Flip камеры бессмысленен, если своя камера не включена (только PiP) — скрываем кнопку.
  const flipBtn = $("#call-flip-overlay-btn");
  if (flipBtn) {
    const lnk = state.callId ? mesh.get(state.callId) : null;
    flipBtn.classList.toggle("hidden", !(lnk && lnk.localVideoTrack));
  }
  const videoBtn = $("#call-video-btn"); if (videoBtn) videoBtn.classList.add("active");
  updateCallButtonsSupport();
}
function hideCallVideo() {
  // Если в этот момент активен PiP — закрываем его явно. Без этого
  // плавающее окошко продолжает показывать видео-поток, который мы вот-вот
  // обнулим (srcObject = null) — на экране остаётся "подвисший" чёрный
  // PiP-прямоугольник вместо того, чтобы просто исчезнуть вместе со звонком.
  if (document.pictureInPictureElement) { try { document.exitPictureInPicture(); } catch (e) {} }
  const rv = $("#call-remote-video"); if (rv) { rv.classList.add("hidden"); rv.srcObject = null; }
  const lv = $("#call-local-video"); if (lv) { lv.classList.add("hidden"); lv.srcObject = null; }
  const cs = $("#call-screen"); if (cs) cs.classList.remove("video-active", "remote-screen", "sharing");
  const overlays = $("#call-video-overlays"); if (overlays) overlays.classList.add("hidden");
  const videoBtn = $("#call-video-btn"); if (videoBtn) videoBtn.classList.remove("active");
}
function startCallTimer() {
  const started = Date.now();
  clearInterval(callTimerInterval);
  state._callDeadSeconds = 0;
  let qualityTick = 0;
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    const cp = $("#call-phase"); if (cp) cp.textContent = `${mm}:${ss}`;
    const mct = $("#mini-call-timer"); if (mct) mct.textContent = `${mm}:${ss}`;
    const cid = state.callId;
    if (!cid) { state._callDeadSeconds = 0; return; }
    const link = mesh.get(cid);
    const alive = link && (link.status === "connected" || link.status === "in-call");
    if (alive) { state._callDeadSeconds = 0; }
    else {
      state._callDeadSeconds = (state._callDeadSeconds || 0) + 1;
      if (state._callDeadSeconds * 1000 >= CALL_DEAD_LINK_TIMEOUT_MS) { closeCallScreen("completed"); return; }
    }
    // P2 — иконка качества связи, раз в 3 секунды (getStats недёшев,
    // раз в секунду было бы избыточно для индикатора на глаз).
    qualityTick++;
    if (alive && link.pc && qualityTick % 3 === 0) updateCallQualityIcon(link.pc);
  }, 1000);
}
let __lastCallQualityRtt = null;
// Следим, идёт ли реально звук в обе стороны (раз в 3 с вместе с индикатором качества). Само по себе это только диагностика —
// «соединение есть, а звука нет» теперь видно в журнале: сколько байт ушло/пришло и на каком этапе остановилось.
// Если входящий звук молчит 9 секунд, один раз пробуем перезапустить ICE.
const __audioWatch = { callId: null, lastIn: -1, lastOut: -1, silentIn: 0, silentOut: 0, kicked: false };
function watchCallAudioFlow(stats) {
  if (__audioWatch.callId !== state.callId) Object.assign(__audioWatch, { callId: state.callId, lastIn: -1, lastOut: -1, silentIn: 0, silentOut: 0, kicked: false });
  let inB = 0, outB = 0, hasIn = false, hasOut = false;
  stats.forEach((r) => {
    const kind = r.kind || r.mediaType;
    if (r.type === "inbound-rtp" && kind === "audio") { hasIn = true; inB += r.bytesReceived || 0; }
    if (r.type === "outbound-rtp" && kind === "audio") { hasOut = true; outB += r.bytesSent || 0; }
  });
  const w = __audioWatch;
  if (hasIn) { w.silentIn = (w.lastIn >= 0 && inB <= w.lastIn) ? w.silentIn + 1 : 0; w.lastIn = inB; }
  if (hasOut) { w.silentOut = (w.lastOut >= 0 && outB <= w.lastOut) ? w.silentOut + 1 : 0; w.lastOut = outB; }
  if (w.silentOut === 3) {
    const l = mesh.get(state.callId);
    etherLog("warn", "[call] звук не уходит собеседнику уже 9 с (исходящих байт: " + outB + "); " + (l && l.audioDebug ? l.audioDebug() : "") + " — беру микрофон заново");
    if (l && l.recoverAudio) l.recoverAudio().then((ok) => { if (ok) l.reInvite(); });
  }
  if (w.silentIn === 3) {
    etherLog("warn", "[call] звук от собеседника не приходит 9 с (входящих байт: " + inB + ")");
    if (!w.kicked) { w.kicked = true; const l = mesh.get(state.callId); if (l) l.reInvite(); }
  }
}
// Подробная строка о качестве звука в журнал (раз в ~15 с): путь, RTT, джиттер, потери, буфер воспроизведения, «замазанные» сэмплы.
// Нужна, чтобы на жалобу «качество не очень, есть задержка» было видно, что именно не так.
let __callStatsTick = 0, __callStatsPrev = null;
const __callStatsInPrev = new Map();
function logCallStats(stats) {
  if (++__callStatsTick % 5 !== 1) return;
  const byId = new Map(); stats.forEach((r) => byId.set(r.id, r));
  let pair = null, inb = null, outb = null, outSum = 0, outN = 0, inGrow = 0;
  stats.forEach((r) => {
    if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) pair = pair && !r.selected ? pair : r;
    const kind = r.kind || r.mediaType;
    if (r.type === "inbound-rtp" && kind === "audio") {
      const prev = __callStatsInPrev.get(r.id), grow = (r.packetsReceived || 0) - (prev || 0);
      __callStatsInPrev.set(r.id, r.packetsReceived || 0);
      if (!inb || grow > inGrow) { inb = r; inGrow = grow; }
    }
    if (r.type === "outbound-rtp" && kind === "audio") { outb = r; outSum += r.bytesSent || 0; outN++; }
  });
  const lt = pair && byId.get(pair.localCandidateId), rt = pair && byId.get(pair.remoteCandidateId);
  const parts = [];
  if (pair) parts.push(`путь ${lt ? lt.candidateType : "?"}/${lt ? (lt.relayProtocol || lt.protocol) : "?"} → ${rt ? rt.candidateType : "?"}, rtt ${Math.round((pair.currentRoundTripTime || 0) * 1000)}мс`);
  if (inb) {
    const jb = inb.jitterBufferEmittedCount ? Math.round(inb.jitterBufferDelay / inb.jitterBufferEmittedCount * 1000) : null;
    const conc = inb.totalSamplesReceived ? Math.round(inb.concealedSamples / inb.totalSamplesReceived * 100) : null;
    parts.push(`вх: джиттер ${Math.round((inb.jitter || 0) * 1000)}мс, потеряно ${inb.packetsLost || 0}/${(inb.packetsReceived || 0) + (inb.packetsLost || 0)}` + (jb != null ? `, буфер ${jb}мс` : "") + (conc != null ? `, заглушено ${conc}%` : ""));
  }
  if (outb) {
    let kbps = null;
    if (__callStatsPrev && __callStatsPrev.t < outb.timestamp && outSum >= __callStatsPrev.b) kbps = Math.round((outSum - __callStatsPrev.b) * 8 / (outb.timestamp - __callStatsPrev.t));
    __callStatsPrev = { t: outb.timestamp, b: outSum };
    parts.push("исх" + (kbps != null ? ` ${kbps} кбит/с` : "") + (outN > 1 ? ` (потоков ${outN})` : ""));
  }
  const lk = state.callId && mesh.get(state.callId);
  if (lk && lk.audioDebug) parts.push(lk.audioDebug());
  if (parts.length) etherLog("info", "[call-stats] " + parts.join("; "));
}
async function updateCallQualityIcon(pc) {
  const icon = $("#call-quality-icon"); if (!icon) return;
  try {
    const stats = await pc.getStats();
    if (!state.callId) return; // звонок завершился, пока ждали статистику
    let rttMs = null, lossRatio = 0;
    stats.forEach((s) => {
      if (s.type === "candidate-pair" && s.state === "succeeded" && typeof s.currentRoundTripTime === "number") {
        rttMs = s.currentRoundTripTime * 1000;
      }
      if (s.type === "inbound-rtp" && typeof s.packetsLost === "number" && typeof s.packetsReceived === "number" && s.packetsReceived + s.packetsLost > 0) {
        lossRatio = Math.max(lossRatio, s.packetsLost / (s.packetsReceived + s.packetsLost));
      }
    });
    __lastCallQualityRtt = rttMs;
    try { watchCallAudioFlow(stats); } catch (e) {}
    try { logCallStats(stats); } catch (e) {}
    let level = "good";
    if (rttMs == null) { icon.classList.add("hidden"); return; }
    if (rttMs > 300 || lossRatio > 0.08) level = "poor";
    else if (rttMs > 150 || lossRatio > 0.03) level = "medium";
    icon.classList.remove("hidden", "quality-good", "quality-medium", "quality-poor");
    icon.classList.add("quality-" + level);
    icon.title = T("call.quality." + level) + (rttMs ? ` (${Math.round(rttMs)} ms)` : "");
  } catch (e) { /* getStats недоступен/звонок закрылся между тиком и ответом — не страшно, следующий тик попробует снова */ }
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
  const qIcon = $("#call-quality-icon"); if (qIcon) qIcon.classList.add("hidden");
  state._callDeadSeconds = 0;
  state._callAcceptInFlight = false;
  state._callUserAccepted = false;
  state._callMuteOnAnswer = false;
  state.callWantsVideo = false;
  releaseWakeLock();
  clearPendingCall();
  stopRingtone();
  stopCallSounds();
  hideCallVideo();
  endCallRecord(reason);
  const cs = $("#call-screen"); if (cs) cs.classList.add("hidden");
  const contentEl = $("#content"); if (contentEl) contentEl.classList.remove("hidden");
  const miniBar = $("#mini-call-bar"); if (miniBar) miniBar.classList.add("hidden");
  const cm = $("#call-mute-btn"); if (cm) cm.classList.remove("active");
  const spkBtn = $("#call-speaker-btn"); if (spkBtn) spkBtn.classList.remove("active");
  speakerOn = false;
  try { if (navigator.audioSession) navigator.audioSession.type = "auto"; } catch (e) {}
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
  // Защита от повторного рингтона. Если у собеседника ещё не отработал
  // call-ended (сеть мигнула, сигнал не дошёл) — он при пересогласовании
  // WebRTC снова пришлёт call-state:ringing. Запоминаем, что звонок
  // только что завершён, и будем игнорировать такие пакеты 15 секунд.
  if (rec && rec.contactId) {
    recentlyEndedCalls.set(rec.contactId, Date.now());
    // Самоочистка по таймеру — раньше запись пропадала только "заодно",
    // при завершении СЛЕДУЮЩЕГО звонка (см. ниже). Если после этого
    // звонка приложение час провисит без единого нового звонка, старая
    // запись просто висела в Map (безвредно, но мусор). setTimeout
    // гарантирует уборку независимо от того, будут ли ещё звонки.
    const ccid = rec.contactId;
    setTimeout(() => {
      const ts = recentlyEndedCalls.get(ccid);
      if (ts && Date.now() - ts >= RECENTLY_ENDED_CALL_MS) recentlyEndedCalls.delete(ccid);
    }, RECENTLY_ENDED_CALL_MS + 100);
    // и всё равно почистим попутно старые записи от других контактов,
    // чтобы не ждать их собственных таймеров без необходимости.
    const now = Date.now();
    for (const [id, ts] of recentlyEndedCalls) {
      if (now - ts > RECENTLY_ENDED_CALL_MS) recentlyEndedCalls.delete(id);
    }
  }

  if (rec && rec.contactId) {
    const c = state.contacts.get(rec.contactId);
    if (c) {
      const sysMsg = systemMessageForCall(rec, reason);
      if (sysMsg) {
        c.messages.push({ id: crypto.randomUUID(), from: "system", text: T(sysMsg.key, sysMsg.params), textKey: sysMsg.key, textParams: sysMsg.params, ts: Date.now() });
        trimMessages(c);
        c.lastActivity = Date.now();
        persistContacts();
        if (state.chatId === rec.contactId) renderChatThread();
        if (state.tab === "chats") renderChatsList();
      }
    }
  }
}
// Меню «ещё» в звонке: кнопка «⋯» видна, только когда в меню есть хотя бы один видимый пункт (показ экрана, рисование на видео).
function wireCallMoreMenu() {
  const btn = $("#call-more-btn"), menu = $("#call-more-menu");
  if (!btn || !menu || btn.dataset.wired) return;
  btn.dataset.wired = "1";
  const sync = () => {
    const any = Array.from(menu.querySelectorAll(".call-menu-item")).some((b) => !b.classList.contains("hidden"));
    if (btn.classList.contains("hidden") === any) btn.classList.toggle("hidden", !any);
    // add() на уже скрытом меню всё равно пишет атрибут → MutationObserver вызывает sync снова (бесконечный цикл)
    if (!any && !menu.classList.contains("hidden")) { menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); }
  };
  const close = () => { menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", () => { const open = menu.classList.contains("hidden"); menu.classList.toggle("hidden", !open); btn.setAttribute("aria-expanded", open ? "true" : "false"); });
  menu.addEventListener("click", (e) => { if (e.target.closest(".call-menu-item")) close(); });
  document.addEventListener("pointerdown", (e) => { if (!menu.classList.contains("hidden") && !menu.contains(e.target) && !btn.contains(e.target)) close(); }, true);
  try { new MutationObserver(sync).observe(menu, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] }); } catch (e) {}
  sync();
}
function wireCallScreen() {
  wireCallMoreMenu();
  const minimizeBtn = $("#call-minimize-btn");
  if (minimizeBtn) minimizeBtn.addEventListener("click", () => minimizeCallScreen());
  const miniBar = $("#mini-call-bar");
  if (miniBar) miniBar.addEventListener("click", () => restoreCallScreen());
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
      if (ok) { state.callWantsVideo = true; showLocalVideoPreview(link); requestWakeLock(); }
      else toast(T("toast.videoNoCamera"));
    } else {
      // Если в этот момент шёл показ экрана — localVideoTrack сейчас это
      // трек ЭКРАНА, не камеры; disableVideo() просто бы заморозил
      // последний кадр показа (enabled=false), не остановив захват, и
      // кнопка screen-share осталась бы залипшей в активном состоянии.
      // Останавливаем показ целиком, а не просто гасим трек.
      if (link._screenSharing) {
        await link.stopScreenShare();
        const ssBtn = $("#call-screenshare-btn"); if (ssBtn) ssBtn.classList.remove("active");
      } else {
        link.disableVideo();
      }
      const lv = $("#call-local-video"); if (lv) { lv.classList.add("hidden"); lv.srcObject = null; }
      videoBtn.classList.remove("active");
      // Оверлей (flip+PiP) прячем только если и удалённого видео тоже
      // нет — пользователь мог выключить СВОЮ камеру, но продолжать
      // смотреть видео собеседника (PiP по-прежнему осмысленен, flip
      // своей камеры — нет, но прятать весь контейнер по отдельности
      // сложнее и не нужно: без видео вообще оверлей всё равно скрыт).
      const rv = $("#call-remote-video");
      const remoteActive = rv && rv.srcObject && !rv.classList.contains("hidden");
      const overlays = $("#call-video-overlays");
      if (!remoteActive && overlays) overlays.classList.add("hidden");
      // Видео выключено (но звонок продолжается) — экран больше не
      // обязан гореть сам по себе, отдаём управление системе (на
      // Android это снова уход в сон через её собственный таймаут).
      releaseWakeLock();
    }
  });
  // Screen sharing (раздел 7 роадмапа) — кнопка показывается только если
  // браузер реально поддерживает getDisplayMedia (не через CSS-медиа-
  // запрос, который ничего не знает о реальном API; заметнее всего это
  // отсутствие поддержки в iOS Safari — там кнопка остаётся скрытой).
  const screenShareBtn = $("#call-screenshare-btn");
  if (screenShareBtn) {
    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) screenShareBtn.classList.remove("hidden");
    screenShareBtn.addEventListener("click", async () => {
      const link = mesh.get(state.callId); if (!link) return;
      if (screenShareBtn.classList.contains("active")) {
        await link.stopScreenShare();
        screenShareBtn.classList.remove("active");
        { const cs0 = $("#call-screen"); if (cs0) cs0.classList.remove("sharing"); }
        updateCallButtonsSupport();
      } else {
        const ok = await link.startScreenShare();
        if (ok) {
          screenShareBtn.classList.add("active");
          { const cs0 = $("#call-screen"); if (cs0) cs0.classList.add("sharing"); }
          // Видео теперь точно есть (экран) — показываем локальный превью/
          // оверлеи и держим экран включённым, как и при обычном enableVideo().
          showLocalVideoPreview(link);
          requestWakeLock();
          const videoBtn = $("#call-video-btn"); if (videoBtn) videoBtn.classList.add("active");
          toast(T("call.screenSharing"));
        } else {
          toast(T("toast.screenShareFailed"));
        }
      }
    });
  }
  // Оверлеи на своём видео: flip камеры + PiP. Раньше это были три
  // отдельные кнопки в основном ряду управления звонком вперемешку с
  // микрофоном/громкой связью/завершением (#call-switch-camera-btn,
  // #call-pip-btn) плюс отдельный #call-flip-overlay-btn поверх видео —
  // теперь единый контейнер-оверлей над превью (#call-video-overlays,
  // см. showLocalVideoPreview/hideCallVideo), основной ряд всегда из 4
  // кнопок.
  const flipOverlayBtn = $("#call-flip-overlay-btn");
  if (flipOverlayBtn) flipOverlayBtn.addEventListener("click", () => {
    const link = mesh.get(state.callId);
    if (link) link.switchCamera();
  });
  // P2.36 — Picture-in-Picture: веб-API, не нужна нативная обёртка, но
  // неравномерная поддержка (надёжно в Chrome/Edge, частично в iOS
  // Safari через webkitSetPresentationMode). Кнопка в оверлее теперь
  // видна всегда (а не скрывается через pipSupported(), как раньше
  // #call-pip-btn) — на неподдерживающем устройстве клик просто
  // показывает toast вместо тихого no-op/скрытой кнопки.
  const pipOverlayBtn = $("#call-pip-overlay-btn");
  if (pipOverlayBtn) pipOverlayBtn.addEventListener("click", async () => {
    if (!pipSupported()) { toast(T("toast.pipUnsupported")); return; }
    // В PiP выносим именно удалённое видео (посмотреть на собеседника,
    // переключившись в другое приложение) — если его ещё нет (например,
    // идёт дозвон и показан только свой превью), используем локальное
    // как резервный вариант, чтобы кнопка не была no-op.
    const rv = $("#call-remote-video");
    const lv = $("#call-local-video");
    const v = (rv && rv.srcObject && !rv.classList.contains("hidden")) ? rv : lv;
    if (!v || !v.srcObject) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      } else if (v.webkitSetPresentationMode) {
        // Старый Safari/iOS путь — у него нет requestPictureInPicture(),
        // а есть webkitSetPresentationMode("picture-in-picture"|"inline").
        v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
      }
    } catch (e) { etherLog("warn", "[call] PiP failed:", String(e)); }
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
        applyCallVolume(cid, v);
      }
    });
  }
  // flip-камеры и PiP (#call-flip-overlay-btn/#call-pip-overlay-btn)
  // уже подключены выше, вместе с остальными кнопками оверлея — второй
  // отдельный addEventListener на ту же кнопку flip здесь раньше был
  // дублем (навешивал второй идентичный обработчик при каждом вызове
  // wireCallScreen).
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
    const c = state.contacts.get(cid);
    const link = mesh.get(cid);

    if (link && (link.status === "connected" || link.status === "in-call")) {
      try {
        await link.answerCall(state.callWantsVideo);
        // Серверный call-accepted шлём ТОЛЬКО после успешного answerCall.
        if (signaling && signaling.connected) {
          try { signaling.signal(cid, { t: "call-accepted" }); } catch (e) {}
        }
        if (state.callWantsVideo) { showLocalVideoPreview(link); requestWakeLock(); }
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
        const name = e && e.name;
        if (name === "NotAllowedError" || name === "PermissionDeniedError") toast(T("toast.callPermissionDenied"));
        else if (name === "NotFoundError" || name === "DevicesNotFoundError") toast(T("toast.voiceNoMic"));
        else toast(T("calls.failed"));
        state._lastCallFailedAt = Date.now();
        closeCallScreen("failed");
        return;
      }
      return;
    }
    // P2P ещё нет (экран «входящий» открылся по серверному приглашению или по нажатию на push, а соединение
    // с звонящим ещё строится). Раньше без линка звонок сразу «не удался», хотя звонящий продолжал звонить.
    // Теперь показываем «Соединение…», подталкиваем подключение и ждём "connected" в wireMeshEvents (там уйдёт answerCall).
    const cp = $("#call-phase"); if (cp) cp.textContent = T("call.connecting");
    const ci = $("#call-controls-incoming"); if (ci) ci.classList.add("hidden");
    const ca = $("#call-controls-active"); if (ca) ca.classList.remove("hidden");
    const iShouldOffer = Store.myId < cid;
    if (signaling && signaling.connected) {
      if (!link || link.status === "disconnected") attemptConnect(cid, iShouldOffer);
    } else {
      waitForSignaling(CALL_SERVER_WAIT_MS).then((ok) => { if (ok && state.callId === cid && state._callUserAccepted && state.callPhase !== "active") attemptConnect(cid, iShouldOffer); });
    }
    clearPendingCall();
    pendingCall.contactId = cid;
    pendingCall.timer = setTimeout(() => {
      if (state.callId !== cid || state.callPhase === "active") return;
      etherLog("warn", "[call] принятый звонок: P2P не поднялся за " + (CALL_ACCEPT_CONNECT_MS / 1000) + " с");
      try { const l = mesh.get(cid); if (l) l.endCall(); } catch (e) {}
      if (signaling && signaling.connected) { try { signaling.signal(cid, { t: "call-ended" }); } catch (e) {} }
      toast(T("calls.failed"));
      state._lastCallFailedAt = Date.now();
      closeCallScreen("failed");
    }, CALL_ACCEPT_CONNECT_MS);
  } catch (e) {
    etherLog("error", "[call] accept handler failed:", String(e));
  } finally {
    state._callAcceptInFlight = false;
  }
}

// =====================================================================
// Pull-to-refresh (список чатов)
// =====================================================================
// Тянем список чатов вниз от самого верха скролла → flushOutbox()
// (досылает застрявшие исходящие) + initSignaling() (переподключение
// к сигнальному серверу). Чисто ручной жест: сервис-воркер и так
// держит соединение, это просто явный способ сказать "попробуй сейчас".
function wirePullToRefresh() {
  const scroller = $("#screen-chats");
  const indicator = $("#chats-ptr");
  if (!scroller || !indicator) return;
  const PTR_TRIGGER_PX = 56;
  const PTR_MAX_PX = 72;
  let startY = 0, pulling = false, refreshing = false;
  scroller.addEventListener("touchstart", (e) => {
    if (refreshing || scroller.scrollTop > 0) { pulling = false; return; }
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  scroller.addEventListener("touchmove", (e) => {
    if (!pulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || scroller.scrollTop > 0) { indicator.style.height = "0px"; return; }
    indicator.style.height = Math.min(dy * 0.6, PTR_MAX_PX) + "px";
  }, { passive: true });
  scroller.addEventListener("touchend", () => {
    if (!pulling || refreshing) return;
    pulling = false;
    const h = parseFloat(indicator.style.height) || 0;
    if (h >= PTR_TRIGGER_PX) {
      refreshing = true;
      indicator.style.height = PTR_TRIGGER_PX + "px";
      haptic("light");
      try { flushOutbox(); } catch (e) {}
      try { initSignaling(); } catch (e) {}
      setTimeout(() => { indicator.style.height = "0px"; refreshing = false; }, 700);
    } else {
      indicator.style.height = "0px";
    }
  });
}

// =====================================================================
// Кастомные папки чатов (раздел 4 роадмапа) — именованные наборы чатов
// (прямых и групповых), доступные как дополнительные чипы в
// #chat-filters рядом с All/Unread/Groups/Direct/Calls. Папка — это
// именно НАБОР конкретных чатов, а не динамическое правило — ближе к
// "альбомам" iOS Photos, чем к сложным Telegram-папкам с комбинацией
// критериев; для первой версии этого достаточно и не требует нового
// языка правил.
let __folderEditingId = null; // null = создаём новую, иначе редактируем существующую
function renderChatFolderChips() {
  const host = $("#chat-filters-custom");
  if (!host) return;
  host.innerHTML = state.folders.map((f) => `
    <button type="button" class="chat-filter-chip" data-filter="folder:${escapeHtml(f.id)}">${escapeHtml(truncate(f.name, 18))}</button>
  `).join("");
  // Клик вешаем здесь же (а не через делегирование на #chat-filters),
  // потому что остальные статичные чипы уже вешают свой обработчик в
  // wireSearchHandlers() при старте — для динамических он должен
  // переустанавливаться при каждом перерендере списка чипов.
  host.querySelectorAll(".chat-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $$("#chat-filters .chat-filter-chip").forEach((b) => b.classList.toggle("active", b === chip));
      state.chatsSegment = "chats";
      state.chatFilter = chip.dataset.filter;
      renderTab(); // из «Звонков» нужно заново показать список чатов, а не только перерисовать его скрытым
    });
  });
}
function openFolderManageSheet() {
  const list = $("#folder-manage-list"), empty = $("#folder-manage-empty");
  if (!list) return;
  list.innerHTML = "";
  if (empty) empty.classList.toggle("hidden", state.folders.length > 0);
  for (const f of state.folders) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "forward-row";
    btn.innerHTML = `<span class="global-search-row-text"><span class="global-search-row-title">${escapeHtml(f.name)}</span><span class="global-search-row-subtitle muted">${T("chats.folder.memberCount", { n: f.contactIds.length })}</span></span>`;
    btn.addEventListener("click", () => { const s = $("#folder-manage-sheet"); if (s) s.classList.add("hidden"); openFolderEditSheet(f.id); });
    list.appendChild(btn);
  }
  const sheet = $("#folder-manage-sheet"); if (sheet) sheet.classList.remove("hidden");
}
function openFolderEditSheet(folderId) {
  __folderEditingId = folderId || null;
  const folder = folderId ? state.folders.find((f) => f.id === folderId) : null;
  const title = $("#folder-edit-title");
  if (title) title.textContent = folder ? folder.name : T("chats.folder.new");
  const nameInput = $("#folder-edit-name");
  if (nameInput) nameInput.value = folder ? folder.name : "";
  const delBtn = $("#folder-edit-delete-btn");
  if (delBtn) delBtn.classList.toggle("hidden", !folder);
  const memberIds = new Set(folder ? folder.contactIds : []);
  const list = $("#folder-edit-member-list");
  if (list) {
    list.innerHTML = "";
    const contacts = Array.from(state.contacts.values()).filter((c) => c.managed && !c.isSelf);
    for (const c of contacts) {
      const row = document.createElement("label");
      row.className = "forward-row";
      row.innerHTML = `${avatarCircleHtml(c, "avatar-sm")}<span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span><input type="checkbox" class="switch folder-member-check" data-contact-id="${escapeHtml(c.id)}" ${memberIds.has(c.id) ? "checked" : ""}>`;
      list.appendChild(row);
    }
  }
  const sheet = $("#folder-edit-sheet"); if (sheet) sheet.classList.remove("hidden");
}
function saveFolderEdit() {
  const nameInput = $("#folder-edit-name");
  const name = (nameInput && nameInput.value || "").trim();
  if (!name) { toast(T("chats.folder.nameRequired")); return; }
  const contactIds = $$("#folder-edit-member-list .folder-member-check:checked").map((el) => el.dataset.contactId);
  if (__folderEditingId) {
    const folder = state.folders.find((f) => f.id === __folderEditingId);
    if (folder) { folder.name = name; folder.contactIds = contactIds; }
  } else {
    state.folders.push({ id: crypto.randomUUID(), name, contactIds });
  }
  persistChatFolders();
  renderChatFolderChips();
  const sheet = $("#folder-edit-sheet"); if (sheet) sheet.classList.add("hidden");
  renderTab();
}
function deleteFolderEdit() {
  if (!__folderEditingId) return;
  // Если удаляемая папка сейчас активна как фильтр — откатываемся на
  // "Все", иначе список чатов тихо остался бы отфильтрован по id папки,
  // которой больше не существует (state.folders.find вернёт undefined,
  // и renderChatsList покажет пустой список без всякого объяснения).
  if (state.chatFilter === "folder:" + __folderEditingId) state.chatFilter = "all";
  state.folders = state.folders.filter((f) => f.id !== __folderEditingId);
  persistChatFolders();
  renderChatFolderChips();
  __folderEditingId = null;
  const sheet = $("#folder-edit-sheet"); if (sheet) sheet.classList.add("hidden");
  renderTab();
}
function wireChatFolders() {
  renderChatFolderChips();
  const addBtn = $("#chat-folder-add-btn");
  if (addBtn) addBtn.addEventListener("click", openFolderManageSheet);
  const createBtn = $("#folder-create-btn");
  if (createBtn) createBtn.addEventListener("click", () => { const s = $("#folder-manage-sheet"); if (s) s.classList.add("hidden"); openFolderEditSheet(null); });
  const saveBtn = $("#folder-edit-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", saveFolderEdit);
  const delBtn = $("#folder-edit-delete-btn");
  if (delBtn) delBtn.addEventListener("click", deleteFolderEdit);
}

// =====================================================================
// Поиск
// =====================================================================
function wireSearchHandlers() {
  const gs = $("#global-search");
  if (gs) gs.addEventListener("input", (e) => { state.searchQuery = e.target.value.trim(); renderChatsList(); });
  const ta = $("#toggle-archived");
  if (ta) ta.addEventListener("click", () => { state.showArchived = !state.showArchived; renderChatsList(); });
  $$("#chat-filters .chat-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const f = chip.dataset.filter || "all";
      $$("#chat-filters .chat-filter-chip").forEach((b) => b.classList.toggle("active", b === chip));
      if (f === "calls") {
        // "Звонки" — не отдельный таб и не отдельный сегмент-переключатель
        // над списком (было двойной навигацией), а такой же чип, как
        // All/Unread/Groups/Direct. Внутреннее состояние chatsSegment
        // оставлено как есть — его читает renderTab()/renderCallsList().
        state.chatsSegment = "calls";
        markMissedCallsSeen();
        renderTab();
      } else {
        state.chatsSegment = "chats";
        state.chatFilter = f;
        renderTab(); // из «Звонков» нужно заново показать список чатов, а не только перерисовать его скрытым
      }
    });
  });
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
  // Сбрасываем отложенный скролл к первому попаданию — иначе ранее
  // поставленный таймер сработает уже после закрытия поиска (или
  // всего чата) и попытается прокрутить #chat-messages, которого к
  // этому моменту может не быть на экране вовсе.
  if (__chatSearchScrollTimer) { clearTimeout(__chatSearchScrollTimer); __chatSearchScrollTimer = null; }
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
// Раздел 9 роадмапа — категории с back-навигацией. category-hidden — своя
// отдельная от search-hidden CSS-подсветка (идентичное правило
// `display:none`, но другой класс): существующий обработчик поиска ниже
// снимает search-hidden с ВСЕХ групп, когда поле очищается (строка
// `q.length > 0 && !anyVisible`) — если бы категории прятались тем же
// классом, очистка поиска случайно показывала бы разом все категории.
function renderSettingsCategories() {
  const list = $("#settings-category-list"); if (!list) return;
  list.innerHTML = SETTINGS_CATEGORIES.map((cat) => `
    <button type="button" class="settings-category-row" data-category="${cat.id}">
      <span class="settings-category-icon"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="${cat.iconPath}"/></svg></span>
      <span class="settings-category-label">${escapeHtml(T(cat.labelKey))}</span>
      <span class="chevron"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg></span>
    </button>`).join("");
  list.querySelectorAll(".settings-category-row").forEach((btn) => {
    btn.addEventListener("click", () => openSettingsCategory(btn.dataset.category));
  });
}
function openSettingsCategory(id) {
  state.settingsCategory = id;
  updateSettingsCategoryView();
}
function closeSettingsCategory() {
  state.settingsCategory = null;
  updateSettingsCategoryView();
}
// Поиск (ниже) работает по-прежнему ПО ВСЕМУ экрану Settings, а не внутри
// одной категории — это сознательно: при вводе запроса пользователь хочет
// найти нужную настройку, а не сначала угадать, в какой категории она
// живёт. Поэтому во время поиска категории временно не участвуют:
// показываются все группы, фильтрация идёт только через search-hidden,
// как и раньше. Категория, что была открыта до начала поиска, никуда не
// теряется — просто не применяется, пока в поле есть текст, и
// восстанавливается сама собой, как только поле очищается (state
// category мы здесь не трогаем).
function updateSettingsCategoryView() {
  const searchEl = $("#settings-search");
  const searching = !!(searchEl && searchEl.value.trim());
  const list = $("#settings-category-list");
  const header = $("#settings-category-header");
  const groups = $$("#screen-settings .settings-group");
  if (searching) {
    if (list) list.classList.add("hidden");
    if (header) header.classList.add("hidden");
    groups.forEach((g) => g.classList.remove("category-hidden"));
    return;
  }
  if (!state.settingsCategory) {
    if (list) list.classList.remove("hidden");
    if (header) header.classList.add("hidden");
    groups.forEach((g) => g.classList.add("category-hidden"));
    return;
  }
  if (list) list.classList.add("hidden");
  if (header) {
    header.classList.remove("hidden");
    const cat = SETTINGS_CATEGORIES.find((c) => c.id === state.settingsCategory);
    const titleEl = $("#settings-category-title");
    if (titleEl) titleEl.textContent = cat ? T(cat.labelKey) : "";
  }
  groups.forEach((g) => g.classList.toggle("category-hidden", g.dataset.settingsCategory !== state.settingsCategory));
}
// Своё фото: выбирается в Настройки → Профиль, сжимается до 160×160 JPEG и рассылается контактам вместе с настройками приватности
// (см. sendPrivacyPrefsTo) — у собеседника оно показывается, пока он не выбрал вам своё.
function renderProfileAvatar() {
  const b = $("#settings-avatar-btn"); if (!b) return;
  const av = Store.myAvatar;
  if (av && AVATAR_DATAURL_RE.test(av)) { b.style.background = ""; b.style.backgroundImage = `url('${av}')`; b.textContent = ""; }
  else { b.style.backgroundImage = ""; b.style.background = avatarGradient(Store.name); b.textContent = initials(Store.name); }
  const rm = $("#settings-avatar-remove"); if (rm) rm.classList.toggle("hidden", !av);
}
function wireProfileAvatar() {
  const btn = $("#settings-avatar-btn"), change = $("#settings-avatar-change"), rm = $("#settings-avatar-remove"), input = $("#settings-avatar-input");
  if (!input || input.dataset.wired) return;
  input.dataset.wired = "1";
  const pick = () => input.click();
  if (btn) btn.addEventListener("click", pick);
  if (change) change.addEventListener("click", pick);
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0]; input.value = "";
    if (!file) return;
    try { Store.myAvatar = await readImageAsAvatarDataUrl(file); renderProfileAvatar(); toast(T("toast.avatarUpdated")); }
    catch (e) { toast(T("toast.avatarFailed")); }
  });
  if (rm) rm.addEventListener("click", () => { Store.myAvatar = ""; renderProfileAvatar(); });
  renderProfileAvatar();
}
function wireSettingsScreen() {
  renderSettingsCategories();
  wireProfileAvatar();
  updateSettingsCategoryView();
  const backBtn = $("#settings-back-btn");
  if (backBtn) backBtn.addEventListener("click", closeSettingsCategory);
  const settingsSearch = $("#settings-search");
  if (settingsSearch) {
    // Нюанс (как и предупреждал ревьюер): .settings-row.column — это
    // контейнер с несколькими подэлементами (например, Privacy), а не
    // одна строка с одним текстом — простая фильтрация по textContent
    // всё равно работает приемлемо (ищет по всему тексту внутри), не
    // идеально для таких составных блоков, но этого достаточно для
    // первой версии.
    settingsSearch.addEventListener("input", (e) => {
      // Отдельный класс search-hidden, а не общий "hidden" — часть строк
      // (например #change-pin-btn) уже скрыта своей собственной логикой
      // независимо от поиска; трогать их общий "hidden" напрямую стёрло
      // бы это состояние при очистке поля поиска.
      const q = e.target.value.trim().toLowerCase();
      $$("#screen-settings .settings-row").forEach((row) => {
        const text = (row.textContent || "").toLowerCase();
        row.classList.toggle("search-hidden", q.length > 0 && !text.includes(q));
      });
      $$("#screen-settings .settings-group").forEach((group) => {
        const anyVisible = Array.from(group.querySelectorAll(".settings-row")).some((r) => !r.classList.contains("search-hidden") && !r.classList.contains("hidden"));
        group.classList.toggle("search-hidden", q.length > 0 && !anyVisible);
      });
      // Поиск временно "снимает" категории (см. комментарий у
      // updateSettingsCategoryView) — пересчитываем после своей логики
      // выше, а не вместо неё.
      updateSettingsCategoryView();
    });
  }
  const helpBtn = $("#help-btn");
  if (helpBtn) helpBtn.addEventListener("click", () => {
    renderHelp();
    const el = $("#help-sheet"); if (el) el.classList.remove("hidden");
  });
  // Тот же export/importBackup, что в Debug — только точка входа теперь
  // на виду, а не спрятана в скрытом экране, куда обычный пользователь
  // никогда не попадёт (5 тапов по заголовку). #import-backup-input —
  // один и тот же file input на двух кнопках (Debug и Settings).
  const favBtn = $("#settings-favorites-btn");
  if (favBtn) favBtn.addEventListener("click", openFavoritesSheet);
  const sExpBackup = $("#settings-export-backup-btn");
  if (sExpBackup) sExpBackup.addEventListener("click", exportBackup);
  const sImpBackup = $("#settings-import-backup-btn");
  if (sImpBackup) sImpBackup.addEventListener("click", () => { const el = $("#import-backup-input"); if (el) el.click(); });
  // killer-features-backlog 0.2 — "свой сервер" как оформленная фича:
  // просто объяснение + готовая команда, без реального провижининга
  // (странице неоткуда развернуть чужой сервер) — честные рамки того,
  // что клиент вообще может сделать.
  const selfHostBtn = $("#self-host-info-btn");
  if (selfHostBtn) selfHostBtn.addEventListener("click", () => {
    const sheet = $("#self-host-sheet"); if (sheet) sheet.classList.remove("hidden");
  });
  // killer-features-backlog 0.5 — Dead Man's Switch настройки.
  const dmEnabledEl = $("#settings-deadman-enabled");
  if (dmEnabledEl) dmEnabledEl.addEventListener("change", (e) => {
    if (e.target.checked && !Store.deadManContactId) {
      e.target.checked = false;
      toast(T("toast.deadManNeedsContact"));
      return;
    }
    Store.deadManEnabled = e.target.checked;
    if (e.target.checked) checkDeadManSwitch();
  });
  const dmThresholdEl = $("#settings-deadman-threshold");
  if (dmThresholdEl) dmThresholdEl.addEventListener("change", (e) => { Store.deadManThresholdDays = parseInt(e.target.value, 10) || 7; });
  const dmContactBtn = $("#settings-deadman-contact-btn");
  if (dmContactBtn) dmContactBtn.addEventListener("click", () => {
    openForwardSheet((contactId) => {
      Store.deadManContactId = contactId;
      const nameEl2 = $("#settings-deadman-contact-name");
      const c = state.contacts.get(contactId);
      if (nameEl2) nameEl2.textContent = c ? (c.name || T("sys.someone")) : "";
    }, "settings.deadMan.contact.pick");
  });
  // killer-features-backlog 1.7 — Panic Clean (встряхнуть телефон).
  const panicShakeEl = $("#settings-panic-shake");
  if (panicShakeEl) {
    if (typeof DeviceMotionEvent === "undefined") {
      const row = $("#settings-panic-shake-row"); if (row) row.classList.add("hidden");
    } else {
      panicShakeEl.addEventListener("change", async (e) => {
        if (e.target.checked) {
          const granted = await requestMotionPermissionIfNeeded();
          if (!granted) { e.target.checked = false; toast(T("toast.motionPermissionDenied")); return; }
          Store.panicShakeEnabled = true;
          wirePanicShake();
        } else {
          Store.panicShakeEnabled = false;
          unwirePanicShake();
        }
      });
    }
  }
  const nameEl = $("#settings-name");
  if (nameEl) nameEl.addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) {
      Store.name = v; toast(T("toast.nameUpdated")); renderProfileAvatar();
      // initSignaling() полностью пересоздаёт WebSocket — если сейчас идёт
      // звонок, лучше не рисковать кратким окном недоступности сигналинга
      // (может понадобиться ICE restart и т.п.) ради обновления имени.
      // Сервер узнает новое имя при следующем естественном переподключении.
      if (!state.callId) initSignaling();
    }
  });
  const hideNotifEl = $("#settings-hide-notif");
  if (hideNotifEl) hideNotifEl.addEventListener("change", (e) => { Store.hideNotifContent = e.target.checked; });
  const myStatusEl = $("#settings-my-status");
  if (myStatusEl) myStatusEl.addEventListener("change", (e) => { Store.myStatus = e.target.value.trim().slice(0, 80); });
  const idEl = $("#settings-identity");
  if (idEl) {
    idEl.addEventListener("input", () => {
      const v = idEl.value.trim();
      if (!v) { idEl.classList.remove("input-invalid"); return; }
      Identity.idFor(v).then(
        () => idEl.classList.remove("input-invalid"),
        () => idEl.classList.add("input-invalid")
      );
    });
    idEl.addEventListener("change", async (e) => {
      const v = e.target.value.trim(); if (!v) return;
      try {
        const identity = await Identity.idFor(v);
        Store.myIdentityRaw = identity.normalized;
        Store.myId = identity.id;
        idEl.classList.remove("input-invalid");
        toast(T("toast.idUpdated"));
        initSignaling();
      } catch (err) { toast(T(err.message)); e.target.value = Store.myIdentityRaw; idEl.classList.remove("input-invalid"); }
    });
  }
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
  const autoEmoji = $("#settings-auto-emoji");
  if (autoEmoji) autoEmoji.addEventListener("change", (e) => {
    Store.autoEmoji = e.target.checked;
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
  const translateEndpointEl = $("#settings-translate-endpoint");
  if (translateEndpointEl) translateEndpointEl.addEventListener("change", (e) => {
    Store.translateEndpoint = e.target.value;
    e.target.value = Store.translateEndpoint; // пустое поле возвращает адрес по умолчанию
  });
  const translateKeyEl = $("#settings-translate-key");
  if (translateKeyEl) translateKeyEl.addEventListener("change", (e) => { Store.translateApiKey = e.target.value; });
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
  const calmModeToggle = $("#settings-calm-mode");
  if (calmModeToggle) { calmModeToggle.checked = Store.calmMode; calmModeToggle.addEventListener("change", () => { Store.calmMode = calmModeToggle.checked; applyCalmMode(); }); }
  const bubbleSizeSel = $("#settings-bubble-size");
  if (bubbleSizeSel) { bubbleSizeSel.value = Store.bubbleSize; bubbleSizeSel.addEventListener("change", () => { Store.bubbleSize = bubbleSizeSel.value; applyChatAppearancePrefs(); }); }
  const fontSizeSel = $("#settings-font-size");
  if (fontSizeSel) { fontSizeSel.value = Store.fontSize; fontSizeSel.addEventListener("change", () => { Store.fontSize = fontSizeSel.value; applyChatAppearancePrefs(); }); }
  const wallpaperSel = $("#settings-wallpaper");
  if (wallpaperSel) { wallpaperSel.value = Store.chatWallpaper; wallpaperSel.addEventListener("change", () => { Store.chatWallpaper = wallpaperSel.value; applyChatAppearancePrefs(); }); }
}

// =====================================================================
// Глобальный поиск (раздел 1/11/13 роадмапа) — единая точка поиска по
// чатам, тексту сообщений, контактам, истории звонков и настройкам.
// Открывается кнопкой #global-search-btn в nav-bar (видна на всех
// экранах-списках) или шорткатом Cmd/Ctrl+K на десктопе. Намеренно НЕ
// реализован как pull-down-to-search на мобильном — список чатов уже
// занят своим pull-to-refresh (см. V.37.0.0), конкурирующий жест на том
// же экране добавил бы путаницу; кнопка в шапке работает одинаково
// предсказуемо на обеих платформах.
// =====================================================================
function openGlobalSearch(prefill) {
  const sheet = $("#global-search-sheet");
  if (!sheet) return;
  sheet.classList.remove("hidden");
  const input = $("#global-search-input");
  if (input) {
    const q = typeof prefill === "string" ? prefill : "";
    input.value = q;
    renderGlobalSearchResults(q);
    setTimeout(() => input.focus(), 50);
  }
}
function closeGlobalSearch() {
  const sheet = $("#global-search-sheet");
  if (sheet) sheet.classList.add("hidden");
}
// Переход в конкретную категорию настроек (используется и кликом по
// результату поиска, и может переиспользоваться где угодно ещё, где
// нужно программно открыть Settings на нужном разделе). Сбрасывает
// активный чат/карточку контакта и любой незакрытый #settings-search,
// чтобы категория точно стала видимой (см. updateSettingsCategoryView).
function navigateToSettingsCategory(catId) {
  state.chatId = null;
  state.contactCardId = null;
  state.tab = "settings";
  state.settingsCategory = catId || null;
  const ss = $("#settings-search");
  if (ss && ss.value) {
    ss.value = "";
    $$("#screen-settings .settings-row").forEach((r) => r.classList.remove("search-hidden"));
    $$("#screen-settings .settings-group").forEach((g) => g.classList.remove("search-hidden"));
  }
  renderTab();
  updateSettingsCategoryView();
}
function renderGlobalSearchResults(rawQuery) {
  const resultsEl = $("#global-search-results");
  const emptyEl = $("#global-search-empty");
  if (!resultsEl) return;
  const q = String(rawQuery || "").trim();
  const qLower = q.toLowerCase();
  if (!qLower) { resultsEl.innerHTML = ""; if (emptyEl) emptyEl.classList.add("hidden"); return; }
  const allContacts = Array.from(state.contacts.values());
  const chatMatches = allContacts
    .filter((c) => c.messages && c.messages.length > 0 && (c.name || "").toLowerCase().includes(qLower))
    .slice(0, 6);
  // По одному (самому недавнему) совпадению на чат — иначе один активно
  // переписывающийся контакт с частым словом забил бы всю секцию.
  const messageMatches = [];
  for (const c of allContacts) {
    if (!c.messages || !c.messages.length) continue;
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const text = c.messages[i].text || "";
      if (text.toLowerCase().includes(qLower)) { messageMatches.push({ contact: c, text }); break; }
    }
    if (messageMatches.length >= 6) break;
  }
  const contactMatches = allContacts
    .filter((c) => (!c.messages || !c.messages.length) && (c.name || "").toLowerCase().includes(qLower))
    .slice(0, 6);
  const callMatches = [];
  const seenCallContacts = new Set();
  for (const r of state.callLog.slice().sort((a, b) => b.startedAt - a.startedAt)) {
    if (seenCallContacts.has(r.contactId)) continue;
    const c = state.contacts.get(r.contactId);
    const name = (c && c.name) || "";
    if (name && name.toLowerCase().includes(qLower)) {
      callMatches.push({ contactId: r.contactId, name });
      seenCallContacts.add(r.contactId);
    }
    if (callMatches.length >= 6) break;
  }
  const settingsCategoryMatches = SETTINGS_CATEGORIES
    .filter((cat) => T(cat.labelKey).toLowerCase().includes(qLower))
    .map((cat) => ({ type: "category", id: cat.id, label: T(cat.labelKey) }));
  const settingsRowMatches = $$("#screen-settings .settings-row")
    .map((row) => ({ row, text: (row.textContent || "").trim() }))
    .filter((r) => r.text && r.text.toLowerCase().includes(qLower))
    .slice(0, 5)
    .map((r) => {
      const group = r.row.closest(".settings-group");
      return { type: "row", id: group && group.dataset.settingsCategory, label: truncate(r.text, 60) };
    });
  const settingsMatches = settingsCategoryMatches.concat(settingsRowMatches).slice(0, 6);

  const sections = [
    { key: "chats", titleKey: "search.global.sectionChats", rows: chatMatches.map((c) => globalSearchRowHtml("chat", c.id, avatarCircleHtml(c, "avatar-sm"), highlightRaw(escapeHtml(c.name || ""), q), "")) },
    { key: "messages", titleKey: "search.global.sectionMessages", rows: messageMatches.map((m) => globalSearchRowHtml("message", m.contact.id, avatarCircleHtml(m.contact, "avatar-sm"), escapeHtml(m.contact.name || ""), highlightRaw(escapeHtml(truncate(m.text, 60)), q))) },
    { key: "contacts", titleKey: "search.global.sectionContacts", rows: contactMatches.map((c) => globalSearchRowHtml("contact", c.id, avatarCircleHtml(c, "avatar-sm"), highlightRaw(escapeHtml(c.name || ""), q), "")) },
    { key: "calls", titleKey: "search.global.sectionCalls", rows: callMatches.map((r) => globalSearchRowHtml("call", r.contactId, avatarCircleHtml(state.contacts.get(r.contactId), "avatar-sm"), highlightRaw(escapeHtml(r.name), q), "")) },
    { key: "settings", titleKey: "search.global.sectionSettings", rows: settingsMatches.map((m) => globalSearchRowHtml(m.type === "category" ? "settings-category" : "settings-row", m.id, "", highlightRaw(escapeHtml(m.label), q), "")) },
  ].filter((s) => s.rows.length > 0);

  if (!sections.length) {
    resultsEl.innerHTML = "";
    if (emptyEl) emptyEl.classList.remove("hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("hidden");
  resultsEl.innerHTML = sections.map((s) => `
    <div class="global-search-section">
      <div class="global-search-section-title">${escapeHtml(T(s.titleKey))}</div>
      <div class="forward-list">${s.rows.join("")}</div>
    </div>
  `).join("");
}
function globalSearchRowHtml(kind, id, avatarHtml, title, subtitle) {
  return `
    <button type="button" class="forward-row global-search-row" data-kind="${kind}" data-id="${escapeHtml(id || "")}">
      ${avatarHtml || ""}
      <span class="global-search-row-text">
        <span class="global-search-row-title">${title}</span>
        ${subtitle ? `<span class="global-search-row-subtitle muted">${subtitle}</span>` : ""}
      </span>
    </button>
  `;
}
// Один поиск вместо двух: на вкладках с собственным полем (Общение, Контакты, Настройки) лупа в шапке просто ведёт к этому полю,
// а когда в поле есть текст, под ним появляется «Искать везде» — переход в общий поиск (чаты, сообщения, контакты, настройки) с тем же запросом.
const INLINE_SEARCH_FIELDS = { chats: "#global-search", connect: "#contacts-search", settings: "#settings-search", debug: "#debug-search" };
// Поиск живёт в одном месте — лупа в шапке. По нажатию над списком выезжает поле поиска ТЕКУЩЕЙ вкладки (чаты / контакты / настройки);
// под ним — «Искать везде» (общий поиск по чатам, сообщениям, контактам и настройкам с тем же запросом). Пока поиск закрыт, места он не занимает.
function setInlineSearchOpen(open) {
  const root = document.documentElement;
  root.classList.toggle("inline-search-open", !!open);
  if (open) root.setAttribute("data-search-tab", state.tab);
  if (!open) {
    for (const sel of Object.values(INLINE_SEARCH_FIELDS)) {
      const el = $(sel);
      if (el && el.value) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
    }
  }
}
function focusInlineSearchOrGlobal() {
  const sel = INLINE_SEARCH_FIELDS[state.tab];
  const el = sel && !state.chatId && !state.contactCardId ? $(sel) : null;
  if (!el) { openGlobalSearch(); return; }
  const isOpen = document.documentElement.classList.contains("inline-search-open") && document.documentElement.getAttribute("data-search-tab") === state.tab;
  if (isOpen) { setInlineSearchOpen(false); return; }
  setInlineSearchOpen(true);
  setTimeout(() => { try { el.focus(); } catch (e) {} }, 120);
}
// Все три поля (чаты, контакты, настройки) живут в одной «панели поиска» сразу под шапкой — на любой вкладке на одном и том же месте
function wireSearchBridge() {
  let dock = $("#search-dock");
  if (!dock) {
    dock = document.createElement("div"); dock.id = "search-dock";
    const nav = $("#nav-bar"); if (nav) nav.insertAdjacentElement("afterend", dock);
  }
  for (const [tab, sel] of Object.entries(INLINE_SEARCH_FIELDS)) {
    const input = $(sel); if (!input || input.dataset.bridge) continue;
    input.dataset.bridge = "1";
    let host = input.closest(".search-wrap");
    if (!host) { host = document.createElement("div"); host.className = "search-wrap"; input.parentNode.insertBefore(host, input); host.appendChild(input); input.style.marginBottom = ""; }
    host.classList.add("search-collapsible"); host.dataset.searchTab = tab;
    const link = document.createElement("button");
    link.type = "button"; link.className = "search-everywhere"; link.dataset.searchTab = tab;
    link.setAttribute("data-i18n", "search.everywhere"); link.textContent = T("search.everywhere");
    dock.appendChild(host); dock.appendChild(link);
    link.addEventListener("click", () => { const v = input.value.trim(); setInlineSearchOpen(false); openGlobalSearch(v); });
  }
}
// Вкладка «Отладка»: то же поле, что и на других вкладках (в общей панели под шапкой); фильтрует пункты экрана
function wireDebugSearch() {
  const input = $("#debug-search"); if (!input || input.dataset.filterWired) return;
  input.dataset.filterWired = "1";
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    const scr = $("#screen-debug"); if (!scr) return;
    scr.querySelectorAll(".settings-group").forEach((g) => {
      const rows = Array.from(g.querySelectorAll(".settings-row, p.fine"));
      let any = false;
      rows.forEach((r) => {
        const hit = !q || (r.textContent || "").toLowerCase().includes(q) || (r.matches("p.fine") ? false : false);
        // пояснения (p.fine) показываем только без запроса; пункты — по совпадению текста (и вложенные строки считаются отдельно)
        const show = r.matches("p.fine") ? !q : (!q || hit);
        r.classList.toggle("search-hidden", !show);
        if (show && !r.matches("p.fine")) any = true;
      });
      g.classList.toggle("search-hidden", !!q && !any);
    });
  });
}
function wireGlobalSearch() {
  wireDebugSearch();
  const btn = $("#global-search-btn");
  if (btn) btn.addEventListener("click", focusInlineSearchOrGlobal);
  wireSearchBridge();
  const input = $("#global-search-input");
  let searchTimer = null;
  if (input) input.addEventListener("input", (e) => {
    const v = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderGlobalSearchResults(v), 150);
  });
  const resultsEl = $("#global-search-results");
  if (resultsEl) {
    resultsEl.addEventListener("click", (e) => {
      const row = e.target.closest(".global-search-row");
      if (!row) return;
      const kind = row.dataset.kind;
      const id = row.dataset.id;
      if (kind === "chat" || kind === "message" || kind === "call") {
        if (!id || !state.contacts.has(id)) { closeGlobalSearch(); return; }
        closeGlobalSearch();
        try { cancelVoiceRecordingIfLeavingChat(id); } catch (e) {}
        state.multiSelect = null;
        state.chatId = id;
        state.contactCardId = null;
        renderTab();
      } else if (kind === "contact") {
        if (!id || !state.contacts.has(id)) { closeGlobalSearch(); return; }
        closeGlobalSearch();
        openContactCard(id);
      } else if (kind === "settings-category" || kind === "settings-row") {
        closeGlobalSearch();
        navigateToSettingsCategory(id);
      }
    });
  }
  // Cmd/Ctrl+K — стандартный десктопный шорткат для "перейти куда угодно"
  // (VS Code, Slack, Linear и т.п.), уже упомянут в разделах 1/11 роадмапа.
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openGlobalSearch();
    }
  });
  // Esc "на всех шторках" (раздел 11/13 роадмапа) теперь общий
  // document-level хендлер — см. wireEscCloseAnySheet() ниже, подключается
  // отдельно при старте, не только здесь.
}
// Esc закрывает самую верхнюю открытую .sheet, какая бы это ни была —
// во всей кодовой базе ~20 разных шторок, и ВСЕ они без исключения
// управляются одинаково: класс .hidden снимается при открытии и
// добавляется при закрытии (см. wireSheetBackdrops выше, data-close-sheet,
// свайп за .sheet-handle). Это значит, что закрытие — это всегда ровно
// "добавить .hidden", без побочных эффектов, специфичных для конкретной
// шторки (ни одна из них не хранит какое-то дополнительное состояние,
// которое нужно было бы сбрасывать при закрытии именно через Esc, а не
// через крестик/бэкдроп/свайп) — поэтому единый обработчик безопасен для
// всех них сразу, без точечной доработки каждой по отдельности.
// Если открыто несколько шторок одновременно (в норме не происходит, но
// на случай незамеченного состояния) — закрываем последнюю в DOM-порядке,
// т.к. шторки всегда дописываются в конец документа и визуально самая
// "верхняя" по z-index оказывается последней.
function wireEscCloseAnySheet() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const flyout = $("#quick-reaction-flyout");
    if (flyout && !flyout.classList.contains("hidden")) { closeQuickReactionFlyout(); return; }
    const openSheets = $$(".sheet:not(.hidden)");
    if (openSheets.length === 0) return;
    openSheets[openSheets.length - 1].classList.add("hidden");
  });
}
// Раздел 11 — фокус-менеджмент шторок (был в "Сознательно отложено").
// Тот же аргумент об однородности, что выше у wireEscCloseAnySheet:
// все ~20 шторок открываются/закрываются ровно одним и тем же способом
// (снятие/добавление .sheet.hidden, без иных побочных эффектов) — значит
// один MutationObserver на все .sheet сразу безопасно даёт: (1) фокус
// внутрь шторки при открытии, если ничто более специфичное не
// позаботилось об этом само (многие шторки уже фокусируют конкретное
// поле — тот код просто выигрывает гонку, выполняясь позже в своём
// setTimeout, и наш общий автофокус для них невидим); (2) возврат фокуса
// на элемент-источник при закрытии — вместо того, чтобы он проваливался
// в <body>, как было раньше у всех шторок без исключения; (3) Tab-ловушку
// внутри самой верхней открытой шторки, вместо утечки фокуса под неё.
const __sheetReturnFocus = new WeakMap();
function focusableIn(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll('button, [href], input, select, textarea, [tabindex]'))
    .filter((el) => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null && !el.classList.contains("sheet-backdrop"));
}
function wireSheetFocusManagement() {
  const sheets = $$(".sheet");
  if (sheets.length === 0) return;
  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      const el = mut.target;
      if (!(el instanceof Element) || !el.classList.contains("sheet")) continue;
      if (!el.classList.contains("hidden")) {
        if (!__sheetReturnFocus.has(el)) __sheetReturnFocus.set(el, document.activeElement);
        const panel = el.querySelector(".sheet-panel") || el;
        const already = panel.contains(document.activeElement) && document.activeElement !== document.body;
        if (!already) {
          const focusables = focusableIn(panel);
          if (focusables.length > 0) setTimeout(() => { if (!el.classList.contains("hidden") && document.activeElement === document.body) focusables[0].focus(); }, 0);
        }
      } else {
        const src = __sheetReturnFocus.get(el);
        __sheetReturnFocus.delete(el);
        if (src && document.body.contains(src) && typeof src.focus === "function" && document.activeElement === document.body) src.focus();
      }
    }
  });
  sheets.forEach((el) => observer.observe(el, { attributes: true, attributeFilter: ["class"] }));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const openSheets = $$(".sheet:not(.hidden)");
    if (openSheets.length === 0) return;
    const top = openSheets[openSheets.length - 1];
    const panel = top.querySelector(".sheet-panel") || top;
    const focusables = focusableIn(panel);
    if (focusables.length === 0) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
// Cmd/Ctrl+N ("новый чат"/"добавить контакт") — ИССЛЕДОВАНО (раздел 11/13),
// НЕ РЕАЛИЗУЕМО: Ctrl/Cmd+N относится к небольшому списку акселераторов,
// захардкоженных самим браузером как "новое окно" (вместе с Ctrl+T/
// Ctrl+W/Ctrl+Tab и т.п.) — событие keydown для него в принципе не
// доходит до JS страницы ни в Chrome, ни в Firefox, ни в Safari, ни во
// вкладке браузера, ни в установленном PWA-окне. Это не ограничение
// текущей реализации — перехватить такой шорткат из веб-страницы
// невозможно никаким кодом. Остаётся в бэктлоге как "признано
// неприменимым", аналогично тому, как Cmd+Enter был признан
// неприменимым в V.41.0.0 (композер однострочный), только по другой
// причине.

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
    // Фидбек на подходе к разблокировке — иначе пользователь не понимает,
    // что тапы вообще считаются, пока не откроется вкладка на 5-м.
    if (__navTitleTaps.length === 3 || __navTitleTaps.length === 4) haptic("light");
    if (__navTitleTaps.length >= 5) {
      __navTitleTaps = [];
      haptic("medium");
      Store.debugHidden = false;
      applyDebugTabVisibility();
    }
  });
}
// P3.47 — "паника": 5 тапов по логотипу в "О приложении" → подтверждение
// → необратимая мгновенная очистка всех данных устройства и перезапуск
// с чистого листа. Нарочно скрыто за тапами (а не отдельной видимой
// кнопкой в UI) и НЕ требует предварительной разблокировки debug-вкладки
// (в отличие от debug-hard-reset-btn, который делает то же самое, но
// спрятан на 2 экрана глубже) — весь смысл паника-кнопки в том, чтобы
// быть доступной за секунды в стрессовой ситуации, а не быть удобной
// для случайного нажатия.
// Общая необратимая очистка — раньше была только внутри wirePanicButton,
// теперь переиспользуется и встряхиванием (killer-features-backlog 1.7).
function performPanicWipe() {
  try { localStorage.clear(); } catch (e) {}
  if ("caches" in window) { try { caches.keys().then((names) => names.forEach((n) => caches.delete(n))); } catch (e) {} }
  if ("indexedDB" in window) { try { indexedDB.deleteDatabase("ether-db"); } catch (e) {} }
  location.reload();
}
function wirePanicButton() {
  const el = document.getElementById("about-app-logo");
  if (!el) return;
  el.addEventListener("click", async () => {
    const now = Date.now();
    __panicTaps = __panicTaps.filter((t) => now - t < 2000);
    __panicTaps.push(now);
    if (__panicTaps.length >= 5) {
      __panicTaps = [];
      if (!await confirmSheet(T("toast.confirmPanic"), { destructive: true })) return;
      performPanicWipe();
    }
  });
}
// killer-features-backlog 1.7 — Panic Clean (встряхнуть телефон → очистка).
// Честная оговорка (см. Store.panicShakeEnabled выше): DeviceMotion на iOS
// 13+ требует permission-промпт по явному жесту пользователя (запрашиваем
// при включении тумблера) и в принципе ненадёжен в фоне — это ПОЭТОМУ не
// "silent background trigger", а быстрый, но ОТМЕНЯЕМЫЙ (4 секунды) wipe,
// чтобы случайное резкое движение (выпал из рук, активная игра) не стёрло
// данные без шанса передумать.
const SHAKE_THRESHOLD = 35; // м/с² суммарно по 3 осям — эмпирический порог резкого рывка
const SHAKE_DEBOUNCE_MS = 3000;
const SHAKE_WIPE_DELAY_MS = 4000;
let __shakeLastTrigger = 0;
let __shakeWipeTimer = null;
function handleShakeMotion(e) {
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a) return;
  const mag = Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0);
  if (mag < SHAKE_THRESHOLD) return;
  const now = Date.now();
  if (now - __shakeLastTrigger < SHAKE_DEBOUNCE_MS) return;
  __shakeLastTrigger = now;
  triggerPanicShakeWipe();
}
function triggerPanicShakeWipe() {
  if (__shakeWipeTimer) return; // уже отсчитывается — повторный рывок не перезапускает таймер
  const banner = $("#panic-shake-banner"); if (banner) banner.classList.remove("hidden");
  __shakeWipeTimer = setTimeout(() => {
    __shakeWipeTimer = null;
    if (banner) banner.classList.add("hidden");
    performPanicWipe();
  }, SHAKE_WIPE_DELAY_MS);
}
function cancelPanicShakeWipe() {
  if (__shakeWipeTimer) { clearTimeout(__shakeWipeTimer); __shakeWipeTimer = null; }
  const banner = $("#panic-shake-banner"); if (banner) banner.classList.add("hidden");
}
async function requestMotionPermissionIfNeeded() {
  // DeviceMotionEvent.requestPermission существует только на iOS 13+ —
  // на Android и десктопе его просто нет, доступ не требует жеста.
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    try {
      const ok = (await DeviceMotionEvent.requestPermission()) === "granted";
      try { localStorage.setItem("ether.motionOk", ok ? "1" : "0"); } catch (e) {}
      if (ok) wireShakeUndoGuard();
      return ok;
    } catch (e) { return false; }
  }
  return true;
}
// iOS показывает системное окно «Отменить ввод?» при встряхивании, если в фокусе поле с набранным текстом (отключить его из веба
// нельзя), а в PWA оно ещё и ломает раскладку. Лучшее, что можно сделать: как только датчик движения (если доступ уже разрешён)
// видит резкую встряску, снимаем фокус с поля — тогда окно не появляется, а набранный текст остаётся в черновике.
let __shakeUndoGuardOn = false;
function wireShakeUndoGuard() {
  if (__shakeUndoGuardOn || typeof DeviceMotionEvent === "undefined") return;
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    let ok = false; try { ok = localStorage.getItem("ether.motionOk") === "1"; } catch (e) {}
    if (!ok) return; // без разрешения датчик недоступен, ничего не делаем (спрашивать ради этого не будем)
  }
  __shakeUndoGuardOn = true;
  window.addEventListener("devicemotion", (e) => {
    const a = e.accelerationIncludingGravity || e.acceleration; if (!a) return;
    if (Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0) < 32) return;
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) { try { saveCurrentDraft(); } catch (er) {} el.blur(); }
  }, { passive: true });
}
function wirePanicShake() {
  if (typeof DeviceMotionEvent === "undefined") return;
  window.removeEventListener("devicemotion", handleShakeMotion); // идемпотентность — safeCall может дёрнуть дважды
  window.addEventListener("devicemotion", handleShakeMotion);
}
function unwirePanicShake() {
  window.removeEventListener("devicemotion", handleShakeMotion);
  cancelPanicShakeWipe();
}
function wirePanicShakeBanner() {
  const btn = $("#panic-shake-cancel-btn");
  if (btn) btn.addEventListener("click", cancelPanicShakeWipe);
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

  const blockedBtn = $("#settings-blocked-btn");
  if (blockedBtn) blockedBtn.addEventListener("click", () => { renderBlockedSheet(); const el = $("#blocked-sheet"); if (el) el.classList.remove("hidden"); });
  const blockedClose = $("#blocked-close");
  if (blockedClose) blockedClose.addEventListener("click", () => { const el = $("#blocked-sheet"); if (el) el.classList.add("hidden"); });
  const blockedList = $("#blocked-list");
  if (blockedList) blockedList.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-unblock-id]"); if (!btn) return;
    const c = state.contacts.get(btn.dataset.unblockId); if (!c) return;
    c.blocked = false; persistContacts(); toast(T("toast.unblocked")); renderBlockedSheet();
  });
  const storageBtn = $("#debug-storage-btn");
  if (storageBtn) storageBtn.addEventListener("click", async () => { try { await renderStorageSheet(); } catch (e) {} const el = $("#storage-sheet"); if (el) el.classList.remove("hidden"); });
  const storageClose = $("#storage-close");
  if (storageClose) storageClose.addEventListener("click", () => { const el = $("#storage-sheet"); if (el) el.classList.add("hidden"); });
  const clearOldMediaBtn = $("#storage-clear-old-media-btn");
  if (clearOldMediaBtn) clearOldMediaBtn.addEventListener("click", async () => {
    if (!await confirmSheet(T("storage.clearOldMedia") + "?", { destructive: true })) return;
    clearOldMedia(30);
  });
  const turnBtn = $("#turn-check-btn");
  if (turnBtn) turnBtn.addEventListener("click", async () => {
    const out = $("#turn-check-out"); if (!out || turnBtn.__busy) return;
    turnBtn.__busy = true; out.classList.remove("hidden"); out.textContent = T("debug.turnChecking");
    try {
      const rows = typeof window.etherTurnCheck === "function" ? await window.etherTurnCheck() : [];
      out.textContent = rows.length ? rows.map((r) => (r.open ? "✅ " : r.relay ? "⚠️ " : "❌ ") + r.url + (r.relayAddr ? " [" + r.relayAddr + "]" : "") + " — "
        + (r.open ? T("debug.turnOk", { ms: r.openMs }) : r.relay ? T("debug.turnAllocOnly") : T("debug.turnNoAlloc")) + (r.error ? " (" + r.error + ")" : "") + (r.diag ? "\n   " + r.diag : "")).join("\n")
        : T("debug.turnNone");
      rows.forEach((r) => etherLog(r.open ? "info" : "warn", "[turn-check]", r.url, r.open ? "relay OK " + r.openMs + "мс" : r.relay ? "allocation есть, данные не идут" + (r.diag ? " [" + r.diag + "]" : "") : "allocation не получен" + (r.diag ? " [" + r.diag + "]" : "")));
    } catch (e) { out.textContent = String(e && e.message || e); }
    turnBtn.__busy = false;
  });
  const exportDiag = $("#export-diagnostics-btn");
  if (exportDiag) exportDiag.addEventListener("click", exportFullDiagnostics);

  const expBackup = $("#export-backup-btn");
  if (expBackup) expBackup.addEventListener("click", exportBackup);
  const impBackup = $("#import-backup-btn");
  if (impBackup) impBackup.addEventListener("click", () => { const el = $("#import-backup-input"); if (el) el.click(); });
  wireImportBackupInput();

  const reset = $("#reset-all-btn");
  if (reset) reset.addEventListener("click", async () => {
    if (!await confirmSheet(T("toast.confirmDeleteContact", { name: "?" }), { destructive: true })) return;
    for (const id of Array.from(state.contacts.keys())) mesh.remove(id);
    for (const t of autoConnectTimers.values()) clearTimeout(t);
    autoConnectTimers.clear();
    onlineSet.clear(); outbox.clear(); groupDeliveryMap.clear(); pendingNoKey.clear(); seenDeliverIds.clear(); seenGroupInviteIds.clear(); recentlyDeletedIds.clear();
    state.contacts.clear(); state.callLog = []; state.currentCallRecord = null;
    state.lastSeen = {}; state.drafts = {}; state.scheduledMessages = []; state.folders = [];
    // Если в момент сброса был в полёте дебаунс-таймер persistContacts()
    // (см. persistContactsNow выше) — он бы минут через 0.2с воскресил
    // только что обнулённый список из устаревшего __contactsPersistPending.
    if (__contactsPersistTimer) { clearTimeout(__contactsPersistTimer); __contactsPersistTimer = null; }
    __contactsPersistPending = null;
    Store.contactsJson = "[]"; Store.outboxJson = "[]"; Store.groupDeliveryMapJson = "[]"; Store.pendingNoKeyJson = "{}";
    Store.callLogJson = "[]"; Store.lastSeenJson = "{}"; Store.draftsJson = "{}"; Store.recentlyDeletedJson = "{}"; Store.scheduledMessagesJson = "[]";
    Store.chatFoldersJson = "[]"; renderChatFolderChips();
    resetConnectScreen(); renderTab();
  });
  const hard = $("#debug-hard-reset-btn");
  if (hard) hard.addEventListener("click", async () => {
    if (!await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) return;
    performFullAccountWipe();
  });
  // «Удалить аккаунт» в обычных настройках — та же необратимая операция,
  // что и debug-hard-reset-btn (раньше была доступна только за 5 тапов
  // в скрытом Debug-экране), но с явным подтверждением, которое называет
  // вещи своими именами: нет серверной копии, отменить нельзя.
  const delAcc = $("#settings-delete-account-btn");
  if (delAcc) delAcc.addEventListener("click", async () => {
    if (!await confirmSheet(T("toast.confirmDeleteAccount"), { destructive: true })) return;
    performFullAccountWipe();
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
// P2 — отдельный экран "Заблокированные": раньше разблокировать можно
// было только найдя контакт и открыв его карточку, что неудобно, если
// хочешь просто обзору список кого заблокировал.
function renderBlockedSheet() {
  const list = $("#blocked-list");
  const empty = $("#blocked-empty");
  if (!list) return;
  const blocked = Array.from(state.contacts.values()).filter((c) => c.blocked && !isGroup(c));
  list.innerHTML = blocked.map((c) => `
    <div class="forward-row">
      ${avatarCircleHtml(c, "avatar-sm")}
      <span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span>
      <button type="button" class="btn-secondary small" data-unblock-id="${escapeHtml(c.id)}">${escapeHtml(T("chat.contact.unblock"))}</button>
    </div>`).join("");
  if (empty) empty.classList.toggle("hidden", blocked.length > 0);
}
async function renderStorageSheet() {
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
  // IndexedDB (файлы/медиа) + Cache Storage (сервис-воркер) — то, что
  // реально занимает место на диске, в отличие от localStorage (там
  // только метаданные/ссылки). navigator.storage.estimate() не точен
  // по байту, но даёт честный порядок величины.
  let idbSize = "—";
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && typeof est.usage === "number") {
        idbSize = `${(est.usage / 1024 / 1024).toFixed(1)} MB` + (est.quota ? ` / ${(est.quota / 1024 / 1024).toFixed(0)} MB` : "");
      }
    }
  } catch (e) {}
  el.innerHTML = `<div>localStorage: ${(totalBytes / 1024).toFixed(1)} KB, ${items.length} keys</div><div>IndexedDB + Cache: ${escapeHtml(idbSize)}</div>` + buildEnvText();
}
// P1.19 — удаляет блобы (фото/видео/голосовые/документы) старше N дней
// из IndexedDB, не трогая сами сообщения (текст и метаданные остаются,
// просто сам файл станет "недоступен" — как при истёкшем TTL). Текст
// переписки — не то, что обычно раздувает хранилище, медиа — то, что
// нужно.
async function clearOldMedia(days) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let cleared = 0;
  for (const c of state.contacts.values()) {
    const old = c.messages.filter((m) => m.file && m.ts < cutoff);
    for (const m of old) { try { await IDB.del("file:" + m.id); cleared++; } catch (e) {} }
  }
  toast(T("toast.oldMediaCleared"));
  if (state.chatId) { try { renderChatThreadInner(); } catch (e) {} }
  try { await renderStorageSheet(); } catch (e) {}
  return cleared;
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
// Метрики окна/вьюпорта для разбора проблем вёрстки на iPhone (полоса под футером, safe area):
// сравнение innerHeight, screen.height, visualViewport, 100vh/100dvh/100svh/100lvh и инсетов.
function collectViewportMetrics() {
  const out = [];
  const r1 = (n) => (typeof n === "number" && isFinite(n) ? String(Math.round(n * 10) / 10) : "—");
  try {
    const vv = window.visualViewport;
    out.push("Standalone: " + isStandalone() + " (navigator.standalone=" + String(navigator.standalone) + ")");
    out.push("inner: " + r1(window.innerWidth) + "x" + r1(window.innerHeight) + ", outer: " + r1(window.outerWidth) + "x" + r1(window.outerHeight));
    out.push("screen: " + r1(screen.width) + "x" + r1(screen.height) + ", avail: " + r1(screen.availWidth) + "x" + r1(screen.availHeight) + ", dpr: " + r1(window.devicePixelRatio));
    out.push("visualViewport: " + (vv ? r1(vv.width) + "x" + r1(vv.height) + " off(" + r1(vv.offsetLeft) + "," + r1(vv.offsetTop) + ") scale " + r1(vv.scale) : "—"));
    out.push("html client: " + r1(document.documentElement.clientWidth) + "x" + r1(document.documentElement.clientHeight) + ", scrollY: " + r1(window.scrollY));
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;";
    document.body.appendChild(probe);
    const measure = (css) => { probe.style.cssText = "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;" + css; return probe.getBoundingClientRect().height; };
    out.push("100vh: " + r1(measure("height:100vh")) + ", 100dvh: " + r1(measure("height:100dvh")) + ", 100svh: " + r1(measure("height:100svh")) + ", 100lvh: " + r1(measure("height:100lvh")) + ", 100%: " + r1(measure("height:100%")));
    out.push("fixed inset:0 → " + r1(measure("top:0;bottom:0;height:auto;position:fixed")) + ", fill-available: " + r1(measure("height:-webkit-fill-available")));
    out.push("safe-area top/bottom/left/right: " + ["top", "bottom", "left", "right"].map((side) => r1(measure("height:env(safe-area-inset-" + side + ", 0px)"))).join(" / "));
    probe.remove();
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return "—"; const r = el.getBoundingClientRect(); return "top " + r1(r.top) + " bottom " + r1(r.bottom) + " h " + r1(r.height); };
    out.push("body: " + rect("body"));
    out.push("#app-shell: " + rect("#app-shell"));
    out.push("#tab-bar: " + rect("#tab-bar"));
    const vp = document.querySelector('meta[name="viewport"]');
    out.push("viewport meta: " + (vp ? vp.content : "—"));
  } catch (e) { out.push("metrics error: " + String(e)); }
  return out;
}
function buildDiagnosticsText() {
  const lines = [];
  lines.push("Ether — diagnostics, " + APP_VERSION);
  lines.push("Time: " + new Date().toLocaleString(I18N.current));
  lines.push("Lang: " + I18N.current + " / sys " + I18N.systemLang());
  lines.push("My id: " + (Store.myId ? Store.myId.slice(0, 16) + "…" : "—"));
  try {
    const ki = JSON.parse(localStorage.getItem("ether.keyInfo") || "null");
    const seed = typeof fxSeed === "function" ? fxSeed("sigil|" + fxMyKeyString())().toString(16).padStart(8, "0") : "—";
    lines.push("Keys: rune-seed " + seed + (ki ? ", создана " + new Date(ki.at).toLocaleString(I18N.current) + ", создана раз: " + ki.count + (ki.existing ? " (поверх существующего профиля)" : "") : ", создана до V.62.0.4"));
  } catch (e) {}
  lines.push("Signaling: " + effectiveSignalingUrl());
  lines.push("Status: " + (signaling ? (signaling.connected ? "on" : "off") : "—"));
  lines.push("Online: " + onlineSet.size);
  lines.push("outbox: " + outbox.size + ", pendingNoKey: " + pendingNoKey.size);
  lines.push("Call: " + (state.callId ? state.callId.slice(0, 10) + " phase=" + state.callPhase : "—"));
  lines.push("--- viewport ---");
  for (const l of collectViewportMetrics()) lines.push(l);
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
    if (d.lastPair) lines.push("pair: " + d.lastPair);
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
// === Шифрование бэкапа паролем (раздел 2 роадмапа) ===
// PBKDF2(пароль, случайная соль) → AES-GCM 256 ключ, тот же envelope-формат
// {iv, ct, v}, что и CryptoHelper.encryptJson/decryptJson используют для
// ECDH-ключей — AES-GCM не знает и не обязан знать, откуда взялся ключ.
// Забытый пароль делает бэкап безвозвратно нечитаемым — это осознанное
// свойство (без него "шифрование" было бы фикцией с чёрным ходом), а не
// баг, но его необходимо явно объяснять на экране экспорта (см. i18n-ключ
// backup.password.exportHint) — отдельная УХ-задача, помимо собственно
// шифрования, которую сам отчёт выделял как главный риск этого пункта.
const BACKUP_PBKDF2_ITERATIONS = 210000;
const BACKUP_ENCRYPTED_MARKER = "etherEncryptedBackup"; // без точки после "ether" — не пересекается с ключами localStorage вида "ether.xxx"
async function deriveBackupKey(password, saltBytes) {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: BACKUP_PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
// Промис-обёртка вокруг шторки #backup-password-sheet: resolve(password)
// при подтверждении с непустым паролем, resolve(null) при "Без пароля"
// (режим export) или любом способе закрыть шторку не дав пароль (backdrop,
// Esc через общий wireEscCloseAnySheet — ни один из них не знает про этот
// промис, поэтому settle() в wireBackupPasswordSheet подписан через
// MutationObserver на сам факт появления класса .hidden, а не только на
// свои кнопки — иначе промис мог бы повиснуть навечно).
let __backupPasswordResolve = null;
function openBackupPasswordSheet(mode) {
  return new Promise((resolve) => {
    const sheet = $("#backup-password-sheet");
    if (!sheet) { resolve(null); return; }
    __backupPasswordResolve = resolve;
    const title = $("#backup-password-title");
    const hint = $("#backup-password-hint");
    const input = $("#backup-password-input");
    const skipBtn = $("#backup-password-skip");
    if (input) input.value = "";
    const titleKey = mode === "import" ? "backup.password.importTitle" : "backup.password.exportTitle";
    const hintKey = mode === "import" ? "backup.password.importHint" : "backup.password.exportHint";
    if (title) { title.setAttribute("data-i18n", titleKey); title.textContent = T(titleKey); }
    if (hint) { hint.setAttribute("data-i18n", hintKey); hint.textContent = T(hintKey); }
    // При импорте пароль обязателен (иначе нечего расшифровывать) —
    // кнопки "Без пароля" на этом шаге просто нет смысла показывать.
    if (skipBtn) skipBtn.classList.toggle("hidden", mode === "import");
    sheet.classList.remove("hidden");
    if (input) setTimeout(() => input.focus(), 50);
  });
}
let __backupPasswordSheetWired = false;
function wireBackupPasswordSheet() {
  if (__backupPasswordSheetWired) return;
  __backupPasswordSheetWired = true;
  const sheet = $("#backup-password-sheet"); if (!sheet) return;
  const input = $("#backup-password-input");
  const confirmBtn = $("#backup-password-confirm");
  const skipBtn = $("#backup-password-skip");
  const settle = (value) => {
    const resolve = __backupPasswordResolve;
    if (!resolve) return; // уже резолвлено (или шторка открылась не через openBackupPasswordSheet)
    __backupPasswordResolve = null;
    sheet.classList.add("hidden");
    resolve(value);
  };
  if (confirmBtn) confirmBtn.addEventListener("click", () => settle((input && input.value) || null));
  if (skipBtn) skipBtn.addEventListener("click", () => settle(null));
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (confirmBtn) confirmBtn.click(); } });
  // Закрытие шторки ЛЮБЫМ другим путём (backdrop-клик через общий
  // wireSheetBackdrops, Esc через wireEscCloseAnySheet) — эти обработчики
  // просто навешивают .hidden и ничего не знают про наш промис.
  // MutationObserver перехватывает сам факт появления .hidden и
  // резолвит оставшийся промис как "отмена" (null), не оставляя его
  // висеть навечно, даже если settle() выше не был вызван напрямую.
  new MutationObserver(() => {
    if (sheet.classList.contains("hidden")) settle(null);
  }).observe(sheet, { attributes: true, attributeFilter: ["class"] });
}
// Воркер — singleton, создаётся лениво при первом реальном экспорте/
// импорте бэкапа (не на старте приложения, это не нужно почти никому
// каждый сеанс). Если конструктор Worker бросил исключение (очень
// старый браузер, ограничение окружения) — getCryptoWorker() вернёт
// null один раз и дальше вызывающий код просто считает на основном
// потоке, как было до этой версии; никакой деградации корректности.
let __cryptoWorker = null;
let __cryptoWorkerFailed = false;
let __cryptoWorkerReqId = 0;
const __cryptoWorkerPending = new Map();
function getCryptoWorker() {
  if (__cryptoWorkerFailed) return null;
  if (__cryptoWorker) return __cryptoWorker;
  try {
    __cryptoWorker = new Worker("js/crypto-worker.js");
    __cryptoWorker.onmessage = (ev) => {
      const { reqId, ok, envelope, data, error } = ev.data || {};
      const pending = __cryptoWorkerPending.get(reqId);
      if (!pending) return;
      __cryptoWorkerPending.delete(reqId);
      if (ok) pending.resolve({ envelope, data }); else pending.reject(new Error(error || "crypto worker error"));
    };
    __cryptoWorker.onerror = () => {
      // Воркер упал целиком (не отдельный запрос, а сам поток) —
      // отклоняем всё, что всё ещё ждёт ответа, и больше не пытаемся
      // создать новый: дальнейшие вызовы сразу идут на основной поток.
      for (const [, pending] of __cryptoWorkerPending) pending.reject(new Error("crypto worker crashed"));
      __cryptoWorkerPending.clear();
      __cryptoWorkerFailed = true;
      __cryptoWorker = null;
    };
  } catch (e) { __cryptoWorkerFailed = true; return null; }
  return __cryptoWorker;
}
function runInCryptoWorker(action, msg) {
  const worker = getCryptoWorker();
  if (!worker) return Promise.reject(new Error("crypto worker unavailable"));
  const reqId = ++__cryptoWorkerReqId;
  return new Promise((resolve, reject) => {
    __cryptoWorkerPending.set(reqId, { resolve, reject });
    worker.postMessage(Object.assign({ reqId, action }, msg));
  });
}
// encrypt у бэкапа не имеет понятия "неверный пароль" (пароль здесь
// просто вход для KDF, не проверка) — поэтому любую ошибку воркера тут
// безопасно считать поводом пересчитать на основном потоке, без риска
// замаскировать настоящую семантическую ошибку.
async function encryptBackupPayload(password, salt, data) {
  try {
    const res = await runInCryptoWorker("encrypt", { password, salt, data });
    return res.envelope;
  } catch (e) {
    const key = await deriveBackupKey(password, salt);
    return CryptoHelper.encryptJson(key, data);
  }
}
// decrypt — наоборот, ошибка воркера МОЖЕТ означать "неверный пароль"
// (AES-GCM не прошёл проверку подлинности). Пересчёт на основном потоке
// в этом случае просто повторит ту же ошибку (цена — одна лишняя
// PBKDF2 на 210000 итераций в редком случае опечатки в пароле, не в
// горячем пути), но зато единообразен с encryptBackupPayload и не
// пытается угадывать причину ошибки по тексту сообщения.
async function decryptBackupPayload(password, salt, envelope) {
  try {
    const res = await runInCryptoWorker("decrypt", { password, salt, envelope });
    return res.data;
  } catch (e) {
    const key = await deriveBackupKey(password, salt);
    return CryptoHelper.decryptJson(key, envelope);
  }
}
async function exportBackup() {
  persistContactsNow(); // гарантируем, что дебаунс-таймер не "съест" последние изменения
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("ether.")) data[k] = localStorage.getItem(k);
  }
  let payload = data;
  let password = null;
  try { password = await openBackupPasswordSheet("export"); } catch (e) {}
  if (password) {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const envelope = await encryptBackupPayload(password, salt, data);
      payload = { [BACKUP_ENCRYPTED_MARKER]: true, kdf: "PBKDF2", iterations: BACKUP_PBKDF2_ITERATIONS, salt: arrayBufferToBase64(salt), envelope };
    } catch (e) {
      etherLog("error", "[backup] encryption failed, falling back to plain export:", String(e));
      payload = data; // шифрование не удалось (например, WebCrypto недоступен) — честнее отдать обычный бэкап, чем вообще ничего
    }
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(blob, `ether-backup-${new Date().toISOString().slice(0, 10)}.json`);
  toast(T("toast.backupSaved"));
}
async function importBackup(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  await importBackupFile(file);
}
// Вынесено из importBackup() отдельно: drag-and-drop файла бэкапа прямо
// на карточку онбординга (см. wireOnboardingOnce) даёт File через
// DataTransfer, а не через <input type="file">, так что общая логика
// не может зависеть от ev.target.
async function importBackupFile(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("bad");
    let data = parsed;
    if (parsed[BACKUP_ENCRYPTED_MARKER]) {
      const password = await openBackupPasswordSheet("import");
      if (!password) return; // пользователь закрыл шторку без пароля — тихо отменяем импорт, а не падаем с ошибкой
      try {
        const salt = base64ToUint8Array(parsed.salt);
        data = await decryptBackupPayload(password, salt, parsed.envelope);
      } catch (e) {
        toast(T("toast.wrongBackupPassword"));
        return;
      }
    }
    if (!data || typeof data !== "object") throw new Error("bad");
    // Файл без единого ключа ether.* — не бэкап; без этой проверки импорт
    // стёр бы все локальные данные и ничего не восстановил.
    if (!Object.keys(data).some((k) => k.startsWith("ether.") && typeof data[k] === "string")) throw new Error("bad");
    if (!await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) return;
    // Отменяем (не сбрасываем!) любой "летящий" дебаунс-таймер
    // persistContacts() — он держит СТАРЫЙ снимок контактов (ещё с ДО
    // импорта) и, сработав в течение 800мс до reload ниже, переписал бы
    // поверх только что импортированных данных это старьё.
    if (__contactsPersistTimer) { clearTimeout(__contactsPersistTimer); __contactsPersistTimer = null; }
    __contactsPersistPending = null;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("ether.")) localStorage.removeItem(k);
    }
    for (const k of Object.keys(data)) if (k.startsWith("ether.") && typeof data[k] === "string") localStorage.setItem(k, data[k]);
    toast(T("toast.imported"));
    setTimeout(() => location.reload(), 800);
  } catch (e) { toast(String(e.message)); }
}

// =====================================================================
// Mesh события
// =====================================================================
function wireMeshEvents() {
  if (typeof gcallWire === "function") gcallWire();
  // Показ экрана прервали через системный UI браузера, а не через нашу
  // кнопку (см. PeerLink.startScreenShare/screenTrack.onended в webrtc.js)
  // — синхронизируем кнопку обратно в неактивное состояние.
  mesh.addEventListener("screen-share-ended", (ev) => {
    if (ev.detail && ev.detail.id === state.callId) {
      const btn = $("#call-screenshare-btn"); if (btn) btn.classList.remove("active");
      { const cs0 = $("#call-screen"); if (cs0) cs0.classList.remove("sharing"); updateCallButtonsSupport(); }
    }
  });
  mesh.addEventListener("relay-fallback", (ev) => {
    const rid = ev.detail.id;
    setTimeout(() => {
      const l = mesh.get(rid);
      if (l && (l.status === "connected" || l.status === "in-call")) return;
      attemptConnect(rid, true).catch(() => {});
    }, 400);
  });
  mesh.addEventListener("link-status", (ev) => {
    try {
      const { id, status } = ev.detail;
      const c = state.contacts.get(id); if (!c) return;
      const wasConnected = c.status === "connected" || c.status === "in-call";
      c.status = status;
      etherLog("info", "[link] " + String(id).slice(0, 10) + "…", "status=" + status);
      if (status === "connected" || status === "in-call") connectFails.delete(id);
      if (status === "connected" && !wasConnected) {
        const link = mesh.get(id);
        if (link && link.remoteName) c.name = link.remoteName;
        if (c.managed) persistContacts();
        toast(T("toast.peerOnline", { name: c.name }));
        clearAutoConnectTimer(id);
        if (state.pendingOutgoing && state.pendingOutgoing.id === id) resetConnectScreen();
        sendPrivacyPrefsTo(id);
        // Если этот контакт состоит в ОБЩЕЙ со мной группе — пересылаю
        // ему актуальный ростер при каждом переподключении. Раньше
        // ростер уходил ТОЛЬКО при явном действии в группе (добавили/
        // убрали участника) — если у НЕГО данные группы пропали
        // (переустановка приложения, своего бэкапа контактов/групп нет),
        // ничего не пересылало её заново, пока кто-то не совершит новое
        // действие. Группа просто не появлялась у вернувшегося участника.
        for (const g of state.contacts.values()) {
          if (g.isGroup && g.members.some((m) => m.id === id)) sendGroupRosterTo(g, id);
        }

        if (state.callId === id && link) {
          if (state.callPhase === "calling") {
            if (!link._audioAdded) {
              link.startCall(state.callWantsVideo).then(() => {
                if (state.callWantsVideo) { showLocalVideoPreview(link); requestWakeLock(); }
                // P2P установлен = собеседник в сети и его экран входящего
                // уже открыт. Обновляем фазу на "Гудки…" — независимо от
                // того, дошёл ли call-invite-ack через сигналинг (он мог
                // отвалиться на секунду). Раньше пользователь видел
                // "Вызов…" до явного ack'а или таймаута, даже когда
                // звонок фактически уже дозвонился.
                if (state.callId === id && state.callPhase === "calling") {
                  const p = $("#call-phase");
                  if (p) p.textContent = T("call.ringing");
                }
              }).catch((e) => etherLog("error", "[call] caller startCall failed:", String(e)));
            } else if (state.callWantsVideo && !link._videoAdded) {
              link.enableVideo().then((ok) => { if (ok) showLocalVideoPreview(link); }).catch((e) => etherLog("error", "[call] caller enableVideo failed:", String(e)));
            }
          } else if (state._callUserAccepted && state.callPhase !== "active") {
            link.answerCall(state.callWantsVideo).then(() => {
              if (state.callWantsVideo) { showLocalVideoPreview(link); requestWakeLock(); }
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
              // P2P-путь реально сработал (answerCall завершился успешно) —
              // ТОЛЬКО ТЕПЕРЬ уведомляем сигнальный сервер, что мы приняли.
              // Раньше серверный call-accepted уходил из acceptCall() ДО
              // link.answerCall: если P2P падал (микрофон запрещён,
              // getUserMedia упал, ICE не прошёл) — собеседник видел
              // "принято", хотя звонок не поднялся. Best-effort: если
              // сигналинг недоступен, не критично — P2P-путь уже работает.
              if (signaling && signaling.connected && state.callId === id) {
                try { signaling.signal(id, { t: "call-accepted" }); } catch (e) {}
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
if (payload && typeof payload.kind === "string" && payload.kind.indexOf("fx") === 0) { if (typeof handleFxPayload === "function") handleFxPayload(id, payload); return; }
if (payload && payload.kind === "gcall") { if (typeof handleGroupCallPayload === "function") handleGroupCallPayload(id, payload); return; }
if (payload && payload.kind === "call-state") {
  // Групповой звонок идёт — входящий 1:1 получает «занято»
  if (payload.state === "ringing" && typeof gcallBusy === "function" && gcallBusy()) {
    const lb = mesh.get(id); if (lb) { try { lb.declineCall("busy"); } catch (e) {} }
    return;
  }
  // Свежесть пакета. Если сообщение старше 20 секунд — оно пришло из
  // буфера iOS (приложение спало, а собеседник звонил). Реальный
  // звонок в этот момент уже давно отбит — рингтон играть не надо.
  const isStale = payload.ts && (Date.now() - payload.ts > 20000);

  // Второй входящий от ДРУГОГО контакта, пока первый ещё звонит, тоже должен получить «занято» (раньше молча игнорировался).
  if (payload.state === "ringing" && state.callId !== id && (state.callId || state.callPhase !== "ringing")) {
    if (isStale) {
      etherLog("info", "[call] игнорирую устаревший call-state:ringing от " + String(id).slice(0, 10) + "… (" + Math.round((Date.now() - payload.ts) / 1000) + "с назад)");
      return;
    }
    const recent = recentlyEndedCalls.get(id);
    if (recent && Date.now() - recent < RECENTLY_ENDED_CALL_MS) {
      etherLog("info", "[call] игнорирую повторный ringing после недавнего отбоя");
      return;
    }
    if (state.callId) {
      const l = mesh.get(id);
      if (l) { try { l.declineCall("busy"); } catch (e) {} }
      return;
    }
    state.callWantsVideo = !!payload.video;
    openCallScreen(id, "ringing");
    try { ensureAudioCtx(); } catch (e) {}
    playRingtone();
  }
  if (payload.state === "screen" && state.callId === id && !isStale) {
    const cs1 = $("#call-screen"); if (cs1) cs1.classList.toggle("remote-screen", !!payload.on);
  }
  if (payload.state === "accepted" && state.callId === id && !isStale) setCallPhaseActive();
  if (payload.state === "declined" && state.callId === id && !isStale) {
    toast(T("calls.declined"));
    if (payload.reason === "busy") playBusySound(); else playNoAnswerSound();
    const link = mesh.get(id); if (link) link.endCall();
    closeCallScreen("declined");
  }
  if (payload.state === "ended" && state.callId === id && !isStale) {
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
      if (payload && payload.kind === "chat") sendAckBatch(id, [payload.id], "delivered");
    } catch (e) {
      etherLog("error", "[message] handler failed:", String(e && e.stack || e));
    }
  });
  mesh.addEventListener("remote-track", (ev) => {
    try {
      const { id, stream, track } = ev.detail;
      // Раньше это условие проверяло ТОЛЬКО "callId===id && не active" и
      // буферизовало поток — но если callId вообще не совпадает с id (мы
      // не в звонке с этим контактом, например, собеседник не отреагировал
      // на call-busy и всё равно продолжил слать медиа), код проваливался
      // прямо в attachRemoteAudio без проверки. attachRemoteVideo сам
      // внутри себя проверяет state.callId !== id — attachRemoteAudio такой
      // защиты не имеет, поэтому тут нужна она явно, симметрично.
      if (state.callId !== id) return;
      if (state.callPhase !== "active") { pendingRemoteStreams.set(id, stream); return; }
      attachRemoteAudio(id, stream);
      if (track && track.kind === "video") attachRemoteVideo(id, stream);
    } catch (e) {
      etherLog("error", "[remote-track] handler failed:", String(e && e.stack || e));
    }
  });
  mesh.addEventListener("ice-candidate", (ev) => {
    // Trickle ICE — отправляем КАЖДЫЙ собранный кандидат собеседнику
    // отдельным сигналом. До этой правки это событие никто не слушал:
    // кандидаты накапливались в _iceCandidates (только для диагностики),
    // а собеседник узнавал о них лишь из SDP — поэтому и приходилось
    // ждать полного gather ДО отправки offer/answer (см. webrtc.js).
    const { id, candidate } = ev.detail;
    if (!candidate) return;
    if (!signaling || !signaling.connected) return;
    try {
      const json = candidate.toJSON ? candidate.toJSON() : candidate;
      signaling.signal(id, { t: "ice", candidate: json });
    } catch (e) {}
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
    const files = Array.from(fileInput.files || []);
    handlePickedFiles(files);
    fileInput.value = "";
  });
}
const cameraInput = $("#chat-camera-input");
if (cameraInput) {
  cameraInput.addEventListener("change", () => {
    const files = Array.from(cameraInput.files || []);
    cameraInput.value = "";
    // Снимок с СИСТЕМНОЙ камеры (capture="environment") — пользователь
    // уже подтвердил кадр в самой камере (отдельный экран с галочкой/
    // пересъёмкой — это UI ОС, не наш). Прогонять его ещё и через
    // handlePickedFiles → openMediaComposeSheet значит показать ВТОРОЙ
    // экран подтверждения с полем подписи поверх уже принятого решения —
    // раздражающее двойное подтверждение. Поэтому снимок уходит сразу,
    // в отличие от обычного выбора файлов (#chat-file-input), где
    // openMediaComposeSheet — первое и единственное подтверждение.
    if (!files.length || !state.chatId) return;
    sendFileMessage(state.chatId, files[0]);
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
      scheduleDraftPersist();
      sendTypingStart(state.chatId);
      clearTimeout(typingSendTimer);
      typingSendTimer = setTimeout(() => sendTypingStop(state.chatId), TYPING_DEBOUNCE_MS);
      updateMentionAutocomplete();
    });
    input.addEventListener("blur", () => { if (state.chatId) sendTypingStop(state.chatId); closeMentionAutocomplete(); });
    input.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeMentionAutocomplete(); });
  }
  wireMentionAutocomplete();
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
  const retryAllBtn = $("#chat-retry-all-btn");
  if (retryAllBtn) retryAllBtn.addEventListener("click", () => {
    const id = state.chatId; if (!id) return;
    retryAllFailed(id).then(() => { if (state.chatId === id) renderChatThreadInner(); if (state.tab === "chats") renderChatsList(); });
  });
  const pinnedJump = $("#pinned-msg-jump");
  if (pinnedJump) pinnedJump.addEventListener("click", () => {
    const c = state.chatId && state.contacts.get(state.chatId); if (!c || !c.pinnedMessageId) return;
    const el = document.querySelector(`.bubble[data-msg-id="${CSS.escape(c.pinnedMessageId)}"]`);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("jump-highlight"); setTimeout(() => el.classList.remove("jump-highlight"), 1200); }
  });
  const pinnedUnpin = $("#pinned-msg-unpin");
  if (pinnedUnpin) pinnedUnpin.addEventListener("click", () => {
    const id = state.chatId; if (!id) return;
    const c = state.contacts.get(id); if (!c) return;
    c.pinnedMessageId = null; persistContacts(); renderChatThreadInner();
  });
  const msCancel = $("#multiselect-cancel-btn");
  if (msCancel) msCancel.addEventListener("click", () => exitMultiSelect());
  const msDelete = $("#multiselect-delete-btn");
  if (msDelete) msDelete.addEventListener("click", async () => {
    const id = state.chatId; if (!id || !state.multiSelect) return;
    if (!await confirmSheet(T("chat.selectMsgs.deleteConfirm", { n: state.multiSelect.size }), { destructive: true })) return;
    for (const msgId of state.multiSelect) deleteMessageLocal(id, msgId, true);
    persistContacts();
    if (state.chatId === id) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    exitMultiSelect();
  });
  const msForward = $("#multiselect-forward-btn");
  if (msForward) msForward.addEventListener("click", () => {
    const id = state.chatId; if (!id || !state.multiSelect || state.multiSelect.size === 0) return;
    const ids = Array.from(state.multiSelect);
    openForwardSheet((toId) => { for (const msgId of ids) forwardMessage(msgId, id, toId); });
    exitMultiSelect();
  });
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
  wireChatEdgeBackGesture();
}
// Свайп от самого левого края экрана закрывает открытый чат — привычный
// iOS-жест "назад", дополняющий кнопку "‹" в шапке. Срабатывает только
// если палец стартовал в первых 24px экрана (почти никогда не совпадает
// с пузырём сообщения — у того есть свой свайп-ответ, см. attachSwipeReply)
// и палец ушёл по горизонтали больше чем по вертикали.
function wireChatEdgeBackGesture() {
  const chatScreenEl = $("#screen-chat");
  if (!chatScreenEl || chatScreenEl.dataset.edgeBackWired) return;
  chatScreenEl.dataset.edgeBackWired = "1";
  let edgeStartX = 0, edgeStartY = 0, edgeTracking = false;
  chatScreenEl.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (t.clientX < 24 && Math.abs(t.clientY - window.innerHeight / 2) < window.innerHeight / 2) {
      edgeStartX = t.clientX; edgeStartY = t.clientY;
      edgeTracking = true;
    } else edgeTracking = false;
  }, { passive: true });
  chatScreenEl.addEventListener("touchmove", (e) => {
    if (!edgeTracking) return;
    const t = e.touches[0];
    if (Math.abs(t.clientY - edgeStartY) > 60) { edgeTracking = false; return; }
  }, { passive: true });
  chatScreenEl.addEventListener("touchend", (e) => {
    if (!edgeTracking) return;
    edgeTracking = false;
    const t = e.changedTouches[0];
    if (t.clientX - edgeStartX > 80) {
      closeChatSafely();
      if (navigator.vibrate) try { navigator.vibrate(5); } catch (e) {}
    }
  }, { passive: true });
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
    // Очистка "залипшей" Media Session. startBackgroundAudioSession() в более
    // ранних версиях объявляла активную mediaSession и оставляла её висеть —
    // iOS показывает "Now Playing" виджет на экране блокировки, пока
    // приложение явно не скажет metadata = null и playbackState = "none".
    // Приложение её не очищает при закрытии, поэтому чистим сами при старте.
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      }
    } catch (e) {}
    // Также останавливаем любые случайно оставшиеся аудио-элементы —
    // помимо виджета они держат активную аудио-сессию, которая мешает
    // Web Audio воспроизводить короткие тоны (звук сообщения при этом
    // просто не слышен, хотя осциллятор формально запускается).
    try {
      document.querySelectorAll("audio").forEach((el) => {
        try { el.pause(); el.currentTime = 0; } catch (e) {}
      });
    } catch (e) {}
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
  try { if (typeof leaveGroupCall === "function") leaveGroupCall({ silent: true }); } catch (e) {}
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
  try { persistContactsNow(); } catch (e) {}
  try { backupToIDB(); } catch (e) {}
  shutdownCallIfActive();
});
// Уход в фон (сворачивание, переключение вкладки) на мобильных — не менее
// вероятная точка "внезапной смерти" процесса, чем beforeunload, который
// на iOS Safari часто просто не успевает сработать. Сбрасываем дебаунс
// persistContacts() и здесь же, не дожидаясь unload.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    try { persistContactsNow(); } catch (e) {}
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // Сбрасываем очередь Web Audio при возврате на передний план.
    // Пока приложение было в фоне, playMessageSound могла накопить
    // __nextSoundAt (осцилляторы не играли — ctx был suspended, но
    // расписание заполнялось). Без сброса первый же звук после возврата
    // прозвучит "отложенно", с уже накопленным временным сдвигом.
    __nextSoundAt = 0;
    // iOS замораживает setInterval в фоне — пока приложение спало,
    // _lastPongAt не обновлялся, и первый же тик после возврата видел
    // "no pong for 137s" (реальная цифра из лога) и ЗАКРЫВАЛ рабочее
    // соединение. На самом деле соединение было живо — просто мы его
    // сами не "проверяли" из-за заморозки. Обновляем _lastPongAt
    // принудительно: реальная проверка произойдёт при следующем пинге
    // через 5 секунд, если собеседник действительно отвалился.
    if (mesh && mesh.links) {
      for (const link of mesh.links.values()) {
        if (link._lastPongAt) link._lastPongAt = Date.now();
      }
    }
    if (signaling && signaling._lastPongAt) signaling._lastPongAt = Date.now();
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
    // Wake Lock автоматически освобождается браузером при уходе
    // вкладки/приложения в фон (это часть спецификации, не баг) —
    // при возврате на передний план запрашиваем заново, если в этот
    // момент идёт видеозвонок. Без этого экран начинал гаснуть по
    // таймауту ОС после каждого переключения в другое приложение и
    // обратно, хотя видеозвонок продолжался.
    if (state.callId && state.callWantsVideo) requestWakeLock();
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