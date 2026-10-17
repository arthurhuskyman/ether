// Покрытие app.js: список чатов (фильтры, закрепление, порядок), контакты, карточка контакта, инфо о группе, демо-чат.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers, installTouch, installPtr } = require("./cov-helpers");
test.after(closeAll);

function seedMany(a) {
  a.run(`(() => { Store.myId = "me-test-id";
    const now = Date.now();
    for (let i = 0; i < 26; i++) { const c = ensureContactEntry("u" + i, (i % 2 ? "Борис " : "Alice ") + String.fromCharCode(65 + (i % 26)) + i); c.managed = true; c.lastActivity = now - i * 1000; c.messages.push({ id: "m" + i, from: i % 3 === 0 ? "them" : "me", text: "msg " + i, ts: now - i * 1000, readAckSent: i % 3 !== 0, ack: "read" }); }
    state.contacts.get("u0").pinned = true; state.contacts.get("u0").pinOrder = 0; state.contacts.get("u1").pinned = true; state.contacts.get("u1").pinOrder = 1; state.contacts.get("u2").pinned = true; state.contacts.get("u2").pinOrder = 2;
    state.contacts.get("u3").muted = true; state.contacts.get("u4").blocked = true; state.contacts.get("u5").archived = true; state.contacts.get("u6").muteUntil = now + 3600000;
    state.contacts.get("u7").messages.push({ id: "f7", from: "them", text: "", ts: now, readAckSent: false, file: { name: "a.png", mime: "image/png", size: 5, kind: "image" } });
    state.contacts.get("u8").messages.push({ id: "p8", from: "me", text: "Q?", ts: now, poll: { q: "Q?", multi: false, opts: [{ id: "a", t: "A" }, { id: "b", t: "B" }] }, pollVotes: {} });
    state.contacts.get("u9").messages.push({ id: "s9", from: "system", text: "x", textKey: "group.systemWriteOpen", ts: now });
    state.typingTimers.set("u10", 1);
    state.contacts.set("g1", { id: "g1", name: "Team", managed: true, isGroup: true, createdBy: "me-test-id", members: [{ id: "me-test-id", name: "Tester", role: "admin" }, { id: "u1", name: "Борис B1" }, { id: "u2", name: "Alice C2" }], messages: [{ id: "g-1", from: "them", fromId: "u1", fromName: "Борис", text: "yo @Tester", ts: now, readAckSent: false }], lastActivity: now });
    state.mentionedChats.add("g1");
    state._firstRenderDone = true; persistContacts(); })()`);
}

test("список чатов: фильтры, поиск, архив, непрочитанные, «печатает», пустое состояние", async () => {
  const a = await boot(); const t = fakeTimers(a); seedMany(a);
  const rows = () => a.document.querySelectorAll("#chats-list .chat-row").length;
  a.run(`state.tab = "chats"; state.chatsSegment = "chats"; renderTab();`);
  const all = rows(); assert.ok(all >= 20, "строк: " + all);
  assert.ok(a.document.querySelector(".chats-section-header"), "секция непрочитанных");
  assert.ok(a.document.querySelector(".chat-row-typing"), "индикатор печати");
  assert.ok(a.document.querySelector(".chat-row-mention"));
  for (const f of ["unread", "groups", "direct", "all"]) { a.run(`state.chatFilter = ${JSON.stringify(f)}; renderChatsList();`); }
  a.run(`state.chatFilter = "groups"; renderChatsList();`); assert.equal(rows(), 1);
  a.run(`state.chatFilter = "all"; state.showArchived = true; renderChatsList();`); assert.ok(rows() > all - 1); a.run(`state.showArchived = false;`);
  a.run(`state.searchQuery = "msg 1"; renderChatsList();`); assert.ok(rows() >= 1 && rows() < all);
  a.run(`state.searchQuery = "zzzz-none"; renderChatsList();`);
  a.run(`state.searchQuery = ""; state.chatFilter = "folder:nope"; renderChatsList(); state.chatFilter = "all"; renderChatsList();`);
  // пустое состояние: без собеседников — карточка первого запуска
  a.run(`for (const id of [...state.contacts.keys()]) { const c = state.contacts.get(id); if (!c.isSelf) state.contacts.delete(id); } renderChatsList();`);
  const card = a.document.querySelector("#first-run-card"); assert.ok(card);
  a.run(`window.createDemoChat = () => { window.__demo = 1; };`);
  card.querySelector('[data-first="demo"]').click(); assert.equal(a.window.__demo, 1);
  card.querySelector('[data-first="find"]').click(); card.querySelector('[data-first="invite"]').click(); t.tick(200);
  a.run(`state.tab = "chats"; renderTab();`); a.document.querySelector("#first-run-card").querySelector('[data-first="scan"]').click();
  a.close();
});

test("список чатов: порядок закреплённых (долгое нажатие, перетаскивание), клик по строке", async () => {
  const a = await boot(); const t = fakeTimers(a); seedMany(a); installPtr(a);
  a.run(`state.tab = "chats"; state.chatsSegment = "chats"; renderTab();`);
  const row = () => a.document.querySelector("#chats-list .chat-row");
  // долгое нажатие по закреплённому чату включает режим порядка
  a.run(`{ const r = [...document.querySelectorAll("#chats-list .chat-row")].find((x) => x.textContent.includes("Alice A0")); __ptr(r, "pointerdown", 10, 10); __ptr(r, "pointermove", 11, 11); }`);
  t.tick(1200);
  assert.equal(a.run(`state.pinReorder`), true, "режим порядка включён");
  const pairs = a.document.querySelectorAll(".chat-row-drag-handle"); assert.ok(pairs.length >= 3, "ручки перетаскивания");
  // отмена долгого нажатия сдвигом
  a.run(`{ const r = document.querySelector("#chats-list .chat-row"); __ptr(r, "pointerdown", 10, 10); __ptr(r, "pointermove", 100, 100); __ptr(r, "pointerup", 100, 100); __ptr(r, "pointercancel", 1, 1); __ptr(r, "pointerleave", 1, 1); }`);
  // перетаскивание первой ручки вниз на место третьей
  a.run(`{ const hs = document.querySelectorAll(".chat-row-drag-handle"); window.__rects = 0;
    document.querySelectorAll(".chat-row-wrapper").forEach((w, i) => { w.getBoundingClientRect = () => ({ top: i * 60, height: 60 }); });
    const h = hs[0]; __ptr(h, "pointerdown", 5, 30, { setPointerCapture() {} }); __ptr(h, "pointermove", 5, 100); __ptr(h, "pointerup", 5, 130); __ptr(h, "click", 5, 5);
    const h2 = hs[1]; __ptr(h2, "pointermove", 1, 1); __ptr(h2, "pointerup", 1, 1); __ptr(h2, "pointerdown", 1, 1, { pointerType: "mouse", button: 2 }); }`);
  const order = J(a.run(`["u0","u1","u2"].map((i) => state.contacts.get(i).pinOrder)`)); assert.notDeepEqual(order, [0, 1, 2]);
  a.document.querySelector(".chats-reorder-bar button").click(); assert.equal(a.run(`state.pinReorder`), false);
  // клик по строке открывает чат; повторный «долгий» клик гасится флагом
  a.run(`{ const r = [...document.querySelectorAll("#chats-list .chat-row")].find((x) => x.textContent.includes("Alice E4") || true); r.__longPressed = true; r.click(); r.click(); }`);
  assert.ok(a.run(`state.chatId`));
  a.run(`state.chatId = null; state.pinReorder = true; state.chatFilter = "unread"; renderChatsList(); state.chatFilter = "all"; state.pinReorder = false;`);
  a.close();
});

test("контакты: список A–Z с индексом, поиск, открытие карточки", async () => {
  const a = await boot(); const t = fakeTimers(a); seedMany(a);
  a.run(`state.tab = "connect"; renderTab();`);
  assert.ok(a.document.querySelectorAll("#contacts-list .roster-row").length >= 20);
  assert.ok(!a.document.querySelector("#contacts-index").classList.contains("hidden"), "индекс при >20 контактов");
  a.document.querySelector("#contacts-index .contacts-index-btn").click();
  a.run(`state.contactsSearchQuery = "борис"; renderContactsList();`); assert.ok(a.document.querySelectorAll("#contacts-list .roster-row").length < 26); assert.ok(a.document.querySelector("#contacts-index").classList.contains("hidden"));
  a.run(`state.contactsSearchQuery = "zzzzz"; renderContactsList();`); assert.ok(!a.document.querySelector("#contacts-empty").classList.contains("hidden"));
  a.run(`state.contactsSearchQuery = "";  renderContactsList();`);
  a.document.querySelector("#contacts-list .roster-row").click(); assert.ok(a.run(`state.contactCardId`));
  a.run(`state.contactCardId = null; state.tab = "connect"; renderTab(); document.querySelector("#contacts-list .roster-add-btn").click();`); assert.ok(a.run(`state.contactCardId`));
  a.run(`openContactCard("nope"); openContactCard("g1");`); assert.ok(!a.document.querySelector("#group-info-sheet").classList.contains("hidden"));
  a.close();
});

test("карточка контакта: все действия, галерея, закрепление, мьют, блок, архив, очистка, удаление", async () => {
  const a = await boot(); const t = fakeTimers(a); seedMany(a);
  a.run(`const c = state.contacts.get("u7"); c.raw = "raw-id"; c.peerStatus = "Hi there"; c.avatar = null; c.peerAvatar = "data:image/png;base64,AAAA";
    c.messages.push({ id: "gv", from: "them", text: "", ts: Date.now(), file: { name: "v.mp4", mime: "video/mp4", size: 1, kind: "video" } });
    window.getFileBlobUrl = async (id) => "blob:" + id; window.openMediaViewer = (u, k) => { window.__viewer = [u, k]; };
    openContactCard("u7");`);
  assert.equal(a.document.querySelector("#contact-about-status").textContent, "Hi there");
  t.tick(10); await sleep(30);
  assert.ok(a.document.querySelectorAll("#contact-gallery-grid .contact-gallery-item").length >= 2);
  a.run(`wireContactGallery();`);
  a.document.querySelector("#contact-gallery-grid .contact-gallery-item").click(); await sleep(20);
  assert.ok(a.window.__viewer);
  a.document.querySelector("#contact-gallery-grid").click();
  const click = (sel) => { const e = a.document.querySelector(sel); assert.ok(e, sel); e.click(); };
  const change = (sel, v) => { const e = a.document.querySelector(sel); e.value = v; e.dispatchEvent(new a.window.Event("change")); };
  a.run(`window.confirmSheet = async () => true; window.beginCall = (id) => { window.__begin = id; }; window.exportChat = (id) => { window.__exp = id; }; window.openSafetySheet = (id) => { window.__safe = id; }; window.openForwardSheet = (cb) => cb("u8"); window.forwardContact = (a1, b1) => { window.__fwd = [a1, b1]; };`);
  click("#contact-call-btn"); assert.equal(a.window.__begin, "u7");
  click("#contact-rename-btn"); assert.ok(!a.document.querySelector("#rename-sheet").classList.contains("hidden")); assert.equal(a.document.querySelector("#rename-input").value, a.run(`state.contacts.get("u7").name`));
  change("#contact-disappearing-select", "3600"); change("#contact-sound-select", "bell"); assert.equal(a.run(`state.contacts.get("u7").notificationSound`), "bell"); change("#contact-sound-select", ""); assert.equal(a.run(`state.contacts.get("u7").notificationSound`), undefined);
  click("#contact-mute-btn"); assert.ok(!a.document.querySelector("#mute-sheet").classList.contains("hidden"));
  a.run(`state.contacts.get("u7").muted = true;`); click("#contact-mute-btn"); assert.equal(a.run(`state.contacts.get("u7").muted`), false);
  const vo = a.document.querySelector("#contact-vibrate-only"); vo.checked = true; vo.dispatchEvent(new a.window.Event("change")); assert.equal(a.run(`state.contacts.get("u7").vibrateOnly`), true);
  click("#contact-pin-btn"); assert.equal(a.run(`state.contacts.get("u7").pinned`), true); click("#contact-pin-btn"); assert.equal(a.run(`state.contacts.get("u7").pinOrder`), null);
  click("#contact-archive-btn"); assert.equal(a.run(`state.contacts.get("u7").archived`), true); click("#contact-archive-btn");
  click("#contact-block-btn"); assert.equal(a.run(`state.contacts.get("u7").blocked`), true); click("#contact-block-btn");
  click("#contact-export-btn"); assert.equal(a.window.__exp, "u7"); click("#contact-forward-btn"); assert.deepEqual(J(a.window.__fwd), ["u7", "u8"]); click("#contact-safety-btn"); assert.equal(a.window.__safe, "u7");
  click("#contact-msg-btn"); assert.equal(a.run(`state.chatId`), "u7");
  a.run(`openContactCard("u7");`); click("#contact-clear-btn"); await sleep(20); assert.equal(a.run(`state.contacts.get("u7").messages.length`), 0);
  click("#contact-delete-btn"); await sleep(20); assert.ok(!a.run(`state.contacts.has("u7")`));
  a.run(`state.contactCardId = "zzz"; renderContactCard();`);
  a.run(`state.contactCardId = null; document.getElementById("contact-call-btn").click(); document.getElementById("contact-msg-btn").click();`);
  a.close();
});

test("инфо о группе: админ и участник, роли, удаление участника, режим «пишут только админы», комната", async () => {
  const a = await boot(); const t = fakeTimers(a); seedMany(a);
  a.run(`window.trySendOrQueue = async (c, id, p) => { (window.__sent = window.__sent || []).push([c.id, p.kind]); };`);
  a.run(`openGroupInfo("g1");`);
  assert.ok(!a.document.querySelector("#group-info-sheet").classList.contains("hidden"));
  const rows = a.document.querySelectorAll("#group-info-members .forward-row"); assert.equal(rows.length, 3);
  assert.ok(a.document.querySelector("#group-info-members .group-role-badge"));
  // повысить участника
  const promote = [...a.document.querySelectorAll("#group-info-members button")].find((b) => b.textContent === a.run(`T("group.promote")`)); assert.ok(promote); promote.click();
  assert.ok(a.run(`isGroupAdmin(state.contacts.get("g1"), "u1")`));
  const demote = [...a.document.querySelectorAll("#group-info-members button")].find((b) => b.textContent === a.run(`T("group.demote")`)); demote.click();
  assert.ok(!a.run(`isGroupAdmin(state.contacts.get("g1"), "u1")`));
  // удалить участника
  a.run(`window.confirmSheet = async () => true;`);
  a.document.querySelector('#group-info-members button[aria-label]').click(); await sleep(30);
  const sentKinds = J(a.window.__sent || []).map((x) => x[1]);
  // режим «пишут только админы»
  a.run(`setGroupWriteRestricted("g1", true);`); assert.equal(a.run(`state.contacts.get("g1").writeRestricted`), true); assert.equal(a.run(`isGroupWriteAllowed(state.contacts.get("g1"), "u2")`), false);
  assert.ok(J(a.window.__sent).some((x) => x[1] === "group-settings"));
  a.run(`setGroupWriteRestricted("g1", false); setGroupWriteRestricted("nope", true); state.contacts.get("g1").createdBy = "u2"; state.contacts.get("g1").members.find((m) => m.id === "me-test-id").role = "member";`);
  a.run(`setGroupWriteRestricted("g1", true);`); // не админ — отказ
  assert.equal(a.run(`state.contacts.get("g1").writeRestricted`), false);
  assert.equal(a.run(`isGroupWriteAllowed(null, "x") && isGroupWriteAllowed({}, "x")`), true);
  a.run(`openGroupInfo("g1"); openGroupInfo("nope"); state.contacts.get("g1").avatar = "data:image/png;base64,AAAA"; openGroupInfo("g1");`);
  assert.ok(a.document.querySelector("#group-info-rename-btn").classList.contains("hidden"));
  assert.equal(a.document.querySelector("#group-info-name").disabled, true);
  a.close();
});

test("демо-чат: создание, ответы гида по шагам, опрос и доска", async () => {
  const a = await boot(); const t = fakeTimers(a);
  a.run(`createDemoChat();`);
  assert.ok(a.run(`state.contacts.has(DEMO_CHAT_ID)`));
  assert.ok(a.run(`state.contacts.get(DEMO_CHAT_ID).messages.length`) >= 2);
  a.run(`createDemoChat();`);
  a.run(`state.chatId = DEMO_CHAT_ID; renderTab();`);
  for (const kind of ["chat", "chat", "chat", "chat", "poll", "board", "file", "nope"]) { a.run(`demoOnSend(state.contacts.get(DEMO_CHAT_ID), ${JSON.stringify({ kind: "__K__" })})`.replace("__K__", kind)); t.tick(1600); }
  a.run(`demoOnSend(state.contacts.get(DEMO_CHAT_ID), null);`);
  a.run(`demoSay(state.contacts.get(DEMO_CHAT_ID), "text");`);
  a.close();
});
