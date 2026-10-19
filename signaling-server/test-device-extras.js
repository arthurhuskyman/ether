// Companion: push-подписка устройства (мок web-push), события devices-updated контактам, список устройств переживает рестарт сервера.
const WebSocket = require("ws"); const crypto = require("crypto"); const fs = require("fs"); const os = require("os"); const path = require("path");
const { spawn } = require("child_process");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-dev-")), DEV_FILE = path.join(tmp, "devices.json");
process.env.PORT = "8801"; process.env.MAILBOX_PERSIST = "0"; process.env.DEVICES_PERSIST = "1"; process.env.DEVICES_FILE = DEV_FILE;
process.env.VAPID_PUBLIC = "BPubKeyForMockOnly"; process.env.VAPID_PRIVATE = "privForMockOnly";
const pushed = [];
require.cache[require.resolve("web-push")] = { id: "web-push", filename: "web-push", loaded: true, exports: { setVapidDetails() {}, sendNotification: async (sub, body) => { pushed.push({ sub, body: JSON.parse(body) }); } } };
require("./server.js");
const A = "fa11".repeat(16), Bid = "fb22".repeat(16), DEV = "0123456789abcdef";
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(port, first) { return new Promise((resolve) => { const ws = new WebSocket("ws://localhost:" + port); const events = []; ws.on("message", (raw) => events.push(JSON.parse(raw))); ws.on("open", () => { ws.send(JSON.stringify(first)); setTimeout(() => resolve({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }), 200); }); }); }
const env = (tag) => ({ iv: "aXY=", ct: Buffer.from(tag).toString("base64"), v: 2 });
const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }); const jp = kp.publicKey.export({ format: "jwk" });
const cert = (exp) => ({ id: A, devId: DEV, pub: { x: jp.x, y: jp.y }, label: "PC", created: Date.now(), expires: exp || Date.now() + 1e7, sig: "c2ln" });
const list = (seq, certs, revoked) => ({ id: A, seq, ts: Date.now(), certs, revoked: revoked || [], sig: "c2ln" });
async function companion(port) {
  const c = await open(port, { type: "register", id: A, deviceId: DEV });
  const ch = c.events.find((e) => e.type === "device-challenge"); if (!ch) return c;
  const sig = crypto.sign("sha256", Buffer.from("ether-devauth-v1|" + ch.nonce + "|" + A + "|" + DEV), { key: kp.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  c.send({ type: "device-auth", sig }); await wait(250); return c;
}
const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abcdef", keys: { p256dh: "B".repeat(30), auth: "a".repeat(12) } };
(async () => {
  await wait(500);
  const P = await open(8801, { type: "register", id: A, name: "Alice", visible: true }), B = await open(8801, { type: "register", id: Bid, name: "Bob", visible: true });
  check("features: devsync/devpush/devnotify", ["devsync", "devpush", "devnotify"].every((f) => P.events.find((e) => e.type === "registered").features.includes(f)));
  B.send({ type: "watch", ids: [A] }); await wait(150);
  P.send({ type: "devices-put", list: list(1, [cert()]) }); await wait(200);
  check("контакт в watch получил devices-updated {id, seq}", B.events.some((e) => e.type === "devices-updated" && e.id === A && e.seq === 1));
  const C = await companion(8801);
  check("companion получил vapid-key при авторизации", C.events.some((e) => e.type === "vapid-key" && e.key === process.env.VAPID_PUBLIC));
  // push companion
  C.send({ type: "push-subscribe", subscription: { endpoint: "http://evil/x", keys: SUB.keys } }); await wait(100);
  check("невалидная подписка companion отвергнута", C.events.some((e) => e.type === "push-subscribe-error"));
  C.send({ type: "push-subscribe", subscription: SUB, lang: "ru" }); await wait(100);
  check("подписка companion принята", C.events.some((e) => e.type === "push-subscribed"));
  C.ws.close(); await wait(150); // companion офлайн: сообщение остаётся в его ящике
  B.send({ type: "deliver", to: A, msgId: "p1", envelope: env("primary"), kind: "chat", copies: [{ dev: DEV, envelope: env("for-dev") }] });
  await wait(5800);
  check("web-push ушёл на подписку companion (мок), а не на основное", pushed.length === 1 && pushed[0].sub.endpoint === SUB.endpoint);
  // обновление списка: отзыв удаляет подписку
  P.send({ type: "devices-put", list: list(2, [], [DEV]) }); await wait(200);
  B.send({ type: "deliver", to: A, msgId: "p2", envelope: env("primary2"), kind: "chat", copies: [{ dev: DEV, envelope: env("for-dev2") }] });
  await wait(5800);
  check("после отзыва push на устройство не идёт", pushed.length === 1);
  P.send({ type: "devices-put", list: list(3, [cert()], []) }); await wait(200);
  check("список сохранён на диск, 0600", await (async () => { await wait(1300); try { const st = fs.statSync(DEV_FILE); return (st.mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(DEV_FILE, "utf8")).lists[0][1].list.seq === 3; } catch (e) { return false; } })());
  // рестарт: второй процесс сервера с тем же файлом, основное не публикует, companion авторизуется сразу
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: "8802", VAPID_PUBLIC: "", VAPID_PRIVATE: "" }, stdio: "ignore" });
  await wait(1200);
  const C2 = await companion(8802);
  check("после рестарта companion авторизуется без основного", C2.events.some((e) => e.type === "registered" && e.device === true));
  C2.ws.close(); child.kill(); await wait(600);
  // битый/просроченный файл не ломает старт
  fs.writeFileSync(DEV_FILE, JSON.stringify({ v: 1, lists: [[A, { at: 1, list: list(9, [cert()]) }], ["x", null], [Bid, { at: Date.now(), list: { id: "other", seq: 1 } }]] }));
  const child2 = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: "8803", VAPID_PUBLIC: "", VAPID_PRIVATE: "" }, stdio: "ignore" });
  await wait(1200);
  const C3 = await companion(8803);
  check("просроченные и некорректные записи отброшены", C3.events.some((e) => e.type === "register-error"));
  child2.kill(); P.ws.close(); B.ws.close();
  console.log(`\n${pass} ok, ${fail} fail`); process.exit(fail ? 1 : 0);
})();
