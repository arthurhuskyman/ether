// Скины: список, применение, сохранение, ранняя установка, словари, покрытие CSS и контраст палитр (день и ночь у каждого).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..");
const css = [fs.readFileSync(path.join(ROOT, "css", "skins.css"), "utf8")].concat(fs.readdirSync(path.join(ROOT, "css", "skins")).sort().map((f) => fs.readFileSync(path.join(ROOT, "css", "skins", f), "utf8"))).join("\n");
const IDS = ["glass", "neon", "clay", "sakura", "cartoon", "comic", "watercolor", "steampunk", "gothic", "lego", "wood", "chalk", "newyear"]; // порядок = Skins.LIST без default; первые четыре + default — главная пятёрка
const MAIN = ["default", "glass", "neon", "clay", "sakura"];
async function booted(storage) {
  const a = createApp({ storage: Object.assign({ "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" }, storage || {}) });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}
// ---- разбор палитр из CSS
function blocks() {
  const out = {};
  for (const m of css.matchAll(/html\[data-skin="(\w+)"\]\[data-scheme="(light|dark)"\]\s*\{([^}]*)\}/g)) {
    const d = {}; for (const x of m[3].matchAll(/(--[\w-]+):\s*([^;]+);/g)) d[x[1]] = x[2].trim();
    const o = (out[m[1]] ||= {}); o[m[2]] = Object.assign(o[m[2]] || {}, d); // допускаются дополнительные блоки той же схемы (правки контраста)
  }
  return out;
}
const hexOf = (v) => { const m = /#([0-9a-fA-F]{6})\b/.exec(v || ""); return m ? m[1] : null; };
const lum = (hex) => { const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test("скины: у каждого из 13 есть светлая и тёмная палитра с полным набором переменных", () => {
  const b = blocks();
  for (const id of IDS) for (const sc of ["light", "dark"]) {
    const d = b[id] && b[id][sc]; assert.ok(d, `${id}/${sc}: блок палитры`);
    for (const k of ["--bg-0", "--ink-0", "--accent", "--bubble-mine-bg", "--bubble-mine-ink", "--bubble-theirs-bg", "--bubble-theirs-ink", "--sk-panel", "--sk-bg", "--sk-btn-bg", "--sk-btn-ink", "--sk-line", "--sk-shadow"]) assert.ok(d[k], `${id}/${sc}: ${k}`);
  }
  for (const id of IDS) assert.ok(new RegExp(`html\\[data-skin="${id}"\\]\\s*\\{`).test(css), `${id}: общий блок формы`);
});

test("скины: контраст текста к фону не ниже 4.5:1 в день и ночь (там, где цвета заданы hex)", () => {
  const b = blocks(), bad = [];
  for (const id of IDS) for (const sc of ["light", "dark"]) {
    const d = b[id][sc];
    const pairs = [["--ink-0", "--bg-0"], ["--ink-0", "--sk-panel"], ["--bubble-mine-ink", "--bubble-mine-bg"], ["--bubble-theirs-ink", "--bubble-theirs-bg"], ["--sk-btn-ink", "--sk-btn-bg"], ["--accent", "--sk-panel"]];
    for (const [fg, bg] of pairs) {
      const f = hexOf(d[fg]), g = hexOf(d[bg]); if (!f || !g) continue;
      const r = ratio(f, g); if (r < 4.5) bad.push(`${id}/${sc} ${fg} на ${bg}: ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, [], "низкий контраст:\n" + bad.join("\n"));
});

test("скины: модуль, применение, сохранение и возврат к обычному виду", async () => {
  const a = await booted();
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify(Skins.IDS.slice(1))`)), IDS);
  assert.equal(a.run(`Skins.get()`), "default");
  assert.equal(a.run(`document.documentElement.getAttribute("data-skin")`), null);
  a.run(`Skins.set("cartoon")`);
  assert.equal(a.run(`document.documentElement.getAttribute("data-skin")`), "cartoon");
  assert.equal(a.window.localStorage.getItem("ether.skin"), "cartoon");
  assert.equal(a.run(`Skins.set("../evil")`), "default", "неизвестное значение → обычный вид");
  assert.equal(a.run(`document.documentElement.getAttribute("data-skin")`), null);
  assert.equal(a.run(`CRITICAL_LS_KEYS.includes("ether.skin")`), true, "скин входит в резервную копию");
  a.close();
});

test("скины: сохранённый скин применяется при запуске, цвет статус-бара и сетка выбора", async () => {
  const a = await booted({ "ether.skin": "neon", "ether.theme": "dark" });
  assert.equal(a.run(`document.documentElement.getAttribute("data-skin")`), "neon");
  const meta = () => a.run(`document.querySelector('meta[name="theme-color"]').getAttribute("content")`);
  assert.equal(meta(), "#07060f", "ночной неон");
  a.run(`applyTheme("light")`);
  assert.equal(meta(), "#eaf4ff", "дневной неон (= --bg-0 скина)");
  const d = a.document;
  const cards = () => Array.from(d.querySelectorAll("#skin-grid .skin-card"));
  assert.equal(cards().length, 6, "пять скинов и ячейка «…»");
  assert.ok(cards().find((c) => c.dataset.skin === "neon").classList.contains("active"));
  d.querySelector("#skin-more-btn").click();
  assert.equal(d.getElementById("skin-sheet").classList.contains("hidden"), false, "«…» открывает шторку");
  const sheet = Array.from(d.querySelectorAll("#skin-sheet-grid .skin-card"));
  assert.equal(sheet.length, 14, "в шторке все 14");
  assert.ok(sheet.find((c) => c.dataset.skin === "neon").classList.contains("active"), "текущий отмечен");
  sheet.find((c) => c.dataset.skin === "gothic").click();
  assert.equal(a.run(`Skins.get()`), "gothic");
  assert.equal(d.getElementById("skin-sheet").classList.contains("hidden"), true, "после выбора шторка закрыта");
  assert.deepEqual(cards().filter((c) => c.dataset.skin).map((c) => c.dataset.skin), ["default", "glass", "neon", "clay", "gothic"], "выбранный вне пятёрки занимает последнее место");
  assert.equal(cards().find((c) => c.dataset.skin === "gothic").getAttribute("aria-checked"), "true");
  assert.ok(cards()[5].classList.contains("skin-more"), "«…» всегда шестая");
  cards().find((c) => c.dataset.skin === "default").click();
  assert.deepEqual(cards().filter((c) => c.dataset.skin).map((c) => c.dataset.skin), MAIN, "вернулась обычная пятёрка");
  assert.equal(a.run(`document.documentElement.getAttribute("data-skin")`), null);
  assert.equal(meta(), "#fafafc", "после возврата цвет снова от обычной темы");
  a.close();
});

test("скины: названия есть в en и ru, файлы подключены в index.html и service worker", () => {
  const en = fs.readFileSync(path.join(ROOT, "js/lang/en.js"), "utf8"), ru = fs.readFileSync(path.join(ROOT, "js/lang/ru.js"), "utf8");
  for (const id of ["default", ...IDS]) { assert.ok(en.includes(`"skin.name.${id}"`), "en " + id); assert.ok(ru.includes(`"skin.name.${id}"`), "ru " + id); }
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  assert.match(html, /css\/skins\.css/); assert.match(html, /js\/skins\.js/);
  assert.match(html, /data-skin/, "ранний скрипт в <head> ставит скин до первой отрисовки");
  assert.match(sw, /\.\/css\/skins\.css/); assert.match(sw, /\.\/js\/skins\.js/);
});

test("скины: в списке 14 скинов, главная пятёрка по умолчанию, sakura зарегистрирован", async () => {
  const a = await booted();
  assert.equal(a.run(`Skins.LIST.length`), 14);
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify(Skins.MAIN)`)), MAIN);
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify(Skins.LIST.map((s) => s.id))`)), ["default", ...IDS]);
  const sp = a.run(`(() => { Skins.set("sakura"); const s = Skins.spec(); return JSON.stringify({ icons: !!s.icons && Object.keys(s.icons).length > 5, sound: Object.keys(s.sound || {}).sort(), haptic: !!s.haptic, deco: typeof s.deco }); })()`);
  const o = JSON.parse(sp);
  assert.equal(o.icons, true); assert.deepEqual(o.sound, ["error", "in", "out", "react", "tab", "tap"]); assert.equal(o.haptic, true); assert.equal(o.deco, "function");
  a.close();
});

test("скины: цвета превью в Skins.LIST совпадают с --bg-0 / --bg-2 / --accent из css/skins/<id>.css", async () => {
  const a = await booted(); const b = blocks(), bad = [];
  const list = JSON.parse(a.run(`JSON.stringify(Skins.LIST)`));
  for (const s of list) {
    if (s.id === "default") continue;
    for (const sc of ["light", "dark"]) {
      const d = b[s.id][sc], got = s[sc], want = [d["--bg-0"], d["--bg-2"], d["--accent"]];
      if (got.join() .toLowerCase() !== want.join().toLowerCase()) bad.push(`${s.id}/${sc}: превью ${got} ≠ css ${want}`);
      if (s.bar[sc].toLowerCase() !== d["--bg-0"].toLowerCase()) bad.push(`${s.id}/${sc}: bar ${s.bar[sc]} ≠ --bg-0`);
    }
  }
  assert.deepEqual(bad, []);
  a.close();
});

test("скины: файлы sakura на месте, подключены в index.html и sw.js; у каждого скина есть css и js", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  for (const id of IDS) {
    assert.ok(fs.existsSync(path.join(ROOT, "css", "skins", id + ".css")), id + ".css");
    assert.ok(fs.existsSync(path.join(ROOT, "js", "skins", id + ".js")), id + ".js");
    assert.ok(html.includes(`js/skins/${id}.js`), "index.html " + id);
    assert.ok(sw.includes(`./js/skins/${id}.js`), "sw.js " + id);
  }
  assert.equal(fs.readdirSync(path.join(ROOT, "css", "skins")).length, 14 - 1, "13 css-файлов скинов (у обычного вида своего нет)");
});

// Сетка выбора скина одинакова во ВСЕХ скинах: раскладку (сетка, ширина, отступы, поля, шрифт, display) задаёт только css/styles.css,
// скин может менять лишь оформление — цвет рамки, скругление, тень.
test("скины: ни один css/skins/*.css и skins.css не задаёт раскладку .skin-grid / .skin-card", () => {
  const files = [path.join(ROOT, "css", "skins.css")].concat(fs.readdirSync(path.join(ROOT, "css", "skins")).map((f) => path.join(ROOT, "css", "skins", f)));
  const FORBID = /^(grid|grid-[\w-]+|width|min-width|max-width|height|min-height|max-height|padding(-[\w-]+)?|margin(-[\w-]+)?|inset(-[\w-]+)?|font|font-size|font-family|line-height|display|gap|row-gap|column-gap|flex(-[\w-]+)?|align-[\w-]+|justify-[\w-]+|position|zoom|transform)$/;
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\.skin-(grid|card|emoji|name|sw|more)\b|#skin-grid|#skin-sheet-grid/.test(m[1])) continue;
      for (const decl of m[2].split(";")) { const prop = decl.split(":")[0].trim().toLowerCase(); if (prop && FORBID.test(prop)) bad.push(`${path.basename(f)}: ${m[1].trim().slice(0, 60)} { ${prop} }`); }
    }
  }
  assert.deepEqual(bad, [], "скин меняет раскладку сетки выбора:\n" + bad.join("\n"));
});

test("скины: сетка выбора — ровно 3 колонки в css/styles.css", () => {
  const css0 = fs.readFileSync(path.join(ROOT, "css", "styles.css"), "utf8");
  assert.match(css0, /\.skin-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(css0, /\.skin-grid \{[^}]*auto-fill/);
});

test("скины: контраст палитры sakura и акцентных пар --on-accent на --accent-bg не ниже 4.5:1", () => {
  const b = blocks(), bad = [];
  for (const id of IDS) for (const sc of ["light", "dark"]) {
    const d = b[id][sc], f = hexOf(d["--on-accent"]), g = hexOf(d["--accent-bg"]);
    if (!f || !g) { bad.push(`${id}/${sc}: нет --on-accent/--accent-bg`); continue; }
    if (f && g && ratio(f, g) < 4.5) bad.push(`${id}/${sc} --on-accent на --accent-bg: ${ratio(f, g).toFixed(2)}`);
  }
  assert.deepEqual(bad, []);
});
