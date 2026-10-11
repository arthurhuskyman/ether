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

// ---------- prekey-пакеты (3DH/4DH) ----------
async function bundleOf(dev, n = 3) {
  const up = await dev.R.prekeyUploadPayload(n);
  return { spk: up.spk, opks: up.opks, bundle: (i = 0) => ({ spk: up.spk, opk: up.opks[i] || null }) };
}
const sendX = (from, to, plain, bundle) => from.R.encrypt({ ...ctx(from, to), getBundle: async () => bundle }, plain);
function reload(dev, mutate) { const o = JSON.parse(dev.mem.json); mutate(o); dev.mem.json = JSON.stringify(o); dev.R.setStore({ load: () => JSON.parse(dev.mem.json), save: (x) => { dev.mem.json = JSON.stringify(x); } }); }

test("prekey: старт по пакету с одноразовым ключом, переписка идёт в обе стороны, одноразовый ключ уничтожен", async () => {
  const { a, b } = await pair();
  const pb = await bundleOf(b);
  const e1 = await sendX(a, b, { t: 1 }, pb.bundle(0));
  assert.ok(e1.h.p && e1.h.p.s === pb.spk.id && e1.h.p.o === pb.opks[0].id && e1.h.i === 1);
  assert.deepEqual(await recv(b, a, e1), { t: 1 });
  const r = await send(b, a, { r: 1 });
  assert.deepEqual(await recv(a, b, r), { r: 1 });
  const e2 = await send(a, b, { t: 2 }); assert.equal(e2.h.p, undefined, "после ответа заголовок пакета больше не нужен");
  assert.deepEqual(await recv(b, a, e2), { t: 2 });
  // повтор начального конверта после сброса сессий не проходит: одноразовый ключ уничтожен
  b.R.reset(a.id);
  await assert.rejects(recv(b, a, e1), /one-time prekey/);
});

test("prekey: пакет без одноразового ключа тоже работает (3DH)", async () => {
  const { a, b } = await pair();
  const pb = await bundleOf(b, 0);
  const e = await sendX(a, b, { t: "без opk" }, { spk: pb.spk, opk: null });
  assert.equal(e.h.p.o, null);
  assert.deepEqual(await recv(b, a, e), { t: "без opk" });
});

test("prekey: утечка ТОЛЬКО долговременных ключей не открывает первое сообщение (в отличие от старта без пакета)", async () => {
  const { a, b } = await pair();
  const pb = await bundleOf(b);
  const withX = await sendX(a, b, { secret: "X" }, pb.bundle(0));
  const legacy = await send(a, b, { secret: "L" }); // та же пара, но без пакета — для сравнения уйдёт новой сессией, поэтому берём другую пару
  void legacy;
  const { a: a2, b: b2 } = await pair();
  const legacyEnv = await send(a2, b2, { secret: "L" });
  // злоумышленник знает долговременный секретный ключ Боба (но не его хранилище prekey)
  const eveLegacy = device("bob-id", { privateKeyJwk: b2.priv, publicKeyJwk: b2.pub });
  assert.deepEqual(await recv(eveLegacy, a2, legacyEnv), { secret: "L" }, "без пакета достаточно долговременного ключа");
  const eve = device("bob-id", { privateKeyJwk: b.priv, publicKeyJwk: b.pub });
  await assert.rejects(recv(eve, a, withX), "с пакетом долговременного ключа недостаточно");
});

test("prekey: испорченный пакет — откат на старт без пакета, сообщение всё равно доходит", async () => {
  const { a, b } = await pair();
  const e = await sendX(a, b, { t: 1 }, { spk: { id: 5, pub: "oops" }, opk: null });
  assert.equal(e.h.p, undefined);
  assert.deepEqual(await recv(b, a, e), { t: 1 });
  const { a: a2, b: b2 } = await pair();
  const e2 = await a2.R.encrypt({ ...ctx(a2, b2), getBundle: async () => { throw new Error("сеть"); } }, { t: 2 });
  assert.deepEqual(await recv(b2, a2, e2), { t: 2 });
});

test("prekey: неизвестный spk отклоняется; старый spk после ротации ещё принимается", async () => {
  const { a, b } = await pair();
  const pb = await bundleOf(b);
  // Алиса взяла пакет со старым spk, Боб до прихода сообщения успел сменить spk (прошла неделя)
  reload(b, (o) => { o.pk.spk.t = 0; });
  const fresh = await b.R.prekeyUploadPayload(2);
  assert.notEqual(fresh.spk.id, pb.spk.id, "spk сменился");
  const e = await sendX(a, b, { t: "по старому spk" }, pb.bundle(0));
  assert.deepEqual(await recv(b, a, e), { t: "по старому spk" });
  const { a: a2, b: b2 } = await pair();
  const bogus = { spk: { id: "нет-такого", pub: pb.spk.pub }, opk: null };
  const e2 = await sendX(a2, b2, { t: 2 }, bogus);
  await assert.rejects(recv(b2, a2, e2), /unknown prekey/);
});

test("prekey: одновременный старт с обеих сторон по пакетам сходится", async () => {
  const { a, b } = await pair();
  const pa = await bundleOf(a), pb = await bundleOf(b);
  const ea = await sendX(a, b, { from: "a" }, pb.bundle(0));
  const eb = await sendX(b, a, { from: "b" }, pa.bundle(0));
  assert.deepEqual(await recv(b, a, ea), { from: "a" });
  assert.deepEqual(await recv(a, b, eb), { from: "b" });
  for (let i = 0; i < 3; i++) {
    const m = await send(a, b, { i }); assert.deepEqual(await recv(b, a, m), { i });
    const r = await send(b, a, { j: i }); assert.deepEqual(await recv(a, b, r), { j: i });
  }
});

test("prekey: запас на сервере пополняется по условию; хранилище переживает перезапуск", async () => {
  const { b } = await pair();
  assert.equal(b.R.needsPrekeys(50), true, "ещё нет spk");
  const up = await b.R.prekeyUploadPayload(20);
  assert.equal(up.opks.length, 20);
  assert.equal(b.R.needsPrekeys(25), false);
  assert.equal(b.R.needsPrekeys(5), true, "на сервере мало");
  assert.equal(b.R.needsPrekeys(undefined), true);
  assert.ok(up.opks.every((o) => /^[A-Za-z0-9_-]{1,32}$/.test(o.id) && o.pub.every((s) => /^[A-Za-z0-9_-]{20,100}$/.test(s))), "формат совместим с проверкой сервера");
  reload(b, () => {});
  assert.equal(b.R.needsPrekeys(25), false, "после перезагрузки spk на месте");
});

// ---------- подпись spk (C2) ----------
test("prekey: spk подписан ключом личности — подлинный пакет принимается, подменённый отвергается, без подписи (старый клиент) принимается", async () => {
  const { a, b } = await pair();
  const up = await b.R.prekeyUploadPayload(2, b.priv);
  assert.ok(up.spk.sig, "подпись выложена");
  assert.equal(await a.R.verifySpk(b.pub, up.spk), true);
  const e = await sendX(a, b, { t: "по подписанному" }, { spk: up.spk, opk: up.opks[0] });
  assert.ok(e.h.p, "старт по prekey-пакету");
  assert.deepEqual(await recv(b, a, e), { t: "по подписанному" });
  // сервер подменил spk своим ключом (подпись от прежнего spk)
  const { a: a2, b: b2 } = await pair();
  const real = await b2.R.prekeyUploadPayload(1, b2.priv);
  const evil = await a2.R.prekeyUploadPayload(1, a2.priv); // «ключ сервера»
  const forged = { id: evil.spk.id, pub: evil.spk.pub, sig: real.spk.sig };
  assert.equal(await a2.R.verifySpk(b2.pub, forged), false);
  const e2 = await sendX(a2, b2, { t: "подмена" }, { spk: forged, opk: null });
  assert.equal(e2.h.p, undefined, "подмена не использована: старт от долговременных ключей");
  assert.deepEqual(await recv(b2, a2, e2), { t: "подмена" });
  // подпись другого человека
  assert.equal(await a2.R.verifySpk(a2.pub, real.spk), false);
  // старый клиент без подписи — принимается как раньше
  const { a: a3, b: b3 } = await pair();
  const old = await b3.R.prekeyUploadPayload(1);
  assert.equal(old.spk.sig, undefined);
  const e3 = await sendX(a3, b3, { t: "без подписи" }, { spk: old.spk, opk: old.opks[0] });
  assert.ok(e3.h.p);
});
