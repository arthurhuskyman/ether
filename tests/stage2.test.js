// Этап 2: F1 (исчезающие от прочтения), F2 (правка/удаление/реакции в группах), F4 (общая заметка), C7 (доверие), F6 (голосовая почта), У1
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/rich.js");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted(storage) {
  const a = createApp({ storage: Object.assign({ "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" }, storage || {}) });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}
const J = (x) => JSON.parse(JSON.stringify(x));

test("F1: таймер исчезающих идёт от прочтения; непрочитанное живёт до 30 суток; старые прочитанные — по прежнему правилу", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; const t = Date.now();
    c.messages.push({ id: "u1", from: "them", text: "непрочитанное", ts: t - 3 * 3600e3, ttl: 3600e3, readAckSent: false });
    c.messages.push({ id: "r1", from: "them", text: "старое прочитанное", ts: t - 3 * 3600e3, ttl: 3600e3, readAckSent: true });
    c.messages.push({ id: "o1", from: "me", text: "моё, не прочитано", ts: t - 3 * 3600e3, ttl: 3600e3, ack: "delivered" });
    c.messages.push({ id: "f1", from: "them", text: "прочитано только что", ts: t - 3 * 3600e3, ttl: 3600e3, readAckSent: true, expAt: t + 60000 });
    sweepExpiredMessages();`);
  assert.deepEqual(J(a.run(`state.contacts.get("alice").messages.map((m) => m.id)`)), ["u1", "o1", "f1"], "непрочитанные и «ещё не истёк expAt» остались, старое прочитанное ушло");
  // чтение запускает таймер
  a.run(`const m = state.contacts.get("alice").messages.find((x) => x.id === "u1"); m.readAckSent = true; startExpiryOnRead(m);`);
  assert.ok(a.run(`state.contacts.get("alice").messages.find((x) => x.id === "u1").expAt`) > Date.now() + 3500e3);
  // подтверждение прочтения собеседником запускает таймер у исходящего
  a.run(`markMessageAck("alice", "o1", "read")`);
  assert.ok(a.run(`state.contacts.get("alice").messages.find((x) => x.id === "o1").expAt`) > 0);
  // 30 суток предел для непрочитанного
  a.run(`state.contacts.get("alice").messages.push({ id: "x1", from: "them", text: "очень старое непрочитанное", ts: Date.now() - 31 * 86400e3, ttl: 3600e3, readAckSent: false }); sweepExpiredMessages();`);
  assert.equal(a.run(`state.contacts.get("alice").messages.some((m) => m.id === "x1")`), false);
  a.close();
});

function groupSetup(a) {
  a.run(`window.__sent = [];
    const g = ensureContactEntry("grp", "Команда"); g.managed = true; g.isGroup = true; g.createdBy = "me-test-id";
    g.members = [{ id: "me-test-id", name: "Я" }, { id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }];
    for (const id of ["alice", "bob"]) { const l = new EventTarget(); Object.assign(l, { id, status: "connected", send(p) { window.__sent.push([id, p]); return true; } }); mesh.links.set(id, l); ensureContactEntry(id, id).managed = true; }
    g.messages.push({ id: "m1", from: "me", text: "привет", ts: Date.now(), ack: "sent" });
    g.messages.push({ id: "m2", from: "them", fromId: "alice", fromName: "Alice", text: "ответ", ts: Date.now(), readAckSent: true });`);
}
test("F2: в группе правка, удаление у всех и реакции уходят всем участникам и применяются у получателей", async () => {
  const a = await booted(); groupSetup(a);
  await a.run(`commitEdit("grp", "m1", "привет, команда")`);
  await a.run(`toggleReaction("grp", "m2", "👍")`);
  await a.run(`deleteMessageForBoth("grp", "m1")`);
  const kinds = J(a.run(`window.__sent.map(([to, p]) => [to, p.kind, p.groupId])`));
  for (const k of ["edit", "reaction", "delete"]) {
    assert.equal(kinds.filter((x) => x[1] === k).length, 2, k + ": каждому участнику");
    assert.ok(kinds.filter((x) => x[1] === k).every((x) => x[2] === "grp"), k + ": с groupId");
  }
  // получатель: Алиса правит своё сообщение и ставит реакцию на моё; Боб-не-участник игнорируется
  a.run(`state.contacts.get("grp").messages.push({ id: "m3", from: "me", text: "ещё", ts: Date.now(), ack: "sent" });`);
  a.run(`applyIncomingPayload("alice", "e1", { kind: "reaction", id: "m3", emoji: "❤️", remove: false, groupId: "grp", ts: Date.now() }, true)`);
  assert.deepEqual(J(a.run(`state.contacts.get("grp").messages.find((m) => m.id === "m3").reactions`)), { "❤️": ["alice"] });
  a.run(`applyIncomingPayload("alice", "e2", { kind: "edit", id: "m2", text: "исправлено", groupId: "grp", ts: Date.now() }, true)`);
  assert.equal(a.run(`state.contacts.get("grp").messages.find((m) => m.id === "m2").text`), "исправлено");
  a.run(`applyIncomingPayload("stranger", "e3", { kind: "reaction", id: "m3", emoji: "💩", remove: false, groupId: "grp", ts: Date.now() }, true)`);
  assert.equal(a.run(`Object.keys(state.contacts.get("grp").messages.find((m) => m.id === "m3").reactions).length`), 1, "не участник игнорируется");
  // чужое сообщение alice нельзя править от имени bob
  a.run(`applyIncomingPayload("bob", "e4", { kind: "edit", id: "m2", text: "подмена", groupId: "grp", ts: Date.now() }, true)`);
  assert.equal(a.run(`state.contacts.get("grp").messages.find((m) => m.id === "m2").text`), "исправлено");
  a.close();
});

test("F4: общая заметка — создание, правка, сходимость по времени, лимиты", async () => {
  const m = { note: R.sanitizeNote({ title: "Список", text: "" }) };
  assert.equal(R.applyNoteOp(m, { t: "set", text: "A" }, 10), true);
  assert.equal(R.applyNoteOp(m, { t: "set", text: "B" }, 5), false, "старая правка не затирает новую");
  assert.equal(R.applyNoteOp(m, { t: "set", text: "C" }, 20), true);
  assert.equal(m.note.text, "C");
  assert.equal(R.applyNoteOp(m, { t: "set", text: "x".repeat(10000) }, 30), true); assert.equal(m.note.text.length, R.NOTE_MAX);
  assert.equal(R.applyNoteOp(m, { t: "boom" }, 40), false);
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; unreadDividerFor.delete("alice"); state.chatId = "alice"; state.tab = "chats"; renderTab();`);
  assert.equal(await a.run(`createNote("alice", "Покупки")`), true);
  const id = a.run(`state.contacts.get("alice").messages.find((m) => m.note).id`);
  await a.run(`noteOp("alice", ${JSON.stringify(id)}, "хлеб\\nмолоко")`);
  assert.match(a.document.querySelector(".note-text").textContent, /хлеб/);
  a.run(`applyIncomingPayload("alice", "n1", { kind: "note-op", id: ${JSON.stringify(id)}, op: { t: "set", text: "хлеб, молоко, сыр" }, ts: Date.now() + 5 }, true)`);
  assert.match(a.document.querySelector(".note-text").textContent, /сыр/);
  a.close();
});

test("C7: отметка «проверен» привязана к ключу и пропадает при его смене; звонки: смена ключа блокирует, режим «только проверенным»", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.publicKey = { kty: "EC", x: "a", y: "b" };`);
  assert.equal(a.run(`isContactVerified(state.contacts.get("alice"))`), false);
  a.run(`setContactVerified("alice", true)`);
  assert.equal(a.run(`isContactVerified(state.contacts.get("alice"))`), true);
  a.run(`state.contacts.get("alice").publicKey = { kty: "EC", x: "other", y: "b" }`);
  assert.equal(a.run(`isContactVerified(state.contacts.get("alice"))`), false, "ключ сменился — отметка недействительна");
  // звонок: смена ключа
  a.run(`state.contacts.get("alice").pendingKey = { key: { kty: "EC", x: "n", y: "n" }, at: Date.now() }; window.__toasts = []; const t0 = toast; toast = (m) => { window.__toasts.push(m); };`);
  await a.run(`beginCall("alice", false)`);
  assert.match(a.run(`window.__toasts.pop()`), /ключ/i);
  assert.equal(a.run(`state.callId`), null);
  // режим «только проверенным»: спрашивает и не звонит
  a.run(`state.contacts.get("alice").pendingKey = undefined; Store.requireVerifiedCalls = true; window.__asked = 0; confirmSheet = () => { window.__asked++; return Promise.resolve(false); };`);
  await a.run(`beginCall("alice", false)`);
  assert.equal(a.run(`window.__asked`), 1); assert.equal(a.run(`state.callId`), null);
  // QR сверки: совпадение ставит отметку, несовпадение — нет
  a.run(`state.contacts.get("alice").verifiedKey = undefined; state.contacts.get("alice").publicKey = { kty: "EC", x: "a", y: "b" }; __safetyCtx = { id: "alice", key: state.contacts.get("alice").publicKey, digits: "123456", pending: false };`);
  assert.equal(a.run(`onSafetyQrScanned("ether://verify?n=999999")`), true);
  assert.equal(a.run(`isContactVerified(state.contacts.get("alice"))`), false);
  assert.equal(a.run(`onSafetyQrScanned("ether://verify?n=123456")`), true);
  assert.equal(a.run(`isContactVerified(state.contacts.get("alice"))`), true);
  assert.equal(a.run(`onSafetyQrScanned("ether://add?id=x")`), false);
  a.close();
});

test("F6: после недозвона предлагается голосовое сообщение; У1: новый профиль получает спокойный стиль, существующий — нет", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; window.__vm = []; window.__st = setTimeout; offerVoicemail = async (id) => { window.__vm.push(id); }; setTimeout = (fn) => { fn(); return 1; };
    state.currentCallRecord = { contactId: "alice", direction: "out", answeredAt: null, startedAt: Date.now() }; closeCallScreen("declined");`);
  assert.deepEqual(J(a.run(`window.__vm`)), ["alice"]);
  a.run(`window.__vm.length = 0; state.currentCallRecord = { contactId: "alice", direction: "out", answeredAt: Date.now(), startedAt: Date.now() }; closeCallScreen("failed");`);
  assert.equal(a.run(`window.__vm.length`), 0, "разговор был — не предлагаем");
  a.run(`setTimeout = window.__st;`); // иначе таймеры переподключения исполняются синхронно и после закрытия окна уходят в бесконечную рекурсию
  a.close();
  const fresh = createApp({ storage: { "ether.lang": "ru" } }); await fresh.ready;
  assert.equal(fresh.run(`FX.get("patina")`), false, "новый профиль: декор выключен");
  assert.equal(fresh.run(`fxCurrentPreset()`), "calm");
  fresh.close();
  const old = await booted();
  assert.equal(old.run(`FX.get("patina")`), true, "существующий профиль не тронут");
  old.close();
});
