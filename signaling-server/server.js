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
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

let webpush = null;
try { webpush = require("web-push"); }
catch (e) { console.warn("[push] пакет web-push не установлен — push отключён"); }

const PORT = process.env.PORT || 8787;
const MAX_MAILBOX_PER_USER = 500;
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
function staticTurnServers() {
  if (!TURN_STATIC_URL || !TURN_STATIC_USERNAME || !TURN_STATIC_PASSWORD) return null;
  return [
    { urls: TURN_STATIC_URL, username: TURN_STATIC_USERNAME, credential: TURN_STATIC_PASSWORD },
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
    for (const k of map.keys()) {
      if (removed >= toRemove) break;
      map.delete(k);
      removed++;
    }
  }
}

let iceCache = { at: 0, servers: null };
const iceHits = new Map(); // ip -> { start, n }

function rateLimitOk(ip) {
  const now = Date.now();
  const w = iceHits.get(ip) || { start: now, n: 0 };
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
  const w = registerHits.get(ip) || { start: now, n: 0 };
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
const signalHits = new Map();
const deliverHits = new Map();

function wsRateLimitOk(map, key, limitPerMin) {
  const now = Date.now();
  const w = map.get(key) || { start: now, n: 0 };
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
function wsRateLimitPairOk(senderId, recipientId, limitPerMin) {
  const key = String(senderId) + "→" + String(recipientId);
  const now = Date.now();
  const w = deliverHits.get(key) || { start: now, n: 0 };
  if (now - w.start > 60_000) { w.start = now; w.n = 0; }
  w.n++;
  deliverHits.set(key, w);
  if (deliverHits.size > 5000) pruneRateLimitMap(deliverHits);
  return w.n <= limitPerMin;
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
    const m = String(url || "").match(/^turns?:([^:?]+):(\d+)/);
    if (!m) return resolve(false);
    const host = m[1];
    const port = parseInt(m[2], 10);
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
  if (servers) {
    // Дополнительная проверка: если TURN недоступен, отдавать его
    // клиенту НЕЛЬЗЯ — ICE на клиенте будет ждать таймаута TURN
    // allocate, блокируя весь звонок, хотя STUN-путь работал бы.
    const turnUrl = TURN_STATIC_URL;
    const alive = await isTurnAlive(turnUrl);
    if (alive) {
      console.log("[ice] используются статические TURN-креденшлы (TURN_STATIC_*)");
    } else {
      console.warn("[ice] TURN " + turnUrl + " недоступен — отдаю только STUN");
      servers = null;
    }
  }
  if (!servers) servers = FALLBACK_ICE.slice();
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
const LINK_PREVIEW_RATE_LIMIT_PER_MIN = 30;
const linkPreviewCache = new Map(); // url -> { at, data }
const linkPreviewHits = new Map();

function linkPreviewRateLimitOk(ip) {
  const now = Date.now();
  const w = linkPreviewHits.get(ip) || { start: now, n: 0 };
  if (now - w.start > 60_000) { w.start = now; w.n = 0; }
  w.n++;
  linkPreviewHits.set(ip, w);
  if (linkPreviewHits.size > 5000) pruneRateLimitMap(linkPreviewHits);
  return w.n <= LINK_PREVIEW_RATE_LIMIT_PER_MIN;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // не распознали — на всякий случай считаем небезопасным
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

async function fetchUrlSafe(targetUrl, redirectsLeft) {
  const u = new URL(targetUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme not allowed");
  // TOCTOU/DNS rebinding: резолвим и проверяем IP здесь, а затем ЯВНО
  // передаём именно ЭТОТ IP в http.get через lookup — если этого не
  // сделать, http.get() резолвит хост ЗАНОВО сам, своим собственным
  // вызовом DNS, и между двумя резолвами атакующий с коротким TTL на
  // своём DNS-сервере может успеть подменить публичный IP на приватный
  // (127.0.0.1 и т.п.), обходя проверку выше полностью.
  const safe = await resolveHostSafe(u.hostname);
  const customLookup = (hostname, options, callback) => {
  // Node вызывает lookup в двух формах: с options.all=true ожидается
  // массив [{address, family}], без него — пара (address, family).
  // http.get в актуальных версиях Node идёт по пути с all:true — раньше
  // мы всегда отдавали строку, и внутренний код получал
  // [0].address === undefined → "Invalid IP address: undefined".
  if (options && options.all) {
    callback(null, [{ address: safe.address, family: safe.family }]);
  } else {
    callback(null, safe.address, safe.family);
  }
};

  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(u, {
      lookup: customLookup,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "max-age=0",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "sec-ch-ua": "\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"Windows\"",
    },
      timeout: LINK_PREVIEW_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        fetchUrlSafe(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error("HTTP " + res.statusCode)); return; }
      const ctype = String(res.headers["content-type"] || "");
      if (ctype && !ctype.includes("html")) { res.resume(); reject(new Error("not html")); return; }

      // Сжимаем ответ, если сервер его отдал в gzip/deflate/br. Без
      // этого мы качаем несжатый HTML — github.com и ya.ru легко
      // переваливают за LINK_PREVIEW_MAX_BYTES и падают с "too large".
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

      let total = 0;
      const chunks = [];
      let settled = false;
      let headTail = "";
      stream.on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > LINK_PREVIEW_MAX_BYTES) { settled = true; req.destroy(); reject(new Error("too large")); return; }
        chunks.push(chunk);
        // Раньше здесь на КАЖДОМ чанке делался Buffer.concat(все_чанки)
        // + toString + toLowerCase — то есть для HTML в 500 КБ из 50
        // чанков это ~12 МБ перекодирования UTF-8 на один запрос.
        // На бесплатном Render (0.1 CPU) это 1-2 секунды на каждое
        // превью. Ищем </head> только в хвосте предыдущего текста
        // (16 символов — с запасом, чтобы поймать </head> на границе
        // чанков) плюс текущий чанк. Подстрока не может "спрятаться"
        // в уже проверенной части, так что корректность та же.
        const chunkText = chunk.toString("utf8").toLowerCase();
        const search = headTail + chunkText;
        if (search.includes("</head>")) {
          settled = true;
          req.destroy();
          resolve(Buffer.concat(chunks).toString("utf8"));
          return;
        }
        headTail = search.slice(-16);
      });
      stream.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
      stream.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => { if (!req.destroyed) reject(e); });
  });
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    // Числовые HTML-сущности: &#8212; (десятичные) и &#x2014;
    // (шестнадцатеричные). Без них некоторые сайты (BBC, Reuters)
    // отдают сырые числовые ссылки в og:title / og:description, и в
    // превью ссылок видно литеральное "&#8212;" вместо "—".
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(parseInt(code, 10)); } catch (e) { return "&#" + code + ";"; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      try { return String.fromCodePoint(parseInt(code, 16)); } catch (e) { return "&#x" + code + ";"; }
    });
}

function extractMeta(html, targetUrl) {
  const metaTag = (attrPattern) => {
    const re = new RegExp(`<meta[^>]+${attrPattern}[^>]+content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attrPattern}`, "i");
    const m = html.match(re) || html.match(re2);
    return m ? decodeHtmlEntities(m[1]).trim() : "";
  };
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const ogTitle = metaTag('property=["\']og:title["\']');
  const ogDesc = metaTag('property=["\']og:description["\']');
  const ogImage = metaTag('property=["\']og:image["\']');
  const ogSite = metaTag('property=["\']og:site_name["\']');
  const plainDesc = metaTag('name=["\']description["\']');

  const title = ogTitle || (titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : "") || "";
  const description = ogDesc || plainDesc || "";
  let image = ogImage || "";
  if (image) {
    try { image = new URL(image, targetUrl).toString(); } catch (e) { image = ""; }
    if (!/^https?:\/\//i.test(image)) image = "";
  }
  let siteName = ogSite || "";
  if (!siteName) { try { siteName = new URL(targetUrl).hostname.replace(/^www\./, ""); } catch (e) {} }

  if (!title && !description && !image) return null;
  return {
    url: targetUrl,
    title: title.slice(0, 200),
    description: description.slice(0, 300),
    image: image.slice(0, 2000),
    siteName: siteName.slice(0, 100),
  };
}

// Отдельный, более короткий TTL для НЕГАТИВНЫХ результатов (data === null:
// сайт отдал 401/403/439, не ответил, отдал не-HTML). Раз в час долбить
// rbc.ru/avito за одним и тем же отказом бессмысленно; через 15 минут
// есть шанс, что сайт был временно недоступен и теперь отдаст превью.
// До этой правки ошибка fetchUrlSafe ПРОБРАСЫВАЛАСЬ наверх и НЕ попадала
// в кеш — каждый вход в чат с той же ссылкой снова дёргал сайт.
const LINK_PREVIEW_NEGATIVE_CACHE_MS = 15 * 60 * 1000;

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url || "";
  if (req.method === "GET" && (url === "/ice" || url.startsWith("/ice?"))) {
    const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim()
      || req.socket.remoteAddress || "unknown";
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
    const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim()
      || req.socket.remoteAddress || "unknown";
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
        console.log("[link-preview] пусто (без исключения) для " + new URL(target).hostname);
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

  if (req.method === "GET" && (url === "/" || url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Ether signaling relay OK\n");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// ---------- Web Push ----------
const PUSH_SUBS_FILE = path.join(__dirname, ".ether-push-subs.json");

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
        pushSubs.set(entry[0], v && v.subscription ? v : { subscription: v, lang: "en" });
      }
    }
    console.log("[push] восстановлено подписок:", pushSubs.size);
  } catch (e) {
    console.warn("[push] не удалось прочитать файл подписок:", e.message);
  }
}
function savePushSubs() {
  try {
    fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(Array.from(pushSubs.entries())));
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
function pushText(lang, key, params) {
  const base = (lang || "en").toLowerCase().split(/[-_]/)[0];
  const table = PUSH_TEXT[base] || PUSH_TEXT.en;
  const val = table[key] !== undefined ? table[key] : PUSH_TEXT.en[key];
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

// ---------- Утилиты ----------
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}
function rosterEntry(id) {
  const c = clients.get(id);
  return c ? { id, name: c.name || "", visible: c.visible !== false, publicKey: c.publicKey || null } : null;
}
function broadcastPresence(id, online, extra = {}) {
  const entry = online ? rosterEntry(id) : { id, name: "", visible: true, publicKey: null };
  for (const [otherId, c] of clients) {
    if (otherId === id) continue;
    safeSend(c.ws, { type: "presence", id, online, ...entry, ...extra });
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
  return env && typeof env.iv === "string" && typeof env.ct === "string"
    && env.iv.length < 200 && env.ct.length < 3.5 * 1024 * 1024;
}
function shortId(s) { return String(s || "").slice(0, 10) + "…"; }

// ---------- Соединения ----------
wss.on("connection", (ws, req) => {
  let myId = null;
  const clientIp = (req && req.headers && req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim()
    || (req && req.socket && req.socket.remoteAddress) || "unknown";
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
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

    if (msg.type === "register" && typeof msg.id === "string" && msg.id && msg.id.length <= 128) {
      if (!registerRateLimitOk(clientIp)) {
        safeSend(ws, { type: "register-rate-limited" });
        return;
      }
      if (clients.has(msg.id) && clients.get(msg.id).ws !== ws) {
        try {
          safeSend(clients.get(msg.id).ws, { type: "replaced" });
          clients.get(msg.id).ws.close();
        } catch (e) {}
        broadcastPresence(msg.id, false);
      }
      myId = msg.id;
      ws._etherId = myId;
      ws.lastClientPing = Date.now();
      clients.set(myId, {
        ws,
        name: String(msg.name || "").slice(0, 60),
        visible: msg.visible !== false,
        publicKey: msg.publicKey || null,
      });
      console.log("[reg] " + shortId(myId) + " visible=" + (msg.visible !== false) + " clients=" + clients.size);
      const online = Array.from(clients.keys())
        .filter((i) => i !== myId)
        .map((i) => rosterEntry(i))
        .filter(Boolean);
      safeSend(ws, { type: "registered", id: myId, online });
      if (PUSH_ENABLED) safeSend(ws, { type: "vapid-key", key: VAPID_PUBLIC });
      clearThrottleForRecipient(myId);
      flushMailbox(myId, ws);
      broadcastPresence(myId, true);
      return;
    }

    if (msg.type === "push-subscribe" && myId && msg.subscription) {
      if (!wsRateLimitOk(pushSubHits, myId, 10)) return;
      try {
        pushSubs.set(myId, { subscription: msg.subscription, lang: typeof msg.lang === "string" ? msg.lang : "en" });
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
      if (target) {
        safeSend(target.ws, payload);
        console.log("[sig] " + shortId(myId) + " → " + shortId(msg.to) + " t=" + (msg.data && msg.data.t));
      } else {
        safeSend(ws, { type: "unreachable", to: msg.to });
        console.log("[sig] " + shortId(myId) + " → UNREACHABLE " + shortId(msg.to) + " t=" + (msg.data && msg.data.t));
      }
      if (msg.data && msg.data.t === "call-invite") {
        // Дедупликация по packet.x — если это повторная отправка ТОГО ЖЕ
        // самого приглашения (например, ретрай после переподключения
        // клиента), получатель уже получил push на эту попытку звонка.
        // На клиенте isDuplicateSignal защищает от повторной обработки
        // сигнала, но push к тому моменту уже был бы отправлен повторно.
        const inviteNonce = msg.data.x;
        if (inviteNonce && callInvitePushSent.has(inviteNonce)) return;
        if (inviteNonce) callInvitePushSent.set(inviteNonce, Date.now());
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
      if (msg.to === myId) return;
      if (!wsRateLimitPairOk(myId, msg.to, DELIVER_RATE_LIMIT_PER_MIN)) return;
      if (!isValidEnvelope(msg.envelope)) {
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
      const kind = typeof msg.kind === "string" ? msg.kind : "chat";
      const target = clients.get(msg.to);
      console.log("[deliver] " + shortId(myId) + " → " + shortId(msg.to) + " msgId=" + String(msg.msgId).slice(0, 8) + "… kind=" + kind + " online=" + !!target);
      const payload = {
        from: myId,
        msgId: msg.msgId,
        envelope: msg.envelope,
        fromPublicKey: msg.fromPublicKey || null,
        kind,
      };

      if (!mailbox.has(msg.to)) mailbox.set(msg.to, new Map());
      mailbox.get(msg.to).set(msg.msgId, { ...payload, ts: Date.now() });

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

    if (msg.type === "mailbox-ack" && myId && typeof msg.msgId === "string") {
      const box = mailbox.get(myId);
      if (box) box.delete(msg.msgId);
      return;
    }
  });

  ws.on("close", () => {
    if (myId && clients.get(myId) && clients.get(myId).ws === ws) {
      clients.delete(myId);
      broadcastPresence(myId, false);
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
  for (const box of mailbox.values()) {
    // Файлы (в отличие от текста) весят много больше — не даём им
    // копиться дольше разумного окна ожидания, даже если общий счётчик
    // per-user ещё не выбран целиком.
    for (const [msgId, entry] of box) {
      if (entry.kind && entry.kind !== "chat" && now - entry.ts > MAILBOX_FILE_TTL_MS) box.delete(msgId);
    }
    if (box.size <= MAX_MAILBOX_PER_USER) continue;
    const entries = Array.from(box.entries()).sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < entries.length - MAX_MAILBOX_PER_USER; i++) box.delete(entries[i][0]);
  }
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

function shutdown() {
  console.log("Завершаем работу…");
  try { savePushSubs(); } catch (e) {}
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
  if (staticTurnServers()) {
    console.log("[ice] заданы TURN_STATIC_* — используется статический TURN");
  } else {
    console.log("[ice] TURN_STATIC_* не заданы — /ice будет отдавать только публичные STUN (не пройдёт двойной/симметричный NAT)");
  }
});