// Prekey-пакеты: загрузка, выдача с расходом одноразового ключа, проверки формата, сигнал "мало ключей", отсутствие утечки секретов.
const WebSocket = require("ws");
process.env.PORT = "8793";
process.env.VAPID_PUBLIC = "";
process.env.VAPID_PRIVATE = "";
require("./server.js");
const URL = "ws://localhost:8793";
const idA = "pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11";
const idB = "pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22";
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
const opkList = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: tag + i, pub: pub("k") }));

(async () => {
  const A = await connect(idA), B = await connect(idB);
  check("registered сообщает features с prekeys и prekeyCount=0", (() => { const r = A.events.find((e) => e.type === "registered"); return r && r.features.includes("prekeys") && r.prekeyCount === 0; })());

  B.send({ type: "prekey-upload", spk: { id: "spk1", pub: pub("s") }, opks: opkList(12, "o") });
  await wait(150);
  const stored = B.events.find((e) => e.type === "prekey-stored");
  check("загрузка подтверждена, count=12", stored && stored.count === 12 && !stored.error);

  A.send({ type: "prekey-fetch", to: idB, rid: "r1" });
  await wait(150);
  const b1 = A.events.find((e) => e.type === "prekey-bundle" && e.rid === "r1");
  check("пакет содержит spk и один opk", b1 && b1.spk && b1.spk.id === "spk1" && b1.opk && b1.opk.id === "o0" && b1.opk.pub.length === 2);
  A.send({ type: "prekey-fetch", to: idB, rid: "r2" });
  await wait(150);
  const b2 = A.events.find((e) => e.type === "prekey-bundle" && e.rid === "r2");
  check("второй запрос получает ДРУГОЙ opk (одноразовый)", b2 && b2.opk && b2.opk.id === "o1");

  // Дорасходуем до порога и проверим сигнал владельцу
  for (let i = 3; i <= 5; i++) { A.send({ type: "prekey-fetch", to: idB, rid: "r" + i }); await wait(80); }
  const low = B.events.find((e) => e.type === "prekey-low");
  check("владельцу ушёл prekey-low, когда запас стал < 10", low && low.count < 10);

  A.send({ type: "prekey-fetch", to: idA, rid: "none" });
  await wait(150);
  const none = A.events.find((e) => e.type === "prekey-bundle" && e.rid === "none");
  check("у пользователя без пакета приходит пустой пакет (клиент откатится на старт без prekey)", none && none.spk === null && none.opk === null);

  // Валидация
  for (const [label, msg] of [
    ["spk без id", { type: "prekey-upload", spk: { pub: pub("s") } }],
    ["pub с недопустимыми символами", { type: "prekey-upload", opks: [{ id: "x1", pub: ["!!!!!!!!!!!!!!!!!!!!!!!!", pub("k")[1]] }] }],
    ["слишком много ключей за раз", { type: "prekey-upload", opks: opkList(51, "m") }],
    ["pub неверной длины", { type: "prekey-upload", opks: [{ id: "x2", pub: ["abc", "def"] }] }],
  ]) {
    const before = B.events.length;
    B.send(msg); await wait(120);
    const r = B.events.slice(before).find((e) => e.type === "prekey-stored");
    check("отклонено: " + label, r && r.error === "invalid");
  }

  // Загрузка нескольких порций ограничена общим потолком 100
  for (let i = 0; i < 4; i++) { B.send({ type: "prekey-upload", opks: opkList(50, "p" + i + "_") }); await wait(80); }
  const last = B.events.filter((e) => e.type === "prekey-stored" && !e.error).pop();
  check("потолок хранения: не больше 100 одноразовых ключей", last && last.count <= 100);

  // Поведение при перерегистрации: счётчик виден клиенту
  const B2 = await connect(idB);
  const reg = B2.events.find((e) => e.type === "registered");
  check("после переподключения registered показывает остаток prekeyCount", reg && reg.prekeyCount > 0);

  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})();
