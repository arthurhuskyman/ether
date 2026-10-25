// Общие функции подписанных релизов (tools/release-*.js). Без зависимостей, только node:crypto.
// Модель: release-manifest.json = {v,version,ts,files:{путь:sha256-hex}}; release-manifest.sig.json = подпись ECDSA P-256/SHA-256
// ИМЕННО по байтам файла манифеста (не по перепакованному JSON — нет проблем с канонизацией). Подпись — IEEE P1363 (r||s), как у WebCrypto.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const MANIFEST_NAME = "release-manifest.json", SIG_NAME = "release-manifest.sig.json";
// Что реально раздаётся пользователю (GitHub Pages отдаёт корень как есть). Тесты, docs, сервер, tools, deploy, архивы — нет.
const ROOT_FILES = ["index.html", "sw.js", "manifest.webmanifest", "config.js", "servers.json"]; // config.js/servers.json — конфигурация, если есть
const DIRS = ["js", "css", "fonts", "icons", "sounds", ".well-known"];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
}
function listShipped(root) {
  root = root || ROOT;
  const abs = [];
  for (const f of ROOT_FILES) if (fs.existsSync(path.join(root, f))) abs.push(path.join(root, f));
  for (const d of DIRS) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d), abs);
  return abs.map((p) => path.relative(root, p).split(path.sep).join("/")).filter((p) => p !== MANIFEST_NAME && p !== SIG_NAME).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function readVersion(root) {
  try { return fs.readFileSync(path.join(root || ROOT, "VERSION"), "utf8").split(/\r?\n/)[0].trim(); } catch (e) { return ""; }
}
function hashFiles(root) {
  root = root || ROOT;
  const files = {};
  for (const rel of listShipped(root)) files[rel] = sha256hex(fs.readFileSync(path.join(root, rel)));
  return files;
}
function buildManifest(root, ts) {
  return { v: 1, version: readVersion(root), ts: ts || new Date().toISOString(), files: hashFiles(root) };
}
const serialize = (m) => JSON.stringify(m, null, 2) + "\n";
function b64u(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function fromB64u(s) { return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64"); }
function keyId(jwk) { return sha256hex(Buffer.from(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))).slice(0, 16); }
// Читает window.RELEASE_PUBKEY из js/release-key.js (или из .json с самим JWK). null = заглушка, ключ не настроен.
function readPubKey(file) {
  const src = fs.readFileSync(file, "utf8");
  let k;
  if (/\.json$/i.test(file)) k = JSON.parse(src);
  else { const w = {}; vm.runInNewContext(src, { window: w }); k = w.RELEASE_PUBKEY; }
  if (k == null) return null;
  if (!k || k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string") throw new Error("RELEASE_PUBKEY: ожидается {kty:'EC',crv:'P-256',x,y}");
  return { kty: k.kty, crv: k.crv, x: k.x, y: k.y };
}
function signBytes(privatePem, bytes) {
  return crypto.sign("sha256", bytes, { key: crypto.createPrivateKey(privatePem), dsaEncoding: "ieee-p1363" });
}
function verifyBytes(jwk, bytes, sig) {
  try { return crypto.verify("sha256", bytes, { key: crypto.createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, sig); } catch (e) { return false; }
}
// Полная проверка: [] = всё хорошо, иначе список проблем. sigObj/pub необязательны (pub=null -> только хэши, подпись не проверяется).
function verifyAll({ manifestBytes, sigObj, pub, root }) {
  const problems = [];
  let m;
  try { m = JSON.parse(manifestBytes.toString("utf8")); } catch (e) { return ["манифест не JSON"]; }
  if (!m || m.v !== 1 || typeof m.files !== "object" || !m.files) return ["неверный формат манифеста"];
  if (pub) {
    if (!sigObj || typeof sigObj.sig !== "string") problems.push("подпись отсутствует");
    else if (!verifyBytes(pub, manifestBytes, fromB64u(sigObj.sig))) problems.push("подпись манифеста НЕ верна");
    else if (sigObj.manifestSha256 && sigObj.manifestSha256 !== sha256hex(manifestBytes)) problems.push("manifestSha256 в подписи не совпадает");
  }
  root = root || ROOT;
  const actual = hashFiles(root);
  for (const p of Object.keys(m.files)) {
    if (!(p in actual)) problems.push("нет файла: " + p);
    else if (actual[p] !== m.files[p]) problems.push("хэш не совпал: " + p);
  }
  for (const p of Object.keys(actual)) if (!(p in m.files)) problems.push("файл не в манифесте: " + p);
  return problems;
}
function arg(name, argv) {
  argv = argv || process.argv;
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
}
module.exports = { ROOT, MANIFEST_NAME, SIG_NAME, listShipped, hashFiles, buildManifest, serialize, sha256hex, b64u, fromB64u, keyId, readPubKey, signBytes, verifyBytes, verifyAll, readVersion, arg };
