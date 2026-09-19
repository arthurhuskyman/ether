// Сигнальный сервер Эфир с поддержкой Web Push.
//
// Задачи:
//   (1) рандеву — двум устройствам сообщить, что они онлайн, и один раз
//       переслать offer/answer;
//   (2) почтовый ящик — придержать зашифрованное сообщение до появления
//       адресата;
//   (3) Web Push — послать системное уведомление через Apple Push Service,
//       когда приложение адресата закрыто.
//
// Push работает только если заданы переменные окружения VAPID_PUBLIC и
// VAPID_PRIVATE (см. README). Без них сервер работает как обычный релей.
//
// ВАЖНО: конверт зашифрован end-to-end, сервер не видит содержимого.
// Но для маршрутизации и решений о push он получает открытое поле `kind`
// ("chat" | "ack-batch" | "edit" | "delete" | "reaction" | "typing").
// Push отправляется ТОЛЬКО для kind === "chat".

const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

let webpush = null;
try { webpush = require("web-push"); }
catch (e) { console.warn("[push] пакет web-push не установлен — push отключён"); }

const PORT = process.env.PORT || 8787;
const MAX_MAILBOX_PER_USER = 500;
const MAX_PAYLOAD = 128 * 1024;

// Throttling push: минимальный интервал между уведомлениями одному
// получателю от одного отправителя.
const PUSH_THROTTLE_MS = 30 * 1000;

// Дедупликация push по msgId — TTL 10 минут.
const PUSH_DEDUP_TTL_MS = 10 * 60 * 1000;
const pushSentForMsgId = new Map(); // msgId -> ts

const PUSH_SUBS_FILE = path.join("/tmp", "ether-push-subs.json");

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

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD });

const clients = new Map();     // id -> { ws, name, visible, publicKey }
const mailbox = new Map();     // id -> Map(msgId -> { from, envelope, fromPublicKey, kind, ts })
const pushSubs = new Map();    // id -> PushSubscription JSON

// pushThrottle: ключ `recipientId:senderId` -> { lastAt, count, timer }
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

// ---------- Отправка с throttling ----------
async function sendPushTo(recipientId, senderId, payload, opts = {}) {
  if (!PUSH_ENABLED) return;
  const sub = pushSubs.get(recipientId);
  if (!sub) return;

  // Звонки — приоритетные, без throttling.
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

      // Если получатель уже подключён — все сообщения у него в приложении,
      // отдельный агрегат не нужен. Это устраняет случай «пришло после того,
      // как прочитал».
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

// При подключении получателя — сбрасываем накопленные для него throttle,
// чтобы не отправить агрегат «N новых» через 30 секунд после того, как он
// уже всё прочитал.
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

// ---------- Соединения ----------
wss.on("connection", (ws) => {
  let myId = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;

    // ---------- Регистрация ----------
    if (msg.type === "register" && typeof msg.id === "string" && msg.id) {
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
      const online = Array.from(clients.keys())
        .filter((i) => i !== myId)
        .map((i) => rosterEntry(i))
        .filter(Boolean);
      safeSend(ws, { type: "registered", id: myId, online });
      if (PUSH_ENABLED) safeSend(ws, { type: "vapid-key", key: VAPID_PUBLIC });
      // Онлайн — сбрасываем накопленные для него агрегаты push.
      clearThrottleForRecipient(myId);
      flushMailbox(myId, ws);
      broadcastPresence(myId, true);
      return;
    }

    // ---------- Подписка на push ----------
    if (msg.type === "push-subscribe" && myId && msg.subscription) {
      try {
        pushSubs.set(myId, msg.subscription);
        savePushSubs();
        safeSend(ws, { type: "push-subscribed" });
        console.log("[push] подписка сохранена для", myId.slice(0, 10) + "…");
      } catch (e) {}
      return;
    }
    if (msg.type === "push-unsubscribe" && myId) {
      pushSubs.delete(myId);
      savePushSubs();
      safeSend(ws, { type: "push-unsubscribed" });
      return;
    }

    // ---------- Пересылка сигналов ----------
    if (msg.type === "signal" && myId && typeof msg.to === "string") {
      const target = clients.get(msg.to);
      const payload = { type: "signal", from: myId, data: msg.data };
      if (target) safeSend(target.ws, payload);
      else safeSend(ws, { type: "unreachable", to: msg.to });

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
      const payload = {
        from: myId,
        msgId: msg.msgId,
        envelope: msg.envelope,
        fromPublicKey: msg.fromPublicKey || null,
        kind,
      };

      if (target) {
        // Получатель онлайн — переслали, push не нужен.
        safeSend(target.ws, { type: "deliver", ...payload, queued: false });
      } else {
        // Получатель офлайн — кладём в ящик.
        if (!mailbox.has(msg.to)) mailbox.set(msg.to, new Map());
        mailbox.get(msg.to).set(msg.msgId, { ...payload, ts: Date.now() });

        // Push — только для реальных chat-сообщений, и только один раз
        // на msgId. Служебные (ack-batch, edit, delete, reaction, typing)
        // push не вызывают.
        if (kind === "chat" && !pushSentForMsgId.has(msg.msgId)) {
          pushSentForMsgId.set(msg.msgId, Date.now());
          const me = clients.get(myId);
          const myName = (me && me.name) || "Новое сообщение";
          sendPushTo(msg.to, myId, {
            title: myName,
            body: "Новое сообщение",
            tag: "ether-msg-" + myId,
            contactId: myId,
            kind: "message",
          }).catch(() => {});
        }
      }

      safeSend(ws, { type: "deliver-ack", msgId: msg.msgId });
      return;
    }

    // ---------- Подтверждение приёма из ящика ----------
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
    }
  });

  ws.on("error", () => {});
});

// ---------- Heartbeat ----------
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ---------- Ограничение размеров ящика ----------
setInterval(() => {
  for (const box of mailbox.values()) {
    if (box.size <= MAX_MAILBOX_PER_USER) continue;
    const entries = Array.from(box.entries()).sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < entries.length - MAX_MAILBOX_PER_USER; i++) box.delete(entries[i][0]);
  }
}, 60000);

// ---------- Очистка дедуп-таблицы ----------
setInterval(() => {
  const now = Date.now();
  for (const [msgId, ts] of pushSentForMsgId) {
    if (now - ts > PUSH_DEDUP_TTL_MS) pushSentForMsgId.delete(msgId);
  }
}, 60 * 1000);

// ---------- Graceful shutdown ----------
function shutdown() {
  console.log("Завершаем работу…");
  try { savePushSubs(); } catch (e) {}
  for (const ws of wss.clients) { try { ws.close(1001, "server shutdown"); } catch (e) {} }
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`Сигнальный релей "Эфир" слушает порт ${PORT}`);