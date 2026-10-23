"use strict";
// Часть 2 из 14 бывшего js/app.js: Логирование, состояние, утилиты, превью ссылок. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Логирование
// =====================================================================
window.__etherDiag = window.__etherDiag || [];
// etherLog определяет signaling-client.js (грузится раньше).
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
  threadRoot: null,
  typingSendingState: new Map(),
  unlockAttempts: 0,
  _callUserAccepted: false,
  _callAcceptInFlight: false,
  _callMuteOnAnswer: false,
  _callDeadSeconds: 0,
  _lastCallFailedAt: 0,   // ← новое
  pinReorder: false,      // режим порядка закреплённых чатов (ручки перетаскивания видны только в нём)
  _unlockLockedUntil: 0,  // до какого момента экран PIN заблокирован после неверных попыток
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
const linkPreviewAllowed = new Set(); // ссылки, для которых вы нажали «Показать превью» (режим «спрашивать»)
const seenGroupInviteIds = new Set(); // отдельно от seenDeliverIds, чтобы инвайты не вытесняли обычные id
// Окно дедупликации входящих: по времени (24 ч), а не только по числу — при плотном потоке старые id раньше вытеснялись за минуты
// и повторная доставка проходила как новое сообщение. Лимит по числу остаётся страховкой по памяти.
const SEEN_DELIVER_TTL_MS = 24 * 3600e3;
const seenDeliverIds = new Map(); // ключ — "from|msgId", не голый msgId (см. ниже); значение — когда видели
function rememberDeliverId(key) {
  const now = Date.now();
  seenDeliverIds.set(key, now);
  for (const [k, t] of seenDeliverIds) { if (now - t > SEEN_DELIVER_TTL_MS || seenDeliverIds.size > SEEN_DELIVER_LIMIT * 4) seenDeliverIds.delete(k); else break; }
}
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
// iOS показывает на экране блокировки виджет «Now Playing» (название страницы, 0:00 и кнопка ▶) после ЛЮБОГО звука, сыгранного через
// <audio> в фоне — звук сообщения, рингтон, гудки. Виджет не исчезает сам. Поэтому после каждого такого звука снимаем медиасессию
// (метаданные, состояние и обработчики кнопок) — несколько раз, т.к. iOS обновляет виджет с задержкой.
function clearNowPlaying() {
  const run = () => {
    try {
      if (!("mediaSession" in navigator)) return;
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      for (const a of ["play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack", "stop"]) { try { navigator.mediaSession.setActionHandler(a, null); } catch (e) {} }
    } catch (e) {}
  };
  run(); setTimeout(run, 400); setTimeout(run, 1500); setTimeout(run, 4000);
}
let dialingAudioEl = null;

function getSoundEl(src, loop) {
  let el = soundPool.get(src);
  if (!el) {
    el = document.createElement("audio");
    el.src = src;
    el.preload = "auto";
    el.loop = !!loop;
    el.setAttribute("playsinline", "");
    el.setAttribute("x-webkit-airplay", "deny"); el.disableRemotePlayback = true; // не показывать AirPlay/пульт для служебных звуков
    el.addEventListener("ended", clearNowPlaying);
    el.addEventListener("pause", () => { clearTimeout(el.__npTimer); el.__npTimer = setTimeout(() => { if (el.paused) clearNowPlaying(); }, 300); });
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

// Тихий WAV (≈0,1 с тишины): разблокировка пула идёт именно им, а не настоящими звуками. Раньше на первом касании после запуска
// «разблокировка» проигрывала ВСЕ рингтоны, звонки и сигналы сообщений «почти беззвучно» (volume = 0.01) — но на iOS громкость
// элемента программно не меняется, и пользователь слышал их все разом, хотя ни звонка, ни сообщений не было.
let __silentWavUri = "";
function silentWavUri() {
  if (__silentWavUri) return __silentWavUri;
  const n = 800, buf = new Uint8Array(44 + n), dv = new DataView(buf.buffer);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) buf[o + i] = t.charCodeAt(i); };
  str(0, "RIFF"); dv.setUint32(4, 36 + n, true); str(8, "WAVE"); str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); str(36, "data"); dv.setUint32(40, n, true);
  buf.fill(128, 44);
  let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return (__silentWavUri = "data:audio/wav;base64," + btoa(bin));
}
function unlockSoundPool() {
  for (const src of [...Object.values(RINGTONES), ...Object.values(SOUND_FILES), ...Object.values(MESSAGE_SOUND_FILES)]) {
    const el = getSoundEl(src, false);
    if (el.dataset.unlocked || el.dataset.unlocking) continue;
    // Не трогаем элемент, который прямо сейчас играет по делу (идёт звонок): это не разблокировка, а помеха
    if (!el.paused) continue;
    el.dataset.unlocking = "1";
    const originalLoop = el.loop;
    let finished = false;
    const finish = (ok) => {
      if (finished) return; finished = true;
      try { el.pause(); } catch (e) {}
      try { el.muted = false; el.volume = 1; el.src = src; el.loop = originalLoop; el.currentTime = 0; } catch (e) {}
      if (ok) el.dataset.unlocked = "1";
      delete el.dataset.unlocking;
    };
    try {
      el.muted = true;
      el.src = silentWavUri();
      const p = el.play();
      if (p && typeof p.then === "function") p.then(() => finish(true)).catch(() => finish(false));
      else finish(true);
      setTimeout(() => finish(false), 1500); // страховка: если play() завис, возвращаем элемент в исходное состояние
    } catch (e) { finish(false); }
  }
}
// Вернулись в приложение: всё, что «зависло» в очереди воспроизведения, пока оно было в фоне (iOS откладывает play() и
// запускает позже), снимаем — если звонка сейчас нет. Иначе рингтон и сигналы вдруг играли бы при открытии приложения.
function silenceStaleSounds() {
  if (state && (state.callId || state.callPhase === "ringing")) return;
  for (const el of soundPool.values()) {
    if (el.dataset && el.dataset.unlocking) continue;
    try { if (!el.paused || el.currentTime > 0) { el.pause(); el.currentTime = 0; } } catch (e) {}
  }
  try { stopRingtone(); } catch (e) {}
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) silenceStaleSounds(); });
window.addEventListener("pageshow", () => silenceStaleSounds());

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
    if (u.start > lastIdx) result += nl2br(applyMarkdown(highlightMentions(highlightRaw(escapeHtml(text.slice(lastIdx, u.start)), query))));
    const hrefUrl = u.normalized; // https://... даже для "голого" домена — иначе браузер трактует как относительный путь
    const displayText = escapeHtml(u.raw); // показываем то, что пользователь реально написал (без добавленного https://)
    result += `<a href="${escapeHtml(hrefUrl)}" target="_blank" rel="noopener noreferrer">${highlightRaw(displayText, query)}</a>`;
    lastIdx = u.end;
  }
  if (lastIdx < text.length) result += nl2br(applyMarkdown(highlightMentions(highlightRaw(escapeHtml(text.slice(lastIdx)), query))));
  return result || nl2br(esc);
}
// Переносы строк из многострочного ввода показываем как <br> (текст к этому моменту уже экранирован).
function nl2br(html) { return String(html).replace(/\r?\n/g, "<br>"); }
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
  // NUL — служебный разделитель плейсхолдеров ниже: во входе он позволил бы подделать \u0000CODE0\u0000
  if (html.indexOf("\u0000") !== -1) html = html.replace(/\u0000/g, "");
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
  if (cached && cached.errAt && Date.now() - cached.errAt > 60000) linkPreviewCache.delete(url); // временная ошибка кэшируется лишь на минуту
  else if (cached) return cached.status === "pending" ? null : cached;
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
    const r = await fetch(base + "/link-preview?url=" + encodeURIComponent(url), { cache: "default", signal: (() => { const ac = new AbortController(); setTimeout(() => ac.abort(), 10000); return ac.signal; })() });
    if (r.status === 204) { const none = { status: "none", data: null }; linkPreviewCache.set(url, none); return none; } // «превью нет» — это ответ, а не «ещё в пути»: слот должен исчезнуть
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    const entry = { status: "done", data };
    linkPreviewCache.set(url, entry);
    return entry;
  } catch (e) {
    const none = { status: "none", data: null, errAt: Date.now() };
    linkPreviewCache.set(url, none);
    return none;
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
try { if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("error", (ev) => { const t = ev && ev.target; if (t && t.classList && t.classList.contains("link-preview-img")) { try { t.remove(); } catch (e) {} } }, true); } catch (e) {}
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
  // Картинку тянем через прокси нашего сервера (/link-preview-image): браузер не обращается к чужому сайту напрямую, IP пользователя не раскрывается.
  // Старый сервер без эндпоинта отдаст 404 — слушатель ошибок ниже уберёт сломанную картинку, карточка останется без неё.
  const imgBase = data.image && /^https?:\/\//i.test(data.image) ? signalingHttpBase() : "";
  const img = imgBase ? `<img class="link-preview-img" src="${escapeHtml(imgBase + "/link-preview-image?url=" + encodeURIComponent(data.image))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "";
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
  // Текст уже экранирован (&amp; &quot; …) и может содержать разметку ссылок: подсвечиваем только в «чистых» кусках, а сущности и теги не трогаем —
  // иначе запрос «amp» или «a» вставил бы <mark> внутрь &amp; и сломал отображение.
  return escapedText.split(/(&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);|<[^>]*>)/i).map((part, k) => {
    if (k % 2 === 1) return part;
    let lower = part.toLowerCase();
    // toLowerCase меняет длину у части символов («İ» → «i̇»): тогда индексы в lower не равны индексам в part — строим карту соответствия
    let mapS = null, mapE = null;
    if (lower.length !== part.length) {
      lower = ""; mapS = []; mapE = []; let pos = 0;
      for (const ch of part) {
        const l = ch.toLowerCase();
        for (let u = 0; u < l.length; u++) { mapS.push(pos); mapE.push(pos + ch.length); }
        lower += l; pos += ch.length;
      }
    }
    let idx = lower.indexOf(q); if (idx === -1) return part;
    let out = "", i = 0;
    while (idx !== -1) {
      const s0 = mapS ? mapS[idx] : idx;
      const e0 = mapS ? mapE[idx + q.length - 1] : idx + q.length;
      if (s0 >= i) { out += part.slice(i, s0) + `<mark class="search-hit">` + part.slice(s0, e0) + `</mark>`; i = e0; }
      idx = lower.indexOf(q, idx + q.length);
    }
    return out + part.slice(i);
  }).join("");
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
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  if (hh === 0 && mm === 0) return T("status.seconds", { n: ss });
  if (hh === 0) return `${mm}:${String(ss).padStart(2, "0")}`;
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
// Часы звонка: «мм:сс», а от часа — «ч:мм:сс» (раньше 97 минут показывались как «97:28»).
function formatClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000)), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${p2(mm)}:${p2(ss)}` : `${p2(mm)}:${p2(ss)}`;
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

let __themeApplied = false, __themeFadeTimer = null;
function applyTheme(theme) {
  // OLED — отдельная тема для выбора пользователем (настоящий чёрный фон
  // экономит заряд на AMOLED-экранах), но на уровне CSS-переменных она
  // работает как тёмная: html[data-theme="oled"] переопределяет только
  // --bg-0/--bg-1 в styles.css, остального (акценты, текст) не трогает.
  // Плавная смена темы: на 300 мс включаем переходы цветов (на первой установке при запуске — без них)
  if (__themeApplied && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const root = document.documentElement; root.classList.add("theme-fading");
    clearTimeout(__themeFadeTimer); __themeFadeTimer = setTimeout(() => root.classList.remove("theme-fading"), 340);
  }
  __themeApplied = true;
  document.documentElement.dataset.theme = theme;
  __isLightCache = null; // инвалидируем кэш — тема поменялась
  const isLight = theme === "light" || (theme === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.scheme = isLight ? "light" : "dark"; // CSS опирается на data-scheme, а не на media-дубли
  const meta = document.querySelector('meta[name="theme-color"]');
  // Обновлено под новую палитру: --bg-0 тёмный и --bg-0 светлый
  // совпадают с meta[theme-color] — статус-бар iOS теперь всегда
  // сливается с фоном приложения.
  if (meta) meta.setAttribute("content", isLight ? "#fafafc" : (theme === "oled" ? "#000000" : "#08080a"));
  try { if (typeof Skins !== "undefined") Skins.syncMeta(); } catch (e) {}
}
// Dynamic Type: режим «Как в системе» берёт размер из системной настройки текста (в Safari/iOS — шрифт -apple-system-body, 17px = 100%).
// В других браузерах шрифт не распознаётся, множитель остаётся 1.
const DT_BASE = { "--fs-xs": 11, "--fs-sm": 13, "--fs-base": 15, "--fs-md": 17, "--fs-lg": 22, "--fs-xl": 28, "--fs-2xl": 34 };
function systemTextScale() {
  try {
    if (typeof CSS === "undefined" || !CSS.supports || !CSS.supports("font", "-apple-system-body")) return 1;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;font:-apple-system-body";
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize); probe.remove();
    if (!isFinite(px) || px <= 0) return 1;
    return Math.min(1.6, Math.max(0.85, px / 17));
  } catch (e) { return 1; }
}
function applyDynamicType() {
  const st = document.documentElement.style;
  if ((Store.fontSize || "normal") !== "system") { st.removeProperty("--ui-scale"); for (const k in DT_BASE) st.removeProperty(k); return; }
  const r = systemTextScale();
  st.setProperty("--ui-scale", String(+r.toFixed(3)));
  for (const k in DT_BASE) st.setProperty(k, Math.round(DT_BASE[k] * r * 10) / 10 + "px");
}
function applyChatAppearancePrefs() {
  const messages = $("#chat-messages");
  if (messages) {
    messages.dataset.wallpaper = Store.chatWallpaper || "none";
    messages.style.setProperty("--wp1", Store.wallpaperColor1); messages.style.setProperty("--wp2", Store.wallpaperColor2);
  }
  document.documentElement.dataset.bubbleSize = Store.bubbleSize || "normal";
  document.documentElement.dataset.fontSize = Store.fontSize || "normal";
  applyDynamicType();
  document.documentElement.dataset.readable = Store.readableMode ? "1" : "0";
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

