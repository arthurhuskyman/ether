// Одноразовый rendezvous переноса на новое устройство: одноразовость, TTL, лимиты, анти-перебор, удаление после выдачи, нет утечки в лог.
process.env.PORT = "8796";
process.env.MAILBOX_PERSIST = "0";
process.env.VAPID_PUBLIC = ""; process.env.VAPID_PRIVATE = "";
process.env.LINK_CHANNEL_TTL_MS = "1500"; process.env.LINK_BLOB_TTL_MS = "1500"; process.env.LINK_MAX_BLOB = String(64 * 1024);
const logs = []; for (const k of ["log", "warn", "error"]) { const o = console[k]; console[k] = (...a) => { logs.push(a.join(" ")); o(...a); }; }
require("./server.js");
const crypto = require("crypto");
const B = "http://localhost:8796";
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = () => crypto.randomBytes(32).toString("hex");
const pub = () => crypto.randomBytes(65).toString("base64url");
const post = (p, body, headers, raw) => fetch(B + p, { method: "POST", headers: Object.assign(raw ? { "Content-Type": "application/octet-stream" } : { "Content-Type": "application/json" }, headers || {}), body: raw ? body : JSON.stringify(body) });

(async () => {
  await wait(400);
  const t = hex(), u = hex(), pa = pub(), pb = pub();
  let r = await post("/link/init", { t, u, pub: pa }); const ij = await r.json();
  check("init: 200, ttl и maxBlob", r.status === 200 && ij.ttl >= 1 && ij.maxBlob === 65536);
  check("повторный init того же t: 409", (await post("/link/init", { t, u, pub: pa })).status === 409);
  check("init с плохим форматом: 400", (await post("/link/init", { t: "zz", u, pub: pa })).status === 400);
  r = await post("/link/state", { t, u }); let sj = await r.json();
  check("state до join: joined=false", sj.joined === false && !sj.hasBlob);
  check("state с чужим u: 404", (await post("/link/state", { t, u: hex() })).status === 404);
  r = await post("/link/join", { t, pub: pb }); const jj = await r.json();
  check("join: отдаёт pub старого и jt", r.status === 200 && jj.pub === pa && jj.jt.length >= 20);
  check("второй join (одноразовость): 409", (await post("/link/join", { t, pub: pub() })).status === 409);
  check("get до put: 204", (await post("/link/get", { t, jt: jj.jt })).status === 204);
  check("get с неверным jt: 404", (await post("/link/get", { t, jt: "x".repeat(32) })).status === 404);
  sj = await (await post("/link/state", { t, u })).json();
  check("state после join: pub нового", sj.joined && sj.pub === pb);
  check("put без u: 404", (await post("/link/put", Buffer.from("zz"), { "X-Link-T": t, "X-Link-U": hex() }, true)).status === 404);
  check("put больше лимита: 413", (await post("/link/put", Buffer.alloc(70 * 1024, 1), { "X-Link-T": t, "X-Link-U": u }, true)).status === 413);
  const blob = crypto.randomBytes(40000);
  check("put: 200", (await post("/link/put", blob, { "X-Link-T": t, "X-Link-U": u }, true)).status === 200);
  check("повторный put: 409", (await post("/link/put", blob, { "X-Link-T": t, "X-Link-U": u }, true)).status === 409);
  r = await post("/link/get", { t, jt: jj.jt }); const got = Buffer.from(await r.arrayBuffer());
  check("get: тот же blob байт-в-байт", r.status === 200 && got.equals(blob));
  check("повторный get: 410 (удалено после выдачи)", (await post("/link/get", { t, jt: jj.jt })).status === 410);
  sj = await (await post("/link/state", { t, u })).json();
  check("state: delivered=true, blob нет", sj.delivered === true && sj.hasBlob === false);

  // TTL канала
  const t2 = hex(), u2 = hex();
  await post("/link/init", { t: t2, u: u2, pub: pa }); await wait(1700);
  check("TTL канала: после истечения join = 404", (await post("/link/join", { t: t2, pub: pb })).status === 404);
  // TTL blob
  const t3 = hex(), u3 = hex();
  await post("/link/init", { t: t3, u: u3, pub: pa }); const j3 = await (await post("/link/join", { t: t3, pub: pb })).json();
  await post("/link/put", Buffer.from("abc"), { "X-Link-T": t3, "X-Link-U": u3 }, true); await wait(1700);
  check("TTL blob: после истечения get = 404, данные не выдаются", (await post("/link/get", { t: t3, jt: j3.jt })).status === 404);
  // cancel
  const t4 = hex(), u4 = hex(); await post("/link/init", { t: t4, u: u4, pub: pa });
  const cc = await post("/link/cancel", { t: t4, u: u4 }); const cj = await post("/link/join", { t: t4, pub: pb }); check("cancel с u: 200 и канал исчезает " + cc.status + "/" + cj.status, cc.status === 200 && cj.status === 404);
  check("не-POST: 405", (await fetch(B + "/link/state")).status === 405);
  // анти-перебор: серия промахов по t -> 429, дальше блокируется даже валидный
  let got429 = false;
  for (let i = 0; i < 40 && !got429; i++) { const x = await post("/link/join", { t: hex(), pub: pb }); if (x.status === 429) got429 = true; }
  check("перебор t: IP получает 429", got429);
  const t5 = hex(); const rr = await post("/link/init", { t: t5, u: hex(), pub: pa });
  check("после блокировки легальные запросы с этого IP тоже 429", rr.status === 429);
  const all = logs.join("\n");
  check("t/u/jt/blob в логи не попали", !all.includes(t) && !all.includes(u) && !all.includes(jj.jt) && !all.includes(blob.toString("base64url").slice(0, 20)));
  const feats = await new Promise((res) => { const WebSocket = require("ws"); const ws = new WebSocket("ws://localhost:8796"); ws.on("open", () => ws.send(JSON.stringify({ type: "register", id: "q".repeat(64), name: "q", visible: true }))); ws.on("message", (m) => { const d = JSON.parse(m); if (d.type === "registered") { ws.close(); res(d.features); } }); });
  check("features содержит devicelink", feats.includes("devicelink"));
  console.log(`\n${pass} ok, ${fail} fail`); process.exit(fail ? 1 : 0);
})();
