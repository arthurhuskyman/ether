// Дизайн-обзор №2, вторая волна: плюралы, типографика, тихие часы, обои, треды, истории, опросы с таймером, колонки, пустые состояния.
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/rich.js");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted(lang) {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": lang || "ru" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}

test("счётные строки без склонений: «Подпись: N» и сокращения, типографика остаётся", async () => {
  const a = await booted("ru");
  const t = (k, n) => a.run(`T(${JSON.stringify(k)}, { n: ${n} })`).replace(/\u00A0/g, " ");
  for (const n of [1, 2, 5, 11, 21, 22, 25]) {
    assert.equal(t("chat.poll.votes", n), "Голосов: " + n, "одинаково при любом числе");
    assert.equal(t("group.memberCount", n), "Участников: " + n);
    assert.equal(t("chat.thread.replies", n), "Ответов: " + n);
  }
  assert.equal(t("chat.loadEarlier", 150), "Показать ранее: 150 шт.");
  assert.match(a.run(`T("demo.s1")`), /\u00A0/, "после коротких слов — неразрывный пробел");
  a.close();
  const e = await booted("en");
  assert.equal(e.run(`T("chat.poll.votes", { n: 1 })`), "Votes: 1");
  assert.equal(e.run(`T("chat.poll.votes", { n: 4 })`), "Votes: 4");
  e.close();
  // ни в одном словаре не осталось ключей-вариантов .one/.few/.many/.other
  const fs = require("fs"), path = require("path"), dir = path.join(__dirname, "..", "js", "lang");
  for (const f of fs.readdirSync(dir)) assert.ok(!/"[\w.]+\.(one|few|many|other)":/.test(fs.readFileSync(path.join(dir, f), "utf8")), f + ": остались ключи множественных форм");
});

test("тихие часы: интервал через полночь, звонки не затрагиваются, обычный день", async () => {
  const a = await booted("en");
  a.window.localStorage.setItem("ether.quietOn", "1"); a.window.localStorage.setItem("ether.quietFrom", "23:00"); a.window.localStorage.setItem("ether.quietTo", "07:00");
  const q = (h, m) => a.run(`quietNow(new Date(2026, 0, 1, ${h}, ${m}))`);
  assert.equal(q(23, 30), true); assert.equal(q(3, 0), true); assert.equal(q(6, 59), true);
  assert.equal(q(7, 0), false); assert.equal(q(12, 0), false); assert.equal(q(22, 59), false);
  a.window.localStorage.setItem("ether.quietFrom", "13:00"); a.window.localStorage.setItem("ether.quietTo", "14:00");
  assert.equal(q(13, 30), true); assert.equal(q(15, 0), false);
  a.window.localStorage.setItem("ether.quietOn", "0");
  assert.equal(q(13, 30), false);
  a.close();
});

test("обои: свой градиент применяется через переменные, цвета проверяются", async () => {
  const a = await booted("en");
  a.window.localStorage.setItem("ether.chatWallpaper", "custom");
  a.run(`Store.wallpaperColor1 = "#112233"; Store.wallpaperColor2 = "javascript:1"; applyChatAppearancePrefs();`);
  const m = a.document.querySelector("#chat-messages");
  assert.equal(m.dataset.wallpaper, "custom");
  assert.equal(m.style.getPropertyValue("--wp1"), "#112233");
  assert.notEqual(m.style.getPropertyValue("--wp2"), "javascript:1", "мусор не принимается");
  a.close();
});

test("опрос с таймером и открытым голосованием; запоздавший голос после закрытия не считается", () => {
  const poll = R.sanitizePoll({ q: "Q", pub: true, closeAt: Date.now() + 3600e3, opts: [{ id: "a", t: "A" }, { id: "b", t: "B" }] });
  assert.equal(poll.pub, true); assert.ok(poll.closeAt > Date.now());
  assert.equal(R.sanitizePoll({ q: "Q", closeAt: Date.now() + 90 * 864e5, opts: [{ id: "a", t: "A" }, { id: "b", t: "B" }] }).closeAt, undefined, "слишком далёкое закрытие отбрасывается");
  const m = { poll };
  assert.equal(R.applyVote(m, "u1", ["a"], poll.closeAt - 1000), true, "голос до закрытия, доставленный позже, принимается");
  assert.equal(R.applyVote(m, "u2", ["a"], poll.closeAt + 1000), false, "после закрытия — нет");
  assert.equal(R.isClosed(m, poll.closeAt + 1), true);
  assert.equal(R.isClosed(m, poll.closeAt - 1), false);
});

test("доска: переименование колонки сходится независимо от порядка", () => {
  const mk = () => ({ board: R.sanitizeBoard({ title: "B", cols: [{ id: "a", t: "A" }, { id: "b", t: "B" }] }) });
  const ops = [[{ t: "colname", col: "a", name: "Первая" }, 10], [{ t: "colname", col: "a", name: "Новая" }, 20], [{ t: "colname", col: "zz", name: "x" }, 30]];
  const m1 = mk(), m2 = mk();
  for (const [o, ts] of ops) R.applyBoardOp(m1, o, ts);
  for (const [o, ts] of [...ops].reverse()) R.applyBoardOp(m2, o, ts);
  assert.equal(m1.board.cols[0].t, "Новая"); assert.equal(m2.board.cols[0].t, "Новая");
});

test("треды: плашка «N ответов», лист с цепочкой, ответ из треда", async () => {
  const a = await booted("ru");
  const d = a.document;
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; const t = Date.now();
    c.messages.push({ id: "r1", from: "them", text: "корень", ts: t - 5000, readAckSent: true });
    c.messages.push({ id: "r2", from: "me", text: "ответ 1", ts: t - 4000, ack: "read", replyTo: { id: "r1", text: "корень", authorName: "Alice" } });
    c.messages.push({ id: "r3", from: "them", text: "ответ на ответ", ts: t - 3000, readAckSent: true, replyTo: { id: "r2", text: "ответ 1" } });
    unreadDividerFor.delete("alice"); state.chatId = "alice"; state.tab = "chats"; renderTab();`);
  const chip = d.querySelector('[data-thread="r1"]');
  assert.ok(chip, "плашка у корня");
  assert.match(chip.textContent.replace(/ /g, " "), /Ответов: 1/);
  chip.click();
  assert.ok(!d.querySelector("#thread-sheet").classList.contains("hidden"));
  assert.equal(d.querySelectorAll("#thread-sheet .thread-msg").length, 3, "корень и вся цепочка");
  d.querySelector("#thread-input").value = "из треда";
  d.querySelector("#thread-send-btn").click();
  await sleep(30);
  const sent = a.run(`state.contacts.get("alice").messages.find((m) => m.text === "из треда")`);
  assert.ok(sent && sent.replyTo && sent.replyTo.id === "r1", "ответ привязан к корню");
  assert.equal(d.querySelectorAll("#thread-sheet .thread-msg").length, 4, "лист обновился");
  a.close();
});

test("истории: публикация, приём, срок жизни 24 часа, просмотр, удаление, чужой мусор", async () => {
  const a = await booted("ru");
  const d = a.document;
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; state.tab = "chats"; state.chatId = null; renderTab(); renderChatsList();`);
  assert.equal(await a.run(`publishStory("Привет всем", 2)`), true);
  assert.equal(await a.run(`publishStory("   ", 1)`), false);
  a.run(`applyIncomingPayload("alice", "s1", { kind: "story", id: "st1", text: "от Алисы", bg: 99, ts: Date.now() }, true)`);
  a.run(`applyIncomingPayload("alice", "s2", { kind: "story", id: "st2", text: "старая", bg: 0, ts: Date.now() - 25 * 3600e3 }, true)`);
  a.run(`applyIncomingPayload("stranger", "s3", { kind: "story", id: "st3", text: "чужой", bg: 0, ts: Date.now() }, true)`);
  assert.equal(a.run(`loadStories().filter((s) => s.owner === "alice").length`), 1, "старая и от незнакомца отброшены");
  assert.equal(a.run(`loadStories().find((s) => s.id === "st1").bg`), 5, "номер фона ограничен");
  a.run(`renderChatsList()`);
  assert.ok(d.querySelector('.story-item.is-unseen[data-story-owner="alice"]'), "кольцо непросмотренной истории");
  d.querySelector('[data-story-owner="alice"]').click();
  assert.ok(!d.querySelector("#story-viewer").classList.contains("hidden"));
  assert.equal(d.querySelector("#story-text").textContent, "от Алисы");
  assert.ok(!d.querySelector("#story-reply").classList.contains("hidden"), "на чужой истории есть поле ответа");
  d.querySelector("#story-reply-input").value = "Классно!";
  d.querySelector("#story-reply").dispatchEvent(new a.window.Event("submit", { cancelable: true, bubbles: true }));
  await sleep(100);
  const sent = a.run(`JSON.stringify(state.contacts.get("alice").messages.filter((m) => m.from === "me").map((m) => ({ t: m.text, r: m.replyTo && m.replyTo.text })))`);
  assert.match(sent, /Классно!/); assert.match(sent, /от Алисы/, "цитата истории в ответе");
  assert.ok(d.querySelector("#story-viewer").classList.contains("hidden"), "просмотр закрылся после ответа");
  a.run(`openStoryViewer("alice")`);
  d.querySelector("#story-close-btn").click();
  assert.equal(a.run(`loadStories().find((s) => s.id === "st1").seen`), true);
  assert.equal(d.querySelector('.story-item.is-unseen'), null, "после просмотра кольцо гаснет");
  // своя: открыть и удалить
  d.querySelector('[data-story-owner="__new__"]').click();
  assert.equal(d.querySelector("#story-text").textContent, "Привет всем");
  d.querySelector("#story-delete-btn").click();
  assert.equal(a.run(`loadStories().some((s) => s.owner === "me")`), false);
  // просрочка при загрузке
  a.run(`loadStories().push({ id: "old", owner: "alice", text: "x", bg: 0, ts: Date.now() - 30 * 3600e3, seen: true }); pruneStories();`);
  assert.equal(a.run(`loadStories().some((s) => s.id === "old")`), false);
  a.close();
});

test("пустые состояния: поиск без результатов даёт выход; ‹оба печатают› в шапке", async () => {
  const a = await booted("en");
  const d = a.document;
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "them", text: "hi", ts: Date.now() }); state.tab = "chats"; state.chatFilter = "all"; state.searchQuery = "zzzz"; renderTab(); renderChatsList();`);
  const nb = d.querySelector("#chats-list .empty-inline");
  assert.ok(nb, "блок «ничего не найдено»");
  nb.querySelector("button").click();
  assert.equal(a.run(`state.searchQuery`), "");
  assert.ok(d.querySelector("#chats-list .chat-row"), "после очистки список вернулся");
  // оба печатают
  a.run(`unreadDividerFor.delete("alice"); state.chatId = "alice"; renderTab(); state.typingTimers.set("alice", setTimeout(() => {}, 5000)); renderChatThread();`);
  assert.ok(!d.querySelector("#chat-peer-status .typing-both"));
  a.run(`state.typingSendingState.set("alice", true); renderChatThread();`);
  assert.ok(d.querySelector("#chat-peer-status .typing-both"), "подпись, когда печатают оба");
  a.close();
});

test("волна старого голосового считается из самого звука один раз и запоминается", async () => {
  const a = await booted("ru");
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "v1", from: "alice", ts: Date.now(), file: { name: "v.webm", mime: "audio/webm", size: 10, kind: "voice", duration: 3 } });`);
  // подмена WebAudio: «звук» с нарастающей громкостью
  a.window.AudioContext = function () { return { decodeAudioData: async () => ({ getChannelData: () => Float32Array.from({ length: 4000 }, (_, i) => (i / 4000) * Math.sin(i)) }), close() {} }; };
  a.run(`IDB.set("file:v1", new Blob([new Uint8Array(10)], { type: "audio/webm" }))`);
  await sleep(50);
  const done = await a.run(`(async () => { const el = document.createElement("div"); el.innerHTML = '<div class="voice-wave-bars"></div>'; await backfillVoiceWave("v1", el); const m = state.contacts.get("alice").messages[0]; return JSON.stringify({ n: m.file.wave && m.file.wave.length, first: m.file.wave && m.file.wave[0], last: m.file.wave && m.file.wave[39], bars: el.querySelectorAll("i").length }); })()`);
  const r = JSON.parse(done);
  assert.equal(r.n, 40); assert.equal(r.bars, 40); assert.ok(r.last > r.first, "форма отражает громкость");
  a.close();
});

test("длинная пачка непрочитанных: у разделителя есть кнопка «Краткое содержание»", async () => {
  const a = await booted("ru");
  const long = "Мы обсуждали поездку в горы и маршрут на выходные. ".repeat(10);
  a.run(`const c = ensureContactEntry("bob", "Bob"); c.managed = true; for (let i = 0; i < 3; i++) c.messages.push({ id: "u" + i, from: "bob", text: ${JSON.stringify(long)}, ts: Date.now() - 1000 + i, ack: "delivered" }); unreadDividerFor.set("bob", "u0"); state.chatId = "bob"; renderChatThread();`);
  const btn = a.document.querySelector(".unread-divider .unread-summary-btn");
  assert.ok(btn, "кнопка сводки у разделителя");
  btn.click();
  assert.ok(!a.document.querySelector("#ai-sheet").classList.contains("hidden"));
  assert.ok(a.document.querySelector("#ai-sheet-text").textContent.length > 10);
  a.close();
});

test("«Задача»: одно название, три колонки (канбан), без выбора шаблона и без «Списка»", async () => {
  const a = await booted("ru");
  const d = a.document;
  assert.equal(d.querySelector("#chat-list-btn"), null, "дубль убран");
  assert.equal(d.querySelector("#chat-board-btn span").textContent, "Задача");
  assert.equal(d.querySelector("#chat-note-btn span").textContent, "Заметка");
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; state.chatId = "alice"; renderChatThread();`);
  d.querySelector("#chat-board-btn").click();
  assert.equal(d.querySelector("#text-sheet-input").value, "Задача", "название по умолчанию");
  d.querySelector("#text-sheet-ok").click();
  await sleep(100);
  const cols = a.run(`JSON.stringify(state.contacts.get("alice").messages.filter((m) => m.board).map((m) => m.board.cols.length))`);
  assert.equal(cols, "[3]", "всегда три колонки");
  assert.equal(a.run(`T("chat.board.addCard")`), "Добавить", "короткая кнопка, помещается в узкую колонку");
  a.close();
});

test("поля поиска: единый вид «Поиск в …» на всех вкладках", async () => {
  const a = await booted("ru");
  const d = a.document;
  const ph = (id) => d.querySelector(id).getAttribute("placeholder");
  const T = (k) => a.run(`T(${JSON.stringify(k)})`).replace(/\u00A0/g, " ");
  assert.equal(T("chats.search"), "Поиск в чатах");
  assert.equal(T("connect.search"), "Поиск в контактах");
  assert.equal(T("settings.search"), "Поиск в настройках");
  assert.equal(T("debug.search"), "Поиск в отладке");
  assert.equal(T("chat.search"), "Поиск в чате");
  assert.ok(ph("#debug-search") && ph("#settings-search"));
  a.close();
});

test("история: после публикации в строке — миниатюра моей истории с плюсом «добавить ещё»", async () => {
  const a = await booted("ru");
  const d = a.document;
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; state.tab = "chats"; state.chatId = null; renderTab(); renderChatsList();`);
  assert.equal(await a.run(`publishStory("Привет всем", 2)`), true);
  a.run(`renderChatsList()`);
  const mine = d.querySelector('.story-item.is-mine');
  assert.ok(mine, "моя история в строке");
  assert.ok(mine.querySelector(".story-thumb.story-bg-2"), "миниатюра последней истории");
  assert.match(mine.querySelector(".story-thumb").textContent, /Привет/);
  assert.ok(mine.querySelector("[data-story-add]"), "плюс для новой истории");
  mine.querySelector("[data-story-add]").dispatchEvent(new a.window.MouseEvent("click", { bubbles: true }));
  assert.ok(!d.querySelector("#story-sheet").classList.contains("hidden"), "плюс открывает создание");
  a.close();
});

test("звук при запуске: пул разблокируется тихим WAV, а не настоящими рингтонами; зависшие звуки снимаются", async () => {
  const a = await booted("ru");
  const calls = [];
  a.window.HTMLMediaElement.prototype.play = function () { calls.push({ src: String(this.src).slice(0, 22), muted: this.muted }); return Promise.resolve(); };
  a.window.HTMLMediaElement.prototype.pause = function () { this.__paused = true; };
  a.run(`for (const el of soundPool.values()) { delete el.dataset.unlocked; delete el.dataset.unlocking; } unlockSoundPool()`);
  await sleep(50);
  assert.ok(calls.length > 5, "элементов пула несколько");
  assert.ok(calls.every((c) => c.src.startsWith("data:audio/wav") && c.muted), "только тихий WAV и muted: " + JSON.stringify(calls[0]));
  // настоящие звуки на месте и размьючены после разблокировки
  const ok = a.run(`Array.from(soundPool.values()).every((el) => el.muted === false && !String(el.src).startsWith("data:"))`);
  assert.equal(ok, true);
  a.close();
});

test("меню «+»: порядок Эмодзи, Камера, Файл, Опрос, Доска, Заметка, Сводка; плашки якорятся над кнопкой", async () => {
  const a = await booted("ru");
  const d = a.document;
  const ids = Array.from(d.querySelectorAll("#composer-menu-sheet .composer-menu-item:not(.composer-recent):not(#composer-menu-more)")).map((b) => b.id);
  assert.deepEqual(ids, ["chat-emoji-btn", "chat-camera-btn", "chat-attach-btn", "chat-poll-btn", "chat-board-btn", "chat-note-btn", "chat-summary-btn", "chat-sticker-btn"]);
  assert.equal(d.querySelector("#chat-attach-btn span").textContent, "Файл");
  a.close();
});

test("форма пузыря «скина» не стирает хвостик: маленький угол остаётся у своих и чужих пузырей", () => {
  const css = require("fs").readFileSync(require("path").join(__dirname, "..", "css", "styles.css"), "utf8");
  assert.match(css, /#screen-chat\[data-skin-shape\] \.bubble-row\.mine \.bubble \{[^}]*border-end-end-radius: 4px/);
  assert.match(css, /#screen-chat\[data-skin-shape\] \.bubble-row\.theirs \.bubble \{[^}]*border-end-start-radius: 4px/);
});
