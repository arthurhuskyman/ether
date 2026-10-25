// Каналы (js/channels.js): подписи постов/меты, закрепление ключа по хешу, шифрование ключом канала, ссылки, совместимость с серверным модулем.
const test = require("node:test");
const assert = require("node:assert/strict");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const nodeCrypto = require("crypto");
const Ch = require("../js/channels.js");
const Srv = require("../signaling-server/channels.js");

test("создание: мета подписана, хеш ключа стабилен, ссылка разбирается (с ключом и без)", async () => {
  const c = await Ch.generate({ name: "Новости", desc: "О канале", enc: false });
  assert.match(c.id, Ch.ID_RE); assert.equal(c.pubHash, await Ch.pubHash(c.pub)); assert.equal(c.key, null);
  assert.ok(await Ch.verifyMeta(c.id, c.pub, c.meta, c.metaSig));
  assert.ok(!(await Ch.verifyMeta(c.id, c.pub, { ...c.meta, name: "Подмена" }, c.metaSig)));
  const l = Ch.parseLink("https://x.example/app/#" + Ch.fragment(c));
  assert.deepEqual(l, { id: c.id, hash: c.pubHash, key: null });
  const e = await Ch.generate({ name: "Closed", enc: true });
  const le = Ch.parseLink(Ch.fragment(e)); assert.equal(le.key, e.key); assert.equal(Ch.fragment(e).split(".").length, 3);
  assert.equal(Ch.parseLink("ch=short.zzz"), null); assert.equal(Ch.parseLink(""), null);
});
test("пост: подпись владельца проходит, чужой ключ/подмена тела/другой канал/ts отвергаются", async () => {
  const c = await Ch.generate({ name: "N" }), other = await Ch.generate({ name: "O" });
  const sub = { id: c.id, pub: c.pub, key: null, kv: 0 };
  const p = await Ch.makePost(c, { text: "Привет, мир" });
  const r = await Ch.openPost(sub, p); assert.ok(r.ok); assert.equal(r.content.text, "Привет, мир");
  assert.equal((await Ch.openPost(sub, { ...p, body: p.body.replace("Привет", "Взлом!") })).reason, "bad-sig");
  assert.equal((await Ch.openPost(sub, { ...p, ts: p.ts + 1 })).reason, "bad-sig");
  assert.equal((await Ch.openPost({ ...sub, id: other.id }, p)).reason, "bad-sig");
  assert.equal((await Ch.openPost({ ...sub, pub: other.pub }, p)).reason, "bad-sig");
  const forged = await Ch.makePost({ ...c, priv: other.priv }, { text: "forged" });
  assert.equal((await Ch.openPost(sub, forged)).reason, "bad-sig"); // подписан чужим ключом — клиент отбрасывает, даже если сервер пропустил
});
test("закрытый канал: шифртекст без ключа не читается, неверный ключ/версия отвергаются, AAD привязывает пост", async () => {
  const c = await Ch.generate({ name: "Closed", enc: true });
  const p = await Ch.makePost(c, { text: "секрет", media: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", name: "a.png" } });
  assert.ok(p.enc && p.iv && !p.body.includes("секрет"));
  const sub = { id: c.id, pub: c.pub, key: c.key, kv: 0 };
  const r = await Ch.openPost(sub, p); assert.equal(r.content.text, "секрет"); assert.equal(r.content.media.name, "a.png");
  const noKey = await Ch.openPost({ ...sub, key: null }, p); assert.ok(noKey.ok && noKey.content === null && noKey.reason === "no-key");
  const bad = await Ch.generate({ name: "x", enc: true });
  assert.equal((await Ch.openPost({ ...sub, key: bad.key }, p)).reason, "auth");
  assert.equal((await Ch.openPost({ ...sub, kv: 1 }, p)).reason, "no-key"); // после смены ключа старый подписчик новых постов не читает
  const swapped = { ...p, id: "z".repeat(24) }; swapped.sig = nodeCrypto.randomBytes(64).toString("base64");
  assert.ok(!(await Ch.openPost(sub, swapped)).ok);
});
test("совместимость с сервером: сервер принимает пост/мету клиента и проверяет те же байты", async () => {
  const c = await Ch.generate({ name: "Compat | name", desc: "d\nx", enc: true });
  const sent = []; let T = Date.now();
  const m = Srv.create({ safeSend: (ws, o) => sent.push(o), clientsGet: () => null, now: () => T });
  const ws = {}; const last = (t) => sent.filter((o) => o.type === t).pop();
  m.onMessage(ws, { type: "channel-create", ch: c.id, pub: c.pub, meta: c.meta, metaSig: c.metaSig }, "own");
  assert.ok(!last("channel-created").error, JSON.stringify(last("channel-created")));
  for (const content of [{ text: "a" }, { text: "b|c\nd", media: { dataUrl: "data:image/png;base64,AAAA" } }]) {
    const p = await Ch.makePost(c, content, T);
    m.onMessage(ws, { type: "channel-post", ch: c.id, post: p }, "own");
    assert.ok(!last("channel-post-ack").error, JSON.stringify(last("channel-post-ack")));
  }
  m.onMessage(ws, { type: "channel-subscribe", ch: c.id }, "sub");
  const inf = last("channel-info"); assert.ok(await Ch.verifyMeta(c.id, inf.pub, inf.meta, inf.metaSig));
  assert.equal(await Ch.pubHash(inf.pub), c.pubHash);
  m.onMessage(ws, { type: "channel-history", ch: c.id }, "sub");
  const h = last("channel-history"); assert.equal(h.posts.length, 2);
  for (const { post } of h.posts) assert.ok((await Ch.openPost({ id: c.id, pub: inf.pub, key: c.key, kv: 0 }, post)).ok);
  const dl = await Ch.signDelete(c, T); m.onMessage(ws, { type: "channel-delete", ch: c.id, ...dl }, "own");
  assert.ok(last("channel-deleted") && !last("channel-deleted").error);
});
test("аватар: хеш входит в подпись меты, подмена картинки отвергается", async () => {
  const c = await Ch.generate({ name: "A", avatar: "data:image/png;base64,AAAA" });
  assert.ok(c.meta.av && c.meta.avatar);
  assert.ok(await Ch.verifyMeta(c.id, c.pub, c.meta, c.metaSig));
  assert.ok(!(await Ch.verifyMeta(c.id, c.pub, { ...c.meta, avatar: "data:image/png;base64,BBBB" }, c.metaSig)));
  assert.ok(!(await Ch.generate({ name: "B", avatar: "javascript:alert(1)" })).meta.avatar);
});
test("слишком большой пост и мусорное медиа не принимаются", async () => {
  const c = await Ch.generate({ name: "N" });
  await assert.rejects(Ch.makePost(c, { text: "x".repeat(8000), media: { dataUrl: "data:image/png;base64," + "A".repeat(Ch.MAX_MEDIA) } }).then(async (p) => { assert.ok(!JSON.parse(p.body).m); throw new Error("ok-trimmed"); }), /ok-trimmed/);
  assert.equal(Ch.unpackContent("not json"), null); assert.equal(Ch.unpackContent('{"v":2}'), null);
});
