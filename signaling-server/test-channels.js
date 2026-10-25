// Каналы (channels.js): подписи постов, владелец-только, fan-out, push офлайн, история-кольцо/TTL/лимиты, персистентность 0600, интеграция по WebSocket.
const crypto = require("crypto"); const fs = require("fs"); const os = require("os"); const path = require("path");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chan-"));
process.env.CHANNEL_HISTORY_MAX = "5"; process.env.CHANNEL_SUBS_MAX = "3"; process.env.CHANNEL_POSTS_PER_MIN = "50"; process.env.CHANNELS_PER_USER = "2"; process.env.CHANNEL_POST_MAX_BYTES = "2000"; process.env.CHANNEL_OPS_PER_MIN = "1000";
const C = require("./channels.js");
const kp = () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pubOf = (k) => { const j = k.publicKey.export({ format: "jwk" }); return { x: j.x, y: j.y }; };
const sign = (k, msg) => crypto.sign("sha256", msg, { key: k.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
const mkWs = () => ({ readyState: 1, sent: [] });
let T = 1_700_000_000_000;
function mk(file) {
  const online = new Map(), pushes = [];
  const m = C.create({ safeSend: (ws, o) => ws.sent.push(o), clientsGet: (id) => online.get(id), push: (uid, c) => pushes.push([uid, c.id]), file, now: () => T });
  return { m, online, pushes };
}
const last = (ws, type) => ws.sent.filter((o) => o.type === type).pop();
const meta = (ch, key, extra) => { const mm = { name: "News", desc: "d", enc: false, ts: T, kv: 0, ...(extra || {}) }; return { meta: mm, metaSig: sign(key, C.metaMsg(ch, mm)) }; };
const post = (ch, key, id, body, extra) => { const p = { id, ts: T, body, enc: false, kv: 0, ...(extra || {}) }; p.sig = sign(key, C.postMsg(ch, p)); return p; };

(async () => {
  const file = path.join(tmp, "ch.json");
  const { m, online, pushes } = mk(file);
  const key = kp(), evil = kp(); const CH = "abcdef123456abcd";
  const owner = mkWs(), s1 = mkWs(), s2 = mkWs(), s3 = mkWs(), s4 = mkWs();
  online.set("owner", { ws: owner }); online.set("s1", { ws: s1 }); online.set("s2", { ws: s2 });
  const msg = (ws, uid, o) => m.onMessage(ws, o, uid);
  // создание
  msg(owner, "owner", { type: "channel-create", ch: CH, pub: pubOf(key), ...meta(CH, key) });
  check("создание канала с верной подписью меты", last(owner, "channel-created") && !last(owner, "channel-created").error);
  msg(owner, "owner", { type: "channel-create", ch: CH, pub: pubOf(key), ...meta(CH, key) });
  check("повторное создание: exists", last(owner, "channel-created").error === "exists");
  msg(owner, "owner", { type: "channel-create", ch: "zzzzzzzzzzzz1111", pub: pubOf(key), meta: { name: "X", ts: T, enc: false }, metaSig: sign(evil, Buffer.from("x")) });
  check("создание с неверной подписью меты отвергнуто", last(owner, "channel-created").error === "invalid");
  msg(owner, "owner", { type: "channel-create", ch: "bbbbbbbbbbbb2222", pub: pubOf(key), ...meta("bbbbbbbbbbbb2222", key) });
  msg(owner, "owner", { type: "channel-create", ch: "cccccccccccc3333", pub: pubOf(key), ...meta("cccccccccccc3333", key) });
  check("лимит каналов на владельца", last(owner, "channel-created").error === "limit");
  // подписка
  msg(s1, "s1", { type: "channel-subscribe", ch: CH }); msg(s2, "s2", { type: "channel-subscribe", ch: CH });
  const inf = last(s1, "channel-info");
  check("подписка: сервер отдаёт pub и мету с подписью", inf && inf.pub.x === pubOf(key).x && inf.metaSig && inf.meta.name === "News");
  msg(s3, "s3", { type: "channel-subscribe", ch: CH }); msg(s4, "s4", { type: "channel-subscribe", ch: CH });
  check("потолок подписчиков (3: владелец+s1+s2) -> full", last(s3, "channel-info").error === "full");
  msg(s2, "s2", { type: "channel-unsubscribe", ch: CH }); msg(s3, "s3", { type: "channel-subscribe", ch: CH });
  check("после отписки место освобождается", last(s3, "channel-info") && !last(s3, "channel-info").error);
  // посты
  const bad = post(CH, evil, "post0001", "forged");
  msg(s1, "s1", { type: "channel-post", ch: CH, post: bad });
  check("чужая подпись: пост отвергнут (подписчик не может постить)", last(s1, "channel-post-ack").error === "bad-sig");
  const good = post(CH, key, "post0002", "hello");
  msg(owner, "owner", { type: "channel-post", ch: CH, post: good });
  check("пост владельца принят, seq=1", last(owner, "channel-post-ack").seq === 1);
  check("fan-out онлайн-подписчику s1", last(s1, "channel-post") && last(s1, "channel-post").post.body === "hello" && last(s1, "channel-post").seq === 1);
  check("офлайн-подписчик s3 получил push", pushes.some((p) => p[0] === "s3" && p[1] === CH) && !pushes.some((p) => p[0] === "s1"));
  msg(owner, "owner", { type: "channel-post", ch: CH, post: good });
  check("повтор того же id: dup без нового seq", last(owner, "channel-post-ack").dup === true && last(owner, "channel-post-ack").seq === 1);
  const tampered = { ...post(CH, key, "post0003", "orig"), body: "changed" };
  msg(owner, "owner", { type: "channel-post", ch: CH, post: tampered });
  check("подмена тела после подписи отвергнута", last(owner, "channel-post-ack").error === "bad-sig");
  msg(owner, "owner", { type: "channel-post", ch: CH, post: post(CH, key, "post0004", "x".repeat(2500)) });
  check("слишком большой пост", last(owner, "channel-post-ack").error === "too-big");
  const old = { id: "post0005", ts: T - 3600_000, body: "old", enc: false, kv: 0 }; old.sig = sign(key, C.postMsg(CH, old));
  msg(owner, "owner", { type: "channel-post", ch: CH, post: old });
  check("уход часов (старый ts) отвергнут", last(owner, "channel-post-ack").error === "clock");
  const encp = { id: "post0006", ts: T, body: "Y2lwaGVy", iv: "aXZpdjEyMzQ1Ng==", enc: true, kv: 1 }; encp.sig = sign(key, C.postMsg(CH, encp));
  msg(owner, "owner", { type: "channel-post", ch: CH, post: encp });
  check("зашифрованный пост принимается как непрозрачный", last(s1, "channel-post").post.enc === true && last(s1, "channel-post").post.kv === 1);
  // история
  for (let i = 0; i < 8; i++) { T += 10; msg(owner, "owner", { type: "channel-post", ch: CH, post: post(CH, key, "bulk" + (1000 + i), "p" + i) }); }
  msg(s1, "s1", { type: "channel-history", ch: CH, since: 0 });
  const h = last(s1, "channel-history");
  check("кольцо истории ограничено (5)", h.posts.length === 5 && h.seq === 10 && h.first === 6);
  msg(s1, "s1", { type: "channel-history", ch: CH, since: 8 });
  check("history since: только новые", last(s1, "channel-history").posts.map((p) => p.seq).join() === "9,10");
  msg(s2, "s2", { type: "channel-history", ch: CH });
  check("история — только подписчикам", last(s2, "channel-history").error === "not-subscribed");
  T += 40 * 86400_000;
  msg(s1, "s1", { type: "channel-history", ch: CH }); check("TTL: старые посты выпали", last(s1, "channel-history").posts.length === 0);
  // мета / удаление
  const m2 = meta(CH, key, { name: "Renamed", ts: T });
  msg(owner, "owner", { type: "channel-meta", ch: CH, ...m2 });
  check("обновление меты владельцем рассылается подписчикам", last(s1, "channel-meta-update") && last(s1, "channel-meta-update").meta.name === "Renamed");
  msg(owner, "owner", { type: "channel-meta", ch: CH, ...meta(CH, evil, { name: "Hacked", ts: T + 5 }) });
  check("мета чужой подписью отвергнута", last(owner, "channel-meta").error === "invalid" && m.channels.get(CH).meta.name === "Renamed");
  // персистентность
  m.save();
  const mode = fs.statSync(file).mode & 0o777;
  check("файл хранилища с правами 0600", mode === 0o600);
  const m2s = mk(file); check("загрузка: канал и подписчики восстановлены", m2s.m.load() === 2 && m2s.m.channels.get(CH).subs.has("s1") && m2s.m.channels.get(CH).seq === 10);
  check("файл без .tmp (атомарная запись)", !fs.existsSync(file + ".tmp"));
  const del = { type: "channel-delete", ch: CH, ts: T, sig: sign(key, C.delMsg(CH, T)) };
  msg(s1, "s1", { ...del, sig: sign(evil, C.delMsg(CH, T)) }); check("удаление чужой подписью отвергнуто", m.channels.has(CH));
  msg(owner, "owner", del); check("удаление владельцем: канал исчез, подписчикам channel-gone", !m.channels.has(CH) && last(s1, "channel-gone"));
  msg(s1, "s1", { type: "channel-subscribe", ch: "nonexistent1234" }); check("подписка на несуществующий", last(s1, "channel-info").error === "not-found");
  msg(s1, "s1", { type: "channel-post", ch: "bad id", post: {} }); check("невалидный id", last(s1, "channel-post-ack").error === "invalid");

  // ---- интеграция с реальным сервером ----
  const WebSocket = require("ws");
  process.env.PORT = "8811"; process.env.MAILBOX_PERSIST = "0"; process.env.VAPID_PUBLIC = ""; process.env.VAPID_PRIVATE = ""; process.env.DATA_DIR = tmp; delete process.env.CHANNEL_HISTORY_MAX;
  require("./server.js");
  await new Promise((r) => setTimeout(r, 400));
  const open = (id) => new Promise((resolve) => { const ws = new WebSocket("ws://localhost:8811"); const ev = []; ws.on("message", (r) => ev.push(JSON.parse(r))); ws.on("open", () => { ws.send(JSON.stringify({ type: "register", id, name: id, visible: true })); setTimeout(() => resolve({ ws, ev, send: (o) => ws.send(JSON.stringify(o)) }), 200); }); });
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const O = await open("owner-x"), S = await open("sub-x");
  check("сервер объявляет возможности channels/gdeliver/sk1", O.ev.some((e) => e.type === "registered" && ["channels", "gdeliver", "sk1"].every((f) => e.features.includes(f))));
  const CH2 = "integr123456abcd", now = Date.now(); T = now;
  const mm = { name: "Live", desc: "", enc: false, ts: now, kv: 0 };
  O.send({ type: "channel-create", ch: CH2, pub: pubOf(key), meta: mm, metaSig: sign(key, C.metaMsg(CH2, mm)) }); await w(150);
  S.send({ type: "channel-subscribe", ch: CH2 }); await w(150);
  const pp = { id: "wsPost0001", ts: now, body: "via-ws", enc: false, kv: 0 }; pp.sig = sign(key, C.postMsg(CH2, pp));
  O.send({ type: "channel-post", ch: CH2, post: pp }); await w(200);
  check("WS: подписчик получил подписанный пост", S.ev.some((e) => e.type === "channel-post" && e.post.body === "via-ws" && e.post.sig === pp.sig));
  S.send({ type: "channel-post", ch: CH2, post: { ...pp, id: "wsPost0002", sig: pp.sig } }); await w(150);
  check("WS: подписчик с чужим постом отвергнут", S.ev.some((e) => e.type === "channel-post-ack" && e.error === "bad-sig"));
  await w(2200);
  check("WS: файл каналов в DATA_DIR создан 0600", fs.existsSync(path.join(tmp, ".ether-channels.json")) && (fs.statSync(path.join(tmp, ".ether-channels.json")).mode & 0o777) === 0o600);
  console.log("\n" + pass + " ok, " + fail + " fail");
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
