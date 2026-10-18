// Сквозной тест с НАСТОЯЩИМ сервером: основное устройство + companion + контакт. Копии по устройствам, sync-sent, fromDev, новое устройство, отзыв.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("path");
const { createApp, closeAll } = require("./harness");
const PORT = 8794;
let server;
test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "signaling-server", "server.js")], { env: { ...process.env, PORT: String(PORT), VAPID_PUBLIC: "", VAPID_PRIVATE: "", MAILBOX_PERSIST: "0", CLAIMS_PERSIST: "0" }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));
});
test.after(async () => { await closeAll(); try { server.kill(); } catch (e) {} });
const seed = (id, name) => JSON.stringify([{ id, name, raw: "", messages: [], lastActivity: 0 }]);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const regd = (a) => a.run(`typeof signaling !== "undefined" && signaling && signaling.registered === true`);
async function boot(storage) {
  const a = createApp({ realWebSocket: true, storage: Object.assign({ "ether.lang": "en", "ether.signalingUrl": "ws://localhost:" + PORT }, storage) });
  await a.ready; await until(() => regd(a)); return a;
}
const has = (a, cid, id, from) => a.run(`(state.contacts.get(${JSON.stringify(cid)}) || {messages:[]}).messages.some((m) => m.id === ${JSON.stringify(id)}${from ? ` && m.from === ${JSON.stringify(from)}` : ""})`);
const chat = (id, text) => ({ kind: "chat", id, text, ts: Date.now() });
function send(a, to, msgId, payload) { a.run(`addToOutbox(${JSON.stringify(msgId)}, ${JSON.stringify(to)}, ${JSON.stringify(payload)}); flushOutboxItem(${JSON.stringify(msgId)});`); }

test("companion: копии, sync-sent, сообщения с fromDev, предупреждение о новом устройстве, отзыв", async () => {
  const A = await boot({ "ether.name": "Alice", "ether.myId": "alice-md", "ether.contacts": seed("bob-md", "Bob") });
  const B = await boot({ "ether.name": "Bob", "ether.myId": "bob-md", "ether.contacts": seed("alice-md", "Alice") });
  assert.ok(await until(() => A.run(`!!state.contacts.get("bob-md").publicKey`) && B.run(`!!state.contacts.get("alice-md").publicKey`)), "ключи через ростер");
  assert.ok(A.run(`signaling.features.includes("devmail") && signaling.features.includes("devlist")`));
  // Боб уже сверил список устройств Алисы (пока устройств нет): дальнейшие появления считаются новыми
  await B.run(`Devices.refreshPeer("alice-md", true)`);
  // привязка companion: основное выпускает сертификат и пакет без ключа личности
  const pair = await A.run(`(async () => { persistContactsNow(); const dev = await Devices.issuePairing("Компьютер"); const data = Devices.applyCompanion(Devices.companionData(), dev); return JSON.stringify({ data, devId: dev.devId, idPriv: Store.myPrivateKeyJwk.d }); })()`).then(JSON.parse);
  assert.ok(!("ether.ratchet" in pair.data) && !("ether.claimToken" in pair.data), "ratchet и claim не переезжают");
  assert.notEqual(JSON.parse(pair.data["ether.privKey"]).d, pair.idPriv, "у companion ключ устройства, а не личности");
  assert.ok(!JSON.stringify(pair.data).includes(pair.idPriv), "секрет ключа личности не попал в пакет companion");
  const C = await boot(pair.data);
  assert.ok(C.run(`Devices.isCompanion()`) && C.run(`signaling.registered === true`), "companion зарегистрирован");
  assert.ok(A.run(`signaling.connected`) && !A.run(`signaling.shouldRun === false`), "основное не вытеснено");
  // Боб -> Алиса: оба устройства получают
  await B.run(`Devices.refreshPeer("alice-md", true)`);
  const dbg = B.run(`JSON.stringify([Devices.peers(), state.contacts.get("alice-md").messages.map((m) => m.textKey), signaling.features])`);
  assert.ok(B.run(`state.contacts.get("alice-md").messages.some((m) => m.textKey === "devices.newDevice")`), "Боб предупреждён: " + dbg);
  send(B, "alice-md", "m1", chat("c1", "привет обоим"));
  assert.ok(await until(() => has(A, "bob-md", "c1")), "основное получило");
  assert.ok(await until(() => has(C, "bob-md", "c1")), "companion получил свою копию");
  // Алиса (основное) -> Боб: Боб получает, companion получает зеркало как исходящее
  send(A, "bob-md", "m2", chat("c2", "от основного"));
  assert.ok(await until(() => has(B, "alice-md", "c2")), "Боб получил");
  assert.ok(await until(() => has(C, "bob-md", "c2", "me")), "sync-sent: companion видит отправленное как своё");
  // companion -> Боб: Боб расшифровывает по ключу устройства; основное получает зеркало
  send(C, "bob-md", "m3", chat("c3", "с компьютера"));
  assert.ok(await until(() => has(B, "alice-md", "c3", "them")), "Боб получил сообщение с устройства Алисы (fromDev)");
  assert.ok(await until(() => has(A, "bob-md", "c3", "me")), "основное видит отправленное с companion");
  // отзыв
  const devId = pair.devId;
  await A.run(`Devices.revoke(${JSON.stringify(devId)})`);
  assert.ok(await until(() => C.run(`!!localStorage.getItem("ether.dev.revoked")`)), "companion узнал об отзыве");
  send(B, "alice-md", "m4", chat("c4", "после отзыва"));
  assert.ok(await until(() => has(A, "bob-md", "c4")), "основное по-прежнему получает");
  assert.equal(C.run(`state.contacts.get("bob-md").messages.some((m) => m.id === "c4")`), false, "отозванное устройство новых копий не получает");
  await B.run(`Devices.refreshPeer("alice-md", true)`);
  assert.equal(B.run(`Devices.peerCerts("alice-md").length`), 0, "контакт обновил список: устройства нет");
});
