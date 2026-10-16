// S3/S11: скрытый (visible:false) неотличим от офлайн для всех, кого нет в его ростере (watch): signal/watch-result/presence
const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (c) => c.repeat(64);
function start(port, strict) {
  return spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(port), MAILBOX_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", STRICT_ROSTER: strict ? "1" : "0", CLAIMS_PERSIST: "0" }), stdio: "ignore" });
}
function connect(port, myId, visible, watch) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:" + port); const events = [];
    ws.on("error", reject);
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => { ws.send(JSON.stringify({ type: "register", id: myId, name: "name-" + myId.slice(0, 1), visible, watch })); setTimeout(() => resolve({ ws, events }), 250); });
  });
}
async function retry(port, myId, visible, watch) { for (let i = 0; i < 30; i++) { try { return await connect(port, myId, visible, watch); } catch (e) { await wait(100); } } throw new Error("нет сервера"); }
const send = (c, o) => c.ws.send(JSON.stringify(o));
(async () => {
  for (const strict of [false, true]) {
    const port = strict ? 8822 : 8821, tag = strict ? "STRICT: " : "";
    const srv = start(port, strict);
    // hidden H: ростер только {F}. Незнакомец S смотрит и по signal, и через watch.
    const H = await retry(port, id("h"), false, [id("f")]);
    const F = await retry(port, id("f"), true, [id("h")]);
    const S = await retry(port, id("s"), true, [id("h"), id("z")]); // z — вообще не существует
    const sr = S.events.find((e) => e.type === "registered");
    check(tag + "registered незнакомца не содержит скрытого", !sr.online.some((x) => x.id === id("h")));
    check(tag + "registered контакта содержит скрытого", F.events.find((e) => e.type === "registered").online.some((x) => x.id === id("h")) || F.events.some((e) => e.type === "presence" && e.id === id("h") && e.online));
    send(S, { type: "watch", ids: [id("h"), id("z")] }); await wait(250);
    const wr = S.events.filter((e) => e.type === "watch-result").pop();
    check(tag + "watch-result для незнакомца пуст: скрытый не отличим от несуществующего", wr && wr.online.length === 0);
    // signal: скрытый и несуществующий дают одинаковый unreachable
    send(S, { type: "signal", to: id("h"), data: { t: "offer" } });
    send(S, { type: "signal", to: id("z"), data: { t: "offer" } });
    await wait(250);
    const unr = S.events.filter((e) => e.type === "unreachable").map((e) => e.to);
    check(tag + "signal скрытому от незнакомца = unreachable (как несуществующему)", unr.includes(id("h")) && unr.includes(id("z")));
    check(tag + "скрытый не получил сигнал незнакомца", !H.events.some((e) => e.type === "signal"));
    // контакт: работает
    send(F, { type: "signal", to: id("h"), data: { t: "offer" } }); await wait(250);
    check(tag + "signal от контакта из ростера скрытого доставляется", H.events.some((e) => e.type === "signal" && e.from === id("f")));
    send(F, { type: "watch", ids: [id("h")] }); await wait(250);
    check(tag + "контакт в ростере скрытого видит его в watch-result", F.events.filter((e) => e.type === "watch-result").pop().online.some((x) => x.id === id("h")));
    send(H, { type: "signal", to: id("f"), data: { t: "answer" } }); await wait(200);
    check(tag + "скрытый может звонить контакту", F.events.some((e) => e.type === "signal" && e.from === id("h")));
    // presence: уход/приход скрытого не виден незнакомцу, виден контакту
    const nPresS = S.events.filter((e) => e.type === "presence" && e.id === id("h")).length;
    H.ws.close(); await wait(250);
    check(tag + "уход скрытого: незнакомец presence не получил", S.events.filter((e) => e.type === "presence" && e.id === id("h")).length === nPresS);
    check(tag + "уход скрытого: контакт получил presence offline", F.events.some((e) => e.type === "presence" && e.id === id("h") && e.online === false));
    const H2 = await retry(port, id("h"), false, [id("f")]); await wait(200);
    check(tag + "возвращение скрытого: незнакомец не видит, контакт видит", !S.events.some((e) => e.type === "presence" && e.id === id("h") && e.online) && F.events.some((e) => e.type === "presence" && e.id === id("h") && e.online === true));
    // deliver: ack одинаков для скрытого и несуществующего
    send(S, { type: "deliver", to: id("h"), msgId: "m1", envelope: { iv: "AAAA", ct: "BBBB" } });
    send(S, { type: "deliver", to: id("z"), msgId: "m2", envelope: { iv: "AAAA", ct: "BBBB" } });
    await wait(250);
    const acks = S.events.filter((e) => e.type === "deliver-ack");
    check(tag + "deliver-ack одинаков (без error) для скрытого и несуществующего", acks.length === 2 && acks.every((a) => !a.error && Object.keys(a).sort().join() === "msgId,type"));
    // скрытый добавил незнакомца в ростер позже -> тот начинает видеть
    send(H2, { type: "watch", ids: [id("f"), id("s")] }); await wait(300);
    check(tag + "после добавления в ростер скрытого незнакомец получает presence", S.events.some((e) => e.type === "presence" && e.id === id("h") && e.online === true));
    send(S, { type: "signal", to: id("h"), data: { t: "offer2" } }); await wait(200);
    check(tag + "и может ему сигналить", H2.events.some((e) => e.type === "signal" && e.from === id("s") && e.data.t === "offer2"));
    for (const c of [H2, F, S]) c.ws.close();
    srv.kill("SIGTERM"); await wait(300);
  }
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
