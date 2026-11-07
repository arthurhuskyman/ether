// V.88.3: лаконичная шапка чата — один значок безопасности у имени, кристалл на углу аватара, без «›».
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const css = R("css/styles.css"), w85 = R("js/app/20-wave85.js"), fx = R("js/features.js");
test("значок безопасности один и стоит после имени; дубль #chat-trust-badge в шапке скрыт", () => {
  assert.match(w85, /const tb = document\.getElementById\("chat-peer-name"\)/);
  assert.match(css, /#nav-chat-mode #chat-trust-badge \{ display: none; \}/);
  assert.match(css, /#nav-chat-mode \.p85-sec-badge\[data-state="e2e"\] \{ display: none; \}/);
  assert.match(css, /#nav-chat-mode \.p85-sec-badge \{[^}]*min-width: 32px; min-height: 32px;/, "зона нажатия ≥ 32px");
});
test("кристалл The Vault — сразу после аватара; стрелки «›» после имени нет; блок собеседника слева", () => {
  assert.match(fx, /av\.insertAdjacentElement\("afterend", v\)/);
  assert.doesNotMatch(css, /#chat-peer-name::after \{ content: "›"/);
  assert.match(css, /#nav-chat-mode \.chat-header-info \{ justify-content: flex-start; \}/);
});
