// node tools/lang-missing.js <код> [файл.json] — ключи en, которых нет в js/lang/<код>.js (ключ → английский текст; для справки добавлен русский)
const fs = require("fs"), path = require("path");
function load(code) { const d = {}; new Function("window", fs.readFileSync(path.join(__dirname, "../js/lang", code + ".js"), "utf8"))({ __LANG_DICTS: d }); return d[code] || {}; }
const code = process.argv[2], out = process.argv[3];
const en = load("en"), ru = load("ru"), cur = load(code);
const res = {};
for (const k of Object.keys(en)) if (!(k in cur)) res[k] = { en: en[k], ru: ru[k] };
if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1)); else console.log(JSON.stringify(res, null, 1));
console.error(Object.keys(res).length + " ключей без перевода в " + code);
