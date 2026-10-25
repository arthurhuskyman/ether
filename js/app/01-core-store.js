"use strict";
// Часть 1 из 14 бывшего js/app.js: Ядро: константы, IndexedDB-обёртка, Store. Глобальная область общая; порядок <script> важен.

// Держать в синхроне с файлом VERSION в корне проекта и с CACHE_VERSION
// в sw.js при каждом повышении версии — здесь оно только для показа в
// "О приложении" (#about-version), больше нигде не участвует.
const APP_VERSION = "V.79.0.0";

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
  { id: "profile", labelKey: "settings.category.profile", icon: "user" },
  { id: "privacy", labelKey: "settings.category.privacy", icon: "shield" },
  { id: "notifications", labelKey: "settings.category.notifications", icon: "bell" },
  { id: "appearance", labelKey: "settings.category.appearance", icon: "palette" },
  { id: "data", labelKey: "settings.category.data", icon: "database" },
  { id: "help", labelKey: "settings.category.help", icon: "help" },
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
// Громкость удалённого потока по умолчанию — 100% (общую громкость задаёт системная кнопка). Раньше было 33,33%: собеседник слышал
// звонок «еле-еле», а у тех, кто двигал ползунок, — громко: «у одного громко, у другого тихо».
const DEFAULT_CALL_VOLUME = 1;
const LEGACY_CALL_VOLUME = 0.3333; // прежний умолчательный (не выбранный пользователем) уровень — считаем «не выбирал»

// Активный сервер: автомат фейловера (js/serverlist.js, getFailover() в 10-signaling.js) -> поле «Сервер» -> встроенный по умолчанию.
// Для пользователя с одним сервером результат тот же, что и раньше.
function effectiveSignalingUrl() {
  let u = "";
  try { if (typeof getFailover === "function") u = getFailover().current(); } catch (e) {}
  return (u || Store.signalingUrl || DEFAULT_SIGNALING_URL).trim();
}

// =====================================================================
// IndexedDB
// =====================================================================
// Идёт полный сброс (выход/стирание): никакая запись — ни в localStorage, ни в IndexedDB — не должна «воскресить» стёртое
// (beforeunload и отложенные сохранения срабатывают уже после очистки)
let __wiping = false;
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
        req.onsuccess = () => {
          const db = req.result;
          // соединение закрыто браузером / новая версия БД — сбрасываем кэш, чтобы следующий вызов открыл заново
          db.onclose = () => { if (dbPromise === p) dbPromise = null; };
          db.onversionchange = () => { try { db.close(); } catch (e) {} if (dbPromise === p) dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => {};
      } catch (e) { reject(e); }
    });
    const p = dbPromise;
    // отклонённый промис не кэшируем: иначе IDB остаётся сломанным до перезагрузки
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
    return p;
  }
  const SEALED_TEXT_KEYS = new Set(["contactsPrev", "contactsCorrupt"]);
  async function set(key, value, opts) {
    if (__wiping) return null;
    try {
      if (typeof SecureStore !== "undefined" && SecureStore.isActive() && !(opts && opts.plain)) {
        if (typeof key === "string" && key.indexOf("file:") === 0 && value instanceof Blob) value = await SecureStore.sealBlob(value);
        else if (SEALED_TEXT_KEYS.has(key) && typeof value === "string") value = await SecureStore.sealText(value);
      }
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
        r.onsuccess = async () => {
          let v = r.result;
          try {
            if (typeof SecureStore !== "undefined") {
              if (v && typeof v === "object" && v.__enc === 1) v = await SecureStore.openBlob(v);
              else if (SEALED_TEXT_KEYS.has(key) && typeof v === "string") v = await SecureStore.openText(v);
            }
          } catch (e) { v = undefined; }
          res(v);
        };
        r.onerror = () => res(undefined);
        tx.onabort = () => res(undefined);
      });
    } catch (e) { return undefined; }
  }
  async function del(key) {
    if (__wiping) return null;
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
  // Закрыть соединение (нужно перед deleteDatabase, иначе удаление ждёт, пока его отпустят)
  async function close() { const p = dbPromise; dbPromise = null; try { if (p) (await p).close(); } catch (e) {} }
  return { open, set, get, del, close };
})();

const CRITICAL_LS_KEYS = [
  "ether.name", "ether.identityRaw", "ether.myId",
  "ether.privKey", "ether.pubKey",
  "ether.pinHash", "ether.pinSalt", "ether.pinEnabled",
  "ether.contacts",
  "ether.outbox", "ether.pendingNoKey", "ether.recentlyDeleted",
  "ether.theme", "ether.skin", "ether.glassAlpha", "ether.sec.on", "ether.sec.salt", "ether.sec.check", "ether.ratchet", "ether.heldDeliveries", "ether.seenMsgIds", "ether.scheduledMessages", "ether.groupDeliveryMap",
  "ether.notifications", "ether.sounds", "ether.ringtone", "ether.linkPreviews", "ether.linkPreviewMode",
  "ether.vapidPublicKey", "ether.pushSubscription",
  "ether.callLog", "ether.lastSeen", "ether.drafts",
  "ether.callVolume", "ether.lang", "ether.recentReactions",
  "ether.chatFolders", "ether.emojiSkinTone", "ether.recentEmoji", "ether.myAvatar",
  "ether.translateEndpoint", "ether.translateApiKey",
  "ether.readable", "ether.fxInit", "ether.requireVerifiedCalls", "ether.localAi", "ether.localAiLang", "ether.stories", "ether.quietOn", "ether.quietFrom", "ether.quietTo", "ether.wpColor1", "ether.wpColor2", "ether.chatWallpaper", "ether.voiceSpeed", "ether.deadManEnabled", "ether.deadManThresholdDays", "ether.deadManContactId", "ether.deadManLastSentAt",
  "ether.panicShakeEnabled", "ether.fx", "ether.sigKey", "ether.fx.aurora", "ether.keyInfo",
  "ether.claimToken", "ether.phoneDiscover", "ether.phoneDiscoverName", "ether.idMig",
  "ether.servers", "ether.serversOff", "ether.srvShare", "ether.fx.campfires", "ether.receiptsEnabled", "ether.lastSeenVisible", "ether.presenceVisible", "ether.myStatus",
];

// Резервная копия ключей в IndexedDB берёт значения «как лежат на диске» (при включённом шифровании — шифртекст), а не расшифрованные из памяти
const lsRaw = (k) => (typeof SecureStore !== "undefined" ? SecureStore.rawGet(k) : localStorage.getItem(k));
async function backupToIDB() {
  for (const k of CRITICAL_LS_KEYS) {
    const v = lsRaw(k);
    if (v !== null) await IDB.set(k, v);
    else await IDB.del(k); // ключ удалён из localStorage (или перешёл в шифрованное хранение) — копия в IDB не должна воскреснуть при старте
  }
}
async function restoreFromIDB() {
  let aborted = false;
  const work = (async () => {
    for (const k of CRITICAL_LS_KEYS) {
      if (aborted) return;
      if (lsRaw(k) !== null) continue;
      const v = await IDB.get(k);
      if (aborted) return;
      if (v !== null && v !== undefined) { if (typeof SecureStore !== "undefined") SecureStore.rawSet(k, v); else localStorage.setItem(k, v); }
    }
  })();
  // зависшая IndexedDB не должна блокировать старт приложения
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => { aborted = true; res(); }, 3000); });
  try { await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
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
  // Claim-токен id (TOFU, см. signaling-server/server.js): случайный секрет устройства, создаётся при первой регистрации и едет в резервной копии.
  // По сети уходит только claimProof() = sha256("ether-claim-v1|"+токен), сам токен — никогда. Пока хранилище заблокировано PIN-кодом, токен недоступен ("").
  get claimToken() {
    try {
      if (typeof SecureStore !== "undefined" && SecureStore.isOn() && !SecureStore.isActive()) return "";
      let t = localStorage.getItem("ether.claimToken") || "";
      if (!/^[0-9a-f]{64}$/.test(t)) {
        t = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join("");
        localStorage.setItem("ether.claimToken", t); scheduleIDBBackup();
      }
      return t;
    } catch (e) { return ""; }
  },
  get signalingUrl() { return localStorage.getItem("ether.signalingUrl") || ""; },
  set signalingUrl(v) { localStorage.setItem("ether.signalingUrl", v); },
  get discoverable() { return localStorage.getItem("ether.discoverable") !== "0"; },
  set discoverable(v) { localStorage.setItem("ether.discoverable", v ? "1" : "0"); },
  // Поиск по хэшу телефона/почты (discovery.js): добровольно, по умолчанию ВЫКЛ (в отличие от discoverable — публичного ростера)
  get phoneDiscover() { return localStorage.getItem("ether.phoneDiscover") === "1"; },
  set phoneDiscover(v) { localStorage.setItem("ether.phoneDiscover", v ? "1" : "0"); scheduleIDBBackup(); },
  get phoneDiscoverName() { return localStorage.getItem("ether.phoneDiscoverName") === "1"; },
  set phoneDiscoverName(v) { localStorage.setItem("ether.phoneDiscoverName", v ? "1" : "0"); scheduleIDBBackup(); },
  // Три тумблера приватности — независимы от discoverable (тот про
  // публичный ростер для незнакомцев, эти про то, что видят уже
  // добавленные контакты). Двусторонне: моё значение влияет на то, что
  // видят ОНИ (через P2P privacy-pref payload), не на то, что вижу я
  // сам про них — это решает уже ИХ собственное значение.
  get receiptsEnabled() { return localStorage.getItem("ether.receiptsEnabled") !== "0"; },
  set receiptsEnabled(v) { localStorage.setItem("ether.receiptsEnabled", v ? "1" : "0"); scheduleIDBBackup(); broadcastPrivacyPrefs(); },
  get lastSeenVisible() { return localStorage.getItem("ether.lastSeenVisible") !== "0"; },
  set lastSeenVisible(v) { localStorage.setItem("ether.lastSeenVisible", v ? "1" : "0"); scheduleIDBBackup(); broadcastPrivacyPrefs(); },
  get presenceVisible() { return localStorage.getItem("ether.presenceVisible") !== "0"; },
  set presenceVisible(v) { localStorage.setItem("ether.presenceVisible", v ? "1" : "0"); scheduleIDBBackup(); broadcastPrivacyPrefs(); },
  // Превью ссылок: "off" — никогда; "ask" — по нажатию на конкретной ссылке (по умолчанию: сервер сам открывает ссылку с чужого IP,
  // поэтому делать это без вашего решения нельзя); "auto" — всегда сразу. Старый переключатель ether.linkPreviews ("1" → auto, "0" → off) учитывается.
  get linkPreviewMode() {
    const m = localStorage.getItem("ether.linkPreviewMode");
    if (m === "off" || m === "ask" || m === "auto") return m;
    const v = localStorage.getItem("ether.linkPreviews");
    return v === "1" ? "auto" : v === "0" ? "off" : "ask";
  },
  set linkPreviewMode(v) { localStorage.setItem("ether.linkPreviewMode", v === "off" || v === "auto" ? v : "ask"); scheduleIDBBackup(); },
  get linkPreviewsEnabled() { return this.linkPreviewMode === "auto"; },
  set linkPreviewsEnabled(v) { localStorage.setItem("ether.linkPreviews", v ? "1" : "0"); localStorage.removeItem("ether.linkPreviewMode"); scheduleIDBBackup(); },
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
  // кто-то из двоих реально откроет Мессенджер — это предел того, что может
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
  get storiesJson() { return localStorage.getItem("ether.stories") || "[]"; },
  set storiesJson(v) { localStorage.setItem("ether.stories", v); scheduleIDBBackup(); },
  get requireVerifiedCalls() { return localStorage.getItem("ether.requireVerifiedCalls") === "1"; },
  set requireVerifiedCalls(v) { localStorage.setItem("ether.requireVerifiedCalls", v ? "1" : "0"); scheduleIDBBackup(); },
  get quietOn() { return localStorage.getItem("ether.quietOn") === "1"; },
  set quietOn(v) { localStorage.setItem("ether.quietOn", v ? "1" : "0"); scheduleIDBBackup(); },
  get quietFrom() { const v = localStorage.getItem("ether.quietFrom"); return /^\d\d:\d\d$/.test(v || "") ? v : "23:00"; },
  set quietFrom(v) { if (/^\d\d:\d\d$/.test(v)) { localStorage.setItem("ether.quietFrom", v); scheduleIDBBackup(); } },
  get quietTo() { const v = localStorage.getItem("ether.quietTo"); return /^\d\d:\d\d$/.test(v || "") ? v : "07:00"; },
  set quietTo(v) { if (/^\d\d:\d\d$/.test(v)) { localStorage.setItem("ether.quietTo", v); scheduleIDBBackup(); } },
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
  get skin() { return localStorage.getItem("ether.skin") || "default"; },
  set skin(v) { localStorage.setItem("ether.skin", v); scheduleIDBBackup(); },
  get theme() { return localStorage.getItem("ether.theme") || "auto"; },
  set theme(v) { localStorage.setItem("ether.theme", v); scheduleIDBBackup(); },
  get callVolume() {
    const raw = parseFloat(localStorage.getItem("ether.callVolume") || String(DEFAULT_CALL_VOLUME));
    if (!Number.isFinite(raw) || Math.abs(raw - LEGACY_CALL_VOLUME) < 0.0005) return DEFAULT_CALL_VOLUME;
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
  // Звонки: только TURN-relay (скрывает IP от собеседника) и опциональный отчёт о качестве (по умолчанию выключены)
  get hideIpInCalls() { return localStorage.getItem("ether.hideIpInCalls") === "1"; },
  set hideIpInCalls(v) { localStorage.setItem("ether.hideIpInCalls", v ? "1" : "0"); },
  get callReport() { return localStorage.getItem("ether.callReport") === "1"; },
  set callReport(v) { localStorage.setItem("ether.callReport", v ? "1" : "0"); },
  get chatWallpaper() { return localStorage.getItem("ether.chatWallpaper") || "none"; },
  set chatWallpaper(v) { localStorage.setItem("ether.chatWallpaper", v); scheduleIDBBackup(); },
  get wallpaperColor1() { const v = localStorage.getItem("ether.wpColor1"); return /^#[0-9a-f]{6}$/i.test(v || "") ? v : "#6d5dfc"; },
  set wallpaperColor1(v) { if (/^#[0-9a-f]{6}$/i.test(v)) { localStorage.setItem("ether.wpColor1", v); scheduleIDBBackup(); } },
  get wallpaperColor2() { const v = localStorage.getItem("ether.wpColor2"); return /^#[0-9a-f]{6}$/i.test(v || "") ? v : "#ff7ab6"; },
  set wallpaperColor2(v) { if (/^#[0-9a-f]{6}$/i.test(v)) { localStorage.setItem("ether.wpColor2", v); scheduleIDBBackup(); } },
  get bubbleSize() { return localStorage.getItem("ether.bubbleSize") || "normal"; },
  set bubbleSize(v) { localStorage.setItem("ether.bubbleSize", v); scheduleIDBBackup(); },
  // Отдельно от bubbleSize: тот меняет только размер/паддинг ПУЗЫРЕЙ
  // сообщений, этот — размер ВСЕГО текста приложения (доступность).
  get fontSize() { return localStorage.getItem("ether.fontSize") || "normal"; },
  set fontSize(v) { localStorage.setItem("ether.fontSize", v); scheduleIDBBackup(); },
  get readableMode() { return localStorage.getItem("ether.readable") === "1"; },
  set readableMode(v) { localStorage.setItem("ether.readable", v ? "1" : "0"); scheduleIDBBackup(); },
  get calmMode() { return localStorage.getItem("ether.calmMode") === "1"; },
  set calmMode(v) { localStorage.setItem("ether.calmMode", v ? "1" : "0"); scheduleIDBBackup(); },
  get myAvatar() { return localStorage.getItem("ether.myAvatar") || ""; },
  set myAvatar(v) { if (v) localStorage.setItem("ether.myAvatar", v); else localStorage.removeItem("ether.myAvatar"); scheduleIDBBackup(); broadcastPrivacyPrefs(); },
  get myStatus() { return localStorage.getItem("ether.myStatus") || ""; },
  set myStatus(v) { localStorage.setItem("ether.myStatus", v || ""); scheduleIDBBackup(); broadcastPrivacyPrefs(); },
};

