#!/usr/bin/env node
// Подпись манифеста приватным ключом. node tools/release-sign.js --key <pem> | (env ETHER_RELEASE_KEY = путь к pem или сам PEM) [--manifest файл] [--out файл]
"use strict";
const fs = require("fs"), path = require("path");
const L = require("./release-lib");
function loadKey() {
  const f = L.arg("key"), env = process.env.ETHER_RELEASE_KEY;
  if (f) return fs.readFileSync(f, "utf8");
  if (env) return /-----BEGIN/.test(env) ? env : fs.readFileSync(env, "utf8");
  console.error("Нужен --key <pem> или переменная ETHER_RELEASE_KEY"); process.exit(2);
}
const mf = path.resolve(L.arg("manifest") || path.join(L.ROOT, L.MANIFEST_NAME));
const out = path.resolve(L.arg("out") || path.join(path.dirname(mf), L.SIG_NAME));
const bytes = fs.readFileSync(mf), pem = loadKey();
const crypto = require("crypto");
const pubJwk = crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ format: "jwk" });
const sig = L.signBytes(pem, bytes);
fs.writeFileSync(out, JSON.stringify({ v: 1, alg: "ECDSA-P256-SHA256", keyId: L.keyId(pubJwk), manifestSha256: L.sha256hex(bytes), sig: L.b64u(sig) }, null, 2) + "\n");
console.log("Подписано: " + out + " keyId " + L.keyId(pubJwk));
