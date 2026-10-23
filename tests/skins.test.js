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
const IDS = ["cartoon", "comic", "watercolor", "neon", "steampunk", "gothic", "clay", "lego", "wood", "glass", "chalk", "newyear"];
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
    (out[m[1]] ||= {})[m[2]] = d;
  }
  return out;
}
const hexOf = (v) => { const m = /#([0-9a-fA-F]{6})\b/.exec(v || ""); return m ? m[1] : null; };
const lum = (hex) => { const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test("скины: у каждого из 12 есть светлая и тёмная палитра с полным набором переменных", () => {
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
  const cards = Array.from(d.querySelectorAll("#skin-grid .skin-card"));
  assert.equal(cards.length, 13, "обычный + 12 скинов");
  assert.ok(cards.find((c) => c.dataset.skin === "neon").classList.contains("active"));
  cards.find((c) => c.dataset.skin === "gothic").click();
  assert.equal(a.run(`Skins.get()`), "gothic");
  assert.equal(cards.find((c) => c.dataset.skin === "gothic").getAttribute("aria-checked"), "true");
  cards.find((c) => c.dataset.skin === "default").click();
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
