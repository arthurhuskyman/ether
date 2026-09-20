/**
 * validate.js — проверка целостности словарей в languages.js.
 *
 * Запуск:  node validate.js
 *
 * Проверяет:
 *   1. Реестр LANGUAGES ссылается только на существующие словари.
 *   2. У всех словарей одинаковый набор ключей (эталон — "en").
 *   3. Нет пустых значений.
 *   4. RTL-языки (ar, fa, ur, he) помечены rtl: true.
 */
"use strict";

const path = require("path");
const fs = require("fs");

const file = path.resolve(__dirname, "languages.js");
if (!fs.existsSync(file)) {
  console.error("✗ languages.js не найден в", __dirname);
  process.exit(1);
}

const mod = require(file);
const LANGUAGES = mod.LANGUAGES;
if (!LANGUAGES) {
  console.error("✗ languages.js должен экспортировать { LANGUAGES }");
  process.exit(1);
}

const codes = Object.keys(LANGUAGES);
console.log(`Проверяю ${codes.length} языков...\n`);

let errors = 0;

// 1. Реестр ссылается на существующие словари
const missing = [];
for (const code of codes) {
  const entry = LANGUAGES[code];
  if (!entry || !entry.dict) missing.push(code);
}
if (missing.length) {
  errors++;
  console.error("✗ Коды без словаря:", missing.join(", "));
}

// 2. Наборы ключей
const keySets = {};
for (const code of codes) {
  const dict = LANGUAGES[code] && LANGUAGES[code].dict;
  if (dict) keySets[code] = new Set(Object.keys(dict));
}

const refCode = keySets.en ? "en" : codes.find(c => keySets[c]);
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

// 3. Пустые значения
for (const code of codes) {
  const dict = LANGUAGES[code] && LANGUAGES[code].dict;
  if (!dict) continue;
  const empty = Object.keys(dict).filter(
    k => typeof dict[k] !== "string" || dict[k].trim() === ""
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

// 4. RTL-языки
const MUST_RTL = ["ar", "fa", "ur", "he"];
const rtlIssues = MUST_RTL.filter(c => LANGUAGES[c] && !LANGUAGES[c].rtl);
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