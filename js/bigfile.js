// V.80: большие файлы по P2P (до 4 ГБ) — бинарный протокол поверх RTCDataChannel без base64, потоковая запись на диск у получателя,
// целостность SHA-256, докачка (resume) после обрыва/перезапуска, пауза/отмена, защита от враждебного пира.
// Чистая логика без DOM: работает и в браузере (EtherBigFile в бандле core), и в Node (тесты). Транспорт, хранилища и БД метаданных
// подставляются снаружи. Формат кадра и сообщения — в docs/BIGFILE-PROTOCOL.md не вынесены: коротко ниже.
//
//  Возможность `filebin1` объявляется в ping/pong (поле fb:1), как rc/e2. Старый пир его не шлёт — тогда остаётся прежний путь
//  (file-meta/file-chunk/file-done с base64 в JSON, ≤ 2 МБ) либо большие файлы отклоняются на стороне отправителя.
//  JSON: file-meta{bin:1,u,h,crc,totalChunks}  file-resume{id,ep,ranges}  file-end{id,ep}  file-ack{id,ep,n}  file-result{id,ok,reason}
//        file-reject{id,reason}  file-pause{id}  file-cancel{id,reason}.
//  Двоичный кадр (один ArrayBuffer): [0xEB][ver=1][idLen][flags: bit0=crc] [u32 индекс первого блока][u32 длина][u32 crc32] [id ASCII] [данные].
//  Блок (unit) = 16 КиБ — единица учёта (битовая карта, докачка). Кадр несёт 1..15 блоков подряд (16–240 КиБ полезной нагрузки, по умолчанию 64 КиБ; всё сообщение ≤ 256 КиБ).
//
//  Платформы (что проверено только логикой, не на устройстве): OPFS createWritable есть в Chrome/Edge/Firefox-desktop; в Safari (в т.ч. iOS) его нет на главном потоке —
//  там срабатывает запасной IndexedDB (Blob-значения; на iOS нужен iOS ≥ 15). Квота iOS Safari ~ доли свободного места и вытесняется при нехватке — отсюда проверка
//  navigator.storage.estimate() и navigator.storage.persist(). Фоновая вкладка/блокировка экрана на iOS замораживают таймеры и DataChannel — передача встанет и
//  продолжится докачкой при возврате (resume), поэтому гарантий «передача при погашенном экране» нет. showSaveFilePicker (FSA) — только Chromium desktop, и только из жеста пользователя.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.EtherBigFile = factory(root);
  }
})(typeof self !== "undefined" ? self : this, function (root) {
  const G = typeof globalThis !== "undefined" ? globalThis : root;
  // SCTP-сообщение не должно превышать 256 КиБ (maxMessageSize у Chrome/Safari/wrtc; больше — канал молча закрывается), а кадр = заголовок (≤80 Б) + полезная нагрузка:
  // поэтому максимум — 15 блоков (240 КиБ), а не ровно 256.
  const UNIT = 16384, FRAME_MIN = 16384, FRAME_DEFAULT = 65536, FRAME_MAX = 15 * 16384;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const HEX64 = /^[0-9a-f]{64}$/;
  const KINDS = new Set(["file-resume", "file-ack", "file-end", "file-result", "file-reject", "file-pause", "file-cancel"]);
  const DEFAULTS = {
    maxSize: 4 * 1024 * 1024 * 1024, memoryCap: 64 * 1024 * 1024, ttlMs: 24 * 3600 * 1000,
    maxInActive: 3, maxInTotal: 20, maxOutActive: 2, windowBytes: 8 * 1024 * 1024, pendingCap: 32 * 1024 * 1024,
    violationLimit: 20, highWater: 1024 * 1024, lowWater: 256 * 1024, ackEvery: 1024 * 1024, progressMs: 200,
    handshakeRetryMs: 5000, handshakeMaxRetries: 12, stallMs: 60000, drainTimeoutMs: 30000, quotaMargin: 64 * 1024 * 1024,
    maxRanges: 512,
  };

  // ---------- SHA-256 (потоковый) и CRC32 ----------
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  class Sha256 {
    constructor() {
      this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
      this.buf = new Uint8Array(64); this.bl = 0; this.len = 0; this.w = new Uint32Array(64);
    }
    _block(d, o) {
      const w = this.w, h = this.h;
      for (let i = 0; i < 16; i++, o += 4) w[i] = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h[0], b = h[1], c = h[2], dd = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += dd; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    update(u8) {
      let i = 0; const n = u8.length; this.len += n;
      if (this.bl) {
        while (i < n && this.bl < 64) this.buf[this.bl++] = u8[i++];
        if (this.bl < 64) return this;
        this._block(this.buf, 0); this.bl = 0;
      }
      for (; i + 64 <= n; i += 64) this._block(u8, i);
      while (i < n) this.buf[this.bl++] = u8[i++];
      return this;
    }
    digest() {
      const bits = this.len * 8, pad = new Uint8Array(((this.bl < 56 ? 56 : 120) - this.bl) + 8);
      pad[0] = 0x80;
      const hi = Math.floor(bits / 4294967296), lo = bits >>> 0, n = pad.length;
      pad[n - 8] = hi >>> 24; pad[n - 7] = hi >>> 16; pad[n - 6] = hi >>> 8; pad[n - 5] = hi;
      pad[n - 4] = lo >>> 24; pad[n - 3] = lo >>> 16; pad[n - 2] = lo >>> 8; pad[n - 1] = lo;
      const saved = this.len; this.update(pad); this.len = saved;
      let out = ""; for (let i = 0; i < 8; i++) out += (this.h[i] >>> 0).toString(16).padStart(8, "0");
      return out;
    }
  }
  const CRC_T = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[i] = c >>> 0; }
  function crc32(u8, prev) {
    let c = ~(prev || 0);
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // ---------- кадры ----------
  function encodeFrame(id, index, payload, withCrc) {
    const idb = new Uint8Array(id.length); for (let i = 0; i < id.length; i++) idb[i] = id.charCodeAt(i) & 127;
    const hl = 16 + idb.length, out = new Uint8Array(hl + payload.length), dv = new DataView(out.buffer);
    out[0] = 0xeb; out[1] = 1; out[2] = idb.length; out[3] = withCrc ? 1 : 0;
    dv.setUint32(4, index); dv.setUint32(8, payload.length); dv.setUint32(12, withCrc ? crc32(payload) : 0);
    out.set(idb, 16); out.set(payload, hl);
    return out.buffer;
  }
  // null — не наш/битый кадр. Длина в заголовке обязана совпасть с фактической (иначе кадр враждебный).
  function decodeFrame(ab) {
    let u8;
    if (ab && ab.byteLength != null && typeof ab.slice === "function" && !ArrayBuffer.isView(ab)) u8 = new Uint8Array(ab);
    else if (ab && ArrayBuffer.isView(ab)) u8 = new Uint8Array(ab.buffer, ab.byteOffset, ab.byteLength);
    else return null;
    if (u8.length < 17 || u8[0] !== 0xeb || u8[1] !== 1) return null;
    const idLen = u8[2], hl = 16 + idLen;
    if (idLen < 1 || idLen > 64 || u8.length < hl) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let id = ""; for (let i = 0; i < idLen; i++) id += String.fromCharCode(u8[16 + i]);
    const index = dv.getUint32(4), length = dv.getUint32(8), crc = dv.getUint32(12);
    return { id, index, length, crc, hasCrc: !!(u8[3] & 1), payload: u8.subarray(hl), valid: u8.length - hl === length };
  }

  // ---------- вспомогательное ----------
  function bmNew(n) { return new Uint8Array((n + 7) >> 3); }
  function bmGet(b, i) { return (b[i >> 3] >> (i & 7)) & 1; }
  function bmSet(b, i) { b[i >> 3] |= 1 << (i & 7); }
  function missingRanges(b, total, max) {
    const out = []; let i = 0;
    while (i < total && out.length < max) {
      while (i < total && bmGet(b, i)) { if ((i & 7) === 0 && b[i >> 3] === 255) i += 8; else i++; }
      if (i >= total) break;
      let j = i; while (j < total && !bmGet(b, j)) j++;
      out.push([i, Math.min(j, total)]); i = j;
    }
    return out;
  }
  function popcount(b, total) { let n = 0; for (let i = 0; i < total; i++) n += bmGet(b, i); return n; }
  function unitsOf(size) { return Math.ceil(size / UNIT); }
  function doneBytes(units, size) { return Math.min(size, units * UNIT); }
  // Имя — только для показа/скачивания: убираем разделители путей, управляющие и bidi-символы, ведущие точки, зарезервированные имена Windows.
  function safeFileName(name) {
    let s = String(name == null ? "" : name).replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "").replace(/[\\/:*?"<>|]/g, "_");
    s = s.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
    if (!s) s = "file";
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = "_" + s;
    if (s.length > 120) { const m = s.match(/\.[A-Za-z0-9]{1,10}$/); const ext = m ? m[0] : ""; s = s.slice(0, 120 - ext.length) + ext; }
    return s;
  }
  function validateMeta(m, lim) {
    if (!m || typeof m.id !== "string" || !ID_RE.test(m.id)) return "id";
    if (!Number.isInteger(m.size) || m.size <= 0 || m.size > lim.maxSize) return "size";
    if (m.u !== UNIT || m.totalChunks !== unitsOf(m.size)) return "layout";
    if (typeof m.h !== "string" || !HEX64.test(m.h)) return "hash";
    if (typeof m.name !== "string" || typeof m.mime !== "string") return "meta";
    return null;
  }
  // Какой путь отправки выбрать: офлайн/старый JSON-путь для маленьких, бинарный для больших, отказ если пир старый.
  function chooseFilePath(o) {
    if (o.size <= o.smallMax) return "legacy-p2p"; // малые файлы всегда по прежнему пути (совместимость проводов)
    if (o.size > o.maxSize) return "too-large";
    return o.peerFileBin === false ? "unsupported" : "binary";
  }
  async function readBytes(blob, off, len) {
    const part = blob.slice(off, off + len);
    if (typeof part.arrayBuffer === "function") return new Uint8Array(await part.arrayBuffer());
    return new Promise((res, rej) => { const fr = new G.FileReader(); fr.onload = () => res(new Uint8Array(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(part); });
  }
  async function hashBlob(blob, onProgress, step) {
    step = step || 2 * 1024 * 1024; const h = new Sha256();
    for (let off = 0; off < blob.size; off += step) {
      h.update(await readBytes(blob, off, step));
      if (onProgress) onProgress(Math.min(blob.size, off + step));
    }
    return h.digest();
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("tx aborted")); });

  // ---------- БД метаданных ----------
  class MemMetaDb {
    constructor() { this.m = new Map(); }
    async get(k) { return this.m.get(k); }
    async set(k, v) { this.m.set(k, v); }
    async del(k) { this.m.delete(k); }
    async list(prefix) { return [...this.m].filter(([k]) => k.startsWith(prefix)); }
  }
  const idbCache = new WeakMap();
  function idbOpen(factory) {
    if (idbCache.has(factory)) return idbCache.get(factory);
    const p = new Promise((res, rej) => {
      const r = factory.open("ether-bigfile", 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta"); if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks"); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    idbCache.set(factory, p); return p;
  }
  class IdbMetaDb {
    constructor(factory, keyRange) { this.f = factory || G.indexedDB; this.KR = keyRange || G.IDBKeyRange; }
    async _s(mode) { const db = await idbOpen(this.f); const tx = db.transaction("meta", mode); return [tx.objectStore("meta"), tx]; }
    async get(k) { const [s] = await this._s("readonly"); return reqP(s.get(k)); }
    async set(k, v) { const [s, tx] = await this._s("readwrite"); s.put(v, k); await txDone(tx); }
    async del(k) { const [s, tx] = await this._s("readwrite"); s.delete(k); await txDone(tx); }
    async list(prefix) {
      const [s] = await this._s("readonly");
      const range = this.KR ? this.KR.bound(prefix, prefix + "\uffff") : undefined;
      const keys = await reqP(s.getAllKeys(range)), vals = await reqP(s.getAll(range));
      return keys.map((k, i) => [k, vals[i]]);
    }
  }

  // ---------- хранилища получателя ----------
  // Интерфейс: durable (каждая запись уже сохранена), write(offset,u8), flush(), readSeq(size,cb), blob(mime), abort(), commitDue(sinceBytes,written).
  class MemoryStore {
    static async open(s, o) {
      if (s.size > ((o && o.memoryCap) || DEFAULTS.memoryCap)) throw new Error("memory cap");
      const st = new MemoryStore(); st.kind = "memory"; st.buf = new Uint8Array(s.size); return st;
    }
    constructor() { this.durable = false; this.resumable = false; }
    async write(off, u8) { this.buf.set(u8, off); }
    async flush() {}
    commitDue() { return false; }
    async readSeq(size, cb) { for (let o = 0; o < size; o += 4 << 20) cb(this.buf.subarray(o, Math.min(size, o + (4 << 20)))); }
    async blob(mime) { return new Blob([this.buf], { type: mime }); }
    async abort() { this.buf = null; }
  }
  // Блоки по 64 КиБ — отдельными записями IndexedDB; значение — Blob (в Chrome/Firefox хранится на диске, итоговый Blob собирается ссылками без копии в ОЗУ).
  class IdbStore {
    static async open(s, o) {
      const f = (o && o.idb) || G.indexedDB; if (!f) throw new Error("no idb");
      const st = new IdbStore(); st.kind = "idb"; st.id = s.id; st.f = f; st.db = await idbOpen(f); st.useBlob = typeof G.Blob === "function"; st.KR = (o && o.keyRange) || G.IDBKeyRange; return st;
    }
    constructor() { this.durable = true; this.resumable = true; }
    commitDue() { return false; }
    async write(off, u8) {
      const idx = off / UNIT;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const tx = this.db.transaction("chunks", "readwrite");
          tx.objectStore("chunks").put({ i: idx, d: this.useBlob ? new G.Blob([u8]) : u8.slice().buffer, n: u8.length }, [this.id, idx]);
          await txDone(tx); return;
        } catch (e) { if (attempt || !this.useBlob) throw e; this.useBlob = false; }
      }
    }
    async flush() {}
    _range() { return this.KR.bound([this.id, 0], [this.id, Infinity]); }
    async _batches(cb) {
      let lower = [this.id, -1], open = true;
      while (true) {
        const tx = this.db.transaction("chunks", "readonly"), os = tx.objectStore("chunks");
        const range = this.KR.bound(lower, [this.id, Infinity], open, false);
        const recs = await reqP(os.getAll(range, 64));
        if (!recs.length) return;
        await cb(recs);
        lower = [this.id, recs[recs.length - 1].i]; open = true;
      }
    }
    async readSeq(size, cb) {
      await this._batches(async (recs) => { for (const r of recs) cb(new Uint8Array(typeof r.d.arrayBuffer === "function" ? await r.d.arrayBuffer() : r.d)); });
    }
    async blob(mime) {
      const parts = []; await this._batches((recs) => { for (const r of recs) parts.push(r.d); });
      return new G.Blob(parts, { type: mime });
    }
    stream() {
      const self = this; let lower = [this.id, -1];
      return new G.ReadableStream({
        async pull(ctrl) {
          const tx = self.db.transaction("chunks", "readonly");
          const recs = await reqP(tx.objectStore("chunks").getAll(self.KR.bound(lower, [self.id, Infinity], true, false), 16));
          if (!recs.length) { ctrl.close(); return; }
          for (const r of recs) ctrl.enqueue(new Uint8Array(typeof r.d.arrayBuffer === "function" ? await r.d.arrayBuffer() : r.d));
          lower = [self.id, recs[recs.length - 1].i];
        },
      });
    }
    async abort() {
      const tx = this.db.transaction("chunks", "readwrite"); tx.objectStore("chunks").delete(this._range()); await txDone(tx).catch(() => {});
    }
  }
  // OPFS / выбранный пользователем файл (File System Access): запись через createWritable. В Chrome createWritable с keepExistingData копирует файл,
  // поэтому фиксацию (close → видимость данных после сбоя) делаем редко: геометрически (каждые max(8 МиБ, 25% записанного)).
  class FileHandleStore {
    constructor(kind, fh, onAbort) { this.kind = kind; this.fh = fh; this.w = null; this.durable = false; this.resumable = true; this.onAbort = onAbort; }
    commitDue(since, written) { return since >= Math.max(8 * 1024 * 1024, written * 0.25); }
    async write(off, u8) {
      if (!this.w) this.w = await this.fh.createWritable({ keepExistingData: true });
      await this.w.write({ type: "write", position: off, data: u8 });
    }
    async size() { await this.flush(); return (await this.fh.getFile()).size; }
    async flush() { if (this.w) { const w = this.w; this.w = null; await w.close(); } }
    async readSeq(size, cb) {
      await this.flush(); const f = await this.fh.getFile(), step = 4 << 20;
      for (let o = 0; o < size; o += step) cb(await readBytes(f, o, step));
    }
    async blob(mime) { await this.flush(); const f = await this.fh.getFile(); return f.slice(0, f.size, mime); }
    async abort() { try { if (this.w) { const w = this.w; this.w = null; await (w.abort ? w.abort() : w.close()); } } catch (e) {} if (this.onAbort) await this.onAbort(); }
  }
  const OPFS_DIR = "ether-bigfile";
  const opfs = {
    supported(g) {
      g = g || G;
      try { return !!(g.navigator && g.navigator.storage && typeof g.navigator.storage.getDirectory === "function" && g.FileSystemFileHandle && "createWritable" in g.FileSystemFileHandle.prototype); } catch (e) { return false; }
    },
    async open(s, o) {
      const g = (o && o.global) || G, rootDir = await g.navigator.storage.getDirectory();
      const dir = await rootDir.getDirectoryHandle(OPFS_DIR, { create: true }), fh = await dir.getFileHandle(s.id, { create: true });
      return new FileHandleStore("opfs", fh, async () => { try { await dir.removeEntry(s.id); } catch (e) {} });
    },
  };

  // ---------- Hub ----------
  class Hub {
    constructor(o) {
      o = o || {};
      const FL = G.EtherFileLimits || (typeof require === "function" ? (() => { try { return require("./file-limits.js"); } catch (e) { return null; } })() : null);
      this.lim = Object.assign({}, DEFAULTS, FL ? { maxSize: FL.P2P_MAX_FILE_SIZE, memoryCap: FL.BIG_MEMORY_CAP, ttlMs: FL.BIG_RESUME_TTL_MS } : {}, o.limits || {});
      this.db = o.metaDb || new MemMetaDb();
      this.emitFn = o.onEvent || (() => {});
      this.onMeta = o.onMeta || null;
      this.now = o.now || Date.now;
      this.crcOn = !!o.crc;
      this.persistSender = o.persistSender !== false;
      this.quotaFn = o.quota || defaultQuota;
      this.storeOpts = o.storeOpts || {};
      this.stores = Object.assign({ opfs: (s) => opfs.open(s, this.storeOpts), idb: (s) => IdbStore.open(s, this.storeOpts), memory: (s) => MemoryStore.open(s, Object.assign({ memoryCap: this.lim.memoryCap }, this.storeOpts)) }, o.stores || {});
      this.order = o.order || null;
      this.saveHandleFor = o.saveHandleFor || null; // (meta) -> FileSystemFileHandle | null (только из жеста пользователя)
      this.tr = new Map(); this.sin = new Map(); this.out = new Map(); this.opening = new Set();
      this.timer = null; this.ready = null;
    }
    // ---- события ----
    _emit(ev) { try { this.emitFn(ev); } catch (e) {} }
    _prog(x, dir, done, force) {
      const t = this.now();
      if (!force && x.lastEmit && t - x.lastEmit < this.lim.progressMs) return;
      x.lastEmit = t; this._emit({ type: "progress", dir, id: x.id, peer: x.peer, done, size: x.size, state: x.state });
    }
    _state(x, dir, state, reason) {
      x.state = state; this._emit({ type: "state", dir, id: x.id, peer: x.peer, state, reason: reason || null, done: dir === "in" ? doneBytes(x.gotUnits || 0, x.size) : (x.doneBytes || 0), size: x.size });
    }
    _ensureTimer() {
      if (this.timer) return;
      this.timer = setInterval(() => this._tick(), 2000);
      if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
    }
    async init() {
      if (this.ready) return this.ready;
      this.ready = (async () => {
        const t = this.now();
        for (const [k, r] of await this.db.list("in:")) {
          if (!r || t - (r.updatedAt || 0) > this.lim.ttlMs || r.kind === "memory") { await this._purgeRec(k, r); continue; }
          const s = this._mkIn(r.peer, r, r.kind); s.claim = r.bitmap.slice(); s.got = r.bitmap.slice(); s.gotUnits = popcount(s.got, s.total); s.handle = r.handle || null;
          s.state = r.state === "paused" ? "paused" : "active"; s.waiting = true; s.createdAt = r.createdAt; s.updatedAt = r.updatedAt;
          try { // данные должны реально лежать в хранилище (файл OPFS мог быть вытеснен системой) — иначе начинаем с нуля
            const st = await this._ensureStore(s);
            if (typeof st.size === "function") { const have = await st.size(); let last = -1; for (let i = s.total - 1; i >= 0; i--) if (bmGet(s.got, i)) { last = i; break; } if (last >= 0 && have < Math.min(s.size, (last + 1) * UNIT)) { s.claim = bmNew(s.total); s.got = bmNew(s.total); s.gotUnits = 0; } }
          } catch (e) { await this._purgeRec(k, r); continue; }
          this.sin.set(s.id, s);
        }
        for (const [k, r] of await this.db.list("out:")) {
          if (!r || !r.file || t - (r.createdAt || 0) > this.lim.ttlMs) { await this.db.del(k); continue; }
          const j = this._mkOut(r.peer, r.file, r); j.hash = r.hash; j.state = r.paused ? "paused" : "queued"; this.out.set(j.id, j);
        }
        if (this.sin.size || this.out.size) this._ensureTimer();
      })();
      return this.ready;
    }
    async _purgeRec(k, r) {
      try { if (r && r.kind && r.id && this.stores[r.kind] && r.kind !== "memory") { const st = await this._reopen(r); if (st) await st.abort(); } } catch (e) {}
      await this.db.del(k).catch(() => {});
    }
    async _reopen(r) {
      const f = this.stores[r.kind]; if (!f || r.kind === "memory") return null;
      if (r.kind === "fsa") { if (!r.handle) return null; return new FileHandleStore("fsa", r.handle); }
      return f({ id: r.id, size: r.size });
    }
    // ---- транспорт ----
    bind(peer, t) {
      this.tr.set(peer, t);
      for (const s of this.sin.values()) if (s.peer === peer && s.state === "active") {
        s.waiting = false; this._state(s, "in", "active");
        // Отправитель сам шлёт file-meta при подключении — на него и ответим (без дублей кадров). Свой запрос — страховка, если meta не придёт.
        clearTimeout(s.resumeTimer);
        s.resumeTimer = setTimeout(() => { if (!s.dead && s.state === "active" && !s.waiting && this.now() - s.lastReq > 1500) this._requestRanges(s); }, 700);
        if (s.resumeTimer.unref) s.resumeTimer.unref();
      }
      for (const j of this.out.values()) if (j.peer === peer) {
        if (j.state === "sending" || j.state === "handshake" || j.state === "verifying") { j.tok++; this._handshake(j); }
      }
      this._pumpQueue(); this._ensureTimer();
    }
    unbind(peer) {
      this.tr.delete(peer);
      for (const j of this.out.values()) if (j.peer === peer) {
        j.tok++; this._wake(j);
        if (j.state === "sending" || j.state === "handshake") { j.state = "queued"; this._state(j, "out", "queued", "link"); }
      }
      for (const s of this.sin.values()) if (s.peer === peer && s.state === "active") { s.waiting = true; this._state(s, "in", "active", "link"); }
    }
    isBound(peer) { return this.tr.has(peer); }
    _t(peer) { const t = this.tr.get(peer); return t && t.isOpen() ? t : null; }
    _send(peer, obj) { const t = this._t(peer); return !!(t && t.sendJson(obj)); }
    has(id) { return this.sin.has(id) || this.out.has(id); }
    info(id) {
      const s = this.sin.get(id); if (s) return { dir: "in", state: s.waiting && s.state === "active" ? "waiting" : s.state, done: doneBytes(s.gotUnits, s.size), size: s.size, kind: s.kind };
      const j = this.out.get(id); if (j) return { dir: "out", state: j.state, done: j.doneBytes || 0, size: j.size };
      return null;
    }
    // ---- вход: JSON / бинарь ----
    isBigMessage(p) { return !!p && (KINDS.has(p.kind) || (p.kind === "file-meta" && p.bin === 1)); }
    async handleJson(peer, p) {
      if (!this.isBigMessage(p) || typeof p.id !== "string" || !ID_RE.test(p.id)) return;
      switch (p.kind) {
        case "file-meta": return this._onMeta(peer, p);
        case "file-resume": return this._onResume(peer, p);
        case "file-ack": return this._onAck(peer, p);
        case "file-end": return this._onEnd(peer, p);
        case "file-result": return this._onResult(peer, p);
        case "file-reject": return this._onReject(peer, p);
        case "file-pause": return this._onPause(peer, p);
        case "file-cancel": return this._onCancel(peer, p);
      }
    }
    // ================= ПОЛУЧАТЕЛЬ =================
    _mkIn(peer, m, kind) {
      const total = unitsOf(m.size);
      return { id: m.id, peer, name: m.name, mime: m.mime, size: m.size, total, hash: m.hash || m.h, crc: !!m.crc, kind: kind || null, extra: m.extra || null,
        claim: bmNew(total), got: bmNew(total), gotUnits: 0, store: null, storeP: null, hasher: new Sha256(), hashPos: 0, chain: Promise.resolve(), pendingBytes: 0, viol: 0,
        state: "active", ep: 0, rx: 0, ackSent: 0, ackTimer: null, commitTimer: null, sinceCommit: 0, written: 0, createdAt: this.now(), updatedAt: this.now(), dead: false, lastEmit: 0, waiting: false, completing: false, handle: null, dups: 0, lastReq: 0, resumeTimer: null };
    }
    async _onMeta(peer, m) {
      const bad = validateMeta(m, this.lim);
      if (bad) { if (ID_RE.test(String(m && m.id))) this._send(peer, { kind: "file-reject", id: m.id, reason: bad === "size" ? "size" : "invalid" }); return; }
      const ex = this.sin.get(m.id);
      if (ex) {
        if (ex.peer !== peer || ex.size !== m.size || ex.hash !== m.h) { this._send(peer, { kind: "file-reject", id: m.id, reason: "conflict" }); return; }
        if (ex.dead) return;
        if (ex.state === "paused" && !ex.remotePaused) { this._send(peer, { kind: "file-pause", id: m.id }); return; }
        ex.waiting = false; ex.remotePaused = false;
        if (ex.state === "paused") ex.state = "active";
        if (!(this.now() - ex.lastReq < 3000)) this._requestRanges(ex); // недавний запрос уже в пути — второй вызвал бы повторную раздачу тех же кадров
        this._state(ex, "in", "active"); return;
      }
      const dn = await this.db.get("done:" + m.id);
      if (dn && dn.peer === peer) { this._send(peer, { kind: "file-result", id: m.id, ok: true }); return; }
      if (this.opening.has(m.id)) return;
      const active = [...this.sin.values()].filter((s) => s.state === "active").length;
      if (this.sin.size >= this.lim.maxInTotal) { this._send(peer, { kind: "file-reject", id: m.id, reason: "limit" }); return; }
      if (active >= this.lim.maxInActive) { this._send(peer, { kind: "file-reject", id: m.id, reason: "busy" }); return; }
      this.opening.add(m.id);
      try {
        const meta = { id: m.id, name: safeFileName(m.name), mime: String(m.mime).slice(0, 100), size: m.size, hash: m.h, crc: m.crc === 1,
          extra: { duration: m.duration, wave: m.wave, ttl: m.ttl, forwarded: m.forwarded, fwdFrom: m.fwdFrom, caption: m.caption } };
        if (this.onMeta) { let ok = true; try { ok = await this.onMeta(peer, meta); } catch (e) { ok = false; } if (ok === false) { this._send(peer, { kind: "file-reject", id: m.id, reason: "declined" }); return; } }
        if (!(await this.quotaFn(m.size + this.lim.quotaMargin))) { this._send(peer, { kind: "file-reject", id: m.id, reason: "quota" }); this._emit({ type: "state", dir: "in", id: m.id, peer, state: "failed", reason: "quota", size: m.size, done: 0, fresh: true }); return; }
        const s = this._mkIn(peer, meta, null);
        if (this.saveHandleFor) { try { s.handle = this.saveHandleFor(meta) || null; } catch (e) {} }
        try { await this._openFresh(s); } catch (e) { this._send(peer, { kind: "file-reject", id: m.id, reason: "storage" }); this._emit({ type: "state", dir: "in", id: m.id, peer, state: "failed", reason: "storage", size: m.size, done: 0, fresh: true }); return; }
        this.sin.set(s.id, s); this._ensureTimer();
        await this._persistIn(s);
        this._emit({ type: "incoming", dir: "in", id: s.id, peer, name: s.name, mime: s.mime, size: s.size, extra: meta.extra, store: s.kind });
        this._requestRanges(s);
      } finally { this.opening.delete(m.id); }
    }
    async _openFresh(s) {
      const order = this.order || [s.handle ? "fsa" : null, opfs.supported(G) ? "opfs" : null, G.indexedDB ? "idb" : null, "memory"].filter(Boolean);
      let lastErr;
      for (const kind of order) {
        try {
          if (kind === "fsa") s.store = new FileHandleStore("fsa", s.handle);
          else if (this.stores[kind]) s.store = await this.stores[kind](s); else continue;
          s.kind = s.store.kind || kind; return;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("no storage");
    }
    async _ensureStore(s) {
      if (s.store) return s.store;
      if (!s.storeP) s.storeP = (async () => { s.store = await this._reopen({ kind: s.kind, id: s.id, size: s.size, handle: s.handle }); if (!s.store) throw new Error("store gone"); return s.store; })();
      return s.storeP;
    }
    async _persistIn(s) {
      s.updatedAt = this.now();
      await this.db.set("in:" + s.id, { id: s.id, peer: s.peer, name: s.name, mime: s.mime, size: s.size, hash: s.hash, crc: s.crc, kind: s.kind, handle: s.handle || undefined,
        extra: s.extra, bitmap: s.got.slice(), state: s.state === "paused" ? "paused" : "active", createdAt: s.createdAt, updatedAt: s.updatedAt });
    }
    _requestRanges(s) {
      s.ep++; s.rx = 0; s.ackSent = 0; s.dups = 0; s.lastReq = this.now();
      const ranges = missingRanges(s.claim, s.total, this.lim.maxRanges);
      if (!ranges.length && s.gotUnits === s.total) return;
      this._send(s.peer, { kind: "file-resume", id: s.id, ep: s.ep, ranges });
    }
    _violate(s, why) {
      s.viol++;
      if (s.viol >= this.lim.violationLimit) {
        this._send(s.peer, { kind: "file-cancel", id: s.id, reason: "protocol" });
        this._dropIn(s, "failed", "protocol:" + why);
      }
    }
    handleBinary(peer, ab) {
      const f = decodeFrame(ab); if (!f) return;
      const s = this.sin.get(f.id); if (!s || s.peer !== peer || s.dead) return;
      if (s.state !== "active" || s.completing) return;
      const L = f.length, start = f.index * UNIT;
      if (!f.valid || L <= 0 || L > FRAME_MAX || f.index >= s.total || start + L > s.size || (L % UNIT !== 0 && start + L !== s.size)) return this._violate(s, "frame");
      if (f.hasCrc && crc32(f.payload) !== f.crc) { return this._violate(s, "crc"); }
      if (s.crc && !f.hasCrc) return this._violate(s, "nocrc");
      const n = Math.ceil(L / UNIT);
      for (let u = f.index; u < f.index + n; u++) if (bmGet(s.claim, u)) { if (++s.dups > 700) this._violate(s, "dup"); return; } // дубли после перезапроса диапазонов законны (кадры «в полёте»), но их число ограничено окном
      if (s.pendingBytes + L > this.lim.pendingCap) return this._violate(s, "flood");
      for (let u = f.index; u < f.index + n; u++) bmSet(s.claim, u);
      s.pendingBytes += L;
      if (start === s.hashPos) { s.hasher.update(f.payload); s.hashPos += L; }
      const payload = f.payload;
      s.chain = s.chain.then(async () => {
        if (s.dead) return;
        const st = await this._ensureStore(s);
        await st.write(start, payload);
        for (let u = f.index; u < f.index + n; u++) bmSet(s.got, u);
        s.updatedAt = this.now(); s.gotUnits += n; s.pendingBytes -= L; s.rx += L; s.written += L; s.sinceCommit += L;
        this._prog(s, "in", doneBytes(s.gotUnits, s.size), s.gotUnits === s.total);
        if (s.rx - s.ackSent >= this.lim.ackEvery) this._ack(s); else if (!s.ackTimer) s.ackTimer = setTimeout(() => { s.ackTimer = null; this._ack(s); }, 80);
        if (s.gotUnits === s.total) await this._complete(s);
        else if (s.store.commitDue(s.sinceCommit, s.written)) await this._commit(s);
        else if (s.store.durable && !s.commitTimer) s.commitTimer = setTimeout(() => { s.commitTimer = null; if (!s.dead) s.chain = s.chain.then(() => this._commit(s)).catch(() => {}); }, 1000);
      }).catch((e) => { if (!s.dead) { this._send(s.peer, { kind: "file-cancel", id: s.id, reason: "storage" }); this._dropIn(s, "failed", "storage", true); } });
    }
    _ack(s) {
      if (s.ackTimer) { clearTimeout(s.ackTimer); s.ackTimer = null; }
      if (s.dead || s.rx === s.ackSent) return;
      s.ackSent = s.rx; this._send(s.peer, { kind: "file-ack", id: s.id, ep: s.ep, n: s.rx });
    }
    async _commit(s) {
      if (s.dead) return;
      try { await s.store.flush(); } catch (e) { throw e; }
      s.sinceCommit = 0; await this._persistIn(s);
    }
    async _complete(s) {
      s.completing = true; this._ack(s);
      this._state(s, "in", "verifying");
      let ok = false, reason = "hash";
      try {
        await s.store.flush();
        let digest;
        if (s.hashPos === s.size) digest = s.hasher.digest();
        else { const h = new Sha256(); await s.store.readSeq(s.size, (u8) => h.update(u8)); digest = h.digest(); }
        ok = digest === s.hash;
      } catch (e) { reason = "storage"; }
      if (s.dead) return;
      if (!ok) { this._send(s.peer, { kind: "file-result", id: s.id, ok: false, reason }); this._dropIn(s, "failed", reason, true); return; }
      const rec = { id: s.id, peer: s.peer, name: s.name, mime: s.mime, size: s.size, kind: s.kind, handle: s.handle || undefined, ts: this.now() };
      if (s.kind !== "memory") await this.db.set("done:" + s.id, rec);
      await this.db.del("in:" + s.id).catch(() => {});
      this.sin.delete(s.id); s.dead = true; clearTimeout(s.ackTimer); clearTimeout(s.commitTimer);
      const store = s.store;
      this._send(s.peer, { kind: "file-result", id: s.id, ok: true });
      this._emit({ type: "done", dir: "in", id: s.id, peer: s.peer, size: s.size, name: s.name, mime: s.mime, store: s.kind, getBlob: () => store.blob(s.mime) });
    }
    async _dropIn(s, state, reason, inChain) {
      if (s.dead && !this.sin.has(s.id)) return;
      s.dead = true; clearTimeout(s.ackTimer); clearTimeout(s.commitTimer); this.sin.delete(s.id);
      if (!inChain) await s.chain.catch(() => {});
      try { const st = s.store || (s.kind ? await this._ensureStore(s).catch(() => null) : null); if (st) await st.abort(); } catch (e) {}
      await this.db.del("in:" + s.id).catch(() => {});
      this._emit({ type: "state", dir: "in", id: s.id, peer: s.peer, state, reason: reason || null, size: s.size, done: 0 });
    }
    // ================= ОТПРАВИТЕЛЬ =================
    _mkOut(peer, file, extra) {
      return { id: extra.id, peer, file, name: extra.name || file.name || "file", mime: extra.mime || file.type || "application/octet-stream", size: file.size, total: unitsOf(file.size), hash: null,
        extra: extra.extra || {}, state: "hashing", createdAt: extra.createdAt || this.now(), tok: 0, ep: 0, acked: 0, sentBytes: 0, baseBytes: 0, doneBytes: 0, frame: FRAME_DEFAULT,
        waiters: [], lastEmit: 0, ranges: null, retries: 0, metaAt: 0, busyUntil: 0, pumping: false, paused: false };
    }
    // extra: { id, name, mime, extra:{duration,wave,ttl,caption,forwarded,fwdFrom} }
    async enqueueSend(peer, file, extra) {
      if (!extra || !ID_RE.test(extra.id || "")) throw new Error("bad id");
      if (!file || !(file.size > 0) || file.size > this.lim.maxSize) throw new Error("size");
      if (this.out.has(extra.id)) return this.out.get(extra.id);
      const j = this._mkOut(peer, file, extra); this.out.set(j.id, j); this._ensureTimer();
      this._state(j, "out", "hashing");
      try {
        j.hash = await hashBlob(file, (n) => { if (!j.dead) this._prog(j, "out", n, false); });
      } catch (e) { this.out.delete(j.id); this._state(j, "out", "failed", "read"); return j; }
      if (j.dead) return j;
      if (this.persistSender) { try { await this.db.set("out:" + j.id, { id: j.id, peer, file, name: j.name, mime: j.mime, extra: j.extra, hash: j.hash, createdAt: j.createdAt }); } catch (e) { j.nonResumable = true; } }
      if (j.dead) return j;
      this._state(j, "out", "queued"); this._pumpQueue();
      return j;
    }
    _metaOf(j) {
      const m = { kind: "file-meta", bin: 1, id: j.id, name: j.name, mime: j.mime, size: j.size, totalChunks: j.total, u: UNIT, h: j.hash, crc: this.crcOn ? 1 : 0 };
      const e = j.extra || {};
      if (e.duration != null) m.duration = e.duration;
      if (e.wave) m.wave = e.wave;
      if (e.forwarded) { m.forwarded = true; if (typeof e.fwdFrom === "string" && e.fwdFrom) m.fwdFrom = e.fwdFrom.slice(0, 80); }
      if (Number.isFinite(e.ttl) && e.ttl > 0) m.ttl = e.ttl;
      if (e.caption) m.caption = e.caption;
      return m;
    }
    _handshake(j) {
      j.state = "handshake"; j.metaAt = this.now(); j.pumping = false;
      if (this._send(j.peer, this._metaOf(j))) this._state(j, "out", "handshake");
      else { j.state = "queued"; }
    }
    _pumpQueue() {
      let busy = [...this.out.values()].filter((j) => j.state === "handshake" || j.state === "sending" || j.state === "verifying").length;
      for (const j of this.out.values()) {
        if (busy >= this.lim.maxOutActive) break;
        if (j.state !== "queued" || j.dead || j.busyUntil > this.now() || !this._t(j.peer)) continue;
        this._handshake(j); if (j.state === "handshake") busy++;
      }
    }
    _wake(j) { const w = j.waiters.splice(0); for (const f of w) f(); }
    _onResume(peer, m) {
      const j = this.out.get(m.id);
      if (!j || j.peer !== peer || j.dead) { this._send(peer, { kind: "file-cancel", id: m.id, reason: "unknown" }); return; }
      if (j.state === "hashing" || j.state === "done") return;
      if (j.state === "paused" && !j.remote) { this._send(peer, { kind: "file-pause", id: j.id }); return; } // пауза поставлена здесь — не раздаём; пауза от получателя снимается его же file-resume
      if (!Number.isInteger(m.ep) || !Array.isArray(m.ranges) || m.ranges.length > this.lim.maxRanges) return;
      const ranges = [];
      for (const r of m.ranges) {
        if (!Array.isArray(r) || !Number.isInteger(r[0]) || !Number.isInteger(r[1]) || r[0] < 0 || r[1] > j.total || r[0] >= r[1]) return;
        ranges.push([r[0], r[1]]);
      }
      j.tok++; this._wake(j); // старая раздача (если шла) прекращается
      j.ep = m.ep; j.acked = 0; j.sentBytes = 0; j.ranges = ranges; j.retries = 0;
      let missing = 0; for (const r of ranges) missing += Math.min(j.size, r[1] * UNIT) - r[0] * UNIT;
      j.baseBytes = j.size - missing; j.doneBytes = j.baseBytes;
      j.state = "sending"; this._state(j, "out", "sending");
      this._pump(j, j.tok, ranges, m.ep);
    }
    async _pump(j, tok, ranges, ep) {
      const t = this._t(j.peer); if (!t) return;
      j.pumping = true;
      const alive = () => tok === j.tok && !j.dead && this._t(j.peer) === t;
      let ri = 0, u = ranges.length ? ranges[0][0] : 0;
      const next = () => {
        while (ri < ranges.length && u >= ranges[ri][1]) { ri++; if (ri < ranges.length) u = ranges[ri][0]; }
        if (ri >= ranges.length) return null;
        const nUnits = Math.min(Math.max(1, Math.round(j.frame / UNIT)), ranges[ri][1] - u), off = u * UNIT, len = Math.min(nUnits * UNIT, j.size - off);
        const d = { u, off, len }; u += nUnits; return d;
      };
      const rd = (d) => d && readBytes(j.file, d.off, d.len).then((b) => ({ d, b }), (e) => ({ err: e }));
      let rateT = this.now(), rateB = 0;
      try {
        let cur = rd(next());
        while (cur) {
          const got = await cur; if (!alive()) return;
          if (got.err) { this._send(j.peer, { kind: "file-cancel", id: j.id, reason: "read" }); this._finishOut(j, "failed", "read"); return; }
          cur = rd(next());
          while (j.sentBytes - j.acked >= this.lim.windowBytes) {
            const to = await new Promise((res) => { const tm = setTimeout(() => res(true), this.lim.stallMs); j.waiters.push(() => { clearTimeout(tm); res(false); }); });
            if (!alive()) return;
            if (to) { j.state = "paused"; j.paused = false; this._state(j, "out", "paused", "timeout"); j.pumping = false; return; }
          }
          if (t.bufferedAmount() > this.lim.highWater) {
            const okd = await t.whenLow(this.lim.lowWater, this.lim.drainTimeoutMs); if (!alive()) return;
            if (!okd) { j.pumping = false; return; }
          }
          if (!t.sendBinary(encodeFrame(j.id, got.d.u, got.b, this.crcOn))) { j.pumping = false; return; }
          j.sentBytes += got.d.len; j.doneBytes = Math.min(j.size, j.baseBytes + j.sentBytes);
          this._prog(j, "out", j.doneBytes, false);
          rateB += got.d.len; const now = this.now();
          if (now - rateT >= 1000) { // подстройка размера кадра по измеренной скорости (на медленном канале — мелкие кадры, чтобы не задерживать ping/pong)
            const r = rateB * 1000 / (now - rateT); rateT = now; rateB = 0;
            j.frame = r > 4e6 ? FRAME_MAX : r > 1e6 ? 131072 : r > 256e3 ? FRAME_DEFAULT : r > 64e3 ? 32768 : FRAME_MIN;
          }
        }
        if (!alive()) return;
        j.pumping = false;
        this._send(j.peer, { kind: "file-end", id: j.id, ep });
        j.state = "verifying"; this._state(j, "out", "verifying");
      } catch (e) { j.pumping = false; }
    }
    _onAck(peer, m) {
      const j = this.out.get(m.id); if (!j || j.peer !== peer || m.ep !== j.ep || !Number.isFinite(m.n)) return;
      if (m.n > j.acked) { j.acked = Math.min(m.n, j.sentBytes); this._wake(j); }
    }
    _onEnd(peer, m) { // получатель: отправитель закончил выдачу запрошенных диапазонов
      const s = this.sin.get(m.id); if (!s || s.peer !== peer || s.dead) return;
      s.chain = s.chain.then(() => {
        if (s.dead || s.completing) return;
        if (s.gotUnits < s.total && s.state === "active") { s.retryEnd = (s.retryEnd || 0) + 1; if (s.retryEnd <= 5) this._requestRanges(s); else { this._send(s.peer, { kind: "file-cancel", id: s.id, reason: "incomplete" }); this._dropIn(s, "failed", "incomplete"); } }
      });
    }
    _onResult(peer, m) {
      const j = this.out.get(m.id); if (!j || j.peer !== peer) return;
      if (m.ok === true) this._finishOut(j, "done"); else this._finishOut(j, "failed", typeof m.reason === "string" ? m.reason.slice(0, 40) : "failed");
    }
    _onReject(peer, m) {
      const j = this.out.get(m.id); if (!j || j.peer !== peer) return;
      const reason = typeof m.reason === "string" ? m.reason.slice(0, 40) : "rejected";
      if (reason === "busy") { j.state = "queued"; j.busyUntil = this.now() + 3000; this._state(j, "out", "queued", "busy"); return; }
      this._finishOut(j, "failed", reason);
    }
    _onPause(peer, m) {
      const j = this.out.get(m.id);
      if (j && j.peer === peer) { j.tok++; this._wake(j); j.pumping = false; j.state = "paused"; j.paused = false; j.remote = true; this._state(j, "out", "paused", "remote"); return; }
      const s = this.sin.get(m.id);
      if (s && s.peer === peer) { s.state = "paused"; s.remotePaused = true; this._state(s, "in", "paused", "remote"); }
    }
    _onCancel(peer, m) {
      const j = this.out.get(m.id);
      if (j && j.peer === peer) { this._finishOut(j, "cancelled", typeof m.reason === "string" ? m.reason.slice(0, 40) : "remote"); return; }
      const s = this.sin.get(m.id);
      if (s && s.peer === peer) this._dropIn(s, "cancelled", typeof m.reason === "string" ? m.reason.slice(0, 40) : "remote");
    }
    _finishOut(j, state, reason) {
      j.dead = true; j.tok++; this._wake(j); this.out.delete(j.id);
      this.db.del("out:" + j.id).catch(() => {});
      if (state === "done") { j.doneBytes = j.size; this._emit({ type: "done", dir: "out", id: j.id, peer: j.peer, size: j.size }); }
      else this._emit({ type: "state", dir: "out", id: j.id, peer: j.peer, state, reason: reason || null, size: j.size, done: j.doneBytes || 0 });
      this._pumpQueue();
    }
    // ================= Управление (UI) =================
    pause(id) {
      const j = this.out.get(id);
      if (j) { j.tok++; this._wake(j); j.pumping = false; j.state = "paused"; j.remote = false; this._send(j.peer, { kind: "file-pause", id }); this._state(j, "out", "paused", "local");
        if (this.persistSender) this.db.get("out:" + id).then((r) => r && this.db.set("out:" + id, Object.assign(r, { paused: true }))).catch(() => {}); this._pumpQueue(); return true; }
      const s = this.sin.get(id);
      if (s) { s.state = "paused"; s.remotePaused = false; this._send(s.peer, { kind: "file-pause", id }); s.chain = s.chain.then(() => this._commit(s)).catch(() => {}); this._state(s, "in", "paused", "local"); return true; }
      return false;
    }
    resume(id) {
      const j = this.out.get(id);
      if (j && j.state === "paused") {
        j.state = "queued"; this._state(j, "out", "queued");
        if (this.persistSender) this.db.get("out:" + id).then((r) => r && this.db.set("out:" + id, Object.assign(r, { paused: false }))).catch(() => {});
        this._pumpQueue(); return true;
      }
      const s = this.sin.get(id);
      if (s && s.state === "paused") {
        s.state = "active"; s.remotePaused = false; this._state(s, "in", "active");
        if (this._t(s.peer)) { s.waiting = false; this._requestRanges(s); } else s.waiting = true;
        return true;
      }
      return false;
    }
    cancel(id) {
      const j = this.out.get(id);
      if (j) { this._send(j.peer, { kind: "file-cancel", id, reason: "user" }); this._finishOut(j, "cancelled", "local"); return true; }
      const s = this.sin.get(id);
      if (s) { this._send(s.peer, { kind: "file-cancel", id, reason: "user" }); this._dropIn(s, "cancelled", "local"); return true; }
      return false;
    }
    async getBlob(id) {
      const r = await this.db.get("done:" + id); if (!r) return null;
      const st = await this._reopen(r); return st ? st.blob(r.mime) : null;
    }
    async getStream(id) { // потоковый доступ без сборки Blob (только IDB-хранилище)
      const r = await this.db.get("done:" + id); if (!r) return null;
      const st = await this._reopen(r); if (!st) return null;
      if (typeof st.stream === "function") return st.stream();
      return (await st.blob(r.mime)).stream();
    }
    async discard(id) { // сообщение удалено: освободить диск
      const r = await this.db.get("done:" + id).catch(() => null);
      if (r) { try { const st = await this._reopen(r); if (st) await st.abort(); } catch (e) {} await this.db.del("done:" + id).catch(() => {}); }
      this.cancel(id);
    }
    _tick() {
      const t = this.now();
      for (const j of [...this.out.values()]) {
        if (t - j.createdAt > this.lim.ttlMs) { this._finishOut(j, "failed", "expired"); continue; }
        if (j.state === "handshake" && t - j.metaAt >= this.lim.handshakeRetryMs) {
          if (++j.retries > this.lim.handshakeMaxRetries) { j.state = "queued"; j.retries = 0; this._state(j, "out", "queued", "no-reply"); } else this._handshake(j);
        }
      }
      for (const s of [...this.sin.values()]) {
        if (t - s.updatedAt > this.lim.ttlMs) this._dropIn(s, "failed", "expired");
      }
      this._pumpQueue();
      if (!this.sin.size && !this.out.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    }
    destroy() { if (this.timer) clearInterval(this.timer); this.timer = null; for (const j of this.out.values()) { j.tok++; this._wake(j); } }
  }
  async function defaultQuota(need) {
    try {
      const n = G.navigator; if (!n || !n.storage || typeof n.storage.estimate !== "function") return true;
      const e = await n.storage.estimate(); if (!e || !(e.quota > 0)) return true;
      try { if (typeof n.storage.persist === "function") n.storage.persist(); } catch (x) {}
      return e.quota - (e.usage || 0) >= need;
    } catch (e) { return true; }
  }

  return { UNIT, FRAME_MIN, FRAME_DEFAULT, FRAME_MAX, DEFAULTS, Sha256, crc32, encodeFrame, decodeFrame, hashBlob, readBytes, safeFileName, validateMeta, chooseFilePath, missingRanges, bmNew, bmGet, bmSet, popcount,
    MemMetaDb, IdbMetaDb, MemoryStore, IdbStore, FileHandleStore, opfs, Hub, ID_RE, tick };
});
