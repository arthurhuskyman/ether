// Проверяет два конкретных бага в пересогласовании SDP (добавление
// аудио к уже установленному P2P-соединению — то, что происходит при
// приёме/начале звонка):
//
// 1. Трек добавили (negotiationneeded сработал) ДО того, как открылся
//    data channel — раньше пересогласование в этом случае терялось
//    навсегда (событие negotiationneeded одноразовое, повтора не было).
// 2. Обе стороны почти одновременно инициируют пересогласование —
//    раньше это било по InvalidStateError без всякой защиты (glare).

const fs = require("fs");
const path = require("path");
const wrtc = require("@roamhq/wrtc");

global.window = global;
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.MediaStream = wrtc.MediaStream;
global.crypto = global.crypto || require("crypto").webcrypto;

// localStorage-заглушка: getMyId()/сам webrtc.js читают её напрямую.
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

// Соединяет два PeerLink напрямую (без сервера/relay — прямой обмен
// offer/answer функциями, как в test-e2e-webrtc.js), возвращает, когда
// у обоих открыт data channel.
async function connectPair(idA, idB) {
  _ls.set("ether.myId", idA);
  const a = new PeerLink({ id: idB, localName: "A", role: "offerer" });
  _ls.set("ether.myId", idB);
  const b = new PeerLink({ id: idA, localName: "B", role: "answerer" });

  const offer = await a.createInitialOffer("");
  const answer = await b.acceptOfferAndCreateAnswer(offer);
  await a.acceptAnswer(answer);

  const deadline = Date.now() + 8000;
  while ((a.status !== "connected" || b.status !== "connected") && Date.now() < deadline) await sleep(50);
  return { a, b };
}

(async () => {
  console.log("\n=== Сценарий 1: пересогласование запросили ДО открытия data channel ===");
  {
    _ls.set("ether.myId", "aaaa");
    const a = new PeerLink({ id: "bbbb", localName: "A", role: "offerer" });
    _ls.set("ether.myId", "bbbb");
    const b = new PeerLink({ id: "aaaa", localName: "B", role: "answerer" });

    const offer = await a.createInitialOffer("");

    // Сразу после создания offer (до открытия dc) просим пересогласовать —
    // именно так раньше терялось добавление аудио, если пользователь
    // успевал нажать "Ответить"/начать звонок раньше, чем канал открылся.
    a.pc.addTransceiver("audio", { direction: "sendrecv" }); // сам negotiationneeded сработает асинхронно
    await sleep(20);
    check("dc ещё не открыт в момент попытки пересогласования (иначе тест не проверяет нужный сценарий)", a.dc.readyState !== "open");
    check("запрос помечен как отложенный, а не потерян", a._negotiationPendingOnOpen === true);

    const answer = await b.acceptOfferAndCreateAnswer(offer);
    await a.acceptAnswer(answer);

    let sdpReachedB = false;
    const origHandle = b._handleRemoteSdp.bind(b);
    b._handleRemoteSdp = async (payload) => { if (payload.sdpType === "offer" && payload.sdp.includes("m=audio")) sdpReachedB = true; return origHandle(payload); };

    const deadline = Date.now() + 8000;
    while (a.status !== "connected" && Date.now() < deadline) await sleep(50);
    await sleep(1500); // дать время повторному пересогласованию долететь

    check("отложенное пересогласование само отправилось после открытия dc", sdpReachedB);
    a.close(); b.close();
  }

  console.log("\n=== Сценарий 2: обе стороны одновременно инициируют пересогласование (glare) ===");
  {
    const { a, b } = await connectPair("cccc", "dddd"); // cccc < dddd → a вежливая, b невежливая
    check("соединение установлено для теста glare", a.status === "connected" && b.status === "connected");

    let aGotAnswer = false, bGotAnswer = false;
    const origA = a._handleRemoteSdp.bind(a);
    a._handleRemoteSdp = async (p) => { if (p.sdpType === "answer") aGotAnswer = true; return origA(p); };
    const origB = b._handleRemoteSdp.bind(b);
    b._handleRemoteSdp = async (p) => { if (p.sdpType === "answer") bGotAnswer = true; return origB(p); };

    // Обе стороны триггерят negotiationneeded практически одновременно.
    a.pc.addTransceiver("audio", { direction: "sendrecv" });
    b.pc.addTransceiver("audio", { direction: "sendrecv" });

    await sleep(3000);

    check("после столкновения обе стороны пришли к стабильному состоянию (нет зависшего offer)",
      a.pc.signalingState === "stable" && b.pc.signalingState === "stable");
    check("согласование реально завершилось (кто-то получил answer), а не просто не упало",
      aGotAnswer || bGotAnswer);
    check("оба PeerLink остались подключены, не развалились из-за ошибки", a.status !== "disconnected" && b.status !== "disconnected");

    a.close(); b.close();
  }

  console.log("\n=== Сценарий 3: reInvite() во время уже идущего пересогласования (добавление аудио) ===");
  {
    const { a, b } = await connectPair("eeee", "ffff");
    check("соединение установлено для теста reInvite-гонки", a.status === "connected" && b.status === "connected");

    let bGotOffer = false;
    const origB = b._handleRemoteSdp.bind(b);
    b._handleRemoteSdp = async (p) => { if (p.sdpType === "offer") bGotOffer = true; return origB(p); };

    // Запускаем обычное пересогласование (как при добавлении аудио) И
    // reInvite() (как при кратковременном ICE-сбое) почти одновременно —
    // раньше это было именно то столкновение, что рвало соединение
    // прямо во время звонка.
    a.pc.addTransceiver("audio", { direction: "sendrecv" }); // триггерит _renegotiateOverDataChannel через negotiationneeded
    const reInvitePromise = a.reInvite(); // и сразу же — второй, независимый путь пересогласования

    await reInvitePromise;
    await sleep(2500);

    check("после конфликта signalingState стабилен, а не завис в half-negotiated", a.pc.signalingState === "stable" && b.pc.signalingState === "stable");
    check("offer реально дошёл до второй стороны, согласование не потерялось", bGotOffer);
    check("оба конца остались подключены — соединение не развалилось из-за гонки", a.status !== "disconnected" && b.status !== "disconnected");

    a.close(); b.close();
  }

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});
