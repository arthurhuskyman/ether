// V.80: самовосстановление звука звонков — рингтон/гудки (iOS), маршрут audioSession, сторож аудио, групповой микрофон.
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const seed = JSON.stringify([{ id: "alice", name: "Алиса", raw: "", messages: [], lastActivity: 1 }]);
const base = { "ether.name": "Tester", "ether.myId": "me-test-id", "ether.lang": "ru", "ether.contacts": seed, "ether.sounds": "1" };

// Подменяем play(): считаем вызовы, paused отражает реальное состояние, режим reject имитирует NotAllowedError.
function stubMedia(a) {
  a.run(`(function(){ const P = HTMLMediaElement.prototype; window.__plays = []; window.__rejectPlay = false;
    Object.defineProperty(P, "paused", { configurable: true, get() { return this.__paused !== false; } });
    P.play = function () { window.__plays.push(this.src || ""); if (window.__rejectPlay) { const e = new Error("blocked"); e.name = "NotAllowedError"; return Promise.reject(e); } this.__paused = false; return Promise.resolve(); };
    P.pause = function () { if (this.__paused === false) { this.__paused = true; this.dispatchEvent(new Event("pause")); } else this.__paused = true; };
  })()`);
}
const plays = (a) => a.run(`window.__plays.length`);

test("входящий звонок: audioSession = playback (рингтон громко), при ответе — play-and-record до микрофона", async () => {
  const a = await bootApp({ platform: "ios", storage: base });
  a.window.navigator.audioSession = { type: "auto" };
  stubMedia(a);
  a.run(`openCallScreen("alice", "ringing")`);
  assert.equal(a.window.navigator.audioSession.type, "playback", "пока звонит — не в разговорный динамик");
  a.run(`resumeCallAudio("foreground")`);
  assert.equal(a.window.navigator.audioSession.type, "playback", "возврат из фона не переключает маршрут посреди звонка");
  a.run(`acceptCall(false)`);
  await tick(30);
  assert.equal(a.window.navigator.audioSession.type, "play-and-record");
  a.run(`closeCallScreen("completed")`);
  a.close();
});

test("исходящий звонок: audioSession = play-and-record", async () => {
  const a = await bootApp({ platform: "ios", storage: base });
  a.window.navigator.audioSession = { type: "auto" };
  a.run(`openCallScreen("alice", "calling")`);
  assert.equal(a.window.navigator.audioSession.type, "play-and-record");
  a.run(`closeCallScreen("completed")`);
  a.close();
});

test("рингтон: play() отклонён (автоплей) — повтор на жесте, при возврате в приложение и сторожем", async () => {
  const a = await bootApp({ platform: "ios", storage: base });
  stubMedia(a);
  a.run(`window.__rejectPlay = true; openCallScreen("alice", "ringing"); playRingtone()`);
  await tick(10);
  const n0 = plays(a);
  assert.ok(n0 >= 1);
  a.run(`window.__rejectPlay = false`);
  a.document.dispatchEvent(new a.window.Event("touchstart", { bubbles: true }));
  await tick(10);
  assert.ok(plays(a) > n0, "жест перезапускает рингтон");
  assert.equal(a.run(`ringtoneAudioEl && ringtoneAudioEl.paused`), false);
  // система поставила на паузу — возврат в приложение запускает снова
  a.run(`ringtoneAudioEl.pause()`);
  const n1 = plays(a);
  a.document.dispatchEvent(new a.window.Event("visibilitychange"));
  await tick(10);
  assert.ok(plays(a) > n1, "visibilitychange перезапускает рингтон");
  // пауза элемента сама возобновляется
  a.run(`ringtoneAudioEl.pause()`);
  const n2 = plays(a);
  await tick(450);
  assert.ok(plays(a) > n2, "pause-обработчик возобновляет рингтон");
  a.run(`stopRingtone(); closeCallScreen("missed")`);
  const n3 = plays(a);
  a.document.dispatchEvent(new a.window.Event("touchstart", { bubbles: true }));
  a.document.dispatchEvent(new a.window.Event("visibilitychange"));
  await tick(450);
  assert.equal(plays(a), n3, "после stopRingtone ничего не перезапускается");
  a.close();
});

test("гудки дозвона (ringback) тоже самовосстанавливаются; stopCallSounds снимает", async () => {
  const a = await bootApp({ platform: "ios", storage: base });
  stubMedia(a);
  a.run(`playDialingSound()`);
  const n0 = plays(a);
  a.run(`dialingAudioEl.pause()`);
  await tick(450);
  assert.ok(plays(a) > n0, "гудки возобновлены после паузы");
  a.run(`stopCallSounds()`);
  const n1 = plays(a);
  a.document.dispatchEvent(new a.window.Event("visibilitychange"));
  assert.equal(plays(a), n1);
  a.close();
});

test("рингтон в момент разблокировки пула не затирается тихим WAV; loop сохраняется", async () => {
  const a = await bootApp({ platform: "ios", storage: base });
  stubMedia(a);
  a.run(`for (const el of soundPool.values()) { delete el.dataset.unlocked; delete el.dataset.unlocking; } unlockSoundPool()`);
  const src = a.run(`currentRingtoneSrc()`);
  assert.equal(a.run(`getSoundEl(currentRingtoneSrc(), true).dataset.unlocking`), "1");
  a.run(`playRingtone()`);
  assert.equal(a.run(`getSoundEl(currentRingtoneSrc(), true).dataset.unlocking || ""`), "", "разблокировка завершена досрочно");
  assert.equal(a.run(`ringtoneAudioEl.loop`), true);
  assert.ok(a.run(`ringtoneAudioEl.src`).endsWith(src), "вместо тишины стоит сам рингтон");
  a.run(`stopRingtone()`);
  a.close();
});

test("AudioContext 'interrupted'/'suspended' во время звонка возвращается в running по statechange", async () => {
  const a = await bootApp({ platform: "ios", storage: base });
  stubMedia(a);
  let resumed = 0, listener = null;
  a.window.AudioContext = function () { this.state = "running"; this.currentTime = 0; this.destination = {};
    this.addEventListener = (n, f) => { if (n === "statechange") listener = f; };
    this.resume = () => { resumed++; this.state = "running"; return Promise.resolve(); };
    this.createOscillator = () => ({ connect() {}, start() {}, stop() {}, frequency: {}, type: "" });
    this.createGain = () => ({ connect() {}, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }); };
  a.run(`globalAudioCtx = null; ensureGlobalAudioCtx()`);
  assert.ok(listener, "statechange подписан сразу при создании контекста");
  a.run(`openCallScreen("alice", "ringing")`);
  const ctx = a.run(`globalAudioCtx`);
  ctx.state = "interrupted"; listener();
  assert.ok(resumed >= 1);
  a.run(`closeCallScreen("completed")`);
  a.close();
});

test("сторож звука: исходящая тишина чинится на 3-м и 9-м замере, не при mute/в фоне; входящая — мягкие меры", async () => {
  const a = await bootApp({ platform: "ios", storage: base });
  stubMedia(a);
  a.run(`openCallScreen("alice", "active"); setCallPhaseActive();`);
  const calls = a.run(`(function(){ const c = { rec: 0, inv: 0, res: 0 };
    window.__c = c;
    const l = { _muted: false, audioDebug() { return ""; }, recoverAudio() { c.rec++; return Promise.resolve(true); }, reInvite() { c.inv++; } };
    window.__l = l; mesh.get = () => l;
    const orig = resumeCallAudio; window.resumeCallAudio = function (r) { c.res++; }; return c; })()`);
  const act = (o) => a.run(`watchCallAudioAct(Object.assign({ silentIn: 0, silentOut: 0, kicked: false }, ${JSON.stringify(o)}), 0, 0)`);
  act({ silentOut: 2 }); assert.equal(calls.rec, 0);
  act({ silentOut: 3 }); assert.equal(calls.rec, 1);
  act({ silentOut: 4 }); assert.equal(calls.rec, 1);
  act({ silentOut: 9 }); assert.equal(calls.rec, 2, "повтор, если первая попытка не помогла");
  a.run(`__l._muted = true`); act({ silentOut: 15 }); assert.equal(calls.rec, 2, "пользователь заглушил себя — не чиним");
  a.run(`__l._muted = false`);
  Object.defineProperty(a.document, "hidden", { value: true, configurable: true });
  act({ silentOut: 15 }); assert.equal(calls.rec, 2, "в фоне getUserMedia не даст трек");
  Object.defineProperty(a.document, "hidden", { value: false, configurable: true });
  act({ silentIn: 2 }); assert.ok(calls.res >= 1, "сначала дешёвая мера");
  assert.equal(calls.inv, 0);
  act({ silentIn: 3 }); assert.equal(calls.inv, 1, "потом один перезапуск ICE");
  a.run(`closeCallScreen("completed")`);
  a.close();
});

test("групповой звонок: убитый микрофон берётся заново и подставляется во все линки", async () => {
  const a = await bootApp({ platform: "ios", storage: base });
  const w = a.window;
  const mk = (id) => { const t = new w.EventTarget(); Object.assign(t, { kind: "audio", id, readyState: "live", muted: false, enabled: true, stop() { this.readyState = "ended"; } }); return t; };
  const oldT = mk("old"), newT = mk("new");
  const stream = { tracks: [oldT], getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }, getTracks() { return this.tracks; }, getVideoTracks() { return []; }, removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }, addTrack(t) { this.tracks.push(t); } };
  w.navigator.mediaDevices = { getUserMedia: async () => ({ getAudioTracks: () => [newT], getTracks: () => [newT] }) };
  const rep = [];
  w.__link = { replaceGroupTrack: async (o, n) => { rep.push([o, n.id]); return true; }, addGroupTracks() {} };
  a.run(`GC.gid = "g1"; GC.stream = null; GC.peers = new Map([["p1", { name: "P" }]]); mesh.get = () => window.__link;`);
  w.__stream = stream; a.run(`GC.stream = window.__stream; GC.muted = true; gcallWatchMic(window.__stream.tracks[0]);`);
  oldT.readyState = "ended"; oldT.dispatchEvent(new w.Event("ended"));
  await tick(30);
  assert.deepEqual(rep, [["old", "new"]]);
  assert.equal(stream.tracks[0], newT);
  assert.equal(newT.enabled, false, "mute пользователя сохраняется");
  assert.equal(a.run(`GC.micSuspended`), false);
  // здоровый трек не трогаем
  assert.equal(await a.run(`gcallEnsureMic("x")`), true);
  assert.equal(rep.length, 1);
  a.run(`GC.gid = null; GC.stream = null; GC.peers = new Map()`);
  a.close();
});
