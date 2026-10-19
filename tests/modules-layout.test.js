// Раскладка js/app/*.js: все куски перечислены в index.html и sw.js в одном порядке, каждый — валидный JS.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const { appScriptPaths } = require("./src-helper");

const onDisk = fs.readdirSync(path.join(ROOT, "js/app")).filter((f) => f.endsWith(".js")).sort().map((f) => "js/app/" + f);

test("index.html подключает все js/app/*.js в порядке номеров", () => {
  assert.ok(onDisk.length > 0);
  assert.deepStrictEqual(appScriptPaths(), onDisk);
});

test("sw.js SHELL_FILES содержит те же куски в том же порядке", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const inSw = [...sw.matchAll(/"\.\/(js\/app\/[^"]+\.js)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(inSw, onDisk);
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
