// Крипто-апгрейд: AAD v3 (проверенные возможности и начальный заголовок), гибрид ML-KEM-768, выравнивание размера, матрица совместимости со старым клиентом.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = nodeCrypto.webcrypto;
const CH = new Function(fs.readFileSync(path.join(__dirname, "..", "js", "crypto-helper.js"), "utf8") + "\nreturn CryptoHelper;")();
const NEW = path.join(__dirname, "..", "js", "ratchet.js"), OLD = path.join(__dirname, "fixtures", "ratchet-v79-legacy.js");
const hex = (s) => Uint8Array.from(Buffer.from(s, "hex"));

function device(id, keys, file) {
  delete require.cache[require.resolve(file)];
  const R = require(file), mem = { json: "{}" };
  R.setStore({ load: () => JSON.parse(mem.json), save: (o) => { mem.json = JSON.stringify(o); return true; } });
  return { id, R, mem, priv: keys.privateKeyJwk, pub: keys.publicKeyJwk };
}
const ctx = (me, o, x) => ({ contactId: o.id, myId: me.id, myPrivJwk: me.priv, theirPubJwk: o.pub, ...(x || {}) });
const send = (f, t, p, x) => f.R.encrypt(ctx(f, t, x), p);
const recv = (t, f, e) => t.R.decrypt(ctx(t, f), e);
const clone = (o) => JSON.parse(JSON.stringify(o));
async function pair(fa = NEW, fb = NEW) { return { a: device("alice-id", await CH.generateKeyPair(), fa), b: device("bob-id", await CH.generateKeyPair(), fb) }; }
const bundleFor = async (dev) => { const up = await dev.R.prekeyUploadPayload(3, dev.priv); return { up, get: (i = 0) => ({ spk: clone(up.spk), opk: up.opks[i] }) }; };

test("ML-KEM-768: KAT-векторы (независимая реализация OpenSSL), implicit rejection, хэш вшитого файла", () => {
  const f = path.join(__dirname, "..", "js", "vendor", "ml-kem768.js");
  const sha = nodeCrypto.createHash("sha384").update(fs.readFileSync(f)).digest("base64");
  for (const doc of ["js/vendor/THIRD_PARTY_LICENSES.md", "docs/THIRD_PARTY.md"]) assert.ok(fs.readFileSync(path.join(__dirname, "..", doc), "utf8").includes(sha), doc + " содержит SHA-384");
  require(f);
  const K = globalThis.EtherMlKem768, kat = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors", "mlkem768-kat.json"), "utf8"));
  for (const v of kat) {
    const { publicKey, secretKey } = K.keygen(hex(v.seed));
    assert.equal(publicKey.length, 1184); assert.equal(nodeCrypto.createHash("sha256").update(publicKey).digest("hex"), v.ekSha256);
    assert.equal(Buffer.from(K.decapsulate(hex(v.ct), secretKey)).toString("hex"), v.ss);
    const bad = hex(v.ct); bad[v.badIdx] ^= 1;
    assert.equal(Buffer.from(K.decapsulate(bad, secretKey)).toString("hex"), v.badCtSs, "implicit rejection совпадает с OpenSSL");
  }
});

test("Kem: бэкенд vendor; нативный WebCrypto используется только после успешной самопроверки, иначе откат", async () => {
  const R = require(NEW); R.Kem._reset();
  assert.equal(await R.Kem.backend(), "vendor");
  const k = await R.Kem.keygen(), e = await R.Kem.encaps(k.pub);
  assert.deepEqual(await R.Kem.decaps(k.seed, e.ct), e.ss);
  // исправный «нативный» WebCrypto (на самом деле вшитая реализация) принимается, неисправный — нет
  const K = globalThis.EtherMlKem768, real = globalThis.crypto.subtle;
  const mk = (broken) => ({
    generateKey: async () => { const seed = nodeCrypto.randomBytes(64), r = K.keygen(seed); return { privateKey: { seed }, publicKey: { pub: r.publicKey } }; },
    exportKey: async (fmt, key) => (fmt === "raw-seed" ? key.seed : key.pub),
    importKey: async (fmt, bytes) => (fmt === "raw-seed" ? { seed: new Uint8Array(bytes) } : { pub: new Uint8Array(bytes) }),
    encapsulateBits: async (a, key) => { const r = K.encapsulate(key.pub); const ss = Uint8Array.from(r.sharedSecret); if (broken) ss[0] ^= 1; return { ciphertext: r.cipherText, sharedKey: ss }; },
    decapsulateBits: async (a, key, ct) => K.decapsulate(new Uint8Array(ct), K.keygen(key.seed).secretKey),
  });
  for (const broken of [false, true]) {
    R.Kem._reset();
    const shim = Object.assign(Object.create(real), mk(broken));
    Object.defineProperty(globalThis.crypto, "subtle", { value: shim, configurable: true });
    try { assert.equal(await R.Kem.backend(), broken ? "vendor" : "webcrypto"); const kk = await R.Kem.keygen(), ee = await R.Kem.encaps(kk.pub); assert.deepEqual(await R.Kem.decaps(kk.seed, ee.ct), ee.ss); }
    finally { Object.defineProperty(globalThis.crypto, "subtle", { value: real, configurable: true }); }
  }
  R.Kem._reset();
});

test("производительность ML-KEM-768 в node (разумные пределы)", async () => {
  const R = require(NEW); R.Kem._reset();
  const t = [];
  let k, e; let t0 = performance.now(); k = await R.Kem.keygen(); t.push(performance.now() - t0);
  t0 = performance.now(); e = await R.Kem.encaps(k.pub); t.push(performance.now() - t0);
  t0 = performance.now(); await R.Kem.decaps(k.seed, e.ct); t.push(performance.now() - t0);
  console.log("# ML-KEM-768 keygen/encaps/decaps, мс: " + t.map((x) => x.toFixed(1)).join(" / "));
  assert.ok(t.every((x) => x < 500));
});

test("гибрид: новый<->новый, подписанный пакет -> v3 + PQ с первого сообщения; классика не затронута", async () => {
  const { a, b } = await pair(); const pb = await bundleFor(b);
  assert.ok(pb.up.spk.kem && pb.up.spk.sig2 && pb.up.spk.c === 7);
  const e1 = await send(a, b, { t: 1 }, { getBundle: async () => pb.get() });
  assert.equal(e1.a, 3); assert.equal(e1.h.c, 7); assert.equal(e1.h.p.v, 3); assert.equal(e1.h.p.k.length, 1452);
  assert.deepEqual(await recv(b, a, e1), { t: 1 });
  assert.equal(a.R.status("bob-id").pq, true); assert.equal(b.R.status("alice-id").pq, true); assert.equal(b.R.status("alice-id").sticky, 3);
  const r = await send(b, a, { t: 2 }); assert.equal(r.a, 3);
  assert.deepEqual(await recv(a, b, r), { t: 2 });
  // без KEM-ключа в пакете (classic bundle) — обычный X3DH v3 без p.k
  const c = await pair(); const up = await c.b.R.prekeyUploadPayload(1, c.b.priv); delete up.spk.kem; delete up.spk.sig2; delete up.spk.c;
  const e = await send(c.a, c.b, { x: 1 }, { getBundle: async () => ({ spk: up.spk, opk: up.opks[0] }) });
  assert.equal(e.h.p.k, undefined); assert.equal(e.a, undefined, "без подписанных caps начальный конверт прежнего формата");
  assert.deepEqual(await recv(c.b, c.a, e), { x: 1 }); assert.equal(c.a.R.status("bob-id").pq, false);
});

test("подмена: шифртекст KEM, p.v, p.k, h.c, a, h.i, ek/spk/opk -> отказ; оригинал после этого открывается", async () => {
  const { a, b } = await pair(); const pb = await bundleFor(b);
  const e = await send(a, b, { s: 1 }, { getBundle: async () => pb.get(0) });
  const muts = [
    (m) => { const k = Buffer.from(m.h.p.k, "base64"); k[10] ^= 1; m.h.p.k = k.toString("base64"); },
    (m) => { delete m.h.p.k; }, (m) => { delete m.h.p.v; }, (m) => { m.h.c = 3; }, (m) => { m.h.c = 5; }, (m) => { delete m.a; }, (m) => { m.a = 1; },
    (m) => { m.h.i = 0; }, (m) => { m.h.p.o = pb.up.opks[1].id; }, (m) => { m.h.p.o = null; },
  ];
  for (const mu of muts) { const m = clone(e); mu(m); await assert.rejects(recv(b, a, m)); }
  assert.deepEqual(await recv(b, a, e), { s: 1 });
});

test("подмена пакета сервером: убрали/подставили kem или caps -> подпись sig2 не сходится, PQ не используется, ничего не ломается", async () => {
  const { a, b } = await pair(); const pb = await bundleFor(b), other = await bundleFor((await pair()).b);
  const tampered = pb.get(); tampered.spk.kem = other.up.spk.kem; // чужой KEM-ключ
  const e = await send(a, b, { z: 1 }, { getBundle: async () => tampered });
  assert.equal(e.h.p.k, undefined, "непроверенный KEM-ключ не используется"); assert.equal(e.a, undefined);
  assert.deepEqual(await recv(b, a, e), { z: 1 });
  const { a: a2, b: b2 } = await pair(); const pb2 = await bundleFor(b2); const t2 = pb2.get(); t2.spk.c = 7 & ~1;
  const e2 = await send(a2, b2, { z: 2 }, { getBundle: async () => t2 });
  assert.equal(e2.h.p.k, undefined); assert.deepEqual(await recv(b2, a2, e2), { z: 2 });
});

test("липкость: после проверенного v3 слабый начальный конверт отвергается с предупреждением; resetTrust исправляет", async () => {
  const { a, b } = await pair(); const pb = await bundleFor(b);
  const w = []; b.R.onWarn((id, c) => w.push(c));
  await recv(b, a, await send(a, b, { n: 1 }, { getBundle: async () => pb.get() }));
  const old = device("alice-id", await CH.generateKeyPair(), OLD); old.pub = a.pub; old.priv = a.priv; // «Алиса» на старом клиенте с пустым состоянием
  const weak = await send(old, b, { w: 1 });
  await assert.rejects(recv(b, old, weak), /downgrade/); assert.deepEqual(w, ["downgrade"]);
  b.R.resetTrust("alice-id");
  assert.deepEqual(await recv(b, old, weak), { w: 1 });
});

test("матрица совместимости: старый<->новый, оба направления, с пакетом и без, много сообщений", async () => {
  for (const [fa, fb] of [[OLD, NEW], [NEW, OLD], [OLD, OLD], [NEW, NEW]]) {
    for (const withBundle of [false, true]) {
      const { a, b } = await pair(fa, fb); const x = withBundle ? { getBundle: async () => (await bundleFor(b)).get() } : {};
      assert.deepEqual(await recv(b, a, await send(a, b, { m: 1 }, x)), { m: 1 });
      for (let i = 0; i < 3; i++) {
        const r = await send(b, a, { r: i }); assert.deepEqual(await recv(a, b, r), { r: i });
        const q = await send(a, b, { q: i }); assert.deepEqual(await recv(b, a, q), { q: i });
        if (fa === OLD || fb === OLD) assert.notEqual(q.a, 3, "старый клиент: v3 не используется " + (fa === OLD) + withBundle + JSON.stringify(Object.keys(q)));
      }
    }
  }
});

test("подсказки без подписи: убрали cp/ac на пути — уровень не падает ниже проверенного, чат жив", async () => {
  const { a, b } = await pair(); const pb = await bundleFor(b);
  await recv(b, a, await send(a, b, { 1: 1 }, { getBundle: async () => pb.get() }));
  for (let i = 0; i < 3; i++) {
    const r = clone(await send(b, a, { i })); const stripped = clone(r); delete stripped.ac; delete stripped.cp;
    assert.deepEqual(await recv(a, b, stripped), { i }); // внутри сессии подсказки не нужны
    assert.equal((await send(a, b, { k: i })).a, 3, "Алиса остаётся на v3");
    await recv(b, a, await send(a, b, { k: i })).catch(() => {});
  }
});

test("выравнивание: корзины 256/1К/4К/16К/64К-шаг, длина аутентифицирована, граница PAD_MAX, только для pad1", async () => {
  const R = require(NEW);
  assert.deepEqual([1, 256, 257, 1024, 1025, 4096, 4097, 16384, 16385, 65536, 65537, 131072].map(R.padBucket), [256, 256, 1024, 1024, 4096, 4096, 16384, 16384, 65536, 65536, 131072, 131072]);
  const { a, b } = await pair(); const pb = await bundleFor(b);
  await recv(b, a, await send(a, b, { s: 1 }, { getBundle: async () => pb.get() }));
  const sizes = new Set();
  for (const n of [1, 50, 150, 700, 3000, 9000]) {
    const p = { t: "x".repeat(n) }, e = await send(a, b, p);
    sizes.add(Buffer.from(e.ct, "base64").length - 16); assert.deepEqual(await recv(b, a, e), p);
    await recv(a, b, await send(b, a, { ok: 1 }));
  }
  assert.ok([...sizes].every((s) => [256, 1024, 4096, 16384].includes(s)), [...sizes].join());
  // кадр: правка длины/нулей отвергается
  const f = R.frameEncode('{"a":1}', 7, true); assert.equal(f.length, 256);
  const bad = Uint8Array.from(f); bad[100] = 1; assert.throws(() => R.frameDecode(bad));
  const bad2 = Uint8Array.from(f); bad2[5] = 251; assert.throws(() => R.frameDecode(bad2));
  assert.equal(R.frameDecode(f).json, '{"a":1}');
  assert.equal(R.frameEncode("x".repeat(3 * 1024 * 1024), 7, true).length, 6 + 3 * 1024 * 1024, "очень большие кадры не раздуваем");
  // пир без pad1 (в подсказке/проверенных caps нет бита) — без выравнивания
  const c = await pair(); const up = await c.b.R.prekeyUploadPayload(1, c.b.priv);
  const e1 = await send(c.a, c.b, { s: 1 }, { getBundle: async () => ({ spk: up.spk, opk: up.opks[0] }) }); await recv(c.b, c.a, e1);
  const j = JSON.parse(c.a.mem.json); j.cb["bob-id"] = 1; j.cp["bob-id"] = 1; c.a.mem.json = JSON.stringify(j); c.a.R.setStore({ load: () => JSON.parse(c.a.mem.json), save: (o) => { c.a.mem.json = JSON.stringify(o); return true; } });
  const small = await send(c.a, c.b, { v: 1 }); assert.ok(Buffer.from(small.ct, "base64").length < 100, "без pad1 длина не выравнивается");
});

test("состояние v3 переживает перезапуск, а prekey добавляется к существующему spk на месте", async () => {
  const { b } = await pair(NEW, NEW);
  const j = { pk: { spk: { id: "s1", x: "x", y: "y", d: "d", t: Date.now() }, opks: {}, old: [] } }; // как у клиента V.79: нет ks
  b.mem.json = JSON.stringify(j); b.R.setStore({ load: () => JSON.parse(b.mem.json), save: (o) => { b.mem.json = JSON.stringify(o); return true; } });
  assert.equal(b.R.needsPrekeys(50), true);
  const priv = (await CH.generateKeyPair()).privateKeyJwk; const up = await b.R.prekeyUploadPayload(1, priv);
  assert.equal(up.spk.id, "s1"); assert.ok(up.spk.kem && up.spk.sig2);
});
