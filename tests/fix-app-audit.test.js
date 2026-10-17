// Регрессии по аудиту js/app.js: сохранение полей групп/приватности, IDB-бэкап, вложения, цитаты, приглашения, блокировка, проверка канала.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester";
    for (const [id, n] of [["alice", "Alice"], ["bob", "Bob"]]) { const c = ensureContactEntry(id, n); c.managed = true; }
    state.contacts.set("g1", { id: "g1", name: "Team", isGroup: true, managed: true, createdBy: "alice", members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice", role: "admin" }, { id: "bob", name: "Bob" }], messages: [], lastActivity: 1 });
    state._firstRenderDone = true; window.attemptConnect = () => {}; window.attemptConnectViaRelay = async () => {}; })()`);
}
const fp = (a, from, payload) => a.run(`handleFilePayload(${JSON.stringify(from)}, ${JSON.stringify(payload)})`);
const ap = (a, from, payload, kind) => a.run(`applyIncomingPayload(${JSON.stringify(from)}, "env-" + Math.random(), ${JSON.stringify(payload)}, true, ${JSON.stringify(kind || null)})`);

test("writeRestricted и peer-настройки переживают перезагрузку контактов", async () => {
  const a = await boot(); seed(a);
  a.run(`state.contacts.get("g1").writeRestricted = true; const al = state.contacts.get("alice"); al.peerReceiptsEnabled = false; al.peerLastSeenVisible = false; al.peerPresenceVisible = false; al.peerStatus = "busy";
    persistContacts(); persistContactsNow(); state.contacts.clear(); loadContacts();`);
  assert.equal(a.run(`state.contacts.get("g1").writeRestricted`), true);
  assert.deepEqual(J(a.run(`(() => { const c = state.contacts.get("alice"); return [c.peerReceiptsEnabled, c.peerLastSeenVisible, c.peerPresenceVisible, c.peerStatus]; })()`)), [false, false, false, "busy"]);
  a.close();
});

test("зависшие передачи вложений после перезапуска становятся failed", async () => {
  const a = await boot(); seed(a);
  a.run(`const al = state.contacts.get("alice");
    al.messages.push({ id: "in1", from: "them", text: "", ts: 1, file: { name: "a", mime: "text/plain", size: 1, kind: "file", pending: true } }, { id: "out1", from: "me", text: "", ts: 2, ack: "sent", file: { name: "b", mime: "text/plain", size: 1, kind: "file", pending: true } });
    persistContacts(); persistContactsNow(); state.contacts.clear(); loadContacts();`);
  const ms = J(a.run(`state.contacts.get("alice").messages`));
  assert.equal(ms[0].file.pending, false); assert.equal(ms[0].file.failed, true);
  assert.equal(ms[1].file.pending, false); assert.equal(ms[1].ack, "failed");
  a.close();
});

test("file-meta с id чужого чата отклоняется; чанки только от того же отправителя", async () => {
  const a = await boot(); seed(a);
  a.run(`state.contacts.get("bob").messages.push({ id: "fx", from: "them", text: "", ts: 1, file: { name: "x", mime: "image/png", size: 3, kind: "image" } });`);
  fp(a, "alice", { kind: "file-meta", id: "fx", name: "evil", mime: "image/png", size: 3, totalChunks: 1 });
  assert.equal(a.run(`incomingFileBuffers.has("fx")`), false);
  assert.equal(a.run(`state.contacts.get("alice").messages.length`), 0);
  fp(a, "alice", { kind: "file-meta", id: "ok1", name: "a", mime: "text/plain", size: 3, totalChunks: 1 });
  assert.equal(a.run(`incomingFileBuffers.has("ok1")`), true);
  fp(a, "bob", { kind: "file-chunk", id: "ok1", index: 0, data: "AAAA" });
  assert.equal(a.run(`incomingFileBuffers.get("ok1").chunks[0]`), null);
  fp(a, "bob", { kind: "file-done", id: "ok1" });
  assert.equal(a.run(`incomingFileBuffers.has("ok1")`), true);
  a.close();
});

test("брошенный приём файла помечает сообщение failed", async () => {
  const a = await boot(); seed(a);
  fp(a, "alice", { kind: "file-meta", id: "st1", name: "a", mime: "text/plain", size: 3, totalChunks: 2 });
  a.run(`incomingFileBuffers.get("st1").receivedAt = Date.now() - 10 * 60 * 1000; sweepIncomingFileBuffers();`);
  const m = J(a.run(`state.contacts.get("alice").messages[0]`));
  assert.equal(m.file.pending, false); assert.equal(m.file.failed, true);
  a.close();
});

test("цитата берёт текст и автора из локального сообщения, поля обрезаются", async () => {
  const a = await boot(); seed(a);
  a.run(`state.contacts.get("alice").messages.push({ id: "orig", from: "me", text: "real text", ts: 1, ack: "read" });`);
  ap(a, "alice", { kind: "chat", id: "r1", text: "hi", replyTo: { id: "orig", text: "FAKE", authorName: "Mallory" } });
  ap(a, "alice", { kind: "chat", id: "r2", text: "hi", replyTo: { id: "unknown", text: "x".repeat(500), authorName: "y".repeat(100), evil: 1 } });
  const ms = J(a.run(`state.contacts.get("alice").messages`));
  const r1 = ms.find((m) => m.id === "r1").replyTo, r2 = ms.find((m) => m.id === "r2").replyTo;
  assert.equal(r1.text, "real text"); assert.equal(r1.authorName, "Tester");
  assert.equal(r2.text.length, 200); assert.equal(r2.authorName.length, 40); assert.equal(r2.evil, undefined);
  a.close();
});

test("group-invite: поля очищаются, writeRestricted применяется; ростер его несёт", async () => {
  const a = await boot(); seed(a);
  ap(a, "alice", { kind: "group-invite", id: "i1", groupId: "gnew", groupName: "N".repeat(200), members: [{ id: "me", name: "T".repeat(100), role: "root", x: 1 }, { id: "alice", name: "Alice", role: "admin" }], writeRestricted: true });
  const g = J(a.run(`state.contacts.get("gnew")`));
  assert.equal(g.name.length, 60); assert.equal(g.members[0].name.length, 40); assert.equal(g.members[0].role, undefined); assert.equal(g.members[0].x, undefined);
  assert.equal(g.writeRestricted, true);
  // дубликаты id в списке — приглашение отклоняется
  ap(a, "alice", { kind: "group-invite", id: "i2", groupId: "gdup", members: [{ id: "me", name: "a" }, { id: "me", name: "b" }] });
  assert.equal(a.run(`state.contacts.has("gdup")`), false);
  a.run(`window.__sent = []; window.trySendOrQueue = async (c, id, p) => { window.__sent.push(p); };`);
  a.run(`state.contacts.get("g1").writeRestricted = true; sendGroupRosterTo(state.contacts.get("g1"), "alice");`);
  assert.equal(a.run(`window.__sent[0].writeRestricted`), true);
  a.close();
});

test("квитанция «прочитано» принимается, даже если свои квитанции выключены", async () => {
  const a = await boot(); seed(a);
  a.run(`Store.receiptsEnabled = false; state.contacts.get("alice").messages.push({ id: "m1", from: "me", text: "x", ts: 1, ack: "sent" }); markMessageAck("alice", "m1", "read");`);
  assert.equal(a.run(`state.contacts.get("alice").messages[0].ack`), "read");
  a.close();
});

test("trimMessages удаляет блобы обрезанной истории; пересылка уважает таймер исчезновения", async () => {
  const a = await boot(); seed(a);
  a.run(`window.__del = []; const od = IDB.del; IDB.del = (k) => { window.__del.push(k); return Promise.resolve(); };
    const c = state.contacts.get("alice"); c.messages = [{ id: "old", from: "them", text: "", ts: 1, file: { name: "a", mime: "x", size: 1, kind: "file" } }];
    for (let i = 0; i < MAX_MESSAGES_PER_CHAT; i++) c.messages.push({ id: "n" + i, from: "them", text: "t", ts: 2 + i });
    trimMessages(c);`);
  assert.deepEqual(J(a.run(`window.__del`)), ["file:old"]);
  a.run(`window.__sent = []; window.trySendOrQueue = async (c, id, p) => { window.__sent.push(p); };
    const al = state.contacts.get("alice"); al.disappearingTimer = 60000; al.messages = [{ id: "src", from: "me", text: "hello", ts: 1, ack: "read" }];
    state.contacts.get("bob").disappearingTimer = 30000;`);
  a.run(`forwardMessage("src", "alice", "bob")`); await sleep(50);
  assert.equal(a.run(`window.__sent[0].ttl`), 30000);
  a.close();
});

test("блокировка рвёт P2P-канал и не шлёт профиль", async () => {
  const a = await boot(); seed(a);
  a.run(`window.__rm = []; mesh.remove = (id) => window.__rm.push(id); window.__sentP = [];
    mesh.get = (id) => ({ status: "connected", send: (p) => { window.__sentP.push(p); return true; } });
    const c = state.contacts.get("alice"); c.blocked = true; sendPrivacyPrefsTo("alice"); sendGroupRosterTo(state.contacts.get("g1"), "alice");`);
  assert.equal(a.run(`window.__sentP.length`), 0);
  a.close();
});

test("устаревший линк не закрывает новый по таймеру проверки", async () => {
  const a = await boot(); seed(a);
  a.run(`window.__rm = []; const oldLink = { authGate: "pending", _authBuf: [], status: "connected" }; const newLink = { authGate: null, status: "connected" };
    mesh.get = () => newLink; mesh.remove = (id) => window.__rm.push(id); state.contacts.get("alice").authSeen = true;
    authTimeout("alice", oldLink); window.__gate = oldLink.authGate;`);
  assert.deepEqual(J(a.run(`window.__rm`)), []);
  assert.equal(a.run(`window.__gate`), "closed");
  a.close();
});

test("relay-deliver от неизвестного from не создаёт контакт", async () => {
  const a = await boot(); seed(a);
  a.run(`handleRelayPayload("alice", { kind: "relay-deliver", from: "phantom", packet: { sdp: "x" } });`);
  assert.equal(a.run(`state.contacts.has("phantom")`), false);
  a.close();
});

test("openFromNotification игнорирует неизвестный контакт; PIN-счётчик сохраняется", async () => {
  const a = await boot(); seed(a);
  a.run(`state.chatId = null; openFromNotification("ghost", "call", false, { ts: Date.now() });`);
  assert.equal(a.run(`state.callId`), null);
  assert.equal(a.run(`state.chatId`), null);
  a.run(`localStorage.setItem("ether.unlockAttempts", "3"); state.unlockAttempts = 0; showLockScreen();`);
  assert.equal(a.run(`state.unlockAttempts`), 3);
  a.close();
});

test("настройки приватности входят в IDB-бэкап; удалённые ключи удаляются из IDB", async () => {
  const a = await boot(); seed(a);
  assert.ok(a.run(`CRITICAL_LS_KEYS.includes("ether.receiptsEnabled") && CRITICAL_LS_KEYS.includes("ether.presenceVisible")`));
  a.run(`window.__idbDel = []; IDB.del = (k) => { window.__idbDel.push(k); return Promise.resolve(); }; IDB.set = () => Promise.resolve(); localStorage.removeItem("ether.drafts");`);
  await a.run(`backupToIDB()`);
  assert.ok(J(a.run(`window.__idbDel`)).includes("ether.drafts"));
  a.close();
});

test("экспорт с паролем при ошибке шифрования ничего не скачивает", async () => {
  const a = await boot(); seed(a);
  a.run(`window.__dl = 0; window.downloadBlob = () => { window.__dl++; }; window.openBackupPasswordSheet = async () => "pw"; window.encryptBackupPayload = async () => { throw new Error("no crypto"); };`);
  await a.run(`exportBackup()`);
  assert.equal(a.run(`window.__dl`), 0);
  a.close();
});
