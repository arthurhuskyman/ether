// Сигнальный сервер "Эфир".
//
// Задачи:
// (1) рандеву — сказать двум устройствам, что они оба сейчас онлайн, и
//     один раз передать между ними пакет подключения WebRTC;
// (2) список "кто сейчас на связи", чтобы контакт можно было добавить
//     в один тап, а не вслепую по номеру;
// (3) почтовый ящик — если адресат сейчас офлайн, ненадолго придержать
//     для него сообщение (уже зашифрованное на устройстве отправителя,
//     сервер видит только шифротекст) и отдать сразу, как только тот
//     подключится.
//
// Всё это — только в памяти процесса, ничего не пишется на диск, при
// перезапуске сервера все очереди и присутствие полностью исчезают
// (сами сообщения при этом не теряются навсегда — они остаются в
// исходном виде на устройстве отправителя, пока получатель их не
// подтвердит; см. комментарий у "deliver" ниже).
//
// Сервер знает участников по непрозрачному id (хэш от номера/почты,
// посчитанный на устройстве), имени, которое устройство само объявляет
// при подключении, и публичному ключу для шифрования очереди. Сам номер
// телефона или email сюда не попадают.

const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8787;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // id -> { ws, name, visible, publicKey }
const mailbox = new Map(); // id получателя -> Map(msgId -> { from, envelope, ts })

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function rosterEntry(id) {
  const c = clients.get(id);
  return c ? { id, name: c.name || "", visible: c.visible !== false, publicKey: c.publicKey || null } : null;
}

function broadcastPresence(id, online) {
  const entry = online ? rosterEntry(id) : { id, name: "", visible: true, publicKey: null };
  for (const [otherId, c] of clients) {
    if (otherId === id) continue;
    safeSend(c.ws, { type: "presence", id, online, name: entry.name, visible: entry.visible, publicKey: entry.publicKey });
  }
}

function flushMailbox(id, ws) {
  const box = mailbox.get(id);
  if (!box || box.size === 0) return;
  for (const [msgId, entry] of box) {
    safeSend(ws, { type: "deliver", from: entry.from, msgId, envelope: entry.envelope, fromPublicKey: entry.fromPublicKey || null, queued: true });
  }
}

wss.on("connection", (ws) => {
  let myId = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    // Клиент представляется id + именем + публичным ключом и получает
    // список тех, кто уже онлайн, плюс всё, что накопилось в его ящике.
    if (msg.type === "register" && typeof msg.id === "string" && msg.id) {
      if (clients.has(msg.id) && clients.get(msg.id).ws !== ws) {
        try {
          safeSend(clients.get(msg.id).ws, { type: "replaced" });
          clients.get(msg.id).ws.close();
        } catch (e) {}
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
        .map((i) => rosterEntry(i));
      safeSend(ws, { type: "registered", id: myId, online });
      flushMailbox(myId, ws);
      broadcastPresence(myId, true);
      return;
    }

    // Пересылка одного пакета сигналинга (offer/answer) конкретному адресату.
    if (msg.type === "signal" && myId && typeof msg.to === "string") {
      const target = clients.get(msg.to);
      if (target) {
        safeSend(target.ws, { type: "signal", from: myId, data: msg.data });
      } else {
        safeSend(ws, { type: "unreachable", to: msg.to });
      }
      return;
    }

    // Доставить непрозрачный конверт (зашифрованное сообщение или квитанцию
    // о получении/прочтении) — сейчас, если адресат на связи, либо
    // придержать в ящике до его следующего подключения. Сервер содержимое
    // envelope не разбирает вообще, только маршрутизирует по id.
    // fromPublicKey передаётся открытым текстом рядом с шифротекстом —
    // публичный ключ не секретен, а получателю он нужен, чтобы расшифровать
    // сообщение, даже если он никогда раньше не видел отправителя онлайн.
    if (msg.type === "deliver" && myId && typeof msg.to === "string" && typeof msg.msgId === "string") {
      const target = clients.get(msg.to);
      const payload = { from: myId, msgId: msg.msgId, envelope: msg.envelope, fromPublicKey: msg.fromPublicKey || null };
      if (target) {
        safeSend(target.ws, { type: "deliver", ...payload, queued: false });
      } else {
        if (!mailbox.has(msg.to)) mailbox.set(msg.to, new Map());
        mailbox.get(msg.to).set(msg.msgId, { ...payload, ts: Date.now() });
      }
      // Отправителю подтверждаем, что мы приняли сообщение на себя — либо
      // сразу передали, либо гарантированно придержим до подключения адресата.
      safeSend(ws, { type: "deliver-ack", msgId: msg.msgId });
      return;
    }

    // Получатель подтвердил, что забрал конверт из ящика — можно удалить,
    // иначе он будет присылаться заново при каждом следующем подключении.
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
});

// Проверка "живости" соединений, чтобы не копить мёртвые сокеты.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// Ограничение по объёму очередей, чтобы нельзя было случайно (или
// умышленно) заспамить память процесса бесконечно копящимися сообщениями
// для кого-то, кто никогда не выйдет в сеть — старые записи вытесняются.
const MAX_MAILBOX_PER_USER = 500;
setInterval(() => {
  for (const box of mailbox.values()) {
    if (box.size <= MAX_MAILBOX_PER_USER) continue;
    const entries = Array.from(box.entries()).sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < entries.length - MAX_MAILBOX_PER_USER; i++) box.delete(entries[i][0]);
  }
}, 60000);

console.log(`Сигнальный релей "Эфир" слушает порт ${PORT}`);
