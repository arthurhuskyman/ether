// CSP, ленивые скины и проверка целостности библиотеки локального ИИ.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { createApp, closeAll, ROOT } = require("./harness");
test.after(closeAll);
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

test("CSP: мета есть, хэши inline-скриптов актуальны (иначе node tools/csp-hash.js)", () => {
  const { build } = require(path.join(ROOT, "tools", "csp-hash.js"));
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
  assert.ok(m, "CSP meta");
  assert.equal(m[1], build(html), "CSP устарела: запустите node tools/csp-hash.js");
  const csp = m[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, "inline-скрипты только по хэшу");
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'/);
  assert.doesNotMatch(csp, /script-src[^;]*https:/, "CDN-скрипты не разрешены: только blob: после проверки хэша");
  assert.doesNotMatch(html, /\son(?:click|load|error|change|submit)\s*=/i, "inline-обработчики нарушили бы CSP");
});

test("скины: CSS не подключён статически и не в предзагрузке SW, а лениво через head-скрипт", () => {
  assert.doesNotMatch(html, /<link[^>]+css\/skins\/[a-z]+\.css/);
  assert.doesNotMatch(sw, /"\.\/css\/skins\//);
  assert.match(html, /data-skin-css/);
  assert.match(html, /"css\/skins\/" \+ id \+ "\.css"/);
  for (const f of fs.readdirSync(path.join(ROOT, "css", "skins"))) assert.ok(fs.existsSync(path.join(ROOT, "css", "skins", f)));
});

test("локальный ИИ: библиотека на своём origin, файл совпадает с закреплённым SHA-384", () => {
  const crypto = require("crypto");
  const ai = fs.readFileSync(path.join(ROOT, "js", "localai.js"), "utf8");
  const pinned = ai.match(/TF_SHA384 = "([^"]+)"/)[1];
  const file = fs.readFileSync(path.join(ROOT, "js", "vendor", "transformers.min.js"));
  assert.ok(file.length < 2 * 1024 * 1024);
  assert.equal(crypto.createHash("sha384").update(file).digest("base64"), pinned, "vendor-файл изменён: обновите хэш осознанно");
  assert.doesNotMatch(ai, /import\(\s*["']https?:/, "скрипты с чужих хостов не грузим");
});
