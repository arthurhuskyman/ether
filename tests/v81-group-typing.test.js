// V.81: «печатает…» в группах — рассылка только по живым P2P-связям, приём только от участника, подписи в шапке и списке.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

test("группа: typing уходит только живым участникам, принимается только от участника, подписи 1/2/много, автосброс", async () => {
  const a = await boot(); const t = fakeTimers(a);
  a.run(`(() => { Store.myId = "me-test-id"; Store.name = "Tester";
    for (const [id, n] of [["alice", "Alice"], ["bob", "Bob"], ["carol", "Carol"], ["dave", "Dave"]]) { const c = ensureContactEntry(id, n); c.managed = true; }
    window.trySendOrQueue = async () => {}; window.attemptConnect = () => {}; window.attemptConnectViaRelay = async () => {};
    state._firstRenderDone = true; persistContacts();
    window.__typ = [];
    const mk = (id, status) => ({ status, send: (p) => window.__typ.push([id, p]) });
    mesh.links.set("alice", mk("alice", "connected")); mesh.links.set("bob", mk("bob", "in-call")); mesh.links.set("carol", mk("carol", "connecting"));
  })()`);
  const gid = a.run(`createGroup("G", ["alice", "bob", "carol"])`);
  const r = J(a.run(`(() => { const o = {}; window.__typ.length = 0;
    sendTypingStart("${gid}"); o.start = window.__typ.map((x) => [x[0], x[1].kind, x[1].active, x[1].groupId === "${gid}"]);
    window.__typ.length = 0; sendTypingStop("${gid}"); o.stop = window.__typ.map((x) => [x[0], x[1].active]);
    const g = state.contacts.get("${gid}"); state.chatId = "${gid}"; renderTab();
    handleIncomingGroupTyping("dave", "${gid}", true); o.stranger = groupTypingLabel(g);
    handleIncomingGroupTyping("alice", "nope", true); o.noGroup = !!(state.groupTyping && state.groupTyping.get("nope"));
    handleIncomingGroupTyping("alice", "${gid}", true); o.one = groupTypingLabel(g);
    o.header = document.querySelector("#chat-peer-status").textContent;
    handleIncomingGroupTyping("bob", "${gid}", true); o.two = groupTypingLabel(g);
    handleIncomingGroupTyping("carol", "${gid}", true); o.many = groupTypingLabel(g);
    handleIncomingGroupTyping("carol", "${gid}", false); o.afterStop = groupTypingLabel(g);
    return o; })()`));
  assert.deepEqual(r.start.sort(), [["alice", "typing", true, true], ["bob", "typing", true, true]]);
  assert.deepEqual(r.stop.sort(), [["alice", false], ["bob", false]]);
  assert.equal(r.stranger, ""); assert.equal(r.noGroup, false);
  assert.match(r.one, /Alice/); assert.match(r.header, /Alice/);
  assert.match(r.two, /Alice/); assert.match(r.two, /Bob/);
  assert.match(r.many, /3/);
  assert.match(r.afterStop, /Bob/);
  t.tick(60000);
  assert.equal(a.run(`groupTypingLabel(state.contacts.get("${gid}"))`), "");
  // входящий payload с groupId идёт в групповой обработчик, без groupId — как раньше в 1:1
  a.run(`handleIncomingGroupTyping("alice", "${gid}", true)`);
  assert.match(a.run(`groupTypingLabel(state.contacts.get("${gid}"))`), /Alice/);
  a.close();
});
