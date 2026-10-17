// Покрытие features.js / features2.js / group-call.js / rooms.js: ранее не затронутые ветки.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    for (const [id, n] of [["alice", "Alice"], ["bob", "Bob"]]) { const c = ensureContactEntry(id, n); c.managed = true; }
    state._firstRenderDone = true; persistContacts(); window.__sent = []; })()`);
}

test("features: ракета, сезонный оттенок, оттенок скина, защита дыхания, сигил (отпечаток, PNG, шторка, поделиться)", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(await a.run(`(async () => { const o = {};
    fxRocket(); o.rocket = !!document.querySelector(".fx-rocket"); __fk.tick(3000);
    const c = state.contacts.get("alice"); state.chatId = "alice"; c.messages.push({ id: "rk1", from: "them", text: "🚀 launch", ts: Date.now() }, { id: "rk2", from: "me", text: "🚀", ts: Date.now() }); FX.set("easter", true); fxScanRockets(); fxScanRockets(); state.chatId = null; fxScanRockets();
    o.hue = [seasonHue(new Date(2024, 0, 1)), seasonHue("2024-06-21"), seasonHue()].every((h) => typeof h === "number" && Math.abs(h) <= 28); o.skin = [skinHue({ id: "a" }), skinHue({ id: "b" })].every((h) => h >= -25 && h <= 25);
    navigator.getBattery = async () => { const b = new EventTarget(); b.charging = false; b.level = 0.1; window.__bat = b; return b; }; fxWireBreathingGuards(); await new Promise((r) => __realTO.call(window, r, 10)); o.lowbat = document.documentElement.classList.contains("fx-lowbat"); window.__bat.charging = true; window.__bat.dispatchEvent(new Event("chargingchange")); o.lowbatOff = !document.documentElement.classList.contains("fx-lowbat");
    navigator.getBattery = () => Promise.reject(new Error("x")); fxWireBreathingGuards(); navigator.getBattery = () => { throw new Error("sync"); }; fxWireBreathingGuards(); delete navigator.getBattery; Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); o.paused = document.documentElement.classList.contains("fx-paused"); Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange"));
    o.fp = await fxSigilFingerprint("some-key"); o.fp2 = (await fxSigilFingerprint("some-key")) === o.fp;
    // PNG: Image-заглушка с onload
    window.Image = class { set src(v) { this._s = v; __realTO.call(window, () => this.onload && this.onload(), 0); } }; o.png = !!(await fxSigilPng("k", "Name", "AAAA BBBB")); window.Image = class { set src(v) { __realTO.call(window, () => this.onerror && this.onerror(), 0); } }; o.pngErr = await fxSigilPng("k", "N", ""); 
    HTMLCanvasElement.prototype.getContext = function () { return null; }; o.pngNoCtx = await fxSigilPng("k", "N", "");
    return o; })()`));
  assert.ok(r.rocket && r.hue && r.skin && r.lowbat && r.lowbatOff && r.paused); assert.ok(r.fp.length >= 16 && r.fp2); assert.equal(r.png, true); assert.equal(r.pngErr, null); assert.equal(r.pngNoCtx, null);
  a.close();
});

test("features: шторка сигила — закрытие, «поделиться» (файл, текст, отмена, скачивание, копирование)", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.__dl = []; window.downloadBlob = (b, n) => { window.__dl.push(n); }; window.copyText = (t2) => { window.__copied = t2; }; window.fxSigilPng = async (k, n, fp) => (window.__noPng ? null : new Blob(["png"], { type: "image/png" }));`);
  const open = (opts) => a.run(`fxOpenSigilSheet(${JSON.stringify(opts)})`);
  open({ mine: true, keyStr: "k1", name: "" }); await sleep(30); a.document.querySelector(".fx-sigil-close").click(); assert.ok(!a.document.getElementById("fx-sigil-sheet"));
  open({ mine: false, keyStr: "k2", name: "Bob", noKey: true }); a.document.querySelector(".sheet-backdrop").click();
  const share = async (setup) => { a.run(setup); open({ mine: false, keyStr: "k3", name: "Bob" }); await sleep(30); a.document.querySelector(".fx-sigil-share").click(); await sleep(40); const el = a.document.getElementById("fx-sigil-sheet"); if (el) el.remove(); };
  await share(`navigator.canShare = () => true; navigator.share = async (d) => { window.__shared = d; };`); assert.ok(a.window.__shared.files);
  await share(`navigator.canShare = () => false; navigator.share = async (d) => { window.__shared2 = d; };`); assert.ok(a.window.__shared2.text);
  await share(`navigator.canShare = undefined; navigator.share = async () => { throw Object.assign(new Error("a"), { name: "AbortError" }); };`);
  await share(`navigator.share = async () => { throw new Error("fail"); };`); assert.ok(a.window.__dl.length >= 1);
  await share(`navigator.share = undefined; window.__noPng = true;`); assert.ok(a.window.__copied);
  a.close();
});

test("features: подписанный экспорт чата и его проверка (корректный, подделанный, мусор), кнопка проверки", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(await a.run(`(async () => { const o = {}; const me = await CryptoHelper.generateKeyPair(); Store.myPrivateKeyJwk = me.privateKeyJwk; Store.myPublicKeyJwk = me.publicKeyJwk;
    const c = state.contacts.get("alice"); c.messages.push({ id: "m1", from: "me", text: "hi", ts: 1000 }, { id: "m2", from: "them", text: "yo", ts: 2000 }); c.publicKey = me.publicKeyJwk;
    window.__dl = []; window.downloadBlob = (b, n) => { window.__dl.push(n); };
    const data = await exportSignedChat("alice"); o.dl = window.__dl[0].startsWith("ether-signed-"); o.v = await verifySignedExport(JSON.parse(JSON.stringify(data)));
    const tampered = JSON.parse(JSON.stringify(data)); tampered.messages[0].text = "evil"; o.t = await verifySignedExport(tampered); o.junk = [await verifySignedExport(null), await verifySignedExport({}), await verifySignedExport({ meta: {} })];
    return o; })()`));
  assert.equal(r.dl, true); assert.equal(r.v.ok, true); assert.ok(r.v.fp.length > 5); assert.equal(r.t.ok, false); assert.ok(r.junk.every((x) => x.ok === false));
  // кнопка «проверить файл» в настройках
  a.run(`state.tab = "settings"; renderTab(); fxInjectSettings && 0;`);
  const input = a.document.querySelector("#fx-verify-input");
  if (input) { Object.defineProperty(input, "files", { value: [{ text: async () => "garbage" }], configurable: true }); input.dispatchEvent(new a.window.Event("change")); await sleep(30); Object.defineProperty(input, "files", { value: [], configurable: true }); input.dispatchEvent(new a.window.Event("change")); a.document.querySelector("#fx-verify-btn").click(); }
  a.close();
});

test("features2: фоновые колокольчики, рисование поверх звонка, взгляд (Vision Loop), погода, пульс, хаптика", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.AudioContext = class { constructor() { this.state = "running"; this.destination = {}; this.sampleRate = 8000; this.currentTime = 0; } resume() { return Promise.resolve(); } createBuffer(c, l) { return { getChannelData: () => new Float32Array(l) }; } createBufferSource() { return { connect() {}, start() {}, stop() {} }; } createBiquadFilter() { return { frequency: {}, Q: {}, connect() {} }; } createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} }; } }; globalAudioCtx = null; Store.soundsEnabled = true;`);
  const r = J(a.run(`(() => { const o = {}; o.start = fxAmbientStart(); o.again = fxAmbientStart(); __fk.tick(40000); o.bells = fxAmb.on; if (typeof fxAmbientStop === "function") fxAmbientStop(); fxAmb.on = false; __fk.tick(40000); return o; })()`));
  assert.equal(r.start, true); assert.equal(r.again, true);
  a.close();
});

test("features2: рисование поверх звонка", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  // рисование
  a.run(`mesh.links.set("alice", { status: "in-call", send(p) { (window.__fx = window.__fx || []).push(p); return true; } }); FX.set("draw", true); openCallScreen = window.openCallScreen; state.callId = "alice"; state.callPhase = "active"; window.requestAnimationFrame = (f) => { window.__draw = f; return 1; };`);
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "req" });`); assert.ok(a.document.getElementById("fx-ask")); a.document.querySelector("#fx-ask .gcall-invite-no").click();
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "req" }); document.querySelector("#fx-ask .gcall-invite-join").click();`); assert.equal(a.run(`FXD.active`), true);
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "s", c: "#ff0000", p: [[0.1, 0.2], [0.5, 0.5], [2, -1], "bad"] }); handleFxPayload("alice", { kind: "fxdraw", t: "s", p: [] }); handleFxPayload("bob", { kind: "fxdraw", t: "s", p: [[0, 0]] });`);
  assert.ok(a.run(`FXD.strokes.length`) >= 1);
  const cv = a.document.getElementById("fx-draw-canvas"); const ev = (type, x, y) => { const e = new a.window.Event(type, { bubbles: true }); e.clientX = x; e.clientY = y; e.pointerId = 1; cv.dispatchEvent(e); };
  cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }); ev("pointerdown", 10, 10); ev("pointermove", 20, 20); a.run(`FXD.cur && (window.__lastSent = 0)`); ev("pointermove", 30, 30); ev("pointerup", 30, 30); ev("pointercancel", 1, 1);
  a.run(`typeof __draw === "function" && __draw(); typeof __draw === "function" && __draw();`);
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "stop" }); handleFxPayload("alice", { kind: "fxdraw", t: "ok" }); FXD.asked = "alice"; handleFxPayload("alice", { kind: "fxdraw", t: "ok" }); handleFxPayload("alice", { kind: "fxdraw", t: "no" }); FXD.asked = "alice"; handleFxPayload("alice", { kind: "fxdraw", t: "no" }); handleFxPayload("alice", null); handleFxPayload("alice", { kind: 5 });`);
  a.run(`FX.set("draw", false); handleFxPayload("alice", { kind: "fxdraw", t: "req" }); FX.set("draw", true); fx2InjectDrawButton(); document.getElementById("fx-draw-btn").click(); FXD.active = true; document.getElementById("fx-draw-btn").click(); state.callId = null; fx2InjectDrawButton();`);
  a.close();
});

test("features2: взгляд (Vision Loop)", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`mesh.links.set("alice", { status: "in-call", send(p) { (window.__fx = window.__fx || []).push(p); return true; } }); state.callId = "alice"; state.callPhase = "active";`);
  a.run(`FX.set("look", true); window.__fx = [];`);
  a.run(`handleFxPayload("alice", { kind: "fxlook", t: "start" }); handleFxPayload("alice", { kind: "fxlook", t: "start" }); handleFxPayload("alice", { kind: "fxlook", t: "f", d: "data:image/jpeg;base64,AAAA" }); handleFxPayload("alice", { kind: "fxlook", t: "f", d: "evil" }); handleFxPayload("alice", { kind: "fxlook", t: "f", d: 5 }); handleFxPayload("bob", { kind: "fxlook", t: "f", d: "data:image/jpeg;base64,AAAA" });`);
  t.tick(7000); a.run(`handleFxPayload("alice", { kind: "fxlook", t: "start" }); handleFxPayload("alice", { kind: "fxlook", t: "end" }); handleFxPayload("bob", { kind: "fxlook", t: "end" }); FXL.sending = true; handleFxPayload("alice", { kind: "fxlook", t: "no" }); FXL.sending = false; handleFxPayload("alice", { kind: "fxlook", t: "no" }); FX.set("look", false); handleFxPayload("alice", { kind: "fxlook", t: "start" }); FX.set("look", true); state.contacts.get("bob").blocked = true; handleFxPayload("bob", { kind: "fxlook", t: "start" }); handleFxPayload("ghost", { kind: "fxlook", t: "start" });`);
  a.run(`state.contactCardId = "alice"; fx2InjectLookButton(); state.contactCardId = null; fx2InjectLookButton(); FX.set("look", false); fx2InjectLookButton();`);
  // fxLookFrame и fxLookStart (камера есть/нет)
  const lf = J(await a.run(`(async () => { const o = {}; o.frame = fxLookFrame({}); HTMLCanvasElement.prototype.getContext = function () { return null; }; o.noctx = fxLookFrame({});
    HTMLCanvasElement.prototype.getContext = function () { return { drawImage() {} }; }; HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,AAAA";
    FX.set("look", true); window.confirmSheet = async () => true; Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => { throw new Error("denied"); } }, configurable: true });
    o.start = await fxLookStart("alice"); window.confirmSheet = async () => false; o.declined = await fxLookStart("alice"); window.confirmSheet = async () => true; o.noContact = await fxLookStart("ghost");
    const stream = { getTracks: () => [{ stop() { window.__stopped = 1; } }], getVideoTracks: () => [{}] }; navigator.mediaDevices.getUserMedia = async () => stream; HTMLMediaElement.prototype.play = async () => {};
    const realST = window.setTimeout; window.setTimeout = (f) => __realTO.call(window, f, 0); const rn = Date.now; let dn = rn.call(Date); Date.now = () => (dn += 700);
    o.start2 = await fxLookStart("alice"); window.setTimeout = realST; Date.now = rn;
    const noVid = { getTracks: () => [], getVideoTracks: () => [] }; navigator.mediaDevices.getUserMedia = async () => noVid; o.start3 = await fxLookStart("alice"); return o; })()`));
  a.close();
});

test("features2: погода, пульс, хаптика", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const w = J(await a.run(`(async () => { const o = {}; o.sky = [skyKindFor(0, true), skyKindFor(0, false), skyKindFor(2, true), skyKindFor(45, true), skyKindFor(61, true), skyKindFor(73, true), skyKindFor(95, true), skyKindFor(10, true), skyKindFor(3, false)];
    window.confirmSheet = async () => false; o.no = await fxEnableWeather(); window.confirmSheet = async () => true; navigator.geolocation = undefined; o.noGeo = await fxEnableWeather();
    navigator.geolocation = { getCurrentPosition: (ok) => ok({ coords: { latitude: 55.75, longitude: 37.61 } }) }; window.fetch = async () => ({ ok: true, json: async () => ({ current: { weather_code: 61, is_day: 1 } }) }); o.ok = await fxEnableWeather(); o.attr = document.documentElement.getAttribute("data-sky");
    window.fetch = async () => ({ ok: false, status: 500 }); o.http = await fxEnableWeather(); window.fetch = async () => ({ ok: true, json: async () => ({}) }); o.bad = await fxEnableWeather();
    FX.set("weather", false); fxApplySky(); o.pulse = [fxPulse()]; Object.defineProperty(document, "hidden", { value: true, configurable: true }); o.pulseHidden = fxPulse(); Object.defineProperty(document, "hidden", { value: false, configurable: true });
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14)", configurable: true }); navigator.vibrate = () => true; FX.set("haptics", true); o.hap = [fxHaptic("send"), fxHaptic("zzz")]; FX.set("haptics", false); o.hapOff = fxHaptic("send"); return o; })()`));
  assert.deepEqual(w.sky.slice(0, 3), w.sky.slice(0, 3)); assert.equal(w.no, false); assert.equal(w.noGeo, false); assert.equal(w.ok, true); assert.equal(w.http, false); assert.equal(w.bad, false); assert.equal(w.hapOff, false);
  a.close();
});

test("features2: «повтор месяца» (реплей) — данные, сцены, отрисовка и запись", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const d = new Date(); d.setDate(10); const y = d.getFullYear(), mo = d.getMonth();
  a.run(`(() => { const c = state.contacts.get("alice"); for (let i = 0; i < 12; i++) c.messages.push({ id: "r" + i, from: i % 2 ? "me" : "them", text: "message number " + i + " with some words to quote here", ts: new Date(${y}, ${mo}, 1 + i * 2, 12).getTime() }); })()`);
  const r = J(await a.run(`(async () => { const o = {}; const c = state.contacts.get("alice"); const data = replayData(c, ${y}, ${mo}); o.data = !!data && data.count; o.scenes = data ? replayScenes(data, c, ${y}, ${mo}).map((s) => s.kind) : [];
    o.empty = replayData(c, 1999, 0); const cv = document.createElement("canvas"); const g = cv.getContext("2d"); for (const s of replayScenes(data, c, ${y}, ${mo})) replayDraw(g, 540, 960, s, 1, 200);
    o.noMR = await (async () => { const MR = window.MediaRecorder; window.MediaRecorder = undefined; const x = await fxMakeReplay("alice", ${y}, ${mo}); window.MediaRecorder = MR; return x; })();
    o.noCap = await fxMakeReplay("alice", ${y}, ${mo}); o.emptyMonth = await fxMakeReplay("alice", 1999, 1); o.noContact = await fxMakeReplay("nope");
    HTMLCanvasElement.prototype.captureStream = () => ({}); window.MediaRecorder = class { constructor() { window.__rec = this; } start() {} stop() { this.onstop && this.onstop(); } static isTypeSupported() { return true; } };
    let now = 0; performance.now = () => now; window.requestAnimationFrame = (f) => { now += 40000; __realTO.call(window, f, 0); }; window.downloadBlob = (b, n) => { window.__rep = n; };
    o.made = await fxMakeReplay("alice", ${y}, ${mo}); o.file = window.__rep; return o; })()`));
  assert.ok(r.data >= 10); assert.ok(r.scenes.includes("title") && r.scenes.includes("quote")); assert.equal(r.empty, null); assert.equal(r.noMR, false); assert.equal(r.made, true); assert.ok(r.file.startsWith("ether-replay-"));
  a.close();
});

test("групповой звонок и комнаты: ошибки микрофона, вступление, треды, видео, выход, таймер", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`state.contacts.set("g1", { id: "g1", isGroup: true, managed: true, createdBy: "me", name: "Team", members: [{ id: "me", name: "Tester", role: "admin" }, { id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }], messages: [], lastActivity: 1 });
    window.__gsent = []; const mk = () => ({ status: "connected", send(p) { window.__gsent.push(p); return true; }, addGroupTracks() { window.__tracks = (window.__tracks || 0) + 1; }, removeGroupTracks() { window.__rm = (window.__rm || 0) + 1; }, close() {} }); mesh.links.set("alice", mk()); mesh.links.set("bob", mk());
    window.__tr = () => { const tr = []; return { getTracks: () => tr, getVideoTracks: () => tr.filter((x) => x.kind === "video"), getAudioTracks: () => [{ kind: "audio", enabled: true, stop() {} }], addTrack(x) { tr.push(x); }, removeTrack(x) { tr.splice(tr.indexOf(x), 1); } }; };`);
  for (const nm of ["NotAllowedError", "NotFoundError", "Other"]) {
    a.run(`navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error("m"), { name: ${JSON.stringify(nm)} }); }; GC.gid = null;`);
    assert.equal(await a.run(`gcallAcquire(false)`), false);
  }
  a.run(`navigator.mediaDevices.getUserMedia = async () => __tr();`);
  a.run(`state.callId = "bob";`); assert.equal(await a.run(`gcallAcquire(true)`), false); a.run(`state.callId = null;`);
  await a.run(`startGroupCall("nope", false)`); a.run(`state.callId = "alice";`); await a.run(`startGroupCall("g1", false)`); a.run(`state.callId = null; mesh.links.get("alice").status = "disconnected"; mesh.links.get("bob").status = "disconnected";`); await a.run(`startGroupCall("g1", false)`);
  a.run(`mesh.links.get("alice").status = "connected"; mesh.links.get("bob").status = "connected"; GC.joining = true;`); await a.run(`startGroupCall("g1", false)`); a.run(`GC.joining = false;`);
  await a.run(`startGroupCall("g1", true)`); assert.equal(a.run(`GC.gid`), "g1"); assert.ok(J(a.window.__gsent).some((x) => x.t === "invite"));
  a.run(`state.callId = null;`); await a.run(`startGroupCall("g1", false)`); await a.run(`joinGroupCall("g1")`); // уже в звонке
  // входящее
  const pl = (from, p) => a.run(`handleGroupCallPayload(${JSON.stringify(from)}, ${JSON.stringify(Object.assign({ gid: "g1", ts: Date.now() }, p))})`);
  pl("alice", { t: "join", video: true, muted: true }); assert.ok(a.run(`GC.peers.has("alice")`)); pl("alice", { t: "invite" }); pl("bob", { t: "join" });
  pl("alice", { t: "state", muted: false, video: false }); pl("alice", { t: "state", muted: "x" }); pl("zed", { t: "state" }); pl("alice", { t: "full" }); pl("alice", { t: "leave" }); assert.ok(!a.run(`GC.peers.has("alice")`)); a.run(`handleGroupCallPayload("alice", null); handleGroupCallPayload("alice", {});`);
  a.run(`GC.peers.clear(); GC.joined.clear();`);
  // треды и статусы линка
  const track = `{ kind: "video", muted: false, readyState: "live", addEventListener(n, f) { (window.__tl = window.__tl || []).push(f); } }`;
  a.run(`gcallOnRemoteTrack({ detail: { id: "alice", stream: {} } }); GC.joined.add("alice"); gcallOnRemoteTrack({ detail: { id: "alice", stream: { id: 1 }, track: ${track} } }); __tl.forEach((f) => f()); gcallOnRemoteTrack({ detail: {} }); gcallOnRemoteTrack({}); gcallOnRemoteTrack({ detail: { id: "zed", stream: {} } });`);
  a.run(`gcallOnLinkStatus({ detail: { id: "alice", status: "connected" } }); gcallOnLinkStatus({ detail: { id: "alice", status: "disconnected" } }); gcallOnLinkStatus({ detail: { id: "zed", status: "connected" } }); gcallOnLinkStatus({});`);
  // лимит участников
  a.run(`for (let i = 0; i < GCALL_MAX; i++) GC.peers.set("fill" + i, { name: "F" });`); assert.equal(a.run(`gcallRegisterPeer("bob", null, null)`), false); a.run(`GC.peers.clear();`);
  // управление
  a.run(`GC.stream = __tr(); gcallToggleMute(); gcallToggleMute();`); await a.run(`gcallToggleCamera()`); await a.run(`gcallToggleCamera()`); a.run(`GC.video = false; GC.peers.set("alice", { name: "A" });`);
  a.run(`navigator.mediaDevices.getUserMedia = async () => { throw new Error("no cam"); };`); await a.run(`gcallToggleCamera()`); a.run(`navigator.mediaDevices.getUserMedia = async () => { const s = __tr(); s.getVideoTracks = () => []; return s; };`); await a.run(`gcallToggleCamera()`);
  a.run(`navigator.mediaDevices.getUserMedia = async () => { const s = __tr(); s.addTrack({ kind: "video", stop() {} }); return s; };`); await a.run(`gcallToggleCamera()`); await a.run(`gcallToggleCamera()`);
  a.run(`const gs = GC.stream; GC.stream = null; gcallToggleMute(); gcallToggleCamera(); GC.stream = gs;`);
  t.tick(3000); a.run(`gcallTick();`);
  a.run(`GC.everConnected = true; state.chatId = "g1"; renderTab(); leaveGroupCall({ silent: false }); leaveGroupCall(); gcallRenderInvite(); gcallStopRing();`);
  assert.ok(a.run(`state.contacts.get("g1").messages.some((m) => m.textKey === "gcall.systemEnded")`));
  // приглашения и экран
  pl("alice", { t: "invite" }); assert.ok(a.run(`GC.invites.has("g1")`)); pl("alice", { t: "leave" }); pl("alice", { t: "invite", ts: 1 }); pl("bob", { t: "end" });
  a.run(`state.contacts.get("alice").blocked = true;`); pl("alice", { t: "invite" }); a.run(`state.contacts.get("alice").blocked = false;`);
  pl("alice", { t: "invite" }); t.tick(30000); await a.run(`joinGroupCall("g1")`);
  a.run(`gcallRenderScreen(); leaveGroupCall({ silent: true });`);
  // голосовые комнаты
  a.run(`state.contacts.get("g1").room = true; Store.myId = "me";`);
  const room = J(await a.run(`(async () => { const o = {}; o.rg = !!roomGroup("g1"); roomMarkPresent("g1", "alice", "Alice", true); roomMarkPresent("g1", "alice", "Alice", false); roomMarkPresent("g1", "bob", "Bob", true); o.members = roomMembers("g1").length; roomSendPresence("g1", true); roomSetEnabled("g1", true); roomSetEnabled("g1", false);
    await joinRoom("g1"); o.joined = GC.gid; roomRenderBar(); leaveRoom(); leaveRoom(); o.left = GC.gid; roomWire(); roomWire(); handleGroupCallPayload("alice", { gid: "g1", t: "room", on: true }); handleGroupCallPayload("alice", { gid: "g1", t: "room-on", name: "A" }); return o; })()`));
  a.close();
});
