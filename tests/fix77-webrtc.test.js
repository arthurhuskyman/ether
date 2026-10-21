// V.76 audit C1/C2/C6/C7/C8.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const mk = (a) => a.run(`(() => { const l = Object.create(PeerLink.prototype); l._log = () => {}; l._closed = false; window.__l = l; return true; })()`) && a.window.__l;
const sdp = (...fps) => "v=0\r\n" + fps.map((f) => "a=fingerprint:" + f + "\r\n").join("");

test("C1: fingerprints() учитывает все a=fingerprint; расхождение -> null", async () => {
  const a = createApp(); await a.ready; const l = mk(a);
  const A = "sha-256 AA:BB:CC", B = "sha-256 DD:EE:FF";
  l.pc = { currentLocalDescription: { sdp: sdp(A, A) }, currentRemoteDescription: { sdp: sdp(A, B) } };
  const fp = l.fingerprints();
  assert.equal(fp.local, "sha-256 aa:bb:cc");
  assert.equal(fp.remote, null, "разные отпечатки одного алгоритма -> отклонить");
  l.pc = { currentLocalDescription: { sdp: sdp(A, "sha-384 11:22") }, currentRemoteDescription: { sdp: sdp(B) } };
  assert.equal(l.fingerprints().local, "sha-256 aa:bb:cc");
  assert.equal(l.fingerprints().remote, "sha-256 dd:ee:ff");
  a.close();
});

test("C2: id v1 не изменился, v2 версионирован и детерминирован", async () => {
  const a = createApp(); await a.ready;
  const r = await a.run(`(async () => { const x = await Identity.idFor("+7 900 123-45-67"); const v = await Identity.idV2For("79001234567", 1000); const v2 = await Identity.hashIdV2("+79001234567", 1000); return { x, v, v2 }; })()`);
  const crypto = require("crypto");
  assert.equal(r.x.id, crypto.createHash("sha256").update("ether:+79001234567").digest("hex"));
  assert.equal(r.v.idV1, r.x.id); assert.ok(r.v.id.startsWith("v2:")); assert.equal(r.v.id, r.v2);
  assert.notEqual(r.v.id.slice(3), r.x.id);
  a.close();
});

test("C7: таймаут первого mute не гасит страховку второго", async () => {
  const a = createApp(); await a.ready; const l = mk(a);
  l.localAudioTrack = { enabled: true };
  const stopped = [];
  const w = a.window; const origSI = w.setInterval, origCI = w.clearInterval, origST = w.setTimeout;
  a.run(`window.__timers = []; window.__ci = []; window.setTimeout = (f, ms) => { window.__timers.push({ f, ms }); return window.__timers.length; }; window.clearTimeout = () => {}; let __n = 100; window.setInterval = () => ++__n; window.clearInterval = (i) => window.__ci.push(i);`);
  l.setMuted(true); const first = l._muteRecheckTimer;
  const t1 = w.__timers.find((t) => t.ms === 10000);
  l.setMuted(false); l.setMuted(true); const second = l._muteRecheckTimer;
  assert.notEqual(first, second);
  t1.f(); // старый таймаут срабатывает
  assert.equal(l._muteRecheckTimer, second, "страховка второго mute жива");
  a.close();
});

test("C8: параллельные _ensureLocalAudio/_addAudioTrackOnce делят один getUserMedia и один attach", async () => {
  const a = createApp(); await a.ready; const l = mk(a);
  let gum = 0, att = 0, stopped = 0;
  a.window.__gum = () => { gum++; return new Promise((r) => setTimeout(() => r({ getAudioTracks: () => [{ kind: "audio", enabled: true, stop() { stopped++; } }], getTracks: () => [{ stop() { stopped++; } }] }), 20)); };
  Object.defineProperty(a.window.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: (c) => a.window.__gum(c) } });
  l._attachTrack = async () => { att++; };
  l._muted = false;
  await Promise.all([l._addAudioTrackOnce(), l._addAudioTrackOnce(), l._ensureLocalAudio()]);
  assert.equal(gum, 1); assert.equal(att, 1); assert.equal(stopped, 0);
  assert.equal(l._audioAdded, true);
  a.close();
});

test("C6: gcallToggleCamera игнорирует повторный вызов во время getUserMedia", async () => {
  const a = createApp(); await a.ready;
  let gum = 0;
  Object.defineProperty(a.window.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => { gum++; return new Promise((r) => setTimeout(() => r({ getVideoTracks: () => [], getTracks: () => [] }), 30)); } } });
  a.run(`GC.gid = "g"; GC.stream = new MediaStream(); GC.video = false;`);
  await Promise.all([a.run(`gcallToggleCamera()`), a.run(`gcallToggleCamera()`)]);
  assert.equal(gum, 1);
  assert.equal(a.run(`GC.camBusy`), false);
  a.close();
});
