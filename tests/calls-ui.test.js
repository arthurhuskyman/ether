// Интерфейс звонков и видео в приложении (iOS/Android/десктоп): экран звонка, кнопки,
// входящие/исходящие, удалённое и локальное видео. PeerLink подменён лёгким двойником,
// сам код app.js (beginCall, wireCallScreen, remote-track и т.д.) исполняется как есть.
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function installFakeLink(a, id = "alice", opts = {}) {
  a.run(`ensureContactEntry("${id}", "Alice");`);
  a.window.__calls = [];
  a.run(`(() => {
    const calls = window.__calls;
    const l = new EventTarget();
    Object.assign(l, { id: "${id}", status: "connected", localVideoTrack: null, _screenSharing: false, _videoAdded: false,
      startCall: async (v) => { calls.push("startCall:" + !!v); if (v) { l.localVideoTrack = { kind: "video", enabled: true, getSettings: () => ({ facingMode: "user" }) }; l.localStream = { id: "ls" }; } l.status = "in-call"; },
      answerCall: async (v) => { calls.push("answerCall:" + !!v); if (v) { l.localVideoTrack = { kind: "video" }; l.localStream = { id: "ls" }; } l.status = "in-call"; },
      declineCall: (r) => calls.push("decline:" + (r || "")),
      endCall: () => { calls.push("endCall"); l.localVideoTrack = null; l._screenSharing = false; l.status = "connected"; },
      enableVideo: async () => { calls.push("enableVideo"); if (${opts.cameraFails ? "true" : "false"}) return false; l.localVideoTrack = { kind: "video", enabled: true }; l.localStream = { id: "ls" }; l._videoAdded = true; return true; },
      disableVideo: () => calls.push("disableVideo"),
      switchCamera: async () => calls.push("switchCamera"),
      startScreenShare: async () => { calls.push("startScreenShare"); l._screenSharing = true; return true; },
      stopScreenShare: async () => { calls.push("stopScreenShare"); l._screenSharing = false; },
      setMuted: (m) => calls.push("mute:" + m), setRemoteVolume: () => {}, send: () => true, close() {} });
    mesh.links.set("${id}", l);
    window.__link = l;
  })()`);
  return a.window.__link;
}
function fakeStream(a, withVideo = true) {
  const mk = (kind) => { const t = new a.window.EventTarget(); Object.assign(t, { kind, readyState: "live", muted: false }); return t; };
  const audio = mk("audio"), video = withVideo ? mk("video") : null;
  const stream = { id: "rs", getVideoTracks: () => (video ? [video] : []), getAudioTracks: () => [audio], getTracks: () => [audio, video].filter(Boolean) };
  return { stream, audio, video };
}
const remoteTrack = (a, id, stream, track) => a.run(`mesh.dispatchEvent(new CustomEvent("remote-track", { detail: { id: "${id}", stream: window.__st, track: window.__tr } }))`, (a.window.__st = stream, a.window.__tr = track));
const sh = (a, sel) => !a.document.querySelector(sel).classList.contains("hidden");

for (const platform of ["desktop", "ios", "android"]) {
  test(`[${platform}] исходящий видеозвонок: экран звонка, startCall(true), локальное превью`, async () => {
    const a = await bootApp({ platform });
    const link = installFakeLink(a);
    a.run(`wireCallScreen && 0; state.callId = null;`);
    await a.run(`beginCall("alice", true)`);
    assert.deepEqual(a.window.__calls, ["startCall:true"]);
    assert.equal(a.run(`state.callId`), "alice");
    assert.equal(a.run(`state.callWantsVideo`), true);
    assert.ok(sh(a, "#call-screen"));
    if (platform === "desktop") {
      assert.ok(a.document.querySelector("#call-flip-overlay-btn").classList.contains("hidden"), "на десктопе «задняя камера» не показываем");
    } else {
      assert.ok(sh(a, "#call-video-overlays"), "на телефоне оверлей с переключением камеры виден");
      assert.ok(sh(a, "#call-flip-overlay-btn"));
      assert.ok(a.document.querySelector("#call-pip-overlay-btn").classList.contains("hidden"), "на телефоне «картинка в картинке» не показываем");
    }
    assert.ok(a.document.querySelector("#call-video-btn").classList.contains("active"));
    a.close();
  });

  test(`[${platform}] аудиозвонок → включение камеры → выключение → выключение показа`, async () => {
    const a = await bootApp({ platform });
    const link = installFakeLink(a);
    await a.run(`beginCall("alice", false)`);
    assert.deepEqual(a.window.__calls, ["startCall:false"]);
    assert.ok(!sh(a, "#call-video-overlays"));
    a.document.querySelector("#call-video-btn").click(); await tick(30);
    assert.ok(a.window.__calls.includes("enableVideo"));
    assert.ok(a.document.querySelector("#call-video-btn").classList.contains("active"));
    a.document.querySelector("#call-video-btn").click(); await tick(30);
    assert.ok(a.window.__calls.includes("disableVideo"));
    assert.ok(!a.document.querySelector("#call-video-btn").classList.contains("active"));
    // включили снова и выключили во время показа экрана — показ должен остановиться целиком
    a.document.querySelector("#call-video-btn").click(); await tick(30);
    link._screenSharing = true;
    a.document.querySelector("#call-video-btn").click(); await tick(30);
    assert.ok(a.window.__calls.includes("stopScreenShare"));
    a.close();
  });

  test(`[${platform}] камера недоступна: тост и кнопка не активируется`, async () => {
    const a = await bootApp({ platform });
    installFakeLink(a, "alice", { cameraFails: true });
    await a.run(`beginCall("alice", false)`);
    a.document.querySelector("#call-video-btn").click(); await tick(30);
    assert.ok(!a.document.querySelector("#call-video-btn").classList.contains("active"));
    assert.ok(a.document.querySelector("#toast").textContent.length > 0);
    a.close();
  });

  test(`[${platform}] flip камеры вызывает switchCamera`, async () => {
    const a = await bootApp({ platform });
    installFakeLink(a);
    await a.run(`beginCall("alice", true)`);
    a.document.querySelector("#call-flip-overlay-btn").click(); await tick(10);
    assert.ok(a.window.__calls.includes("switchCamera"));
    a.close();
  });

  test(`[${platform}] кнопка демонстрации экрана: ${platform === "desktop" ? "видна и работает" : "скрыта (нет getDisplayMedia)"}`, async () => {
    const a = await bootApp({ platform });
    installFakeLink(a);
    await a.run(`beginCall("alice", false)`);
    const btn = a.document.querySelector("#call-screenshare-btn");
    if (platform === "desktop") {
      assert.ok(!btn.classList.contains("hidden"));
      btn.click(); await tick(30);
      assert.ok(a.window.__calls.includes("startScreenShare"));
      assert.ok(btn.classList.contains("active"));
      btn.click(); await tick(30);
      assert.ok(a.window.__calls.includes("stopScreenShare"));
    } else {
      assert.ok(btn.classList.contains("hidden"));
    }
    a.close();
  });

  test(`[${platform}] входящий видеозвонок: ringing → принять; отклонить; занято`, async () => {
    const a = await bootApp({ platform });
    const link = installFakeLink(a);
    const msg = (payload) => { a.window.__pl = payload; a.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "alice", payload: window.__pl } }))`); };
    msg({ kind: "call-state", state: "ringing", video: true, ts: Date.now() });
    assert.equal(a.run(`state.callId`), "alice");
    assert.equal(a.run(`state.callPhase`), "ringing");
    assert.equal(a.run(`state.callWantsVideo`), true);
    assert.ok(sh(a, "#call-controls-incoming"));
    // второй звонок от другого контакта, пока идёт этот → «занято»
    a.run(`ensureContactEntry("bob", "Bob")`);
    a.run(`mesh.links.set("bob", Object.assign(new EventTarget(), { id: "bob", declineCall: (r) => window.__calls.push("bob-decline:" + r), status: "connected" }))`);
    a.window.__pl = { kind: "call-state", state: "ringing", ts: Date.now() };
    a.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "bob", payload: window.__pl } }))`);
    assert.ok(a.window.__calls.includes("bob-decline:busy"));
    // принять
    a.document.querySelector("#call-accept-btn").click(); await tick(50);
    assert.ok(a.window.__calls.some((c) => c.startsWith("answerCall")));
    a.close();
  });

  test(`[${platform}] входящий: отклонение, устаревший ringing игнорируется, завершение собеседником`, async () => {
    const a = await bootApp({ platform });
    installFakeLink(a);
    const msg = (payload) => { a.window.__pl = payload; a.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "alice", payload: window.__pl } }))`); };
    msg({ kind: "call-state", state: "ringing", ts: Date.now() - 60000 });
    assert.equal(a.run(`state.callId`), null, "рингтон из буфера iOS-пуша не играем");
    msg({ kind: "call-state", state: "ringing", ts: Date.now() });
    a.document.querySelector("#call-decline-btn").click(); await tick(20);
    assert.ok(a.window.__calls.some((c) => c.startsWith("decline")));
    assert.equal(a.run(`state.callId`), null);
    a.close();

    const b = await bootApp({ platform });
    installFakeLink(b);
    const m2 = (payload) => { b.window.__pl = payload; b.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "alice", payload: window.__pl } }))`); };
    await b.run(`beginCall("alice", false)`);
    m2({ kind: "call-state", state: "accepted", ts: Date.now() });
    assert.equal(b.run(`state.callPhase`), "active");
    m2({ kind: "call-state", state: "ended", ts: Date.now() });
    assert.equal(b.run(`state.callId`), null);
    b.close();
  });

  test(`[${platform}] удалённое видео: буферизуется до ответа, потом показывается; mute/unmute/ended`, async () => {
    const a = await bootApp({ platform });
    installFakeLink(a);
    await a.run(`beginCall("alice", false)`);
    const { stream, audio, video } = fakeStream(a);
    remoteTrack(a, "alice", stream, video);
    assert.ok(!sh(a, "#call-remote-video"), "до принятия видео не показываем");
    a.run(`setCallPhaseActive()`);
    assert.ok(sh(a, "#call-remote-video"));
    assert.ok(a.document.querySelector("#call-screen").classList.contains("video-active"));
    assert.ok(a.document.querySelector("#call-flip-overlay-btn").classList.contains("hidden"), "своей камеры нет — flip скрыт");
    assert.ok(!sh(a, "#call-video-overlays"), "нет применимых кнопок (на телефоне нет PiP, на десктопе нет «задней камеры») — оверлей не показываем");
    // собеседник убрал видео → не оставляем замороженный кадр
    video.dispatchEvent(new a.window.Event("mute"));
    assert.ok(!sh(a, "#call-remote-video"));
    assert.ok(!a.document.querySelector("#call-screen").classList.contains("video-active"));
    video.dispatchEvent(new a.window.Event("unmute"));
    assert.ok(sh(a, "#call-remote-video"));
    video.dispatchEvent(new a.window.Event("ended"));
    assert.ok(!sh(a, "#call-remote-video"));
    a.close();
  });

  test(`[${platform}] чужой/лишний remote-track вне звонка игнорируется; аудио без видео не включает видеоэкран`, async () => {
    const a = await bootApp({ platform });
    installFakeLink(a);
    const { stream, video } = fakeStream(a);
    remoteTrack(a, "alice", stream, video); // не в звонке
    assert.ok(!sh(a, "#call-remote-video"));
    await a.run(`beginCall("alice", false)`); a.run(`setCallPhaseActive()`);
    const audioOnly = fakeStream(a, false);
    remoteTrack(a, "alice", audioOnly.stream, audioOnly.audio);
    assert.ok(!sh(a, "#call-remote-video"));
    a.close();
  });

  test(`[${platform}] завершение звонка чистит видео-интерфейс и вызывает endCall`, async () => {
    const a = await bootApp({ platform });
    installFakeLink(a);
    await a.run(`beginCall("alice", true)`); a.run(`setCallPhaseActive()`);
    const { stream, video } = fakeStream(a);
    remoteTrack(a, "alice", stream, video);
    a.document.querySelector("#call-hangup-btn").click(); await tick(30);
    assert.ok(a.window.__calls.includes("endCall"));
    assert.equal(a.run(`state.callId`), null);
    assert.ok(!a.document.querySelector("#call-screen").classList.contains("video-active"));
    assert.ok(!sh(a, "#call-video-overlays"));
    assert.ok(!sh(a, "#call-remote-video"));
    a.close();
  });

  test(`[${platform}] mute и сворачивание звонка в мини-панель`, async () => {
    const a = await bootApp({ platform });
    installFakeLink(a);
    await a.run(`beginCall("alice", false)`); a.run(`setCallPhaseActive()`);
    a.document.querySelector("#call-mute-btn").click();
    assert.ok(a.window.__calls.includes("mute:true"));
    a.document.querySelector("#call-mute-btn").click();
    assert.ok(a.window.__calls.includes("mute:false"));
    a.document.querySelector("#call-minimize-btn").click();
    assert.ok(sh(a, "#mini-call-bar"));
    a.document.querySelector("#mini-call-bar").click();
    assert.ok(!sh(a, "#mini-call-bar"));
    assert.ok(sh(a, "#call-screen"));
    a.close();
  });
}

test("звонок: нельзя звонить группе, себе, заблокированному, второй звонок во время первого", async () => {
  const a = await bootApp({});
  installFakeLink(a);
  a.run(`state.contacts.set("g1", {id:"g1", isGroup:true, name:"G", managed:true, members:[], messages:[]}); ensureContactEntry("bob","Bob").blocked = true;`);
  await a.run(`beginCall("g1", false)`); assert.equal(a.run(`state.callId`), null);
  await a.run(`beginCall("bob", false)`); assert.equal(a.run(`state.callId`), null);
  await a.run(`beginCall("__self__", false)`); assert.equal(a.run(`state.callId`), null);
  await a.run(`beginCall("alice", false)`); assert.equal(a.run(`state.callId`), "alice");
  a.run(`ensureContactEntry("carol","Carol")`);
  await a.run(`beginCall("carol", false)`); assert.equal(a.run(`state.callId`), "alice");
  a.close();
});

test("звонок без P2P и без сервера: тост «нет сервера», звонок закрывается", async () => {
  const a = await bootApp({});
  a.run(`ensureContactEntry("alice","Alice");`);
  await a.run(`beginCall("alice", true)`);
  assert.equal(a.run(`state.callId`), null);
  assert.ok(a.document.querySelector("#toast").textContent.length > 0);
  a.close();
});

test("отказ в разрешении на микрофон/камеру при старте звонка закрывает его с тостом", async () => {
  const a = await bootApp({});
  const link = installFakeLink(a);
  link.startCall = async () => { const e = new Error("no"); e.name = "NotAllowedError"; throw e; };
  await a.run(`beginCall("alice", true)`);
  assert.equal(a.run(`state.callId`), null);
  assert.ok(a.document.querySelector("#toast").textContent.length > 0);
  a.close();
});
