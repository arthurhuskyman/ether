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

test("комната: флаг сохраняется, плашка видна, присутствие и пустая комната", async () => {
  const a = await booted(); setup(a);
  const d = a.document;
  assert.ok(d.querySelector("#room-bar").classList.contains("hidden"), "без флага плашки нет");
  a.run(`roomSetEnabled("grp", true)`);
  assert.ok(!d.querySelector("#room-bar").classList.contains("hidden"));
  assert.match(d.querySelector("#room-bar").textContent, /Пусто/);
  const flagMsgs = a.run(`window.__sent.filter(([, p]) => p.t === "presence" && p.setRoom === true).length`);
  assert.equal(flagMsgs, 2, "флаг разослан участникам");
  a.run(`handleGroupCallPayload("alice", { gid: "grp", t: "presence", on: true, room: true, name: "Алиса", ts: Date.now() })`);
  assert.match(d.querySelector("#room-bar").textContent, /Внутри: Алиса/);
  a.close();
});

test("комната: вход без мелодии и приглашения, присутствие рассылается, выход гасит его", async () => {
  const a = await booted(); setup(a);
  const d = a.document;
  a.run(`roomSetEnabled("grp", true); window.__sent.length = 0;`);
  // входящий join от Боба, пока я не в комнате — не приглашение, а присутствие
  a.run(`handleGroupCallPayload("bob", { gid: "grp", t: "join", ts: Date.now() })`);
  assert.equal(a.run(`GC.invites.size`), 0, "приглашения нет");
  assert.match(d.querySelector("#room-bar").textContent, /Боб/);
  assert.equal(await a.run(`joinRoom("grp")`), true);
  assert.equal(a.run(`GC.gid`), "grp");
  const pres = a.run(`window.__sent.filter(([, p]) => p.t === "presence" && p.on === true).length`);
  assert.equal(pres, 2, "всем в сети отправлено присутствие");
  assert.ok(d.querySelector("#room-bar .room-btn.is-leave"), "кнопка сменилась на «Выйти»");
  assert.match(d.querySelector("#room-bar").textContent, /Вы|Боб/);
  a.run(`window.__sent.length = 0; leaveRoom();`);
  assert.equal(a.run(`GC.gid`), null);
  assert.equal(a.run(`window.__sent.filter(([, p]) => p.t === "presence" && p.on === false).length`), 2, "уход разослан");
  assert.equal(a.run(`roomMembers("grp").some((m) => m.id === "me-test-id")`), false);
  a.close();
});

test("комната: записи без пульса протухают, чужие не участники и не-админ не снимает флаг", async () => {
  const a = await booted(); setup(a);
  a.run(`roomSetEnabled("grp", true)`);
  a.run(`handleGroupCallPayload("alice", { gid: "grp", t: "presence", on: true, room: true, ts: Date.now() })`);
  assert.equal(a.run(`roomMembers("grp").length`), 1);
  a.run(`ROOMS.present.get("grp").get("alice").ts = Date.now() - 61000`);
  assert.equal(a.run(`roomMembers("grp").length`), 0, "через 60 с без пульса — вышла");
  a.run(`handleGroupCallPayload("stranger", { gid: "grp", t: "presence", on: true, room: true, ts: Date.now() })`);
  assert.equal(a.run(`roomMembers("grp").length`), 0, "не участник группы игнорируется");
  // не-админ пытается выключить комнату
  a.run(`state.contacts.get("grp").createdBy = "me-test-id"; state.contacts.get("grp").admins = ["me-test-id"];`);
  a.run(`handleGroupCallPayload("bob", { gid: "grp", t: "presence", on: false, room: false, setRoom: true, ts: Date.now() })`);
  assert.equal(a.run(`!!state.contacts.get("grp").room`), true, "флаг не снят чужим");
  a.close();
});

test("группа без комнаты ведёт себя как прежде: join даёт приглашение", async () => {
  const a = await booted(); setup(a);
  a.run(`handleGroupCallPayload("alice", { gid: "grp", t: "invite", from: "Алиса", ts: Date.now() })`);
  assert.equal(a.run(`GC.invites.size`), 1);
  a.close();
});
