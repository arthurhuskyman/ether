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
  A.run(`{ const c = ensureContactEntry("bob-id", "Bob"); c.publicKey = ${pubB}; } signaling.features = ["ratchet2"];`);
  B.run(`{ const c = ensureContactEntry("alice-id", "Alice"); c.publicKey = ${pubA}; } signaling.features = ["ratchet2"];`);
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

async function reinstalled(A, pubA) { // Боб "переустановил" приложение: тот же id, новая пара ключей
  const B2 = await booted("bob-id", "Bob");
  const pubB2 = JSON.parse(B2.run(`JSON.stringify(Store.myPublicKeyJwk)`));
  B2.run(`{ const c = ensureContactEntry("alice-id", "Alice"); c.publicKey = ${JSON.stringify(pubA)}; } signaling.features = ["ratchet2"];`);
  return { B2, pubB2 };
}
const bobState = (A) => JSON.parse(A.run(`JSON.stringify({ pk: !!state.contacts.get("bob-id").pendingKey, rej: !!state.contacts.get("bob-id").rejectedKey, key: state.contacts.get("bob-id").publicKey, held: heldDeliveries.length })`));

test("смена ключа: новый ключ не принимается, сообщение удерживается, баннер показан; подтверждение расшифровывает удержанное", async () => {
  const { A, B, pubA, pubB } = await setup();
  await sendOffline(A, B, "alice-id", "bob-id", pubA, "y1", chat("z1", "a"));
  await sendOffline(B, A, "bob-id", "alice-id", pubB, "y2", chat("z2", "b"));
  assert.notEqual(A.run(`Ratchet.info("bob-id")`), "нет");
  const { B2, pubB2 } = await reinstalled(A, pubA);
  A.run(`state.chatId = "bob-id"; renderKeyChangeBanner();`);
  await sendOffline(B2, A, "bob-id", "alice-id", pubB2, "n1", chat("zz1", "я переустановил"));
  await new Promise((r) => setTimeout(r, 200));
  let st = bobState(A);
  assert.equal(st.pk, true, "новый ключ ждёт подтверждения");
  assert.equal(JSON.stringify(st.key), JSON.stringify(pubB), "прежний ключ остаётся доверенным");
  assert.equal(st.held, 1, "входящее удержано");
  assert.equal(has(A, "bob-id", "zz1"), false, "до подтверждения сообщение не показано");
  assert.equal(A.run(`document.querySelector("#keychange-banner").classList.contains("hidden")`), false, "баннер виден");
  // исходящее ждёт подтверждения
  A.run(`addToOutbox("o1", "bob-id", ${JSON.stringify(chat("zo1", "ответ"))}); flushOutboxItem("o1");`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(A.run(`(pendingNoKey.get("bob-id") || []).length`), 1, "исходящее отложено до подтверждения");
  // подтверждаем
  await ev(A, `await confirmContactKey("bob-id");`);
  st = bobState(A);
  assert.equal(st.pk, false); assert.equal(st.held, 0);
  assert.equal(JSON.stringify(st.key), JSON.stringify(pubB2), "новый ключ принят");
  assert.equal(has(A, "bob-id", "zz1"), true, "удержанное сообщение расшифровано и показано");
  assert.equal(A.run(`document.querySelector("#keychange-banner").classList.contains("hidden")`), true);
  assert.equal(A.run(`(pendingNoKey.get("bob-id") || []).length`), 0, "отложенное исходящее ушло в очередь отправки");
});

test("смена ключа: отклонение сбрасывает удержанное и молча отбрасывает дальнейшее от того же ключа", async () => {
  const { A, B, pubA, pubB } = await setup();
  await sendOffline(A, B, "alice-id", "bob-id", pubA, "q1", chat("p1", "a"));
  await sendOffline(B, A, "bob-id", "alice-id", pubB, "q2", chat("p2", "b"));
  const { B2, pubB2 } = await reinstalled(A, pubA);
  await sendOffline(B2, A, "bob-id", "alice-id", pubB2, "r1", chat("pp1", "x"));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(bobState(A).held, 1);
  A.run(`rejectContactKey("bob-id")`);
  let st = bobState(A);
  assert.equal(st.pk, false); assert.equal(st.rej, true); assert.equal(st.held, 0);
  await sendOffline(B2, A, "bob-id", "alice-id", pubB2, "r2", chat("pp2", "y"));
  await new Promise((r) => setTimeout(r, 150));
  st = bobState(A);
  assert.equal(st.held, 0, "повторные от отклонённого ключа не копятся");
  assert.equal(st.pk, false);
  assert.equal(has(A, "bob-id", "pp2"), false);
  assert.equal(JSON.stringify(st.key), JSON.stringify(pubB));
});

test("состояние доверия переживает сохранение и загрузку контактов", async () => {
  const { A, B, pubA, pubB } = await setup();
  await sendOffline(A, B, "alice-id", "bob-id", pubA, "t1", chat("u1", "a"));
  A.run(`markContactRatchet(state.contacts.get("bob-id")); state.contacts.get("bob-id").pendingKey = { key: { kty: "EC", crv: "P-256", x: "x", y: "y" }, at: 5 }; persistContacts(); persistContactsNow();`);
  const saved = JSON.parse(A.run(`Store.contactsJson`)).find((c) => c.id === "bob-id");
  assert.equal(saved.rc, true);
  assert.equal(saved.pendingKey.at, 5);
  A.run(`state.contacts.clear(); loadContacts();`);
  assert.equal(A.run(`!!state.contacts.get("bob-id").rc`), true);
  assert.equal(A.run(`state.contacts.get("bob-id").pendingKey.at`), 5);
});

test("удаление контакта забывает ratchet-сессии", async () => {
  const { A, B, pubA } = await setup();
  await sendOffline(A, B, "alice-id", "bob-id", pubA, "w1", chat("v1", "a"));
  await sendOffline(B, A, "bob-id", "alice-id", JSON.parse(B.run(`JSON.stringify(Store.myPublicKeyJwk)`)), "w2", chat("v2", "b"));
  assert.notEqual(B.run(`Ratchet.info("alice-id")`), "нет");
  B.run(`deleteContact("alice-id")`);
  assert.equal(B.run(`Ratchet.info("alice-id")`), "нет");
});

test("сервер без поддержки v2: Ratchet не используется, уходит прежний формат", async () => {
  const { A, B, pubA, pubB } = await setup();
  await sendOffline(A, B, "alice-id", "bob-id", pubA, "s1", chat("q1", "a"));
  A.run(`signaling.features = []`);
  const e = await ev(A, `state.contacts.get("bob-id").rc = true; return await encryptForContact(state.contacts.get("bob-id"), "s2", ${JSON.stringify(chat("q2", "b"))});`);
  assert.equal(e.v, 1);
});

test("сервер отклонил конверт: сообщение не считается доставленным, повтор идёт прежним форматом", async () => {
  const { A, pubA } = await setup();
  A.run(`state.contacts.get("bob-id").rc = true;
    outbox.set("e1", { msgId: "e1", to: "bob-id", payload: ${JSON.stringify(chat("r1", "x"))}, sentAt: Date.now(), attempts: 1, serverAcked: false });
    signaling.dispatchEvent(new CustomEvent("deliver-ack", { detail: { msgId: "e1", error: "invalid-envelope" } }));`);
  assert.equal(A.run(`outbox.get("e1").forceV1`), true);
  assert.equal(A.run(`!!outbox.get("e1").serverAcked`), false);
  const e = await ev(A, `return await encryptForContact(state.contacts.get("bob-id"), "e1", outbox.get("e1").payload, outbox.get("e1").forceV1);`);
  assert.equal(e.v, 1);
});
