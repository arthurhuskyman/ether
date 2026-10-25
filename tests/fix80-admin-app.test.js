// Админ-инструменты в приложении: подписанные действия принимаются/отклоняются получателем, медленный режим, объявления, закрепление по ролям, передача владения, одобрение входа.
const test = require("node:test");
const assert = require("node:assert/strict");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
const GA = require("../js/groupadmin.js");
test.after(closeAll);
async function ident() { const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]); const j = await crypto.subtle.exportKey("jwk", kp.privateKey); return { priv: { x: j.x, y: j.y, d: j.d }, pub: { x: j.x, y: j.y } }; }

async function setup() {
  const a = await boot(); const keys = { own: await ident(), adm: await ident(), mod: await ident(), u1: await ident(), me: await ident() };
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; Store.myPrivateKeyJwk = ${JSON.stringify(keys.me.priv)}; Store.myPublicKeyJwk = ${JSON.stringify(keys.me.pub)}; window.__sent = [];
    window.trySendOrQueue = async (c, id, p) => { window.__sent.push([c.id, p.kind, p]); }; window.attemptConnect = () => {}; window.attemptConnectViaRelay = async () => {}; state._firstRenderDone = true;
    const pubs = ${JSON.stringify(Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.pub])))};
    for (const id of ["own", "adm", "mod", "u1", "u2"]) { const c = ensureContactEntry(id, id.toUpperCase()); c.managed = true; if (pubs[id]) c.publicKey = pubs[id]; }
    state.contacts.set("g1", { id: "g1", isGroup: true, name: "G", managed: true, messages: [], lastActivity: 1, createdBy: "own", members: [{ id: "own", name: "OWN", role: "admin" }, { id: "adm", name: "ADM", role: "admin" }, { id: "mod", name: "MOD", role: "moderator" }, { id: "u1", name: "U1" }, { id: "u2", name: "U2" }, { id: "me", name: "Tester" }] }); })()`);
  const now = () => Date.now();
  const send = async (by, fields, opts = {}) => {
    const g = J(a.run(`state.contacts.get("g1")`)); g.aseq = J(a.run(`state.contacts.get("g1").aseq || {}`));
    const { act, sig } = await GA.make(g, by, (opts.key || keys[by]).priv, fields, now());
    a.run(`applyIncomingPayload(${JSON.stringify(by)}, "m" + Math.random(), ${JSON.stringify({ kind: "group-admin", id: "x" + Math.random(), groupId: "g1", act, sig })}, true, "group-admin")`); await sleep(120); return { act, sig };
  };
  return { a, keys, send };
}
const G = (a) => J(a.run(`state.contacts.get("g1")`));

test("получатель применяет подписанные действия по ролям и отклоняет недопустимые", async () => {
  const { a, keys, send } = await setup();
  await send("mod", { op: "kick", target: "adm" }); assert.ok(G(a).members.some((m) => m.id === "adm"), "модератор не исключает админа");
  await send("u1", { op: "settings", settings: { slowSec: 10 } }); assert.ok(!G(a).slowSec, "участник не меняет настройки");
  await send("mod", { op: "kick", target: "u2", reason: "спам" }, { key: keys.u1 }); assert.ok(G(a).members.some((m) => m.id === "u2"), "чужая подпись");
  await send("mod", { op: "kick", target: "u2", reason: "спам" });
  let g = G(a); assert.ok(!g.members.some((m) => m.id === "u2")); assert.deepEqual(g.banned, ["u2"]); assert.equal(g.banReasons.u2, "спам"); assert.ok(g.messages.some((m) => /спам/.test(m.text)));
  const { act, sig } = await send("adm", { op: "role", target: "u1", role: "moderator" }); assert.equal(G(a).members.find((m) => m.id === "u1").role, "moderator");
  a.run(`applyIncomingPayload("adm", "mm", ${JSON.stringify({ kind: "group-admin", id: "r1", groupId: "g1", act, sig })}, true, "group-admin")`); await sleep(100); // повтор
  assert.equal(Object.keys(G(a).aseq).length, 2);
  await send("adm", { op: "role", target: "u1", role: "admin" }); assert.equal(G(a).members.find((m) => m.id === "u1").role, "moderator", "админ не назначает админов");
  await send("own", { op: "role", target: "u1", role: "admin" }); assert.equal(G(a).members.find((m) => m.id === "u1").role, "admin");
  a.close();
});
test("медленный режим и «только объявления» проверяет получатель; модераторы не ограничены", async () => {
  const { a, send } = await setup();
  await send("adm", { op: "settings", settings: { slowSec: 30, writeRestricted: false } }); assert.equal(G(a).slowSec, 30);
  const chat = (from, id) => a.run(`applyIncomingPayload(${JSON.stringify(from)}, ${JSON.stringify("e" + id)}, ${JSON.stringify({ kind: "chat", id, text: "t" + id, ts: Date.now(), groupId: "g1" })}, true, "chat")`);
  chat("u2", "a1"); chat("u2", "a2"); chat("u1", "b1"); chat("mod", "c1"); chat("mod", "c2");
  assert.deepEqual(G(a).messages.filter((m) => m.from === "them").map((m) => m.id), ["a1", "b1", "c1", "c2"]);
  await send("adm", { op: "settings", settings: { writeRestricted: true } });
  chat("u1", "d1"); chat("mod", "d2"); chat("adm", "d3"); const ids = G(a).messages.map((m) => m.id);
  assert.ok(!ids.includes("d1") && !ids.includes("d2") && ids.includes("d3"));
  // отправитель-я: медленный режим блокирует и мою отправку
  a.run(`state.contacts.get("g1").writeRestricted = false; state.contacts.get("g1").members.find((m) => m.id === "me").role = undefined`);
  await a.run(`sendGroupMessage("g1", "one")`); const n = a.window.__sent.filter((x) => x[1] === "chat").length; await a.run(`sendGroupMessage("g1", "two")`);
  assert.equal(a.window.__sent.filter((x) => x[1] === "chat").length, n, "второе сообщение отложено медленным режимом"); assert.ok(n > 0);
  a.close();
});
test("закрепление по роли, передача владения, ростер не повышает роли, исключение меня", async () => {
  const { a, send } = await setup();
  await send("u1", { op: "pin", msgId: "p1" }); assert.ok(!G(a).pinnedMessageId);
  await send("mod", { op: "pin", msgId: "p1" }); assert.equal(G(a).pinnedMessageId, "p1");
  await send("adm", { op: "settings", settings: { pinPolicy: "admins" } }); await send("mod", { op: "pin", msgId: "p2" }); assert.equal(G(a).pinnedMessageId, "p1");
  await send("adm", { op: "transfer", target: "u1" }); assert.equal(G(a).createdBy, "own");
  await send("own", { op: "transfer", target: "adm" }); assert.equal(G(a).createdBy, "adm"); assert.equal(G(a).members.find((m) => m.id === "own").role, "admin");
  // ростер от админа (не владельца) с попыткой назначить админа/модератора
  const roster = G(a).members.map((m) => (m.id === "u2" ? { ...m, role: "admin" } : m.id === "u1" ? { ...m, role: "moderator" } : m));
  a.run(`applyIncomingPayload("own", "ro1", ${JSON.stringify({ kind: "group-invite", id: "inv1", groupId: "g1", groupName: "G", members: roster, ver: 5 })}, true, "group-invite")`);
  const g = G(a); assert.ok(!g.members.find((m) => m.id === "u2").role); assert.ok(!g.members.find((m) => m.id === "u1").role);
  await send("adm", { op: "kick", target: "me", reason: "тест" }); assert.equal(a.run(`state.contacts.has("g1")`), false, "исключённый убирает группу у себя");
  a.close();
});
test("мои действия: подписаны моим ключом, рассылаются участникам, права проверяются до отправки", async () => {
  const { a, keys } = await setup();
  a.run(`state.contacts.get("g1").createdBy = "me"; state.contacts.get("g1").members.find((m) => m.id === "me").role = "admin"`);
  assert.equal(await a.run(`groupAdminDo("g1", { op: "kick", target: "u2", reason: "reason" })`), true);
  const out = J(a.window.__sent).filter((x) => x[1] === "group-admin"); assert.equal(out.length, 5);
  const p = out[0][2]; assert.ok(await GA.verifyAct(keys.me.pub, p.act, p.sig)); assert.equal(p.act.reason, "reason");
  assert.equal(await a.run(`groupAdminDo("g1", { op: "kick", target: "me" })`), false);
  a.run(`state.contacts.get("g1").createdBy = "own"; state.contacts.get("g1").members.find((m) => m.id === "me").role = undefined`);
  assert.equal(await a.run(`groupAdminDo("g1", { op: "settings", settings: { slowSec: 10 } })`), false);
  a.close();
});
test("ссылка-приглашение: срок и подпись, одобрение админом, просроченная/подделанная отклоняются", async () => {
  const { a } = await setup();
  a.run(`(() => { const g = state.contacts.get("g1"); g.createdBy = "me"; g.members.find((m) => m.id === "me").role = "admin"; })()`);
  const code = await a.run(`buildSignedGroupInvite("g1", 3600, true)`); assert.match(code, /&exp=\d+&ap=1&sg=/);
  const parsed = J(a.run(`parseGroupInviteCode(${JSON.stringify(code)})`)); assert.ok(parsed.exp > Date.now() && parsed.ap === true && parsed.sg);
  const req = (extra) => a.run(`applyIncomingPayload("newbie", "j" + Math.random(), ${JSON.stringify({ kind: "group-join-request", groupId: "g1", requesterName: "Newbie", ...extra })}, true, "group-join-request")`);
  req({ exp: parsed.exp, ap: 1, sg: parsed.sg }); await sleep(150);
  assert.equal(G(a).pendingJoins.length, 1); assert.ok(!G(a).members.some((m) => m.id === "newbie"));
  req({ exp: parsed.exp + 999999, ap: 1, sg: parsed.sg }); await sleep(100); assert.equal(G(a).pendingJoins.length, 1, "срок продлить нельзя");
  const old = await a.run(`(async () => { const sg = await GroupAdmin.signInvite(Store.myPrivateKeyJwk, "g1", Store.myId, Date.now() - 1000, false); return sg; })()`);
  req({ exp: Date.now() - 1000, ap: 0, sg: old }); await sleep(100); assert.ok(!G(a).members.some((m) => m.id === "newbie") && G(a).pendingJoins.length === 1, "просроченная");
  a.run(`groupResolveJoin("g1", "newbie", true)`); assert.ok(G(a).members.some((m) => m.id === "newbie")); assert.equal(G(a).pendingJoins.length, 0);
  assert.equal(a.run(`(async () => 1)() && 1`), 1);
  // просроченную ссылку не принимает и сам вступающий
  assert.equal(await a.run(`joinGroupViaInvite("ether://group?gid=zz&ref=r&exp=${Date.now() - 5000}&ap=0&sg=x")`), false);
  // панель «Дополнительно» отрисовывается и содержит элементы управления
  a.run(`openGroupInfo("g1")`); const panel = a.window.document.getElementById("group-admin-panel"); assert.ok(panel && panel.tagName === "DETAILS" && panel.querySelectorAll("select").length === 2);
  a.close();
});
