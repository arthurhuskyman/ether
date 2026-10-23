// Миграция id v1 -> v2 на сервере: оба вида id принимаются; алиас старого id на новый (alias-set) ставится только при доказательстве обоих claim-ов;
// deliver/signal на старый id пересылаются на новый, поле "as" штампует from старого id только владельцу алиаса; presence зеркалится; алиас переживает рестарт, 0600, TTL.
const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const v1 = (c) => c.repeat(64);
const v2 = (c) => "v2:" + c.repeat(64);
const claimOf = (t) => crypto.createHash("sha256").update("ether-claim-v1|" + t).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-idv2-"));
const ALIASES = path.join(tmp, "aliases.json"), CLAIMS = path.join(tmp, "claims.json");
const ENV = { iv: "AAAAAAAAAAAAAAAA", ct: "Y2lwaGVydGV4dA==" };
function start(port, env) {
  return spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(port), MAILBOX_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", ALIASES_FILE: ALIASES, ALIASES_PERSIST: "1", CLAIMS_FILE: CLAIMS, CLAIMS_PERSIST: "1", MAX_SOCKETS_PER_IP: "200", REGISTER_RATE_LIMIT_PER_MIN: "500" }, env || {}), stdio: "ignore" });
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
const send = (c, o) => c.ws.send(JSON.stringify(o));
(async () => {
  let srv = start(8851);
  const CO = claimOf("device-secret"), CX = claimOf("x-secret");
  // 1. оба вида id принимаются и общаются
  const O = await retry(8851, v1("a"), { claim: CO });          // старый id (v1)
  const X = await retry(8851, v1("c"), { claim: CX });          // необновлённый контакт
  const P = await retry(8851, v2("e"), { claim: claimOf("p") }); // другой пользователь уже на v2
  check("register с id v1 и с префиксом v2: принимаются", has(O, "registered") && has(P, "registered") && !has(P, "register-error"));
  send(P, { type: "deliver", to: v1("c"), msgId: "m-p-x", envelope: ENV, kind: "chat" });
  await wait(200);
  check("deliver между id v2 и v1 доходит (from = полный id v2)", has(X, "deliver", (e) => e.from === v2("e") && e.msgId === "m-p-x"));
  send(X, { type: "signal", to: v2("e"), data: { t: "ping" } }); await wait(150);
  check("signal на id v2 доходит", has(P, "signal", (e) => e.from === v1("c")));
  // 2. alias-set: отказы
  const Nbad = await retry(8851, v2("1"), { claim: claimOf("other-secret") });
  send(Nbad, { type: "alias-set", old: v1("a"), oldClaim: claimOf("other-secret") }); await wait(200);
  check("alias-set с чужим claim старого id отклонён (old-claim)", has(Nbad, "alias-result", (e) => e.ok === false && e.error === "old-claim"));
  send(Nbad, { type: "alias-set", old: v1("a"), oldClaim: "zz" }); await wait(150);
  check("alias-set с битым claim отклонён", Nbad.events.filter((e) => e.type === "alias-result" && e.ok === false).length === 2);
  send(Nbad, { type: "alias-set", old: v1("f"), oldClaim: CO }); await wait(150);
  check("alias-set для старого id без записи claim отклонён", Nbad.events.filter((e) => e.type === "alias-result" && e.error === "old-claim").length >= 2);
  Nbad.ws.close();
  const Nnoclaim = await retry(8851, v2("d"));
  send(Nnoclaim, { type: "alias-set", old: v1("a"), oldClaim: CO }); await wait(150);
  check("новый id без claim алиас поставить не может (no-claim)", has(Nnoclaim, "alias-result", (e) => e.ok === false && e.error === "no-claim"));
  Nnoclaim.ws.close();
  send(X, { type: "alias-set", old: v1("a"), oldClaim: CX }); await wait(150);
  check("чужой сокет (свой claim, не claim старого id) алиас чужого id поставить не может", has(X, "alias-result", (e) => e.ok === false && e.error === "old-claim"));
  // 3. почта для старого id копится, пока нового нет; после alias-set переезжает
  O.ws.close(); await wait(250);
  send(X, { type: "deliver", to: v1("a"), msgId: "m-x-old", envelope: ENV, kind: "chat" }); await wait(150);
  const N = await retry(8851, v2("b"), { claim: CO }); // тот же секрет устройства: claim нового = claim старого
  if (process.env.DBG) console.log(JSON.stringify(N.events.slice(0,3)));
  check("новый id зарегистрирован с claim", has(N, "registered", (e) => e.claimed === true));
  send(N, { type: "alias-set", old: v1("a"), oldClaim: CO }); await wait(300);
  check("alias-set принят: ok и ttlDays=90", has(N, "alias-result", (e) => e.ok === true && e.ttlDays === 90 && e.old === v1("a")));
  check("накопленная почта старого id переехала в ящик нового (from = отправитель)", has(N, "deliver", (e) => e.msgId === "m-x-old" && e.from === v1("c")));
  // 4. пересылка deliver/signal со старого id
  send(X, { type: "deliver", to: v1("a"), msgId: "m-x-live", envelope: ENV, kind: "chat" }); await wait(200);
  check("deliver на старый id пересылается на новый (онлайн)", has(N, "deliver", (e) => e.msgId === "m-x-live" && e.from === v1("c") && e.queued === false));
  check("отправитель получает deliver-ack", has(X, "deliver-ack", (e) => e.msgId === "m-x-live" && !e.error));
  send(X, { type: "signal", to: v1("a"), data: { t: "call-invite", x: "n1" } }); await wait(200);
  check("signal на старый id пересылается на новый", has(N, "signal", (e) => e.from === v1("c") && e.data.t === "call-invite"));
  // 5. as: ответ от имени старого id
  X.events.length = 0;
  send(N, { type: "deliver", to: v1("c"), msgId: "m-n-as", envelope: ENV, kind: "chat", as: v1("a") }); await wait(200);
  check("as=старый id: контакт получает from = старый id", has(X, "deliver", (e) => e.msgId === "m-n-as" && e.from === v1("a")));
  send(N, { type: "signal", to: v1("c"), data: { t: "ping" }, as: v1("a") }); await wait(150);
  check("signal с as: from = старый id", has(X, "signal", (e) => e.from === v1("a")));
  send(N, { type: "deliver", to: v1("c"), msgId: "m-n-plain", envelope: ENV, kind: "chat" }); await wait(150);
  check("без as: from = новый id", has(X, "deliver", (e) => e.msgId === "m-n-plain" && e.from === v2("b")));
  send(P, { type: "deliver", to: v1("c"), msgId: "m-p-spoof", envelope: ENV, kind: "chat", as: v1("a") }); await wait(150);
  check("чужой сокет не может слать от имени чужого старого id (as игнорируется)", has(X, "deliver", (e) => e.msgId === "m-p-spoof" && e.from === v2("e")));
  send(N, { type: "deliver", to: v1("c"), msgId: "m-n-as2", envelope: ENV, kind: "chat", as: v1("zzz") }); await wait(150);
  check("as с id без алиаса игнорируется", has(X, "deliver", (e) => e.msgId === "m-n-as2" && e.from === v2("b")));
  // 6. presence под старым id для тех, кто следит за старым id
  X.events.length = 0;
  send(X, { type: "watch", ids: [v1("a")] }); await wait(200);
  check("watch старого id: онлайн-запись приходит под старым id (алиас живой)", has(X, "watch-result", (e) => Array.isArray(e.online) && e.online.some((u) => u.id === v1("a"))));
  X.events.length = 0;
  N.ws.close(); await wait(300);
  check("новый ушёл офлайн: наблюдатель старого id получает presence offline под старым id", has(X, "presence", (e) => e.id === v1("a") && e.online === false));
  X.events.length = 0;
  const N2 = await retry(8851, v2("b"), { claim: CO }); await wait(200);
  check("новый вернулся: presence online под старым id", has(X, "presence", (e) => e.id === v1("a") && e.online === true));
  // 7. если старый id снова онлайн (другое устройство) — алиас не перехватывает
  const Oagain = await retry(8851, v1("a"), { claim: CO });
  X.events.length = 0;
  send(X, { type: "deliver", to: v1("a"), msgId: "m-x-direct", envelope: ENV, kind: "chat" }); await wait(200);
  check("пока старый id сам онлайн, сообщение идёт ему, а не по алиасу", has(Oagain, "deliver", (e) => e.msgId === "m-x-direct"));
  Oagain.ws.close(); await wait(200);
  // 8. персистентность: файл 0600, переживает рестарт, ограничения
  await wait(1300);
  check("файл алиасов создан с правами 0600", fs.existsSync(ALIASES) && (fs.statSync(ALIASES).mode & 0o777) === 0o600);
  const saved = JSON.parse(fs.readFileSync(ALIASES, "utf8"));
  check("в файле алиас old -> new с TTL около 90 суток", saved.aliases.length === 1 && saved.aliases[0][0] === v1("a") && saved.aliases[0][1].to === v2("b") && Math.abs(saved.aliases[0][1].exp - (Date.now() + 90 * 86400_000)) < 120_000);
  [N2, X, P].forEach((c) => c.ws.close());
  srv.kill("SIGTERM"); await wait(500);
  srv = start(8851);
  const X3 = await retry(8851, v1("c"), { claim: CX });
  const N3 = await retry(8851, v2("b"), { claim: CO });
  send(X3, { type: "deliver", to: v1("a"), msgId: "m-after-restart", envelope: ENV, kind: "chat" }); await wait(250);
  check("алиас пережил рестарт сервера", has(N3, "deliver", (e) => e.msgId === "m-after-restart"));
  [N3, X3].forEach((c) => c.ws.close());
  srv.kill("SIGTERM"); await wait(500);
  // 9. истёкший алиас при загрузке отбрасывается
  const f = JSON.parse(fs.readFileSync(ALIASES, "utf8")); f.aliases[0][1].exp = Date.now() - 1000; fs.writeFileSync(ALIASES, JSON.stringify(f));
  srv = start(8851);
  const X4 = await retry(8851, v1("c"), { claim: CX });
  const N4 = await retry(8851, v2("b"), { claim: CO });
  send(X4, { type: "deliver", to: v1("a"), msgId: "m-expired", envelope: ENV, kind: "chat" }); await wait(250);
  check("истёкший алиас не действует (сообщение остаётся в ящике старого id)", !has(N4, "deliver", (e) => e.msgId === "m-expired"));
  [N4, X4].forEach((c) => c.ws.close());
  srv.kill("SIGTERM"); await wait(400);
  // 10. потолок числа алиасов
  try { fs.unlinkSync(ALIASES); } catch (e) {}
  srv = start(8852, { ALIASES_MAX: "1" });
  const Q1 = await retry(8852, v1("g"), { claim: claimOf("q") }), Q2 = await retry(8852, v1("h"), { claim: claimOf("q") });
  const R1 = await retry(8852, v2("g"), { claim: claimOf("q") });
  send(R1, { type: "alias-set", old: v1("g"), oldClaim: claimOf("q") }); await wait(150);
  send(R1, { type: "alias-set", old: v1("h"), oldClaim: claimOf("q") }); await wait(150);
  check("потолок ALIASES_MAX: второй алиас отклонён (full)", has(R1, "alias-result", (e) => e.ok === true) && has(R1, "alias-result", (e) => e.ok === false && e.error === "full"));
  [Q1, Q2, R1].forEach((c) => c.ws.close());
  srv.kill("SIGTERM"); await wait(300);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
