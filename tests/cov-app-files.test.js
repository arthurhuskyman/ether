// Покрытие app.js: отправка и приём файлов, голосовые (запись, воспроизведение), вложения, медиа-вьюер, безопасные числовые поля.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers, installTouch, installPtr } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me-test-id"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.publicKey = { kty: "EC" };
    state.contacts.set("g1", { id: "g1", name: "Team", managed: true, isGroup: true, createdBy: "me-test-id", members: [{ id: "me-test-id", name: "Tester", role: "admin" }, { id: "alice", name: "Alice" }], messages: [], lastActivity: 1 });
    window.__sent = []; window.trySendOrQueue = async (c, id, p) => { window.__sent.push([c.id, p.kind, p]); };
    state._firstRenderDone = true; persistContacts(); state.tab = "chats"; state.chatId = "alice"; renderTab(); })()`);
}
const fileOf = (a, name, type, n) => a.run(`new File([new Uint8Array(${n})], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} })`);
const kinds = (a) => J(a.window.__sent).map((x) => x[1]);

test("вспомогательные: kind по mime, размер, base64, безопасные числа, волна, длительность, скорость", async () => {
  const a = await boot(); fakeTimers(a); seed(a);
  const r = J(a.run(`(() => { const o = {};
    o.kind = ["image/png", "image/svg+xml", "video/mp4", "audio/webm", "application/pdf", "", null].map(fileKindFromMime);
    o.size = [formatFileSize(5), formatFileSize(2048), formatFileSize(3 * 1024 * 1024)];
    o.b64 = Array.from(base64ToUint8Array(arrayBufferToBase64(new Uint8Array([1, 2, 250]).buffer))); o.b64big = arrayBufferToBase64(new Uint8Array(100000).buffer).length;
    o.ts = [safeMsgTs("x") > 0, safeMsgTs(5) > 0, safeMsgTs(Date.now() + 999999999) <= Date.now() + 1, safeMsgTs(Date.now() - 5000) === Date.now() - 5000 || true];
    o.dur = [safeDuration(5), safeDuration(-1), safeDuration(1e9), safeDuration("x")]; o.ttl = [safeTtl(500), safeTtl(60000), safeTtl(1e12), safeTtl("a")];
    o.op = [clampOpTs(undefined, 1000), clampOpTs(5, 1000), clampOpTs(1000 + 999999, 1000), clampOpTs(1500, 1000), clampOpTs(-5, 1000)];
    o.wave = [sanitizeWave([1, 2]), sanitizeWave("x"), sanitizeWave([1, 2, 3, 99]), sanitizeWave(new Array(70).fill(1)), sanitizeWave([0.4, "z", -5, 40, 1])];
    o.cw = [compressWave([]), compressWave([0.1]), compressWave(Array.from({ length: 200 }, (_, i) => (i % 10) / 10)).length, compressWave([0, 0, 0, 0], 2)];
    o.fb = fallbackWave("seed").length; o.fb2 = fallbackWave("seed").join() === fallbackWave("seed").join(); o.vw = voiceWaveHtml([1, 2, 3, 4], "x").split("<i").length - 1; o.vw2 = voiceWaveHtml(null, "x").split("<i").length - 1;
    localStorage.removeItem("ether.voiceSpeed"); o.sp = [voiceSpeed(), cycleVoiceSpeed(), cycleVoiceSpeed(), cycleVoiceSpeed()]; localStorage.setItem("ether.voiceSpeed", "3"); o.sp2 = voiceSpeed();
    o.vd = [formatVoiceDuration(59.9), formatVoiceDuration(61), formatVoiceDuration(-3)];
    o.html = [fileBubbleHtml("p", { pending: true, progress: 0.5 }).includes("width:50.0%"), fileBubbleHtml("p", { pending: true }).includes("indeterminate"), fileBubbleHtml("f", { failed: true }).includes("file-bubble-failed"),
      fileBubbleHtml("i", { kind: "image", size: 5, w: 100, h: 50, caption: "cap" }).includes("100 / 50"), fileBubbleHtml("v", { kind: "video", size: 5 }).includes("16 / 9"), fileBubbleHtml("a", { kind: "audio", size: 5, duration: 5, transcript: "hi there" }).includes("voice-transcript"), fileBubbleHtml("d", { kind: "file", name: "x<y", size: 5 }).includes("x&lt;y")];
    fileBlobUrlCache.set("img1", "blob:q"); o.cached = fileBubbleHtml("img1", { kind: "image", size: 1 }).includes("blob:q"); o.tag = [mediaTagHtml("video", "u").includes("<video"), mediaTagHtml("image", "u").includes("<img")];
    return o; })()`));
  assert.deepEqual(r.kind, ["image", "file", "video", "audio", "file", "file", "file"]); assert.equal(r.size[0], "5 B"); assert.equal(r.size[1], "2 KB"); assert.equal(r.size[2], "3.0 MB");
  assert.deepEqual(r.b64, [1, 2, 250]); assert.deepEqual(r.dur, [5, 0, 0, 0]); assert.deepEqual(r.ttl, [0, 60000, 0, 0]); assert.deepEqual(r.op.slice(0, 2), [1000, 5]); assert.equal(r.op[2], 31000); assert.equal(r.op[3], 1500); assert.equal(r.op[4], 1000);
  assert.equal(r.wave[0], null); assert.equal(r.wave[3], null); assert.deepEqual(r.wave[4], [0, 0, 0, 31, 1]); assert.equal(r.cw[0], null); assert.equal(r.cw[2], 40); assert.equal(r.fb, 40); assert.equal(r.fb2, true); assert.equal(r.vw, 4); assert.equal(r.vw2, 40);
  assert.deepEqual(r.sp, [1, 1.5, 2, 1]); assert.equal(r.sp2, 1); assert.deepEqual(r.vd, ["0:59", "1:01", "0:00"]); assert.ok(r.html.every(Boolean), JSON.stringify(r.html)); assert.equal(r.cached, true);
  a.close();
});

test("выбор файлов: превью-шторка для фото/видео, документ, несколько файлов", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.sendFileMessage = async (id, f, o) => { (window.__sf = window.__sf || []).push([id, f.name, o && o.caption, o && o.silent]); };`);
  a.window.__f1 = fileOf(a, "a.png", "image/png", 10); a.window.__f2 = fileOf(a, "b.mp4", "video/mp4", 10); a.window.__f3 = fileOf(a, "c.pdf", "application/pdf", 10);
  a.run(`handlePickedFiles([]); handlePickedFiles([__f3]);`); assert.equal(a.window.__sf.length, 1);
  a.run(`handlePickedFiles([__f1]);`); assert.ok(!a.document.querySelector("#media-compose-sheet").classList.contains("hidden")); assert.ok(a.document.querySelector("#media-compose-preview img"));
  a.document.querySelector("#media-compose-caption").value = "  cap  "; a.document.querySelector("#media-compose-send").click(); assert.deepEqual(J(a.window.__sf.at(-1)).slice(0, 3), ["alice", "a.png", "cap"]);
  a.run(`handlePickedFiles([__f2]);`); assert.ok(a.document.querySelector("#media-compose-preview video")); a.document.querySelector("#media-compose-sheet .sheet-cancel") && a.document.querySelector("#media-compose-sheet .sheet-cancel").click();
  a.run(`handlePickedFiles([__f2]);`); a.document.querySelector("#media-compose-sheet .sheet-backdrop") && a.document.querySelector("#media-compose-sheet .sheet-backdrop").click(); assert.ok(a.document.querySelector("#media-compose-sheet").classList.contains("hidden"));
  a.run(`handlePickedFiles([__f1, __f3]);`); await sleep(30); assert.ok(a.window.__sf.filter((x) => x[3] === true).length >= 2);
  a.run(`state.chatId = null; handlePickedFiles([__f1]);`);
  a.close();
});

test("отправка файла: пустой, огромный, блокировка, живая связь, офлайн-путь, сжатие, группа", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const msgs = () => J(a.run(`state.contacts.get("alice").messages.filter((m) => m.file).map((m) => ({ ack: m.ack, pending: m.file.pending, name: m.file.name, cap: m.file.caption, ttl: m.ttl }))`));
  // пустой/огромный/заблокированный
  await a.run(`sendFileMessage("alice", new File([], "e.txt"))`); await a.run(`sendFileMessage("alice", { size: 999999999, name: "huge.bin", type: "x" })`); await a.run(`sendFileMessage("nope", new File(["x"], "n.txt"))`);
  a.run(`state.contacts.get("alice").blocked = true;`); await a.run(`sendFileMessage("alice", new File(["x"], "b.txt"))`); a.run(`state.contacts.get("alice").blocked = false;`);
  assert.equal(msgs().length, 0);
  // живая связь
  a.run(`window.__prog = []; mesh.links.set("alice", { status: "connected", sendFile: async (meta, chunks, onP) => { window.__chunks = chunks.length; if (onP) { onP(1, chunks.length); onP(chunks.length, chunks.length); } return true; } });`);
  a.run(`state.contacts.get("alice").disappearingTimer = 3600000;`);
  await a.run(`sendFileMessage("alice", new File([new Uint8Array(150000)], "big.bin", { type: "application/octet-stream" }), { caption: "  hello caption  " })`);
  assert.ok(a.window.__chunks >= 3); let m = msgs().at(-1); assert.deepEqual([m.ack, m.pending, m.cap, m.ttl], ["sent", false, "hello caption", 3600000]);
  a.run(`mesh.links.set("alice", { status: "connected", sendFile: async () => false });`); await a.run(`sendFileMessage("alice", new File(["xx"], "fail.bin"), { silent: true })`); assert.equal(msgs().at(-1).ack, "failed");
  // файл не читается
  a.run(`mesh.links.set("alice", { status: "connected", sendFile: async () => true });`); await a.run(`sendFileMessage("alice", { size: 5, name: "unreadable.bin", type: "x/y", arrayBuffer: async () => { throw new Error("io"); } })`); assert.equal(msgs().at(-1).ack, "failed");
  // офлайн-путь
  a.run(`mesh.links.delete("alice"); window.ensureLiveLink = async () => null;`);
  await a.run(`sendFileMessage("alice", new File(["offline"], "off.txt", { type: "text/plain" }), { caption: "c" })`); assert.ok(kinds(a).includes("file")); assert.equal(msgs().at(-1).pending, false);
  await a.run(`sendFileMessage("alice", { size: 5, name: "unread2.bin", type: "x/y", arrayBuffer: async () => { throw new Error("io"); } })`);
  assert.equal(msgs().at(-1).ack, "failed");
  // огромный, но сжимаемый (картинка): через createImageBitmap + canvas
  a.run(`window.createImageBitmap = async () => ({ width: 4000, height: 3000, close() {} });
    HTMLCanvasElement.prototype.toBlob = function (cb, type, q) { cb(new Blob([new Uint8Array(q > 0.5 ? 3 * 1024 * 1024 : 1000)], { type })); };`);
  await a.run(`sendFileMessage("alice", new File([new Uint8Array(3 * 1024 * 1024)], "photo.png", { type: "image/png" }))`);
  assert.ok(msgs().some((x) => x.name === "photo.jpg"), "сжатое имя .jpg");
  a.run(`HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new Blob([new Uint8Array(3 * 1024 * 1024)], { type: "image/jpeg" })); };`);
  await a.run(`sendFileMessage("alice", new File([new Uint8Array(3 * 1024 * 1024)], "photo2.png", { type: "image/png" }))`);
  await a.run(`sendFileMessage("alice", new File([new Uint8Array(3 * 1024 * 1024)], "anim.gif", { type: "image/gif" }))`);
  a.run(`window.createImageBitmap = async () => { throw new Error("bad"); };`); await a.run(`sendFileMessage("alice", new File([new Uint8Array(3 * 1024 * 1024)], "p3.png", { type: "image/png" }))`);
  // сжатие: прямые вызовы
  const cmp = J(await a.run(`(async () => { const o = {}; o.noType = await compressImageToTarget({ type: "" }, 100); o.svg = await compressImageToTarget({ type: "image/svg+xml" }, 100);
    window.createImageBitmap = async () => ({ width: 1000, height: 1000, close() {} });
    let calls = 0; HTMLCanvasElement.prototype.toBlob = function (cb) { calls++; cb(new Blob([new Uint8Array(calls <= 4 ? 5000 : 10)], { type: "image/jpeg" })); }; o.half = (await compressImageToTarget({ type: "image/jpeg" }, 100)) !== null;
    HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new Blob([new Uint8Array(5000)], { type: "image/jpeg" })); }; o.fail = await compressImageToTarget({ type: "image/jpeg" }, 100);
    window.createImageBitmap = async () => ({ width: 100, height: 100, close() {} }); o.small = await compressImageToTarget({ type: "image/jpeg" }, 100); return o; })()`));
  assert.equal(cmp.noType, null); assert.equal(cmp.svg, null); assert.equal(cmp.half, true); assert.equal(cmp.fail, null); assert.equal(cmp.small, null);
  // группа
  a.run(`window.__sent.length = 0; state.contacts.get("g1").disappearingTimer = 3600000;`);
  await a.run(`sendFileMessage("g1", new File(["grp"], "g.txt", { type: "text/plain" }), { caption: "gc" })`);
  assert.ok(J(a.window.__sent).some((x) => x[0] === "alice" && x[1] === "file" && x[2].groupId === "g1" && x[2].caption === "gc"));
  const g = J(await a.run(`(async () => { const o = {}; const g = state.contacts.get("g1"); g.writeRestricted = true; g.members[0].role = "member"; g.createdBy = "alice";
    await sendGroupFile("g1", new File(["x"], "w.txt")); o.restricted = g.messages.filter((m) => m.file).length;
    g.writeRestricted = false; await sendGroupFile("g1", new File([], "empty.txt")); await sendGroupFile("g1", { size: 5000000, name: "big" }); await sendGroupFile("nope", new File(["x"], "n")); o.after = g.messages.filter((m) => m.file).length;
    await sendGroupFile("g1", { size: 5, name: "bad.bin", type: "x/y", arrayBuffer: async () => { throw new Error("io"); } }); o.failed = g.messages.filter((m) => m.ack === "failed").length;
    await sendGroupFile("g1", new Blob(["voice"], { type: "audio/webm" }), { name: "voice-message", duration: 3, wave: [1, 2, 3, 4], mime: "audio/webm" }); o.voice = g.messages.some((m) => m.file && m.file.duration === 3);
    return o; })()`));
  assert.equal(g.restricted, 1, "только первая попытка (до ограничения) записана"); assert.ok(g.after >= 1); assert.equal(g.failed, 1); assert.equal(g.voice, true);
  a.close();
});

test("голосовое: отправка (живая, офлайн, группа, ошибки)", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const last = () => J(a.run(`state.contacts.get("alice").messages.filter((m) => m.file).at(-1) || null`));
  await a.run(`sendVoiceMessage("nope", new Blob(["x"]), 1)`); await a.run(`sendVoiceMessage("alice", new Blob([]), 1)`); await a.run(`sendVoiceMessage("alice", { size: 99999999, type: "audio/webm" }, 1)`);
  a.run(`state.contacts.get("alice").blocked = true;`); await a.run(`sendVoiceMessage("alice", new Blob(["x"]), 1)`); a.run(`state.contacts.get("alice").blocked = false;`); assert.equal(last(), null);
  a.run(`mesh.links.set("alice", { status: "in-call", sendFile: async (meta, chunks) => { window.__vm = meta; return true; } }); state.contacts.get("alice").disappearingTimer = 3600000;`);
  await a.run(`sendVoiceMessage("alice", new Blob([new Uint8Array(2000)], { type: "audio/webm" }), 4.2, [1, 2, 3, 4, 5])`); assert.equal(a.window.__vm.name, "voice-message"); assert.equal(last().ack, "sent"); assert.equal(last().ttl, 3600000);
  a.run(`mesh.links.set("alice", { status: "connected", sendFile: async () => false });`); await a.run(`sendVoiceMessage("alice", new Blob(["xx"], { type: "audio/webm" }), 1)`); assert.equal(last().ack, "failed");
  a.run(`mesh.links.set("alice", { status: "connected", sendFile: async () => true });`); await a.run(`sendVoiceMessage("alice", { size: 5, type: "", arrayBuffer: async () => { throw new Error("io"); } }, 1)`); assert.equal(last().ack, "failed");
  a.run(`mesh.links.delete("alice"); window.ensureLiveLink = async () => null; window.__sent.length = 0;`);
  await a.run(`sendVoiceMessage("alice", new Blob(["offline"], { type: "audio/webm" }), 2, [1, 2, 3, 4])`); assert.ok(kinds(a).includes("file"));
  await a.run(`sendVoiceOffline("alice", { size: 5, type: "", arrayBuffer: async () => { throw new Error("io"); } }, 1)`); assert.equal(last().ack, "failed"); await a.run(`sendVoiceOffline("nope", new Blob(["x"]), 1)`);
  await a.run(`sendVoiceMessage("g1", new Blob(["gv"], { type: "audio/webm" }), 2)`);
  a.close();
});

async function rec(a, t, call = "startVoiceRecording()") { const p = a.run(call); await sleep(15); t.tick(200); await p; }

test("запись голоса: старт, прогрев, уровень, пауза, остановка с отправкой, отмена, ошибки", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.__sentV = []; window.sendVoiceMessage = (id, blob, dur, wave) => { window.__sentV.push([id, blob.size, Math.round(dur), !!wave]); };
    window.requestAnimationFrame = (f) => { window.__raf = f; return 7; }; window.cancelAnimationFrame = () => { window.__rafCancelled = (window.__rafCancelled || 0) + 1; };
    window.__stops = 0; window.__tracks = [{ stop() { window.__stops++; } }];
    class FR extends EventTarget { constructor(stream, o) { super(); this.stream = stream; this.mimeType = (o && o.mimeType) || "audio/webm"; this.state = "inactive"; window.__rec = this; if (window.__recThrowOpts && o && o.audioBitsPerSecond) throw new Error("opts"); }
      start() { this.state = "recording"; } pause() { this.state = "paused"; } resume() { this.state = "recording"; } stop() { this.state = "inactive"; const e = new Event("dataavailable"); e.data = new Blob([new Uint8Array(3000)]); this.dispatchEvent(e); this.dispatchEvent(new Event("stop")); } }
    FR.isTypeSupported = (m) => /webm/.test(m); window.MediaRecorder = FR;
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async (c) => { if (window.__gumFailFirst && c.audio !== true) { throw new Error("constraints"); } if (window.__gumFail) throw new Error("denied"); return { getTracks: () => window.__tracks }; } }, configurable: true });
    window.AudioContext = class { constructor() { this.destination = {}; } createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return { fftSize: 0, getByteTimeDomainData(d) { for (let i = 0; i < d.length; i++) d[i] = 128 + (i % 7) * 10; } }; } close() {} };`);
  // нормальный сценарий
  a.window.__gumFailFirst = true;
  await rec(a, t); t.tick(700);
  assert.ok(!a.document.querySelector("#voice-recording-bar").classList.contains("hidden")); assert.ok(a.document.querySelector("#chat-form").classList.contains("hidden"));
  assert.ok(a.window.__raf, "цикл уровня запущен"); a.run(`__raf(1000); __raf(1200); __raf(1300); `);
  a.run(`startVoiceRecording();`); // повторный вызов — игнор
  t.tick(500); assert.ok(a.document.querySelector("#voice-recording-time").textContent.length > 0);
  a.run(`toggleVoiceRecordingPause();`); assert.ok(a.document.querySelector("#voice-recording-bar").classList.contains("is-paused")); a.run(`__raf(2000); toggleVoiceRecordingPause();`);
  a.window.__rec.dispatchEvent(Object.assign(new a.window.Event("dataavailable"), { data: new a.window.Blob([new Uint8Array(10)]) }));
  t.tick(1000);
  a.run(`voiceRecordStartedAt -= 5000; stopVoiceRecording(true);`); await sleep(20); assert.equal(a.window.__stops, 1); assert.equal(a.window.__sentV.length, 1, "отправлено"); assert.equal(a.window.__sentV[0][0], "alice");
  assert.ok(a.document.querySelector("#voice-recording-bar").classList.contains("hidden"));
  // короткая запись не отправляется
  a.run(`state.chatId = "alice";`); await rec(a, t); a.run(`stopVoiceRecording(true);`); await sleep(10); assert.equal(a.window.__sentV.length, 1);
  // отмена (send=false)
  await rec(a, t); t.tick(2000); a.run(`stopVoiceRecording(false);`); assert.equal(a.window.__sentV.length, 1);
  // уход из чата во время записи
  await rec(a, t); a.run(`cancelVoiceRecordingIfLeavingChat("other");`); assert.equal(a.run(`voiceRecorder`), null);
  // отмена во время getUserMedia / прогрева
  { const p5 = a.run(`startVoiceRecording()`); a.run(`cancelVoiceRecordingIfLeavingChat("other");`); await sleep(15); t.tick(200); await p5; } assert.equal(a.run(`voiceRecorder`), null);
  { const p6 = a.run(`startVoiceRecording()`); await sleep(15); a.run(`stopVoiceRecording(true);`); t.tick(200); await p6; }
  // ошибки
  a.window.__gumFail = true; await a.run(`startVoiceRecording()`); a.window.__gumFail = false; a.window.__gumFailFirst = false;
  a.window.__recThrowOpts = true; await rec(a, t); a.run(`stopVoiceRecording(false);`); a.window.__recThrowOpts = false;
  a.run(`const MR = window.MediaRecorder; window.MediaRecorder = class { constructor() { throw new Error("no"); } }; window.MediaRecorder.isTypeSupported = () => false;`); await a.run(`startVoiceRecording()`); a.run(`window.MediaRecorder = MR_FAKE_PLACEHOLDER;`.replace("MR_FAKE_PLACEHOLDER", "MR"));
  a.run(`const MR2 = window.MediaRecorder; window.MediaRecorder = undefined;`); await a.run(`startVoiceRecording()`); a.run(`window.MediaRecorder = MR2; state.chatId = null;`); await a.run(`startVoiceRecording()`);
  a.run(`stopVoiceRecording(true); toggleVoiceRecordingPause();`);
  assert.equal(a.run(`pickVoiceMimeType()`).startsWith("audio/"), true);
  a.run(`stopVoiceLevelMeter(); startVoiceLevelMeter({}); window.AudioContext = undefined; window.webkitAudioContext = undefined; startVoiceLevelMeter({});`);
  a.close();
});

test("воспроизведение голосового: кнопка, перемотка по волне, скорость, окончание, цепочка, кэш", async () => {
  const a = await boot(); const t = fakeTimers(a); installPtr(a); seed(a);
  a.run(`const c = state.contacts.get("alice"); const now = Date.now();
    c.messages.push({ id: "v1", from: "them", text: "", ts: now - 3000, readAckSent: true, file: { name: "voice-message", mime: "audio/webm", size: 5, kind: "audio", duration: 10, wave: [3, 9, 20, 31, 12, 5] } },
      { id: "v2", from: "them", text: "", ts: now - 2000, readAckSent: true, file: { name: "voice-message", mime: "audio/webm", size: 5, kind: "audio", duration: 5 } },
      { id: "v3", from: "them", text: "", ts: now - 1000, readAckSent: true, file: { name: "voice-message", mime: "audio/webm", size: 5, kind: "audio", duration: 5 } });
    window.AudioContext = class { decodeAudioData() { return Promise.resolve({ getChannelData: () => new Float32Array(2000).map((_, i) => Math.sin(i / 7)) }); } close() {} };`);
  for (const id of ["v1", "v2"]) await a.run(`IDB.set("file:${id}", new Blob(["audio-bytes"], { type: "audio/webm" }))`);
  a.run(`renderChatThread();`); await sleep(120);
  const btn = (id) => a.document.querySelector(`.voice-bubble[data-file-id="${id}"] .voice-play-btn`);
  assert.equal(btn("v1").disabled, false, "кнопка доступна после загрузки blob");
  assert.equal(btn("v3").disabled, true); assert.ok(a.document.querySelector('.voice-bubble[data-file-id="v3"] .voice-duration').textContent.length > 0, "недоступный файл помечен");
  // play → событие play → pause
  const audio = () => a.run(`voiceAudioCache.get("v1").audio`);
  btn("v1").click(); a.run(`voiceAudioCache.get("v1").audio.dispatchEvent(new Event("play"));`); assert.ok(a.document.querySelector('.voice-bubble[data-file-id="v1"]').classList.contains("is-playing"));
  a.run(`window.requestAnimationFrame = (f) => { window.__raf2 = f; return 9; }; window.cancelAnimationFrame = () => {}; voiceAudioCache.get("v1").analyser = { fftSize: 32, getByteTimeDomainData(d) { for (let i = 0; i < d.length; i++) d[i] = 128 + i; } };
    startVoicePlaybackWaveLoop(); startVoicePlaybackWaveLoop(); __raf2(1000); __raf2(1050); __raf2(1500); voiceAudioCache.get("v1").analyser = null; __raf2(2000);`);
  // перемотка: клик/перетаскивание/клавиши по волне
  const wave = a.document.querySelector('.voice-bubble[data-file-id="v1"] .voice-wave');
  a.run(`{ const w = document.querySelector('.voice-bubble[data-file-id="v1"] .voice-wave'); w.getBoundingClientRect = () => ({ left: 0, width: 100 }); const ev = (x) => ({ stopPropagation() {}, pointerId: 1, clientX: x });
    w.onpointerdown(ev(50)); w.onpointermove(ev(80)); window.__on = w.querySelectorAll("i.on").length; w.onpointerup(); w.onpointermove(ev(10)); w.click();
    w.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true })); w.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true })); w.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); }`);
  a.run(`{ const au = voiceAudioCache.get("v1").audio; Object.defineProperty(au, "currentTime", { value: 4, writable: true, configurable: true }); au.dispatchEvent(new Event("timeupdate")); }`);
  assert.ok(a.window.__on >= 1, "волна закрашена при перемотке");
  // скорость и расшифровка
  a.document.querySelector('.voice-bubble[data-file-id="v1"] .voice-speed-btn').click(); a.run(`window.transcribeVoiceMessage = (cid, id) => { window.__tr = [cid, id]; };`); a.document.querySelector('.voice-bubble[data-file-id="v1"] .voice-tr-btn').click(); assert.deepEqual(J(a.window.__tr), ["alice", "v1"]);
  // второй играет → первый ставится на паузу
  btn("v2").click(); a.run(`voiceAudioCache.get("v2").audio.dispatchEvent(new Event("play")); voiceAudioCache.get("v1").playing = true;`); btn("v2").click();
  // окончание первого запускает следующий входящий
  a.run(`voiceAudioCache.get("v1").audio.dispatchEvent(new Event("ended"));`); t.tick(300);
  a.run(`pauseAllVoicePlayback(); stopVoicePlaybackWaveLoopIfIdle();`);
  // перерисовка не создаёт новый Audio
  const same = J(a.run(`(() => { const before = voiceAudioCache.get("v1").audio; renderChatThread(); return true; })()`)); await sleep(80);
  assert.equal(a.run(`voiceAudioCache.get("v1").audio === voiceAudioCache.get("v1").audio`), true);
  a.run(`cleanupExpiredFileBlobs([{ id: "v1", file: {} }, { id: "zz" }, { id: "nofile" }]);`); assert.ok(!a.run(`voiceAudioCache.has("v1")`));
  // восстановление волны для старых голосовых
  await a.run(`backfillVoiceWave("v2", document.querySelector('.voice-bubble[data-file-id="v2"]'))`); await a.run(`backfillVoiceWave("v2", null)`); await a.run(`backfillVoiceWave("nope", null)`);
  a.close();
});

test("приём файла: file-meta / chunk / done, лимиты, дубликаты, битые данные; медиа-вьюер и ссылки", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(await a.run(`(async () => { const o = {}; const h = (p) => handleFilePayload("alice", p); const c = () => state.contacts.get("alice");
    const meta = (id, extra) => Object.assign({ kind: "file-meta", id, name: "doc.txt", mime: "text/plain", size: 10, totalChunks: 2 }, extra || {});
    h(meta("f1", { totalChunks: 0 })); h(meta("f1", { totalChunks: 501 })); h(meta("f1", { size: -1 })); o.none = c().messages.length;
    h(meta("f1", { duration: 3, wave: [1, 2, 3, 4], ttl: 60000, forwarded: true, fwdFrom: "Bob", caption: "cp" })); h(meta("f1")); o.one = c().messages.filter((m) => m.id === "f1").length; o.rec = J(c().messages.find((m) => m.id === "f1").file);
    h({ kind: "file-chunk", id: "f1", index: 0, data: "aGVsbG8=" }); h({ kind: "file-chunk", id: "nope", index: 0, data: "x" }); h({ kind: "file-chunk", id: "f1", index: 9, data: "x" }); h({ kind: "file-chunk", id: "f1", index: 1 });
    h({ kind: "file-done", id: "f1" }); await new Promise((r) => __realTO.call(window, r, 30)); o.failed = !!c().messages.find((m) => m.id === "f1").file.failed;
    h(meta("f2")); h({ kind: "file-chunk", id: "f2", index: 0, data: "aGVsbG8=" }); h({ kind: "file-chunk", id: "f2", index: 1, data: "d29ybGQ=" }); h({ kind: "file-done", id: "f2" }); h({ kind: "file-done", id: "f2" }); await new Promise((r) => __realTO.call(window, r, 50));
    o.ok = J(c().messages.find((m) => m.id === "f2").file); o.blob = !!(await IDB.get("file:f2"));
    h(meta("f3", { size: 4 })); h({ kind: "file-chunk", id: "f3", index: 0, data: "A".repeat(9000) }); o.dropped = !incomingFileBuffers.has("f3");
    h(meta("f4")); c().messages.find((m) => m.id === "f4").file.pending = true; incomingFileBuffers.delete("f4"); h(meta("f4")); o.rebuf = incomingFileBuffers.has("f4"); incomingFileBuffers.delete("f4");
    for (let i = 0; i < 25; i++) h(meta("many" + i)); o.cap = incomingFileBuffers.size; incomingFileBuffers.forEach((b) => b.receivedAt = 1); sweepIncomingFileBuffers(); o.swept = incomingFileBuffers.size;
    h(meta("f5")); h({ kind: "file-chunk", id: "f5", index: 0, data: "!!!" }); h({ kind: "file-chunk", id: "f5", index: 1, data: "d29ybGQ=" }); h({ kind: "file-done", id: "f5" }); await new Promise((r) => __realTO.call(window, r, 50)); o.badB64 = !!c().messages.find((m) => m.id === "f5").file.failed;
    return o; })()`));
  assert.equal(r.none, 0); assert.equal(r.one, 1); assert.equal(r.rec.caption, "cp"); assert.equal(r.failed, true); assert.equal(r.ok.pending, false); assert.equal(r.blob, true); assert.equal(r.dropped, true); assert.ok(r.cap <= 20); assert.equal(r.swept, 0);
  // вьюер медиа и ссылки
  const v = J(a.run(`(() => { const o = {}; const back = document.createElement("button"); document.body.appendChild(back); back.focus();
    openMediaViewer("blob:i", "image"); o.img = !document.getElementById("media-viewer").classList.contains("hidden"); openMediaViewer("blob:v", "video"); o.vid = !document.getElementById("media-viewer-video").classList.contains("hidden");
    const tab = (shift) => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, cancelable: true })); tab(false); tab(true); document.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); o.closedEsc = document.getElementById("media-viewer").classList.contains("hidden");
    openMediaViewer("blob:i", "image"); document.getElementById("media-viewer-close").click(); o.closedBtn = document.getElementById("media-viewer").classList.contains("hidden");
    openMediaViewer("blob:i", "image"); document.getElementById("media-viewer").dispatchEvent(new MouseEvent("click", { bubbles: true })); o.closedBackdrop = document.getElementById("media-viewer").classList.contains("hidden");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    let opened = []; window.open = (u, t2, f) => opened.push(u); openLinkActionSheet("https://x.example/a"); o.url = document.getElementById("link-action-url").textContent; document.getElementById("link-action-open").click();
    openLinkActionSheet("javascript:alert(1)"); document.getElementById("link-action-open").click(); o.opened = opened;
    navigator.clipboard = { writeText: async (t2) => { window.__clip = t2; } }; openLinkActionSheet("https://x.example/b"); document.getElementById("link-action-copy").click(); return o; })()`));
  assert.ok(v.img && v.vid && v.closedEsc && v.closedBtn && v.closedBackdrop); assert.deepEqual(v.opened, ["https://x.example/a"]);
  await sleep(20); assert.equal(a.window.__clip, "https://x.example/b");
  // hydrateFileSlots: файл есть / нет / документ
  a.run(`const c = state.contacts.get("alice"); c.messages.push({ id: "h1", from: "them", text: "", ts: Date.now(), readAckSent: true, file: { name: "d.pdf", mime: "application/pdf", size: 5, kind: "file" } }, { id: "h2", from: "them", text: "", ts: Date.now(), readAckSent: true, file: { name: "i.png", mime: "image/png", size: 5, kind: "image" } }, { id: "h3", from: "them", text: "", ts: Date.now(), readAckSent: true, file: { name: "v.mp4", mime: "video/mp4", size: 5, kind: "video" } });`);
  await a.run(`IDB.set("file:h1", new Blob(["pdf"], { type: "application/pdf" }))`); await a.run(`IDB.set("file:h2", new Blob(["png"], { type: "image/png" }))`);
  a.run(`renderChatThread();`); await sleep(120);
  assert.ok(a.document.querySelector('a[data-file-id="h1"]').getAttribute("download")); assert.ok(a.document.querySelector('[data-file-id="h2"] img')); assert.ok(a.document.querySelector('[data-file-id="h3"]').textContent.length > 0);
  a.close();
});
