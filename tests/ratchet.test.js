// Double Ratchet (js/ratchet.js): прямые проверки протокола двумя независимыми "устройствами".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const ratchetPath = path.join(__dirname, "..", "js", "ratchet.js");
const helperSrc = fs.readFileSync(path.join(__dirname, "..", "js", "crypto-helper.js"), "utf8");
const CH = new Function(helperSrc + "\nreturn CryptoHelper;")();

// Каждое устройство получает свой экземпляр модуля (свои сессии и своё "хранилище").
function device(id, keys) {
  delete require.cache[require.resolve(ratchetPath)];
  const R = require(ratchetPath);
  const mem = { json: "{}" };
  R.setStore({ load: () => JSON.parse(mem.json), save: (o) => { mem.json = JSON.stringify(o); } });
  return { id, R, mem, priv: keys.privateKeyJwk, pub: keys.publicKeyJwk };
}
const ctx = (me, other) => ({ contactId: other.id, myId: me.id, myPrivJwk: me.priv, theirPubJwk: other.pub });
const send = (from, to, plain) => from.R.encrypt(ctx(from, to), plain);
const recv = (to, from, env) => to.R.decrypt(ctx(to, from), env);

async function pair() {
  const a = device("alice-id", await CH.generateKeyPair());
  const b = device("bob-id", await CH.generateKeyPair());
  return { a, b };
}

test("переписка в обе стороны: все сообщения расшифровываются, ключи меняются", async () => {
  const { a, b } = await pair();
  const e1 = await send(a, b, { text: "привет" });
  assert.equal(e1.v, 2); assert.equal(e1.h.i, 1);
  assert.deepEqual(await recv(b, a, e1), { text: "привет" });
  const r1 = await send(b, a, { text: "ответ" });
  assert.deepEqual(await recv(a, b, r1), { text: "ответ" });
  assert.notDeepEqual(e1.h.d, r1.h.d, "у сторон разные временные ключи");
  for (let i = 0; i < 6; i++) {
    const m = await send(a, b, { n: i }); assert.equal(m.h.i, undefined, "после ответа флаг начальной сессии снят");
    assert.deepEqual(await recv(b, a, m), { n: i });
    const r = await send(b, a, { n: 100 + i });
    assert.deepEqual(await recv(a, b, r), { n: 100 + i });
  }
  const d1 = (await send(a, b, { x: 1 })).h.d, d2 = (await send(a, b, { x: 2 })).h.d;
  assert.deepEqual(d1, d2, "внутри одной цепочки временный ключ не меняется");
});

test("сообщения приходят не по порядку: пропущенные ключи сохраняются", async () => {
  const { a, b } = await pair();
  const m = []; for (let i = 0; i < 4; i++) m.push(await send(a, b, { i }));
  assert.deepEqual(await recv(b, a, m[2]), { i: 2 });
  assert.deepEqual(await recv(b, a, m[0]), { i: 0 });
  assert.deepEqual(await recv(b, a, m[3]), { i: 3 });
  assert.deepEqual(await recv(b, a, m[1]), { i: 1 });
  // после ответа и новой цепочки "хвост" старой цепочки всё ещё открывается
  const old = await send(a, b, { tail: true });
  const rep = await send(b, a, { r: 1 });
  await recv(a, b, rep);
  const fresh = await send(a, b, { fresh: true });
  assert.deepEqual(await recv(b, a, fresh), { fresh: true });
  assert.deepEqual(await recv(b, a, old), { tail: true });
});

test("повтор того же конверта отклоняется и не портит состояние", async () => {
  const { a, b } = await pair();
  const e = await send(a, b, { t: 1 });
  await recv(b, a, e);
  await assert.rejects(recv(b, a, e));
  const e2 = await send(a, b, { t: 2 });
  assert.deepEqual(await recv(b, a, e2), { t: 2 });
});

test("подмена шифртекста или заголовка не проходит и не сдвигает состояние", async () => {
  const { a, b } = await pair();
  const e = await send(a, b, { secret: 1 });
  const bad = JSON.parse(JSON.stringify(e)); bad.ct = bad.ct.slice(0, -4) + "AAAA";
  await assert.rejects(recv(b, a, bad));
  const bad2 = JSON.parse(JSON.stringify(e)); bad2.h.n = 1;
  await assert.rejects(recv(b, a, bad2));
  assert.deepEqual(await recv(b, a, e), { secret: 1 }, "настоящий конверт всё ещё открывается");
});

test("конверт нельзя выдать за конверт от другого отправителя или другому получателю", async () => {
  const { a, b } = await pair();
  const c = device("carol-id", await CH.generateKeyPair());
  const e = await send(a, b, { x: 1 });
  // тот же конверт, но Боб считает, что он пришёл от Кэрол
  await assert.rejects(b.R.decrypt({ contactId: c.id, myId: b.id, myPrivJwk: b.priv, theirPubJwk: c.pub }, e));
});

test("forward secrecy: после чтения ключ сообщения уничтожен, копия состояния его не откроет", async () => {
  const { a, b } = await pair();
  const e = await send(a, b, { t: "старое" });
  await recv(b, a, e);
  const reply = await send(b, a, { r: 1 }); await recv(a, b, reply);
  const e2 = await send(a, b, { t: "новое" }); await recv(b, a, e2);
  const leaked = b.mem.json; // "украденное" состояние Боба после чтения
  const thief = device("bob-id", { privateKeyJwk: b.priv, publicKeyJwk: b.pub });
  thief.mem.json = leaked; thief.R.setStore({ load: () => JSON.parse(leaked), save: () => {} });
  await assert.rejects(recv(thief, a, e), "старое сообщение украденным состоянием не открывается");
  await assert.rejects(recv(thief, a, e2));
});

test("одновременный первый контакт с обеих сторон сходится в одну переписку", async () => {
  const { a, b } = await pair();
  const ea = await send(a, b, { from: "a" });
  const eb = await send(b, a, { from: "b" });
  assert.deepEqual(await recv(b, a, ea), { from: "a" });
  assert.deepEqual(await recv(a, b, eb), { from: "b" });
  for (let i = 0; i < 4; i++) {
    const m = await send(a, b, { i }); assert.deepEqual(await recv(b, a, m), { i });
    const r = await send(b, a, { j: i }); assert.deepEqual(await recv(a, b, r), { j: i });
  }
});

test("потерянное первое сообщение: вторая попытка открывает сессию, первое доходит позже", async () => {
  const { a, b } = await pair();
  const m0 = await send(a, b, { n: 0 }), m1 = await send(a, b, { n: 1 });
  assert.deepEqual(await recv(b, a, m1), { n: 1 });
  assert.deepEqual(await recv(b, a, m0), { n: 0 });
});

test("потеря состояния у одной стороны лечится новой сессией", async () => {
  const { a, b } = await pair();
  const e = await send(a, b, { n: 1 }); await recv(b, a, e);
  const r = await send(b, a, { r: 1 }); await recv(a, b, r);
  const settled = await send(a, b, { n: 2 }); // без флага начальной сессии
  b.R.resetAll();
  await assert.rejects(recv(b, a, settled));
  const hello = await send(b, a, { again: 1 });
  assert.deepEqual(await recv(a, b, hello), { again: 1 });
  const back = await send(a, b, { back: 1 });
  assert.deepEqual(await recv(b, a, back), { back: 1 });
});

test("слишком большой разрыв номеров отклоняется", async () => {
  const { a, b } = await pair();
  let last; for (let i = 0; i < 260; i++) last = await send(a, b, { i });
  await assert.rejects(recv(b, a, last));
});

test("состояние переживает перезапуск (сохранение и загрузка)", async () => {
  const { a, b } = await pair();
  await recv(b, a, await send(a, b, { n: 1 }));
  await recv(a, b, await send(b, a, { r: 1 }));
  const b2 = device("bob-id", { privateKeyJwk: b.priv, publicKeyJwk: b.pub });
  b2.mem.json = b.mem.json;
  b2.R.setStore({ load: () => JSON.parse(b.mem.json), save: (o) => { b.mem.json = JSON.stringify(o); } });
  const m = await send(a, b2, { n: 2 });
  assert.deepEqual(await recv(b2, a, m), { n: 2 });
});

test("reset(contact) забывает сессии контакта", async () => {
  const { a, b } = await pair();
  await recv(b, a, await send(a, b, { n: 1 }));
  assert.match(b.R.info(a.id), /сесс/);
  b.R.reset(a.id);
  assert.equal(b.R.info(a.id), "нет");
});
