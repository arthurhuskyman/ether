// V.82: автоблокировка в фоне (экран-замок поверх работающего приложения), размытие в фоне, имена для push — только на устройстве.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { closeAll } = require("./harness");
const { boot, sleep } = require("./cov-helpers");
test.after(closeAll);

function setHidden(a, hidden) {
  Object.defineProperty(a.document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(a.document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  a.document.dispatchEvent(new a.window.Event("visibilitychange"));
}

test("автоблокировка: выключена без PIN; с PIN и 1 мин — замок после фона, без перезапуска; не во время звонка; размытие в фоне", async () => {
  const a = await boot();
  const d = a.document;
  a.run(`state.tab = "settings"; renderTab();`);
  assert.equal(d.querySelector("#settings-autolock-row").classList.contains("hidden"), true);
  // PIN 123456 + автоблокировка 1 мин
  const pl = d.querySelector("#settings-pinlock"); pl.checked = true; pl.dispatchEvent(new a.window.Event("change"));
  d.querySelector("#set-pin-input").value = "123456"; d.querySelector("#set-pin-save-btn").click(); await sleep(700);
  assert.equal(a.run(`Store.pinEnabled`), true);
  assert.equal(d.querySelector("#settings-autolock-row").classList.contains("hidden"), false);
  const sel = d.querySelector("#settings-autolock"); sel.value = "1"; sel.dispatchEvent(new a.window.Event("change"));
  assert.equal(a.run(`autoLockMinutes()`), 1);
  // короткий уход — без замка, но с размытием в фоне
  setHidden(a, true); assert.equal(d.documentElement.classList.contains("privacy-veil"), true);
  setHidden(a, false); assert.equal(d.documentElement.classList.contains("privacy-veil"), false);
  assert.equal(d.querySelector("#lock-screen").classList.contains("hidden"), true);
  // долгий уход во время звонка — без замка
  setHidden(a, true); a.run(`__hiddenAt = Date.now() - 120000; state.callId = "c1";`); setHidden(a, false);
  assert.equal(d.querySelector("#lock-screen").classList.contains("hidden"), true);
  a.run(`state.callId = null;`);
  // долгий уход — замок; приложение не перезапускается
  a.run(`window.__booted = 0; const ob = bootAfterUnlock; window.bootAfterUnlock = () => { window.__booted++; };`);
  setHidden(a, true); a.run(`__hiddenAt = Date.now() - 120000;`); setHidden(a, false);
  assert.equal(d.querySelector("#lock-screen").classList.contains("hidden"), false);
  assert.equal(d.querySelector("#app-shell").classList.contains("hidden"), true);
  await a.run(`tryUnlock("000000")`); await sleep(200);
  assert.equal(d.querySelector("#lock-screen").classList.contains("hidden"), false);
  await a.run(`tryUnlock("123456")`); await sleep(200);
  assert.equal(d.querySelector("#lock-screen").classList.contains("hidden"), true);
  assert.equal(d.querySelector("#app-shell").classList.contains("hidden"), false);
  assert.equal(a.run(`window.__booted`), 0);
  a.close();
});

test("push без имени: сервер по умолчанию не кладёт имя; SW подставляет имя из индекса ./__names.json", () => {
  const root = path.join(__dirname, "..");
  const srv = fs.readFileSync(path.join(root, "signaling-server", "server.js"), "utf8");
  assert.match(srv, /const PUSH_NAMES = process\.env\.PUSH_NAMES === "1";/);
  assert.ok(!/title: \(\w+ && \w+\.name\) \|\| pushText/.test(srv), "имя отправителя не должно попадать в заголовок push");
  assert.match(srv, /name: PUSH_NAMES \? rec\.name : undefined/);
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  assert.match(sw, /data\.type === "names-index"/);
  assert.match(sw, /metaGet\("\.\/__names\.json"\)/);
});
