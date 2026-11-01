// Аудит контраста скинов: чистая математика WCAG (tools/skin-contrast-lib.js) + быстрый прогон реального аудита на одном скине.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const C = require("../tools/skin-contrast-lib.js");
const near = (a, b, e = 0.02) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);

test("контраст: эталонные пары WCAG", () => {
  near(C.ratio([0, 0, 0, 1], [255, 255, 255, 1]), 21, 0.001);
  near(C.ratio([255, 255, 255, 1], [255, 255, 255, 1]), 1, 0.001);
  near(C.ratio([119, 119, 119, 1], [255, 255, 255, 1]), 4.48, 0.02); // #777 на белом — известная граница 4.5
  near(C.ratio([118, 118, 118, 1], [255, 255, 255, 1]), 4.54, 0.02);
  assert.equal(C.ratio([10, 20, 30, 1], [200, 210, 220, 1]), C.ratio([200, 210, 220, 1], [10, 20, 30, 1]));
});

test("разбор цвета: rgb/rgba/color(srgb)/hex/transparent", () => {
  assert.deepEqual(C.parseColor("rgb(1, 2, 3)"), [1, 2, 3, 1]);
  assert.deepEqual(C.parseColor("rgba(255, 255, 255, 0.5)"), [255, 255, 255, 0.5]);
  assert.deepEqual(C.parseColor("rgb(10 20 30 / 50%)"), [10, 20, 30, 0.5]);
  assert.deepEqual(C.parseColor("#fff"), [255, 255, 255, 1]);
  assert.deepEqual(C.parseColor("#11223380").map((v) => Math.round(v * 100) / 100), [17, 34, 51, 0.5]);
  assert.deepEqual(C.parseColor("color(srgb 1 0 0 / 0.5)"), [255, 0, 0, 0.5]);
  assert.deepEqual(C.parseColor("transparent"), [0, 0, 0, 0]);
  assert.equal(C.parseColor("oklab(0.5 0 0)"), null);
  assert.equal(C.parseColor(5), null);
});

test("композиция: альфа предков, градиент -> средний цвет, прозрачность текста", () => {
  // полупрозрачная белая панель на чёрном даёт серый
  const bg = C.composite([[255, 255, 255, 0.5]], [0, 0, 0, 1]);
  near(bg[0], 127.5, 0.01); assert.equal(bg[3], 1);
  // слой сверху перекрывает нижний; прозрачные слои игнорируются
  assert.deepEqual(C.composite([[0, 0, 0, 0], [255, 0, 0, 1], [0, 255, 0, 1]], [9, 9, 9, 1]).slice(0, 3), [255, 0, 0]);
  // градиент: среднее по стопам, прозрачный стоп снижает альфу (а не затемняет цвет)
  const m = C.meanColor([[255, 255, 255, 1], [0, 0, 0, 1]]);
  assert.deepEqual(m, [127.5, 127.5, 127.5, 1]);
  const m2 = C.meanColor([[200, 0, 0, 1], [0, 0, 0, 0]]);
  assert.deepEqual(m2, [200, 0, 0, 0.5]);
  assert.equal(C.meanColor([]), null);
  // прозрачность текста: белый с opacity 0.5 на белом нечитаем, на чёрном — серый
  near(C.textRatio([255, 255, 255, 1], [255, 255, 255, 1], 0.5), 1, 0.001);
  assert.ok(C.textRatio([255, 255, 255, 1], [0, 0, 0, 1], 0.5) < C.textRatio([255, 255, 255, 1], [0, 0, 0, 1], 1));
  assert.ok(C.textRatio([0, 0, 0, 0.3], [255, 255, 255, 1]) < 4.5);
});

test("крупный текст по WCAG: от 24px или 18.66px жирным", () => {
  assert.ok(C.isLarge(24, 400)); assert.ok(C.isLarge(19, 700)); assert.ok(!C.isLarge(19, 400)); assert.ok(!C.isLarge(14, 700));
});

test("аудит скинов: инструмент подхватывает список из js/skins.js и сэмпл скина проходит без нарушений", { timeout: 240000 }, (t) => {
  const tool = path.join(__dirname, "..", "tools", "skin-contrast.js");
  assert.ok(/Skins\.LIST/.test(fs.readFileSync(tool, "utf8")), "список скинов берётся из приложения, а не зашит");
  if (!fs.existsSync("/opt/node-tools/node_modules/playwright")) return t.skip("нет Playwright");
  const r = spawnSync(process.execPath, [tool, "--skins", "default,neon", "--schemes", "dark"], { encoding: "utf8", timeout: 220000 });
  if (/Executable doesn't exist|browserType\.launch/.test(r.stderr + r.stdout)) return t.skip("нет Chromium");
  assert.equal(r.status, 0, r.stdout.slice(-1500) + r.stderr.slice(-500));
});

test("доска задач в пузыре (входящем и исходящем) читаема во всех схемах: карточки не берут светлую панель скина", { timeout: 240000 }, (t) => {
  const tool = path.join(__dirname, "..", "tools", "skin-contrast.js");
  if (!fs.existsSync("/opt/node-tools/node_modules/playwright")) return t.skip("нет Playwright");
  const out = path.join(require("os").tmpdir(), "skin-board-" + process.pid + ".json");
  // sakura/vampire/medieval — светлая схема с бордовыми/сливовыми исходящими пузырями на кремовой странице (жалоба владельца V.79), default — без data-skin
  const r = spawnSync(process.execPath, [tool, "--skins", "sakura,vampire,medieval,default", "--schemes", "light,dark", "--screens", "chat", "--strict", "--probe", ".board-bubble *", "--out", out], { encoding: "utf8", timeout: 220000 });
  if (/Executable doesn't exist|browserType\.launch/.test(r.stderr + r.stdout)) return t.skip("нет Chromium");
  const rows = JSON.parse(fs.readFileSync(out, "utf8")); fs.unlinkSync(out);
  const board = rows.filter((x) => /board-/.test(x.el));
  for (const sel of ["board-card-t", "board-col-name", "board-add"]) assert.ok(board.some((x) => x.el.includes(sel)), "в прогоне нет " + sel + " (доска не отрисована?)");
  const bad = board.filter((x) => (x.kind === "text" || x.kind === "probe") && x.ratio < 4.5);
  assert.deepEqual(bad.map((x) => `${x.skin}/${x.scheme} ${x.el} ${x.ratio}`), []);
  assert.deepEqual(rows.filter((x) => x.kind !== "probe").map((x) => `${x.skin}/${x.scheme} ${x.el} ${x.ratio}`), []);
});
