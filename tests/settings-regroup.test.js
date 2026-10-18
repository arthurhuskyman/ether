// Настройки: «Часто используемые» (6 плиток) и «Дополнительно» (свёрнуто по умолчанию, запоминается, поиск раскрывает).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted(storage) {
  const a = createApp({ storage: Object.assign({ "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" }, storage || {}) });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  a.run(`state.tab = "settings"; state.chatId = null; renderTab();`);
  await sleep(60);
  return a;
}
const collapsed = (d, id) => d.getElementById(id).closest("[data-settings-adv]").classList.contains("adv-collapsed");

test("вверху экрана — блок «Часто используемые» с 6 плитками, список категорий на месте", async () => {
  const a = await booted(); const d = a.document;
  const tiles = Array.from(d.querySelectorAll("#settings-category-list .settings-quick-tile"));
  assert.deepEqual(tiles.map((t) => t.dataset.quick), ["theme", "skin", "sounds", "notifications", "pin", "backup"]);
  assert.match(d.querySelector(".settings-quick-title").textContent, /Часто используемые/);
  assert.equal(d.querySelectorAll("#settings-category-list .settings-category-row").length, 6);
  assert.ok(d.querySelector(".settings-quick").compareDocumentPosition(d.querySelector(".settings-category-row")) & 4, "блок выше категорий");
  a.close();
});

test("плитки-переключатели меняют реальные настройки; тема переключается; переходы открывают категорию", async () => {
  const a = await booted(); const d = a.document;
  const tile = (id) => d.querySelector(`.settings-quick-tile[data-quick="${id}"]`);
  const before = a.run(`Store.soundsEnabled`);
  tile("sounds").click(); await sleep(450);
  assert.equal(a.run(`Store.soundsEnabled`), !before);
  assert.equal(tile("sounds").getAttribute("aria-pressed"), String(!before));
  assert.equal(d.getElementById("settings-sounds").checked, !before);
  a.run(`Store.theme = "auto"`);
  tile("theme").click();
  assert.equal(a.run(`Store.theme`), "light");
  tile("theme").click(); assert.equal(a.run(`Store.theme`), "dark");
  tile("skin").click(); await sleep(80);
  assert.equal(a.run(`state.settingsCategory`), "appearance");
  a.run(`closeSettingsCategory()`);
  tile("backup").click(); await sleep(80);
  assert.equal(a.run(`state.settingsCategory`), "data");
  a.close();
});

test("редкие строки свёрнуты по умолчанию, id не изменились; кнопка «Дополнительно» раскрывает и запоминает", async () => {
  const a = await booted(); const d = a.document;
  for (const id of ["settings-require-verified", "settings-ringtone", "settings-encrypt-store", "settings-link-previews", "settings-bubble-size", "settings-wallpaper", "settings-local-ai", "settings-delete-account-btn", "settings-deadman-enabled", "settings-signaling-url"]) assert.ok(collapsed(d, id), id + " свёрнут");
  for (const id of ["settings-notifications", "settings-sounds", "settings-pinlock", "settings-readable-mode", "settings-calm-mode", "settings-receipts", "settings-export-backup-btn", "settings-name", "settings-language"]) {
    assert.ok(d.getElementById(id), id); assert.ok(!d.getElementById(id).closest(".adv-collapsed"), id + " виден");
  }
  a.run(`openSettingsCategory("notifications")`); await sleep(30);
  const btn = d.querySelector('.settings-adv-toggle[data-adv-cat="notifications"]');
  assert.ok(btn && !btn.classList.contains("category-hidden") && btn.getAttribute("aria-expanded") === "false");
  assert.ok(d.querySelector('.settings-adv-toggle[data-adv-cat="appearance"]').classList.contains("category-hidden"), "кнопки других категорий скрыты");
  btn.click(); await sleep(30);
  assert.equal(collapsed(d, "settings-ringtone"), false);
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.equal(JSON.parse(a.window.localStorage.getItem("ether.settingsAdv")).notifications, true);
  assert.equal(collapsed(d, "settings-bubble-size"), true, "другая категория не затронута");
  btn.click(); await sleep(30);
  assert.equal(collapsed(d, "settings-ringtone"), true);
  a.close();
});

test("раскрытое состояние запоминается между запусками", async () => {
  const a = await booted({ "ether.settingsAdv": JSON.stringify({ appearance: true }) }); const d = a.document;
  assert.equal(collapsed(d, "settings-bubble-size"), false);
  assert.equal(collapsed(d, "settings-ringtone"), true);
  a.close();
});

test("поиск находит строки и в свёрнутом «Дополнительно» (показывает их), после очистки снова свёрнуто", async () => {
  const a = await booted(); const d = a.document;
  const s = d.getElementById("settings-search");
  s.value = "рингтон"; s.dispatchEvent(new a.window.Event("input", { bubbles: true })); await sleep(40);
  assert.ok(d.getElementById("screen-settings").classList.contains("settings-searching"), "в поиске свёрнутое видно");
  const row = d.getElementById("settings-ringtone").closest(".settings-row");
  assert.ok(!row.classList.contains("search-hidden"), "строка найдена");
  assert.ok(!d.getElementById("settings-ringtone").closest(".settings-group").classList.contains("category-hidden"));
  assert.ok(Array.from(d.querySelectorAll(".settings-adv-toggle")).every((b) => b.classList.contains("category-hidden")));
  s.value = ""; s.dispatchEvent(new a.window.Event("input", { bubbles: true })); await sleep(40);
  assert.ok(!d.getElementById("screen-settings").classList.contains("settings-searching"));
  assert.equal(collapsed(d, "settings-ringtone"), true);
  a.close();
});

test("CSS: свёрнутое скрывается только вне поиска; ключи i18n в en и ru", () => {
  const fs = require("fs"), path = require("path"), root = path.join(__dirname, "..");
  const css = fs.readFileSync(path.join(root, "css", "styles.css"), "utf8");
  assert.match(css, /#screen-settings:not\(\.settings-searching\) \.adv-collapsed \{ display: none !important/);
  for (const l of ["en", "ru"]) {
    const s = fs.readFileSync(path.join(root, "js", "lang", l + ".js"), "utf8");
    for (const k of ["settings.quick.title", "settings.quick.theme", "settings.quick.skin", "settings.quick.sounds", "settings.quick.notifications", "settings.quick.pin", "settings.quick.backup", "settings.advanced"]) assert.ok(s.includes('"' + k + '"'), l + ":" + k);
  }
});
