// =====================================================================
// Шифрование данных на устройстве (C5): переписка, очередь отправки, ключи Double Ratchet и приватный ключ личности лежат в localStorage
// в зашифрованном виде (AES-256-GCM), ключ выводится из PIN (PBKDF2-SHA256). После ввода PIN значения расшифровываются в память, а
// дальше приложение работает как обычно: Storage.prototype.getItem/setItem для защищаемых ключей отдают и принимают открытый текст,
// а на диск уходит шифртекст. Файлы (фото, голосовые) в IndexedDB шифруются отдельным ключом (HKDF от основного).
//
// V.80: шифрование «в покое» включено ПО УМОЛЧАНИЮ и без PIN. Ключ устройства — неизвлекаемый AES-GCM CryptoKey (WebCrypto), лежит в
// отдельной IndexedDB «ether-keys» (структурное клонирование CryptoKey, сырых байтов ключа нет нигде). Формат тот же: версия-префикс
// "encd1:", случайный IV на запись, AAD = имя ключа. С PIN слои вложены: encd1(enc1(данные)) — PIN-ключ внутри, ключ устройства снаружи;
// снятие PIN оставляет слой ключа устройства. Паника/сброс удаляют ключ устройства (crypto-shred): данные нечитаемы мгновенно.
// Честные границы ключа устройства (подробнее — docs/THREAT-MODEL.md §3.4): ключ лежит в том же профиле браузера, поэтому он защищает от
// копирования файлов localStorage/IndexedDB по отдельности и от расширений/инструментов, читающих только хранилище значений, но НЕ от кода,
// исполняющегося в нашем origin, и не от полностью скомпрометированного устройства.
//
// Честные границы PIN-режима: защита «в покое» — от того, кто получил копию хранилища БЕЗ PIN. PIN из цифр подбирается офлайн (медленный хэш лишь
// замедляет), поэтому включение требует PIN от 6 цифр, лучше длиннее. Забытый PIN = данные не восстановить (только полный сброс).
// Работающее приложение держит расшифрованное в памяти; от вредоносного кода на странице это не защищает.
// =====================================================================
const SecureStore = (() => {
  const KEYS = ["ether.contacts", "ether.outbox", "ether.ratchet", "ether.pendingNoKey", "ether.heldDeliveries", "ether.drafts", "ether.stories",
    "ether.privKey", "ether.callLog", "ether.scheduledMessages", "ether.groupDeliveryMap", "ether.recentlyDeleted", "ether.lastSeen", "ether.translateApiKey", "ether.claimToken", "ether.sigKey"];
  const PREFIX = "enc1:", DPREFIX = "encd1:", ITER = 250000, MIN_PIN = 6;
  const KDB = "ether-keys", KSTORE = "k", KREC = "device";
  const FLAG = "ether.sec.on", SALT = "ether.sec.salt", CHECK = "ether.sec.check";
  const te = new TextEncoder(), td = new TextDecoder();
  const proto = (typeof Storage !== "undefined") ? Storage.prototype : null;
  const orig = proto ? { get: proto.getItem, set: proto.setItem, del: proto.removeItem } : null;
  let key = null, fileKey = null, cache = null, installed = false, timers = new Map(), pendingWrites = new Set();
  let devKey = null, devFile = null, status = "init", initP = null;
  const written = new Map(), failed = new Set(); // k -> открытое значение, уже лежащее на диске шифртекстом (повторно не шифруем); k -> не удалось записать (квота)
  const secured = (k) => KEYS.indexOf(k) >= 0;
  const rawGet = (k) => orig.get.call(localStorage, k), rawSet = (k, v) => orig.set.call(localStorage, k, v), rawDel = (k) => orig.del.call(localStorage, k);

  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (str) => { const s = atob(str); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; };

  async function derive(pin, saltB64) {
    const base = await crypto.subtle.importKey("raw", te.encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: ITER }, base, 256));
    const main = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
    const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const files = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: te.encode("ether-files"), info: te.encode("file-key-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { main, files };
  }
  async function encStr(k, text, aad, prefix) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad || "") }, k, te.encode(text)));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return (prefix || PREFIX) + b64(out);
  }
  async function decStr(k, packed, aad, prefix) {
    const raw = unb64(packed.slice((prefix || PREFIX).length));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: te.encode(aad || "") }, k, raw.subarray(12));
    return td.decode(pt);
  }

  // Слои: PIN-ключ (внутри) и ключ устройства (снаружи). Любой из них может отсутствовать.
  async function sealWith(pk, dk, k, v) {
    let s = v;
    if (pk) s = await encStr(pk, s, k, PREFIX);
    if (dk) s = await encStr(dk, s, k, DPREFIX);
    return s;
  }
  async function openWith(pk, dk, k, d) {
    let s = d, pin = false;
    if (s.indexOf(DPREFIX) === 0) { if (!dk) throw new Error("secure-nokey"); s = await decStr(dk, s, k, DPREFIX); }
    if (s.indexOf(PREFIX) === 0) { if (!pk) throw new Error("secure-locked"); s = await decStr(pk, s, k, PREFIX); pin = true; }
    return { v: s, pin };
  }
  const isEnc = (v) => typeof v === "string" && (v.indexOf(DPREFIX) === 0 || v.indexOf(PREFIX) === 0);

  // ----- Ключ устройства: отдельная IndexedDB, соединение открывается на время операции и закрывается (иначе deleteDatabase блокируется) -----
  function kdbOp(mode, fn) {
    return new Promise((resolve, reject) => {
      let req; try { req = indexedDB.open(KDB, 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(KSTORE)) req.result.createObjectStore(KSTORE); };
      req.onerror = () => reject(req.error || new Error("kdb"));
      req.onblocked = () => {};
      req.onsuccess = () => {
        const db = req.result; db.onversionchange = () => { try { db.close(); } catch (e) {} };
        let out;
        try {
          const tx = db.transaction(KSTORE, mode);
          out = fn(tx.objectStore(KSTORE));
          tx.oncomplete = () => { try { db.close(); } catch (e) {} resolve(out && "v" in out ? out.v : undefined); };
          tx.onerror = tx.onabort = () => { try { db.close(); } catch (e) {} reject(tx.error || new Error("kdb-tx")); };
        } catch (e) { try { db.close(); } catch (x) {} reject(e); }
      };
    });
  }
  const kdbRead = () => kdbOp("readonly", (st) => { const o = {}; const r = st.get(KREC); r.onsuccess = () => { o.v = r.result; }; return o; });
  // Создать, только если записи ещё нет (get+put в одной транзакции: две вкладки не затрут ключ друг друга)
  async function kdbCreate() {
    const mk = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const rec = { v: 1, key: await mk(), files: await mk(), created: Date.now() };
    return kdbOp("readwrite", (st) => { const o = {}; const g = st.get(KREC); g.onsuccess = () => { if (g.result) o.v = g.result; else { st.put(rec, KREC); o.v = rec; } }; return o; });
  }
  function kdbDelete() {
    return new Promise((res) => {
      let done = false; const fin = () => { if (!done) { done = true; res(); } };
      try { const r = indexedDB.deleteDatabase(KDB); r.onsuccess = r.onerror = r.onblocked = fin; } catch (e) { fin(); }
      setTimeout(fin, 3000);
    });
  }
  const devAvailable = () => !!(proto && typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && crypto.subtle);

  function install() {
    if (installed || !proto) return; installed = true;
    proto.getItem = function (k) { if (this === localStorage && cache && secured(k)) return cache.has(k) ? cache.get(k) : null; return orig.get.call(this, k); };
    proto.setItem = function (k, v) { if (this === localStorage && cache && secured(k)) { cache.set(k, String(v)); schedule(k); return; } return orig.set.call(this, k, v); };
    proto.removeItem = function (k) { if (this === localStorage && cache && secured(k)) { cache.delete(k); written.delete(k); clearTimeout(timers.get(k)); timers.delete(k); rawDel(k); return; } return orig.del.call(this, k); };
  }
  function uninstall() { if (!installed || !proto) return; proto.getItem = orig.get; proto.setItem = orig.set; proto.removeItem = orig.del; installed = false; }
  // Запись шифртекста на диск: сразу (следующим тиком), с ОЧЕРЕДЬЮ на ключ — WebCrypto не гарантирует порядок завершения, и без цепочки
  // более ранний вариант мог бы затереть более новый. Перед самой записью значение сверяется с кэшем: удалённый ключ не «воскресает»,
  // а если за время шифрования значение изменилось, пишет уже следующая запись в цепочке.
  const chains = new Map();
  // Большие значения (переписка в МБ) копим чуть дольше: серия быстрых правок даёт одно шифрование, а не десяток
  function schedule(k) {
    clearTimeout(timers.get(k));
    const v = cache && cache.get(k);
    timers.set(k, setTimeout(() => { timers.delete(k); writeNow(k); }, v && v.length > 200000 ? 300 : 0));
  }
  function writeNow(k, verify) {
    const run = async () => {
      if ((!key && !devKey) || !cache || !cache.has(k)) return;
      const k0 = key, d0 = devKey, v = cache.get(k);
      if (written.get(k) === v) return;                      // на диске уже лежит шифртекст ровно этого значения — не шифруем заново
      let ct;
      try {
        ct = await sealWith(k0, d0, k, v);
        if (verify && (await openWith(k0, d0, k, ct)).v !== v) throw new Error("verify"); // миграция: сначала проверяем, что шифртекст читается
      } catch (e) { failed.add(k); return; }
      if (!cache || !cache.has(k)) return;                   // ключ удалили, пока шифровали
      if (key !== k0 || devKey !== d0) { schedule(k); return; } // PIN сменили/ключ устройства убран — перешифруем актуальным набором
      if (cache.get(k) !== v) return;                        // есть более новое значение — им займётся его собственная запись
      try { rawSet(k, ct); written.set(k, v); failed.delete(k); } catch (e) { failed.add(k); /* квота: прежнее значение (в т.ч. открытый текст миграции) остаётся на диске */ }
    };
    const p = (chains.get(k) || Promise.resolve()).then(run, run);
    chains.set(k, p); pendingWrites.add(p);
    p.finally(() => { pendingWrites.delete(p); if (chains.get(k) === p) chains.delete(k); });
    return p;
  }
  // Дождаться записи всего накопленного (перед сменой ключа, отключением, выгрузкой страницы)
  async function flush() {
    for (const [k, t] of Array.from(timers)) { clearTimeout(t); timers.delete(k); writeNow(k); }
    for (let i = 0; i < 5 && pendingWrites.size; i++) await Promise.all(Array.from(pendingWrites));
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

  const isOn = () => rawGet(FLAG) === "1";
  const isActive = () => !!key;
  async function loadAll() {
    const next = new Map(); written.clear(); failed.clear();
    for (const k of KEYS) {
      const v = rawGet(k); if (v === null) continue;
      if (isEnc(v)) {
        const r = await openWith(key, devKey, k, v);
        next.set(k, r.v);
        if (v.indexOf(DPREFIX) === 0 && !!r.pin === !!key) written.set(k, r.v); // слои на диске совпадают с нужными — перешифровывать не придётся
      } else next.set(k, v); // открытый текст (ещё не мигрирован / не успели зашифровать) принимаем как есть
    }
    cache = next;
  }
  // Привести диск к зашифрованному виду: для каждого ключа с открытым текстом (или без внешнего слоя) — записать шифртекст, предварительно
  // проверив его расшифровкой. Возобновляемо: состояние каждого ключа видно по префиксу, повторный запуск продолжает с оставшихся.
  async function migrateAll() {
    if (!cache) return 0;
    const want = devKey ? DPREFIX : PREFIX, jobs = [];
    for (const k of cache.keys()) { const d = rawGet(k); if (d !== null && d.indexOf(want) !== 0) jobs.push(writeNow(k, true)); }
    await Promise.all(jobs);
    return pending();
  }
  const pending = () => { let n = 0; for (const k of KEYS) { const d = rawGet(k); if (d !== null && !isEnc(d)) n++; } return n; };
  // Проверка PIN без изменения состояния
  async function verify(pin) {
    const salt = rawGet(SALT), chk = rawGet(CHECK); if (!salt || !chk) return false;
    try { const d = await derive(pin, salt); return (await decStr(d.main, chk, "check")) === "ether" ? d : false; } catch (e) { return false; }
  }
  // ----- Старт: ключ устройства, расшифровка в память, миграция. Вызывается один раз до startApp(). Возвращает режим -----
  function init() { return initP || (initP = doInit()); }
  async function doInit() {
    if (!devAvailable()) { status = "none"; return status; }
    const diskHasDev = KEYS.some((k) => (rawGet(k) || "").indexOf(DPREFIX) === 0);
    let rec = null, readErr = false;
    try { rec = await kdbRead(); } catch (e) { readErr = true; }
    if (!rec || !rec.key) {
      if (diskHasDev) { status = "keylost"; return status; } // данные есть, ключа нет: НЕ создаём новый (молча затёрли бы шанс) — экран восстановления
      if (readErr) { status = "none"; return status; }
      try { rec = await kdbCreate(); } catch (e) { status = "none"; return status; }
    }
    devKey = rec.key; devFile = rec.files;
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {}); } catch (e) {}
    if (isOn()) { status = "pin"; return status; }           // PIN включён: значения откроет unlock()
    try { await loadAll(); } catch (e) { cache = null; devKey = null; devFile = null; status = "keylost"; return status; }
    install(); status = "device";
    await migrateAll();
    return status;
  }
  let unlocking = null;
  async function unlock(pin) {
    if (!isOn()) return true;
    if (key) return true;                                    // уже открыто (двойное нажатие «Войти»)
    if (unlocking) return unlocking;
    unlocking = (async () => {
      const d = await verify(pin); if (!d) return false;
      key = d.main; fileKey = d.files;
      try { await loadAll(); } catch (e) { key = null; fileKey = null; cache = null; throw new Error("secure-corrupt"); }
      install(); status = "pin";
      migrateAll();                                          // доводим «недописанное»/без слоя ключа устройства (фоном, кэш уже готов)
      return true;
    })();
    try { return await unlocking; } finally { unlocking = null; }
  }
  const readPlainDisk = () => { const m = new Map(); for (const k of KEYS) { const v = rawGet(k); if (v !== null) m.set(k, v); } return m; };
  const sameMap = (a, b) => a.size === b.size && Array.from(a).every(([k, v]) => b.get(k) === v);
  // Записать набор ключей на диск ОДНИМ синхронным блоком (без await между записями) с откатом: либо всё, либо ничего.
  // Порядок: соль и проверочное значение — до шифртекста, флаг — последним, чтобы любой обрыв оставлял читаемое состояние.
  function commitSync(writes, extra) {
    const names = [...writes.keys(), ...Object.keys(extra)];
    const saved = new Map(names.map((k) => [k, rawGet(k)]));
    try {
      for (const [k, v] of Object.entries(extra)) if (k !== FLAG) rawSet(k, v);
      for (const [k, v] of writes) rawSet(k, v);
      if (FLAG in extra) rawSet(FLAG, extra[FLAG]);
    } catch (e) {
      for (const [k, v] of saved) { try { if (v === null) rawDel(k); else rawSet(k, v); } catch (x) {} }
      throw e;
    }
  }
  // Диск -> открытый текст (с заданными слоями ключей)
  async function readDiskPlain(pk) { const m = new Map(); for (const [k, v] of readPlainDisk()) m.set(k, isEnc(v) ? (await openWith(pk, devKey, k, v)).v : v); return m; }
  async function sealAll(snap, pk, dk) { const m = new Map(); for (const [k, v] of snap) m.set(k, (pk || dk) ? await sealWith(pk, dk, k, v) : v); return m; }
  const markWritten = (snap) => { written.clear(); for (const [k, v] of snap) written.set(k, v); };
  async function enable(pin) {
    if (isOn()) return true;
    if (String(pin).length < MIN_PIN) throw new Error("pin-short");
    const saltB64 = b64(crypto.getRandomValues(new Uint8Array(16)));
    const d = await derive(pin, saltB64);
    const check = await encStr(d.main, "ether", "check");
    // Шифруем в памяти, пока не убедимся, что за время шифрования ничего не изменилось (иначе запись другого кода была бы затёрта)
    let plain = new Map(), encd = new Map();
    for (let attempt = 0; attempt < 5; attempt++) {
      if (cache) { await flush(); plain = new Map(cache); encd = await sealAll(plain, d.main, devKey); if (sameMap(cache, plain)) break; }
      else { const snap = readPlainDisk(); plain = await readDiskPlain(null); encd = await sealAll(plain, d.main, devKey); if (sameMap(readPlainDisk(), snap)) break; }
      if (attempt === 4) throw new Error("secure-busy");
    }
    commitSync(encd, { [SALT]: saltB64, [CHECK]: check, [FLAG]: "1" });
    key = d.main; fileKey = d.files; cache = plain; markWritten(plain); status = "pin"; install();
    return true;
  }
  async function disable(pin) {
    if (!isOn()) return true;
    const d = key ? { main: key } : await verify(pin);
    if (!d) return false;
    if (!cache) { // заперто: открытого текста в памяти нет — расшифровываем с диска и оставляем слой ключа устройства
      const plainDisk = await readDiskPlain(d.main), encd = await sealAll(plainDisk, null, devKey);
      commitSync(encd, {}); rawDel(FLAG); rawDel(SALT); rawDel(CHECK); key = null; fileKey = null;
      if (devKey) { cache = plainDisk; markWritten(plainDisk); status = "device"; install(); } else uninstall();
      return true;
    }
    await flush();
    // Правда — в кэше (а не на диске): берём снимок, шифруем только ключом устройства и переключаем всё синхронно
    let snap = new Map(cache), encd = new Map();
    for (let attempt = 0; attempt < 5; attempt++) {
      snap = new Map(cache); encd = await sealAll(snap, null, devKey);
      if (sameMap(cache, snap)) break;
      if (attempt === 4) throw new Error("secure-busy");
    }
    if (!devKey) uninstall();
    commitSync(encd, {}); // при ошибке записи диск откатывается к прежнему шифртексту, данные не теряются
    for (const k of KEYS) if (!snap.has(k)) rawDel(k);
    rawDel(FLAG); rawDel(SALT); rawDel(CHECK);
    key = null; fileKey = null; markWritten(snap); status = devKey ? "device" : "none";
    if (!devKey) cache = null;
    return true;
  }
  // Смена PIN: перешифровать всё новым ключом
  async function rekey(oldPin, newPin) {
    if (!isOn()) return true;
    if (String(newPin).length < MIN_PIN) throw new Error("pin-short");
    const d = key ? { main: key } : await verify(oldPin); if (!d) return false;
    if (!cache) throw new Error("secure-locked");
    await flush();
    const saltB64 = b64(crypto.getRandomValues(new Uint8Array(16)));
    const nd = await derive(newPin, saltB64);
    const check = await encStr(nd.main, "ether", "check");
    let snap = new Map(cache), encd = new Map();
    for (let attempt = 0; attempt < 5; attempt++) {
      encd = await sealAll(snap, nd.main, devKey);
      if (sameMap(cache, snap)) break;           // за время шифрования кто-то писал — повторяем со свежим снимком
      snap = new Map(cache);
      if (attempt === 4) throw new Error("secure-busy");
    }
    commitSync(encd, { [SALT]: saltB64, [CHECK]: check });
    key = nd.main; fileKey = nd.files; markWritten(snap); // с этого момента новые записи идут новым ключом
    return true;
  }
  // Crypto-shred (паника/полный сброс): ключ устройства удаляется сразу, память очищается, отложенные записи отменяются.
  // Данные на диске (и копия в IndexedDB) остаются шифртекстом без ключа. Возвращает промис удаления БД ключа.
  function shred() {
    key = null; fileKey = null; devKey = null; devFile = null; cache = null; written.clear(); failed.clear();
    for (const t of timers.values()) clearTimeout(t); timers.clear();
    status = "shredded";
    return kdbDelete();
  }
  // Файлы (blob) в IndexedDB: { __enc: 1, iv, data, type } — только PIN-слой (прежний формат); { __enc: 2, iv, iv1, data, type } — слой ключа
  // устройства (iv/data) поверх необязательного PIN-слоя (iv1)
  const encBuf = (k, buf) => { const iv = crypto.getRandomValues(new Uint8Array(12)); return crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, buf).then((data) => ({ iv, data })); };
  async function sealBlob(blob, opts) {
    if (!(blob instanceof Blob)) return blob;
    const pk = opts && opts.deviceOnly ? null : fileKey;
    if (!pk && !devFile) return blob;
    let buf = await blob.arrayBuffer(), iv1 = null;
    if (pk) { const r = await encBuf(pk, buf); iv1 = r.iv; buf = r.data; }
    if (!devFile) return { __enc: 1, iv: iv1.buffer, data: buf, type: blob.type || "" };
    const r2 = await encBuf(devFile, buf);
    return { __enc: 2, iv: r2.iv.buffer, iv1: iv1 ? iv1.buffer : null, data: r2.data, type: blob.type || "" };
  }
  async function openBlob(v) {
    if (!v || !v.__enc) return v;
    try {
      let buf = v.data;
      if (v.__enc === 2) { if (!devFile) return null; buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(v.iv) }, devFile, buf); if (v.iv1) { if (!fileKey) return null; buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(v.iv1) }, fileKey, buf); } }
      else { if (!fileKey) return null; buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(v.iv) }, fileKey, buf); }
      return new Blob([buf], { type: v.type || "" });
    } catch (e) { return null; } // заперто / ключ другой — файл недоступен
  }
  // Короткие строки (снимок «contactsPrev» в IndexedDB)
  async function sealText(text) { return (key || devKey) ? sealWith(key, devKey, "idb-text", text) : text; }
  async function openText(v) { if (!isEnc(v)) return v; try { return (await openWith(key, devKey, "idb-text", v)).v; } catch (e) { return null; } }
  const mode = () => (status === "keylost" || status === "shredded" ? status : isOn() ? "pin" : status === "device" ? "device" : status);
  return { sealText, openText, KEYS, MIN_PIN, isOn, isActive, enable, disable, unlock, rekey, verify, flush, sealBlob, openBlob, rawGet, rawSet, rawDel,
    init, shred, mode, pending, retryMigration: migrateAll, sealing: () => !!(key || devKey), hasDevice: () => !!devKey, DPREFIX };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SecureStore;
