// Векторы протокола v1 (tests/vectors/protocol-v1.json, генератор tools/gen-protocol-vectors.js): расшифровка/проверка НАСТОЯЩИМ кодом js/*.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = nodeCrypto.webcrypto;
const ROOT = path.join(__dirname, "..");
const V = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors", "protocol-v1.json"), "utf8"));
const CHJ = new Function(fs.readFileSync(path.join(ROOT, "js", "crypto-helper.js"), "utf8") + "\nreturn CryptoHelper;")();
require(path.join(ROOT, "js", "vendor", "ml-kem768.js"));
const fresh = (f) => { const p = path.join(ROOT, "js", f); delete require.cache[require.resolve(p)]; return require(p); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const IDK = V.identities;
const full = (j) => ({ kty: "EC", crv: "P-256", ...j });

function device(preset) {
  const R = fresh("ratchet.js"), mem = { json: JSON.stringify(preset || {}) };
  R.setStore({ load: () => JSON.parse(mem.json), save: (o) => { mem.json = JSON.stringify(o); return true; } });
  return { R, mem };
}
const cx = (me, other) => ({ contactId: IDK[other].id, myId: IDK[me].id, myPrivJwk: IDK[me].privateKeyJwk, theirPubJwk: IDK[other].publicKeyJwk });

for (const sc of V.ratchet) {
  test("вектор ratchet: " + sc.name, async () => {
    const dev = {};
    for (const id of sc.order) {
      const m = sc.messages[id];
      if (m.stateBefore) dev[m.to] = device(m.stateBefore); // состояние получателя перед этим конвертом (содержит его эфемерные ключи, полученные при прошлых шагах)
      const got = await dev[m.to].R.decrypt(cx(m.to, m.from), clone(m.envelope));
      assert.deepEqual(got, m.plain, id);
    }
  });
}

test("вектор ratchet: AAD и заголовок защищены (подмена a / h.i / h.p / h.c / ct ломает расшифровку)", async () => {
  const sc = V.ratchet.find((r) => r.name === "x3dh-v3-pq-reorder"), m = sc.messages.a2;
  const tweaks = [(e) => { e.a = 1; }, (e) => { e.h.c = 3; }, (e) => { e.h.p.s = "zzz"; }, (e) => { e.h.p.k = e.h.p.k.slice(0, -4) + "AAAA"; }, (e) => { e.h.i = 1; e.h.n = 7; }, (e) => { e.ct = e.ct.slice(0, -4) + "AAAA"; }];
  for (const t of tweaks) {
    const d = device(m.stateBefore), e = clone(m.envelope); t(e);
    await assert.rejects(d.R.decrypt(cx("bob", "alice"), e));
  }
  const d = device(m.stateBefore); // исходный конверт открывается, а повтор отвергается
  assert.deepEqual(await d.R.decrypt(cx("bob", "alice"), clone(m.envelope)), m.plain);
  await assert.rejects(d.R.decrypt(cx("bob", "alice"), clone(m.envelope)));
});

test("вектор ratchet: уровень AAD «липкий» — после v3 начальный конверт слабее отвергается", async () => {
  const pq = V.ratchet.find((r) => r.name === "x3dh-v3-pq-reorder"), weak = V.ratchet.find((r) => r.name === "x3dh-classic");
  const d = device(pq.messages.a2.stateBefore);
  for (const id of pq.order.slice(0, 3)) await d.R.decrypt(cx("bob", "alice"), clone(pq.messages[id].envelope));
  assert.equal(d.R.status(IDK.alice.id).sticky, 3);
  await assert.rejects(d.R.decrypt(cx("bob", "alice"), clone(weak.messages.a1.envelope)), /downgrade/);
});

test("вектор: подписи prekey (sig, sig2) проверяются, подмена id/ключа/kem — нет", async () => {
  const R = fresh("ratchet.js"), spk = V.prekeys.upload.spk, pub = V.prekeys.spkVerify.publicKeyJwk;
  assert.equal(await R.verifySpk(pub, spk), true);
  assert.equal(await R.verifySpk2(pub, spk), true);
  assert.equal(await R.verifySpk(pub, { ...spk, id: spk.id + "x" }), false);
  assert.equal(await R.verifySpk2(pub, { ...spk, c: spk.c ^ 4 }), false);
  assert.equal(await R.verifySpk2(pub, { ...spk, kem: spk.kem.slice(0, -4) + "AAAA" }), false);
  assert.equal(spk.kem.length, 1580);
});

test("вектор env2: статический ECDH + AES-GCM, AAD привязывает направление и пару id", async () => {
  const e = V.env2, key = await CHJ.deriveSharedKey(IDK.bob.privateKeyJwk && full(IDK.bob.privateKeyJwk), full(IDK.alice.publicKeyJwk));
  assert.deepEqual(await CHJ.decryptJson(key, e.v2, CHJ.envAad(e.from, e.to)), e.plain);
  assert.deepEqual(await CHJ.decryptJson(key, e.v1), e.plain);
  await assert.rejects(CHJ.decryptJson(key, e.v2, CHJ.envAad(e.to, e.from)));
  await assert.rejects(CHJ.decryptJson(key, e.v2));
  await assert.rejects(CHJ.decryptJson(key, { ...e.v2, v: 3 }), /unsupported/);
});

test("вектор: safety number симметричен и совпадает", async () => {
  const a = await CHJ.computeSafetyNumber(full(IDK.alice.publicKeyJwk), full(IDK.bob.publicKeyJwk)), b = await CHJ.computeSafetyNumber(full(IDK.bob.publicKeyJwk), full(IDK.alice.publicKeyJwk));
  assert.deepEqual(a, V.safetyNumber.groups); assert.deepEqual(b, a); assert.equal(a.length, 12);
});

test("вектор Sender Keys: цепочка, подпись, порядок 1,0,2, подмена и повтор отвергаются", async () => {
  const s = V.senderKeys, G = fresh("groupkeys.js"), mem = { j: "{}" };
  G.setStore({ load: () => JSON.parse(mem.j), save: (o) => { mem.j = JSON.stringify(o); return true; } });
  assert.equal(G.acceptDistribution(s.gid, s.sender, clone(s.distribution)), true);
  for (const i of s.order) assert.equal(await G.decrypt(s.gid, s.sender, clone(s.envelopes[i])), s.plains[i]);
  await assert.rejects(G.decrypt(s.gid, s.sender, clone(s.envelopes[0])), /old/);
  const G2 = fresh("groupkeys.js"); G2.setStore({ load: () => ({}), save: () => true });
  G2.acceptDistribution(s.gid, s.sender, clone(s.distribution));
  await assert.rejects(G2.decrypt(s.gid, "mallory", clone(s.envelopes[0])), /no-chain/);
  await assert.rejects(G2.decrypt(s.gid, s.sender, { ...clone(s.envelopes[0]), n: 1 }), /bad-sig/);
  await assert.rejects(G2.decrypt(s.gid + "x", s.sender, clone(s.envelopes[0])));
  G.flush(); G2.flush();
});

test("вектор каналов: мета и посты подписаны, ссылка #ch= разбирается, закрытый канал расшифровывается ключом из ссылки", async () => {
  const C = fresh("channels.js");
  for (const k of ["public", "private"]) {
    const c = V.channels[k];
    assert.equal(await C.pubHash(c.pub), c.pubHash);
    assert.equal(await C.verifyMeta(c.id, c.pub, c.meta, c.metaSig), true);
    const link = C.parseLink(c.link);
    assert.equal(link.id, c.id); assert.equal(link.hash, c.pubHash);
    const ch = { id: c.id, pub: c.pub, key: link.key, kv: c.kv };
    const r = await C.openPost(ch, c.post);
    assert.equal(r.ok, true); assert.equal(r.content.text, c.text);
    assert.equal((await C.openPost(ch, { ...c.post, body: c.post.body + "A" })).ok, false);
    assert.equal((await C.openPost({ ...ch, id: c.id + "x" }, c.post)).ok, false);
  }
  assert.equal(V.channels.public.link.includes(".", V.channels.public.link.indexOf(".") + 1), false, "у открытого канала в ссылке нет ключа");
  assert.equal((await C.openPost({ id: V.channels.private.id, pub: V.channels.private.pub, key: null, kv: 0 }, V.channels.private.post)).reason, "no-key");
});

test("вектор filebin1: кадр [0xEB][1][idLen][flags][index][len][crc][id][data], CRC32 IEEE", () => {
  const BF = fresh("bigfile.js"), f = V.filebin1, payload = Uint8Array.from(Buffer.from(f.payloadHex, "hex"));
  assert.equal(BF.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(Buffer.from(new Uint8Array(BF.encodeFrame(f.id, f.index, payload, true))).toString("hex"), f.frameCrcHex);
  assert.equal(Buffer.from(new Uint8Array(BF.encodeFrame(f.id, f.index, payload, false))).toString("hex"), f.frameNoCrcHex);
  const d = BF.decodeFrame(Uint8Array.from(Buffer.from(f.frameCrcHex, "hex")).buffer);
  assert.deepEqual({ id: d.id, index: d.index, length: d.length, crc: d.crc, hasCrc: d.hasCrc, valid: d.valid }, { id: f.id, index: f.index, length: 40, crc: f.crc, hasCrc: true, valid: true });
  assert.equal(BF.decodeFrame(Uint8Array.from(Buffer.from(f.frameCrcHex.slice(0, -2), "hex")).buffer).valid, false);
});

test("вектор claim: SHA-256(\"ether-claim-v1|\"+token) в hex", () => {
  assert.equal(nodeCrypto.createHash("sha256").update("ether-claim-v1|" + V.claim.token).digest("hex"), V.claim.proof);
});

test("PROTOCOL-V1.md не расходится с кодом: ключевые константы и метки доменов упомянуты", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "PROTOCOL-V1.md"), "utf8");
  for (const s of ["ether-dr1", "ether-dr2", "ether-dr3", "ether-dr-rk", "ether-dr-aead", "ether-dr-x3dh-v3", "ether-spk-v1", "ether-spk-v2", "ether-env-v2", "ether-sk1", "ether-chpost-v1", "ether-chmeta-v1", "ether-chdel-v1", "ether-chenc-v1", "ether-claim-v1",
    "MAX_SKIP", "ML-KEM-768", "filebin1", "prekey-upload", "prekey-fetch", "gdeliver", "linkcall-create", "call-ring", "tests/vectors/protocol-v1.json"]) assert.ok(doc.includes(s), "нет в спецификации: " + s);
  const src = fs.readFileSync(path.join(ROOT, "js", "ratchet.js"), "utf8");
  assert.match(src, /MAX_SKIP = 200/); assert.ok(doc.includes("200"));
});
