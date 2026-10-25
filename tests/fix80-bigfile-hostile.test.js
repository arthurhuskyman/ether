// V.80: большие файлы — враждебный пир, лимиты и хранилища. Без сети: Hub вызывается напрямую; настоящий DataChannel — в fix80-bigfile-transfer.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const { BF, sleep, until, SynthBlob, synthSha256, blobSha256, fakeOpfs, mkHub, loopBind } = require("./fix80-bigfile-helpers");

const SIZE = 100000, TOTAL = Math.ceil(SIZE / BF.UNIT); // 7 блоков
const DATA = crypto.randomBytes(SIZE), HASH = crypto.createHash("sha256").update(DATA).digest("hex");
const meta = (o) => Object.assign({ kind: "file-meta", bin: 1, id: "h-1", name: "a.bin", mime: "application/octet-stream", size: SIZE, totalChunks: TOTAL, u: BF.UNIT, h: HASH, crc: 0 }, o);
const frame = (id, idx, len, data) => BF.encodeFrame(id, idx, (data || DATA).subarray(idx * BF.UNIT, idx * BF.UNIT + len), false);
async function recv(opts) {
  const sent = [];
  const R = mkHub(opts); const tr = { isOpen: () => true, sendJson: (p) => { sent.push(p); return true; }, sendBinary: () => true, bufferedAmount: () => 0, whenLow: async () => true };
  R.bind("P", tr); R.sent = sent; return R;
}
const kinds = (R) => R.sent.map((m) => m.kind + (m.reason ? ":" + m.reason : ""));

test("ложный file-meta отклоняется: размер, раскладка блоков, хэш, id (path traversal), нет сессии", async () => {
  const R = await recv();
  for (const bad of [{ size: 5 * 1024 ** 3, totalChunks: Math.ceil(5 * 1024 ** 3 / BF.UNIT) }, { size: 0, totalChunks: 0 }, { size: -5 }, { size: 1.5 }, { size: "100" }, { size: 1e300 }]) {
    await R.handleJson("P", meta(bad));
  }
  assert.ok(kinds(R).every((k) => k.startsWith("file-reject")), kinds(R).join()); assert.equal(R.sin.size, 0);
  const n = R.sent.length;
  await R.handleJson("P", meta({ totalChunks: 2 })); await R.handleJson("P", meta({ u: 1 })); await R.handleJson("P", meta({ h: "zz" })); await R.handleJson("P", meta({ name: 5 }));
  assert.equal(R.sent.length, n + 4); assert.equal(R.sin.size, 0);
  const n2 = R.sent.length;
  for (const id of ["../../x", "a/b", "a b", "", "x".repeat(65), "é"]) await R.handleJson("P", meta({ id }));
  assert.equal(R.sent.length, n2, "с недопустимым id даже не отвечаем"); assert.equal(R.sin.size, 0);
});

test("имя файла с ../ чистится; на диске файл называется по id, а не по имени", async () => {
  const opfs = fakeOpfs(); const R = await recv({ order: ["opfs"], storeOpts: { global: opfs.global } });
  await R.handleJson("P", meta({ id: "n-1", name: "../../../etc/passwd‮.exe" }));
  const inc = R.events.find((e) => e.type === "incoming"); assert.ok(inc);
  assert.ok(!/[\\/]/.test(inc.name) && !inc.name.startsWith(".") && !inc.name.includes("‮"), inc.name);
  assert.ok(require("node:fs").existsSync(opfs.fileOf("n-1")));
  assert.deepEqual(require("node:fs").readdirSync(require("node:path").join(opfs.baseDir, "ether-bigfile")), ["n-1"]);
});

test("враждебные кадры: слишком большой, неверный индекс, за границей файла, неровная длина, битая длина в заголовке, CRC, дубликаты, чужой пир", async () => {
  const R = await recv({ limits: { violationLimit: 1000 } });
  await R.handleJson("P", meta());
  const s = R.sin.get("h-1"); assert.ok(s);
  const big = BF.encodeFrame("h-1", 0, new Uint8Array(300000), false); R.handleBinary("P", big);          // > FRAME_MAX
  R.handleBinary("P", frame("h-1", 50, 16384));                                                              // индекс за пределами
  R.handleBinary("P", BF.encodeFrame("h-1", 6, new Uint8Array(40000), false));                               // выходит за заявленный размер
  R.handleBinary("P", BF.encodeFrame("h-1", 0, DATA.subarray(0, 1000), false));                              // длина не кратна блоку (не хвост)
  const lie = new Uint8Array(BF.encodeFrame("h-1", 0, DATA.subarray(0, 16384), false)); new DataView(lie.buffer).setUint32(8, 99999); R.handleBinary("P", lie.buffer); // длина в заголовке ≠ фактической
  const crcBad = new Uint8Array(BF.encodeFrame("h-1", 0, DATA.subarray(0, 16384), true)); crcBad[crcBad.length - 1] ^= 1; R.handleBinary("P", crcBad.buffer);
  R.handleBinary("P", BF.encodeFrame("h-1", 0, DATA.subarray(0, 16384), false).slice(0, 20));              // обрезанный кадр
  R.handleBinary("Q", frame("h-1", 0, 16384));                                                               // чужой пир
  R.handleBinary("P", BF.encodeFrame("nope", 0, DATA.subarray(0, 16384), false));                            // чужая сессия
  await sleep(20);
  assert.equal(s.gotUnits, 0, "ни один враждебный кадр не записан"); assert.equal(s.viol, 7, "нарушения посчитаны: " + s.viol);
  // дубликаты
  R.handleBinary("P", frame("h-1", 0, 32768)); R.handleBinary("P", frame("h-1", 0, 32768)); R.handleBinary("P", frame("h-1", 1, 16384));
  await sleep(30); assert.equal(s.gotUnits, 2, "дубликат не записан и не посчитан дважды");
  // перекрытие частично занятых блоков тоже дубликат
  R.handleBinary("P", frame("h-1", 1, 32768)); await sleep(20); assert.equal(s.gotUnits, 2);
  assert.equal(R.sin.size, 1, "сессия жива");
});

test("поток нарушений обрывает передачу: file-cancel и очистка хранилища", async () => {
  const opfs = fakeOpfs(); const R = await recv({ order: ["opfs"], storeOpts: { global: opfs.global }, limits: { violationLimit: 5 } });
  await R.handleJson("P", meta({ id: "h-2" }));
  for (let i = 0; i < 6; i++) R.handleBinary("P", frame("h-2", 90 + i, 16384));
  await sleep(50);
  assert.ok(kinds(R).includes("file-cancel:protocol")); assert.equal(R.has("h-2"), false);
  assert.equal(require("node:fs").existsSync(opfs.fileOf("h-2")), false);
  // бесконечные дубли после перезапроса ограничены окном
  const R2 = await recv({ limits: { violationLimit: 3 } }); await R2.handleJson("P", meta({ id: "h-3" }));
  R2.handleBinary("P", frame("h-3", 0, 16384)); await sleep(10);
  for (let i = 0; i < 2100; i++) R2.handleBinary("P", frame("h-3", 0, 16384));
  assert.equal(R2.has("h-3"), false, "флуд дублями обрывает приём");
});

test("лживый хэш/данные: файл собран, но SHA-256 не сходится → failed/hash, данные удалены, отправителю file-result ok:false", async () => {
  const R = await recv(); await R.handleJson("P", meta({ id: "h-4", h: "a".repeat(64) }));
  for (let i = 0; i < TOTAL; i++) R.handleBinary("P", frame("h-4", i, Math.min(16384, SIZE - i * 16384)));
  assert.ok(await until(() => !R.has("h-4"), 3000));
  assert.ok(R.sent.some((m) => m.kind === "file-result" && m.ok === false && m.reason === "hash"));
  assert.equal(R.events.filter((e) => e.type === "done").length, 0);
  // верный хэш при кадрах вразнобой (докачка с дырами → перепроверка чтением из хранилища)
  const R2 = await recv(); await R2.handleJson("P", meta({ id: "h-5" }));
  for (const i of [3, 0, 6, 1, 5, 2, 4]) R2.handleBinary("P", frame("h-5", i, Math.min(16384, SIZE - i * 16384)));
  assert.ok(await until(() => R2.events.some((e) => e.type === "done"), 3000));
  assert.equal(await blobSha256(await R2.events.find((e) => e.type === "done").getBlob()), HASH);
  assert.ok(R2.sent.some((m) => m.kind === "file-result" && m.ok === true));
});

test("лимиты: квота хранилища, busy/limit, отказ приложения, повторный meta не плодит сессий", async () => {
  const Rq = await recv({ quota: async () => false }); await Rq.handleJson("P", meta());
  assert.deepEqual(kinds(Rq), ["file-reject:quota"]); assert.ok(Rq.events.some((e) => e.type === "state" && e.state === "failed" && e.reason === "quota"));
  const Rd = await recv({ onMeta: () => false }); await Rd.handleJson("P", meta()); assert.deepEqual(kinds(Rd), ["file-reject:declined"]);
  const Rb = await recv({ limits: { maxInActive: 1, maxInTotal: 2 } });
  await Rb.handleJson("P", meta({ id: "b-1" })); await Rb.handleJson("P", meta({ id: "b-2" })); assert.ok(kinds(Rb).includes("file-reject:busy"));
  await Rb.handleJson("P", meta({ id: "b-1" })); assert.equal(Rb.sin.size, 1);
  await Rb.handleJson("P", meta({ id: "b-1", size: SIZE + 1, totalChunks: TOTAL })); assert.ok(kinds(Rb).includes("file-reject:conflict"));
  const Rs = await recv({ order: ["memory"], limits: { memoryCap: 1000 } }); await Rs.handleJson("P", meta());
  assert.deepEqual(kinds(Rs), ["file-reject:storage"], "память дороже лимита и других хранилищ нет → отказ, а не падение");
});

test("хранилища: IndexedDB (кадры вразнобой, чтение по порядку, Blob, поток, удаление), память, OPFS-файл", async () => {
  const idb = new IDBFactory(); const st = await BF.IdbStore.open({ id: "i-1", size: SIZE }, { idb, keyRange: IDBKeyRange });
  for (const i of [2, 0, 1, 3]) await st.write(i * 16384, DATA.subarray(i * 16384, (i + 1) * 16384));
  await st.write(4 * 16384, DATA.subarray(4 * 16384));
  const h = new BF.Sha256(); await st.readSeq(SIZE, (u8) => h.update(u8)); assert.equal(h.digest(), HASH);
  const blob = await st.blob("text/x"); assert.equal(blob.size, SIZE); assert.equal(blob.type, "text/x");
  const chunks = []; const rd = st.stream().getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(Buffer.from(value)); }
  assert.equal(Buffer.concat(chunks).toString("hex"), DATA.toString("hex"));
  await st.abort(); const h2 = new BF.Sha256(); let n = 0; await st.readSeq(SIZE, (u8) => { n += u8.length; }); assert.equal(n, 0, "после abort блоков нет");
  const m = await BF.MemoryStore.open({ size: 10 }, { memoryCap: 100 }); await m.write(2, Uint8Array.of(1, 2)); assert.deepEqual([...m.buf.subarray(0, 5)], [0, 0, 1, 2, 0]);
  await assert.rejects(BF.MemoryStore.open({ size: 1000 }, { memoryCap: 100 }));
  const opfs = fakeOpfs(); const f = await BF.opfs.open({ id: "o-1", size: SIZE }, { global: opfs.global });
  assert.ok(f.commitDue(8 * 1024 * 1024, 0) && !f.commitDue(1024, 1e9) && f.commitDue(300e6, 1e9));
  await f.write(16384, DATA.subarray(16384, 32768)); await f.write(0, DATA.subarray(0, 16384)); await f.flush();
  assert.equal(await f.size(), 32768); assert.equal(opfs.state.writers, 1);
  await f.abort(); assert.equal(require("node:fs").existsSync(opfs.fileOf("o-1")), false);
  assert.equal(BF.opfs.supported({ navigator: {} }), false);
});

test("через IndexedDB-хранилище целиком: Hub отправитель → Hub получатель, Blob из getBlob, discard освобождает место", async () => {
  const idb = new IDBFactory(); const S = mkHub(), R = mkHub({ order: ["idb"], storeOpts: { idb, keyRange: IDBKeyRange }, metaDb: new BF.MemMetaDb() });
  loopBind(S, R);
  const SZ = 3 * 1024 * 1024 + 5;
  await S.enqueueSend("R", new SynthBlob(SZ, 2), { id: "i-2", name: "x.bin", mime: "x/y" });
  assert.ok(await until(() => R.events.some((e) => e.type === "done"), 20000, 20));
  const b = await R.getBlob("i-2"); assert.equal(b.size, SZ); assert.equal(await blobSha256(b), synthSha256(SZ, 2));
  assert.equal(R.events.find((e) => e.type === "done").store, "idb");
  await R.discard("i-2"); assert.equal(await R.getBlob("i-2"), null);
  // обычная передача мелочи: и отправитель получил ok
  assert.ok(S.events.some((e) => e.type === "done"));
});
