// Покрытие app.js: приём payload'ов каждого вида (корректные и мусорные), доставка из ящика, квитанции, outbox, события сигналинга, relay, проверка канала.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    for (const [id, n] of [["alice", "Alice"], ["bob", "Bob"]]) { const c = ensureContactEntry(id, n); c.managed = true; }
    state.contacts.set("g1", { id: "g1", name: "Team", isGroup: true, managed: true, createdBy: "alice", members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice", role: "admin" }, { id: "bob", name: "Bob" }], messages: [], lastActivity: 1 });
    state._firstRenderDone = true; persistContacts(); window.attemptConnect = () => {}; window.attemptConnectViaRelay = async () => {}; })()`);
}
const ap = (a, from, payload, kind) => a.run(`applyIncomingPayload(${JSON.stringify(from)}, "env-" + Math.random(), ${JSON.stringify(payload)}, true, ${JSON.stringify(kind || null)})`);
const msgs = (a, id) => J(a.run(`state.contacts.get(${JSON.stringify(id)}).messages`));

test("chat: личный и групповой, валидация, упоминания, ответ/пересылка/ttl, открытый и закрытый чат, уведомления", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`Store.notificationsEnabled = true; Notification = class { static get permission() { return "granted"; } }; window.Notification = Notification; window.__notes = []; window.showNotification = (...x) => { window.__notes.push(x); };`);
  ap(a, "alice", { kind: "chat", id: "c1", text: "hello", ts: Date.now(), replyTo: { id: "x", text: "q" }, forwarded: true, fwdFrom: "Zed", ttl: 60000 });
  ap(a, "alice", { kind: "chat", id: "c1", text: "dup" }); ap(a, "alice", { kind: "chat", id: "c2" }); ap(a, "alice", { kind: "chat", id: "c3", text: 5 });
  ap(a, "stranger", { kind: "chat", id: "s1", text: "from new" }); assert.ok(a.run(`state.contacts.has("stranger")`));
  const m = msgs(a, "alice")[0]; assert.equal(m.text, "hello"); assert.equal(m.forwardedFrom, "Zed"); assert.equal(m.ttl, 60000); assert.equal(m.replyTo.id, "x");
  a.run(`state.chatId = "alice"; renderTab();`); ap(a, "alice", { kind: "chat", id: "c4", text: "while open" }); assert.equal(msgs(a, "alice").length, 2);
  // группа
  ap(a, "bob", { kind: "chat", id: "g1m", text: "hi @Tester please", groupId: "g1", senderName: "Fake" });
  const gm = msgs(a, "g1")[0]; assert.equal(gm.fromName, "Bob"); assert.equal(gm.mentionMe, true); assert.ok(a.run(`state.mentionedChats.has("g1")`));
  ap(a, "stranger", { kind: "chat", id: "g2", text: "x", groupId: "g1" }); ap(a, "bob", { kind: "chat", id: "g3", text: "x", groupId: "nope" }); ap(a, "bob", { kind: "chat", id: "g4", text: "x", groupId: "alice" });
  a.run(`state.contacts.get("g1").writeRestricted = true;`); ap(a, "bob", { kind: "chat", id: "g5", text: "denied", groupId: "g1" }); ap(a, "alice", { kind: "chat", id: "g6", text: "admin ok", groupId: "g1" });
  assert.deepEqual(msgs(a, "g1").map((x) => x.id), ["g1m", "g6"]);
  a.run(`state.contacts.get("g1").writeRestricted = false; state.contacts.get("g1").members = state.contacts.get("g1").members.filter((m) => m.id !== "stranger");`);
  ap(a, "alice", {}, "chat");
  a.close();
});

test("file/файл одним payload, contact-card, disappearing-timer, heartbeat, privacy-pref, typing, story", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const b64 = Buffer.from("hello file").toString("base64");
  ap(a, "alice", { kind: "file", id: "f1", name: "a.txt", mime: "text/plain", size: 10, dataB64: b64, ts: Date.now(), forwarded: true, fwdFrom: "Q", caption: "cap", duration: 3, wave: [1, 2, 3, 4], ttl: 60000 });
  ap(a, "alice", { kind: "file", id: "f1", name: "dup", size: 10, dataB64: b64 }); ap(a, "alice", { kind: "file", id: "f2", size: -5, dataB64: b64 }); ap(a, "alice", { kind: "file", id: "f3", size: 5, dataB64: "!!!" });
  ap(a, "alice", { kind: "file", id: "f4", name: "n", mime: "audio/webm", size: 10, dataB64: b64, groupId: "g1" }); ap(a, "bob", { kind: "file", id: "f5", name: "g.png", mime: "image/png", size: 10, dataB64: b64, groupId: "g1" });
  ap(a, "stranger", { kind: "file", id: "f6", size: 10, dataB64: b64, groupId: "g1" }); ap(a, "bob", { kind: "file", id: "f7", size: 10, dataB64: b64, groupId: "nope" });
  a.run(`state.contacts.get("g1").writeRestricted = true;`); ap(a, "bob", { kind: "file", id: "f8", size: 10, dataB64: b64, groupId: "g1" }); a.run(`state.contacts.get("g1").writeRestricted = false; state.contacts.get("alice").disappearingTimer = 3600000;`);
  ap(a, "alice", { kind: "file", id: "f9", name: "n", mime: "image/png", size: 10, dataB64: b64 }); a.run(`state.chatId = "alice"; renderTab();`); ap(a, "alice", { kind: "file", id: "f10", name: "n", mime: "image/png", size: 10, dataB64: b64 });
  await sleep(60);
  assert.deepEqual(msgs(a, "alice").map((x) => x.id), ["f1", "f9", "f10"]); assert.equal(msgs(a, "alice")[0].file.caption, "cap"); assert.equal(msgs(a, "alice")[1].ttl, 3600000); assert.deepEqual(msgs(a, "g1").map((x) => x.id), ["f4", "f5"]);
  // IDB.set падает: сообщение остаётся
  a.run(`IDB.set = async () => { throw new Error("idb"); };`); ap(a, "alice", { kind: "file", id: "f11", name: "n", mime: "x/y", size: 10, dataB64: b64 }); await sleep(30); assert.ok(msgs(a, "alice").some((x) => x.id === "f11"));
  // contact-card
  ap(a, "alice", { kind: "contact-card", id: "cc1", contactId: "carol", contactName: "Carol", forwarded: true, fwdFrom: "Z" }); ap(a, "alice", { kind: "contact-card", id: "cc1", contactId: "carol" }); ap(a, "bob", { kind: "contact-card", id: "cc2", contactId: "x" });
  a.run(`state.chatId = "alice"; renderTab();`); ap(a, "alice", { kind: "contact-card", id: "cc3", contactId: "dave", contactName: "Dave" });
  assert.ok(msgs(a, "alice").some((x) => x.contactCard && x.contactCard.id === "dave"));
  // disappearing-timer
  ap(a, "bob", { kind: "disappearing-timer", timer: 3600000 }); ap(a, "bob", { kind: "disappearing-timer", timer: 3600000 }); ap(a, "bob", { kind: "disappearing-timer", timer: 5 }); ap(a, "bob", { kind: "disappearing-timer", timer: "x" }); ap(a, "bob", { kind: "disappearing-timer", timer: 0 });
  assert.equal(a.run(`state.contacts.get("bob").disappearingTimer`), 0); assert.equal(msgs(a, "bob").filter((m) => m.from === "system").length, 2);
  // heartbeat
  ap(a, "alice", { kind: "heartbeat", ts: 12345, thresholdDays: 3 }); ap(a, "ghost", { kind: "heartbeat" }); assert.equal(a.run(`state.contacts.get("alice").lastHeartbeatAt`), 12345); assert.equal(a.run(`state.contacts.get("alice").heartbeatThresholdDays`), 3);
  // privacy-pref
  const avatar = "data:image/png;base64,AAAA";
  ap(a, "alice", { kind: "privacy-pref", receiptsEnabled: false, lastSeenVisible: false, presenceVisible: false, status: "s".repeat(300), avatar });
  const al = J(a.run(`state.contacts.get("alice")`)); assert.equal(al.peerReceiptsEnabled, false); assert.equal(al.peerStatus.length, 140); assert.equal(al.peerAvatar, avatar);
  ap(a, "alice", { kind: "privacy-pref", avatar: "" }); assert.equal(a.run(`state.contacts.get("alice").peerAvatar`), undefined); ap(a, "alice", { kind: "privacy-pref", avatar: "javascript:evil" }); ap(a, "ghost", { kind: "privacy-pref" });
  assert.equal(a.run(`state.contacts.get("alice").peerReceiptsEnabled`), true);
  // typing
  ap(a, "alice", { kind: "typing", active: true }); assert.ok(a.run(`state.typingTimers.has("alice")`)); ap(a, "alice", { kind: "typing", active: true }); t.tick(10000); assert.ok(!a.run(`state.typingTimers.has("alice")`)); ap(a, "alice", { kind: "typing", active: false });
  // story
  ap(a, "alice", { kind: "story", id: "st1", text: "story text", ts: Date.now() }); assert.ok(a.run(`loadStories().some((s) => s.id === "st1")`));
  a.close();
});

test("group-invite / group-settings / join-request: права, дедупликация, склейка по составу, самовыход, лимиты", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const inv = (extra) => Object.assign({ kind: "group-invite", id: "inv-" + Math.random(), groupId: "newg", groupName: "New Group", members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice", role: "admin" }, { id: "bob", name: "Bob" }] }, extra || {});
  ap(a, "alice", inv({ groupAvatar: "data:image/png;base64,AAAA", groupDescription: "descr" })); const g = J(a.run(`state.contacts.get("newg")`)); assert.equal(g.name, "New Group"); assert.equal(g.createdBy, "alice"); assert.equal(g.avatar, "data:image/png;base64,AAAA"); assert.equal(g.description, "descr"); assert.equal(g.messages.length, 1);
  const same = inv({ id: "same-id" }); ap(a, "alice", same); ap(a, "alice", same); ap(a, "alice", inv({ id: "i1", members: [] })); ap(a, "alice", inv({ id: "i2", members: [{ id: "alice" }] })); ap(a, "alice", inv({ id: "i3", members: Array.from({ length: 300 }, (_, i) => ({ id: "m" + i })) })); ap(a, "alice", inv({ id: "i4", members: "x" }));
  // инвайт с другим groupId, но тем же составом/именем от админа: склейка
  ap(a, "alice", inv({ id: "i5", groupId: "renamed-id" })); assert.ok(a.run(`state.contacts.has("renamed-id")`) && !a.run(`state.contacts.has("newg")`));
  // от админа: обновление состава, имени, аватара, описания
  ap(a, "alice", inv({ id: "i6", groupId: "renamed-id", groupName: "Renamed", groupAvatar: "javascript:x", groupDescription: "new d", members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice", role: "admin" }, { id: "bob", name: "Bob" }, { id: "dan", name: "Dan" }] }));
  const g2 = J(a.run(`state.contacts.get("renamed-id")`)); assert.equal(g2.name, "Renamed"); assert.equal(g2.members.length, 4); assert.equal(g2.avatar, null);
  // не админ меняет состав — отклонено; самовыход — применяется
  ap(a, "bob", inv({ id: "i7", groupId: "renamed-id", groupName: "Hack", members: [{ id: "me" }, { id: "bob" }] })); assert.equal(a.run(`state.contacts.get("renamed-id").name`), "Renamed");
  ap(a, "dan", inv({ id: "i8", groupId: "renamed-id", members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }] })); assert.ok(!a.run(`state.contacts.get("renamed-id").members.some((m) => m.id === "dan")`));
  // group-settings
  ap(a, "alice", { kind: "group-settings", groupId: "renamed-id", writeRestricted: true }); assert.equal(a.run(`state.contacts.get("renamed-id").writeRestricted`), true);
  ap(a, "bob", { kind: "group-settings", groupId: "renamed-id", writeRestricted: false }); assert.equal(a.run(`state.contacts.get("renamed-id").writeRestricted`), true);
  ap(a, "alice", { kind: "group-settings", groupId: "nope", writeRestricted: false }); ap(a, "alice", { kind: "group-settings", groupId: "renamed-id", writeRestricted: "yes" });
  a.run(`state.activeGroupContext = "renamed-id"; state.chatId = "renamed-id";`); ap(a, "alice", { kind: "group-settings", groupId: "renamed-id", writeRestricted: false });
  // join-request (я админ g2)
  a.run(`{ const g = state.contacts.get("renamed-id"); g.createdBy = "me"; g.members.find((m) => m.id === "me").role = "admin"; } window.addGroupMember = (gid, id) => { (window.__added = window.__added || []).push(id); };`);
  ap(a, "newbie", { kind: "group-join-request", groupId: "renamed-id", requesterName: "Newbie" }); ap(a, "alice", { kind: "group-join-request", groupId: "renamed-id" }); a.run(`state.contacts.get("renamed-id").banned = ["banned1"];`); ap(a, "banned1", { kind: "group-join-request", groupId: "renamed-id" }); ap(a, "x", { kind: "group-join-request", groupId: "nope" });
  a.run(`{ const g = state.contacts.get("renamed-id"); while (g.members.length < MAX_GROUP_MEMBERS) g.members.push({ id: "f" + g.members.length, name: "F" }); }`); ap(a, "late", { kind: "group-join-request", groupId: "renamed-id" });
  a.run(`{ const g = state.contacts.get("renamed-id"); g.members = g.members.slice(0, 3); g.createdBy = "alice"; g.members.find((m) => m.id === "me").role = "member"; }`); ap(a, "newbie2", { kind: "group-join-request", groupId: "renamed-id" });
  assert.deepEqual(J(a.window.__added), ["newbie"]);
  a.close();
});

test("edit / delete / ack / ack-batch / reaction: права, группы, мусор", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`{ const al = state.contacts.get("alice"); al.messages.push({ id: "m1", from: "them", text: "orig", ts: 1 }, { id: "mine", from: "me", text: "my", ts: 2, ack: "sent" }); const g = state.contacts.get("g1"); g.messages.push({ id: "gm1", from: "them", fromId: "bob", text: "bobs", ts: 1 }, { id: "gme", from: "me", text: "mine", ts: 2, ack: "sent" }); }`);
  ap(a, "alice", { kind: "edit", id: "m1", text: "changed", ts: 5 }); ap(a, "alice", { kind: "edit", id: "mine", text: "hack" }); ap(a, "alice", { kind: "edit", id: "m1", text: 5 }); ap(a, "alice", { kind: "edit", id: "none", text: "x" });
  assert.equal(msgs(a, "alice")[0].text, "changed"); assert.equal(msgs(a, "alice")[1].text, "my");
  a.run(`state.chatId = "alice"; renderTab();`); ap(a, "alice", { kind: "edit", id: "m1", text: "while open" });
  ap(a, "bob", { kind: "edit", id: "gm1", text: "edited", groupId: "g1" }); ap(a, "alice", { kind: "edit", id: "gm1", text: "admin hack", groupId: "g1" }); ap(a, "stranger", { kind: "edit", id: "gm1", text: "x", groupId: "g1" }); ap(a, "bob", { kind: "edit", id: "gm1", text: "x", groupId: "nope" });
  assert.equal(msgs(a, "g1")[0].text, "edited");
  ap(a, "alice", { kind: "delete", id: "mine" }); assert.equal(msgs(a, "alice").length, 2); ap(a, "alice", { kind: "delete", id: "m1" }); assert.equal(msgs(a, "alice").length, 1); ap(a, "alice", { kind: "delete", id: "zz" });
  ap(a, "alice", { kind: "delete", id: "gm1", groupId: "g1" }); ap(a, "bob", { kind: "delete", id: "gm1", groupId: "g1" }); assert.equal(msgs(a, "g1").length, 1); ap(a, "bob", { kind: "delete", id: "gm1", groupId: "nope" });
  // квитанции
  ap(a, "alice", { kind: "ack-batch", ids: ["mine", 5, "zz"], state: "delivered" }); assert.equal(msgs(a, "alice")[0].ack, "delivered"); ap(a, "alice", { kind: "ack-batch", ids: ["mine"], state: "read" }); assert.equal(msgs(a, "alice")[0].ack, "read");
  ap(a, "alice", { kind: "ack-batch", ids: ["mine"], state: "failed" }); ap(a, "alice", { kind: "ack-batch", ids: ["mine"] }); ap(a, "alice", { kind: "ack", id: "mine", state: "sent" }); ap(a, "alice", { kind: "ack-batch", ids: "x", state: "read" }); assert.equal(msgs(a, "alice")[0].ack, "read");
  ap(a, "bob", { kind: "ack-batch", ids: ["gme"], state: "delivered" }); assert.equal(msgs(a, "g1")[0].ack, "delivered");
  a.run(`Store.receiptsEnabled = false;`); ap(a, "bob", { kind: "ack-batch", ids: ["gme"], state: "read" }); a.run(`Store.receiptsEnabled = true;`);
  // реакции
  ap(a, "alice", { kind: "reaction", id: "mine", emoji: "👍" }); ap(a, "alice", { kind: "reaction", id: "mine", emoji: "👍" }); assert.deepEqual(msgs(a, "alice")[0].reactions, { "👍": ["alice"] });
  ap(a, "alice", { kind: "reaction", id: "mine", emoji: "👍", remove: true }); assert.equal(msgs(a, "alice")[0].reactions["👍"], undefined); ap(a, "alice", { kind: "reaction", id: "mine", emoji: "👍", remove: true });
  for (const bad of ["", "__proto__", "constructor", "x".repeat(20), 5, null]) ap(a, "alice", { kind: "reaction", id: "mine", emoji: bad });
  ap(a, "alice", { kind: "reaction", id: "zz", emoji: "❤️" }); ap(a, "bob", { kind: "reaction", id: "gme", emoji: "❤️", groupId: "g1" }); ap(a, "ghost", { kind: "reaction", id: "x", emoji: "x" }); a.run(`state.chatId = "alice"; renderTab();`); ap(a, "alice", { kind: "reaction", id: "mine", emoji: "🔥" });
  a.close();
});

test("handleDeliver: расшифровка v1/v2, дубликаты, заблокированные, нет ключа, удержание при смене ключа", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(await a.run(`(async () => { const o = {};
    const me = await CryptoHelper.generateKeyPair(), al = await CryptoHelper.generateKeyPair(); Store.myPrivateKeyJwk = me.privateKeyJwk; Store.myPublicKeyJwk = me.publicKeyJwk;
    const c = state.contacts.get("alice"); c.publicKey = al.publicKeyJwk;
    const acks = []; const sent = []; window.sendAckBatch = (...x) => acks.push(x); signaling = { mailboxAck: (id) => sent.push(id), connected: true, features: [], signal() { return true; }, deliver() { return true; } };
    const key = await CryptoHelper.deriveSharedKey(al.privateKeyJwk, me.publicKeyJwk);
    const env1 = await CryptoHelper.encryptJson(key, { kind: "chat", id: "d1", text: "v1 text" }); env1.rc = 1; env1.e2 = 1;
    await handleDeliver({ from: "alice", msgId: "d1", envelope: env1, fromPublicKey: al.publicKeyJwk, kind: "chat" }, false); o.v1 = c.messages.some((m) => m.id === "d1"); o.flags = [c.rc, c.e2];
    await handleDeliver({ from: "alice", msgId: "d1", envelope: env1, kind: "chat" }, false); o.dupAck = acks.length;
    const env2 = await CryptoHelper.encryptJson(key, { kind: "chat", id: "d2", text: "v2 text" }, CryptoHelper.envAad("alice", "me")); env2.v = 2;
    await handleDeliver({ from: "alice", msgId: "d2", envelope: env2, kind: "chat" }, false); o.v2 = c.messages.some((m) => m.id === "d2");
    await handleDeliver({ from: "alice", msgId: "d3", envelope: { iv: "AAAA", ct: "bad" }, kind: "chat" }, false); o.bad = !c.messages.some((m) => m.id === "d3");
    c.blocked = true; await handleDeliver({ from: "alice", msgId: "d4", envelope: env1, kind: "chat" }, false); c.blocked = false; o.blockedAck = acks.length;
    const stranger = ensureContactEntry("zed", "Zed"); stranger.publicKey = null; await handleDeliver({ from: "zed", msgId: "z1", envelope: env1, kind: "chat" }, false); o.noKey = stranger.messages.length;
    // смена ключа: удерживается
    const other = await CryptoHelper.generateKeyPair(); await handleDeliver({ from: "alice", msgId: "d5", envelope: env1, fromPublicKey: other.publicKeyJwk, kind: "chat" }, false); o.held = heldDeliveries.some((h) => h.msgId === "d5"); o.pending = !!c.pendingKey;
    await handleDeliver({ from: "alice", msgId: "d5", envelope: env1, fromPublicKey: other.publicKeyJwk, kind: "chat" }, true); o.heldOnce = heldDeliveries.filter((h) => h.msgId === "d5").length;
    c.rejectedKey = other.publicKeyJwk; c.pendingKey = undefined; await handleDeliver({ from: "alice", msgId: "d6", envelope: env1, fromPublicKey: other.publicKeyJwk, kind: "chat" }, false); o.rejectedDrop = !heldDeliveries.some((h) => h.msgId === "d6");
    o.mailboxAcks = sent.length; return o; })()`));
  assert.equal(r.v1, true); assert.deepEqual(r.flags, [true, true]); assert.equal(r.dupAck, 2); assert.equal(r.v2, true); assert.equal(r.bad, true); assert.equal(r.noKey, 0); assert.equal(r.held, true); assert.equal(r.pending, true); assert.equal(r.heldOnce, 1); assert.equal(r.rejectedDrop, true); assert.ok(r.mailboxAcks >= 5);
  a.close();
});

test("outbox: flushOutboxItem (нет ключа, нет контакта, успех, отказ), prune, resume, pendingNoKey, квитанции, печатает", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(await a.run(`(async () => { const o = {};
    const me = await CryptoHelper.generateKeyPair(), al = await CryptoHelper.generateKeyPair(); Store.myPrivateKeyJwk = me.privateKeyJwk; Store.myPublicKeyJwk = me.publicKeyJwk;
    const c = state.contacts.get("alice"); c.messages.push({ id: "o1", from: "me", text: "x", ts: Date.now(), ack: "pending" }, { id: "o2", from: "me", text: "y", ts: Date.now() - 1000, ack: "failed" }, { id: "of", from: "me", text: "", ts: Date.now(), ack: "pending", file: { pending: true, name: "f" } });
    const delivered = []; signaling = { connected: true, features: [], registered: true, deliver: (to, id, env, pk, kind) => { delivered.push([to, id, kind]); return !window.__failDeliver; }, mailboxAck() {}, signal() { return true; } };
    // нет ключа
    addToOutbox("o1", "alice", { kind: "chat", id: "o1", text: "x" }); await flushOutboxItem("o1"); o.noKey = [c.messages[0].ack, pendingNoKey.has("alice"), outbox.has("o1")];
    addToOutbox("of", "alice", { kind: "file", id: "of" }); await flushOutboxItem("of"); o.filePending = c.messages[2].file.pending;
    await flushOutboxItem("none"); addToOutbox("ghost1", "ghost", { kind: "chat" }); await flushOutboxItem("ghost1"); o.ghost = outbox.has("ghost1");
    outbox.set("srv", { msgId: "srv", to: "alice", payload: {}, sentAt: Date.now(), serverAcked: true }); await flushOutboxItem("srv"); o.srvAcked = outbox.has("srv");
    // появился ключ: уходит
    c.publicKey = al.publicKeyJwk; c.pendingKey = null; flushPendingNoKey("alice"); await new Promise((r) => __realTO.call(window, r, 60)); o.afterKey = [delivered.length, c.messages[0].ack, pendingNoKey.has("alice")];
    addToOutbox("o2", "alice", { kind: "chat", id: "o2", text: "y" }); window.__failDeliver = true; await flushOutboxItem("o2"); o.failed = c.messages[1].ack; window.__failDeliver = false;
    addToOutbox("ob", "alice", { kind: "poll", idbKey: "file:nonexistent", id: "ob" }); await flushOutboxItem("ob"); o.hydrateMissing = outbox.has("ob");
    const bk = ensureContactEntry("badkey", "BK"); bk.publicKey = { kty: "EC", crv: "P-256", x: "AAAA", y: "AAAA" }; addToOutbox("oe", "badkey", { kind: "chat", id: "oe" }); await flushOutboxItem("oe");
    // flush / prune / resume
    outbox.clear(); signaling.connected = false; await flushOutbox(); signaling.connected = true;
    outbox.set("old", { msgId: "old", to: "alice", payload: { kind: "chat" }, sentAt: Date.now() - OUTBOX_MAX_AGE_MS - 5000 }); outbox.set("oldack", { msgId: "oldack", to: "alice", payload: { kind: "ack-batch" }, sentAt: Date.now() - RECEIPT_MAX_AGE_MS - 5000 }); outbox.set("sa", { msgId: "sa", to: "alice", payload: {}, sentAt: Date.now(), serverAcked: true });
    pruneOutbox(); o.pruned = outbox.size;
    c.messages.push({ id: "rs1", from: "me", text: "resume me", ts: Date.now() - 1000, ack: "failed", replyTo: { id: "x", text: "y", authorName: "z" }, ttl: 60000 }, { id: "rs2", from: "me", text: "", ts: Date.now(), ack: "failed", file: {} }, { id: "rs3", from: "me", text: "old", ts: 1, ack: "failed" }, { id: "rs4", from: "them", ack: "failed" });
    resumeUnsentMessages(); await new Promise((r) => __realTO.call(window, r, 60)); o.resumed = c.messages.find((m) => m.id === "rs1").ack; o.notResumed = [outbox.has("rs2"), outbox.has("rs3")];
    persistPendingNoKey(); pendingNoKey.set("alice", [{ msgId: "pn", payload: { dataB64: "QQ==", id: "pn" } }]); persistPendingNoKey(); pendingNoKey.clear(); restorePendingNoKey(); o.pn = pendingNoKey.get("alice").length; Store.pendingNoKeyJson = "{bad"; restorePendingNoKey(); Store.pendingNoKeyJson = "5"; restorePendingNoKey();
    // sendAckBatch
    const sentLink = []; mesh.links.set("alice", { status: "connected", send: (p) => { sentLink.push(p); return true; } }); sendAckBatch("alice", ["m1"], "delivered"); sendAckBatch("alice", ["m1"], "delivered"); sendAckBatch("alice", [], "read"); sendAckBatch("alice", "x", "read"); o.ackSent = sentLink.length;
    state.contacts.get("alice").isSelf = true; sendAckBatch("alice", ["q"], "read"); state.contacts.get("alice").isSelf = false; mesh.links.delete("alice"); sendAckBatch("alice", ["m9"], "read"); sendAckBatch("nobody", ["m9"], "read");
    for (let i = 0; i < 210; i++) sendAckBatch("alice", ["e" + i], "sent");
    // печатает
    mesh.links.set("alice", { status: "connected", send: (p) => { sentLink.push(p); return true; } }); const n0 = sentLink.length; sendTypingStart("alice"); sendTypingStart("alice"); state.chatId = "alice"; sendTypingStop("alice"); sendTypingStop("alice"); sendTypingStart("none"); o.typing = sentLink.slice(n0).map((p) => p.active);
    mesh.links.delete("alice"); state.typingSendingState.clear(); sendTypingStart("alice"); sendTypingStop("alice"); mesh.links.set("alice", { status: "connected", send: (p) => { sentLink.push(p); return true; } }); sendPrivacyPrefsTo("alice"); sendPrivacyPrefsTo("bob"); broadcastPrivacyPrefs(); o.prefs = sentLink.filter((p) => p.kind === "privacy-pref").length;
    return o; })()`));
  assert.deepEqual(r.noKey, ["failed", true, false]); assert.equal(r.filePending, false); assert.equal(r.ghost, false); assert.equal(r.srvAcked, false); assert.ok(r.afterKey[0] >= 1); assert.equal(r.afterKey[1], "sent"); assert.equal(r.failed, "failed"); assert.equal(r.hydrateMissing, false); assert.equal(r.pruned, 0);
  assert.equal(r.resumed, "sent"); assert.deepEqual(r.notResumed, [false, false]); assert.equal(r.pn, 1); assert.equal(r.ackSent, 1); assert.deepEqual(r.typing, [true, false]); assert.ok(r.prefs >= 2);
  a.close();
});

test("applyIncomingPayload: null/не-объект payload не должен бросать исключение", { todo: "bug: js/app.js:9122 — payload === null (kind→\"chat\") даёт TypeError на payload.groupId; handleDeliver не защищён от JSON null после расшифровки" }, async () => {
  const a = await boot(); seed(a);
  assert.doesNotThrow(() => a.run(`applyIncomingPayload("alice", "e", null, true, null)`));
  assert.doesNotThrow(() => a.run(`applyIncomingPayload("alice", "e", 5, true, null)`));
  a.close();
});
