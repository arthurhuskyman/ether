// Сквозной тест с НАСТОЯЩИМ сигнальным сервером: два приложения регистрируются, обмениваются ключами через ростер,
// выкладывают prekey, шлют друг другу офлайн-конверты (v1 → Double Ratchet по пакету), всё идёт через реальный WebSocket.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("path");
const { createApp, closeAll } = require("./harness");

const PORT = 8795;
let server;
test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "signaling-server", "server.js")], { env: { ...process.env, PORT: String(PORT), VAPID_PUBLIC: "", VAPID_PRIVATE: "", CLAIMS_PERSIST: "0", MAILBOX_PERSIST: "0" }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));
});
test.after(async () => { await closeAll(); try { server.kill(); } catch (e) {} });

const seed = (id, name) => JSON.stringify([{ id, name, raw: "", messages: [], lastActivity: 0 }]);
async function boot(id, name, otherId, otherName) {
  const a = createApp({ realWebSocket: true, storage: { "ether.name": name, "ether.myId": id, "ether.lang": "en", "ether.signalingUrl": "ws://localhost:" + PORT, "ether.contacts": seed(otherId, otherName) } });
  await a.ready;
  for (let i = 0; i < 100 && !a.run(`typeof signaling !== "undefined" && signaling && signaling.registered === true`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const chat = (id, text) => ({ kind: "chat", id, text, ts: Date.now() });
const has = (a, cid, id) => a.run(`(state.contacts.get(${JSON.stringify(cid)}) || {messages:[]}).messages.some((m) => m.id === ${JSON.stringify(id)})`);
function send(a, to, msgId, payload) { a.run(`addToOutbox(${JSON.stringify(msgId)}, ${JSON.stringify(to)}, ${JSON.stringify(payload)}); flushOutboxItem(${JSON.stringify(msgId)});`); }

test("настоящий сервер: ключи через ростер, prekey, v1 → Double Ratchet по пакету, ответы в обе стороны", async () => {
  const A = await boot("alice-srv", "Alice", "bob-srv", "Bob");
  const B = await boot("bob-srv", "Bob", "alice-srv", "Alice");
  assert.ok(await until(() => A.run(`!!state.contacts.get("bob-srv").publicKey`) && B.run(`!!state.contacts.get("alice-srv").publicKey`)), "ключи получены через ростер/присутствие");
  assert.ok(A.run(`signaling.features.includes("ratchet2") && signaling.features.includes("prekeys")`), "сервер объявил возможности");
  assert.ok(await until(() => A.run(`signaling.prekeyCount !== null`)), "счётчик prekey известен");
  // оба выложили пакеты
  assert.ok(await until(() => A.run(`(JSON.parse(localStorage.getItem("ether.ratchet") || "{}").pk || {}).spk !== undefined`) && B.run(`(JSON.parse(localStorage.getItem("ether.ratchet") || "{}").pk || {}).spk !== undefined`)), "пакеты подготовлены и выложены");
  B.run(`window.__kinds = []; { const od = Ratchet.decrypt; Ratchet.decrypt = (c, e) => { window.__kinds.push(e.h.p ? "x3dh" : "id"); return od(c, e); }; }`);
  A.run(`window.__kinds = []; { const od = Ratchet.decrypt; Ratchet.decrypt = (c, e) => { window.__kinds.push(e.h.p ? "x3dh" : "id"); return od(c, e); }; }`);

  // 1) первое сообщение: поддержка ещё неизвестна → прежний формат + флаг rc
  send(A, "bob-srv", "s1", chat("c1", "привет через сервер"));
  assert.ok(await until(() => has(B, "alice-srv", "c1")), "Боб получил первое сообщение");
  assert.equal(B.run(`!!state.contacts.get("alice-srv").rc`), true);
  // 2) Боб отвечает: теперь уже Double Ratchet, старт по пакету Алисы
  send(B, "alice-srv", "s2", chat("c2", "ответ"));
  assert.ok(await until(() => has(A, "bob-srv", "c2")), "Алиса получила ответ по Double Ratchet");
  const kinds = JSON.parse(A.run(`JSON.stringify(window.__kinds)`));
  assert.ok(kinds.length >= 1 && kinds.every((k) => k === "x3dh"), "всё, что Боб слал до первого ответа Алисы (в т.ч. квитанция), начато по prekey-пакету Алисы: " + kinds);
  // 3) дальше обычный обмен
  for (let i = 0; i < 3; i++) {
    send(A, "bob-srv", "a" + i, chat("ca" + i, "a" + i)); assert.ok(await until(() => has(B, "alice-srv", "ca" + i)), "A→B " + i);
    send(B, "alice-srv", "b" + i, chat("cb" + i, "b" + i)); assert.ok(await until(() => has(A, "bob-srv", "cb" + i)), "B→A " + i);
  }
  // сервер всё это время не видел открытого текста: в ящике нет полей текста (проверка на клиенте — envelope без "text")
  const env = JSON.parse(A.run(`JSON.stringify(envelopeCache.get("a2"))`));
  assert.equal(env.v, 2); assert.equal(JSON.stringify(env).includes("a2\""), false);
});

test("настоящий сервер: старый клиент (без rc/ratchet) и новый общаются прежним форматом", async () => {
  const A = await boot("alice-old", "Alice", "bob-old", "Bob");
  const B = await boot("bob-old", "Bob", "alice-old", "Alice");
  assert.ok(await until(() => A.run(`!!state.contacts.get("bob-old").publicKey`) && B.run(`!!state.contacts.get("alice-old").publicKey`)));
  // «старый» Боб: не объявляет поддержку и не умеет читать v2 — имитируем, подменив отправку на прежний формат
  A.run(`markContactEnv2 = () => {}; state.contacts.get("bob-old").e2 = false;`); // «старый» Боб не объявляет env2 ни в регистрации, ни в конвертах
  B.run(`encryptForContact = async (contact, msgId, payload) => { const k = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, contact.publicKey); return await CryptoHelper.encryptJson(k, payload); };`);
  send(B, "alice-old", "o1", chat("old1", "я старый клиент"));
  assert.ok(await until(() => has(A, "bob-old", "old1")), "новая Алиса читает старый формат");
  assert.equal(A.run(`!!state.contacts.get("bob-old").rc`), false, "флага поддержки нет — Алиса продолжает слать прежним форматом");
  send(A, "bob-old", "o2", chat("old2", "новый клиент отвечает"));
  assert.ok(await until(() => has(B, "alice-old", "old2")));
  assert.equal(JSON.parse(A.run(`JSON.stringify(envelopeCache.get("o2").v)`)), 1);
});
