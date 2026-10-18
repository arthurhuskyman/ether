// Проверка устройства (js/devicecheck.js) и отчёт об ошибке: шаги с моками API, санитайзер журнала.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
async function booted(platform) {
  const a = createApp({ platform, storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" } });
  await a.ready;
  return a;
}

test("санитайзер: тексты, токены, ключи, URL с query, почта и id не попадают в отчёт", async () => {
  const a = await booted();
  const s = (x) => a.run("DeviceCheck").sanitize(x);
  const cases = [
    ['[chat] text="Привет, мой пароль 12345" ok', ["Привет", "12345"]],
    ["push endpoint=https://fcm.googleapis.com/fcm/send/AbCdEf123456789SECRETSECRETSECRET?x=1", ["SECRETSECRET", "x=1"]],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", ["eyJhbGci", "eyJzdWIi"]],
    ["key=MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEabcdefghijklmnop", ["MFkwEwYH"]],
    ['group name="Секретный клуб" members=3', ["Секретный"]],
    ["from a1b2c3d4e5f6a7b8… t=msg mail bob@example.com", ["a1b2c3d4e5f6", "bob@example.com"]],
    ["ws wss://user:pw@sig.example.org/room/abc?token=zzz", ["pw@", "token=zzz", "room/abc"]],
    ["token: abcdefghijklmnopqrstuvwxyz0123456789ABCD", ["abcdefghijklmnopqrstuvwxyz"]],
    ["-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----", ["MIIEvQ"]],
  ];
  for (const [inp, banned] of cases) { const out = s(inp); for (const b of banned) assert.ok(!out.includes(b), `«${b}» просочилось: ${out}`); }
  assert.match(s("[net] connection change: 4g, downlink=10"), /connection change: 4g/, "обычные технические строки сохраняются");
});

test("отчёт об ошибке: журнал очищен, версия и окружение на месте", async () => {
  const a = await booted("android");
  a.run(`etherLog("info", "[msg] text=" + JSON.stringify("секретное сообщение"), "key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); etherLog("warn", "[group] name=" + JSON.stringify("Тайный чат")); etherLog("error", "[net] failed https://x.example/ice?token=SECRET123");`);
  const r = a.run("DeviceCheck").buildErrorReport();
  for (const bad of ["секретное", "Тайный", "AAAAAAAAAAAA", "SECRET123"]) assert.ok(!r.includes(bad), bad);
  assert.match(r, /App: V\.\d/); assert.match(r, /UA: .*Android/); assert.match(r, /WARN /); assert.match(r, /x\.example/);
});

test("шаги: на моках собирается отчёт со всеми разделами, пропуски и ошибки не падают", async () => {
  const a = await booted("ios");
  const w = a.window;
  // iOS: нет vibrate, push недоступен, есть MediaSession/MediaRecorder/AudioContext в виде заглушек
  w.AudioContext = class { constructor() { this.state = "suspended"; this.sampleRate = 48000; this.currentTime = 0; this.destination = {}; } resume() { this.state = "running"; return Promise.resolve(); } createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} }; } createGain() { return { gain: {}, connect() {} }; } close() {} };
  w.MediaRecorder = class { static isTypeSupported(m) { return m === "audio/mp4"; } constructor(s, o) { this.mimeType = (o && o.mimeType) || "audio/mp4"; } start() {} stop() { this.ondataavailable({ data: new w.Blob(["abcd"]) }); setTimeout(() => this.onstop(), 0); } };
  Object.defineProperty(w.navigator, "mediaDevices", { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true });
  w.MediaMetadata = class { constructor(o) { Object.assign(this, o); } };
  Object.defineProperty(w.navigator, "mediaSession", { value: { metadata: null }, configurable: true });
  w.Audio = class { play() { return Promise.resolve(); } pause() {} };
  w.URL.createObjectURL = () => "blob:x";
  const asked = [];
  const { results, report } = await a.run("DeviceCheck").run({ ask: async (q) => { asked.push(q); return true; }, progress() {} }, ["env", "audio", "vibration", "mic", "media", "push", "viewport", "storage"]);
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by.audio.ok, true); assert.match(by.audio.detail, /state after resume: running/);
  assert.equal(by.vibration.ok, null);
  assert.equal(by.mic.ok, true); assert.match(by.mic.detail, /recorded mime audio\/mp4, 4 B/);
  assert.equal(by.media.ok, true); assert.match(by.media.detail, /metadata set: Ether - test/);
  assert.equal(by.push.ok, false); assert.match(by.push.detail, /supported=false/);
  assert.ok(by.viewport.detail.includes("safe-area"));
  assert.ok(asked.length >= 3);
  assert.match(report, /^Ether — device check/); assert.match(report, /\[SKIP\]/); assert.match(report, /\[OK\]/);
  assert.ok(!/eyJ|@/.test(report.replace(/Ether — device check/, "")), "в отчёте нет почты/токенов");
});

test("шаг Whisper: без согласия пропускается, с согласием идёт через LocalAI", async () => {
  const a = await booted();
  const w = a.window;
  const skip = await a.run("DeviceCheck").run({ ask: async () => false }, ["whisper"]);
  assert.equal(skip.results[0].ok, null);
  a.run(`LocalAI.transcribeBlob = async () => "ok"; LocalAI.isReady = () => true; LocalAI.onProgress = (fn) => { fn(50); return () => {}; };`);
  const go = await a.run("DeviceCheck").run({ ask: async () => true }, ["whisper"]);
  assert.equal(go.results[0].ok, true);
});

test("UI: кнопки во вкладке «Отладка» открывают листы и показывают отчёт", async () => {
  const a = await booted();
  const d = a.window.document;
  assert.ok(d.getElementById("devicecheck-btn")); assert.ok(d.getElementById("report-problem-btn"));
  assert.match(d.querySelector("#report-problem-btn span").textContent, /Сообщить об ошибке/);
  d.getElementById("report-problem-btn").click();
  const sheet = d.getElementById("devicecheck-sheet");
  assert.ok(sheet); assert.match(sheet.textContent, /Ether — problem report/);
  sheet.remove();
  d.getElementById("devicecheck-btn").click();
  assert.ok(d.getElementById("devicecheck-sheet").querySelector("button.btn-primary"));
});
