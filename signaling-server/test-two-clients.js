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

  A.ws.close();
  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})();
