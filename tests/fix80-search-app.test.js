// Поиск по сообщениям в приложении: индекс из кэша чатов, общий поиск с подсветкой и переходом, фильтры-чипы, палитра команд, живые обновления, доступность.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

async function setup() {
  const a = await boot();
  a.run(`(() => { Store.myId = "me-test-id"; state._firstRenderDone = true;
    const mk = (id, name, msgs) => { const c = ensureContactEntry(id, name); c.managed = true; c.messages = msgs; return c; };
    mk("alice", "Alice", [{ id: "a1", from: "them", text: "Встреча завтра в офисе", ts: Date.now() - 5000 }, { id: "a2", from: "me", text: "Посмотри https://example.org/doc", ts: Date.now() - 4000, ack: "sent" }]);
    mk("bob", "Bob", [{ id: "b1", from: "them", text: "meeting tomorrow, café Zürich", ts: Date.now() - 3000 }, { id: "b2", from: "them", text: "", file: { kind: "audio", name: "v.ogg", duration: 3 }, ts: Date.now() - 2000 }]);
    persistContacts(); })()`);
  await a.run(`searchBuild()`);
  return a;
}
const rows = (a) => J(Array.from(a.window.document.querySelectorAll("#global-search-results .global-search-row[data-kind=message]")).map((r) => ({ id: r.dataset.id, msg: r.dataset.msg, aria: r.getAttribute("aria-label"), html: r.innerHTML })));

test("индекс строится из чатов; общий поиск показывает сообщения с подсветкой, aria-label и переходом к сообщению", async () => {
  const a = await setup();
  assert.equal(a.run(`__searchBuilt`), true);
  a.run(`openGlobalSearch("встреч")`); await sleep(50);
  const r = rows(a); assert.equal(r.length, 1); assert.equal(r[0].id, "alice"); assert.equal(r[0].msg, "a1"); assert.match(r[0].html, /<mark>Встреча<\/mark>/); assert.match(r[0].aria, /Alice/);
  assert.equal(a.window.document.getElementById("global-search-results").getAttribute("role"), "list");
  // диакритика/латиница и экранирование
  a.run(`openGlobalSearch("cafe zurich")`); await sleep(30); assert.deepEqual(rows(a).map((x) => x.msg), ["b1"]);
  a.run(`state.contacts.get("bob").messages.push({ id: "b3", from: "them", text: "<img src=x onerror=alert(1)> payload", ts: Date.now() }); openGlobalSearch("payload")`); await sleep(30);
  assert.equal(rows(a).length, 1); assert.ok(!rows(a)[0].html.includes("<img"));
  // переход по клику
  a.window.document.querySelector("#global-search-results .global-search-row[data-kind=message]").click(); await sleep(150);
  assert.equal(a.run(`state.chatId`), "bob");
  a.close();
});
test("фильтры: чипы типов пишут операторы в запрос; тип voice/links; «только этот чат»", async () => {
  const a = await setup();
  const chips = a.window.document.querySelectorAll("#gs-filters .gs-chip"); assert.equal(chips.length, 5);
  a.run(`openGlobalSearch("")`); const input = a.window.document.getElementById("global-search-input");
  const click = (t) => Array.from(chips).find((c) => c.dataset.type === t).click();
  click("voice"); await sleep(250); assert.equal(input.value, "type:voice"); assert.deepEqual(rows(a).map((x) => x.msg), ["b2"]);
  click("links"); await sleep(250); assert.equal(input.value, "type:links"); assert.deepEqual(rows(a).map((x) => x.msg), ["a2"]);
  click(""); input.value = "tomorrow"; a.run(`state.chatId = "alice"; document.getElementById("gs-this-chat").checked = true`); input.dispatchEvent(new a.window.Event("input")); await sleep(250);
  assert.equal(rows(a).length, 0, "в чате Alice слова tomorrow нет");
  a.run(`state.chatId = "bob"`); input.dispatchEvent(new a.window.Event("input")); await sleep(250); assert.deepEqual(rows(a).map((x) => x.msg), ["b1"]);
  assert.ok(a.window.document.querySelector("#gs-filters details summary"), "даты и операторы спрятаны в «Дополнительно»");
  a.close();
});
test("живые обновления без хуков (новые/удалённые чаты и сообщения), палитра команд, пустой индекс не ломает старый поиск", async () => {
  const a = await setup();
  a.run(`state.contacts.get("alice").messages.push({ id: "a3", from: "them", text: "уникальноеслово", ts: Date.now() })`);
  assert.deepEqual(J(a.run(`searchQueryMessages("уникальное").map((r) => r.id)`)), ["a3"]);
  a.run(`state.contacts.delete("bob")`); assert.deepEqual(J(a.run(`searchQueryMessages("meeting").map((r) => r.id)`)), []);
  const items = J(a.run(`cmdkBuildItems("встреч").filter((i) => i.g === T("cmdk.messages")).map((i) => i.label)`)); assert.equal(items.length, 1); assert.match(items[0], /Alice/);
  assert.equal(J(a.run(`cmdkBuildItems("в")`)).filter((i) => i.g === "Messages").length, 0, "меньше 2 символов — без сообщений");
  const b = await boot(); b.run(`state.contacts.get("me-test-id")`); assert.equal(b.run(`searchGlobalRows("x")`), null, "до готовности индекса — прежний поиск"); b.close();
  a.close();
});
