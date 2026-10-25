// V.76 audit C3/C4/C5: AAD v2 с capability-гейтом, запись до выдачи plaintext при opk, не вытеснять живые opk.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const ratchetPath = path.join(__dirname, "..", "js", "ratchet.js");
const CH = new Function(fs.readFileSync(path.join(__dirname, "..", "js", "crypto-helper.js"), "utf8") + "\nreturn CryptoHelper;")();
function device(id, keys, opts = {}) {
  delete require.cache[require.resolve(ratchetPath)];
  const R = require(ratchetPath);
  const mem = { json: "{}", fail: false };
  R.setStore({ load: () => JSON.parse(mem.json), save: (o) => { if (mem.fail) return false; mem.json = JSON.stringify(o); return true; } });
  return { id, R, mem, priv: keys.privateKeyJwk, pub: keys.publicKeyJwk };
}
const ctx = (me, o, extra) => ({ contactId: o.id, myId: me.id, myPrivJwk: me.priv, theirPubJwk: o.pub, ...(extra || {}) });
const send = (f, t, p, x) => f.R.encrypt(ctx(f, t, x), p);
const recv = (t, f, e) => t.R.decrypt(ctx(t, f), e);
async function pair() { return { a: device("alice-id", await CH.generateKeyPair()), b: device("bob-id", await CH.generateKeyPair()) }; }

test("C3: первое сообщение v1 (совместимо), после увидев ac — v2; подмена h.i/h.p ловится", async () => {
  const { a, b } = await pair();
  const e1 = await send(a, b, { t: 1 });
  assert.equal(e1.ac, 1); assert.equal(e1.a, undefined, "без подтверждённой поддержки AAD v1");
  assert.deepEqual(await recv(b, a, e1), { t: 1 });
  const r = await send(b, a, { t: 2 });
  assert.equal(r.a, 3, "Боб знает (подсказка cp), что Алиса умеет AAD v3");
  assert.deepEqual(await recv(a, b, r), { t: 2 });
  const e2 = await send(a, b, { t: 3 });
  assert.equal(e2.a, 3);
  assert.deepEqual(await recv(b, a, e2), { t: 3 });
  // подмена h.i в v2-конверте
  const e3 = await send(a, b, { t: 4 });
  const bad = JSON.parse(JSON.stringify(e3)); bad.h.i = 1;
  await assert.rejects(recv(b, a, bad));
});

test("C3: v2 AAD покрывает h.i и h.p (начальный конверт)", async () => {
  const { a, b } = await pair();
  // Алиса уже знает, что Боб умеет v2
  const warm = await send(b, a, { w: 1 }); await recv(a, b, warm);
  const up = await b.R.prekeyUploadPayload(2);
  a.R.reset("bob-id");
  const e = await send(a, b, { x: 1 }, { getBundle: async () => ({ spk: up.spk, opk: up.opks[0] }) });
  assert.equal(e.a, 3); assert.ok(e.h.p && e.h.i === 1);
  const bad = JSON.parse(JSON.stringify(e)); bad.h.p.o = up.opks[1].id;
  await assert.rejects(recv(b, a, bad));
  assert.deepEqual(await recv(b, a, e), { x: 1 });
});

test("C3/v3: после проверенного v3 откат собеседника не сбрасывает уровень молча: конверт слабее отвергается, resetTrust — явный выход", async () => {
  const { a, b } = await pair();
  await recv(b, a, await send(a, b, { 1: 1 }));
  const r = await send(b, a, { 2: 2 }); await recv(a, b, r);
  assert.equal((await send(a, b, { 3: 3 })).a, 3);
  const warns = []; a.R.onWarn((id, code) => warns.push(id + ":" + code));
  // Сервер убрал a/ac/cp у настоящего v3-конверта Боба: AAD не сойдётся (не принимаем как v1/v2)
  const e = await send(b, a, { 4: 4 }); const forged = JSON.parse(JSON.stringify(e)); delete forged.a; delete forged.ac; delete forged.cp;
  await assert.rejects(recv(a, b, forged), /auth failed/);
  assert.equal(a.R.status("bob-id").sticky, 3);
  assert.equal((await send(a, b, { 5: 5 })).a, 3, "Алиса продолжает слать v3 даже без подсказок");
  assert.deepEqual(await recv(a, b, e), { 4: 4 }, "настоящий конверт по-прежнему открывается");
  // «Боб» поставил чистый клиент и шлёт начальный конверт со слабым AAD: отвергаем с предупреждением, не сбрасывая уровень
  const b2 = device("bob-id", await CH.generateKeyPair());
  b2.pub = b.pub; b2.priv = b.priv;
  const weak = await send(b2, a, { w: 1 });
  assert.equal(weak.a, undefined);
  await assert.rejects(recv(a, b2, weak), /downgrade/);
  assert.deepEqual(warns, ["bob-id:downgrade"]);
  assert.equal(a.R.status("bob-id").sticky, 3);
  a.R.resetTrust("bob-id");
  assert.equal(a.R.status("bob-id").sticky, 0);
});

test("C4: opk не отдаёт plaintext, если запись удаления не удалась; повтор после восстановления работает", async () => {
  const { a, b } = await pair();
  const up = await b.R.prekeyUploadPayload(1);
  const e = await send(a, b, { s: 1 }, { getBundle: async () => ({ spk: up.spk, opk: up.opks[0] }) });
  b.mem.fail = true;
  await assert.rejects(recv(b, a, e), /persist/);
  assert.ok(JSON.parse(b.mem.json).pk.opks[up.opks[0].id], "opk в хранилище нетронут");
  b.mem.fail = false;
  b.R.setStore({ load: () => JSON.parse(b.mem.json), save: (o) => { b.mem.json = JSON.stringify(o); return true; } });
  assert.deepEqual(await recv(b, a, e), { s: 1 });
  assert.equal(JSON.parse(b.mem.json).pk.opks[up.opks[0].id], undefined, "после записи opk удалён");
});

test("C5: переполнение не вытесняет свежие opk — их выдаётся не больше свободного места", async () => {
  const { b } = await pair();
  const first = await b.R.prekeyUploadPayload(190);
  const second = await b.R.prekeyUploadPayload(50);
  assert.equal(second.opks.length, 10);
  const saved = JSON.parse(b.mem.json).pk.opks;
  assert.equal(Object.keys(saved).length, 200);
  assert.ok(first.opks.every((o) => saved[o.id]), "ранее выданные на сервер opk целы");
  // давно загруженные (старше TTL) освобождают место
  for (const id of Object.keys(saved).slice(0, 5)) saved[id].t = Date.now() - 90 * 24 * 3600 * 1000;
  b.mem.json = JSON.stringify({ ...JSON.parse(b.mem.json), pk: { ...JSON.parse(b.mem.json).pk, opks: saved } });
  b.R.setStore({ load: () => JSON.parse(b.mem.json), save: (o) => { b.mem.json = JSON.stringify(o); return true; } });
  assert.equal((await b.R.prekeyUploadPayload(20)).opks.length, 5);
});

