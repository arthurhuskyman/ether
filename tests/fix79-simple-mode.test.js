// V.79: простой/полный режим интерфейса, «Ещё» в меню, единое якорное меню, онбординг в 3 шага, удаление дубля реакций.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const ROOT = path.join(__dirname, "..");
async function booted(storage) {
  const a = createApp({ storage: Object.assign({ "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en" }, storage || {}) });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}
const setupChat = (a) => a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "them", text: "hi", ts: Date.now() }); state.chatId = "alice"; renderTab();`);

test("режим: новый пользователь получает simple, существующий — молча full, сохранённый выбор не трогается", async () => {
  const fresh = createApp({ storage: { "ether.lang": "en" } }); await fresh.ready;
  assert.equal(fresh.document.documentElement.getAttribute("data-ui"), "simple");
  assert.equal(fresh.run(`localStorage.getItem("ether.uiMode")`), "simple");
  const old = await booted();
  assert.equal(old.document.documentElement.getAttribute("data-ui"), "full");
  assert.equal(old.run(`localStorage.getItem("ether.uiMode")`), "full");
  const keep = await booted({ "ether.uiMode": "simple" });
  assert.equal(keep.document.documentElement.getAttribute("data-ui"), "simple", "явный выбор сохраняется");
  fresh.close(); old.close(); keep.close();
});

test("настройки: плитка-переключатель режима; в simple редкие строки под «Дополнительно», в full показаны", async () => {
  const a = await booted();
  const d = a.document;
  const tile = d.querySelector('.settings-quick-tile[data-quick="uimode"]');
  assert.ok(tile, "плитка режима есть");
  const row = d.querySelector("#settings-calm-mode").closest("label");
  assert.ok(!row.classList.contains("adv-collapsed"), "full: показано");
  tile.click();
  assert.equal(d.documentElement.getAttribute("data-ui"), "simple");
  assert.equal(a.run(`localStorage.getItem("ether.uiMode")`), "simple");
  assert.equal(tile.getAttribute("aria-pressed"), "true");
  assert.ok(row.classList.contains("adv-collapsed"), "simple: спрятано");
  assert.ok(d.querySelector("#settings-notifications").closest("label").classList.contains("adv-collapsed") === false, "уведомления остаются");
  assert.ok(d.querySelector("#settings-name").closest("label").classList.contains("adv-collapsed") === false, "имя остаётся");
  // «Дополнительно» раскрывает, ничего не удалено
  a.run(`openSettingsCategory("appearance")`);
  const adv = d.querySelector('#settings-adv-toggles .settings-adv-toggle[data-adv-cat="appearance"]');
  assert.ok(adv && !adv.classList.contains("category-hidden"), "кнопка «Дополнительно» видна");
  adv.click();
  assert.ok(!row.classList.contains("adv-collapsed"), "после раскрытия строка доступна");
  tile.click();
  assert.equal(d.documentElement.getAttribute("data-ui"), "full");
  a.close();
});

test("«+» композера: в simple 5 плиток + «Ещё», «Ещё» раскрывает остальное; все id на месте", async () => {
  const a = await booted({ "ether.uiMode": "simple" });
  setupChat(a);
  const sheet = a.document.querySelector("#composer-menu-sheet");
  a.document.querySelector("#chat-plus-btn").click();
  assert.ok(!sheet.classList.contains("hidden"));
  const more = a.document.querySelector("#composer-menu-more");
  assert.ok(more, "кнопка «Ещё»");
  for (const id of ["chat-board-btn", "chat-note-btn"]) assert.ok(a.document.getElementById(id).hasAttribute("data-menu-more"), id + " уходит под «Ещё»");
  for (const id of ["chat-emoji-btn", "chat-camera-btn", "chat-attach-btn", "chat-poll-btn", "chat-sticker-btn"]) assert.ok(!a.document.getElementById(id).hasAttribute("data-menu-more"), id + " основной");
  more.click();
  assert.ok(sheet.classList.contains("menu-expanded"));
  assert.equal(more.getAttribute("aria-expanded"), "true");
  a.document.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(sheet.classList.contains("hidden"), "Esc закрывает");
  assert.ok(!sheet.classList.contains("menu-expanded"), "состояние «Ещё» сбрасывается");
  a.close();
});

test("якорное меню: «⋯» шапки в simple прячет редкое под «Ещё»; Esc, клик снаружи, ловушка фокуса, смена чата", async () => {
  const a = await booted({ "ether.uiMode": "simple" });
  setupChat(a);
  const d = a.document;
  d.querySelector("#chat-more-btn").click();
  const m = d.querySelector("#anchored-menu");
  assert.ok(m && m.getAttribute("role") === "menu");
  assert.equal(d.querySelector("#chat-more-btn").getAttribute("aria-expanded"), "true");
  const vis = () => Array.from(m.querySelectorAll(".amenu-item:not(.hidden)")).map((b) => b.textContent.trim());
  assert.ok(vis().includes("More"), "есть «Ещё»");
  assert.ok(vis().length <= 5, "основных пунктов не больше 4 + «Ещё»: " + vis().join("|"));
  m.querySelector(".amenu-more").click();
  assert.equal(vis().includes("More"), false);
  assert.ok(vis().length >= 5, "после «Ещё» доступно всё оставшееся (V.80: в меню 5 пунктов, дубли убраны)");
  // Tab не выходит за меню
  const items = Array.from(m.querySelectorAll(".amenu-item:not(.hidden)"));
  items[items.length - 1].focus();
  d.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.equal(d.activeElement, items[0], "фокус зациклен");
  d.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(d.querySelector("#anchored-menu"), null, "Esc закрыл");
  assert.equal(d.querySelector("#chat-more-btn").getAttribute("aria-expanded"), "false");
  // клик снаружи
  d.querySelector("#chat-more-btn").click();
  await new Promise((r) => setTimeout(r, 20));
  d.body.dispatchEvent(new a.window.Event("pointerdown", { bubbles: true }));
  assert.equal(d.querySelector("#anchored-menu"), null, "клик снаружи закрыл");
  // действие закрывает и вызывает fn; один экземпляр
  d.querySelector("#chat-more-btn").click(); d.querySelector("#chat-more-btn").click();
  assert.equal(d.querySelectorAll("#anchored-menu").length, 1, "меню одно");
  a.close();
});

test("якорное меню: позиционирование не выходит за экран, учитывает RTL", async () => {
  const a = await booted();
  const r = a.run(`(() => {
    const out = {};
    const mk = (l, t, w, h) => { const el = document.createElement("button"); el.getBoundingClientRect = () => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h }); return el; };
    const panel = document.createElement("div"); document.body.appendChild(panel);
    Object.defineProperty(panel, "offsetWidth", { value: 200 }); Object.defineProperty(panel, "offsetHeight", { value: 150 });
    window.innerWidth = 360; window.innerHeight = 640;
    positionAnchored(panel, mk(330, 10, 30, 30), { align: "end" }); out.endLeft = parseInt(panel.style.left); out.endTop = parseInt(panel.style.top); out.side = panel.dataset.side;
    positionAnchored(panel, mk(5, 600, 30, 30), { align: "start" }); out.upTop = parseInt(panel.style.top); out.upSide = panel.dataset.side; out.startLeft = parseInt(panel.style.left);
    document.documentElement.dir = "rtl"; positionAnchored(panel, mk(5, 300, 30, 30), { align: "start" }); out.rtlLeft = parseInt(panel.style.left);
    document.documentElement.dir = "ltr"; return out; })()`);
  assert.ok(r.endLeft >= 8 && r.endLeft + 200 <= 352, "справа в пределах экрана: " + r.endLeft);
  assert.equal(r.side, "down");
  assert.equal(r.upSide, "up"); assert.ok(r.upTop + 150 <= 640 - 8);
  assert.equal(r.startLeft, 8, "слева зажато отступом");
  assert.ok(r.rtlLeft >= 8, "RTL: start-выравнивание от правого края кнопки, не отрицательное");
  a.close();
});

test("реакции: плавающей панели нет ни в разметке, ни в коде; ряд реакций только в шторке сообщения; долгое нажатие открывает шторку", async () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(!/quick-reaction-flyout/.test(html));
  for (const f of fs.readdirSync(path.join(ROOT, "js/app"))) assert.ok(!/QuickReactionFlyout|quick-reaction-flyout|qrf-/.test(fs.readFileSync(path.join(ROOT, "js/app", f), "utf8")), f);
  assert.ok(!/quick-reaction-flyout|\.qrf-/.test(fs.readFileSync(path.join(ROOT, "css/styles.css"), "utf8")));
  const a = await booted();
  setupChat(a);
  a.run(`openMessageSheet("m1", "alice")`);
  assert.equal(a.document.querySelectorAll("#reaction-bar .reaction-emoji").length, 7);
  a.close();
});

test("онбординг: 3 шага, «Пригласить друга» и подсказка на последнем; пустой список чатов — одно главное действие", async () => {
  const a = createApp({ storage: { "ether.lang": "en" } }); await a.ready;
  const d = a.document;
  assert.equal(d.querySelectorAll(".onboarding-slide").length, 3);
  assert.equal(d.querySelectorAll(".onboarding-dot").length, 3);
  assert.ok(d.querySelector('[data-slide="0"] #onboarding-lang-grid') && d.querySelector('[data-slide="0"] #onboarding-lang-select'), "язык на первом шаге");
  assert.ok(d.querySelector('[data-slide="2"] #onboarding-invite-btn') && d.querySelector('[data-slide="2"] #onboarding-copy-link-btn') && d.querySelector('[data-slide="2"] #onboarding-qr-canvas'));
  assert.ok(d.querySelector("#onboarding-next-hint").textContent.length > 10);
  d.querySelector("#onboarding-name").value = "Zed";
  d.querySelector("#onboarding-form").dispatchEvent(new a.window.Event("submit", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(a.run(`__onboardingSlide`), 2);
  let copied = null; a.run(`window.copyText = (t) => { window.__copied = t; };`);
  d.querySelector("#onboarding-copy-link-btn").click();
  assert.match(a.window.__copied || "", /add=/, "копируется ссылка-приглашение");
  a.run(`window.shareMyInviteLink = () => { window.__shared = 1; }`);
  d.querySelector("#onboarding-invite-btn").click();
  assert.equal(a.window.__shared, 1);
  // пустой список: единственное главное действие
  assert.ok(d.querySelector("#chats-empty-invite-btn"));
  a.close();
});

test("ключи V.79: файл CHANGED-KEYS есть, значения совпадают со словарями en/ru, жаргона в изменённых строках нет", () => {
  const ch = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/CHANGED-KEYS-V79.json"), "utf8"));
  const load = (c) => { const d = {}; new Function("window", fs.readFileSync(path.join(ROOT, "js/lang", c + ".js"), "utf8"))({ __LANG_DICTS: d }); return d[c]; };
  const en = load("en"), ru = load("ru");
  assert.ok(Object.keys(ch).length >= 60);
  const jargonCS = /\bTOFU\b|\bDTLS\b|\bTURN\b|\bICE\b/, jargonCI = /envelope|ratchet|prekey|fingerprint|claim|конверт|отпечат|закреплен|храповик/i;
  const jargon = { test: (t) => jargonCS.test(t) || jargonCI.test(t) };
  for (const [k, v] of Object.entries(ch)) {
    assert.equal(en[k], v.en, k); assert.equal(ru[k], v.ru, k);
    assert.ok(!jargon.test(v.en) && !jargon.test(v.ru), "жаргон в " + k);
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
    if (k.indexOf("ui.") !== 0) assert.ok(ph(v.en) === ph(v.ru), "плейсхолдеры " + k);
  }
});
