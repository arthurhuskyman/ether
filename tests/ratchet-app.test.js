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

test("prekey: приложение берёт пакет получателя и стартует сессию по 4DH; приёмник расходует одноразовый ключ", async () => {
  const { A, B, pubA, pubB } = await setup();
  const up = await ev(B, `return await Ratchet.prekeyUploadPayload(5);`);
  A.run(`state.contacts.get("bob-id").rc = true; window.__fetched = 0; fetchPrekeyBundle = async (id) => { window.__fetched++; return { spk: ${JSON.stringify(up.spk)}, opk: ${JSON.stringify(up.opks[0])} }; };`);
  const e1 = await sendOffline(A, B, "alice-id", "bob-id", pubA, "px1", chat("pc1", "по пакету"));
  assert.equal(e1.v, 2); assert.ok(e1.h.p && e1.h.p.o === up.opks[0].id, "в заголовке данные пакета");
  assert.equal(A.run(`window.__fetched`), 1);
  assert.ok(has(B, "alice-id", "pc1"), "получатель расшифровал");
  assert.equal(B.run(`!!state.contacts.get("alice-id").rc`), true);
  await sendOffline(A, B, "alice-id", "bob-id", pubA, "px2", chat("pc2", "второе"));
  assert.equal(A.run(`window.__fetched`), 1, "пакет нужен только для старта сессии");
  assert.ok(has(B, "alice-id", "pc2"));
  assert.equal(B.run(`Object.keys(JSON.parse(localStorage.getItem("ether.ratchet")).pk.opks).includes(${JSON.stringify(up.opks[0].id)})`), false, "одноразовый ключ удалён");
});

test("prekey: запрос пакета через сигнальный клиент (ответ сервера, таймаут, отказ)", async () => {
  const { A } = await setup();
  A.run(`window.__ws = []; signaling.ws = { readyState: WebSocket.OPEN, send(x) { window.__ws.push(JSON.parse(x)); } }; signaling.connected = true; signaling.features = ["ratchet2", "prekeys"];`);
  // ответ сервера
  A.run(`window.__b = undefined; fetchPrekeyBundle("bob-id", 1500).then((v) => { window.__b = JSON.stringify(v); });`);
  const req = JSON.parse(A.run(`JSON.stringify(window.__ws.find((m) => m.type === "prekey-fetch"))`));
  assert.equal(req.to, "bob-id");
  A.run(`signaling.dispatchEvent(new CustomEvent("prekey-bundle", { detail: { rid: ${JSON.stringify(req.rid)}, spk: { id: "s1", pub: ["a","b"] }, opk: { id: "o1", pub: ["c","d"] }, error: null } }))`);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(JSON.parse(A.run(`window.__b`)), { spk: { id: "s1", pub: ["a", "b"] }, opk: { id: "o1", pub: ["c", "d"] } });
  // чужой rid игнорируется, по таймауту — null
  A.run(`window.__b2 = "pending"; fetchPrekeyBundle("bob-id", 200).then((v) => { window.__b2 = JSON.stringify(v); }); signaling.dispatchEvent(new CustomEvent("prekey-bundle", { detail: { rid: "чужой", spk: { id: "x", pub: [] } } }));`);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(A.run(`window.__b2`), "null");
  // сервер без поддержки — сразу null, запрос не отправляется
  A.run(`signaling.features = ["ratchet2"]; window.__ws.length = 0; window.__b3 = "pending"; fetchPrekeyBundle("bob-id", 200).then((v) => { window.__b3 = JSON.stringify(v); });`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(A.run(`window.__b3`), "null"); assert.equal(A.run(`window.__ws.length`), 0);
});

test("signaling.deliver пропускает конверт Double Ratchet (v2) и отбрасывает мусор", async () => {
  const { A } = await setup();
  A.run(`window.__ws = []; signaling.ws = { readyState: WebSocket.OPEN, send(x) { window.__ws.push(JSON.parse(x)); } };`);
  assert.equal(A.run(`signaling.deliver("bob-id", "m1", { v: 2, h: { d: ["a", "b"], pn: 0, n: 0 }, ct: "QUJD" }, {}, "chat")`), true);
  assert.equal(A.run(`signaling.deliver("bob-id", "m2", { iv: "AA", ct: "BB", v: 1 }, {}, "chat")`), true);
  assert.equal(A.run(`signaling.deliver("bob-id", "m3", { v: 2, ct: "QUJD" }, {}, "chat")`), false, "v2 без заголовка");
  assert.equal(A.run(`signaling.deliver("bob-id", "m4", { x: 1 }, {}, "chat")`), false);
  assert.equal(A.run(`window.__ws.filter((m) => m.type === "deliver").length`), 2);
});

test("prekey: при регистрации приложение выкладывает ключи, а при prekey-low пополняет запас", async () => {
  const { A } = await setup();
  A.run(`window.__ws = []; signaling.ws = { readyState: WebSocket.OPEN, send(x) { window.__ws.push(JSON.parse(x)); } }; signaling.connected = true; signaling.registered = true; signaling.features = ["ratchet2", "prekeys"]; signaling.prekeyCount = 0;`);
  await ev(A, `await maybeUploadPrekeys(false);`);
  let up = JSON.parse(A.run(`JSON.stringify(window.__ws.filter((m) => m.type === "prekey-upload"))`));
  assert.equal(up.length, 1); assert.equal(up[0].opks.length, 30); assert.ok(up[0].spk.id);
  A.run(`signaling.prekeyCount = 40`);
  await ev(A, `await maybeUploadPrekeys(false);`);
  assert.equal(JSON.parse(A.run(`JSON.stringify(window.__ws.filter((m) => m.type === "prekey-upload").length)`)), 1, "запаса достаточно — повторно не выкладываем");
  A.run(`signaling.dispatchEvent(new CustomEvent("prekey-low", { detail: { count: 3 } }))`);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(JSON.parse(A.run(`JSON.stringify(window.__ws.filter((m) => m.type === "prekey-upload").length)`)), 2, "prekey-low вызывает пополнение");
});
