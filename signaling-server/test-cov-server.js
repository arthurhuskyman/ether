// Покрытие server.js: чёрный ящик. Сервер запускается как процесс; web-push, dns и http.get подменяются preload-скриптом
// (NODE_OPTIONS=--require), долгие таймеры (5с/2с/30с) в нём ускорены. Всё детерминированно, без внешней сети.
const { spawn } = require("child_process");
const WebSocket = require("ws");
const http = require("http");
const net = require("net");
const zlib = require("zlib");
const fs = require("fs");
const os = require("os");
const path = require("path");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (c) => c.repeat(64);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-cov-"));

// ---- preload: web-push / dns / http.get / ускорение таймеров
const preload = path.join(tmp, "preload.js");
fs.writeFileSync(preload, `
const Module = require("module"); const orig = Module._load;
Module._load = function (req, ...r) {
  if (req === "web-push") return {
    setVapidDetails() { if (process.env.VAPID_BREAK) throw new Error("bad vapid"); },
    async sendNotification(sub, payload, opts) {
      console.log("PUSHCALL " + JSON.stringify({ ep: sub.endpoint, payload: JSON.parse(payload), opts }));
      if (sub.endpoint.includes("gone")) { const e = new Error("gone"); e.statusCode = 410; throw e; }
      if (sub.endpoint.includes("boom")) { const e = new Error("boom"); e.statusCode = 500; throw e; }
    },
  };
  return orig.call(this, req, ...r);
};
const dns = require("dns");
dns.lookup = (h, cb) => {
  if (h === "pub.test") return cb(null, "93.184.216.34", 4);
  if (h === "priv.test") return cb(null, "10.0.0.5", 4);
  if (h === "empty.test") return cb(null, "", 4);
  return cb(new Error("ENOTFOUND"));
};
const http = require("http"); const og = http.get;
http.get = (u, o, cb) => og({ host: "127.0.0.1", port: +process.env.MOCK_PORT, path: u.pathname + u.search, headers: o.headers, timeout: o.timeout }, cb);
const st = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => st(fn, (ms === 5000 || ms === 2000 || (ms > 20000 && ms <= 30000)) ? Math.max(30, Math.round(ms / 40)) : ms, ...a);
`);

// ---- моки: TURN (tcp), HTTP (Cloudflare API + страницы для превью)
let cfHits = 0, cfMode = "ok";
const html = (t) => "<html><head><title>" + t + "</title><meta property=\"og:title\" content=\"" + t + "\"></head><body></body></html>";
const mock = http.createServer((req, res) => {
  const u = req.url;
  if (u.startsWith("/v1/turn/keys/")) {
    cfHits++;
    if (cfMode === "bad") { res.writeHead(500); return res.end("x"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ iceServers: { urls: ["turn:cf.example:3478", "stun:x"], username: "cfu", credential: "cfp" } }));
  }
  if (u === "/ok") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(html("Hello ok")); }
  if (u === "/redir") { res.writeHead(302, { Location: "http://pub.test/ok" }); return res.end(); }
  if (u === "/badloc") { res.writeHead(302, { Location: "http://[bad" }); return res.end(); }
  if (u === "/gz") { res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" }); return res.end(zlib.gzipSync(html("Gz"))); }
  if (u === "/defl") { res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "deflate" }); return res.end(zlib.deflateSync(html("Defl"))); }
  if (u === "/br") { res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "br" }); return res.end(zlib.brotliCompressSync(html("Br"))); }
  if (u === "/json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("{}"); }
  if (u === "/big") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html><body>" + "a".repeat(600 * 1024)); }
  if (u === "/notitle") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html><head></head><body>x</body></html>"); }
  if (u === "/chunk") { res.writeHead(200, { "Content-Type": "text/html" }); res.write("<html><head><ti"); setTimeout(() => res.end("tle>Chunked</title></head>"), 30); return; }
  res.writeHead(404); res.end("nf");
});
const turnSock = net.createServer((s) => s.destroy());
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

let nextPort = 8830;
const procs = [];
process.on("exit", () => procs.forEach((p) => { try { p.kill("SIGKILL"); } catch (e) {} }));
function start(env) {
  const port = nextPort++;
  let out = "";
  const proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, { PORT: String(port), MAILBOX_PERSIST: "0", CLAIMS_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", NODE_OPTIONS: "--require " + preload, MOCK_PORT: String(env.__mock || 0) }, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(proc);
  proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
  return { port, proc, out: () => out };
}
function get(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: (headers && headers.__m) || "GET", headers }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on("error", reject); req.end();
  });
}
async function ready(port) { for (let i = 0; i < 60; i++) { try { await get(port, "/health"); return; } catch (e) { await wait(100); } } throw new Error("нет сервера"); }
let ipN = 1;
function conn(port, reg, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port, { headers: { "x-forwarded-for": "10.9." + (ipN >> 8) + "." + (ipN++ & 255) } });
    const ev = []; ws.on("message", (r) => ev.push(JSON.parse(r))); ws.on("error", reject);
    ws.on("open", async () => {
      if (reg) ws.send(JSON.stringify(Object.assign({ type: "register", id: reg, name: "N" + reg[0], visible: true }, opts)));
      await wait(120); resolve({ ws, ev, send: (o) => ws.send(JSON.stringify(o)) });
    });
  });
}
const types = (c, t) => c.ev.filter((e) => e.type === t);
const env1 = { v: 1, iv: "aXY=", ct: "Y3Q=" };
const subOf = (n) => ({ endpoint: "https://fcm.googleapis.com/fcm/send/" + n, keys: { p256dh: "B".repeat(40), auth: "A".repeat(16) }, expirationTime: 5 });

(async () => {
  const mp = await listen(mock), tp = await listen(turnSock);
  const mailFile = path.join(tmp, "mail.json"), subsFile = path.join(tmp, "subs.json"), claimsFile = path.join(tmp, "claims.json");
  const now = Date.now();
  fs.writeFileSync(mailFile, JSON.stringify({ v: 1, boxes: [[id("q"), [["m-old", { from: id("z"), msgId: "m-old", envelope: env1, kind: "chat", ts: now - 20 * 86400e3 }], ["m-new", { from: id("z"), msgId: "m-new", envelope: env1, kind: "chat", ts: now - 1000 }], [5, {}], ["m-file", { from: id("z"), msgId: "m-file", envelope: env1, kind: "file", ts: now - 10 * 3600e3 }]]], ["bad", "x"]] }));
  fs.writeFileSync(subsFile, JSON.stringify([[id("p"), { subscription: subOf("ok1"), lang: "de" }], [id("o"), subOf("legacy")], [id("n"), { subscription: { endpoint: "http://evil/" } }], ["x"]]));
  fs.writeFileSync(claimsFile, JSON.stringify({ v: 1, claims: [["old-claim", { h: "00", seen: 1 }]] }));

  // ================= HTTP: ICE / CORS / health / 404 / rate-limit / превью =================
  const s1 = start({
    __mock: mp, ALLOWED_ORIGIN: "https://ex.com/path", TURN_STATIC_URL: "turn:127.0.0.1:" + tp, TURN_STATIC_SECRET: "sec",
    TURN_EXTRA_JSON: "var p = new Peer({config:{iceServers:[{urls:'turns:h.example:443',username:'u',credential:'c'},]}});",
    CF_TURN_KEY_ID: "K", CF_TURN_API_TOKEN: "T", CF_TURN_API_BASE: "http://127.0.0.1:" + mp,
    MAILBOX_PERSIST: "1", MAILBOX_FILE: mailFile, PUSH_SUBS_FILE: subsFile, CLAIMS_PERSIST: "1", CLAIMS_FILE: claimsFile,
    VAPID_PUBLIC: "pub", VAPID_PRIVATE: "priv", MAILBOX_MAX_PER_USER: "3", MAILBOX_MAX_TOTAL_ENTRIES: "40", REGISTER_DEADLINE_MS: "400", MAX_SOCKETS_PER_IP: "3",
  });
  await ready(s1.port);
  const P = s1.port;
  let r = await get(P, "/", { __m: "OPTIONS" }); check("OPTIONS → 204 + CORS", r.status === 204 && r.headers["access-control-allow-origin"] === "https://ex.com/path");
  r = await get(P, "/health"); check("/health 200", r.status === 200 && /relay OK/.test(r.body));
  r = await get(P, "/nope"); check("неизвестный путь → 404", r.status === 404);
  r = await get(P, "/ice?x=1"); let ice = JSON.parse(r.body);
  check("/ice отдаёт TURN из секрета + Cloudflare + extra + STUN", r.status === 200 && ice.some((s) => JSON.stringify(s.urls).includes("127.0.0.1:" + tp)) && ice.some((s) => s.username === "cfu") && ice.some((s) => JSON.stringify(s.urls).includes("h.example")) && ice.some((s) => JSON.stringify(s.urls).includes("stun:")));
  check("/ice: cache-control и повторный ответ из кеша", r.headers["cache-control"].includes("max-age") && (await get(P, "/ice")).status === 200 && cfHits === 1);
  check("в логе: claims/mailbox/push восстановлены, ALLOWED_ORIGIN с путём — предупреждение", /восстановлено подписок: 2/.test(s1.out()) && /\[mailbox\] восстановлено/.test(s1.out()) && /содержит путь/.test(s1.out()) && /\[claims\] восстановлено/.test(s1.out()));
  // превью
  r = await get(P, "/link-preview"); check("превью без url → 400", r.status === 400);
  r = await get(P, "/link-preview?url=" + encodeURIComponent("ftp://pub.test/x")); check("превью: схема ftp запрещена → 204", r.status === 204);
  r = await get(P, "/link-preview?url=" + encodeURIComponent("http://priv.test/ok")); check("превью: приватный адрес → 204", r.status === 204 && /private address blocked/.test(s1.out()));
  r = await get(P, "/link-preview?url=" + encodeURIComponent("http://nx.test/ok")); check("превью: DNS-ошибка → 204", r.status === 204);
  r = await get(P, "/link-preview?url=" + encodeURIComponent("http://empty.test/ok")); check("превью: пустой адрес → 204", r.status === 204 && /no address/.test(s1.out()));
  r = await get(P, "/link-preview?url=" + encodeURIComponent("not a url")); check("превью: мусорный url → 204", r.status === 204);
  for (const [p, t] of [["ok", "Hello ok"], ["redir", "Hello ok"], ["gz", "Gz"], ["defl", "Defl"], ["br", "Br"], ["chunk", "Chunked"]]) {
    r = await get(P, "/link-preview?url=" + encodeURIComponent("http://pub.test/" + p));
    check("превью /" + p + " → " + t, r.status === 200 && r.body.includes(t));
  }
  r = await get(P, "/link-preview?url=" + encodeURIComponent("http://pub.test/ok")); check("превью из кеша → 200", r.status === 200);
  for (const p of ["json", "big", "404", "badloc", "notitle"]) { r = await get(P, "/link-preview?url=" + encodeURIComponent("http://pub.test/" + p)); check("превью /" + p + " → 204 (отказ кешируется)", r.status === 204); }
  r = await get(P, "/link-preview?url=" + encodeURIComponent("http://pub.test/json")); check("негативный кеш: повтор → 204", r.status === 204);
  let limited = false; for (let i = 0; i < 40 && !limited; i++) limited = (await get(P, "/link-preview?url=" + encodeURIComponent("http://pub.test/ok"))).status === 429;
  check("превью: 429 при превышении лимита", limited);
  limited = false; for (let i = 0; i < 30 && !limited; i++) limited = (await get(P, "/ice")).status === 429;
  check("/ice: 429 при превышении лимита", limited);

  // ================= WebSocket =================
  const raw = await conn(P, null);
  raw.ws.send("не json"); raw.send({ nope: 1 }); raw.send(null); raw.send({ type: "signal", to: id("a"), data: {} }); raw.send({ type: "watch", ids: [] });
  raw.send({ type: "ping", t: 7 }); await wait(100);
  check("ping → pong с тем же t; мусор и сообщения без регистрации игнорируются", types(raw, "pong").length === 1 && types(raw, "pong")[0].t === 7 && raw.ev.length === 1);
  await wait(450);
  check("незарегистрированный сокет закрыт по дедлайну", raw.ws.readyState === WebSocket.CLOSED || raw.ws.readyState === WebSocket.CLOSING);
  const codes = [];
  const socks = [];
  for (let i = 0; i < 5; i++) { const w = new WebSocket("ws://127.0.0.1:" + P, { headers: { "x-forwarded-for": "10.77.0.1" } }); w.on("error", () => {}); w.on("close", (c) => codes.push(c)); socks.push(w); await wait(80); }
  await wait(200);
  check("лимит сокетов на IP: лишние закрываются кодом 1013", codes.filter((c) => c === 1013).length === 2);
  socks.forEach((w) => { try { w.terminate(); } catch (e) {} });

  const A = await conn(P, id("a"), { claim: "c".repeat(64), publicKey: { kty: "EC", x: "1" }, caps: ["env2", "BAD CAP!", 5] });
  const B = await conn(P, id("b"), { visible: false, watch: [id("a"), 7, ""] });
  const Q = await conn(P, id("q"));
  const reg = types(A, "registered")[0];
  check("registered: features, vapid-key, claimed", reg && reg.features.includes("env2") && reg.claimed === true && types(A, "vapid-key")[0].key === "pub");
  check("офлайн-ящик с диска: свежие доставлены, просроченные нет", types(Q, "deliver").map((d) => d.msgId).sort().join() === "m-file,m-new");
  Q.send({ type: "mailbox-ack", msgId: "m-new" }); Q.send({ type: "mailbox-ack", msgId: "zzz" }); Q.send({ type: "mailbox-ack", msgId: 5 });
  const Cx = await conn(P, id("a"), { claim: "d".repeat(64) });
  check("чужой claim: register-error id-claimed", types(Cx, "register-error").length === 1);
  const Cy = await conn(P, id("a")); check("без claim занять защищённый id нельзя", types(Cy, "register-error").length === 1);
  const L = await conn(P, "x".repeat(129)); check("register с id >128 игнорируется", L.ev.length === 0);
  L.ws.close();
  B.send({ type: "register", id: id("b2"), name: "second" }); await wait(150);
  check("повторный register с другим id на том же сокете", types(B, "registered").length === 2);
  const B1 = await conn(P, id("g"));
  const B1dup = await conn(P, id("g")); await wait(100);
  check("вытеснение: старый получает replaced", types(B1, "replaced").length === 1);
  A.send({ type: "signal", to: "y".repeat(64), data: { t: "offer" } }); await wait(80);
  check("signal на незнакомого → unreachable", types(A, "unreachable").length === 1 || console.log(JSON.stringify(A.ev.map(e=>e.type))));
  A.send({ type: "signal", to: id("g"), data: { t: "offer" } }); await wait(80);
  check("signal доставляется", types(B1dup, "signal").length === 1 && types(B1dup, "signal")[0].from === id("a"));
  const D = await conn(P, id("d"));
  D.send({ type: "push-subscribe", subscription: { endpoint: "http://evil" } }); D.send({ type: "push-subscribe", subscription: subOf("gone-d"), lang: "ru_RU" }); await wait(100);
  check("push-subscribe: невалидная → error, валидная → subscribed", types(D, "push-subscribe-error").length === 1 && types(D, "push-subscribed").length === 1);
  D.ws.close(); await wait(100);
  A.send({ type: "signal", to: id("d"), data: { t: "call-invite", x: "n1" } }); await wait(250);
  check("call-invite → force-push (urgency high) получателю", /PUSHCALL.*gone-d/.test(s1.out()) && /"urgency":"high"/.test(s1.out()));
  A.send({ type: "signal", to: id("d"), data: { t: "call-invite", x: "n1" } });
  A.send({ type: "signal", to: id("d"), data: { t: "call-invite", x: "n2" } }); await wait(150);
  check("повторный invite (тот же x) и частый invite не шлют лишних push", (s1.out().match(/PUSHCALL.*gone-d/g) || []).length === 1 && /throttled/.test(s1.out()));
  const ack = async (o) => { const n = types(A, "deliver-ack").length; A.send(Object.assign({ type: "deliver", to: id("g"), msgId: "m" + Math.random() }, o)); await wait(70); return types(A, "deliver-ack").slice(n)[0]; };
  check("deliver: нет envelope → invalid-envelope", (await ack({ envelope: null })).error === "invalid-envelope");
  check("deliver: v2 с кривым h → invalid-envelope", (await ack({ envelope: { v: 2, h: { d: ["a"], pn: 0, n: 0 }, ct: "x" } })).error === "invalid-envelope");
  check("deliver: v2 с неверным pn → invalid", (await ack({ envelope: { v: 2, h: { d: ["a", "b"], pn: -1, n: 0 }, ct: "x" } })).error === "invalid-envelope");
  check("deliver: v2 с огромным p → invalid", (await ack({ envelope: { v: 2, h: { d: ["a", "b"], pn: 0, n: 0, p: "x".repeat(500) }, ct: "x" } })).error === "invalid-envelope");
  check("deliver: огромный i → invalid-envelope", (await ack({ envelope: { v: 2, h: { d: ["a", "b"], pn: 0, n: 0, i: "x".repeat(500) }, ct: "x" } })).error === "invalid-envelope");
  check("deliver: fromPublicKey массив → invalid", (await ack({ envelope: env1, fromPublicKey: [1] })).error === "invalid-envelope");
  check("deliver: огромный fromPublicKey → invalid", (await ack({ envelope: env1, fromPublicKey: { k: "x".repeat(2000) } })).error === "invalid-envelope");
  const v2 = { v: 2, h: { d: ["xx", "yy"], pn: 1, n: 2, i: { a: 1 }, p: { b: 2 } }, ct: "ct", rc: 1, e2: true, extra: "drop" };
  const okAck = await ack({ envelope: v2, fromPublicKey: { kty: "EC" }, kind: "file" });
  const got = types(B1dup, "deliver").pop();
  check("deliver v2: ack без ошибки, лишние поля отброшены, h/rc/e2 сохранены", okAck && !okAck.error && got && got.envelope.extra === undefined && got.envelope.h.i.a === 1 && got.envelope.rc === 1 && got.envelope.e2 === true);
  A.send({ type: "deliver", to: id("a"), msgId: "self", envelope: env1 }); await wait(60);
  check("deliver самому себе молча отбрасывается", !types(A, "deliver-ack").some((x) => x.msgId === "self"));
  for (let i = 0; i < 6; i++) A.send({ type: "deliver", to: id("m"), msgId: "box" + i, envelope: { v: "1", iv: "i", ct: "c" } });
  await wait(150);
  const M = await conn(P, id("m"));
  check("потолок ящика на получателя: остаются 3 последних", types(M, "deliver").map((d) => d.msgId).join() === "box3,box4,box5");
  const E = await conn(P, id("e")); E.send({ type: "push-subscribe", subscription: subOf("boom-e"), lang: "fr" }); await wait(80); E.ws.close(); await wait(100);
  for (let i = 0; i < 3; i++) A.send({ type: "deliver", to: id("e"), msgId: "chat" + i, envelope: env1, kind: "chat" });
  await wait(400);
  check("chat-deliver офлайн → push (500 логируется, процесс жив)", /PUSHCALL.*boom-e/.test(s1.out()) && /ошибка отправки: 500/.test(s1.out()));
  await wait(1000);
  check("push после троттлинга (агрегированный)", (s1.out().match(/PUSHCALL.*boom-e/g) || []).length >= 1);
  const E2 = await conn(P, id("e")); check("при входе получателя очередь доставлена", types(E2, "deliver").length === 3);
  E2.send({ type: "push-unsubscribe" }); await wait(80); check("push-unsubscribe", types(E2, "push-unsubscribed").length === 1);
  for (let i = 0; i < 12; i++) E2.send({ type: "push-subscribe", subscription: subOf("rl" + i) }); await wait(150);
  check("push-subscribe: rate-limit 10/мин", types(E2, "push-subscribed").length === 9 || console.log(JSON.stringify(E2.ev.map(e=>e.type+(e.error||"")))));
  const K = await conn(P, id("k"));
  const pub = ["a".repeat(24), "b".repeat(24)];
  K.send({ type: "prekey-upload", spk: { id: "s1", pub: "bad" } });
  K.send({ type: "prekey-upload", spk: { id: "s1", pub, sig: 5 } });
  K.send({ type: "prekey-upload", opks: [{ id: "o0", pub: 1 }] });
  K.send({ type: "prekey-upload", spk: { id: "s1", pub, sig: "s" }, opks: [{ id: "o1", pub }, { id: "o2", pub }] }); await wait(120);
  check("prekey-upload", types(K, "prekey-stored").filter((x) => x.error === "invalid").length === 3 && types(K, "prekey-stored").pop().count === 2 || console.log(JSON.stringify(K.ev)));
  const F = await conn(P, id("f"));
  F.send({ type: "prekey-fetch", to: id("k"), rid: "r1" }); F.send({ type: "prekey-fetch", to: id("k"), rid: "r2" }); F.send({ type: "prekey-fetch", to: "w".repeat(64), rid: "r3" }); await wait(150);
  const bun = types(F, "prekey-bundle"); 
  check("prekey-fetch: spk + одноразовый opk; owner получает prekey-low; пусто для чужого", bun[0].opk && bun[0].spk.id === "s1" && types(K, "prekey-low").length >= 1 && bun[2].spk === null && bun[2].opk === null);
  for (let i = 0; i < 14; i++) F.send({ type: "prekey-fetch", to: id("k"), rid: "x" + i }); await wait(200);
  check("prekey-fetch: лимит по паре → error rate", types(F, "prekey-bundle").some((b) => b.error === "rate"));
  A.send({ type: "watch", ids: [id("k"), "y".repeat(200), 5] }); await wait(100);
  check("watch-result", types(A, "watch-result").length === 1);
  A.send({ type: "deliver", to: id("zz"), msgId: "persist1", envelope: env1, kind: "file" }); await wait(200);

  // ================= shutdown: сохранение файлов =================
  s1.proc.kill("SIGTERM");
  const code = await new Promise((res) => s1.proc.on("exit", res));
  check("SIGTERM: корректное завершение (код 0)", code === 0 && /Завершаем работу/.test(s1.out()));
  const mailSaved = JSON.parse(fs.readFileSync(mailFile, "utf8"));
  check("shutdown: ящик сохранён (без просроченных)", mailSaved.v === 1 && JSON.stringify(mailSaved).includes("persist1") && !JSON.stringify(mailSaved).includes("m-old"));
  check("shutdown: подписки и claims сохранены", fs.readFileSync(subsFile, "utf8").includes("send/rl8") && fs.readFileSync(claimsFile, "utf8").includes(id("a")));

  // ================= S2: битые файлы, отказ Cloudflare, недоступный TURN, STRICT_ROSTER =================
  fs.writeFileSync(mailFile, "{broken"); fs.writeFileSync(subsFile, "{broken"); fs.writeFileSync(claimsFile, "{broken");
  cfMode = "bad";
  const s2 = start({
    __mock: mp, CF_TURN_KEY_ID: "K", CF_TURN_API_TOKEN: "T", CF_TURN_API_BASE: "http://127.0.0.1:" + mp,
    TURN_STATIC_URL: "turn:127.0.0.1:1", TURN_STATIC_USERNAME: "u", TURN_STATIC_PASSWORD: "p", TURN_EXTRA_JSON: "[{{",
    MAILBOX_PERSIST: "1", MAILBOX_FILE: mailFile, PUSH_SUBS_FILE: subsFile, CLAIMS_PERSIST: "1", CLAIMS_FILE: claimsFile, ALLOWED_ORIGIN: "*",
    TRUST_PROXY: "0", STRICT_ROSTER: "1",
  });
  await ready(s2.port);
  r = await get(s2.port, "/ice"); ice = JSON.parse(r.body);
  check("S2: TURN недоступен → только STUN, лог о недоступности", r.status === 200 && ice.every((s) => !JSON.stringify(s.urls).includes("turn:127.0.0.1")) && /НЕДОСТУПЕН/.test(s2.out()));
  check("S2: битые файлы состояния не роняют сервер", /не удалось прочитать файл подписок/.test(s2.out()) && /не удалось прочитать файл ящика/.test(s2.out()) && /\[claims\] не удалось прочитать/.test(s2.out()));
  check("S2: Cloudflare 500 и кривой TURN_EXTRA_JSON — предупреждения", /Cloudflare TURN недоступен/.test(s2.out()) && /TURN_EXTRA_JSON не разобран/.test(s2.out()) && /ALLOWED_ORIGIN не задан/.test(s2.out()));
  check("S2: без VAPID push выключен", /Web Push не настроен/.test(s2.out()));
  const S = await conn(s2.port, id("s")); await conn(s2.port, id("t"), { visible: false });
  S.send({ type: "push-subscribe", subscription: subOf("zz") }); S.send({ type: "signal", to: id("t"), data: { t: "call-invite", x: "q" } }); await wait(150);
  check("S2: STRICT_ROSTER и TRUST_PROXY=0: регистрация работает, push без VAPID — no-op, скрытый недостижим", types(S, "registered").length === 1 && types(S, "vapid-key").length === 0 && types(S, "unreachable").length === 1);
  s2.proc.kill("SIGINT"); await new Promise((res) => s2.proc.on("exit", res));

  // ================= S3: статический TURN (user/pass), сломанный VAPID =================
  const s3 = start({ __mock: mp, TURN_STATIC_URL: "turn:127.0.0.1:" + tp, TURN_STATIC_USERNAME: "u", TURN_STATIC_PASSWORD: "p", VAPID_PUBLIC: "a", VAPID_PRIVATE: "b", VAPID_BREAK: "1", APP_BASE_URL: "https://x.example/app/", ALLOWED_ORIGIN: "https://ex.com" });
  await ready(s3.port);
  ice = JSON.parse((await get(s3.port, "/ice")).body);
  check("S3: статический TURN (user/pass), ошибка VAPID не роняет сервер", ice[0].username === "u" && /не удалось инициализировать VAPID/.test(s3.out()) && /устаревший способ/.test(s3.out()));
  s3.proc.kill("SIGTERM"); await new Promise((res) => s3.proc.on("exit", res));

  mock.close(); turnSock.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
