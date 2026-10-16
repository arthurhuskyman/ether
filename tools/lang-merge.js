// node tools/lang-merge.js <код> <файл.json> — добавляет переводы {ключ: "текст"} в js/lang/<код>.js (только отсутствующие ключи из en;
// плейсхолдеры {x}, %s, %d, переводы строк и HTML-теги должны совпадать с английским — иначе ключ пропускается и печатается)
const fs = require("fs"), path = require("path");
function load(code) { const d = {}; new Function("window", fs.readFileSync(path.join(__dirname, "../js/lang", code + ".js"), "utf8"))({ __LANG_DICTS: d }); return d[code] || {}; }
const [code, file] = process.argv.slice(2);
const en = load("en"), cur = load(code), add = JSON.parse(fs.readFileSync(file, "utf8"));
const ph = (s) => (String(s).match(/\{[^}]+\}|%[sd]|<\/?[a-z]+[^>]*>|\n/gi) || []).sort().join("|");
let ok = 0, bad = [];
const lines = [];
for (const [k, v] of Object.entries(add)) {
  if (!(k in en) || k in cur) continue;
  if (typeof v !== "string" || !v.trim()) { bad.push(k + " (пусто)"); continue; }
  if (ph(v) !== ph(en[k])) { bad.push(k + " (плейсхолдеры)"); continue; }
  lines.push("    " + JSON.stringify(k) + ": " + JSON.stringify(v) + ",");
  ok++;
}
if (ok) {
  const p = path.join(__dirname, "../js/lang", code + ".js");
  let s = fs.readFileSync(p, "utf8");
  const i = s.lastIndexOf("};");
  const head = s.slice(0, i).replace(/\s*$/, "");
  const sep = /,$/.test(head) || /\{$/.test(head) ? "\n" : ",\n";
  s = head + sep + lines.join("\n") + "\n" + s.slice(i);
  fs.writeFileSync(p, s);
}
console.log(code + ": добавлено " + ok + (bad.length ? ", пропущено " + bad.length + ": " + bad.slice(0, 10).join(", ") : ""));
