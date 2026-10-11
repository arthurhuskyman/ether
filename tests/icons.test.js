// Единый набор иконок: реестр, гидратация, отсутствие «потерянных» имён в разметке и коде.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Icons = require("../js/icons.js");
const ROOT = path.join(__dirname, "..");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

test("все data-icon в index.html и Icons.html(...) в js/app.js есть в наборе", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  const names = new Set();
  for (const m of html.matchAll(/data-icon="([a-z0-9-]+)"/g)) names.add(m[1]);
  for (const m of app.matchAll(/Icons\.html\("([a-z0-9-]+)"/g)) names.add(m[1]);
  for (const m of app.matchAll(/\bicon: "([a-z0-9-]+)"/g)) names.add(m[1]);
  assert.ok(names.size > 25, "иконок в использовании: " + names.size);
  for (const n of names) assert.ok(Icons.has(n), "нет иконки " + n);
});

test("гидратация заполняет svg, заливочные иконки помечены", async () => {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en" } });
  await a.ready;
  const d = a.document;
  const all = Array.from(d.querySelectorAll("svg[data-icon]"));
  assert.ok(all.length > 50);
  for (const el of all) assert.ok(el.innerHTML.length > 10, "пустая иконка " + el.getAttribute("data-icon"));
  assert.ok(d.querySelector('svg[data-icon="play"]') === null || d.querySelector('svg[data-icon="play"]').classList.contains("ico-fill"));
  assert.match(a.run(`Icons.html("send", 18)`), /<svg class="ico" viewBox="0 0 24 24" width="18" height="18"/);
  a.close();
});
