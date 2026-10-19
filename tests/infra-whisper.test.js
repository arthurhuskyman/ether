// Whisper (js/localai.js + js/devicecheck.js): конфигурация, проверенная в песочнице на реальной речи (jfk.wav → «ask not what your country can do for you»),
// и структура диагностики. Без сети.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const ai = fs.readFileSync(path.join(ROOT, "js", "localai.js"), "utf8");
const dc = fs.readFileSync(path.join(ROOT, "js", "devicecheck.js"), "utf8");

test("onnx: один поток без прокси, wasm-устройство и q8 (Safari без SharedArrayBuffer)", () => {
  assert.match(ai, /numThreads = 1/); assert.match(ai, /\.proxy = false/);
  assert.match(ai, /device: "wasm"/); assert.match(ai, /dtype: plan\.dtype/);
  assert.match(ai, /allowLocalModels = false/);
});
test("план загрузки: base → tiny → tiny без Cache API; зеркало wasm выбирается пробой до первой попытки", () => {
  assert.match(ai, /LOAD_PLAN = \[[\s\S]*whisper|model: MODEL[\s\S]*FALLBACK_MODEL[\s\S]*cache: false/);
  assert.match(ai, /unpkg\.com\/@huggingface\/transformers@3\.0\.0\/dist\//);
  assert.ok(ai.indexOf("Range: \"bytes=0-0\"") < ai.indexOf("mod.pipeline("), "пробный запрос wasm должен идти раньше pipeline");
  assert.match(ai, /STALL_MS/);
});
test("диагностика: этапы, http, размер, окружение, подсказка; ошибки очищаются от URL", () => {
  for (const k of ["stage", "attempts", "bytes", "http", "hint", "envInfo", "crossOriginIsolated", "SharedArrayBuffer", "deviceMemory"]) assert.ok(ai.includes(k), k);
  for (const k of ["stage=", "downloaded", "attempts [", "Подсказка", "sha384 mismatch", "TF_SHA384"]) assert.ok(dc.includes(k), k);
});
test("hintFor и cleanMsg: чистят ссылки и дают подсказки", () => {
  const vm = require("vm");
  const ctx = { window: {}, document: { baseURI: "http://x/", documentElement: { getAttribute() { return "ru"; } } }, localStorage: { getItem() { return null; } }, navigator: {}, etherLog() {}, console };
  vm.createContext(ctx); vm.runInContext(ai + "\nthis.L = LocalAI;", ctx);
  const L = ctx.L;
  assert.match(L.hintFor("model", "Error", "no available backend found. ERR: [wasm] fetching of the wasm failed", []), /huggingface|jsdelivr/);
  assert.match(L.hintFor("model", "RangeError", "Array buffer allocation failed", []), /памят/);
  assert.match(L.hintFor("model", "Error", "x", [404]), /ошибкой/);
  assert.match(L.hintFor("lib", "Error", "x", []), /transformers\.min\.js/);
});
