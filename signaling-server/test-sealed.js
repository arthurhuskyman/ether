// V.87: запечатанный отправитель — анонимное соединение кладёт конверт в ящик, только с верным ключом доступа получателя.
const WebSocket = require("ws"), crypto = require("crypto");
Object.assign(process.env, { PORT: "8834", MAILBOX_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", GROUPS_PERSIST: "0", CHANNELS_PERSIST: "0", BLOBS: "0" });
require("./server.js");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const w = (ms) => new Promise((r) => setTimeout(r, ms));
const sock = (reg) => new Promise((resolve) => { const ws = new WebSocket("ws://localhost:8834"); const ev = []; ws.on("message", (r) => ev.push(JSON.parse(r))); ws.on("open", () => { if (reg) ws.send(JSON.stringify({ type: "register", id: reg, name: reg })); setTimeout(() => resolve({ ws, ev, send: (m) => ws.send(JSON.stringify(m)) }), 200); }); });
(async () => {
  await w(400);
  const ak = crypto.randomBytes(16), h = crypto.createHash("sha256").update(ak).digest("hex");
  const B = await sock("se-b"); B.send({ type: "set-uak", h }); await w(100);
  check("сервер объявляет sealed", B.ev.find((e) => e.type === "registered").features.includes("sealed"));
  const anon = await sock(null);
  anon.send({ type: "sealed-deliver", to: "se-b", msgId: "s1", s: "CIPHERTEXT", ak: crypto.randomBytes(16).toString("base64") }); await w(150);
  check("чужой ключ доступа — отказ", anon.ev.some((e) => e.type === "sealed-ack" && e.msgId === "s1" && e.error === "denied") && !B.ev.some((e) => e.type === "sealed"));
  anon.send({ type: "sealed-deliver", to: "se-b", msgId: "s2", s: "CIPHERTEXT", ak: ak.toString("base64") }); await w(150);
  check("верный ключ: доставлено без поля from, отправитель получил ack", anon.ev.some((e) => e.type === "sealed-ack" && e.msgId === "s2" && !e.error) && B.ev.some((e) => e.type === "sealed" && e.msgId === "s2" && e.s === "CIPHERTEXT" && e.from === undefined));
  B.ws.close(); await w(150);
  anon.send({ type: "sealed-deliver", to: "se-b", msgId: "s3", s: "LATER", ak: ak.toString("base64") }); await w(150);
  const B2 = await sock("se-b"); await w(200);
  check("офлайн: из ящика при входе", B2.ev.some((e) => e.type === "sealed" && e.msgId === "s3" && e.queued));
  B2.send({ type: "mailbox-ack", msgId: "s3" }); B2.send({ type: "mailbox-ack", msgId: "s2" }); await w(100);
  B2.ws.close(); await w(100); const B3 = await sock("se-b"); await w(200);
  check("после подтверждения больше не приходит", !B3.ev.some((e) => e.type === "sealed"));
  anon.send({ type: "sealed-deliver", to: "se-b", msgId: "s4", s: "x".repeat(400 * 1024), ak: ak.toString("base64") }); await w(150);
  check("слишком большой конверт отвергнут", anon.ev.some((e) => e.msgId === "s4" && e.error === "invalid"));
  // V.88: заголовок PQR (h.q) проходит через ящик без изменений; лишние поля и неверные размеры — отказ
  const A = await sock("se-a"); const B4 = await sock("se-q");
  const k = "A".repeat(1452), p = "B".repeat(1580);
  A.send({ type: "deliver", to: "se-q", msgId: "q1", envelope: { v: 2, h: { d: ["x", "y"], pn: 0, n: 0, c: 15, q: { i: "abc", k, j: "def", p } }, ct: "AAAA", a: 3 }, kind: "chat" }); await w(150);
  const got = B4.ev.find((e) => e.type === "deliver" && e.msgId === "q1");
  check("h.q доходит целиком", got && got.envelope.h.q.k === k && got.envelope.h.q.p === p && got.envelope.h.q.i === "abc");
  A.send({ type: "deliver", to: "se-q", msgId: "q2", envelope: { v: 2, h: { d: ["x", "y"], pn: 0, n: 0, q: { k: "short", i: "a" } }, ct: "AAAA" }, kind: "chat" }); await w(150);
  check("неверный размер KEM в h.q — отказ", A.ev.some((e) => e.type === "deliver-ack" && e.msgId === "q2" && e.error));
  A.send({ type: "deliver", to: "se-q", msgId: "q3", envelope: { v: 2, h: { d: ["x", "y"], pn: 0, n: 0, q: { zz: 1 } }, ct: "AAAA" }, kind: "chat" }); await w(150);
  check("лишнее поле в h.q — отказ", A.ev.some((e) => e.type === "deliver-ack" && e.msgId === "q3" && e.error));
  check("сервер объявляет pqr", A.ev.find((e) => e.type === "registered").features.includes("pqr"));
  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
