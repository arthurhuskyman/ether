// node tools/coverage.js [client|server] — замер покрытия c8 с порогами: строки >= 90%, ветвления >= 80% (решение владельца).
// Клиент: тесты грузят js/bundle.*.js, поэтому исходники, вошедшие в бандлы, из итога исключаются (иначе двойной счёт).
// Итог считает сам скрипт по json-summary (исключения --exclude у c8 на этих путях не срабатывали).
// Требует: cd tests && npm install (c8 лежит в tests/node_modules). Клиентский замер ~25 мин, серверный ~5 мин.
const fs = require("fs"), path = require("path"), os = require("os"), { spawnSync } = require("child_process");
const { BUNDLES } = require("./build-bundles.js");
const ROOT = path.resolve(__dirname, "..");
const c8 = path.join(ROOT, "tests/node_modules/.bin/c8");
const which = process.argv[2] || "client";
const LINES = 90, BRANCHES = 80;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cov-")), rep = path.join(tmp, "rep");
const common = ["--reporter=json-summary", "--allowExternal", "--temp-directory=" + path.join(tmp, "raw"), "--report-dir=" + rep];
let cwd = ROOT, cmd, keep;
const bundled = new Set(BUNDLES.flatMap((b) => b.files));
if (which === "server") {
  cwd = path.join(ROOT, "signaling-server");
  cmd = [...common, "npm", "test"];
  keep = (p) => p.startsWith("signaling-server/") && !/\/(test-[^/]*|node_modules\/.*)$/.test(p);
} else {
  cmd = [...common, "node", "--test", "--test-concurrency=2", "--test-timeout=240000", ...fs.readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith(".test.js")).map((f) => "tests/" + f)];
  keep = (p) => p.startsWith("js/") && !p.startsWith("js/vendor/") && !p.startsWith("js/lang/") && !bundled.has(p);
}
const r = spawnSync(c8, cmd, { cwd, stdio: "inherit" });
const sum = JSON.parse(fs.readFileSync(path.join(rep, "coverage-summary.json"), "utf8"));
let l = [0, 0], b = [0, 0];
for (const [k, v] of Object.entries(sum)) {
  if (k === "total") continue;
  const p = path.relative(ROOT, k).split(path.sep).join("/");
  if (!keep(p)) continue;
  l[0] += v.lines.covered; l[1] += v.lines.total; b[0] += v.branches.covered; b[1] += v.branches.total;
}
const lp = (100 * l[0]) / l[1], bp = (100 * b[0]) / b[1];
console.log(`\n[${which}] строки ${lp.toFixed(1)}% (${l[0]}/${l[1]}), ветвления ${bp.toFixed(1)}% (${b[0]}/${b[1]}); пороги ${LINES}% / ${BRANCHES}%`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.status || (lp < LINES || bp < BRANCHES ? 1 : 0));
