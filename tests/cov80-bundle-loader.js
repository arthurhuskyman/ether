// Замер покрытия бандлов. Многие чистые тесты (fix80-*, ratchet*, rich, stickers...) делают require("../js/<модуль>.js") — это исходник, а в клиентском
// замере (tools/coverage.js client) исходники, вошедшие в бандлы, исключаются, так что такие прогоны не засчитывались. Загрузчик подменяет такой
// require на ТОТ ЖЕ код из js/bundle.*.js: бандл исполняется через vm.compileFunction БЕЗ изменения текста (file:// URL бандла — как у jsdom-замеров, смещения
// те же), module подставляется, чтобы «module.exports = X» отдавало экземпляры модулей. Тест, сбросивший require.cache, получает свежий экземпляр (бандл
// исполняется заново). Использование: require("./cov80-bundle-loader").install(); затем require("./<существующий>.test.js").
const fs = require("fs"), path = require("path"), vm = require("vm"), Module = require("module");
const { pathToFileURL } = require("url");
const ROOT = path.resolve(__dirname, "..");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const MAP = { // исходник -> [бандл, имя глобала]
  "groupkeys.js": ["core", "GroupKeys"], "groupadmin.js": ["core", "GroupAdmin"], "channels.js": ["core", "Channels"], "search.js": ["core", "MsgSearch"],
  "serverlist.js": ["core", "ServerList"], "ratchet.js": ["core", "Ratchet"], "linkauth.js": ["core", "LinkAuth"], "rich.js": ["core", "EtherRich"],
  "bigfile.js": ["core", "EtherBigFile"], "callquality.js": ["core", "EtherCallQuality"], "file-limits.js": ["core", "EtherFileLimits"],
  "stickers.js": ["features", "EtherStickers"], "devicecert.js": ["features", "DeviceCert"], "devicelink.js": ["features", "DeviceLink"],
  "icons.js": ["core", "Icons"], "vendor/ml-kem768.js": ["core", null], // null — модуль только ставит globalThis.EtherMlKem768 (побочный эффект исполнения бандла)
 
};
const text = {}, started = {};
function bundle(b) { return text[b] || (text[b] = fs.readFileSync(path.join(ROOT, "js/bundle." + b + ".js"), "utf8")); }
// Какому модулю бандла принадлежит строка (по маркерам "/* ==== js/x.js ==== */").
function marks(b) {
  if (marks[b]) return marks[b];
  const lines = bundle(b).split("\n"), out = [];
  lines.forEach((l, i) => { const m = /^\/\* ==== (js\/\S+) ==== \*\//.exec(l); if (m) out.push([i + 1, m[1]]); });
  return (marks[b] = out);
}
const modAt = (b, line) => { let r = null; for (const [n, f] of marks(b)) if (n <= line) r = f; return r; };
// Исполнить бандл БЕЗ изменений текста (vm.compileFunction: const/class — внутри функции, повторный запуск даёт свежий экземпляр модулей; смещения для c8 те же,
// что в jsdom-замерах). module подставляется, чтобы «if (typeof module !== "undefined") module.exports = X» отдавало экземпляры. Побочные эффекты загрузки гасим.
function boot(b) {
  if (typeof globalThis.window === "undefined") globalThis.window = {}; // бандл пишет window.__etherDiag; модули сами проверяют typeof window
  if (!started.meta) { started.meta = true; const lm = path.join(ROOT, "js/languages-meta.js"); new vm.Script(fs.readFileSync(lm, "utf8").replace(/^const LANGUAGES/m, "var LANGUAGES"), { filename: pathToFileURL(lm).href }).runInThisContext(); }
  const got = {}, bname = "bundle." + b + ".js"; let lastF = null;
  const mod = { // присвоение module.exports: автора определяем по номеру строки в стеке
    set exports(v) { const st = new Error().stack.split("\n").find((x) => x.includes(bname)); const ln = st && /:(\d+):\d+\)?$/.exec(st); lastF = ln ? modAt(b, +ln[1]) : null; if (lastF) got[lastF] = v; },
    get exports() { return (lastF && got[lastF]) || {}; }, // truthy-заглушка для UMD-проверки "module.exports"
  };
  const file = path.join(ROOT, "js/bundle." + b + ".js");
  const f0 = globalThis.fetch; globalThis.fetch = () => Promise.reject(new Error("offline (test)")); // webrtc.js при загрузке пытается получить /ice
  try { vm.compileFunction(bundle(b), ["module"], { filename: pathToFileURL(file).href })(mod); }
  catch (e) { if (process.env.COV80_DEBUG) console.error("boot", b, String(e.message)); /* верхний уровень бандла может требовать DOM — модули до места падения уже определены */ }
  finally { globalThis.fetch = f0; }
  return got;
}
function install() {
  if (install.done) return; install.done = true;
  // webrtc.js после неудачного /ice крутит фоновые повторы через 5с*N — долгие таймеры (>= 4с) не должны держать процесс теста
  const st = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { const t = st(fn, ms, ...a); if (ms >= 4000 && t && t.unref) t.unref(); return t; };
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    let file; try { file = Module._resolveFilename(request, parent, isMain); } catch (e) { return orig.apply(this, arguments); }
    const rel = path.relative(path.join(ROOT, "js"), file).split(path.sep).join("/");
    const m = MAP[rel]; if (!m) return orig.apply(this, arguments);
    const c = Module._cache[file]; if (c && c.__bundle) return c.exports; // тест не сбрасывал кэш — тот же экземпляр
    const got = boot(m[0]); const exp = m[1] === null ? {} : got["js/" + rel];
    if (exp === undefined) throw new Error("cov80: модуль не отдан бандлом: " + rel);
    Module._cache[file] = { id: file, filename: file, loaded: true, exports: exp, children: [], paths: [], __bundle: true };
    return exp;
  };
}
module.exports = { install };
