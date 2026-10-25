#!/usr/bin/env node
// Генерация пары ECDSA P-256 для подписи релизов. Запускать ОФЛАЙН на доверенной машине.
//   node tools/release-keygen.js --private ~/secrets/ether-release.pem [--pub-file js/release-key.js]
// Приватный ключ (PKCS8 PEM, права 0600) пишется ТОЛЬКО в указанный путь, который должен быть вне репозитория; публичный — в js/release-key.js.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const L = require("./release-lib");
function main() {
  const priv = L.arg("private"), pubFile = L.arg("pub-file") || path.join(L.ROOT, "js/release-key.js");
  if (!priv) { console.error("Укажите --private <путь к файлу приватного ключа (вне репозитория)>"); process.exit(2); }
  const abs = path.resolve(priv);
  if (abs === L.ROOT || abs.startsWith(L.ROOT + path.sep)) { console.error("Отказ: приватный ключ нельзя хранить внутри репозитория."); process.exit(2); }
  if (fs.existsSync(abs) && !process.argv.includes("--force")) { console.error("Файл уже есть (--force чтобы перезаписать): " + abs); process.exit(2); }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  fs.writeFileSync(abs, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const j = publicKey.export({ format: "jwk" });
  const jwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
  fs.writeFileSync(pubFile, "// ПУБЛИЧНЫЙ ключ подписи релизов (ECDSA P-256). Сгенерирован tools/release-keygen.js; приватный ключ хранится у владельца офлайн.\n// keyId " + L.keyId(jwk) + "\nwindow.RELEASE_PUBKEY = " + JSON.stringify(jwk) + ";\n");
  console.log("Приватный ключ: " + abs + " (СДЕЛАЙТЕ РЕЗЕРВНУЮ КОПИЮ офлайн, никому не передавайте)\nПубличный ключ записан в " + pubFile + ", keyId " + L.keyId(jwk));
}
main();
