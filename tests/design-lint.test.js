// V.85: дизайн-система проверяется в каждом прогоне тестов (и в CI)
const test = require("node:test");
const assert = require("node:assert/strict");
const { lint } = require("../tools/design-lint.js");
test("дизайн-система: шрифты в rem, радиусы по шкале, новые цвета только через токены", () => {
  const r = lint();
  assert.deepEqual(r.errors, []);
});
