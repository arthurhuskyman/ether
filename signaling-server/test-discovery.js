// Обнаружение по хэшу телефона/почты: публикация только для id с claim, поиск, лимиты, TTL/снятие, персистентность, 0600
const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (c) => c.repeat(64);
const claimOf = (t) => crypto.createHash("sha256").update("ether-claim-v1|" + t).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-disc-"));
const FILE = path.join(tmp, "disc.json");
const PORT = 8821;
function start(env) {
  return spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(PORT), MAILBOX_PERSIST: "0", CLAIMS_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", DISCOVERY_FILE: FILE, DISCOVERY_MIN_MS: "100", REGISTER_DEADLINE_MS: "60000" }, env || {}), stdio: "ignore" });
}
function connect(myId, extra) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:" + PORT); const events = [];
    ws.on("error", reject);
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => { ws.send(JSON.stringify(Object.assign({ type: "register", id: myId, name: "Имя-" + myId[0], visible: true, publicKey: { kty: "EC", crv: "P-256", x: "x" + myId[0], y: "y" } }, extra || {}))); setTimeout(() => resolve({ ws, events }), 250); });
  });
}
async function retry(myId, extra) { for (let i = 0; i < 40; i++) { try { return await connect(myId, extra); } catch (e) { await wait(100); } } throw new Error("нет сервера"); }
const send = (c, o) => c.ws.send(JSON.stringify(o));
const last = (c, type) => { for (let i = c.events.length - 1; i >= 0; i--) if (c.events[i].type === type) return c.events[i]; return null; };
const hmac = (salt, s) => crypto.createHmac("sha256", salt).update(s).digest("hex");
async function lookup(c, hashes, rid) { const n = c.events.length; send(c, { type: "discovery-lookup", rid, hashes }); for (let i = 0; i < 30; i++) { await wait(50); const r = c.events.slice(n).find((e) => e.type === "discovery-result" && e.rid === rid); if (r) return r; } return null; }
async function publish(c, o) { const n = c.events.length; send(c, Object.assign({ type: "discovery-publish" }, o)); for (let i = 0; i < 30; i++) { await wait(50); const r = c.events.slice(n).find((e) => e.type === "discovery-published"); if (r) return r; } return null; }
(async () => {
  let srv = start({ DISCOVERY_REQ_PER_HOUR: "7", DISCOVERY_HASHES_PER_DAY: "300" });
  const a = await retry(id("a"), { claim: claimOf("A") });
  const reg = last(a, "registered");
  check("feature discovery и соль в registered", reg.features.includes("discovery") && typeof reg.discoverySalt === "string" && reg.discoverySalt.length >= 32);
  const salt = reg.discoverySalt;
  const hA = hmac(salt, "79001112233"), hMail = hmac(salt, "a@b.c");
  // публикация
  const nc = await retry(id("n"));
  check("id без claim публиковать не может", (await publish(nc, { hashes: [hmac(salt, "1")] })).error === "no-claim");
  check("битые хэши = снятие, не запись", (await publish(a, { hashes: ["zz", 5] })).count === 0);
  const p = await publish(a, { hashes: [hA, hMail], shareName: true, name: "Алиса <b>x</b>" });
  check("публикация принята", p.ok === true && p.count === 2);
  const b = await retry(id("b"), { claim: claimOf("B") });
  let r = await lookup(b, [hA, hmac(salt, "000"), hMail], "r1");
  check("найден только опубликованный: hash, id, publicKey, name", r.found.length === 2 && r.found[0].id === id("a") && r.found[0].publicKey.kty === "EC" && r.found[0].name.startsWith("Алиса") && r.found[0].hash === hA);
  check("ответ содержит только найденные (без неизвестных)", !JSON.stringify(r).includes(hmac(salt, "000")));
  // скрытый / не включивший неотличимы от отсутствующего
  const c = await retry(id("c"), { claim: claimOf("C"), visible: false });
  const hC = hmac(salt, "79005556677");
  r = await lookup(b, [hC], "r2");
  check("не включивший = пусто, без ошибки", r.found.length === 0 && !r.error);
  await publish(c, { hashes: [hC] });
  r = await lookup(b, [hC], "r3");
  check("без shareName имя не отдаётся", r.found.length === 1 && r.found[0].name === undefined);
  // самого себя не возвращает
  r = await lookup(a, [hA], "r4");
  check("свой хэш в поиске не возвращается", r.found.length === 0);
  // время ответа не меньше минимума
  const t0 = Date.now(); await lookup(b, [hmac(salt, "q")], "r5");
  check("минимальное время ответа выдержано", Date.now() - t0 >= 90);
  // снятие
  await publish(a, { hashes: [] });
  r = await lookup(b, [hA], "r6");
  check("после снятия не находится", r.found.length === 0);
  // лимиты: 6 запросов/час (IP общий: r1-r6)
  r = await lookup(b, [hA], "r7"); check("7-й запрос проходит", !r.error);
  r = await lookup(b, [hA], "r8"); check("сверх лимита запросов — error rate", r.error === "rate" && r.found.length === 0);
  const d = await retry(id("d"), { claim: claimOf("D") });
  r = await lookup(d, [hA], "x1"); check("лимит по IP общий для разных id", r.error === "rate");
  // >200 хэшей
  const many = Array.from({ length: 201 }, (_, i) => hmac(salt, "n" + i));
  r = await lookup(d, many, "x2"); check("больше 200 хэшей за запрос отклоняется", r.error === "bad-request" || r.error === "rate");
  // персистентность
  await publish(a, { hashes: [hA] });
  await wait(2300);
  const raw = fs.readFileSync(FILE, "utf8");
  check("файл 0600", (fs.statSync(FILE).mode & 0o777) === 0o600);
  check("на диске нет телефона/почты, только хэши; нет claim-токена", !raw.includes("79001112233") && !raw.includes("a@b.c") && !raw.includes("secret"));
  for (const x of [a, b, c, d, nc]) try { x.ws.close(); } catch (e) {}
  srv.kill("SIGTERM"); await wait(600);
  srv = start({ DISCOVERY_REQ_PER_HOUR: "50" });
  const b2 = await retry(id("b"), { claim: claimOf("B") });
  check("соль сохраняется между перезапусками", last(b2, "registered").discoverySalt === salt);
  r = await lookup(b2, [hA], "p1");
  check("записи переживают перезапуск", r && r.found.length === 1 && r.found[0].id === id("a"));
  // смена id на том же сокете снимает запись
  const a2 = await retry(id("a"), { claim: claimOf("A") });
  send(a2, { type: "register", id: id("e"), name: "e", visible: true, claim: claimOf("A"), publicKey: { kty: "EC", crv: "P-256", x: "xe", y: "y" } });
  await wait(300);
  r = await lookup(b2, [hA], "p2");
  check("смена id снимает запись", r.found.length === 0);
  a2.ws.close(); b2.ws.close(); srv.kill("SIGTERM"); await wait(500);
  // TTL: запись со старым seen не загружается
  const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
  j.entries.push([hmac(salt, "old"), { id: id("z"), pk: { kty: "EC" }, name: "", seen: Date.now() - 100 * 86400000 }]);
  fs.writeFileSync(FILE, JSON.stringify(j));
  srv = start();
  const b3 = await retry(id("b"), { claim: claimOf("B") });
  r = await lookup(b3, [hmac(salt, "old")], "t1");
  check("просроченная по TTL запись не находится", r.found.length === 0);
  b3.ws.close(); srv.kill("SIGTERM"); await wait(500);
  // выключено
  srv = start({ DISCOVERY_ENABLED: "0" });
  const o = await retry(id("b"), { claim: claimOf("B") });
  check("DISCOVERY_ENABLED=0: нет feature и соли", !last(o, "registered").features.includes("discovery") && last(o, "registered").discoverySalt === undefined);
  o.ws.close(); srv.kill("SIGTERM");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
