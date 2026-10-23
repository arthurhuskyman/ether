// Звук звонка: микрофон при уходе в фон, перезахват трека, уведомления обеим сторонам, повтор play(), громкая связь, громкость.
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function fakeTrack(w, o = {}) { const t = new w.EventTarget(); Object.assign(t, { kind: "audio", readyState: "live", muted: false, enabled: true, stop() { this.readyState = "ended"; } }, o); return t; }
function linkWithMic(a, track) {
  const l = a.run(`new PeerLink({ id: "alice", localName: "me", role: "offerer" })`);
  l.localAudioTrack = track; l._audioAdded = true;
  l.sent = []; l.send = (m) => { l.sent.push(m); return true; };
  l.events = []; l.addEventListener("mic-state", (e) => l.events.push(e.detail));
  return l;
}

test("PeerLink: mute/unmute микрофона от ОС сообщается собеседнику и UI", async () => {
  const a = await bootApp({ platform: "ios" });
  const t = fakeTrack(a.window), l = linkWithMic(a, t);
  l._watchMicTrack(t);
  t.dispatchEvent(new a.window.Event("mute"));
  assert.deepEqual(l.sent.map((m) => [m.kind, m.state, m.suspended]), [["call-state", "mic", true]]);
  assert.equal(l.events[0].suspended, true);
  t.dispatchEvent(new a.window.Event("mute")); // повторный mute — без дубля
  assert.equal(l.sent.length, 1);
  t.dispatchEvent(new a.window.Event("unmute"));
  assert.equal(l.sent[1].suspended, false);
  assert.equal(l.events[1].suspended, false);
  l.close(); a.close();
});

test("PeerLink: 'ended' трека → перезахват микрофона; ensureMic не трогает здоровый трек", async () => {
  const a = await bootApp({ platform: "ios" });
  const t = fakeTrack(a.window), l = linkWithMic(a, t);
  let recovered = 0;
  l.recoverAudio = async () => { recovered++; l.localAudioTrack = fakeTrack(a.window); return true; };
  l._watchMicTrack(t);
  // здоровый трек: ничего не пересоздаём, но уважаем mute пользователя
  l._muted = true;
  assert.equal(await l.ensureMic("test"), true);
  assert.equal(recovered, 0);
  assert.equal(t.enabled, false, "заглушённый пользователем микрофон остаётся выключенным");
  l._muted = false;
  t.readyState = "ended"; t.dispatchEvent(new a.window.Event("ended"));
  await tick(20);
  assert.equal(recovered, 1, "после ended берём микрофон заново");
  assert.equal(l.sent.some((m) => m.state === "mic" && m.suspended === false), true, "после перезахвата собеседнику сообщаем, что звук снова идёт");
  // трек, заглушённый ОС, ensureMic пересоздаёт (после возврата из фона), force — всегда
  const t2 = l.localAudioTrack; t2.muted = true;
  await l.ensureMic("foreground"); assert.equal(recovered, 2);
  const t3 = l.localAudioTrack; await l.ensureMic("fix", true); assert.equal(recovered, 3);
  assert.ok(t3);
  l.close(); a.close();
});

test("ensureMic в фоне не вызывает getUserMedia (повторится при возврате)", async () => {
  const a = await bootApp({ platform: "ios" });
  const t = fakeTrack(a.window, { muted: true }), l = linkWithMic(a, t);
  let recovered = 0; l.recoverAudio = async () => { recovered++; return true; };
  Object.defineProperty(a.document, "hidden", { value: true, configurable: true });
  assert.equal(await l.ensureMic("bg"), false);
  assert.equal(recovered, 0);
  assert.equal(l._micLost, true);
  Object.defineProperty(a.document, "hidden", { value: false, configurable: true });
  assert.equal(await l.ensureMic("fg"), true);
  assert.equal(recovered, 1);
  l.close(); a.close();
});

function inCall(a) {
  a.run(`ensureContactEntry("alice", "Alice"); state.callId = "alice"; state.callPhase = "active";`);
  a.window.__ens = [];
  a.run(`(() => { const l = new EventTarget(); Object.assign(l, { id: "alice", status: "in-call", localAudioTrack: { readyState: "live", muted: false }, ensureMic: async (r, f) => { window.__ens.push([r, !!f]); return true; }, setMuted() {}, setRemoteVolume() {}, send: () => true, endCall() {}, close() {} }); mesh.links.set("alice", l); window.__link = l; })()`);
  return a.window.__link;
}
const msg = (a, payload) => { a.window.__pl = payload; a.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "alice", payload: window.__pl } }))`); };
const notice = (a) => a.document.querySelector("#call-notice");

test("собеседник сообщил «микрофон приостановлен» → плашка на экране звонка, снимается по возобновлению", async () => {
  const a = await bootApp({ platform: "ios" });
  inCall(a);
  assert.ok(notice(a).classList.contains("hidden"));
  msg(a, { kind: "call-state", state: "mic", suspended: true, ts: Date.now() });
  assert.ok(!notice(a).classList.contains("hidden"));
  assert.match(notice(a).textContent, /Alice/);
  msg(a, { kind: "call-state", state: "mic", suspended: false, ts: Date.now() });
  assert.ok(notice(a).classList.contains("hidden"));
  a.close();
});

test("свой микрофон приостановлен ОС → плашка; тап по плашке = «починить звук»", async () => {
  const a = await bootApp({ platform: "ios" });
  const l = inCall(a);
  a.run(`mesh.dispatchEvent(new CustomEvent("mic-state", { detail: { id: "alice", suspended: true } }))`);
  assert.ok(!notice(a).classList.contains("hidden"));
  assert.match(notice(a).textContent, /microphone/i);
  notice(a).click(); await tick(20);
  assert.ok(a.window.__ens.some(([r, f]) => r === "fix" && f), "ensureMic(force) вызван");
  a.run(`mesh.dispatchEvent(new CustomEvent("mic-state", { detail: { id: "alice", suspended: false } }))`);
  assert.ok(notice(a).classList.contains("hidden"));
  assert.ok(l);
  a.close();
});

test("возврат на передний план: контекст Web Audio, <audio> и микрофон оживают", async () => {
  const a = await bootApp({ platform: "ios", suspendedAudio: true });
  inCall(a);
  let plays = 0;
  const el = a.document.createElement("audio"); el.id = "remote-audio-alice"; el.play = () => { plays++; return Promise.resolve(); };
  a.document.body.appendChild(el);
  a.run(`ensureGlobalAudioCtx()`); a.window.__audioCtx.state = "suspended";
  a.document.dispatchEvent(new a.window.Event("visibilitychange"));
  assert.equal(a.window.__audioCtx.state, "running", "AudioContext возобновлён");
  assert.ok(plays >= 1, "приостановленный <audio> запущен снова");
  await tick(1400);
  assert.ok(a.window.__ens.some(([r]) => r === "foreground"), "микрофон проверен/перезахвачен после возврата");
  a.close();
});

test("play() отклонён политикой автоплея → видимая подсказка и повтор по жесту", async () => {
  const a = await bootApp({ platform: "ios" });
  inCall(a);
  let calls = 0;
  a.window.HTMLMediaElement.prototype.play = function () { calls++; return calls === 1 ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve(); };
  const s = { id: "S", getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] };
  a.window.__s = s; a.run(`attachRemoteAudio("alice", window.__s)`);
  await tick(20);
  assert.ok(!notice(a).classList.contains("hidden"), "показана плашка «звук заблокирован»");
  a.document.body.dispatchEvent(new a.window.Event("touchstart", { bubbles: true }));
  await tick(20);
  assert.ok(calls >= 2, "повторная попытка по жесту");
  assert.ok(notice(a).classList.contains("hidden"), "после успеха плашка убрана");
  a.close();
});

test("системная пауза <audio> во время звонка возобновляется", async () => {
  const a = await bootApp({ platform: "ios" });
  inCall(a);
  let calls = 0;
  a.window.HTMLMediaElement.prototype.play = function () { calls++; return Promise.resolve(); };
  const s = { id: "S", getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] };
  a.window.__s = s; a.run(`attachRemoteAudio("alice", window.__s)`);
  const el = a.document.getElementById("remote-audio-alice");
  const before = calls;
  Object.defineProperty(el, "paused", { value: true, configurable: true });
  el.dispatchEvent(new a.window.Event("pause"));
  await tick(250);
  assert.ok(calls > before);
  a.close();
});

test("кнопка «проблема со звуком» видна в активном звонке и перезапускает звук", async () => {
  const a = await bootApp({ platform: "android" });
  inCall(a);
  a.run(`setCallPhaseActive()`);
  const b = a.document.querySelector("#call-sound-fix-btn");
  assert.ok(!b.classList.contains("hidden"));
  a.window.__ens.length = 0;
  b.click(); await tick(30);
  assert.ok(a.window.__ens.some(([r, f]) => r === "fix" && f));
  a.run(`closeCallScreen("completed")`);
  assert.ok(b.classList.contains("hidden"));
  a.close();
});

test("громкость по умолчанию 100% (раньше 33% — «одного еле слышно»); прежний умолчательный 0.3333 считается невыбранным", async () => {
  const a = await bootApp({ platform: "desktop" });
  a.run(`localStorage.removeItem("ether.callVolume")`);
  assert.equal(a.run(`Store.callVolume`), 1);
  a.run(`localStorage.setItem("ether.callVolume", "0.3333")`);
  assert.equal(a.run(`Store.callVolume`), 1);
  a.run(`localStorage.setItem("ether.callVolume", "0.5")`);
  assert.equal(a.run(`Store.callVolume`), 0.5, "осознанный выбор пользователя сохраняется");
  assert.equal(a.document.querySelector("#call-volume-slider").getAttribute("value"), "1");
  a.close();
});

test("новый поток собеседника сбрасывает старую цепочку GainNode (ползунок не «мёртвый»)", async () => {
  const a = await bootApp({ platform: "ios" });
  a.run(`ensureContactEntry("alice","Alice"); state.callId = "alice"; state.callPhase = "active"; Store.callVolume = 1;`);
  const audio = a.document.createElement("audio"); audio.id = "remote-audio-alice"; a.document.body.appendChild(audio);
  Object.defineProperty(audio, "volume", { get: () => 1, set: () => {}, configurable: true }); // iOS: volume только для чтения
  const mk = (id) => ({ id, getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] });
  a.window.__s1 = mk("S1"); a.window.__s2 = mk("S2");
  a.run(`attachRemoteAudio("alice", window.__s1)`);
  a.run(`applyCallVolume("alice", 0.4)`);
  const g1 = audio._relayGain; assert.ok(g1);
  a.run(`Store.callVolume = 0.4; attachRemoteAudio("alice", window.__s2)`);
  assert.notEqual(audio._relayGain, g1, "старый GainNode отсоединён");
  assert.equal(audio._relayGain.gain.value, 0.4, "новый поток сразу идёт с выбранной громкостью");
  a.close();
});

test("iOS: громкая связь = audioSession.playback; если микрофон при этом умер — откат и перезахват", async () => {
  const a = await bootApp({ platform: "ios" });
  const l = inCall(a);
  a.window.navigator.audioSession = { type: "play-and-record" };
  a.run(`speakerOn = false`);
  await a.run(`toggleSpeaker()`);
  assert.equal(a.window.navigator.audioSession.type, "playback");
  assert.equal(a.run(`speakerOn`), true);
  assert.ok(a.document.querySelector("#call-speaker-btn").classList.contains("active"));
  l.localAudioTrack.muted = true; // iOS остановила захват из-за смены категории
  a.run(`verifySpeakerKeepsMic()`);
  assert.equal(a.window.navigator.audioSession.type, "play-and-record", "откат на play-and-record");
  assert.equal(a.run(`speakerOn`), false);
  assert.ok(!a.document.querySelector("#call-speaker-btn").classList.contains("active"));
  assert.ok(a.window.__ens.some(([r, f]) => r === "speaker-revert" && f), "микрофон перезахвачен");
  a.close();
});

test("Android: громкая связь не «включается вхолостую», если устройство вывода не нашлось", async () => {
  const a = await bootApp({ platform: "android" });
  inCall(a);
  const el = a.document.createElement("audio"); el.id = "remote-audio-alice"; let sink = [];
  el.setSinkId = async (id) => { sink.push(id); }; a.document.body.appendChild(el);
  Object.defineProperty(a.window.navigator.mediaDevices, "enumerateDevices", { value: async () => [{ kind: "audiooutput", deviceId: "default", label: "" }], configurable: true });
  a.run(`speakerOn = false`);
  await a.run(`toggleSpeaker()`);
  assert.equal(a.run(`speakerOn`), false, "нет устройства «динамик» — состояние не меняем");
  assert.ok(!a.document.querySelector("#call-speaker-btn").classList.contains("active"));
  assert.deepEqual(sink, []);
  Object.defineProperty(a.window.navigator.mediaDevices, "enumerateDevices", { value: async () => [{ kind: "audiooutput", deviceId: "spk1", label: "Speakerphone" }, { kind: "audiooutput", deviceId: "ear1", label: "Earpiece" }], configurable: true });
  await a.run(`toggleSpeaker()`);
  assert.equal(a.run(`speakerOn`), true);
  assert.deepEqual(sink, ["spk1"]);
  a.close();
});
