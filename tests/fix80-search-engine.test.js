// Локальный поиск (js/search.js): токенизация ru/en/ar, диакритика, префикс/фраза, фильтры, ранжирование, сниппеты, инкрементальная сборка, 100k сообщений.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/search.js");
const D = (s) => new Date(s).getTime();
function mk(msgs, chat = "c1", name = "Чат") { const ix = S.create(); return ix.build([{ id: chat, name, messages: msgs }]).then(() => ix); }
const ids = (r) => r.map((x) => x.id);

test("нормализация: регистр, диакритика, ё/е, й/и, арабские огласовки/алеф/цифры", () => {
  assert.equal(S.norm("Ёлка"), "елка"); assert.equal(S.norm("Йога"), "иога"); assert.equal(S.norm("Café ZÜRICH"), "cafe zurich");
  assert.equal(S.norm("مَرْحَبًا"), "مرحبا"); assert.equal(S.norm("أهلاً"), S.norm("اهلا")); assert.equal(S.norm("٣٤٥"), "345");
  assert.deepEqual(S.tokens("Hello, мир! 123 e-mail"), ["hello", "мир", "123", "e", "mail"]);
});
test("поиск ru/en/ar: префикс, регистр, диакритика, несколько слов (все должны быть), RTL-подсветка по исходным смещениям", async () => {
  const ix = await mk([
    { id: "1", from: "them", fromName: "Алиса", text: "Привет! Встреча завтра в 10:00", ts: D("2025-03-01") },
    { id: "2", from: "me", text: "Ёлка и ЁЖ у café Zürich", ts: D("2025-03-02") },
    { id: "3", from: "them", fromName: "Омар", text: "مَرْحَبًا بالعالم، أهلاً وسهلاً", ts: D("2025-03-03") },
    { id: "4", from: "system", text: "Привет системное", ts: D("2025-03-04") },
  ]);
  assert.deepEqual(ids(ix.search("встреч")), ["1"]); assert.deepEqual(ids(ix.search("ПРИВ")), ["1"]);
  assert.deepEqual(ids(ix.search("елка еж")), ["2"]); assert.deepEqual(ids(ix.search("cafe zurich")), ["2"]);
  assert.deepEqual(ids(ix.search("مرحبا")), ["3"]); assert.deepEqual(ids(ix.search("اهلا وسهلا")), ["3"]);
  assert.deepEqual(ids(ix.search("встреча ёжик")), [], "все слова обязательны");
  const sn = ix.search("أهلا")[0].snippet; assert.equal(sn.filter((s) => s.hit).map((s) => s.t).join(""), "أهلاً"); assert.equal(sn.map((s) => s.t).join(""), "مَرْحَبًا بالعالم، أهلاً وسهلاً");
  assert.equal(ix.size(), 3, "системные сообщения не индексируются");
});
test("фразы в кавычках: только подряд идущие слова; одно слово в кавычках — точное, не префикс", async () => {
  const ix = await mk([{ id: "1", from: "me", text: "big red apple pie", ts: 1 }, { id: "2", from: "me", text: "red big apple", ts: 2 }, { id: "3", from: "me", text: "applesauce", ts: 3 }]);
  assert.deepEqual(ids(ix.search('"red pie"')), []); assert.deepEqual(ids(ix.search('"big red"')), ["1"]); assert.deepEqual(ids(ix.search('"apple pie"')), ["1"]);
  assert.deepEqual(ids(ix.search("apple")).sort(), ["1", "2", "3"]); assert.deepEqual(ids(ix.search('"apple"')).sort(), ["1", "2"]);
});
test("фильтры: чат, отправитель, дата, тип (media/links/files/voice), только-фильтры", async () => {
  const ix = S.create();
  await ix.build([
    { id: "a", name: "Работа", messages: [
      { id: "1", from: "them", fromName: "Иван", text: "отчёт готов https://example.org/r", ts: D("2025-01-10") },
      { id: "2", from: "them", fromName: "Иван", text: "", file: { kind: "image", name: "photo.png", caption: "отчёт фото" }, ts: D("2025-02-10") },
      { id: "3", from: "me", text: "", file: { kind: "audio", name: "voice.ogg", duration: 3 }, ts: D("2025-02-11") },
      { id: "4", from: "me", text: "", file: { kind: "application/pdf", name: "отчёт.pdf" }, ts: D("2025-03-01") } ] },
    { id: "b", name: "Семья", messages: [{ id: "5", from: "them", fromName: "Мама", text: "отчёт по огороду", ts: D("2025-03-05") }] },
  ]);
  assert.deepEqual(ids(ix.search("отчёт")).sort(), ["1", "2", "4", "5"]);
  assert.deepEqual(ids(ix.search("отчёт in:семья")), ["5"]); assert.deepEqual(ids(ix.search("отчёт", { chats: ["a"] })).sort(), ["1", "2", "4"]);
  assert.deepEqual(ids(ix.search("отчёт from:иван")).sort(), ["1", "2"]); assert.deepEqual(ids(ix.search("отчёт from:me")), ["4"]);
  assert.deepEqual(ids(ix.search("отчёт after:2025-02-01 before:2025-02-28")), ["2"]);
  assert.deepEqual(ids(ix.search("type:links")), ["1"]); assert.deepEqual(ids(ix.search("type:media")), ["2"]); assert.deepEqual(ids(ix.search("type:voice")), ["3"]); assert.deepEqual(ids(ix.search("type:files")), ["4"]);
  assert.deepEqual(ids(ix.search("отчёт type:files")), ["4"]); assert.deepEqual(ids(ix.search("in:работа")).sort(), ["1", "2", "3", "4"]);
  assert.deepEqual(ids(ix.search("отчёт", { type: S.T_LINK })), ["1"]);
});
test("ранжирование: точное слово выше префикса, фраза выше, при равенстве — свежее", async () => {
  const ix = await mk([{ id: "old", from: "me", text: "cat", ts: 1000 }, { id: "pre", from: "me", text: "category", ts: 3000 }, { id: "new", from: "me", text: "cat", ts: 4000 }]);
  assert.deepEqual(ids(ix.search("cat")), ["new", "old", "pre"]);
  const ix2 = await mk([{ id: "a", from: "me", text: "foo bar baz", ts: 5 }, { id: "b", from: "me", text: "bar foo", ts: 9 }]);
  assert.equal(ix2.search('"foo bar"')[0].id, "a");
});
test("живые изменения: добавление, правка, удаление, удаление чата; пустой/мусорный запрос", async () => {
  const ix = await mk([{ id: "1", from: "me", text: "alpha", ts: 1 }]);
  assert.ok(ix.addMessage("c1", { id: "2", from: "them", text: "beta gamma", ts: 2 })); assert.deepEqual(ids(ix.search("gamma")), ["2"]);
  ix.updateMessage("c1", { id: "2", from: "them", text: "delta", ts: 2 }); assert.deepEqual(ids(ix.search("gamma")), []); assert.deepEqual(ids(ix.search("delta")), ["2"]);
  ix.removeMessage("c1", "1"); assert.deepEqual(ids(ix.search("alpha")), []);
  ix.removeChat("c1"); assert.deepEqual(ids(ix.search("delta")), []); assert.equal(ix.size(), 0);
  assert.deepEqual(ix.search(""), []); assert.deepEqual(ix.search("   \"\" "), []); assert.deepEqual(ix.search("zzz"), []);
});
test("инкрементальная сборка: уступает циклу событий и не блокирует, повторная сборка отменяет прежнюю", async () => {
  const msgs = Array.from({ length: 20000 }, (_, i) => ({ id: "m" + i, from: "me", text: "message number " + i + " lorem ipsum", ts: i }));
  const ix = S.create(); let yields = 0, progress = 0;
  const p = ix.build([{ id: "c", name: "x", messages: msgs }], { sliceMs: 1, yieldFn: () => { yields++; return new Promise((r) => setImmediate(r)); }, onProgress: (n) => { progress = n; } });
  let ticked = false; setImmediate(() => { ticked = true; });
  await p; assert.ok(yields > 3, "yields=" + yields); assert.ok(ticked); assert.equal(progress, 20000); assert.equal(ix.size(), 20000);
  const ix2 = S.create(); const p1 = ix2.build([{ id: "c", name: "x", messages: msgs }], { sliceMs: 1, yieldFn: () => new Promise((r) => setImmediate(r)) });
  await new Promise((r) => setImmediate(r)); const p2 = ix2.build([{ id: "c", name: "x", messages: msgs.slice(0, 10) }]); await Promise.all([p1, p2]);
  assert.ok(ix2.size() < 20010);
});
test("100k сообщений: сборка и поиск укладываются в бюджет", async () => {
  const words = "привет мир дела работа проект встреча завтра отчёт hello world meeting project report مرحبا العالم اجتماع تقرير файл ссылка фото".split(" ");
  let seed = 7; const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const N = 100000, msgs = new Array(N);
  for (let i = 0; i < N; i++) { const n = 5 + Math.floor(rnd() * 10); let t = ""; for (let k = 0; k < n; k++) t += words[Math.floor(rnd() * words.length)] + (rnd() < 0.1 ? i : "") + " "; msgs[i] = { id: "m" + i, from: rnd() < 0.5 ? "me" : "them", fromName: "u" + (i % 7), text: t, ts: 1.7e12 + i * 1000 }; }
  msgs[54321].text += " уникальноеслово";
  const ix = S.create(); const t0 = Date.now();
  await ix.build([{ id: "big", name: "big", messages: msgs }], { sliceMs: 10 });
  const tb = Date.now() - t0;
  const t1 = Date.now(); const r1 = ix.search("уникальное"), r2 = ix.search("встреч отчёт", { limit: 500 }), r3 = ix.search('"привет мир"', { limit: 20 }), r4 = ix.search("type:links"), r5 = ix.search("пр");
  const ts = (Date.now() - t1) / 5;
  assert.deepEqual(ids(r1), ["m54321"]); assert.ok(r2.length > 100, "r2=" + r2.length); assert.equal(r3.length, 20, "r3"); assert.equal(r5.length, 50, "r5=" + r5.length);
  assert.ok(tb < 15000, "build ms=" + tb); assert.ok(ts < 400, "avg search ms=" + ts);
  console.log("# 100k: build " + tb + " ms, avg search " + ts.toFixed(1) + " ms, vocab " + ix.vocabSize());
});
test("parseQuery: операторы, кавычки, мусорные даты", () => {
  const q = S.parseQuery('привет "добрый день" in:"Моя работа" from:Иван type:media after:2025-01-02 before:bad');
  assert.deepEqual(q.phrases, [[S.norm("добрый"), "день"]]); assert.equal(q.filters.in, "моя работа"); assert.equal(q.filters.from, "иван"); assert.equal(q.filters.type, S.T_MEDIA);
  assert.ok(q.filters.after > 0 && q.filters.before === undefined); assert.deepEqual(q.terms.map((t) => t.t), ["привет"]);
});
