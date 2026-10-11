// =====================================================================
// Шифрование данных на устройстве (C5): переписка, очередь отправки, ключи Double Ratchet и приватный ключ личности лежат в localStorage
// в зашифрованном виде (AES-256-GCM), ключ выводится из PIN (PBKDF2-SHA256). После ввода PIN значения расшифровываются в память, а
// дальше приложение работает как обычно: Storage.prototype.getItem/setItem для защищаемых ключей отдают и принимают открытый текст,
// а на диск уходит шифртекст. Файлы (фото, голосовые) в IndexedDB шифруются отдельным ключом (HKDF от основного).
//
// Честные границы: защита «в покое» — от того, кто получил копию хранилища БЕЗ PIN. PIN из цифр подбирается офлайн (медленный хэш лишь
// замедляет), поэтому включение требует PIN от 6 цифр, лучше длиннее. Забытый PIN = данные не восстановить (только полный сброс).
// Работающее приложение держит расшифрованное в памяти; от вредоносного кода на странице это не защищает.
// =====================================================================
const SecureStore = (() => {
  const KEYS = ["ether.contacts", "ether.outbox", "ether.ratchet", "ether.pendingNoKey", "ether.heldDeliveries", "ether.drafts", "ether.stories",
    "ether.privKey", "ether.callLog", "ether.scheduledMessages", "ether.groupDeliveryMap", "ether.recentlyDeleted", "ether.lastSeen"];
  const PREFIX = "enc1:", ITER = 250000, MIN_PIN = 6;
  const FLAG = "ether.sec.on", SALT = "ether.sec.salt", CHECK = "ether.sec.check";
  const te = new TextEncoder(), td = new TextDecoder();
  const proto = (typeof Storage !== "undefined") ? Storage.prototype : null;
  const orig = proto ? { get: proto.getItem, set: proto.setItem, del: proto.removeItem } : null;
  let key = null, fileKey = null, cache = null, installed = false, timers = new Map(), pendingWrites = new Set();
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
  async function encStr(k, text, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad || "") }, k, te.encode(text)));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return PREFIX + b64(out);
  }
  async function decStr(k, packed, aad) {
    const raw = unb64(packed.slice(PREFIX.length));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: te.encode(aad || "") }, k, raw.subarray(12));
    return td.decode(pt);
  }

  function install() {
    if (installed || !proto) return; installed = true;
    proto.getItem = function (k) { if (this === localStorage && cache && secured(k)) return cache.has(k) ? cache.get(k) : null; return orig.get.call(this, k); };
    proto.setItem = function (k, v) { if (this === localStorage && cache && secured(k)) { cache.set(k, String(v)); schedule(k); return; } return orig.set.call(this, k, v); };
    proto.removeItem = function (k) { if (this === localStorage && cache && secured(k)) { cache.delete(k); clearTimeout(timers.get(k)); timers.delete(k); rawDel(k); return; } return orig.del.call(this, k); };
  }
  function uninstall() { if (!installed || !proto) return; proto.getItem = orig.get; proto.setItem = orig.set; proto.removeItem = orig.del; installed = false; }
  // Запись шифртекста на диск: сразу (следующим микротиком), с очередью на ключ — чтобы последний вариант не затёрся более ранним
  function schedule(k) {
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => { timers.delete(k); writeNow(k); }, 0));
  }
  async function writeNow(k) {
    if (!key || !cache || !cache.has(k)) return;
    const p = (async () => { try { rawSet(k, await encStr(key, cache.get(k), k)); } catch (e) { /* квота: прежнее значение на диске остаётся */ } })();
    pendingWrites.add(p); p.finally(() => pendingWrites.delete(p));
    return p;
  }
  // Дождаться записи всего накопленного (перед сменой ключа, отключением, выгрузкой страницы)
  async function flush() {
    for (const [k, t] of Array.from(timers)) { clearTimeout(t); timers.delete(k); await writeNow(k); }
    await Promise.all(Array.from(pendingWrites));
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

  const isOn = () => rawGet(FLAG) === "1";
  const isActive = () => !!key;
  async function loadAll() {
    cache = new Map();
    for (const k of KEYS) {
      const v = rawGet(k); if (v === null) continue;
      cache.set(k, v.indexOf(PREFIX) === 0 ? await decStr(key, v, k) : v); // открытый текст (ещё не успели зашифровать) принимаем как есть
    }
  }
  // Проверка PIN без изменения состояния
  async function verify(pin) {
    const salt = rawGet(SALT), chk = rawGet(CHECK); if (!salt || !chk) return false;
    try { const d = await derive(pin, salt); return (await decStr(d.main, chk, "check")) === "ether" ? d : false; } catch (e) { return false; }
  }
  async function unlock(pin) {
    if (!isOn()) return true;
    const d = await verify(pin); if (!d) return false;
    key = d.main; fileKey = d.files;
    try { await loadAll(); } catch (e) { key = null; fileKey = null; cache = null; throw new Error("secure-corrupt"); }
    install();
    for (const k of KEYS) if (cache.has(k) && (rawGet(k) || "").indexOf(PREFIX) !== 0) writeNow(k); // доводим «недописанное» до шифртекста
    return true;
  }
  async function enable(pin) {
    if (isOn()) return true;
    if (String(pin).length < MIN_PIN) throw new Error("pin-short");
    const saltB64 = b64(crypto.getRandomValues(new Uint8Array(16)));
    const d = await derive(pin, saltB64);
    const plain = new Map();
    for (const k of KEYS) { const v = rawGet(k); if (v !== null) plain.set(k, v.indexOf(PREFIX) === 0 ? await decStr(d.main, v, k) : v); }
    // 1) всё шифруем в памяти; 2) только потом пишем на диск и ставим флаг — обрыв посередине оставляет открытые данные, а не мусор
    const encd = new Map(); for (const [k, v] of plain) encd.set(k, await encStr(d.main, v, k));
    const check = await encStr(d.main, "ether", "check");
    for (const [k, v] of encd) rawSet(k, v);
    rawSet(SALT, saltB64); rawSet(CHECK, check); rawSet(FLAG, "1");
    key = d.main; fileKey = d.files; cache = plain; install();
    return true;
  }
  async function disable(pin) {
    if (!isOn()) return true;
    const d = key ? { main: key } : await verify(pin);
    if (!d) return false;
    await flush();
    const plain = new Map();
    for (const k of KEYS) { const v = rawGet(k); if (v !== null) plain.set(k, v.indexOf(PREFIX) === 0 ? await decStr(d.main, v, k) : v); }
    uninstall();
    for (const [k, v] of plain) rawSet(k, v);
    rawDel(FLAG); rawDel(SALT); rawDel(CHECK);
    key = null; fileKey = null; cache = null;
    return true;
  }
  // Смена PIN: перешифровать всё новым ключом
  async function rekey(oldPin, newPin) {
    if (!isOn()) return true;
    if (String(newPin).length < MIN_PIN) throw new Error("pin-short");
    const d = key ? { main: key } : await verify(oldPin); if (!d) return false;
    await flush();
    const saltB64 = b64(crypto.getRandomValues(new Uint8Array(16)));
    const nd = await derive(newPin, saltB64);
    const encd = new Map(); for (const [k, v] of cache) encd.set(k, await encStr(nd.main, v, k));
    const check = await encStr(nd.main, "ether", "check");
    for (const [k, v] of encd) rawSet(k, v);
    rawSet(SALT, saltB64); rawSet(CHECK, check);
    key = nd.main; fileKey = nd.files;
    return true;
  }
  // Файлы (blob) в IndexedDB: объект { __enc: 1, iv, data (ArrayBuffer), type }
  async function sealBlob(blob) {
    if (!fileKey || !(blob instanceof Blob)) return blob;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, fileKey, await blob.arrayBuffer());
    return { __enc: 1, iv: iv.buffer, data, type: blob.type || "" };
  }
  async function openBlob(v) {
    if (!v || v.__enc !== 1) return v;
    if (!fileKey) return null; // заперто — файл недоступен
    try { return new Blob([await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(v.iv) }, fileKey, v.data)], { type: v.type || "" }); } catch (e) { return null; }
  }
  // Короткие строки (снимок «contactsPrev» в IndexedDB)
  async function sealText(text) { return key ? encStr(key, text, "idb-text") : text; }
  async function openText(v) { if (typeof v !== "string" || v.indexOf(PREFIX) !== 0) return v; if (!key) return null; try { return await decStr(key, v, "idb-text"); } catch (e) { return null; } }
  return { sealText, openText, KEYS, MIN_PIN, isOn, isActive, enable, disable, unlock, rekey, verify, flush, sealBlob, openBlob, rawGet, rawSet };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SecureStore;
