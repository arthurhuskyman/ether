// node tools/lang-override.js <код> <файл.json> — заменяет УЖЕ существующие переводы {ключ: "текст"} в js/lang/<код>.js (для ключей, чей английский текст изменился).
// Плейсхолдеры {x}, %s, %d, HTML-теги и переводы строк должны совпадать с js/lang/en.js, иначе ключ пропускается. Новые ключи не добавляет (для них lang-merge.js).
const fs = require("fs"), path = require("path");
function load(code) { const d = {}; new Function("window", fs.readFileSync(path.join(__dirname, "../js/lang", code + ".js"), "utf8"))({ __LANG_DICTS: d }); return d[code] || {}; }
const [code, file] = process.argv.slice(2);
const en = load("en"), cur = load(code), add = JSON.parse(fs.readFileSync(file, "utf8"));
const ph = (s) => (String(s).match(/\{[^}]+\}|%[sd]|<\/?[a-z]+[^>]*>|\n/gi) || []).sort().join("|");
const p = path.join(__dirname, "../js/lang", code + ".js");
let s = fs.readFileSync(p, "utf8"), ok = 0; const bad = [];
for (const [k, v] of Object.entries(add)) {
  if (!(k in cur) || !(k in en)) continue;
  if (typeof v !== "string" || !v.trim()) { bad.push(k + " (пусто)"); continue; }
  if (ph(v) !== ph(en[k])) { bad.push(k + " (плейсхолдеры)"); continue; }
  const re = new RegExp("^(\\s*)" + JSON.stringify(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*.*$", "m");
  if (!re.test(s)) { bad.push(k + " (не найден в файле)"); continue; }
  s = s.replace(re, (m, sp) => sp + JSON.stringify(k) + ": " + JSON.stringify(v) + ",");
  ok++;
}
if (ok) fs.writeFileSync(p, s);
console.log(code + ": заменено " + ok + (bad.length ? ", пропущено: " + bad.join("; ") : ""));
