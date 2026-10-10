// TURN_EXTRA_JSON: чистый JSON, JS-фрагмент провайдера (Metered) и мусор.
process.env.PORT = "8796"; process.env.VAPID_PUBLIC = ""; process.env.VAPID_PRIVATE = "";
const http = require("http");
let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  OK   " + l); } else { fail++; console.log("  FAIL " + l); } }
const snippet = `var myPeer = new Peer({
  config: {
    iceServers: [
      { urls: "stun:stun.relay.metered.ca:80" },
      { urls: 'turn:h.relay.metered.ca:80', username: "u1", credential: "p1", },
      { urls: "turns:h.relay.metered.ca:443?transport=tcp", username: "u1", credential: "p1" },
    ],
  },
});`;
process.env.TURN_EXTRA_JSON = snippet;
require(require("path").join(__dirname, "server.js"));
function get(path) { return new Promise((res, rej) => http.get({ host: "127.0.0.1", port: 8796, path }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej)); }
setTimeout(async () => {
  console.log("\n=== TURN_EXTRA_JSON как JS-фрагмент провайдера ===");
  const list = await get("/ice");
  const turn = list.filter((s) => s.username);
  check("найдено 2 TURN-записи с логином (STUN без логина отфильтрован)", turn.length === 2);
  check("ключи и одинарные кавычки разобраны", turn[0].urls === "turn:h.relay.metered.ca:80" && turn[0].username === "u1" && turn[0].credential === "p1");
  check("turns:443 на месте", turn[1].urls.indexOf("turns:") === 0 && turn[1].urls.includes(":443"));
  check("STUN Google остался", list.some((s) => String(s.urls).includes("stun.l.google.com")));
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
}, 600);
