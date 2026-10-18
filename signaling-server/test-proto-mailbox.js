// Протокол: (1) идемпотентность deliver по (from,to,msgId,конверт) — повтор не кладётся в ящик и не пересылается;
// (2) прокси /link-preview-image (SSRF, параметры, типы картинок); (3) register-error id-claimed несёт claimTtlH.
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs"), os = require("os"), path = require("path");
const WebSocket = require("ws");
const PORT = 8841, URL = "ws://localhost:" + PORT;
const FILE = path.join(os.tmpdir(), "ether-proto-mailbox-" + process.pid + ".json");
const CLAIMS = path.join(os.tmpdir(), "ether-proto-claims-" + process.pid + ".json");
const idA = "pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11pa11";
const idB = "pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22pb22";
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function startServer() {
  const p = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(PORT), MAILBOX_FILE: FILE, CLAIMS_FILE: CLAIMS, VAPID_PUBLIC: "", VAPID_PRIVATE: "" }), stdio: "ignore" });
  return p;
}
function connect(id, claim) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL); const events = [];
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", id, name: id.slice(0, 2), visible: true, claim })));
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => setTimeout(() => resolve({ ws, events }), 250));
  });
}
async function connectRetry(id, claim) { for (let i = 0; i < 30; i++) { try { return await connect(id, claim); } catch (e) { await wait(100); } } throw new Error("сервер не поднялся"); }
function get(p) { return new Promise((resolve, reject) => { http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 8000 }, (res) => { const b = []; res.on("data", (c) => b.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(b).toString() })); }).on("error", reject); }); }
const send = (c, o) => c.ws.send(JSON.stringify(o));
const env1 = { iv: "AAAA", ct: "BBBB", v: 1, rc: 1 }, env2 = { iv: "AAAA", ct: "CCCC", v: 1, rc: 1 };
(async () => {
  for (const f of [FILE, CLAIMS]) try { fs.unlinkSync(f); } catch (e) {}
  const srv = startServer();
  try {
    const A = await connectRetry(idA);
    const B = await connectRetry(idB);
    const live = () => B.events.filter((e) => e.type === "deliver" && e.msgId === "m1").length;
    send(A, { type: "deliver", to: idB, msgId: "m1", envelope: env1, kind: "chat" });
    await wait(200);
    check("первый deliver доставлен получателю", live() === 1);
    send(A, { type: "deliver", to: idB, msgId: "m1", envelope: env1, kind: "chat" });
    await wait(200);
    check("повтор с тем же конвертом (до ack) не пересылается второй раз", live() === 1);
    check("повтор подтверждается отправителю (deliver-ack)", A.events.filter((e) => e.type === "deliver-ack" && e.msgId === "m1" && !e.error).length === 2);
    send(B, { type: "mailbox-ack", msgId: "m1" });
    await wait(150);
    send(A, { type: "deliver", to: idB, msgId: "m1", envelope: env1, kind: "chat" });
    await wait(200);
    check("повтор после mailbox-ack в ящик не возвращается", live() === 1);
    send(A, { type: "deliver", to: idB, msgId: "m1", envelope: env2, kind: "chat" });
    await wait(200);
    check("перешифрованный конверт с тем же msgId проходит", live() === 2);
    // ящик: после повторного deliver офлайн-получатель получит одну копию
    B.ws.close(); await wait(200);
    send(A, { type: "deliver", to: idB, msgId: "m2", envelope: env1, kind: "chat" });
    send(A, { type: "deliver", to: idB, msgId: "m2", envelope: env1, kind: "chat" });
    await wait(250);
    const B2 = await connectRetry(idB);
    check("офлайн: в ящике одна копия повторно отправленного", B2.events.filter((e) => e.type === "deliver" && e.msgId === "m2").length === 1);

    // /link-preview-image
    let r = await get("/link-preview-image");
    check("без url — 400", r.status === 400);
    r = await get("/link-preview-image?url=" + encodeURIComponent("http://127.0.0.1:1/x.png"));
    check("loopback (SSRF) — 204 без тела", r.status === 204 && r.body === "");
    r = await get("/link-preview-image?url=" + encodeURIComponent("http://169.254.169.254/latest/meta-data"));
    check("метадата облака (SSRF) — 204", r.status === 204);
    r = await get("/link-preview-image?url=" + encodeURIComponent("file:///etc/passwd"));
    check("file:// — 204", r.status === 204);
    r = await get("/link-preview-image?url=" + encodeURIComponent("http://localhost/" + "a".repeat(2100)));
    check("слишком длинный url — 400", r.status === 400);
    r = await get("/link-preview");
    check("старый /link-preview не затронут (400 без url)", r.status === 400);

    // id-claimed → claimTtlH
    const C1 = await connectRetry(idA.replace(/^pa/, "pc"), "a".repeat(64));
    const C2 = await connectRetry(idA.replace(/^pa/, "pc"), "b".repeat(64));
    const err = C2.events.find((e) => e.type === "register-error");
    check("id-claimed содержит claimTtlH (часы, число)", !!err && err.error === "id-claimed" && Number.isFinite(err.claimTtlH) && err.claimTtlH > 0);
    void C1;
  } finally { srv.kill("SIGTERM"); for (const f of [FILE, CLAIMS]) try { fs.unlinkSync(f); } catch (e) {} }

  const { imageMimeOk } = require("./guards");
  check("imageMimeOk: png/jpeg/webp да", imageMimeOk("image/png") === "image/png" && imageMimeOk("image/JPG; charset=x") === "image/jpeg" && imageMimeOk("image/webp") === "image/webp");
  check("imageMimeOk: svg/html/пусто нет", imageMimeOk("image/svg+xml") === null && imageMimeOk("text/html") === null && imageMimeOk("") === null && imageMimeOk(undefined) === null);
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
