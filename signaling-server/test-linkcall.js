// Звонок по ссылке (раздел E протокола): комнаты, код, гость без регистрации, ретрансляция сигналов только внутри комнаты, лимиты, закрытие.
const WebSocket = require("ws");
const tmp = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "ether-lc-"));
process.env.DATA_DIR = tmp; process.env.PUSH_SUBS_FILE = tmp + "/push.json";
process.env.PORT = "8813"; process.env.MAILBOX_PERSIST = "0"; process.env.TRUST_PROXY = "1";
process.env.LINKCALL_TTL_MS = "900"; process.env.REGISTER_DEADLINE_MS = "400";
require("./server.js");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (c) => c.repeat(64);
function open(ip, first) { return new Promise((resolve) => { const ws = new WebSocket("ws://localhost:8813", { headers: { "X-Forwarded-For": ip } }); const ev = []; let closed = false; ws.on("close", () => (closed = true)); ws.on("message", (r) => ev.push(JSON.parse(r))); ws.on("open", () => { if (first) ws.send(JSON.stringify(first)); setTimeout(() => resolve({ ws, ev, isClosed: () => closed, send: (o) => ws.send(JSON.stringify(o)) }), 120); }); }); }
const reg = (c, ip) => open(ip || "10.2.0." + c.charCodeAt(0), { type: "register", id: id(c), name: c });
const last = (c, t) => c.ev.filter((e) => e.type === t).pop();
async function room(A) { A.send({ type: "linkcall-create" }); await wait(80); return last(A, "linkcall-created"); }

(async () => {
  await wait(400);
  console.log("\n=== создание и вход по ссылке ===");
  const A = await reg("a");
  const R = await room(A);
  check("linkcall-created: room 128 бит base64url, code 6 цифр, expiresAt", R && /^[A-Za-z0-9_-]{22}$/.test(R.room) && /^\d{6}$/.test(R.code) && R.expiresAt > Date.now());
  const G = await open("10.3.0.1");
  G.send({ type: "linkcall-join", room: R.room, name: "Гость" }); await wait(100);
  check("гость (НЕзарегистрированный) получил linkcall-joined", !!last(G, "linkcall-joined"));
  const gev = last(A, "linkcall-guest");
  check("создатель получил linkcall-guest {guestRef, name, viaCode:false}", gev && gev.room === R.room && gev.name === "Гость" && gev.viaCode === false && gev.guestRef);
  A.send({ type: "linkcall-allow", room: R.room, guestRef: "bad" }); await wait(60);
  check("allow с чужим guestRef игнорируется", !last(G, "linkcall-allowed"));
  A.send({ type: "linkcall-allow", room: R.room, guestRef: gev.guestRef }); await wait(80);
  check("allow → гость получает linkcall-allowed", !!last(G, "linkcall-allowed"));
  await wait(1100);
  check("гость не закрыт таймаутом регистрации, TTL комнаты после входа не действует", !G.isClosed() && !last(A, "linkcall-end"));
  G.send({ type: "linkcall-signal", room: R.room, data: { sdp: "offer" } }); A.send({ type: "linkcall-signal", room: R.room, data: { sdp: "answer" } }); await wait(80);
  check("сигналы ретранслируются в обе стороны", last(A, "linkcall-signal").data.sdp === "offer" && last(G, "linkcall-signal").data.sdp === "answer");

  console.log("\n=== изоляция ===");
  const X = await open("10.3.0.2"); const Z = await reg("z");
  X.send({ type: "linkcall-signal", room: R.room, data: { evil: 1 } }); Z.send({ type: "linkcall-signal", room: R.room, data: { evil: 2 } });
  X.send({ type: "linkcall-end", room: R.room }); Z.send({ type: "linkcall-end", room: R.room }); await wait(100);
  check("третий сокет (и зарегистрированный тоже) не может вставить signal/end", !A.ev.concat(G.ev).some((e) => e.data && e.data.evil) && !last(A, "linkcall-end"));
  X.send({ type: "linkcall-join", room: R.room }); await wait(80);
  check("второй гость → full", last(X, "linkcall-error").reason === "full");
  X.send({ type: "linkcall-allow", room: R.room, guestRef: gev.guestRef }); X.send({ type: "linkcall-create" }); X.send({ type: "signal", to: id("a"), data: { t: "offer" } }); X.send({ type: "deliver", to: id("a"), msgId: "m1", envelope: {} }); X.send({ type: "watch", ids: [id("a")] }); await wait(100);
  check("незарегистрированный: create/allow/signal/deliver/watch ничего не делают", !last(X, "linkcall-created") && !A.ev.some((e) => e.type === "signal") && X.ev.length === 1);
  await wait(500);
  check("обычный незарегистрированный сокет по-прежнему закрывается по таймауту регистрации", X.isClosed());

  console.log("\n=== закрытие ===");
  G.ws.close(); await wait(120);
  check("закрытие гостя закрывает комнату: создателю linkcall-end", last(A, "linkcall-end") && last(A, "linkcall-end").room === R.room);
  A.send({ type: "linkcall-signal", room: R.room, data: 1 }); const G2 = await open("10.3.0.3"); G2.send({ type: "linkcall-join", room: R.room }); await wait(80);
  check("после закрытия вход → notfound", last(G2, "linkcall-error").reason === "notfound");
  const R2 = await room(A); const G3 = await open("10.3.0.4"); G3.send({ type: "linkcall-join", room: R2.room }); await wait(80);
  A.ws.close(); await wait(120);
  check("закрытие создателя: гость получает linkcall-end", !!last(G3, "linkcall-end"));

  console.log("\n=== код ===");
  const B = await reg("b");
  const RB = await room(B); const RB2 = await room(B);
  check("коды разные у активных комнат", RB.code !== RB2.code);
  const GC = await open("10.4.0.1"); GC.send({ type: "linkcall-join", code: RB.code, name: "ByCode" }); await wait(100);
  check("вход по коду → viaCode:true", last(B, "linkcall-guest").viaCode === true && !!last(GC, "linkcall-joined"));
  B.send({ type: "linkcall-deny", room: RB.room, guestRef: last(B, "linkcall-guest").guestRef }); await wait(80);
  check("deny → гость получает linkcall-denied", !!last(GC, "linkcall-denied"));
  const GW = await open("10.4.0.2"); GW.send({ type: "linkcall-join", code: "000000" }); GW.send({ type: "linkcall-join", room: "nonexistent" }); await wait(100);
  check("неверный код/комната → notfound", GW.ev.filter((e) => e.type === "linkcall-error" && e.reason === "notfound").length === 2);
  const RB3 = await room(B); const nErr = B.ev.filter((e) => e.type === "linkcall-error").length; B.send({ type: "linkcall-create" }); await wait(80);
  check("не более 3 активных комнат на id (4-я → ratelimit)", !!RB3 && B.ev.filter((e) => e.type === "linkcall-error").length === nErr + 1);

  console.log("\n=== истечение TTL ===");
  await wait(1000);
  const GE = await open("10.4.0.3"); GE.send({ type: "linkcall-join", room: RB2.room }); await wait(100);
  check("истёкшая комната → expired", last(GE, "linkcall-error").reason === "expired");
  check("создатель уведомлён об истечении", B.ev.some((e) => e.type === "linkcall-end" && e.room === RB2.room && e.reason === "expired"));

  console.log("\n=== rate-limit по IP ===");
  const C = await reg("c"); const GL = await open("10.5.0.1");
  for (let i = 0; i < 7; i++) GL.send({ type: "linkcall-join", code: String(100000 + i) });
  await wait(150);
  const errs = GL.ev.filter((e) => e.type === "linkcall-error").map((e) => e.reason);
  check("вход по коду: 5/мин с IP, дальше ratelimit", errs.slice(0, 5).every((r) => r === "notfound") && errs.slice(5).every((r) => r === "ratelimit") && errs.length === 7);
  const GL2 = await open("10.5.0.2");
  for (let i = 0; i < 22; i++) GL2.send({ type: "linkcall-join", room: "r" + i });
  await wait(200);
  const e2 = GL2.ev.filter((e) => e.type === "linkcall-error").map((e) => e.reason);
  check("вход по room: 20/мин с IP, дальше ratelimit", e2.filter((r) => r === "ratelimit").length === 2);
  let rl = 0; for (let i = 0; i < 8; i++) { C.send({ type: "linkcall-create" }); await wait(20); }
  rl = C.ev.filter((e) => e.type === "linkcall-error").length;
  check("create ограничен (≤3 комнаты и rate-limit)", C.ev.filter((e) => e.type === "linkcall-created").length === 3 && rl >= 5);

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})();
