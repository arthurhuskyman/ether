// tools/make-mirror.js: зеркало = те же файлы + свой config.js; index.html/sw.js/бандлы не меняются (CSP и подпись релиза остаются верными); zip корректен.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), vm = require("vm"), cp = require("child_process"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const MM = require("../tools/make-mirror.js");
const SL = require("../js/serverlist.js");
const cfgOf = (f) => { const w = {}; vm.runInNewContext(read(f).toString(), { window: w }); return JSON.parse(JSON.stringify(w.__ETHER_CONFIG__)); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ether-mirror-"));
const read = (p) => fs.readFileSync(p);
function readZip(file) { // минимальный разбор zip: имя -> содержимое
  const b = read(file), out = {}; let eocd = b.length - 22; while (b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const n = b.readUInt16LE(eocd + 10); let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), csize = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nl).toString(); const lnl = b.readUInt16LE(off + 26), lel = b.readUInt16LE(off + 28);
    const raw = b.slice(off + 30 + lnl + lel, off + 30 + lnl + lel + csize), data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(MM.crc32(data), crc, name); out[name] = data; p += 46 + nl + el + cl;
  }
  return out;
}

test("зеркало: файлы, config.js, неизменённые index.html/sw.js/бандлы, служебные файлы хостингов, zip", () => {
  const out = path.join(tmp(), "m");
  const r = MM.make({ servers: ["wss://Relay.Example.org/", "relay2.example.org"], mirrors: ["https://mirror.example.net/ether/"], out, zip: true, lock: false, keepDefault: true, label: "Мой сервер" });
  for (const f of ["index.html", "sw.js", "manifest.webmanifest", "config.js", "servers.json", "mirrors.json", "_headers", ".nojekyll", "nginx.conf.example", "js/bundle.core.js", "js/bundle.app.js", "js/serverlist.js", "js/lang/en.js", "css/styles.css", "icons/icon-192.png"]) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, "js/app")), "исходники бандла не нужны");
  for (const f of ["index.html", "sw.js", "manifest.webmanifest", "js/bundle.core.js", "js/bundle.app.js", "js/bundle.features.js", "js/bundle.fx.js"]) assert.ok(read(path.join(out, f)).equals(read(path.join(ROOT, f))), f + " не изменён");
  const cfg = cfgOf(path.join(out, "config.js"));
  assert.deepEqual(cfg.servers.map((s) => s.url), ["wss://relay.example.org", "wss://relay2.example.org", "wss://ether-1-baqy.onrender.com"]);
  assert.equal(cfg.servers[0].label, "Мой сервер");
  assert.deepEqual(SL.configDefaults(cfg).map((e) => e.url), cfg.servers.map((s) => s.url));
  assert.deepEqual(cfg.mirrors.map((m) => m.url), ["https://mirror.example.net/ether/"]);
  assert.deepEqual(JSON.parse(read(path.join(out, "mirrors.json"))).mirrors.length, 1);
  assert.ok(read(path.join(ROOT, "config.js")).toString().includes("ether-1-baqy"), "исходный config.js не тронут");
  const z = readZip(r.zip);
  assert.equal(Object.keys(z).length, r.files);
  assert.ok(z["config.js"].equals(read(path.join(out, "config.js"))) && z["index.html"].equals(read(path.join(ROOT, "index.html"))));
  // собранный SW ссылается только на существующие файлы (проверка внутри make), а CSP не зависит от origin
  const csp = read(path.join(out, "index.html")).toString().match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'self'/); assert.match(csp, /connect-src 'self' https: wss:/);
  assert.doesNotMatch(read(path.join(out, "index.html")).toString() + read(path.join(out, "manifest.webmanifest")).toString(), /github\.io|\/ether\//, "нет жёстких адресов origin");
});

test("--no-default и --lock-connect: сервер по умолчанию не добавляется; CSP сужается, inline-хэши целы", () => {
  const out = path.join(tmp(), "m");
  MM.make({ servers: ["wss://only.example.org:8443"], mirrors: [], out, zip: false, lock: true, keepDefault: false });
  const cfg = cfgOf(path.join(out, "config.js"));
  assert.deepEqual(cfg.servers.map((s) => s.url), ["wss://only.example.org:8443"]);
  const html = read(path.join(out, "index.html")).toString();
  assert.match(html, /connect-src 'self' https:\/\/only\.example\.org:8443 wss:\/\/only\.example\.org:8443 blob: data:/);
  const orig = read(path.join(ROOT, "index.html")).toString();
  assert.equal(html.replace(/connect-src [^;"]*/, ""), orig.replace(/connect-src [^;"]*/, ""), "изменён только connect-src");
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => "'sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64") + "'");
  for (const h of hashes) assert.ok(html.includes(h), "хэш inline-скрипта в CSP: " + h);
  assert.ok(!fs.existsSync(path.join(out, "..", "m.zip")));
});

test("ошибки: неверный/пустой сервер, неверное зеркало, неизвестный аргумент, CLI с кодом выхода", () => {
  const out = path.join(tmp(), "m");
  assert.throws(() => MM.make({ servers: ["ws://plain.example.org"], mirrors: [], out, zip: false }), /неверный адрес сервера/);
  assert.throws(() => MM.make({ servers: [], mirrors: [], out, zip: false }), /хотя бы один --server/);
  assert.throws(() => MM.make({ servers: ["wss://a.example.org"], mirrors: ["http://insecure.example.net"], out, zip: false }), /https/);
  assert.throws(() => MM.parseArgs(["--bogus"]), /неизвестный аргумент/);
  const bad = cp.spawnSync(process.execPath, [path.join(ROOT, "tools/make-mirror.js"), "--server", "nope", "--out", out], { encoding: "utf8" });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /ОШИБКА/);
  const ok = cp.spawnSync(process.execPath, [path.join(ROOT, "tools/make-mirror.js"), "--server", "wss://cli.example.org", "--out", out, "--no-zip"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /зеркало готово/);
});

test("документы: MIRRORS.md и RELAY-OPERATOR.md есть и описывают все способы размещения, подпись и env-переменные", () => {
  const m = read(path.join(ROOT, "docs/MIRRORS.md")).toString(), r = read(path.join(ROOT, "docs/RELAY-OPERATOR.md")).toString();
  for (const w of ["GitHub Pages", "Cloudflare Pages", "Netlify", "IPFS", "nginx", "mirrors.json", "make-mirror", "sign-list"]) assert.ok(m.includes(w), "MIRRORS: " + w);
  for (const w of ["docker-compose", "Render", "VPS", "ALLOWED_ORIGIN", "DATA_DIR", "PUSH_SUBS_FILE", "/info", "servers.json"]) assert.ok(r.includes(w), "RELAY: " + w);
});
