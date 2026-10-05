// Аудио/видеозвонки: настоящие PeerLink между двумя окнами с реальным WebRTC
// (@roamhq/wrtc). Подменяются только источники пикселей и звука.
const test = require("node:test");
const assert = require("node:assert/strict");
const wrtc = require("@roamhq/wrtc");
const { createApp, bootApp, closeAll } = require("./harness");
test.after(closeAll);

const { RTCVideoSource, RTCAudioSource } = wrtc.nonstandard;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(40); } return false; }

const timers = [];
test.after(() => {
  for (const t of timers.splice(0)) clearInterval(t);
  // Нативные потоки wrtc не дают процессу завершиться сами — выходим после того, как отчёт теста уже сброшен.
  setTimeout(() => process.exit(process.exitCode || 0), 1500);
});
function installMedia(a, log) {
  const frame = (src) => { const w = 64, h = 48; src.onFrame({ width: w, height: h, data: new Uint8ClampedArray((w * h * 3) / 2).fill(100) }); };
  const mkVideo = (facing, label) => {
    const src = new RTCVideoSource(); const track = src.createTrack(); frame(src);
    const iv = setInterval(() => frame(src), 100); timers.push(iv);
    track.addEventListener("ended", () => clearInterval(iv));
    Object.defineProperty(track, "getSettings", { value: () => ({ facingMode: facing }), configurable: true });
    track.__label = label; log.push(label);
    return { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
  };
  const mkAudio = () => {
    const src = new RTCAudioSource(); const track = src.createTrack();
    const iv = setInterval(() => src.onData({ samples: new Int16Array(160), sampleRate: 16000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 160 }), 10); timers.push(iv);
    track.addEventListener("ended", () => clearInterval(iv));
    return new wrtc.MediaStream([track]);
  };
  Object.defineProperty(a.window.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (c) => {
        if (a.window.__denyMedia) { const e = new Error("denied"); e.name = "NotAllowedError"; throw e; }
        if (c && c.video) return mkVideo(c.video.facingMode || "user", "camera:" + (c.video.facingMode || "user"));
        if (c && c.audio) return mkAudio();
        throw new Error("no constraints");
      },
      getDisplayMedia: async () => mkVideo("screen", "screen"),
      enumerateDevices: async () => [],
    },
  });
}

async function pair() {
  const a = createApp(), b = createApp();
  await Promise.all([a.ready, b.ready]);
  const la = [], lb = [];
  installMedia(a, la); installMedia(b, lb);
  a.window.localStorage.setItem("ether.myId", "caller01"); b.window.localStorage.setItem("ether.myId", "callee01");
  const A = a.run(`new PeerLink({ id: "callee01", localName: "A", role: "offerer" })`);
  const B = b.run(`new PeerLink({ id: "caller01", localName: "B", role: "answerer" })`);
  const offer = await A.createInitialOffer("");
  const answer = await B.acceptOfferAndCreateAnswer(offer);
  await A.acceptAnswer(answer);
  assert.ok(await until(() => A.status === "connected" && B.status === "connected" && A.dc && B.dc), "P2P должен подняться");
  const events = { A: [], B: [] };
  for (const [n, l] of [["A", A], ["B", B]]) {
    l.addEventListener("remote-track", (ev) => events[n].push(ev.detail.track.kind));
    l.addEventListener("app-message", (ev) => { if (ev.detail && ev.detail.kind === "call-state") events[n].push("cs:" + ev.detail.state); });
  }
  return { a, b, A, B, events, la, lb, close() { try { A.close(); B.close(); } catch (e) {} } };
}

test("аудиозвонок: ringing → accepted → ended между двумя клиентами", async () => {
  const p = await pair();
  await p.A.startCall(false);
  assert.ok(await until(() => p.events.B.includes("cs:ringing")));
  assert.ok(await until(() => p.events.B.includes("audio")), "B должен получить аудиотрек A");
  assert.equal(p.A.status, "in-call");
  await p.B.answerCall(false);
  assert.ok(await until(() => p.events.A.includes("cs:accepted")));
  assert.ok(await until(() => p.events.A.includes("audio")));
  p.A.endCall();
  assert.ok(await until(() => p.events.B.includes("cs:ended")));
  assert.equal(p.A.status, "connected");
  assert.equal(p.A.localAudioTrack, null);
  p.close();
});

test("видеозвонок с самого начала: видеотрек доходит, камера на месте", async () => {
  const p = await pair();
  await p.A.startCall(true);
  assert.ok(await until(() => p.events.B.includes("video")), "B должен получить видео");
  assert.ok(p.A.localVideoTrack);
  assert.ok(p.A.localStream.getVideoTracks().includes(p.A.localVideoTrack));
  await p.B.answerCall(true);
  assert.ok(await until(() => p.events.A.includes("video")), "A должен получить видео B");
  p.close();
});

test("включение, выключение и повторное включение камеры посреди аудиозвонка", async () => {
  const p = await pair();
  await p.A.startCall(false); await p.B.answerCall(false);
  assert.equal(await p.A.enableVideo(), true);
  assert.ok(await until(() => p.events.B.includes("video")));
  p.A.disableVideo();
  assert.equal(p.A.localVideoTrack.enabled, false);
  const trackBefore = p.A.localVideoTrack;
  assert.equal(await p.A.enableVideo(), true);
  assert.equal(p.A.localVideoTrack, trackBefore, "повторное включение переиспользует трек, без нового getUserMedia");
  assert.equal(p.A.localVideoTrack.enabled, true);
  assert.equal(p.la.filter((l) => l.startsWith("camera")).length, 1);
  assert.ok(await until(() => p.A.pc.signalingState === "stable"));
  p.close();
});

test("после завершения видеозвонка и нового звонка на том же линке нет второго video-сендера", async () => {
  const p = await pair();
  await p.A.startCall(true); await p.B.answerCall(false);
  assert.ok(await until(() => p.events.B.includes("video")));
  p.A.endCall();
  assert.equal(p.A.localVideoTrack, null);
  await sleep(300);
  await p.A.startCall(true);
  const videoSenders = p.A.pc.getSenders().filter((s) => s.track && s.track.kind === "video");
  assert.equal(videoSenders.length, 1);
  assert.equal(p.A.pc.getTransceivers().filter((t) => t.sender.track && t.sender.track.kind === "video").length, 1);
  p.close();
});

test("переключение камеры: фронтальная ↔ тыловая, localStream обновляется", async () => {
  const p = await pair();
  await p.A.startCall(true);
  const first = p.A.localVideoTrack;
  assert.equal(first.getSettings().facingMode, "user");
  await p.A.switchCamera();
  assert.notEqual(p.A.localVideoTrack, first);
  assert.equal(p.A.localVideoTrack.getSettings().facingMode, "environment");
  assert.deepEqual(p.A.localStream.getVideoTracks(), [p.A.localVideoTrack]);
  assert.equal(first.readyState, "ended", "старая камера остановлена");
  await p.A.switchCamera();
  assert.equal(p.A.localVideoTrack.getSettings().facingMode, "user");
  p.close();
});

test("switchCamera: если браузер не отдаёт facingMode в getSettings, режим всё равно чередуется", async () => {
  const p = await pair();
  await p.A.startCall(true);
  p.a.window.__noFacing = true;
  const modes = [];
  const orig = p.a.window.navigator.mediaDevices.getUserMedia;
  p.a.window.navigator.mediaDevices.getUserMedia = async (c) => {
    const st = await orig(c);
    if (c.video) { modes.push(c.video.facingMode); const t = st.getVideoTracks()[0]; Object.defineProperty(t, "getSettings", { value: () => ({}), configurable: true }); }
    return st;
  };
  Object.defineProperty(p.A.localVideoTrack, "getSettings", { value: () => ({}), configurable: true });
  await p.A.switchCamera(); await p.A.switchCamera(); await p.A.switchCamera();
  assert.deepEqual(modes, ["environment", "user", "environment"]);
  p.close();
});

test("switchCamera без видео — no-op; switchCamera при отказе getUserMedia сохраняет текущую камеру", async () => {
  const p = await pair();
  await p.A.switchCamera(); // нет localVideoTrack
  await p.A.startCall(true);
  const cur = p.A.localVideoTrack;
  p.a.window.__denyMedia = true;
  await p.A.switchCamera();
  assert.equal(p.A.localVideoTrack, cur);
  assert.equal(cur.readyState, "live");
  p.close();
});

test("отказ в доступе к камере: enableVideo → false, состояние чистое, можно повторить", async () => {
  const p = await pair();
  await p.A.startCall(false);
  p.a.window.__denyMedia = true;
  assert.equal(await p.A.enableVideo(), false);
  assert.equal(p.A._videoAdded, false);
  assert.equal(p.A.localVideoTrack, null);
  p.a.window.__denyMedia = false;
  assert.equal(await p.A.enableVideo(), true);
  p.close();
});

test("показ экрана поверх камеры: собеседник получает экран, потом камера возвращается", async () => {
  const p = await pair();
  await p.A.startCall(true); await p.B.answerCall(false);
  const cam = p.A.localVideoTrack;
  assert.equal(await p.A.startScreenShare(), true);
  assert.equal(p.A.localVideoTrack.__label, "screen");
  assert.deepEqual(p.A.localStream.getVideoTracks(), [p.A.localVideoTrack], "превью показывает экран");
  assert.equal(cam.readyState, "live", "камера не останавливается на время показа");
  await p.A.stopScreenShare();
  assert.equal(p.A.localVideoTrack, cam);
  assert.deepEqual(p.A.localStream.getVideoTracks(), [cam]);
  p.close();
});

test("показ экрана без камеры: трек добавляется и убирается, звонок жив", async () => {
  const p = await pair();
  await p.A.startCall(false); await p.B.answerCall(false);
  assert.equal(await p.A.startScreenShare(), true);
  assert.ok(await until(() => p.events.B.includes("video")));
  await p.A.stopScreenShare();
  assert.equal(p.A._videoAdded, false);
  assert.equal(p.A.localVideoTrack, null);
  assert.equal(p.A.status, "in-call");
  p.close();
});

test("БАГ: switchCamera во время показа экрана не должен ломать показ", async () => {
  const p = await pair();
  await p.A.startCall(true); await p.B.answerCall(false);
  const cam = p.A.localVideoTrack;
  await p.A.startScreenShare();
  const screen = p.A.localVideoTrack;
  await p.A.switchCamera();
  assert.equal(p.A.localVideoTrack, screen, "во время показа экрана flip камеры ничего не меняет");
  assert.equal(screen.readyState, "live", "трек экрана не должен быть остановлен");
  await p.A.stopScreenShare();
  assert.equal(p.A.localVideoTrack, cam);
  assert.equal(cam.readyState, "live");
  p.close();
});

test("завершение звонка во время показа экрана останавливает и экран, и камеру", async () => {
  const p = await pair();
  await p.A.startCall(true);
  const cam = p.A.localVideoTrack;
  await p.A.startScreenShare();
  const screen = p.A.localVideoTrack;
  p.A.endCall();
  assert.equal(screen.readyState, "ended");
  assert.equal(cam.readyState, "ended");
  assert.equal(p.A._screenSharing, false);
  p.close();
});

test("одновременное включение видео с обеих сторон (glare) заканчивается stable и видео у обоих", async () => {
  const p = await pair();
  await p.A.startCall(false); await p.B.answerCall(false);
  await Promise.all([p.A.enableVideo(), p.B.enableVideo()]);
  assert.ok(await until(() => p.events.A.includes("video") && p.events.B.includes("video"), 10000));
  assert.ok(await until(() => p.A.pc.signalingState === "stable" && p.B.pc.signalingState === "stable"));
  p.close();
});

test("отклонение звонка и занято: declineCall доходит до звонящего", async () => {
  const p = await pair();
  await p.A.startCall(true);
  p.B.declineCall("busy");
  assert.ok(await until(() => p.events.A.includes("cs:declined")));
  p.close();
});

test("mute: отключает аудиотрек и снимает его при endCall", async () => {
  const p = await pair();
  await p.A.startCall(false);
  p.A.setMuted(true);
  assert.equal(p.A.localAudioTrack.enabled, false);
  p.A.setMuted(false);
  assert.equal(p.A.localAudioTrack.enabled, true);
  p.A.setMuted(true); p.A.endCall();
  assert.equal(p.A._muteRecheckTimer, null);
  p.close();
});
