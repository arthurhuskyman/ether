// V.81: пароль вместо цифрового PIN; D9 — напоминания и данные мини-приложений под SecureStore.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep } = require("./cov-helpers");
test.after(closeAll);

test("пароль: короткий отвергается, от 8 символов принимается, экран блокировки получает текстовую клавиатуру", async () => {
  const a = await boot();
  const d = a.document;
  const flow = async (pin) => { d.querySelector("#set-pin-input").value = pin; d.querySelector("#set-pin-save-btn").click(); await sleep(700); };
  a.run(`state.tab = "settings"; renderTab();`);
  const pl = d.querySelector("#settings-pinlock"); pl.checked = true; pl.dispatchEvent(new a.window.Event("change"));
  d.querySelector("#set-pin-kind-btn").click();
  assert.equal(d.querySelector("#set-pin-input").getAttribute("inputmode"), "text");
  await flow("abc12"); assert.equal(a.run(`Store.pinEnabled`), false); // короче 8 — нет
  await flow("x".repeat(65)); assert.equal(a.run(`Store.pinEnabled`), false); // длиннее 64 — нет
  await flow("correct horse"); assert.equal(a.run(`Store.pinEnabled`), true);
  assert.equal(a.run(`localStorage.getItem("ether.pinKind")`), "pass");
  a.run(`applyPinKindToLock()`);
  assert.equal(d.querySelector("#lock-pin").getAttribute("inputmode"), "text");
  assert.equal(a.run(`T("lock.subPass")`), d.querySelector("#lock-screen .onboarding-sub").textContent);
  // разблокировка паролем
  await a.run(`tryUnlock("correct horse")`); await sleep(300);
  assert.equal(d.querySelector("#lock-screen").classList.contains("hidden"), true);
  a.close();
});

test("D9: напоминания и данные мини-приложений входят в защищаемые ключи SecureStore", async () => {
  const a = await boot();
  const keys = a.run(`SecureStore.KEYS.slice()`);
  for (const k of ["ether.reminders", "ether.miniapps.state", "ether.miniapps.inbox", "ether.miniapps.perms", "ether.chatFolders"]) assert.ok(keys.includes(k), k);
  a.close();
});
