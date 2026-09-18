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

const { WebSocketServer, WebSocket } = require("ws");

let webpush = null;
try { webpush = require("web-push"); }
catch (e) { console.warn("[push] пакет web-push не установлен — push отключён"); }

const PORT = process.env.PORT || 8787;
const MAX_MAILBOX_PER_USER = 500;
const MAX_PAYLOAD = 128 * 1024;

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

const clients = new Map();          // id -> { ws, name, visible, publicKey }
const mailbox = new Map();          // id -> Map(msgId -> { from, envelope, fromPublicKey, ts })
const pushSubs = new Map();         // id -> PushSubscription JSON

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
      queued: true,
    });
  }
}

function isValidEnvelope(env) {
  return env && typeof env.iv === "string" && typeof env.ct === "string"
    && env.iv.length < 200 && env.ct.length < 96 * 1024;
}

async function sendPushTo(id, payload) {
  if (!PUSH_ENABLED) return;
  const sub = pushSubs.get(id);
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      TTL: 3600,
      urgency: payload.kind === "call" ? "high" : "normal",
    });
  } catch (e) {
    // 404 / 410 — подписка больше недействительна, чистим
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      pushSubs.delete(id);
    }
  }
}

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
      // Публичный VAPID-ключ — клиент подпишется и пришлёт push-subscribe.
      if (PUSH_ENABLED) safeSend(ws, { type: "vapid-key", key: VAPID_PUBLIC });
      flushMailbox(myId, ws);
      broadcastPresence(myId, true);
      return;
    }

    // ---------- Подписка на push ----------
    if (msg.type === "push-subscribe" && myId && msg.subscription) {
      try {
        pushSubs.set(myId, msg.subscription);
        safeSend(ws, { type: "push-subscribed" });
        console.log("[push] подписка сохранена для", myId.slice(0, 10) + "…");
      } catch (e) {}
      return;
    }
    if (msg.type === "push-unsubscribe" && myId) {
      pushSubs.delete(myId);
      safeSend(ws, { type: "push-unsubscribed" });
      return;
    }

    // ---------- Пересылка сигналов ----------
    if (msg.type === "signal" && myId && typeof msg.to === "string") {
      const target = clients.get(msg.to);
      const payload = { type: "signal", from: myId, data: msg.data };
      if (target) {
        safeSend(target.ws, payload);
      } else {
        safeSend(ws, { type: "unreachable", to: msg.to });
      }
      // Входящий звонок — всегда пушим, даже если адресат «онлайн»,
      // потому что iOS Safari в фоне может не получить WebSocket вовремя.
      if (msg.data && msg.data.t === "call-invite") {
        const me = clients.get(myId);
        const myName = (me && me.name) || "Звонок";
        sendPushTo(msg.to, {
          title: "📞 " + myName,
          body: "Входящий вызов",
          tag: "ether-call-" + myId,
          contactId: myId,
          kind: "call",
        }).catch(() => {});
      }
      return;
    }

    // ---------- Доставка зашифрованного конверта ----------
    if (msg.type === "deliver" && myId && typeof msg.to === "string" && typeof msg.msgId === "string") {
      if (!isValidEnvelope(msg.envelope)) {
        safeSend(ws, { type: "deliver-ack", msgId: msg.msgId, error: "invalid-envelope" });
        return;
      }
      const target = clients.get(msg.to);
      const payload = {
        from: myId,
        msgId: msg.msgId,
        envelope: msg.envelope,
        fromPublicKey: msg.fromPublicKey || null,
      };
      if (target) {
        safeSend(target.ws, { type: "deliver", ...payload, queued: false });
      } else {
        if (!mailbox.has(msg.to)) mailbox.set(msg.to, new Map());
        mailbox.get(msg.to).set(msg.msgId, { ...payload, ts: Date.now() });
        // Адресат офлайн — попробуем отправить ему push.
        const me = clients.get(myId);
        const myName = (me && me.name) || "Новое сообщение";
        sendPushTo(msg.to, {
          title: myName,
          body: "Новое сообщение",
          tag: "ether-msg-" + myId,
          contactId: myId,
          kind: "message",
        }).catch(() => {});
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

// Heartbeat
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// Ограничение размеров ящика
setInterval(() => {
  for (const box of mailbox.values()) {
    if (box.size <= MAX_MAILBOX_PER_USER) continue;
    const entries = Array.from(box.entries()).sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < entries.length - MAX_MAILBOX_PER_USER; i++) box.delete(entries[i][0]);
  }
}, 60000);

function shutdown() {
  console.log("Завершаем работу…");
  for (const ws of wss.clients) { try { ws.close(1001, "server shutdown"); } catch (e) {} }
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`Сигнальный релей "Эфир" слушает порт ${PORT}`);