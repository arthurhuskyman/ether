// Сводка чата: локальная детерминированная выжимка за период (сегодня / 7 дней / всё), без сети и без модели.
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
const DAY = 864e5;
function seed(a) {
  a.run(`{ const c = ensureContactEntry("alice", "Alice"); c.managed = true; const n = Date.now();
    const add = (o) => c.messages.push(Object.assign({ ts: n, from: "them", readAckSent: true }, o));
    add({ id: "old1", from: "me", text: "Давно было: планируем релиз приложения", ts: n - 20 * DAYMS });
    add({ id: "w1", text: "Нужно обсудить релиз приложения, дедлайн релиз пятница.", ts: n - 3 * DAYMS });
    add({ id: "w2", from: "me", text: "Согласен, релиз приложения важнее всего.", ts: n - 3 * DAYMS + 1000 });
    add({ id: "w3", text: "Кто сделает тесты для релиза? ", ts: n - 3 * DAYMS + 2000 });
    add({ id: "t1", from: "me", text: "Смотри https://example.com/spec и ещё www.test.org", ts: n - 1000 });
    add({ id: "t3", from: "me", text: "Как дела с релизом приложения?", ts: n - 600 });
    add({ id: "f1", file: { kind: "image", name: "a.jpg" }, text: "", ts: n - 500 });
    add({ id: "f2", file: { kind: "audio", name: "v.webm" }, text: "", ts: n - 400 });
    add({ id: "f3", file: { kind: "file", name: "d.pdf" }, text: "", ts: n - 300 });
    add({ id: "p1", poll: { q: "Куда идём?", opts: [{ id: "a", t: "x" }, { id: "b", t: "y" }] }, text: "", ts: n - 200 });
    add({ id: "b1", board: { title: "Спринт", cols: [{ id: "c1", t: "К работе" }, { id: "c2", t: "В работе" }, { id: "c3", t: "Готово" }], cards: [{ id: "k1", t: "Написать тесты", col: "c1" }, { id: "k2", t: "Сделано", col: "c3" }, { id: "k3", t: "Ревью", col: "c2" }] }, text: "", ts: n - 100 });
    add({ id: "n1", note: { title: "Планы", text: "x" }, text: "", ts: n - 50 });
    add({ id: "del", deleted: true, text: "удалённое слово слово слово", ts: n - 40 });
    add({ id: "t2", text: "Когда созвонимся?", ts: n - 30 });
  }`.replace(/DAYMS/g, String(DAY)));
}
const digest = (a, since) => JSON.parse(a.run(`JSON.stringify(LocalAI.chatDigest(state.contacts.get("alice"), { since: ${since}, meName: "Я" }))`));

test("дайджест за разные периоды: счётчики, участники, темы, вопросы, ссылки, файлы, опросы, задачи, заметки", async () => {
  const a = await booted(); seed(a);
  const all = digest(a, 0);
  assert.equal(all.count, 13, "удалённые не считаются");
  const week = digest(a, `Date.now() - 7 * ${DAY}`);
  assert.equal(week.count, 12, "старше 7 дней отброшено");
  const today = digest(a, a.run(`summarySince("today")`));
  assert.ok(today.count <= week.count && today.count >= 1);
  assert.equal(all.people.find((p) => p.name === "Я").n >= 3, true);
  assert.ok(all.people.some((p) => p.name === "Alice"));
  assert.ok(week.topics.includes("релиз") || week.topics.includes("приложения"), JSON.stringify(week.topics));
  assert.ok(!week.topics.includes("давно"), "тема из периода");
  assert.deepEqual(week.files, { image: 1, video: 0, audio: 1, file: 1 });
  assert.deepEqual(week.polls, ["Куда идём?"]); assert.deepEqual(week.notes, ["Планы"]);
  assert.deepEqual(week.tasks.map((t) => t.text).sort(), ["Написать тесты", "Ревью"], "открытые = не в последней колонке");
  assert.equal(week.links.length, 1, "учитываются только http(s)-ссылки");
  assert.ok(week.links[0].startsWith("https://example.com/spec"));
  assert.ok(week.questions.some((q) => /созвонимся/.test(q.text)), "вопрос без ответа другого участника");
  assert.ok(!week.questions.some((q) => /Кто сделает тесты/.test(q.text)), "вопрос, на который ответили, не открыт");
  assert.ok(week.key.length > 0 && /релиз/i.test(week.key));
  a.close();
});

test("ответ replyTo закрывает вопрос; пустой чат и чат без текста не падают; мало текста — без «главного»", async () => {
  const a = await booted();
  a.run(`{ const c = ensureContactEntry("alice", "Alice"); const n = Date.now();
    c.messages.push({ id: "q1", from: "me", text: "Где ключ?", ts: n - 300 }, { id: "q2", from: "me", text: "Ты тут?", ts: n - 200 }, { id: "a1", from: "them", text: "вот", ts: n - 100, replyTo: { id: "q1" } }); }`);
  const d = digest(a, 0);
  assert.equal(d.key, "", "меньше 4 текстов — честно ничего не выдумываем");
  assert.deepEqual(d.questions, [], "любое сообщение собеседника после вопроса закрывает его");
  a.run(`ensureContactEntry("bob", "Bob").messages = []`);
  const e = JSON.parse(a.run(`JSON.stringify(LocalAI.chatDigest(state.contacts.get("bob"), {}))`));
  assert.equal(e.count, 0); assert.deepEqual(e.people, []);
  assert.doesNotThrow(() => a.run(`LocalAI.chatDigest(null, null)`));
  assert.doesNotThrow(() => a.run(`LocalAI.chatDigest({ messages: [null, {}, { ts: "x", text: 5 }, { ts: Date.now(), text: {} }] }, {})`));
  a.close();
});

test("шторка: пункт меню чата и строка карточки контакта, выбор периода, пустой период, aria", async () => {
  const a = await booted(); const d = a.document; seed(a);
  a.run(`state.chatId = "alice"; state.tab = "chats"; renderTab();`);
  // V.80 (fix80-menu-dedup): из меню «+» пункт убран (не вложение) — открывается из меню «⋯» шапки чата и из карточки контакта
  assert.equal(d.querySelector("#chat-summary-btn"), null, "в меню «+» дубля нет");
  a.run(`openChatHeaderMenu()`);
  const btn = Array.from(d.querySelectorAll("#anchored-menu .amenu-item")).find((b) => b.textContent.trim() === "Сводка чата"); assert.ok(btn);
  btn.click();
  const sheet = d.querySelector("#summary-sheet");
  assert.ok(!sheet.classList.contains("hidden"));
  assert.equal(sheet.getAttribute("role"), "dialog"); assert.equal(sheet.getAttribute("aria-modal"), "true");
  const body = d.querySelector("#summary-body");
  assert.match(body.textContent, /Сообщений: 12/);
  assert.match(body.textContent, /Участники/); assert.match(body.textContent, /Alice: /);
  assert.match(body.textContent, /Открытые задачи/); assert.match(body.textContent, /Написать тесты/);
  assert.match(body.textContent, /Вопросы без ответа/); assert.match(body.textContent, /example\.com/);
  assert.match(d.querySelector("#summary-sheet .fine").textContent, /нейросеть\s+не\s+используется/, "честная пометка про отсутствие модели");
  const per = (p) => d.querySelector(`.summary-period[data-period="${p}"]`);
  per("all").click(); assert.match(body.textContent, /Сообщений: 13/); assert.equal(per("all").getAttribute("aria-pressed"), "true"); assert.equal(per("week").getAttribute("aria-pressed"), "false");
  per("today").click(); assert.ok(/Сообщений: \d+/.test(body.textContent));
  // период без сообщений
  a.run(`state.contacts.get("alice").messages.forEach((m) => { m.ts -= 40 * ${DAY}; }); renderChatSummary();`);
  assert.match(body.textContent, /подводить\s+итоги\s+не\s+с\s+чего/);
  per("all").click(); assert.match(body.textContent, /Сообщений: 13/);
  d.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(sheet.classList.contains("hidden"));
  // карточка контакта
  a.run(`state.chatId = null; state.contactCardId = "alice"; renderTab();`);
  d.querySelector("#contact-summary-btn").click();
  assert.ok(!sheet.classList.contains("hidden"));
  a.close();
});

test("XSS: имя и текст с разметкой экранируются; группа с несколькими участниками", async () => {
  const a = await booted("en"); const d = a.document;
  const evil = `<img src=x onerror="window.__pwn=1">`;
  a.run(`{ const g = { id: "grp1", name: ${JSON.stringify(evil)}, isGroup: true, managed: true, members: [{ id: "me-test-id", name: "T" }, { id: "b", name: "B" }, { id: "e", name: "E" }], messages: [], lastActivity: Date.now(), status: "paired" };
    state.contacts.set("grp1", g); const n = Date.now();
    g.messages.push({ id: "1", from: "them", fromId: "b", fromName: ${JSON.stringify(evil)}, text: ${JSON.stringify("Where is " + evil + "? ")}, ts: n - 5 }, { id: "2", from: "them", fromId: "e", fromName: "Eve", text: ${JSON.stringify("see https://x.io/a?b=<script>1</script> now")}, ts: n - 4 }, { id: "3", from: "me", text: "ok", ts: n - 3 });
    state.chatId = "grp1"; state.tab = "chats"; renderTab(); openChatSummary("grp1"); }`);
  const body = d.querySelector("#summary-body");
  assert.equal(body.querySelector("img"), null); assert.equal(body.querySelector("script"), null);
  assert.equal(a.window.__pwn, undefined);
  assert.match(body.textContent, /Messages: 3/); assert.match(body.textContent, /Eve: 1/);
  assert.match(body.textContent, /<img src=x/, "текст виден как текст");
  assert.equal(a.run(`T("summary.week")`), "7 days");
  a.close();
});

test("сводка не обращается к сети", async () => {
  const a = await booted(); seed(a);
  a.run(`window.__net = 0; window.fetch = () => { window.__net++; return Promise.reject(new Error("net")); }; openChatSummary("alice"); renderChatSummary();`);
  await sleep(50);
  assert.equal(a.run(`window.__net`), 0);
  a.close();
});
