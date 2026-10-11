// Сервер принимает конверты Double Ratchet (v2), отклоняет заведомо кривые и объявляет features при регистрации.
const WebSocket = require("ws");
process.env.PORT = "8792";
process.env.MAILBOX_PERSIST = "0";
process.env.VAPID_PUBLIC = "";
process.env.VAPID_PRIVATE = "";
require("./server.js");

const URL = "ws://localhost:8792";
const idA = "ra11ra11ra11ra11ra11ra11ra11ra11ra11ra11ra11ra11ra11ra11ra11ra11";
const idB = "rb22rb22rb22rb22rb22rb22rb22rb22rb22rb22rb22rb22rb22rb22rb22rb22";
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
function connect(id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL); const events = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", id, name: id.slice(0, 2), visible: true })));
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => setTimeout(() => resolve({ ws, events }), 200));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const v2 = { v: 2, h: { d: ["x".repeat(43), "y".repeat(43)], pn: 0, n: 0, i: 1 }, ct: "QUJD", rc: 1 };

(async () => {
  const A = await connect(idA), B = await connect(idB);
  const reg = A.events.find((e) => e.type === "registered");
  check("registered содержит features с ratchet2", reg && Array.isArray(reg.features) && reg.features.includes("ratchet2"));

  A.ws.send(JSON.stringify({ type: "deliver", to: idB, msgId: "m-v2", envelope: v2, fromPublicKey: { kty: "EC", crv: "P-256", x: "a", y: "b" }, kind: "chat" }));
  await wait(250);
  const got = B.events.find((e) => e.type === "deliver" && e.msgId === "m-v2");
  check("получатель получил конверт v2 как есть", got && got.envelope.v === 2 && got.envelope.h.n === 0 && got.envelope.ct === "QUJD");
  const ack = A.events.find((e) => e.type === "deliver-ack" && e.msgId === "m-v2");
  check("отправитель получил подтверждение без ошибки", ack && !ack.error);

  A.ws.send(JSON.stringify({ type: "deliver", to: idB, msgId: "m-v1", envelope: { iv: "AAAA", ct: "BBBB", v: 1, rc: 1 }, kind: "chat" }));
  await wait(200);
  check("прежний формат v1 по-прежнему проходит", !!B.events.find((e) => e.type === "deliver" && e.msgId === "m-v1"));

  for (const [label, env] of [
    ["v2 без заголовка", { v: 2, ct: "QUJD" }],
    ["v2 с некорректным d", { v: 2, h: { d: ["a"], pn: 0, n: 0 }, ct: "QUJD" }],
    ["v2 с отрицательным номером", { v: 2, h: { d: ["a", "b"], pn: 0, n: -1 }, ct: "QUJD" }],
    ["v2 с огромным p", { v: 2, h: { d: ["a", "b"], pn: 0, n: 0, p: { z: "q".repeat(500) } }, ct: "QUJD" }],
    ["без ct", { v: 2, h: { d: ["a", "b"], pn: 0, n: 0 } }],
  ]) {
    const id = "bad-" + label;
    A.ws.send(JSON.stringify({ type: "deliver", to: idB, msgId: id, envelope: env, kind: "chat" }));
    await wait(150);
    const a = A.events.find((e) => e.type === "deliver-ack" && e.msgId === id);
    check("отклонён: " + label, a && a.error === "invalid-envelope");
    check("не доставлен: " + label, !B.events.find((e) => e.type === "deliver" && e.msgId === id));
  }
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})();
