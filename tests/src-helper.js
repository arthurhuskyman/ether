// Исходник приложения как текст: конкатенация js/app/*.js (источники, не бандл) в порядке манифеста tools/build-bundles.js.
// index.html теперь подключает js/bundle.app.js, а не отдельные куски, поэтому порядок берём из манифеста бандлов.
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { appFiles } = require("../tools/build-bundles.js");
function appScriptPaths() { return appFiles.slice(); }
function readAppSource() {
  return appScriptPaths().map((p) => fs.readFileSync(path.join(ROOT, p), "utf8")).join("\n");
}
module.exports = { readAppSource, appScriptPaths };
// Файл подключён и предзагружается: либо отдельным тегом/записью, либо внутри бандла, который есть в index.html и sw.js.
const { BUNDLES } = require("../tools/build-bundles.js");
function wiredInHtmlAndSw(file) {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const b = BUNDLES.find((x) => x.files.includes(file));
  const unit = b ? b.out : file;
  return { unit, html: html.includes('src="' + unit + '"'), sw: sw.includes('"./' + unit + '"') };
}
module.exports.wiredInHtmlAndSw = wiredInHtmlAndSw;
