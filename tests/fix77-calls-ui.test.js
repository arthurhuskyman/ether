// Экран звонка: фон при выключенном видео, свёрнутая плашка вверху (не перекрывает композер), свайп никогда не завершает звонок.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const css = fs.readFileSync(path.join(__dirname, "..", "css/styles.css"), "utf8");

function fakeLink(a) {
  a.run(`ensureContactEntry("alice", "Alice");`);
  a.window.__calls = [];
  a.run(`(() => { const calls = window.__calls; const l = new EventTarget();
    Object.assign(l, { id: "alice", status: "connected", localVideoTrack: null, _screenSharing: false,
      startCall: async (v) => { calls.push("startCall"); if (v) { l.localVideoTrack = { kind: "video", enabled: true }; l.localStream = { id: "ls" }; } l.status = "in-call"; },
      endCall: () => { calls.push("endCall"); l.status = "connected"; },
      enableVideo: async () => { calls.push("enableVideo"); l.localVideoTrack = { kind: "video", enabled: true }; l.localStream = { id: "ls" }; return true; },
      disableVideo: () => { calls.push("disableVideo"); }, setMuted() {}, setRemoteVolume() {}, send: () => true, close() {} });
    mesh.links.set("alice", l); window.__link = l; })()`);
}
function remoteVideo(a) {
  const mk = (kind) => { const t = new a.window.EventTarget(); Object.assign(t, { kind, readyState: "live", muted: false }); return t; };
  const video = mk("video"), audio = mk("audio");
  const stream = { id: "rs", getVideoTracks: () => [video], getAudioTracks: () => [audio], getTracks: () => [audio, video] };
  a.window.__st = stream; a.window.__tr = video;
  a.run(`mesh.dispatchEvent(new CustomEvent("remote-track", { detail: { id: "alice", stream: window.__st, track: window.__tr } }))`);
  return video;
}
const cs = (a) => a.document.querySelector("#call-screen");
const msg = (a, payload) => { a.window.__pl = payload; a.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "alice", payload: window.__pl } }))`); };

test("видеозвонок: выключили свою камеру → обычный фон звонка с аватаром, а не чёрный экран", async () => {
  const a = await bootApp({ platform: "ios" });
  fakeLink(a);
  await a.run(`beginCall("alice", true)`); a.run(`setCallPhaseActive()`);
  // только своё превью: фон и аватар звонка остаются (раньше пропадали → чёрный экран)
  assert.ok(!cs(a).classList.contains("video-active"), "своё превью-плашка не отменяет фон звонка");
  assert.ok(cs(a).classList.contains("local-video-on"));
  a.document.querySelector("#call-video-btn").click(); await tick(20);
  assert.ok(!cs(a).classList.contains("video-active"));
  assert.ok(!cs(a).classList.contains("local-video-on"));
  assert.ok(a.window.__calls.includes("disableVideo"));
  a.close();
});

test("видео собеседника + своё: выключили своё → видео собеседника на месте; собеседник выключил → фон звонка", async () => {
  const a = await bootApp({ platform: "ios" });
  fakeLink(a);
  await a.run(`beginCall("alice", true)`); a.run(`setCallPhaseActive()`);
  remoteVideo(a);
  assert.ok(cs(a).classList.contains("video-active"));
  a.document.querySelector("#call-video-btn").click(); await tick(20);
  assert.ok(cs(a).classList.contains("video-active"), "видео собеседника по-прежнему показано");
  msg(a, { kind: "call-state", state: "video", on: false, ts: Date.now() });
  assert.ok(!cs(a).classList.contains("video-active"), "собеседник выключил камеру: enabled=false даёт чёрные кадры без mute — сигнал по каналу");
  assert.ok(a.document.querySelector("#call-remote-video").classList.contains("hidden"));
  msg(a, { kind: "call-state", state: "video", on: true, ts: Date.now() });
  assert.ok(cs(a).classList.contains("video-active"));
  assert.ok(!a.document.querySelector("#call-remote-video").classList.contains("hidden"));
  a.close();
});

test("PeerLink.disableVideo/enableVideo сообщают собеседнику о состоянии камеры", async () => {
  const a = await bootApp({ platform: "desktop" });
  const l = a.run(`new PeerLink({ id: "alice", localName: "me", role: "offerer" })`);
  const sent = []; l.send = (m) => { sent.push(m); return true; };
  l.localVideoTrack = { enabled: true }; l._videoAdded = true;
  l.disableVideo();
  assert.equal(l.localVideoTrack.enabled, false);
  assert.deepEqual(sent.map((m) => [m.state, m.on]), [["video", false]]);
  await l.enableVideo();
  assert.deepEqual(sent.map((m) => [m.state, m.on]), [["video", false], ["video", true]]);
  l.close(); a.close();
});

test("свёрнутый звонок: плашка в потоке сразу под шапкой, не fixed и не над композером/таб-баром", async () => {
  const a = await bootApp({ platform: "desktop" });
  const shell = a.document.querySelector("#app-shell"), bar = a.document.querySelector("#mini-call-bar");
  assert.equal(bar.parentElement, shell);
  const nav = a.document.querySelector("#nav-bar"), content = a.document.querySelector("#content");
  assert.ok(nav.compareDocumentPosition(bar) & 4, "после шапки");
  assert.ok(bar.compareDocumentPosition(content) & 4, "до основного контента (композер внутри него остаётся свободным)");
  const tab = a.document.querySelector("#tab-bar");
  assert.ok(bar.compareDocumentPosition(tab) & 4, "таб-бар ниже плашки в документе");
  const rule = css.slice(css.indexOf("#mini-call-bar {"), css.indexOf("#mini-call-bar.hidden"));
  assert.doesNotMatch(rule, /position:\s*fixed/);
  assert.doesNotMatch(rule, /bottom:\s*var\(--tabbar-h/);
  assert.match(rule, /flex:\s*0 0 auto/);
  a.close();
});

test("свайп вверх сворачивает звонок; свайп вправо/влево/вниз звонок НЕ завершают", async () => {
  const a = await bootApp({ platform: "ios" });
  fakeLink(a);
  await a.run(`beginCall("alice", false)`); a.run(`setCallPhaseActive()`);
  const swipe = (dx, dy, target) => {
    const el = target || a.document.querySelector(".call-content");
    const t0 = { clientX: 200, clientY: 400 }, t1 = { clientX: 200 + dx, clientY: 400 + dy };
    const s = new a.window.Event("touchstart", { bubbles: true }); s.touches = [t0]; s.changedTouches = [t0]; el.dispatchEvent(s);
    const m = new a.window.Event("touchmove", { bubbles: true }); m.touches = [t1]; m.changedTouches = [t1]; el.dispatchEvent(m);
    const e = new a.window.Event("touchend", { bubbles: true }); e.touches = []; e.changedTouches = [t1]; el.dispatchEvent(e);
  };
  for (const [dx, dy] of [[220, 0], [-220, 0], [220, 30], [0, 200], [150, -40]]) {
    swipe(dx, dy);
    assert.equal(a.run(`state.callId`), "alice", `свайп ${dx},${dy} не завершает звонок`);
    assert.ok(!cs(a).classList.contains("hidden"), `свайп ${dx},${dy} не сворачивает`);
  }
  assert.ok(!a.window.__calls.includes("endCall"));
  swipe(0, 12, a.document.querySelector("#call-hangup-btn")); // начат на кнопке — не жест
  swipe(5, -160, a.document.querySelector("#call-mute-btn"));
  assert.ok(!cs(a).classList.contains("hidden"));
  swipe(10, -160);
  assert.ok(cs(a).classList.contains("hidden"), "вверх — свёрнут");
  assert.ok(!a.document.querySelector("#mini-call-bar").classList.contains("hidden"));
  assert.equal(a.run(`state.callId`), "alice", "звонок продолжается");
  assert.ok(!a.window.__calls.includes("endCall"));
  a.close();
});

test("«назад» (свайп от края / системная навигация) во время звонка: якорь истории, звонок жив, экран сворачивается", async () => {
  const a = await bootApp({ platform: "ios" });
  fakeLink(a);
  const h0 = a.window.history.length;
  await a.run(`beginCall("alice", false)`); a.run(`setCallPhaseActive()`);
  assert.ok(a.window.history.length > h0, "при старте звонка поставлен якорь истории");
  const h1 = a.window.history.length;
  a.window.dispatchEvent(new a.window.PopStateEvent("popstate", { state: null }));
  assert.equal(a.run(`state.callId`), "alice");
  assert.ok(!a.window.__calls.includes("endCall"));
  assert.ok(cs(a).classList.contains("hidden"), "свернулся");
  assert.ok(a.window.history.length > h1, "якорь восстановлен — следующий «назад» тоже безопасен");
  // вне звонка popstate ничего не трогает
  a.run(`closeCallScreen("completed")`);
  const h2 = a.window.history.length;
  a.window.dispatchEvent(new a.window.PopStateEvent("popstate", { state: null }));
  assert.equal(a.window.history.length, h2);
  a.close();
});

test("вёрстка звонка: safe-area не удваивается, ряд кнопок сжимается вместе с экраном, плашки не выдавливают кнопки", async () => {
  assert.match(css, /#call-screen \{[^}]*padding: 52px 20px 12px/s);
  assert.match(css, /\.call-btn \{[^}]*flex: 1 1 0; min-width: 0; max-width: 76px/s);
  assert.match(css, /\.call-btn svg \{[^}]*width: min\(54px, 100%\)/s);
  assert.match(css, /#app-shell:has\(#call-screen:not\(\.hidden\)\) #notif-banner \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 360px\) \{\s*#nav-bar \{ padding-inline: 6px; \}/);
});
