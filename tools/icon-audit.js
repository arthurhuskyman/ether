#!/usr/bin/env node
// Статическая проверка иконок: каждое имя, на которое ссылается код/разметка, должно быть в реестре js/icons.js.
// Неизвестное имя в рантайме молча рисуется как «info» — это и ловим. Код выхода 1 при проблемах.
// Проверяется: Icons.html("x"), data-icon="x", icon: "x" (меню/шторки/настройки), [data-icon="x"] в CSS,
// заливаемые иконки (FILLED) есть в реестре, у каждой иконки непустое содержимое, оверрайды скинов (js/skins.js) ссылаются на реальные имена.
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const Icons = require(path.join(ROOT, "js/icons.js"));
const known = new Set(Icons.names());
const rd = (d) => fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d)).map((f) => d + "/" + f) : [];
const SKIP = /bundle\./;
const files = [...rd("js/app"), ...rd("js").filter((f) => f.endsWith(".js") && f !== "js/icons.js"), "index.html", ...rd("css").filter((f) => f.endsWith(".css")), ...rd("css/skins")].filter((f) => !SKIP.test(f) && fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());
const PATTERNS = [/Icons\.html\(\s*["']([^"'$]+)["']/g, /data-icon=["']([^"'$]+)["']/g, /\bicon:\s*["']([a-z][a-z0-9-]*)["']/g, /\[data-icon=["']?([a-z][a-z0-9-]*)/g];
function audit() {
  const problems = [], used = new Set();
  for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const re of PATTERNS) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(t))) {
        used.add(m[1]);
        if (!known.has(m[1])) problems.push(`${f}:${t.slice(0, m.index).split("\n").length}: неизвестная иконка "${m[1]}"`);
      }
    }
  }
  for (const n of known) if (!/^[a-z][a-z0-9-]*$/.test(n)) problems.push(`реестр: некорректное имя "${n}"`);
  const src = fs.readFileSync(path.join(ROOT, "js/icons.js"), "utf8");
  const fm = src.match(/FILLED = new Set\(\[([^\]]*)\]/);
  if (fm) for (const n of fm[1].match(/"([^"]+)"/g) || []) if (!known.has(n.slice(1, -1))) problems.push(`FILLED: нет иконки ${n}`);
  for (const n of known) { const h = Icons.html(n, 20); if (!/<(path|circle|rect|ellipse|line|polyline|polygon)\b/.test(h)) problems.push(`реестр: пустая иконка "${n}"`); }
  return { problems, used: [...used].sort(), unused: [...known].filter((n) => !used.has(n)).sort() };
}
module.exports = { audit };
if (require.main === module) {
  const r = audit();
  console.log(`иконок в реестре: ${known.size}, используется: ${r.used.length}, не используется: ${r.unused.length}${r.unused.length ? " (" + r.unused.join(", ") + ")" : ""}`);
  if (r.problems.length) { console.log(r.problems.join("\n")); process.exit(1); }
  console.log("OK");
}
