// Проверяет модуль шифрования (js/crypto-helper.js) напрямую в Node, тем
// же Web Crypto API, что и в браузере (globalThis.crypto.subtle).

const fs = require("fs");
const path = require("path");

if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
  globalThis.crypto = require("crypto").webcrypto;
}

const src = fs.readFileSync(path.join(__dirname, "..", "js", "crypto-helper.js"), "utf8");
// eslint-disable-next-line no-eval
eval(src + "\nglobalThis.__CryptoHelper = CryptoHelper;");
const CH = globalThis.__CryptoHelper;

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

(async () => {
  console.log("\n=== Генерация ключевых пар для двух устройств ===");
  const alice = await CH.generateKeyPair();
  const bob = await CH.generateKeyPair();
  check("у Алисы есть публичный и приватный ключ", !!alice.publicKeyJwk && !!alice.privateKeyJwk);
  check("у Боба есть публичный и приватный ключ", !!bob.publicKeyJwk && !!bob.privateKeyJwk);
  check("публичные ключи разные", JSON.stringify(alice.publicKeyJwk) !== JSON.stringify(bob.publicKeyJwk));

  console.log("\n=== Оба независимо вычисляют один и тот же общий секрет (ECDH) ===");
  const aliceShared = await CH.deriveSharedKey(alice.privateKeyJwk, bob.publicKeyJwk);
  const bobShared = await CH.deriveSharedKey(bob.privateKeyJwk, alice.publicKeyJwk);
  check("оба вывели ключ без ошибок", !!aliceShared && !!bobShared);

  console.log("\n=== Шифрование на стороне Алисы, расшифровка на стороне Боба ===");
  const original = { kind: "chat", id: "msg-1", text: "Привет, Боб! Это секретное сообщение.", ts: Date.now() };
  const envelope = await CH.encryptJson(aliceShared, original);
  check("шифротекст не содержит открытый текст", !JSON.stringify(envelope).includes("секретное"));
  const decrypted = await CH.decryptJson(bobShared, envelope);
  check("Боб расшифровал ровно то же сообщение", JSON.stringify(decrypted) === JSON.stringify(original));

  console.log("\n=== Третья сторона (не Боб) не может расшифровать ===");
  const eve = await CH.generateKeyPair();
  const eveShared = await CH.deriveSharedKey(eve.privateKeyJwk, alice.publicKeyJwk);
  let eveDecryptFailed = false;
  try {
    await CH.decryptJson(eveShared, envelope);
  } catch (e) {
    eveDecryptFailed = true;
  }
  check("чужой ключ не может расшифровать конверт", eveDecryptFailed);

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});