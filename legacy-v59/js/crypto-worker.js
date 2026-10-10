// Web Worker для тяжёлой части шифрования бэкапа (раздел 13 роадмапа,
// "Сознательно отложено" → снято с паузы).
//
// Важная оговорка, зафиксированная сразу, чтобы не повторить ошибку
// исходного отчёта: сами операции crypto.subtle (включая PBKDF2 на
// 210000 итераций и AES-GCM) в подавляющем большинстве браузеров УЖЕ не
// блокируют основной поток — WebCrypto исполняется нативным кодом вне
// JS-потока, а наружу торчит только Promise. Поэтому "Web Worker для
// крипто" не ускоряет сам crypto.subtle.deriveKey/encrypt/decrypt.
// Настоящая узкая часть — это синхронная работа ВОКРУГ него на основном
// потоке: JSON.stringify/parse всего бэкапа (может быть мегабайты при
// большом числе чатов) и побайтовые циклы toBase64/fromBase64 в
// CryptoHelper. Перенос этого воркера переносит именно их, не давая
// видимости "ускорения крипто", которой на деле не было бы.
//
// Классический (не module) воркер — importScripts работает, а
// crypto.subtle/TextEncoder/TextDecoder/btoa/atob доступны в воркере
// без DOM, так что crypto-helper.js переиспользуется как есть, без
// дублирования логики шифрования в двух местах.
importScripts("crypto-helper.js");

const BACKUP_PBKDF2_ITERATIONS = 210000;
async function deriveBackupKey(password, saltBytes) {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: BACKUP_PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

self.onmessage = async (ev) => {
  const { reqId, action, password, salt, data, envelope } = ev.data || {};
  try {
    if (action === "encrypt") {
      const key = await deriveBackupKey(password, salt);
      const env = await CryptoHelper.encryptJson(key, data);
      self.postMessage({ reqId, ok: true, envelope: env });
    } else if (action === "decrypt") {
      const key = await deriveBackupKey(password, salt);
      const plain = await CryptoHelper.decryptJson(key, envelope);
      self.postMessage({ reqId, ok: true, data: plain });
    } else {
      self.postMessage({ reqId, ok: false, error: "unknown action: " + action });
    }
  } catch (e) {
    self.postMessage({ reqId, ok: false, error: String((e && e.message) || e) });
  }
};
