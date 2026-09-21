// Проверяет конкретно то, что раньше молча терялось: поле duration у
// голосового сообщения. sendFile() в webrtc.js перечислял поля пакета
// file-meta явно и не передавал duration дальше — из-за этого все
// полученные голосовые показывали бы 0:00 вместо реальной длительности.

const fs = require("fs");
const path = require("path");
const wrtc = require("@roamhq/wrtc");

global.window = global;
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.MediaStream = wrtc.MediaStream;
global.crypto = global.crypto || require("crypto").webcrypto;

const _ls = new Map();
global.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
};

const src = fs.readFileSync(path.join(__dirname, "..", "js", "webrtc.js"), "utf8");
// eslint-disable-next-line no-eval
eval(src + "\nglobalThis.__PeerLink = PeerLink;");
const PeerLink = globalThis.__PeerLink;

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log("\n=== duration долетает вместе с голосовым сообщением ===");
  _ls.set("ether.myId", "sender01");
  const a = new PeerLink({ id: "recv01", localName: "A", role: "offerer" });
  _ls.set("ether.myId", "recv01");
  const b = new PeerLink({ id: "sender01", localName: "B", role: "answerer" });

  const offer = await a.createInitialOffer("");
  const answer = await b.acceptOfferAndCreateAnswer(offer);
  await a.acceptAnswer(answer);

  const deadline = Date.now() + 8000;
  while ((a.status !== "connected" || b.status !== "connected" || !b.dc) && Date.now() < deadline) await sleep(50);
  check("соединение установлено", a.status === "connected" && b.status === "connected" && !!b.dc);

  let receivedMeta = null;
  b.dc.addEventListener("message", (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch (e) { return; }
    if (payload.kind === "file-meta") receivedMeta = payload;
  });

  // Имитируем короткое голосовое ~2 секунды: одна крошечная порция данных.
  const ok = await a.sendFile(
    { id: "voice1", name: "voice-message", mime: "audio/webm", size: 100, duration: 2.35 },
    [Buffer.from("fake-audio-bytes").toString("base64")]
  );
  check("sendFile() вернул true", ok === true);

  await sleep(300);
  check("file-meta вообще дошёл", !!receivedMeta);
  check("duration дошёл вместе с ним (а не потерялся)", receivedMeta && receivedMeta.duration === 2.35);
  check("остальные поля тоже на месте", receivedMeta && receivedMeta.mime === "audio/webm" && receivedMeta.name === "voice-message");

  a.close(); b.close();

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});
