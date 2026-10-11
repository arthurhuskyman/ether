// A3: список «онлайн» — только контакты из watch и добровольно видимые; скрытые чужим не видны; STRICT_ROSTER закрывает и старых клиентов
const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (c) => c.repeat(64);
function start(port, strict) {
  return spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(port), MAILBOX_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", STRICT_ROSTER: strict ? "1" : "0" }), stdio: "ignore" });
}
function connect(port, myId, visible, watch) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:" + port); const events = [];
    ws.on("error", reject);
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => { ws.send(JSON.stringify({ type: "register", id: myId, name: myId.slice(0, 1), visible, watch })); setTimeout(() => resolve({ ws, events }), 250); });
  });
}
async function retry(port, myId, visible, watch) { for (let i = 0; i < 30; i++) { try { return await connect(port, myId, visible, watch); } catch (e) { await wait(100); } } throw new Error("нет сервера"); }
const ids = (events, type) => events.filter((e) => e.type === type).flatMap((e) => (e.online && Array.isArray(e.online) ? e.online.map((x) => x.id) : [e.id]));
(async () => {
  // --- режим совместимости: старый клиент (без watch) видит всех, новый — только watch + видимых
  let srv = start(8796, false);
  const hidden = await retry(8796, id("h"), false);
  const shown = await retry(8796, id("s"), true);
  const friend = await retry(8796, id("f"), false);
  const legacy = await retry(8796, id("l"), true);
  const reg = legacy.events.find((e) => e.type === "registered");
  check("сервер объявляет feature watch", reg.features.includes("watch"));
  check("совместимость: старый клиент по-прежнему видит всех онлайн", ["h", "s", "f"].every((c) => reg.online.some((x) => x.id === id(c))));
  const modern = await retry(8796, id("m"), true);
  modern.ws.send(JSON.stringify({ type: "watch", ids: [id("f")] }));
  await wait(250);
  const wr = modern.events.find((e) => e.type === "watch-result");
  const early = await retry(8796, id("e"), true, [id("f")]);
  const er = early.events.find((e) => e.type === "registered");
  check("watch при регистрации урезает первый ростер: скрытого нет, контакт и видимые есть", er.online.some((x) => x.id === id("f")) && er.online.some((x) => x.id === id("s")) && !er.online.some((x) => x.id === id("h")));
  early.ws.close();
  check("watch-result содержит только онлайн-контактов из списка", wr && wr.online.length === 1 && wr.online[0].id === id("f"));
  // presence: friend выходит/входит — modern видит (в списке), hidden — нет
  hidden.ws.close(); await wait(200);
  check("скрытый, которого нет в watch, не присылает presence", !ids(modern.events, "presence").includes(id("h")));
  friend.ws.close(); await wait(250);
  check("контакт из watch присылает presence (офлайн)", modern.events.some((e) => e.type === "presence" && e.id === id("f") && e.online === false));
  const friend2 = await retry(8796, id("f"), false);
  await wait(200);
  check("контакт из watch присылает presence (онлайн), даже если сам скрыт", modern.events.some((e) => e.type === "presence" && e.id === id("f") && e.online === true));
  const shown2 = await retry(8796, id("v"), true);
  await wait(200);
  check("добровольно видимый виден и без watch", modern.events.some((e) => e.type === "presence" && e.id === id("v") && e.online === true));
  const hid2 = await retry(8796, id("x"), false);
  await wait(200);
  check("скрытый чужой виден не-watch клиенту только в совместимом режиме (legacy)", legacy.events.some((e) => e.type === "presence" && e.id === id("x")) && !modern.events.some((e) => e.type === "presence" && e.id === id("x")));
  for (const c of [shown, shown2, friend2, hid2, legacy, modern]) c.ws.close();
  srv.kill("SIGTERM"); await wait(400);

  // --- строгий режим: и старые клиенты видят только добровольно видимых
  srv = start(8797, true);
  const h3 = await retry(8797, id("h"), false), s3 = await retry(8797, id("s"), true);
  const l3 = await retry(8797, id("l"), true);
  const r3 = l3.events.find((e) => e.type === "registered");
  check("STRICT: старый клиент видит видимого, но не скрытого", r3.online.some((x) => x.id === id("s")) && !r3.online.some((x) => x.id === id("h")));
  for (const c of [h3, s3, l3]) c.ws.close();
  srv.kill("SIGTERM"); await wait(300);
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
