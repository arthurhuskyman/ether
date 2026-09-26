// Safety number (отпечаток пары публичных ключей для сверки собеседниками
// "в реальном мире") — проверяем три критичных свойства: одинаковый
// результат независимо от того, кто его вычисляет, чувствительность к
// подмене любого из двух ключей, и устойчивость к порядку полей JWK.

global.window = global;
global.crypto = require("crypto").webcrypto;
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "js", "crypto-helper.js"), "utf8");
// eslint-disable-next-line no-eval
eval(src + "\nglobalThis.__CryptoHelper = CryptoHelper;");
const CryptoHelper = globalThis.__CryptoHelper;

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

(async () => {
  const alice = await CryptoHelper.generateKeyPair();
  const bob = await CryptoHelper.generateKeyPair();
  const eve = await CryptoHelper.generateKeyPair();

  console.log("\n=== Обе стороны вычисляют одинаковый отпечаток для одного разговора ===");
  const fromAlice = await CryptoHelper.computeSafetyNumber(alice.publicKeyJwk, bob.publicKeyJwk);
  const fromBob = await CryptoHelper.computeSafetyNumber(bob.publicKeyJwk, alice.publicKeyJwk);
  check("Алиса и Боб видят одинаковый отпечаток независимо от того, кто 'я'", JSON.stringify(fromAlice) === JSON.stringify(fromBob));
  check("60 цифр (12 групп по 5)", fromAlice.length === 12 && fromAlice.every((g) => g.length === 5));

  console.log("\n=== Подмена любого из двух ключей меняет отпечаток (детектирует MITM) ===");
  const withEveInsteadOfBob = await CryptoHelper.computeSafetyNumber(alice.publicKeyJwk, eve.publicKeyJwk);
  check("другой публичный ключ собеседника -> другой отпечаток", JSON.stringify(fromAlice) !== JSON.stringify(withEveInsteadOfBob));
  const withEveInsteadOfAlice = await CryptoHelper.computeSafetyNumber(eve.publicKeyJwk, bob.publicKeyJwk);
  check("другой свой ключ -> тоже другой отпечаток", JSON.stringify(fromAlice) !== JSON.stringify(withEveInsteadOfAlice));

  console.log("\n=== Стабильность при изменённом порядке полей JWK ===");
  const reordered = JSON.parse(JSON.stringify(bob.publicKeyJwk));
  const shuffled = {};
  for (const k of Object.keys(reordered).reverse()) shuffled[k] = reordered[k];
  const withShuffled = await CryptoHelper.computeSafetyNumber(alice.publicKeyJwk, shuffled);
  check("порядок полей JWK не влияет на результат", JSON.stringify(fromAlice) === JSON.stringify(withShuffled));

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});
