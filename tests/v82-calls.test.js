// V.82: звонки 1:1 — «Переподключение…» при обрыве ICE, режим звука «голос/музыка», «вас плохо слышно», прогрев связи при открытии чата.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

test("переподключение: плашка при disconnected, снятие и тост при connected; вне активного звонка — ничего", async () => {
  const a = await boot();
  const d = a.document;
  a.run(`state.callId = "bob"; state.callPhase = "ringing"; onCallIceState("bob", "disconnected");`);
  assert.equal(d.querySelector("#call-notice").classList.contains("hidden"), true);
  a.run(`state.callPhase = "active"; setCallNotice("quality", "Q"); onCallIceState("bob", "disconnected");`);
  assert.equal(d.querySelector("#call-notice").textContent, a.run(`T("call.reconnecting")`));
  assert.equal(d.querySelector("#call-screen").classList.contains("call-reconnecting"), true);
  a.run(`onCallIceState("alice", "connected");`); // чужой линк не снимает плашку
  assert.equal(d.querySelector("#call-notice").textContent, a.run(`T("call.reconnecting")`));
  a.run(`onCallIceState("bob", "connected");`);
  assert.equal(d.querySelector("#call-notice").textContent, "Q");
  assert.equal(d.querySelector("#call-screen").classList.contains("call-reconnecting"), false);
  a.close();
});

test("режим звука: музыка выключает обработку на лету и для следующего захвата; голос возвращает", async () => {
  const a = await boot();
  a.run(`(() => { window.__c = []; const tr = { applyConstraints: async (c) => { window.__c.push(c); } };
    mesh.links.set("bob", { id: "bob", status: "in-call", localAudioTrack: tr, send() { return true; } }); state.callId = "bob"; })()`);
  await a.run(`setCallAudioMode("music")`);
  assert.equal(a.run(`callAudioMode()`), "music");
  assert.deepEqual(J(a.run(`window.__c[0]`)), { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  assert.equal(a.run(`audioCaptureForMode().noiseSuppression`), false);
  await a.run(`setCallAudioMode("voice")`);
  assert.deepEqual(J(a.run(`window.__c[1]`)), { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  assert.equal(a.run(`audioCaptureForMode().noiseSuppression`), true);
  a.close();
});

test("прогрев: при открытии личного чата — attemptConnect и обновление ICE не чаще раза в 20 с; при живой связи — ничего", async () => {
  const a = await boot();
  a.run(`(() => { window.__ac = 0; window.attemptConnect = async () => { window.__ac++; }; })()`);
  a.run(`prewarmLink("bob"); prewarmLink("bob");`);
  assert.equal(a.run(`window.__ac`), 1);
  a.run(`mesh.links.set("carol", { id: "carol", status: "connected" }); prewarmLink("carol");`);
  assert.equal(a.run(`window.__ac`), 1);
  a.close();
});
