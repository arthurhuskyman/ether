// Серия «гудков» (web-push мок), отмена, /push-ack (токен, повтор, подделка), call-ringing один раз, лимиты, удержание приглашения, push-test-ring.
const WebSocket = require("ws"); const http = require("http");
const tmp = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "ether-rings-"));
process.env.DATA_DIR = tmp; process.env.PUSH_SUBS_FILE = tmp + "/push.json";
process.env.PORT = "8812"; process.env.MAILBOX_PERSIST = "0"; process.env.TRUST_PROXY = "1"; // у каждого клиента свой «IP» через X-Forwarded-For: иначе лимит register 15/мин на IP мешает тесту
let ipN = 0;
process.env.VAPID_PUBLIC = "BPubKeyForMockOnly"; process.env.VAPID_PRIVATE = "privForMockOnly";
process.env.RING_INTERVAL_MS = "120"; process.env.RING_HOLD_MS = "1500"; process.env.RING_ONLINE_GRACE_MS = "300";
process.env.RING_PAIR_MS = "700"; process.env.CALL_PUSH_PER_IP_PER_MIN = "100"; process.env.PUSH_ACK_PER_IP_PER_MIN = "12";
process.env.ALLOWED_ORIGIN = "https://app.example"; process.env.APP_BASE_URL = "https://app.example/ether";
const pushed = [];
require.cache[require.resolve("web-push")] = { id: "web-push", filename: "web-push", loaded: true, exports: { setVapidDetails() {}, sendNotification: async (sub, body, opts) => { pushed.push({ sub, body: JSON.parse(body), opts }); } } };
require("./server.js");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (c) => c.repeat(64);
const subOf = (n) => ({ endpoint: "https://fcm.googleapis.com/fcm/send/" + n, keys: { p256dh: "B".repeat(30), auth: "a".repeat(12) } });
function open(first) { return new Promise((resolve) => { const ws = new WebSocket("ws://localhost:8812", { headers: { "X-Forwarded-For": "10.1." + Math.floor(++ipN / 250) + "." + (ipN % 250) } }); const ev = []; ws.on("message", (r) => ev.push(JSON.parse(r))); ws.on("open", () => { ws.send(JSON.stringify(first)); setTimeout(() => resolve({ ws, ev, send: (o) => ws.send(JSON.stringify(o)) }), 150); }); }); }
const reg = (c, name) => open({ type: "register", id: id(c), name: name || c });
function post(body, headers) { return new Promise((resolve) => { const data = typeof body === "string" ? body : JSON.stringify(body); const r = http.request({ host: "localhost", port: 8812, path: "/push-ack", method: "POST", headers: Object.assign({ "X-Forwarded-For": "10.9.9.9", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }, headers) }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }); r.end(data); }); }
const forSub = (n) => pushed.filter((p) => p.sub.endpoint.endsWith("/" + n));
const rings = (n) => forSub(n).filter((p) => p.body.t === "call-ring");
const cancels = (n) => forSub(n).filter((p) => p.body.t === "call-cancel");
async function offlineWithSub(c) { const R = await reg(c); R.send({ type: "push-subscribe", subscription: subOf("sub-" + c), lang: "en" }); await wait(100); R.ws.close(); await wait(100); }
const inv = (A, to, callId, extra) => A.send({ type: "signal", to: id(to), data: Object.assign({ t: "call-invite", callId }, extra) });

(async () => {
  await wait(400);
  console.log("\n=== серия гудков ===");
  const A = await reg("a", "Alice");
  await offlineWithSub("b");
  inv(A, "b", "callAAAA1111", { video: true }); await wait(60);
  check("push #1 уходит сразу", rings("sub-b").length === 1);
  const r1 = rings("sub-b")[0];
  check("payload call-ring: callId/from/name/seq/total/video/ackToken", r1.body.callId === "callAAAA1111" && r1.body.from === id("a") && r1.body.name === "Alice" && r1.body.seq === 1 && r1.body.total === 6 && r1.body.video === true && typeof r1.body.ackToken === "string");
  check("заголовки: urgency high, TTL 30, topic ring-<id8>-<seq>", r1.opts.urgency === "high" && r1.opts.TTL === 30 && r1.opts.topic === "ring-callAAAA-1");
  await wait(900);
  check("серия не больше 6", rings("sub-b").length === 6);
  check("topic разный на каждый push", new Set(rings("sub-b").map((p) => p.opts.topic)).size === 6);
  await wait(900);
  check("по истечении 45с (RING_HOLD) уходит cancel push reason=timeout", cancels("sub-b").length === 1 && cancels("sub-b")[0].body.reason === "timeout" && cancels("sub-b")[0].body.callId === "callAAAA1111");

  console.log("\n=== остановка: отмена звонящим ===");
  await offlineWithSub("c");
  await wait(750); // окно пары (700 мс)
  inv(A, "c", "callCCCC1111"); await wait(300);
  const nBefore = rings("sub-c").length;
  A.send({ type: "signal", to: id("c"), data: { t: "call-ended" } }); await wait(400);
  check("после call-ended новые гудки не идут", rings("sub-c").length === nBefore && nBefore >= 2);
  check("cancel push reason=cancelled", cancels("sub-c").length === 1 && cancels("sub-c")[0].body.reason === "cancelled");

  console.log("\n=== остановка: дисконнект звонящего ===");
  await offlineWithSub("d");
  const A2 = await reg("e", "Eve"); inv(A2, "d", "callDDDD1111"); await wait(250);
  A2.ws.close(); await wait(300);
  const nd = rings("sub-d").length;
  await wait(400);
  check("после дисконнекта звонящего серия остановлена + cancelled", rings("sub-d").length === nd && cancels("sub-d").length === 1 && cancels("sub-d")[0].body.reason === "cancelled");

  console.log("\n=== приглашение держится и отдаётся при регистрации; остановка по accept ===");
  const F = await reg("f", "Fred"); await offlineWithSub("g");
  inv(F, "g", "callGGGG1111"); await wait(200);
  const G = await reg("g");
  const got = G.ev.find((e) => e.type === "signal" && e.data && e.data.t === "call-invite");
  check("отложенное приглашение доставлено при регистрации", !!got && got.from === id("f") && got.data.callId === "callGGGG1111");
  const ng = rings("sub-g").length; await wait(400);
  check("после доставки сокету серия остановлена", rings("sub-g").length === ng);
  check("тихо: cancel push не нужен после доставки", cancels("sub-g").length === 0);
  const H = await reg("h", "Hal"); await offlineWithSub("i");
  inv(H, "i", "callHHHH1111"); await wait(250);
  const I = await reg("i");
  H.send({ type: "signal", to: id("i"), data: { t: "call-invite", callId: "callHHHH1111" } });
  I.send({ type: "signal", to: id("h"), data: { t: "call-accepted" } }); await wait(100);
  check("invite доставлен при регистрации", I.ev.some((e) => e.type === "signal" && e.data.t === "call-invite"));

  console.log("\n=== остановка: accept/decline при офлайн-режиме (ответ с другого сокета) ===");
  await offlineWithSub("j"); await offlineWithSub("k");
  const K1 = await reg("k", "K"); void K1;
  const J = await reg("j"); J.ws.close(); await wait(100); // j офлайн
  const L = await reg("l", "Lee"); await offlineWithSub("m");
  inv(L, "m", "callMMMM1111"); await wait(250);
  // m «отвечает» с другого устройства: симулируем сигнал от m звонящему (m регистрируется и принимает → invite доставлен → стоп)
  const M = await reg("m"); const nm = rings("sub-m").length; await wait(350);
  check("регистрация получателя останавливает серию", rings("sub-m").length === nm);
  M.send({ type: "signal", to: id("l"), data: { t: "call-declined" } });

  console.log("\n=== онлайн-получатель: call-invite-ack отменяет серию, без ack — гудки после grace ===");
  const O = await reg("o", "Ollie"); O.send({ type: "push-subscribe", subscription: subOf("sub-o") }); await wait(100);
  const P = await reg("p", "Pat"); P.send({ type: "push-subscribe", subscription: subOf("sub-p") }); await wait(100);
  const Q = await reg("q", "Q");
  inv(Q, "o", "callOOOO1111"); await wait(60);
  O.send({ type: "signal", to: id("q"), data: { t: "call-invite-ack" } }); await wait(600);
  check("онлайн + ack: push не уходят", rings("sub-o").length === 0);
  inv(Q, "p", "callPPPP1111"); await wait(150);
  check("онлайн без ack: до grace push нет", rings("sub-p").length === 0);
  await wait(400);
  check("онлайн без ack: после grace гудки идут (зомби-сокет)", rings("sub-p").length >= 1);
  Q.send({ type: "signal", to: id("p"), data: { t: "call-ended" } });

  console.log("\n=== лимиты ===");
  await wait(800);
  const S = await reg("s", "S"), S2 = await reg("t", "T");
  await offlineWithSub("u");
  inv(S, "u", "callSSSS0001"); await wait(60);
  inv(S, "u", "callSSSS0002"); await wait(60);
  check("1 звонок на пару за RING_PAIR_MS: повтор молча отброшен", new Set(rings("sub-u").map((p) => p.body.callId)).size === 1);
  S.send({ type: "signal", to: id("u"), data: { t: "call-ended" } });
  inv(S2, "u", "callTTTT0001"); await wait(60);
  S2.send({ type: "signal", to: id("u"), data: { t: "call-ended" } });
  const S3 = await reg("v", "V"); inv(S3, "u", "callVVVV0001"); await wait(60);
  S3.send({ type: "signal", to: id("u"), data: { t: "call-ended" } });
  const S4 = await reg("w", "W"); inv(S4, "u", "callWWWW0001"); await wait(60);
  check("не более 3 звонков в минуту получателю (4-й отброшен)", new Set(rings("sub-u").map((p) => p.body.callId)).size === 3);
  S4.send({ type: "signal", to: id("u"), data: { t: "call-ended" } });
  await offlineWithSub("x1"); await offlineWithSub("x2");
  // нет подписки у получателя и он онлайн — push не планируется
  const Y = await reg("y"); const cnt = pushed.length; inv(S, "y", "callYYYY0001"); await wait(100);
  check("онлайн-получатель без подписки: push нет", pushed.length === cnt); void Y;

  console.log("\n=== /push-ack ===");
  const W = await reg("z", "Zed"); await offlineWithSub("ack");
  const R = await reg("r", "Rita"); R.send({ type: "push-subscribe", subscription: subOf("sub-r") }); await wait(80); R.ws.close(); await wait(100);
  inv(W, "r", "callRRRR0001"); await wait(300);
  const rr = rings("sub-r"); const t1 = rr[0].body.ackToken;
  const ok1 = await post({ callId: "callRRRR0001", seq: 1, ackToken: t1 }, { Origin: "https://app.example" });
  check("валидный токен: 200 и CORS для origin приложения", ok1.status === 200 && ok1.headers["access-control-allow-origin"] === "https://app.example");
  await wait(80);
  check("звонящему пришёл call-ringing", W.ev.filter((e) => e.type === "call-ringing" && e.callId === "callRRRR0001").length === 1);
  const rep = await post({ callId: "callRRRR0001", seq: 1, ackToken: t1 });
  await wait(60);
  check("повтор токена не действует (одноразовый)", rep.status === 200 && JSON.parse(rep.body).dup === true);
  const ok2 = await post({ callId: "callRRRR0001", seq: 2, ackToken: rr[1].body.ackToken });
  await wait(60);
  check("следующий seq принят, но call-ringing всё равно ровно один", ok2.status === 200 && W.ev.filter((e) => e.type === "call-ringing").length === 1);
  check("подделка токена → 403", (await post({ callId: "callRRRR0001", seq: 3, ackToken: "AAAA" + t1.slice(4) })).status === 403);
  check("токен от другого seq → 403", (await post({ callId: "callRRRR0001", seq: 4, ackToken: t1 })).status === 403);
  check("неизвестный callId → 403", (await post({ callId: "nope1234", seq: 1, ackToken: t1 })).status === 403);
  check("мусорное тело → 403", (await post("{bad", {})).status === 403);
  check("чужой origin → 403", (await post({ callId: "callRRRR0001", seq: 1, ackToken: t1 }, { Origin: "https://evil.example" })).status === 403);
  const pre = await new Promise((res) => { const r = http.request({ host: "localhost", port: 8812, path: "/push-ack", method: "OPTIONS", headers: { Origin: "https://app.example" } }, (x) => { x.resume(); res(x); }); r.end(); });
  check("preflight для origin приложения → 204 с Allow-Origin", pre.statusCode === 204 && pre.headers["access-control-allow-origin"] === "https://app.example");
  let limited = false; for (let i = 0; i < 20; i++) if ((await post({ callId: "x", seq: 1, ackToken: "y" })).status === 429) limited = true;
  check("rate-limit по IP → 429", limited);
  W.send({ type: "signal", to: id("r"), data: { t: "call-ended" } });

  console.log("\n=== push-test-ring ===");
  const T = await reg("tt", "Tester");
  T.send({ type: "push-test-ring" }); await wait(100);
  check("без подписки: push-test-error nosub", T.ev.some((e) => e.type === "push-test-error" && e.reason === "nosub"));
  T.send({ type: "push-subscribe", subscription: subOf("sub-tt") }); await wait(100);
  T.send({ type: "push-test-ring" }); await wait(500);
  const tr = rings("sub-tt");
  check("3 гудка с callId test-…", tr.length === 3 && tr.every((p) => p.body.callId.startsWith("test-")) && tr[0].body.total === 3);
  check("push-test-started получен", T.ev.some((e) => e.type === "push-test-started" && e.total === 3));
  await post({ callId: tr[0].body.callId, seq: 1, ackToken: tr[0].body.ackToken }, { "X-Forwarded-For": "10.9.9.8" });
  await wait(80);
  check("ack теста: call-ringing самому клиенту", T.ev.some((e) => e.type === "call-ringing" && e.callId === tr[0].body.callId));
  check("cancel push для теста не шлётся", cancels("sub-tt").length === 0);
  T.send({ type: "push-test-ring" }); T.send({ type: "push-test-ring" }); T.send({ type: "push-test-ring" }); await wait(100);
  check("лимит тестов в минуту", T.ev.some((e) => e.type === "push-test-error" && e.reason === "ratelimit"));
  const U = await open({ type: "push-test-ring" }); await wait(100);
  check("незарегистрированный push-test-ring игнорируется", U.ev.length === 0);

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})();
