// Постоянный ящик: недоставленное переживает перезапуск сервера; подтверждённое — нет; просроченное отбрасывается; повреждённый файл не валит запуск.
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const WebSocket = require("ws");
const PORT = 8795, URL = "ws://localhost:" + PORT;
const FILE = path.join(os.tmpdir(), "ether-mailbox-test-" + process.pid + ".json");
const idA = "pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11";
const idB = "pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22";
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function startServer() {
  const p = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(PORT), MAILBOX_FILE: FILE, VAPID_PUBLIC: "", VAPID_PRIVATE: "" }), stdio: "ignore" });
  return p;
}
function stopServer(p) { return new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); }); }
function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL); const events = [];
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", id, name: id.slice(0, 2), visible: true })));
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => setTimeout(() => resolve({ ws, events }), 250));
  });
}
async function connectRetry(id) { for (let i = 0; i < 30; i++) { try { return await connect(id); } catch (e) { await wait(100); } } throw new Error("сервер не поднялся"); }
const env = { iv: "AAAA", ct: "BBBB", v: 1, rc: 1 };
(async () => {
  try { fs.unlinkSync(FILE); } catch (e) {}
  let srv = startServer();
  const A = await connectRetry(idA);
  A.ws.send(JSON.stringify({ type: "deliver", to: idB, msgId: "keep-1", envelope: env, kind: "chat" }));
  A.ws.send(JSON.stringify({ type: "deliver", to: idB, msgId: "keep-2", envelope: env, kind: "chat" }));
  await wait(300);
  A.ws.close();
  await wait(2600); // дебаунс записи 2 с
  check("файл ящика создан", fs.existsSync(FILE));
  if (process.platform !== "win32") check("права 0600", (fs.statSync(FILE).mode & 0o777) === 0o600);
  await stopServer(srv);

  srv = startServer();
  let B = await connectRetry(idB);
  const got = B.events.filter((e) => e.type === "deliver" && e.queued);
  check("после перезапуска получатель получил оба недоставленных", got.length === 2 && got.some((e) => e.msgId === "keep-1") && got.some((e) => e.msgId === "keep-2"));
  B.ws.send(JSON.stringify({ type: "mailbox-ack", msgId: "keep-1" }));
  await wait(2600);
  B.ws.close();
  await stopServer(srv);

  const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const left = saved.boxes.flatMap(([, es]) => es.map(([id]) => id));
  check("подтверждённое из файла убрано, неподтверждённое осталось", !left.includes("keep-1") && left.includes("keep-2"));

  // просроченное и мусор
  saved.boxes.push([idB, [["old-1", { from: idA, msgId: "old-1", envelope: env, kind: "chat", ts: Date.now() - 20 * 24 * 3600e3 }], ["oldfile-1", { from: idA, msgId: "oldfile-1", envelope: env, kind: "file", ts: Date.now() - 3 * 24 * 3600e3 }]]]);
  fs.writeFileSync(FILE, JSON.stringify(saved));
  srv = startServer();
  B = await connectRetry(idB);
  const ids = B.events.filter((e) => e.type === "deliver").map((e) => e.msgId);
  check("просроченные (текст 14 сут, файл 48 ч) отброшены", !ids.includes("old-1") && !ids.includes("oldfile-1") && ids.includes("keep-2"));
  B.ws.close(); await stopServer(srv);

  fs.writeFileSync(FILE, "{ это не json");
  srv = startServer();
  const C = await connectRetry(idA);
  check("повреждённый файл не мешает запуску", C.events.some((e) => e.type === "registered"));
  C.ws.close(); await stopServer(srv);
  try { fs.unlinkSync(FILE); } catch (e) {}
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
