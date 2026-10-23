// Dynamic Type: размеры шрифта в rem, настройка «Размер текста» (ether.textScale), применение до первой отрисовки.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const cssFiles = ["css/styles.css", "css/tokens.css", "css/skins.css"].concat(fs.readdirSync(path.join(ROOT, "css", "skins")).filter((f) => f.endsWith(".css")).map((f) => "css/skins/" + f));

test("в css нет font-size в px (кроме декора >= 40px и max(16px,1em) для полей iOS)", () => {
  const bad = [];
  for (const f of cssFiles) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/font-size:\s*([^;}]*)/g)) {
      const v = m[1].trim();
      if (/^max\(16px,\s*1em\)$/.test(v)) continue;
      if (/^(\d+(?:\.\d+)?)px$/.test(v) && parseFloat(v) >= 40) continue; // эмодзи-декор, яйца, ракета
      if (/\d\s*px/.test(v)) bad.push(f + ": " + v);
    }
  }
  assert.deepEqual(bad, []);
});

test("токены шрифтов --fs-* и --t-* заданы в rem", () => {
  const src = read("css/tokens.css");
  for (const m of src.matchAll(/--(?:fs|t)-[\w-]+:\s*([^;]+);/g)) assert.ok(!/\d\s*px/.test(m[1]), "px в токене: " + m[0]);
});

test("html: база 100% (rem), iOS через --sys-text-scale, ручные масштабы 87.5/100/115/135%", () => {
  const s = read("css/styles.css");
  assert.match(s, /html\s*\{[^}]*font-size:\s*100%/);
  assert.match(s, /@supports \(font: -apple-system-body\)\s*\{\s*html\s*\{\s*font-size:\s*calc\(100% \* var\(--sys-text-scale, 1\)\)/);
  for (const [k, v] of [["small", "87.5"], ["normal", "100"], ["large", "115"], ["xlarge", "135"]]) assert.match(s, new RegExp(`html\\[data-text-scale="${k}"\\]\\s*\\{\\s*font-size:\\s*${v}%`));
});

test("разметка: ряд «Размер текста» с 5 сегментами, textscale.js в head и в кэше SW, строки en/ru", () => {
  const h = read("index.html");
  for (const v of ["system", "small", "normal", "large", "xlarge"]) assert.ok(h.includes(`data-text-scale="${v}"`), v);
  assert.ok(h.indexOf('src="js/textscale.js"') > 0 && h.indexOf('src="js/textscale.js"') < h.indexOf("</head>"));
  assert.ok(read("sw.js").includes("./js/textscale.js"));
  for (const l of ["en", "ru"]) { const d = read("js/lang/" + l + ".js"); for (const k of ["", ".system", ".small", ".normal", ".large", ".xlarge"]) assert.ok(d.includes(`"settings.textScale${k}"`), l + k); }
});

async function boot(storage) {
  const a = createApp({ storage: Object.assign({ "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" }, storage || {}) });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}

test("TextScale: по умолчанию системный, set сохраняет и ставит data-text-scale, system снимает", async () => {
  const a = await boot();
  assert.equal(a.run(`TextScale.get()`), "system");
  assert.equal(a.run(`document.documentElement.getAttribute("data-text-scale")`), null);
  a.run(`TextScale.set("large")`);
  assert.equal(a.run(`localStorage.getItem("ether.textScale")`), "large");
  assert.equal(a.run(`document.documentElement.getAttribute("data-text-scale")`), "large");
  a.run(`TextScale.set("bogus")`);
  assert.equal(a.run(`TextScale.get()`), "system");
  assert.equal(a.run(`localStorage.getItem("ether.textScale")`), null);
});

test("TextScale: сохранённое значение применяется при загрузке; мусор игнорируется", async () => {
  const a = await boot({ "ether.textScale": "xlarge" });
  assert.equal(a.run(`document.documentElement.getAttribute("data-text-scale")`), "xlarge");
  const b = await boot({ "ether.textScale": "zzz" });
  assert.equal(b.run(`TextScale.get()`), "system");
  assert.equal(b.run(`document.documentElement.getAttribute("data-text-scale")`), null);
});

test("сегменты в настройках переключают масштаб и подсвечивают активный", async () => {
  const a = await boot({ "ether.textScale": "small" });
  assert.equal(a.run(`document.querySelector('#text-scale-seg .active').dataset.textScale`), "small");
  a.run(`document.querySelector('#text-scale-seg [data-text-scale="normal"]').click()`);
  assert.equal(a.run(`TextScale.get()`), "normal");
  assert.equal(a.run(`document.querySelector('#text-scale-seg .active').dataset.textScale`), "normal");
  assert.equal(a.run(`document.querySelector('#text-scale-seg [aria-checked="true"]').dataset.textScale`), "normal");
});
