// Федерация ретрансляторов (fed0, ЭКСПЕРИМЕНТАЛЬНО): два настоящих процесса сервера, подписанная пересылка конвертов, закреплённые ключи, защита от подделки/повтора, выключено по умолчанию.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const fed = require("./federation");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const w = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-fed-"));
const keyA = fed.loadOrCreateKey(path.join(tmp, "a.json")), keyB = fed.loadOrCreateKey(path.join(tmp, "b.json")), keyEvil = fed.loadOrCreateKey(path.join(tmp, "evil.json"));
const PA = 8881, PB = 8882, PC = 8883;
const base = { ...process.env, MAILBOX_PERSIST: "0", CLAIMS_PERSIST: "0", DISCOVERY_PERSIST: "0", GROUPS_PERSIST: "0", CHANNELS_PERSIST: "0", DEVICES_PERSIST: "0", ALIASES_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "" };
const start = (port, extra) => spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...base, PORT: String(port), ...extra }, stdio: "ignore" });
const procs = [
  start(PA, { FEDERATION_ENABLED: "1", FEDERATION_NAME: "alpha", FEDERATION_KEY_FILE: path.join(tmp, "a.json"), FEDERATION_PEERS: JSON.stringify([{ name: "beta", url: "http://127.0.0.1:" + PB, pub: keyB.x }]) }),
  start(PB, { FEDERATION_ENABLED: "1", FEDERATION_NAME: "beta", FEDERATION_KEY_FILE: path.join(tmp, "b.json"), FEDERATION_PEERS: JSON.stringify([{ name: "alpha", url: "http://127.0.0.1:" + PA, pub: keyA.x }]) }),
  start(PC, {}), // федерация не включена
];
const open = (port, id) => new Promise((resolve) => { const ws = new WebSocket("ws://127.0.0.1:" + port); const ev = []; ws.on("message", (r) => ev.push(JSON.parse(r))); ws.on("open", () => { ws.send(JSON.stringify({ type: "register", id, name: id, visible: true })); setTimeout(() => resolve({ ws, ev, send: (o) => ws.send(JSON.stringify(o)) }), 300); }); });
const get = (port, p) => new Promise((resolve) => http.get("http://127.0.0.1:" + port + p, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => resolve({ status: r.statusCode, body: b })); }).on("error", () => resolve({ status: 0, body: "" })));
function post(port, relay, key, ts, bodyObj, opt) {
  const body = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);
  const priv = crypto.createPrivateKey({ key, format: "jwk" });
  const sig = crypto.sign(null, fed.canon(relay, ts, crypto.createHash("sha256").update((opt && opt.signBody) || body).digest("hex")), priv).toString("base64url");
  return new Promise((resolve) => { const r = http.request({ host: "127.0.0.1", port, path: "/federation/inbox", method: "POST", headers: { "Content-Type": "application/json", "X-Ether-Fed-Relay": relay, "X-Ether-Fed-Ts": ts, "X-Ether-Fed-Sig": (opt && opt.sig) || sig } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); }); r.on("error", () => resolve({ status: 0 })); r.end(body); });
}
const ENV = { v: 2, h: { d: ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"], pn: 0, n: 0 }, ct: Buffer.from("opaque-ciphertext").toString("base64") };

(async () => {
  await w(1800);
  const idA = await get(PA, "/federation/identity");
  const doc = JSON.parse(idA.body || "{}");
  check("identity: имя, ключ и самоподпись", idA.status === 200 && doc.name === "alpha" && doc.pub === keyA.x && fed.verify(doc.pub, Buffer.from("ether-fed-id-v1|alpha|" + doc.pub), doc.sig));
  check("выключенная федерация: /federation/identity недоступен", (await get(PC, "/federation/identity")).status !== 200);

  const dis = await open(PC, "dis"); check("по умолчанию fed0 не объявляется, а адрес вида id@имя — обычный id", dis.ev.some((e) => e.type === "registered" && !e.features.includes("fed0"))); dis.ws.close();
  const alice = await open(PA, "alice"), bob = await open(PB, "bob");
  check("сервер объявляет возможность fed0 только при включении", alice.ev.some((e) => e.type === "registered" && e.features.includes("fed0")));
  const spoof = await open(PA, "mallory@beta"); check("D8: при включённой федерации id с '@' не регистрируется", spoof.ev.some((e) => e.type === "register-error" && e.error === "invalid-id") && !spoof.ev.some((e) => e.type === "registered")); spoof.ws.close();
  alice.send({ type: "deliver", to: "bob@beta", msgId: "f1", envelope: ENV, fromPublicKey: { kty: "EC", crv: "P-256", x: "xx", y: "yy" }, kind: "chat" }); await w(500);
  check("alpha -> beta: отправитель получил ack без ошибки", alice.ev.some((e) => e.type === "deliver-ack" && e.msgId === "f1" && !e.error));
  const got = bob.ev.find((e) => e.type === "deliver" && e.msgId === "f1");
  check("beta показывает получателю отправителя alice@alpha и тот же конверт", got && got.from === "alice@alpha" && got.envelope.ct === ENV.ct && got.kind === "chat" && got.fromPublicKey && got.fromPublicKey.x === "xx");
  bob.send({ type: "deliver", to: "alice@alpha", msgId: "f2", envelope: ENV, kind: "chat" }); await w(500);
  check("ответ beta -> alpha идёт тем же путём (от bob@beta)", alice.ev.some((e) => e.type === "deliver" && e.msgId === "f2" && e.from === "bob@beta"));
  const carol = await open(PB, "carol-offline"); carol.ws.close(); await w(100);
  alice.send({ type: "deliver", to: "carol-offline@beta", msgId: "f3", envelope: ENV }); await w(400);
  const carol2 = await open(PB, "carol-offline");
  check("получатель офлайн: конверт ждёт в ящике beta", carol2.ev.some((e) => e.type === "deliver" && e.msgId === "f3" && e.queued && e.from === "alice@alpha"));
  alice.send({ type: "deliver", to: "bob@gamma", msgId: "f4", envelope: ENV }); await w(300);
  check("суффикс неизвестного пира — обычный локальный id (без пересылки и без ошибки)", !bob.ev.some((e) => e.msgId === "f4") && alice.ev.some((e) => e.type === "deliver-ack" && e.msgId === "f4" && !e.error));
  alice.send({ type: "deliver", to: "bob@beta", msgId: "f5", envelope: { ct: 5 } }); await w(300);
  check("невалидный конверт отвергается до пересылки", alice.ev.some((e) => e.type === "deliver-ack" && e.msgId === "f5" && e.error === "invalid-envelope") && !bob.ev.some((e) => e.msgId === "f5"));

  // прямые запросы к /federation/inbox
  const ts = String(Date.now()), body = { v: 1, from: "mallory", to: "bob", msgId: "x1", envelope: ENV, kind: "chat", ts: Number(ts) };
  let r = await post(PB, "alpha", keyA, ts, body);
  check("корректно подписанный запрос принят", r.status === 200 && bob.ev.some((e) => e.msgId === "x1" && e.from === "mallory@alpha"));
  r = await post(PB, "alpha", keyA, ts, body);
  check("повтор того же запроса — dup, повторной доставки нет", r.status === 200 && JSON.parse(r.body).dup === true && bob.ev.filter((e) => e.msgId === "x1").length === 1);
  r = await post(PB, "alpha", keyEvil, String(Date.now()), { ...body, msgId: "x2", ts: Date.now() });
  check("подпись чужим ключом отвергнута (ключ пира закреплён)", r.status === 401 && !bob.ev.some((e) => e.msgId === "x2"));
  const ts3 = String(Date.now()); const b3 = JSON.stringify({ ...body, msgId: "x3", ts: Number(ts3) });
  r = await post(PB, "alpha", keyA, ts3, b3.replace("bob", "bobx"), { signBody: b3 });
  check("тело изменено после подписи — отвергнуто", r.status === 401);
  r = await post(PB, "alpha", keyA, String(Date.now() - 3600_000), { ...body, msgId: "x4", ts: Date.now() - 3600_000 });
  check("устаревшая метка времени отвергнута", r.status === 401 && JSON.parse(r.body).error === "clock");
  r = await post(PB, "unknown", keyA, String(Date.now()), { ...body, msgId: "x5" });
  check("неизвестный ретранслятор отвергнут", r.status === 401 && JSON.parse(r.body).error === "unknown-peer");
  const ts6 = String(Date.now());
  r = await post(PB, "alpha", keyA, ts6, { ...body, msgId: "x6", to: "bob@alpha", ts: Number(ts6) });
  check("цепочки пересылки запрещены (адресат с '@')", r.status === 400);
  const ts7 = String(Date.now());
  r = await post(PB, "alpha", keyA, ts7, { ...body, msgId: "x7", from: "a@b", ts: Number(ts7) });
  check("отправитель с '@' отвергнут", r.status === 400);
  const ts8 = String(Date.now());
  r = await post(PB, "alpha", keyA, ts8, { ...body, msgId: "x8", envelope: { ct: 1 }, ts: Number(ts8) });
  check("невалидный конверт отвергнут", r.status === 400 && JSON.parse(r.body).error === "invalid-envelope");
  // пир недоступен
  procs[1].kill(); await w(500);
  alice.send({ type: "deliver", to: "bob@beta", msgId: "f9", envelope: ENV }); await w(1500);
  check("пир недоступен: отправитель получает ошибку в deliver-ack", alice.ev.some((e) => e.type === "deliver-ack" && e.msgId === "f9" && e.error === "federation-unreachable"));
  alice.ws.close();
  console.log("\nitogo: " + pass + " OK, " + fail + " FAIL");
  procs.forEach((p) => { try { p.kill(); } catch (e) {} }); fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); procs.forEach((p) => { try { p.kill(); } catch (e2) {} }); process.exit(1); });
