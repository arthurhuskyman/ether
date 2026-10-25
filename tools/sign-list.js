#!/usr/bin/env node
// Подпись списка серверов/зеркал ключом релизов (ECDSA P-256), формат проверяется js/serverlist.js.
//   node tools/sign-list.js servers.json --private <private.jwk.json>            (подписывает на месте, ts = сейчас)
//   node tools/sign-list.js mirrors.json --field mirrors --private <private.jwk.json>
//   node tools/sign-list.js servers.json --verify <public.jwk.json>              (только проверка)
// Приватный ключ хранится ВНЕ репозитория (см. tools/release-keygen.js, docs/RELEASING.md).
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const SL = require("../js/serverlist.js");
const args = process.argv.slice(2);
const file = args[0];
const opt = (n) => { const i = args.indexOf("--" + n); return i > 0 ? args[i + 1] : ""; };
if (!file || (!opt("private") && !opt("verify"))) { console.error("usage: sign-list.js <file.json> [--field servers|mirrors] --private <jwk> | --verify <pub jwk>"); process.exit(2); }
const field = opt("field") || "servers";
const obj = JSON.parse(fs.readFileSync(file, "utf8"));
(async () => {
  if (opt("verify")) {
    const pub = JSON.parse(fs.readFileSync(opt("verify"), "utf8"));
    const r = await SL.verifySigned(obj, pub, { field, subtle: crypto.webcrypto.subtle });
    console.log(r.ok ? "подпись верна" : "ПОДПИСЬ НЕ ВЕРНА: " + r.reason);
    process.exit(r.ok ? 0 : 1);
  }
  const priv = crypto.createPrivateKey({ key: JSON.parse(fs.readFileSync(opt("private"), "utf8")), format: "jwk" });
  const out = { v: 1, ts: Math.floor(Date.now() / 1000), [field]: obj[field] };
  const parsed = SL.parseSigned(Object.assign({}, out, { sig: "x" }), field);
  if (!parsed) { console.error("неверный формат списка"); process.exit(1); }
  out[field] = parsed[field];
  const sig = crypto.sign("sha256", Buffer.from(SL.canonical(out, field)), { key: priv, dsaEncoding: "ieee-p1363" });
  out.sig = sig.toString("base64url");
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  console.log("подписано: " + file + " ts=" + out.ts);
})();
