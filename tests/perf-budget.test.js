// Бюджет первой загрузки: ядро в предзагрузке SW, скины и шрифты скинов — только по требованию.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const shell = [...sw.slice(sw.indexOf("SHELL_FILES"), sw.indexOf("];")).matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]).filter((f) => f && f !== "./");

test("предзагрузка SW: все файлы существуют, нет css/skins и шрифтов скинов, размер в бюджете", () => {
  let total = 0;
  for (const f of shell) { const p = path.join(ROOT, f); assert.ok(fs.existsSync(p), "нет файла " + f); total += fs.statSync(p).size; }
  assert.ok(!shell.some((f) => /^css\/skins\/|^fonts\/skins\//.test(f)));
  assert.ok(total < 3.6 * 1024 * 1024, "предзагрузка " + Math.round(total / 1024) + " КБ");
});

test("все статические скрипты index.html, кроме тяжёлых библиотек, есть в предзагрузке; transformers.js — только по требованию", () => {
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length > 20);
  for (const s of srcs) assert.ok(shell.includes(s) || /^js\/lang\//.test(s), "не в предзагрузке: " + s);
  assert.ok(!shell.includes("js/vendor/transformers.min.js"));
  assert.ok(!srcs.includes("js/vendor/transformers.min.js"));
});

test("шрифт Inter предзагружается в head, CSS скинов не блокирует первую отрисовку", () => {
  assert.match(html, /<link rel="preload" href="fonts\/InterVariable\.woff2" as="font"/);
  assert.equal((html.match(/<link rel="stylesheet"/g) || []).length, 3, "tokens, styles, skins; остальное лениво");
});
