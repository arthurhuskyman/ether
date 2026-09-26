/**
 * validate.js — проверка целостности словарей после разбивки на
 * отдельные файлы (js/languages-meta.js + js/lang/<code>.js).
 *
 * Запуск:  node validate.js
 *
 * Проверяет:
 *   1. Каждому коду из реестра LANGUAGES соответствует файл js/lang/<code>.js.
 *   2. У всех словарей одинаковый набор ключей (эталон — "en").
 *   3. Нет пустых значений.
 *   4. RTL-языки (ar, fa, ur, he) помечены rtl: true.
 */
"use strict";

const path = require("path");
const fs = require("fs");

const langDir = path.resolve(__dirname, "..", "js", "lang");
const metaFile = path.resolve(__dirname, "..", "js", "languages-meta.js");

if (!fs.existsSync(metaFile)) {
  console.error("✗ languages-meta.js не найден в", path.dirname(metaFile));
  process.exit(1);
}

const metaMod = require(metaFile);
const LANGUAGES = metaMod.LANGUAGES;
if (!LANGUAGES) {
  console.error("✗ languages-meta.js должен экспортировать { LANGUAGES }");
  process.exit(1);
}

const codes = Object.keys(LANGUAGES);
console.log(`Проверяю ${codes.length} языков...\n`);

let errors = 0;

const dicts = {};
const missingFiles = [];
for (const code of codes) {
  const file = path.join(langDir, code + ".js");
  if (!fs.existsSync(file)) { missingFiles.push(code); continue; }
  const src = fs.readFileSync(file, "utf8");
  const win = { __LANG_DICTS: {}, __onLangDictReady: () => {} };
  try {
    const fn = new Function("window", src);
    fn(win);
    dicts[code] = win.__LANG_DICTS[code];
  } catch (e) {
    errors++;
    console.error(`✗ ${code}: ошибка выполнения файла — ${e.message}`);
  }
}
if (missingFiles.length) {
  errors++;
  console.error("✗ Коды без файла js/lang/<code>.js:", missingFiles.join(", "));
}

const keySets = {};
for (const code of codes) {
  if (dicts[code]) keySets[code] = new Set(Object.keys(dicts[code]));
}

const refCode = keySets.en ? "en" : codes.find((c) => keySets[c]);
if (!refCode) {
  console.error("✗ Не найден ни один словарь для эталона.");
  process.exit(1);
}
const refKeys = keySets[refCode];
console.log(`Эталон: ${refCode} (${refKeys.size} ключей)\n`);

for (const code of codes) {
  const keys = keySets[code];
  if (!keys) continue;

  const missingKeys = [];
  const extraKeys = [];
  for (const k of refKeys) if (!keys.has(k)) missingKeys.push(k);
  for (const k of keys) if (!refKeys.has(k)) extraKeys.push(k);

  if (missingKeys.length || extraKeys.length) {
    errors++;
    console.error(`✗ ${code}:`);
    if (missingKeys.length) {
      console.error(
        `    отсутствуют (${missingKeys.length}): ` +
          missingKeys.slice(0, 8).join(", ") +
          (missingKeys.length > 8 ? " …" : "")
      );
    }
    if (extraKeys.length) {
      console.error(
        `    лишние (${extraKeys.length}): ` +
          extraKeys.slice(0, 8).join(", ") +
          (extraKeys.length > 8 ? " …" : "")
      );
    }
  }
}

for (const code of codes) {
  const dict = dicts[code];
  if (!dict) continue;
  const empty = Object.keys(dict).filter(
    (k) => typeof dict[k] !== "string" || dict[k].trim() === ""
  );
  if (empty.length) {
    errors++;
    console.error(
      `✗ ${code}: пустые значения (${empty.length}): ` +
        empty.slice(0, 6).join(", ") +
        (empty.length > 6 ? " …" : "")
    );
  }
}

const MUST_RTL = ["ar", "fa", "ur", "he"];
const rtlIssues = MUST_RTL.filter((c) => LANGUAGES[c] && !LANGUAGES[c].rtl);
if (rtlIssues.length) {
  errors++;
  console.error("✗ RTL-языки без флага rtl:true:", rtlIssues.join(", "));
}

console.log("");
if (errors === 0) {
  console.log(`✓ Все ${codes.length} языков прошли проверку (по ${refKeys.size} ключей).`);
  process.exit(0);
} else {
  console.error(`✗ Найдено проблем: ${errors}`);
  process.exit(1);
}
