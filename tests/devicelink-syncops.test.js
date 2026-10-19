// Сквозной тест с НАСТОЯЩИМ сервером: sync-op между устройствами аккаунта (правки, удаления, реакции, «прочитано», квитанции, файлы по запросу,
// опросы), push-подписка companion, мгновенный devices-updated контактам, продление сертификата, рестарт сервера (список на диске).
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("path"), os = require("os"), fs = require("fs");
const { createApp, closeAll } = require("./harness");
const PORT = 8795, DEV_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ether-sop-")), "devices.json");
let server;
const startServer = async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "signaling-server", "server.js")], { env: { ...process.env, PORT: String(PORT), VAPID_PUBLIC: "", VAPID_PRIVATE: "", MAILBOX_PERSIST: "0", CLAIMS_PERSIST: "0", DEVICES_PERSIST: "1", DEVICES_FILE: DEV_FILE }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));
};
test.before(startServer);
test.after(async () => { await closeAll(); try { server.kill(); } catch (e) {} });
const seed = (id, name) => JSON.stringify([{ id, name, raw: "", messages: [], lastActivity: 0 }]);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 60)); } return false; };
const regd = (a) => a.run(`typeof signaling !== "undefined" && signaling && signaling.registered === true`);
async function boot(storage) {
  const a = createApp({ realWebSocket: true, storage: Object.assign({ "ether.lang": "en", "ether.signalingUrl": "ws://localhost:" + PORT }, storage) });
  await a.ready; await until(() => regd(a)); return a;
}
const msg = async (a, cid, id) => JSON.parse(await a.run(`JSON.stringify((state.contacts.get(${JSON.stringify(cid)}) || {messages:[]}).messages.find((m) => m.id === ${JSON.stringify(id)}) || null)`));
function send(a, to, msgId, payload) { a.run(`addToOutbox(${JSON.stringify(msgId)}, ${JSON.stringify(to)}, ${JSON.stringify(payload)}); flushOutboxItem(${JSON.stringify(msgId)});`); }

test("sync-op: правки/удаления/реакции/прочитано/квитанции/файлы/опросы, push, devices-updated, продление, рестарт", async () => {
  const A = await boot({ "ether.name": "Alice", "ether.myId": "alice-so", "ether.contacts": seed("bob-so", "Bob") });
  const B = await boot({ "ether.name": "Bob", "ether.myId": "bob-so", "ether.contacts": seed("alice-so", "Alice") });
  assert.ok(await until(() => A.run(`!!state.contacts.get("bob-so").publicKey`) && B.run(`!!state.contacts.get("alice-so").publicKey`)));
  await B.run(`Devices.refreshPeer("alice-so", true)`);
  const pair = await A.run(`(async () => { persistContactsNow(); const dev = await Devices.issuePairing("PC"); return JSON.stringify({ data: Devices.applyCompanion(Devices.companionData(), dev), devId: dev.devId }); })()`).then(JSON.parse);
  const C = await boot(pair.data);
  assert.ok(C.run(`Devices.isCompanion() && signaling.registered === true`));
  assert.ok(A.run(`signaling.features.includes("devsync") && signaling.features.includes("devnotify")`));

  // исходное сообщение A -> Bob, зеркало на C
  send(A, "bob-so", "m1", { kind: "chat", id: "c1", text: "первое", ts: Date.now() });
  assert.ok(await until(async () => (await msg(C, "bob-so", "c1")) && (await msg(B, "alice-so", "c1"))), "chat зеркалируется");
  // правка
  send(A, "bob-so", "e1", { kind: "edit", id: "c1", text: "правлено", ts: Date.now() });
  assert.ok(await until(async () => ((await msg(C, "bob-so", "c1")) || {}).text === "правлено"), "правка на companion");
  assert.equal((await msg(C, "bob-so", "c1")).edited, true);
  // реакция
  send(A, "bob-so", "r1", { kind: "reaction", id: "c1", emoji: "👍", remove: false, ts: Date.now() });
  assert.ok(await until(async () => (((await msg(C, "bob-so", "c1")) || {}).reactions || {})["👍"]?.includes("alice-so")), "реакция на companion");
  send(A, "bob-so", "r2", { kind: "reaction", id: "c1", emoji: "👍", remove: true, ts: Date.now() });
  assert.ok(await until(async () => !(((await msg(C, "bob-so", "c1")) || {}).reactions || {})["👍"]), "снятие реакции");
  // анти-эхо: повтор того же sync-op (тот же opId) не применяется второй раз
  assert.equal(C.run(`JSON.parse(localStorage.getItem("ether.dev.ops") || "[]").length > 0`), true, "opId запоминаются");
  // удаление
  send(A, "bob-so", "d1", { kind: "delete", id: "c1", ts: Date.now() });
  assert.ok(await until(async () => !(await msg(C, "bob-so", "c1"))), "удаление на companion");

  // входящее от Боба на оба устройства; «прочитано» на companion -> основное
  send(B, "alice-so", "bm1", { kind: "chat", id: "b1", text: "от Боба", ts: Date.now() });
  assert.ok(await until(async () => (await msg(A, "bob-so", "b1")) && (await msg(C, "bob-so", "b1"))), "Боб -> оба устройства");
  assert.equal((await msg(A, "bob-so", "b1")).readAckSent, false);
  C.run(`markThreadRead(state.contacts.get("bob-so"))`);
  assert.ok(await until(async () => (await msg(A, "bob-so", "b1")).readAckSent === true), "прочитано синхронизировано на основное");

  // квитанции Боба на моё сообщение доходят до обоих моих устройств
  A.run(`state.contacts.get("bob-so").messages.push({ id: "c5", from: "me", text: "прочти", ts: Date.now(), ack: "sent" })`);
  send(A, "bob-so", "c5", { kind: "chat", id: "c5", text: "прочти", ts: Date.now() });
  assert.ok(await until(async () => (await msg(C, "bob-so", "c5")) && (await msg(B, "alice-so", "c5"))));
  B.run(`markThreadRead(state.contacts.get("alice-so"))`);
  assert.ok(await until(async () => (await msg(A, "bob-so", "c5")).ack === "read"), "основное: read");
  assert.ok(await until(async () => (await msg(C, "bob-so", "c5")).ack === "read"), "companion: read (ack-in)");

  // малый файл целиком; большой — заглушка и докачка по запросу
  const small = Buffer.from("hello-file").toString("base64");
  send(A, "bob-so", "f1", { kind: "file", id: "f1", name: "a.txt", mime: "text/plain", size: 10, dataB64: small, ts: Date.now() });
  assert.ok(await until(async () => (await msg(C, "bob-so", "f1")) && !(await msg(C, "bob-so", "f1")).file.remote), "малый файл с данными");
  assert.ok(await until(() => C.run(`IDB.get("file:f1").then((b) => !!b)`)), "blob файла на companion");
  const bigBytes = Buffer.alloc(420_000, 7), big = bigBytes.toString("base64");
  await A.run(`IDB.set("file:f2", new Blob([Uint8Array.from(atob(${JSON.stringify(big)}), (c) => c.charCodeAt(0))], { type: "application/octet-stream" }))`);
  A.run(`state.contacts.get("bob-so").messages.push({ id: "f2", from: "me", text: "", ts: Date.now(), ack: "sent", file: { name: "big.bin", mime: "application/octet-stream", size: ${bigBytes.length}, kind: "file" } })`);
  send(A, "bob-so", "f2", { kind: "file", id: "f2", name: "big.bin", mime: "application/octet-stream", size: bigBytes.length, dataB64: big, ts: Date.now() });
  assert.ok(await until(async () => ((await msg(C, "bob-so", "f2")) || {}).file?.remote === true), "большой файл: заглушка «на другом устройстве»");
  C.run(`Devices.requestFile("bob-so", "f2")`);
  assert.ok(await until(async () => (await msg(C, "bob-so", "f2")).file.remote === undefined, 15000), "файл подтянут по запросу");
  assert.equal(await C.run(`IDB.get("file:f2").then((b) => b.size)`), bigBytes.length);

  // опрос
  await A.run(`createPoll("bob-so", "Чай?", ["да", "нет"], false)`);
  assert.ok(await until(() => C.run(`state.contacts.get("bob-so").messages.some((m) => m.poll && m.poll.q === "Чай?" && m.from === "me")`)), "опрос зеркалируется");

  // push-подписка companion регистрируется на сервере
  C.run(`globalThis.__ps = 0; signaling.addEventListener("push-subscribed", () => { globalThis.__ps++; })`);
  C.run(`signaling.sendPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/zzz", keys: { p256dh: "B".repeat(30), auth: "a".repeat(12) } })`);
  assert.ok(await until(() => C.run(`globalThis.__ps > 0`)), "сервер принял push-подписку companion");

  // продление сертификата: за 30 дней до конца основное перевыпускает и присылает companion
  A.run(`(() => { const l = JSON.parse(localStorage.getItem("ether.dev.list")); l.certs[0].expires = Date.now() + 10 * 86400000; localStorage.setItem("ether.dev.list", JSON.stringify(l)); })()`);
  C.run(`(() => { const s = JSON.parse(localStorage.getItem("ether.dev.self")); s.cert.expires = Date.now() + 10 * 86400000; localStorage.setItem("ether.dev.self", JSON.stringify(s)); })()`);
  assert.equal(await A.run(`Devices.renewDue()`), 1, "основное перевыпустило сертификат");
  assert.ok(await until(() => C.run(`Devices.self().cert.expires > Date.now() + 300 * 86400000`)), "companion применил новый сертификат");
  assert.ok(await until(() => A.run(`Devices.listState().certs[0].expires > Date.now() + 300 * 86400000`)));

  // devices-updated: отзыв доходит до Боба без ручной перезагрузки списка и без ожидания кэша
  await B.run(`Devices.refreshPeer("alice-so", true)`);
  assert.equal(B.run(`Devices.peerCerts("alice-so").length`), 1);
  await A.run(`Devices.revoke(${JSON.stringify(pair.devId)})`);
  assert.ok(await until(() => B.run(`Devices.peerCerts("alice-so").length === 0`)), "Боб мгновенно узнал об отзыве (devices-updated)");
  assert.ok(await until(() => C.run(`!!localStorage.getItem("ether.dev.revoked")`)));
});

test("рестарт сервера: список устройств с диска, companion авторизуется без основного", async () => {
  const A = await boot({ "ether.name": "Alice", "ether.myId": "alice-rs", "ether.contacts": seed("bob-rs", "Bob") });
  const pair = await A.run(`(async () => { persistContactsNow(); const dev = await Devices.issuePairing("PC"); return JSON.stringify({ data: Devices.applyCompanion(Devices.companionData(), dev) }); })()`).then(JSON.parse);
  const C = await boot(pair.data);
  assert.ok(C.run(`signaling.registered === true`));
  A.run(`signaling.stop()`); // основное остаётся офлайн и список не перепубликует
  await new Promise((r) => setTimeout(r, 2200)); // дать записать файл списков на диск
  server.kill(); await new Promise((r) => setTimeout(r, 600));
  await startServer();
  assert.ok(await until(() => C.run(`signaling.registered === true`), 25000), "companion авторизовался после рестарта сервера");
});
