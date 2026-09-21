// Проверяет реальный путь видеозвонка через настоящий data channel и
// настоящее WebRTC-согласование: enableVideo() добавляет видеотрек и
// запускает пересогласование (через тот же _negotiate(), что чинил
// glare для аудио), а другая сторона реально получает видеотрек через
// событие remote-track.
//
// В этой песочнице нет настоящей камеры, поэтому navigator.mediaDevices
// заменён на синтетический источник (wrtc.nonstandard.RTCVideoSource) —
// это не имитация логики приложения, а честная подмена только источника
// пикселей; сам enableVideo()/switchCamera() код выполняется как есть.

const fs = require("fs");
const path = require("path");
const wrtc = require("@roamhq/wrtc");
const { RTCVideoSource } = wrtc.nonstandard;

global.window = global;
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.MediaStream = wrtc.MediaStream;
global.crypto = global.crypto || require("crypto").webcrypto;

const _ls = new Map();
global.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
};

function fakeFrame(source) {
  const width = 160, height = 120;
  const data = new Uint8ClampedArray((width * height * 3) / 2).fill(128);
  source.onFrame({ width, height, data });
}
let fakeSourceCounter = 0;
Object.defineProperty(global, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        if (constraints && constraints.video) {
          fakeSourceCounter++;
          const source = new RTCVideoSource();
          const track = source.createTrack();
          fakeFrame(source);
          const interval = setInterval(() => fakeFrame(source), 100);
          track.addEventListener("ended", () => clearInterval(interval));
          return new wrtc.MediaStream([track]);
        }
        throw new Error("audio not needed in this test");
      },
    },
  },
});

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
  console.log("\n=== Видеозвонок: enableVideo() добавляет трек, другая сторона его получает ===");
  _ls.set("ether.myId", "caller01");
  const a = new PeerLink({ id: "callee01", localName: "A", role: "offerer" });
  _ls.set("ether.myId", "callee01");
  const b = new PeerLink({ id: "caller01", localName: "B", role: "answerer" });

  const offer = await a.createInitialOffer("");
  const answer = await b.acceptOfferAndCreateAnswer(offer);
  await a.acceptAnswer(answer);

  const deadline = Date.now() + 8000;
  while ((a.status !== "connected" || b.status !== "connected" || !a.dc || !b.dc) && Date.now() < deadline) await sleep(50);
  check("соединение установлено до включения видео", a.status === "connected" && b.status === "connected");

  let bReceivedVideoTrack = false;
  b.addEventListener("remote-track", (ev) => {
    if (ev.detail.track && ev.detail.track.kind === "video") bReceivedVideoTrack = true;
  });

  const ok = await a.enableVideo();
  check("enableVideo() вернул true (успех)", ok === true);
  check("localVideoTrack реально создан у стороны A", !!a.localVideoTrack);
  check("_videoAdded выставлен в true", a._videoAdded === true);

  const videoDeadline = Date.now() + 5000;
  while (!bReceivedVideoTrack && Date.now() < videoDeadline) await sleep(100);
  check("сторона B получила видеотрек через remote-track (реальное согласование, не заглушка)", bReceivedVideoTrack);

  check("после включения видео соединение осталось стабильным", a.pc.signalingState === "stable" && b.pc.signalingState === "stable");
  check("data channel не пострадал от пересогласования видео", a.status === "connected" && b.status === "connected");

  console.log("\n=== disableVideo() отключает трек, не разрывая звонок ===");
  a.disableVideo();
  check("трек выключен (enabled=false), а не удалён (звонок не перезапускается)", a.localVideoTrack && a.localVideoTrack.enabled === false);
  check("соединение по-прежнему стабильно", a.status === "connected" && b.status === "connected");

  a.close(); b.close();

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});
