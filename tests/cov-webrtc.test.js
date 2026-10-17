// Покрытие js/webrtc.js: проверка TURN «на месте», фоновая догрузка ICE, обработчики состояния ICE, статистика пары, аудио-диагностика.
const test = require("node:test");
const assert = require("node:assert/strict");
const loose = require("node:assert").deepEqual; // значения из окна jsdom — другой realm
const { closeAll } = require("./harness");
const { boot, fakeTimers, sleep } = require("./cov-helpers");
test.after(closeAll);

test("classifyCandidate: host/srflx/prflx/relay/unknown", async () => {
  const a = await boot();
  assert.equal(a.run(`classifyCandidate("candidate:1 1 udp 1 1.1.1.1 1 typ srflx raddr")`), "srflx");
  assert.equal(a.run(`classifyCandidate("a typ relay b")`), "relay");
  assert.equal(a.run(`classifyCandidate("a prflx b")`), "prflx");
  assert.equal(a.run(`classifyCandidate("a host b")`), "host");
  assert.equal(a.run(`classifyCandidate("ничего")`), "unknown");
  assert.equal(a.run(`classifyCandidate("")`), "unknown");
  assert.equal(a.run(`classifyCandidate(null)`), "unknown");
  a.close();
});

const FAKE_PC = `
class FakePC extends EventTarget {
  constructor(cfg) { super(); this.cfg = cfg; this.iceConnectionState = "new"; FakePC.all.push(this); this.closed = false; }
  createDataChannel() { this.dc = {}; return this.dc; }
  async createOffer() { if (FakePC.mode === "offer-error") throw new Error("offer-boom"); return { type: "offer", sdp: "o" }; }
  async createAnswer() { return { type: "answer", sdp: "a" }; }
  async setLocalDescription() {
    if (FakePC.mode === "open" && this.dc) setTimeout(() => {
      const e = new Event("icecandidate"); e.candidate = { candidate: "candidate:1 1 udp 1 5.5.5.5 3478 typ relay raddr x" }; this.dispatchEvent(e);
      const e2 = new Event("icecandidate"); e2.candidate = { candidate: "candidate:2 1 udp 1 5.5.5.5 3478 typ relay" }; this.dispatchEvent(e2);
      const e3 = new Event("icecandidate"); e3.candidate = null; this.dispatchEvent(e3);
      const ee = new Event("icecandidateerror"); ee.errorCode = 701; ee.errorText = "bad"; this.dispatchEvent(ee);
      if (this.dc.onopen) this.dc.onopen();
    }, 5);
    if (FakePC.mode === "timeout" && this.dc) setTimeout(() => {
      for (let i = 0; i < 5; i++) { const ee = new Event("icecandidateerror"); ee.errorCode = i; this.dispatchEvent(ee); }
    }, 5);
  }
  async setRemoteDescription() {}
  addIceCandidate() { return FakePC.mode === "cand-reject" ? Promise.reject(new Error("x")) : Promise.resolve(); }
  async getStats() { if (FakePC.mode === "stats-error") throw new Error("st"); const m = new Map([["p", { type: "candidate-pair", requestsSent: 3, responsesReceived: 1 }], ["x", { type: "other" }]]); return m; }
  close() { this.closed = true; if (FakePC.mode === "close-error") throw new Error("c"); }
}
FakePC.all = []; FakePC.mode = "open"; window.__realPC = window.RTCPeerConnection; window.RTCPeerConnection = FakePC; window.__FakePC = FakePC;`;

test("etherTurnCheckOne: data channel открылся через relay → open, relay, адрес", async () => {
  const a = await boot();
  a.run(FAKE_PC);
  const r = await a.run(`etherTurnCheckOne("turn:h:3478", "u", "p", 2000)`);
  assert.equal(r.open, true); assert.equal(r.relay, true); assert.equal(r.relayAddr, "5.5.5.5");
  assert.equal(r.error, ""); assert.ok(r.openMs >= 0 && r.relayMs >= 0);
  assert.equal(a.run(`__FakePC.all.every((p) => p.closed)`), true);
  a.close();
});

test("etherTurnCheckOne: канал не открылся → диагностика ICE и ошибки кандидатов (до 3)", async () => {
  const a = await boot();
  a.run(FAKE_PC); a.run(`__FakePC.mode = "timeout"`);
  const r = await a.run(`etherTurnCheckOne("turn:h:3478", "u", "p", 60)`);
  assert.equal(r.open, false);
  assert.match(r.diag, /ice new\/new, пар 1 ↑3 ↓1, пар 1 ↑3 ↓1, ошибки: \?; 1; 2/);
  a.close();
});

test("etherTurnCheckOne: исключение createOffer → error; getStats падает → diag пуст; close бросает — не страшно", async () => {
  const a = await boot();
  a.run(FAKE_PC); a.run(`__FakePC.mode = "offer-error"`);
  let r = await a.run(`etherTurnCheckOne("turn:h:3478", "u", "p", 50)`);
  assert.match(r.error, /offer-boom/); assert.match(r.diag, /^ice new\/new/);
  a.run(`__FakePC.mode = "stats-error"`);
  r = await a.run(`etherTurnCheckOne("turn:h:3478", "u", "p", 30)`);
  assert.equal(r.diag, ""); // getStats бросил — диагностика не собрана, но результат вернулся
  a.run(`__FakePC.mode = "close-error"`);
  r = await a.run(`etherTurnCheckOne("turn:h:3478", "u", "p", 30)`);
  assert.equal(r.open, false);
  // конструктор бросает → a = null, b = null → diag «ice ?/?»
  a.run(`window.RTCPeerConnection = function () { throw new Error("no rtc"); }`);
  r = await a.run(`etherTurnCheckOne("turn:h:3478", "u", "p", 30)`);
  assert.match(r.error, /no rtc/); assert.equal(r.diag, "ice ?/?");
  a.close();
});

test("etherTurnCheck: проверяет только turn(s)-адреса с логином, параллельно", async () => {
  const a = await boot();
  a.run(FAKE_PC);
  a.run(`ICE_SERVERS = [{ urls: ["turn:a:1", "turns:b:2", "stun:c:3"], username: "u", credential: "p" }, { urls: "turn:nologin:1" }, { urls: "turn:d:4", username: "u2" }];
         window.__etherIceReady = Promise.reject(new Error("не готово"));`);
  const res = await a.run(`etherTurnCheck(500)`);
  loose(res.map((x) => x.url).sort(), ["turn:a:1", "turn:d:4", "turns:b:2"]);
  assert.ok(res.every((x) => x.open));
  a.close();
});

test("refreshIceServersInBackground: ретраи с нарастающей паузой, затем ICE_SERVERS обновлён", async () => {
  const a = await boot();
  fakeTimers(a);
  a.run(`window.__calls = 0; window.fetchIceServers = async (t) => { window.__calls++; return window.__calls < 3 ? null : [{ urls: "turn:z:1", username: "u", credential: "p" }]; };
         window.__done = false; refreshIceServersInBackground().then(() => { window.__done = true; });`);
  assert.equal(a.run(`window.__calls`), 0);
  for (const ms of [5000, 10000, 15000]) { a.run(`__fk.tick(${ms})`); await sleep(15); }
  assert.equal(a.run(`window.__calls`), 3);
  await sleep(15);
  assert.equal(a.run(`window.__done`), true);
  assert.equal(a.run(`ICE_SERVERS[0].urls`), "turn:z:1");
  // все 8 попыток неудачны → просто завершается
  a.run(`window.__calls = 0; window.fetchIceServers = async () => { window.__calls++; return null; }; window.__done = false; refreshIceServersInBackground().then(() => { window.__done = true; });`);
  for (let i = 1; i <= 8; i++) { a.run(`__fk.tick(${5000 * i})`); await sleep(15); }
  assert.equal(a.run(`window.__calls`), 8); assert.equal(a.run(`window.__done`), true);
  a.close();
});

function mkLink(a) {
  a.run(`window.__lis = {}; { const P = window.RTCPeerConnection.prototype; const o = P.addEventListener; P.addEventListener = function (t, f, x) { (window.__lis[t] = window.__lis[t] || []).push(f); return o.call(this, t, f, x); }; }
         window.__L = new PeerLink({ id: "peer-abcdefghij", localName: "me", role: "offerer" }); window.__L._log = () => {};
         (() => { const real = window.__L.pc; window.__ov = {}; window.__realpc = real;
           window.__L.pc = new Proxy(real, { get(t, k) { if (k in window.__ov) return window.__ov[k]; const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } }); })();
         ICE_SERVERS = [{ urls: ["turn:t:1"], username: "u", credential: "p" }];`);
  return a.window.__L;
}
function ice(a, state) {
  a.run(`window.__ov.iceConnectionState = ${JSON.stringify(state)}`); a.run(`window.__lis["iceconnectionstatechange"].forEach((f) => f({}))`);
}

test("ICE-состояния: connected → DTLS-таймер (6с) → relay-fallback; disconnected → таймер reInvite 8с; failed → reInvite", async () => {
  const a = await boot();
  fakeTimers(a);
  const l = mkLink(a);
  a.run(`window.__reinv = 0; window.__L.reInvite = () => { window.__reinv++; }; window.__pairs = []; window.__L._logSelectedPair = (r) => window.__pairs.push(r);
         window.__fb = []; window.__L.addEventListener("relay-fallback", (e) => window.__fb.push(e.detail.reason));`);
  // connected: DTLS не завершился за 6с → fallback на relay
  ice(a, "connected");
  assert.ok(l._dtlsWatch);
  ice(a, "completed"); // второй connected не плодит таймеры
  a.run(`__fk.tick(6000)`);
  assert.equal(l._dtlsWatch, null);
  loose(a.run(`window.__fb`), ["dtls-timeout"]);
  // failed до первого соединения → fallback ice-failed + reInvite
  a.run(`window.__L._relayOnly = false; window.__L._everConnected = false;`);
  ice(a, "failed");
  assert.equal(a.run(`window.__reinv`), 1);
  assert.ok(a.run(`window.__pairs`).includes("failed"));
  // disconnected: таймер 8с; при всё ещё disconnected → reInvite; повторный disconnected перезапускает таймер
  a.run(`window.__L._everConnected = true`);
  ice(a, "disconnected"); ice(a, "disconnected");
  assert.ok(l._iceDisconnectTimer);
  a.run(`__fk.tick(8000)`);
  assert.equal(a.run(`window.__reinv`), 2);
  assert.equal(l._iceDisconnectTimer, null);
  // disconnected → затем состояние стало failed к моменту таймера → тоже reInvite
  ice(a, "disconnected");
  a.run(`__ov.iceConnectionState = "failed"; __fk.tick(8000)`);
  assert.equal(a.run(`window.__reinv`), 3);
  // disconnected → восстановились: таймер сброшен; таймер ничего не делает если link закрыт
  ice(a, "disconnected"); ice(a, "connected");
  assert.equal(l._iceDisconnectTimer, null);
  ice(a, "disconnected"); a.run(`__L._closed = true; __fk.tick(8000)`);
  assert.equal(a.run(`window.__reinv`), 3);
  // таймер сработал, но состояние уже "checking" → ничего
  a.run(`__L._closed = false`);
  ice(a, "disconnected");
  a.run(`__ov.iceConnectionState = "checking"; __fk.tick(8000)`);
  assert.equal(a.run(`window.__reinv`), 3);
  a.run(`__L.pc.close()`);
  a.close();
});

test("_logSelectedPair: transport.selectedCandidatePairId, запасной candidate-pair, пустая статистика, исключение", async () => {
  const a = await boot();
  const l = mkLink(a);
  const run = async (stats) => {
    a.run(`window.__L.pc.getStats = async () => { ${stats} }; window.__logs = []; window.__L._log = (...x) => window.__logs.push(x.join(" "));`);
    await a.run(`window.__L._logSelectedPair("failed")`);
    return [l._lastPairInfo, a.run(`window.__logs`)];
  };
  let [info] = await run(`return new Map([["t", { id: "t", type: "transport", selectedCandidatePairId: "p" }], ["p", { id: "p", type: "candidate-pair", localCandidateId: "l", remoteCandidateId: "r", currentRoundTripTime: 0.05, bytesSent: 10, bytesReceived: 20, consentRequestsSent: 2, state: "succeeded" }], ["l", { id: "l", candidateType: "relay", protocol: "udp", relayProtocol: "tls" }], ["r", { id: "r", candidateType: "host", protocol: "udp" }]]);`);
  assert.match(info, /failed: relay\/udp\(tls\) → host\/udp, rtt=50мс, ↑10 ↓20 Б, consent 2, state=succeeded/);
  [info] = await run(`return new Map([["p", { id: "p", type: "candidate-pair", nominated: true, state: "waiting" }]]);`);
  assert.match(info, /failed: \?\/\? → \?\/\?, rtt=\?, ↑0 ↓0 Б, consent 0, state=waiting/);
  [info] = await run(`return new Map();`);
  assert.equal(info, "нет выбранной пары (failed)");
  [info] = await run(`throw new Error("x");`);
  assert.equal(info, "нет выбранной пары (failed)"); // исключение проглочено, прежнее значение не затёрто
  a.run(`__L.pc.close()`);
  a.close();
});

test("setRemoteVolume / audioDebug / allDiagnostics / broadcast", async () => {
  const a = await boot();
  const l = mkLink(a);
  a.run(`document.body.insertAdjacentHTML("beforeend", '<audio id="remote-audio-peer-abcdefghij"></audio>')`);
  l.setRemoteVolume(5); assert.equal(a.run(`document.getElementById("remote-audio-peer-abcdefghij").volume`), 1);
  l.setRemoteVolume("abc"); assert.equal(a.run(`document.getElementById("remote-audio-peer-abcdefghij").volume`), 0);
  l.setRemoteVolume(0.4); assert.equal(a.run(`document.getElementById("remote-audio-peer-abcdefghij").volume`), 0.4);
  a.run(`document.getElementById("remote-audio-peer-abcdefghij").remove()`);
  l.setRemoteVolume(0.5); // элемента нет — без исключения
  assert.match(l.audioDebug(), /^mic нет, трансиверы/);
  a.run(`__L.localAudioTrack = { readyState: "live", muted: true, enabled: false };
         __L.pc.getTransceivers = () => [{ receiver: { track: { kind: "audio" } }, direction: "sendrecv", currentDirection: null, sender: { track: null } }, { receiver: { track: { kind: "video" } } }, { receiver: { track: { kind: "audio" } }, direction: "recvonly", currentDirection: "recvonly", sender: { track: {} } }];`);
  assert.equal(l.audioDebug(), "mic live/muted/off, трансиверы sendrecv>-(без трека) recvonly>recvonly");
  a.run(`__L.pc.getTransceivers = undefined; __L.localAudioTrack = { readyState: "live", muted: false, enabled: true }`);
  assert.equal(l.audioDebug(), "mic live, трансиверы —");
  // MeshManager
  a.run(`window.__M = new MeshManager("me"); const x = { send: (p) => (window.__sent = (window.__sent || []).concat(["x" + p.k])), getDiagnostics: () => ({ d: 1 }), close() {} }; const y = { send: (p) => (window.__sent = (window.__sent || []).concat(["y" + p.k])), getDiagnostics: () => ({ d: 2 }), close() {} };
         __M.links.set("x", x); __M.links.set("y", y);`);
  a.run(`__M.broadcast({ k: 1 }); __M.broadcast({ k: 2 }, "x")`);
  loose(a.run(`window.__sent`), ["x1", "y1", "y2"]);
  loose(a.run(`__M.allDiagnostics()`), [{ d: 1 }, { d: 2 }]);
  a.run(`__L.pc.close()`);
  a.close();
});

test("recoverAudio: заменяет трек в существующем sender и возвращает sendrecv; без трансивера — addTrack; ошибка → false; закрыт → false", async () => {
  const a = await boot();
  const l = mkLink(a);
  a.run(`window.__stopped = 0; window.__newTrack = { enabled: true, stop() {} };
    __L.localAudioTrack = { stop() { window.__stopped++; } };
    __L._ensureLocalAudio = async () => { __L.localAudioTrack = window.__newTrack; __L.localStream = { id: "s" }; };
    __L._tuneSenders = () => { window.__tuned = true; };
    window.__replaced = null; window.__tr = { receiver: { track: { kind: "audio" } }, direction: "recvonly", sender: { replaceTrack: async (t) => { window.__replaced = t; } } };
    __L.pc.getTransceivers = () => [window.__tr];`);
  l._muted = true;
  assert.equal(await l.recoverAudio(), true);
  assert.equal(a.run(`window.__stopped`), 1);
  assert.equal(a.run(`window.__replaced === window.__newTrack`), true);
  assert.equal(a.run(`window.__tr.direction`), "sendrecv");
  assert.equal(a.run(`window.__newTrack.enabled`), false); // был muted
  assert.equal(a.run(`window.__tuned`), true); assert.equal(l._audioAdded, true);
  // нет подходящего трансивера → addTrack
  a.run(`window.__added = null; __L.pc.getTransceivers = () => []; __L.pc.addTrack = (t, s) => { window.__added = [t, s]; };`);
  l._muted = false;
  assert.equal(await l.recoverAudio(), true);
  assert.equal(a.run(`window.__added[0] === window.__newTrack`), true);
  // ошибка getUserMedia → false
  a.run(`__L._ensureLocalAudio = async () => { throw new Error("denied"); }`);
  assert.equal(await l.recoverAudio(), false);
  l._closed = true;
  assert.equal(await l.recoverAudio(), false);
  l._closed = false;
  a.run(`__L.pc.close()`);
  a.close();
});

test("PeerLink: статус disconnected после DISCONNECT_GRACE_MS, connecting сбрасывает таймер; reInvite без открытого канала — пропуск", async () => {
  const a = await boot();
  fakeTimers(a);
  const l = mkLink(a);
  const setConn = (s) => { a.run(`__ov.connectionState = "${s}"`); a.run(`window.__lis["connectionstatechange"].forEach((f) => f({}))`); };
  setConn("disconnected");
  assert.ok(l._discTimer);
  setConn("connecting");
  assert.equal(l._discTimer, null);
  setConn("disconnected");
  a.run(`__fk.tick(60000)`);
  assert.equal(l.status, "disconnected");
  assert.equal(await l.reInvite(), undefined); // dc нет → логируем и выходим
  a.run(`__L.pc.close()`);
  a.close();
});
