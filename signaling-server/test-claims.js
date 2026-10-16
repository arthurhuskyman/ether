// Claim-токены id (TOFU): занять чужой id нельзя; TTL; персистентность; лимиты; совместимость со старыми клиентами
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-claims-"));
const FILE = path.join(tmp, "claims.json");
function start(port, env) {
  return spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(port), MAILBOX_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", CLAIMS_FILE: FILE, REGISTER_DEADLINE_MS: "60000" }, env || {}), stdio: "ignore" });
}
function connect(port, myId, extra) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:" + port); const events = [];
    ws.on("error", reject);
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => { ws.send(JSON.stringify(Object.assign({ type: "register", id: myId, name: "n", visible: true }, extra || {}))); setTimeout(() => resolve({ ws, events }), 250); });
  });
}
async function retry(port, myId, extra) { for (let i = 0; i < 40; i++) { try { return await connect(port, myId, extra); } catch (e) { await wait(100); } } throw new Error("нет сервера"); }
const has = (c, type, f) => c.events.some((e) => e.type === type && (!f || f(e)));
(async () => {
  let srv = start(8811);
  const A = claimOf("secret-A"), B = claimOf("secret-B");
  const a1 = await retry(8811, id("a"), { claim: A });
  check("первая регистрация с claim принята и помечена claimed", has(a1, "registered", (e) => e.claimed === true));
  check("сервер объявляет feature claim", has(a1, "registered", (e) => e.features.includes("claim")));
  a1.ws.close(); await wait(300);
  const thief = await retry(8811, id("a"), { claim: B });
  check("чужой claim: register-error id-claimed, не registered", has(thief, "register-error", (e) => e.error === "id-claimed") && !has(thief, "registered"));
  thief.ws.close();
  const legacy = await retry(8811, id("a"));
  check("старый клиент без claim не может занять id с claim", has(legacy, "register-error", (e) => e.error === "id-claimed") && !has(legacy, "registered"));
  legacy.ws.close();
  const bad = await retry(8811, id("a"), { claim: "xyz" });
  check("битый claim = отсутствие claim → отказ", has(bad, "register-error"));
  bad.ws.close();
  const a2 = await retry(8811, id("a"), { claim: A });
  check("владелец (тот же claim) регистрируется снова", has(a2, "registered"));
  // вытеснение работает только для владельца: вор не выкидывает онлайн-владельца
  const thief2 = await retry(8811, id("a"), { claim: B });
  check("вор не вытесняет онлайн-владельца", !has(a2, "replaced") && has(thief2, "register-error"));
  thief2.ws.close();
  // id без claim: старый клиент работает как раньше
  const old = await retry(8811, id("o"));
  check("id без claim: старый клиент регистрируется", has(old, "registered", (e) => e.claimed === false));
  old.ws.close();
  // смена id (A3 v2): тот же токен — другой id, оба работают
  const a3 = await retry(8811, id("n"), { claim: A });
  check("новый id с тем же токеном принимается (смена id / восстановление из бэкапа)", has(a3, "registered"));
  a3.ws.close(); a2.ws.close();
  await wait(2600);
  check("claim записан на диск, без самого токена и claim-хэша", fs.existsSync(FILE) && !fs.readFileSync(FILE, "utf8").includes(A) && !fs.readFileSync(FILE, "utf8").includes("secret-A"));
  check("файл claim-ов с правами 0600", (fs.statSync(FILE).mode & 0o777) === 0o600);
  srv.kill("SIGTERM"); await wait(500);

  // перезапуск: claim пережил
  srv = start(8811);
  const t3 = await retry(8811, id("a"), { claim: B });
  check("после перезапуска claim сохраняется (вор отклонён)", has(t3, "register-error"));
  t3.ws.close();
  const a4 = await retry(8811, id("a"), { claim: A });
  check("после перезапуска владелец принят", has(a4, "registered"));
  a4.ws.close();
  srv.kill("SIGTERM"); await wait(500);

  // TTL: подделываем seen в файле старше TTL (1 час в тесте)
  const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  for (const e of data.claims) e[1].seen = Date.now() - 2 * 3600 * 1000;
  fs.writeFileSync(FILE, JSON.stringify(data));
  srv = start(8812, { CLAIM_TTL_HOURS: "1" });
  const t4 = await retry(8812, id("a"), { claim: B });
  check("claim старше CLAIM_TTL_HOURS освобождён: id можно переприсвоить", has(t4, "registered"));
  t4.ws.close();
  const t5 = await retry(8812, id("a"), { claim: A });
  check("после переприсвоения прежний владелец отклонён", has(t5, "register-error"));
  t5.ws.close();
  srv.kill("SIGTERM"); await wait(500);

  // DoS: лимит создания claim с одного IP и потолок таблицы
  try { fs.unlinkSync(FILE); } catch (e) {}
  srv = start(8813, { CLAIM_CREATE_PER_HOUR_PER_IP: "3", CLAIMS_MAX: "100000", MAX_SOCKETS_PER_IP: "100" });
  const made = [];
  for (let i = 0; i < 6; i++) { const c = await retry(8813, id(String.fromCharCode(97 + i)), { claim: claimOf("t" + i) }); made.push(c); await wait(60); }
  const regs = made.filter((c) => has(c, "registered")).length;
  const claimed = made.filter((c) => has(c, "registered", (e) => e.claimed === true)).length;
  check("сверх лимита создания claim id всё равно регистрируется (без claim)", regs === made.length);
  check("claim создаётся не больше лимита на IP (3 из 6)", claimed === 3);
  made.forEach((c) => c.ws.close());
  srv.kill("SIGTERM"); await wait(400);
  try { fs.unlinkSync(FILE); } catch (e) {}
  srv = start(8814, { CLAIMS_MAX: "2", MAX_SOCKETS_PER_IP: "100" });
  const full = [];
  for (let i = 0; i < 4; i++) { const c = await retry(8814, id(String.fromCharCode(97 + i)), { claim: claimOf("u" + i) }); full.push(c); await wait(60); }
  check("таблица claim ограничена CLAIMS_MAX (2 из 4)", full.filter((c) => has(c, "registered", (e) => e.claimed === true)).length === 2);
  check("при полной таблице чужие claim не вытесняются: первый владелец защищён", has(await retry(8814, id("a"), { claim: claimOf("zzz") }), "register-error"));
  full.forEach((c) => c.ws.close());
  srv.kill("SIGTERM"); await wait(300);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
