// Панель треда: исходное сообщение сверху, ответы, поле ответа, счётчик на родителе, закрытие, личные и групповые чаты.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted(lang) {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": lang || "ru" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}
const seed = (a) => a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; const t = Date.now();
  c.messages.push({ id: "r1", from: "them", text: "корень <b>x</b>", ts: t - 5000, readAckSent: true });
  c.messages.push({ id: "r2", from: "me", text: "ответ 1", ts: t - 4000, ack: "read", replyTo: { id: "r1", text: "корень" } });
  c.messages.push({ id: "r3", from: "them", text: "ответ на ответ", ts: t - 3000, readAckSent: true, replyTo: { id: "r2", text: "ответ 1" } });
  c.messages.push({ id: "o1", from: "them", text: "другое", ts: t - 2000, readAckSent: true });
  unreadDividerFor.delete("alice"); state.chatId = "alice"; state.tab = "chats"; renderTab();`);

test("счётчик на родителе, открытие тапом, корень отдельно сверху, ответы списком, заголовок с числом", async () => {
  const a = await booted(); const d = a.document; seed(a);
  const chip = d.querySelector('[data-thread="r1"]');
  assert.ok(chip); assert.equal(d.querySelector('[data-thread="o1"]'), null, "у сообщения без ответов счётчика нет");
  assert.match(chip.getAttribute("aria-label"), /Тред, ответов: 1/);
  assert.ok(chip.getBoundingClientRect !== undefined);
  chip.click();
  const sheet = d.querySelector("#thread-sheet");
  assert.ok(!sheet.classList.contains("hidden"));
  assert.equal(d.querySelectorAll("#thread-root .thread-msg.is-root").length, 1);
  assert.equal(d.querySelector("#thread-root .thread-msg-t").textContent, "корень <b>x</b>", "текст экранирован");
  assert.equal(d.querySelector("#thread-root .thread-msg-t").children.length, 0);
  assert.equal(d.querySelectorAll("#thread-list .thread-msg").length, 2, "только ответы в списке");
  assert.match(d.querySelector("#thread-sheet-title").textContent, /Тред · 2/);
  assert.equal(d.querySelector("#thread-input").disabled, false);
  a.close();
});

test("пустой тред: подсказка вместо списка; новый ответ доставляется с replyTo и счётчик растёт", async () => {
  const a = await booted("en"); const d = a.document; seed(a);
  a.run(`openThread("alice", "o1")`);
  assert.ok(d.querySelector("#thread-list .thread-none"));
  assert.match(d.querySelector("#thread-root").textContent, /Original message/);
  d.querySelector("#thread-input").value = "первый";
  d.querySelector("#thread-send-btn").click(); await sleep(60);
  const m = a.run(`state.contacts.get("alice").messages.find((x) => x.text === "первый")`);
  assert.ok(m && m.replyTo.id === "o1");
  assert.equal(d.querySelector("#thread-list .thread-none"), null);
  assert.equal(d.querySelectorAll("#thread-list .thread-msg").length, 1);
  assert.ok(d.querySelector('[data-thread="o1"]'), "счётчик появился на родителе");
  a.close();
});

test("закрытие: крестик, Escape, свайп вниз за шапку, смена чата не ломает; тап-цель крестика", async () => {
  const a = await booted(); const d = a.document; seed(a);
  const sheet = d.querySelector("#thread-sheet");
  const open = () => a.run(`openThread("alice", "r1")`);
  open(); d.querySelector("#thread-close-btn").click();
  assert.ok(sheet.classList.contains("hidden")); assert.equal(a.run(`state.threadRoot`), null);
  open(); d.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(sheet.classList.contains("hidden"));
  open();
  const head = d.querySelector(".thread-head");
  const touch = (type, y) => { const e = new a.window.Event(type, { bubbles: true }); const t = { clientY: y }; e.touches = [t]; e.changedTouches = [t]; head.dispatchEvent(e); };
  touch("touchstart", 100); touch("touchend", 120);
  assert.ok(!sheet.classList.contains("hidden"), "короткий свайп не закрывает");
  touch("touchstart", 100); touch("touchend", 220);
  assert.ok(sheet.classList.contains("hidden"), "свайп вниз закрывает");
  assert.equal(d.querySelector("#thread-close-btn").getAttribute("aria-label"), "Закрыть тред");
  const css = require("fs").readFileSync(require("path").join(__dirname, "..", "css", "styles.css"), "utf8");
  assert.match(css, /\.thread-head \.icon-btn \{[^}]*min-width: 44px; min-height: 44px/);
  assert.equal(sheet.getAttribute("role"), "dialog"); assert.equal(sheet.getAttribute("aria-modal"), "true");
  a.close();
});

test("группа: ответы от разных участников с именами, ответ уходит как групповое сообщение; запрет записи блокирует поле", async () => {
  const a = await booted(); const d = a.document;
  a.run(`{ const g = { id: "grp1", name: "Группа", isGroup: true, managed: true, members: [{ id: "me-test-id", name: "T" }, { id: "bob", name: "Bob" }, { id: "eve", name: "Eve" }], admins: ["me-test-id"], messages: [], lastActivity: Date.now(), status: "paired" };
    state.contacts.set("grp1", g); const t = Date.now();
    g.messages.push({ id: "g1", from: "them", fromId: "bob", fromName: "Bob", text: "вопрос", ts: t - 3000, readAckSent: true });
    g.messages.push({ id: "g2", from: "them", fromId: "eve", fromName: "Eve", text: "ответ Евы", ts: t - 2000, readAckSent: true, replyTo: { id: "g1", text: "вопрос" } });
    window.__grp = []; sendGroupMessage = (id, text, rt) => { window.__grp.push({ id, text, rt }); };
    state.chatId = "grp1"; state.tab = "chats"; renderTab(); openThread("grp1", "g1"); }`);
  assert.match(d.querySelector("#thread-root").textContent, /Bob/);
  assert.match(d.querySelector("#thread-list").textContent, /Eve/);
  d.querySelector("#thread-input").value = "и я"; d.querySelector("#thread-send-btn").click();
  const sent = JSON.parse(a.run(`JSON.stringify(window.__grp)`));
  assert.equal(sent.length, 1); assert.equal(sent[0].id, "grp1"); assert.equal(sent[0].rt.msgId, "g1");
  // запрет писать: поле отключено
  a.run(`{ const g = state.contacts.get("grp1"); g.writeRestricted = true; g.admins = ["bob"]; renderThreadSheet(); }`);
  assert.equal(d.querySelector("#thread-input").disabled, true);
  assert.equal(d.querySelector("#thread-send-btn").disabled, true);
  a.close();
});

test("личный чат с заблокированным: писать в тред нельзя; исчезнувший корень закрывает шторку", async () => {
  const a = await booted(); const d = a.document; seed(a);
  a.run(`state.contacts.get("alice").blocked = true; openThread("alice", "r1");`);
  assert.equal(d.querySelector("#thread-input").disabled, true);
  a.run(`state.contacts.get("alice").blocked = false; renderThreadSheet();`);
  assert.equal(d.querySelector("#thread-input").disabled, false);
  a.run(`{ const c = state.contacts.get("alice"); c.messages = c.messages.filter((m) => m.id !== "r1"); renderThreadSheet(); }`);
  assert.ok(d.querySelector("#thread-sheet").classList.contains("hidden"));
  a.run(`openThread("alice", "nonexistent")`);
  assert.ok(d.querySelector("#thread-sheet").classList.contains("hidden"));
  // вложение без текста и циклические ссылки не ломают
  a.run(`{ const c = state.contacts.get("alice"); c.messages.push({ id: "c1", from: "them", text: "", ts: Date.now(), replyTo: { id: "c2" } }, { id: "c2", from: "them", text: "x", ts: Date.now(), replyTo: { id: "c1" } }); openThread("alice", "c1"); }`);
  assert.ok(!d.querySelector("#thread-sheet").classList.contains("hidden"));
  assert.match(d.querySelector("#thread-root").textContent, /вложение/);
  a.close();
});

test("ключи i18n en/ru присутствуют", async () => {
  const a = await booted("en");
  for (const k of ["chat.thread.close", "chat.thread.none", "chat.thread.original", "chat.thread.aria"]) assert.notEqual(a.run(`T(${JSON.stringify(k)}, { n: 2 })`), k);
  assert.equal(a.run(`T("chat.thread.aria", { n: 3 })`), "Thread, replies: 3");
  a.close();
});
