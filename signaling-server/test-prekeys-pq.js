// Prekey-пакет v3: расширение c/sig2/kem (ML-KEM-768), валидация и выдача; конверты: a/ac/cp/h.c проходят, KEM-шифртекст в p проходит, мусор отвергается.
const WebSocket = require("ws");
process.env.PORT = "8794"; process.env.MAILBOX_PERSIST = "0"; process.env.VAPID_PUBLIC = ""; process.env.VAPID_PRIVATE = "";
require("./server.js");
const URL = "ws://localhost:8794";
const idA = "pq11pq11pq11pq11pq11pq11pq11pq11pq11pq11pq11pq11pq11pq11pq11pq11";
const idB = "pq22pq22pq22pq22pq22pq22pq22pq22pq22pq22pq22pq22pq22pq22pq22pq22";
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL); const events = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", id, name: id.slice(0, 2), visible: true })));
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => setTimeout(() => resolve({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }), 200));
  });
}
const pub = (c) => [c.repeat(43), c.toUpperCase().repeat(43)];
const kem = Buffer.alloc(1184, 7).toString("base64"), ct = Buffer.alloc(1088, 9).toString("base64");
(async () => {
  const A = await connect(idA), B = await connect(idB);
  check("features содержит pq1", A.events.find((e) => e.type === "registered").features.includes("pq1"));
  const up = (spk) => { B.events.length = 0; B.send({ type: "prekey-upload", spk, opks: [] }); return wait(150).then(() => B.events.find((e) => e.type === "prekey-stored")); };
  check("kem неверной длины отвергнут", (await up({ id: "s1", pub: pub("s"), sig: "c2ln", sig2: "c2ln", c: 7, kem: "AAAA" })).error === "invalid");
  check("kem без sig2/c отвергнут", (await up({ id: "s1", pub: pub("s"), sig: "c2ln", kem })).error === "invalid");
  check("c вне диапазона отвергнут", (await up({ id: "s1", pub: pub("s"), sig: "c2ln", sig2: "c2ln", c: 999, kem })).error === "invalid");
  check("kem не base64 отвергнут", (await up({ id: "s1", pub: pub("s"), sig: "c2ln", sig2: "c2ln", c: 7, kem: "!".repeat(1580) })).error === "invalid");
  check("полный пакет принят", !(await up({ id: "s1", pub: pub("s"), sig: "c2ln", sig2: "c2ln", c: 7, kem })).error);
  A.send({ type: "prekey-fetch", to: idB, rid: "r1" }); await wait(150);
  const b = A.events.find((e) => e.type === "prekey-bundle");
  check("пакет отдаётся с c/sig2/kem без изменений", b && b.spk.kem === kem && b.spk.c === 7 && b.spk.sig2 === "c2ln" && b.spk.sig === "c2ln");
  check("старый пакет (без расширения) по-прежнему принят", !(await up({ id: "s2", pub: pub("t"), sig: "c2ln" })).error);
  A.send({ type: "prekey-fetch", to: idB, rid: "r2" }); await wait(150);
  const b2 = A.events.find((e) => e.type === "prekey-bundle" && e.rid === "r2");
  check("после замены расширения нет", b2 && b2.spk.id === "s2" && b2.spk.kem === undefined);

  const env = (extra, hx) => Object.assign({ v: 2, h: Object.assign({ d: [pub("d")[0], pub("d")[1]], pn: 0, n: 0, i: 1, c: 7, p: { e: pub("e"), s: "s1", o: null, v: 3, k: ct } }, hx), ct: "Y3Q=", rc: 1, ac: 1, cp: 7, a: 3 }, extra);
  const deliver = async (id, e) => { B.events.length = 0; A.events.length = 0; A.send({ type: "deliver", to: idB, msgId: id, envelope: e, fromPublicKey: {}, kind: "chat" }); await wait(200); return { ack: A.events.find((x) => x.type === "deliver-ack"), got: B.events.find((x) => x.type === "deliver") }; };
  let r = await deliver("m1", env());
  check("конверт v3 доходит с a/ac/cp/h.c/p.k", r.got && r.got.envelope.a === 3 && r.got.envelope.ac === 1 && r.got.envelope.cp === 7 && r.got.envelope.h.c === 7 && r.got.envelope.h.p.k === ct && r.got.envelope.h.p.v === 3);
  r = await deliver("m2", env({ a: 9, cp: 999, evil: 1 }));
  check("неизвестные значения a/cp и лишние поля отбрасываются", r.got && r.got.envelope.a === undefined && r.got.envelope.cp === undefined && r.got.envelope.evil === undefined);
  r = await deliver("m3", env({}, { p: { e: pub("e"), s: "s1", o: null, v: 3, k: "x".repeat(1452) + "!" } }));
  check("p.k неверной формы отвергнут", r.ack && r.ack.error === "invalid-envelope");
  r = await deliver("m4", env({}, { c: 1000 }));
  check("h.c вне диапазона отвергнут", r.ack && r.ack.error === "invalid-envelope");
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
