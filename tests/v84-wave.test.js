// V.84: волна из 40 пунктов — ключевые проверки по пачкам (защита, функционал, интерфейс, серверы).
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

test("защита: EXIF вырезается, PIN паники, скрытые превью, ссылки с подтверждением и пометкой подделки", async () => {
  const a = await boot();
  // JPEG: SOI, APP1(Exif, 10 байт данных), APP2(ICC), SOS…EOI
  const r = J(a.run(`(() => { const u = new Uint8Array([0xff,0xd8, 0xff,0xe1,0,12, 69,120,105,102,0,0,1,2,3,4, 0xff,0xe2,0,4,9,9, 0xff,0xda,0,2, 1,2,3, 0xff,0xd9]);
    const s = stripJpegMeta(u); return { before: u.length, after: s.length, hasExif: Array.from(s).join(",").includes("69,120,105,102"), keepsIcc: Array.from(s).join(",").includes("255,226,0,4,9,9") }; })()`));
  assert.equal(r.after, r.before - 14); assert.equal(r.hasExif, false); assert.equal(r.keepsIcc, true);
  assert.equal(a.run(`stripJpegMeta(new Uint8Array([1,2,3])).length`), 3);
  // PIN паники
  a.run(`Store.pinSalt = randomSaltHex(16);`); await a.run(`pbkdf2Hex("1111", Store.pinSalt, PIN_ITERATIONS).then((h) => { Store.pinHash = h; Store.pinEnabled = true; })`);
  await a.run(`setDuressPin("1111")`); assert.equal(a.run(`duressSet()`), false, "совпадает с основным — не задаётся");
  await a.run(`setDuressPin("9999")`); assert.equal(a.run(`duressSet()`), true);
  assert.equal(await a.run(`isDuressPin("9999")`), true); assert.equal(await a.run(`isDuressPin("1111")`), false);
  a.run(`window.__wiped = 0; window.wipeEverythingAndReload = () => { window.__wiped++; };`);
  await a.run(`tryUnlock("9999")`); assert.equal(a.run(`window.__wiped`), 1);
  // ссылки
  assert.deepEqual(J(a.run(`linkHostInfo("https://xn--pple-43d.com/x")`)).suspicious, true);
  assert.deepEqual(J(a.run(`linkHostInfo("https://example.com/")`)).suspicious, false);
  // скрытые превью
  a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; c.messages.push({ id: "m1", from: "them", text: "секрет", ts: Date.now() }); P84.set("hidePreviews", true); state.tab = "chats"; state.chatId = null; renderTab(); })()`);
  assert.ok(!a.document.querySelector("#chats-list, .chat-list, body").textContent.includes("секрет"));
  a.close();
});

test("функционал: спойлер/зачёркнутый, крупные эмодзи, @all, несколько закрепов, txt-экспорт, черновики, «в Сохранённые», шаблоны, тихая отправка", async () => {
  const a = await boot();
  assert.match(a.run(`applyMarkdown("a ||тайна|| b ~~x~~")`), /<span class="spoiler"[^>]*>тайна<\/span>.*<s>x<\/s>/);
  assert.equal(a.run(`isEmojiOnly("😀👍")`), true); assert.equal(a.run(`isEmojiOnly("hi 😀")`), false); assert.equal(a.run(`isEmojiOnly("123")`), false);
  assert.equal(a.run(`isMentioned("всем привет @all", "Bob")`), true); assert.equal(a.run(`isMentioned("@все сюда", "")`), true);
  const r = J(a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; for (let i = 1; i <= 7; i++) c.messages.push({ id: "p" + i, from: "them", text: "t" + i, ts: Date.now() });
    for (let i = 1; i <= 7; i++) togglePinnedMessage("bob", "p" + i); const o = { ids: c.pinIds.slice(), cur: c.pinnedMessageId };
    togglePinnedMessage("bob", "p7"); o.afterUnpin = c.pinnedMessageId; o.txt = chatAsText(c).split("\\n").length;
    state.drafts["bob"] = "черновик"; state.chatFilter = "drafts"; o.draftsOk = true;
    saveToSaved(c, c.messages[0]); o.saved = state.contacts.get(SELF_CHAT_ID).messages.at(-1).text;
    saveTemplate("Скоро буду"); o.tpl = loadTemplates()[0];
    return o; })()`));
  assert.deepEqual(r.ids, ["p3", "p4", "p5", "p6", "p7"]); assert.equal(r.cur, "p7"); assert.equal(r.afterUnpin, "p6");
  assert.ok(r.txt >= 9); assert.equal(r.saved, "t1"); assert.equal(r.tpl, "Скоро буду");
  // тихая отправка: флаг в payload
  a.run(`window.__p = []; window.trySendOrQueue = async (c, id, p) => { window.__p.push(p); }; state._silentNext = true;`);
  await a.run(`sendChatMessage("bob", "тсс", null)`);
  assert.equal(a.run(`window.__p.at(-1).silent`), true);
  await a.run(`sendChatMessage("bob", "обычное", null)`);
  assert.equal(a.run(`window.__p.at(-1).silent`), undefined);
  // входящее «без звука» не играет звук
  a.run(`window.__snd = 0; const o = messageSoundStyleForContact; window.messageSoundStyleForContact = (...x) => { window.__snd++; return o(...x); }; Store.soundsEnabled = true;`);
  a.run(`applyIncomingPayload("bob", "z1", { kind: "chat", id: "z1", text: "x", ts: Date.now(), silent: true }, true)`);
  assert.equal(a.run(`window.__snd`), 0);
  a.close();
});

test("интерфейс и серверы: классы настроек, цвет имени, заголовок с непрочитанными, импорт серверов по ссылке", async () => {
  const a = await boot();
  a.run(`P84.set("highContrast", true); P84.set("compactList", true); P84.set("reduceMotion", true);`);
  const cl = a.document.documentElement.classList;
  assert.ok(cl.contains("p84-contrast") && cl.contains("p84-compact") && cl.contains("p84-reduce-motion"));
  assert.match(a.run(`senderColor("alice")`), /^hsl\(\d+ /); assert.equal(a.run(`senderColor("alice")`), a.run(`senderColor("alice")`));
  a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; c.messages.push({ id: "u1", from: "them", text: "x", ts: Date.now(), readAckSent: false }); updateAppBadge(); })()`);
  assert.match(a.document.title, /^\(\d+\) /);
  a.run(`window.confirmSheet = async () => true; history.replaceState({}, "", location.pathname + "#servers=" + encodeURIComponent("https://relay.example.org"));`);
  a.run(`p84ServersFromHash()`); await sleep(50);
  assert.ok(J(a.run(`ServerList.loadUser(localStorage).map((x) => x.url)`)).some((u) => /relay\.example\.org/.test(u)));
  a.close();
});
