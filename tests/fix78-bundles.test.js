// Бандлы js/bundle.*.js: актуальны, порядок и состав как у исходников, index.html/sw.js на них ссылаются,
// глобальные функции после загрузки бандлов те же, что после загрузки отдельных исходников.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm"), cp = require("child_process");
const { createApp, closeAll } = require("./harness");
const ROOT = path.resolve(__dirname, "..");
const { BUNDLES, HTML_ORDER, build } = require("../tools/build-bundles.js");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const shell = [...sw.slice(sw.indexOf("SHELL_FILES"), sw.indexOf("];")).matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]);
const htmlSrcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).filter((s) => !s.startsWith("js/lang/"));

test("бандлы актуальны (node tools/build-bundles.js --check)", () => {
  cp.execFileSync(process.execPath, [path.join(ROOT, "tools/build-bundles.js"), "--check"]);
  for (const b of BUNDLES) assert.equal(fs.readFileSync(path.join(ROOT, b.out), "utf8"), build(b), b.out);
});

test("каждый исходный js-файл из манифеста включён ровно один раз, маркеры идут в порядке манифеста", () => {
  const all = BUNDLES.flatMap((b) => b.files);
  assert.equal(new Set(all).size, all.length);
  for (const f of all) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  for (const b of BUNDLES) {
    const text = fs.readFileSync(path.join(ROOT, b.out), "utf8");
    const marks = [...text.matchAll(/^\/\* ==== (\S+) ==== \*\/$/gm)].map((m) => m[1]);
    assert.deepEqual(marks, b.files, b.out);
    for (const f of b.files) assert.ok(text.includes(fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n").replace(/^﻿/, "").replace(/\n+$/, "")), f);
  }
  // все js/app/*.js на диске в бандле
  const onDisk = fs.readdirSync(path.join(ROOT, "js/app")).filter((f) => f.endsWith(".js")).map((f) => "js/app/" + f);
  for (const f of onDisk) assert.ok(all.includes(f), f);
});

test("порядок бандлов в index.html = HTML_ORDER, все файлы существуют; отдельных исходников бандлов в index.html нет", () => {
  const nonLang = htmlSrcs.filter((s) => s !== "js/textscale.js");
  assert.deepEqual(nonLang, HTML_ORDER);
  for (const s of htmlSrcs) assert.ok(fs.existsSync(path.join(ROOT, s)), s);
  const bundled = new Set(BUNDLES.flatMap((b) => b.files));
  for (const s of htmlSrcs) assert.ok(!bundled.has(s), "уже в бандле: " + s);
});

test("порядок выполнения сохранён: бандлы в порядке прежних <script>, кроме задокументированного переноса discovery.js", () => {
  const original = ["js/i18n.js", "js/signaling-codec.js", "js/crypto-helper.js", "js/secure-store.js", "js/icons.js", "js/rich.js", "js/vendor/ml-kem768.js", "js/ratchet.js", "js/linkauth.js", "js/signaling-client.js", "js/serverlist.js", "js/discovery.js", "js/callquality.js", "js/webrtc.js", "js/file-limits.js", "js/bigfile.js", "js/emoji-data.js"];
  const V80 = ["js/groupkeys.js", "js/groupadmin.js", "js/channels.js", "js/search.js"]; // V.80: новые модули стоят сразу после ratchet.js
  const flat = BUNDLES.flatMap((b) => b.files);
  assert.deepEqual(flat.slice(flat.indexOf("js/ratchet.js") + 1, flat.indexOf("js/ratchet.js") + 5), V80);
  flat.splice(flat.indexOf("js/ratchet.js") + 1, 4);
  const expected = [...original.filter((f) => f !== "js/discovery.js"), "js/discovery.js"];
  assert.deepEqual(flat.slice(0, expected.length), expected);
  const rest = flat.slice(expected.length);
  assert.ok(rest[0] === "js/app/01-core-store.js" || rest[1] === "js/app/01-core-store.js");
  const iApp = flat.indexOf("js/app/17-search.js"); // V.80: после 14-backup-boot идут 15-channels, 16-groupadmin, 17-search
  assert.deepEqual(flat.slice(iApp + 1, iApp + 9), ["js/stickers.js", "js/group-call.js", "js/rooms.js", "js/localai.js", "js/devicecheck.js", "js/devicecert.js", "js/devicelink.js", "js/devices.js"]);
  assert.deepEqual(flat.slice(-3), ["js/skins/sakura.js", "js/features.js", "js/features2.js"]);
});

test("sw.js предзагружает бандлы и файлы, нужные в рантайме (crypto-helper для воркера); исходников бандлов там нет", () => {
  for (const b of BUNDLES) assert.ok(shell.includes(b.out), b.out);
  for (const s of htmlSrcs) assert.ok(shell.includes(s), "не в предзагрузке: " + s);
  assert.ok(shell.includes("js/crypto-helper.js") && shell.includes("js/crypto-worker.js"));
  for (const f of BUNDLES.flatMap((b) => b.files).filter((f) => f !== "js/crypto-helper.js")) assert.ok(!shell.includes(f), f);
  for (const f of shell) if (f && f !== "./") assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test("строгость: бандлы со строгими файлами начинаются с \"use strict\" (после комментариев), остальные — нет", () => {
  for (const b of BUNDLES) {
    const text = fs.readFileSync(path.join(ROOT, b.out), "utf8").replace(/\/\*[\s\S]*?\*\/\s*/g, "");
    assert.equal(/^["']use strict["']/.test(text), b.strict, b.out);
  }
});

function loadScripts(files) {
  const a = createApp({ scripts: files, storage: { "ether.name": "Tester", "ether.myId": "me-test-id", "ether.lang": "en" } });
  return { dom: a.dom, ctx: a.dom.getInternalVMContext(), errs: a.errors };
}
function topFunctions(src) { return [...src.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]); }

test("jsdom: после бандлов набор глобальных функций (typeof) тот же, что после отдельных исходников", () => {
  const vendor = ["js/vendor/qrcode-generator.js", "js/vendor/qrcode-generator-utf8.js", "js/vendor/jsQR.js"];
  const srcOrder = [...vendor, ...BUNDLES.flatMap((b) => b.files), "js/easter.js"];
  const bunOrder = [...vendor, ...BUNDLES.map((b) => b.out), "js/easter.js"];
  const names = [...new Set(srcOrder.flatMap((f) => topFunctions(fs.readFileSync(path.join(ROOT, f), "utf8"))))];
  assert.ok(names.length > 500, "найдено функций: " + names.length);
  const probe = `JSON.stringify(${JSON.stringify(names)}.map((n) => { try { return [n, typeof eval(n)]; } catch (e) { return [n, "err"]; } }))`;
  const a = loadScripts(srcOrder), b = loadScripts(bunOrder);
  const ta = JSON.parse(new vm.Script(probe).runInContext(a.ctx)), tb = JSON.parse(new vm.Script(probe).runInContext(b.ctx));
  assert.deepEqual(tb, ta);
  assert.ok(ta.filter(([, t]) => t === "function").length > 500);
  assert.deepEqual(b.errs, a.errs);
  const globals = (x) => new vm.Script(`JSON.stringify(Object.keys(window).filter((k) => !/^(on|webkit)/.test(k)).sort())`).runInContext(x.ctx);
  assert.equal(globals(b), globals(a));
  closeAll();
});
