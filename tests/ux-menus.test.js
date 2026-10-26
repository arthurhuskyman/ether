// UX-пакет: меню «+», задачи/напоминания из сообщения, меню шапки и строки чата, палитра, ссылка-приглашение, онбординг.
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
const css = fs.readFileSync(path.join(__dirname, "..", "css", "styles.css"), "utf8");

test("меню «+»: порядок плашек, сетка 2 колонки, «Недавнее» скрыто без файлов и показано с файлом", async () => {
  const a = await booted();
  const ids = Array.from(a.document.querySelectorAll("#composer-menu-sheet .composer-menu-item:not(.composer-recent):not(#composer-menu-more)")).map((b) => b.id);
  assert.deepEqual(ids, ["chat-emoji-btn", "chat-camera-btn", "chat-attach-btn", "chat-poll-btn", "chat-board-btn", "chat-note-btn", "chat-sticker-btn", "chat-miniapp-btn"]); // V.80: мини-приложения — один пункт, добавляется из JS
  assert.match(css, /composer-menu-actions \{ display: grid; grid-template-columns: repeat\(2/);
  a.run(`{ const c = ensureContactEntry("alice", "Alice"); c.managed = true; state.chatId = "alice"; renderTab(); setComposerFan(true); }`);
  assert.ok(a.document.querySelector("#composer-recent").classList.contains("hidden"));
  a.run(`state.contacts.get("alice").messages.push({ id: "f1", from: "me", text: "", ts: Date.now(), file: { kind: "file", name: "doc.pdf" } }); setComposerFan(true);`);
  assert.ok(!a.document.querySelector("#composer-recent").classList.contains("hidden"));
  assert.match(a.document.querySelector("#composer-recent").textContent, /doc\.pdf/);
  a.close();
});

test("сообщение -> задача создаёт доску и карточку; напоминание сохраняется и срабатывает", async () => {
  const a = await booted();
  a.run(`{ const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "them", text: "buy milk", ts: Date.now() }); state.chatId = "alice"; renderTab(); }`);
  const labels = Array.from((a.run(`openMessageSheet("m1","alice"); document.querySelectorAll("#message-sheet-body .sheet-action")`), a.document.querySelectorAll("#message-sheet-body .sheet-action"))).map((b) => b.dataset.action);
  assert.ok(labels.includes("task") && labels.includes("remind"));
  assert.equal(labels[labels.length - 1], "delete-local");
  await a.run(`createTaskFromMessage("alice", "m1")`);
  const n = a.run(`(() => { const b = state.contacts.get("alice").messages.find((m) => m.board); return b ? b.board.cards.map((k) => k.t).join("|") : "none"; })()`);
  assert.equal(n, "buy milk");
  a.run(`addReminder("alice", "m1", Date.now() - 1000)`);
  assert.equal(a.run(`loadReminders().length`), 1);
  a.run(`checkReminders()`);
  assert.equal(a.run(`loadReminders().length`), 0);
  a.close();
});

test("меню шапки чата и контекстное меню строки; помечено непрочитанным", async () => {
  const a = await booted();
  a.run(`{ const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "me", text: "x", ts: Date.now() }); state.chatId = "alice"; renderTab(); }`);
  assert.ok(a.document.querySelector("#chat-more-btn").getAttribute("aria-label") || a.document.querySelector("#chat-more-btn").dataset.i18nAria);
  a.document.querySelector("#chat-more-btn").click();
  const items = Array.from(a.document.querySelectorAll("#anchored-menu .amenu-item")); // V.79: единое якорное меню
  assert.equal(items.length, 5, "в полном режиме все 5 пунктов сразу, без «Ещё» (V.80: убраны дубли Поиск/Закреплённое/Экспорт)");
  assert.ok(items[items.length - 1].classList.contains("destructive"), "очистка внизу красным");
  a.run(`closeAnchoredMenu(); state.chatId = null; state.tab = "chats"; renderTab(); renderChatsList(); openChatRowMenu(state.contacts.get("alice"));`);
  assert.equal(a.document.querySelectorAll("#anchored-menu .amenu-item").length, 5);
  a.run(`state.contacts.get("alice").markedUnread = true;`);
  assert.equal(a.run(`unreadCount(state.contacts.get("alice"))`), 1);
  a.close();
});

test("командная палитра: Ctrl+K открывает диалог, поиск по чатам, Esc закрывает", async () => {
  const a = await booted();
  a.run(`ensureContactEntry("alice", "Alice").managed = true;`);
  const w = a.window;
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  const d = a.document.querySelector("#cmdk");
  assert.ok(!d.classList.contains("hidden"));
  assert.equal(d.getAttribute("role"), "dialog");
  const input = a.document.querySelector("#cmdk-input"); input.value = "alic"; input.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.match(a.document.querySelector("#cmdk-list").textContent, /Alice/);
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(d.classList.contains("hidden"));
  a.close();
});

test("ссылка-приглашение: #add= добавляет контакт; первый экран — три шага", async () => {
  const a = await booted();
  a.run(`history.replaceState(null, "", location.pathname + "#add=friend-id&name=Bob")`);
  a.run(`window.confirmSheet = () => Promise.resolve(true)`); // V.77 A6: добавление по ссылке теперь с подтверждением
  assert.equal(a.run(`handleAddLinkFromLocation()`), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(a.run(`state.contacts.has("friend-id")`));
  assert.match(a.run(`myAddLink()`), /#add=me-test-id/);
  a.run(`state.tab = "chats"; state.chatId = null; renderTab(); renderChatsList();`);
  const card = a.document.querySelector("#first-run-card");
  if (card) assert.equal(card.querySelectorAll(".first-step").length, 3);
  a.close();
});

test("скины newyear/steampunk: переключатель темы переносит подписи", () => {
  for (const s of ["newyear", "steampunk"]) assert.match(fs.readFileSync(path.join(__dirname, "..", "css", "skins", s + ".css"), "utf8"), /theme-seg button \{[^}]*white-space: normal/);
});
