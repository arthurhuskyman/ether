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
  const rb = a.document.querySelector("#reaction-bar");
  assert.equal(rb.children.length, 7, "в шторке — ряд из 6 реакций и «+» (тот же обработчик, что в панели)");
  assert.ok(rb.querySelector(".reaction-expand").getAttribute("aria-label"));
  rb.children[1].click();
  assert.ok(a.document.querySelector("#message-sheet").classList.contains("hidden"), "реакция закрывает шторку");
  assert.ok(JSON.stringify(a.run(`state.contacts.get("alice").messages[0].reactions || null`)).length > 4, "реакция применена");
  a.run(`openMessageSheet("m1", "alice")`);
  const labels = Array.from(a.document.querySelectorAll("#message-sheet-body .sheet-action")).map((b) => b.dataset.action);
  assert.deepEqual(labels.slice(0, 4), ["reply", "forward", "copy", "pin"], "основные действия сверху");
  assert.ok(a.document.querySelector("#message-sheet-body .sheet-divider"));
  assert.ok(!labels.includes("retry"), "«Повторить» убрано из меню");
  // своё сообщение: удаление у меня / у всех
  a.run(`openMessageSheet("m2", "alice")`);
  const del = Array.from(a.document.querySelectorAll("#message-sheet-body .destructive")).map((b) => b.textContent);
  assert.deepEqual(del, ["Delete for me only", "Delete for everyone"]);
  // группа: реакций нет ни в панели, ни в шторке
  a.run(`state.contacts.set("g0", { id: "g0", name: "G0", managed: true, isGroup: true, createdBy: "me-test-id", members: [{ id: "me-test-id", name: "T", role: "admin" }], messages: [{ id: "gz", from: "them", fromId: "x", text: "yo", ts: Date.now() }], lastActivity: Date.now() }); openMessageSheet("gz", "g0")`);
  assert.equal(a.document.querySelector("#reaction-bar").children.length, 0);
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

test("пресеты стиля: Спокойный/Стандартный/Игривый применяются, ручное изменение даёт «Свой», расширенные эффекты свёрнуты", async () => {
  const a = await booted();
  const grp = a.document.querySelector("#fx-presets-group");
  assert.ok(grp, "группа пресетов добавлена в настройки");
  assert.ok(a.document.querySelector("#fx-settings-group").classList.contains("fx-advanced-collapsed"), "расширенные эффекты по умолчанию свёрнуты");
  assert.equal(a.run(`fxCurrentPreset()`), "default");
  a.run(`fxApplyPreset("calm")`);
  assert.equal(a.run(`fxCurrentPreset()`), "calm");
  assert.equal(a.run(`FX.get("dance")`), false); assert.equal(a.run(`FX.get("patina")`), false); assert.equal(a.run(`Store.calmMode`), true);
  assert.equal(a.document.documentElement.dataset.calmMode, "1");
  assert.equal(a.document.querySelector("#fxs-dance").checked, false, "тумблер расширенной группы следует за пресетом");
  assert.equal(a.document.querySelector('[data-preset="calm"]').classList.contains("active"), true);
  a.run(`fxApplyPreset("playful")`);
  assert.equal(a.run(`fxCurrentPreset()`), "playful");
  assert.equal(a.run(`FX.get("skin")`), true); assert.equal(a.run(`FX.get("ambient")`), false, "фоновый звук пресет не включает"); assert.equal(a.run(`Store.calmMode`), false);
  a.run(`fxApplyPreset("default")`);
  assert.equal(a.run(`fxCurrentPreset()`), "default");
  assert.equal(a.run(`FX.get("dance")`), true); assert.equal(a.run(`FX.get("skin")`), false);
  // ручное изменение → «Свой»
  const sw = a.document.querySelector("#fxs-dance"); sw.checked = false; sw.dispatchEvent(new a.window.Event("change"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(a.run(`fxCurrentPreset()`), "custom");
  assert.equal(a.document.querySelector('[data-preset="custom"]').classList.contains("active"), true);
  // «Расширенные эффекты» разворачивают группы
  a.document.querySelector("#fx-advanced-btn").click();
  assert.equal(a.document.querySelector("#fx-settings-group").classList.contains("fx-advanced-collapsed"), false);
  // приватные/разрешаемые функции пресет не трогает
  a.run(`FX.set("weather", true); FX.set("burn", "ash"); fxApplyPreset("calm");`);
  assert.equal(a.run(`FX.get("weather")`), true); assert.equal(a.run(`FX.get("burn")`), "ash");
  a.close();
});

test("поле ввода: многострочное; Enter отправляет только на десктопе, Shift+Enter и сенсорные устройства — перенос; переносы видны в пузыре", async () => {
  const a = await booted();
  a.run(`ensureContactEntry("alice", "Alice").managed = true; state.chatId = "alice"; renderTab();`);
  const el = a.document.querySelector("#chat-input");
  assert.equal(el.tagName, "TEXTAREA");
  let submits = 0;
  a.document.querySelector("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  const key = (opts) => { const ev = new a.window.KeyboardEvent("keydown", Object.assign({ key: "Enter", bubbles: true, cancelable: true }, opts)); el.dispatchEvent(ev); return ev; };
  a.window.matchMedia = (q) => ({ matches: false, addEventListener() {}, addListener() {} }); // мышь
  el.value = "hello";
  assert.equal(key({}).defaultPrevented, true, "Enter на десктопе отправляет"); assert.equal(submits, 1);
  assert.equal(key({ shiftKey: true }).defaultPrevented, false, "Shift+Enter — перенос строки"); assert.equal(submits, 1);
  assert.equal(key({ isComposing: true }).defaultPrevented, false, "ввод через IME не прерываем");
  el.value = "   "; assert.equal(key({}).defaultPrevented, true); assert.equal(submits, 1, "пустое не отправляется");
  a.window.matchMedia = (q) => ({ matches: /coarse/.test(q), addEventListener() {}, addListener() {} }); // сенсорный экран
  el.value = "hi"; assert.equal(key({}).defaultPrevented, false, "на сенсорном Enter — перенос строки"); assert.equal(submits, 1);
  assert.equal(a.run(`linkifyAndHighlight("line1\\nline2 https://e.com\\nline3", "")`).split("<br>").length, 3, "переносы строк показываются");
  assert.equal(a.run(`linkifyAndHighlight("<b>x</b>\\ny", "")`).includes("<b>"), false, "разметка по-прежнему экранируется");
  a.close();
});

test("доступность: skip-ссылка и ориентиры, модальный просмотр медиа с ловушкой фокуса, объявление реакций, читаемость, экономия данных", async () => {
  const a = await booted();
  const d = a.document;
  assert.ok(d.querySelector("a.skip-link[href='#content']"));
  d.querySelector(".skip-link").click();
  assert.equal(d.activeElement.id, "content", "skip-ссылка переносит фокус на main");
  assert.equal(a.window.location.hash, "", "адрес страницы не меняется");
  assert.ok(d.querySelector("main#content")); assert.ok(d.querySelector("nav#tab-bar[aria-label]"));
  // просмотрщик медиа
  const viewer = d.querySelector("#media-viewer");
  assert.equal(viewer.getAttribute("role"), "dialog"); assert.equal(viewer.getAttribute("aria-modal"), "true");
  const opener = d.querySelector("#chat-plus-btn"); opener.focus();
  a.run(`openMediaViewer("blob:x", "image")`);
  assert.equal(d.activeElement.id, "media-viewer-close", "фокус внутри окна");
  d.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.equal(viewer.contains(d.activeElement), true, "Tab не выходит за пределы окна");
  d.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.ok(viewer.classList.contains("hidden"), "Esc закрывает");
  assert.equal(d.activeElement, opener, "фокус вернулся на вызвавший элемент");
  // реакции объявляются
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "them", text: "x", ts: Date.now() }); toggleReaction("alice", "m1", "👍");`);
  await new Promise((r) => setTimeout(r, 60));
  assert.match(d.querySelector("#sr-announcer").textContent, /👍/);
  // входящая реакция собеседника тоже озвучивается
  a.run(`applyIncomingPayload("alice", "env1", { kind: "reaction", id: "m1", emoji: "❤️", remove: false, ts: Date.now() }, true)`);
  await new Promise((r) => setTimeout(r, 60));
  assert.match(d.querySelector("#sr-announcer").textContent, /Alice.*❤️/);
  // режим читаемости
  a.run(`Store.readableMode = true; applyChatAppearancePrefs();`);
  assert.equal(d.documentElement.dataset.readable, "1");
  // экономия данных: без явного выбора превью ссылок выключены
  a.window.localStorage.removeItem("ether.linkPreviews");
  a.window.matchMedia = (q) => ({ matches: /reduced-data/.test(q), addEventListener() {}, addListener() {} });
  assert.equal(a.run(`Store.linkPreviewsEnabled`), false);
  a.window.localStorage.setItem("ether.linkPreviews", "1");
  assert.equal(a.run(`Store.linkPreviewsEnabled`), true, "явный выбор пользователя сильнее системной настройки");
  a.close();
  const css = fs.readFileSync(path.join(ROOT, "css", "styles.css"), "utf8");
  for (const q of ["prefers-reduced-transparency", "prefers-contrast: more", "data-readable"]) assert.ok(css.includes(q), q);
});

test("окно отрисовки чата: длинная переписка рисуется частями, старые сообщения подгружаются кнопкой и переходами", async () => {
  const a = await booted();
  const d = a.document;
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; const t = Date.now();
    for (let i = 0; i < 400; i++) c.messages.push({ id: "m" + i, from: "me", text: "msg " + i, ts: t - (400 - i) * 1000 });
    unreadDividerFor.delete("alice"); state.chatId = "alice"; state.tab = "chats"; renderTab();`);
  await new Promise((r) => setTimeout(r, 80));
  const count = () => d.querySelectorAll("#chat-messages .bubble[data-msg-id]").length;
  assert.equal(count(), 150, "рисуются только последние 150");
  assert.ok(d.querySelector(".load-earlier-btn"), "есть кнопка «ещё»");
  assert.match(d.querySelector(".load-earlier-btn").textContent, /150/);
  d.querySelector(".load-earlier-btn").click();
  assert.equal(count(), 300);
  a.run(`ensureMessageRendered("alice", "m0")`);
  assert.equal(count(), 400, "переход к старому сообщению раскрывает окно");
  assert.equal(d.querySelector(".load-earlier-btn"), null);
  a.close();
});

test("голосовые: волна из метаданных, перемотка по волне, скорость, пауза записи, очистка чужой волны", async () => {
  const a = await booted();
  const d = a.document;
  // чистка чужого значения
  assert.equal(a.run(`sanitizeWave("x")`), undefined);
  assert.equal(a.run(`sanitizeWave([1,2])`), undefined);
  assert.equal(JSON.stringify(a.run(`sanitizeWave([0,5,99,-3,7.6,1])`)), JSON.stringify([0, 5, 31, 0, 8, 1]));
  const w = a.run(`compressWave(Array.from({length: 200}, (_, i) => (i % 20) / 20))`);
  assert.equal(w.length, 40); assert.ok(Math.max(...w) === 31 && Math.min(...w) >= 2);
  // отрисовка
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true;
    c.messages.push({ id: "v1", from: "them", text: "", ts: Date.now(), file: { name: "voice-message", mime: "audio/webm", size: 10, kind: "audio", duration: 10, wave: Array.from({length: 40}, (_, i) => i % 32) } });
    c.messages.push({ id: "v2", from: "them", text: "", ts: Date.now(), file: { name: "voice-message", mime: "audio/webm", size: 10, kind: "audio", duration: 4 } });
    unreadDividerFor.delete("alice"); state.chatId = "alice"; state.tab = "chats"; renderTab();`);
  const bubbles = d.querySelectorAll(".voice-bubble");
  assert.equal(bubbles.length, 2);
  for (const b of bubbles) assert.equal(b.querySelectorAll(".voice-wave-bars i").length, 40, "40 столбиков (и без волны — запасная)");
  assert.equal(bubbles[0].querySelector(".voice-wave").getAttribute("role"), "slider");
  // скорость
  assert.equal(a.run(`voiceSpeed()`), 1);
  d.querySelector(".voice-speed-btn").click();
  assert.equal(a.run(`voiceSpeed()`), 1.5);
  assert.equal(d.querySelector(".voice-speed-btn").textContent, "1.5×");
  d.querySelector(".voice-speed-btn").click(); d.querySelector(".voice-speed-btn").click();
  assert.equal(a.run(`voiceSpeed()`), 1, "цикл 1 → 1.5 → 2 → 1");
  // пауза записи: время паузы не входит в длительность
  a.run(`voiceRecorder = { pause() {}, resume() {}, state: "recording" }; voiceRecordStartedAt = Date.now() - 5000; voiceRecordPausedTotal = 0; voiceRecordPaused = false;`);
  a.run(`toggleVoiceRecordingPause()`);
  assert.equal(a.run(`voiceRecordPaused`), true);
  assert.ok(d.querySelector("#voice-recording-bar").classList.contains("is-paused"));
  a.run(`voiceRecordPausedAt = Date.now() - 3000`);
  const el = a.run(`voiceRecordElapsedSec()`);
  assert.ok(el > 1.5 && el < 2.6, "5 с минус 3 с паузы ≈ 2 с, получили " + el);
  a.run(`toggleVoiceRecordingPause()`);
  assert.equal(a.run(`voiceRecordPaused`), false);
  assert.ok(a.run(`voiceRecordPausedTotal`) >= 2900);
  a.run(`voiceRecorder = null; voiceRecordPausedTotal = 0;`);
  a.close();
});

test("опросы и доски: создание, голосование, получение от собеседника и из группы, права", async () => {
  const a = await booted();
  const d = a.document;
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; state.chatId = "alice"; state.tab = "chats"; renderTab();`);
  // создание опроса
  const ok = await a.run(`createPoll("alice", "Обед?", ["Суши", "Пицца"], false)`);
  assert.equal(ok, true);
  assert.equal(await a.run(`createPoll("alice", "x", ["один"], false)`), false, "меньше двух пунктов");
  const mine = a.run(`state.contacts.get("alice").messages.find((m) => m.poll)`);
  assert.ok(mine && mine.text === "Обед?");
  assert.equal(d.querySelectorAll(".poll-opt").length, 2);
  // голос и перевод в процент
  d.querySelector('[data-poll-opt="o2"]').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.match(d.querySelector('[data-poll-opt="o2"]').textContent, /100%/);
  assert.ok(d.querySelector('[data-poll-opt="o2"]').classList.contains("is-mine"));
  // нажатие по пункту не открывает меню сообщения
  assert.ok(d.querySelector("#message-sheet").classList.contains("hidden"));
  // голос собеседника
  a.run(`applyIncomingPayload("alice", "e1", { kind: "poll-vote", id: "${mine.id}", opts: ["o1"], ts: Date.now() }, true)`);
  assert.match(d.querySelector('[data-poll-opt="o1"]').textContent, /50%/);
  // чужой не-автор не закрывает мой опрос? — закрывает только автор: приходящее poll-close для моего сообщения игнорируется
  a.run(`applyIncomingPayload("alice", "e2", { kind: "poll-close", id: "${mine.id}" }, true)`);
  assert.equal(a.run(`state.contacts.get("alice").messages.find((m) => m.poll).poll.closed`), false);
  // входящий опрос и закрытие автором
  a.run(`applyIncomingPayload("alice", "e3", { kind: "poll", id: "p-in", ts: Date.now(), poll: { q: "Кино?", multi: true, opts: [{ id: "a", t: "Да" }, { id: "b", t: "Нет" }] } }, true)`);
  assert.ok(Array.from(d.querySelectorAll(".poll-q")).some((e) => e.textContent.includes("Кино?")));
  a.run(`applyIncomingPayload("alice", "e4", { kind: "poll-close", id: "p-in" }, true)`);
  assert.ok(Array.from(d.querySelectorAll(".poll-bubble.is-closed")).length === 1);
  // мусорный опрос отбрасывается
  a.run(`applyIncomingPayload("alice", "e5", { kind: "poll", id: "bad", poll: { q: "", opts: [] } }, true)`);
  assert.equal(a.run(`state.contacts.get("alice").messages.some((m) => m.id === "bad")`), false);
  // доска
  assert.equal(await a.run(`createBoard("alice", "Релиз")`), true);
  const bm = a.run(`state.contacts.get("alice").messages.find((m) => m.board)`);
  assert.equal(d.querySelectorAll(".board-col").length, 3);
  await a.run(`boardOp("alice", "${bm.id}", { t: "add", card: { id: "k1", t: "Тесты", col: "todo" } })`);
  assert.equal(d.querySelectorAll(".board-card").length, 1);
  d.querySelector('.board-card [data-board-act="right"]').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(d.querySelector('.board-col[data-col="doing"] .board-card') !== null, true, "карточка переехала в «В работе»");
  a.run(`applyIncomingPayload("alice", "e6", { kind: "board-op", id: "${bm.id}", ts: Date.now() + 5, op: { t: "del", id: "k1" } }, true)`);
  assert.equal(d.querySelectorAll(".board-card").length, 0);
  // группа: операции только от участников
  a.run(`const g = ensureContactEntry("grp1", "Team"); g.managed = true; g.isGroup = true; g.members = [{id: "me-test-id", name: "T"}, {id: "alice", name: "Alice"}]; g.createdBy = "me-test-id";`);
  a.run(`applyIncomingPayload("alice", "g1", { kind: "poll", id: "gp1", groupId: "grp1", senderName: "Alice", ts: Date.now(), poll: { q: "Группа?", opts: [{ id: "a", t: "A" }, { id: "b", t: "B" }] } }, true)`);
  assert.equal(a.run(`state.contacts.get("grp1").messages.some((m) => m.id === "gp1")`), true);
  a.run(`applyIncomingPayload("stranger", "g2", { kind: "poll", id: "gp2", groupId: "grp1", ts: Date.now(), poll: { q: "Чужой", opts: [{ id: "a", t: "A" }, { id: "b", t: "B" }] } }, true)`);
  assert.equal(a.run(`state.contacts.get("grp1").messages.some((m) => m.id === "gp2")`), false, "не участник — игнор");
  a.run(`applyIncomingPayload("stranger", "g3", { kind: "poll-vote", id: "gp1", groupId: "grp1", opts: ["a"] }, true)`);
  assert.equal(a.run(`Object.keys(state.contacts.get("grp1").messages.find((m) => m.id === "gp1").pollVotes).length`), 0);
  // превью в списке чатов и отсутствие правки/перевода
  a.run(`state.chatId = null; state.tab = "chats"; renderTab(); renderChatsList();`);
  assert.match(d.querySelector("#chats-list").textContent, /🗂|📊/);
  a.close();
});

test("демо-чат: создаётся из карточки первого запуска, отвечает по сценарию, не ходит в сеть, переживает перезагрузку; анимации отклика", async () => {
  const a = await booted();
  const d = a.document;
  a.run(`state.tab = "chats"; state.chatFilter = "all"; renderTab(); renderChatsList();`);
  const btn = d.querySelector('#first-run-card [data-first="demo"]');
  assert.ok(btn, "кнопка демо-чата в карточке первого запуска");
  btn.click();
  assert.equal(a.run(`state.chatId`), "__demo__");
  const c = () => a.run(`state.contacts.get("__demo__")`);
  assert.equal(a.run(`state.contacts.get("__demo__").messages.length`), 2, "два приветствия");
  assert.ok(a.run(`state.contacts.get("__demo__").isSelf`), "обходится сетью как «Заметки себе»");
  // пишем — получаем ответ по шагам
  await a.run(`sendChatMessage("__demo__", "привет")`);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(a.run(`state.contacts.get("__demo__").messages.length`), 4);
  assert.equal(a.run(`state.contacts.get("__demo__").messages[2].ack`), "read", "свои сообщения сразу прочитаны");
  await a.run(`sendChatMessage("__demo__", "ещё")`);
  await new Promise((r) => setTimeout(r, 2400));
  assert.ok(d.querySelector(".poll-bubble"), "бот прислал пример опроса");
  assert.ok(d.querySelector(".board-bubble"), "и доску");
  // голосование в демо не уходит в сеть и работает
  d.querySelector('[data-poll-opt="o1"]').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.match(d.querySelector('[data-poll-opt="o1"]').textContent, /100%/);
  // карточка первого запуска остаётся (настоящих контактов ещё нет)
  a.run(`state.chatId = null; renderTab(); renderChatsList();`);
  assert.ok(d.querySelector("#first-run-card"));
  // сохранение: флаги не теряются
  const saved = JSON.parse(a.window.localStorage.getItem("ether.contacts") || "[]");
  a.run(`persistContactsNow()`);
  const raw = a.window.localStorage.getItem("ether.contacts");
  assert.ok(!raw || raw.includes('"isDemo":true'), "isDemo сохраняется");
  // статус звонка/мэша: демо не считается контактом для списка «Контакты»
  assert.equal(a.run(`Array.from(state.contacts.values()).filter((c) => c.managed && !c.isGroup && !c.isSelf).length`), 0);
  // анимации отклика: смена статуса даёт ack-pop, копирование даёт вспышку
  a.run(`const n = ensureContactEntry("zed", "Zed"); n.managed = true; n.messages.push({ id: "q1", from: "me", text: "x", ts: Date.now(), ack: "sent" }); unreadDividerFor.delete("zed"); state.chatId = "zed"; renderTab();`);
  assert.equal(d.querySelector(".ack-pop"), null, "на первой отрисовке прыжка нет");
  a.run(`state.contacts.get("zed").messages[0].ack = "delivered"; renderChatThread();`);
  assert.ok(d.querySelector(".ack-tick.ack-pop"), "смена статуса — прыжок галочки");
  a.run(`flashCopiedBubble("q1")`);
  assert.ok(d.querySelector(".bubble.bubble-copied"));
  a.close();
});
