// Покрытие app.js: тред чата — жесты (свайп строки, долгое нажатие, свайп-ответ, двойной тап), клики по содержимому пузыря.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers, installTouch, installPtr } = require("./cov-helpers");
test.after(closeAll);

function seedThread(a) {
  a.run(`(() => { Store.myId = "me-test-id"; const now = Date.now();
    const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.publicKey = null;
    c.messages.push(
      { id: "t1", from: "them", text: "see https://example.com/page now", ts: now - 9000, readAckSent: true },
      { id: "t2", from: "me", text: "quote reply", ts: now - 8000, ack: "read", replyTo: { msgId: "t1", text: "see", from: "them", authorName: "Alice" } },
      { id: "t3", from: "me", text: "failed one", ts: now - 7000, ack: "failed" },
      { id: "t4", from: "them", text: "", ts: now - 6000, readAckSent: true, file: { name: "p.png", mime: "image/png", size: 10, kind: "image" } },
      { id: "t5", from: "them", text: "", ts: now - 5000, readAckSent: true, file: { name: "voice-message", mime: "audio/webm", size: 10, kind: "audio", duration: 3 } },
      { id: "t6", from: "me", text: "thread reply", ts: now - 4000, ack: "sent", replyTo: { msgId: "t1", text: "see", from: "them" } },
      { id: "t7", from: "them", text: "fwd", ts: now - 3000, readAckSent: true, forwarded: true, forwardedFrom: "Bob", edited: true, ttl: 3600000 },
      { id: "t8", from: "them", text: "gone-reply", ts: now - 2000, readAckSent: true, replyTo: { msgId: "missing", text: "x", from: "me" } },
      { id: "t9", from: "them", text: "fav", ts: now - 1000, readAckSent: true, favorite: true, reactions: { "👍": ["alice"], "❤️": ["me-test-id"] } });
    window.getFileBlobUrl = async (id) => "blob:" + id; window.openMediaViewer = (u, k) => { window.__viewer = [u, k]; };
    window.openLinkActionSheet = (u) => { window.__link = u; }; window.openMessageSheet = (m, cid) => { (window.__sheet = window.__sheet || []).push([m, cid]); }; window.openQuickReactionFlyout = (el, m, cid) => { window.__fly = [m, cid]; };
    window.openThread = (cid, mid) => { window.__thread = [cid, mid]; }; window.ensureMessageRendered = (cid, mid) => { window.__ens = mid; };
    state._firstRenderDone = true; persistContacts(); state.tab = "chats"; state.chatId = "alice"; renderTab(); })()`);
}
const bubble = (a, id) => a.document.querySelector(`#chat-messages .bubble[data-msg-id="${id}"]`);

test("тред: рендер разных сообщений и клики по содержимому пузыря", async () => {
  const a = await boot(); const t = fakeTimers(a); installTouch(a); seedThread(a);
  assert.ok(a.document.querySelectorAll("#chat-messages .bubble").length >= 9);
  // ссылка
  const link = bubble(a, "t1").querySelector("a[href]"); assert.ok(link); link.click(); assert.ok(a.window.__link && a.window.__link.includes("example.com"));
  // цитата ответа: оригинал есть → подсветка; нет → ensure + тост
  const q = bubble(a, "t2").querySelector(".bubble-reply[data-reply-to-id]"); assert.ok(q); q.click(); t.tick(2000);
  bubble(a, "t8").querySelector(".bubble-reply[data-reply-to-id]").click(); assert.equal(a.window.__ens, "missing");
  // повтор неудачного
  a.run(`window.retryMessage = (c, m) => { window.__retry = m; };`);
  const retry = bubble(a, "t3").querySelector(".ack-failed[data-retry]"); if (retry) { retry.click(); assert.equal(a.window.__retry, "t3"); }
  // картинка → медиа-вьюер
  bubble(a, "t4").click(); await sleep(20); assert.deepEqual(J(a.window.__viewer), ["blob:t4", "image"]);
  // аудио → воспроизведение
  a.run(`window.toggleVoicePlaybackFor = (el) => { window.__voice = el.getAttribute("data-msg-id"); };`);
  bubble(a, "t5").click(); assert.equal(a.window.__voice, "t5");
  // чип треда
  const chip = a.document.querySelector(".thread-chip"); if (chip) { chip.click(); assert.deepEqual(J(a.window.__thread), ["alice", chip.getAttribute("data-thread")]); }
  // одиночный тап → меню по таймеру 220 мс; двойной → реакция
  bubble(a, "t7").click(); t.tick(300); assert.deepEqual(J(a.window.__sheet.at(-1)), ["t7", "alice"]);
  a.run(`window.toggleReaction = (cid, mid, em) => { window.__react = [cid, mid, em]; };`);
  bubble(a, "t7").click(); bubble(a, "t7").click(); assert.equal(a.window.__react[1], "t7");
  // мультивыбор: клик переключает выбор
  a.run(`state.multiSelect = new Set(); window.toggleMultiSelectMsg = (id) => { window.__ms = id; };`); bubble(a, "t7").click(); assert.equal(a.window.__ms, "t7"); a.run(`state.multiSelect = null;`);
  // кнопка «показать превью» в режиме ask
  a.run(`Store.linkPreviewMode = "ask"; renderChatThread();`);
  const ask = a.document.querySelector("[data-preview-ask]"); if (ask) { ask.click(); assert.ok(a.run(`linkPreviewAllowed.size`) >= 1); }
  a.close();
});

test("тред: долгое нажатие (touch/mouse), отмена движением, свайп-ответ, порог и RTL", async () => {
  const a = await boot(); const t = fakeTimers(a); installTouch(a); seedThread(a);
  const b = () => bubble(a, "t1");
  a.run(`{ const el = document.querySelector('#chat-messages .bubble[data-msg-id="t1"]'); __touch(el, "touchstart", 10, 10); }`); t.tick(150);
  assert.ok(b().classList.contains("bubble-pressing")); t.tick(500);
  assert.deepEqual(J((a.window.__sheet || []).pop()), ["t1", "alice"]); b().click(); // гасится флагом
  a.window.__sheet = [];
  a.run(`{ const el = document.querySelector('#chat-messages .bubble[data-msg-id="t1"]'); __touch(el, "touchstart", 10, 10); __touch(el, "touchmove", 60, 10); }`); t.tick(700); assert.equal((a.window.__sheet || []).length, 0, "движение отменяет долгое нажатие");
  a.run(`{ const el = document.querySelector('#chat-messages .bubble[data-msg-id="t1"]'); __touch(el, "touchend", 60, 10); __touch(el, "touchcancel", 60, 10);
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 5 })); el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 6, clientY: 6 })); el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 90, clientY: 90 })); el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true })); }`);
  a.run(`state.multiSelect = new Set(); { const el = document.querySelector('#chat-messages .bubble[data-msg-id="t1"]'); __touch(el, "touchstart", 1, 1); } `); t.tick(700); assert.equal((a.window.__sheet || []).length, 0, "в мультивыборе меню не открывается"); a.run(`state.multiSelect = null;`);
  // свайп-ответ: короткий не срабатывает, длинный ставит replyTo
  a.run(`{ const el = document.querySelector('#chat-messages .bubble[data-msg-id="t1"]'); state.replyTo = null; __touch(el, "touchstart", 100, 100); __touch(el, "touchmove", 120, 101); __touch(el, "touchend", 120, 101); }`);
  assert.equal(a.run(`state.replyTo`), null);
  a.run(`{ const el = document.querySelector('#chat-messages .bubble[data-msg-id="t1"]'); __touch(el, "touchstart", 100, 100); __touch(el, "touchmove", 150, 101); __touch(el, "touchmove", 230, 101); __touch(el, "touchmove", 170, 101); __touch(el, "touchmove", 240, 101); __touch(el, "touchend", 240, 101); }`);
  assert.equal(a.run(`state.replyTo && state.replyTo.msgId`), "t1");
  assert.ok(!a.document.querySelector("#reply-banner").classList.contains("hidden"));
  a.close();
});

test("список чатов: свайп строки открывает панели, кнопки архив/мьют/закрепить/удалить, тап закрывает", async () => {
  const a = await boot(); const t = fakeTimers(a); installTouch(a);
  a.run(`(() => { for (let i = 0; i < 3; i++) { const c = ensureContactEntry("s" + i, "Sw" + i); c.managed = true; c.messages.push({ id: "x" + i, from: "me", text: "hi", ts: Date.now() - i, ack: "read" }); } state._firstRenderDone = true; persistContacts(); state.tab = "chats"; state.chatsSegment = "chats"; renderTab(); })()`);
  const rowOf = (i) => a.document.querySelectorAll("#chats-list .chat-row")[i];
  const swipe = (i, dx) => a.run(`{ const r = document.querySelectorAll("#chats-list .chat-row")[${i}]; __touch(r, "touchstart", 200, 50); __touch(r, "touchmove", ${200 + dx}, 52); __touch(r, "touchend", ${200 + dx}, 52); }`);
  swipe(0, 150); const w0 = rowOf(0).parentElement; assert.ok(w0.classList.contains("swiped-start"));
  swipe(1, -150); assert.ok(!w0.classList.contains("swiped-start"), "первая закрылась"); assert.ok(rowOf(1).parentElement.classList.contains("swiped-end"));
  swipe(1, 20); // небольшой сдвиг: вернуть
  swipe(2, 5); // не начало перетаскивания
  t.tick(400);
  a.run(`window.confirmSheet = async () => true;`);
  // тап по открытой строке закрывает вместо открытия чата
  swipe(0, 150); rowOf(0).click(); assert.equal(a.run(`state.chatId`), null);
  const acts = () => rowOf(0).parentElement;
  acts().querySelector(".chat-row-action-pin").click();
  acts().querySelector(".chat-row-action-mute").click();
  acts().querySelector(".chat-row-action-archive").click();
  assert.ok(a.run(`[...state.contacts.values()].some((c) => c.archived)`));
  await (async () => { const w = rowOf(0).parentElement; w.querySelector(".chat-row-action-delete").click(); await sleep(30); })();
  a.run(`window.confirmSheet = async () => false;`);
  await (async () => { const w = rowOf(0).parentElement; w.querySelector(".chat-row-action-delete").click(); await sleep(30); })();
  // RTL
  a.run(`document.documentElement.dir = "rtl"; renderChatsList();`); swipe(0, 150); swipe(0, -150); a.run(`document.documentElement.dir = "ltr";`);
  a.close();
});

test("тред: жест «назад» от левого края, вертикальный увод и короткий свайп не закрывают чат", async () => {
  const a = await boot(); const t = fakeTimers(a); installTouch(a); seedThread(a);
  const scr = () => a.document.querySelector("#screen-chat");
  const g = (x0, y0, x1, y1, mid) => a.run(`{ const s = document.getElementById("screen-chat"); __touch(s, "touchstart", ${x0}, ${y0}); ${mid ? `__touch(s, "touchmove", ${x0 + 20}, ${y0 + 200});` : `__touch(s, "touchmove", ${x1}, ${y1});`} __touch(s, "touchend", ${x1}, ${y1}); }`);
  g(10, 100, 50, 100); assert.equal(a.run(`state.chatId`), "alice", "короткий — остаёмся");
  g(100, 100, 300, 100); assert.equal(a.run(`state.chatId`), "alice", "не от края");
  g(10, 100, 200, 100, true); assert.equal(a.run(`state.chatId`), "alice", "уход по вертикали");
  g(10, 100, 200, 101); assert.equal(a.run(`state.chatId`), null);
  a.close();
});
