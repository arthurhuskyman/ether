#!/usr/bin/env node
// Манифест релиза: SHA-256 каждого раздаваемого файла. node tools/release-manifest.js [--out файл] [--ts ISO] [--root dir] [--check]
// --check: ничего не пишет; код 1, если release-manifest.json устарел относительно файлов (сравниваются только files).
"use strict";
const fs = require("fs"), path = require("path");
const L = require("./release-lib");
const root = path.resolve(L.arg("root") || L.ROOT), out = path.resolve(L.arg("out") || path.join(root, L.MANIFEST_NAME));
if (process.argv.includes("--check")) {
  if (!fs.existsSync(out)) { console.log("release-manifest.json не закоммичен — проверять нечего"); process.exit(0); }
  let old; try { old = JSON.parse(fs.readFileSync(out, "utf8")); } catch (e) { console.error("release-manifest.json повреждён"); process.exit(1); }
  const now = L.hashFiles(root), bad = [];
  for (const p of Object.keys(now)) if (old.files[p] !== now[p]) bad.push(p);
  for (const p of Object.keys(old.files || {})) if (!(p in now)) bad.push(p + " (удалён)");
  if (bad.length) { console.error("release-manifest.json УСТАРЕЛ (" + bad.length + "): " + bad.slice(0, 10).join(", ") + (bad.length > 10 ? " …" : "") + "\nЗапустите node tools/release-manifest.js и заново подпишите (tools/release-sign.js)."); process.exit(1); }
  console.log("release-manifest.json актуален"); process.exit(0);
}
const m = L.buildManifest(root, L.arg("ts"));
fs.writeFileSync(out, L.serialize(m));
console.log(out + ": " + Object.keys(m.files).length + " файлов, версия " + m.version);
