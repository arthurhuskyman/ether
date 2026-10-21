// V.77 B6/B8/B9/B10/B12/B14/B15/B16: мелкие правки UI-слоя.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { closeAll } = require("./harness");
const { boot, J } = require("./cov-helpers");
const { readAppSource } = require("./src-helper");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; ensureContactEntry("alice", "Alice").managed = true; state._firstRenderDone = true; })()`);
}

test("B6: подпись ленты меняется, когда контакт из карточки добавлен", async () => {
  const a = await boot(); seed(a);
  a.run(`window.__c = { id: "alice", messages: [{ id: "k1", from: "them", text: "", ts: 1, contactCard: { id: "newbie", name: "N" } }] };`);
  const before = a.run(`chatRenderSig(__c, "", __c.messages)`);
  a.run(`ensureContactEntry("newbie", "N")`);
  assert.notEqual(a.run(`chatRenderSig(__c, "", __c.messages)`), before);
  a.close();
});

test("B8: Ctrl+K работает по e.code на нерусской/русской раскладке", async () => {
  const a = await boot(); seed(a);
  a.run(`window.__cmdk = 0; openCmdk = () => { window.__cmdk++; };`);
  a.run(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "л", code: "KeyK", ctrlKey: true, bubbles: true }));`);
  assert.equal(a.run(`__cmdk`), 1);
  a.close();
});

test("B9: Enter при IME-композиции (keyCode 229) не отправляет форму", async () => {
  const a = await boot(); seed(a);
  const r = a.run(`(() => { const el = $("#chat-input"); wireChatInputKeys(); el.value = "привет"; let n = 0;
    $("#chat-form").requestSubmit = () => { n++; };
    const ev = (kc) => { const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); Object.defineProperty(e, "keyCode", { value: kc }); el.dispatchEvent(e); };
    ev(229); const ime = n; ev(13); return [ime, n]; })()`);
  assert.deepEqual(J(r), [0, 1]);
  a.close();
});

test("B10: @упоминание не-латинских имён учитывает границу слова", async () => {
  const a = await boot();
  assert.equal(a.run(`isMentioned("привет @Иван, как дела", "Иван")`), true);
  assert.equal(a.run(`isMentioned("привет @Иванов", "Иван")`), false);
  assert.equal(a.run(`isMentioned("hi @Zoë!", "Zoë")`), true);
  assert.equal(a.run(`isMentioned("hi @Zoëx", "Zoë")`), false);
  assert.equal(a.run(`isMentioned("@Ольга1", "Ольга")`), false);
  assert.equal(a.run(`isMentioned("@Ann", "Ann")`), true);
  a.close();
});

test("B12: таймер истории возобновляется на blur поля ответа (если оно пустое)", async () => {
  const a = await boot(); seed(a);
  a.run(`window.__t = 0; const orig = window.setTimeout; storiesList = [{ id: "s1", owner: "alice", text: "a", bg: 1, ts: Date.now(), seen: false }, { id: "s2", owner: "alice", text: "b", bg: 1, ts: Date.now() + 1, seen: false }];
    pruneStories = () => storiesList; persistStories = () => {}; wireStories();
    openStoryViewer("alice");`);
  assert.equal(a.run(`__storyViewer.items.length`), 2);
  a.run(`const ri = $("#story-reply-input"); ri.dispatchEvent(new Event("focus")); window.__afterFocus = __storyViewer.timer;`);
  a.run(`const ri2 = $("#story-reply-input"); ri2.value = ""; ri2.dispatchEvent(new Event("blur"));`);
  assert.equal(a.run(`__storyViewer.timer !== null && __storyViewer.timer !== window.__afterFocus`), true);
  // с набранным текстом таймер не возобновляется
  a.run(`const ri3 = $("#story-reply-input"); clearTimeout(__storyViewer.timer); __storyViewer.timer = null; ri3.value = "draft"; ri3.dispatchEvent(new Event("blur"));`);
  assert.equal(a.run(`__storyViewer.timer`), null);
  a.run(`closeStoryViewer()`);
  a.close();
});

test("B14: cleanupExpiredFileBlobs удаляет блоб своего стикера sticker.custom", async () => {
  const a = await boot(); seed(a);
  const dels = a.run(`(() => { const d = []; IDB.del = (k) => { d.push(k); return Promise.resolve(); };
    cleanupExpiredFileBlobs([{ id: "st1", sticker: { custom: true } }, { id: "f1", file: {} }, { id: "plain" }]); return d; })()`);
  assert.deepEqual(J(dels), ["file:st1", "file:f1"]);
  a.close();
});

test("B15: аватар заливается белым до drawImage (прозрачный PNG не чернеет)", () => {
  const src = readAppSource();
  const i = src.indexOf("function readImageAsAvatarDataUrl");
  const body = src.slice(i, i + 1200);
  assert.ok(body.indexOf("fillRect") > 0 && body.indexOf("fillRect") < body.indexOf("drawImage"));
});

test("B16: клик по документу с href=\"#\" не меняет location.hash", async () => {
  const src = readAppSource();
  assert.match(src, /docLink\.getAttribute\("href"\) === "#"\) ev\.preventDefault\(\)/);
});
