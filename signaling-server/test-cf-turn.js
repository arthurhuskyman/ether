// Cloudflare TURN: /ice берёт временные креды у API (здесь — локальная подмена), кладёт их первыми и кэширует;
// при сбое API отдаёт прежний набор (STUN).
const http = require("http");
let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  OK   " + l); } else { fail++; console.log("  FAIL " + l); } }
let calls = 0, mode = "ok", lastAuth = "", lastBody = "";
const fake = http.createServer((req, res) => {
  calls++; lastAuth = req.headers.authorization || "";
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    lastBody = b;
    if (mode === "fail") { res.writeHead(500); res.end("{}"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ iceServers: { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u1", credential: "c1" } }));
  });
});
function get(port, path) {
  return new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path, timeout: 8000 }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => resolve({ status: r.statusCode, body: b })); }).on("error", reject));
}
fake.listen(0, "127.0.0.1", async () => {
  process.env.PORT = "8795"; process.env.VAPID_PUBLIC = ""; process.env.VAPID_PRIVATE = "";
  process.env.CF_TURN_KEY_ID = "key123"; process.env.CF_TURN_API_TOKEN = "tok456";
  process.env.CF_TURN_API_BASE = "http://127.0.0.1:" + fake.address().port;
  require(require("path").join(__dirname, "server.js"));
  await new Promise((r) => setTimeout(r, 500));
  console.log("\n=== Cloudflare TURN в /ice ===");
  const r = await get(8795, "/ice");
  const list = JSON.parse(r.body);
  check("статус 200", r.status === 200);
  check("первым идёт Cloudflare с логином и паролем", list[0] && list[0].username === "u1" && list[0].credential === "c1");
  check("отданы только turn:/turns: адреса (TLS 443 есть)", list[0].urls.every((u) => /^turns?:/.test(u)) && list[0].urls.some((u) => /^turns:.*:443/.test(u)));
  check("запрос к API с Bearer-токеном и ttl", lastAuth === "Bearer tok456" && JSON.parse(lastBody).ttl === 86400);
  check("STUN Google остаётся в списке", list.some((s) => String(s.urls).includes("stun.l.google.com")));
  console.log("\n=== Кэш ===");
  await get(8795, "/ice");
  check("повторный /ice не ходит в API", calls === 1);
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
});
