// Интеграция в PeerLink (jsdom, поддельный RTCPeerConnection): скрывать IP, SDP на проводе, кодеки, цикл адаптации, групповой бюджет, смена сети
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep } = require("./cov-helpers");
test.after(closeAll);

const FAKE = `
class FPC extends EventTarget {
  constructor(cfg) { super(); this.cfg = cfg; this.iceConnectionState = "new"; this.connectionState = "new"; this.signalingState = "stable"; this.senders = []; this.stats = new Map(); this.trs = []; FPC.all.push(this); }
  createDataChannel() { return Object.assign(new EventTarget(), { readyState: "connecting", close() {} }); } getSenders() { return this.senders; } getTransceivers() { return this.trs; } async getStats() { return this.stats; }
  addTrack(t) { const s = { track: t, params: { encodings: [{}] }, getParameters() { return JSON.parse(JSON.stringify(this.params)); }, async setParameters(p) { this.params = JSON.parse(JSON.stringify(p)); } }; this.senders.push(s); return s; }
  close() { this.closed = true; }
}
FPC.all = []; window.RTCPeerConnection = FPC; window.__FPC = FPC;
window.RTCRtpReceiver = { getCapabilities: () => ({ codecs: [{ mimeType: "video/VP8" }, { mimeType: "video/H264" }, { mimeType: "video/VP9" }] }) };
ICE_SERVERS = [{ urls: ["stun:s:1"] }, { urls: ["turn:t:3478", "turns:t:443?transport=tcp"], username: "u", credential: "p" }];`;
const mk = (a, id = "peer-abcdefghij") => a.run(`(() => { const L = new PeerLink({ id: ${JSON.stringify(id)}, localName: "me", role: "offerer" }); L._log = () => {}; window.__L = L; return 1; })()`) && a.window.__L;

test("настройка «Скрывать IP»: выкл -> обычная конфигурация; вкл -> relay и только TURN (хранится в Store)", async () => {
  const a = await boot(); a.run(FAKE);
  assert.equal(a.run(`Store.hideIpInCalls`), false);
  mk(a);
  assert.equal(a.run(`__FPC.all.at(-1).cfg.iceTransportPolicy`), undefined);
  a.run(`Store.hideIpInCalls = true`);
  assert.equal(a.run(`localStorage.getItem("ether.hideIpInCalls")`), "1");
  const L = mk(a, "peer-zzzzzzzzzz");
  assert.equal(a.run(`__FPC.all.at(-1).cfg.iceTransportPolicy`), "relay");
  assert.equal(a.run(`__FPC.all.at(-1).cfg.iceServers.every((s) => [].concat(s.urls).every((u) => /^turns?:/.test(u)))`), true);
  assert.equal(L._hideIp, true);
  a.run(`Store.hideIpInCalls = false`);
  mk(a, "peer-yyyyyyyyyy");
  assert.equal(a.run(`__FPC.all.at(-1).cfg.iceTransportPolicy`), undefined);
  a.close();
});

test("_wireSdp: Opus настроен, без EtherCallQuality/на мусоре возвращает исходное", async () => {
  const a = await boot(); a.run(FAKE);
  const L = mk(a);
  const sdp = "m=audio 9 RTP/AVP 111\r\na=rtpmap:111 opus/48000/2\r\n";
  assert.match(L._wireSdp(sdp), /a=fmtp:111 .*useinbandfec=1.*usedtx=1/);
  a.run(`window.__cq = window.EtherCallQuality; window.EtherCallQuality = null`);
  assert.equal(L._wireSdp(sdp), sdp);
  a.run(`window.EtherCallQuality = { tuneOpusSdp() { throw new Error("x"); } }`);
  assert.equal(L._wireSdp(sdp), sdp);
  a.run(`window.EtherCallQuality = window.__cq`);
  a.close();
});

test("кодеки: setCodecPreferences вызывается один раз на трансивер; iOS -> H.264; ошибка не ломает", async () => {
  const a = await boot(); a.run(FAKE);
  const L = mk(a);
  a.run(`Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", configurable: true })`);
  a.run(`window.__prefs = []; window.__tr = { setCodecPreferences(c) { window.__prefs.push(c.map((x) => x.mimeType)); } }`);
  assert.equal(L._applyCodecPrefs(a.window.__tr), true); assert.equal(L._applyCodecPrefs(a.window.__tr), true);
  assert.equal(a.run(`__prefs.length`), 1); assert.equal(a.run(`__prefs[0][0]`), "video/H264"); assert.equal(a.run(`__prefs[0].length`), 3);
  assert.equal(L._applyCodecPrefs({ setCodecPreferences() { throw new Error("x"); } }), false);
  assert.equal(L._applyCodecPrefs({}), false);
  a.close();
});

test("цикл адаптации: плохая сеть -> видео снижается, потом аудио-режим (событие quality, kind call-quality в dc), восстановление", async () => {
  const a = await boot(); a.run(FAKE);
  const L = mk(a); const pc = L.pc;
  a.run(`window.__sent = []; window.__L.send = (p) => { __sent.push(p); return true; }; window.__ev = []; __L.addEventListener("quality", (e) => __ev.push(e.detail));`);
  const vs = pc.addTrack({ kind: "video", id: "v" }); pc.addTrack({ kind: "audio", id: "a" });
  let t = 1000, recv = 0, lost = 0;
  const feed = (lossFrac) => { t += 2000; recv += Math.round(100 * (1 - lossFrac)); lost += Math.round(100 * lossFrac);
    a.window.__FPC.all.at(-1).stats = new Map([["i", { id: "i", type: "inbound-rtp", kind: "audio", timestamp: t, packetsReceived: recv, packetsLost: lost }], ["p", { id: "p", type: "candidate-pair", selected: true, state: "succeeded", currentRoundTripTime: 0.05 }]]); };
  // быстрый setInterval: подменяем таймер окна, чтобы не ждать 2 с
  a.run(`window.__ticks = []; window.__si = window.setInterval; window.setInterval = (f, ms) => { __ticks.push(f); return 77; };`);
  assert.equal(L.startQuality(), true);
  assert.equal(L.startQuality(), false); // повторный запуск не плодит циклы
  const tick = async () => { await a.window.__ticks[0](); await sleep(5); };
  feed(0); await tick(); // первый тик — база
  for (let i = 0; i < 3; i++) { feed(0.25); await tick(); }
  assert.equal(L._qc.level, 4);
  assert.equal(vs.params.encodings[0].active, false);
  assert.ok(a.run(`__sent.some((p) => p.kind === "call-quality" && p.audioOnly === true)`));
  assert.equal(a.run(`__ev.at(-1).audioOnly`), true);
  for (let i = 0; i < 15; i++) { feed(0); await tick(); }
  assert.equal(L._qc.level, 3);
  assert.equal(vs.params.encodings[0].active, true); assert.ok(vs.params.encodings[0].maxBitrate > 0);
  assert.equal(a.run(`__ev.at(-1).restored`), true);
  L.stopQuality(); assert.equal(L._qTimer, null);
  a.close();
});

test("групповой бюджет: setVideoBudget задаёт maxBitrate, 0 -> видео выключено (и цикл адаптации его не включает)", async () => {
  const a = await boot(); a.run(FAKE);
  const L = mk(a); const vs = L.pc.addTrack({ kind: "video", id: "v" });
  L.setVideoBudget(600000); await sleep(5);
  assert.equal(vs.params.encodings[0].maxBitrate, 600000);
  L.setVideoBudget(0); await sleep(5);
  assert.equal(vs.params.encodings[0].active, false);
  await L._applyQualityPlan({ audioOnly: false, video: { maxBitrate: 999 } });
  assert.equal(vs.params.encodings[0].active, false);
  a.close();
});

test("gcallLimit: 6 по умолчанию, не больше GCALL_MAX; gcallApplyBudget раздаёт бюджет линкам", async () => {
  const a = await boot(); a.run(FAKE);
  assert.equal(a.run(`gcallLimit()`) <= 6, true);
  a.run(`GC.gid = "g"; GC.video = true; GC.peers = new Map([["p1", {}], ["p2", {}]]);
    window.__b = []; mesh.links.set("p1", { setVideoBudget(b) { __b.push(b); } }); mesh.links.set("p2", { setVideoBudget(b) { __b.push(b); } }); gcallApplyBudget();`);
  assert.equal(a.run(`__b.length`), 2); assert.ok(a.run(`__b[0]`) > 400000 && a.run(`__b[0]`) <= 1200000);
  a.run(`GC.peers = new Map([1,2,3,4,5].map((i) => ["p" + i, {}])); for (const i of [1,2,3,4,5]) mesh.links.set("p" + i, { setVideoBudget(b) { __b.push(b); } }); __b.length = 0; gcallApplyBudget();`);
  assert.deepEqual(Array.from(a.run(`__b`)), [0, 0, 0, 0, 0]);
  a.run(`GC.gid = null; GC.peers = new Map(); GC.video = false;`);
  a.close();
});

test("смена сети: online -> быстрый reInvite только для линков с активным медиа, не чаще раза в 3 с", async () => {
  const a = await boot(); a.run(FAKE);
  const L1 = mk(a, "peer-aaaaaaaaaa"), L2 = mk(a, "peer-bbbbbbbbbb");
  a.run(`window.__ri = []`);
  for (const [L, media] of [[L1, true], [L2, false]]) { L.status = "in-call"; L.localAudioTrack = media ? {} : null; L.reInvite = () => a.window.__ri.push(L.id); }
  a.window.dispatchEvent(new a.window.Event("online"));
  await sleep(900);
  assert.deepEqual(Array.from(a.window.__ri), ["peer-aaaaaaaaaa"]);
  a.window.dispatchEvent(new a.window.Event("online")); await sleep(900);
  assert.equal(a.window.__ri.length, 1);
  a.close();
});

test("prewarmCallIce: создаёт короткоживущий PC с пулом, не чаще раза в 20 с; TURN сортируются по RTT", async () => {
  const a = await boot(); a.run(FAKE);
  a.run(`window.__prewarmAtReset = 1; __prewarmAt = 0`);
  const n0 = a.run(`__FPC.all.length`);
  assert.equal(a.run(`prewarmCallIce()`), true);
  assert.equal(a.run(`__FPC.all.length`), n0 + 1); assert.equal(a.run(`__FPC.all.at(-1).cfg.iceCandidatePoolSize`), 2);
  assert.equal(a.run(`prewarmCallIce()`), false);
  a.run(`ICE_SERVERS = [{ urls: ["turn:slow"], username: "u", credential: "c" }, { urls: ["turn:fast"], username: "u", credential: "c" }];
    window.etherTurnCheckOne = async (u) => ({ relay: true, relayMs: u === "turn:fast" ? 20 : 300 }); turnRttAt = 0;`);
  await a.run(`measureTurnRtt(true)`);
  assert.equal(a.run(`ICE_SERVERS[0].urls[0]`), "turn:fast");
  a.close();
});

test("callReportText: простыми словами; опция отчёта выключена по умолчанию", async () => {
  const a = await boot();
  assert.equal(a.run(`Store.callReport`), false);
  assert.match(a.run(`callReportText({ verdict: "excellent", rttMedianMs: 40, lossAvgPct: 0 })`), /Audio was excellent\. Delay 40 ms, packet loss 0%\./);
  assert.match(a.run(`callReportText({ verdict: "poor", rttMedianMs: 700, lossAvgPct: 12, audioOnlyUsed: true, path: "relay" })`), /Audio was poor.*Video was switched off.*relay/);
  a.close();
});
