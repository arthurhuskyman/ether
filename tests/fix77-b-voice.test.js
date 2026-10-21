// V.77 B1/B11: лимит голосовой записи (предупреждение + автостоп) и отправка при уже остановленном recorder.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, J } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; ensureContactEntry("alice", "Alice").managed = true;
    state.contacts.set("g1", { id: "g1", name: "Team", isGroup: true, managed: true, createdBy: "me", members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice" }], messages: [], lastActivity: 1 });
    window.__toasts = []; toast = (m) => window.__toasts.push(m);
    window.__sent = []; sendVoiceMessage = (cid, blob, dur) => { window.__sent.push({ cid, size: blob.size, dur }); };
    window.__fakeRec = (state) => ({ state, mimeType: "audio/webm", stopped: 0, listeners: {}, addEventListener(n, f) { this.listeners[n] = f; }, stop() { this.stopped++; this.state = "inactive"; if (this.listeners.stop) this.listeners.stop(); } });
  })()`);
}
const setRec = (a, cap, bytes, elapsed) => a.run(`(() => { voiceRecorder = __fakeRec("recording"); voiceRecordChunks = [new Blob(["abc"])]; voiceRecordTargetChatId = "alice"; voiceRecordStartedAt = Date.now() - ${elapsed} * 1000; voiceRecordPausedTotal = 0; voiceRecordPaused = false;
  voiceRecordCapBytes = ${cap}; voiceRecordBytes = ${bytes}; voiceRecordWarned = false; })()`);

test("B1: за ~10 с до потолка один раз предупреждает, у потолка останавливает и отправляет", async () => {
  const a = await boot(); seed(a);
  const cap = 1024 * 1024;
  setRec(a, cap, 0, 1);
  a.run(`voiceRecordLimitCheck()`);
  assert.equal(a.run(`__toasts.length`), 0);
  a.run(`voiceRecordBytes = ${cap} - 8 * 13200; voiceRecordLimitCheck(); voiceRecordLimitCheck();`);
  assert.deepEqual(J(a.run(`__toasts`)), [a.run(`T("toast.voiceLimitSoon", { sec: 8 })`)]);
  assert.equal(a.run(`voiceRecorder !== null`), true);
  a.run(`voiceRecordBytes = ${cap} - 5000; voiceRecordLimitCheck();`);
  assert.equal(a.run(`voiceRecorder`), null);
  assert.equal(a.run(`__toasts[__toasts.length - 1]`), a.run(`T("toast.voiceLimitReached")`));
  assert.equal(a.run(`__sent.length`), 1);
  assert.equal(a.run(`__sent[0].cid`), "alice");
  a.close();
});

test("B1: на паузе лимит не проверяется", async () => {
  const a = await boot(); seed(a);
  setRec(a, 1000, 5000, 1);
  a.run(`voiceRecordPaused = true; voiceRecordPausedAt = Date.now(); voiceRecordLimitCheck();`);
  assert.equal(a.run(`voiceRecorder !== null`), true);
  assert.equal(a.run(`GROUP_FILE_MAX < MAX_FILE_SIZE`), true);
  a.close();
});

test("B11: recorder уже inactive — голосовое всё равно собирается из накопленных чанков", async () => {
  const a = await boot(); seed(a);
  setRec(a, 2e6, 0, 3);
  a.run(`voiceRecorder.state = "inactive"; voiceRecorder.stop = () => { throw new Error("InvalidStateError"); }; stopVoiceRecording(true);`);
  assert.equal(a.run(`__sent.length`), 1);
  assert.equal(a.run(`__sent[0].size`), 3);
  // не отправляем при отмене
  setRec(a, 2e6, 0, 3);
  a.run(`voiceRecorder.state = "inactive"; stopVoiceRecording(false);`);
  assert.equal(a.run(`__sent.length`), 1);
  // и ровно один раз при обычной остановке
  setRec(a, 2e6, 0, 3);
  a.run(`stopVoiceRecording(true);`);
  assert.equal(a.run(`__sent.length`), 2);
  a.close();
});

test("B1: строки лимита есть в en и ru", () => {
  for (const l of ["en", "ru"]) {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "js", "lang", l + ".js"), "utf8");
    assert.match(src, /"toast\.voiceLimitSoon":/); assert.match(src, /"toast\.voiceLimitReached":/);
  }
});
