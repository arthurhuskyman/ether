// Companion-устройства: ящик по (id, deviceId), challenge-подпись, копии по устройствам, ack по устройству, sync-sent, отзыв, совместимость.
const WebSocket = require("ws"); const crypto = require("crypto");
process.env.PORT = "8798"; process.env.MAILBOX_PERSIST = "0"; process.env.VAPID_PUBLIC = ""; process.env.VAPID_PRIVATE = "";
require("./server.js");
const A = "ea11".repeat(16), Bid = "eb22".repeat(16), DEV = "0123456789abcdef", DEV2 = "fedcba9876543210";
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(first) { return new Promise((resolve) => { const ws = new WebSocket("ws://localhost:8798"); const events = []; ws.on("message", (raw) => events.push(JSON.parse(raw))); ws.on("open", () => { ws.send(JSON.stringify(first)); setTimeout(() => resolve({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }), 200); }); }); }
const reg = (id) => open({ type: "register", id, name: "n", visible: true });
const env = (tag) => ({ iv: "aXY=", ct: Buffer.from(tag).toString("base64"), v: 2 });
const kp = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwkPub = (k) => { const j = k.publicKey.export({ format: "jwk" }); return { x: j.x, y: j.y }; };
const cert = (id, devId, k, exp) => ({ id, devId, pub: jwkPub(k), label: "PC", created: Date.now(), expires: exp || Date.now() + 1e7, sig: "c2ln" });
const list = (seq, certs, revoked) => ({ id: A, seq, ts: Date.now(), certs, revoked: revoked || [], sig: "c2ln" });
async function companion(devId, key, id) {
  const c = await open({ type: "register", id: id || A, deviceId: devId });
  const ch = c.events.find((e) => e.type === "device-challenge"); if (!ch) return c;
  const sig = crypto.sign("sha256", Buffer.from("ether-devauth-v1|" + ch.nonce + "|" + (id || A) + "|" + devId), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  c.send({ type: "device-auth", sig }); await wait(200); return c;
}
(async () => {
  await wait(400);
  const k1 = kp(), k2 = kp(), bad = kp();
  const P = await reg(A), B = await reg(Bid);
  const c0 = await open({ type: "register", id: A, deviceId: DEV });
  check("companion без сертификата в списке отвергнут", c0.events.some((e) => e.type === "register-error" && e.error === "device-not-authorized"));
  P.send({ type: "devices-put", list: list(1, [cert(A, DEV, k1)]) }); await wait(150);
  const cBad = await companion(DEV, bad);
  check("чужая подпись (ключ не из сертификата) отвергнута", cBad.events.some((e) => e.type === "register-error") && !cBad.events.some((e) => e.type === "registered"));
  const C = await companion(DEV, k1);
  check("companion с верной подписью: registered device=true", C.events.some((e) => e.type === "registered" && e.device === true && e.deviceId === DEV));
  check("основное соединение не вытеснено", !P.events.some((e) => e.type === "replaced") && P.ws.readyState === 1);
  B.send({ type: "deliver", to: A, msgId: "m1", envelope: env("primary"), kind: "chat", copies: [{ dev: DEV, envelope: env("for-dev") }] }); await wait(250);
  const dp = P.events.find((e) => e.type === "deliver" && e.msgId === "m1"), dc = C.events.find((e) => e.type === "deliver" && e.msgId === "m1");
  check("основное получает свой конверт, companion — свой (разные)", dp && dc && dp.envelope.ct !== dc.envelope.ct && Buffer.from(dc.envelope.ct, "base64").toString() === "for-dev");
  C.send({ type: "mailbox-ack", msgId: "m1" }); await wait(100);
  C.ws.close(); await wait(150);
  const C2 = await companion(DEV, k1);
  check("ack по устройству: companion m1 не получает повторно", !C2.events.some((e) => e.type === "deliver" && e.msgId === "m1"));
  P.ws.close(); await wait(150);
  const P2 = await reg(A);
  check("ящик основного не затронут ack companion (m1 доставлен из ящика)", P2.events.some((e) => e.type === "deliver" && e.msgId === "m1" && e.queued));
  P2.send({ type: "mailbox-ack", msgId: "m1" });
  // офлайн-ящик companion
  C2.ws.close(); await wait(150);
  B.send({ type: "deliver", to: A, msgId: "m2", envelope: env("p2"), kind: "chat", copies: [{ dev: DEV, envelope: env("d2") }] }); await wait(200);
  const C3 = await companion(DEV, k1);
  check("офлайн: копия ждёт в ящике устройства и приходит при входе", C3.events.some((e) => e.type === "deliver" && e.msgId === "m2" && e.queued));
  // копия на неизвестное устройство не доставляется и не копится
  B.send({ type: "deliver", to: A, msgId: "m3", envelope: env("p3"), kind: "chat", copies: [{ dev: DEV2, envelope: env("x") }] }); await wait(200);
  check("копия неизвестному устройству отброшена (ack без ошибки)", B.events.some((e) => e.type === "deliver-ack" && e.msgId === "m3" && !e.error));
  B.send({ type: "deliver", to: A, msgId: "m4", envelope: env("p4"), copies: Array.from({ length: 9 }, (_, i) => ({ dev: "0000000000000" + (100 + i).toString(16).slice(-3), envelope: env("z") })) }); await wait(150);
  check("больше 8 копий отвергается", B.events.some((e) => e.type === "deliver-ack" && e.msgId === "m4" && e.error === "invalid-envelope"));
  // sync-sent: основное -> companion
  P2.send({ type: "deliver", to: A, msgId: "s1", kind: "sync-sent", copies: [{ dev: DEV, envelope: env("sync") }] }); await wait(200);
  check("sync-sent с основного доходит до companion (kind sync-sent)", C3.events.some((e) => e.type === "deliver" && e.msgId === "s1" && e.kind === "sync-sent"));
  check("sync-sent не возвращается отправителю", !P2.events.some((e) => e.msgId === "s1" && e.type === "deliver"));
  // companion -> контакт: fromDev выставляет сервер
  C3.send({ type: "deliver", to: Bid, msgId: "c1", envelope: env("to-b"), kind: "chat", fromDev: "ffffffffffffffff" }); await wait(200);
  const db = B.events.find((e) => e.type === "deliver" && e.msgId === "c1");
  check("сообщение companion доходит контакту с from=аккаунт и fromDev=его deviceId (не подделать)", db && db.from === A && db.fromDev === DEV);
  // companion -> основное через sync-sent
  C3.send({ type: "deliver", to: A, msgId: "s2", kind: "sync-sent", copies: [{ dev: "", envelope: env("s") }] }); await wait(200);
  check("sync-sent с companion доходит до основного", P2.events.some((e) => e.type === "deliver" && e.msgId === "s2" && e.fromDev === DEV));
  check("companion не может звонить/смотреть ростер (молча игнорируется)", (C3.send({ type: "signal", to: Bid, data: { t: "x" } }), await wait(120), !B.events.some((e) => e.type === "signal")));
  // отзыв
  P2.send({ type: "devices-put", list: list(2, [cert(A, DEV, k1)], [DEV]) }); await wait(250);
  check("отзыв: companion получил device-revoked и отключён", C3.events.some((e) => e.type === "device-revoked") && C3.ws.readyState !== 1);
  B.send({ type: "deliver", to: A, msgId: "m5", envelope: env("p5"), copies: [{ dev: DEV, envelope: env("d5") }] }); await wait(200);
  const C4 = await companion(DEV, k1);
  check("отозванное устройство не может зарегистрироваться и ничего не получает", C4.events.some((e) => e.type === "register-error") && !C4.events.some((e) => e.msgId === "m5"));
  // просроченный сертификат
  P2.send({ type: "devices-put", list: list(3, [cert(A, DEV2, k2, Date.now() - 1000)]) }); await wait(150);
  const C5 = await companion(DEV2, k2);
  check("просроченный сертификат не принимается", C5.events.some((e) => e.type === "register-error"));
  console.log(`\n${pass} ok, ${fail} fail`); process.exit(fail ? 1 : 0);
})();
