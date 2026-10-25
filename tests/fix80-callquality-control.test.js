// Цикл адаптации (лестница, аудио-режим, гистерезис), статистика, групповые лимиты, отчёт
const test = require("node:test");
const assert = require("node:assert/strict");
const CQ = require("../js/callquality.js");

const GOOD = { lossPct: 0, rttMs: 60, jitterMs: 5 }, BAD = { lossPct: 7, rttMs: 200 }, SEVERE = { lossPct: 20, rttMs: 300 };
const run = (c, s, n) => { let r; for (let i = 0; i < n; i++) r = c.step(s); return r; };

test("лестница: потери 7% -> шаг вниз каждые 2 тика (4 с), видео-параметры уменьшаются", () => {
  const c = CQ.createController({ baseVideoBps: 2000000 });
  const p0 = c.plan(); assert.equal(p0.level, 0); assert.equal(p0.video.maxBitrate, 2000000);
  assert.equal(c.step(BAD).level, 0);
  const r1 = c.step(BAD); assert.equal(r1.level, 1); assert.equal(r1.changed, true); assert.equal(r1.video.maxBitrate, 1200000);
  run(c, BAD, 2); const r2 = c.plan(); assert.equal(r2.level, 2); assert.equal(r2.video.scaleResolutionDownBy, 2); assert.ok(r2.video.maxFramerate <= 24);
  assert.equal(r2.audioOnly, false);
});
test("потери >15% 6 с (3 тика) -> только аудио с видимой причиной; RTT>800 -> тоже", () => {
  const c = CQ.createController({});
  assert.equal(c.step(SEVERE).audioOnly, false); assert.equal(c.step(SEVERE).audioOnly, false);
  const r = c.step(SEVERE); assert.equal(r.audioOnly, true); assert.equal(r.video, null); assert.equal(r.reason, "severe");
  const c2 = CQ.createController({}); assert.equal(run(c2, { lossPct: 0, rttMs: 900 }, 3).audioOnly, true);
  // одиночный выброс не рушит звонок
  const c3 = CQ.createController({}); c3.step(SEVERE); c3.step(GOOD); c3.step(SEVERE); assert.equal(c3.step(GOOD).level, 0);
});
test("гистерезис: подъём на шаг только после 8 хороших тиков; из аудио-режима — после 15; смешанные тики счёт сбрасывают", () => {
  const c = CQ.createController({}); run(c, BAD, 2); assert.equal(c.level, 1);
  run(c, GOOD, 7); assert.equal(c.level, 1);
  c.step({ lossPct: 3, rttMs: 100 }); // «средне» — сброс счётчика хороших
  run(c, GOOD, 7); assert.equal(c.level, 1);
  const up = c.step(GOOD); assert.equal(up.level, 0); assert.equal(up.reason, "restored");
  const a = CQ.createController({}); run(a, SEVERE, 3); assert.equal(a.level, 4);
  run(a, GOOD, 14); assert.equal(a.level, 4);
  const back = a.step(GOOD); assert.equal(back.level, 3); assert.equal(back.audioOnly, false);
  // сразу после восстановления одна плохая выборка не откатывает
  assert.equal(a.step(BAD).level, 3);
});
test("availableOutgoingBitrate ниже цели -> подгон без ожидания потерь; без видео лестница не двигается", () => {
  const c = CQ.createController({ baseVideoBps: 2000000 });
  const r = c.step({ lossPct: 0, rttMs: 50, availBps: 500000 }); assert.equal(r.level, 1); assert.equal(r.reason, "bandwidth");
  const a = CQ.createController({ hasVideo: false }); run(a, SEVERE, 5); assert.equal(a.level, 0);
});
test("класс сети для Opus: ухудшение быстро (2 тика), улучшение медленно (6 тиков)", () => {
  const c = CQ.createController({ hasVideo: false });
  assert.equal(c.step({ lossPct: 10, rttMs: 100 }).netClass, "good"); assert.equal(c.step({ lossPct: 10, rttMs: 100 }).netClass, "poor");
  assert.equal(run(c, GOOD, 5).netClass, "poor"); assert.equal(c.step(GOOD).netClass, "good");
  assert.equal(c.plan().opusBitrate, CQ.OPUS_BITRATE.good);
});

test("extractSample: потери/битрейт/fps за интервал, RTT, путь relay/direct, кодеки", () => {
  const mk = (t, recv, lost, bytes, frames) => new Map(Object.entries({
    a: { id: "a", type: "inbound-rtp", kind: "audio", timestamp: t, packetsReceived: recv, packetsLost: lost, jitter: 0.012, codecId: "c1" },
    o: { id: "o", type: "outbound-rtp", kind: "video", timestamp: t, bytesSent: bytes, framesSent: frames },
    c1: { id: "c1", type: "codec", mimeType: "audio/opus" },
    p: { id: "p", type: "candidate-pair", selected: true, state: "succeeded", currentRoundTripTime: 0.08, availableOutgoingBitrate: 900000, localCandidateId: "l", remoteCandidateId: "r" },
    l: { id: "l", type: "local-candidate", candidateType: "relay" }, r: { id: "r", type: "remote-candidate", candidateType: "srflx" },
  }));
  const s0 = CQ.extractSample(mk(1000, 100, 0, 0, 0), null);
  assert.equal(s0.lossPct, 0); assert.equal(s0.outKbps, null);
  const s1 = CQ.extractSample(mk(3000, 180, 20, 250000, 60), s0.raw);
  assert.equal(Math.round(s1.lossPct), 20); assert.equal(Math.round(s1.outKbps), 1000); assert.equal(Math.round(s1.fps), 30);
  assert.equal(s1.rttMs, 80); assert.equal(s1.jitterMs, 12); assert.equal(s1.availBps, 900000);
  assert.equal(s1.pathType, "relay"); assert.equal(s1.pairType, "relay/srflx"); assert.equal(s1.audioCodec, "opus");
  assert.doesNotThrow(() => CQ.extractSample(new Map(), s1.raw));
});

test("группа: бюджет делится между получателями, >4 видео-пиров -> только аудио, слабый канал -> без видео", () => {
  const p2 = CQ.groupVideoPlan({ peers: 2, uplinkBps: 3000000 });
  assert.equal(p2.video, true); assert.ok(p2.perPeerBps > 500000 && p2.perPeerBps <= 1200000);
  const p4 = CQ.groupVideoPlan({ peers: 4, uplinkBps: 3000000 });
  assert.ok(p4.perPeerBps < p2.perPeerBps); assert.ok(p4.perPeerBps * 4 + 4 * 64000 <= 3000000);
  const p5 = CQ.groupVideoPlan({ peers: 5, uplinkBps: 20000000 }); assert.deepEqual([p5.video, p5.reason], [false, "many-peers"]);
  assert.deepEqual([CQ.groupVideoPlan({ peers: 3, uplinkBps: 600000 }).video, CQ.groupVideoPlan({ peers: 3, uplinkBps: 600000 }).reason], [false, "uplink"]);
  assert.equal(CQ.groupVideoPlan({ peers: 0 }).video, false);
});
test("groupLimit: 6 по умолчанию; слабый канал/устройство уменьшают, но не ниже 3", () => {
  assert.equal(CQ.groupLimit({}), 6);
  assert.equal(CQ.groupLimit({ cores: 2 }), 4);
  assert.equal(CQ.groupLimit({ uplinkBps: 100000 }), 3);
  assert.equal(CQ.groupLimit({ uplinkBps: 10000000 }), 6);
});

test("отчёт: вердикты по звуку, экспорт JSON, мало данных -> unknown, ограничение размера", () => {
  const rep = CQ.createReport(50);
  const add = (n, s) => { for (let i = 0; i < n; i++) CQ.reportAdd(rep, Object.assign({ level: 0, audioCodec: "opus", pathType: "direct", pairType: "host/host" }, s)); };
  assert.equal(CQ.summarizeReport(rep).verdict, "unknown");
  add(10, { rttMs: 40, jitterMs: 4, lossPct: 0, outKbps: 60 });
  let sum = CQ.summarizeReport(rep); assert.equal(sum.verdict, "excellent"); assert.equal(sum.rttMedianMs, 40); assert.equal(sum.path, "direct");
  const r2 = CQ.createReport(); for (let i = 0; i < 10; i++) CQ.reportAdd(r2, { rttMs: 250, jitterMs: 20, lossPct: 5, level: 2 });
  sum = CQ.summarizeReport(r2); assert.equal(sum.verdict, "fair"); assert.equal(sum.videoDegraded, true); assert.equal(sum.audioOnlyUsed, false);
  const r3 = CQ.createReport(); for (let i = 0; i < 10; i++) CQ.reportAdd(r3, { rttMs: 700, jitterMs: 20, lossPct: 12, level: 4 });
  sum = CQ.summarizeReport(r3); assert.equal(sum.verdict, "poor"); assert.equal(sum.audioOnlyUsed, true);
  add(100, { rttMs: 40, jitterMs: 4, lossPct: 0 }); assert.equal(rep.samples.length, 50);
  rep.reconnects = 4; assert.equal(CQ.summarizeReport(rep).verdict, "good");
  const j = JSON.parse(CQ.reportToJson(rep)); assert.equal(j.version, 1); assert.equal(j.samples.length, 50); assert.equal(j.summary.reconnects, 4);
});
