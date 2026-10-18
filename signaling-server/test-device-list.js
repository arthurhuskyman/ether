// Список устройств аккаунта: публикует только владелец id, seq только растёт, лимит размера, отдача другим, совместимость (feature devlist).
const WebSocket = require("ws");
process.env.PORT = "8797"; process.env.MAILBOX_PERSIST = "0"; process.env.VAPID_PUBLIC = ""; process.env.VAPID_PRIVATE = "";
require("./server.js");
const idA = "da11".repeat(16), idB = "db22".repeat(16);
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(id) { return new Promise((resolve) => { const ws = new WebSocket("ws://localhost:8797"); const events = []; ws.on("message", (raw) => events.push(JSON.parse(raw))); ws.on("open", () => { ws.send(JSON.stringify({ type: "register", id, name: "n", visible: true })); setTimeout(() => resolve({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }), 200); }); }); }
const list = (id, seq, extra) => Object.assign({ id, seq, ts: Date.now(), certs: [{ id, devId: "0123456789abcdef", pub: { x: "x", y: "y" }, label: "Компьютер", created: 1, expires: 2, sig: "c2ln" }], revoked: [], sig: "c2ln" }, extra || {});
(async () => {
  await wait(400);
  const A = await connect(idA), B = await connect(idB);
  check("features содержит devlist", A.events.find((e) => e.type === "registered").features.includes("devlist"));
  A.send({ type: "devices-put", list: list(idA, 1) }); await wait(120);
  check("владелец публикует: stored seq=1", A.events.some((e) => e.type === "devices-stored" && e.seq === 1 && !e.error));
  B.send({ type: "devices-put", list: list(idA, 5) }); await wait(120);
  check("чужой id в списке отвергнут", B.events.some((e) => e.type === "devices-stored" && e.error === "invalid"));
  A.send({ type: "devices-put", list: list(idA, 1) }); await wait(120);
  check("откат/повтор seq отвергнут (stale)", A.events.filter((e) => e.type === "devices-stored").pop().error === "stale");
  A.send({ type: "devices-put", list: list(idA, 2, { revoked: ["0123456789abcdef"], certs: [] }) }); await wait(120);
  B.send({ type: "devices-get", to: idA, rid: "r1" }); await wait(120);
  const got = B.events.find((e) => e.type === "devices-list" && e.rid === "r1");
  check("контакт получает последнюю версию (seq=2, отзыв виден)", got && got.list && got.list.seq === 2 && got.list.revoked.length === 1);
  B.send({ type: "devices-get", to: idB, rid: "r2" }); await wait(120);
  check("нет списка -> list:null", B.events.find((e) => e.rid === "r2").list === null);
  A.send({ type: "devices-put", list: list(idA, 3, { certs: Array.from({ length: 9 }, () => ({})) }) }); await wait(120);
  check("больше 8 устройств отвергается", A.events.filter((e) => e.type === "devices-stored").pop().error === "invalid");
  A.send({ type: "devices-put", list: list(idA, 4, { pad: "z".repeat(9000) }) }); await wait(120);
  check("слишком большой список отвергается", A.events.filter((e) => e.type === "devices-stored").pop().error === "invalid");
  A.send({ type: "devices-put", list: list(idA, 7, { sig: 5 }) }); await wait(120);
  check("sig не строка отвергается", A.events.filter((e) => e.type === "devices-stored").pop().error === "invalid");
  console.log(`\n${pass} ok, ${fail} fail`); process.exit(fail ? 1 : 0);
})();
