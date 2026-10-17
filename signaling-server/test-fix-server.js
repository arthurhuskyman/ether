// Регрессии аудита: квота на отправителя в ящике, TTL служебных записей, потолок prekeys, двойное раскодирование сущностей.
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const WebSocket = require("ws");
const { decodeHtmlEntities } = require("./meta-extract");
const PORT = 8797, URL = "ws://localhost:" + PORT;
const FILE = path.join(os.tmpdir(), "ether-fixsrv-" + process.pid + ".json");
const id = (c) => c.repeat(64);
const [idA, idB, idC, idD] = [id("a"), id("b"), id("c"), id("d")];
let fail = 0;
function check(label, cond) { if (!cond) fail++; console.log((cond ? "  OK   " : "  FAIL ") + label); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function startServer(extra) { return spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(PORT), MAILBOX_FILE: FILE, VAPID_PUBLIC: "", VAPID_PRIVATE: "" }, extra), stdio: "ignore" }); }
function stopServer(p) { return new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); }); }
function connect(myId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL); const events = [];
    ws.on("error", reject);
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => { ws.send(JSON.stringify({ type: "register", id: myId, name: myId.slice(0, 2), visible: true })); setTimeout(() => resolve({ ws, events }), 250); });
  });
}
async function connectRetry(myId) { for (let i = 0; i < 30; i++) { try { return await connect(myId); } catch (e) { await wait(100); } } throw new Error("сервер не поднялся"); }
const env = { iv: "AAAA", ct: "BBBB", v: 1, rc: 1 };
const send = (c, to, msgId, kind) => c.ws.send(JSON.stringify({ type: "deliver", to, msgId, envelope: env, kind: kind || "chat" }));
(async () => {
  check("entities: &amp;lt; не превращается в <", decodeHtmlEntities("a &amp;lt;b&amp;gt; &lt;i&gt; &#39;x&#x27; &amp;") === "a &lt;b&gt; <i> 'x' &");
  try { fs.unlinkSync(FILE); } catch (e) {}
  let srv = startServer({ MAILBOX_MAX_PER_SENDER: "5", MAILBOX_MAX_TOTAL_ENTRIES: "40", PREKEYS_MAX: "2" });
  const A = await connectRetry(idA);
  const C = await connectRetry(idC);
  send(C, idB, "victim-1");
  for (let i = 0; i < 12; i++) send(A, idB, "spam-" + i);
  await wait(400);
  const B = await connectRetry(idB);
  const q = B.events.filter((e) => e.type === "deliver" && e.queued).map((e) => e.msgId);
  check("от одного отправителя в ящике не больше квоты (5)", q.filter((m) => m.startsWith("spam-")).length === 5);
  check("свежие записи отправителя остаются, старые вытеснены", q.includes("spam-11") && !q.includes("spam-0"));
  check("чужое сообщение не вытеснено спамом", q.includes("victim-1"));
  A.ws.close(); C.ws.close(); B.ws.close();

  // потолок prekeys: третий id вытесняет самый старый
  const pk = (n) => "k".repeat(20) + n;
  const up = async (cid, n) => { const c = await connectRetry(cid); c.ws.send(JSON.stringify({ type: "prekey-upload", spk: { id: "s" + n, pub: [pk(n), pk(n)] }, opks: [] })); await wait(200); return c; };
  const u1 = await up(idA, 1), u2 = await up(idB, 2), u3 = await up(idC, 3);
  const d = await connectRetry(idD);
  d.ws.send(JSON.stringify({ type: "prekey-fetch", to: idA, rid: "r1" })); await wait(200);
  const r = d.events.find((e) => e.type === "prekey-bundle" && e.rid === "r1");
  check("prekeys: самый старый id вытеснен при превышении потолка", r && !r.spk);
  d.ws.send(JSON.stringify({ type: "prekey-fetch", to: idC, rid: "r2" })); await wait(200);
  check("prekeys: новый id сохранён", d.events.some((e) => e.type === "prekey-bundle" && e.rid === "r2" && e.spk));
  [u1, u2, u3, d].forEach((c) => c.ws.close());
  await wait(2600);
  await stopServer(srv);

  // TTL: служебная запись (poll) старше 48 ч доживает, файл — нет
  const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const old = Date.now() - 3 * 24 * 3600e3;
  saved.boxes = [[idD, [["poll-1", { from: idA, msgId: "poll-1", envelope: env, kind: "poll", ts: old }], ["file-1", { from: idA, msgId: "file-1", envelope: env, kind: "file", ts: old }]]]];
  fs.writeFileSync(FILE, JSON.stringify(saved));
  srv = startServer({});
  const D = await connectRetry(idD);
  const ids = D.events.filter((e) => e.type === "deliver").map((e) => e.msgId);
  check("TTL: опрос (3 сут) доставлен, файл (3 сут) отброшен", ids.includes("poll-1") && !ids.includes("file-1"));
  D.ws.close();
  await stopServer(srv);
  try { fs.unlinkSync(FILE); } catch (e) {}
  console.log(fail ? "FAILED: " + fail : "OK");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
