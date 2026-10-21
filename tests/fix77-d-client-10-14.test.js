// Аудит V.76 раздел 5 (D1–D14): регрессии клиента js/app/10–14.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot } = require("./cov-helpers");
const { readAppSource } = require("./src-helper");
test.after(closeAll);
const src = readAppSource();
const has = (re) => assert.match(src, re);

async function app() {
  const a = await boot();
  a.run(`ensureContactEntry("alice","Alice"); ensureContactEntry("bob","Bob");`);
  return a;
}

test("D1: resetChatTransientState сбрасывает ответ/правку/мультивыбор при смене чата, но не в том же чате", async () => {
  const a = await app();
  a.run(`state.chatId = "alice"; state.replyTo = {msgId:"x", text:"t", from:"them"}; state.editingMessageId = "m"; state.multiSelect = new Set(["m"]);`);
  a.run(`resetChatTransientState("alice")`);
  assert.ok(a.run(`state.replyTo !== null && state.editingMessageId === "m"`), "тот же чат — не трогаем");
  a.run(`jumpToMessageInChat("bob", "zzz")`);
  assert.equal(a.run(`state.replyTo`), null);
  assert.equal(a.run(`state.editingMessageId`), null);
  assert.equal(a.run(`state.multiSelect`), null);
  assert.equal(a.run(`state.chatId`), "bob");
  a.close();
});

test("D1: все прямые присвоения state.chatId в 10–14 предваряются сбросом", () => {
  for (const f of ["11-qr-sheets-translate", "12-calls-search", "13-settings-debug", "14-backup-boot"]) {
    const t = require("fs").readFileSync(require("path").join(__dirname, "..", "js/app", f + ".js"), "utf8");
    for (const line of t.split("\n")) if (/state\.chatId = (?!null\b)[^=]/.test(line) && !/function resetChatTransientState/.test(line)) {
      const idx = t.indexOf(line);
      assert.ok(/resetChatTransientState/.test(t.slice(Math.max(0, idx - 400), idx + line.length)), f + ": " + line.trim());
    }
  }
});

test("D2: stopQrScan инвалидирует токен; камера после закрытия шторки гасится", () => {
  has(/qrScanToken/); has(/myToken !== qrScanToken/);
  has(/gotStream\.getTracks\(\)\.forEach/);
});

test("D3: call-invite при групповом звонке отвечает call-busy", () => {
  has(/state\.callId !== from\) \|\| \(typeof gcallBusy === "function" && gcallBusy\(\)\)\)/);
});

test("D4: pinSave защищён busy-флагом", () => {
  has(/let pinSaveBusy = false/); has(/if \(pinSaveBusy\) return;/);
});

test("D5: смена id сбрасывает Ratchet и envelopeCache", () => {
  const t = require("fs").readFileSync(require("path").join(__dirname, "..", "js/app/13-settings-debug.js"), "utf8");
  assert.match(t, /Store\.myId = identity\.id;\s*try \{ Ratchet\.resetAll\(\); \} catch \(e2\) \{\}[^\n]*\n\s*try \{ envelopeCache\.clear\(\)/);
});

test("D6/D13: имена из presence/packet.n обрезаются, heartbeat валидируется", () => {
  has(/u\.name\.slice\(0, 40\)/); has(/packet\.n\.slice\(0, 40\)/);
  has(/payload\.thresholdDays/); has(/thr >= 1 && thr <= 3650/); has(/payload\.ts <= nowTs \+ 60000/);
});

test("D7: handleIncomingCode бросает на мусоре и не-offer (вызывающие показывают toast)", async () => {
  const a = await app();
  assert.equal(await a.run(`handleIncomingCode("garbage!!").then(() => "ok", () => "threw")`), "threw");
  a.close();
});

test("D8: createInvite не запускается повторно", async () => {
  const a = await app();
  a.run(`__createInviteBusy = true; state.pendingOutgoing = null;`);
  await a.run(`createInvite()`);
  assert.equal(a.run(`state.pendingOutgoing`), null);
  a.close();
});

test("D9: второй confirmSheet резолвит первый в false", async () => {
  const a = await app();
  const r = await a.run(`(async () => { const p1 = confirmSheet("one"); const p2 = confirmSheet("two"); const r1 = await p1; __confirmSheetResolve && __confirmSheetResolve(true); return [r1, await p2]; })()`);
  assert.deepEqual(Array.from(r), [false, true]);
  a.close();
});

test("D10: applyImportedData откатывает при сбое записи, без сырого e.message", () => {
  has(/const snapshot = \{\};/); has(/toast\(T\("toast\.importFailed"\)\)/);
  assert.doesNotMatch(src, /catch \(e\) \{ toast\(String\(e\.message\)\); \}\n\}\n\/\/ Применение/);
});

test("D11: clearOldMedia чистит fileBlobUrlCache/voiceAudioCache", () => {
  has(/clearOldMedia[\s\S]{0,900}fileBlobUrlCache\.get\(m\.id\)[\s\S]{0,300}voiceAudioCache\.delete\(m\.id\)/);
});

test("D12: цикл тем включает oled", async () => {
  const a = await app();
  a.run(`Store.theme = "dark"; onSettingsQuick("theme")`);
  assert.equal(a.run(`Store.theme`), "oled");
  a.run(`onSettingsQuick("theme")`);
  assert.equal(a.run(`Store.theme`), "auto");
  a.close();
});

test("D14: после локальной ошибки микрофона голосовая почта не предлагается", () => {
  has(/closeCallScreen\("failed", \{ localError: true \}\)/); has(/!\(opts && opts\.localError\) && rec\.direction/);
});

test("A3: heartbeat off снимает наблюдение; B5: новая группа только от админа, createdBy из members", () => {
  has(/if \(payload\.off\) \{[\s\S]{0,200}delete c\.lastHeartbeatAt; delete c\.heartbeatThresholdDays; delete c\.heartbeatAlertedAt;/);
  has(/senderIsAdmin/); has(/createdBy: cbOk \? payload\.createdBy : from/);
});
