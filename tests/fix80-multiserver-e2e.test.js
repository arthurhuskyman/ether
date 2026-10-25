// Сквозной тест multi-server с ДВУМЯ настоящими процессами signaling-server/server.js (случайные порты, временные DATA_DIR/PUSH_SUBS_FILE):
// 1) A кладёт офлайн-конверт на запасной сервер B, B забирает его ящик; 2) A доставляет через сервер получателя, которого нет на активном;
// 3) при падении основного сервера A сам переходит на второй, перерегистрируется там и показывает заметку про первую регистрацию.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net"), os = require("node:os"), fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { createApp, closeAll } = require("./harness");

const procs = [];
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
async function startServer() {
  const port = await freePort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ether-ms-"));
  const p = spawn(process.execPath, [path.join(__dirname, "..", "signaling-server", "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, PUSH_SUBS_FILE: path.join(dir, "push.json"), MAILBOX_FILE: path.join(dir, "mb.json"), VAPID_PUBLIC: "", VAPID_PRIVATE: "", CLAIMS_PERSIST: "0", ALIASES_PERSIST: "0" }, stdio: "ignore" });
  procs.push(p);
  for (let i = 0; i < 80; i++) { // ждём /health
    const ok = await new Promise((r) => http.get({ host: "127.0.0.1", port, path: "/health" }, (rs) => { rs.resume(); r(rs.statusCode === 200); }).on("error", () => r(false)));
    if (ok) break; await new Promise((r) => setTimeout(r, 100));
  }
  return { port, url: "ws://localhost:" + port, proc: p };
}
test.after(async () => { await closeAll(); for (const p of procs) { try { p.kill(); } catch (e) {} } });

const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const sv = (...u) => JSON.stringify(u.map((url) => ({ url, label: url.slice(5), addedAt: 1 })));
async function boot(id, name, storage) {
  const a = createApp({ realWebSocket: true, storage: { "ether.name": name, "ether.myId": id, "ether.lang": "en", "ether.serversOff": JSON.stringify(["wss://ether-1-baqy.onrender.com"]), ...storage } });
  await a.ready;
  for (let i = 0; i < 100 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}
const registered = (a) => until(() => a.run(`!!(signaling && signaling.registered === true)`));
const contactsJson = (...cs) => JSON.stringify(cs.map(([id, name, pk, servers]) => ({ id, name, raw: "", publicKey: pk, servers, messages: [], lastActivity: 1000 })));
const has = (a, cid, id) => a.run(`(state.contacts.get(${JSON.stringify(cid)}) || {messages:[]}).messages.some((m) => m.id === ${JSON.stringify(id)})`);
const chat = (id, text) => ({ kind: "chat", id, text, ts: Date.now() });
function send(a, to, msgId, payload) { a.run(`addToOutbox(${JSON.stringify(msgId)}, ${JSON.stringify(to)}, ${JSON.stringify(payload)}); outbox.get(${JSON.stringify(msgId)}).forceV1 = true; flushOutboxItem(${JSON.stringify(msgId)});`); }

test("/info и /health: CORS для любого origin, version/features, без секретов", async () => {
  const s = await startServer();
  for (const p of ["/info", "/health"]) {
    const r = await fetch("http://127.0.0.1:" + s.port + p, { headers: { Origin: "https://mirror.example.net" } });
    assert.equal(r.status, 200); assert.equal(r.headers.get("access-control-allow-origin"), "*");
    if (p === "/info") { const j = await r.json(); assert.equal(typeof j.version, "string"); assert.ok(Array.isArray(j.features) && j.features.includes("claim")); assert.deepEqual(Object.keys(j).sort(), ["features", "name", "push", "time", "version"]); }
  }
  s.proc.kill();
});

test("A кладёт офлайн-конверт на сервер S2 (запасной сервер B), B онлайн на S1 забирает ящик S2 коротким подключением; ящик очищается", async () => {
  const S1 = await startServer(), S2 = await startServer();
  // B: основной S1, запасной S2 (так B рекламирует себя в приглашениях)
  const B = await boot("bob-id", "Bob", { "ether.servers": sv(S1.url, S2.url) });
  await registered(B);
  assert.equal(B.run(`effectiveSignalingUrl()`), S1.url);
  assert.deepEqual(JSON.parse(B.run(`JSON.stringify(srvMyHints())`)), [S1.url, S2.url]);
  const bobKey = JSON.parse(B.run(`JSON.stringify(Store.myPublicKeyJwk)`));
  // A живёт на S2; контакт B пришёл из приглашения с servers=[S1,S2]
  const A = await boot("alice-id", "Alice", { "ether.servers": sv(S2.url), "ether.contacts": contactsJson(["bob-id", "Bob", bobKey, [S1.url, S2.url]]) });
  await registered(A);
  assert.equal(A.run(`effectiveSignalingUrl()`), S2.url);
  B.run(`ensureContactEntry("alice-id", "Alice")`);
  send(A, "bob-id", "m-1", chat("c-1", "через запасной"));
  assert.ok(await until(() => A.run(`outbox.size === 0`)), "S2 принял конверт (активный сервер A входит в серверы B: удалённая отправка не нужна)");
  assert.equal(B.run(`state.contacts.get("alice-id").messages.some((m) => m.id === "c-1")`), false, "B на S1 пока ничего не получил");
  const got = await B.run(`srvDrainSecondary(true)`);
  assert.equal(got, 1);
  assert.ok(await until(() => has(B, "alice-id", "c-1")), "B забрал конверт из ящика запасного сервера");
  assert.equal(await B.run(`srvDrainSecondary(true)`), 0, "ящик уже пуст: подтверждение ушло на S2");
  assert.equal(B.run(`signaling.url`), S1.url, "основное соединение B не тронуто");
  S1.proc.kill(); S2.proc.kill();
});

test("A на S2, получатель B слушает только S1: конверт идёт через сервер получателя (сессия на S1), запись в очереди остаётся до его подтверждения", async () => {
  const S1 = await startServer(), S2 = await startServer();
  const B = await boot("bob2-id", "Bob", { "ether.servers": sv(S1.url) });
  await registered(B);
  const bobKey = JSON.parse(B.run(`JSON.stringify(Store.myPublicKeyJwk)`));
  B.run(`ensureContactEntry("alice2-id", "Alice")`);
  const A = await boot("alice2-id", "Alice", { "ether.servers": sv(S2.url), "ether.contacts": contactsJson(["bob2-id", "Bob", bobKey, [S1.url]]) });
  await registered(A);
  assert.deepEqual(JSON.parse(A.run(`JSON.stringify(srvRemoteTargets(state.contacts.get("bob2-id")))`)), [S1.url]);
  send(A, "bob2-id", "m-2", chat("c-2", "на сервер получателя"));
  assert.ok(await until(() => has(B, "alice2-id", "c-2"), 15000), "B получил живьём от S1");
  assert.ok(await until(() => A.run(`outbox.size === 0`), 15000), "после подтверждения сервером получателя запись снята");
  S1.proc.kill(); S2.proc.kill();
});

test("основной сервер убит: A после трёх неудач сам переходит на второй, перерегистрируется, показывает заметку и доставляет сообщение", async () => {
  const S1 = await startServer(), S2 = await startServer();
  const B = await boot("bob3-id", "Bob", { "ether.servers": sv(S2.url) });
  await registered(B);
  const bobKey = JSON.parse(B.run(`JSON.stringify(Store.myPublicKeyJwk)`));
  B.run(`ensureContactEntry("alice3-id", "Alice")`);
  const A = await boot("alice3-id", "Alice", { "ether.servers": sv(S1.url, S2.url), "ether.contacts": contactsJson(["bob3-id", "Bob", bobKey, [S2.url]]) });
  await registered(A);
  assert.equal(A.run(`signaling.url`), S1.url);
  S1.proc.kill(); // основной сервер пропал
  assert.ok(await until(() => A.run(`signaling && signaling.url === ${JSON.stringify(S2.url)} && signaling.registered === true`), 45000), "A перешёл на S2 и зарегистрировался там");
  assert.equal(A.run(`effectiveSignalingUrl()`), S2.url);
  assert.equal(A.run(`localStorage.getItem("ether.serverLastGood")`), S2.url);
  assert.match(A.window.document.getElementById("toast").textContent + A.run(`JSON.stringify(window.__etherDiag.slice(-80))`), /new server|переключение/i);
  assert.ok(JSON.parse(A.run(`localStorage.getItem("ether.serversSeen")`)).includes(S2.url));
  send(A, "bob3-id", "m-3", chat("c-3", "после отказа"));
  assert.ok(await until(() => has(B, "alice3-id", "c-3"), 15000), "сообщение дошло через второй сервер");
  S2.proc.kill();
});
