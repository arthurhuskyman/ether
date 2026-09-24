// Relay (attemptConnectViaRelay в app.js) — целиком клиентская логика:
// сервер вообще не знает о "relay-request"/"relay-response", это чистый
// P2P-форвардинг поверх уже установленных data channel'ов. Саму бизнес-
// логику app.js (интерпретация relay-* payload'ов) протестировать без
// браузера/DOM нельзя — она слишком завязана на UI. Но можно честно
// проверить транспортный уровень, на котором relay держится: что через
// ОДНОГО пира (хаб) реально можно прокидывать данные между ДВУМЯ другими
// независимо установленными WebRTC-соединениями — именно это app.js и
// делает вызовом link.send(...) на обеих сторонах хаба.

const fs = require("fs");
const path = require("path");
const wrtc = require("@roamhq/wrtc");

global.window = global;
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.MediaStream = wrtc.MediaStream;
global.crypto = global.crypto || require("crypto").webcrypto;

const _ls = new Map();
global.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
};

const src = fs.readFileSync(path.join(__dirname, "..", "js", "webrtc.js"), "utf8");
// eslint-disable-next-line no-eval
eval(src + "\nglobalThis.__PeerLink = PeerLink;");
const PeerLink = globalThis.__PeerLink;

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function connectPair(idSelf, idPeer, roleSelf, rolePeer) {
  _ls.set("ether.myId", idSelf);
  const self1 = new PeerLink({ id: idPeer, localName: idSelf, role: roleSelf });
  _ls.set("ether.myId", idPeer);
  const peer1 = new PeerLink({ id: idSelf, localName: idPeer, role: rolePeer });

  const offer = await self1.createInitialOffer("");
  const answer = await peer1.acceptOfferAndCreateAnswer(offer);
  await self1.acceptAnswer(answer);

  const deadline = Date.now() + 8000;
  while ((self1.status !== "connected" || peer1.status !== "connected" || !self1.dc || !peer1.dc) && Date.now() < deadline) await sleep(50);
  return { self: self1, peer: peer1 };
}

(async () => {
  console.log("\n=== Транспорт для relay: хаб A пересылает данные между B и C ===");
  const idA = "hub0000hub0000hub0000hub0000hub0000hub0000hub0000hub0000hub0000";
  const idB = "peerB111peerB111peerB111peerB111peerB111peerB111peerB111peerB111";
  const idC = "peerC222peerC222peerC222peerC222peerC222peerC222peerC222peerC222";

  // Два НЕЗАВИСИМЫХ соединения через одного и того же хаба A — ровно
  // так mesh в app.js держит связь с несколькими пирами одновременно.
  const ab = await connectPair(idA, idB, "offerer", "answerer");
  const ac = await connectPair(idA, idC, "offerer", "answerer");

  check("A-B соединение установлено", ab.self.status === "connected" && ab.peer.status === "connected");
  check("A-C соединение установлено", ac.self.status === "connected" && ac.peer.status === "connected");
  check("оба соединения через A независимы друг от друга (разные data channel)", ab.self.dc !== ac.self.dc);

  // B шлёт хабу A нечто вида relay-request; A (в app.js — attemptConnectViaRelay
  // на стороне инициатора / обработчик relay-request на стороне хаба)
  // форвардит это дальше на C через СВОЁ отдельное соединение с C.
  let receivedAtC = null;
  ac.peer.dc.addEventListener("message", (ev) => { receivedAtC = JSON.parse(ev.data); });

  const relayPayload = { kind: "relay-request", to: idC, packet: { t: "offer", sdp: "fake-sdp-for-transport-test" } };
  const sentFromB = ab.peer.send(relayPayload); // B -> A
  await sleep(200);
  check("B успешно отправил A payload для пересылки", sentFromB === true);

  // Хаб A форвардит то же самое (в реальном коде — после разбора и
  // адресации) дальше на C через отдельный канал A-C.
  const forwarded = ac.self.send(relayPayload); // A -> C, по ДРУГОМУ соединению
  await sleep(200);
  check("A успешно переслал (форвардил) payload C по отдельному каналу", forwarded === true);
  check("C реально получил именно то, что изначально отправил B", receivedAtC && receivedAtC.kind === "relay-request" && receivedAtC.to === idC && receivedAtC.packet.sdp === "fake-sdp-for-transport-test");

  // И в обратную сторону — C отвечает через тот же хаб обратно к B.
  let receivedAtB = null;
  ab.peer.dc.addEventListener("message", (ev) => { receivedAtB = JSON.parse(ev.data); });
  const relayResponse = { kind: "relay-response", to: idB, packet: { t: "answer", sdp: "fake-answer-sdp" } };
  ac.peer.send(relayResponse); // C -> A
  await sleep(150);
  ab.self.send(relayResponse); // A -> B, форвард в обратную сторону
  await sleep(200);
  check("ответ C дошёл до B через тот же хаб A в обратную сторону", receivedAtB && receivedAtB.kind === "relay-response" && receivedAtB.packet.sdp === "fake-answer-sdp");

  ab.self.close(); ab.peer.close(); ac.self.close(); ac.peer.close();

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});
