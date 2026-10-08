const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

function link(a) {
  return a.run(`(() => { const l = Object.create(PeerLink.prototype); l._log = () => {}; l._closed = false; window.__l = l; return true; })()`) && a.window.__l;
}

test("sendFile: отправляет meta, чанки и done по порядку", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  const sent = [];
  l.dc = { readyState: "open", bufferedAmount: 0 };
  l.send = (p) => { sent.push(p.kind); return true; };
  const ok = await l.sendFile({ id: "f", name: "a", mime: "x/y", size: 3, duration: 2, forwarded: true, caption: "c" }, ["QQ==", "Qg=="], () => {});
  assert.equal(ok, true);
  assert.deepEqual(sent, ["file-meta", "file-chunk", "file-chunk", "file-done"]);
  a.close();
});

test("sendFile: канал закрыт / send вернул false → false", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  l.dc = null;
  assert.equal(await l.sendFile({ id: "f" }, ["a"]), false);
  l.dc = { readyState: "open", bufferedAmount: 0 };
  l.send = () => false;
  assert.equal(await l.sendFile({ id: "f" }, ["a"]), false);
  let n = 0; l.send = () => ++n < 2; // meta ok, первый чанк — отказ
  assert.equal(await l.sendFile({ id: "f" }, ["a"]), false);
  n = 0; l.send = () => ++n < 3; // meta и чанк ok, done — отказ
  assert.equal(await l.sendFile({ id: "f" }, ["a"]), false);
  a.close();
});

test("sendFile: залипший bufferedAmount прерывает отправку по таймауту backpressure", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  l.dc = { readyState: "open", bufferedAmount: 10 * 1024 * 1024 };
  l.send = () => true;
  a.run(`(() => { let t = 0; Date.now = () => (t += 20000); })()`); // каждые вызов — +20 с
  const started = process.hrtime.bigint();
  const ok = await l.sendFile({ id: "f", name: "a", mime: "x/y", size: 1 }, ["QQ=="]);
  assert.equal(ok, false);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e9 < 5, "не должен висеть реальные 30 секунд");
  a.close();
});

test("sendFile: канал закрывается во время ожидания буфера → false", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  l.dc = { readyState: "open", bufferedAmount: 10 * 1024 * 1024 };
  l.send = () => true;
  setTimeout(() => { l.dc.readyState = "closed"; }, 80);
  assert.equal(await l.sendFile({ id: "f", name: "a", mime: "x/y", size: 1 }, ["QQ=="]), false);
  a.close();
});

function fakeTrack(kind) { return { kind, stopped: false, stop() { this.stopped = true; } }; }
function fakeStream(tracks) {
  return { tracks: tracks.slice(),
    getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); },
    addTrack(t) { this.tracks.push(t); },
    removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); } };
}

test("startScreenShare (камера уже есть): localStream получает трек экрана, stop возвращает камеру", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  const cam = fakeTrack("video"), screen = fakeTrack("video");
  const sender = { track: cam, replaced: null, async replaceTrack(t) { this.replaced = t; this.track = t; } };
  l.pc = { getSenders: () => [sender] };
  l.localStream = fakeStream([cam]);
  l.localVideoTrack = cam; l._videoAdded = true;
  l.dispatchEvent = () => true;
  a.window.navigator.mediaDevices = { getDisplayMedia: async () => ({ getVideoTracks: () => [screen], getTracks: () => [screen] }) };
  assert.equal(await l.startScreenShare(), true);
  assert.equal(sender.replaced, screen);
  assert.deepEqual(l.localStream.getVideoTracks(), [screen], "превью (localStream) должно показывать экран, а не камеру");
  assert.equal(await l.startScreenShare(), true, "повторный старт — no-op");
  await l.stopScreenShare();
  assert.deepEqual(l.localStream.getVideoTracks(), [cam]);
  assert.equal(screen.stopped, true);
  await l.stopScreenShare(); // не шарим — no-op
  a.close();
});

test("startScreenShare (камеры нет): трек добавляется, stop убирает сендер", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  const screen = fakeTrack("video");
  const sender = { track: screen };
  a.window.MediaStream = class { constructor() { this.tracks = []; } getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); } addTrack(t) { this.tracks.push(t); } removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); } };
  let removed = 0;
  l.pc = { getSenders: () => [sender], addTrack: () => sender, removeTrack: () => { removed++; } };
  l.localStream = null; l._videoAdded = false;
  l.dispatchEvent = () => true;
  a.window.navigator.mediaDevices = { getDisplayMedia: async () => ({ getVideoTracks: () => [screen], getTracks: () => [screen] }) };
  assert.equal(await l.startScreenShare(), true);
  assert.deepEqual(l.localStream.getVideoTracks(), [screen]);
  await l.stopScreenShare();
  assert.equal(removed, 1);
  assert.equal(l._videoAdded, false);
  a.close();
});

test("startScreenShare: отказ пользователя, нет API, закрытый линк, нет трека", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  l.pc = { getSenders: () => [] };
  a.window.navigator.mediaDevices = { getDisplayMedia: async () => { throw new Error("denied"); } };
  assert.equal(await l.startScreenShare(), false);
  a.window.navigator.mediaDevices = { getDisplayMedia: async () => ({ getVideoTracks: () => [], getTracks: () => [] }) };
  assert.equal(await l.startScreenShare(), false);
  a.window.navigator.mediaDevices = {};
  assert.equal(await l.startScreenShare(), false);
  l._closed = true;
  assert.equal(await l.startScreenShare(), false);
  a.close();
});

test("startScreenShare: onended сам останавливает показ и шлёт событие", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  const cam = fakeTrack("video"), screen = fakeTrack("video");
  const sender = { track: cam, async replaceTrack(t) { this.track = t; } };
  l.pc = { getSenders: () => [sender] };
  l.localStream = fakeStream([cam]); l.localVideoTrack = cam; l._videoAdded = true;
  let ended = false;
  l.dispatchEvent = (ev) => { if (ev.type === "screen-share-ended") ended = true; return true; };
  a.window.navigator.mediaDevices = { getDisplayMedia: async () => ({ getVideoTracks: () => [screen], getTracks: () => [screen] }) };
  await l.startScreenShare();
  screen.onended();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ended, true);
  assert.equal(l._screenSharing, false);
  a.close();
});

test("relay-only: после «ICE connected без DTLS» следующий линк идёт только через TURN, offer несёт rl:1", async () => {
  const a = createApp(); await a.ready;
  a.run(`ICE_SERVERS = [{ urls: ["turn:t.example:3478", "turn:t.example:3478?transport=tcp"], username: "u", credential: "c" }, { urls: "stun:s.example" }];`);
  assert.equal(a.run(`isRelayOnly("bob")`), false);
  a.run(`markRelayOnly("bob")`);
  assert.equal(a.run(`isRelayOnly("bob")`), true);
  assert.equal(a.run(`isRelayOnly("carol")`), false);
  const servers = JSON.parse(JSON.stringify(a.run(`relayCapableServers()`)));
  assert.equal(servers.length, 1, "только TURN-серверы");
  const l = a.run(`(() => { const l = new PeerLink({ id: "bob", localName: "me", role: "offerer" }); window.__rl = l; return l._relayOnly; })()`);
  assert.equal(l, true);
  const offer = await a.window.__rl.createInitialOffer("room");
  assert.equal(offer.rl, 1, "offer помечен rl:1 — собеседник тоже уйдёт на relay");
  a.run(`window.__rl.close()`);
  a.close();
});
