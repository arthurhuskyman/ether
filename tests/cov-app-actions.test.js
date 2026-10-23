// Покрытие app.js: меню сообщения, действия над сообщениями, перевод, избранное, мультивыбор, повтор отправки, пересылка-лист, эмодзи/упоминания, ручное приглашение.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    const al = ensureContactEntry("alice", "Alice"); al.managed = true; al.publicKey = { kty: "EC" };
    const now = Date.now();
    al.messages.push({ id: "t1", from: "them", text: "hello world there", ts: now - 9000, readAckSent: true }, { id: "t2", from: "me", text: "my own message " + "x".repeat(220), ts: now - 8000, ack: "sent" },
      { id: "t3", from: "me", text: "", ts: now - 7000, ack: "failed", file: { name: "a.png", mime: "image/png", size: 5, kind: "image" } }, { id: "t4", from: "me", text: "", ts: now - 6000, ack: "failed", contactCard: { id: "carol", name: "Carol" } },
      { id: "t5", from: "me", text: "failed text", ts: now - 5000, ack: "failed", replyTo: { id: "t1", text: "hello", authorName: "A" }, ttl: 60000, forwarded: true, forwardedFrom: "Z" });
    state.contacts.set("g1", { id: "g1", name: "Team", isGroup: true, managed: true, createdBy: "me", members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice" }, { id: "bob", name: "Bobby" }], messages: [{ id: "gf", from: "me", text: "grp failed", ts: now, ack: "failed" }], lastActivity: now });
    window.__sent = []; window.trySendOrQueue = async (c, id, p) => { window.__sent.push([c.id, p.kind, p]); };
    state._firstRenderDone = true; persistContacts(); state.tab = "chats"; state.chatId = "alice"; renderTab(); })()`);
}

test("меню сообщения: набор действий для разных сообщений и вызов каждого действия", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.confirmSheet = async () => true; window.copyText = (t2, m) => { window.__copy = t2; }; window.translateMessage = (c, m) => { window.__tr = m; }; window.openSummarySheet = (s) => { window.__sum = s.length; }; window.openForwardSheet = (cb) => { window.__fwdCb = cb; }; window.forwardMessage = (m, f, to) => { window.__fwd = [m, f, to]; };`);
  const actionsOf = (msg, cid = "alice") => { a.run(`openMessageSheet(${JSON.stringify(msg)}, ${JSON.stringify(cid)})`); return [...a.document.querySelectorAll("#message-sheet-body .sheet-action")].map((b) => b.dataset.action); };
  const own = actionsOf("t2"); assert.ok(["reply", "forward", "copy", "pin", "translate", "favorite", "thread", "summary", "select", "edit", "delete-local", "delete-both"].every((x) => own.includes(x)), own.join());
  const theirs = actionsOf("t1"); assert.ok(!theirs.includes("edit") && !theirs.includes("delete-both"));
  const file = actionsOf("t3"); assert.ok(!file.includes("translate") && !file.includes("edit"));
  a.run(`openMessageSheet("nope", "alice"); openMessageSheet("t1", "nope");`);
  const click = async (msg, act, cid = "alice") => { a.run(`openMessageSheet(${JSON.stringify(msg)}, ${JSON.stringify(cid)})`); a.document.querySelector(`#message-sheet-body [data-action="${act}"]`).click(); await sleep(15); };
  await click("t1", "copy"); assert.equal(a.window.__copy, "hello world there"); await click("t1", "thread"); await click("t2", "summary"); assert.ok(a.window.__sum >= 200);
  await click("t2", "edit"); assert.equal(a.run(`state.editingMessageId`), "t2"); a.run(`cancelEditing();`);
  await click("t1", "reply"); assert.equal(a.run(`state.replyTo.msgId`), "t1"); a.run(`cancelReply();`);
  await click("t1", "forward"); await a.window.__fwdCb("g1"); assert.deepEqual(J(a.window.__fwd), ["t1", "alice", "g1"]);
  await click("t1", "pin"); assert.equal(a.run(`state.contacts.get("alice").pinnedMessageId`), "t1"); await click("t1", "pin"); assert.equal(a.run(`state.contacts.get("alice").pinnedMessageId`), null);
  await click("t1", "select"); assert.ok(a.run(`state.multiSelect.has("t1")`)); a.run(`exitMultiSelect();`);
  await click("t1", "favorite"); assert.equal(a.run(`state.contacts.get("alice").messages[0].favorite`), true); await click("t1", "favorite");
  await click("t1", "translate"); assert.equal(a.window.__tr, "t1");
  await click("t1", "delete-local"); assert.ok(!a.run(`state.contacts.get("alice").messages.some((m) => m.id === "t1")`));
  await click("t2", "delete-both"); assert.ok(sentKinds(a).includes("delete"));
  a.run(`window.confirmSheet = async () => false;`); a.run(`state.contacts.get("alice").messages.push({ id: "t6", from: "me", text: "z", ts: 1, ack: "sent" });`); await click("t6", "delete-both"); assert.ok(a.run(`state.contacts.get("alice").messages.some((m) => m.id === "t6")`));
  await a.run(`handleMessageAction("retry", "t5", "alice")`); await a.run(`handleMessageAction("bogus", "t5", "alice")`); await a.run(`handleMessageAction("copy", "zz", "alice")`); await a.run(`handleMessageAction("copy", "t5", "zz")`);
  a.run(`document.getElementById("message-sheet").classList.add("hidden");`);
  a.close();
});
const sentKinds = (a) => J(a.window.__sent).map((x) => x[1]);

test("перевод сообщений: успех, повторный тап скрывает, ошибки, без сервера, дубль в полёте", async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); if (url.includes("bad")) return { ok: false, status: 500 }; if (url.includes("empty")) return { ok: true, json: async () => ({}) }; return { ok: true, json: async () => ({ translatedText: "Привет мир" }) }; };
  const a = await boot({ fetch }); const t = fakeTimers(a); seed(a); a.window.AbortSignal.timeout = () => undefined;
  const r = J(await a.run(`(async () => { const o = {}; const m = () => state.contacts.get("alice").messages.find((x) => x.id === "t1");
    Store.translateEndpoint = "https://tr.example/translate"; Store.translateApiKey = "KEY"; await translateMessage("alice", "t1"); o.t1 = m().translation && m().translation.text; await translateMessage("alice", "t1"); o.hidden = !m().translation;
    Store.translateEndpoint = "https://tr.example/bad"; await translateMessage("alice", "t1"); o.bad = !m().translation; Store.translateEndpoint = "https://tr.example/empty"; await translateMessage("alice", "t1"); o.empty = !m().translation;
    localStorage.removeItem("ether.translateEndpoint"); const def = Store.translateEndpoint; Store.translateEndpoint = ""; o.defEndpoint = Store.translateEndpoint === def || typeof def; await translateMessage("alice", "t1");
    Store.translateEndpoint = "https://tr.example/translate"; const p1 = translateMessage("alice", "t1"); const p2 = translateMessage("alice", "t1"); await Promise.all([p1, p2]);
    await translateMessage("nope", "t1"); await translateMessage("alice", "nope"); await translateMessage("alice", "t3"); return o; })()`));
  assert.equal(r.t1, "Привет мир"); assert.equal(r.hidden, true); assert.equal(r.bad, true); assert.equal(r.empty, true); assert.equal(calls[0][1].api_key, "KEY"); assert.equal(calls[0][1].target, "en");
  a.close();
});

test("избранное, мультивыбор, закрепление, переход к сообщению, повтор неотправленных, лист пересылки, исходящие", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.requestAnimationFrame = (f) => f(); state.contacts.get("alice").messages[0].favorite = true; state.contacts.get("alice").messages[1].favorite = true; state.contacts.get("alice").messages[2].favorite = true;`);
  a.run(`openFavoritesSheet(); updateFavoritesCount();`); assert.equal(a.document.querySelectorAll("#favorites-list .forward-row").length, 3); assert.equal(a.document.querySelector("#settings-favorites-count").textContent, "3");
  a.document.querySelector("#favorites-list .forward-row").click(); assert.equal(a.run(`state.chatId`), "alice"); t.tick(2000);
  a.run(`for (const c of state.contacts.values()) for (const m of c.messages) m.favorite = false; openFavoritesSheet(); updateFavoritesCount();`); assert.ok(a.document.querySelector("#favorites-list .muted"));
  // мультивыбор
  a.run(`enterMultiSelect("t1"); toggleMultiSelectMsg("t2"); toggleMultiSelectMsg("t2"); updateMultiSelectBanner();`); assert.equal(a.document.querySelector("#multiselect-count").textContent, "1");
  a.run(`toggleMultiSelectMsg("t1");`); assert.equal(a.run(`state.multiSelect`), null); a.run(`toggleMultiSelectMsg("t1"); updateMultiSelectBanner();`);
  // повтор
  a.run(`mesh.links.delete("alice");`); a.run(`IDB.set("file:t3", new Blob(["img"], { type: "image/png" }));`); await sleep(20);
  await a.run(`retryMessage("alice", "t3")`); await a.run(`retryMessage("alice", "t4")`); await a.run(`retryMessage("alice", "t5")`); await a.run(`retryMessage("alice", "nope")`); await a.run(`retryMessage("nope", "x")`);
  const kinds = sentKinds(a); assert.ok(["file", "contact-card", "chat"].every((k) => kinds.includes(k)), kinds.join());
  await a.run(`IDB.del("file:t3")`); a.run(`state.contacts.get("alice").messages.find((m) => m.id === "t3").ack = "failed";`); await a.run(`retryMessage("alice", "t3")`); assert.equal(a.run(`state.contacts.get("alice").messages.find((m) => m.id === "t3").ack`), "failed");
  a.window.__sent.length = 0; await a.run(`retryMessage("g1", "gf")`); assert.ok(J(a.window.__sent).some((x) => x[0] === "alice" && x[2].groupId === "g1"));
  a.run(`const al = state.contacts.get("alice"); al.messages.forEach((m) => { if (m.from === "me") m.ack = "failed"; });`); await a.run(`retryAllFailed("alice")`); await a.run(`retryAllFailed("nope")`);
  // баннеры правки/ответа и лист пересылки
  a.run(`startEditing("nope"); startEditing("t1"); state.chatId = "alice"; startEditing("t5"); cancelEditing(); state.replyTo = null; showReplyBanner(); state.replyTo = { msgId: "t1", text: "q", authorName: "A" }; showReplyBanner(); cancelReply();`); assert.equal(a.run(`state.editingMessageId`), null);
  a.run(`state.contacts.get("g1").writeRestricted = true; state.contacts.get("g1").createdBy = "alice"; state.contacts.get("g1").members[0].role = "member"; let picked = null; openForwardSheet((id) => { window.__picked = id; }); `); const rows = a.document.querySelectorAll("#forward-list .forward-row"); assert.ok(rows.length >= 1); rows[0].click(); await sleep(10); assert.ok(a.window.__picked);
  a.run(`openForwardSheet(() => {}, "shareTarget.pickChat");`); assert.equal(a.document.querySelector("#forward-sheet h2").getAttribute("data-i18n"), "shareTarget.pickChat"); a.run(`openForwardSheet(() => {});`);
  // исходящие
  a.run(`addToOutbox("ob1", "alice", { kind: "chat" }); pendingNoKey.set("bob", [{ msgId: "x", payload: {} }]); pendingNoKey.set("empty", []); openOutboxSheet();`); assert.ok(a.document.querySelectorAll("#outbox-list .outbox-row").length >= 2);
  a.run(`outbox.clear(); pendingNoKey.clear(); renderOutboxSheet();`); assert.ok(!a.document.querySelector("#outbox-empty").classList.contains("hidden"));
  // прыжок к дате
  a.run(`openJumpToDateSheet(""); openJumpToDateSheet("alice");`); assert.equal(a.document.querySelector("#jump-date-sheet").dataset.contactId, "alice");
  a.close();
});

test("эмодзи: панель, вкладки, поиск, тон кожи, рукопожатие, недавние; @упоминания; быстрые реакции", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.requestAnimationFrame = (f) => f(); state.chatId = "g1"; renderTab(); installPtrShim = 1;`);
  const r = J(a.run(`(() => { const o = {};
    const input = document.getElementById("chat-input"); input.value = "hi @Bo"; input.setSelectionRange(6, 6);
    o.tok = currentMentionToken(input); updateMentionAutocomplete(); o.box = document.querySelectorAll("#mention-autocomplete .mention-autocomplete-item").length; wireMentionAutocomplete();
    document.querySelector("#mention-autocomplete .mention-autocomplete-item").click(); o.after = input.value;
    input.value = "no mention"; input.setSelectionRange(10, 10); updateMentionAutocomplete(); o.closed = document.getElementById("mention-autocomplete").classList.contains("hidden"); input.value = "@zzz"; input.setSelectionRange(4, 4); updateMentionAutocomplete(); input.value = "@a b"; input.setSelectionRange(4, 4); o.spaceTok = currentMentionToken(input);
    state.chatId = "alice"; updateMentionAutocomplete(); state.chatId = "g1"; applyMentionChoice("X"); closeMentionAutocomplete();
    // эмодзи
    input.value = "ab"; input.setSelectionRange(1, 1); insertEmojiAtCursor("😀"); o.ins = input.value;
    return o; })()`));
  assert.equal(r.tok.partial, "Bo"); assert.equal(r.box, 1); assert.ok(r.after.includes("@Bobby ")); assert.equal(r.closed, true); assert.equal(r.spaceTok, null); assert.ok(r.ins.includes("😀"));
  const e = J(a.run(`(() => { const o = {}; document.getElementById("chat-emoji-btn") && document.getElementById("chat-emoji-btn").click();
    o.sheet = !document.getElementById("emoji-picker-sheet").classList.contains("hidden"); renderEmojiTabs(); o.tabs = document.querySelectorAll("#emoji-tabs .emoji-tab-btn").length;
    for (const b of document.querySelectorAll("#emoji-tabs .emoji-tab-btn")) b.click(); o.grid = document.querySelectorAll("#emoji-grid .emoji-grid-btn").length;
    const s = document.getElementById("emoji-search-input"); s.value = "smile"; s.dispatchEvent(new Event("input")); o.search = document.querySelectorAll("#emoji-grid .emoji-grid-btn").length; s.value = "qqqqzzzz"; s.dispatchEvent(new Event("input")); o.none = !!document.querySelector("#emoji-grid .emoji-empty"); s.value = ""; s.dispatchEvent(new Event("input"));
    renderSkinToneRow(() => { window.__toneCb = 1; }); document.querySelectorAll("#emoji-skin-tone-row .skin-tone-swatch")[3].click(); o.tone = Store.emojiSkinTone; o.toneCb = window.__toneCb; updateEmojiToneButton();
    openHandshakeToneSheet(); document.querySelectorAll("#handshake-tone-row-a .skin-tone-swatch")[1].click(); document.querySelectorAll("#handshake-tone-row-b .skin-tone-swatch")[4].click(); wireHandshakeToneSheet(); wireHandshakeToneSheet(); document.getElementById("handshake-tone-insert").click();
    o.hs = document.getElementById("chat-input").value.includes("🤝");
    return o; })()`));
  assert.equal(e.sheet, true); assert.ok(e.tabs >= 8); assert.ok(e.grid > 0); assert.equal(e.none, true); assert.ok(e.toneCb === 1);
  // длинное нажатие на рукопожатие в сетке
  a.run(`{ const s = document.getElementById("emoji-search-input"); s.value = "handshake"; s.dispatchEvent(new Event("input")); const b = [...document.querySelectorAll("#emoji-grid .emoji-grid-btn")].find((x) => x.textContent.startsWith("🤝")); if (b) { const ev = (type, x, y) => { const e2 = new Event(type, { bubbles: true }); e2.clientX = x; e2.clientY = y; b.dispatchEvent(e2); }; ev("pointerdown", 1, 1); ev("pointermove", 50, 50); ev("pointerup", 1, 1); ev("pointerdown", 1, 1); window.__hb = b; } }`); t.tick(700);
  a.run(`{ const b = window.__hb; if (b) { b.click(); } }`);
  // быстрые реакции
  const q = J(a.run(`(() => { const o = {}; state.chatId = "alice"; renderTab(); const el = document.querySelector('#chat-messages .bubble[data-msg-id="t5"]');
    window.__react = []; window.toggleReaction = (...x) => { window.__react.push(x); }; window.openEmojiPicker = (opts) => { window.__ep = opts; }; window.handleMessageAction = (...x) => { window.__ha = x; };
    openQuickReactionFlyout(el, "t5", "alice"); o.btns = document.querySelectorAll("#quick-reaction-flyout .reaction-emoji").length; o.acts = document.querySelectorAll("#quick-reaction-flyout .qrf-act").length;
    document.querySelector("#quick-reaction-flyout .reaction-emoji").click(); o.reacted = window.__react.length;
    openQuickReactionFlyout(el, "t5", "alice"); document.querySelector("#quick-reaction-flyout .reaction-expand").click(); window.__ep.onPick("🔥"); o.picker = !!window.__ep;
    openQuickReactionFlyout(el, "t5", "alice"); const acts = document.querySelectorAll("#quick-reaction-flyout .qrf-act"); acts[0].click(); openQuickReactionFlyout(el, "t5", "alice"); document.querySelectorAll("#quick-reaction-flyout .qrf-act")[1].click(); openQuickReactionFlyout(el, "t5", "alice"); document.querySelectorAll("#quick-reaction-flyout .qrf-act")[2].click();
    openQuickReactionFlyout(el, "t5", "alice"); closeQuickReactionFlyout(); closeQuickReactionFlyout(); openQuickReactionFlyout(null, "x", "alice"); openQuickReactionFlyout(el, "nope", "alice"); openQuickReactionFlyout(el, "t5", "nope");
    openQuickReactionFlyout(el, "t5", "g1"); closeQuickReactionFlyout(); return o; })()`));
  assert.ok(q.btns >= 7); assert.ok(q.acts >= 2); assert.equal(q.reacted, 1);
  t.tick(10);
  a.run(`openQuickReactionFlyout(document.querySelector('#chat-messages .bubble[data-msg-id="t5"]'), "t5", "alice");`); t.tick(10); a.run(`document.dispatchEvent(new Event("pointerdown", { bubbles: true }));`);
  a.close();
});

test("ручное приглашение: создать, ответ, завершение, сброс, copyText, камера и подтверждение", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.window.CompressionStream = CompressionStream; a.window.DecompressionStream = DecompressionStream; a.window.Response = Response;
  a.run(`state.tab = "connect"; renderTab(); window.__copied = []; navigator.clipboard = { writeText: async (x) => { window.__copied.push(x); } };`);
  const fakeLink = `{ createInitialOffer: async () => ({ t: "offer", n: "Tester", d: { type: "offer", sdp: "v=0\\r\\n" }, r: "tag" }), acceptOfferAndCreateAnswer: async (p) => ({ t: "answer", n: "Me", d: { type: "answer", sdp: "v=0\\r\\n" }, r: "" }), acceptAnswer: async () => { window.__accepted = 1; }, close() {} }`;
  a.run(`mesh.createOutgoingLink = (id) => { const l = ${fakeLink}; mesh.links.set(id, l); return l; }; mesh.createIncomingLink = (id) => { const l = ${fakeLink}; mesh.links.set(id, l); return l; };`);
  await a.run(`createInvite()`); await sleep(50); assert.ok(a.document.querySelector("#invite-code-out").textContent.length > 10); assert.ok(a.run(`!!state.pendingOutgoing`)); const code = a.document.querySelector("#invite-code-out").textContent;
  a.document.querySelector("#copy-code-btn").click(); a.document.querySelector("#copy-link-btn").click(); await sleep(10); assert.equal(a.window.__copied[0], code);
  a.run(`navigator.share = async (o) => { window.__shared = o.url; };`); a.document.querySelector("#share-link-btn").click(); await sleep(10); assert.ok(a.window.__shared); a.run(`navigator.share = undefined;`); a.document.querySelector("#share-link-btn").click(); await sleep(10);
  // завершение приглашения чужим ответом
  const answerCode = await a.run(`SignalingCodec.encode({ t: "answer", n: "Bob", d: { type: "answer", sdp: "v=0\\r\\n" }, r: "" })`);
  a.document.querySelector("#answer-code-in").value = answerCode; a.document.querySelector("#complete-invite-btn").click(); await sleep(60); assert.equal(a.window.__accepted, 1);
  a.document.querySelector("#answer-code-in").value = "garbage"; a.document.querySelector("#complete-invite-btn").click(); await sleep(60);
  a.document.querySelector("#answer-code-in").value = await a.run(`SignalingCodec.encode({ t: "offer", n: "X", d: {}, r: "" })`); a.document.querySelector("#complete-invite-btn").click(); await sleep(60);
  a.run(`mesh.links.delete(state.pendingOutgoing.id);`); a.document.querySelector("#answer-code-in").value = answerCode; a.document.querySelector("#complete-invite-btn").click(); await sleep(60); assert.equal(a.run(`state.pendingOutgoing`), null);
  // входящий код
  const offerCode = await a.run(`SignalingCodec.encode({ t: "offer", n: "Offerer", d: { type: "offer", sdp: "v=0\\r\\n" }, r: "" })`);
  a.document.querySelector("#paste-code-in").value = offerCode; a.document.querySelector("#reply-btn").click(); await sleep(80);
  assert.ok(!a.document.querySelector("#incoming-banner").classList.contains("hidden")); assert.ok(a.document.querySelector("#answer-out-code").textContent.length > 10); a.document.querySelector("#answer-copy-btn").click();
  a.run(`Promise.resolve(handleIncomingCode("garbage")).catch(() => {}); `); await sleep(20); await a.run(`Promise.resolve(handleIncomingCode(${JSON.stringify(await a.run(`SignalingCodec.encode({ t: "answer", n: "X", d: {}, r: "" })`))})).catch(() => {})`); // D7: мусор и не-offer теперь бросают (вызывающие показывают toast)
  a.document.querySelector("#paste-code-in").value = ""; a.document.querySelector("#reply-btn").click(); a.document.querySelector("#paste-code-in").value = "garbage"; a.document.querySelector("#reply-btn").click(); await sleep(40);
  a.document.querySelector("#new-invite-again").click(); assert.ok(!a.document.querySelector("#invite-idle").classList.contains("hidden"));
  // createInvite: offer не создан
  a.run(`mesh.createOutgoingLink = (id) => { const l = { createInitialOffer: async () => null, close() {} }; mesh.links.set(id, l); return l; };`); await a.run(`createInvite()`);
  // copyText без clipboard и с ошибкой
  a.run(`navigator.clipboard = undefined; document.execCommand = () => true; copyText("x", "ok"); document.execCommand = () => false; copyText("x", "ok"); document.execCommand = () => { throw new Error("no"); }; copyText("x", "ok"); navigator.clipboard = { writeText: () => Promise.reject(new Error("no")) }; copyText("y", "ok"); navigator.clipboard = { writeText: () => { throw new Error("sync"); } }; copyText("y", "ok");`);
  // сброс с временным контактом
  a.run(`state.contacts.set("tmp1", { id: "tmp1", name: "…", managed: false, status: "awaiting-answer", messages: [] }); state.pendingOutgoing = { id: "tmp1" }; resetConnectScreen();`); assert.ok(!a.run(`state.contacts.has("tmp1")`));
  // камера в чате и шторки
  a.run(`state.chatId = "alice"; renderTab(); let clicked = 0; document.getElementById("chat-camera-input").click = () => { window.__cam = 1; }; document.getElementById("chat-camera-btn").click();`); assert.equal(a.window.__cam, 1);
  a.close();
});

test("шторки: ручка закрывает жестом, подтверждение, backdrop и Esc", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(await a.run(`(async () => { const o = {};
    const sheet = document.getElementById("mute-sheet"); sheet.classList.remove("hidden"); const handle = sheet.querySelector(".sheet-handle"); o.hasHandle = !!handle;
    if (handle) { const ev = (type, y) => { const e = new Event(type, { bubbles: true }); e.touches = [{ clientY: y }]; e.changedTouches = [{ clientY: y }]; handle.dispatchEvent(e); }; ev("touchstart", 10); ev("touchmove", 40); ev("touchend", 20); o.stillOpen = !sheet.classList.contains("hidden"); ev("touchstart", 10); ev("touchmove", 90); ev("touchend", 90); o.closed = sheet.classList.contains("hidden"); }
    sheet.classList.remove("hidden"); sheet.querySelector(".sheet-backdrop").click(); o.backdrop = sheet.classList.contains("hidden");
    // confirmSheet
    const p = confirmSheet("Sure?", { destructive: true }); document.getElementById("confirm-sheet-ok").click(); o.yes = await p;
    const p2 = confirmSheet("Sure?"); document.querySelector("#confirm-sheet .sheet-cancel, #confirm-sheet-cancel").click(); o.no = await p2;
    const p3 = confirmSheet("Sure?"); document.getElementById("confirm-sheet").classList.add("hidden"); o.hidden = await p3;
    return o; })()`));
  assert.equal(r.yes, true); assert.equal(r.no, false); assert.equal(r.hidden, false);
  if (r.hasHandle) { assert.equal(r.stillOpen, true); assert.equal(r.closed, true); }
  a.run(`document.getElementById("mute-sheet").classList.remove("hidden"); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));`);
  a.close();
});
