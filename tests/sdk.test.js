// ether-sdk (sdk/): два клиента SDK через НАСТОЯЩИЙ локальный сигнальный сервер — Double Ratchet по prekey (X3DH + ML-KEM), приём в офлайн, каналы, закрепление ключей.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client, generateIdentity, claimProof } = require("../sdk/index.cjs");

const PORT = 8871, URL = "ws://127.0.0.1:" + PORT;
let server;
test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "signaling-server", "server.js")], { env: { ...process.env, PORT: String(PORT), VAPID_PUBLIC: "", VAPID_PRIVATE: "", CLAIMS_PERSIST: "0", MAILBOX_PERSIST: "0", DISCOVERY_PERSIST: "0", GROUPS_PERSIST: "0", CHANNELS_PERSIST: "0", DEVICES_PERSIST: "0", ALIASES_PERSIST: "0" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await new Promise((res, rej) => { const w = new WebSocket(URL); w.onopen = () => { w.close(); res(); }; w.onerror = rej; }); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
});
test.after(() => { try { server.kill(); } catch (e) {} });

const once = (c, ev, ms = 8000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout " + ev)), ms); c.once(ev, (v) => { clearTimeout(t); res(v); }); });
async function mk(name, extra) { const identity = await generateIdentity({ name }); return { identity, c: new Client({ url: URL, identity, reconnect: false, ...(extra || {}) }) }; }

test("claimProof совпадает с формулой приложения", () => {
  assert.equal(claimProof("claim-token-example"), require("./vectors/protocol-v1.json").claim.proof);
});

test("обмен сообщениями в обе стороны: первый конверт AAD v3 + ML-KEM, ответ, порядок сообщений", async () => {
  const A = await mk("Alice"), B = await mk("Bob");
  await A.c.connect(); await B.c.connect();
  assert.ok(A.c.features.includes("pq1") && A.c.features.includes("prekeys"));
  A.c.addPeer(B.identity.id, B.identity.publicKeyJwk);
  const got = once(B.c, "message");
  const msgId = await A.c.sendText(B.identity.id, "привет, Боб");
  const m = await got;
  assert.equal(m.from, A.identity.id); assert.equal(m.text, "привет, Боб"); assert.equal(m.msgId, msgId);
  const st = A.c.R.status(B.identity.id);
  assert.equal(st.pq, true, "старт гибридный (PQ) по подписанному prekey-пакету"); assert.equal(st.level, 3);
  assert.ok(B.c.peers[A.identity.id], "Боб закрепил ключ Алисы из fromPublicKey");
  const back = once(A.c, "message");
  await B.c.send(A.identity.id, { kind: "chat", id: "x1", text: "ответ", ts: 1 });
  assert.equal((await back).text, "ответ");
  const many = []; A.c.on("message", (x) => many.push(x.text));
  for (let i = 0; i < 3; i++) await B.c.sendText(A.identity.id, "n" + i);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(many, ["n0", "n1", "n2"]);
  A.c.close(); B.c.close();
});

test("получатель офлайн: сообщение лежит в ящике сервера и приходит после подключения; состояние переживает перезапуск (statePath)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ether-sdk-"));
  const A = await mk("Alice2"), B = await mk("Bob2", { statePath: path.join(dir, "b.json") });
  await A.c.connect(); A.c.addPeer(B.identity.id, B.identity.publicKeyJwk);
  await B.c.connect(); B.c.close(); await new Promise((r) => setTimeout(r, 200)); // Боб выложил prekey и ушёл
  await A.c.sendText(B.identity.id, "пока тебя не было");
  const B2 = new Client({ url: URL, identity: B.identity, statePath: path.join(dir, "b.json"), reconnect: false });
  const got = once(B2, "message");
  B2.addPeer(A.identity.id, A.identity.publicKeyJwk);
  await B2.connect();
  assert.equal((await got).text, "пока тебя не было");
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "b.json"), "utf8")).ratchet.s[A.identity.id], "сессия сохранена на диск");
  A.c.close(); B2.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("TOFU: смена ключа контакта отвергается (key-changed), пока не подтверждена явно", async () => {
  const A = await mk("Alice3"), B = await mk("Bob3"), B2 = await generateIdentity({ name: "Bob3" });
  await A.c.connect();
  A.c.addPeer(B.identity.id, B.identity.publicKeyJwk);
  let ev = null; A.c.on("key-changed", (e) => { ev = e; });
  assert.equal(A.c._learn(B.identity.id, B2.publicKeyJwk), false);
  assert.ok(ev && ev.id === B.identity.id);
  assert.equal(A.c.peers[B.identity.id].x, B.identity.publicKeyJwk.x);
  A.c.close();
});

test("каналы: бот создаёт канал, подписчик проверяет ключ по хешу из ссылки и подпись постов", async () => {
  const O = await mk("Owner"), S = await mk("Sub");
  await O.c.connect(); await S.c.connect();
  const ch = await O.c.createChannel({ name: "Новости", desc: "тест", enc: true });
  await S.c.subscribeChannel(ch.link);
  const got = once(S.c, "channel-post");
  await O.c.postToChannel(ch.id, "первый пост");
  const p = await got;
  assert.equal(p.content.text, "первый пост");
  await assert.rejects(S.c.subscribeChannel(ch.link.replace(/\.[0-9a-f]{26}/, "." + "0".repeat(26))), /hash|timeout|bad/);
  O.c.close(); S.c.close();
});

test("ESM-обёртка отдаёт тот же API", async () => {
  const esm = await import("../sdk/index.mjs");
  assert.equal(esm.Client, Client); assert.equal(typeof esm.generateIdentity, "function");
});
