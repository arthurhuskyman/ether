// Проверяет конкретный найденный баг: endCall() убирал из pc только
// audio-сендеры (getSenders().filter(track.kind === "audio")), video
// оставался прикреплён с уже остановленным треком. При повторном
// enableVideo() на ТОМ ЖЕ PeerLink (переиспользуется, пока живо
// P2P-соединение — не пересоздаётся на каждый звонок) _videoAdded уже
// сброшен в false, addTrack добавил бы ВТОРОЙ video-сендер поверх
// непочищенного первого.

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
_ls.set("ether.myId", "aaaa");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "webrtc.js"), "utf8");
// eslint-disable-next-line no-eval
eval(src + "\nglobalThis.__PeerLink = PeerLink;");
const PeerLink = globalThis.__PeerLink;

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

function fakeVideoTrack() {
  const source = new wrtc.nonstandard.RTCVideoSource();
  return source.createTrack();
}
function fakeAudioTrack() {
  const source = new wrtc.nonstandard.RTCAudioSource();
  return source.createTrack();
}

(async () => {
  console.log("\n=== endCall() убирает И audio, И video сендеры (не только audio) ===");

  const link = new PeerLink({ id: "bbbb", localName: "A", role: "offerer" });

  // Имитируем состояние "звонок с видео уже шёл": добавляем оба трека
  // напрямую в pc, минуя enableVideo()/_ensureLocalVideo (не нужна
  // реальная камера для этой проверки — важно именно поведение
  // endCall() относительно уже существующих сендеров).
  const audioTrack = fakeAudioTrack();
  const videoTrack = fakeVideoTrack();
  const stream = new wrtc.MediaStream();
  link.pc.addTrack(audioTrack, stream);
  link.pc.addTrack(videoTrack, stream);
  link.localAudioTrack = audioTrack;
  link.localVideoTrack = videoTrack;
  link._audioAdded = true;
  link._videoAdded = true;

  const sendersBefore = link.pc.getSenders().filter((s) => s.track);
  check("до endCall() в pc два сендера с треками (audio+video)", sendersBefore.length === 2);

  link.endCall();

  const sendersAfter = link.pc.getSenders().filter((s) => s.track);
  console.log("  (диагностика) сендеров с треками после endCall():", sendersAfter.length,
    sendersAfter.map((s) => s.track && s.track.kind));
  check("после endCall() НЕ остаётся сендеров с прикреплённым треком (ни audio, ни video)", sendersAfter.length === 0);
  check("_videoAdded корректно сброшен", link._videoAdded === false);
  check("_audioAdded корректно сброшен", link._audioAdded === false);

  // Ключевая проверка бага: повторный enableVideo() на ТОМ ЖЕ pc не
  // должен создавать ВТОРОЙ video-сендер поверх незачищенного старого.
  console.log("\n=== Повторный enableVideo() на том же PeerLink не плодит второй video-сендер ===");
  link.localStream = null; // подготовка к тому, что _ensureLocalVideo создал бы заново
  const videoTrack2 = fakeVideoTrack();
  // Симулируем именно то, что делает enableVideo() после успешного
  // _ensureLocalVideo — вызываем ту же addTrack-логику напрямую, не
  // завязываясь на реальный доступ к камере в тестовом окружении.
  link.pc.addTrack(videoTrack2, new wrtc.MediaStream());
  link._videoAdded = true;
  link.localVideoTrack = videoTrack2;

  const videoSendersNow = link.pc.getSenders().filter((s) => s.track && s.track.kind === "video");
  check("ровно ОДИН video-сендер после повторного добавления (не два)", videoSendersNow.length === 1);

  link.close();
  console.log("\nИтого: " + pass + " прошло, " + fail + " упало");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("Ошибка теста:", e); process.exit(1); });
