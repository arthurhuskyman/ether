// Проверяет конкретный найденный баг: если send() offer'а во время
// пересогласования проваливается, PeerLink обязан откатить
// setLocalDescription (rollback), иначе signalingState навсегда
// застревает в "have-local-offer" и следующий _negotiate() вечно уходит
// в retry-таймер каждые 300-500мс, ничего не делая.

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

(async () => {
  console.log("\n=== Неудачная отправка offer при пересогласовании: откат, а не вечный застой ===");
  _ls.set("ether.myId", "sender01");
  const a = new PeerLink({ id: "recv01", localName: "A", role: "offerer" });
  _ls.set("ether.myId", "recv01");
  const b = new PeerLink({ id: "sender01", localName: "B", role: "answerer" });

  const offer = await a.createInitialOffer("");
  const answer = await b.acceptOfferAndCreateAnswer(offer);
  await a.acceptAnswer(answer);

  const deadline = Date.now() + 8000;
  while ((a.status !== "connected" || b.status !== "connected" || !a.dc || !b.dc) && Date.now() < deadline) await sleep(50);
  check("соединение установлено", a.status === "connected" && b.status === "connected");
  check("исходное состояние — stable", a.pc.signalingState === "stable");

  // Ломаем send() ИМЕННО на стороне A, имитируя ситуацию из отчёта — offer
  // создаётся успешно, но уйти по каналу не может.
  let sendCalls = 0;
  const originalSend = a.send.bind(a);
  a.send = function (payload) {
    if (payload && payload.kind === "sdp" && payload.sdpType === "offer") { sendCalls++; return false; }
    return originalSend(payload);
  };

  await a._negotiate(false);
  check("send() offer'а был вызван и вернул false (имитация проблемы)", sendCalls === 1);
  check("signalingState ОТКАЧЕН обратно в stable, а не застрял на have-local-offer", a.pc.signalingState === "stable");

  // Возвращаем настоящий send и ждём retry-таймер (500мс) — вторая попытка
  // должна реально дойти до создания offer заново, а не тихо сидеть в
  // "не время" из-за некорректного signalingState.
  a.send = originalSend;
  await sleep(700);
  check("после восстановления send() и срабатывания retry — пересогласование завершилось успешно (не застряло)", a.pc.signalingState === "stable" && a._pendingNegotiation === false);

  a.close(); b.close();

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});
