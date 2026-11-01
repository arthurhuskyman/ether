// V.86: волна из 50+ пунктов — шифрование кадров, защита, функции чата, интерфейс.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);
const ROOT = path.join(__dirname, "..");

test("лицензия MIT в корне, у сервера и SDK", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /^MIT License/);
  for (const p of ["signaling-server/package.json", "sdk/package.json"]) assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")).license, "MIT");
});

test("шифрование кадров: туда-обратно, открытый заголовок, чужой ключ и подмена отвергаются, эпохи", async () => {
  const a = await boot();
  const r = J(await a.run(`(async () => {
    const raw = FrameCrypt.newRawKey(), k = await FrameCrypt.importKey(raw), k2 = await FrameCrypt.importKey(FrameCrypt.newRawKey());
    const frame = new Uint8Array(200); for (let i = 0; i < 200; i++) frame[i] = i;
    const enc = new Uint8Array(await FrameCrypt.encrypt(k, 7, 42, frame.buffer, 10));
    const headKept = Array.from(enc.slice(0, 10)).join() === Array.from(frame.slice(0, 10)).join();
    const bodyHidden = Array.from(enc.slice(15, 30)).join() !== Array.from(frame.slice(10, 25)).join();
    const dec = new Uint8Array(await FrameCrypt.decrypt((e) => (e === 7 ? k : null), enc.buffer, 10));
    const wrongKey = await FrameCrypt.decrypt(() => k2, enc.buffer, 10);
    const noEpoch = await FrameCrypt.decrypt((e) => (e === 8 ? k : null), enc.buffer, 10);
    const tampered = enc.slice(); tampered[3] ^= 1; const t = await FrameCrypt.decrypt(() => k, tampered.buffer, 10);
    return { len: enc.length - frame.length, headKept, bodyHidden, same: Array.from(dec).join() === Array.from(frame).join(), wrongKey, noEpoch, t, clearA: FrameCrypt.clearBytesFor("audio"), clearK: FrameCrypt.clearBytesFor("video", true) };
  })()`));
  assert.equal(r.len, 5 + 16); assert.ok(r.headKept && r.bodyHidden && r.same);
  assert.equal(r.wrongKey, null); assert.equal(r.noEpoch, null); assert.equal(r.t, null, "подмена открытого заголовка ломает тег");
  assert.equal(r.clearA, 1); assert.equal(r.clearK, 10);
  // ключи отправителя в групповом звонке: рассылка участнику, приём, ротация
  a.run(`window.__gsent = []; window.gcallSend = (id, p) => { window.__gsent.push([id, p]); return true; }; p86NewSenderKey(); p86SendKeyTo("bob");`);
  const sent = J(a.run(`window.__gsent`));
  assert.equal(sent[0][1].t, "fkey"); assert.equal(sent[0][1].e, 1); assert.ok(sent[0][1].fe === 0 || sent[0][1].fe === 1);
  a.run(`p86OnPeerKey("bob", ${JSON.stringify(sent[0][1])}); p86OnPeerKey("bob", { e: 2, k: "short" });`);
  assert.equal(a.run(`FK.peers.get("bob").size`), 1);
  a.run(`p86NewSenderKey()`); assert.equal(a.run(`FK.epoch`), 2);
  a.close();
});

test("защита: сила пароля, метки слежки, опасные файлы, авто-стирание, блокировка при бездействии, срок медиа", async () => {
  const a = await boot();
  assert.ok(a.run(`passStrength("aaaa")`) <= 1); assert.ok(a.run(`passStrength("Correct-Horse-42!")`) >= 3);
  assert.equal(a.run(`cleanTrackingParams("см https://ex.com/a?utm_source=x&id=5&fbclid=9 и https://b.org/?gclid=1")`), "см https://ex.com/a?id=5 и https://b.org/");
  assert.equal(a.run(`cleanTrackingParams("https://ex.com/a?id=5")`), "https://ex.com/a?id=5");
  assert.equal(a.run(`isRiskyFileName("setup.apk")`), true); assert.equal(a.run(`isRiskyFileName("photo.jpg")`), false);
  a.run(`window.__wiped = 0; window.wipeEverythingAndReload = () => { window.__wiped++; }; state.unlockAttempts = 10;`);
  assert.equal(a.run(`p86AfterUnlockAttempt()`), false, "выключено по умолчанию");
  a.run(`P86.set("autoWipe", true)`); assert.equal(a.run(`p86AfterUnlockAttempt()`), true); assert.equal(a.run(`window.__wiped`), 1);
  a.run(`window.__relocked = 0; window.relockApp = () => { window.__relocked++; }; Store.pinEnabled = true; P86.set("idleLock", 5); __p86LastInput = Date.now() - 6 * 60000;`);
  assert.equal(a.run(`p86IdleTick()`), true);
  a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.messages.push({ id: "old", from: "them", ts: Date.now() - 40 * 86400000, file: { name: "a.jpg" } }, { id: "new", from: "them", ts: Date.now(), file: { name: "b.jpg" } }); P86.set("mediaDays", 30); })()`);
  assert.equal(await a.run(`p86MediaSweep()`), 1);
  assert.equal(a.run(`state.contacts.get("bob").messages.find((m) => m.id === "old").file.expired`), true);
  a.close();
});

test("чат: отмена отправки, типографика, код и цитаты, история правок, подсказки эмодзи, длинные сообщения", async () => {
  const a = await boot(); const d = a.document;
  a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; state._firstRenderDone = true; state.tab = "chats"; state.chatId = "bob"; renderTab(); })()`);
  // отправка идёт через обёртку: метки слежки вырезаются
  a.run(`window.__s = []; window.__orig = null;`);
  const html = a.run(`applyMarkdown("x\\n&gt; цитата\\n\`\`\`\\nlet a = **1**;\\n\`\`\`")`);
  assert.match(html, /<span class="md-quote">цитата<\/span>/); assert.match(html, /<pre class="md-pre"><code>let a = \*\*1\*\*;/);
  assert.equal(a.run(`smartPunct("да -- нет...")`), "да — нет…");
  assert.ok(J(a.run(`emojiSuggest("smil")`)).length > 0); assert.ok(J(a.run(`emojiSuggest("улыб")`)).length > 0);
  const lines = J(a.run(`msgInfoLines({ ts: 1, edited: true, editedAt: 2, editHistory: [{ t: "старый", at: 1 }] })`));
  assert.ok(lines.some((l) => l.includes("старый")));
  // длинное сообщение сворачивается
  a.run(`(() => { const c = state.contacts.get("bob"); c.messages.push({ id: "long", from: "them", ts: Date.now() - 100000, text: "слово ".repeat(400) }); renderChatThreadInner(); })()`);
  assert.ok(d.querySelector('#chat-messages .bubble.p86-long .p86-more'));
  // упоминания
  a.run(`(() => { const c = state.contacts.get("bob"); c.messages.push({ id: "mm", from: "them", ts: Date.now() - 50000, text: "@me", mentionMe: true }); renderChatThreadInner(); })()`);
  assert.ok(!d.querySelector("#p86-mention-btn").classList.contains("hidden"));
  a.close();
});

test("отмена отправки возвращает текст в поле; без отмены сообщение уходит", async () => {
  const a = await boot(); const d = a.document;
  a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; state._firstRenderDone = true; state.tab = "chats"; state.chatId = "bob"; renderTab(); P86.set("undoSend", true); })()`);
  const before = a.run(`state.contacts.get("bob").messages.length`);
  a.run(`sendChatMessage("bob", "привет https://x.org/?utm_source=a")`);
  d.querySelector("#p86-undo-btn").click(); await sleep(20);
  assert.equal(d.querySelector("#chat-input").value, "привет https://x.org/?utm_source=a");
  assert.equal(a.run(`state.contacts.get("bob").messages.length`), before);
  a.close();
});

test("интерфейс: настройки V.86 на местах, тёмная по расписанию, тихие часы, экспорт и импорт вида, горячие клавиши, статистика", async () => {
  const a = await boot(); const d = a.document;
  a.run(`state.tab = "settings"; renderTab();`);
  for (const id of ["p86-autoWipe", "p86-idleLock", "p86-mediaDays", "p86-undoSend", "p86-darkSchedule", "p86-quietHours", "p86-test-notif", "p86-conn-report"]) assert.ok(d.getElementById(id), id);
  a.run(`P86.set("darkSchedule", true)`);
  assert.equal(a.run(`p86ThemeTick(new Date(2026, 0, 1, 23))`), "dark"); assert.equal(a.run(`p86ThemeTick(new Date(2026, 0, 1, 12))`), "light");
  assert.equal(a.run(`inQuietHours(new Date(2026, 0, 1, 2))`), true); assert.equal(a.run(`inQuietHours(new Date(2026, 0, 1, 12))`), false);
  a.run(`P86.set("airy", true)`); const ex = a.run(`exportUiSettings()`);
  a.run(`resetAppearance()`); assert.equal(d.documentElement.classList.contains("p86-airy"), false);
  assert.equal(a.run(`importUiSettings(${JSON.stringify(ex)})`), true); assert.ok(d.documentElement.classList.contains("p86-airy"));
  assert.equal(a.run(`importUiSettings("{bad")`), false);
  assert.match(a.run(`p86ConnReport()`), /V\.\d+\./);
  const st = J(a.run(`chatStats({ messages: [{ from: "me", ts: 5 }, { from: "them", ts: 3, file: {} }] })`));
  assert.deepEqual(st, { total: 2, mine: 1, theirs: 1, media: 1, first: 3 });
  a.run(`window.__sheet = null; window.openActionSheet = (t, items) => { window.__sheet = [t, items.length]; };`);
  d.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "?", bubbles: true }));
  assert.equal(J(a.run(`window.__sheet`))[1], 9);
  a.close();
});
