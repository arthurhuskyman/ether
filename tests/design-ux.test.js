// Дизайн/UX-пакет: иерархия списка чатов, меню «+», панель на долгое нажатие и шторка сообщения, схема темы, токены.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

async function booted() {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}
const ROOT = path.join(__dirname, "..");

test("список чатов: в строке нет иконок закрепа/mute/блока/ошибки, состояния — текстом для скринридера, mute — приглушённый бейдж", async () => {
  const a = await booted();
  a.run(`
    const mk = (id, name, x) => { const c = ensureContactEntry(id, name); c.managed = true; Object.assign(c, x || {}); return c; };
    const t = Date.now();
    const al = mk("alice", "Alice", { pinned: true, pinOrder: 1 }); const b = mk("bob", "Bob", { muted: true }); const k = mk("cat", "Cat", { blocked: true });
    al.messages.push({ id: "1", from: "them", text: "hi", ts: t }, { id: "2", from: "me", text: "yo", ts: t, ack: "failed" });
    b.messages.push({ id: "3", from: "them", text: "photo", ts: t });
    k.messages.push({ id: "4", from: "me", text: "ok", ts: t, ack: "sent" });
    state.tab = "chats"; state.chatFilter = "all"; renderTab(); renderChatsList();`);
  const doc = a.document;
  assert.equal(doc.querySelectorAll("#chats-list .muted-icon, #chats-list .chat-row-fail-icon").length, 0, "иконок состояний в строке нет");
  const rows = Array.from(doc.querySelectorAll("#chats-list .chat-row"));
  const row = (name) => rows.find((r) => r.textContent.includes(name));
  assert.match(row("Alice").querySelector(".sr-only").textContent, /Pin/i, "закреплён — текстом");
  assert.match(row("Alice").querySelector(".sr-only").textContent, /not delivered|Not delivered|failed|Failed/i, "недоставлено — текстом");
  assert.ok(row("Bob").querySelector(".unread-badge.is-muted"), "у mute-чата бейдж приглушён");
  assert.ok(row("Bob").querySelector(".chat-row-name.is-muted"));
  assert.match(row("Cat").querySelector(".sr-only").textContent, /Block/i);
  a.close();
});

test("закреплённые чаты: ручки перетаскивания только в режиме порядка, строка в нём чат не открывает", async () => {
  const a = await booted();
  a.run(`
    const mk = (id, name, x) => { const c = ensureContactEntry(id, name); c.managed = true; Object.assign(c, x || {}); return c; };
    mk("p1", "P1", { pinned: true, pinOrder: 1 }).messages.push({ id: "1", from: "them", text: "a", ts: Date.now() });
    mk("p2", "P2", { pinned: true, pinOrder: 2 }).messages.push({ id: "2", from: "them", text: "b", ts: Date.now() });
    state.tab = "chats"; state.chatFilter = "all"; state.chatId = null; renderTab(); renderChatsList();`);
  assert.equal(a.document.querySelectorAll(".chat-row-drag-handle").length, 0, "по умолчанию ручек нет");
  a.run(`setPinReorder(true)`);
  assert.ok(a.document.querySelectorAll(".chat-row-drag-handle").length >= 2, "в режиме порядка ручки видны");
  assert.ok(a.document.querySelector(".chats-reorder-bar"), "есть панель «Готово»");
  a.document.querySelector(".chat-row").click();
  assert.equal(a.run(`state.chatId`), null, "в режиме порядка нажатие чат не открывает");
  a.document.querySelector(".chats-reorder-bar button").click();
  assert.equal(a.document.querySelectorAll(".chat-row-drag-handle").length, 0);
  assert.equal(a.run(`state.pinReorder`), false);
  a.close();
});

test("композер: «+» открывает меню-шторку вместо веера, действие закрывает её", async () => {
  const a = await booted();
  a.run(`ensureContactEntry("alice", "Alice").managed = true; state.chatId = "alice"; renderTab();`);
  assert.equal(a.document.querySelector("#composer-fan"), null, "веера больше нет");
  const sheet = a.document.querySelector("#composer-menu-sheet"), plus = a.document.querySelector("#chat-plus-btn");
  assert.ok(sheet.classList.contains("hidden"));
  plus.click();
  assert.equal(sheet.classList.contains("hidden"), false);
  assert.equal(plus.getAttribute("aria-expanded"), "true");
  assert.ok(sheet.querySelector("#chat-emoji-btn") && sheet.querySelector("#chat-camera-btn") && sheet.querySelector("#chat-attach-btn"));
  a.document.querySelector("#chat-attach-btn").click();
  assert.ok(sheet.classList.contains("hidden"), "выбор действия закрыл меню");
  plus.click(); a.document.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.ok(sheet.classList.contains("hidden"), "Esc закрывает");
  a.close();
});

test("меню сообщения: панель на долгое нажатие с реакциями и быстрыми действиями; шторка без дубля реакций, уровни и подписи удаления", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true;
    c.messages.push({ id: "m1", from: "them", text: "hello", ts: Date.now() }, { id: "m2", from: "me", text: "mine", ts: Date.now(), ack: "failed" });
    state.chatId = "alice"; renderTab();`);
  const flyout = a.document.querySelector("#quick-reaction-flyout");
  const anchor = a.document.querySelector(".bubble");
  a.run(`openQuickReactionFlyout(document.querySelector(".bubble"), "m1", "alice")`);
  assert.ok(flyout.querySelectorAll(".qrf-reactions .reaction-emoji").length >= 7, "6 реакций и «+»");
  const acts = Array.from(flyout.querySelectorAll(".qrf-act")).map((b) => b.textContent);
  assert.deepEqual(acts, ["Reply", "Copy", "More"]);
  flyout.querySelector(".qrf-act:last-child").click();
  assert.equal(a.document.querySelector("#message-sheet").classList.contains("hidden"), false, "«More» открывает шторку");
  assert.equal(a.document.querySelector("#reaction-bar").children.length, 0, "в шторке реакций нет");
  const labels = Array.from(a.document.querySelectorAll("#message-sheet-body .sheet-action")).map((b) => b.dataset.action);
  assert.deepEqual(labels.slice(0, 4), ["reply", "forward", "copy", "pin"], "основные действия сверху");
  assert.ok(a.document.querySelector("#message-sheet-body .sheet-divider"));
  assert.ok(!labels.includes("retry"), "«Повторить» убрано из меню");
  // своё сообщение: удаление у меня / у всех
  a.run(`openMessageSheet("m2", "alice")`);
  const del = Array.from(a.document.querySelectorAll("#message-sheet-body .destructive")).map((b) => b.textContent);
  assert.deepEqual(del, ["Delete for me only", "Delete for everyone"]);
  // группа: реакций нет, только быстрые действия
  a.run(`state.contacts.set("g1", { id: "g1", name: "G", managed: true, isGroup: true, createdBy: "me-test-id", members: [{ id: "me-test-id", name: "T", role: "admin" }], messages: [{ id: "gm", from: "them", fromId: "x", text: "yo", ts: Date.now() }], lastActivity: Date.now() }); openQuickReactionFlyout(document.querySelector(".bubble"), "gm", "g1")`);
  assert.equal(a.document.querySelectorAll("#quick-reaction-flyout .qrf-reactions").length, 0);
  assert.ok(a.document.querySelector("#quick-reaction-flyout .qrf-actions"));
  a.close();
});

test("тап по значку «не доставлено» сразу повторяет отправку", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "f1", from: "me", text: "x", ts: Date.now(), ack: "failed" });
    window.__retried = []; retryMessage = async (cid, mid) => { window.__retried.push(cid + ":" + mid); };
    state.chatId = "alice"; renderTab();`);
  const icon = a.document.querySelector(".ack-failed[data-retry]");
  assert.ok(icon);
  icon.click();
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify(window.__retried)`)), ["alice:f1"]);
  a.close();
});

test("тема: data-scheme выставляется applyTheme (light/dark/auto по системе); светлая палитра описана один раз", async () => {
  const a = await booted();
  a.run(`applyTheme("light")`); assert.equal(a.document.documentElement.dataset.scheme, "light");
  a.run(`applyTheme("dark")`); assert.equal(a.document.documentElement.dataset.scheme, "dark");
  a.run(`applyTheme("oled")`); assert.equal(a.document.documentElement.dataset.scheme, "dark");
  a.window.matchMedia = (q) => ({ matches: /light/.test(q), addEventListener() {}, addListener() {} });
  a.run(`applyTheme("auto")`); assert.equal(a.document.documentElement.dataset.scheme, "light");
  a.window.matchMedia = (q) => ({ matches: false, addEventListener() {}, addListener() {} });
  a.run(`applyTheme("auto")`); assert.equal(a.document.documentElement.dataset.scheme, "dark");
  a.close();
});

test("токены: отдельный файл, подключён в index.html и service worker, без media-дублей светлой темы", () => {
  const css = fs.readFileSync(path.join(ROOT, "css", "styles.css"), "utf8");
  const tokens = fs.readFileSync(path.join(ROOT, "css", "tokens.css"), "utf8");
  assert.ok(fs.readFileSync(path.join(ROOT, "index.html"), "utf8").includes('href="css/tokens.css"'));
  assert.ok(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8").includes('"./css/tokens.css"'));
  assert.equal(/prefers-color-scheme/.test(css), false, "в styles.css нет media-дублей светлой темы");
  assert.equal((tokens.match(/html\[data-scheme="light"\] \{/g) || []).length, 1, "светлая палитра описана один раз");
  for (const t of ["--sp-1", "--r-md", "--motion-fast", "--ease-out", "--t-body", "--text-primary", "--bubble-mine-bg", "--success-soft"]) assert.ok(tokens.includes(t + ":"), t);
  // радиусы только по шкале (кроме мелких 1–4px, 50%, пилюль)
  const odd = (css.match(/border(?:-[a-z]+)*-radius:[^;]*/g) || []).filter((d) => /(?<![\d.])(6|9|10|11|14|15|18|20|22|26|28|32)px/.test(d));
  assert.deepEqual(odd, [], "радиусы вне шкалы 8/12/16/24: " + odd.slice(0, 3).join(" | "));
});
