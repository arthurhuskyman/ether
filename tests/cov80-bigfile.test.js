// Редкие ветки js/bigfile.js (на коде из js/bundle.core.js, см. cov80-bundle-loader.js): помощники, хранилища, квота, отказы получателя, враждебные кадры, сторона отправителя.
require("./cov80-bundle-loader").install();
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const { BF, sleep, until, SynthBlob, fakeOpfs, mkHub } = require("./fix80-bigfile-helpers");

const UNIT = BF.UNIT;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SIZE = 100000, TOTAL = Math.ceil(SIZE / UNIT);
const DATA = crypto.randomBytes(SIZE), HASH = sha(DATA);
const meta = (o) => Object.assign({ kind: "file-meta", bin: 1, id: "c-1", name: "a.bin", mime: "application/octet-stream", size: SIZE, totalChunks: TOTAL, u: UNIT, h: HASH, crc: 0 }, o);
const frame = (id, idx, len, crc, data) => BF.encodeFrame(id, idx, (data || DATA).subarray(idx * UNIT, idx * UNIT + len), !!crc);
const tr = (sent, extra) => Object.assign({ isOpen: () => true, sendJson: (p) => { sent.push(p); return true; }, sendBinary: () => true, bufferedAmount: () => 0, whenLow: async () => true }, extra || {});
function rx(opts) { const R = mkHub(opts); R.sent = []; R.bind("P", tr(R.sent)); return R; }
const kinds = (R) => R.sent.map((m) => m.kind + (m.reason ? ":" + m.reason : ""));
const lenOf = (idx) => Math.min(UNIT, SIZE - idx * UNIT);
const withGlobal = async (name, value, fn) => { const d = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); try { return await fn(); } finally { if (d) Object.defineProperty(globalThis, name, d); else delete globalThis[name]; } };

test("кадры: decodeFrame на view/смещении, мусор и враждебные заголовки", () => {
  const ab = BF.encodeFrame("abc", 3, new Uint8Array([1, 2, 3]), true);
  const big = new Uint8Array(ab.byteLength + 10); big.set(new Uint8Array(ab), 5);
  const f = BF.decodeFrame(new Uint8Array(big.buffer, 5, ab.byteLength));
  assert.equal(f.id, "abc"); assert.equal(f.index, 3); assert.ok(f.valid); assert.ok(f.hasCrc); assert.deepEqual([...f.payload], [1, 2, 3]);
  assert.ok(BF.decodeFrame(new DataView(ab)));
  for (const bad of [null, undefined, "str", 5, {}, new Uint8Array(10)]) assert.equal(BF.decodeFrame(bad), null);
  const mk = (patch) => { const u = new Uint8Array(ab.slice(0)); patch(u); return u; };
  assert.equal(BF.decodeFrame(mk((u) => { u[0] = 0; })), null);
  assert.equal(BF.decodeFrame(mk((u) => { u[1] = 2; })), null);
  assert.equal(BF.decodeFrame(mk((u) => { u[2] = 0; })), null);
  assert.equal(BF.decodeFrame(mk((u) => { u[2] = 65; })), null);
  const longId = new Uint8Array(17); longId[0] = 0xeb; longId[1] = 1; longId[2] = 64; assert.equal(BF.decodeFrame(longId), null);
  assert.equal(BF.decodeFrame(new Uint8Array(ab).subarray(0, 18)), null);
  const noCrc = BF.decodeFrame(BF.encodeFrame("x", 0, new Uint8Array(2), false)); assert.equal(noCrc.hasCrc, false); assert.equal(noCrc.crc, 0);
});

test("Sha256/crc32/missingRanges: границы блоков паддинга и быстрый пропуск полных байтов", () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const d = crypto.randomBytes(n), h = new BF.Sha256(); h.update(d.subarray(0, Math.floor(n / 3))); h.update(d.subarray(Math.floor(n / 3)));
    assert.equal(h.digest(), sha(d), "len " + n);
  }
  assert.equal(BF.crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(BF.crc32(Buffer.from("6789"), BF.crc32(Buffer.from("12345"))), 0xcbf43926, "продолжение по prev");
  const b = BF.bmNew(40); for (let i = 0; i < 16; i++) { b[i >> 3] |= 1 << (i & 7); } b[3] = 0b101;
  assert.deepEqual(BF.missingRanges(b, 40, 10), [[16, 24], [25, 26], [27, 40]]); assert.deepEqual(BF.missingRanges(b, 40, 2), [[16, 24], [25, 26]]);
  assert.deepEqual(BF.missingRanges(new Uint8Array([255, 255, 255]), 24, 5), []);
  assert.deepEqual(BF.missingRanges(BF.bmNew(40), 40, 1), [[0, 40]]);
});

test("safeFileName / validateMeta / chooseFilePath: все ветки", () => {
  assert.equal(BF.safeFileName(null), "file"); assert.equal(BF.safeFileName(undefined), "file"); assert.equal(BF.safeFileName(" ..  "), "file");
  assert.equal(BF.safeFileName("a‮b/c:d.txt"), "ab_c_d.txt"); assert.equal(BF.safeFileName("CON.txt"), "_CON.txt"); assert.equal(BF.safeFileName("lpt1"), "_lpt1");
  const long = BF.safeFileName("x".repeat(200) + ".jpeg"); assert.equal(long.length, 120); assert.ok(long.endsWith(".jpeg"));
  const long2 = BF.safeFileName("y".repeat(200)); assert.equal(long2.length, 120);
  const long3 = BF.safeFileName("z".repeat(200) + ".verylongext123"); assert.equal(long3.length, 120);
  const lim = { maxSize: 1e6 };
  const ok = { id: "a", size: 100, u: UNIT, totalChunks: 1, h: "0".repeat(64), name: "n", mime: "m" };
  assert.equal(BF.validateMeta(ok, lim), null);
  assert.equal(BF.validateMeta(null, lim), "id"); assert.equal(BF.validateMeta({ ...ok, id: 5 }, lim), "id"); assert.equal(BF.validateMeta({ ...ok, id: "a b" }, lim), "id");
  assert.equal(BF.validateMeta({ ...ok, size: 0 }, lim), "size"); assert.equal(BF.validateMeta({ ...ok, size: 2e6 }, lim), "size"); assert.equal(BF.validateMeta({ ...ok, size: 1.5 }, lim), "size");
  assert.equal(BF.validateMeta({ ...ok, u: 1 }, lim), "layout"); assert.equal(BF.validateMeta({ ...ok, totalChunks: 2 }, lim), "layout");
  assert.equal(BF.validateMeta({ ...ok, h: 5 }, lim), "hash"); assert.equal(BF.validateMeta({ ...ok, h: "G".repeat(64) }, lim), "hash");
  assert.equal(BF.validateMeta({ ...ok, name: 1 }, lim), "meta"); assert.equal(BF.validateMeta({ ...ok, mime: null }, lim), "meta");
  assert.equal(BF.chooseFilePath({ size: 10, smallMax: 100, maxSize: 1000 }), "legacy-p2p");
  assert.equal(BF.chooseFilePath({ size: 2000, smallMax: 100, maxSize: 1000 }), "too-large");
  assert.equal(BF.chooseFilePath({ size: 500, smallMax: 100, maxSize: 1000, peerFileBin: false }), "unsupported");
  assert.equal(BF.chooseFilePath({ size: 500, smallMax: 100, maxSize: 1000, peerFileBin: true }), "binary");
});

test("readBytes: запасной FileReader (успех/ошибка), hashBlob с прогрессом", async () => {
  class FR { readAsArrayBuffer(p) { setImmediate(() => { if (p.fail) { this.error = new Error("fr"); this.onerror(); } else { this.result = new Uint8Array([7, 8]).buffer; this.onload(); } }); } }
  await withGlobal("FileReader", FR, async () => {
    const blob = { slice: (a, b) => ({ fail: false }) }; assert.deepEqual([...await BF.readBytes(blob, 0, 2)], [7, 8]);
    await assert.rejects(BF.readBytes({ slice: () => ({ fail: true }) }, 0, 2), /fr/);
  });
  const calls = []; const b = new Blob([DATA]);
  assert.equal(await BF.hashBlob(b, (n) => calls.push(n), 40000), HASH); assert.deepEqual(calls, [40000, 80000, 100000]);
  assert.equal(await BF.hashBlob(b), HASH);
});

test("MemoryStore: потолок памяти; IdbStore: нет IndexedDB, запись/чтение/поток/abort, откат с Blob на буфер", async () => {
  await assert.rejects(BF.MemoryStore.open({ size: 100 }, { memoryCap: 10 }), /memory cap/);
  await assert.rejects(BF.MemoryStore.open({ size: BF.DEFAULTS.memoryCap + 1 }), /memory cap/);
  const m = await BF.MemoryStore.open({ size: 5 }); await m.write(0, new Uint8Array([1, 2, 3, 4, 5])); assert.equal(m.commitDue(), false); await m.flush();
  assert.equal(await (await m.blob("x/y")).text(), "\x01\x02\x03\x04\x05"); await m.abort();
  await assert.rejects(BF.IdbStore.open({ id: "q" }), /no idb/);
  const f = new IDBFactory(), o = { idb: f, keyRange: IDBKeyRange };
  const st = await BF.IdbStore.open({ id: "s1" }, o);
  const parts = [DATA.subarray(0, UNIT), DATA.subarray(UNIT, 2 * UNIT), DATA.subarray(2 * UNIT, 3 * UNIT)].map((p) => new Uint8Array(p)); // копии: Buffer.slice() делит общий пул
  await st.write(0, parts[0]);
  const real = st.db.transaction.bind(st.db); let fail = 1; st.db.transaction = (...a) => { if (fail-- > 0) throw new Error("tx boom"); return real(...a); };
  await st.write(UNIT, parts[1]); assert.equal(st.useBlob, false, "после сбоя пишем ArrayBuffer");
  await st.write(2 * UNIT, parts[2]);
  st.db.transaction = real;
  const got = []; await st.readSeq(3 * UNIT, (u8) => got.push(Buffer.from(u8)));
  assert.equal(Buffer.concat(got).compare(DATA.subarray(0, 3 * UNIT)), 0);
  assert.equal(Buffer.from(await (await st.blob("a/b")).arrayBuffer()).compare(DATA.subarray(0, 3 * UNIT)), 0);
  const rd = st.stream().getReader(), chunks = []; for (;;) { const r = await rd.read(); if (r.done) break; chunks.push(Buffer.from(r.value)); }
  assert.equal(Buffer.concat(chunks).compare(DATA.subarray(0, 3 * UNIT)), 0);
  const st2 = await BF.IdbStore.open({ id: "s2" }, { idb: new IDBFactory(), keyRange: IDBKeyRange }); st2.useBlob = false; st2.db.transaction = () => { throw new Error("always"); };
  await assert.rejects(st2.write(0, parts[0]), /always/);
  const st3 = await BF.IdbStore.open({ id: "s3" }, { idb: new IDBFactory(), keyRange: IDBKeyRange }); const real3 = st3.db.transaction.bind(st3.db); st3.db.transaction = () => { throw new Error("twice"); };
  await assert.rejects(st3.write(0, parts[0]), /twice/); st3.db.transaction = real3;
  await st.abort(); await st3.abort();
});

test("IdbMetaDb: без IDBKeyRange список берётся целиком; с ним — по префиксу", async () => {
  const f = new IDBFactory();
  const a = new BF.IdbMetaDb(f, IDBKeyRange); await a.set("in:1", { x: 1 }); await a.set("out:1", { y: 2 });
  assert.deepEqual((await a.list("in:")).map((x) => x[0]), ["in:1"]); assert.deepEqual(await a.get("in:1"), { x: 1 });
  await a.del("in:1"); assert.equal(await a.get("in:1"), undefined);
  const b = new BF.IdbMetaDb(f, null); b.KR = null; assert.ok((await b.list("zzz")).length >= 1);
});

test("opfs.supported: все отрицательные ветки; FileHandleStore: abort с abort()/close(), size, readSeq, blob", async () => {
  assert.equal(BF.opfs.supported({}), false); assert.equal(BF.opfs.supported({ navigator: {} }), false);
  assert.equal(BF.opfs.supported({ navigator: { storage: {} } }), false);
  assert.equal(BF.opfs.supported({ navigator: { storage: { getDirectory() {} } } }), false);
  assert.equal(BF.opfs.supported({ navigator: { storage: { getDirectory() {} } }, FileSystemFileHandle: { prototype: {} } }), false);
  assert.equal(BF.opfs.supported({ navigator: { storage: { getDirectory() {} } }, FileSystemFileHandle: { prototype: { createWritable() {} } } }), true);
  assert.equal(BF.opfs.supported({ get navigator() { throw new Error("x"); } }), false);
  assert.equal(BF.opfs.supported(), BF.opfs.supported(globalThis));
  const ofs = fakeOpfs();
  const st = await BF.opfs.open({ id: "o1" }, { global: ofs.global });
  await st.write(0, DATA.subarray(0, UNIT)); await st.write(UNIT, DATA.subarray(UNIT, SIZE)); assert.equal(await st.size(), SIZE);
  const seq = []; await st.readSeq(SIZE, (u8) => seq.push(Buffer.from(u8))); assert.equal(Buffer.concat(seq).compare(DATA), 0);
  assert.equal((await st.blob("a/b")).size, SIZE);
  await st.write(0, DATA.subarray(0, 4)); await st.abort(); assert.equal(require("fs").existsSync(ofs.fileOf("o1")), false); await st.abort();
  let closed = 0; const st2 = new BF.FileHandleStore("fsa", { createWritable: async () => ({ write: async () => {}, close: async () => { closed++; } }) });
  await st2.write(0, new Uint8Array(1)); await st2.abort(); assert.equal(closed, 1);
  const st3 = new BF.FileHandleStore("fsa", { createWritable: async () => ({ write: async () => {}, abort: async () => { closed += 10; }, close: async () => {} }) });
  await st3.write(0, new Uint8Array(1)); await st3.abort(); assert.equal(closed, 11);
  assert.equal(st3.commitDue(1, 1), false); assert.equal(st3.commitDue(9 * 1024 * 1024, 1), true);
});

test("квота по умолчанию: нет navigator.storage, estimate бросает, нулевая квота, persist бросает/нет, нехватка места", async () => {
  const quotaOf = async (nav, need) => withGlobal("navigator", nav, async () => { const R = rx({ order: ["memory"], limits: { quotaMargin: 0 } }); await R.handleJson("P", meta({ id: "q-" + Math.random().toString(36).slice(2, 8), size: need, totalChunks: Math.ceil(need / UNIT) })); return kinds(R); });
  assert.ok(!(await quotaOf(undefined, 1000)).includes("file-reject:quota"));
  assert.ok(!(await quotaOf({}, 1000)).includes("file-reject:quota"));
  assert.ok(!(await quotaOf({ storage: {} }, 1000)).includes("file-reject:quota"));
  assert.ok(!(await quotaOf({ storage: { estimate: async () => { throw new Error("e"); } } }, 1000)).includes("file-reject:quota"));
  assert.ok(!(await quotaOf({ storage: { estimate: async () => null } }, 1000)).includes("file-reject:quota"));
  assert.ok(!(await quotaOf({ storage: { estimate: async () => ({ quota: 0 }) } }, 1000)).includes("file-reject:quota"));
  assert.ok(!(await quotaOf({ storage: { estimate: async () => ({ quota: 1e9 }), persist() { throw new Error("p"); } } }, 1000)).includes("file-reject:quota"));
  assert.ok(!(await quotaOf({ storage: { estimate: async () => ({ quota: 1e9, usage: 1 }), persist() {} } }, 1000)).includes("file-reject:quota"));
  assert.ok((await quotaOf({ storage: { estimate: async () => ({ quota: 5000, usage: 4500 }) } }, 1000)).includes("file-reject:quota"));
});

test("получатель: отказы onMeta (false/бросок), квота, хранилище, лимиты, конфликт и повтор meta", async () => {
  let R = rx({ onMeta: async () => false }); await R.handleJson("P", meta()); assert.deepEqual(kinds(R), ["file-reject:declined"]);
  R = rx({ onMeta: async () => { throw new Error("ui"); } }); await R.handleJson("P", meta()); assert.deepEqual(kinds(R), ["file-reject:declined"]);
  R = rx({ onMeta: async () => true, quota: async () => false }); await R.handleJson("P", meta());
  assert.deepEqual(kinds(R), ["file-reject:quota"]); assert.ok(R.events.some((e) => e.reason === "quota" && e.fresh));
  R = rx({ order: ["nope"] }); await R.handleJson("P", meta()); assert.deepEqual(kinds(R), ["file-reject:storage"]);
  R = rx({ order: ["bad"], stores: { bad: async () => { throw new Error("disk"); } } }); await R.handleJson("P", meta()); assert.deepEqual(kinds(R), ["file-reject:storage"]); assert.equal(R.sin.size, 0);
  R = rx({ limits: { maxInTotal: 1 } }); await R.handleJson("P", meta({ id: "a1" })); await R.handleJson("P", meta({ id: "a2" }));
  assert.deepEqual(kinds(R).filter((k) => k.startsWith("file-reject")), ["file-reject:limit"]);
  R = rx({ limits: { maxInActive: 1 } }); await R.handleJson("P", meta({ id: "a1" })); await R.handleJson("P", meta({ id: "a2" }));
  assert.deepEqual(kinds(R).filter((k) => k.startsWith("file-reject")), ["file-reject:busy"]);
  // повтор meta: тот же отправитель — продолжаем, чужой/другой размер — конфликт, пауза локальная — отвечаем file-pause
  R = rx(); await R.handleJson("P", meta()); const n = R.sent.length;
  await R.handleJson("P", meta()); assert.equal(R.sent.length, n, "недавний запрос уже в пути — второй не шлём");
  R.bind("Q", tr(R.sent)); await R.handleJson("Q", meta()); assert.equal(kinds(R).at(-1), "file-reject:conflict");
  await R.handleJson("P", meta({ size: SIZE - 1, totalChunks: TOTAL })); assert.equal(kinds(R).at(-1), "file-reject:conflict");
  R.pause("c-1"); const n2 = R.sent.length; await R.handleJson("P", meta()); assert.equal(R.sent.length, n2 + 1); assert.equal(R.sent.at(-1).kind, "file-pause");
  R.sin.get("c-1").remotePaused = true; R.sin.get("c-1").lastReq = -1e9; await R.handleJson("P", meta()); assert.equal(R.sin.get("c-1").state, "active");
  R.sin.get("c-1").dead = true; const n3 = R.sent.length; await R.handleJson("P", meta()); assert.equal(R.sent.length, n3);
  // уже принятый файл: повтор meta от того же пира -> ok, от другого -> новая сессия
  R = rx(); await R.db.set("done:c-9", { peer: "P" }); await R.handleJson("P", meta({ id: "c-9" })); assert.deepEqual(kinds(R), ["file-result"]); assert.equal(R.sent[0].ok, true);
});

test("получатель: параллельные meta одного id (opening), saveHandleFor и выбор хранилища по умолчанию", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let R = rx({ onMeta: () => gate });
  const p1 = R.handleJson("P", meta()); await sleep(5); await R.handleJson("P", meta()); assert.equal(R.sent.length, 0); release(true); await p1; assert.equal(R.sin.size, 1);
  const ofs = fakeOpfs(); const fh = await (await (await ofs.global.navigator.storage.getDirectory()).getDirectoryHandle("d", { create: true })).getFileHandle("fh-1", { create: true });
  R = mkHub({ order: null, saveHandleFor: () => fh }); R.sent = []; R.bind("P", tr(R.sent)); await R.handleJson("P", meta({ id: "fh-1" })); assert.equal(R.sin.get("fh-1").kind, "fsa");
  R = mkHub({ order: null, saveHandleFor: () => { throw new Error("gesture"); } }); R.sent = []; R.bind("P", tr(R.sent)); await R.handleJson("P", meta({ id: "fh-2" })); assert.equal(R.sin.get("fh-2").kind, "memory");
  R = mkHub({ order: null, saveHandleFor: () => null }); R.sent = []; R.bind("P", tr(R.sent)); await R.handleJson("P", meta({ id: "fh-3" })); assert.equal(R.sin.get("fh-3").handle, null);
  R = mkHub({ order: null }); R.sent = []; R.bind("P", tr(R.sent)); await R.handleJson("P", meta({ id: "fh-4" })); assert.equal(R.sin.get("fh-4").kind, "memory");
  R = mkHub({ order: null, storeOpts: { idb: new IDBFactory(), keyRange: IDBKeyRange } }); R.sent = []; R.bind("P", tr(R.sent));
  await withGlobal("indexedDB", new IDBFactory(), async () => { await R.handleJson("P", meta({ id: "fh-5" })); }); assert.equal(R.sin.get("fh-5").kind, "idb");
});

test("враждебные кадры: мусор, чужой пир, пауза, неверные поля, crc, отсутствующий crc, дубль, flood, предел нарушений", async () => {
  let R = rx(); await R.handleJson("P", meta());
  R.handleBinary("P", new ArrayBuffer(3)); R.handleBinary("P", frame("zz", 0, UNIT)); R.bind("Q", tr([])); R.handleBinary("Q", frame("c-1", 0, UNIT));
  assert.equal(R.sin.get("c-1").claim.every((x) => x === 0), true);
  R.handleBinary("P", frame("c-1", 0, UNIT - 5)); assert.equal(R.sin.get("c-1").viol, 1);
  R.handleBinary("P", frame("c-1", 0, 0)); R.handleBinary("P", frame("c-1", 99, UNIT)); assert.equal(R.sin.get("c-1").viol, 3);
  const bad = new Uint8Array(frame("c-1", 0, UNIT)); bad[4 + 15] = 0; R.handleBinary("P", bad.buffer);
  const withCrc = new Uint8Array(frame("c-1", 1, UNIT, true)); withCrc[withCrc.length - 1] ^= 1; R.handleBinary("P", withCrc.buffer); assert.equal(R.sin.get("c-1").viol >= 4, true);
  R.handleBinary("P", frame("c-1", 0, UNIT, true)); await sleep(20); assert.equal(R.sin.get("c-1").gotUnits, 1);
  R.handleBinary("P", frame("c-1", 0, UNIT)); assert.ok(R.sin.get("c-1").dups >= 1);
  R.pause("c-1"); R.handleBinary("P", frame("c-1", 2, UNIT)); assert.equal(R.sin.get("c-1").gotUnits, 1);
  R = rx(); await R.handleJson("P", meta({ crc: 1 })); const before = R.sin.get("c-1").viol; R.handleBinary("P", frame("c-1", 0, UNIT, false)); assert.equal(R.sin.get("c-1").viol, before + 1);
  R = rx({ limits: { pendingCap: UNIT } }); await R.handleJson("P", meta()); R.handleBinary("P", frame("c-1", 0, UNIT)); R.handleBinary("P", frame("c-1", 1, UNIT)); assert.equal(R.sin.get("c-1").viol, 1);
  R = rx({ limits: { violationLimit: 2 } }); await R.handleJson("P", meta()); R.handleBinary("P", frame("c-1", 0, 5)); R.handleBinary("P", frame("c-1", 0, 5)); await sleep(10);
  assert.ok(kinds(R).includes("file-cancel:protocol")); assert.equal(R.sin.size, 0);
  R = rx(); await R.handleJson("P", meta()); R.sin.get("c-1").dups = 700; R.handleBinary("P", frame("c-1", 0, UNIT)); await sleep(10); R.handleBinary("P", frame("c-1", 0, UNIT)); assert.equal(R.sin.get("c-1").viol, 1);
});

test("завершение: чужой хэш, ошибка хранилища при проверке, запись падает, мёртвая сессия, file-end с повторами", async () => {
  const feed = async (R, order) => { for (const i of order) R.handleBinary("P", frame("c-1", i, lenOf(i))); await sleep(60); };
  let R = rx(); await R.handleJson("P", meta({ h: "0".repeat(64) })); await feed(R, [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(kinds(R).includes("file-result:hash")); assert.equal(R.sin.size, 0);
  // порядок нарушен -> хэш считается перечитыванием; чтение падает -> storage
  R = rx({ stores: { memory: async (s) => { const st = await BF.MemoryStore.open(s); st.readSeq = async () => { throw new Error("rd"); }; return st; } } });
  await R.handleJson("P", meta()); await feed(R, [1, 0, 2, 3, 4, 5, 6]); assert.ok(kinds(R).includes("file-result:storage"));
  R = rx(); await R.handleJson("P", meta()); await feed(R, [1, 0, 2, 3, 4, 5, 6]); assert.ok(R.events.some((e) => e.type === "done" && e.dir === "in"));
  R = rx({ stores: { memory: async (s) => { const st = await BF.MemoryStore.open(s); st.write = async () => { throw new Error("wr"); }; return st; } } });
  await R.handleJson("P", meta()); R.handleBinary("P", frame("c-1", 0, UNIT)); await sleep(30); assert.ok(kinds(R).includes("file-cancel:storage")); assert.equal(R.sin.size, 0);
  R = rx({ stores: { memory: async (s) => { const st = await BF.MemoryStore.open(s); st.flush = async () => { throw new Error("fl"); }; return st; } } });
  await R.handleJson("P", meta()); await feed(R, [0, 1, 2, 3, 4, 5, 6]); assert.ok(kinds(R).includes("file-result:storage"));
  // file-end: до 5 повторных запросов, затем incomplete; чужой пир и неизвестный id игнорируются
  R = rx(); await R.handleJson("P", meta()); R.handleJson("P", { kind: "file-end", id: "nope", ep: 1 }); R.bind("Q", tr([])); R.handleJson("Q", { kind: "file-end", id: "c-1", ep: 1 });
  for (let i = 0; i < 6; i++) { R.handleJson("P", { kind: "file-end", id: "c-1", ep: 1 }); await sleep(5); }
  assert.ok(kinds(R).includes("file-cancel:incomplete")); assert.equal(R.sin.size, 0);
  R = rx(); await R.handleJson("P", meta()); await feed(R, [0, 1, 2, 3, 4, 5, 6]); const s0 = R.sent.length; R.handleJson("P", { kind: "file-end", id: "c-1", ep: 1 }); await sleep(5); assert.equal(R.sent.length, s0);
  // ack: ackEvery малый -> немедленный ack; поздние кадры после dead — игнор
  R = rx({ limits: { ackEvery: UNIT } }); await R.handleJson("P", meta()); R.handleBinary("P", frame("c-1", 0, UNIT)); await sleep(20); assert.ok(kinds(R).includes("file-ack"));
  const s = R.sin.get("c-1"); s.dead = true; R._ack(s); s.dead = false; s.rx = s.ackSent; R._ack(s);
});

test("получатель: управление (пауза/возобновление/отмена), pause от пира, cancel, getBlob/getStream/discard, _tick просрочки", async () => {
  let t = 1000; let R = rx({ now: () => t });
  await R.handleJson("P", meta()); assert.equal(R.info("c-1").dir, "in"); assert.equal(R.info("nope"), null); assert.ok(R.has("c-1"));
  assert.equal(R.pause("c-1"), true); assert.equal(R.resume("c-1"), true); assert.equal(R.resume("c-1"), false); assert.equal(R.resume("nope"), false); assert.equal(R.pause("nope"), false);
  R.unbind("P"); assert.equal(R.info("c-1").state, "waiting"); R.pause("c-1"); assert.equal(R.resume("c-1"), true); assert.equal(R.sin.get("c-1").waiting, true);
  R.bind("P", tr(R.sent)); R.handleJson("P", { kind: "file-pause", id: "c-1" }); assert.equal(R.sin.get("c-1").remotePaused, true);
  R.handleJson("P", { kind: "file-cancel", id: "c-1", reason: 5 }); await sleep(5); assert.equal(R.sin.size, 0);
  await R.handleJson("P", meta()); R.handleJson("P", { kind: "file-cancel", id: "c-1", reason: "bye" }); await sleep(5); assert.ok(R.events.some((e) => e.reason === "bye"));
  R.handleJson("Z", { kind: "file-cancel", id: "c-1" }); R.handleJson("Z", { kind: "file-pause", id: "c-1" });
  await R.handleJson("P", meta()); assert.equal(R.cancel("c-1"), true); assert.equal(R.cancel("c-1"), false);
  await R.handleJson("P", meta()); t += BF.DEFAULTS.ttlMs + 10; R._tick(); await sleep(10); assert.ok(R.events.some((e) => e.reason === "expired")); R.destroy();
  // завершённый: getBlob/getStream/discard (IDB)
  const f = new IDBFactory(), o = { idb: f, keyRange: IDBKeyRange };
  R = rx({ order: ["idb"], storeOpts: o }); await R.handleJson("P", meta({ id: "done-1" }));
  for (let i = 0; i < TOTAL; i++) R.handleBinary("P", frame("done-1", i, lenOf(i))); await until(() => R.events.some((e) => e.type === "done"), 5000);
  assert.equal(Buffer.from(await (await R.getBlob("done-1")).arrayBuffer()).compare(DATA), 0);
  const rd = (await R.getStream("done-1")).getReader(); let n = 0; for (;;) { const r = await rd.read(); if (r.done) break; n += r.value.length; } assert.equal(n, SIZE);
  const evt = R.events.find((e) => e.type === "done"); assert.ok((await evt.getBlob()).size === SIZE);
  assert.equal(await R.getBlob("zzz"), null); assert.equal(await R.getStream("zzz"), null);
  await R.discard("done-1"); assert.equal(await R.getBlob("done-1"), null); await R.discard("never");
  R.stores.memory = async () => null; await R.db.set("done:m", { id: "m", kind: "memory", size: 1 }); assert.equal(await R.getBlob("m"), null); assert.equal(await R.getStream("m"), null);
});

test("init: восстановление после перезапуска (просрочка, memory, не хватает данных, нет хранилища, исходящие)", async () => {
  const t = 5e9; const db = new (BF.MemMetaDb)(); const f = new IDBFactory(), o = { idb: f, keyRange: IDBKeyRange };
  const bm = BF.bmNew(TOTAL); bm[0] = 0b11;
  await db.set("in:old", null);
  await db.set("in:exp", { id: "exp", peer: "P", name: "n", mime: "m", size: SIZE, hash: HASH, kind: "idb", bitmap: bm.slice(), updatedAt: 0, createdAt: 0 });
  await db.set("in:mem", { id: "mem", peer: "P", name: "n", mime: "m", size: SIZE, hash: HASH, kind: "memory", bitmap: bm.slice(), updatedAt: t, createdAt: t });
  await db.set("in:gone", { id: "gone", peer: "P", name: "n", mime: "m", size: SIZE, hash: HASH, kind: "zzz", bitmap: bm.slice(), updatedAt: t, createdAt: t });
  const ofs = fakeOpfs(); const ost = await BF.opfs.open({ id: "short" }, { global: ofs.global }); await ost.write(0, DATA.subarray(0, 5)); await ost.flush();
  await db.set("in:short", { id: "short", peer: "P", name: "n", mime: "m", size: SIZE, hash: HASH, kind: "opfs", bitmap: bm.slice(), updatedAt: t, createdAt: t, state: "paused" });
  await db.set("in:fsa", { id: "fsa", peer: "P", name: "n", mime: "m", size: SIZE, hash: HASH, kind: "fsa", bitmap: bm.slice(), updatedAt: t, createdAt: t });
  await db.set("out:bad", null); await db.set("out:nofile", { id: "nofile", peer: "P", createdAt: t });
  await db.set("out:old", { id: "old", peer: "P", file: new Blob([DATA]), createdAt: 0 });
  await db.set("out:ok", { id: "ok", peer: "P", file: new Blob([DATA]), createdAt: t, hash: HASH, name: "n", mime: "m", extra: {}, paused: true });
  await db.set("out:ok2", { id: "ok2", peer: "P", file: new Blob([DATA]), createdAt: t, hash: HASH, name: "n", mime: "m", extra: {} });
  const R = mkHub({ metaDb: db, now: () => t, stores: { opfs: (s) => BF.opfs.open(s, { global: ofs.global }) }, order: ["opfs", "memory"] });
  await R.init(); await R.init();
  assert.deepEqual([...R.sin.keys()].sort(), ["short"]); assert.equal(R.sin.get("short").gotUnits, 0); assert.equal(R.sin.get("short").state, "paused");
  assert.deepEqual([...R.out.keys()].sort(), ["ok", "ok2"]); assert.equal(R.out.get("ok").state, "paused"); assert.equal(R.out.get("ok2").state, "queued");
  assert.equal(await db.get("in:exp"), undefined); assert.equal(await db.get("out:old"), undefined);
  R.destroy();
});

test("отправитель: проверка аргументов, дубликат, сбой чтения, отмена во время хэширования, db без записи, meta с extra", async () => {
  const mkOut = (o) => { const sent = []; const S = mkHub(Object.assign({ onEvent: undefined }, o)); S.sent = sent; S.bind("P", tr(sent)); return S; };
  const S = mkOut(); const blob = new Blob([DATA]);
  await assert.rejects(S.enqueueSend("P", blob, null), /bad id/); await assert.rejects(S.enqueueSend("P", blob, { id: "a b" }), /bad id/); await assert.rejects(S.enqueueSend("P", blob, {}), /bad id/);
  await assert.rejects(S.enqueueSend("P", null, { id: "x" }), /size/); await assert.rejects(S.enqueueSend("P", new Blob([]), { id: "x" }), /size/);
  const S2 = mkOut({ limits: { maxSize: 10 } }); await assert.rejects(S2.enqueueSend("P", blob, { id: "x" }), /size/);
  const j1 = await S.enqueueSend("P", blob, { id: "s-1", extra: { duration: 3, wave: [1], forwarded: true, fwdFrom: "Bob", ttl: 30, caption: "hi" } });
  assert.equal(await S.enqueueSend("P", blob, { id: "s-1" }), j1);
  const m = S.sent.find((x) => x.kind === "file-meta"); assert.deepEqual([m.duration, m.wave, m.forwarded, m.fwdFrom, m.ttl, m.caption], [3, [1], true, "Bob", 30, "hi"]);
  const m2 = S._metaOf({ id: "q", name: "n", mime: "m", size: 1, total: 1, hash: "h", extra: { forwarded: true, fwdFrom: 5, ttl: -1 } }); assert.equal(m2.fwdFrom, undefined); assert.equal(m2.ttl, undefined); assert.equal(S._metaOf({ id: "q", extra: null }).crc, 0);
  const S3 = mkOut({ crc: true }); assert.equal(S3._metaOf({ id: "q", extra: {} }).crc, 1);
  const S4 = mkOut(); const bad = { size: 100, slice() { throw new Error("rd"); } };
  const j4 = await S4.enqueueSend("P", bad, { id: "bad-1" }); assert.equal(j4.state, "failed"); assert.equal(S4.out.size, 0);
  const S5 = mkOut(); const slow = { size: 40000, slice(a, b) { return { arrayBuffer: async () => { await sleep(20); return new ArrayBuffer(b - a); } }; } };
  const p5 = S5.enqueueSend("P", slow, { id: "dead-1" }); await sleep(5); S5.cancel("dead-1"); const j5 = await p5; assert.equal(j5.dead, true);
  const S6 = mkOut({ metaDb: { get: async () => null, set: async () => { throw new Error("quota"); }, del: async () => {}, list: async () => [] } });
  const j6 = await S6.enqueueSend("P", blob, { id: "nr-1" }); assert.equal(j6.nonResumable, true);
  const S7 = mkOut({ persistSender: false }); const j7 = await S7.enqueueSend("P", blob, { id: "np-1" }); assert.equal(j7.state === "handshake" || j7.state === "queued", true);
  S.destroy(); S2.destroy(); S3.destroy(); S4.destroy(); S5.destroy(); S6.destroy(); S7.destroy();
});

test("отправитель: ответы пира (resume/ack/result/reject/pause/cancel) с враждебными полями", async () => {
  const sent = []; let t = 1000;
  const S = mkHub({ now: () => t, limits: { maxOutActive: 1, maxRanges: 2 } }); S.bind("P", tr(sent)); S.bind("Q", tr([]));
  const blob = new Blob([DATA]);
  await S.enqueueSend("P", blob, { id: "o-1" }); await S.enqueueSend("P", blob, { id: "o-2" });
  assert.equal(S.out.get("o-1").state, "handshake"); assert.equal(S.out.get("o-2").state, "queued");
  S.handleJson("P", { kind: "file-resume", id: "ghost", ep: 1, ranges: [] }); assert.equal(sent.at(-1).reason, "unknown");
  S.handleJson("Q", { kind: "file-resume", id: "o-1", ep: 1, ranges: [] }); assert.equal(sent.at(-1).reason, "unknown");
  S.out.get("o-1").state = "hashing"; S.handleJson("P", { kind: "file-resume", id: "o-1", ep: 1, ranges: [[0, 1]] }); S.out.get("o-1").state = "done"; S.handleJson("P", { kind: "file-resume", id: "o-1", ep: 1, ranges: [[0, 1]] });
  S.out.get("o-1").state = "handshake";
  for (const bad of [{ ep: "x", ranges: [] }, { ep: 1, ranges: "x" }, { ep: 1, ranges: [[0, 1], [1, 2], [2, 3]] }, { ep: 1, ranges: ["x"] }, { ep: 1, ranges: [[0.5, 1]] }, { ep: 1, ranges: [[0, 1.5]] }, { ep: 1, ranges: [[-1, 1]] }, { ep: 1, ranges: [[0, 99]] }, { ep: 1, ranges: [[3, 3]] }])
    S.handleJson("P", Object.assign({ kind: "file-resume", id: "o-1" }, bad));
  assert.equal(S.out.get("o-1").state, "handshake");
  S.pause("o-1"); const nS = sent.length; S.handleJson("P", { kind: "file-resume", id: "o-1", ep: 1, ranges: [[0, 1]] }); assert.equal(sent.at(-1).kind, "file-pause"); assert.equal(sent.length, nS + 1);
  assert.equal(S.resume("o-1"), true); assert.equal(S.resume("o-1"), false);
  S.handleJson("P", { kind: "file-pause", id: "o-1" }); assert.equal(S.out.get("o-1").remote, true);
  S.handleJson("P", { kind: "file-resume", id: "o-1", ep: 7, ranges: [] }); await sleep(30);
  S.handleJson("P", { kind: "file-ack", id: "nope", ep: 7, n: 1 }); S.handleJson("Q", { kind: "file-ack", id: "o-1", ep: 7, n: 1 }); S.handleJson("P", { kind: "file-ack", id: "o-1", ep: 6, n: 1 }); S.handleJson("P", { kind: "file-ack", id: "o-1", ep: 7, n: "x" });
  S.handleJson("P", { kind: "file-ack", id: "o-1", ep: 7, n: 0 });
  S.handleJson("P", { kind: "file-result", id: "nope", ok: true }); S.handleJson("Q", { kind: "file-result", id: "o-1", ok: true });
  S.handleJson("P", { kind: "file-reject", id: "nope" }); S.handleJson("Q", { kind: "file-reject", id: "o-1" });
  S.handleJson("P", { kind: "file-reject", id: "o-1", reason: "busy" }); assert.equal(S.out.get("o-1").state, "queued");
  S.out.get("o-1").busyUntil = 0; S.handleJson("P", { kind: "file-reject", id: "o-1", reason: 5 }); assert.ok(S.events.some((e) => e.id === "o-1" && e.reason === "rejected"));
  S.handleJson("P", { kind: "file-result", id: "o-2", ok: false, reason: 5 }); assert.ok(S.events.some((e) => e.id === "o-2" && e.reason === "failed"));
  await S.enqueueSend("P", blob, { id: "o-3" }); S.handleJson("P", { kind: "file-result", id: "o-3", ok: false, reason: "disk" }); assert.ok(S.events.some((e) => e.id === "o-3" && e.reason === "disk"));
  await S.enqueueSend("P", blob, { id: "o-4" }); S.handleJson("P", { kind: "file-result", id: "o-4", ok: true }); assert.ok(S.events.some((e) => e.id === "o-4" && e.type === "done"));
  await S.enqueueSend("P", blob, { id: "o-5" }); S.handleJson("P", { kind: "file-cancel", id: "o-5", reason: 5 }); assert.ok(S.events.some((e) => e.id === "o-5" && e.reason === "remote"));
  await S.enqueueSend("P", blob, { id: "o-6" }); S.handleJson("P", { kind: "file-cancel", id: "o-6", reason: "x" });
  assert.equal(S.cancel("nope"), false);
  S.destroy();
});

test("раздача: чтение падает, окно стоит до таймаута, канал не сливается, sendBinary отказывает, подстройка кадра, повторный resume", async () => {
  let t = 0; const mk = (opts, trx) => { const sent = [], bin = []; const S = mkHub(Object.assign({ now: () => t }, opts)); S.sent = sent; S.bin = bin; S.bind("P", tr(sent, Object.assign({ sendBinary: (b) => { bin.push(b); return true; } }, trx))); return S; };
  const start = async (S, id, file, ranges) => { await S.enqueueSend("P", file, { id }); S.handleJson("P", { kind: "file-resume", id, ep: 1, ranges: ranges || [[0, TOTAL]] }); };
  // чтение падает посреди раздачи
  let S = mk(); let reads = 0;
  const flaky = { size: SIZE, slice(a, b) { return { arrayBuffer: async () => { if (a > 0 && ++reads >= 1) throw new Error("rd"); return DATA.slice(a, b).buffer; } }; } };
  await start(S, "p-1", flaky); await sleep(40); assert.ok(S.sent.some((m) => m.kind === "file-cancel" && m.reason === "read")); S.destroy();
  // окно: stallMs короткий -> пауза timeout
  S = mk({ limits: { windowBytes: UNIT, stallMs: 20 } }); await start(S, "p-2", new Blob([DATA])); await sleep(120);
  assert.equal(S.out.get("p-2").state, "paused"); assert.ok(S.events.some((e) => e.reason === "timeout")); S.destroy();
  // окно: ack снимает ожидание
  S = mk({ limits: { windowBytes: UNIT, stallMs: 5000 } }); await start(S, "p-2b", new Blob([DATA])); await sleep(30);
  S.handleJson("P", { kind: "file-ack", id: "p-2b", ep: 1, n: 1e9 }); await sleep(30); S.destroy();
  // высокая заполненность: whenLow = false -> стоп; true -> идём
  S = mk({ limits: { highWater: 0 } }, { bufferedAmount: () => 5, whenLow: async () => false }); await start(S, "p-3", new Blob([DATA])); await sleep(30); assert.equal(S.bin.length, 0); assert.equal(S.out.get("p-3").pumping, false); S.destroy();
  S = mk({ limits: { highWater: 0 } }, { bufferedAmount: () => 5, whenLow: async () => true }); await start(S, "p-3b", new Blob([DATA])); await sleep(40); assert.ok(S.bin.length > 0); S.destroy();
  // sendBinary отказал
  S = mk({}, { sendBinary: () => false }); await start(S, "p-4", new Blob([DATA])); await sleep(30); assert.equal(S.out.get("p-4").pumping, false); S.destroy();
  // подстройка кадра по скорости: виртуальное время идёт на 1.5 с за кадр
  for (const bytesPerMs of [1, 5, 20]) {
    let tt = 0; const S2 = mkHub({ now: () => tt }); S2.bind("P", tr([], { sendBinary: () => { tt += Math.ceil(65536 / bytesPerMs); return true; } }));
    await S2.enqueueSend("P", new Blob([DATA]), { id: "r-" + bytesPerMs }); S2.handleJson("P", { kind: "file-resume", id: "r-" + bytesPerMs, ep: 1, ranges: [[0, TOTAL]] }); await sleep(40); S2.destroy();
  }
  // отмена раздачи новой resume (токен)
  S = mk({}, { sendBinary: (b) => { return true; } }); await S.enqueueSend("P", new Blob([DATA]), { id: "p-6" });
  S.handleJson("P", { kind: "file-resume", id: "p-6", ep: 1, ranges: [[0, TOTAL]] }); S.handleJson("P", { kind: "file-resume", id: "p-6", ep: 2, ranges: [[2, 4], [5, 6]].slice(0, 2) }); await sleep(40); S.destroy();
  // _pump без канала
  S = mk(); await S.enqueueSend("P", new Blob([DATA]), { id: "p-7" }); S.unbind("P"); await S._pump(S.out.get("p-7"), 0, [[0, 1]], 1);
  S.destroy();
});

test("тик отправителя: просрочка, повтор рукопожатия и «нет ответа»; bind/unbind перезапускают рукопожатие", async () => {
  let t = 1000; const sent = []; const S = mkHub({ now: () => t, limits: { handshakeRetryMs: 100, handshakeMaxRetries: 2 } }); S.bind("P", tr(sent));
  await S.enqueueSend("P", new Blob([DATA]), { id: "t-1" }); assert.equal(S.out.get("t-1").state, "handshake");
  for (let i = 0; i < 4; i++) { t += 150; S._tick(); } assert.ok(S.events.some((e) => e.reason === "no-reply"));
  t += BF.DEFAULTS.ttlMs + 1; S._tick(); assert.ok(S.events.some((e) => e.reason === "expired")); assert.equal(S.timer, null);
  const S2 = mkHub({ now: () => t }); S2.bind("P", tr([])); await S2.enqueueSend("P", new Blob([DATA]), { id: "t-2" });
  S2.out.get("t-2").state = "sending"; const tok = S2.out.get("t-2").tok; S2.unbind("P"); assert.equal(S2.out.get("t-2").state, "queued"); S2.unbind("P");
  S2.out.get("t-2").state = "verifying"; S2.bind("P", tr([])); assert.equal(S2.out.get("t-2").state, "handshake"); assert.ok(S2.out.get("t-2").tok > tok);
  assert.equal(S2.isBound("P"), true); S2.destroy();
});
