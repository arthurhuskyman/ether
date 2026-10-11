// Регрессии по найденным багам: черновик/правка, квитанция о файле, дебаунс звонка, TURN-проверка, аватар.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

async function booted() {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}

test("B1: текст правки не сохраняется как черновик при выходе из чата", async () => {
  const a = await booted();
  a.run(`ensureContactEntry("alice", "Alice"); state.chatId = "alice"; state.drafts = {};`);
  const input = a.document.querySelector("#chat-input");
  input.value = "правлю чужой текст";
  a.run(`state.editingMessageId = "m1"; saveCurrentDraft();`);
  assert.equal(a.run(`JSON.stringify(state.drafts)`), "{}");
  a.run(`state.editingMessageId = null; saveCurrentDraft();`);
  assert.equal(a.run(`state.drafts.alice`), "правлю чужой текст", "обычный черновик по-прежнему сохраняется");
  a.close();
});

test("B3: быстрый повторный звонок после провала показывает подсказку вместо тихого игнора", async () => {
  const a = await booted();
  a.run(`ensureContactEntry("alice", "Alice"); window.__toasts = []; const o = window.toast; toast = (m) => { window.__toasts.push(String(m)); };`);
  a.run(`state._lastCallFailedAt = Date.now(); beginCall("alice");`);
  assert.match(a.run(`window.__toasts.join("|")`), /last call just failed/i);
  a.close();
});

test("B7: TURN-проверка идёт параллельно, а не по очереди", async () => {
  const a = await booted();
  a.run(`ICE_SERVERS = [{ urls: ["turn:a.example:3478", "turn:b.example:3478", "turn:c.example:3478", "turn:d.example:3478"], username: "u", credential: "p" }];
    window.__calls = 0; etherTurnCheckOne = (u) => { window.__calls++; return new Promise((r) => setTimeout(() => r({ url: u, ok: true }), 150)); };`);
  const t0 = Date.now();
  a.window.__res = undefined;
  a.run(`etherTurnCheck().then((r) => { window.__res = r.length; })`);
  for (let i = 0; i < 100 && a.window.__res === undefined; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.window.__res, 4);
  assert.ok(Date.now() - t0 < 450, "4 адреса по 150 мс заняли " + (Date.now() - t0) + " мс — не параллельно");
  a.close();
});

test("B12: огромный файл не читается как аватар", async () => {
  const a = await booted();
  a.window.__out = undefined;
  a.run(`readImageAsAvatarDataUrl({ size: 30 * 1024 * 1024 }).then(() => { window.__out = "ok"; }, (e) => { window.__out = String(e.message); })`);
  for (let i = 0; i < 50 && a.window.__out === undefined; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.window.__out, "image too large");
  a.close();
});

test("B5: блокировка PIN инициализирована явно", async () => {
  const a = await booted();
  assert.strictEqual(a.run(`state._unlockLockedUntil`), 0);
  a.close();
});
