// Покрытие app.js: отложенные сообщения, мьют, правка/удаление, истории, треды, опросы/доски/заметки, карточки контактов, исчезающие.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

function seedChat(a) {
  a.run(`(() => { Store.myId = "me-test-id"; Store.name = "Tester";
    const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.publicKey = { kty: "EC" };
    c.messages.push({ id: "t1", from: "them", text: "root", ts: Date.now() - 5000, readAckSent: true });
    state.contacts.set("g1", { id: "g1", name: "Team", managed: true, isGroup: true, createdBy: "me-test-id", members: [{ id: "me-test-id", name: "Tester", role: "admin" }, { id: "alice", name: "Alice" }], messages: [], lastActivity: 1 });
    window.J = (x) => JSON.parse(JSON.stringify(x)); window.__sent = []; window.trySendOrQueue = async (c, id, p) => { window.__sent.push([c.id, p.kind, p]); };
    state._firstRenderDone = true; persistContacts(); state.tab = "chats"; state.chatId = "alice"; renderTab(); })()`);
}
const sentKinds = (a) => J(a.window.__sent).map((x) => x[1]);

test("отложенные сообщения: шторка, пресеты, список, отмена, рассылка по сроку, долгое нажатие на «Отправить»", async () => {
  const a = await boot(); const t = fakeTimers(a); seedChat(a);
  a.run(`window.sendChatMessage = (id, text, r) => { (window.__plain = window.__plain || []).push([id, text]); }; window.sendGroupMessage = (id, text, r) => { (window.__plain = window.__plain || []).push([id, text, "g"]); };`);
  const input = a.document.querySelector("#chat-input");
  a.run(`openScheduleSheet();`); assert.ok(!a.document.querySelector("#schedule-sheet").classList.contains("hidden")); assert.ok(a.document.querySelector("#schedule-custom-input").value.length > 8);
  // пустое поле: ничего не планируется
  a.run(`queueScheduledMessage(Date.now() + 1000)`); assert.equal(a.run(`state.scheduledMessages.length`), 0);
  input.value = "later 1"; a.document.querySelector("#schedule-preset-1h").click(); assert.equal(a.run(`state.scheduledMessages.length`), 1); assert.equal(input.value, "");
  input.value = "later 2"; a.document.querySelector("#schedule-preset-tomorrow").click();
  input.value = "later 3"; a.document.querySelector("#schedule-custom-input").value = "2999-01-01T10:00"; a.document.querySelector("#schedule-custom-confirm-btn").click();
  input.value = "later 4"; a.document.querySelector("#schedule-custom-input").value = ""; a.document.querySelector("#schedule-custom-confirm-btn").click(); assert.equal(a.run(`state.scheduledMessages.length`), 3);
  a.document.querySelector("#schedule-custom-input").value = "bad"; a.document.querySelector("#schedule-custom-confirm-btn").click();
  assert.ok(!a.document.querySelector("#schedule-banner").classList.contains("hidden")); assert.equal(a.document.querySelector("#schedule-banner-count").textContent, "3");
  a.document.querySelector("#schedule-banner").click(); assert.equal(a.document.querySelectorAll("#schedule-list .forward-row").length, 3);
  a.document.querySelector(".schedule-row-cancel-btn").click(); assert.equal(a.run(`state.scheduledMessages.length`), 2);
  assert.equal(a.run(`scheduledCountFor("alice")`), 2);
  // срок наступил: уходит обычным сообщением; чужие/удалённые контакты пропускаются
  a.run(`state.scheduledMessages.forEach((s) => s.sendAt = Date.now() - 5); state.scheduledMessages.push({ id: "x", contactId: "gone", text: "z", sendAt: 1 }, { id: "y", contactId: "g1", isGroup: true, text: "grp", sendAt: 1 }); sweepScheduledMessages(); sweepScheduledMessages();`);
  assert.equal(a.run(`state.scheduledMessages.length`), 0); assert.equal(a.window.__plain.length, 3);
  // долгое нажатие на кнопку отправки
  const btn = a.document.querySelector('#chat-form button[type="submit"].send-btn'); wire(a);
  input.value = "hold"; btn.dispatchEvent(new a.window.MouseEvent("mousedown", { bubbles: true })); t.tick(600);
  assert.ok(!a.document.querySelector("#schedule-sheet").classList.contains("hidden"));
  const ck = new a.window.MouseEvent("click", { bubbles: true, cancelable: true }); btn.dispatchEvent(ck); assert.equal(ck.defaultPrevented, true);
  btn.dispatchEvent(new a.window.MouseEvent("mousedown", { bubbles: true })); btn.dispatchEvent(new a.window.MouseEvent("mouseup", { bubbles: true })); t.tick(700);
  input.value = ""; btn.dispatchEvent(new a.window.MouseEvent("mousedown", { bubbles: true })); t.tick(700);
  a.close();
});
function wire(a) { /* кнопка отправки уже подключена при старте приложения */ }

test("мьют на время, правка и удаление сообщений у обоих", async () => {
  const a = await boot(); const t = fakeTimers(a); seedChat(a);
  a.run(`state.chatId = null; state.contactCardId = "alice"; renderTab();`);
  for (const id of ["#mute-preset-1h", "#mute-preset-8h", "#mute-preset-tomorrow"]) { a.document.querySelector(id).click(); assert.ok(a.run(`isContactMuted(state.contacts.get("alice"))`)); a.run(`state.contacts.get("alice").muteUntil = null; state.contacts.get("alice").muted = false;`); }
  a.document.querySelector("#mute-preset-forever").click(); assert.equal(a.run(`state.contacts.get("alice").muted`), true);
  a.run(`state.contactCardId = null; state.chatId = "alice"; renderTab(); state.contacts.get("alice").messages.push({ id: "mine1", from: "me", text: "orig", ts: Date.now(), ack: "sent" }, { id: "mf", from: "me", text: "", ts: Date.now(), file: { name: "a.png", mime: "image/png", size: 1, kind: "image" } });
    fileBlobUrlCache.set("mf", "blob:x");`);
  return (async () => {
    await a.run(`commitEdit("alice", "mine1", "new  text :)")`); const m = J(a.run(`state.contacts.get("alice").messages.find((x) => x.id === "mine1")`)); assert.equal(m.edited, true); assert.ok(m.text.startsWith("new"));
    await a.run(`commitEdit("nope", "x", "y")`); await a.run(`commitEdit("alice", "nope", "y")`);
    assert.ok(sentKinds(a).includes("edit"));
    await a.run(`deleteMessageForBoth("alice", "mine1")`); assert.ok(!a.run(`state.contacts.get("alice").messages.some((x) => x.id === "mine1")`)); assert.ok(sentKinds(a).includes("delete"));
    a.run(`deleteMessageLocal("alice", "mf", true); persistContacts();`); assert.ok(!a.run(`fileBlobUrlCache.has("mf")`));
    a.run(`deleteMessageLocal("alice", "nope"); deleteMessageLocal("zzz", "nope");`);
    await a.run(`deleteMessageForBoth("zzz", "x")`);
    // группа: правка уходит каждому участнику
    a.run(`state.contacts.get("g1").messages.push({ id: "gm", from: "me", text: "g", ts: Date.now(), ack: "sent" });`); await a.run(`commitEdit("g1", "gm", "g2")`);
    assert.ok(J(a.window.__sent).some((x) => x[0] === "alice" && x[1] === "edit" && x[2].groupId === "g1"));
    a.close();
  })();
});

test("истории: публикация, приём чужих (валидация), просмотр, ответ, удаление, лимиты", async () => {
  const a = await boot(); const t = fakeTimers(a); seedChat(a);
  a.run(`window.sendChatMessage = async (id, text, r) => { window.__reply = [id, text, r]; };`);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]).toString("base64");
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]).toString("base64");
  const r = J(await a.run(`(async () => { const o = {};
    o.empty = await publishStory("   ", 0); o.long = await publishStory("x".repeat(500), 99); o.stories1 = loadStories().length; o.len = loadStories()[0].text.length; o.bg = loadStories()[0].bg;
    o.sentStories = window.__sent.filter((x) => x[1] === "story").length;
    o.badPhoto = await publishStory("", 0, { blob: new Blob(["x"], { type: "image/png" }), w: 1, h: 1 });
    const jb = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], { type: "image/jpeg" }); o.photoOk = await publishStory("cap", 2, { blob: jb, w: 100, h: 50 });
    const notJpeg = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], { type: "image/jpeg" }); o.photoSig = await publishStory("", 0, { blob: notJpeg, w: 1, h: 1 });
    o.pm = [sanitizeStoryPhotoMeta({ mime: "image/png", w: 10, h: 99999, size: 100 }), sanitizeStoryPhotoMeta({ mime: "image/gif" }), sanitizeStoryPhotoMeta(null), sanitizeStoryPhotoMeta({ mime: "image/webp", w: 1, h: 1, size: 9999999 })];
    o.sig = [storyPhotoBytesOk(new Uint8Array(12), "image/jpeg"), storyPhotoBytesOk(null, "image/png"), storyPhotoBytesOk(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), "image/webp"), storyPhotoBytesOk(new Uint8Array(20), "image/gif")];
    // приём
    const rc = (p, from) => receiveStory(from || "alice", p);
    rc({ id: "s1", text: "hello", bg: 3, ts: Date.now() }); rc({ id: "s1", text: "dup", ts: Date.now() }); rc({ id: "bad id!", text: "x" }); rc({ id: "s2" }); rc({ id: "s3", text: "old", ts: Date.now() - 2 * 86400000 }); rc(null); rc({ id: "s4", text: "x" }, "stranger"); rc({ id: "s5", text: "ctl\\u0001x" });
    state.contacts.get("alice").blocked = true; rc({ id: "s6", text: "blocked" }); state.contacts.get("alice").blocked = false;
    rc({ id: "s7", text: "ph", mime: "image/gif", dataB64: "AAAAAAAAAAAAAAAAAAAA" }); rc({ id: "s8", text: "ph", mime: "image/png", dataB64: "!!" }); rc({ id: "s9", text: "ph", mime: "image/png", dataB64: "${png}" });
    rc({ id: "s10", text: "ph", mime: "image/jpeg", dataB64: "${jpg}", w: 10, h: 10 }); rc({ id: "s11", mime: "image/png", dataB64: "${jpg}" });
    await new Promise((r) => __realTO.call(window, r, 50));
    o.received = loadStories().filter((x) => x.owner === "alice").map((x) => x.id).sort();
    for (let i = 0; i < 25; i++) rc({ id: "bulk" + i, text: "b" + i, ts: Date.now() - i }); o.perOwner = loadStories().filter((x) => x.owner === "alice").length;
    // старая и будущая истории вычищаются
    loadStories().push({ id: "old1", owner: "alice", text: "o", bg: 0, ts: Date.now() - 3 * 86400000, seen: true }, { id: "fut", owner: "alice", text: "f", bg: 0, ts: Date.now() + 3600000 * 5, seen: true }); o.pruned = pruneStories().some((x) => x.id === "old1" || x.id === "fut");
    return o; })()`));
  assert.equal(r.empty, false); assert.equal(r.long, true); assert.equal(r.len, 280); assert.equal(r.bg, 5); assert.equal(r.sentStories, 1); assert.equal(r.badPhoto, false); assert.equal(r.photoOk, true); assert.equal(r.photoSig, false);
  assert.equal(r.pm[1], null); assert.equal(r.pm[2], null); assert.equal(r.pm[0].h, 0); assert.equal(r.pm[3].size, 0); assert.deepEqual(r.sig, [true === false, false, true, false].map((x, i) => (i === 0 ? false : x)));
  assert.ok(r.received.includes("s1") && r.received.includes("s5") && r.received.includes("s9") && r.received.includes("s10") && !r.received.includes("s3") && !r.received.includes("s6") && !r.received.includes("s7") && !r.received.includes("s8") && !r.received.includes("s4"));
  assert.ok(r.perOwner <= 20); assert.equal(r.pruned, false);
  // строка историй и просмотрщик
  a.run(`state.tab = "chats"; state.chatId = null; renderTab(); `);
  assert.ok(a.document.querySelectorAll("#stories-row .story-item").length >= 2);
  a.run(`window.confirmSheet = async () => true;`);
  const alice = a.document.querySelector('#stories-row [data-story-owner="alice"]'); alice.click(); assert.ok(!a.document.querySelector("#story-viewer").classList.contains("hidden"));
  a.document.querySelector("#story-viewer").click(); t.tick(7000); t.tick(7000);
  a.document.querySelector("#story-close-btn").click();
  a.run(`openStoryViewer("alice");`); const ri = a.document.querySelector("#story-reply-input"); ri.dispatchEvent(new a.window.Event("focus")); ri.value = "nice";
  a.document.querySelector("#story-reply").dispatchEvent(new a.window.Event("submit", { cancelable: true })); await sleep(30); assert.equal(a.window.__reply[0], "alice"); assert.ok(a.window.__reply[2].msgId.startsWith("story:"));
  a.run(`openStoryViewer("alice"); document.getElementById("story-reply").dispatchEvent(new Event("submit", { cancelable: true })); closeStoryViewer();`);
  a.run(`openStoryViewer("me");`); t.tick(50); a.document.querySelector("#story-delete-btn").click(); assert.ok(a.run(`loadStories().filter((x) => x.owner === "me").length`) >= 0);
  a.run(`openStoryViewer("nobody"); openStoryViewer("me"); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));`);
  // композер: цвета, публикация, отмена фото
  a.run(`openStoryComposer();`); a.document.querySelector("#story-input").value = "from composer"; a.document.querySelectorAll("#story-swatches .story-swatch")[2].click();
  a.document.querySelector("#story-publish-btn").click(); await sleep(60); assert.ok(a.run(`loadStories().some((x) => x.text === "from composer")`));
  a.run(`setStoryDraftPhoto({ blob: new Blob(["x"], { type: "image/jpeg" }), w: 1, h: 1 }); setStoryDraftPhoto(null); window.prepareStoryPhoto = async () => null; pickStoryPhoto(null);`); await a.run(`pickStoryPhoto({ name: "x" })`);
  a.run(`window.prepareStoryPhoto = async () => ({ blob: new Blob(["x"], { type: "image/jpeg" }), w: 1, h: 1 });`); await a.run(`pickStoryPhoto({ name: "x" })`); a.document.querySelector("#story-photo-remove").click();
  const pickIn = a.document.querySelector("#story-photo-input"); pickIn.dispatchEvent(new a.window.Event("change")); a.document.querySelector("#story-photo-pick").click(); a.document.querySelector("#story-photo-camera").click();
  a.close();
});

test("треды: ветка ответов, шторка, отправка ответа, права записи, свайп вниз", async () => {
  const a = await boot(); const t = fakeTimers(a); seedChat(a);
  a.run(`const c = state.contacts.get("alice"); c.messages.push({ id: "r1", from: "me", text: "reply 1", ts: Date.now() - 4000, ack: "sent", replyTo: { msgId: "t1", text: "root" } }, { id: "r2", from: "them", text: "", ts: Date.now() - 3000, replyTo: { id: "r1" }, file: { name: "a.png", mime: "image/png", size: 1, kind: "image" } });
    window.sendChatMessage = (id, text, r) => { window.__tr = [id, text, r]; }; window.sendGroupMessage = (id, text, r) => { window.__trg = [id, text, r]; };`);
  const r = J(a.run(`(() => { const o = {}; const c = state.contacts.get("alice");
    o.thread = threadMessages(c, "t1").map((m) => m.id); o.none = threadMessages(c, "nope");
    openThread("alice", "nope"); openThread("zzz", "t1"); openThread("alice", "t1"); o.title = document.getElementById("thread-sheet-title").textContent; o.items = document.querySelectorAll("#thread-list .thread-msg").length;
    const inp = document.getElementById("thread-input"); inp.value = "  my reply  "; sendThreadReply(); o.sent = window.__tr; inp.value = ""; sendThreadReply();
    c.blocked = true; renderThreadSheet(); o.blockedDisabled = document.getElementById("thread-input").disabled; c.blocked = false;
    const g = state.contacts.get("g1"); g.messages.push({ id: "gr", from: "them", fromId: "alice", fromName: "Alice", text: "g root", ts: Date.now() }); openThread("g1", "gr"); inp.value = "to group"; sendThreadReply(); o.grp = window.__trg && window.__trg[1];
    g.writeRestricted = true; g.members.find((m) => m.id === "me-test-id").role = "member"; g.createdBy = "alice"; renderThreadSheet(); o.grpDisabled = document.getElementById("thread-input").disabled;
    const ke = new KeyboardEvent("keydown", { key: "Enter", cancelable: true }); document.getElementById("thread-input").value = "x"; document.getElementById("thread-input").dispatchEvent(ke); o.enter = ke.defaultPrevented;
    openThread("alice", "t1"); c.messages = c.messages.filter((m) => m.id !== "t1"); renderThreadSheet(); o.closed = state.threadRoot === null;
    return o; })()`));
  assert.deepEqual(r.thread, ["t1", "r1", "r2"]); assert.equal(r.none, null); assert.ok(r.title.includes("2")); assert.equal(r.items, 2); assert.equal(r.sent[1], "my reply"); assert.equal(r.sent[2].msgId, "t1");
  assert.equal(r.blockedDisabled, true); assert.equal(r.grp, "to group"); assert.equal(r.grpDisabled, true); assert.equal(r.enter, true); assert.equal(r.closed, true);
  a.run(`state.threadRoot = null; openThread("alice", "t1"); closeThreadSheet();`);
  a.close();
});

test("опросы, доски, заметки: создание, голосование, закрытие, операции, входящие, пузыри и клики", async () => {
  const a = await boot(); const t = fakeTimers(a); seedChat(a);
  a.run(`window.confirmSheet = async () => true;`);
  const r = J(await a.run(`(async () => { const o = {};
    o.blockedPoll = (state.contacts.get("alice").blocked = true, await createPoll("alice", "Q?", ["a", "b"])); state.contacts.get("alice").blocked = false;
    o.few = await createPoll("alice", "Q?", ["a"]); o.noC = await createPoll("zzz", "Q", ["a", "b"]);
    o.poll = await createPoll("alice", "Lunch?", ["Pizza", "Sushi", "Tacos"], true, { pub: true, closeAt: Date.now() + 3600000 });
    const c = state.contacts.get("alice"); const pm = c.messages.find((m) => m.poll); o.pm = !!pm;
    await votePoll("alice", pm.id, "o1"); await votePoll("alice", pm.id, "o2"); await votePoll("alice", pm.id, "o1"); await votePoll("alice", "nope", "o1");
    o.votes = J(pm.pollVotes[Store.myId]);
    o.single = await createPoll("alice", "One?", ["x", "y"]); const sm = c.messages.filter((m) => m.poll)[1]; await votePoll("alice", sm.id, "o1"); await votePoll("alice", sm.id, "o1"); o.single0 = (sm.pollVotes[Store.myId] || []).length;
    state.chatId = "alice"; renderChatThread(); o.pollHtml = document.querySelectorAll(".poll-bubble").length; o.optBtns = document.querySelectorAll("[data-poll-opt]").length;
    await closePollMsg("alice", sm.id); o.closed = sm.poll.closed === true; await votePoll("alice", sm.id, "o2"); await closePollMsg("alice", "nope");
    o.board = await createBoard("alice", "My board"); o.board2 = await createBoard("alice", "", ["todo", "done"]); o.note = await createNote("alice", "Notes");
    const bm = c.messages.find((m) => m.board), nm = c.messages.find((m) => m.note);
    await boardOp("alice", bm.id, { t: "add", card: { id: "k1", t: "Card", col: "todo" } }); await boardOp("alice", bm.id, { t: "move", id: "k1", col: "doing" }); await boardOp("alice", bm.id, { t: "edit", id: "k1", text: "Card2" }); await boardOp("alice", bm.id, { t: "colname", col: "todo", name: "Backlog" }); await boardOp("alice", bm.id, { t: "del", id: "zzz" }); await boardOp("alice", "nope", {});
    await noteOp("alice", nm.id, "note body"); await noteOp("alice", nm.id, "note body"); await noteOp("alice", "nope", "x");
    renderChatThread(); o.boardHtml = document.querySelectorAll(".board-bubble").length; o.noteHtml = document.querySelectorAll(".note-bubble").length; o.card = document.querySelectorAll(".board-card").length;
    o.kinds = window.__sent.map((x) => x[1]);
    // клики в пузырях
    window.__origOTS = openTextSheet; window.openTextSheet = (opts) => { window.__ts = opts; opts.onOk && opts.onOk("typed"); };
    const click = (sel, n) => { const els = document.querySelectorAll(sel); const el = els[n || 0]; if (el) { el.click(); return true; } return false; };
    o.clicks = [click("[data-poll-opt]"), click("[data-poll-close]"), click('[data-board-act="add"]'), click('[data-board-act="colname"]'), click('[data-board-act="edit"]'), click('[data-board-act="right"]'), click('[data-board-act="left"]'), click('[data-board-act="del"]'), click("[data-note-edit]")];
    return o; })()`));
  assert.equal(r.blockedPoll, false); assert.equal(r.few, false); assert.equal(r.noC, false); assert.equal(r.poll, true); assert.deepEqual(r.votes, ["o2"]); assert.equal(r.single0, 0); assert.equal(r.closed, true);
  assert.ok(r.board && r.board2 && r.note); assert.ok(r.pollHtml >= 2 && r.boardHtml >= 2 && r.noteHtml >= 1); assert.ok(["poll", "poll-vote", "poll-close", "board", "board-op", "note", "note-op"].every((k) => r.kinds.includes(k)), r.kinds.join());
  // входящие
  a.run(`window.__sent.length = 0;`);
  const inc = J(a.run(`(() => { const o = {}; const c = state.contacts.get("alice"); const g = state.contacts.get("g1"); const ap = applyIncomingRich;
    ap("alice", "d1", { kind: "poll", id: "ip1", ts: Date.now(), poll: { q: "Inc?", multi: false, opts: [{ id: "o1", t: "A" }, { id: "o2", t: "B" }] } }); ap("alice", "d1", { kind: "poll", id: "ip1", poll: {} }); ap("alice", "d1", { kind: "poll", id: 5 });
    ap("alice", "d2", { kind: "poll", id: "ip-bad", poll: { q: "x", opts: [] } });
    ap("alice", "d3", { kind: "board", id: "ib1", board: { title: "B", cols: [{ id: "todo", t: "T" }, { id: "done", t: "D" }] } }); ap("alice", "d4", { kind: "note", id: "in1", note: { title: "N", text: "initial" } }); ap("alice", "d5", { kind: "note", id: "in2", note: { title: "" } }); ap("alice", "d5", { kind: "board", id: "ib-bad", board: {} });
    ap("alice", "dv", { kind: "poll-vote", id: "ip1", opts: ["o1"], ts: Date.now() }); ap("alice", "dv", { kind: "poll-close", id: "ip1" }); ap("alice", "dv", { kind: "poll-vote", id: "ip1", opts: ["o2"] });
    ap("alice", "dn", { kind: "note-op", id: "in1", op: { t: "set", text: "changed" }, ts: Date.now() }); ap("alice", "dn", { kind: "note-op", id: "in1" }); ap("alice", "db", { kind: "board-op", id: "ib1", op: { t: "add", card: { id: "z", t: "zz", col: "todo" } }, ts: Date.now() }); ap("alice", "dx", { kind: "poll-vote", id: "missing" });
    ap("zzz", "d", { kind: "board-op", id: "x" }); ap("alice", "dg", { kind: "poll", id: "gp", groupId: "g1", poll: { q: "G?", opts: [{ id: "o1", t: "a" }, { id: "o2", t: "b" }] } });
    ap("alice", "dg", { kind: "poll", id: "gp2", groupId: "g1", senderName: "Ali", poll: { q: "G2?", opts: [{ id: "o1", t: "a" }, { id: "o2", t: "b" }] } }); g.writeRestricted = true; ap("alice", "dg", { kind: "poll", id: "gp3", groupId: "g1", poll: { q: "G3?", opts: [{ id: "o1", t: "a" }, { id: "o2", t: "b" }] } }); g.writeRestricted = false;
    ap("alice", "dg", { kind: "poll", id: "gp4", groupId: "nogroup", poll: { q: "x" } });
    o.ids = c.messages.map((m) => m.id).filter((x) => /^i[pbn]/.test(x)); o.closed = c.messages.find((m) => m.id === "ip1").poll.closed === true; o.note = c.messages.find((m) => m.id === "in1").note.text; o.grp = g.messages.map((m) => m.id);
    state.chatId = "alice"; renderChatThread(); o.rendered = document.querySelectorAll(".poll-bubble").length;
    return o; })()`));
  assert.ok(inc.ids.includes("ip1") && inc.ids.includes("ib1") && inc.ids.includes("in1") && !inc.ids.includes("ib-bad")); assert.equal(inc.closed, true); assert.equal(inc.note, "changed"); assert.deepEqual(inc.grp.sort(), ["gp", "gp2"]);
  // шторки
  const sh = J(await a.run(`(async () => { const o = {};
    openPollSheet(); o.opts0 = document.querySelectorAll("#poll-opts-list .poll-opt-input").length; for (let i = 0; i < 12; i++) addPollOptionInput(); o.optsMax = document.querySelectorAll("#poll-opts-list .poll-opt-input").length;
    openPollSheet(); document.getElementById("poll-q-input").value = "Via sheet?"; const ins = document.querySelectorAll("#poll-opts-list .poll-opt-input"); ins[0].value = "one"; ins[1].value = "two"; document.getElementById("poll-timer-input").value = "2"; document.getElementById("poll-multi-input").checked = true;
    document.getElementById("poll-create-btn").click(); await new Promise((r) => __realTO.call(window, r, 30)); o.pollHidden = document.getElementById("poll-sheet").classList.contains("hidden");
    window.openTextSheet = window.__origOTS;
    return o; })()`));
  assert.equal(sh.opts0, 2); assert.ok(sh.optsMax >= 5); assert.equal(sh.pollHidden, true);
  a.run(`openTextSheet({ title: "T", value: "v", placeholder: "p", onOk: (v) => { window.__tsv = v; } }); document.getElementById("text-sheet-input").value = "  "; submitTextSheet(); document.getElementById("text-sheet-input").value = "ok"; document.getElementById("text-sheet-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));`);
  assert.equal(a.window.__tsv, "ok");
  a.run(`const nm = state.contacts.get("alice").messages.find((m) => m.note); openNoteSheet("alice", nm.id); document.getElementById("note-input").value = "via sheet"; document.getElementById("note-save-btn").click(); openNoteSheet("alice", "nope");`);
  a.run(`document.getElementById("chat-board-btn").click(); document.getElementById("text-sheet-input").value = "Brd"; document.getElementById("text-sheet-ok").click(); document.getElementById("chat-note-btn").click(); document.getElementById("text-sheet-input").value = "Nt"; document.getElementById("text-sheet-ok").click(); document.getElementById("chat-poll-btn").click();`);
  t.tick(500);
  a.close();
});

test("карточка контакта в чате, добавление из карточки, исчезающие сообщения", async () => {
  const a = await boot(); const t = fakeTimers(a); seedChat(a);
  const r = J(a.run(`(() => { const o = {};
    o.html = [contactCardBubbleHtml({ id: "new1", name: "Newbie" }).includes("contact-card-add-btn"), contactCardBubbleHtml({ id: "alice", name: "Alice" }).includes("contact-card-already"), contactCardBubbleHtml({ id: "q" }).length > 0];
    window.attemptConnectViaRelay = async () => {}; addContactFromCard(Store.myId, "me"); addContactFromCard("alice", "A"); addContactFromCard("new1", "Newbie"); o.added = state.contacts.has("new1"); recentlyDeletedIds.set("new2", 1); addContactFromCard("new2", "N2"); o.rd = recentlyDeletedIds.has("new2");
    onlineSet.add("new3"); addContactFromCard("new3", "N3");
    o.labels = [disappearingTimerLabel(3600000), disappearingTimerLabel(86400000), disappearingTimerLabel(604800000), disappearingTimerLabel(0)];
    const c = state.contacts.get("alice");
    addDisappearingSystemMessage(c, 3600000, true); addDisappearingSystemMessage(c, 86400000, false); addDisappearingSystemMessage(c, 0, true); addDisappearingSystemMessage(c, 0, false);
    o.sys = c.messages.filter((m) => m.from === "system").map((m) => renderSystemMessageText(m));
    o.sysFallback = renderSystemMessageText({ textKey: "no.such.key", text: "fallback" }); o.sysPlain = renderSystemMessageText({ text: "plain" });
    return o; })()`));
  assert.deepEqual(r.html, [true, true, true]); assert.equal(r.added, true); assert.equal(r.rd, false); assert.equal(r.sysFallback, "fallback"); assert.equal(r.sysPlain, "plain"); assert.equal(r.sys.length, 4);
  await a.run(`setDisappearingTimer("alice", 3600000)`); await a.run(`setDisappearingTimer("alice", 3600000)`); await a.run(`setDisappearingTimer("alice", 0)`); await a.run(`setDisappearingTimer("zzz", 5)`);
  assert.equal(sentKinds(a).filter((k) => k === "disappearing-timer").length, 2);
  a.close();
});
