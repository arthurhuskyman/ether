// Покрытие app.js: журнал звонков, экран звонка (кнопки, таймер, качество), приём/сброс, события mesh, аудио-выход, голосовая почта.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    for (const [id, n] of [["alice", "Alice"], ["bob", "Bob"]]) { const c = ensureContactEntry(id, n); c.managed = true; c.publicKey = { kty: "EC" }; }
    state._firstRenderDone = true; persistContacts();
    window.mkLink = (extra) => Object.assign({ status: "connected", startCall: async () => { window.__started = 1; }, answerCall: async () => { window.__answered = 1; }, endCall() { window.__ended = (window.__ended || 0) + 1; }, declineCall(r) { window.__declined = r || "x"; }, setMuted(m) { window.__muted = m; }, enableVideo: async () => true, disableVideo() { window.__vidOff = 1; }, switchCamera() { window.__flip = 1; }, startScreenShare: async () => true, stopScreenShare: async () => {}, send() { return true; }, localStream: { id: "ls" }, close() {} }, extra || {}); })()`);
}

test("журнал звонков: запись, статусы, подписи, список, перезвон, нормализация", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.beginCall = (id) => { window.__bc = id; };`);
  const r = J(a.run(`(() => { const o = {};
    startCallRecord("alice", "out"); updateCallRecordStatus("active"); updateCallRecordStatus("active"); const rec = state.currentCallRecord; rec.answeredAt = Date.now() - 5000; endCallRecord("completed"); o.completed = [state.callLog[0].status, state.callLog[0].durationMs >= 5000];
    startCallRecord("alice", "out"); endCallRecord("completed"); o.cancelled = state.callLog[1].status; startCallRecord("bob", "in"); endCallRecord(); o.missed = state.callLog[2].status; startCallRecord("bob", "in"); endCallRecord("declined"); o.declined = state.callLog[3].status;
    startCallRecord("bob", "out"); state.currentCallRecord.answeredAt = 1; endCallRecord("failed"); o.failed = state.callLog[4].status; updateCallRecordStatus("x"); endCallRecord("x");
    o.labels = state.callLog.map((r) => callStatusLabel(r).length > 0); o.meta = state.callLog.map((r) => callStatusMeta(r).cls);
    state.callLog.push({ id: "z", contactId: "ghost", contactName: "Ghost", direction: "in", status: "busy", startedAt: Date.now() - 1000 });
    state.tab = "chats"; state.chatsSegment = "calls"; renderTab(); o.rows = document.querySelectorAll("#calls-list .call-row").length;
    document.querySelector("#calls-list .call-back-btn:not([disabled])").click(); o.bc = !!window.__bc; document.querySelector("#calls-list .call-row-main:not([disabled])").click(); o.chat = state.chatId;
    state.callLog = []; renderCallsList(); o.empty = !document.getElementById("calls-empty").classList.contains("hidden");
    state.callLog = [{ id: "n", contactId: "alice", seen: undefined, status: "missed", direction: "in", startedAt: 1 }, null, { id: 5 }]; Store.callLogJson = JSON.stringify(state.callLog); loadCallLog(); o.loaded = state.callLog.length; o.seen = state.callLog[0].seen;
    Store.callLogJson = "{bad"; loadCallLog(); Store.callLogJson = "5"; loadCallLog();
    o.sys = [systemMessageForCall(null, "x"), systemMessageForCall({ direction: "out", answeredAt: 1, durationMs: 5 }, "completed").key, systemMessageForCall({ direction: "out" }, "completed").key, systemMessageForCall({ direction: "in" }, "completed").key, systemMessageForCall({ direction: "out" }, "missed").key, systemMessageForCall({ direction: "in" }, "missed").key, systemMessageForCall({ noAnswer: true }, "cancelled").key, systemMessageForCall({}, "cancelled").key, systemMessageForCall({}, "declined").key, systemMessageForCall({}, "busy").key, systemMessageForCall({}, "failed").key, systemMessageForCall({}, "zzz")];
    return o; })()`));
  assert.deepEqual(r.completed, ["completed", true]); assert.equal(r.cancelled, "cancelled"); assert.equal(r.missed, "missed"); assert.equal(r.declined, "declined"); assert.equal(r.failed, "failed"); assert.equal(r.rows, 6); assert.equal(r.bc, true); assert.ok(r.chat); assert.equal(r.empty, true); assert.equal(r.seen, true);
  assert.equal(r.sys[0], null); assert.equal(r.sys[11], null); assert.equal(r.sys[10], "calls.failed");
  a.close();
});

test("начало звонка: все отказы и вариации (P2P, сервер, офлайн), таймауты и повтор приглашения", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.__sigs = []; signaling = { connected: true, signal(to, d) { window.__sigs.push([to, d.t]); return true; }, addEventListener() {}, removeEventListener() {} }; window.attemptConnect = async () => {}; window.getUserMedia = 1;`);
  const bc = async (id, v) => { await a.run(`beginCall(${JSON.stringify(id)}, ${v ? "true" : "false"})`); };
  await bc("nope"); a.run(`state.contacts.get("alice").isSelf = true;`); await bc("alice"); a.run(`state.contacts.get("alice").isSelf = false; state.contacts.get("alice").blocked = true;`); await bc("alice"); a.run(`state.contacts.get("alice").blocked = false; state.callId = "bob";`); await bc("alice");
  a.run(`state.callId = "alice"; state.callPhase = "calling";`); await bc("alice"); a.run(`closeCallScreen("cancelled"); state.contacts.get("alice").pendingKey = { key: {} };`); await bc("alice"); a.run(`state.contacts.get("alice").pendingKey = undefined; Store.requireVerifiedCalls = true; window.confirmSheet = async () => true; window.openSafetySheet = (id) => { window.__safe = id; };`); await bc("alice"); assert.equal(a.window.__safe, "alice"); a.run(`Store.requireVerifiedCalls = false; state._lastCallFailedAt = Date.now();`); await bc("alice"); a.run(`state._lastCallFailedAt = 0;`);
  // группа
  a.run(`state.contacts.set("g1", { id: "g1", isGroup: true, members: [], messages: [] }); window.startGroupCall = (g, v) => { window.__gc = g; };`); await bc("g1"); assert.equal(a.window.__gc, "g1"); a.run(`window.gcallBusy = () => true;`); await bc("alice"); a.run(`window.gcallBusy = () => false;`);
  // живой P2P
  a.run(`mesh.links.set("alice", mkLink()); window.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [] }) };`); await bc("alice", true); assert.equal(a.window.__started, 1); assert.equal(a.run(`state.callId`), "alice"); a.run(`closeCallScreen("cancelled");`);
  // P2P есть, но микрофон запрещён / нет / сломан
  for (const nm of ["NotAllowedError", "NotFoundError", "Boom"]) { a.run(`mesh.links.set("alice", mkLink({ startCall: async () => { throw Object.assign(new Error("m"), { name: ${JSON.stringify(nm)} }); } })); state._lastCallFailedAt = 0;`); await bc("alice"); }
  // отмена пока висит запрос микрофона
  a.run(`mesh.links.set("alice", mkLink({ startCall: async () => { state.callId = null; } })); state._lastCallFailedAt = 0;`); await bc("alice");
  // без P2P: ждём сигналинг, приглашаем, таймаут «нет ответа»
  a.run(`mesh.links.delete("alice"); state._lastCallFailedAt = 0; onlineSet.add("alice"); window.__sigs.length = 0;`); await bc("alice"); assert.ok(J(a.window.__sigs).some((x) => x[1] === "call-invite")); t.tick(8000); t.tick(8000); t.tick(60000); assert.equal(a.run(`state.callId`), null);
  a.run(`onlineSet.delete("alice"); state._lastCallFailedAt = 0;`); await bc("alice"); a.run(`state.callPhase = "active";`); t.tick(120000); a.run(`closeCallScreen("completed");`);
  // сигналинг недоступен
  a.run(`state._lastCallFailedAt = 0; signaling.connected = false;`); { const pw = a.run(`beginCall("alice", false)`); await sleep(10); t.tick(60000); await pw; } a.run(`signaling.connected = true; state._lastCallFailedAt = 0; closeCallScreen("failed");`);
  // waitForSignaling
  const w = J(await a.run(`(async () => { const o = {}; const sg = new EventTarget(); sg.connected = false; signaling = sg; const p = waitForSignaling(50); sg.connected = true; sg.dispatchEvent(new Event("connected")); o.ok = await p; sg.connected = false; const p2 = waitForSignaling(5000); o.timeoutPending = true; signaling = null; o.noSig = await waitForSignaling(10); return o; })()`));
  assert.equal(w.ok, true);
  a.close();
});

test("экран звонка: кнопки (сброс, микрофон, видео, экран, PiP, громкость), принять/отклонить, сворачивание", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.__sigs = []; signaling = { connected: true, signal(to, d) { window.__sigs.push([to, d.t]); return true; }, addEventListener() {}, removeEventListener() {} }; window.attemptConnect = async () => {};`);
  const click = (id) => { const e = a.document.getElementById(id); assert.ok(e, id); e.click(); };
  a.run(`mesh.links.set("alice", mkLink()); openCallScreen("alice", "calling");`);
  click("call-mute-btn"); assert.equal(a.window.__muted, true); click("call-mute-btn"); assert.equal(a.window.__muted, false);
  click("call-video-btn"); await sleep(10); assert.ok(a.document.getElementById("call-video-btn").classList.contains("active")); a.run(`mesh.get("alice")._screenSharing = true;`); click("call-video-btn"); await sleep(10); a.run(`mesh.get("alice")._screenSharing = false; mesh.get("alice").enableVideo = async () => false;`); click("call-video-btn"); await sleep(10);
  a.run(`mesh.get("alice").enableVideo = async () => true;`); click("call-video-btn"); await sleep(10); click("call-video-btn"); await sleep(10); assert.equal(a.window.__vidOff, 1);
  const ss = a.document.getElementById("call-screenshare-btn"); ss.classList.remove("hidden"); ss.click(); await sleep(10); assert.ok(ss.classList.contains("active")); ss.click(); await sleep(10); a.run(`mesh.get("alice").startScreenShare = async () => false;`); ss.click(); await sleep(10);
  click("call-flip-overlay-btn"); assert.equal(a.window.__flip, 1); click("call-pip-overlay-btn");
  a.run(`document.getElementById("call-remote-video").srcObject = { id: 1 }; document.getElementById("call-remote-video").classList.remove("hidden"); document.getElementById("call-remote-video").requestPictureInPicture = async () => { window.__pip = 1; };`); click("call-pip-overlay-btn"); await sleep(10);
  a.run(`document.pictureInPictureElement = {}; document.exitPictureInPicture = async () => { window.__pipExit = 1; };`); click("call-pip-overlay-btn"); await sleep(10); a.run(`document.pictureInPictureElement = null;`);
  const vs = a.document.getElementById("call-volume-slider"); vs.value = "0.3"; vs.dispatchEvent(new a.window.Event("input")); assert.equal(a.run(`Store.callVolume`), 0.3);
  click("call-minimize-btn"); assert.ok(!a.document.getElementById("mini-call-bar").classList.contains("hidden")); click("mini-call-bar"); assert.ok(a.document.getElementById("mini-call-bar").classList.contains("hidden")); a.run(`restoreCallScreen();`); a.run(`const sc = state.callId; state.callId = null; minimizeCallScreen(); restoreCallScreen(); state.callId = sc;`);
  click("call-hangup-btn"); assert.equal(a.run(`state.callId`), null); assert.ok(J(a.window.__sigs).some((x) => x[1] === "call-ended"));
  // принять / отклонить
  a.run(`mesh.links.set("alice", mkLink()); openCallScreen("alice", "ringing");`); click("call-decline-btn"); assert.equal(a.window.__declined, "x"); assert.ok(J(a.window.__sigs).some((x) => x[1] === "call-declined"));
  a.run(`openCallScreen("alice", "ringing"); window.__answered = 0;`); click("call-accept-btn"); await sleep(30); assert.equal(a.window.__answered, 1); assert.equal(a.run(`state.callPhase`), "active"); a.run(`closeCallScreen("completed");`);
  a.run(`openCallScreen("alice", "ringing"); state.callWantsVideo = true;`); click("call-mute-accept-btn"); await sleep(30); assert.equal(a.window.__muted, true); a.run(`closeCallScreen("completed");`);
  // принять без P2P — ждём «connected»; повторный accept; ошибка микрофона; требование проверки
  a.run(`mesh.links.delete("alice"); openCallScreen("alice", "ringing");`); await a.run(`acceptCall(false)`); await a.run(`acceptCall(false)`); t.tick(60000); await sleep(10); a.run(`closeCallScreen("failed");`);
  for (const nm of ["NotAllowedError", "NotFoundError", "X"]) { a.run(`mesh.links.set("alice", mkLink({ answerCall: async () => { throw Object.assign(new Error("m"), { name: ${JSON.stringify(nm)} }); } })); openCallScreen("alice", "ringing");`); await a.run(`acceptCall(false)`); a.run(`state._callUserAccepted = false;`); }
  a.run(`mesh.links.set("alice", mkLink({ answerCall: async () => { state.callId = null; } })); openCallScreen("alice", "ringing");`); await a.run(`acceptCall(false)`);
  a.run(`state._callUserAccepted = false; openCallScreen("alice", "ringing"); Store.requireVerifiedCalls = true;`); await a.run(`acceptCall(false)`); a.run(`Store.requireVerifiedCalls = false; closeCallScreen("declined"); acceptCall(false);`);
  // входящий с таймаутом
  a.run(`openCallScreen("alice", "ringing", { timeoutMs: 1000 });`); t.tick(1500); assert.equal(a.run(`state.callId`), null);
  a.close();
});

test("события mesh: link-status, message (call-state, auth, relay, file, fx), remote-track, ice, шлюз аутентификации", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.__sigs = []; signaling = { connected: true, signal(to, d) { window.__sigs.push([to, d.t, d.candidate]); return true; }, addEventListener() {}, removeEventListener() {}, features: [] }; window.attemptConnect = async () => {};`);
  const ev = (type, detail) => a.run(`mesh.dispatchEvent(new CustomEvent(${JSON.stringify(type)}, { detail: ${JSON.stringify(detail)} }))`);
  const msg = (id, payload) => ev("message", { id, payload });
  // link-status
  a.run(`mesh.links.set("alice", mkLink({ remoteName: "Alice R", dc: { readyState: "closed" }, fingerprints: () => ({}) }));`);
  ev("link-status", { id: "alice", status: "connected" }); ev("link-status", { id: "alice", status: "in-call" }); ev("link-status", { id: "alice", status: "disconnected" }); ev("link-status", { id: "ghost", status: "connected" }); t.tick(11000);
  a.run(`state.contacts.get("alice").nameLocal = true; state.contacts.get("alice").status = "disconnected"; state.pendingOutgoing = { id: "alice" };`); ev("link-status", { id: "alice", status: "connected" });
  // соединение во время звонка: caller / callee
  a.run(`openCallScreen("alice", "calling"); state.callWantsVideo = true; state.contacts.get("alice").status = "x";`); ev("link-status", { id: "alice", status: "connected" }); await sleep(20); a.run(`mesh.get("alice")._audioAdded = true; state.contacts.get("alice").status = "x";`); ev("link-status", { id: "alice", status: "connected" }); await sleep(20); a.run(`closeCallScreen("cancelled");`);
  a.run(`openCallScreen("alice", "ringing"); state._callUserAccepted = true; state._callMuteOnAnswer = true; state.callWantsVideo = true; state.contacts.get("alice").status = "x";`); ev("link-status", { id: "alice", status: "connected" }); await sleep(30); a.run(`closeCallScreen("cancelled");`);
  // caps и прочее
  ev("link-caps", { id: "alice", rc: true, e2: true }); ev("link-caps", { id: "ghost" }); ev("link-dc-open", { id: "alice" }); ev("screen-share-ended", { id: "alice" }); a.run(`state.callId = "alice";`); ev("screen-share-ended", { id: "alice" }); a.run(`state.callId = null;`); ev("relay-fallback", { id: "alice" }); t.tick(1000);
  // message: блок, auth, шлюз
  a.run(`state.contacts.get("bob").blocked = true;`); msg("bob", { kind: "call-state", state: "ringing" }); msg("bob", { kind: "chat", id: "x", text: "y" }); t.tick(40000); a.run(`state.contacts.get("bob").blocked = false;`); msg("ghost", { kind: "chat" });
  a.run(`const lk = mkLink(); lk.authGate = "pending"; lk._authBuf = []; lk._authStarted = true; mesh.links.set("alice", lk);`); msg("alice", { kind: "chat", id: "buf1", text: "buffered" }); assert.equal(a.run(`mesh.get("alice")._authBuf.length`), 1); msg("alice", { kind: "ping" }); msg("alice", { kind: "auth", s: 1, n: "x" });
  a.run(`mesh.get("alice").authGate = "closed";`); msg("alice", { kind: "chat", id: "closed1", text: "dropped" }); a.run(`mesh.get("alice").authGate = null; state.contacts.get("alice").authSeen = false;`);
  msg("alice", { kind: "fx.something" }); msg("alice", { kind: "gcall", t: "join" }); msg("alice", { kind: "relay-request", to: "x" }); msg("alice", { kind: "file-meta", id: "ff", name: "n", mime: "x/y", size: 5, totalChunks: 1 });
  msg("alice", { kind: "chat", id: "live1", text: "live" }); assert.ok(a.run(`state.contacts.get("alice").messages.some((m) => m.id === "live1")`));
  // call-state
  a.run(`window.__ct = []; for (const f of ["openCallScreen", "playRingtone", "stopRingtone", "playBusySound", "playNoAnswerSound"]) { const orig = window[f]; }`);
  a.run(`recentlyEndedCalls.clear();`); msg("alice", { kind: "call-state", state: "ringing", ts: Date.now() }); assert.equal(a.run(`state.callId`), "alice"); msg("alice", { kind: "call-state", state: "screen", on: true }); msg("alice", { kind: "call-state", state: "accepted" }); assert.equal(a.run(`state.callPhase`), "active");
  msg("alice", { kind: "call-state", state: "declined", reason: "busy" }); assert.equal(a.run(`state.callId`), null);
  a.run(`openCallScreen("alice", "calling");`); msg("alice", { kind: "call-state", state: "declined" }); a.run(`openCallScreen("alice", "active");`); msg("alice", { kind: "call-state", state: "ended" }); assert.equal(a.run(`state.callId`), null);
  msg("alice", { kind: "call-state", state: "ringing", ts: 1 }); assert.equal(a.run(`state.callId`), null, "устаревший ringing игнорируется"); msg("alice", { kind: "call-state", state: "ringing", ts: Date.now() }); a.run(`closeCallScreen("missed");`); msg("alice", { kind: "call-state", state: "ringing", ts: Date.now() }); assert.equal(a.run(`state.callId`), null, "после недавнего отбоя");
  a.run(`recentlyEndedCalls.clear(); openCallScreen("bob", "active");`); msg("alice", { kind: "call-state", state: "ringing", ts: Date.now() }); assert.ok(a.window.__declined); a.run(`closeCallScreen("completed"); window.gcallBusy = () => true;`); msg("alice", { kind: "call-state", state: "ringing" }); a.run(`window.gcallBusy = () => false;`);
  // remote-track и ICE
  const stream = `{ id: "s", getVideoTracks: () => [{ kind: "video", addEventListener() {} }], getAudioTracks: () => [] }`;
  a.run(`window.__rs = ${stream};`); ev("remote-track", { id: "alice", stream: null }); a.run(`openCallScreen("alice", "calling");`); a.run(`mesh.dispatchEvent(new CustomEvent("remote-track", { detail: { id: "alice", stream: __rs, track: { kind: "video" } } }))`); assert.ok(a.run(`pendingRemoteStreams.has("alice")`));
  a.run(`state.callPhase = "active"; mesh.dispatchEvent(new CustomEvent("remote-track", { detail: { id: "alice", stream: __rs, track: { kind: "video" } } })); mesh.dispatchEvent(new CustomEvent("remote-track", { detail: { id: "bob", stream: __rs } }))`);
  ev("ice-candidate", { id: "alice", candidate: null }); a.run(`mesh.dispatchEvent(new CustomEvent("ice-candidate", { detail: { id: "alice", candidate: { toJSON: () => ({ candidate: "c" }) } } })); mesh.dispatchEvent(new CustomEvent("ice-candidate", { detail: { id: "alice", candidate: { candidate: "plain" } } })); signaling.connected = false; mesh.dispatchEvent(new CustomEvent("ice-candidate", { detail: { id: "alice", candidate: { candidate: "x" } } }));`);
  assert.ok(J(a.window.__sigs).some((x) => x[2] && x[2].candidate === "c"));
  a.close();
});

test("аудио и качество звонка: remote audio, громкость, динамик, вывод, статистика, мёртвая связь, голосовая почта", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.__sigs = []; signaling = { connected: true, signal() { return true; }, addEventListener() {}, removeEventListener() {} };`);
  const r = J(await a.run(`(async () => { const o = {};
    attachRemoteAudio("alice", null); const stream = { id: "rs", getTracks: () => [], getVideoTracks: () => [] }; attachRemoteAudio("alice", stream); attachRemoteAudio("alice", stream); o.el = !!document.getElementById("remote-audio-alice");
    applyCallVolume("alice", 0.4); applyCallVolume("alice", "x"); applyCallVolume("nobody", 1); const el = document.getElementById("remote-audio-alice"); el._volReadOnly = true; applyCallVolume("alice", 0.5); applyCallVolume("alice", 1); el._relayGain = null; o.gain = !!ensureRelayGain(el, stream); o.gain2 = !!ensureRelayGain(el, stream); const el2 = document.createElement("audio"); o.noStream = ensureRelayGain(el2, null);
    HTMLMediaElement.prototype.setSinkId = async function (id) { window.__sink = id; }; navigator.mediaDevices.enumerateDevices = async () => [{ kind: "audiooutput", deviceId: "spk", label: "Speaker" }, { kind: "audiooutput", deviceId: "ear", label: "Earpiece receiver" }, { kind: "audiooutput", deviceId: "default", label: "" }, { kind: "videoinput", deviceId: "v", label: "cam" }];
    o.found = [await findAudioOutputDevice(/speaker/i), await findAudioOutputDevice(/zzz/i)]; navigator.mediaDevices.enumerateDevices = async () => { throw new Error("x"); }; o.foundErr = await findAudioOutputDevice(/x/); navigator.mediaDevices.enumerateDevices = async () => [{ kind: "audiooutput", deviceId: "spk", label: "Speaker" }, { kind: "audiooutput", deviceId: "ear", label: "Earpiece" }];
    o.flags = [typeof isMobileDevice(), typeof speakerToggleSupported(), typeof pipSupported()]; localStorage.setItem("ether.audioOut", "spk"); o.saved = savedAudioOutput(); await setAudioOutput("ear"); o.sink = window.__sink; await setAudioOutput("");
    openCallScreen("alice", "active"); Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile", configurable: true });
    await toggleSpeaker(); o.spk1 = speakerOn; await toggleSpeaker(); o.spk2 = speakerOn;
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (X11; Linux x86_64) Chrome/124", configurable: true }); await toggleSpeaker();
    await openAudioOutputPicker(); o.menu = !!document.getElementById("audio-out-menu"); const mb = document.querySelector("#audio-out-menu .call-menu-item"); if (mb) mb.click(); await openAudioOutputPicker(); await openAudioOutputPicker();
    navigator.mediaDevices.enumerateDevices = async () => []; await openAudioOutputPicker(); document.getElementById("audio-out-menu") && document.getElementById("audio-out-menu").remove();
    Object.defineProperty(navigator, "audioSession", { value: { type: "" }, configurable: true }); await toggleSpeaker();
    // статистика
    const stats = (rtt, lost, recv, sent, bytesIn, bytesOut) => { const m = new Map(); m.set("cp", { id: "cp", type: "candidate-pair", state: "succeeded", selected: true, currentRoundTripTime: rtt, localCandidateId: "l", remoteCandidateId: "r", nominated: true }); m.set("l", { id: "l", type: "local-candidate", candidateType: "host", protocol: "udp" }); m.set("r", { id: "r", type: "remote-candidate", candidateType: "relay", protocol: "udp" }); m.set("in", { id: "in", type: "inbound-rtp", kind: "audio", packetsLost: lost, packetsReceived: recv, bytesReceived: bytesIn, jitter: 0.01, jitterBufferDelay: 2, jitterBufferEmittedCount: 100, concealedSamples: 5, totalSamplesReceived: 100, packetsReceived2: 1 }); m.set("out", { id: "out", type: "outbound-rtp", kind: "audio", bytesSent: bytesOut, timestamp: Date.now() }); m.forEach = Map.prototype.forEach; return m; };
    const lk = mkLink({ pc: { getStats: async () => window.__stats }, audioDebug: () => "dbg", recoverAudio: async () => true, reInvite() { window.__reinvite = (window.__reinvite || 0) + 1; } }); mesh.links.set("alice", lk);
    for (const [rtt, lost, recv] of [[0.05, 0, 100], [0.2, 4, 100], [0.4, 30, 100]]) { window.__stats = stats(rtt, lost, recv, 0, 1000, 1000); await updateCallQualityIcon(lk.pc); o["q" + rtt] = document.getElementById("call-quality-icon").className; }
    window.__stats = { forEach(f) { f({ type: "candidate-pair", state: "succeeded" }); } }; await updateCallQualityIcon(lk.pc); const pcOld = state.callId; state.callId = null; await updateCallQualityIcon(lk.pc); state.callId = pcOld; await updateCallQualityIcon({ getStats: async () => { throw new Error("x"); } });
    for (let i = 0; i < 6; i++) { watchCallAudioFlow(stats(0.1, 0, 10, 0, 500, 500)); } o.reinvite = window.__reinvite; for (let i = 0; i < 12; i++) logCallStats(stats(0.1, 0, 10, 0, 500 + i, 500 + i));
    // таймер звонка и мёртвая связь
    state.callPhase = "active"; startCallTimer(); __fk.tick(4000); mesh.links.delete("alice"); __fk.tick(CALL_DEAD_LINK_TIMEOUT_MS + 5000); o.dead = state.callId;
    return o; })()`));
  assert.equal(r.el, true); assert.equal(r.gain, true); assert.deepEqual(r.found, ["spk", null]); assert.equal(r.foundErr, null); assert.equal(r.saved, "spk"); assert.equal(r.sink, "ear"); assert.ok(r["q0.05"].includes("quality-good")); assert.ok(r["q0.2"].includes("quality-medium")); assert.ok(r["q0.4"].includes("quality-poor")); assert.ok(r.reinvite >= 1); assert.equal(r.dead, null);
  // голосовая почта
  a.run(`window.confirmSheet = async () => true; window.startVoiceRecording = () => { window.__vr = 1; };`); await a.run(`offerVoicemail("alice")`); t.tick(300); assert.equal(a.window.__vr, 1);
  a.run(`window.confirmSheet = async () => false;`); await a.run(`offerVoicemail("alice")`); await a.run(`offerVoicemail("nope")`); a.run(`state.contacts.get("alice").blocked = true;`); await a.run(`offerVoicemail("alice")`);
  a.run(`state.contacts.get("alice").blocked = false; startCallRecord("alice", "out"); state.callId = "alice"; closeCallScreen("declined"); closeCallScreen("cancelled", { noAnswer: true }); window.confirmSheet = async () => true;`); t.tick(1000); t.tick(60000);
  a.close();
});

test("устойчивость: shutdownCallIfActive, восстановление после сбоя, служебные функции запуска", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`mesh.links.set("alice", mkLink()); openCallScreen("alice", "active"); window.__sigs = []; signaling = { connected: true, signal(to, d) { window.__sigs.push(d.t); return true; } };`);
  a.run(`typeof shutdownCallIfActive === "function" && shutdownCallIfActive();`);
  a.run(`typeof showBootRecovery === "function" && showBootRecovery();`); assert.ok(!a.document.getElementById("boot-recovery").classList.contains("hidden"));
  a.close();
});
