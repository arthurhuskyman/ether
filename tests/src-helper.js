// Исходник приложения как текст: конкатенация js/app/*.js в порядке <script src> из index.html.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
function appScriptPaths() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  return [...html.matchAll(/<script src="(js\/app\/[^"]+\.js)"><\/script>/g)].map((m) => m[1]);
}
function readAppSource() {
  return appScriptPaths().map((p) => fs.readFileSync(path.join(ROOT, p), "utf8")).join("\n");
}
module.exports = { readAppSource, appScriptPaths };
