// V.77 B2/B3/B4/B5/B7: очистка очереди при удалении, таймер в группе, пересылка контакта, createdBy в ростере, ttl от delivered.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, J } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester";
    for (const [id, n] of [["alice", "Alice"], ["bob", "Bob"]]) { const c = ensureContactEntry(id, n); c.managed = true; }
    state.contacts.set("g1", { id: "g1", name: "Team", isGroup: true, managed: true, createdBy: "me", members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }], messages: [], lastActivity: 1 });
    state._firstRenderDone = true; window.attemptConnect = () => {}; window.attemptConnectViaRelay = async () => {};
    window.__toasts = []; toast = (m) => window.__toasts.push(m);
    window.__q = []; trySendOrQueue = async (c, id, p) => { window.__q.push({ to: c.id, id, p }); };
  })()`);
}

test("B2: удаление неотправленного личного сообщения чистит outbox и pendingNoKey, но не 'delete'", async () => {
  const a = await boot(); seed(a);
  a.run(`state.contacts.get("alice").messages.push({ id: "m1", from: "me", text: "x", ts: 1, ack: "pending" }, { id: "m2", from: "me", text: "y", ts: 2, ack: "pending" });
    outbox.set("m1", { msgId: "m1", to: "alice", payload: { kind: "chat", id: "m1", text: "x" }, sentAt: 1, attempts: 0 });
    outbox.set("m2", { msgId: "m2", to: "alice", payload: { kind: "chat", id: "m2", text: "y" }, sentAt: 1, attempts: 0 });
    outbox.set("del1", { msgId: "del1", to: "alice", payload: { kind: "delete", id: "m1" }, sentAt: 1, attempts: 0 });
    pendingNoKey.set("alice", [{ msgId: "m1", payload: { kind: "chat", id: "m1" } }, { msgId: "m2", payload: { kind: "chat", id: "m2" } }]);
    deleteMessageLocal("alice", "m1");`);
  assert.deepEqual(J(a.run(`Array.from(outbox.keys())`)), ["m2", "del1"]);
  assert.deepEqual(J(a.run(`pendingNoKey.get("alice").map((x) => x.msgId)`)), ["m2"]);
  assert.match(a.run(`Store.outboxJson`), /m2/); assert.doesNotMatch(a.run(`Store.outboxJson`), /"msgId":"m1"/);
  a.close();
});

test("B2: для группы чистятся записи по deliveryId (groupDeliveryMap) и по payload.id", async () => {
  const a = await boot(); seed(a);
  a.run(`state.contacts.get("g1").messages.push({ id: "gm1", from: "me", text: "x", ts: 1, ack: "pending" });
    groupDeliveryMap.set("d-a", { groupId: "g1", contentId: "gm1", to: "alice" });
    groupDeliveryMap.set("d-b", { groupId: "g1", contentId: "gm1", to: "bob" });
    groupDeliveryMap.set("d-other", { groupId: "g1", contentId: "gm9", to: "bob" });
    outbox.set("d-a", { msgId: "d-a", to: "alice", payload: { kind: "chat", id: "gm1", groupId: "g1" }, sentAt: 1, attempts: 0 });
    pendingNoKey.set("bob", [{ msgId: "d-b", payload: { kind: "chat", id: "gm1", groupId: "g1" } }]);
    deleteMessageLocal("g1", "gm1");`);
  assert.equal(a.run(`outbox.size`), 0);
  assert.equal(a.run(`pendingNoKey.has("bob")`), false);
  assert.deepEqual(J(a.run(`Array.from(groupDeliveryMap.keys())`)), ["d-other"]);
  a.close();
});

test("B3: таймер исчезновения в группе не уходит в очередь (ttl едет в сообщениях)", async () => {
  const a = await boot(); seed(a);
  await a.run(`setDisappearingTimer("g1", 3600000)`);
  assert.equal(a.run(`state.contacts.get("g1").disappearingTimer`), 3600000);
  assert.equal(a.run(`__q.length`), 0);
  assert.equal(a.run(`pendingNoKey.size`), 0);
  await a.run(`setDisappearingTimer("alice", 3600000)`);
  assert.equal(a.run(`__q.length`), 1);
  assert.equal(a.run(`__q[0].p.kind`), "disappearing-timer");
  a.close();
});

test("B4: forwardContact — заблокированному нельзя, в группу уходит текст каждому участнику", async () => {
  const a = await boot(); seed(a);
  a.run(`state.contacts.get("bob").blocked = true;`);
  await a.run(`forwardContact("alice", "bob")`);
  assert.equal(a.run(`__q.length`), 0);
  assert.equal(a.run(`state.contacts.get("bob").messages.length`), 0);
  await a.run(`forwardContact("alice", "g1")`);
  const q = J(a.run(`__q`));
  assert.equal(q.length, 2);
  assert.ok(q.every((x) => x.p.kind === "chat" && x.p.groupId === "g1" && /Alice/.test(x.p.text)));
  assert.equal(a.run(`state.contacts.get("g1").messages.length`), 1);
  a.run(`state.contacts.get("g1").writeRestricted = true; state.contacts.get("g1").createdBy = "alice"; state.contacts.get("g1").members[1].role = "admin";`);
  await a.run(`forwardContact("alice", "g1")`);
  assert.equal(a.run(`state.contacts.get("g1").messages.length`), 1);
  a.close();
});

test("B5: ростер содержит createdBy", async () => {
  const a = await boot(); seed(a);
  a.run(`state.contacts.get("g1").createdBy = "alice"; sendGroupRosterTo(state.contacts.get("g1"), "bob");`);
  assert.equal(a.run(`__q[0].p.createdBy`), "alice");
  a.close();
});

test("B7: без квитанций прочтения у собеседника ttl идёт от 'доставлено'", async () => {
  const a = await boot(); seed(a);
  a.run(`const al = state.contacts.get("alice"); al.peerReceiptsEnabled = false; const bo = state.contacts.get("bob");
    al.messages.push({ id: "t1", from: "me", text: "x", ts: Date.now(), ttl: 60000, ack: "sent" });
    bo.messages.push({ id: "t2", from: "me", text: "x", ts: Date.now(), ttl: 60000, ack: "sent" });
    markMessageAck("alice", "t1", "delivered"); markMessageAck("bob", "t2", "delivered");`);
  assert.ok(a.run(`state.contacts.get("alice").messages[0].expAt`) > 0);
  assert.equal(a.run(`state.contacts.get("bob").messages[0].expAt`) === undefined, true);
  a.close();
});
