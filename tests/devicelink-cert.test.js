// Сертификаты устройств (js/devicecert.js): подпись основным ключом, срок, отзыв, откат seq, подделка.
const test = require("node:test");
const assert = require("node:assert/strict");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const DC = require("../js/devicecert.js");
async function identity() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const j = await crypto.subtle.exportKey("jwk", kp.privateKey); return { priv: { x: j.x, y: j.y, d: j.d }, pub: { x: j.x, y: j.y } };
}
test("сертификат: верная подпись принимается, чужой ключ/изменённое поле/срок отвергаются", async () => {
  const idn = await identity(), other = await identity(), dev = await DC.genDeviceKey(), devId = DC.newDeviceId();
  const c = await DC.issue(idn.priv, { id: "me", devId, pub: dev.pub, label: "Компьютер", ttlMs: 1000 });
  assert.ok(await DC.verifyCert(idn.pub, c));
  assert.ok(!(await DC.verifyCert(other.pub, c)), "подпись чужого ключа");
  assert.ok(!(await DC.verifyCert(idn.pub, { ...c, label: "Взлом" })), "метка изменена");
  assert.ok(!(await DC.verifyCert(idn.pub, { ...c, pub: { ...dev.pub, x: other.pub.x } })), "ключ устройства подменён");
  assert.ok(!(await DC.verifyCert(idn.pub, c, Date.now() + 5000)), "срок истёк");
  assert.ok(!c.pub.d && !JSON.stringify(c).includes(dev.priv.d), "приватный ключ устройства в сертификат не попадает");
});
test("список устройств: seq растёт, отозванные исключаются, подмена и откат отвергаются, отпечаток стабилен", async () => {
  const idn = await identity(), d1 = await DC.genDeviceKey(), d2 = await DC.genDeviceKey();
  const c1 = await DC.issue(idn.priv, { id: "me", devId: DC.newDeviceId(), pub: d1.pub, label: "A" }), c2 = await DC.issue(idn.priv, { id: "me", devId: DC.newDeviceId(), pub: d2.pub, label: "B" });
  const l1 = await DC.signList(idn.priv, { id: "me", seq: 1, certs: [c1, c2], revoked: [] });
  let v = await DC.verifyList(idn.pub, "me", l1); assert.ok(v.ok && v.certs.length === 2);
  assert.ok(!(await DC.verifyList(idn.pub, "me", l1, { minSeq: 1 })).ok, "откат/повтор seq");
  const l2 = await DC.signList(idn.priv, { id: "me", seq: 2, certs: [c1, c2], revoked: [c2.devId] });
  v = await DC.verifyList(idn.pub, "me", l2, { minSeq: 1 }); assert.ok(v.ok && v.certs.length === 1 && v.certs[0].devId === c1.devId, "отозванное устройство исключено");
  assert.ok(!(await DC.verifyList(idn.pub, "me", { ...l2, revoked: [] }, { minSeq: 1 })).ok, "снятие отзыва без подписи невозможно");
  assert.ok(!(await DC.verifyList(idn.pub, "other", l2)).ok, "чужой id");
  const ff = await DC.fingerprint(c1); assert.match(ff, /^([0-9a-f]{4} ){4}[0-9a-f]{4}$/); assert.equal(ff, await DC.fingerprint(c1));
});
