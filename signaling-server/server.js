// Сигнальный сервер "Эфир".
//
// Его единственная задача — рандеву: сказать двум устройствам, что они
// сейчас оба онлайн, и один раз передать между ними пакет подключения
// WebRTC (offer/answer). Сам сервер:
//   - НЕ хранит сообщения и не видит их содержимое;
//   - НЕ хранит и не передаёт звук — после подключения весь трафик идёт
//     напрямую между устройствами, сервер в нём не участвует;
//   - НЕ пишет ничего на диск и не ведёт журнал — только Map в памяти
//     процесса, которая полностью исчезает при перезапуске;
//   - знает участников только по непрозрачному id (хэш от номера/почты,
//     вычисленный на устройстве) — сам номер телефона или email сюда
//     не попадают.

const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8787;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // id -> ws

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastPresence(id, online) {
  for (const [otherId, ws] of clients) {
    if (otherId === id) continue;
    safeSend(ws, { type: "presence", id, online });
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

    // Клиент представляется своим id и получает список тех, кто уже онлайн.
    if (msg.type === "register" && typeof msg.id === "string" && msg.id) {
      if (clients.has(msg.id) && clients.get(msg.id) !== ws) {
        // Тот же id уже подключён с другой вкладки/устройства — не рвём
        // старое соединение молча, просто не даём дублей в списке рассылки.
        try { clients.get(msg.id).close(); } catch (e) {}
      }
      myId = msg.id;
      clients.set(myId, ws);
      safeSend(ws, {
        type: "registered",
        id: myId,
        online: Array.from(clients.keys()).filter((i) => i !== myId),
      });
      broadcastPresence(myId, true);
      return;
    }

    // Пересылка одного пакета сигналинга конкретному адресату.
    if (msg.type === "signal" && myId && typeof msg.to === "string") {
      const target = clients.get(msg.to);
      if (target) {
        safeSend(target, { type: "signal", from: myId, data: msg.data });
      } else {
        safeSend(ws, { type: "unreachable", to: msg.to });
      }
      return;
    }
  });

  ws.on("close", () => {
    if (myId && clients.get(myId) === ws) {
      clients.delete(myId);
      broadcastPresence(myId, false);
    }
  });
});

// Проверка "живости" соединений, чтобы не копить мёртвые сокеты
// (например, если телефон ушёл в спящий режим без нормального closе).
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
