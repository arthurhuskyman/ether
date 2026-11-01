#!/usr/bin/env node
// V.85: проверка дизайн-системы. Запускается в тестах (tests/design-lint.test.js), значит и в CI.
// Правила: 1) шрифт не в px (кроме декоративных ≥ 40px); 2) радиусы базовых стилей — только шкала
// 0 / 4 / 8 / 12 / 16 / 24 / 50% / 999px или токен var(...); 3) радиусы скинов не больше 48px (характер скина, но без «пилюль» на всё);
// 4) «храповик» сырых цветов: в styles.css их не больше, чем было (новые — только через токены).
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const RAW_COLOR_BASELINE = 93; // +3: пары «поверхность + чернила» подсветки поиска из V.80.2 (контраст)
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
function lint() {
  const errors = [];
  const files = ["css/styles.css", "css/tokens.css", "css/skins.css"].concat(fs.readdirSync(path.join(ROOT, "css/skins")).filter((f) => f.endsWith(".css")).map((f) => "css/skins/" + f));
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    src.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/font-size:\s*([0-9.]+)px/g)) if (Number(m[1]) < 40) errors.push(`${f}:${i + 1} шрифт ${m[1]}px — нужен rem или токен`);
      for (const m of line.matchAll(/border(?:-[a-z]+)*-radius:\s*([^;}]+)/g)) {
        const parts = m[1].replace(/!important/, "").trim().replace(/var\([^)]*\)+/g, "VAR").split(/[\s/]+/).filter(Boolean);
        for (const p of parts) {
          if (p === "VAR" || p === "inherit" || p === "0" || p === "50%" || p === "999px" || /vw$|vh$|%$/.test(p)) continue;
          const px = /^([0-9.]+)px$/.exec(p);
          if (!px) { errors.push(`${f}:${i + 1} радиус «${p}» вне шкалы`); continue; }
          const v = Number(px[1]);
          if (f.startsWith("css/skins/")) { if (v > 48) errors.push(`${f}:${i + 1} радиус скина ${v}px больше 48px`); }
          else if (![4, 8, 12, 16, 24].includes(v)) errors.push(`${f}:${i + 1} радиус ${v}px вне шкалы 4/8/12/16/24`);
        }
      }
    });
  }
  const st = read("css/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const raw = (st.match(/(^|[^-])(color|background(-color)?):\s*#[0-9a-fA-F]{3,8}/gm) || []).length;
  if (raw > RAW_COLOR_BASELINE) errors.push(`css/styles.css: сырых цветов ${raw}, допустимо ${RAW_COLOR_BASELINE} — новые цвета только через токены`);
  return { errors, rawColors: raw };
}
module.exports = { lint };
if (require.main === module) {
  const r = lint();
  if (r.errors.length) { console.error(r.errors.join("\n")); process.exit(1); }
  console.log("дизайн-система в порядке (сырых цветов: " + r.rawColors + ")");
}
