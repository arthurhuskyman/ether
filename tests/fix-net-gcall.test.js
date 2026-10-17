// Голосовые комнаты: флаг комнаты, присутствие, тихий вход без приглашения, выход, истечение записей, права на флаг.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted() {
  const a = createApp({ storage: { "ether.name": "Я", "ether.myId": "me-test-id", "ether.lang": "ru" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}
function setup(a) {
  a.run(`
    window.__sent = [];
    const g = ensureContactEntry("grp", "Команда"); g.managed = true; g.isGroup = true; g.createdBy = "me-test-id";
    g.members = [{ id: "me-test-id", name: "Я" }, { id: "alice", name: "Алиса" }, { id: "bob", name: "Боб" }];
    for (const id of ["alice", "bob"]) { const l = new EventTarget(); Object.assign(l, { id, status: "connected", send(p) { window.__sent.push([id, p]); return true; }, addGroupTracks() {}, removeGroupTracks() {} }); mesh.links.set(id, l); }
    gcallAcquire = async () => { GC.stream = { getTracks: () => [], getVideoTracks: () => [] }; return true; };
    state.chatId = "grp"; state.tab = "chats"; renderTab();`);
}


test("fix-net: join повторяется, пока линк не прошёл проверку; sentJoin только после успешной отправки", async () => {
  const a = await booted(); setup(a);
  a.run(`window.__ok = false; mesh.links.get("alice").send = (p) => { window.__sent.push(["alice", p]); return window.__ok; };
    startGroupCall("grp", false);`);
  await sleep(100);
  a.run(`window.__sent.length = 0; gcallJoinRetry("alice");`);
  assert.equal(a.run(`GC.sentJoin.has("alice")`), false, "отправка отклонена — в sentJoin не пишем");
  a.run(`window.__ok = true`);
  await sleep(700);
  assert.equal(a.run(`GC.sentJoin.has("alice")`), true, "после готовности линка join ушёл");
  a.close();
});

test("fix-net: обрыв линка убирает участника; переполненный звонок не отвечает join'ом", async () => {
  const a = await booted(); setup(a);
  a.run(`startGroupCall("grp", false)`); await sleep(100);
  a.run(`handleGroupCallPayload("alice", { gid: "grp", t: "join", ts: Date.now() })`);
  assert.equal(a.run(`GC.peers.has("alice")`), true);
  a.run(`mesh.dispatchEvent(new CustomEvent("link-status", { detail: { id: "alice", status: "disconnected" } }))`);
  assert.equal(a.run(`GC.peers.has("alice")`), false, "плитка убрана");
  a.run(`window.__sent.length = 0; GC.peers.set("x1", {}); GC.peers.set("x2", {}); GC.peers.set("x3", {}); GC.peers.set("x4", {}); GC.peers.set("x5", {});
    handleGroupCallPayload("bob", { gid: "grp", t: "join", ts: Date.now() })`);
  assert.equal(a.run(`window.__sent.filter(([id, p]) => id === "bob" && p.t === "join").length`), 0, "7-му join не шлём");
  a.close();
});

test("fix-net: выключенная комната не включается пульсом; выход кнопкой молчит; приглашение гасится только от автора", async () => {
  const a = await booted(); setup(a);
  a.run(`roomSetEnabled("grp", true); window.__sent.length = 0;`);
  assert.equal(await a.run(`joinRoom("grp")`), true);
  a.run(`roomSetEnabled("grp", false); window.__sent.length = 0; roomSendPresence("grp", true)`);
  assert.equal(a.run(`GC.gid`), null, "звонок выключенной комнаты завершён");
  assert.equal(a.run(`window.__sent.length`), 0, "presence on не рассылается");
  a.run(`roomSetEnabled("grp", true)`);
  assert.equal(await a.run(`joinRoom("grp")`), true);
  const before = a.run(`state.contacts.get("grp").messages.length`);
  a.run(`GC.everConnected = true; leaveGroupCall()`);
  assert.equal(a.run(`state.contacts.get("grp").messages.length`), before, "нет системного сообщения");
  a.run(`roomSetEnabled("grp", false); GC.invites.set("grp", { from: "alice", fromName: "Алиса", ts: Date.now() });
    handleGroupCallPayload("grp", { gid: "grp", t: "leave" });`);
  a.run(`handleGroupCallPayload("bob", { gid: "grp", t: "leave" })`);
  assert.equal(a.run(`GC.invites.has("grp")`), true, "leave чужого участника не гасит приглашение");
  a.run(`handleGroupCallPayload("alice", { gid: "grp", t: "leave" })`);
  assert.equal(a.run(`GC.invites.has("grp")`), false);
  a.close();
});
