#!/usr/bin/env node
// Сборка зеркала приложения для другого origin/сервера: статическая папка + zip, которые можно выложить на ЛЮБОЙ статический хостинг.
//   node tools/make-mirror.js --server wss://relay.example.org [--server wss://relay2.example.org] [--label "Мой сервер"]
//        [--mirror https://mirror.example.net/ether/] [--out dist/mirror] [--no-zip] [--lock-connect] [--keep-default]
// Что делает:
//   * проверяет, что бандлы актуальны (node tools/build-bundles.js --check) и что всё из index.html и sw.js существует;
//   * копирует ровно то, что раздаётся пользователям (index.html, sw.js, manifest, js/, css/, fonts/, icons/, sounds/, servers.json);
//   * пишет config.js: свои серверы (первый = основной; встроенный Ether добавляется ПОСЛЕ них, если не --no-default) и известные зеркала;
//   * кладёт _headers (Cloudflare Pages/Netlify), .nojekyll (GitHub Pages), nginx.conf.example и mirrors.json (неподписанный);
//   * CSP/SW: пути в index.html/sw.js/manifest относительные, CSP опирается на 'self' и https:/wss: — от origin они НЕ зависят, поэтому
//     index.html, sw.js и бандлы копируются БЕЗ изменений (хэши inline-скриптов и подписанный release-manifest остаются верными).
//     Меняется только config.js (это конфигурация). --lock-connect дополнительно сужает connect-src до перечисленных серверов
//     (inline-скрипты не затронуты, хэши CSP верны, но index.html перестанет совпадать с подписанным манифестом и пользователь не сможет
//     добавлять сторонние серверы — включайте осознанно).
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const SL = require("../js/serverlist.js");

function parseArgs(argv) {
  const o = { servers: [], mirrors: [], out: path.join(ROOT, "dist", "mirror"), zip: true, lock: false, keepDefault: true, label: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--server") o.servers.push(v());
    else if (a === "--mirror") o.mirrors.push(v());
    else if (a === "--out") o.out = path.resolve(v());
    else if (a === "--label") o.label = v();
    else if (a === "--no-zip") o.zip = false;
    else if (a === "--lock-connect") o.lock = true;
    else if (a === "--no-default") o.keepDefault = false;
    else if (a === "--keep-default") o.keepDefault = true;
    else if (a === "--help" || a === "-h") { o.help = true; }
    else throw new Error("неизвестный аргумент: " + a);
  }
  return o;
}
function readConfigDefaults() {
  const w = {}; try { vm.runInNewContext(fs.readFileSync(path.join(ROOT, "config.js"), "utf8"), { window: w }); } catch (e) {}
  return (w.__ETHER_CONFIG__ && w.__ETHER_CONFIG__.servers) || [];
}
function buildConfig(o) {
  const servers = [];
  const add = (url, label) => { const u = SL.normalizeUrl(url); if (!u) throw new Error("неверный адрес сервера: " + url + " (нужен wss://имя.домен)"); if (!servers.some((s) => s.url === u)) servers.push({ url: u, label: SL.cleanLabel(label, u) }); };
  o.servers.forEach((s, i) => add(s, i === 0 && o.label ? o.label : ""));
  if (!servers.length) throw new Error("укажите хотя бы один --server wss://…");
  if (o.keepDefault) for (const d of readConfigDefaults()) { const u = SL.normalizeUrl(d.url); if (u && !servers.some((s) => s.url === u)) servers.push({ url: u, label: d.label || u }); }
  const mirrors = [];
  for (const m of o.mirrors) {
    let u; try { u = new URL(m); } catch (e) { throw new Error("неверный адрес зеркала: " + m); }
    if (u.protocol !== "https:") throw new Error("зеркало должно быть https: " + m);
    u.hash = ""; u.search = ""; mirrors.push({ url: u.toString(), label: u.host });
  }
  return { servers, mirrors };
}
function copyTree(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (skip && skip(s)) continue;
    if (e.isDirectory()) copyTree(s, d, skip); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
function checkBundles() {
  const { BUNDLES, build } = require("./build-bundles.js");
  for (const b of BUNDLES) {
    const p = path.join(ROOT, b.out);
    if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== build(b)) throw new Error("бандл устарел: " + b.out + " — запустите node tools/build-bundles.js");
  }
}
function checkReferences(out) {
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8"), missing = [];
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) if (!/^(https?:)?\/\//.test(m[1]) && !fs.existsSync(path.join(out, m[1]))) missing.push(m[1]);
  for (const m of html.matchAll(/<link[^>]*\shref="([^"#?]+)"/g)) if (!/^(https?:)?\/\//.test(m[1]) && !fs.existsSync(path.join(out, m[1]))) missing.push(m[1]);
  const sw = fs.readFileSync(path.join(out, "sw.js"), "utf8"), list = sw.match(/const SHELL_FILES = \[([\s\S]*?)\];/);
  if (list) for (const m of list[1].matchAll(/"\.\/([^"]*)"/g)) if (m[1] && !fs.existsSync(path.join(out, m[1]))) missing.push("sw:" + m[1]);
  if (missing.length) throw new Error("в зеркале нет файлов: " + missing.join(", "));
}
// ---- минимальный zip (deflate), без зависимостей ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function walk(dir, out, base) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out, base); else out.push(path.relative(base, p).split(path.sep).join("/")); } return out; }
function makeZip(dir, file) {
  const files = walk(dir, [], dir).sort(), parts = [], central = []; let offset = 0;
  for (const rel of files) {
    const data = fs.readFileSync(path.join(dir, rel)), comp = zlib.deflateRawSync(data), name = Buffer.from(rel), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0x58210000, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(0x58210000, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name); offset += lh.length + name.length + comp.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, ...central, end]));
  return files.length;
}
function make(o) {
  checkBundles();
  const cfg = buildConfig(o);
  fs.rmSync(o.out, { recursive: true, force: true });
  fs.mkdirSync(o.out, { recursive: true });
  for (const f of ["index.html", "sw.js", "manifest.webmanifest", "servers.json", "VERSION", "release-manifest.json", "release-manifest.sig.json"]) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(o.out, f));
  for (const d of ["js", "css", "fonts", "icons", "sounds", ".well-known"]) if (fs.existsSync(path.join(ROOT, d))) copyTree(path.join(ROOT, d), path.join(o.out, d), (p) => p === path.join(ROOT, "js", "app") || /\.(map|bak)$/.test(p));
  fs.writeFileSync(path.join(o.out, "config.js"), "// Конфигурация этого зеркала (создано tools/make-mirror.js). servers — по приоритету; mirrors — известные адреса приложения.\nwindow.__ETHER_CONFIG__ = " + JSON.stringify(cfg, null, 2) + ";\n");
  if (o.lock) {
    const p = path.join(o.out, "index.html"); let html = fs.readFileSync(p, "utf8");
    const origins = [...new Set(cfg.servers.flatMap((s) => [SL.httpBase(s.url), s.url.replace(/^(wss?:\/\/[^/]+).*$/, "$1")]))];
    const next = html.replace(/connect-src [^;"]*/, "connect-src 'self' " + origins.join(" ") + " blob: data:");
    if (next === html) throw new Error("не нашёл connect-src в CSP index.html");
    fs.writeFileSync(p, next);
  }
  fs.writeFileSync(path.join(o.out, ".nojekyll"), "");
  fs.writeFileSync(path.join(o.out, "_headers"), "# Cloudflare Pages / Netlify\n/sw.js\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/config.js\n  Cache-Control: no-cache\n/servers.json\n  Cache-Control: no-cache\n  Access-Control-Allow-Origin: *\n/mirrors.json\n  Cache-Control: no-cache\n  Access-Control-Allow-Origin: *\n/js/*\n  Cache-Control: public, max-age=3600\n");
  fs.writeFileSync(path.join(o.out, "nginx.conf.example"), "# server { listen 443 ssl; server_name mirror.example.net; root /var/www/ether-mirror; ssl_certificate …; ssl_certificate_key …;\n#   location = /sw.js { add_header Cache-Control no-cache; }\n#   location ~ ^/(index.html|config.js|servers.json|mirrors.json)$ { add_header Cache-Control no-cache; add_header Access-Control-Allow-Origin *; }\n#   types { application/manifest+json webmanifest; }  # если нет в mime.types\n# }\n");
  fs.writeFileSync(path.join(o.out, "mirrors.json"), JSON.stringify({ v: 1, ts: 0, mirrors: cfg.mirrors, sig: "" }, null, 1) + "\n");
  checkReferences(o.out);
  const res = { out: o.out, config: cfg, files: walk(o.out, [], o.out).length };
  if (o.zip) { res.zip = o.out.replace(/[\\/]+$/, "") + ".zip"; makeZip(o.out, res.zip); }
  return res;
}
if (require.main === module) {
  let o; try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.help) { console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
  try {
    const r = make(o);
    console.log("зеркало готово: " + r.out + " (" + r.files + " файлов)" + (r.zip ? ", архив " + r.zip : ""));
    console.log("серверы: " + r.config.servers.map((s) => s.url).join(", "));
    console.log("Выложите папку на любой статический хостинг по HTTPS (docs/MIRRORS.md). Подписать mirrors.json: node tools/sign-list.js mirrors.json --field mirrors --private <ключ>");
  } catch (e) { console.error("ОШИБКА: " + e.message); process.exit(1); }
}
module.exports = { make, parseArgs, buildConfig, makeZip, crc32 };
