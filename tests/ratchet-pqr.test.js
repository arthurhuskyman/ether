// V.88: постквантовое обновление внутри идущей сессии (PQR): KEM подмешивается в шаги DH, ключи KEM меняются,
// совместимость со старыми клиентами и с серверами, вырезающими h.q, подмена заголовка отвергается.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), nodeCrypto = require("crypto");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = nodeCrypto.webcrypto;
const CH = new Function(fs.readFileSync(path.join(__dirname, "..", "js", "crypto-helper.js"), "utf8") + "\nreturn CryptoHelper;")();
const NEW = path.join(__dirname, "..", "js", "ratchet.js"), OLD = path.join(__dirname, "fixtures", "ratchet-v79-legacy.js");
function device(id, keys, file) {
  delete require.cache[require.resolve(file)];
  const R = require(file), mem = { json: "{}" };
  R.setStore({ load: () => JSON.parse(mem.json), save: (o) => { mem.json = JSON.stringify(o); return true; } });
  return { id, R, mem, priv: keys.privateKeyJwk, pub: keys.publicKeyJwk };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const ctx = (me, o, x) => ({ contactId: o.id, myId: me.id, myPrivJwk: me.priv, theirPubJwk: o.pub, ...(x || {}) });
const send = (f, t, p, x) => f.R.encrypt(ctx(f, t, x), p);
const recv = (t, f, e) => t.R.decrypt(ctx(t, f), clone(e));
async function pair(fa = NEW, fb = NEW) { return { a: device("alice-id", await CH.generateKeyPair(), fa), b: device("bob-id", await CH.generateKeyPair(), fb) }; }
const sess = (d, other) => JSON.parse(d.mem.json).s[other.id][0];
async function v3Session(a, b) {
  const up = await b.R.prekeyUploadPayload(3, b.priv);
  const e1 = await send(a, b, { n: 0 }, { getBundle: async () => ({ spk: clone(up.spk), opk: up.opks[0] }) });
  assert.equal(e1.a, 3); assert.deepEqual(await recv(b, a, e1), { n: 0 });
  const e2 = await send(b, a, { n: 1 }); await recv(a, b, e2);
}

test("PQR: ключи KEM разъезжаются в заголовках, шаг DH с KEM у обоих сходится, ключ меняется после использования", async () => {
  const { a, b } = await pair(); a.R.setQOk(true); b.R.setQOk(true);
  await v3Session(a, b);
  let sawKem = 0, sawPub = 0, maxLen = 0;
  for (let i = 0; i < 6; i++) { // пинг-понг: каждый ответ — новый шаг DH
    const ea = await send(a, b, { a: i }); if (ea.h.q) { if (ea.h.q.k) sawKem++; if (ea.h.q.p) sawPub++; } maxLen = Math.max(maxLen, JSON.stringify(ea).length);
    assert.deepEqual(await recv(b, a, ea), { a: i });
    const eb = await send(b, a, { b: i }); if (eb.h.q) { if (eb.h.q.k) sawKem++; if (eb.h.q.p) sawPub++; }
    assert.deepEqual(await recv(a, b, eb), { b: i });
  }
  assert.ok(sawPub >= 2, "ключи KEM переданы"); assert.ok(sawKem >= 2, "KEM подмешан в шаги DH (с обеих сторон)");
  assert.ok(sess(a, b).kqOld && sess(a, b).kqOld.length >= 1, "использованный ключ заменён новым");
  // внутри часа повторного подмешивания нет — заголовки снова лёгкие
  const e = await send(a, b, { x: 1 }); assert.ok(!e.h.q || !e.h.q.k);
  assert.deepEqual(await recv(b, a, e), { x: 1 });
});

test("PQR: подмена KEM-шифртекста или ключа в заголовке ломает AEAD, оригинал открывается", async () => {
  const { a, b } = await pair(); a.R.setQOk(true); b.R.setQOk(true);
  await v3Session(a, b);
  let env = null;
  for (let i = 0; i < 6 && !env; i++) { const ea = await send(a, b, { i }); if (ea.h.q) env = ea; else { await recv(b, a, ea); await recv(a, b, await send(b, a, { r: i })); } }
  assert.ok(env, "есть конверт с h.q");
  const t = clone(env); if (t.h.q.p) t.h.q.p = "A" + t.h.q.p.slice(1); else t.h.q.k = "A" + t.h.q.k.slice(1);
  await assert.rejects(recv(b, a, t));
  const t2 = clone(env); delete t2.h.q; await assert.rejects(recv(b, a, t2), "сервер вырезал h.q — конверт не принимается");
  const opened = await recv(b, a, env); assert.equal(typeof opened.i, "number", "оригинал открывается");
});

test("PQR выключен (сервер вырезает h.q) или собеседник старый — заголовков q нет, переписка идёт как раньше", async () => {
  const { a, b } = await pair(); // setQOk не вызван
  await v3Session(a, b);
  for (let i = 0; i < 4; i++) { const e = await send(a, b, { i }); assert.equal(e.h.q, undefined); await recv(b, a, e); await recv(a, b, await send(b, a, { j: i })); }
  const c = await pair(NEW, OLD); c.a.R.setQOk(true);
  const up = await c.b.R.prekeyUploadPayload(3, c.b.priv);
  const e1 = await send(c.a, c.b, { n: 0 }, { getBundle: async () => ({ spk: clone(up.spk), opk: up.opks[0] }) });
  await recv(c.b, c.a, e1);
  for (let i = 0; i < 3; i++) { const eb = await send(c.b, c.a, { b: i }); await recv(c.a, c.b, eb); const ea = await send(c.a, c.b, { a: i }); assert.equal(ea.h.q, undefined, "старому клиенту q не шлём"); assert.deepEqual(await recv(c.b, c.a, ea), { a: i }); }
});
