// Интеграция Double Ratchet в приложение: два настоящих экземпляра приложения (jsdom) обмениваются офлайн-конвертами.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

async function booted(id, name) {
  const a = createApp({ storage: { "ether.name": name, "ether.myId": id, "ether.lang": "en" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted && !!Store.myPublicKeyJwk`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}
async function ev(a, code) { // выполняет async-код в окне приложения и возвращает JSON-результат
  a.window.__r = undefined; a.window.__e = undefined;
  a.run(`(async () => { ${code} })().then((v) => { window.__r = JSON.stringify(v === undefined ? null : v); }, (e) => { window.__e = String(e); })`);
  for (let i = 0; i < 200 && a.window.__r === undefined && a.window.__e === undefined; i++) await new Promise((r) => setTimeout(r, 25));
  if (a.window.__e) throw new Error(a.window.__e);
  return JSON.parse(a.window.__r);
}

async function setup() {
  const A = await booted("alice-id", "Alice"), B = await booted("bob-id", "Bob");
  const pubA = A.run(`JSON.stringify(Store.myPublicKeyJwk)`), pubB = B.run(`JSON.stringify(Store.myPublicKeyJwk)`);
  A.run(`{ const c = ensureContactEntry("bob-id", "Bob"); c.publicKey = ${pubB}; }`);
  B.run(`{ const c = ensureContactEntry("alice-id", "Alice"); c.publicKey = ${pubA}; }`);
  return { A, B, pubA: JSON.parse(pubA), pubB: JSON.parse(pubB) };
}
// A шифрует payload для contactId и "доставляет" конверт B через событие deliver сигнального клиента B.
async function sendOffline(from, to, fromId, toId, fromPub, msgId, payload) {
  const env = await ev(from, `return await encryptForContact(state.contacts.get(${JSON.stringify(toId)}), ${JSON.stringify(msgId)}, ${JSON.stringify(payload)});`);
  to.run(`signaling.dispatchEvent(new CustomEvent("deliver", { detail: { from: ${JSON.stringify(fromId)}, msgId: ${JSON.stringify(msgId)}, envelope: ${JSON.stringify(env)}, fromPublicKey: ${JSON.stringify(fromPub)}, kind: "chat" } }))`);
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 25)); if (to.run(`(state.contacts.get(${JSON.stringify(fromId)}) || {messages:[]}).messages.some((m) => m.id === ${JSON.stringify(payload.id)})`)) break; }
  return env;
}
const has = (a, cid, id) => a.run(`(state.contacts.get(${JSON.stringify(cid)}) || {messages:[]}).messages.some((m) => m.id === ${JSON.stringify(id)})`);
const chat = (id, text) => ({ kind: "chat", id, text, ts: Date.now() });

test("первое сообщение идёт прежним форматом с флагом rc, дальше оба переходят на Double Ratchet", async () => {
  const { A, B, pubA, pubB } = await setup();
  const e1 = await sendOffline(A, B, "alice-id", "bob-id", pubA, "m1", chat("c1", "привет"));
  assert.equal(e1.v, 1, "собеседник ещё не объявил поддержку — прежний формат");
  assert.equal(e1.rc, 1);
  assert.ok(has(B, "alice-id", "c1"), "Боб прочитал сообщение прежнего формата");
  assert.equal(B.run(`!!state.contacts.get("alice-id").rc`), true, "Боб запомнил, что Алиса умеет Double Ratchet");

  const e2 = await sendOffline(B, A, "bob-id", "alice-id", pubB, "m2", chat("c2", "ответ"));
  assert.equal(e2.v, 2, "Боб уже знает про Алису — Double Ratchet");
  assert.ok(has(A, "bob-id", "c2"));
  assert.equal(A.run(`!!state.contacts.get("bob-id").rc`), true);

  const e3 = await sendOffline(A, B, "alice-id", "bob-id", pubA, "m3", chat("c3", "ещё"));
  assert.equal(e3.v, 2);
  assert.ok(has(B, "alice-id", "c3"));
  const e4 = await sendOffline(B, A, "bob-id", "alice-id", pubB, "m4", chat("c4", "и ещё"));
  assert.ok(has(A, "bob-id", "c4"));
  assert.notDeepEqual(e3.h.d, e4.h.d);
});

test("повторная отправка того же msgId не тратит новые ключи цепочки (кэш конверта)", async () => {
  const { A, B, pubA, pubB } = await setup();
  await sendOffline(A, B, "alice-id", "bob-id", pubA, "x1", chat("k1", "a"));
  await sendOffline(B, A, "bob-id", "alice-id", pubB, "x2", chat("k2", "b"));
  const p = chat("k3", "c");
  const first = await ev(A, `return await encryptForContact(state.contacts.get("bob-id"), "x3", ${JSON.stringify(p)});`);
  const again = await ev(A, `return await encryptForContact(state.contacts.get("bob-id"), "x3", ${JSON.stringify(p)});`);
  assert.deepEqual(first, again);
});

test("смена долговременного ключа контакта: сессии сброшены, показано предупреждение", async () => {
  const { A, B, pubA, pubB } = await setup();
  await sendOffline(A, B, "alice-id", "bob-id", pubA, "y1", chat("z1", "a"));
  await sendOffline(B, A, "bob-id", "alice-id", pubB, "y2", chat("z2", "b"));
  assert.notEqual(A.run(`Ratchet.info("bob-id")`), "нет");
  const fakeKey = await ev(A, `const p = await CryptoHelper.generateKeyPair(); return p.publicKeyJwk;`);
  A.run(`adoptContactKey(state.contacts.get("bob-id"), ${JSON.stringify(fakeKey)})`);
  assert.equal(A.run(`Ratchet.info("bob-id")`), "нет", "сессии с Бобом сброшены");
  assert.equal(A.run(`JSON.stringify(state.contacts.get("bob-id").publicKey)`), JSON.stringify(fakeKey), "новый ключ принят");
});

test("удаление контакта забывает ratchet-сессии", async () => {
  const { A, B, pubA } = await setup();
  await sendOffline(A, B, "alice-id", "bob-id", pubA, "w1", chat("v1", "a"));
  await sendOffline(B, A, "bob-id", "alice-id", JSON.parse(B.run(`JSON.stringify(Store.myPublicKeyJwk)`)), "w2", chat("v2", "b"));
  assert.notEqual(B.run(`Ratchet.info("alice-id")`), "нет");
  B.run(`deleteContact("alice-id")`);
  assert.equal(B.run(`Ratchet.info("alice-id")`), "нет");
});
