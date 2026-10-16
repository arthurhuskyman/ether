// TURN REST API: TURN_STATIC_SECRET -> временные креды username="<expiry>:ether", credential=base64(HMAC-SHA1)
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function start(port, env) {
  return spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(port), MAILBOX_PERSIST: "0", CLAIMS_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", TURN_CHECK_DISABLED: "1", CF_TURN_KEY_ID: "", CF_TURN_API_TOKEN: "", TURN_EXTRA_JSON: "", TURN_STATIC_USERNAME: "", TURN_STATIC_PASSWORD: "", TURN_STATIC_SECRET: "" }, env), stdio: "ignore" });
}
function get(port) {
  return new Promise((resolve, reject) => http.get({ host: "localhost", port, path: "/ice" }, (res) => { let b = ""; res.on("data", (d) => b += d); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on("error", reject));
}
async function getRetry(port) { for (let i = 0; i < 40; i++) { try { return await get(port); } catch (e) { await wait(100); } } throw new Error("нет сервера"); }
(async () => {
  let srv = start(8831, { TURN_STATIC_URL: "turn:turn.example.org:3478", TURN_STATIC_SECRET: "s3cr3t", TURN_TTL_SECONDS: "3600", TURN_STATIC_USERNAME: "old", TURN_STATIC_PASSWORD: "oldpw" });
  const j = await getRetry(8831);
  const t = j.find((s) => s.username);
  check("есть TURN-сервер с учётными данными", !!t);
  const m = /^(\d+):ether$/.exec(t.username);
  check("username = <unix-expiry>:ether", !!m);
  const exp = Number(m[1]), now = Math.floor(Date.now() / 1000);
  check("expiry примерно now + TURN_TTL_SECONDS", exp > now + 3500 && exp <= now + 3601);
  check("credential = base64(HMAC-SHA1(secret, username))", t.credential === crypto.createHmac("sha1", "s3cr3t").update(t.username).digest("base64"));
  check("TCP-вариант url добавлен", t.urls.includes("turn:turn.example.org:3478?transport=tcp"));
  check("статический пароль не используется при заданном секрете", t.username !== "old" && t.credential !== "oldpw");
  const j2 = await get(8831);
  check("кеш 5 минут: повторный запрос отдаёт те же креды", j2.find((s) => s.username).credential === t.credential);
  srv.kill("SIGTERM"); await wait(300);

  srv = start(8832, { TURN_STATIC_URL: "turn:turn.example.org:3478", TURN_STATIC_USERNAME: "old", TURN_STATIC_PASSWORD: "oldpw" });
  const k = (await getRetry(8832)).find((s) => s.username);
  check("совместимость: без секрета остаются статические креды", k && k.username === "old" && k.credential === "oldpw");
  srv.kill("SIGTERM"); await wait(300);

  srv = start(8833, { TURN_STATIC_URL: "turn:turn.example.org:3478" });
  const none = await getRetry(8833);
  check("без секрета и без статики — только STUN", none.every((s) => !s.username));
  srv.kill("SIGTERM"); await wait(300);

  // 21-й запрос за минуту — лимит /ice сохранён
  srv = start(8834, {});
  await getRetry(8834); let limited = false;
  for (let i = 0; i < 25; i++) { const r = await get(8834); if (r && r.error === "rate limited") limited = true; }
  check("лимит /ice сохранён (429 rate limited)", limited);
  srv.kill("SIGTERM"); await wait(300);
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
