const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootApp, closeAll, ROOT } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const pngSize = (f) => { const b = fs.readFileSync(path.join(ROOT, f)); assert.equal(b.toString("ascii", 1, 4), "PNG", f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test("сервер перевода: адрес по умолчанию, пустое поле возвращает его, API-ключ уходит в запрос", async () => {
  let seen;
  const a = await bootApp({ fetch: async (url, init) => { seen = { url: String(url), body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ translatedText: "x" }) }; } });
  assert.equal(a.run(`Store.translateEndpoint`), a.run(`DEFAULT_TRANSLATE_ENDPOINT`));
  assert.match(a.run(`DEFAULT_TRANSLATE_ENDPOINT`), /^https:\/\/.+\/translate$/);
  assert.equal(a.document.querySelector("#settings-translate-endpoint").value, a.run(`DEFAULT_TRANSLATE_ENDPOINT`));
  a.run(`ensureContactEntry("alice","Alice"); state.contacts.get("alice").messages.push({id:"t1", from:"them", text:"hello"});`);
  await a.run(`translateMessage("alice", "t1")`);
  assert.equal(seen.url, a.run(`DEFAULT_TRANSLATE_ENDPOINT`));
  assert.equal(seen.body.api_key, undefined, "без ключа поле api_key не отправляется");
  const key = a.document.querySelector("#settings-translate-key");
  key.value = " k-123 "; key.dispatchEvent(new a.window.Event("change", { bubbles: true }));
  const ep = a.document.querySelector("#settings-translate-endpoint");
  ep.value = "https://my.srv/translate"; ep.dispatchEvent(new a.window.Event("change", { bubbles: true }));
  a.run(`delete state.contacts.get("alice").messages[0].translation`);
  await a.run(`translateMessage("alice", "t1")`);
  assert.equal(seen.url, "https://my.srv/translate");
  assert.equal(seen.body.api_key, "k-123");
  ep.value = "   "; ep.dispatchEvent(new a.window.Event("change", { bubbles: true }));
  assert.equal(ep.value, a.run(`DEFAULT_TRANSLATE_ENDPOINT`), "пустое поле возвращает адрес по умолчанию");
  a.close();
});

test("«Переключатель мертвеца» перенесён в Отладку (и по-прежнему работает)", async () => {
  const a = await bootApp({});
  const dm = a.document.querySelector("#settings-deadman-enabled");
  assert.ok(dm.closest("#screen-debug"), "переключатель внутри экрана отладки");
  assert.equal(a.document.querySelector('[data-settings-category] #settings-deadman-enabled'), null, "в обычных настройках его больше нет");
  assert.ok(a.document.querySelector("#screen-debug #settings-deadman-threshold"));
  assert.ok(a.document.querySelector("#screen-debug #settings-deadman-contact-btn"));
  // без доверенного контакта включить нельзя — тумблер откатывается (поведение не изменилось)
  dm.checked = true; dm.dispatchEvent(new a.window.Event("change", { bubbles: true })); await tick(20);
  assert.equal(dm.checked, false);
  assert.equal(a.run(`Store.deadManEnabled`), false);
  a.run(`Store.deadManContactId = "alice"; ensureContactEntry("alice","Alice");`);
  dm.checked = true; dm.dispatchEvent(new a.window.Event("change", { bubbles: true })); await tick(20);
  assert.equal(a.run(`Store.deadManEnabled`), true);
  a.close();
});

test("черновик не «переезжает» между чатами; не теряется при смене чата в обход закрытия", async () => {
  const a = await bootApp({});
  a.run(`ensureContactEntry("alice","Alice"); ensureContactEntry("bob","Bob");`);
  const input = () => a.document.querySelector("#chat-input");
  const type = (v) => { input().value = v; input().dispatchEvent(new a.window.Event("input", { bubbles: true })); };
  a.run(`state.chatId = "alice"; renderTab();`);
  type("привет, это Алисе");
  // переключаемся в другой чат напрямую (как из глобального поиска)
  a.run(`state.chatId = "bob"; renderTab();`);
  assert.equal(input().value, "", "в чате без черновика поле пустое, а не текст предыдущего чата");
  type("а это Бобу");
  a.run(`state.chatId = "alice"; renderTab();`);
  assert.equal(input().value, "привет, это Алисе");
  a.run(`state.chatId = "bob"; renderTab();`);
  assert.equal(input().value, "а это Бобу");
  assert.equal(a.run(`state.drafts.alice`), "привет, это Алисе");
  assert.equal(a.run(`state.drafts.bob`), "а это Бобу");
  // перерисовка того же чата (входящее сообщение) не трогает ввод пользователя
  input().value = "печатаю   "; a.run(`renderChatThread()`);
  assert.equal(input().value, "печатаю   ");
  // выход из чата и повторный вход читают сохранённый черновик
  a.run(`closeChatSafely()`);
  a.run(`state.chatId = "bob"; renderTab();`);
  assert.equal(input().value, "печатаю");
  a.close();
});

test("логотип: иконки из файла логотипа нужных размеров, manifest/apple-touch/favicon/SW, логотип в «О приложении»", async () => {
  assert.deepEqual(pngSize("icons/icon-512.png"), [512, 512]);
  assert.deepEqual(pngSize("icons/icon-192.png"), [192, 192]);
  assert.deepEqual(pngSize("icons/apple-touch-icon.png"), [180, 180]);
  assert.deepEqual(pngSize("icons/favicon-32.png"), [32, 32]);
  assert.deepEqual(pngSize("icons/logo-256.png"), [256, 256]);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8"));
  for (const ic of manifest.icons) assert.ok(fs.existsSync(path.join(ROOT, ic.src)), ic.src);
  assert.match(html, /rel="apple-touch-icon" href="icons\/apple-touch-icon\.png"/);
  assert.match(sw, /"\.\/icons\/logo-256\.png"/);
  const a = await bootApp({});
  const logo = a.document.querySelector('[data-settings-category="help"] img.about-logo');
  assert.ok(logo, "логотип в Настройки → О приложении");
  assert.equal(logo.getAttribute("src"), "icons/logo-256.png");
  const name = a.document.querySelector("#about-app-logo");
  assert.ok(logo.compareDocumentPosition(name) & a.window.Node.DOCUMENT_POSITION_FOLLOWING, "логотип расположен над названием");
  a.close();
});

test("Настройки: отдельного поля поиска нет, остаётся лупа в хедере (глобальный поиск, ведёт в категорию)", async () => {
  const a = await bootApp({});
  assert.equal(a.document.querySelector("#settings-search"), null);
  assert.equal(a.document.querySelector("#screen-settings input.search-input"), null);
  assert.ok(a.document.querySelector("#global-search-btn"), "лупа в хедере на месте");
  // категории работают без поля поиска
  a.document.querySelector('.tab-btn[data-tab="settings"]').click();
  a.document.querySelector('.settings-category-row[data-category="help"]').click();
  assert.ok(!a.document.querySelector('[data-settings-category="help"]').classList.contains("category-hidden"));
  a.document.querySelector("#settings-back-btn").click();
  assert.ok(!a.document.querySelector("#settings-category-list").classList.contains("hidden"));
  // глобальный поиск по настройкам открывает нужную категорию
  a.run(`navigateToSettingsCategory("help")`);
  assert.equal(a.run(`state.settingsCategory`), "help");
  assert.ok(!a.document.querySelector('[data-settings-category="help"]').classList.contains("category-hidden"));
  a.close();
});
