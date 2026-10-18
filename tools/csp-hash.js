// Пересчитывает CSP в index.html: node tools/csp-hash.js [--check]
// Inline-скрипты разрешены только по sha256-хэшу; при их правке запустите без флага. С --check только проверяет (код 1 при расхождении).
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const file = path.resolve(__dirname, "..", "index.html");
function build(html) {
  const hashes = [];
  html.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, (m, body) => { hashes.push("'sha256-" + crypto.createHash("sha256").update(body, "utf8").digest("base64") + "'"); return m; });
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob: " + hashes.join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https: wss: ws://localhost:* http://localhost:* blob: data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
if (require.main === module) {
  const html = fs.readFileSync(file, "utf8");
  const csp = build(html);
  const re = /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/;
  if (!re.test(html)) { console.error("CSP meta не найдена"); process.exit(1); }
  const out = html.replace(re, (m, a, b) => a + csp + b);
  if (process.argv.includes("--check")) { if (out !== html) { console.error("CSP устарела: запустите node tools/csp-hash.js"); process.exit(1); } console.log("CSP актуальна"); }
  else { fs.writeFileSync(file, out); console.log(csp); }
}
module.exports = { build };
