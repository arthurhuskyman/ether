// Фото-истории: публикация, приём с жёсткой проверкой, просмотр, ответ, срок жизни 24 ч, XSS через подпись.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted(lang) {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": lang || "ru" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.publicKey = c.publicKey || {}; state.tab = "chats"; state.chatId = null; renderTab(); renderChatsList();`);
  return a;
}
const bytes = (kind, n) => {
  const head = { jpeg: [0xff, 0xd8, 0xff, 0xe0], png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], svg: [0x3c, 0x73, 0x76, 0x67] }[kind];
  const u = new Uint8Array(n || 64); u.set(head); return u;
};
const b64 = (u) => Buffer.from(u).toString("base64");
const photoPayload = (o) => Object.assign({ kind: "story", id: "ph1", text: "подпись", bg: 1, ts: Date.now(), mime: "image/jpeg", w: 100, h: 200, dataB64: b64(bytes("jpeg")) }, o || {});
const recv = (a, p, from) => { a.run(`applyIncomingPayload(${JSON.stringify(from || "alice")}, "e-" + Math.random(), ${JSON.stringify(p)}, true)`); return sleep(60); };
const stories = (a, owner) => JSON.parse(a.run(`JSON.stringify(loadStories().filter((s) => s.owner === ${JSON.stringify(owner)}))`));

test("приём фото-истории: хранится как вложение, показывается в просмотрщике с подписью, ответ цитирует", async () => {
  const a = await booted(); const d = a.document;
  await recv(a, photoPayload());
  const st = stories(a, "alice"); assert.equal(st.length, 1);
  assert.equal(st[0].text, "подпись"); assert.equal(st[0].photo.mime, "image/jpeg"); assert.equal(st[0].photo.w, 100);
  assert.ok(await a.run(`IDB.get("file:story:alice:ph1").then((b) => !!b && b.size === 64)`), "данные в IDB (общий путь file: → шифрование под PIN)");
  a.run(`renderChatsList()`);
  d.querySelector('[data-story-owner="alice"]').click();
  await sleep(60);
  const img = d.querySelector("#story-photo");
  assert.ok(!img.classList.contains("hidden") && img.getAttribute("src"), "фото показано");
  assert.equal(d.querySelector("#story-text").textContent, "подпись");
  assert.ok(d.querySelector("#story-viewer").classList.contains("has-photo"));
  assert.ok(!d.querySelector("#story-reply").classList.contains("hidden"), "ответ доступен");
  d.querySelector("#story-reply-input").value = "Красиво!";
  d.querySelector("#story-reply").dispatchEvent(new a.window.Event("submit", { cancelable: true, bubbles: true }));
  await sleep(100);
  assert.match(a.run(`JSON.stringify(state.contacts.get("alice").messages.map((m) => [m.text, m.replyTo && m.replyTo.text]))`), /Красиво!.*подпись/);
  a.close();
});

test("фото без подписи допустимо; текстовая история без фото работает как раньше", async () => {
  const a = await booted();
  await recv(a, photoPayload({ id: "ph2", text: "" }));
  await recv(a, { kind: "story", id: "t1", text: "просто текст", bg: 0, ts: Date.now() });
  assert.equal(stories(a, "alice").length, 2);
  assert.equal(stories(a, "alice").find((s) => s.id === "ph2").text, "");
  assert.equal(stories(a, "alice").find((s) => s.id === "t1").photo, undefined);
  a.close();
});

test("невалидные входящие фото отбрасываются: mime, сигнатура, размер, base64, id, источник", async () => {
  const a = await booted();
  const bad = [
    photoPayload({ id: "b1", mime: "image/svg+xml", dataB64: b64(bytes("svg")) }),
    photoPayload({ id: "b2", mime: "text/html" }),
    photoPayload({ id: "b3", mime: "image/gif", dataB64: b64(bytes("gif")) }),          // не из белого списка
    photoPayload({ id: "b4", mime: "image/png" }),                                       // mime не совпадает с байтами
    photoPayload({ id: "b5", dataB64: b64(bytes("jpeg", 600 * 1024)) }),                // больше потолка
    photoPayload({ id: "b6", dataB64: "не base64!!" }),
    photoPayload({ id: "b7", dataB64: 12345 }),
    photoPayload({ id: "b8", dataB64: "" }),
    photoPayload({ id: "b9", dataB64: undefined, text: "" }),                          // mime есть, данных нет, подписи нет
    photoPayload({ id: "../../x" }),
    photoPayload({ id: "b" + "x".repeat(80) }),
    photoPayload({ id: "b11", ts: Date.now() - 25 * 3600e3 }),                          // уже просрочена
    photoPayload({ id: "b12", mime: ["image/jpeg"] }),
  ];
  for (const p of bad) await recv(a, p);
  await recv(a, photoPayload({ id: "b13" }), "stranger");                               // не контакт
  assert.equal(stories(a, "alice").length, 0, JSON.stringify(stories(a, "alice").map((s) => s.id)));
  assert.equal(stories(a, "stranger").length, 0);
  assert.equal(await a.run(`IDB.get("file:story:alice:b4").then((b) => !!b)`), false, "ничего не записано в IDB");
  // размеры в метаданных — мусор → обнуляются, но фото принимается
  await recv(a, photoPayload({ id: "ok1", w: 99999, h: -5 }));
  const ok = stories(a, "alice")[0]; assert.equal(ok.photo.w, 0); assert.equal(ok.photo.h, 0);
  // заблокированный контакт
  a.run(`state.contacts.get("alice").blocked = true`);
  await recv(a, photoPayload({ id: "blk" }));
  assert.equal(stories(a, "alice").length, 1);
  a.close();
});

test("чужой id не затирает чужие данные и дубли не плодятся; лимит историй на отправителя", async () => {
  const a = await booted();
  a.run(`state.contacts.get("alice").messages.push({ id: "msg1", from: "me", text: "x", ts: Date.now() })`);
  await a.run(`IDB.set("file:msg1", new Blob(["secret-file"], { type: "text/plain" }))`);
  await recv(a, photoPayload({ id: "msg1" }));
  assert.equal(await a.run(`IDB.get("file:msg1").then((b) => b.size)`), 11, "вложение не перезаписано");
  await recv(a, photoPayload({ id: "dup" })); await recv(a, photoPayload({ id: "dup" }));
  assert.equal(stories(a, "alice").filter((s) => s.id === "dup").length, 1);
  for (let i = 0; i < 25; i++) await recv(a, photoPayload({ id: "many" + i, ts: Date.now() - (30 - i) * 1000 }));
  assert.ok(stories(a, "alice").length <= 20, "не больше 20 историй от одного контакта");
  a.close();
});

test("подпись и имя: XSS не выполняется (textContent), HTML не разбирается", async () => {
  const a = await booted(); const d = a.document;
  const evil = `<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>`;
  a.run(`state.contacts.get("alice").name = ${JSON.stringify(evil)}`);
  await recv(a, photoPayload({ id: "xss", text: evil }));
  a.run(`renderChatsList()`);
  d.querySelector('[data-story-owner="alice"]').click();
  await sleep(60);
  assert.equal(d.querySelector("#story-text").textContent, evil.slice(0, 280));
  assert.equal(d.querySelector("#story-text").children.length, 0);
  assert.equal(d.querySelector("#story-who").children.length, 0);
  assert.equal(d.querySelector("#stories-row img[onerror]"), null);
  assert.equal(a.window.__pwn, undefined);
  assert.ok(a.run(`loadStories()[0].text.length`) <= 280);
  a.close();
});

test("публикация фото: ограничения, рассылка по каналу историй, удаление данных по TTL и вручную", async () => {
  const a = await booted(); const d = a.document;
  a.run(`window.__sent = []; trySendOrQueue = async (c, id, p) => { window.__sent.push({ to: c.id, p }); };`);
  const mk = (type, n) => `{ blob: new Blob([new Uint8Array(${JSON.stringify(Array.from(bytes("jpeg", n)))})], { type: ${JSON.stringify(type)} }), w: 640, h: 480 }`;
  assert.equal(await a.run(`publishStory("", 0, ${mk("image/png", 64)})`), false, "только JPEG после сжатия");
  assert.equal(await a.run(`publishStory("", 0, { blob: new Blob([], { type: "image/jpeg" }) })`), false, "пустой файл");
  assert.equal(await a.run(`publishStory("", 0, ${mk("image/jpeg", 513 * 1024)})`), false, "слишком большой");
  assert.equal(a.run(`window.__sent.length`), 0);
  assert.equal(await a.run(`publishStory("  вид с горы  ", 3, ${mk("image/jpeg", 2048)})`), true);
  const sent = a.run(`JSON.stringify(window.__sent)`); const p = JSON.parse(sent)[0].p;
  assert.equal(p.kind, "story"); assert.equal(p.text, "вид с горы"); assert.equal(p.mime, "image/jpeg");
  assert.equal(Buffer.from(p.dataB64, "base64").length, 2048);
  const mine = stories(a, "me")[0]; assert.ok(mine.photo && mine.photo.size === 2048);
  assert.equal(await a.run(`IDB.get("file:" + ${JSON.stringify(mine.id)}).then((b) => b.size)`), 2048);
  // очередь отправки не раздувается: фото уходит в IDB-ключ, а не в localStorage
  assert.ok(a.run(`slimPayload(${JSON.stringify(p)}).idbKey`) === "file:" + mine.id);
  // подпись длиннее 280 режется
  assert.equal(await a.run(`publishStory(${JSON.stringify("я".repeat(400))}, 0, ${mk("image/jpeg", 100)})`), true);
  assert.equal(JSON.parse(a.run(`JSON.stringify(window.__sent)`)).pop().p.text.length, 280);
  // TTL: просроченная своя фото-история удаляется вместе с данными
  a.run(`loadStories().find((s) => s.id === ${JSON.stringify(mine.id)}).ts = Date.now() - 25 * 3600e3; pruneStories();`);
  await sleep(40);
  assert.equal(stories(a, "me").some((s) => s.id === mine.id), false);
  assert.equal(await a.run(`IDB.get("file:" + ${JSON.stringify(mine.id)}).then((b) => !!b)`), false, "данные удалены по сроку");
  // просрочка принятой
  await recv(a, photoPayload({ id: "rx" }));
  a.run(`loadStories().find((s) => s.id === "rx").ts = Date.now() - 30 * 3600e3; pruneStories();`);
  await sleep(40);
  assert.equal(await a.run(`IDB.get("file:story:alice:rx").then((b) => !!b)`), false);
  // ручное удаление из просмотрщика
  const other = stories(a, "me")[0];
  a.run(`renderStoriesRow()`); d.querySelector('[data-story-owner="__new__"]').click(); await sleep(60);
  d.querySelector("#story-delete-btn").click(); await sleep(40);
  assert.equal(stories(a, "me").some((s) => s.id === other.id), false);
  assert.equal(await a.run(`IDB.get("file:" + ${JSON.stringify(other.id)}).then((b) => !!b)`), false);
  a.close();
});

test("композер: выбор фото, предпросмотр, удаление, публикация только с фото; невалидный файл", async () => {
  const a = await booted(); const d = a.document;
  a.run(`window.__sent = []; trySendOrQueue = async (c, id, p) => { window.__sent.push(p); };
    window.createImageBitmap = async () => ({ width: 3000, height: 2000, close() {} });
    HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {}, set fillStyle(v) {} });
    HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])], { type: "image/jpeg" })); };`);
  a.run(`openStoryComposer()`);
  assert.ok(d.querySelector("#story-photo-pick").offsetParent !== undefined);
  assert.equal(d.querySelector("#story-photo-preview").classList.contains("hidden"), true);
  // SVG и не-картинки не принимаются
  await a.run(`pickStoryPhoto(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }))`);
  assert.equal(d.querySelector("#story-photo-preview").classList.contains("hidden"), true);
  await a.run(`pickStoryPhoto(new File(["x"], "a.pdf", { type: "application/pdf" }))`);
  assert.equal(d.querySelector("#story-photo-preview").classList.contains("hidden"), true);
  await a.run(`pickStoryPhoto(new File(["data"], "p.jpg", { type: "image/jpeg" }))`);
  assert.equal(d.querySelector("#story-photo-preview").classList.contains("hidden"), false);
  assert.equal(d.querySelector("#story-input").placeholder, "Добавьте подпись…");
  d.querySelector("#story-photo-remove").click();
  assert.equal(d.querySelector("#story-photo-preview").classList.contains("hidden"), true);
  await a.run(`pickStoryPhoto(new File(["data"], "p.jpg", { type: "image/jpeg" }))`);
  d.querySelector("#story-publish-btn").click(); await sleep(150);
  assert.ok(d.querySelector("#story-sheet").classList.contains("hidden"), "опубликовано без текста");
  assert.equal(a.run(`window.__sent.length`) >= 1, true);
  assert.equal(a.run(`window.__sent[0].kind`), "story");
  // без фото и без текста — не публикуется
  a.run(`openStoryComposer()`); d.querySelector("#story-publish-btn").click(); await sleep(50);
  assert.ok(!d.querySelector("#story-sheet").classList.contains("hidden"));
  a.close();
});

test("сжатие: слишком большое/ошибочное изображение → null; интерфейс и i18n", async () => {
  const a = await booted("en");
  a.run(`window.createImageBitmap = async () => { throw new Error("bad"); }`);
  assert.equal(await a.run(`prepareStoryPhoto(new File(["x"], "a.jpg", { type: "image/jpeg" })).then((r) => r)`), null);
  assert.equal(await a.run(`prepareStoryPhoto(null)`), null);
  assert.equal(await a.run(`prepareStoryPhoto(new File([""], "a.jpg", { type: "image/jpeg" }))`), null);
  for (const k of ["stories.photo.pick", "stories.photo.camera", "stories.photo.remove", "stories.photo.bad", "stories.photo.alt", "stories.caption.placeholder"]) assert.notEqual(a.run(`T(${JSON.stringify(k)})`), k);
  assert.ok(a.document.querySelector("#story-photo-camera").textContent.includes("Take photo"));
  a.close();
});
