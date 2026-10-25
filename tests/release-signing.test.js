// Подписанные релизы: tools/release-*.js (пара ключей генерируется на лету; приватных ключей в репозитории нет).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const L = require("../tools/release-lib.js");
const tool = (n) => path.join(ROOT, "tools", n);
function run(n, args, env) { const r = cp.spawnSync(process.execPath, [tool(n), ...args], { encoding: "utf8", env: Object.assign({}, process.env, env || {}) }); return { code: r.status, out: r.stdout + r.stderr }; }
function mkTree() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
  const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); };
  w("index.html", "<html></html>"); w("sw.js", "//sw"); w("manifest.webmanifest", "{}"); w("VERSION", "V.1.2.3\n# rule");
  w("js/b.js", "b"); w("js/a.js", "a"); w("js/release-key.js", "window.RELEASE_PUBKEY = null;\n"); w("css/s.css", "x{}"); w("icons/i.png", "png"); w("sounds/s.mp3", "mp3"); w("fonts/f.woff2", "f");
  w("tests/t.test.js", "t"); w("docs/D.md", "d"); w("signaling-server/s.js", "s"); w("tools/x.js", "x");
  return d;
}
function setup() {
  const d = mkTree(), keys = fs.mkdtempSync(path.join(os.tmpdir(), "relkey-")), priv = path.join(keys, "priv.pem");
  const kg = run("release-keygen.js", ["--private", priv, "--pub-file", path.join(d, "js/release-key.js")]);
  assert.equal(kg.code, 0, kg.out);
  assert.equal(run("release-manifest.js", ["--root", d]).code, 0);
  assert.equal(run("release-sign.js", ["--manifest", path.join(d, "release-manifest.json"), "--key", priv]).code, 0);
  return { d, priv, keys };
}

test("манифест: детерминированный порядок, только раздаваемые файлы, версия из VERSION", () => {
  const d = mkTree();
  const m1 = L.buildManifest(d, "T"), m2 = L.buildManifest(d, "T");
  assert.equal(L.serialize(m1), L.serialize(m2));
  const names = Object.keys(m1.files);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(names, ["css/s.css", "fonts/f.woff2", "icons/i.png", "index.html", "js/a.js", "js/b.js", "js/release-key.js", "manifest.webmanifest", "sounds/s.mp3", "sw.js"]);
  assert.equal(m1.version, "V.1.2.3"); assert.equal(m1.v, 1);
  assert.equal(m1.files["js/a.js"], crypto.createHash("sha256").update("a").digest("hex"));
});

test("keygen -> manifest -> sign -> verify проходит; ключ записан в release-key.js, приватный не в репозитории", () => {
  const { d, priv } = setup();
  const pub = L.readPubKey(path.join(d, "js/release-key.js"));
  assert.equal(pub.kty, "EC"); assert.equal(pub.crv, "P-256"); assert.ok(!("d" in pub));
  assert.ok(!fs.readFileSync(path.join(d, "js/release-key.js"), "utf8").includes('"d"'));
  assert.equal((fs.statSync(priv).mode & 0o077), 0, "права 0600");
  // манифест создавался до записи ключа? нет: keygen шёл первым, значит хэш release-key.js уже верен
  const v = run("release-verify.js", ["--root", d]);
  assert.equal(v.code, 0, v.out);
});

test("verify: изменённый файл, добавленный файл, удалённый файл -> код 1", () => {
  const { d } = setup();
  fs.writeFileSync(path.join(d, "js/a.js"), "evil");
  let v = run("release-verify.js", ["--root", d]); assert.equal(v.code, 1); assert.match(v.out, /js\/a\.js/);
  fs.writeFileSync(path.join(d, "js/a.js"), "a"); assert.equal(run("release-verify.js", ["--root", d]).code, 0);
  fs.writeFileSync(path.join(d, "js/new.js"), "n"); v = run("release-verify.js", ["--root", d]); assert.equal(v.code, 1); assert.match(v.out, /не в манифесте/);
  fs.unlinkSync(path.join(d, "js/new.js")); fs.unlinkSync(path.join(d, "css/s.css")); v = run("release-verify.js", ["--root", d]); assert.equal(v.code, 1); assert.match(v.out, /нет файла/);
});

test("verify: подделанный манифест, чужой ключ, пустая/битая подпись -> код 1", () => {
  const { d, keys } = setup();
  const mf = path.join(d, "release-manifest.json"), orig = fs.readFileSync(mf, "utf8");
  const m = JSON.parse(orig); m.files["js/a.js"] = "0".repeat(64); fs.writeFileSync(mf, JSON.stringify(m, null, 2) + "\n");
  let v = run("release-verify.js", ["--root", d]); assert.equal(v.code, 1); assert.match(v.out, /подпись/);
  fs.writeFileSync(mf, orig);
  // другой ключ
  const other = path.join(keys, "o.pem"), pubOther = path.join(keys, "other-key.js");
  assert.equal(run("release-keygen.js", ["--private", other, "--pub-file", pubOther]).code, 0);
  v = run("release-verify.js", ["--root", d, "--pub", pubOther]); assert.equal(v.code, 1);
  fs.writeFileSync(path.join(d, "release-manifest.sig.json"), "{}"); assert.equal(run("release-verify.js", ["--root", d]).code, 1);
  fs.unlinkSync(path.join(d, "release-manifest.sig.json")); assert.equal(run("release-verify.js", ["--root", d]).code, 1);
});

test("verify: ключ-заглушка (null) -> код 2, с --allow-unsigned проверяются только хэши", () => {
  const d = mkTree();
  assert.equal(run("release-manifest.js", ["--root", d]).code, 0);
  assert.equal(run("release-verify.js", ["--root", d]).code, 2);
  assert.equal(run("release-verify.js", ["--root", d, "--allow-unsigned"]).code, 0);
  fs.writeFileSync(path.join(d, "sw.js"), "//x"); assert.equal(run("release-verify.js", ["--root", d, "--allow-unsigned"]).code, 1);
});

test("manifest --check: устаревший закоммиченный манифест -> 1; без манифеста -> 0", () => {
  const d = mkTree();
  assert.equal(run("release-manifest.js", ["--root", d, "--check"]).code, 0);
  run("release-manifest.js", ["--root", d]);
  assert.equal(run("release-manifest.js", ["--root", d, "--check"]).code, 0);
  fs.writeFileSync(path.join(d, "index.html"), "<html>changed</html>");
  const r = run("release-manifest.js", ["--root", d, "--check"]); assert.equal(r.code, 1); assert.match(r.out, /УСТАРЕЛ/);
});

test("keygen отказывает писать приватный ключ внутрь репозитория и перезаписывать существующий", () => {
  const r = run("release-keygen.js", ["--private", path.join(ROOT, "evil.pem"), "--pub-file", path.join(os.tmpdir(), "x-key.js")]);
  assert.equal(r.code, 2); assert.ok(!fs.existsSync(path.join(ROOT, "evil.pem")));
  const { keys, d } = setup();
  assert.equal(run("release-keygen.js", ["--private", path.join(keys, "priv.pem"), "--pub-file", path.join(d, "js/release-key.js")]).code, 2);
});

test("sign: ключ из переменной окружения (путь и PEM); без ключа код 2", () => {
  const { d, priv } = setup();
  const sig = path.join(d, "release-manifest.sig.json"); fs.unlinkSync(sig);
  assert.equal(run("release-sign.js", ["--manifest", path.join(d, "release-manifest.json")], { ETHER_RELEASE_KEY: priv }).code, 0);
  assert.equal(run("release-verify.js", ["--root", d]).code, 0);
  fs.unlinkSync(sig);
  assert.equal(run("release-sign.js", ["--manifest", path.join(d, "release-manifest.json")], { ETHER_RELEASE_KEY: fs.readFileSync(priv, "utf8") }).code, 0);
  assert.equal(run("release-verify.js", ["--root", d]).code, 0);
  assert.equal(run("release-sign.js", ["--manifest", path.join(d, "release-manifest.json")], { ETHER_RELEASE_KEY: "" }).code, 2);
});

test("репозиторий: release-key.js — заглушка null, приватных ключей в дереве нет, .well-known помечен TODO", () => {
  assert.equal(L.readPubKey(path.join(ROOT, "js/release-key.js")), null);
  for (const f of L.listShipped(ROOT)) { if (/\.(png|mp3|woff2)$/.test(f)) continue; assert.ok(!/BEGIN (EC |RSA )?PRIVATE KEY/.test(fs.readFileSync(path.join(ROOT, f), "utf8")), f); }
  assert.match(fs.readFileSync(path.join(ROOT, ".well-known/security.txt"), "utf8"), /TODO/);
  assert.ok(!L.listShipped(ROOT).some((f) => /^(tests|docs|signaling-server|tools)\//.test(f)));
});
