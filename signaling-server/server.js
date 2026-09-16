// Сигнальный сервер "Эфир".
//
// Задачи: (1) рандеву — сказать двум устройствам, что они оба сейчас
// онлайн, и один раз передать между ними пакет подключения WebRTC;
// (2) список "кто сейчас на связи", чтобы контакт можно было добавить
// в один тап, а не вслепую по номеру. Всё это — только в памяти
// процесса, ничего не пишется на диск, при перезапуске сервера список
// полностью исчезает.
//
// Сервер знает участников по непрозрачному id (хэш от номера/почты,
// посчитанный на устройстве) и по имени, которое устройство само
// объявляет при подключении. Сам номер телефона или email сюда не
// попадают. Имя человек указывает сам и может как угодно исказить.

const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8787;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // id -> { ws, name, visible }

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function rosterEntry(id) {
  const c = clients.get(id);
  return c ? { id, name: c.name || "", visible: c.visible !== false } : null;
}

function broadcastPresence(id, online) {
  const entry = online ? rosterEntry(id) : { id, name: "", visible: true };
  for (const [otherId, c] of clients) {
    if (otherId === id) continue;
    safeSend(c.ws, { type: "presence", id, online, name: entry.name, visible: entry.visible });
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

    // Клиент представляется id + именем и получает список тех, кто уже онлайн.
    if (msg.type === "register" && typeof msg.id === "string" && msg.id) {
      if (clients.has(msg.id) && clients.get(msg.id).ws !== ws) {
        try { clients.get(msg.id).ws.close(); } catch (e) {}
      }
      myId = msg.id;
      clients.set(myId, { ws, name: String(msg.name || "").slice(0, 60), visible: msg.visible !== false });
      const online = Array.from(clients.keys())
        .filter((i) => i !== myId)
        .map((i) => rosterEntry(i));
      safeSend(ws, { type: "registered", id: myId, online });
      broadcastPresence(myId, true);
      return;
    }

    // Пересылка одного пакета сигналинга конкретному адресату.
    if (msg.type === "signal" && myId && typeof msg.to === "string") {
      const target = clients.get(msg.to);
      if (target) {
        safeSend(target.ws, { type: "signal", from: myId, data: msg.data });
      } else {
        safeSend(ws, { type: "unreachable", to: msg.to });
      }
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

console.log(`Сигнальный релей "Эфир" слушает порт ${PORT}`);
