// Стикеры: встроенные паки, свой пак, строгая проверка входящих, XSS, лимиты, отображение без пузыря, действия над сообщением.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { createApp, closeAll } = require("./harness");
const ES = require("../js/stickers.js");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted(lang) {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": lang || "ru" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.publicKey = c.publicKey || {}; state.tab = "chats"; state.chatId = "alice"; renderTab();`);
  return a;
}
const head = { jpeg: [0xff, 0xd8, 0xff, 0xe0], png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], svg: [0x3c, 0x73, 0x76, 0x67] };
const bytes = (kind, n) => { const u = new Uint8Array(n || 64); u.set(head[kind]); return u; };
const b64 = (u) => Buffer.from(u).toString("base64");
const builtinP = (o) => Object.assign({ kind: "sticker", id: "s1", ts: Date.now(), pack: "ether", sticker: "fehu" }, o || {});
const customP = (o) => Object.assign({ kind: "sticker", id: "c1", ts: Date.now(), pack: "user", sticker: "x1", mime: "image/webp", dataB64: b64(bytes("webp")) }, o || {});
const recv = async (a, p, from) => { a.run(`applyIncomingPayload(${JSON.stringify(from || "alice")}, "e-" + Math.random(), ${JSON.stringify(p)}, true)`); await sleep(80); };
const msgs = (a, id) => JSON.parse(a.run(`JSON.stringify(state.contacts.get(${JSON.stringify(id || "alice")}).messages)`));

test("встроенные паки: ≥2 набора по ≥12 стикеров, есть «Мессенджер», SVG без скриптов и внешних ссылок", () => {
  assert.ok(ES.PACKS.length >= 2);
  assert.ok(ES.PACKS.some((p) => p.id === "ether" && p.name.ru === "Мессенджер"));
  for (const p of ES.PACKS) {
    assert.ok(p.items.length >= 12, p.id);
    for (const it of p.items) {
      const svg = it.svg();
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.ok(!/<script|href=|xlink|<image|<foreignObject|on\w+=/i.test(svg), p.id + "/" + it.id);
      assert.ok(ES.dataUrl(p.id, it.id).startsWith("data:image/svg+xml"));
      assert.ok(it.name.en && it.name.ru);
    }
  }
});

test("validateIncoming: встроенный, неизвестный id → заглушка, мусор отбрасывается", () => {
  assert.deepEqual(ES.validateIncoming(builtinP()).sticker, { pack: "ether", id: "fehu" });
  assert.equal(ES.validateIncoming(builtinP({ sticker: "nope" })).sticker.unknown, true);
  assert.equal(ES.validateIncoming(builtinP({ pack: "future" })).sticker.unknown, true);
  const bad = [null, 5, {}, builtinP({ id: "../x" }), builtinP({ id: "" }), builtinP({ id: "a".repeat(65) }), builtinP({ pack: "<img>" }), builtinP({ pack: "ETHER" }), builtinP({ sticker: "<svg onload=1>" }),
    builtinP({ sticker: 5 }), builtinP({ groupId: "g" }), builtinP({ dataB64: b64(bytes("webp")) }), builtinP({ mime: "image/png" })];
  for (const p of bad) assert.equal(ES.validateIncoming(p).ok, false, JSON.stringify(p));
});

test("validateIncoming: пользовательский — mime, сигнатура, размер, base64, только растр", () => {
  const ok = ES.validateIncoming(customP());
  assert.ok(ok.ok && ok.sticker.custom && ok.sticker.mime === "image/webp");
  for (const [mime, k] of [["image/png", "png"], ["image/jpeg", "jpeg"]]) assert.ok(ES.validateIncoming(customP({ mime, dataB64: b64(bytes(k)) })).ok);
  const bad = [
    customP({ mime: "image/svg+xml", dataB64: b64(bytes("svg")) }), customP({ mime: "image/gif", dataB64: b64(bytes("gif")) }), customP({ mime: "text/html" }), customP({ mime: undefined }),
    customP({ mime: "image/png" }),                                     // сигнатура не совпадает
    customP({ dataB64: b64(bytes("webp", 64 * 1024 + 1)) }),            // больше 64 КБ
    customP({ dataB64: "!!!notbase64!!!!!!!!" }), customP({ dataB64: "AAAA" }), customP({ dataB64: 123 }), customP({ dataB64: undefined }),
  ];
  for (const p of bad) assert.equal(ES.validateIncoming(p).ok, false, JSON.stringify(p).slice(0, 80));
  assert.ok(ES.validateIncoming(customP({ dataB64: b64(bytes("webp", 64 * 1024)) })).ok, "ровно 64 КБ допустимо");
  assert.equal(ES.validateIncoming(customP({ w: 99999, h: -3 })).sticker.w, 0);
});

test("приём встроенного: лента без пузыря, alt/aria-label, подпись «Стикер», реакция и ответ работают", async () => {
  const a = await booted(); const d = a.document;
  await recv(a, builtinP());
  const m = msgs(a)[0];
  assert.deepEqual(m.sticker, { pack: "ether", id: "fehu" }); assert.equal(m.from, "them"); assert.match(m.text, /Стикер/);
  a.run(`renderChatThread()`); await sleep(60);
  const b = d.querySelector('.bubble[data-msg-id="s1"]');
  assert.ok(b && b.classList.contains("bubble-sticker"));
  const img = b.querySelector("img.sticker-img");
  assert.ok(img && img.getAttribute("src").startsWith("data:image/svg+xml") && /Руна Fehu/.test(img.alt) && img.width === 160);
  // реакция
  a.run(`applyReaction("alice", { kind: "reaction", id: "s1", emoji: "👍" })`); await sleep(40);
  assert.ok(msgs(a)[0].reactions && msgs(a)[0].reactions["👍"], "реакция записана");
  // ответ: цитата берётся из текста сообщения
  a.run(`state.replyTo = { msgId: "s1", text: "x", from: "them", authorName: "Alice" }`);
  await a.run(`sendChatMessage("alice", "ок", state.replyTo)`);
  assert.equal(msgs(a).find((x) => x.text === "ок").replyTo.id, "s1");
  // удаление у себя
  a.run(`deleteMessageLocal("alice", "s1")`);
  assert.equal(msgs(a).some((x) => x.id === "s1"), false);
  a.close();
});

test("неизвестный стикер показывается заглушкой, без падения", async () => {
  const a = await booted(); const d = a.document;
  await recv(a, builtinP({ id: "u9", pack: "future", sticker: "z1" }));
  a.run(`renderChatThread()`); await sleep(40);
  const b = d.querySelector('.bubble[data-msg-id="u9"]');
  assert.ok(b && b.querySelector(".sticker-missing") && !b.querySelector("img"));
  a.close();
});

test("XSS: HTML в id/паке/подписи не попадает в сообщение и в DOM", async () => {
  const a = await booted(); const d = a.document;
  await recv(a, builtinP({ id: "x1", sticker: '"><img src=x onerror=window.__pwn=1>' }));
  await recv(a, builtinP({ id: "x2", pack: '<svg onload=window.__pwn=1>' }));
  await recv(a, builtinP({ id: '<b>x3</b>' }));
  await recv(a, builtinP({ id: "x4", text: "<img src=x onerror=window.__pwn=1>", name: "<script>window.__pwn=1</script>", replyTo: { id: "q", text: "<b>", authorName: "<i>" } }));
  a.run(`renderChatThread()`); await sleep(60);
  assert.equal(msgs(a).length, 1, "принято только корректное");
  assert.ok(!d.querySelector("#chat-messages img[onerror], #chat-messages script, #chat-messages b"));
  assert.equal(a.window.__pwn, undefined);
  a.close();
});

test("пользовательский входящий: хранится в IDB как вложение, показывается картинкой; удаление чистит IDB", async () => {
  const a = await booted(); const d = a.document;
  await recv(a, customP());
  assert.ok(await a.run(`IDB.get("file:c1").then((b) => !!b && b.size === 64)`));
  a.run(`renderChatThread()`); await sleep(120);
  const slot = d.querySelector('.sticker-slot[data-sticker-file="c1"]');
  assert.ok(slot && slot.getAttribute("role") === "img" && slot.getAttribute("aria-label"));
  assert.ok(slot.querySelector("img.sticker-img"), "картинка подставлена");
  a.run(`deleteMessageLocal("alice", "c1")`); await sleep(60);
  assert.equal(await a.run(`IDB.get("file:c1").then((b) => !b)`), true);
  a.close();
});

test("невалидные пользовательские, дубль, заблокированный, группа и поток отбрасываются", async () => {
  const a = await booted();
  await recv(a, customP({ id: "b1", mime: "image/svg+xml", dataB64: b64(bytes("svg")) }));
  await recv(a, customP({ id: "b2", mime: "image/png" }));
  await recv(a, customP({ id: "b3", dataB64: b64(bytes("webp", 70000)) }));
  assert.equal(msgs(a).length, 0);
  await recv(a, builtinP({ id: "d1" })); await recv(a, builtinP({ id: "d1" }));
  assert.equal(msgs(a).length, 1, "дубль по id не добавляется");
  await recv(a, builtinP({ id: "g1", groupId: "alice" }));
  assert.equal(msgs(a).length, 1);
  a.run(`ensureContactEntry("bob", "Bob").blocked = true`);
  await recv(a, builtinP({ id: "bl1" }), "bob");
  assert.equal(msgs(a, "bob").length, 0);
  // лимит частоты: не больше RATE_MAX в минуту от одного контакта
  for (let i = 0; i < ES.RATE_MAX + 15; i++) a.run(`applyIncomingPayload("alice", "e${i}", ${JSON.stringify(builtinP({ id: "r" + i }))}, true)`);
  await sleep(300);
  const n = msgs(a).filter((m) => m.id.startsWith("r")).length;
  assert.ok(n <= ES.RATE_MAX && n > 0, "принято " + n);
  a.close();
});

test("отправка встроенного: сообщение в ленте и payload kind:sticker (id пака + id стикера), недавние", async () => {
  const a = await booted();
  a.run(`window.__sent = []; trySendOrQueue = async (c, id, p) => { window.__sent.push(p); };`);
  assert.equal(await a.run(`EtherStickers.send("alice", "mood", "fire")`), true);
  const p = JSON.parse(a.run(`JSON.stringify(window.__sent[0])`));
  assert.equal(p.kind, "sticker"); assert.equal(p.pack, "mood"); assert.equal(p.sticker, "fire"); assert.ok(!("dataB64" in p));
  const m = msgs(a)[0]; assert.deepEqual(m.sticker, { pack: "mood", id: "fire" }); assert.equal(m.from, "me");
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify(EtherStickers.recents())`)), ["mood/fire"]);
  assert.equal(await a.run(`EtherStickers.send("alice", "mood", "nonexistent")`), false);
  a.close();
});

test("свой пак: добавить, отправить (dataB64 ≤ 64 КБ), переименовать, в избранное, удалить", async () => {
  const a = await booted();
  a.run(`window.__sent = []; trySendOrQueue = async (c, id, p) => { window.__sent.push(p); };`);
  const id = await a.run(`EtherStickers.addBlob(new Blob([new Uint8Array([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50,1,2,3,4])], { type: "image/webp" }), "котик")`);
  assert.ok(id);
  assert.equal(await a.run(`EtherStickers.addBlob(new Blob(["<svg onload=1></svg>"], { type: "image/svg+xml" }))`), null, "svg не хранится как стикер");
  assert.equal(await a.run(`EtherStickers.addBlob(new Blob([new Uint8Array(100)], { type: "image/webp" }))`), null, "без сигнатуры");
  assert.equal(await a.run(`EtherStickers.addBlob(new Blob([new Uint8Array([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50].concat(new Array(62000).fill(1)))], { type: "image/webp" }))`), null, "больше 60 КБ");
  assert.equal(await a.run(`EtherStickers.send("alice", "user", ${JSON.stringify(id)})`), true);
  const p = JSON.parse(a.run(`JSON.stringify(window.__sent[0])`));
  assert.equal(p.pack, "user"); assert.equal(p.mime, "image/webp"); assert.ok(p.dataB64.length <= Math.ceil(65536 * 4 / 3));
  assert.ok(ES.validateIncoming(Object.assign({ kind: "sticker" }, p)).ok, "то, что мы шлём, проходит проверку получателя");
  assert.equal(a.run(`EtherStickers.renameUser(${JSON.stringify(id)}, "Кот")`), true);
  assert.equal(a.run(`EtherStickers.label("user", ${JSON.stringify(id)})`), "Кот");
  assert.equal(a.run(`EtherStickers.toggleFav("user", ${JSON.stringify(id)})`), true);
  assert.equal(a.run(`EtherStickers.favorites().length`), 1);
  await a.run(`EtherStickers.removeUser(${JSON.stringify(id)})`);
  assert.equal(a.run(`EtherStickers.userItems().length`), 0);
  assert.equal(a.run(`EtherStickers.favorites().length`), 0, "избранное чистится вместе со стикером");
  assert.equal(await a.run(`IDB.get("file:sticker:" + ${JSON.stringify(id)}).then((b) => !b)`), true);
  a.close();
});

test("панель: пункт «Стикеры» в меню «+», кнопка в эмодзи-панели, вкладки, aria, отправка по тапу", async () => {
  const a = await booted("en"); const d = a.document;
  const menu = d.querySelectorAll("#composer-menu-sheet .composer-menu-item:not(.composer-recent)");
  assert.equal(menu.length, 8);
  assert.ok(d.querySelector("#chat-sticker-btn") && d.querySelector("#emoji-sticker-btn"));
  a.run(`window.__sent = []; trySendOrQueue = async (c, id, p) => { window.__sent.push(p); };`);
  d.querySelector("#chat-sticker-btn").click(); await sleep(150);
  const sheet = d.querySelector("#sticker-picker-sheet");
  assert.ok(!sheet.classList.contains("hidden"));
  const tabs = Array.from(d.querySelectorAll("#sticker-tabs .sticker-tab"));
  assert.ok(tabs.length >= 6 && tabs.every((t) => t.getAttribute("aria-label")));
  d.querySelector('[data-stab="ether"]').click(); await sleep(100);
  const btns = d.querySelectorAll("#sticker-grid .sticker-btn");
  assert.ok(btns.length >= 12 && btns[0].getAttribute("aria-label") && btns[0].querySelector("img").alt);
  btns[0].click(); await sleep(150);
  assert.ok(sheet.classList.contains("hidden"));
  assert.equal(a.run(`window.__sent[0].pack`), "ether");
  a.close();
});

test("группа: стикер не рассылается; кнопка/пересылка в личный чат создаёт копию", async () => {
  const a = await booted();
  a.run(`window.__sent = []; trySendOrQueue = async (c, id, p) => { window.__sent.push(p); }; const g = { id: "grp1", isGroup: true, name: "G", members: [{ id: "me-test-id" }, { id: "alice" }], messages: [], lastActivity: Date.now() }; state.contacts.set("grp1", g);`);
  assert.equal(await a.run(`EtherStickers.send("grp1", "ether", "fehu")`), false);
  await recv(a, builtinP({ id: "f1" }));
  a.run(`ensureContactEntry("carol", "Carol")`);
  await a.run(`forwardMessage("f1", "alice", "carol")`); await sleep(100);
  const fm = msgs(a, "carol")[0];
  assert.ok(fm.sticker && fm.sticker.id === "fehu" && fm.forwarded);
  assert.equal(a.run(`window.__sent.at(-1).kind`), "sticker");
  a.close();
});

test("скины и calm: стикер без фона пузыря, тень по скину, анимация выключается", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "css", "styles.css"), "utf8");
  assert.match(css, /\.bubble-row \.bubble\.bubble-sticker\s*\{[^}]*background: transparent !important/);
  assert.match(css, /html\[data-skin="neon"\] \{ --sticker-shadow/);
  assert.match(css, /html\[data-calm-mode="1"\] \.bubble-sticker \.sticker-img/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.bubble-sticker/);
});

test("i18n: ключи стикеров есть в en и ru", () => {
  for (const l of ["en", "ru"]) {
    const s = fs.readFileSync(path.join(__dirname, "..", "js", "lang", l + ".js"), "utf8");
    for (const k of ["sticker.menu", "sticker.label", "sticker.alt", "sticker.unknown", "sticker.noGroup", "sticker.add", "sticker.tab.fav", "sticker.tab.recent", "sticker.myPack"]) assert.ok(s.includes('"' + k + '"'), l + ":" + k);
  }
});
