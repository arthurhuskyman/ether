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
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

let webpush = null;
try { webpush = require("web-push"); }
catch (e) { console.warn("[push] пакет web-push не установлен — push отключён"); }

const PORT = process.env.PORT || 8787;
const MAX_MAILBOX_PER_USER = 500;
const MAX_PAYLOAD = 128 * 1024;

const PUSH_THROTTLE_MS = 30 * 1000;
const PUSH_DEDUP_TTL_MS = 10 * 60 * 1000;
const PUSH_AFTER_MS = 5000;
const pushSentForMsgId = new Map();

// ---------- Metered (TURN) ----------
const METERED_API_KEY = process.env.METERED_API_KEY || "";
const METERED_API_BASE = "https://arthurhusky.metered.live/api/v1/turn/credentials";
const ICE_CACHE_MS = 5 * 60 * 1000;
const ICE_RATE_LIMIT_PER_MIN = 20;

const FALLBACK_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

let iceCache = { at: 0, servers: null };
const iceHits = new Map(); // ip -> { start, n }

function rateLimitOk(ip) {
  const now = Date.now();
  const w = iceHits.get(ip) || { start: now, n: 0 };
  if (now - w.start > 60_000) { w.start = now; w.n = 0; }
  w.n++;
  iceHits.set(ip, w);
  if (iceHits.size > 5000) {
    // грубая очистка, чтобы map не разрастался
    for (const [k, v] of iceHits) if (now - v.start > 120_000) iceHits.delete(k);
  }
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
  if (registerHits.size > 5000) {
    for (const [k, v] of registerHits) if (now - v.start > 120_000) registerHits.delete(k);
  }
  return w.n <= REGISTER_RATE_LIMIT_PER_MIN;
}

async function fetchMeteredIce() {
  if (!METERED_API_KEY) return null;
  const url = METERED_API_BASE + "?apiKey=" + encodeURIComponent(METERED_API_KEY);
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("metered HTTP " + r.status);
  const list = await r.json();
  if (!Array.isArray(list) || list.length === 0) return null;

  // ИСПРАВЛЕНО: раньше запись `stun:...` (у неё нет `transport=tcp`)
  // ошибочно классифицировалась как TURN UDP и блокировала настоящий
  // TURN UDP-сервер, который в списке Metered идёт следом. Теперь
  // классифицируем строго по префиксу URL и берём по одной записи
  // каждого типа:
  //   1. STUN     — для srflx-кандидатов (прямое P2P без relay)
  //   2. TURN UDP — самый быстрый путь через релей, когда UDP разрешён
  //   3. TURN TCP — запасной путь для сетей, где UDP закрыт
  const byKind = { stun: null, "turn-udp": null, "turn-tcp": null };
  for (const s of list) {
    const u = (s.urls || "").toString();
    if (!u) continue;
    let kind = null;
    if (u.startsWith("stuns:") || u.startsWith("stun:")) kind = "stun";
    else if (u.includes("transport=tcp")) kind = "turn-tcp";
    else if (u.startsWith("turns:") || u.startsWith("turn:")) kind = "turn-udp";
    if (!kind || byKind[kind]) continue;
    byKind[kind] = s;
  }

  const filtered = [];
  if (byKind.stun) filtered.push(byKind.stun);
  if (byKind["turn-udp"]) filtered.push(byKind["turn-udp"]);
  if (byKind["turn-tcp"]) filtered.push(byKind["turn-tcp"]);

  return filtered.length ? filtered : null;
}

async function getIceServers() {
  const now = Date.now();
  if (iceCache.servers && now - iceCache.at < ICE_CACHE_MS) return iceCache.servers;
  let servers = null;
  try {
    servers = await fetchMeteredIce();
    if (servers) console.log("[ice] Metered отдал", servers.length, "серверов");
  } catch (e) {
    console.warn("[ice] Metered недоступен:", e.message);
  }
  if (!servers) servers = FALLBACK_ICE.slice();
  iceCache = { at: now, servers };
  return servers;
}

// ---------- HTTP-сервер (для /ice и как база для WS) ----------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
if (ALLOWED_ORIGIN === "*") {
  console.warn("[ice] ALLOWED_ORIGIN не задан — /ice отдаёт TURN-credentials любому источнику. " +
    "Перед публичным релизом задайте ALLOWED_ORIGIN=https://ваш-домен в переменных окружения.");
}
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
        pushSubs.set(entry[0], entry[1]);
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
loadPushSubs();

// ---------- Базовая отправка push ----------
async function actuallySendPush(sub, payload) {
  if (!PUSH_ENABLED) return false;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      TTL: 3600,
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
  const sub = pushSubs.get(recipientId);
  if (!sub) return;

  if (opts.force || payload.kind === "call") {
    const res = await actuallySendPush(sub, payload);
    if (res === "gone") { pushSubs.delete(recipientId); savePushSubs(); }
    return;
  }

  const key = `${recipientId}:${senderId}`;
  const now = Date.now();
  const entry = pushThrottle.get(key);

  if (!entry || now - entry.lastAt >= PUSH_THROTTLE_MS) {
    if (entry && entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    pushThrottle.set(key, { lastAt: now, count: 0, timer: null });
    const res = await actuallySendPush(sub, payload);
    if (res === "gone") { pushSubs.delete(recipientId); savePushSubs(); }
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
      const n = cur.count + 1;
      cur.lastAt = Date.now();
      cur.count = 0;
      const aggregated = { ...payload, body: n > 1 ? `${n} новых сообщений` : payload.body };
      const res = await actuallySendPush(subNow, aggregated);
      if (res === "gone") { pushSubs.delete(recipientId); savePushSubs(); }
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
function isValidEnvelope(env) {
  return env && typeof env.iv === "string" && typeof env.ct === "string"
    && env.iv.length < 200 && env.ct.length < 96 * 1024;
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
      safeSend(ws, { type: "pong", t: msg.t });
      return;
    }

    if (msg.type === "register" && typeof msg.id === "string" && msg.id) {
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
      try {
        pushSubs.set(myId, msg.subscription);
        savePushSubs();
        safeSend(ws, { type: "push-subscribed" });
        console.log("[push] подписка сохранена для", shortId(myId), "всего=" + pushSubs.size);
      } catch (e) {}
      return;
    }
    if (msg.type === "push-unsubscribe" && myId) {
      pushSubs.delete(myId);
      savePushSubs();
      safeSend(ws, { type: "push-unsubscribed" });
      return;
    }

    if (msg.type === "signal" && myId && typeof msg.to === "string") {
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
        const me = clients.get(myId);
        const myName = (me && me.name) || "Звонок";
        sendPushTo(msg.to, myId, {
          title: "📞 " + myName,
          body: "Входящий вызов",
          tag: "ether-call-" + myId,
          contactId: myId,
          kind: "call",
        }, { force: true }).catch(() => {});
      }
      return;
    }

    // ---------- Доставка зашифрованного конверта ----------
    if (msg.type === "deliver" && myId && typeof msg.to === "string" && typeof msg.msgId === "string") {
      if (!isValidEnvelope(msg.envelope)) {
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
          const myName = (me && me.name) || "Новое сообщение";
          sendPushTo(msg.to, myId, {
            title: myName,
            body: "Новое сообщение",
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
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

setInterval(() => {
  for (const box of mailbox.values()) {
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
  console.log(METERED_API_KEY
    ? "[ice] Metered API-ключ задан, /ice будет проксировать запросы"
    : "[ice] METERED_API_KEY не задан — /ice будет отдавать только публичные STUN");
});