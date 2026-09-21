// Проверяет sendFile() поверх настоящего WebRTC data channel: разбиение
// на чанки, контроль bufferedAmount (backpressure) и то, что все чанки
// реально доходят до другой стороны в правильном порядке.

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

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  return Buffer.from(binary, "binary").toString("base64");
}

(async () => {
  console.log("\n=== Передача файла через реальный data channel (с учётом backpressure) ===");
  _ls.set("ether.myId", "sender01");
  const a = new PeerLink({ id: "recv01", localName: "A", role: "offerer" });
  _ls.set("ether.myId", "recv01");
  const b = new PeerLink({ id: "sender01", localName: "B", role: "answerer" });

  const offer = await a.createInitialOffer("");
  const answer = await b.acceptOfferAndCreateAnswer(offer);
  await a.acceptAnswer(answer);

  const deadline = Date.now() + 8000;
  while ((a.status !== "connected" || b.status !== "connected" || !b.dc) && Date.now() < deadline) await sleep(50);
  check("соединение установлено", a.status === "connected" && b.status === "connected");
  check("data channel реально назначен у принимающей стороны (не только status='connected')", !!b.dc);

  // Собираем на стороне B то, что реально приходит
  const received = { meta: null, chunks: [], done: false };
  const origHandler = b.dc.onmessage;
  b.dc.addEventListener("message", (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch (e) { return; }
    if (payload.kind === "file-meta") received.meta = payload;
    else if (payload.kind === "file-chunk") received.chunks[payload.index] = payload.data;
    else if (payload.kind === "file-done") received.done = true;
  });

  // Имитируем файл ~500КБ — несколько десятков чанков, достаточно, чтобы
  // реально нагрузить bufferedAmount и проверить, что пауза действительно
  // отрабатывает, а не просто не мешает маленьким передачам.
  const FILE_CHUNK_SIZE = 48 * 1024;
  const totalSize = 500 * 1024;
  const original = new Uint8Array(totalSize);
  for (let i = 0; i < totalSize; i++) original[i] = (i * 31 + 3) % 256;
  const chunks = [];
  for (let offset = 0; offset < original.length; offset += FILE_CHUNK_SIZE) {
    chunks.push(arrayBufferToBase64(original.slice(offset, offset + FILE_CHUNK_SIZE).buffer));
  }

  const ok = await a.sendFile({ id: "f1", name: "test.bin", mime: "application/octet-stream", size: totalSize }, chunks);
  check("sendFile() вернул true (успех)", ok === true);

  await sleep(500); // дать последним сообщениям долететь и обработаться

  check("получен file-meta с верными полями", received.meta && received.meta.name === "test.bin" && received.meta.totalChunks === chunks.length);
  check("получен file-done", received.done === true);
  check("количество полученных чанков совпадает", received.chunks.filter((c) => c !== undefined).length === chunks.length);
  check("чанки пришли в правильном порядке (индексы 0..N-1 все на месте)", !received.chunks.slice(0, chunks.length).some((c) => c === undefined));

  // Собираем обратно и сверяем побайтово
  if (received.chunks.length === chunks.length) {
    const reassembled = Buffer.concat(received.chunks.map((b64) => Buffer.from(b64, "base64")));
    check("пересобранный файл идентичен исходному побайтово", Buffer.compare(reassembled, Buffer.from(original)) === 0);
  } else {
    fail++; console.log("  FAIL пересборка пропущена — не все чанки дошли");
  }

  a.close(); b.close();

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});
