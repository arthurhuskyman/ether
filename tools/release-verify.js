#!/usr/bin/env node
// Проверка релиза: подпись манифеста + хэш каждого файла. Код 1 при любом расхождении.
// node tools/release-verify.js [--manifest f] [--sig f] [--pub js/release-key.js|.json] [--root dir] [--allow-unsigned]
// Если публичный ключ = null (заглушка): без --allow-unsigned это ошибка 2 (проверять подпись нечем).
"use strict";
const fs = require("fs"), path = require("path");
const L = require("./release-lib");
const root = path.resolve(L.arg("root") || L.ROOT);
const mf = path.resolve(L.arg("manifest") || path.join(root, L.MANIFEST_NAME));
const sf = path.resolve(L.arg("sig") || path.join(path.dirname(mf), L.SIG_NAME));
let pub;
try { pub = L.readPubKey(path.resolve(L.arg("pub") || path.join(root, "js/release-key.js"))); } catch (e) { console.error(e.message); process.exit(2); }
if (!pub && !process.argv.includes("--allow-unsigned")) { console.error("Публичный ключ не настроен (js/release-key.js = null): подпись проверить нечем. См. docs/RELEASING.md."); process.exit(2); }
let sigObj = null;
if (fs.existsSync(sf)) try { sigObj = JSON.parse(fs.readFileSync(sf, "utf8")); } catch (e) { sigObj = null; }
const problems = L.verifyAll({ manifestBytes: fs.readFileSync(mf), sigObj, pub, root });
if (problems.length) { console.error("ПРОВЕРКА НЕ ПРОЙДЕНА:\n - " + problems.slice(0, 30).join("\n - ")); process.exit(1); }
console.log("OK: " + (pub ? "подпись верна, " : "(без подписи) ") + "хэши всех файлов совпали");
