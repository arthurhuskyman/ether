// V.77 регрессии аудита V76, раздел 3 (A1–A13): js/app/01–05.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep } = require("./cov-helpers");
const { readAppSource } = require("./src-helper");
test.after(closeAll);
const SRC = readAppSource();

test("A1: openGroupInfo не стирает фото группы (нет background=\"\" в ветке avatar)", () => {
  assert.ok(!/style\.backgroundImage = `url\('\$\{g\.avatar\}'\)`; avatarBtn\.style\.background = ""/.test(SRC));
});

test("A2: controllerchange на первой установке SW не перезагружает страницу", () => {
  assert.match(SRC, /let hadController = !!navigator\.serviceWorker\.controller;/);
  assert.match(SRC, /if \(!hadController\) \{ hadController = true; return; \}/);
});

test("A3: выключенный Dead Man's Switch один раз шлёт heartbeat off", async () => {
  const a = await boot();
  a.run(`Store.myId = "me"; const c = ensureContactEntry("alice", "Alice"); Store.deadManEnabled = false; Store.deadManContactId = "alice"; Store.deadManLastSentAt = 123;
    window.__sent = []; window.trySendOrQueue = async (t, id, p) => { window.__sent.push(p); };
    checkDeadManSwitch(); checkDeadManSwitch();`);
  assert.equal(a.run(`window.__sent.length`), 1);
  assert.equal(a.run(`window.__sent[0].off`), true);
  assert.equal(a.run(`Store.deadManLastSentAt`), 0);
  a.close();
});

test("A4: IDB — отклонённый open не кэшируется, onclose/onabort/таймаут restore", async () => {
  assert.match(SRC, /p\.catch\(\(\) => \{ if \(dbPromise === p\) dbPromise = null; \}\)/);
  assert.match(SRC, /db\.onclose = /);
  assert.match(SRC, /tx\.onabort = \(\) => res\(undefined\)/);
  assert.match(SRC, /setTimeout\(\(\) => \{ aborted = true; res\(\); \}, 3000\)/);
  const a = await boot();
  const t0 = Date.now();
  // зависшая IDB: get никогда не отвечает — restore должен завершиться по таймауту
  a.run(`localStorage.removeItem("ether.name"); window.__origGet = IDB.get; IDB.get = () => new Promise(() => {});`);
  await a.run(`restoreFromIDB()`);
  assert.ok(Date.now() - t0 < 6000);
  a.close();
});

test("A5: битый JSON контактов сохраняется в IDB (contactsCorrupt)", async () => {
  const a = await boot();
  a.run(`window.__saved = []; IDB.set = async (k, v) => { window.__saved.push([k, v]); }; localStorage.setItem("ether.contacts", "{broken"); state.contacts.clear(); loadContacts();`);
  assert.deepEqual(JSON.parse(JSON.stringify(a.run(`window.__saved`))), [["contactsCorrupt", "{broken"]]);
  a.close();
});

test("A6: #add= просит подтверждение; без согласия контакт не добавляется", async () => {
  const a = await boot();
  a.run(`Store.myId = "me"; history.replaceState(null, "", "#add=bob&name=Bob"); window.__q = null;
    window.confirmSheet = (m) => { window.__q = m; return Promise.resolve(false); }; window.__added = []; window.addContactFromCard = (i, n) => window.__added.push(i);
    handleAddLinkFromLocation();`);
  await sleep(20);
  assert.match(String(a.run(`window.__q`)), /Bob/);
  assert.equal(a.run(`window.__added.length`), 0);
  a.run(`history.replaceState(null, "", "#add=bob&name=Bob"); window.confirmSheet = () => Promise.resolve(true); handleAddLinkFromLocation();`);
  await sleep(20);
  assert.equal(a.run(`window.__added[0]`), "bob");
  a.close();
});

test("A7: буква индекса контактов не режет суррогатные пары", () => {
  assert.ok(!/\(c\.name \|\| ""\)\.trim\(\)\.charAt\(0\)/.test(SRC));
  assert.match(SRC, /Array\.from\(\(c\.name \|\| ""\)\.trim\(\)\)\[0\]/);
});

test("A8: pointercancel не переставляет закреплённые чаты", () => {
  assert.match(SRC, /handle\.addEventListener\("pointercancel", \(e\) => finish\(e, true\)\)/);
  assert.match(SRC, /if \(cancelled\) return;/);
});

test("A9: NUL во входе applyMarkdown не подделывает плейсхолдер кода", async () => {
  const a = await boot();
  assert.equal(a.run(`applyMarkdown("x \\u0000CODE0\\u0000 y")`), "x CODE0 y");
  assert.equal(a.run(`applyMarkdown("\`a\` b")`), "<code>a</code> b");
  a.close();
});

test("A10: maybeOfferSystemLanguage не плодит обработчики", () => {
  assert.match(SRC, /yes\.onclick = \(\) =>/);
  assert.match(SRC, /no\.onclick = \(\) =>/);
});

test("A11: contactStatusLabel для группы без members не падает", async () => {
  const a = await boot();
  assert.doesNotThrow(() => a.run(`contactStatusLabel({ isGroup: true })`));
  a.close();
});

test("A12: highlightRaw корректен для символов, меняющих длину в toLowerCase", async () => {
  const a = await boot();
  assert.equal(a.run(`highlightRaw("İx abc", "abc")`), 'İx <mark class="search-hit">abc</mark>');
  assert.equal(a.run(`highlightRaw("Hello", "ell")`), 'H<mark class="search-hit">ell</mark>o');
  a.close();
});

test("A13: lockViewportGestures не глотит двойной тап по интерактивным элементам", () => {
  assert.match(SRC, /!onTitle && !interactive\) e\.preventDefault\(\)/);
});
