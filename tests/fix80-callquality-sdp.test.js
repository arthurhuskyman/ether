// Opus fmtp, порядок видеокодеков, конфиг ICE (скрывать IP), сортировка TURN: чистые функции js/callquality.js
const test = require("node:test");
const assert = require("node:assert/strict");
const CQ = require("../js/callquality.js");

const SDP = (fmtp) => ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9", "c=IN IP4 0.0.0.0", "a=rtpmap:111 opus/48000/2", ...(fmtp === null ? [] : ["a=fmtp:111 " + fmtp]), "a=rtpmap:63 red/48000/2", "a=rtpmap:9 G722/8000", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=rtpmap:96 VP8/90000", "a=fmtp:96 x=1", ""].join("\r\n");
const fm = (sdp, pt = 111) => { const m = new RegExp("a=fmtp:" + pt + " (.*)").exec(sdp); return m ? Object.fromEntries(m[1].replace(/\r/, "").split(";").map((x) => x.split("="))) : null; };

test("tuneOpusSdp: добавляет FEC/DTX/mono/minptime/maxaveragebitrate к существующему fmtp, прочее сохраняет", () => {
  const out = CQ.tuneOpusSdp(SDP("minptime=10;useinbandfec=1;foo=bar"), { netClass: "good" });
  assert.deepEqual(fm(out), { minptime: "10", useinbandfec: "1", foo: "bar", usedtx: "1", maxaveragebitrate: "64000", stereo: "0", "sprop-stereo": "0" });
  assert.equal(fm(out, 96).x, "1"); // видео не тронуто
  assert.ok(out.includes("a=rtpmap:63 red/48000/2"));
});
test("tuneOpusSdp: нет fmtp -> строка создаётся сразу после rtpmap; класс сети задаёт битрейт", () => {
  const out = CQ.tuneOpusSdp(SDP(null), { netClass: "poor" });
  assert.equal(fm(out).maxaveragebitrate, "24000");
  const lines = out.split("\r\n"), i = lines.indexOf("a=rtpmap:111 opus/48000/2");
  assert.ok(lines[i + 1].startsWith("a=fmtp:111 "));
  assert.equal(CQ.tuneOpusSdp(SDP(null), { netClass: "fair" }).match(/maxaveragebitrate=(\d+)/)[1], "40000");
});
test("tuneOpusSdp: идемпотентна, переопределяет старые значения, dtx:false -> usedtx=0", () => {
  const once = CQ.tuneOpusSdp(SDP("useinbandfec=0;maxaveragebitrate=510000"), {});
  assert.equal(fm(once).useinbandfec, "1"); assert.equal(fm(once).maxaveragebitrate, "64000");
  assert.equal(CQ.tuneOpusSdp(once, {}), once);
  assert.equal(fm(CQ.tuneOpusSdp(SDP(null), { dtx: false })).usedtx, "0");
  assert.equal(fm(CQ.tuneOpusSdp(SDP(null), { fec: false })).useinbandfec, undefined);
});
test("tuneOpusSdp: безопасна — нет Opus, пустое, не строка, \\n вместо \\r\\n", () => {
  const noOpus = "v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n";
  assert.equal(CQ.tuneOpusSdp(noOpus, {}), noOpus);
  for (const v of ["", null, undefined, 5]) assert.equal(CQ.tuneOpusSdp(v, {}), v);
  const lf = CQ.tuneOpusSdp(SDP(null).replace(/\r\n/g, "\n"), {});
  assert.ok(!lf.includes("\r") && /a=fmtp:111 /.test(lf));
});
test("tuneOpusSdp: Opus в видео-секции (теоретически) не трогается; ptime добавляется один раз", () => {
  const out = CQ.tuneOpusSdp(SDP(null), { ptime: 20 });
  assert.equal(out.split("a=ptime:20").length, 2);
  assert.equal(CQ.tuneOpusSdp(out, { ptime: 20 }).split("a=ptime:20").length, 2);
});

test("orderVideoCodecs: iOS -> H.264 первым, список целиком, RTX/RED в хвосте; без проверок среды — не падает", () => {
  const caps = [{ mimeType: "video/VP8" }, { mimeType: "video/rtx" }, { mimeType: "video/H264", sdpFmtpLine: "a" }, { mimeType: "video/VP9" }, { mimeType: "video/AV1" }, { mimeType: "video/red" }];
  const ios = CQ.orderVideoCodecs(caps, { ios: true });
  assert.equal(ios[0].mimeType, "video/H264"); assert.equal(ios.length, caps.length);
  assert.deepEqual(new Set(ios), new Set(caps));
  assert.equal(CQ.orderVideoCodecs(caps, { cores: 8 })[0].mimeType, "video/VP9");
  assert.equal(CQ.orderVideoCodecs(caps, { cores: 8, allowAV1: true })[0].mimeType, "video/AV1");
  assert.equal(CQ.orderVideoCodecs(caps, { android: true })[0].mimeType, "video/H264");
  assert.equal(CQ.orderVideoCodecs(caps, { cores: 2 })[0].mimeType, "video/VP8");
  assert.deepEqual(CQ.orderVideoCodecs([], {}), []);
});

test("rtcConfigFor: hideIp -> relay и только TURN (UDP раньше TCP/TLS); без TURN всё равно relay", () => {
  const ice = [{ urls: ["stun:s:1"] }, { urls: ["turns:t:443?transport=tcp", "turn:t:3478?transport=udp"], username: "u", credential: "c" }];
  const on = CQ.rtcConfigFor({ hideIp: true, iceServers: ice });
  assert.equal(on.iceTransportPolicy, "relay");
  assert.equal(on.iceServers.length, 1); assert.deepEqual(on.iceServers[0].urls, ["turn:t:3478?transport=udp", "turns:t:443?transport=tcp"]);
  assert.equal(on.iceServers[0].username, "u");
  const none = CQ.rtcConfigFor({ hideIp: true, iceServers: [{ urls: "stun:s" }] });
  assert.equal(none.iceTransportPolicy, "relay"); assert.deepEqual(none.iceServers, []);
  const off = CQ.rtcConfigFor({ hideIp: false, iceServers: ice, poolSize: 2 });
  assert.equal(off.iceTransportPolicy, undefined); assert.equal(off.iceServers, ice); assert.equal(off.iceCandidatePoolSize, 2);
});

test("sortIceByRtt: быстрые TURN вперёд, не отвечающие в конец, STUN вперёд всех, порядок стабилен", () => {
  const s = [{ urls: "turn:slow" }, { urls: "turn:dead" }, { urls: "stun:x" }, { urls: "turn:fast" }, { urls: "turn:unknown" }];
  const out = CQ.sortIceByRtt(s, { "turn:slow": 300, "turn:fast": 40, "turn:dead": -1 });
  assert.deepEqual(out.map((x) => x.urls), ["stun:x", "turn:fast", "turn:slow", "turn:unknown", "turn:dead"]);
  assert.deepEqual(CQ.sortIceByRtt(s, {}).map((x) => x.urls), ["stun:x", "turn:slow", "turn:dead", "turn:fast", "turn:unknown"]);
});
