// V.87: большие вложения в группы одним зашифрованным блобом; групповой звонок через SFU с шифрованием кадров.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

function fakeSignaling(a, features) {
  a.run(`(() => { const s = new EventTarget(); s.connected = true; s.registered = true; s.features = ${JSON.stringify(features)}; s.sent = [];
    s.send = (t, p) => { s.sent.push([t, p]); if (t === "blob-ticket") setTimeout(() => s.dispatchEvent(new CustomEvent("blob-ticket", { detail: { rid: p.rid, id: "a".repeat(32), token: "tok" } })), 0); return true; };
    signaling = s; window.__sig = s; if (typeof p87WireSignaling === "function") p87WireSignaling(s); })()`);
}

test("группа: файл 3 МБ уходит одним зашифрованным блобом, участникам — только ссылка с ключом; получатель расшифровывает", async () => {
  const a = await boot();
  fakeSignaling(a, ["blob"]);
  a.run(`(() => { window.__uploads = []; window.fetch = async (url, o) => { window.__uploads.push([url, o && o.method, o && o.body && o.body.byteLength]); window.__ct = o && o.body; return { status: 201, ok: true }; };
    window.effectiveSignalingUrl = () => "wss://relay.example.org"; window.serverEntries = () => [{ url: "wss://relay.example.org" }];
    const g = ensureContactEntry("grp1", "Группа"); g.isGroup = true; g.members = [{ id: Store.myId, name: "Я" }, { id: "bob", name: "Bob" }, { id: "eve", name: "Eve" }];
    window.__q = []; window.trySendOrQueue = async (c, id, p) => { window.__q.push([c.id, p]); }; state._firstRenderDone = true; })()`);
  await a.run(`(async () => { const u = new Uint8Array(3 * 1024 * 1024); u[5] = 42; await sendFileMessage("grp1", new File([u], "big.bin", { type: "application/octet-stream" }), {}); })()`);
  const up = J(a.run(`window.__uploads`));
  assert.equal(up.length, 1, "один загруженный блоб на всю группу");
  assert.match(up[0][0], /^https:\/\/relay\.example\.org\/blob\/a{32}\?t=tok$/); assert.equal(up[0][1], "PUT");
  assert.equal(up[0][2], 3 * 1024 * 1024 + 16, "шифртекст = файл + тег GCM");
  const q = J(a.run(`window.__q.map(([id, p]) => [id, p.kind, !!p.dataB64, p.blob && p.blob.id, p.size])`));
  assert.deepEqual(q.map((x) => x[0]).sort(), ["bob", "eve"]);
  assert.ok(q.every((x) => x[1] === "file" && x[2] === false && x[3] === "a".repeat(32) && x[4] === 3 * 1024 * 1024));
  // получатель: скачивает со своего сервера и расшифровывает; чужой адрес не принимается
  const r = await boot();
  r.run(`(() => { window.effectiveSignalingUrl = () => "wss://relay.example.org"; window.serverEntries = () => [{ url: "wss://relay.example.org" }]; })()`);
  const payload = J(a.run(`window.__q[0][1]`));
  const ctB64 = a.run(`arrayBufferToBase64(window.__ct)`);
  r.run(`window.__ctb = base64ToUint8Array(${JSON.stringify(ctB64)}); window.fetch = async (url) => ({ ok: true, arrayBuffer: async () => window.__ctb.buffer });`);
  const ok = J(await r.run(`hydrateBlobPayload(${JSON.stringify(payload)}).then((p) => p && { len: base64ToUint8Array(p.dataB64).length, b5: base64ToUint8Array(p.dataB64)[5], blob: p.blob })`));
  assert.deepEqual(ok, { len: 3 * 1024 * 1024, b5: 42 });
  const evil = Object.assign({}, payload, { blob: Object.assign({}, payload.blob, { u: "https://tracker.example.net" }) });
  assert.equal(await r.run(`hydrateBlobPayload(${JSON.stringify(evil)})`), null, "чужой сервер в ссылке не используется");
  const badKey = Object.assign({}, payload, { blob: Object.assign({}, payload.blob, { k: btoa("x".repeat(32)) }) });
  assert.equal(await r.run(`hydrateBlobPayload(${JSON.stringify(badKey)}).catch(() => null)`), null, "чужой ключ — не расшифровывается");
  a.close(); r.close();
});

test("без поддержки блобов на сервере — прежний потолок 1 МБ", async () => {
  const a = await boot();
  fakeSignaling(a, []);
  a.run(`(() => { const g = ensureContactEntry("grp2", "G"); g.isGroup = true; g.members = [{ id: Store.myId }, { id: "bob" }]; window.__toasts = []; window.toast = (t) => window.__toasts.push(t); })()`);
  await a.run(`sendFileMessage("grp2", new File([new Uint8Array(1500000)], "x.bin"), {})`);
  assert.ok(J(a.run(`window.__toasts`)).length >= 1);
  a.close();
});

test("SFU: выбор режима, вход по sfu-join, ответ на предложение сервера с отправкой своих треков, откат к сетке при отказе", async () => {
  const a = await boot();
  fakeSignaling(a, ["sfu"]);
  a.run(`(() => { const g = ensureContactEntry("big", "Big"); g.isGroup = true; g.members = Array.from({ length: 8 }, (_, i) => ({ id: i ? "m" + i : Store.myId, name: "m" + i }));
    window.p86FrameE2EESupported = () => true; })()`);
  assert.equal(a.run(`sfuWanted(state.contacts.get("big"))`), true);
  a.run(`localStorage.setItem("ether.sfuMode", "off")`); assert.equal(a.run(`sfuWanted(state.contacts.get("big"))`), false);
  a.run(`localStorage.setItem("ether.sfuMode", "auto"); window.p86FrameE2EESupported = () => false;`);
  assert.equal(a.run(`sfuWanted(state.contacts.get("big"))`), false, "без шифрования кадров через сервер не звоним");
  a.run(`window.p86FrameE2EESupported = () => false;`);
  // предложение сервера: свои треки на «вверх», остальное на приём; ответ уходит серверу
  a.run(`(() => {
    class T { constructor(mid) { this.mid = mid; this.direction = "recvonly"; this.sender = { track: null, replaceTrack: async (t) => { this.sender.track = t; } }; this.receiver = {}; } }
    window.RTCPeerConnection = class { constructor() { this.t = [new T("0"), new T("1"), new T("2"), new T("3")]; this.iceGatheringState = "complete"; this.localDescription = null; }
      addEventListener() {} getTransceivers() { return this.t; } async setRemoteDescription(d) { this.remote = d; } async createAnswer() { return { type: "answer", sdp: "v=0 answer" }; }
      async setLocalDescription(d) { this.localDescription = d; } close() {} };
    window.fetchIceServers = async () => [];
    GC.gid = "big"; GC.sfu = true; GC.joined = new Set(); GC.peers = new Map();
    GC.stream = { getTracks: () => [{ kind: "audio", id: "mic" }, { kind: "video", id: "cam" }] }; })()`);
  const ok = await a.run(`sfuOnOffer({ gid: "big", sdp: "v=0 offer", up: { audio: "0", video: "1" }, map: [{ mid: "2", from: "m1", kind: "audio" }, { mid: "3", from: "m1", kind: "video" }] })`);
  assert.equal(ok, true);
  const st = J(a.run(`SFU.pc.t.map((t) => [t.mid, t.direction, t.sender.track && t.sender.track.id])`));
  assert.deepEqual(st, [["0", "sendonly", "mic"], ["1", "sendonly", "cam"], ["2", "recvonly", null], ["3", "recvonly", null]]);
  assert.deepEqual(J(a.run(`__sig.sent.filter((x) => x[0] === "sfu-answer").map((x) => x[1])`)), [{ gid: "big", sdp: "v=0 answer" }]);
  assert.equal(a.run(`SFU.map.get("3")`), "m1");
  // отказ сервера — назад к сетке
  a.run(`__sig.dispatchEvent(new CustomEvent("sfu-joined", { detail: { gid: "big", error: "full" } }))`);
  assert.equal(a.run(`GC.sfu`), false); assert.equal(a.run(`SFU.pc`), null);
  a.close();
});

test("запечатанный отправитель: ключ доступа, печать и вскрытие, отправка с анонимного соединения, чужое отбрасывается", async () => {
  const a = await boot(), b = await boot();
  const ak = a.run(`sealedAccessKey()`); assert.match(ak, /^[A-Za-z0-9+/]{22}==$/); assert.equal(a.run(`sealedAccessKey()`), ak, "ключ постоянный");
  // b знает ключ a; a — получатель
  const aPub = J(a.run(`Store.myPublicKeyJwk`)), aId = a.run(`Store.myId`), bId = b.run(`Store.myId`);
  b.run(`(() => { const c = ensureContactEntry(${JSON.stringify(aId)}, "A"); c.managed = true; c.publicKey = ${JSON.stringify(aPub)}; c.ak = ${JSON.stringify(ak)}; })()`);
  const sealed = await b.run(`sealFor(state.contacts.get(${JSON.stringify(aId)}), { from: Store.myId, msgId: "m1", envelope: { v: 2, h: {}, ct: "x" }, kind: "chat" })`);
  assert.ok(!sealed.includes(bId), "в запечатанном виде id отправителя не виден");
  const inner = J(await a.run(`unseal(${JSON.stringify(sealed)})`));
  assert.equal(inner.from, bId); assert.equal(inner.msgId, "m1");
  assert.equal(await b.run(`unseal(${JSON.stringify(sealed)}).then(() => "opened", () => "closed")`), "closed", "вскрыть может только получатель");
  // вскрытое уходит в обычную обработку только от известного контакта
  a.run(`window.__d = []; window.handleDeliver = (d) => { window.__d.push(d); }; window.__acks = []; window.__sig = { send: (t, p) => { window.__acks.push([t, p]); } };`);
  assert.equal(await a.run(`onSealed(__sig, { msgId: "m1", s: ${JSON.stringify(sealed)} })`), false, "незнакомый отправитель — отброшено и подтверждено");
  assert.deepEqual(J(a.run(`window.__acks`)), [["mailbox-ack", { msgId: "m1" }]]);
  a.run(`ensureContactEntry(${JSON.stringify(bId)}, "B")`);
  assert.equal(await a.run(`onSealed(__sig, { msgId: "m1", s: ${JSON.stringify(sealed)}, queued: true })`), true);
  assert.deepEqual(J(a.run(`window.__d.map((d) => [d.from, d.msgId, d.kind, d.queued, d.sealed])`)), [[bId, "m1", "chat", true, true]]);
  // отправка: deliver() идёт через анонимный сокет, при отказе — обычным путём
  b.run(`(() => { window.__anon = []; window.anonSend = async (o) => { window.__anon.push(o); return {}; };
    const s = new SignalingClient("wss://x.invalid", Store.myId, {}); s.features = ["sealed"]; s.registered = true; window.__orig = []; s.send = (t, p) => { window.__orig.push(t); return true; };
    window.__acked = []; s.addEventListener("deliver-ack", (e) => window.__acked.push(e.detail.msgId)); signaling = s; })()`);
  b.run(`signaling.deliver(${JSON.stringify(aId)}, "m2", { v: 2, h: {}, ct: "y" }, null, "chat")`); await sleep(100);
  const an = J(b.run(`window.__anon`));
  assert.equal(an.length, 1); assert.equal(an[0].type, "sealed-deliver"); assert.equal(an[0].to, aId); assert.equal(an[0].ak, ak); assert.equal(an[0].from, undefined);
  assert.deepEqual(J(b.run(`window.__acked`)), ["m2"]); assert.deepEqual(J(b.run(`window.__orig`)), []);
  b.run(`window.anonSend = async () => ({ error: "denied" })`);
  b.run(`signaling.deliver(${JSON.stringify(aId)}, "m3", { v: 2, h: {}, ct: "z" }, null, "chat")`); await sleep(100);
  assert.deepEqual(J(b.run(`window.__orig`)), ["deliver"], "отказ — обычная доставка");
  a.close(); b.close();
});
