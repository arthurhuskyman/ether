// node tools/coverage.js [client|server] — замер покрытия c8 с порогами: строки >= 90%, ветвления >= 80% (решение владельца).
// Клиент: тесты грузят js/bundle.*.js, поэтому исходники, вошедшие в бандлы, из отчёта исключаются (иначе двойной счёт).
// Требует: cd tests && npm install (c8 лежит в tests/node_modules). Клиентский замер ~25 мин, серверный ~5 мин.
const path = require("path"), { spawnSync } = require("child_process");
const { BUNDLES } = require("./build-bundles.js");
const ROOT = path.resolve(__dirname, "..");
const c8 = path.join(ROOT, "tests/node_modules/.bin/c8");
const which = process.argv[2] || "client";
const thr = ["--check-coverage", "--lines=90", "--branches=80"];
let args, cwd = ROOT;
if (which === "server") {
  cwd = path.join(ROOT, "signaling-server");
  args = [...thr, "--reporter=text-summary", "--allowExternal", "--exclude=test-*.js", "--exclude=node_modules/**", "--exclude=../js/**", "npm", "test"];
} else {
  const ex = ["tests/**", "tools/**", "js/vendor/**", "js/lang/**", "signaling-server/**", "js/app/**", ...BUNDLES.flatMap((b) => b.files).filter((f) => !f.startsWith("js/app/"))].map((p) => "--exclude=" + p);
  args = [...thr, "--reporter=text-summary", "--allowExternal", ...ex, "node", "--test", "--test-concurrency=2", "--test-timeout=240000", ...require("fs").readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith(".test.js")).map((f) => "tests/" + f)];
}
process.exit(spawnSync(c8, args, { cwd, stdio: "inherit" }).status || 0);
