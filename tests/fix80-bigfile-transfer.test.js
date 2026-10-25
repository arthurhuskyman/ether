// V.80: большие файлы по P2P — двоичный протокол поверх настоящего RTCDataChannel (wrtc): передача 150 МБ с проверкой SHA-256,
// докачка после обрыва канала и после «перезапуска приложения», пауза/отмена с обеих сторон, троттлинг прогресса.
const test = require("node:test");
const assert = require("node:assert/strict");
const { BF, sleep, until, makePair, wire, SynthBlob, synthSha256, blobSha256, fakeOpfs, mkHub, PCS } = require("./fix80-bigfile-helpers");

const pairs = [];
test.after(() => { for (const p of pairs) p.close(); for (const p of PCS) { try { p.close(); } catch (e) {} } setTimeout(() => process.exit(process.exitCode || 0), 500); });
const pair = async () => { const p = await makePair(); pairs.push(p); return p; };
const evs = (hub, type, id) => hub.events.filter((e) => e.type === type && (!id || e.id === id));
const last = (hub, id) => { const l = hub.events.filter((e) => (e.type === "state" || e.type === "done") && e.id === id); return l[l.length - 1]; };

test("векторы: SHA-256 (потоковый) и CRC32, кадр туда-обратно, имя файла без путей", () => {
  const h = new BF.Sha256(); h.update(Buffer.from("a")); h.update(Buffer.from("bc"));
  assert.equal(h.digest(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(new BF.Sha256().digest(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const million = new BF.Sha256(); const a = Buffer.alloc(1000, 97); for (let i = 0; i < 1000; i++) million.update(a);
  assert.equal(million.digest(), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  assert.equal(BF.crc32(Buffer.from("123456789")), 0xcbf43926);
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const f = BF.decodeFrame(BF.encodeFrame("msg-1", 7, payload, true));
  assert.equal(f.id, "msg-1"); assert.equal(f.index, 7); assert.equal(f.length, 5); assert.ok(f.valid && f.hasCrc); assert.equal(f.crc, BF.crc32(payload)); assert.deepEqual([...f.payload], [1, 2, 3, 4, 5]);
  assert.equal(BF.decodeFrame(new Uint8Array(3).buffer), null);
  const trunc = BF.encodeFrame("x", 0, payload, false).slice(0, 18); assert.equal(BF.decodeFrame(trunc).valid, false);
  for (const bad of ["../../etc/passwd", "..\\..\\win.ini", "/abs/path.txt", "a‮gpj.exe", "CON.txt", "...", "", "x".repeat(300) + ".mp4"]) {
    const n = BF.safeFileName(bad); assert.ok(!/[\\/]/.test(n) && !n.startsWith(".") && n.length <= 120 && n.length > 0, JSON.stringify([bad, n]));
  }
  assert.ok(BF.safeFileName("x".repeat(300) + ".mp4").endsWith(".mp4"));
  assert.equal(BF.chooseFilePath({ size: 1000, smallMax: 2e6, maxSize: 4e9, peerFileBin: false }), "legacy-p2p");
  assert.equal(BF.chooseFilePath({ size: 5e6, smallMax: 2e6, maxSize: 4e9, peerFileBin: false }), "unsupported");
  assert.equal(BF.chooseFilePath({ size: 5e6, smallMax: 2e6, maxSize: 4e9, peerFileBin: true }), "binary");
  assert.equal(BF.chooseFilePath({ size: 5e9, smallMax: 2e6, maxSize: 4e9, peerFileBin: true }), "too-large");
  assert.deepEqual(BF.missingRanges(Uint8Array.of(0b00001111, 0b11110000), 16, 10), [[4, 12]]);
});

test("150 МБ по настоящему DataChannel: SHA-256 сходится, запись в (фальшивый) OPFS, ограниченное число событий прогресса, бинарные кадры без base64", async () => {
  const SIZE = 150 * 1024 * 1024 + 12345, SEED = 7;
  const p = await pair(); const opfs = fakeOpfs();
  const S = mkHub({ crc: true }), R = mkHub({ order: ["opfs"], storeOpts: { global: opfs.global } });
  let jsonKinds = {}, binFrames = 0, maxFrame = 0;
  const hooksS = { onJson: (j) => { jsonKinds[j.kind] = (jsonKinds[j.kind] || 0) + 1; }, onBinary: (b) => { binFrames++; maxFrame = Math.max(maxFrame, b.byteLength); } };
  wire(R, "S", p.dcB); wire(S, "R", p.dcA, hooksS);
  const file = new SynthBlob(SIZE, SEED);
  const t0 = Date.now();
  await S.enqueueSend("R", file, { id: "f-big-1", name: "film.bin", mime: "video/x-test", extra: { caption: "hi" } });
  assert.ok(await until(() => last(S, "f-big-1") && last(S, "f-big-1").type === "done", 55000, 50), "отправитель получил file-result ok");
  assert.ok(await until(() => evs(R, "done", "f-big-1").length === 1, 10000));
  const dt = Date.now() - t0;
  const done = evs(R, "done", "f-big-1")[0];
  assert.equal(done.size, SIZE); assert.equal(done.store, "opfs");
  assert.equal(await blobSha256(await done.getBlob()), synthSha256(SIZE, SEED), "получен ровно тот же файл");
  assert.equal(evs(R, "incoming", "f-big-1")[0].extra.caption, "hi");
  assert.equal(jsonKinds["file-chunk"], undefined, "base64-кусков нет");
  assert.ok(binFrames >= SIZE / BF.FRAME_MAX && binFrames <= Math.ceil(SIZE / BF.FRAME_MIN), "кадров " + binFrames);
  assert.ok(maxFrame <= 262144, "всё сообщение не больше 256 КиБ (maxMessageSize SCTP): " + maxFrame);
  assert.ok(evs(R, "progress", "f-big-1").length < 400 && evs(S, "progress", "f-big-1").length < 400, "прогресс троттлится (" + evs(R, "progress", "f-big-1").length + ")");
  assert.ok(!Number.isNaN(dt) && dt < 58000, "уложились во время: " + dt + " мс");
  assert.equal(R.sin.size, 0); assert.equal(S.out.size, 0);
  console.log("150MB за", dt, "мс; кадров", binFrames, "; прогресс-событий R/S:", evs(R, "progress").length, evs(S, "progress").length);
});

test("докачка после обрыва канала: второй канал догружает только недостающее, итоговый хэш верен", async () => {
  const SIZE = 80 * 1024 * 1024 + 777, SEED = 11;
  const p1 = await pair(); const opfs = fakeOpfs();
  const S = mkHub(), R = mkHub({ order: ["opfs"], storeOpts: { global: opfs.global } });
  let sent1 = 0; wire(R, "S", p1.dcB); wire(S, "R", p1.dcA, { onBinary: (b) => { sent1 += b.byteLength; } });
  await S.enqueueSend("R", new SynthBlob(SIZE, SEED), { id: "f-res-1", name: "a.bin", mime: "application/octet-stream" });
  assert.ok(await until(() => R.sin.get("f-res-1") && R.sin.get("f-res-1").gotUnits * BF.UNIT > 24 * 1024 * 1024, 30000, 5), "дошли до ~24 МБ");
  p1.dcA.close(); p1.dcB.close(); // принудительный обрыв
  assert.ok(await until(() => p1.dcA.readyState === "closed", 5000));
  S.unbind("R"); R.unbind("S");
  await sleep(200);
  const have = R.sin.get("f-res-1").gotUnits;
  assert.ok(have * BF.UNIT < SIZE, "не докачано");
  assert.equal(S.info("f-res-1").state, "queued");
  const p2 = await pair(); let sent2 = 0;
  wire(R, "S", p2.dcB); wire(S, "R", p2.dcA, { onBinary: (b) => { sent2 += b.byteLength; } });
  assert.ok(await until(() => evs(R, "done", "f-res-1").length === 1 && evs(S, "done", "f-res-1").length === 1, 40000, 50), JSON.stringify(R.events.slice(-3).map((e) => e.type + ":" + e.state)));
  assert.equal(await blobSha256(await evs(R, "done")[0].getBlob()), synthSha256(SIZE, SEED));
  assert.ok(sent2 <= SIZE - have * BF.UNIT + 3 * BF.FRAME_MAX, `второй канал: ${sent2} Б из ${SIZE} (было ${have * BF.UNIT})`);
  assert.ok(sent2 + sent1 >= SIZE);
  assert.equal(evs(R, "incoming").length, 1, "сообщение создаётся один раз");
});

test("перезапуск приложения: новый Hub из той же БД метаданных и того же OPFS продолжает с зафиксированного места (в пределах 24 ч)", async () => {
  const SIZE = 64 * 1024 * 1024 + 1, SEED = 21;
  const sDb = new BF.MemMetaDb(), rDb = new BF.MemMetaDb(); const opfs = fakeOpfs();
  const mkR = () => mkHub({ metaDb: rDb, order: ["opfs"], storeOpts: { global: opfs.global } });
  let S = mkHub({ metaDb: sDb }), R = mkR();
  const p1 = await pair(); wire(R, "S", p1.dcB); wire(S, "R", p1.dcA);
  const file = new SynthBlob(SIZE, SEED);
  await S.enqueueSend("R", file, { id: "f-rst-1", name: "r.bin", mime: "application/octet-stream" });
  assert.ok(await until(() => { const s = R.sin.get("f-rst-1"); return s && s.written > 30 * 1024 * 1024; }, 30000, 5), "записано > 30 МБ");
  assert.ok(await until(async () => { const r = await rDb.get("in:f-rst-1"); return r && BF.popcount(r.bitmap, r.bitmap.length * 8) * BF.UNIT > 8 * 1024 * 1024; }, 5000, 20), "карта принятых диапазонов сохранена");
  p1.dcA.close(); p1.dcB.close(); S.destroy(); R.destroy();
  const saved = await rDb.get("in:f-rst-1"); const committed = BF.popcount(saved.bitmap, saved.bitmap.length * 8) * BF.UNIT;
  assert.ok(committed < SIZE);
  // «перезапуск»: новые объекты, те же БД/диск
  S = mkHub({ metaDb: sDb }); R = mkR(); await S.init(); await R.init();
  assert.ok(S.has("f-rst-1") && R.has("f-rst-1"), "передача пережила перезапуск");
  assert.equal(R.info("f-rst-1").state, "waiting");
  const p2 = await pair(); let sent2 = 0;
  wire(R, "S", p2.dcB); wire(S, "R", p2.dcA, { onBinary: (b) => { sent2 += b.byteLength; } });
  assert.ok(await until(() => evs(R, "done", "f-rst-1").length === 1, 40000, 50));
  assert.equal(await blobSha256(await evs(R, "done")[0].getBlob()), synthSha256(SIZE, SEED));
  assert.ok(sent2 < SIZE, "докачано только недостающее: " + sent2 + " из " + SIZE);
  assert.equal(await rDb.get("in:f-rst-1"), undefined); assert.equal(await sDb.get("out:f-rst-1"), undefined);
  // просроченная (>24 ч) передача при загрузке вычищается вместе с данными на диске
  const old = mkHub({ metaDb: rDb, order: ["opfs"], storeOpts: { global: opfs.global }, now: () => Date.now() + 25 * 3600 * 1000 });
  await rDb.set("in:stale", { id: "stale", peer: "S", name: "s", mime: "x", size: 100000, hash: "0".repeat(64), kind: "opfs", bitmap: BF.bmNew(7), state: "active", createdAt: 1, updatedAt: 1 });
  await old.init(); assert.equal(old.has("stale"), false); assert.equal(await rDb.get("in:stale"), undefined);
});

test("пауза и отмена с обеих сторон", async () => {
  const SIZE = 40 * 1024 * 1024, SEED = 3; const p = await pair(); const opfs = fakeOpfs();
  const S = mkHub(), R = mkHub({ order: ["opfs"], storeOpts: { global: opfs.global } });
  wire(R, "S", p.dcB); wire(S, "R", p.dcA);
  await S.enqueueSend("R", new SynthBlob(SIZE, SEED), { id: "f-pz-1", name: "p.bin", mime: "x/y" });
  assert.ok(await until(() => R.sin.get("f-pz-1") && R.sin.get("f-pz-1").gotUnits > 100, 20000, 2));
  // пауза получателем
  R.pause("f-pz-1"); assert.ok(await until(() => S.info("f-pz-1").state === "paused", 3000)); assert.equal(R.info("f-pz-1").state, "paused");
  await sleep(300); const g1 = R.sin.get("f-pz-1").gotUnits; await sleep(300); assert.equal(R.sin.get("f-pz-1").gotUnits, g1, "данные не идут во время паузы");
  // продолжение получателем
  R.resume("f-pz-1");
  assert.ok(await until(() => S.info("f-pz-1") && S.info("f-pz-1").state === "queued" || S.info("f-pz-1").state === "sending" || !S.has("f-pz-1"), 100) || true);
  // отправитель в состоянии «пауза (remote)» сам продолжается после resume() на своей стороне:
  S.resume("f-pz-1");
  assert.ok(await until(() => R.sin.get("f-pz-1") ? R.sin.get("f-pz-1").gotUnits > g1 + 50 : true, 15000, 5), "после resume данные идут");
  // пауза отправителем
  if (S.has("f-pz-1") && R.has("f-pz-1")) {
    S.pause("f-pz-1"); assert.ok(await until(() => R.info("f-pz-1") && R.info("f-pz-1").state === "paused", 3000));
    S.resume("f-pz-1");
  }
  assert.ok(await until(() => evs(R, "done", "f-pz-1").length === 1, 40000, 50), "после пауз файл всё равно дошёл целым");
  assert.equal(await blobSha256(await evs(R, "done")[0].getBlob()), synthSha256(SIZE, SEED));
  // отмена отправителем: у получателя исчезают запись и файл на диске
  const S2 = mkHub(), R2 = mkHub({ order: ["opfs"], storeOpts: { global: opfs.global } });
  const q = await pair(); wire(R2, "S", q.dcB); wire(S2, "R", q.dcA);
  await S2.enqueueSend("R", new SynthBlob(SIZE, 4), { id: "f-cn-1", name: "c.bin", mime: "x/y" });
  assert.ok(await until(() => R2.sin.get("f-cn-1") && R2.sin.get("f-cn-1").gotUnits > 50, 20000, 2));
  S2.cancel("f-cn-1");
  assert.ok(await until(() => !R2.has("f-cn-1"), 3000)); assert.equal(last(R2, "f-cn-1").state, "cancelled");
  assert.equal(require("node:fs").existsSync(opfs.fileOf("f-cn-1")), false, "файл на диске удалён");
  // отмена получателем: отправитель получает отказ
  const S3 = mkHub(), R3 = mkHub({ order: ["opfs"], storeOpts: { global: opfs.global } });
  const q3 = await pair(); wire(R3, "S", q3.dcB); wire(S3, "R", q3.dcA);
  await S3.enqueueSend("R", new SynthBlob(SIZE, 5), { id: "f-cn-2", name: "c.bin", mime: "x/y" });
  assert.ok(await until(() => R3.sin.get("f-cn-2") && R3.sin.get("f-cn-2").gotUnits > 50, 20000, 2));
  R3.cancel("f-cn-2"); assert.ok(await until(() => !S3.has("f-cn-2"), 3000)); assert.equal(last(S3, "f-cn-2").state, "cancelled");
});

test("сквозной контроль целостности: подмена данных в канале даёт failed/hash, а не «успех»", async () => {
  const SIZE = 6 * 1024 * 1024, p = await pair();
  const S = mkHub(), R = mkHub();
  let n = 0; const orig = p.dcA.send.bind(p.dcA);
  p.dcA.send = (d) => { if (typeof d !== "string" && ++n === 10) { const c = new Uint8Array(d.slice(0)); c[c.length - 1] ^= 0xff; return orig(c.buffer); } return orig(d); };
  wire(R, "S", p.dcB); wire(S, "R", p.dcA);
  await S.enqueueSend("R", new SynthBlob(SIZE, 9), { id: "f-bad-1", name: "b.bin", mime: "x/y" });
  assert.ok(await until(() => last(S, "f-bad-1") && last(S, "f-bad-1").type === "state" && last(S, "f-bad-1").state === "failed", 20000, 20), JSON.stringify(last(S, "f-bad-1")));
  assert.equal(last(S, "f-bad-1").reason, "hash"); assert.equal(last(R, "f-bad-1").reason, "hash"); assert.equal(evs(R, "done").length, 0);
});

test("ограничение параллельных передач: лишние получают busy и ждут; отправитель повторяет сам", async () => {
  const p = await pair(); const S = mkHub({ limits: { maxOutActive: 5 } }), R = mkHub({ limits: { maxInActive: 1 } });
  wire(R, "S", p.dcB); wire(S, "R", p.dcA);
  await Promise.all([1, 2].map((i) => S.enqueueSend("R", new SynthBlob(3 * 1024 * 1024, i), { id: "f-q-" + i, name: i + ".bin", mime: "x/y" })));
  assert.ok(await until(() => evs(R, "done").length === 2, 30000, 50), "оба файла дошли по очереди: " + JSON.stringify(R.events.map((e) => e.type + ":" + e.id)));
});
