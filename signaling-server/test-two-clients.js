const WebSocket = require("ws");

const URL = "ws://localhost:8787";
const idA = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const idB = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

function connect(id, name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const events = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", id, name, visible: true })));
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => setTimeout(() => resolve({ ws, events, id, name }), 200));
  });
}

(async () => {
  console.log("\n=== Шаг 1: клиент A регистрируется первым ===");
  const A = await connect(idA, "Артём");
  const registeredA = A.events.find((e) => e.type === "registered");
  check("A получил 'registered'", !!registeredA);
  check("A видит пустой список онлайн (B ещё не подключён)", registeredA && registeredA.online.length === 0);

  console.log("\n=== Шаг 2: клиент B подключается ===");
  const B = await connect(idB, "Мария");
  const registeredB = B.events.find((e) => e.type === "registered");
  check("B получил 'registered'", !!registeredB);
  check("B сразу видит A в списке онлайн", registeredB && registeredB.online.some((u) => u.id === idA && u.name === "Артём"));

  await new Promise((r) => setTimeout(r, 200));
  const presenceOnA = A.events.find((e) => e.type === "presence" && e.id === idB);
  check("A получил presence(B online) без опроса — реальным push", !!presenceOnA && presenceOnA.online === true && presenceOnA.name === "Мария");

  console.log("\n=== Шаг 3: пересылка offer/answer (то, что раньше зависало) ===");
  const fakeOffer = { t: "offer", n: "Артём", d: { type: "offer", sdp: "v=0\r\n...fake-sdp..." } };
  A.ws.send(JSON.stringify({ type: "signal", to: idB, data: fakeOffer }));
  await new Promise((r) => setTimeout(r, 200));
  const gotOffer = B.events.find((e) => e.type === "signal" && e.from === idA);
  check("B получил offer от A с корректным payload", !!gotOffer && gotOffer.data.t === "offer" && gotOffer.data.d.sdp.includes("fake-sdp"));

  const fakeAnswer = { t: "answer", n: "Мария", d: { type: "answer", sdp: "v=0\r\n...fake-answer..." } };
  B.ws.send(JSON.stringify({ type: "signal", to: idA, data: fakeAnswer }));
  await new Promise((r) => setTimeout(r, 200));
  const gotAnswer = A.events.find((e) => e.type === "signal" && e.from === idB);
  check("A получил answer от B с корректным payload", !!gotAnswer && gotAnswer.data.t === "answer");

  console.log("\n=== Шаг 4: сигнал незарегистрированному id ===");
  A.ws.send(JSON.stringify({ type: "signal", to: "нет-такого-id", data: { t: "offer" } }));
  await new Promise((r) => setTimeout(r, 200));
  const unreachable = A.events.find((e) => e.type === "unreachable");
  check("A получил 'unreachable' вместо зависания", !!unreachable);

  console.log("\n=== Шаг 5: отключение B транслируется как presence(offline) ===");
  B.ws.close();
  await new Promise((r) => setTimeout(r, 400));
  const offlineOnA = A.events.filter((e) => e.type === "presence" && e.id === idB).pop();
  check("A узнал, что B ушёл офлайн", !!offlineOnA && offlineOnA.online === false);

  console.log("\n=== Шаг 6: тот же id регистрируется второй раз (два клиента с одним и тем же номером/email) ===");
  const A2 = await connect(idA, "Артём (вторая вкладка)");
  await new Promise((r) => setTimeout(r, 300));
  const replacedMsg = A.events.find((e) => e.type === "replaced");
  check("старая сессия A получила 'replaced' вместо тихого обрыва", !!replacedMsg);
  const registeredA2 = A2.events.find((e) => e.type === "registered");
  check("новая сессия с тем же id успешно зарегистрировалась", !!registeredA2);
  console.log("\n=== Шаг 7: офлайн-очередь — сообщение ждёт адресата и приходит при подключении ===");
  const idC = "cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333";
  // idB сейчас не подключён (закрыт на шаге 5) — шлём ему конверт "в закрытые двери".
  A2.ws.send(JSON.stringify({ type: "deliver", to: idB, msgId: "queued-msg-1", envelope: { iv: "x", ct: "y" }, fromPublicKey: { fake: "key" } }));
  await new Promise((r) => setTimeout(r, 200));
  const deliverAckToA = A2.events.find((e) => e.type === "deliver-ack" && e.msgId === "queued-msg-1");
  check("отправитель сразу получил deliver-ack (сервер принял конверт на хранение)", !!deliverAckToA);

  const B2 = await connect(idB, "Мария (снова онлайн)");
  await new Promise((r) => setTimeout(r, 300));
  const queuedDeliver = B2.events.find((e) => e.type === "deliver" && e.msgId === "queued-msg-1");
  check("при подключении Б получил отложенное сообщение из очереди", !!queuedDeliver && queuedDeliver.queued === true);
  check("вместе с конвертом пришёл открытый ключ отправителя", !!queuedDeliver && queuedDeliver.fromPublicKey && queuedDeliver.fromPublicKey.fake === "key");

  B2.ws.send(JSON.stringify({ type: "mailbox-ack", msgId: "queued-msg-1" }));
  await new Promise((r) => setTimeout(r, 200));
  const B3 = await connect(idB, "Мария (третий раз)");
  await new Promise((r) => setTimeout(r, 300));
  const redelivered = B3.events.find((e) => e.type === "deliver" && e.msgId === "queued-msg-1");
  check("после mailbox-ack сообщение больше не присылается повторно", !redelivered);
  B2.ws.close();
  B3.ws.close();

  console.log("\n=== Шаг 8: если адресат сейчас на связи — доставка идёт сразу, без очереди ===");
  const C = await connect(idC, "Пётр");
  await new Promise((r) => setTimeout(r, 200));
  A2.ws.send(JSON.stringify({ type: "deliver", to: idC, msgId: "live-msg-1", envelope: { iv: "a", ct: "b" }, fromPublicKey: null }));
  await new Promise((r) => setTimeout(r, 200));
  const liveDeliver = C.events.find((e) => e.type === "deliver" && e.msgId === "live-msg-1");
  check("сообщение дошло сразу, отмечено как НЕ из очереди", !!liveDeliver && liveDeliver.queued === false);
  C.ws.close();

  A2.ws.close();
  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})();
