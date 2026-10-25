const test = require("node:test"), assert = require("node:assert");
const { audit } = require("../tools/icon-audit.js");

test("статический аудит иконок: все ссылки на имена есть в реестре", () => {
  const r = audit();
  assert.deepStrictEqual(r.problems, []);
  for (const n of ["phone", "mic", "volume", "video", "more", "monitor", "flip", "chevron-down"]) assert.ok(r.used.includes(n), "кнопки звонка используют " + n);
});

test("экран звонка: у каждой кнопки есть видимая иконка (svg с data-icon или собственной графикой)", () => {
  const html = require("fs").readFileSync(require("path").join(__dirname, "../index.html"), "utf8");
  for (const id of ["call-accept-btn", "call-decline-btn", "call-mute-accept-btn", "call-mute-btn", "call-speaker-btn", "call-video-btn", "call-hangup-btn", "call-more-btn"]) {
    const m = html.match(new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)</button>'));
    assert.ok(m && /<svg[\s\S]*?(data-icon=|<path)/.test(m[1]), id + " без иконки");
  }
});
