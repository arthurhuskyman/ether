// V.88.2: кнопка микрофона не вылезает за композер в скинах с увеличенной кнопкой; на телефонах «Поиск» шапки уходит в меню «⋯».
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const css = fs.readFileSync(path.join(__dirname, "..", "css", "styles.css"), "utf8");
const thread = fs.readFileSync(path.join(__dirname, "..", "js", "app", "06-thread.js"), "utf8");
test("слот send/mic растягивается под кнопку, а не фиксирован 40px", () => {
  const m = css.match(/\.send-mic-slot \{[^}]*\}/); assert.ok(m);
  assert.match(m[0], /display: grid/); assert.match(m[0], /min-width: 40px/); assert.doesNotMatch(m[0], /(^|[^-])width: 40px/);
  assert.match(css, /\.send-mic-slot \.send-btn \{\s*grid-area: 1 \/ 1;/);
});
test("до 440px значок поиска скрыт, а в меню шапки есть пункт «Поиск»", () => {
  assert.match(css, /@media \(max-width: 440px\) \{[^}]*\}\s*#nav-chat-mode #chat-search-btn \{ display: none; \}|@media \(max-width: 440px\) \{\s*#nav-chat-mode \{ gap: 2px; \}\s*#nav-chat-mode #chat-search-btn \{ display: none; \}/);
  assert.match(thread, /sb && getComputedStyle\(sb\)\.display === "none" \? \[\{ label: T\("a11y\.search"\), icon: "search", fn: \(\) => sb\.click\(\) \}\]/);
});
