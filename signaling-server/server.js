const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 8787;
const MAX_MAILBOX_PER_USER = 500;
const MAX_PAYLOAD = 128 * 1024;

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD });

const clients = new Map();
const mailbox = new Map();

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

wss.on("connection", (ws) => {
  let myId = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;

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
      const online = Array.from(clients.keys()).filter((i) => i !== myId).map((i) => rosterEntry(i)).filter(Boolean);
      safeSend(ws, { type: "registered", id: myId, online });
      flushMailbox(myId, ws);
      broadcastPresence(myId, true);
      return;
    }

    if (msg.type === "signal" && myId && typeof msg.to === "string") {
      const target = clients.get(msg.to);
      if (target) safeSend(target.ws, { type: "signal", from: myId, data: msg.data });
      else safeSend(ws, { type: "unreachable", to: msg.to });
      return;
    }

    if (msg.type === "deliver" && myId && typeof msg.to === "string" && typeof msg.msgId === "string") {
      if (!isValidEnvelope(msg.envelope)) {
        safeSend(ws, { type: "deliver-ack", msgId: msg.msgId, error: "invalid-envelope" });
        return;
      }
      const target = clients.get(msg.to);
      const payload = { from: myId, msgId: msg.msgId, envelope: msg.envelope, fromPublicKey: msg.fromPublicKey || null };
      if (target) safeSend(target.ws, { type: "deliver", ...payload, queued: false });
      else {
        if (!mailbox.has(msg.to)) mailbox.set(msg.to, new Map());
        mailbox.get(msg.to).set(msg.msgId, { ...payload, ts: Date.now() });
      }
      safeSend(ws, { type: "deliver-ack", msgId: msg.msgId });
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

function shutdown() {
  console.log("Завершаем работу…");
  for (const ws of wss.clients) { try { ws.close(1001, "server shutdown"); } catch (e) {} }
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`Сигнальный релей "Эфир" слушает порт ${PORT}`);