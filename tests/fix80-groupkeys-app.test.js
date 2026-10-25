// Большие группы на Sender Keys в приложении: выбор режима, одна рассылка gdeliver, раздача ключей, приём, смешанные возможности, rekey после исключения, лимиты.
const test = require("node:test");
const assert = require("node:assert/strict");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

async function setup(n, opts = {}) {
  const a = await boot();
  a.run(`(() => { Store.myId = "me-test-id"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    window.__sent = []; window.__gd = []; window.trySendOrQueue = async (c, id, p) => { window.__sent.push([c.id, p.kind, p]); };
    window.attemptConnect = () => {}; window.attemptConnectViaRelay = async () => {}; state._firstRenderDone = true;
    signaling = Object.assign(new EventTarget(), { connected: true, registered: true, features: ${JSON.stringify(opts.features || ["gdeliver"])}, prekeyCount: 0, mailboxAck(id) { window.__acks = (window.__acks || []).concat(id); }, groupRoster() { return true; },
      gdeliver(gid, msgId, to, env) { window.__gd.push({ gid, msgId, to, env }); if (!window.__noAck) this.dispatchEvent(new CustomEvent("gdeliver-ack", { detail: { msgId, error: window.__ackErr || null } })); return true; } });
    const ids = []; for (let i = 0; i < ${n}; i++) { const c = ensureContactEntry("m" + i, "M" + i); c.managed = true; c.sk1 = ${opts.noSk ? "false" : "true"}; ids.push("m" + i); }
    window.__ids = ids; })()`);
  return a;
}
const mkGroup = (a, n) => a.run(`(() => { const g = { id: "grp-big-1", isGroup: true, name: "Big", members: [{ id: Store.myId, name: "Tester", role: "admin" }].concat(__ids.slice(0, ${n}).map((id) => ({ id, name: id }))), messages: [], lastActivity: Date.now(), managed: true, createdBy: Store.myId };
  state.contacts.set(g.id, g); persistContacts(); return g.id; })()`);

test("группа >8 со всеми sk1: один gdeliver вместо N попарных, ключи раздаются по 1:1 каналу один раз", async () => {
  const a = await setup(14); const gid = mkGroup(a, 13);
  await a.run(`sendGroupMessage("${gid}", "hello big group")`);
  const gd = J(a.window.__gd), sent = J(a.window.__sent);
  assert.equal(gd.length, 1); assert.equal(gd[0].to.length, 13); assert.ok(!gd[0].to.includes("me-test-id")); assert.equal(gd[0].env.v, "sk1"); assert.ok(!JSON.stringify(gd[0]).includes("hello big group"), "текст не уходит открытым");
  assert.equal(sent.filter((x) => x[1] === "chat").length, 0); const dist = sent.filter((x) => x[1] === "gk-dist"); assert.equal(dist.length, 13); assert.equal(new Set(dist.map((d) => d[2].cid)).size, 1);
  await a.run(`sendGroupMessage("${gid}", "second")`);
  assert.equal(J(a.window.__gd).length, 2); assert.equal(J(a.window.__sent).filter((x) => x[1] === "gk-dist").length, 13, "повторно ключи не раздаются");
  assert.equal(J(a.window.__gd)[1].env.n, 1);
  assert.equal(a.run(`state.contacts.get("${gid}").messages.filter((m) => m.from === "me" && m.sk).length`), 2);
  a.close();
});
test("смешанная группа (у одного нет sk1), группа ≤8 и сервер без gdeliver остаются попарными", async () => {
  const a = await setup(14); const gid = mkGroup(a, 13);
  a.run(`state.contacts.get("m5").sk1 = false`); await a.run(`sendGroupMessage("${gid}", "mixed")`);
  assert.equal(J(a.window.__gd).length, 0); assert.equal(J(a.window.__sent).filter((x) => x[1] === "chat").length, 13);
  a.run(`state.contacts.get("m5").sk1 = true; signaling.features = []; window.__sent.length = 0`); await a.run(`sendGroupMessage("${gid}", "old server")`);
  assert.equal(J(a.window.__gd).length, 0); assert.equal(J(a.window.__sent).filter((x) => x[1] === "chat").length, 13);
  a.run(`signaling.features = ["gdeliver"]; state.contacts.get("${gid}").members = state.contacts.get("${gid}").members.slice(0, 8); window.__sent.length = 0`); await a.run(`sendGroupMessage("${gid}", "small")`);
  assert.equal(J(a.window.__gd).length, 0); assert.equal(J(a.window.__sent).filter((x) => x[1] === "chat").length, 7);
  a.close();
});
test("ошибка/таймаут сервера: сообщение уходит попарно (без дублей в получателе)", async () => {
  const a = await setup(12); const gid = mkGroup(a, 11);
  a.run(`window.__ackErr = "rate"`); await a.run(`sendGroupMessage("${gid}", "fallback")`);
  assert.equal(J(a.window.__gd).length, 1); assert.equal(J(a.window.__sent).filter((x) => x[1] === "chat").length, 11);
  a.run(`signaling.connected = false; window.__sent.length = 0; window.__gd.length = 0`); await a.run(`sendGroupMessage("${gid}", "offline")`);
  assert.equal(J(a.window.__gd).length, 0); assert.equal(J(a.window.__sent).filter((x) => x[1] === "chat").length, 11);
  a.close();
});
test("rekey после исключения: новая цепочка, исключённый не в списке и не получает новый ключ; новому участнику — текущий", async () => {
  const a = await setup(14); const gid = mkGroup(a, 11);
  await a.run(`sendGroupMessage("${gid}", "before")`); const cid0 = J(a.window.__gd)[0].env.cid;
  a.window.__sent.length = 0;
  a.run(`removeGroupMember("${gid}", "m3", false)`);
  await a.run(`sendGroupMessage("${gid}", "after kick")`);
  const gd = J(a.window.__gd), dist = J(a.window.__sent).filter((x) => x[1] === "gk-dist");
  assert.notEqual(gd[1].env.cid, cid0); assert.ok(!gd[1].to.includes("m3")); assert.equal(gd[1].to.length, 10);
  assert.equal(dist.length, 10); assert.ok(!dist.some((d) => d[0] === "m3")); assert.ok(dist.every((d) => d[2].cid === gd[1].env.cid));
  a.window.__sent.length = 0; a.run(`addGroupMember("${gid}", "m12")`);
  await sleep(50);
  const nd = J(a.window.__sent).filter((x) => x[1] === "gk-dist"); assert.equal(nd.length, 1); assert.equal(nd[0][0], "m12"); assert.equal(nd[0][2].cid, gd[1].env.cid);
  a.close();
});
test("приём: раздача ключа и сообщение расшифровываются; подделка/не участник/до раздачи ключа — обработка без падений", async () => {
  const a = await setup(12); const gid = mkGroup(a, 11);
  delete require.cache[require.resolve("../js/groupkeys.js")]; const G = require("../js/groupkeys.js");
  const mem = { j: "{}" }; G.setStore({ load: () => JSON.parse(mem.j), save: (o) => { mem.j = JSON.stringify(o); return true; } });
  const dist = await G.distribution(gid);
  const payload = { kind: "chat", id: "msg-1", text: "привет, группа", ts: Date.now(), groupId: gid, senderName: "M2" };
  const env = await G.encrypt(gid, "m2", JSON.stringify(payload));
  // сообщение пришло раньше ключа: парковка + запрос ключа
  await a.run(`handleDeliver(${JSON.stringify({ from: "m2", msgId: "d1", envelope: env, kind: "gchat", gid })}, false)`);
  assert.equal(a.run(`state.contacts.get("${gid}").messages.length`), 0); assert.ok(J(a.window.__sent).some((x) => x[0] === "m2" && x[1] === "gk-req"));
  a.run(`applyIncomingPayload("m2", "k1", ${JSON.stringify({ kind: "gk-dist", id: "kd1", groupId: gid, ...dist })}, true, "gk-dist")`);
  await sleep(150);
  const msgs = J(a.run(`state.contacts.get("${gid}").messages`)); assert.equal(msgs.length, 1); assert.equal(msgs[0].text, "привет, группа"); assert.equal(msgs[0].fromId, "m2"); assert.ok(msgs[0].sk);
  assert.deepEqual(J(a.window.__acks), ["d1"]);
  // дубликат
  await a.run(`handleDeliver(${JSON.stringify({ from: "m2", msgId: "d1", envelope: env, kind: "gchat", gid })}, false)`); assert.equal(a.run(`state.contacts.get("${gid}").messages.length`), 1);
  // не участник и чужая раздача
  const env2 = await G.encrypt(gid, "m2", JSON.stringify({ ...payload, id: "msg-2" }));
  await a.run(`handleDeliver(${JSON.stringify({ from: "outsider", msgId: "d2", envelope: env2, kind: "gchat", gid })}, false)`);
  a.run(`applyIncomingPayload("outsider", "k2", ${JSON.stringify({ kind: "gk-dist", id: "kd2", groupId: gid, ...dist })}, true, "gk-dist")`);
  assert.equal(a.run(`state.contacts.get("${gid}").messages.length`), 1);
  // подмена шифртекста
  const bad = { ...env2, ct: env2.ct.slice(0, -4) + "AAAA" };
  await a.run(`handleDeliver(${JSON.stringify({ from: "m2", msgId: "d3", envelope: bad, kind: "gchat", gid })}, false)`); assert.equal(a.run(`state.contacts.get("${gid}").messages.length`), 1);
  await a.run(`handleDeliver(${JSON.stringify({ from: "m2", msgId: "d4", envelope: env2, kind: "gchat", gid })}, false)`); assert.equal(a.run(`state.contacts.get("${gid}").messages.length`), 2);
  // квитанции чтения для sk-сообщений не рассылаются
  a.window.__sent.length = 0; a.run(`markThreadRead(state.contacts.get("${gid}"))`); assert.equal(J(a.window.__sent).filter((x) => x[1] === "ack-batch").length, 0);
  a.close();
});
test("лимиты состава: 256 при sk1 у всех и gdeliver на сервере, иначе 10; приглашение на 256 принимается", async () => {
  const a = await setup(3);
  const r = J(a.run(`({ sk: groupMemberLimit(__ids), noSrv: (signaling.features = [], groupMemberLimit(__ids)), }) `));
  assert.equal(r.sk, 256); assert.equal(r.noSrv, 10);
  a.run(`signaling.features = ["gdeliver"]; state.contacts.get("m1").sk1 = false`); assert.equal(a.run(`groupMemberLimit(__ids)`), 10);
  assert.equal(a.run(`MAX_GROUP_MEMBERS_SK`), 256);
  a.close();
});
