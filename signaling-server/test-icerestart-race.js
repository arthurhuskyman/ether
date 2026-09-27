// Проверяет конкретный найденный баг (не через живой wrtc — слишком
// много неконтролируемых побочных эффектов от двух полноценных
// PeerLink, включая их собственные автоматические пересогласования —
// а через управляемый мок pc, где момент "встречного offer" можно
// выставить детерминированно, ровно в окно между
// setLocalDescription(offer) и резолвом waitForIceGathering).
//
// Сценарий: _negotiate(iceRestart=true) фиксирует offer,
// setLocalDescription переводит signalingState в "have-local-offer",
// дальше — await waitForIceGathering (растянутое окно). Если в это
// окно "приходит" встречный offer и _handleRemoteSdp (вежливая
// сторона) делает rollback + принимает чужой + создаёт СВОЙ answer —
// pc.localDescription/signalingState к моменту резолва
// waitForIceGathering уже не то, чем было. Раньше код читал SDP
// ПОСЛЕ await и слал this.pc.localDescription.sdp с меткой "offer" —
// то есть отправил бы answer, подписанный как offer.

const fs = require("fs");
const path = require("path");

global.window = global;
global.RTCPeerConnection = function () {}; // не используется напрямую в этом тесте
global.MediaStream = function () {};
global.crypto = global.crypto || require("crypto").webcrypto;
global.localStorage = { getItem: () => null, setItem: () => {} };

const src = fs.readFileSync(path.join(__dirname, "..", "js", "webrtc.js"), "utf8");
// eslint-disable-next-line no-eval
eval(src + "\nglobalThis.__PeerLink = PeerLink; globalThis.__waitForIceGathering = waitForIceGathering;");
const PeerLink = globalThis.__PeerLink;

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Мок RTCPeerConnection — минимум, нужный именно _negotiate/_handleRemoteSdp.
function makeMockPc() {
  const listeners = {};
  const pc = {
    signalingState: "stable",
    iceGatheringState: "gathering",
    localDescription: null,
    remoteDescription: null,
    addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    removeEventListener(ev, cb) {
      if (!listeners[ev]) return;
      listeners[ev] = listeners[ev].filter((c) => c !== cb);
    },
    async createOffer() {
      return { type: "offer", sdp: "OFFER-SDP-" + Math.random().toString(36).slice(2) };
    },
    async createAnswer() {
      return { type: "answer", sdp: "ANSWER-SDP-" + Math.random().toString(36).slice(2) };
    },
    async setLocalDescription(desc) {
      if (desc && desc.type === "rollback") {
        this.signalingState = "stable";
        this.localDescription = null;
        return;
      }
      this.localDescription = desc;
      this.signalingState = desc.type === "offer" ? "have-local-offer" : "stable";
    },
    async setRemoteDescription(desc) {
      this.remoteDescription = desc;
      this.signalingState = desc.type === "offer" ? "have-remote-offer" : "stable";
    },
    _fireGatheringComplete() {
      this.iceGatheringState = "complete";
      (listeners["icegatheringstatechange"] || []).forEach((cb) => cb());
    },
  };
  return pc;
}

(async () => {
  console.log("\n=== Гонка при ICE-restart: встречный offer прилетает ДО резолва waitForIceGathering ===");

  const pc = makeMockPc();
  const sent = [];
  const fake = Object.create(PeerLink.prototype);
  fake.id = "peer-under-test";
  fake.pc = pc;
  fake.dc = { readyState: "open" };
  fake._closed = false;
  fake._makingOffer = false;
  fake._pendingNegotiation = false;
  fake._polite = true; // именно вежливая сторона делает rollback при коллизии — тот случай, что нужно проверить
  fake._log = () => {};
  fake.send = (payload) => { sent.push(payload); return true; };

  // Запускаем ICE-restart, НЕ дожидаясь (промис повиснет на
  // waitForIceGathering, т.к. pc.iceGatheringState стартует как "gathering").
  const negotiatePromise = fake._negotiate(true);

  // Даём микрозадачам createOffer/setLocalDescription отработать.
  await sleep(20);
  check("после setLocalDescription(offer) signalingState стал have-local-offer", pc.signalingState === "have-local-offer");
  const offerThatWasSet = pc.localDescription.sdp;

  // Ровно в этом окне "приходит" встречный offer — вызываем
  // _handleRemoteSdp напрямую, как сделал бы обработчик входящих
  // сигнальных сообщений.
  await fake._handleRemoteSdp({ sdpType: "offer", sdp: "REMOTE-COLLISION-OFFER-SDP" });

  check("вежливая сторона откатила свой offer и приняла чужой (signalingState снова stable)", pc.signalingState === "stable");
  check("после коллизии localDescription — это ответ (answer), не исходный offer", pc.localDescription && pc.localDescription.type === "answer");

  // Теперь резолвим waitForIceGathering — ИМЕННО в этот момент раньше
  // код читал this.pc.localDescription.sdp и слал его с меткой "offer".
  pc._fireGatheringComplete();
  await negotiatePromise;

  console.log("  (диагностика) что реально отправлено через send():", JSON.stringify(sent));

  const sentOffers = sent.filter((p) => p.kind === "sdp" && p.sdpType === "offer");
  const sentAnswers = sent.filter((p) => p.kind === "sdp" && p.sdpType === "answer");
  check(
    "НИЧЕГО не отправлено с меткой offer, чей sdp на самом деле answer (тот самый баг)",
    sentOffers.every((p) => p.sdp !== pc.localDescription?.sdp || pc.localDescription?.type !== "answer") && !sentOffers.some((p) => p.sdp.startsWith("ANSWER-SDP-"))
  );
  check("конкретно: исходный offer НЕ был отправлен как есть после того, как стал неактуален", sentOffers.every((p) => p.sdp !== offerThatWasSet) || sentOffers.length === 0);
  // Уточнение по формулировке (был неоднозначный комментарий): _negotiate()
  // сама при коллизии молчит (offer не шлёт ни один) — но answer ВСЁ
  // РАВНО уходит, только другим путём (_handleRemoteSdp, вежливая
  // сторона после rollback+accept+createAnswer). Проверяем оба факта
  // раздельно и явно, а не одной обтекаемой формулировкой.
  check("_negotiate() сама не отправила ни одного offer'а при этой коллизии", sentOffers.length === 0);
  check("но answer от _handleRemoteSdp (коллизия) реально ушёл — молчит только offer-путь, не вся коммуникация", sentAnswers.length === 1 && sentAnswers[0].sdp === pc.localDescription.sdp);

  console.log("\n=== Контрольный случай: БЕЗ коллизии — offer уходит нормально ===");
  {
    const pc2 = makeMockPc();
    const sent2 = [];
    const fake2 = Object.create(PeerLink.prototype);
    fake2.id = "peer-no-collision";
    fake2.pc = pc2;
    fake2.dc = { readyState: "open" };
    fake2._closed = false;
    fake2._makingOffer = false;
    fake2._pendingNegotiation = false;
    fake2._polite = true;
    fake2._log = () => {};
    fake2.send = (payload) => { sent2.push(payload); return true; };

    const p2 = fake2._negotiate(true);
    await sleep(20);
    pc2._fireGatheringComplete();
    await p2;

    const offers2 = sent2.filter((p) => p.kind === "sdp" && p.sdpType === "offer");
    check("без коллизии offer реально отправлен", offers2.length === 1);
    check("и это ТОТ ЖЕ SDP, что был зафиксирован в pc.localDescription", offers2.length === 1 && offers2[0].sdp === pc2.localDescription.sdp);
  }

  console.log("\nИтого: " + pass + " прошло, " + fail + " упало");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("НЕПОЙМАННАЯ ОШИБКА:", e); process.exit(1); });
