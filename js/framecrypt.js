// V.86: сквозное шифрование кадров для групповых звонков через сервер-ретранслятор (SFU) — по образцу SFrame (RFC 9605), упрощённо.
// У каждого участника свой ключ отправителя (32 байта, AES-GCM-256) с номером эпохи; ключ рассылается участникам по уже
// зашифрованному каналу. Кадр: [открытые байты заголовка кодека][эпоха 1 байт][счётчик 4 байта][шифртекст+тег 16 байт].
// IV = 8 нулевых байт + счётчик (уникален в пределах ключа отправителя: каждый шифрует только своим ключом).
// Открытые байты (VP8: 10 у ключевого и 3 у обычного кадра, Opus: 1) нужны SFU и декодеру, сам медиаконтент зашифрован.
// Скрипт общий для окна и для воркера (js/frame-worker.js подключает его через importScripts).
(function (root) {
  "use strict";
  const HDR = 5, TAG = 16;
  const subtle = () => (root.crypto && root.crypto.subtle) || null;
  function clearBytesFor(kind, keyFrame) { return kind === "audio" ? 1 : keyFrame ? 10 : 3; }
  async function importKey(raw) { return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }
  function newRawKey() { const k = new Uint8Array(32); root.crypto.getRandomValues(k); return k; }
  function iv(ctr) { const v = new Uint8Array(12); new DataView(v.buffer).setUint32(8, ctr >>> 0); return v; }
  // Шифрует кадр. clear — сколько первых байт оставить открытыми; aad = открытые байты + заголовок (их подмена ломает тег).
  async function encrypt(key, epoch, ctr, data, clear) {
    const src = new Uint8Array(data); const c = Math.min(clear | 0, src.length);
    const head = new Uint8Array(c + HDR); head.set(src.subarray(0, c)); head[c] = epoch & 255; new DataView(head.buffer).setUint32(c + 1, ctr >>> 0);
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv(ctr), additionalData: head, tagLength: 128 }, key, src.subarray(c)));
    const out = new Uint8Array(head.length + ct.length); out.set(head); out.set(ct, head.length); return out.buffer;
  }
  // keyFor(epoch) -> CryptoKey | null. Возвращает null, если кадр не наш, ключа нет или тег не сошёлся.
  async function decrypt(keyFor, data, clear) {
    const src = new Uint8Array(data); const c = Math.min(clear | 0, src.length);
    if (src.length < c + HDR + TAG) return null;
    const epoch = src[c]; const ctr = new DataView(src.buffer, src.byteOffset).getUint32(c + 1);
    const key = keyFor(epoch); if (!key) return null;
    try {
      const pt = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: iv(ctr), additionalData: src.subarray(0, c + HDR), tagLength: 128 }, key, src.subarray(c + HDR)));
      const out = new Uint8Array(c + pt.length); out.set(src.subarray(0, c)); out.set(pt, c); return out.buffer;
    } catch (e) { return null; }
  }
  root.FrameCrypt = { HDR, TAG, clearBytesFor, importKey, newRawKey, encrypt, decrypt };
})(typeof self !== "undefined" ? self : this);
