// V.79: клиент — экран «Входящий звонок» по /#answer=…, состояния звонящего, «Проверка уведомлений», настройки для SW.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, bootApp, closeAll } = require("./harness");
test.after(closeAll);
const nb = (x) => String(x).replace(/\u00a0/g, " "); // типографика ru ставит неразрывные пробелы
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(30); } return false; }
const seed = JSON.stringify([{ id: "alice", name: "Алиса", raw: "", messages: [], lastActivity: 1 }]);
const base = { "ether.name": "Tester", "ether.myId": "me-test-id", "ether.lang": "ru", "ether.contacts": seed };
const vis = (a, sel) => !a.document.querySelector(sel).classList.contains("hidden");
const txt = (a, sel) => nb(a.document.querySelector(sel).textContent);
function fakeSignaling(a) { a.run(`window.__sent = []; signaling.connected = true; signaling.registered = true; signaling.signal = (to, d) => { window.__sent.push({ to, d }); return true; }; signaling.send = (t, p) => { window.__sent.push({ type: t, p }); return true; };`); }
const invite = (a, from) => { a.window.__f = from; a.run(`signaling.dispatchEvent(new CustomEvent("signal", { detail: { from: window.__f, data: { t: "call-invite", n: "Алиса", x: "x1" } } }))`); };

test("deep link /#answer=: экран входящего рисуется сразу с именем контакта, кнопки «Ответить»/«Отклонить»", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=alice", storage: { ...base, "ether.cnames": JSON.stringify({ alice: "Алиса" }) } });
  // экран нарисован ещё до startApp (на момент DOMContentLoaded + одного такта)
  assert.ok(await until(() => a.run(`typeof answerUi !== "undefined" && answerUi.active`), 1500));
  assert.equal(txt(a, "#answer-name"), "Алиса");
  assert.equal(txt(a, "#answer-accept-btn"), "Ответить"); assert.equal(txt(a, "#answer-decline-btn"), "Отклонить");
  assert.ok(vis(a, "#answer-screen"));
  assert.equal(a.run(`__appStarted`), false, "полный старт ещё не выполнен — экран показан раньше");
  await a.ready;
  assert.ok(await until(() => a.run(`__appStarted`)), "приложение стартует параллельно");
  assert.equal(a.run(`state.contacts.size >= 1`), true);
});

test("нет индекса имён (первый запуск после обновления): сначала короткий id, затем имя из сохранённых контактов", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=alice", storage: base });
  assert.ok(await until(() => a.run(`answerUi.active`), 1500));
  assert.ok(await until(() => txt(a, "#answer-name") === "Алиса", 3000));
  await a.ready; assert.ok(await until(() => a.run(`__appStarted`)));
  assert.ok(JSON.parse(a.window.localStorage.getItem("ether.cnames")).alice, "индекс создан при старте");
});

test("неизвестный отправитель: вместо имени короткий id; индекс имён ether.cnames пишется при сохранении контактов", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=deadbeefcafe0123", storage: base });
  assert.ok(await until(() => a.run(`answerUi.active`), 1500));
  assert.equal(txt(a, "#answer-name"), "deadbeef");
  await a.ready;
  a.run(`ensureContactEntry("bob", "Боб"); persistContactsNow();`);
  assert.equal(JSON.parse(a.window.localStorage.getItem("ether.cnames")).bob, "Боб");
});

test("без аккаунта #answer игнорируется (обычный онбординг)", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=alice", storage: { "ether.lang": "ru" } });
  await a.ready;
  assert.equal(a.run(`answerUi.active`), false);
  assert.ok(!vis(a, "#answer-screen"));
});

test("«Ответить» до прихода приглашения → «Соединяем…», затем приглашение принимается автоматически; экран скрывается", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=alice", storage: base });
  await a.ready; assert.ok(await until(() => a.run(`__appStarted`)));
  fakeSignaling(a);
  a.document.querySelector("#answer-accept-btn").click();
  assert.equal(txt(a, "#answer-status"), "Соединяем…");
  invite(a, "alice");
  assert.ok(await until(() => a.run(`state._callUserAccepted === true`)), "микрофон/принятие только после тапа пользователя");
  assert.ok(!vis(a, "#answer-screen"));
  assert.equal(a.run(`state.callId`), "alice");
});

test("приглашение пришло раньше тапа: экран входящего заменяется обычным экраном звонка, без авто-принятия", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=alice", storage: base });
  await a.ready; assert.ok(await until(() => a.run(`__appStarted`)));
  fakeSignaling(a);
  invite(a, "alice");
  assert.ok(!vis(a, "#answer-screen"));
  assert.equal(a.run(`state.callPhase`), "ringing");
  assert.equal(a.run(`state._callUserAccepted`), false);
});

test("«Отклонить» на раннем экране: приглашение, пришедшее позже, отклоняется само", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=alice", storage: base });
  await a.ready; assert.ok(await until(() => a.run(`__appStarted`)));
  fakeSignaling(a);
  a.document.querySelector("#answer-decline-btn").click();
  assert.ok(!vis(a, "#answer-screen"));
  assert.ok(a.run(`window.__sent`).some((x) => x.d && x.d.t === "call-declined" && x.to === "alice"));
  a.run(`window.__sent.length = 0`);
  invite(a, "alice");
  assert.ok(await until(() => a.run(`window.__sent`).some((x) => x.d && x.d.t === "call-declined")), "опоздавший invite отклонён");
  assert.equal(a.run(`state.callId`), null, "экран звонка закрыт отклонением");
});

test("приглашение не пришло: «Звонок завершён. Перезвонить?» и кнопка «Перезвонить» звонит контакту", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=alice", storage: base });
  await a.ready; assert.ok(await until(() => a.run(`__appStarted`) && a.run(`answerUi.active`)));
  fakeSignaling(a);
  a.run(`answerUi.registeredAt = Date.now() - 6000; answerTick();`);
  assert.equal(txt(a, "#answer-status"), "Звонок завершён. Перезвонить?");
  assert.ok(vis(a, "#answer-callback-btn")); assert.ok(!vis(a, "#answer-accept-btn"));
  a.run(`window.__began = []; beginCall = (id) => window.__began.push(id);`);
  a.document.querySelector("#answer-callback-btn").click();
  assert.deepEqual([...a.window.__began], ["alice"]);
  assert.ok(!vis(a, "#answer-screen"));
});

test("жёсткий предел ожидания 50 с даже без регистрации", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=alice", storage: base });
  await a.ready; assert.ok(await until(() => a.run(`answerUi.active`)));
  a.run(`answerUi.t0 = Date.now() - 51000; answerTick();`);
  assert.equal(a.run(`answerUi.state`), "ended");
});

test("клик по уведомлению при открытом приложении (answer-call от SW): показывает экран; если звонок уже звонит — не дублирует", async () => {
  const a = await bootApp({ storage: base });
  a.run(`answerFromNotification({ type: "answer-call", from: "alice", callId: "c9", name: "Алиса" })`);
  assert.ok(vis(a, "#answer-screen"));
  a.run(`hideAnswerScreen()`);
  fakeSignaling(a); invite(a, "alice");
  a.run(`answerFromNotification({ from: "alice", callId: "c9" })`);
  assert.ok(!vis(a, "#answer-screen"), "звонок уже на экране");
});

test("быстрый старт: второстепенные wire* откладываются, главное готово сразу; после такта всё подключено", async () => {
  const a = createApp({ url: "http://localhost/#answer=c1&from=alice", storage: base });
  await a.ready; assert.ok(await until(() => a.run(`__appStarted`)));
  assert.ok(await until(() => a.run(`__fastBoot === false`)), "отложенные wire выполнены");
  assert.ok(a.run(`typeof signaling !== "undefined" && !!signaling`));
  assert.ok(a.run(`!!mesh`));
});

// ---------- Звонящий ----------
test("звонящий: «Вызываем…» → «Звонит у собеседника…» по call-ringing → через 20 с три действия", async () => {
  const a = await bootApp({ storage: base });
  fakeSignaling(a);
  const real = a.window.setTimeout.bind(a.window);
  a.window.setTimeout = (f, ms, ...r) => real(f, ms === 20000 ? 60 : ms, ...r); // ускоряем только эскалацию
  a.run(`onlineSet.add("alice")`);
  await a.run(`beginCall("alice", false)`);
  assert.equal(txt(a, "#call-phase"), "Вызываем…");
  assert.ok(!vis(a, "#call-noanswer-actions"));
  a.run(`signaling.dispatchEvent(new CustomEvent("call-ringing", { detail: { type: "call-ringing", callId: "x" } }))`);
  assert.equal(txt(a, "#call-phase"), "Звонит у собеседника…");
  assert.ok(await until(() => vis(a, "#call-noanswer-actions"), 1500));
  const labels = [...a.document.querySelectorAll("#call-noanswer-actions button")].map((b) => b.textContent);
  assert.deepEqual(labels, ["Позвать другим способом", "Оставить голосовое", "Позвонить ещё раз"]);
  a.window.setTimeout = real;
});

test("«Позвонить ещё раз»: тихий отбой и новый вызов с новым приглашением", async () => {
  const a = await bootApp({ storage: base });
  fakeSignaling(a);
  a.run(`onlineSet.add("alice")`);
  await a.run(`beginCall("alice", false)`);
  a.run(`window.__sent.length = 0`);
  a.document.querySelector("#call-alt-retry-btn").click();
  assert.equal(a.run(`state.callId`), null);
  assert.ok(a.run(`window.__sent`).some((x) => x.d && x.d.t === "call-ended"));
  assert.ok(await until(() => a.run(`state.callId`) === "alice", 2000), "новый звонок начат");
  assert.ok(a.run(`window.__sent`).some((x) => x.d && x.d.t === "call-invite"));
});

test("«Оставить голосовое»: звонок завершён без второго запроса, открыт чат и пошла запись", async () => {
  const a = await bootApp({ storage: base });
  fakeSignaling(a);
  a.run(`window.__rec = 0; startVoiceRecording = () => { window.__rec++; };`);
  await a.run(`beginCall("alice", false)`);
  a.document.querySelector("#call-alt-voicemail-btn").click();
  assert.equal(a.run(`state.callId`), null);
  assert.equal(a.run(`state.chatId`), "alice");
  assert.ok(await until(() => a.window.__rec === 1));
});

test("действия «нет ответа» не показываются, если собеседник уже ответил", async () => {
  const a = await bootApp({ storage: base });
  fakeSignaling(a);
  const real = a.window.setTimeout.bind(a.window);
  a.window.setTimeout = (f, ms, ...r) => real(f, ms === 20000 ? 50 : ms, ...r);
  await a.run(`beginCall("alice", false)`);
  a.run(`setCallPhaseActive()`);
  await sleep(200);
  assert.ok(!vis(a, "#call-noanswer-actions"));
  a.window.setTimeout = real;
});

// ---------- Настройки для SW ----------
test("настройки гудков уходят в service worker (HTTP-адрес сервера и локализованные тексты), повторно не дублируются", async () => {
  const a = await bootApp({ storage: { ...base, "ether.signalingUrl": "wss://sig.example" } });
  const msgs = [];
  a.run(`swRegistration = { active: { postMessage: (m) => window.__swm.push(m) } };`);
  a.window.__swm = msgs; a.run(`__ringCfgKey = ""; syncRingConfigToSW(); syncRingConfigToSW();`);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, "ring-config"); assert.equal(msgs[0].httpBase, "https://sig.example");
  assert.equal(nb(msgs[0].strings.ringTitle), "📞 {name} звонит"); assert.equal(nb(msgs[0].strings.missed), "Пропущенный звонок от {name}");
});

// ---------- Проверка уведомлений ----------
test("«Проверка уведомлений»: строки состояния, подсказки iOS, кнопка теста; тест успешен, когда гудок пришёл", async () => {
  const a = await bootApp({ storage: base });
  a.document.documentElement.setAttribute("lang", "ru");
  fakeSignaling(a);
  const btn = a.document.querySelector("#notifcheck-btn");
  assert.equal(btn.querySelector("span").textContent, "Проверка уведомлений");
  btn.click(); await sleep(150);
  const sheet = a.document.querySelector("#devicecheck-sheet");
  assert.ok(sheet);
  const items = [...sheet.querySelectorAll(".notifcheck-list li")].map((l) => l.textContent);
  assert.ok(items.some((t) => t.includes("Разрешение на уведомления")));
  assert.ok(items.some((t) => t.includes("Установлено на экран «Домой»")));
  assert.ok(items.some((t) => t.includes("Подписка на уведомления")));
  assert.ok(items.some((t) => t.includes("Последнее уведомление получено")));
  assert.ok(sheet.querySelectorAll(".notifcheck-tips li").length >= 4, "советы про «Домой», Фокус, баннеры «Постоянные», звук");
  assert.ok(/Постоянные/.test(sheet.textContent) && /Фокусирование/.test(sheet.textContent));
  const test = [...sheet.querySelectorAll("button")].find((b) => b.textContent === "Позвонить мне (тест)");
  assert.ok(test && test.getAttribute("aria-label"));
  for (const b of sheet.querySelectorAll("button")) assert.ok(b.getAttribute("aria-label") || b.textContent.trim(), "у кнопок есть имя");
  test.click(); await sleep(60);
  assert.ok(a.run(`window.__sent`).some((x) => x.type === "push-test-ring"), "по сокету ушёл push-test-ring");
  assert.match(sheet.querySelector("p[role=status]").textContent, /Ждём тестовый звонок/);
  a.window.notifCheckOnRing({ type: "ring-received" }); await sleep(100);
  assert.match(sheet.querySelector("p[role=status]").textContent, /Тестовый звонок дошёл за \d+ с/);
});

test("тест уведомлений: нет гудка за лимит → отчёт о провале; нет сервера → понятное сообщение", async () => {
  const a = await bootApp({ storage: base });
  fakeSignaling(a);
  const r1 = await a.run(`DeviceCheck.runRingTest(150)`);
  assert.equal(r1.ok, false);
  a.run(`signaling.connected = false`);
  const r2 = await a.run(`DeviceCheck.runRingTest(150)`);
  assert.equal(r2.reason, "noserver");
});

test("«Проверка уведомлений»: последний push берётся из метки SW в кэше, подписка помечается подтверждённой сервером", async () => {
  const a = await bootApp({ storage: base });
  const store = new Map([["./__lastpush.json", JSON.stringify({ ts: Date.now() - 5 * 60000, t: "call-ring" })]]);
  a.window.caches = { open: async () => ({ match: async (k) => (store.has(k) ? new a.window.Response(store.get(k)) : undefined) }) };
  a.window.Response = a.window.Response || Response;
  a.run(`state._pushServerOk = Date.now()`);
  const rows = await a.run(`DeviceCheck.notifState()`);
  const last = rows.find((r) => r.id === "last");
  assert.equal(last.ok, true); assert.match(last.detail, /5 мин/);
  assert.equal(rows.find((r) => r.id === "sw").ok, false, "в тестовом окне service worker нет");
});
