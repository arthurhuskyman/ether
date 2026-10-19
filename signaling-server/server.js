require("dotenv").config();

// Сигнальный сервер Эфир с поддержкой Web Push + прокси ICE-серверов.
//
// Задачи:
//   (1) рандеву — двум устройствам сообщить, что они онлайн, и один раз
//       переслать offer/answer;
//   (2) почтовый ящик — придержать зашифрованное сообщение до появления
//       адресата;
//   (3) Web Push — послать системное уведомление через Apple Push Service,
//       когда приложение адресата закрыто;
//   (4) прокси ICE — выдать клиенту TURN-credentials от Metered, не
//       раскрывая API-ключ.
//
// ВАЖНО: конверт зашифрован end-to-end, сервер не видит содержимого.
// Но для маршрутизации и решений о push он получает открытое поле `kind`.
// Push отправляется ТОЛЬКО для kind === "chat" и "call".

const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { extractMeta } = require("./meta-extract");
const { imageMimeOk, isPrivateIp, validatePushSubscription, validLang, clientIpFrom, sanitizeForLog } = require("./guards");

// Ни одна неожиданная ошибка не должна ронять релей: логируем и живём дальше.
process.on("uncaughtException", (e) => { try { console.error("[fatal-guard] uncaughtException:", sanitizeForLog(e && e.stack || e, 500)); } catch (e2) {} });
process.on("unhandledRejection", (e) => { try { console.error("[fatal-guard] unhandledRejection:", sanitizeForLog(e && e.stack || e, 500)); } catch (e2) {} });

// За прокси (Render и т.п.) IP клиента — ПОСЛЕДНЯЯ запись X-Forwarded-For (её дописывает прокси). TRUST_PROXY=0 — не доверять заголовку.
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";
const clientIp = (req) => clientIpFrom(req, TRUST_PROXY);

let webpush = null;
try { webpush = require("web-push"); }
catch (e) { console.warn("[push] пакет web-push не установлен — push отключён"); }

const PORT = process.env.PORT || 8787;
const envInt = (name, def) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : def; };
const PREKEYS_MAX = envInt("PREKEYS_MAX", 50000);
const MAX_MAILBOX_PER_USER = envInt("MAILBOX_MAX_PER_USER", 500);
const MAX_MAILBOX_PER_SENDER = envInt("MAILBOX_MAX_PER_SENDER", 250);
const MAX_MAILBOX_TOTAL_ENTRIES = envInt("MAILBOX_MAX_TOTAL_ENTRIES", 100000);
const MAX_MAILBOX_TOTAL_BYTES = envInt("MAILBOX_MAX_TOTAL_BYTES", 400 * 1024 * 1024); // приблизительно, по длине ct и служебному запасу
const MAX_SIGNAL_SOCKETS_PER_IP = envInt("MAX_SOCKETS_PER_IP", 40);
const REGISTER_DEADLINE_MS = envInt("REGISTER_DEADLINE_MS", 15000);
const MAX_PUSH_SUBS = envInt("MAX_PUSH_SUBS", 20000);
// MAX_PAYLOAD — потолок на весь WS-фрейм целиком (текст, deliver с
// файлом/голосовым через kind:"file", сигналинг звонков). Офлайн-файлы
// (sendFileOffline/sendVoiceOffline в app.js) ограничены на клиенте
// MAX_FILE_SIZE = 2МБ; после base64 (~2.73МБ) укладываются и в это, и
// в потолок isValidEnvelope на ct (см. ниже) с запасом.
const MAX_PAYLOAD = 8 * 1024 * 1024;
// Файлы в mailbox не должны копиться вечно — в отличие от текста,
// каждая запись весит МНОГО больше. 48 часов — разумное окно для
// "получатель скоро зайдёт в сеть", не бесконечное хранение.
const MAILBOX_FILE_TTL_MS = 48 * 60 * 60 * 1000;

const PUSH_THROTTLE_MS = 30 * 1000;
const PUSH_DEDUP_TTL_MS = 10 * 60 * 1000;
const PUSH_AFTER_MS = 5000;
const pushSentForMsgId = new Map();
const callInvitePushSent = new Map(); // packet.x -> ts — от повторной отправки ОДНОГО И ТОГО ЖЕ call-invite (например, ретрай после переподключения клиента) получатель не должен получать второй push на ту же самую попытку звонка
const CALL_INVITE_PUSH_DEDUP_TTL_MS = 60 * 1000;

// ---------- TURN (ICE) ----------
// Metered.ca теперь требует оплаты и не используется — переменная
// METERED_API_KEY удалена из окружения на Render. Убрана и сама ветка
// кода, а не просто оставлена мёртвым, никогда не срабатывающим путём.
// Основной механизм TURN теперь — статические креденшлы (ExpressTURN
// или любой другой провайдер со статическим логином/паролем).
const ICE_CACHE_MS = 5 * 60 * 1000;
const ICE_RATE_LIMIT_PER_MIN = 20;

const FALLBACK_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
// ExpressTURN (или любой другой провайдер со СТАТИЧЕСКИМИ, не
// генерируемыми на сессию, креденшлами) — задаётся через переменные
// окружения, подставляется в ответ /ice напрямую, без HTTP-запроса
// за креденшлами на каждую сессию (в отличие от провайдеров с
// динамической выдачей учётных данных через свой API).
// TURN_STATIC_URL пример: "turn:free.expressturn.com:3478"
const TURN_STATIC_URL = process.env.TURN_STATIC_URL || "";
const TURN_STATIC_USERNAME = process.env.TURN_STATIC_USERNAME || "";
const TURN_STATIC_PASSWORD = process.env.TURN_STATIC_PASSWORD || "";
// Временные креды по схеме TURN REST API (coturn: use-auth-secret + static-auth-secret). Если задан TURN_STATIC_SECRET, вместо вечных
// TURN_STATIC_USERNAME/PASSWORD (устаревший способ — их можно раздать кому угодно навсегда) выдаются креды с истечением:
//   username = "<unix-время-истечения>:ether", credential = base64(HMAC-SHA1(secret, username)); срок жизни — TURN_TTL_SECONDS (24 ч).
const TURN_STATIC_SECRET = process.env.TURN_STATIC_SECRET || "";
const TURN_TTL_SECONDS = envInt("TURN_TTL_SECONDS", 86400);
function turnRestCredentials(secret, ttlSeconds, nowMs) {
  const username = (Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000) + ttlSeconds) + ":ether";
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}
// Запасной TURN-провайдер (например, с TLS на 443): TURN_EXTRA_JSON='[{"urls":["turns:host:443?transport=tcp"],"username":"u","credential":"p"}]'
// Принимает чистый JSON-массив ИЛИ JS-фрагмент, как его показывают панели провайдеров (Metered: "var myPeer = new Peer({config:{iceServers:[{urls:'…',username:'…'}]}})"):
// берётся первый сбалансированный массив [ … ], ключи без кавычек и одинарные кавычки приводятся к JSON, лишние запятые убираются. Код не исполняется.
function parseLooseIceArray(raw) {
  const s = String(raw || "");
  try { const j = JSON.parse(s); if (Array.isArray(j)) return j; } catch (e) {}
  const start = s.indexOf("[");
  if (start < 0) throw new Error("не найден массив [ … ]");
  let depth = 0, end = -1, quote = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error("массив не закрыт");
  let t = s.slice(start, end + 1);
  t = t.replace(/'([^'"\\]*)'/g, '"$1"');                      // одинарные кавычки → двойные
  t = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":'); // ключи без кавычек
  t = t.replace(/,\s*([}\]])/g, "$1");                         // хвостовые запятые
  const j = JSON.parse(t);
  if (!Array.isArray(j)) throw new Error("не массив");
  return j;
}
function extraTurnServers() {
  try {
    const raw = process.env.TURN_EXTRA_JSON; if (!raw) return [];
    const arr = parseLooseIceArray(raw);
    return arr.filter((x) => x && x.urls && x.username && x.credential);
  } catch (e) { console.warn("[ice] TURN_EXTRA_JSON не разобран:", String(e && e.message || e)); return []; }
}
// Cloudflare Realtime TURN (бесплатный тариф, надёжный; порты 443/80 по TCP/TLS). Нужны CF_TURN_KEY_ID и CF_TURN_API_TOKEN
// (Cloudflare → Realtime → TURN → Create). Временные креды запрашиваются по API и кэшируются на сутки.
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || "";
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN || "";
const CF_TURN_API_BASE = process.env.CF_TURN_API_BASE || "https://rtc.live.cloudflare.com";
const CF_TURN_TTL_S = 86400;
let cfTurnCache = { server: null, expiresAt: 0 };
async function cloudflareTurnServer() {
  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) return null;
  const now = Date.now();
  if (cfTurnCache.server && cfTurnCache.expiresAt - now > 3600_000) return cfTurnCache.server;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    let r;
    try {
      r = await fetch(CF_TURN_API_BASE + "/v1/turn/keys/" + encodeURIComponent(CF_TURN_KEY_ID) + "/credentials/generate", {
        method: "POST",
        headers: { "Authorization": "Bearer " + CF_TURN_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: CF_TURN_TTL_S }),
        signal: ctl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const s = j && j.iceServers;
    const urls = s && [].concat(s.urls || []).filter((u) => /^turns?:/i.test(u));
    if (!urls || !urls.length || !s.username || !s.credential) throw new Error("неожиданный ответ");
    const server = { urls, username: s.username, credential: s.credential };
    cfTurnCache = { server, expiresAt: now + CF_TURN_TTL_S * 1000 };
    console.log("[ice] Cloudflare TURN: креды получены (" + urls.length + " адресов)");
    return server;
  } catch (e) {
    console.warn("[ice] Cloudflare TURN недоступен:", String(e && e.message || e));
    // Старые креды ещё живы — лучше отдать их, чем ничего
    return cfTurnCache.server && cfTurnCache.expiresAt > now ? cfTurnCache.server : null;
  }
}
function staticTurnServers() {
  if (!TURN_STATIC_URL) return null;
  if (!TURN_STATIC_SECRET && (!TURN_STATIC_USERNAME || !TURN_STATIC_PASSWORD)) return null;
  const cred = TURN_STATIC_SECRET ? turnRestCredentials(TURN_STATIC_SECRET, TURN_TTL_SECONDS) : { username: TURN_STATIC_USERNAME, credential: TURN_STATIC_PASSWORD };
  // TURN_STATIC_URL может содержать несколько адресов через запятую/пробел. К каждому turn:host:port
  // добавляем вариант ?transport=tcp — когда UDP режется провайдером (DPI), relay по TCP/TLS всё ещё проходит.
  const base = TURN_STATIC_URL.split(/[\s,]+/).filter(Boolean);
  const urls = [];
  for (const u of base) {
    urls.push(u);
    if (/^turn:/i.test(u) && !/transport=/i.test(u)) urls.push(u + "?transport=tcp");
  }
  return [
    { urls: Array.from(new Set(urls)), username: cred.username, credential: cred.credential },
    ...extraTurnServers(),
    { urls: "stun:stun.l.google.com:19302" },
  ];
}

// Общая логика очистки rate-limit карт. Раньше у каждой карты (iceHits,
// registerHits, signalHits, deliverHits, pushSubHits) была только чистка
// "по возрасту" — если за минуту приходило много разных ключей (IP,
// myId), все они остаются свежими, и карта растёт без предела. У
// linkPreviewHits уже был жёсткий предел по количеству (см. ниже) — тот
// же приём вынесен сюда, чтобы применить единообразно везде.
const RL_MAX_ENTRIES = 5000;
const RL_STALE_MS = 120_000;
function pruneRateLimitMap(map) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.start > RL_STALE_MS) map.delete(k);
  if (map.size > RL_MAX_ENTRIES) {
    const toRemove = map.size - Math.floor(RL_MAX_ENTRIES * 0.9);
    let removed = 0;
    for (const k of map.keys()) { // порядок Map = давность последнего обращения (см. rlGet): вытесняем самые «холодные» ключи
      if (removed >= toRemove) break;
      map.delete(k);
      removed++;
    }
  }
}
// LRU: при каждом обращении ключ удаляется и вставляется заново — активный ключ всегда в конце Map и
// не вытесняется потоком одноразовых ключей.
function rlGet(map, key, now) {
  const w = map.get(key);
  if (w) map.delete(key);
  return w || { start: now, n: 0 };
}

let iceCache = { at: 0, servers: null };
const iceHits = new Map(); // ip -> { start, n }

function rateLimitOk(ip) {
  const now = Date.now();
  const w = rlGet(iceHits, ip, now);
  if (now - w.start > 60_000) { w.start = now; w.n = 0; }
  w.n++;
  iceHits.set(ip, w);
  if (iceHits.size > 5000) pruneRateLimitMap(iceHits);
  return w.n <= ICE_RATE_LIMIT_PER_MIN;
}

// Отдельный, независимый лимит на попытки регистрации с одного IP.
// Сервер не проверяет владение номером/email (id — просто хэш) — это
// известное ограничение (см. README). Полноценная защита требует
// верификации номера/почты; пока это не сделано, лимит хотя бы
// затрудняет автоматический перебор чужих id с одного источника.
const REGISTER_RATE_LIMIT_PER_MIN = 15;
const registerHits = new Map();
function registerRateLimitOk(ip) {
  const now = Date.now();
  const w = rlGet(registerHits, ip, now);
  if (now - w.start > 60_000) { w.start = now; w.n = 0; }
  w.n++;
  registerHits.set(ip, w);
  if (registerHits.size > 5000) pruneRateLimitMap(registerHits);
  return w.n <= REGISTER_RATE_LIMIT_PER_MIN;
}

// На /ice, /link-preview и register лимиты уже были — на signal/deliver
// не было вовсе, хотя это WS-сообщения, а не HTTP-запросы: один
// скомпрометированный/сбойный клиент мог бы залить сервер тысячами
// пакетов в секунду. Лимитируем по myId (уже зарегистрированное
// соединение), не по IP — тут это точнее отражает угрозу.
const SIGNAL_RATE_LIMIT_PER_MIN = 120; // выше, чем deliver — сюда же идут SDP offer/answer/ICE-кандидаты при живом WebRTC-согласовании, всплеск легитимен
// DELIVER_RATE_LIMIT_PER_MIN считается по ПАРЕ (отправитель → получатель),
// а не по одному отправителю — см. wsRateLimitPairOk. sendGroupMessage
// делает по одному deliver на каждого участника группы, поэтому лимит
// "на отправителя вообще" упирался бы в потолок уже на 6 сообщениях
// в группе из 10 человек.
const DELIVER_RATE_LIMIT_PER_MIN = 60;
const DELIVER_TOTAL_LIMIT_PER_MIN = 1200;
const deliverTotalHits = new Map();
const signalHits = new Map();
const deliverHits = new Map();

function wsRateLimitOk(map, key, limitPerMin) {
  const now = Date.now();
  const w = rlGet(map, key, now);
  if (now - w.start > 60_000) { w.start = now; w.n = 0; }
  w.n++;
  map.set(key, w);
  if (map.size > 5000) pruneRateLimitMap(map);
  return w.n <= limitPerMin;
}
// Лимит по паре (отправитель → получатель). Используется для deliver,
// потому что sendGroupMessage рассылает сообщение каждому участнику
// отдельным deliver'ом. Лимит "на отправителя вообще" не подходит:
// в группе из 10 человек один активный пользователь упрётся в него
// уже на 6 сообщениях в минуту. Лимит по паре ограничивает fan-out
// на конкретного получателя, но не мешает человеку писать в разные
// чаты или разным людям.
function wsRateLimitPairOk(senderId, recipientId, limitPerMin, map = deliverHits) {
  const key = String(senderId) + "→" + String(recipientId);
  return wsRateLimitOk(map, key, limitPerMin);
}
// ---------- Проверка доступности TURN ----------
// ExpressTURN (и любой TURN) может быть недоступен: сервер лежит,
// креденшлы истекли, сеть заблокирована. Если сервер отдаёт клиенту
// битые TURN-креденшлы, ICE-сбор на клиенте встаёт в ступор: браузер
// пытается получить relay-кандидата, ждёт 30 секунд таймаута
// TURN allocate request, и всё это время соединение не устанавливается.
// При этом сам звонок бы прошёл по STUN за 1-3 секунды.
//
// Проверка: пытаемся открыть TCP-соединение до TURN-сервера. Не
// идеально (TURN работает по UDP), но: если TCP не открывается за
// 1500мс — TURN точно недоступен. Если открывается — считаем
// живым. Ложные срабатывания в сторону "доступен" менее вредны, чем
// "недоступен" (в худшем случае клиент получит те же 30 секунд
// ожидания, что и сейчас).
const TURN_CHECK_TIMEOUT_MS = 1500;
const TURN_CHECK_CACHE_MS = 5 * 60 * 1000; // раз в 5 минут достаточно
let turnCheckCache = { at: 0, ok: null };
// Проверка по TCP может давать ложный "недоступен" у провайдеров, у
// которых TCP-порт закрыт, а реально используемый UDP — открыт (TURN в
// основном работает по UDP). Для таких доверенных серверов можно отключить
// проверку целиком, а не чинить это полноценным STUN Binding Request по UDP
// (больше кода и свой набор граничных случаев — не обязательно того стоит
// для одного конкретного провайдера).
const TURN_CHECK_DISABLED = process.env.TURN_CHECK_DISABLED === "1";

function checkTurnAlive(url) {
  return new Promise((resolve) => {
    // url вида "turn:free.expressturn.com:3478" или "turns:..."
    const m = String(url || "").match(/^(turns?):(\[[^\]]+\]|[^:?\/]+)(?::(\d+))?/i);
    if (!m) return resolve(false);
    const host = m[2].replace(/^\[|\]$/g, "");
    const port = m[3] ? parseInt(m[3], 10) : (m[1].toLowerCase() === "turns" ? 5349 : 3478);
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) {}
      resolve(ok);
    };
    socket.setTimeout(TURN_CHECK_TIMEOUT_MS);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

async function isTurnAlive(url) {
  if (TURN_CHECK_DISABLED) return true;
  const now = Date.now();
  if (turnCheckCache.ok !== null && now - turnCheckCache.at < TURN_CHECK_CACHE_MS) {
    return turnCheckCache.ok;
  }
  const ok = await checkTurnAlive(url);
  turnCheckCache = { at: now, ok };
  console.log("[ice] проверка TURN " + url + " → " + (ok ? "доступен" : "НЕДОСТУПЕН"));
  return ok;
}

async function getIceServers() {
  const now = Date.now();
  if (iceCache.servers && now - iceCache.at < ICE_CACHE_MS) return iceCache.servers;
  // Статический TURN (ExpressTURN или аналог) — основной механизм.
  // Metered.ca требует оплаты и больше не используется.
  let servers = staticTurnServers();
  const cf = await cloudflareTurnServer();
  if (cf) {
    // Cloudflare — первым: основной рабочий TURN; статический остаётся запасным, пока его не уберут из окружения
    servers = [cf].concat(servers || FALLBACK_ICE.slice().concat(extraTurnServers()));
    iceCache = { at: now, servers };
    return servers;
  }
  if (servers) {
    // Дополнительная проверка: если TURN недоступен, отдавать его
    // клиенту НЕЛЬЗЯ — ICE на клиенте будет ждать таймаута TURN
    // allocate, блокируя весь звонок, хотя STUN-путь работал бы.
    const turnUrl = TURN_STATIC_URL;
    const alive = await isTurnAlive(turnUrl.split(/[\s,]+/).filter(Boolean)[0]);
    if (alive) {
      console.log(TURN_STATIC_SECRET ? "[ice] используются временные TURN-креденшлы (TURN_STATIC_SECRET, TTL " + TURN_TTL_SECONDS + " с)" : "[ice] используются статические TURN-креденшлы (TURN_STATIC_*, устаревший способ)");
    } else {
      console.warn("[ice] TURN " + turnUrl + " недоступен — отдаю только STUN");
      servers = null;
    }
  }
  if (!servers) servers = FALLBACK_ICE.slice().concat(extraTurnServers());
  iceCache = { at: now, servers };
  return servers;
}

// ---------- Превью ссылок ----------
// Браузер не может сам скачать чужую HTML-страницу для превью (CORS
// блокирует это почти везде) — поэтому, как и у всех остальных
// мессенджеров, это делает сервер. Сервер при этом узнаёт, какую именно
// ссылку смотрит клиент (см. README) — контент сообщений это не
// раскрывает, но сама ссылка серверу видна.
const LINK_PREVIEW_CACHE_MS = 60 * 60 * 1000; // час — большинство ссылок не меняют title/картинку так часто
const LINK_PREVIEW_MAX_BYTES = 512 * 1024; // не скачиваем больше полумегабайта HTML
const LINK_PREVIEW_TIMEOUT_MS = 6000;
const LINK_PREVIEW_IMAGE_MAX_BYTES = Math.max(1024, Number(process.env.LINK_PREVIEW_IMAGE_MAX_BYTES) || 1024 * 1024); // прокси og:image: потолок 1 МБ
const LINK_PREVIEW_IMAGE_CACHE_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.LINK_PREVIEW_IMAGE_CACHE_BYTES) || 32 * 1024 * 1024); // суммарный объём кэша картинок в памяти
const LINK_PREVIEW_RATE_LIMIT_PER_MIN = 30;
const linkPreviewCache = new Map(); // url -> { at, data }
const linkPreviewHits = new Map();

function linkPreviewRateLimitOk(ip) {
  const now = Date.now();
  const w = rlGet(linkPreviewHits, ip, now);
  if (now - w.start > 60_000) { w.start = now; w.n = 0; }
  w.n++;
  linkPreviewHits.set(ip, w);
  if (linkPreviewHits.size > 5000) pruneRateLimitMap(linkPreviewHits);
  return w.n <= LINK_PREVIEW_RATE_LIMIT_PER_MIN;
}

// Node не кэширует dns.lookup вообще — каждый resolveHostSafe был
// полноценным DNS-запросом к системному резолверу. При нескольких
// ссылках на один домен (или цепочке редиректов через один хост) это
// десятки лишних lookup'ов за сессию. Простой Map с TTL 5 минут
// закрывает 90% случаев.
const dnsCache = new Map(); // hostname -> { address, family, at }
const DNS_CACHE_MS = 5 * 60 * 1000;
const DNS_CACHE_MAX = 500;

function resolveHostSafe(hostname) {
  const now = Date.now();
  const hit = dnsCache.get(hostname);
  if (hit && now - hit.at < DNS_CACHE_MS) return Promise.resolve({ address: hit.address, family: hit.family });
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address, family) => {
      if (err) return reject(err);
      if (!address) return reject(new Error("no address"));
      if (isPrivateIp(address)) return reject(new Error("private address blocked"));
      dnsCache.set(hostname, { address, family, at: now });
      if (dnsCache.size > DNS_CACHE_MAX) dnsCache.delete(dnsCache.keys().next().value);
      resolve({ address, family });
    });
  });
}

const LINK_PREVIEW_DEADLINE_MS = 8000; // общий потолок на весь запрос (включая DNS и редиректы)
// Декодирование тела с учётом charset (Content-Type или <meta charset> в первых 1024 байтах); откат на utf-8.
function decodeHtmlBody(buf, ctype) {
  let cs = (/charset\s*=\s*["']?([\w.:-]+)/i.exec(String(ctype || "")) || [])[1];
  if (!cs) {
    const head = buf.subarray(0, 1024).toString("latin1");
    cs = (/<meta[^>]{0,200}?charset\s*=\s*["']?([\w.:-]+)/i.exec(head) || [])[1];
  }
  if (cs && !/^utf-?8$/i.test(cs)) {
    try { return new TextDecoder(cs, { fatal: false }).decode(buf); } catch (e) { /* неизвестная кодировка — utf-8 */ }
  }
  return buf.toString("utf8");
}

async function fetchUrlSafe(targetUrl, redirectsLeft, deadlineAt, opts) {
  const imageMode = !!(opts && opts.image); // режим прокси картинки: image/* до LINK_PREVIEW_IMAGE_MAX_BYTES, без распаковки, результат { buf, type }
  if (!deadlineAt) deadlineAt = Date.now() + LINK_PREVIEW_DEADLINE_MS;
  const u = new URL(targetUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme not allowed");
  // TOCTOU/DNS rebinding: резолвим и проверяем IP здесь, а затем ЯВНО
  // передаём именно ЭТОТ IP в http.get через lookup — иначе http.get()
  // резолвит хост ЗАНОВО, и атакующий с коротким TTL успел бы подменить
  // публичный IP на приватный.
  let dnsTimer;
  const safe = await Promise.race([
    resolveHostSafe(u.hostname),
    new Promise((_, rej) => { dnsTimer = setTimeout(() => rej(new Error("dns timeout")), Math.max(1, deadlineAt - Date.now())); }),
  ]).finally(() => clearTimeout(dnsTimer));
  const customLookup = (hostname, options, callback) => {
    // Node вызывает lookup в двух формах: с options.all=true ожидается
    // массив [{address, family}], без него — пара (address, family).
    if (options && options.all) {
      callback(null, [{ address: safe.address, family: safe.family }]);
    } else {
      callback(null, safe.address, safe.family);
    }
  };

  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    // settled-флаг + общий дедлайн: раньше req.destroy(err) выставлял req.destroyed ДО события 'error',
    // и обработчик `if (!req.destroyed) reject(e)` никогда не вызывал reject — запрос висел вечно.
    let settled = false, req = null, stream = null, deadline = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { if (stream) stream.destroy(); } catch (e) {}
      try { if (req) req.destroy(); } catch (e) {}
      fn(v);
    };
    const fail = (e) => finish(reject, e instanceof Error ? e : new Error(String(e)));
    const ok = (v) => finish(resolve, v);
    deadline = setTimeout(() => fail(new Error("deadline")), Math.max(1, deadlineAt - Date.now()));
    req = mod.get(u, {
      lookup: customLookup,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": imageMode ? "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8" : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": imageMode ? "identity" : "gzip, deflate, br",
        "Cache-Control": "max-age=0",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": imageMode ? "image" : "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "sec-ch-ua": "\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
      },
      timeout: LINK_PREVIEW_TIMEOUT_MS,
    }, (res) => {
      res.on("error", fail);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (e) { return fail(e); }
        fetchUrlSafe(next, redirectsLeft - 1, deadlineAt, opts).then(ok, fail);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); fail(new Error("HTTP " + res.statusCode)); return; }
      const ctype = String(res.headers["content-type"] || "");
      if (imageMode) {
        const itype = imageMimeOk(ctype);
        if (!itype) { res.resume(); fail(new Error("not an image")); return; }
        const clen = Number(res.headers["content-length"]);
        if (Number.isFinite(clen) && clen > LINK_PREVIEW_IMAGE_MAX_BYTES) { res.resume(); fail(new Error("too large")); return; }
        let itotal = 0; const ichunks = [];
        res.on("data", (chunk) => {
          if (settled) return;
          itotal += chunk.length;
          if (itotal > LINK_PREVIEW_IMAGE_MAX_BYTES) { fail(new Error("too large")); return; }
          ichunks.push(chunk);
        });
        res.on("end", () => ok({ buf: Buffer.concat(ichunks), type: itype }));
        return;
      }
      if (ctype && !ctype.includes("html")) { res.resume(); fail(new Error("not html")); return; }

      // Сжатый ответ распаковываем: без этого github.com и ya.ru переваливают за LINK_PREVIEW_MAX_BYTES.
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      stream = res;
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

      let total = 0;
      const chunks = [];
      let headTail = "";
      stream.on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > LINK_PREVIEW_MAX_BYTES) { fail(new Error("too large")); return; }
        chunks.push(chunk);
        // Ищем </head> только в хвосте предыдущего текста (16 символов) плюс текущий чанк — без повторного
        // перекодирования всего накопленного на каждом чанке.
        const chunkText = chunk.toString("utf8").toLowerCase();
        const search = headTail + chunkText;
        if (search.includes("</head>")) { ok(decodeHtmlBody(Buffer.concat(chunks), ctype)); return; }
        headTail = search.slice(-16);
      });
      stream.on("end", () => ok(decodeHtmlBody(Buffer.concat(chunks), ctype)));
      stream.on("error", fail);
    });
    req.on("timeout", () => fail(new Error("timeout")));
    req.on("error", fail);
  });
}

// extractMeta / decodeHtmlEntities вынесены в meta-extract.js (линейный разбор, без ReDoS).

// Отдельный, более короткий TTL для НЕГАТИВНЫХ результатов (data === null:
// сайт отдал 401/403/439, не ответил, отдал не-HTML). Раз в час долбить
// rbc.ru/avito за одним и тем же отказом бессмысленно; через 15 минут
// есть шанс, что сайт был временно недоступен и теперь отдаст превью.
// До этой правки ошибка fetchUrlSafe ПРОБРАСЫВАЛАСЬ наверх и НЕ попадала
// в кеш — каждый вход в чат с той же ссылкой снова дёргал сайт.
const LINK_PREVIEW_NEGATIVE_CACHE_MS = 15 * 60 * 1000;

const linkPreviewImageCache = new Map(); // url -> { at, data: {buf,type}|null }
let linkPreviewImageCacheBytes = 0;
async function getLinkPreviewImage(targetUrl) {
  const now = Date.now();
  const cached = linkPreviewImageCache.get(targetUrl);
  if (cached) {
    const ttl = cached.data ? LINK_PREVIEW_CACHE_MS : LINK_PREVIEW_NEGATIVE_CACHE_MS;
    if (now - cached.at < ttl) return cached.data;
    linkPreviewImageCache.delete(targetUrl); linkPreviewImageCacheBytes -= cached.data ? cached.data.buf.length : 0;
  }
  let data = null;
  try { data = await fetchUrlSafe(targetUrl, 3, undefined, { image: true }); }
  catch (e) { console.log("[link-preview-image] ошибка для " + (() => { try { return new URL(targetUrl).hostname; } catch (e2) { return "?"; } })() + ": " + e.message); }
  linkPreviewImageCache.set(targetUrl, { at: now, data });
  if (data) linkPreviewImageCacheBytes += data.buf.length;
  // вытесняем самые старые записи, пока не уложимся в лимит по байтам и числу записей
  while ((linkPreviewImageCacheBytes > LINK_PREVIEW_IMAGE_CACHE_MAX_BYTES || linkPreviewImageCache.size > 1000) && linkPreviewImageCache.size > 1) {
    const k = linkPreviewImageCache.keys().next().value; const v = linkPreviewImageCache.get(k);
    linkPreviewImageCache.delete(k); if (v && v.data) linkPreviewImageCacheBytes -= v.data.buf.length;
  }
  return data;
}

async function getLinkPreview(targetUrl) {
  const now = Date.now();
  const cached = linkPreviewCache.get(targetUrl);
  if (cached) {
    const ttl = cached.data ? LINK_PREVIEW_CACHE_MS : LINK_PREVIEW_NEGATIVE_CACHE_MS;
    if (now - cached.at < ttl) return cached.data;
  }
  const host = (() => { try { return new URL(targetUrl).hostname; } catch (e) { return targetUrl; } })();
  let data = null;
  try {
    const html = await fetchUrlSafe(targetUrl, 3);
    data = extractMeta(html, targetUrl);
    if (!data) console.log("[link-preview] пусто (без исключения) для " + host);
  } catch (e) {
    // Отрицательный результат — сохраняем ниже в кеш как null, чтобы
    // повторный запрос той же ссылки не дёргал сайт снова.
    console.log("[link-preview] ошибка для " + host + ": " + e.message + " (кеширую отказ на 15 мин)");
  }
  linkPreviewCache.set(targetUrl, { at: now, data });
  if (linkPreviewCache.size > 2000) {
    const cutoff = now - LINK_PREVIEW_CACHE_MS;
    for (const [k, v] of linkPreviewCache) if (v.at < cutoff) linkPreviewCache.delete(k);
    if (linkPreviewCache.size > 2000) {
      const toRemove = linkPreviewCache.size - 1800;
      let removed = 0;
      for (const k of linkPreviewCache.keys()) {
        if (removed >= toRemove) break;
        linkPreviewCache.delete(k);
        removed++;
      }
    }
  }
  return data;
}

// ---------- HTTP-сервер (для /ice и как база для WS) ----------
// ВАЖНО: ALLOWED_ORIGIN и APP_BASE_URL — это НЕ одно и то же, и раньше
// тут была реальная ошибка: одна и та же переменная использовалась и как
// значение заголовка Access-Control-Allow-Origin (там браузер ожидает
// ГОЛЫЙ origin, без пути — "https://example.com"), и как база для поля
// "navigate" в push-уведомлениях (там нужен путь, если приложение
// развёрнуто не в корне домена — "https://example.com/ether"). Если
// приложение живёт по пути (как в этом проекте — GitHub Pages, /ether/),
// одной переменной на оба назначения не хватает: либо CORS сломается
// (браузер не примет origin с путём), либо push будет открывать не ту
// страницу. Поэтому — две отдельные переменные.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
if (ALLOWED_ORIGIN === "*") {
  console.warn("[ice] ALLOWED_ORIGIN не задан — /ice отдаёт TURN-credentials любому источнику. " +
    "Перед публичным релизом задайте ALLOWED_ORIGIN=https://ваш-домен в переменных окружения.");
} else if (/^https?:\/\/[^\/]+\/./.test(ALLOWED_ORIGIN)) {
  console.warn("[ice] ALLOWED_ORIGIN содержит путь (" + ALLOWED_ORIGIN + ") — для CORS нужен только " +
    "голый origin, без пути (например https://example.com, а не https://example.com/ether). " +
    "Браузер будет отклонять запросы. Путь до приложения задаётся отдельно через APP_BASE_URL.");
}
// Полный адрес приложения (с путём, если он есть) — используется только
// для поля "navigate"/иконок в push. Если не задан явно, для обратной
// совместимости пробуем ALLOWED_ORIGIN (сработает, если приложение живёт
// в корне домена), иначе — известный адрес деплоя проекта.
const APP_BASE_URL = (process.env.APP_BASE_URL || (ALLOWED_ORIGIN !== "*" ? ALLOWED_ORIGIN : "") || "https://arthurhuskyman.github.io/ether").replace(/\/+$/, "");
const APP_ORIGIN = APP_BASE_URL;
const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Link-T, X-Link-U");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url || "";
  if (url.startsWith("/link/") && await require("./devicelink").handle(req, res, clientIp(req))) return; // перенос на новое устройство (docs/MULTIDEVICE.md)
  if (req.method === "GET" && (url === "/ice" || url.startsWith("/ice?"))) {
    const ip = clientIp(req);
    if (!rateLimitOk(ip)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    try {
      const servers = await getIceServers();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" });
      res.end(JSON.stringify(servers));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ice unavailable" }));
    }
    return;
  }

  if (req.method === "GET" && (url === "/link-preview" || url.startsWith("/link-preview?"))) {
    const ip = clientIp(req);
    if (!linkPreviewRateLimitOk(ip)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    let target = "";
    try { target = new URL(req.url, "http://x").searchParams.get("url") || ""; } catch (e) {}
    if (!target) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing url" }));
      return;
    }
    try {
      const data = await getLinkPreview(target);
      if (!data) {
        // Раньше здесь ничего не логировалось — при отказе не было ни
        // единого следа в логах сервера, даже на реальном деплое.
        // Отладить, ПОЧЕМУ конкретная ссылка не даёт превью, было
        // невозможно без гадания. Теперь видно домен и что именно
        // произошло (или не бросило исключения, просто вернуло null).
        console.log("[link-preview] пусто (без исключения) для " + (() => { try { return new URL(target).hostname; } catch (e2) { return target; } })());
        res.writeHead(204); res.end(); return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.log("[link-preview] ошибка для " + (() => { try { return new URL(target).hostname; } catch (e2) { return target; } })() + ": " + e.message);
      res.writeHead(204); // тихо ничего не показываем в самом чате — не хотим шумных ошибок из-за недоступной ссылки, но в логах теперь видно
      res.end();
    }
    return;
  }

  // Прокси og:image: браузер пользователя не ходит на чужой сайт напрямую (IP не раскрывается). Те же SSRF-защиты, что у /link-preview.
  if (req.method === "GET" && (url === "/link-preview-image" || url.startsWith("/link-preview-image?"))) {
    const ip = clientIp(req);
    if (!linkPreviewRateLimitOk(ip)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    let target = "";
    try { target = new URL(req.url, "http://x").searchParams.get("url") || ""; } catch (e) {}
    if (!target || target.length > 2000) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing url" }));
      return;
    }
    try {
      const data = await getLinkPreviewImage(target);
      if (!data) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, {
        "Content-Type": data.type, "Content-Length": data.buf.length, "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "cross-origin",
      });
      res.end(data.buf);
    } catch (e) { res.writeHead(204); res.end(); }
    return;
  }

  if (req.method === "GET" && (url === "/" || url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Ether signaling relay OK\n");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// ---------- Web Push ----------
const PUSH_SUBS_FILE = process.env.PUSH_SUBS_FILE || path.join(__dirname, ".ether-push-subs.json");

const VAPID_PUBLIC = process.env.VAPID_PUBLIC || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
const PUSH_ENABLED = !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE);

if (PUSH_ENABLED) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log("[push] Web Push включён");
  } catch (e) {
    console.error("[push] не удалось инициализировать VAPID:", e.message);
  }
} else {
  console.log("[push] Web Push не настроен (нет VAPID-ключей или пакета web-push)");
}

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

const clients = new Map();
const mailbox = new Map();

// ---------- Постоянный ящик (A4) ----------
// Недоставленные конверты (они уже зашифрованы end-to-end, сервер их прочитать не может) сохраняются на диск и переживают перезапуск.
// Путь — MAILBOX_FILE (по умолчанию рядом с сервером или в DATA_DIR). ВАЖНО: на бесплатном Render диск эфемерный — файл пропадает при
// каждом деплое/засыпании; чтобы ящик реально переживал перезапуски, подключите Persistent Disk и укажите DATA_DIR (или MAILBOX_FILE) на него.
// MAILBOX_PERSIST=0 отключает запись. Текст хранится не дольше MAILBOX_TEXT_TTL_MS (14 суток), файлы — MAILBOX_FILE_TTL_MS (48 ч).
const MAILBOX_FILE = process.env.MAILBOX_FILE || path.join(process.env.DATA_DIR || __dirname, ".ether-mailbox.json");
const MAILBOX_PERSIST = process.env.MAILBOX_PERSIST !== "0";
const MAILBOX_TEXT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAILBOX_HEAVY_CT = 256 * 1024;
const MAILBOX_PERSIST_MAX_BYTES = 150 * 1024 * 1024;
function mailboxEntryExpired(entry, now) {
  // 48 ч — только для тяжёлых записей (файлы/голосовые, ct > 256 КБ); опросы, карточки, приглашения, правки и реакции живут как текст.
  const heavy = (entry && (entry.kind === "file" || entry.kind === "audio")) || (entry && entry.envelope && typeof entry.envelope.ct === "string" && entry.envelope.ct.length > MAILBOX_HEAVY_CT);
  const ttl = heavy ? MAILBOX_FILE_TTL_MS : MAILBOX_TEXT_TTL_MS;
  return !entry || typeof entry.ts !== "number" || now - entry.ts > ttl;
}
// Учёт объёма ящика. Размер приблизительный (ct + служебный запас) — нужен только для глобальных потолков.
let mailboxTotalCount = 0, mailboxTotalBytes = 0;
function approxEntrySize(e) {
  const env = (e && e.envelope) || {};
  return 400 + (typeof env.ct === "string" ? env.ct.length : 0) + (typeof env.iv === "string" ? env.iv.length : 0) + (e && e.fromPublicKey ? 300 : 0);
}
function mailboxRemove(userId, msgId) {
  const box = mailbox.get(userId);
  if (!box) return false;
  const e = box.get(msgId);
  if (!e) return false;
  box.delete(msgId);
  mailboxTotalCount--; mailboxTotalBytes -= approxEntrySize(e);
  if (box.size === 0) mailbox.delete(userId); // пустые ящики не копим
  return true;
}
// Глобальное вытеснение бьёт по самому «жирному» отправителю (по числу записей), а не по самой старой записи вообще:
// иначе один аноним, залив ящики, вытеснял бы почту всех остальных.
function mailboxEvictFromHeaviestSender() {
  const cnt = new Map();
  for (const box of mailbox.values()) for (const e of box.values()) cnt.set(e.from, (cnt.get(e.from) || 0) + 1);
  let top = null, topN = 0;
  for (const [f, n] of cnt) if (n > topN) { top = f; topN = n; }
  if (top === null) return false;
  let bestUser = null, bestMsg = null, bestTs = Infinity;
  for (const [uid, box] of mailbox) for (const [mid, e] of box) if (e.from === top && e.ts < bestTs) { bestTs = e.ts; bestUser = uid; bestMsg = mid; }
  if (bestUser === null) return false;
  return mailboxRemove(bestUser, bestMsg);
}
// Вставка с проверкой потолков ПРЯМО В МОМЕНТ записи (раньше лишнее срезалось раз в минуту, и за это время ящик раздувался без предела).
// Недавно подтверждённые получателем конверты (to|from|msgId|хеш конверта): повторный deliver с теми же байтами после mailbox-ack
// не должен снова попасть в ящик (иначе получатель увидит дубль). Окно DELIVER_DEDUP_TTL_MS, потолок записей DELIVER_DEDUP_MAX.
const DELIVER_DEDUP_TTL_MS = envInt("DELIVER_DEDUP_TTL_MIN", 15) * 60 * 1000, DELIVER_DEDUP_MAX = 20000;
const recentAcked = new Map(); // ключ -> ts
function deliverDupKey(to, from, msgId, envelope) {
  let h = ""; try { h = crypto.createHash("sha1").update(JSON.stringify(envelope)).digest("hex").slice(0, 20); } catch (e) {}
  return to + "|" + from + "|" + msgId + "|" + h;
}
function rememberAcked(key) {
  const now = Date.now();
  recentAcked.delete(key); recentAcked.set(key, now);
  for (const [k, t] of recentAcked) { if (now - t > DELIVER_DEDUP_TTL_MS || recentAcked.size > DELIVER_DEDUP_MAX) recentAcked.delete(k); else break; }
}
setInterval(() => { const now = Date.now(); for (const [k, t] of recentAcked) { if (now - t > DELIVER_DEDUP_TTL_MS) recentAcked.delete(k); else break; } }, 60 * 1000).unref();
function mailboxPut(userId, msgId, entry) {
  mailboxRemove(userId, msgId);
  let box = mailbox.get(userId);
  if (!box) { box = new Map(); mailbox.set(userId, box); }
  box.set(msgId, entry);
  mailboxTotalCount++; mailboxTotalBytes += approxEntrySize(entry);
  // Квота на отправителя в одном ящике: один отправитель не вытесняет почту остальных у получателя.
  if (entry && entry.from) {
    let n = 0; for (const e of box.values()) if (e.from === entry.from) n++;
    if (n > MAX_MAILBOX_PER_SENDER) for (const [mid, e] of box) { if (e.from === entry.from && mid !== msgId) { mailboxRemove(userId, mid); if (--n <= MAX_MAILBOX_PER_SENDER) break; } }
    box = mailbox.get(userId) || box;
  }
  while (box.size > MAX_MAILBOX_PER_USER) mailboxRemove(userId, box.keys().next().value);
  if (mailboxTotalCount > MAX_MAILBOX_TOTAL_ENTRIES || mailboxTotalBytes > MAX_MAILBOX_TOTAL_BYTES) {
    const lowC = Math.floor(MAX_MAILBOX_TOTAL_ENTRIES * 0.95), lowB = MAX_MAILBOX_TOTAL_BYTES * 0.95;
    while ((mailboxTotalCount > lowC || mailboxTotalBytes > lowB) && mailboxEvictFromHeaviestSender()) { /* вытесняем у самого «жирного» отправителя */ }
  }
}
function loadMailbox() {
  if (!MAILBOX_PERSIST) return 0;
  try {
    if (!fs.existsSync(MAILBOX_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(MAILBOX_FILE, "utf8"));
    if (!data || data.v !== 1 || !Array.isArray(data.boxes)) return 0;
    const now = Date.now(); let n = 0;
    for (const [id, entries] of data.boxes) {
      if (typeof id !== "string" || !Array.isArray(entries)) continue;
      for (const [msgId, entry] of entries) { if (typeof msgId === "string" && !mailboxEntryExpired(entry, now)) { mailboxPut(id, msgId, entry); n++; } }
    }
    console.log("[mailbox] восстановлено записей: " + mailboxTotalCount);
    return n;
  } catch (e) { console.warn("[mailbox] не удалось прочитать файл ящика:", e.message); return 0; }
}
function saveMailbox() {
  if (!MAILBOX_PERSIST) return;
  try {
    const now = Date.now(); let boxes = [];
    for (const [id, box] of mailbox) {
      const entries = [];
      for (const [msgId, entry] of box) if (!mailboxEntryExpired(entry, now)) entries.push([msgId, entry]);
      if (entries.length) boxes.push([id, entries]);
    }
    let json = JSON.stringify({ v: 1, boxes });
    if (json.length > MAILBOX_PERSIST_MAX_BYTES) { // слишком много — на диск только текст (файлы остаются в памяти)
      boxes = boxes.map(([id, es]) => [id, es.filter(([, e]) => !e.kind || e.kind === "chat")]).filter(([, es]) => es.length);
      json = JSON.stringify({ v: 1, boxes });
    }
    if (json.length > MAILBOX_PERSIST_MAX_BYTES) { // потолок действует и на текст: оставляем самые новые записи, самые старые отбрасываем
      const flat = [];
      for (const [id, es] of boxes) for (const [msgId, e] of es) flat.push({ id, msgId, e, sz: approxEntrySize(e) });
      flat.sort((a, b) => b.e.ts - a.e.ts);
      let sum = 0; const keep = new Map();
      for (const f of flat) {
        sum += f.sz; if (sum > MAILBOX_PERSIST_MAX_BYTES * 0.9) break;
        if (!keep.has(f.id)) keep.set(f.id, []);
        keep.get(f.id).unshift([f.msgId, f.e]);
      }
      json = JSON.stringify({ v: 1, boxes: Array.from(keep.entries()) });
    }
    const tmp = MAILBOX_FILE + ".tmp";
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, MAILBOX_FILE); // атомарно: обрыв посреди записи не портит прежний файл
  } catch (e) { console.warn("[mailbox] не удалось сохранить ящик:", e.message); }
}
let mailboxDirty = false, mailboxTimer = null;
function scheduleMailboxSave() {
  if (!MAILBOX_PERSIST) return;
  mailboxDirty = true;
  if (mailboxTimer) return;
  mailboxTimer = setTimeout(() => { mailboxTimer = null; if (mailboxDirty) { mailboxDirty = false; saveMailbox(); } }, 2000);
}
loadMailbox();
const pushSubs = new Map();
const pushThrottle = new Map();

// ---------- Персистентность push-подписок ----------
function loadPushSubs() {
  try {
    if (!fs.existsSync(PUSH_SUBS_FILE)) return;
    const raw = fs.readFileSync(PUSH_SUBS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]) {
        // Обратная совместимость: старый формат хранил голую подписку
        // (объект с .endpoint), новый — { subscription, lang }.
        const v = entry[1];
        const rec = v && v.subscription ? v : { subscription: v, lang: "en" };
        // Подписки с диска проверяем так же строго, как новые (endpoint — только известные push-сервисы).
        const sub = validatePushSubscription(rec.subscription);
        if (!sub || pushSubs.size >= MAX_PUSH_SUBS) continue;
        pushSubs.set(entry[0], { subscription: sub, lang: validLang(rec.lang) ? rec.lang : "en" });
      }
    }
    console.log("[push] восстановлено подписок:", pushSubs.size);
  } catch (e) {
    console.warn("[push] не удалось прочитать файл подписок:", e.message);
  }
}
function savePushSubs() {
  try {
    const tmp = PUSH_SUBS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Array.from(pushSubs.entries())), { mode: 0o600 });
    fs.renameSync(tmp, PUSH_SUBS_FILE); // атомарно: обрыв записи не портит прежний файл
  } catch (e) {
    console.warn("[push] не удалось сохранить файл подписок:", e.message);
  }
}
// Раньше push-subscribe писал файл подписок на диск (fs.writeFileSync,
// синхронно) на КАЖДОЕ сообщение, без rate-limit вовсе. ensurePushSubscription
// на клиенте дёргается из нескольких мест (после регистрации SW, смены
// vapid-ключа, push-subscription-changed, восстановления ростера,
// онлайн-события) — при частых переподключениях это реально молотит
// диск на медленном FS (Render и подобные). Дебаунс: помечаем "грязным"
// и пишем раз в 2с по таймеру, плюс гарантированно на shutdown — не
// теряем данные, просто не пишем чаще, чем нужно.
let pushSubsDirty = false;
let pushSubsFlushTimer = null;
function schedulePushSubsSave() {
  pushSubsDirty = true;
  if (pushSubsFlushTimer) return;
  pushSubsFlushTimer = setTimeout(() => {
    pushSubsFlushTimer = null;
    if (pushSubsDirty) { pushSubsDirty = false; savePushSubs(); }
  }, 2000);
}
const pushSubHits = new Map();
const watchHits = new Map();
loadPushSubs();

// ---------- Базовая отправка push ----------
// Собирает push-уведомление в формате Declarative Web Push (W3C, поле
// web_push: 8030) — платформа (в первую очередь Safari/iOS 16.4+) может
// показать уведомление САМА, без всякого участия Service Worker. Это
// заметно надёжнее, чем полагаться на то, что SW успеет проснуться и
// вызвать showNotification() сам — именно в этом узкое место, из-за
// которого звонки на iOS исторически не добуживались при закрытом или
// выгруженном PWA. mutable:false — уведомление показывается напрямую,
// платформа не ждёт от SW никакой трансформации.
// На браузерах, которые декларативный формат ещё не понимают (сейчас —
// Chrome/Firefox на Android), тот же самый JSON просто долетает до
// обработчика push в sw.js как обычный payload — тот же формат работает
// в обоих случаях, никакой отдельной ветки на сервере не нужно.
// Небольшая таблица переводов ИМЕННО для текста push-уведомлений —
// полный 72-язычный словарь приложения живёт в клиенте (js/lang/*.js)
// и на сервер не годится копировать целиком ради нескольких строк.
// Покрывает крупнейшие языки; для остальных — честный английский, а не
// русский по умолчанию, как было раньше (сервер теперь знает язык
// получателя из push-subscribe).
const PUSH_TEXT = {
  en: { call: "Call", incomingCall: "Incoming call", newMessage: "New message", aggregatedMessages: (n) => `${n} new messages` },
  ru: { call: "Звонок", incomingCall: "Входящий вызов", newMessage: "Новое сообщение", aggregatedMessages: (n) => `${n} новых сообщений` },
  es: { call: "Llamada", incomingCall: "Llamada entrante", newMessage: "Mensaje nuevo", aggregatedMessages: (n) => `${n} mensajes nuevos` },
  pt: { call: "Chamada", incomingCall: "Chamada recebida", newMessage: "Nova mensagem", aggregatedMessages: (n) => `${n} novas mensagens` },
  fr: { call: "Appel", incomingCall: "Appel entrant", newMessage: "Nouveau message", aggregatedMessages: (n) => `${n} nouveaux messages` },
  de: { call: "Anruf", incomingCall: "Eingehender Anruf", newMessage: "Neue Nachricht", aggregatedMessages: (n) => `${n} neue Nachrichten` },
  it: { call: "Chiamata", incomingCall: "Chiamata in arrivo", newMessage: "Nuovo messaggio", aggregatedMessages: (n) => `${n} nuovi messaggi` },
  zh: { call: "通话", incomingCall: "来电", newMessage: "新消息", aggregatedMessages: (n) => `${n} 条新消息` },
  ja: { call: "通話", incomingCall: "着信", newMessage: "新着メッセージ", aggregatedMessages: (n) => `新着メッセージ ${n} 件` },
  ko: { call: "통화", incomingCall: "수신 전화", newMessage: "새 메시지", aggregatedMessages: (n) => `새 메시지 ${n}개` },
  ar: { call: "مكالمة", incomingCall: "مكالمة واردة", newMessage: "رسالة جديدة", aggregatedMessages: (n) => `${n} رسائل جديدة` },
  hi: { call: "कॉल", incomingCall: "आने वाली कॉल", newMessage: "नया संदेश", aggregatedMessages: (n) => `${n} नए संदेश` },
  tr: { call: "Arama", incomingCall: "Gelen arama", newMessage: "Yeni mesaj", aggregatedMessages: (n) => `${n} yeni mesaj` },
  vi: { call: "Cuộc gọi", incomingCall: "Cuộc gọi đến", newMessage: "Tin nhắn mới", aggregatedMessages: (n) => `${n} tin nhắn mới` },
  pl: { call: "Połączenie", incomingCall: "Połączenie przychodzące", newMessage: "Nowa wiadomość", aggregatedMessages: (n) => `${n} nowych wiadomości` },
  nl: { call: "Oproep", incomingCall: "Inkomend gesprek", newMessage: "Nieuw bericht", aggregatedMessages: (n) => `${n} nieuwe berichten` },
  th: { call: "โทร", incomingCall: "สายเรียกเข้า", newMessage: "ข้อความใหม่", aggregatedMessages: (n) => `ข้อความใหม่ ${n} รายการ` },
  id: { call: "Panggilan", incomingCall: "Panggilan masuk", newMessage: "Pesan baru", aggregatedMessages: (n) => `${n} pesan baru` },
  fa: { call: "تماس", incomingCall: "تماس ورودی", newMessage: "پیام جدید", aggregatedMessages: (n) => `${n} پیام جدید` },
  uk: { call: "Дзвінок", incomingCall: "Вхідний дзвінок", newMessage: "Нове повідомлення", aggregatedMessages: (n) => `${n} нових повідомлень` },
};
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function pushText(lang, key, params) {
  // lang приходит от клиента: PUSH_TEXT["constructor"] раньше возвращал функцию Object и ронял процесс. Только собственные ключи.
  const base = (typeof lang === "string" && lang ? lang : "en").toLowerCase().split(/[-_]/)[0];
  const table = hasOwn(PUSH_TEXT, base) ? PUSH_TEXT[base] : PUSH_TEXT.en;
  const val = hasOwn(table, key) ? table[key] : (hasOwn(PUSH_TEXT.en, key) ? PUSH_TEXT.en[key] : undefined);
  const resolved = typeof val === "function" ? val(params && params.n) : val;
  // Если ключа нет даже в en (опечатка при добавлении нового ключа) —
  // не отдаём undefined в заголовок/текст уведомления.
  return resolved === undefined ? key : resolved;
}

function buildDeclarativePush(payload, lang) {
  const isCall = payload.kind === "call";
  // Раньше: APP_ORIGIN + "/" + "?call=..." — сейчас APP_BASE_URL всегда без
  // хвостового "/" (см. .replace(/\/+$/, "") выше), так что результат
  // корректен (.../ether/?call=abc), но конструкция хрупкая: если
  // APP_BASE_URL когда-нибудь будет задан с собственным query-параметром,
  // жёстко вшитый "/" перед "?" всё сломает. Строим без промежуточного "/".
  const now = Date.now();
  // ts для звонка: клиент по нему понимает, свежий ли это звонок (push старше минуты — звонящий уже сдался).
  const navigate = APP_ORIGIN + (isCall ? "?call=" : "?chat=") + encodeURIComponent(payload.contactId || "") + (isCall ? "&ts=" + now : "");
  const notification = {
    title: payload.title || "Эфир",
    body: payload.body || "",
    navigate,
    tag: payload.tag || "ether",
    icon: APP_ORIGIN + "/icons/icon-192.png",
    badge: APP_ORIGIN + "/icons/icon-192.png",
    vibrate: isCall ? [300, 150, 300, 150, 300] : [100, 50, 100],
    requireInteraction: isCall,
    renotify: isCall,
    data: { contactId: payload.contactId || null, kind: payload.kind || "message", navigate, ts: now },
  };
  return { web_push: 8030, notification, mutable: false };
}

async function actuallySendPush(subEntry, payload) {
  if (!PUSH_ENABLED) return false;
  try {
    // TTL: 30с для звонков (устаревший рингтон, доигравший через час
    // простоя сервера, — хуже, чем отсутствие звонка вовсе), 5 минут
    // для обычных сообщений. Apple может задерживать доставку push на
    // 10-20 секунд при плохой связи или в Low Power Mode — TTL 30с для
    // сообщений означало, что такой push просто отбрасывался Apple, и
    // уведомление пропадало без следа.
    const ttl = payload.kind === "call" ? 30 : 5 * 60;
    await webpush.sendNotification(subEntry.subscription, JSON.stringify(buildDeclarativePush(payload, subEntry.lang)), {
      TTL: ttl,
      urgency: payload.kind === "call" ? "high" : "normal",
      timeout: 10000, // не даём подвисшему push-сервису держать сокет вечно
    });
    return true;
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) return "gone";
    console.warn("[push] ошибка отправки:", e && e.statusCode, e && e.message);
    return false;
  }
}

async function sendPushTo(recipientId, senderId, payload, opts = {}) {
  if (!PUSH_ENABLED) return;
  const subEntry = pushSubs.get(recipientId);
  if (!subEntry) return;

  if (opts.force || payload.kind === "call") {
    const res = await actuallySendPush(subEntry, payload);
    if (res === "gone") { pushSubs.delete(recipientId); schedulePushSubsSave(); }
    return;
  }

  const key = `${recipientId}:${senderId}`;
  const now = Date.now();
  const entry = pushThrottle.get(key);

  if (!entry || now - entry.lastAt >= PUSH_THROTTLE_MS) {
    if (entry && entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    pushThrottle.set(key, { lastAt: now, count: 0, timer: null });
    const res = await actuallySendPush(subEntry, payload);
    if (res === "gone") { pushSubs.delete(recipientId); schedulePushSubsSave(); }
    return;
  }

  entry.count += 1;
  if (!entry.timer) {
    const delay = PUSH_THROTTLE_MS - (now - entry.lastAt);
    entry.timer = setTimeout(async () => {
      const cur = pushThrottle.get(key);
      if (!cur) return;
      cur.timer = null;
      if (clients.has(recipientId)) {
        pushThrottle.delete(key);
        return;
      }
      const subNow = pushSubs.get(recipientId);
      if (!subNow) { pushThrottle.delete(key); return; }
      // Раньше здесь было cur.count + 1 — счётчик на 1 больше
      // реального числа сообщений в этом агрегированном пуше.
      // Первое сообщение уже ушло отдельным немедленным пушем ДО
      // того, как count вообще начал расти (count стартует с 0
      // именно в момент немедленной отправки) — значит cur.count
      // уже и есть точное число сообщений, пришедших ПОСЛЕ него.
      // Пользователь видел "Новое сообщение", затем "3 новых
      // сообщения" при реальных 2 дополнительных — переплата на одно.
      const n = cur.count;
      cur.lastAt = Date.now();
      cur.count = 0;
      const aggregated = { ...payload, body: n > 1 ? pushText(subNow.lang, "aggregatedMessages", { n }) : payload.body };
      const res = await actuallySendPush(subNow, aggregated);
      if (res === "gone") { pushSubs.delete(recipientId); schedulePushSubsSave(); }
    }, delay);
  }
}

// Push устройству-companion: подписка лежит под ключом "id#deviceId"; как и для основного — только если сообщение за PUSH_AFTER_MS не забрали.
function notifyDevice(ownerId, devId, fromId, msgId, key) {
  if (!PUSH_ENABLED || !pushSubs.has(key)) return;
  const dk = msgId + "#" + devId;
  if (pushSentForMsgId.has(dk)) return;
  setTimeout(() => {
    const box = mailbox.get(key);
    if (!box || !box.has(msgId) || pushSentForMsgId.has(dk) || !pushSubs.has(key)) return;
    pushSentForMsgId.set(dk, Date.now());
    const lang = (pushSubs.get(key) || {}).lang;
    const fr = clients.get(fromId);
    sendPushTo(key, fromId, { title: (fr && fr.name) || pushText(lang, "newMessage"), body: pushText(lang, "newMessage"), tag: "ether-msg-" + fromId, contactId: fromId, kind: "message" }).catch(() => {});
  }, PUSH_AFTER_MS);
}

function clearThrottleForRecipient(recipientId) {
  const prefix = recipientId + ":";
  for (const key of Array.from(pushThrottle.keys())) {
    if (key.startsWith(prefix)) {
      const entry = pushThrottle.get(key);
      if (entry && entry.timer) clearTimeout(entry.timer);
      pushThrottle.delete(key);
    }
  }
}

// ---------- Claim-токены id (TOFU) ----------
// Сервер не проверяет владение номером/почтой, из которых получен id, поэтому раньше любой мог занять чужой id (register вытеснял владельца).
// Теперь клиент при первой регистрации генерирует секрет T (localStorage ether.claimToken) и присылает в register поле claim = sha256("ether-claim-v1|"+T)
// в hex — сам T по сети не уходит. Сервер запоминает ТОЛЬКО sha256(claim) (утечка файла claim-ов не даёт занять id). Дальше register этого id
// принимается только с тем же claim; иначе — { type:"register-error", error:"id-claimed" }. Старый клиент без claim может занимать только id без claim.
// Если владелец не появлялся дольше CLAIM_TTL_HOURS (по умолчанию 336 ч = 14 суток) — claim освобождается и id можно занять заново.
// Ограничения: это TOFU — кто первым зарегистрировал id с claim, тот и владелец; id, зарегистрированный до обновления, остаётся без защиты, пока владелец
// не обновится и не зарегистрируется с claim. Хранилище ограничено (CLAIMS_MAX) и защищено лимитом создания claim с одного IP.
const CLAIM_TTL_MS = envInt("CLAIM_TTL_HOURS", 336) * 3600 * 1000;
const CLAIMS_MAX = envInt("CLAIMS_MAX", 200000);
const CLAIM_CREATE_PER_HOUR_PER_IP = envInt("CLAIM_CREATE_PER_HOUR_PER_IP", 60);
const CLAIMS_PERSIST = process.env.CLAIMS_PERSIST !== "0";
const CLAIMS_FILE = process.env.CLAIMS_FILE || path.join(process.env.DATA_DIR || __dirname, ".ether-claims.json");
const claims = new Map(); // id -> { h: sha256(claim) hex, seen: ts }
const claimCreateHits = new Map();
const CLAIM_RE = /^[0-9a-f]{64}$/;
function sha256Hex(str) { return crypto.createHash("sha256").update(str).digest("hex"); }
function validClaim(c) { return typeof c === "string" && CLAIM_RE.test(c); }
function claimMatches(rec, claim) {
  if (!rec || !validClaim(claim)) return false;
  const a = Buffer.from(rec.h, "hex"), b = Buffer.from(sha256Hex(claim), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function claimExpired(rec, now) { return !rec || now - rec.seen > CLAIM_TTL_MS; }
function pruneClaims(now) {
  let n = 0;
  for (const [id, rec] of claims) if (claimExpired(rec, now) && !(clients.has(id))) { claims.delete(id); n++; }
  return n;
}
function loadClaims() {
  if (!CLAIMS_PERSIST) return 0;
  try {
    if (!fs.existsSync(CLAIMS_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
    if (!data || data.v !== 1 || !Array.isArray(data.claims)) return 0;
    const now = Date.now();
    for (const e of data.claims) {
      if (!Array.isArray(e) || typeof e[0] !== "string" || !e[0] || e[0].length > 128 || !e[1] || !validClaim(e[1].h) || typeof e[1].seen !== "number") continue;
      if (claims.size >= CLAIMS_MAX) break;
      if (!claimExpired(e[1], now)) claims.set(e[0], { h: e[1].h, seen: e[1].seen });
    }
    console.log("[claims] восстановлено: " + claims.size);
    return claims.size;
  } catch (e) { console.warn("[claims] не удалось прочитать файл:", e.message); return 0; }
}
function saveClaims() {
  if (!CLAIMS_PERSIST) return;
  try {
    const tmp = CLAIMS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, claims: Array.from(claims.entries()) }), { mode: 0o600 });
    fs.renameSync(tmp, CLAIMS_FILE); // атомарно
  } catch (e) { console.warn("[claims] не удалось сохранить:", e.message); }
}
let claimsDirty = false, claimsTimer = null;
function scheduleClaimsSave() {
  if (!CLAIMS_PERSIST) return;
  claimsDirty = true;
  if (claimsTimer) return;
  claimsTimer = setTimeout(() => { claimsTimer = null; if (claimsDirty) { claimsDirty = false; saveClaims(); } }, 2000);
}
function claimCreateOk(ip) {
  const now = Date.now();
  const w = rlGet(claimCreateHits, ip, now);
  if (now - w.start > 3600_000) { w.start = now; w.n = 0; }
  w.n++;
  claimCreateHits.set(ip, w);
  if (claimCreateHits.size > 5000) pruneRateLimitMap(claimCreateHits);
  return w.n <= CLAIM_CREATE_PER_HOUR_PER_IP;
}
// Решение для register: "ok" (claim принят/создан или id без claim), "claimed" (id занят другим владельцем).
function claimCheckRegister(id, claim, ip) {
  const now = Date.now();
  let rec = claims.get(id);
  if (rec && claimExpired(rec, now) && !clients.has(id)) { claims.delete(id); rec = null; scheduleClaimsSave(); }
  if (rec) {
    if (!claimMatches(rec, claim)) return "claimed";
    rec.seen = now; scheduleClaimsSave();
    return "ok";
  }
  if (!validClaim(claim)) return "ok"; // старый клиент: id без защиты
  if (claims.size >= CLAIMS_MAX) { pruneClaims(now); if (claims.size >= CLAIMS_MAX) return "ok"; } // таблица полна — не вытесняем чужие claim-ы, id остаётся без защиты
  if (!claimCreateOk(ip)) return "ok"; // лимит создания: id регистрируется, но claim не создаётся (клиент повторит позже)
  claims.set(id, { h: sha256Hex(claim), seen: now });
  scheduleClaimsSave();
  return "ok";
}
function touchClaim(id) { const r = claims.get(id); if (r) { r.seen = Date.now(); scheduleClaimsSave(); } }
loadClaims();

// ---------- Обнаружение по хэшу телефона/почты (добровольно, по умолчанию у клиента ВЫКЛ) ----------
// Клиент, включивший «Меня можно найти», публикует ключ обнаружения = HMAC-SHA256(DISCOVERY_SALT, нормализованный телефон/email).
// Сервер хранит только: хэш, id, публичный ключ (берётся из register) и, если владелец разрешил, имя. Публиковать может лишь id с claim (владение id).
// Поиск: клиент шлёт ≤200 хэшей своих знакомых — в ответ только найденные. «Скрытый/не включил» неотличим от «нет». Лимиты: см. ниже.
// Риск: номеров мало (~10^10), поэтому соль + лимиты замедляют, но не исключают перебор; это добровольная функция (см. docs/PRIVACY.md).
const DISCOVERY_ENABLED = process.env.DISCOVERY_ENABLED !== "0";
const DISCOVERY_TTL_MS = envInt("DISCOVERY_TTL_DAYS", 90) * 86400 * 1000;
const DISCOVERY_MAX = envInt("DISCOVERY_MAX", 200000);
const DISCOVERY_MAX_PER_ID = 3;
const DISCOVERY_BATCH = 200;
const DISCOVERY_REQ_PER_HOUR = envInt("DISCOVERY_REQ_PER_HOUR", 20);
const DISCOVERY_HASHES_PER_DAY = envInt("DISCOVERY_HASHES_PER_DAY", 1000);
const DISCOVERY_PUBLISH_PER_HOUR = envInt("DISCOVERY_PUBLISH_PER_HOUR", 30);
const DISCOVERY_MIN_MS = envInt("DISCOVERY_MIN_MS", 150); // одинаковое (минимальное) время ответа
const DISCOVERY_PERSIST = process.env.DISCOVERY_PERSIST !== "0";
const DISCOVERY_FILE = process.env.DISCOVERY_FILE || path.join(process.env.DATA_DIR || __dirname, ".ether-discovery.json");
const HASH_RE = /^[0-9a-f]{64}$/;
const discovery = new Map();     // hash -> { id, pk, name, seen }
const discoveryById = new Map(); // id -> Set(hash)
const discIpHits = new Map(), discIdHits = new Map(), discDayHits = new Map(), discPubHits = new Map();
let DISCOVERY_SALT = (process.env.DISCOVERY_SALT || "").trim();
function loadDiscovery() {
  let data = null;
  try { if (DISCOVERY_PERSIST && fs.existsSync(DISCOVERY_FILE)) data = JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8")); } catch (e) { console.warn("[discovery] не удалось прочитать файл:", e.message); }
  if (!data || data.v !== 1 || typeof data.salt !== "string" || !Array.isArray(data.entries)) data = null;
  if (!DISCOVERY_SALT) DISCOVERY_SALT = data ? data.salt : crypto.randomBytes(24).toString("hex");
  if (data && data.salt === DISCOVERY_SALT) {
    const now = Date.now();
    for (const e of data.entries) {
      if (!Array.isArray(e) || !HASH_RE.test(e[0]) || !e[1] || typeof e[1].id !== "string" || !e[1].id || e[1].id.length > 128 || typeof e[1].seen !== "number") continue;
      if (now - e[1].seen > DISCOVERY_TTL_MS || discovery.size >= DISCOVERY_MAX) continue;
      discoverySet(e[0], { id: e[1].id, pk: validPublicKeyJwk(e[1].pk) ? e[1].pk : null, name: typeof e[1].name === "string" ? e[1].name.slice(0, 60) : "", seen: e[1].seen });
    }
  } // соль сменилась — старые хэши бесполезны, отбрасываем
  saveDiscovery();
}
function discoverySet(h, rec) {
  const old = discovery.get(h);
  if (old && old.id !== rec.id) { const s = discoveryById.get(old.id); if (s) { s.delete(h); if (!s.size) discoveryById.delete(old.id); } }
  discovery.set(h, rec);
  let s = discoveryById.get(rec.id); if (!s) discoveryById.set(rec.id, s = new Set()); s.add(h);
}
function discoveryDropId(id) {
  const s = discoveryById.get(id); if (!s) return false;
  for (const h of s) discovery.delete(h);
  discoveryById.delete(id); scheduleDiscoverySave(); return true;
}
function saveDiscovery() {
  if (!DISCOVERY_PERSIST) return;
  try {
    const tmp = DISCOVERY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, salt: DISCOVERY_SALT, entries: Array.from(discovery.entries()) }), { mode: 0o600 });
    fs.renameSync(tmp, DISCOVERY_FILE);
  } catch (e) { console.warn("[discovery] не удалось сохранить:", e.message); }
}
let discoveryTimer = null;
function scheduleDiscoverySave() {
  if (!DISCOVERY_PERSIST || discoveryTimer) return;
  discoveryTimer = setTimeout(() => { discoveryTimer = null; saveDiscovery(); }, 2000);
}
function discWindow(map, key, windowMs, add, limit) { // true, если после добавления add остаёмся в пределах limit
  const now = Date.now();
  const w = rlGet(map, key, now);
  if (now - w.start > windowMs) { w.start = now; w.n = 0; }
  w.n += add; map.set(key, w);
  if (map.size > 20000) { for (const [k, v] of map) if (now - v.start > windowMs) map.delete(k); }
  return w.n <= limit;
}
function discoveryExpire() {
  const now = Date.now();
  for (const [h, r] of discovery) if (now - r.seen > DISCOVERY_TTL_MS && !clients.has(r.id)) { discovery.delete(h); const s = discoveryById.get(r.id); if (s) { s.delete(h); if (!s.size) discoveryById.delete(r.id); } }
}
function discoveryTouch(id, pk) { // при регистрации: продлеваем TTL и обновляем публичный ключ
  const s = discoveryById.get(id); if (!s) return;
  const now = Date.now();
  for (const h of s) { const r = discovery.get(h); if (r) { r.seen = now; if (pk) r.pk = pk; } }
  scheduleDiscoverySave();
}
if (DISCOVERY_ENABLED) loadDiscovery();

// ---------- Утилиты ----------
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}
function rosterEntry(id) {
  const c = clients.get(id);
  return c ? { id, name: c.name || "", visible: c.visible !== false, publicKey: c.publicKey || null, caps: c.caps || [] } : null;
}
// Кто кого видит в списке «онлайн» (A3). Раньше каждый зарегистрировавшийся получал ВСЕХ: id (хэш телефона/почты без соли — перебирается
// за минуты), имена и ключи — в том числе скрытых («не показывать меня»). Теперь клиент присылает watch — список id своих контактов, и видит
// только их плюс тех, кто сам согласился быть видимым. Старые клиенты (без watch) пока видят всех; STRICT_ROSTER=1 закрывает и это —
// включайте, когда клиенты обновились (иначе у старых скрытые контакты будут казаться офлайн).
const STRICT_ROSTER = process.env.STRICT_ROSTER === "1";
const WATCH_MAX = 2000;
// Скрытый (visible:false) виден ТОЛЬКО тем, кто есть в его собственном ростере (watch): раньше достаточно было вписать чужой id в свой watch — и
// watch-result/presence выдавали «онлайн» + имя + ключ скрытого кому угодно (оракул присутствия, S3/S11). target — запись клиента ({visible, watch}).
// Скрытый старый клиент без watch оценивается по прежним правилам (совместимость).
function canSeePresence(viewer, viewerId, targetId, target) {
  const targetVisible = target ? target.visible : true;
  if (targetVisible !== false) return true;
  if (target && target.watch) return target.watch.has(viewerId);
  if (viewer.watch) return viewer.watch.has(targetId);
  return !STRICT_ROSTER;
}
// Можно ли доставить сигнал (offer/answer/call-invite) адресату: те же права, что и на присутствие, чтобы unreachable не выдавал скрытого.
function canReach(fromId, from, targetId, target) {
  if (!target) return false;
  if (target.visible !== false) return true;
  if (target.watch) return target.watch.has(fromId);
  return from && from.watch ? from.watch.has(targetId) : !STRICT_ROSTER;
}
function broadcastPresence(id, online, extra = {}) {
  const rec = online ? clients.get(id) : (extra.rec || null);
  const entry = online ? rosterEntry(id) : { id, name: "", visible: extra.wasVisible !== false, publicKey: null };
  const { wasVisible, rec: _rec, ...rest } = extra;
  const target = rec || { visible: entry ? entry.visible : true, watch: null };
  for (const [otherId, c] of clients) {
    if (otherId === id) continue;
    if (!canSeePresence(c, otherId, id, target)) continue;
    safeSend(c.ws, { type: "presence", id, online, ...entry, ...rest });
  }
}
function flushMailbox(id, ws) {
  const box = mailbox.get(id);
  if (!box || box.size === 0) return;
  for (const [msgId, entry] of box) {
    safeSend(ws, {
      type: "deliver",
      from: entry.from,
      msgId,
      envelope: entry.envelope,
      fromPublicKey: entry.fromPublicKey || null,
      kind: entry.kind || "chat",
      ...(entry.fromDev ? { fromDev: entry.fromDev } : {}),
      queued: true,
    });
  }
}
// Раньше ct.length < 96*1024 — рассчитано только на текстовые
// сообщения. Но офлайн-отправка файлов/голосовых (kind: "file",
// добавлена позже — sendFileOffline/sendVoiceOffline в app.js) кладёт
// в этот же envelope base64 файла до MAX_FILE_SIZE (2МБ), что после
// base64-кодирования даёт ~2.73МБ — сервер отклонял бы это как
// "invalid-envelope" на КАЖДОЙ попытке отправить файл офлайн крупнее
// ~70КБ, независимо от того, что сама фича существует и работает во
// всём остальном. Подняли потолок до 3.5МБ — с запасом выше
// теоретического максимума (2МБ исходника * 4/3 base64 + накладные
// расходы шифрования), но по-прежнему далеко от MAX_PAYLOAD (8МБ) —
// внешний предел на весь WS-фрейм остаётся дополнительной защитой.
function isValidEnvelope(env) {
  if (!env || typeof env.ct !== "string" || env.ct.length >= 3.5 * 1024 * 1024) return false;
  // v1: {iv, ct, v?} — статический ECDH; v2: Double Ratchet {v:2, h:{d:[x,y], pn, n, i?, p?}, ct} (js/ratchet.js)
  // v2 без поля h — конверт офлайн-очереди формата env2 (AES-GCM с AAD, {iv, ct, v:2}, js/crypto-helper.js): валидируется как v1.
  if (env.v === 2 && env.h !== undefined) {
    const h = env.h;
    const str = (s) => typeof s === "string" && s.length > 0 && s.length <= 100;
    if (!h || typeof h !== "object" || !Array.isArray(h.d) || h.d.length !== 2 || !str(h.d[0]) || !str(h.d[1])) return false;
    if (!Number.isInteger(h.pn) || !Number.isInteger(h.n) || h.pn < 0 || h.n < 0 || h.pn > 1e9 || h.n > 1e9) return false;
    if (h.p != null && (typeof h.p !== "object" || JSON.stringify(h.p).length > 400)) return false;
    return true;
  }
  return typeof env.iv === "string" && env.iv.length < 200;
}
// Возможности сервера, о которых он сообщает клиентам при регистрации: клиент включает новый формат только если сервер его понимает.
const devicesMod = require("./devices");
const deviceLists = new Map(), deviceListHits = new Map(); // id -> {seq, list, at}; хранится в DATA_DIR/.ether-devices.json, основное по-прежнему публикует список при каждом подключении
const DEVICE_LIST_MAX_BYTES = 8 * 1024, DEVICE_LISTS_MAX = 20000;
// Списки устройств переживают рестарт: DATA_DIR/.ether-devices.json (атомарно, 0600), TTL записи без обновления, потолок числа и размера.
// Подпись сервер не проверяет (контакты проверяют сами), поэтому подмена файла ничего не даёт: ни один клиент не примет список без подписи владельца.
const DEVICES_PERSIST = process.env.DEVICES_PERSIST ? process.env.DEVICES_PERSIST !== "0" : process.env.MAILBOX_PERSIST !== "0";
const DEVICES_FILE = process.env.DEVICES_FILE || path.join(process.env.DATA_DIR || __dirname, ".ether-devices.json");
const DEVICES_TTL_MS = 400 * 86400_000, DEVICES_FILE_MAX_BYTES = 40 * 1024 * 1024;
function validDeviceList(id, l) {
  if (!l || typeof l !== "object" || l.id !== id || !Number.isSafeInteger(l.seq) || l.seq <= 0 || typeof l.sig !== "string" || l.sig.length > 200 || !Array.isArray(l.certs) || l.certs.length > 8) return false;
  try { return JSON.stringify(l).length <= DEVICE_LIST_MAX_BYTES; } catch (e) { return false; }
}
function loadDeviceLists() {
  if (!DEVICES_PERSIST) return 0;
  try {
    if (!fs.existsSync(DEVICES_FILE) || fs.statSync(DEVICES_FILE).size > DEVICES_FILE_MAX_BYTES) return 0;
    const data = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8")), now = Date.now();
    if (!data || data.v !== 1 || !Array.isArray(data.lists)) return 0;
    for (const e of data.lists) {
      if (!Array.isArray(e) || typeof e[0] !== "string" || !e[0] || e[0].length > 128 || !e[1] || typeof e[1].at !== "number" || now - e[1].at > DEVICES_TTL_MS || !validDeviceList(e[0], e[1].list)) continue;
      if (deviceLists.size >= DEVICE_LISTS_MAX) break;
      deviceLists.set(e[0], { seq: e[1].list.seq, list: e[1].list, at: e[1].at });
    }
    console.log("[devices] восстановлено списков: " + deviceLists.size);
    return deviceLists.size;
  } catch (e) { console.warn("[devices] не удалось прочитать файл:", e.message); return 0; }
}
function saveDeviceLists() {
  if (!DEVICES_PERSIST) return;
  try {
    const tmp = DEVICES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, lists: Array.from(deviceLists.entries()).map(([id, e]) => [id, { at: e.at || Date.now(), list: e.list }]) }), { mode: 0o600 });
    fs.renameSync(tmp, DEVICES_FILE); // атомарно
  } catch (e) { console.warn("[devices] не удалось сохранить:", e.message); }
}
let devicesTimer = null;
function scheduleDevicesSave() {
  if (!DEVICES_PERSIST || devicesTimer) return;
  devicesTimer = setTimeout(() => { devicesTimer = null; saveDeviceLists(); }, 1000);
}
loadDeviceLists();
function devicesCtx() {
  return { deviceLists, safeSend, mailboxPut, mailboxRemove, scheduleSave: scheduleMailboxSave, isValidEnvelope, cleanEnvelope, cleanKind, WebSocket, features: SERVER_FEATURES,
    clientsGet: (id) => clients.get(id), flush: (key, w) => flushMailbox(key, w),
    rateOk: (from, to) => wsRateLimitPairOk(from, to, DELIVER_RATE_LIMIT_PER_MIN) && wsRateLimitOk(deliverTotalHits, from, DELIVER_TOTAL_LIMIT_PER_MIN),
    pushSubs, validatePushSubscription, normLang, schedulePushSubsSave, maxPushSubs: MAX_PUSH_SUBS, vapidKey: () => (PUSH_ENABLED ? VAPID_PUBLIC : ""),
    pushHit: (k) => wsRateLimitOk(pushSubHits, k, 10), notifyDevice,
    mailboxKeys: (prefix) => Array.from(mailbox.keys()).filter((k) => k.startsWith(prefix)),
    mailboxDropBox: (k) => { const b = mailbox.get(k); if (b) for (const m of Array.from(b.keys())) mailboxRemove(k, m); scheduleMailboxSave(); } };
}
const SERVER_FEATURES = ["ratchet2", "prekeys", "watch", "claim", "env2", "devicelink", "devlist", "devmail", "devsync", "devpush", "devnotify"].concat(DISCOVERY_ENABLED ? ["discovery"] : []);

// ---------- Prekey-пакеты для начала Double Ratchet (3DH/4DH) ----------
// Клиент заранее выкладывает подписанный-по-смыслу prekey (spk, меняется раз в неделю) и пачку одноразовых (opks).
// Сервер хранит только ПУБЛИЧНЫЕ части в памяти и отдаёт желающим начать переписку: spk + один opk (который тут же удаляется).
// Подмена пакета сервером ничего не даёт: общий секрет включает DH с долговременным ключом получателя, которого у сервера нет.
const prekeys = new Map(); // id -> { spk: {id, pub:[x,y]}|null, opks: Map(opkId -> [x,y]), ts }
const prekeyUploadHits = new Map();
const prekeyFetchHits = new Map();
const prekeyPairHits = new Map();   // отдельно от deliverHits: выборка prekey не должна съедать квоту deliver (и наоборот)
const prekeyTargetHits = new Map(); // общий лимит на ЦЕЛЬ: не даём выкачать одноразовые ключи жертвы с разных аккаунтов
const PREKEY_FETCH_PER_TARGET_PER_MIN = 10;
const callPushRecipientAt = new Map(); // получатель -> ts последнего принудительного push о звонке
const callPushPairAt = new Map();      // отправитель→получатель -> ts
const CALL_PUSH_RECIPIENT_BURST = 3;
const CALL_PUSH_RECIPIENT_MS = 15 * 1000, CALL_PUSH_PAIR_MS = 30 * 1000;
const ipConnCount = new Map();         // ip -> число открытых сокетов
// Язык push приходит от клиента: нормализуем ("ru_RU" → "ru-RU") и проверяем по белому списку формы, иначе "en".
function normLang(l) {
  if (typeof l !== "string" || l.length > 35) return "en";
  const t = l.split(/[-_]/).slice(0, 2).join("-");
  return validLang(t) ? t : "en";
}
function validPublicKeyJwk(k) {
  if (k == null || typeof k !== "object" || Array.isArray(k)) return false;
  try { return JSON.stringify(k).length <= 1024; } catch (e) { return false; }
}
// В ящик попадают только известные поля конверта (раньше сохранялся любой объект, присланный клиентом, целиком).
function cleanEnvelope(env) {
  const out = {};
  if (env.v === 2 && env.h !== undefined) {
    const h = env.h, nh = { d: [h.d[0], h.d[1]], pn: h.pn, n: h.n };
    if (h.i != null) { let l = 1e9; try { l = JSON.stringify(h.i).length; } catch (e) {} if (l > 400) return null; nh.i = h.i; }
    if (h.p != null) nh.p = h.p;
    out.v = 2; out.h = nh; out.ct = env.ct;
  } else {
    out.iv = env.iv; out.ct = env.ct;
    if (typeof env.v === "number" || typeof env.v === "string") out.v = typeof env.v === "string" ? env.v.slice(0, 8) : env.v;
  }
  if (typeof env.rc === "number" || typeof env.rc === "boolean") out.rc = env.rc;
  if (typeof env.e2 === "number" || typeof env.e2 === "boolean") out.e2 = env.e2; // «я умею конверты v2 с AAD» (как rc для Double Ratchet)
  return out;
}
function cleanKind(k) { return typeof k === "string" && k.length <= 24 && /^[a-z0-9-]+$/i.test(k) ? k : "chat"; }
const PREKEY_MAX_OPKS = 100, PREKEY_MAX_UPLOAD = 50, PREKEY_LOW = 10, PREKEY_TTL_MS = 30 * 24 * 3600 * 1000;
function validPrekeyPub(p) { return Array.isArray(p) && p.length === 2 && p.every((s) => typeof s === "string" && s.length >= 20 && s.length <= 100 && /^[A-Za-z0-9_-]+$/.test(s)); }
function validPrekeyId(s) { return typeof s === "string" && s.length >= 1 && s.length <= 32 && /^[A-Za-z0-9_-]+$/.test(s); }
function prekeyCount(id) { const e = prekeys.get(id); return e ? e.opks.size : 0; }
setInterval(() => { const now = Date.now(); for (const [id, e] of prekeys) if (now - e.ts > PREKEY_TTL_MS) prekeys.delete(id); }, 3600 * 1000).unref();
function shortId(s) { return sanitizeForLog(String(s || "").slice(0, 10), 10) + "…"; }

// ---------- Соединения ----------
wss.on("connection", (ws, req) => {
  let myId = null;
  const ipAddr = clientIp(req);
  ws.on("error", () => {});
  // Не более MAX_SIGNAL_SOCKETS_PER_IP одновременных соединений с одного адреса (с запасом на несколько вкладок/устройств).
  const nConn = (ipConnCount.get(ipAddr) || 0) + 1;
  if (nConn > MAX_SIGNAL_SOCKETS_PER_IP) { try { ws.close(1013, "too many connections"); } catch (e) {} setTimeout(() => { try { ws.terminate(); } catch (e) {} }, 1000).unref(); return; }
  ipConnCount.set(ipAddr, nConn);
  // Сокет, который не зарегистрировался за REGISTER_DEADLINE_MS, закрываем: иначе пустые соединения живут вечно.
  const regTimer = setTimeout(() => { if (!myId && !ws._dev) { try { ws.terminate(); } catch (e) {} } }, REGISTER_DEADLINE_MS);
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    // Любая ошибка в разборе сообщения не должна ронять процесс — логируем и идём дальше.
    try { onMessage(raw); } catch (e) { console.error("[ws] ошибка обработчика:", sanitizeForLog(e && e.stack || e, 300)); }
  });
  const onMessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "ping") {
      // application-level пинг от клиента (см. signaling-client.js,
      // шлётся каждые 15 секунд). iOS-фоновый браузер отвечает на
      // protocol-level WebSocket pong сам, даже когда JS приложения
      // не выполняется — поэтому ws.isAlive остаётся true и сервер
      // часами считает закрытый PWA онлайн. Application-level ping
      // может отправить только работающий JS — по его отсутствию
      // определяем реального "мертвеца".
      ws.lastClientPing = Date.now();
      safeSend(ws, { type: "pong", t: msg.t });
      return;
    }

    // Companion-устройства аккаунта (devices.js): register с deviceId, device-auth и всё от уже авторизованного companion-сокета
    if ((msg.type === "register" && typeof msg.deviceId === "string") || msg.type === "device-auth" || ws._dev) {
      if (devicesMod.onMessage(ws, msg, devicesCtx())) return;
    }

    // Всё, кроме register/ping, — только от текущего (не вытесненного) соединения зарегистрированного id.
    if (msg.type !== "register" && (!myId || !clients.get(myId) || clients.get(myId).ws !== ws)) return;

    if (msg.type === "register" && typeof msg.id === "string" && msg.id && msg.id.length <= 128) {
      if (!registerRateLimitOk(ipAddr)) {
        safeSend(ws, { type: "register-rate-limited" });
        return;
      }
      // Claim-токен: id, занятый другим владельцем (его claim ещё не истёк), занять нельзя — ни новому клиенту с другим токеном, ни старому без токена.
      if (claimCheckRegister(msg.id, msg.claim, ipAddr) === "claimed") {
        safeSend(ws, { type: "register-error", error: "id-claimed", id: msg.id, claimTtlH: Math.round(CLAIM_TTL_MS / 3600000) });
        console.log("[reg] " + shortId(msg.id) + " отклонён: id-claimed");
        return;
      }
      // Повторный register с ДРУГИМ id на том же сокете: старую запись снимаем (иначе clients[A] навсегда указывал бы на этот сокет).
      if (myId && myId !== msg.id) {
        const prev = clients.get(myId);
        if (prev && prev.ws === ws) {
          if (DISCOVERY_ENABLED) discoveryDropId(myId); // смена id: запись обнаружения старого id снимается
          clients.delete(myId);
          broadcastPresence(myId, false, { wasVisible: prev.visible, rec: prev });
        }
      }
      if (clients.has(msg.id) && clients.get(msg.id).ws !== ws) {
        let oldVisible = true, oldRec = null;
        try {
          const old = clients.get(msg.id);
          oldRec = old;
          oldVisible = old.visible;
          // Для диагностики: с какого адреса пришла «замена» и совпадает ли он со старым соединением (то же устройство/сеть)
          safeSend(old.ws, { type: "replaced", sameIp: old.ip === ipAddr, ageSec: Math.round((Date.now() - (old.since || Date.now())) / 1000) });
          old.ws.close();
          // Вытесненный сокет не должен оставаться рабочим, пока закрывается: дожимаем terminate() (его сообщения и так игнорируются — см. проверку выше).
          const oldWs = old.ws; setTimeout(() => { try { oldWs.terminate(); } catch (e) {} }, 1500).unref();
        } catch (e) {}
        broadcastPresence(msg.id, false, { wasVisible: oldVisible, rec: oldRec });
      }
      myId = msg.id;
      clearTimeout(regTimer);
      ws._etherId = myId;
      ws.lastClientPing = Date.now();
      clients.set(myId, {
        ws, ip: ipAddr, since: Date.now(),
        name: String(msg.name || "").slice(0, 60),
        visible: msg.visible !== false,
        // Возможности клиента (напр. "env2"): короткий белый список строк, рассылается наблюдателям вместе с присутствием
        caps: Array.isArray(msg.caps) ? msg.caps.filter((x) => typeof x === "string" && /^[a-z0-9]{1,12}$/.test(x)).slice(0, 8) : [],
        publicKey: validPublicKeyJwk(msg.publicKey) ? msg.publicKey : null, // раньше без проверки типа/размера и рассылалось всем наблюдателям
        // Новый клиент передаёт список контактов уже при регистрации — первый ростер сразу урезан (иначе до отдельного watch он бы получил всех)
        watch: Array.isArray(msg.watch) ? new Set(msg.watch.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 128).slice(0, WATCH_MAX)) : null,
      });
      console.log("[reg] " + shortId(myId) + " visible=" + (msg.visible !== false) + " clients=" + clients.size);
      const me0 = clients.get(myId);
      const online = Array.from(clients.keys())
        .filter((i) => i !== myId)
        .map((i) => rosterEntry(i))
        .filter((e) => e && canSeePresence(me0, myId, e.id, clients.get(e.id)));
      safeSend(ws, Object.assign({ type: "registered", id: myId, online, features: SERVER_FEATURES, prekeyCount: prekeyCount(myId), claimed: claims.has(myId) }, DISCOVERY_ENABLED ? { discoverySalt: DISCOVERY_SALT, discoveryPublished: discoveryById.has(myId) } : {}));
      if (DISCOVERY_ENABLED) discoveryTouch(myId, me0.publicKey);
      if (PUSH_ENABLED) safeSend(ws, { type: "vapid-key", key: VAPID_PUBLIC });
      clearThrottleForRecipient(myId);
      flushMailbox(myId, ws);
      broadcastPresence(myId, true);
      return;
    }

    // watch: «следите за этими контактами» — заменяет весь список; в ответ — те из них, кто сейчас онлайн
    if (msg.type === "watch" && myId) {
      if (!wsRateLimitOk(watchHits, myId, 20)) return;
      const me = clients.get(myId); if (!me) return;
      const ids = Array.isArray(msg.ids) ? msg.ids.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 128).slice(0, WATCH_MAX) : [];
      const prevWatch = me.watch;
      me.watch = new Set(ids);
      // Скрытого чужой watch не делает видимым: нужен он сам в чужом ростере (см. canSeePresence).
      const online = ids.filter((i) => i !== myId).map((i) => rosterEntry(i)).filter((e) => e && canSeePresence(me, myId, e.id, clients.get(e.id)));
      safeSend(ws, { type: "watch-result", online, strict: STRICT_ROSTER });
      // Скрытый, убравший контакта из watch, перестаёт быть для него «онлайн».
      if (me.visible === false && prevWatch) {
        for (const i of prevWatch) {
          if (i === myId || me.watch.has(i)) continue;
          const other = clients.get(i);
          if (other) safeSend(other.ws, { type: "presence", id: myId, online: false, name: "", visible: false, publicKey: null });
        }
      }
      // Скрытый, добавивший контакта в свой ростер, становится виден ему: сообщаем присутствие вновь добавленным.
      if (me.visible === false) {
        for (const i of me.watch) {
          if (i === myId || (prevWatch && prevWatch.has(i))) continue;
          const other = clients.get(i);
          if (other && canSeePresence(other, i, myId, me)) safeSend(other.ws, { type: "presence", id: myId, online: true, ...rosterEntry(myId) });
        }
      }
      return;
    }

    if (msg.type === "push-subscribe" && myId && msg.subscription) {
      if (!wsRateLimitOk(pushSubHits, myId, 10)) return;
      try {
        // endpoint выбирает клиент — без проверки это слепой SSRF (сервер сам делает POST на этот адрес). Только https и известные push-сервисы.
        const sub = validatePushSubscription(msg.subscription);
        if (!sub) { safeSend(ws, { type: "push-subscribe-error", error: "invalid-subscription" }); return; }
        if (!pushSubs.has(myId) && pushSubs.size >= MAX_PUSH_SUBS) { safeSend(ws, { type: "push-subscribe-error", error: "full" }); return; }
        pushSubs.set(myId, { subscription: sub, lang: normLang(msg.lang) });
        schedulePushSubsSave();
        safeSend(ws, { type: "push-subscribed" });
        console.log("[push] подписка сохранена для", shortId(myId), "всего=" + pushSubs.size);
      } catch (e) {}
      return;
    }
    if (msg.type === "push-unsubscribe" && myId) {
      pushSubs.delete(myId);
      schedulePushSubsSave();
      safeSend(ws, { type: "push-unsubscribed" });
      return;
    }

    if (msg.type === "signal" && myId && typeof msg.to === "string" && msg.to.length <= 128) {
      if (!wsRateLimitOk(signalHits, myId, SIGNAL_RATE_LIMIT_PER_MIN)) return;
      const target = clients.get(msg.to);
      const payload = { type: "signal", from: myId, data: msg.data };
      // Скрытый адресат, у которого отправителя нет в ростере, неотличим от офлайн/незарегистрированного: тот же ответ unreachable, без доставки.
      if (target && canReach(myId, clients.get(myId), msg.to, target)) {
        safeSend(target.ws, payload);
        console.log("[sig] " + shortId(myId) + " → " + shortId(msg.to) + " t=" + sanitizeForLog(msg.data && msg.data.t, 24));
      } else {
        safeSend(ws, { type: "unreachable", to: msg.to });
        console.log("[sig] " + shortId(myId) + " → UNREACHABLE " + shortId(msg.to) + " t=" + sanitizeForLog(msg.data && msg.data.t, 24));
      }
      if (msg.data && msg.data.t === "call-invite") {
        // Дедупликация по packet.x — если это повторная отправка ТОГО ЖЕ
        // самого приглашения (например, ретрай после переподключения
        // клиента), получатель уже получил push на эту попытку звонка.
        // На клиенте isDuplicateSignal защищает от повторной обработки
        // сигнала, но push к тому моменту уже был бы отправлен повторно.
        const inviteNonce = (typeof msg.data.x === "string" || typeof msg.data.x === "number") ? String(msg.data.x).slice(0, 128) : null;
        if (inviteNonce && callInvitePushSent.has(inviteNonce)) return;
        // Принудительные (force) push о звонке обходят общий троттлинг — ограничиваем отдельно: не чаще раза в 15 с на получателя
        // и раза в 30 с на пару отправитель→получатель (первый push уходит сразу).
        { const tNow = Date.now(), pk = myId + "→" + msg.to;
          let lr = callPushRecipientAt.get(msg.to); const lp = callPushPairAt.get(pk);
          if (lr && tNow - lr.ts >= CALL_PUSH_RECIPIENT_MS) lr = null; // окно получателя истекло
          // Получатель: не более CALL_PUSH_RECIPIENT_BURST push за окно (а не один: иначе посторонний «глушит» настоящие звонки жертве).
          if ((lr && lr.n >= CALL_PUSH_RECIPIENT_BURST) || (lp && tNow - lp < CALL_PUSH_PAIR_MS)) { console.log("[call-push] throttled " + shortId(myId) + " → " + shortId(msg.to)); return; }
          console.log("[call-push] allowed " + shortId(myId) + " → " + shortId(msg.to));
          if (inviteNonce) callInvitePushSent.set(inviteNonce, tNow); // nonce помечаем только после прохождения троттлинга
          callPushRecipientAt.set(msg.to, lr ? { ts: lr.ts, n: lr.n + 1 } : { ts: tNow, n: 1 }); callPushPairAt.set(pk, tNow);
          for (const m of [callPushRecipientAt, callPushPairAt]) if (m.size > 50000) m.delete(m.keys().next().value); }
        const me = clients.get(myId);
        const recipientLang = (pushSubs.get(msg.to) || {}).lang;
        const myName = (me && me.name) || pushText(recipientLang, "call");
        sendPushTo(msg.to, myId, {
          title: "📞 " + myName,
          body: pushText(recipientLang, "incomingCall"),
          tag: "ether-call-" + myId,
          contactId: myId,
          kind: "call",
        }, { force: true }).catch(() => {});
      }
      return;
    }

    // ---------- Доставка зашифрованного конверта ----------
    if (msg.type === "deliver" && myId && typeof msg.to === "string" && msg.to.length <= 128 && typeof msg.msgId === "string" && msg.msgId.length <= 128) {
      // Доставка самому себе бессмысленна: клиент не имеет причин так
      // делать, а сервер только зря потратит память на запись в mailbox
      // и попытается сделать доставку через свой же WS, что немедленно
      // провалится в "target.readyState !== OPEN" (это тот же WS).
      // Отсекаем сразу.
      if (msg.to === myId && !((msg.kind === "sync-sent" || msg.kind === "sync-op") && Array.isArray(msg.copies))) return;
      if (!wsRateLimitPairOk(myId, msg.to, DELIVER_RATE_LIMIT_PER_MIN)) return;
      if (!wsRateLimitOk(deliverTotalHits, myId, DELIVER_TOTAL_LIMIT_PER_MIN)) return; // общий потолок на отправителя независимо от получателей
      const syncOnly = msg.to === myId && msg.envelope == null; // sync-sent: только копии другим устройствам аккаунта
      if (!syncOnly && !isValidEnvelope(msg.envelope)) {
        safeSend(ws, { type: "deliver-ack", msgId: msg.msgId, error: "invalid-envelope" });
        return;
      }
      // fromPublicKey раньше принимался вообще без проверки размера —
      // реальный JWK P-256 весит ~126 байт, но ничто не мешало
      // отправителю подсунуть сюда мегабайты произвольной строки.
      // MAX_MAILBOX_PER_USER записей в mailbox * почти неограниченный
      // fromPublicKey на каждую — потенциально гигабайты на одного
      // получателя. 1КБ — щедрый запас (8x реального размера), но
      // отсекает злоупотребление.
      if (msg.fromPublicKey != null && (
        typeof msg.fromPublicKey !== "object" ||
        Array.isArray(msg.fromPublicKey) ||
        JSON.stringify(msg.fromPublicKey).length > 1024
      )) {
        safeSend(ws, { type: "deliver-ack", msgId: msg.msgId, error: "invalid-envelope" });
        return;
      }
      const kind = cleanKind(msg.kind);
      const envelope = syncOnly ? null : cleanEnvelope(msg.envelope);
      if (!envelope && !syncOnly) {
        safeSend(ws, { type: "deliver-ack", msgId: msg.msgId, error: "invalid-envelope" });
        return;
      }
      const target = clients.get(msg.to);
      console.log("[deliver] " + shortId(myId) + " → " + shortId(msg.to) + " msgId=" + sanitizeForLog(msg.msgId, 8) + "… kind=" + sanitizeForLog(kind, 24) + " online=" + !!target);
      const payload = {
        from: myId,
        msgId: msg.msgId,
        envelope,
        fromPublicKey: msg.fromPublicKey || null,
        kind,
      };

      // Идемпотентность: повтор того же (from, to, msgId) с ТЕМ ЖЕ конвертом (ретрай клиента, лаг подтверждения) в ящик не кладём
      // и не пересылаем — получатель уже получил его или получит из ящика. Конверт, зашифрованный заново (другие байты), проходит как раньше.
      if (msg.copies != null && !devicesMod.dispatch(devicesCtx(), { fromId: myId, fromDev: "", to: msg.to, msgId: msg.msgId, kind, envelope: null, copies: msg.copies, fromPublicKey: msg.fromPublicKey })) {
        safeSend(ws, { type: "deliver-ack", msgId: msg.msgId, error: "invalid-envelope" });
        return;
      }
      if (msg.to === myId) { safeSend(ws, { type: "deliver-ack", msgId: msg.msgId }); return; } // sync-sent: только копии другим устройствам
      const dupKey = deliverDupKey(msg.to, myId, msg.msgId, envelope);
      const inBox = mailbox.get(msg.to);
      const prev = inBox && inBox.get(msg.msgId);
      const isDup = recentAcked.has(dupKey) || !!(prev && prev.from === myId && deliverDupKey(msg.to, myId, msg.msgId, prev.envelope) === dupKey);
      if (isDup) {
        safeSend(ws, { type: "deliver-ack", msgId: msg.msgId });
        return;
      }
      mailboxPut(msg.to, msg.msgId, { ...payload, ts: Date.now() }); // потолки (на получателя и общие) проверяются при вставке
      scheduleMailboxSave();

      if (target && target.ws.readyState === WebSocket.OPEN) {
        safeSend(target.ws, { type: "deliver", ...payload, queued: false });
      }

      safeSend(ws, { type: "deliver-ack", msgId: msg.msgId });

      if (kind === "chat" && !pushSentForMsgId.has(msg.msgId)) {
        const mid = msg.msgId;
        setTimeout(() => {
          const box = mailbox.get(msg.to);
          if (!box || !box.has(mid)) return;
          if (pushSentForMsgId.has(mid)) return;
          pushSentForMsgId.set(mid, Date.now());
          const me = clients.get(myId);
          const recipientLang = (pushSubs.get(msg.to) || {}).lang;
          const myName = (me && me.name) || pushText(recipientLang, "newMessage");
          sendPushTo(msg.to, myId, {
            title: myName,
            body: pushText(recipientLang, "newMessage"),
            tag: "ether-msg-" + myId,
            contactId: myId,
            kind: "message",
          }).catch(() => {});
        }, PUSH_AFTER_MS);
      }
      return;
    }

    if (msg.type === "prekey-upload" && myId) {
      if (!wsRateLimitOk(prekeyUploadHits, myId, 20)) return;
      const spk = msg.spk, opks = Array.isArray(msg.opks) ? msg.opks : [];
      if (spk != null && !(spk && validPrekeyId(spk.id) && validPrekeyPub(spk.pub) && (spk.sig == null || (typeof spk.sig === "string" && spk.sig.length <= 200)))) { safeSend(ws, { type: "prekey-stored", error: "invalid" }); return; }
      if (opks.length > PREKEY_MAX_UPLOAD || !opks.every((o) => o && validPrekeyId(o.id) && validPrekeyPub(o.pub))) { safeSend(ws, { type: "prekey-stored", error: "invalid" }); return; }
      let e = prekeys.get(myId);
      if (!e) {
        if (prekeys.size >= PREKEYS_MAX) prekeys.delete(prekeys.keys().next().value); // потолок по числу id: вытесняем самый старый
        e = { spk: null, opks: new Map(), ts: Date.now() }; prekeys.set(myId, e);
      }
      if (spk) e.spk = { id: spk.id, pub: spk.pub, ...(typeof spk.sig === "string" && spk.sig.length <= 200 ? { sig: spk.sig } : {}) };
      for (const o of opks) e.opks.set(o.id, o.pub);
      while (e.opks.size > PREKEY_MAX_OPKS) e.opks.delete(e.opks.keys().next().value);
      e.ts = Date.now();
      safeSend(ws, { type: "prekey-stored", count: e.opks.size });
      return;
    }
    // Список устройств аккаунта (docs/MULTIDEVICE.md): непрозрачный JSON, подписанный основным ключом личности. Сервер подпись не проверяет
    // (публичный ключ — у контактов) и не может подделать; он хранит только версию с большим seq и отдаёт её. Публикует лишь владелец id.
    if (msg.type === "devices-put" && myId && msg.list && typeof msg.list === "object") {
      if (!wsRateLimitOk(deviceListHits, myId, 20)) return;
      const l = msg.list; let ok = l.id === myId && Number.isSafeInteger(l.seq) && l.seq > 0 && typeof l.sig === "string" && l.sig.length <= 200 && Array.isArray(l.certs) && l.certs.length <= 8;
      let raw = ""; try { raw = JSON.stringify(l); } catch (e) { ok = false; }
      if (!ok || raw.length > DEVICE_LIST_MAX_BYTES) { safeSend(ws, { type: "devices-stored", error: "invalid" }); return; }
      const cur = deviceLists.get(myId);
      if (cur && cur.seq >= l.seq) { safeSend(ws, { type: "devices-stored", error: "stale", seq: cur.seq }); return; }
      if (!cur && deviceLists.size >= DEVICE_LISTS_MAX) deviceLists.delete(deviceLists.keys().next().value);
      deviceLists.set(myId, { seq: l.seq, list: l, at: Date.now() });
      scheduleDevicesSave();
      devicesMod.onListChanged(myId, devicesCtx()); // отозванные companion отключаются, их ящики чистятся
      safeSend(ws, { type: "devices-stored", seq: l.seq });
      // Контактам, у кого владелец в watch и кто онлайн, и устройствам самого владельца: список изменился, пора перезапросить (кэш клиента остаётся запасным путём)
      const meRec = clients.get(myId), note = { type: "devices-updated", id: myId, seq: l.seq };
      for (const [oid, other] of clients) {
        if (oid === myId || !other.watch || !other.watch.has(myId) || other.ws.readyState !== WebSocket.OPEN) continue;
        if (meRec && !canSeePresence(other, oid, myId, meRec)) continue;
        safeSend(other.ws, note);
      }
      devicesMod.broadcastOwn(myId, note, devicesCtx());
      return;
    }
    if (msg.type === "devices-get" && myId && typeof msg.to === "string" && msg.to.length <= 128 && typeof msg.rid === "string" && msg.rid.length <= 40) {
      if (!wsRateLimitOk(deviceListHits, myId + "|g", 120)) { safeSend(ws, { type: "devices-list", rid: msg.rid, to: msg.to, list: null }); return; }
      const e = deviceLists.get(msg.to);
      safeSend(ws, { type: "devices-list", rid: msg.rid, to: msg.to, list: e ? e.list : null });
      return;
    }
    if (msg.type === "prekey-fetch" && myId && typeof msg.to === "string" && msg.to.length <= 128 && typeof msg.rid === "string" && msg.rid.length <= 40) {
      if (!wsRateLimitOk(prekeyFetchHits, myId, 60) || !wsRateLimitPairOk(myId, msg.to, 12, prekeyPairHits)) { safeSend(ws, { type: "prekey-bundle", rid: msg.rid, to: msg.to, error: "rate" }); return; }
      const e = prekeys.get(msg.to);
      let opk = null;
      // Сверх лимита на цель отдаём только подписанный prekey, не расходуя одноразовый (иначе их можно выкачать за минуту с нескольких аккаунтов).
      const targetOk = wsRateLimitOk(prekeyTargetHits, msg.to, PREKEY_FETCH_PER_TARGET_PER_MIN);
      if (targetOk && e && e.opks.size) { const k = e.opks.keys().next().value; opk = { id: k, pub: e.opks.get(k) }; e.opks.delete(k); }
      safeSend(ws, { type: "prekey-bundle", rid: msg.rid, to: msg.to, spk: e && e.spk ? e.spk : null, opk });
      // Владельцу — сигнал пополнить запас, если он онлайн
      if (e && opk && e.opks.size < PREKEY_LOW) {
        const owner = clients.get(msg.to);
        if (owner) safeSend(owner.ws, { type: "prekey-low", count: e.opks.size });
      }
      return;
    }

    // Обнаружение: публикация/снятие своего хэша (только id с claim) и поиск по списку хэшей.
    if (msg.type === "discovery-publish" && myId) {
      const reply = (o) => safeSend(ws, Object.assign({ type: "discovery-published" }, o));
      if (!DISCOVERY_ENABLED) return reply({ ok: false, error: "disabled" });
      if (!discWindow(discPubHits, myId, 3600_000, 1, DISCOVERY_PUBLISH_PER_HOUR)) return reply({ ok: false, error: "rate" });
      const me = clients.get(myId); if (!me) return;
      const hashes = Array.isArray(msg.hashes) ? Array.from(new Set(msg.hashes.filter((h) => typeof h === "string" && HASH_RE.test(h)))).slice(0, DISCOVERY_MAX_PER_ID) : [];
      if (!hashes.length) { discoveryDropId(myId); return reply({ ok: true, count: 0 }); } // снятие
      if (!claims.has(myId)) return reply({ ok: false, error: "no-claim" });
      if (!me.publicKey) return reply({ ok: false, error: "no-key" });
      const fresh = hashes.filter((h) => !discovery.has(h) || discovery.get(h).id !== myId).length;
      if (discovery.size + fresh > DISCOVERY_MAX) { discoveryExpire(); if (discovery.size + fresh > DISCOVERY_MAX) return reply({ ok: false, error: "full" }); }
      const name = msg.shareName === true ? String(msg.name || me.name || "").slice(0, 60) : "";
      discoveryDropId(myId);
      const now = Date.now();
      for (const h of hashes) {
        const prev = discovery.get(h); // хэш уже занят другим id (напр. номер перешёл к другому человеку) — перезаписывает последний подтвердивший
        discoverySet(h, { id: myId, pk: me.publicKey, name, seen: now });
        if (prev && prev.id !== myId) { const s = discoveryById.get(prev.id); if (s) s.delete(h); }
      }
      scheduleDiscoverySave();
      return reply({ ok: true, count: hashes.length, ttlDays: Math.round(DISCOVERY_TTL_MS / 86400000) });
    }
    if (msg.type === "discovery-lookup" && myId && typeof msg.rid === "string" && msg.rid.length <= 40) {
      const t0 = Date.now();
      const rid = msg.rid;
      const done = (o) => { const wait = Math.max(0, DISCOVERY_MIN_MS - (Date.now() - t0)); setTimeout(() => safeSend(ws, Object.assign({ type: "discovery-result", rid }, o)), wait); };
      if (!DISCOVERY_ENABLED) return done({ found: [], error: "disabled" });
      const hashes = Array.isArray(msg.hashes) ? Array.from(new Set(msg.hashes.filter((h) => typeof h === "string" && HASH_RE.test(h)))) : [];
      if (!hashes.length || hashes.length > DISCOVERY_BATCH) return done({ found: [], error: "bad-request" });
      if (!discWindow(discIpHits, ipAddr, 3600_000, 1, DISCOVERY_REQ_PER_HOUR) || !discWindow(discIdHits, myId, 3600_000, 1, DISCOVERY_REQ_PER_HOUR)
        || !discWindow(discDayHits, myId, 86400_000, hashes.length, DISCOVERY_HASHES_PER_DAY)) return done({ found: [], error: "rate" });
      const now = Date.now(), found = [];
      for (const h of hashes) {
        const r = discovery.get(h);
        if (!r || r.id === myId || now - r.seen > DISCOVERY_TTL_MS || !r.pk) continue;
        const o = { hash: h, id: r.id, publicKey: r.pk };
        if (r.name) o.name = r.name;
        found.push(o);
      }
      return done({ found });
    }

    if (msg.type === "mailbox-ack" && myId && typeof msg.msgId === "string") {
      { const e0 = mailbox.get(myId) && mailbox.get(myId).get(msg.msgId); if (e0) rememberAcked(deliverDupKey(myId, e0.from, msg.msgId, e0.envelope)); }
      if (mailboxRemove(myId, msg.msgId)) scheduleMailboxSave();
      return;
    }
  };

  ws.on("close", () => {
    clearTimeout(regTimer);
    devicesMod.onClose(ws);
    const left = (ipConnCount.get(ipAddr) || 1) - 1;
    if (left <= 0) ipConnCount.delete(ipAddr); else ipConnCount.set(ipAddr, left);
    if (myId && clients.get(myId) && clients.get(myId).ws === ws) {
      const goneRec = clients.get(myId);
      const wasVisible = goneRec.visible;
      clients.delete(myId);
      touchClaim(myId);
      broadcastPresence(myId, false, { wasVisible, rec: goneRec });
      console.log("[reg] " + shortId(myId) + " disconnected, clients=" + clients.size);
    }
  });

  ws.on("error", () => {});
});

setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    // Если от клиента не приходил application-level ping больше 60
    // секунд (клиент обязан слать каждые 15с) — считаем его мёртвым,
    // не дожидаясь protocol-level таймаута. Логируем, чтобы в логах
    // было видно disconnected даже при закрытом iOS-приложении.
    if (ws.lastClientPing && now - ws.lastClientPing > 60000) {
      console.log("[reg] " + shortId(ws._etherId) + " no app-ping for 60s, terminate");
      ws.terminate();
      continue;
    }
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [uid, box] of Array.from(mailbox)) {
    // Файлы (в отличие от текста) весят много больше — не даём им копиться дольше разумного окна ожидания.
    for (const [msgId, entry] of Array.from(box)) {
      if (mailboxEntryExpired(entry, now)) { mailboxRemove(uid, msgId); scheduleMailboxSave(); }
    }
    const cur = mailbox.get(uid);
    if (cur && cur.size === 0) mailbox.delete(uid);
  }
  for (const m of [callPushRecipientAt, callPushPairAt]) for (const [k, v] of m) if (now - (typeof v === "number" ? v : v.ts) > CALL_PUSH_PAIR_MS) m.delete(k);
}, 60000);

setInterval(() => {
  const now = Date.now();
  for (const [msgId, ts] of pushSentForMsgId) {
    if (now - ts > PUSH_DEDUP_TTL_MS) pushSentForMsgId.delete(msgId);
  }
}, 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [x, ts] of callInvitePushSent) {
    if (now - ts > CALL_INVITE_PUSH_DEDUP_TTL_MS) callInvitePushSent.delete(x);
  }
}, 60 * 1000);

setInterval(() => {
  // Запись вида { lastAt, count: 0, timer: null } создаётся при
  // немедленной (не отложенной) отправке и остаётся в pushThrottle
  // НАВСЕГДА, если от этого отправителя этому получателю больше не
  // придёт сообщений (только тогда сработал бы clearThrottleForRecipient
  // на реконнекте) — у записей БЕЗ активного timer нет своего
  // встроенного момента очистки. При долгоживущем процессе и множестве
  // разных пар отправитель/получатель карта будет медленно расти.
  const now = Date.now();
  for (const [key, entry] of pushThrottle) {
    if (!entry.timer && now - entry.lastAt > PUSH_THROTTLE_MS * 10) pushThrottle.delete(key);
  }
}, 5 * 60 * 1000);

setInterval(() => {
  // Подключённый владелец «появляется» постоянно: продлеваем его claim (иначе непрерывно онлайн >TTL claim бы истёк), и чистим протухшие.
  const now = Date.now();
  for (const id of clients.keys()) { const r = claims.get(id); if (r) r.seen = now; }
  if (pruneClaims(now) || clients.size) scheduleClaimsSave();
  if (DISCOVERY_ENABLED) { for (const id of clients.keys()) discoveryTouch(id); discoveryExpire(); scheduleDiscoverySave(); }
}, 3600 * 1000).unref();

function shutdown() {
  console.log("Завершаем работу…");
  try { saveClaims(); } catch (e) {}
  try { if (DISCOVERY_ENABLED) saveDiscovery(); } catch (e) {}
  try { savePushSubs(); } catch (e) {}
  try { saveDeviceLists(); } catch (e) {}
  try { saveMailbox(); } catch (e) {}
  for (const ws of wss.clients) { try { ws.close(1001, "server shutdown"); } catch (e) {} }
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

httpServer.listen(PORT, () => {
  console.log(`Сигнальный релей "Эфир" слушает порт ${PORT}`);
  if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) console.log("[ice] заданы CF_TURN_* — используется Cloudflare TURN");
  { const n = extraTurnServers().length; if (process.env.TURN_EXTRA_JSON) console.log("[ice] TURN_EXTRA_JSON: серверов с логином — " + n); }
  if (staticTurnServers()) {
    console.log(TURN_STATIC_SECRET ? "[ice] задан TURN_STATIC_SECRET — временные креды TURN REST API" : "[ice] заданы TURN_STATIC_* — используется статический TURN (устаревший способ; лучше TURN_STATIC_SECRET)");
  } else {
    console.log("[ice] TURN_STATIC_* не заданы — /ice будет отдавать только публичные STUN (не пройдёт двойной/симметричный NAT)");
  }
});