// V.80 fuzz: Ratchet.decrypt на обрезанных/мутированных/мусорных конвертах. Требования: никогда не принимает испорченное
// (результат либо исключение, либо ровно исходный текст), не зависает, не портит состояние сессии (честная переписка продолжается).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const { rng, junkValue, withTimeout } = require("./fuzz-helpers");
const ratchetPath = path.join(__dirname, "..", "js", "ratchet.js");
const CH = new Function(fs.readFileSync(path.join(__dirname, "..", "js", "crypto-helper.js"), "utf8") + "\nreturn CryptoHelper;")();
function device(id, keys) {
  delete require.cache[require.resolve(ratchetPath)];
  const R = require(ratchetPath), mem = { json: "{}" };
  R.setStore({ load: () => JSON.parse(mem.json), save: (o) => { mem.json = JSON.stringify(o); } });
  return { id, R, mem, priv: keys.privateKeyJwk, pub: keys.publicKeyJwk };
}
const ctx = (me, o) => ({ contactId: o.id, myId: me.id, myPrivJwk: me.priv, theirPubJwk: o.pub });
const send = (f, t, p) => f.R.encrypt(ctx(f, t), p);
const recv = (t, f, e) => t.R.decrypt(ctx(t, f), e);
const clone = (x) => JSON.parse(JSON.stringify(x));

// Случайная мутация одного листа JSON-дерева конверта
function mutate(env, r) {
  for (let t = 0; t < 20; t++) { const m = mutate1(env, r); if (JSON.stringify(m) !== JSON.stringify(env)) return m; }
  return { v: 2 };
}
function mutate1(env, r) {
  const e = clone(env), paths = [];
  (function walk(o, p) { for (const k of Object.keys(o)) { if (p.length === 0 && (k === "rc" || k === "ac" || k === "cp")) continue; // rc/ac — осознанно НЕ аутентифицируемые подсказки возможностей (docs/THREAT-MODEL.md, остаточные риски)
    const q = p.concat(k); if (o[k] && typeof o[k] === "object") walk(o[k], q); paths.push(q); } })(e, []);
  const path = paths[r.int(paths.length)];
  let o = e; for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  const k = path[path.length - 1], v = o[k], m = r.int(7);
  if (m === 0) delete o[k];
  else if (m === 1) o[k] = null;
  else if (m === 2) o[k] = junkValue(r, 2);
  else if (m === 3 && typeof v === "string") o[k] = v.slice(0, r.int(v.length));
  else if (m === 4 && typeof v === "string" && v.length) { const b = Buffer.from(v, "base64"); if (b.length) { b[r.int(b.length)] ^= 1 << r.int(8); o[k] = b.toString("base64"); } else o[k] = v + "A"; }
  else if (m === 5 && typeof v === "number") o[k] = v + (r.bool() ? 1 : -1) * (1 + r.int(5));
  else if (m === 6 && typeof v === "string") o[k] = v + v;
  else o[k] = typeof v === "string" ? "" : 0;
  return e;
}
async function tryRecv(t, f, env, plain) {
  let res;
  try { res = await withTimeout(Promise.resolve().then(() => recv(t, f, env)), 8000, "ratchet завис"); }
  catch (e) { assert.ok(!/завис/.test(String(e && e.message)), "ratchet завис"); return false; }
  assert.deepEqual(res, plain, "принят испорченный конверт с другим содержимым");
  return true;
}

test("ratchet: мутации начального конверта не принимаются и не ломают сессию", async () => {
  const r = rng(80010);
  const a = device("alice-id", await CH.generateKeyPair()), b = device("bob-id", await CH.generateKeyPair());
  const e1 = await send(a, b, { text: "первое" });
  let acc = 0;
  for (let i = 0; i < 120; i++) { if (await tryRecv(b, a, mutate(e1, r), { text: "первое" })) acc++; }
  // полностью мусорные конверты
  for (let i = 0; i < 60; i++) await tryRecv(b, a, junkValue(r, 0), { text: "первое" }).catch(() => {});
  for (const bad of [null, undefined, 0, "", "x", [], {}, { v: 2 }, { v: 2, h: {} }, { v: 2, h: { d: 1, n: 0 }, iv: "", ct: "" }]) assert.equal(await tryRecv(b, a, bad, { text: "первое" }), false);
  assert.ok(acc <= 120);
  assert.deepEqual(await recv(b, a, e1), { text: "первое" }, "настоящий конверт после мусора расшифровывается");
  const rr = await send(b, a, { text: "ответ" });
  assert.deepEqual(await recv(a, b, rr), { text: "ответ" });
});

test("ratchet: мутации в середине переписки (в т.ч. пропущенные сообщения) не портят состояние", async () => {
  const r = rng(80011);
  const a = device("alice-id", await CH.generateKeyPair()), b = device("bob-id", await CH.generateKeyPair());
  assert.deepEqual(await recv(b, a, await send(a, b, { n: 0 })), { n: 0 });
  assert.deepEqual(await recv(a, b, await send(b, a, { n: 1 })), { n: 1 });
  const m2 = await send(a, b, { n: 2 }), m3 = await send(a, b, { n: 3 }), m4 = await send(a, b, { n: 4 });
  for (let i = 0; i < 100; i++) {
    const useM3 = r.bool(), orig = useM3 ? m3 : m4, mu = mutate(orig, r);
    if (await tryRecv(b, a, mu, useM3 ? { n: 3 } : { n: 4 })) assert.fail("принят мутированный конверт: " + JSON.stringify(mu) + " вместо " + JSON.stringify(orig));
  }
  // обрезки каждого строкового поля
  for (const len of [0, 1, 5, 20]) { const e = clone(m3); e.ct = e.ct.slice(0, len); assert.equal(await tryRecv(b, a, e, { n: 3 }), false); }
  // порядок вывернут: сначала m4, потом m2, m3 — пропущенные ключи работают
  assert.deepEqual(await recv(b, a, m4), { n: 4 });
  assert.deepEqual(await recv(b, a, m2), { n: 2 });
  assert.deepEqual(await recv(b, a, m3), { n: 3 });
  // повтор уже принятого не принимается как новое
  await assert.rejects(() => recv(b, a, m3));
  // огромный пропуск (счётчик далеко вперёд) отклоняется и не съедает память/время
  const far = clone(await send(a, b, { n: 5 })); if (far.h && typeof far.h.n === "number") far.h.n += 5000;
  await tryRecv(b, a, far, { n: 5 });
  assert.deepEqual(await recv(b, a, await send(a, b, { n: 6 })), { n: 6 });
  assert.deepEqual(await recv(a, b, await send(b, a, { n: 7 })), { n: 7 });
  // состояние, сериализованное в хранилище, остаётся валидным JSON и загружается
  assert.doesNotThrow(() => JSON.parse(b.mem.json)); assert.doesNotThrow(() => JSON.parse(a.mem.json));
});
