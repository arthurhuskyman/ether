// Конверт офлайн-очереди v2 (AES-GCM с AAD, {iv, ct, v:2} БЕЗ h) проходит валидацию и хранится как непрозрачный; Double Ratchet v2 ({v:2,h,ct}) не затронут
const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (c) => c.repeat(64);
function connect(port, myId, caps) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:" + port); const events = [];
    ws.on("error", reject);
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => { ws.send(JSON.stringify({ type: "register", id: myId, name: "n", visible: true, caps })); setTimeout(() => resolve({ ws, events }), 250); });
  });
}
async function retry(port, myId, caps) { for (let i = 0; i < 40; i++) { try { return await connect(port, myId, caps); } catch (e) { await wait(100); } } throw new Error("нет сервера"); }
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: "8841", MAILBOX_PERSIST: "0", CLAIMS_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "" }), stdio: "ignore" });
  const A = await retry(8841, id("a"), ["env2", "bad caps!", 5]);
  check("сервер объявляет feature env2", A.events.find((e) => e.type === "registered").features.includes("env2"));
  const B = await retry(8841, id("b"));
  check("caps клиента (белый список) рассылаются наблюдателям", B.events.some((e) => (e.type === "presence" && e.id === id("a") && e.caps && e.caps.join() === "env2") || (e.type === "registered" && e.online.some((x) => x.id === id("a") && x.caps.join() === "env2"))));
  const send = (o) => A.ws.send(JSON.stringify(Object.assign({ type: "deliver", to: id("b"), fromPublicKey: null, kind: "chat" }, o)));
  send({ msgId: "e1", envelope: { iv: "AAAAAAAAAAAAAAAA", ct: "Zm9v", v: 2, rc: 1, e2: 1, evil: "x" } });
  send({ msgId: "e2", envelope: { iv: "AAAAAAAAAAAAAAAA", ct: "Zm9v", v: 2 } });
  send({ msgId: "e3", envelope: { ct: "Zm9v", v: 2 } }); // v2 без iv и без h — мусор
  send({ msgId: "e4", envelope: { v: 2, h: { d: ["a".repeat(30), "b".repeat(30)], pn: 0, n: 0 }, ct: "Zm9v" } }); // настоящий ratchet-формат
  await wait(500);
  const acks = Object.fromEntries(A.events.filter((e) => e.type === "deliver-ack").map((e) => [e.msgId, e.error || null]));
  check("env2 {iv,ct,v:2} принят", acks.e1 === null && acks.e2 === null);
  check("v2 без iv и без h отклонён", acks.e3 === "invalid-envelope");
  check("ratchet v2 принят как раньше", acks.e4 === null);
  const got = B.events.filter((e) => e.type === "deliver");
  const e1 = got.find((e) => e.msgId === "e1");
  check("получатель видит v:2, e2 и rc; посторонние поля срезаны", e1 && e1.envelope.v === 2 && e1.envelope.e2 === 1 && e1.envelope.rc === 1 && e1.envelope.evil === undefined && e1.envelope.h === undefined);
  A.ws.close(); B.ws.close(); srv.kill("SIGTERM"); await wait(300);
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
