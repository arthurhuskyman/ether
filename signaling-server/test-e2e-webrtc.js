// Полноценный тест: два независимых WebRTC-пира договариваются через
// локальный сигнальный сервер (тот же самый server.js) и обмениваются
// сообщением по настоящему P2P data channel — то есть воспроизводит
// ровно то, что делают два браузерных клиента приложения, только без
// самого браузера.

const WebSocket = require("ws");
const wrtc = require("@roamhq/wrtc");
const { RTCPeerConnection } = wrtc;

const SIGNALING_URL = "ws://localhost:8787";
const idA = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const idB = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

function waitIceComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 4000);
    pc.addEventListener("icegatheringstatechange", function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    });
  });
}

function makeSignalingSocket(id, name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(SIGNALING_URL);
    const handlers = {};
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (handlers[msg.type]) handlers[msg.type](msg);
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "register", id, name, visible: true }));
      resolve({
        ws,
        on: (type, fn) => { handlers[type] = fn; },
        signal: (to, data) => ws.send(JSON.stringify({ type: "signal", to, data })),
      });
    });
  });
}

(async () => {
  console.log("\n=== Поднимаем два независимых WebRTC-пира ===");

  const sockA = await makeSignalingSocket(idA, "Артём");
  const sockB = await makeSignalingSocket(idB, "Мария");
  await new Promise((r) => setTimeout(r, 200));

  // ---- Сторона A: офферер (как offerer-роль в PeerLink) ----
  const pcA = new RTCPeerConnection({ iceServers: [] }); // локально STUN не нужен
  const dcA = pcA.createDataChannel("control", { ordered: true });

  let dcAOpen = false;
  const receivedOnA = [];
  dcA.onopen = () => (dcAOpen = true);
  dcA.onmessage = (ev) => receivedOnA.push(JSON.parse(ev.data));

  // ---- Сторона B: ответчик (как answerer-роль в PeerLink) ----
  const pcB = new RTCPeerConnection({ iceServers: [] });
  let dcB = null;
  let dcBOpen = false;
  const receivedOnB = [];
  pcB.ondatachannel = (ev) => {
    dcB = ev.channel;
    dcB.onopen = () => (dcBOpen = true);
    dcB.onmessage = (ev2) => receivedOnB.push(JSON.parse(ev2.data));
  };

  // ---- Сигналинг между ними идёт ровно через тот же протокол, что и в app.js ----
  sockB.on("signal", async (msg) => {
    if (msg.data.t !== "offer") return;
    await pcB.setRemoteDescription(msg.data.d);
    const answer = await pcB.createAnswer();
    await pcB.setLocalDescription(answer);
    await waitIceComplete(pcB);
    sockB.signal(idA, { t: "answer", n: "Мария", d: { type: pcB.localDescription.type, sdp: pcB.localDescription.sdp } });
  });

  sockA.on("signal", async (msg) => {
    if (msg.data.t !== "answer") return;
    await pcA.setRemoteDescription(msg.data.d);
  });

  console.log("\n=== Шаг 1: A создаёт offer и отправляет через сигнальный сервер ===");
  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  await waitIceComplete(pcA);
  sockA.signal(idB, { t: "offer", n: "Артём", d: { type: pcA.localDescription.type, sdp: pcA.localDescription.sdp } });

  console.log("=== Шаг 2: ждём, пока data channel откроется на обеих сторонах ===");
  const deadline = Date.now() + 8000;
  while ((!dcAOpen || !dcBOpen) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check("Data channel открылся у A (offerer)", dcAOpen);
  check("Data channel открылся у B (answerer)", dcBOpen);
  check("pcA.connectionState === connected", pcA.connectionState === "connected");
  check("pcB.connectionState === connected", pcB.connectionState === "connected");

  console.log("\n=== Шаг 3: обмен настоящими сообщениями через P2P data channel ===");
  dcA.send(JSON.stringify({ kind: "chat", text: "Привет от Артёма", ts: Date.now() }));
  dcB.send(JSON.stringify({ kind: "chat", text: "Привет от Марии", ts: Date.now() }));
  await new Promise((r) => setTimeout(r, 300));

  check("B получил сообщение от A", receivedOnB.some((m) => m.text === "Привет от Артёма"));
  check("A получил сообщение от B", receivedOnA.some((m) => m.text === "Привет от Марии"));

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);

  pcA.close(); pcB.close();
  sockA.ws.close(); sockB.ws.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});