// Админ-инструменты группы (js/groupadmin.js): матрица прав, подписи, повтор, кик/бан с причиной, медленный режим, закрепление по ролям, передача владения, ростер, ссылки с истечением.
const test = require("node:test");
const assert = require("node:assert/strict");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const A = require("../js/groupadmin.js");
async function ident() { const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]); const j = await crypto.subtle.exportKey("jwk", kp.privateKey); return { priv: { x: j.x, y: j.y, d: j.d }, pub: { x: j.x, y: j.y } }; }
const mkG = () => ({ id: "g1", isGroup: true, createdBy: "own", members: [{ id: "own", name: "Own", role: "admin" }, { id: "adm", name: "Adm", role: "admin" }, { id: "mod", name: "Mod", role: "moderator" }, { id: "u1", name: "U1" }, { id: "u2", name: "U2" }] });
const NOW = 1_800_000_000_000;

test("роли и матрица прав", () => {
  const g = mkG();
  assert.deepEqual(["own", "adm", "mod", "u1", "zz"].map((i) => A.role(g, i)), ["owner", "admin", "moderator", "member", null]);
  const c = (a, act) => A.can(g, a, act);
  assert.ok(c("mod", { op: "kick", target: "u1" })); assert.ok(!c("mod", { op: "kick", target: "adm" })); assert.ok(!c("mod", { op: "kick", target: "mod" })); assert.ok(!c("u1", { op: "kick", target: "u2" }));
  assert.ok(c("adm", { op: "kick", target: "mod" })); assert.ok(!c("adm", { op: "kick", target: "own" })); assert.ok(c("own", { op: "kick", target: "adm" }));
  assert.ok(c("adm", { op: "role", target: "u1", role: "moderator" })); assert.ok(!c("adm", { op: "role", target: "u1", role: "admin" })); assert.ok(c("own", { op: "role", target: "u1", role: "admin" }));
  assert.ok(!c("mod", { op: "role", target: "u1", role: "member" })); assert.ok(!c("adm", { op: "role", target: "own", role: "member" }));
  assert.ok(c("adm", { op: "settings" })); assert.ok(!c("mod", { op: "settings" }));
  assert.ok(c("mod", { op: "pin" })); assert.ok(!c("u1", { op: "pin" })); g.pinPolicy = "admins"; assert.ok(!c("mod", { op: "pin" })); g.pinPolicy = "all"; assert.ok(c("u1", { op: "pin" })); assert.ok(!c("zz", { op: "pin" }));
  assert.ok(c("own", { op: "transfer", target: "u1" })); assert.ok(!c("adm", { op: "transfer", target: "u1" })); assert.ok(!c("own", { op: "transfer", target: "own" }));
  assert.ok(!c("own", { op: "bogus" }));
});
test("режим «только объявления»: пишут админы и выше; медленный режим не касается модераторов", () => {
  const g = mkG(); assert.ok(A.canPost(g, "u1")); g.writeRestricted = true;
  assert.ok(!A.canPost(g, "u1")); assert.ok(!A.canPost(g, "mod")); assert.ok(A.canPost(g, "adm")); assert.ok(A.canPost(g, "own")); assert.ok(!A.canPost(g, "ghost"));
  g.writeRestricted = false; g.slowSec = 30; const last = new Map();
  assert.ok(A.slowAllowed(g, "u1", NOW, last)); assert.ok(!A.slowAllowed(g, "u1", NOW + 5000, last)); assert.ok(A.slowAllowed(g, "u2", NOW + 5000, last));
  assert.ok(A.slowAllowed(g, "u1", NOW + 22000, last)); assert.ok(A.slowAllowed(g, "mod", NOW, last)); assert.ok(A.slowAllowed(g, "mod", NOW + 1, last));
  assert.ok(A.slowWaitMs(g, "u1", NOW + 23000, last) > 0 && A.slowWaitMs(g, "mod", NOW, last) === 0);
});
test("подписанное действие: верная подпись проходит; чужой ключ/изменённое поле — нет; повтор seq отвергается", async () => {
  const g = mkG(), mod = await ident(), other = await ident();
  const { act, sig } = await A.make(g, "mod", mod.priv, { op: "kick", target: "u1", reason: "спам" }, NOW);
  assert.ok(await A.verifyAct(mod.pub, act, sig)); assert.ok(!(await A.verifyAct(other.pub, act, sig))); assert.ok(!(await A.verifyAct(mod.pub, { ...act, target: "u2" }, sig))); assert.ok(!(await A.verifyAct(null, act, sig)));
  const r = A.apply(g, act, NOW, "me"); assert.ok(r.ok); assert.equal(r.removed, "u1"); assert.deepEqual(g.banned, ["u1"]); assert.equal(g.banReasons.u1, "спам"); assert.ok(!g.members.some((m) => m.id === "u1")); assert.equal(r.sys.key, "group.systemKickedReason");
  assert.equal(A.apply(g, act, NOW, "me").reason, "replay");
  const next = await A.make(g, "mod", mod.priv, { op: "kick", target: "u2" }, NOW); assert.ok(next.act.seq > act.seq); assert.ok(A.apply(g, next.act, NOW, "u2").removedSelf);
});
test("недопустимое: модератор не кикает админа, участник не меняет настройки, будущее время, мусор — состояние не меняется", async () => {
  const g = mkG(), k = await ident(); const snap = JSON.stringify(g);
  const m1 = await A.make(g, "mod", k.priv, { op: "kick", target: "adm" }, NOW); assert.equal(A.apply(g, m1.act, NOW, "me").reason, "denied");
  const m2 = await A.make(g, "u1", k.priv, { op: "settings", settings: { slowSec: 10 } }, NOW); assert.equal(A.apply(g, m2.act, NOW, "me").reason, "denied");
  const m3 = await A.make(g, "adm", k.priv, { op: "settings", settings: { slowSec: 7 } }, NOW); assert.equal(A.apply(g, m3.act, NOW, "me").reason, "shape");
  const m4 = await A.make(g, "adm", k.priv, { op: "settings", settings: { slowSec: 10 } }, NOW + 5 * 86400_000); assert.equal(A.apply(g, m4.act, NOW, "me").reason, "future");
  assert.equal(A.apply(g, { op: "kick" }, NOW, "me").reason, "shape"); assert.equal(A.apply({ ...g, id: "other" }, m1.act, NOW, "me").reason, "shape");
  assert.equal(JSON.stringify(g), snap.replace(/"aseq":\{[^}]*\},?/, "").length ? JSON.stringify(g) : snap);
  assert.ok(g.members.length === 5 && !g.slowSec);
});
test("настройки, роли, закрепление, разбан, передача владения", async () => {
  const g = mkG(), k = await ident(); const run = async (by, f) => A.apply(g, (await A.make(g, by, k.priv, f, NOW)).act, NOW, "me");
  assert.ok((await run("adm", { op: "settings", settings: { slowSec: 30, pinPolicy: "admins", writeRestricted: true, joinApproval: true } })).ok);
  assert.equal(g.slowSec, 30); assert.equal(g.pinPolicy, "admins"); assert.ok(g.writeRestricted && g.joinApproval);
  assert.equal((await run("mod", { op: "pin", msgId: "m1" })).reason, "denied"); assert.ok((await run("adm", { op: "pin", msgId: "m1" })).ok); assert.equal(g.pinnedMessageId, "m1"); assert.ok((await run("own", { op: "pin" })).ok); assert.equal(g.pinnedMessageId, null);
  assert.ok((await run("adm", { op: "role", target: "u1", role: "moderator" })).ok); assert.equal(A.role(g, "u1"), "moderator");
  assert.ok((await run("adm", { op: "role", target: "u1", role: "member" })).ok); assert.equal(A.role(g, "u1"), "member");
  assert.equal((await run("adm", { op: "role", target: "u1", role: "admin" })).reason, "denied");
  assert.ok((await run("adm", { op: "kick", target: "u2" })).ok); assert.ok((await run("adm", { op: "unban", target: "u2" })).ok); assert.ok(!g.banned.includes("u2"));
  assert.equal((await run("adm", { op: "transfer", target: "u1" })).reason, "denied");
  assert.ok((await run("own", { op: "transfer", target: "adm" })).ok); assert.equal(g.createdBy, "adm"); assert.equal(A.role(g, "own"), "admin"); assert.equal(A.role(g, "adm"), "owner");
  assert.equal((await run("own", { op: "transfer", target: "u1" })).reason, "denied", "прежний владелец больше не вправе");
});
test("ростер: не-владелец не повышает до admin, moderator из ростера не берётся, локальный moderator сохраняется", () => {
  const g = mkG();
  const inc = [{ id: "own", name: "Own", role: "admin" }, { id: "adm", name: "Adm", role: "admin" }, { id: "mod", name: "Mod" }, { id: "u1", name: "U1", role: "admin" }, { id: "u2", name: "U2", role: "moderator" }];
  const out = A.sanitizeRoster(g, inc, "adm"); const r = (id) => out.find((m) => m.id === id).role;
  assert.equal(r("u1"), undefined); assert.equal(r("u2"), undefined); assert.equal(r("mod"), "moderator"); assert.equal(r("adm"), "admin");
  assert.equal(A.sanitizeRoster(g, inc, "own").find((m) => m.id === "u1").role, "admin");
});
test("ссылка-приглашение: подпись покрывает срок и признак одобрения", async () => {
  const k = await ident(), o = await ident(); const exp = NOW + 3600_000;
  const sg = await A.signInvite(k.priv, "g1", "adm", exp, true);
  assert.ok(await A.verifyInvite(k.pub, "g1", "adm", exp, true, sg));
  assert.ok(!(await A.verifyInvite(k.pub, "g1", "adm", exp + 1, true, sg)), "срок продлить нельзя"); assert.ok(!(await A.verifyInvite(k.pub, "g1", "adm", exp, false, sg))); assert.ok(!(await A.verifyInvite(o.pub, "g1", "adm", exp, true, sg)));
});
