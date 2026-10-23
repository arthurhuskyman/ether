// Раскладка js/app/*.js: все куски перечислены в index.html и sw.js в одном порядке, каждый — валидный JS.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const { appScriptPaths } = require("./src-helper");

const onDisk = fs.readdirSync(path.join(ROOT, "js/app")).filter((f) => f.endsWith(".js")).sort().map((f) => "js/app/" + f);

test("манифест бандлов: bundle.app.js = discovery + все js/app/*.js в порядке номеров; index.html подключает бандл, а не куски", () => {
  // Раньше тест сверял отдельные <script src="js/app/..."> в index.html; теперь они склеены в js/bundle.app.js,
  // поэтому проверяем манифест tools/build-bundles.js (appScriptPaths()) и что в index.html стоит бандл.
  assert.ok(onDisk.length > 0);
  assert.deepStrictEqual(appScriptPaths(), onDisk);
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(html.includes('<script src="js/bundle.app.js"></script>'));
  assert.ok(!/<script src="js\/app\//.test(html));
});

test("sw.js предзагружает бандл приложения, а не отдельные куски", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  assert.ok(sw.includes('"./js/bundle.app.js"'));
  assert.deepStrictEqual([...sw.matchAll(/"\.\/(js\/app\/[^"]+\.js)"/g)], []);
  assert.ok(!sw.includes('"./js/app.js"'));
});

test("каждый кусок начинается с \"use strict\" и проходит node --check", () => {
  for (const p of onDisk) {
    const src = fs.readFileSync(path.join(ROOT, p), "utf8");
    assert.ok(src.startsWith('"use strict";'), p);
    cp.execFileSync(process.execPath, ["--check", path.join(ROOT, p)]);
  }
});

test("конкатенация кусков — валидный скрипт, старого js/app.js нет", () => {
  const { readAppSource } = require("./src-helper");
  new (require("vm").Script)(readAppSource());
  assert.ok(!fs.existsSync(path.join(ROOT, "js/app.js")));
});
