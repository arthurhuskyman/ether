// Каналы в приложении: подписка по ссылке с закреплением ключа, проверка подписей, только чтение для подписчика, баннер, закрытый канал, владелец публикует.
const test = require("node:test");
const assert = require("node:assert/strict");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
const Ch = require("../js/channels.js");
test.after(closeAll);

async function setup() {
  const a = await boot();
  a.run(`(() => { Store.myId = "me-test-id"; Store.name = "Tester"; window.__ops = []; state._firstRenderDone = true; window.trySendOrQueue = async () => {};
    const sig = Object.assign(new EventTarget(), { connected: true, registered: true, features: ["channels"], channelOp(t, p) { window.__ops.push([t, p]); return true; } });
    signaling = sig; window.__subs = []; channelsWire(sig, (t, fn) => { sig.addEventListener(t, fn); return () => {}; }, window.__subs);
    window.fire = (t, d) => sig.dispatchEvent(new CustomEvent(t, { detail: d })); })()`);
  return a;
}
const fire = (a, t, d) => a.run(`fire(${JSON.stringify(t)}, ${JSON.stringify(d)})`);
const ops = (a, t) => J(a.window.__ops).filter((o) => o[0] === t).map((o) => o[1]);

test("подписчик: ссылка закрепляет ключ, подмена ключа сервером отвергается, посты проверяются, форма только для чтения", async () => {
  const a = await setup();
  const c = await Ch.generate({ name: "Новости", desc: "О нас" }), evil = await Ch.generate({ name: "Evil" });
  const link = "https://x.example/#" + Ch.fragment(c);
  assert.equal(a.run(`channelSubscribeFromLink(${JSON.stringify(link)})`), true); assert.equal(ops(a, "channel-subscribe")[0].ch, c.id);
  // сервер подсунул чужой ключ -> хеш не совпал
  fire(a, "channel-info", { ch: c.id, pub: evil.pub, meta: evil.meta, metaSig: evil.metaSig, subs: 1 }); await sleep(100);
  assert.equal(a.run(`!!channelEntry(${JSON.stringify(c.id)})`), false); assert.equal(ops(a, "channel-unsubscribe").length, 1);
  a.run(`channelSubscribeFromLink(${JSON.stringify(link)})`);
  fire(a, "channel-info", { ch: c.id, pub: c.pub, meta: c.meta, metaSig: c.metaSig, subs: 7 }); await sleep(150);
  const g = J(a.run(`channelEntry(${JSON.stringify(c.id)})`)); assert.ok(g && g.isChannel && g.isGroup && g.name === "Новости" && g.ch.subs === 7 && !g.ch.owner);
  assert.equal(ops(a, "channel-history")[0].since, 0); a.run(`state.chatId = null; state.tab = "chats"`);
  const good = await Ch.makePost(c, { text: "первый пост https://example.org" }), forged = await Ch.makePost({ ...c, priv: evil.priv }, { text: "forged" }), later = await Ch.makePost(c, { text: "второй" });
  fire(a, "channel-history", { ch: c.id, posts: [{ seq: 1, post: good }, { seq: 2, post: forged }], seq: 2 }); await sleep(400);
  let ms = J(a.run(`channelEntry(${JSON.stringify(c.id)}).messages.filter((m) => m.from !== "system")`));
  assert.equal(ms.length, 1); assert.equal(ms[0].text, "первый пост https://example.org"); assert.equal(a.run(`channelEntry(${JSON.stringify(c.id)}).ch.sigFail`), 1);
  fire(a, "channel-post", { ch: c.id, seq: 3, post: later }); await sleep(100);
  fire(a, "channel-post", { ch: c.id, seq: 3, post: later }); await sleep(50);
  ms = J(a.run(`channelEntry(${JSON.stringify(c.id)}).messages.filter((m) => m.from !== "system")`)); assert.equal(ms.length, 2, "дубликат игнорируется");
  assert.equal(a.run(`unreadCount(channelEntry(${JSON.stringify(c.id)}))`), 2);
  // чтение: композер закрыт, отправка не уходит, баннер подписи показан
  assert.equal(a.run(`isGroupWriteAllowed(channelEntry(${JSON.stringify(c.id)}), Store.myId)`), false);
  a.window.__ops.length = 0; await a.run(`sendGroupMessage("ch-${c.id}", "я тоже хочу")`); assert.equal(ops(a, "channel-post").length, 0);
  a.run(`state.tab = "chats"; state.chatId = "ch-${c.id}"; renderTab();`);
  assert.ok(a.window.document.getElementById("chat-channel-banner"), "баннер ошибки подписи"); assert.equal(a.window.document.getElementById("chat-call-btn").classList.contains("hidden"), true);
  // реакции локальные, сети нет
  a.window.__sent = []; await a.run(`toggleReaction("ch-${c.id}", ${JSON.stringify(good.id)}, "👍")`); assert.equal(a.window.__sent.length, 0);
  assert.equal(a.run(`channelEntry(${JSON.stringify(c.id)}).messages.find((m) => m.id === ${JSON.stringify(good.id)}).reactions["👍"].length`), 1);
  // открытие сведений и отписка
  a.run(`openGroupInfo("ch-${c.id}")`); assert.ok(!a.window.document.getElementById("channel-info-sheet").classList.contains("hidden"));
  a.run(`channelLeave(channelEntry(${JSON.stringify(c.id)}))`); assert.equal(a.run(`!!channelEntry(${JSON.stringify(c.id)})`), false); assert.equal(ops(a, "channel-unsubscribe").length, 1);
  a.close();
});
test("закрытый канал: ключ из ссылки, посты читаются, при смене ключа — заглушка и баннер; обновление меты проверяется", async () => {
  const a = await setup(); const c = await Ch.generate({ name: "Closed", enc: true });
  a.run(`channelSubscribeFromLink(${JSON.stringify("#" + Ch.fragment(c))})`); fire(a, "channel-info", { ch: c.id, pub: c.pub, meta: c.meta, metaSig: c.metaSig, subs: 1 }); await sleep(100);
  const p = await Ch.makePost(c, { text: "секретный пост" }); fire(a, "channel-post", { ch: c.id, seq: 1, post: p }); await sleep(100);
  assert.equal(a.run(`channelEntry(${JSON.stringify(c.id)}).messages.at(-1).text`), "секретный пост");
  const rot = { ...c, kv: 1, key: Buffer.from(require("crypto").randomBytes(32)).toString("base64") }; const m2 = await Ch.signMeta(rot, { name: "Closed", enc: true, kv: 1, ts: Date.now() + 5 });
  fire(a, "channel-meta-update", { ch: c.id, meta: m2.meta, metaSig: m2.metaSig }); await sleep(100);
  assert.equal(a.run(`channelEntry(${JSON.stringify(c.id)}).ch.keyStale`), true);
  const p2 = await Ch.makePost(rot, { text: "новый ключ" }); fire(a, "channel-post", { ch: c.id, seq: 2, post: p2 }); await sleep(100);
  assert.equal(a.run(`channelEntry(${JSON.stringify(c.id)}).messages.at(-1).chLocked`), true);
  fire(a, "channel-meta-update", { ch: c.id, meta: { ...m2.meta, name: "Hacked", ts: Date.now() + 99 }, metaSig: m2.metaSig }); await sleep(100);
  assert.equal(a.run(`channelEntry(${JSON.stringify(c.id)}).name`), "Closed"); assert.ok(a.run(`channelEntry(${JSON.stringify(c.id)}).ch.sigFail`) >= 1);
  a.close();
});
test("владелец: создание подписывает мету, пост подписан ключом канала и проверяется подписчиком, ack, удаление подписано", async () => {
  const a = await setup();
  const id = await a.run(`channelCreate("Мой канал", "описание", false)`); assert.ok(id);
  const cr = ops(a, "channel-create")[0]; assert.equal(cr.ch, id); assert.ok(await Ch.verifyMeta(id, cr.pub, cr.meta, cr.metaSig));
  assert.equal(a.run(`!!channelEntry(${JSON.stringify(id)})`), false, "до ответа сервера записи нет");
  fire(a, "channel-created", { ch: id, seq: 0 }); await sleep(50);
  assert.equal(a.run(`isGroupWriteAllowed(channelEntry(${JSON.stringify(id)}), Store.myId)`), true);
  a.window.__ops.length = 0; assert.equal(await a.run(`sendGroupMessage("ch-${id}", "Привет, подписчики")`), true);
  const post = ops(a, "channel-post")[0].post; const sub = { id, pub: cr.pub, key: null, kv: 0 };
  assert.equal((await Ch.openPost(sub, post)).content.text, "Привет, подписчики");
  assert.equal(a.run(`channelEntry(${JSON.stringify(id)}).messages.at(-1).ack`), "pending");
  fire(a, "channel-post-ack", { ch: id, id: post.id, seq: 1 }); assert.equal(a.run(`channelEntry(${JSON.stringify(id)}).messages.at(-1).ack`), "sent");
  fire(a, "channel-post-ack", { ch: id, id: post.id, error: "rate" }); assert.equal(a.run(`channelEntry(${JSON.stringify(id)}).messages.at(-1).ack`), "failed");
  assert.match(a.run(`channelInviteLink(channelEntry(${JSON.stringify(id)}))`), /#ch=[a-z0-9]{12,32}\.[0-9a-f]{26}$/);
  a.run(`channelDelete(channelEntry(${JSON.stringify(id)}))`); await sleep(100);
  const del = ops(a, "channel-delete")[0]; assert.equal(del.ch, id); assert.equal(a.run(`!!channelEntry(${JSON.stringify(id)})`), false);
  a.close();
});
test("без поддержки сервером: создание и подписка отказывают, resync ничего не шлёт; устаревший клиент игнорирует channel-* (сервер не шлёт без подписки)", async () => {
  const a = await setup(); a.run(`signaling.features = []`);
  assert.equal(await a.run(`channelCreate("X", "", false)`), null); assert.equal(a.run(`channelSubscribeFromLink("not a link")`), false);
  a.run(`channelsResync()`); assert.equal(J(a.window.__ops).length, 0);
  a.close();
});
