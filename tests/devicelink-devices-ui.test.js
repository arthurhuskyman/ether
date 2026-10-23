// Экран «Мои устройства», ключи i18n, applyCompanion, подключение скриптов.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const R = path.join(__dirname, "..");

test("кнопка «Мои устройства» открывает лист; основное устройство предлагает привязку; скрипты в index.html и sw.js", async () => {
  const a = createApp({ storage: { "ether.name": "A", "ether.myId": "a".repeat(64), "ether.lang": "ru" } }); await a.ready; const d = a.document;
  d.getElementById("settings-devices-btn").click();
  const sh = d.getElementById("devicelink-sheet"); assert.ok(sh);
  assert.ok([...sh.querySelectorAll("button")].some((b) => b.className.includes("btn-primary")), "есть кнопка привязки");
  for (const f of ["devicecert.js", "devices.js"]) { const w = require("./src-helper").wiredInHtmlAndSw("js/" + f); assert.ok(w.sw, f); assert.ok(w.html, f); } // файлы внутри js/bundle.features.js
});
test("applyCompanion: проверяет пакет и кладёт ключ устройства вместо ключа личности", async () => {
  const a = createApp({ storage: { "ether.lang": "en" } }); await a.ready;
  const out = JSON.parse(a.run(`JSON.stringify(Devices.applyCompanion({"ether.myId":"u1","ether.name":"N"}, {devId:"0123456789abcdef", priv:{x:"X",y:"Y",d:"D"}, cert:{id:"u1",devId:"0123456789abcdef"}}))`));
  assert.equal(JSON.parse(out["ether.privKey"]).d, "D"); assert.equal(JSON.parse(out["ether.dev.self"]).devId, "0123456789abcdef");
  assert.throws(() => a.run(`Devices.applyCompanion({"ether.myId":"other"}, {devId:"0123456789abcdef", priv:{d:"D"}, cert:{id:"u1",devId:"0123456789abcdef"}})`), /bad-package/);
  assert.throws(() => a.run(`Devices.applyCompanion({"ether.myId":"u1"}, {devId:"zz", priv:{d:"D"}, cert:{}})`), /bad-package/);
});
test("все ключи devices.* из devices.js и devicelink.js есть в en.js и ru.js", () => {
  const src = fs.readFileSync(path.join(R, "js/devices.js"), "utf8") + fs.readFileSync(path.join(R, "js/devicelink.js"), "utf8");
  const keys = new Set([...src.matchAll(/(?:tr|T)\("(devices\.[\w.-]*\w)"/g)].map((m) => m[1]));
  assert.ok(keys.size > 10);
  for (const l of ["en", "ru"]) { const s = fs.readFileSync(path.join(R, "js/lang", l + ".js"), "utf8"); for (const k of keys) assert.ok(s.includes('"' + k + '"'), l + " нет " + k); }
});
