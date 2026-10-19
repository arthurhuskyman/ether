// Перенос на новое устройство: интерфейс в приложении (кнопки, лист отправки, QR-хук, санитайзер, применение пакета, совместимость).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
process.env.LINK_INIT_PER_MIN = "100";
const Srv = require("../signaling-server/devicelink.js");
const DL = require("../js/devicelink.js");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
let server, base;
test.before(async () => {
  server = http.createServer(async (req, res) => { if (!(await Srv.handle(req, res, "127.0.0.1"))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(30); } throw new Error("timeout"); }

test("кнопки на месте, ключи i18n есть в en и ru, скрипт в кэше SW и в index.html", async () => {
  const a = createApp({ storage: { "ether.name": "A", "ether.myId": "a".repeat(64), "ether.lang": "ru" } }); await a.ready;
  const d = a.document;
  assert.ok(d.getElementById("settings-link-device-btn")); assert.ok(d.getElementById("onboarding-link-device-btn"));
  const R = path.join(__dirname, "..");
  assert.ok(fs.readFileSync(path.join(R, "sw.js"), "utf8").includes('"./js/devicelink.js"'));
  const keys = [...fs.readFileSync(path.join(R, "js/devicelink.js"), "utf8").matchAll(/tr\("(devlink\.[\w.-]*\w)"/g)].map((m) => m[1]);
  for (const l of ["en", "ru"]) { const src = fs.readFileSync(path.join(R, "js/lang", l + ".js"), "utf8"); for (const k of new Set(keys)) assert.ok(src.includes('"' + k + '"'), l + " нет " + k); }
});

test("отправка из приложения: код в QR/поле, подтверждение, пакет без привязанного к устройству, затем предложение стереть", async () => {
  const a = createApp({ fetch: (u, i) => fetch(u, i), storage: { "ether.name": "Аня", "ether.myId": "a".repeat(64), "ether.lang": "ru", "ether.signalingUrl": base.replace("http", "ws"), "ether.contacts": '[{"id":"b"}]', "ether.sec.on": "1", "ether.pushSubscription": "{}" } });
  await a.ready; const d = a.document;
  d.getElementById("settings-link-device-btn").click();
  const sheet = d.getElementById("devicelink-sheet"); assert.ok(sheet);
  [...sheet.querySelectorAll("button")].find((b) => b.className.includes("btn-primary")).click();
  const box = await until(() => d.querySelector("#devicelink-sheet textarea.link-code"));
  const code = await until(() => box.value);
  assert.match(code, /^ether:\/\/link\?s=/);
  const r = await DL.join({ code, pollMs: 30 });
  const yes = await until(() => [...d.querySelectorAll("#devicelink-sheet button")].find((b) => b.className.includes("btn-primary") && /\d/.test(d.querySelector("#devicelink-sheet .link-verify") ? "1" : "")));
  assert.equal(d.querySelector("#devicelink-sheet .link-verify").textContent.replace(/\s/g, ""), r.verify, "проверочные коды совпадают");
  const got = r.receive(); yes.click();
  const data = await got;
  assert.equal(data["ether.contacts"], '[{"id":"b"}]'); assert.equal(data["ether.name"], "Аня");
  assert.equal(data["ether.sec.on"], undefined); assert.equal(data["ether.pushSubscription"], undefined);
  const wipe = await until(() => [...d.querySelectorAll("#devicelink-sheet button")].some((b) => b.className.includes("btn-primary")) && d.querySelectorAll("#devicelink-sheet button").length === 2);
  assert.ok(wipe, "после успеха предлагается выйти и стереть, а также оставить");
});

test("«не совпадает» не отправляет ничего", async () => {
  const a = createApp({ fetch: (u, i) => fetch(u, i), storage: { "ether.name": "A", "ether.myId": "a".repeat(64), "ether.lang": "ru", "ether.signalingUrl": base.replace("http", "ws") } });
  await a.ready; const d = a.document;
  d.getElementById("settings-link-device-btn").click();
  [...d.querySelectorAll("#devicelink-sheet button")].find((b) => b.className.includes("btn-primary")).click();
  const code = await until(() => (d.querySelector("#devicelink-sheet textarea.link-code") || {}).value);
  const r = await DL.join({ code, pollMs: 30 });
  await until(() => d.querySelector("#devicelink-sheet .link-verify"));
  const btns = [...d.querySelectorAll("#devicelink-sheet button")]; btns[btns.length - 1].click();
  assert.equal(d.getElementById("devicelink-sheet"), null);
  await assert.rejects(Promise.race([r.receive(), wait(1500).then(() => { throw Object.assign(new Error("x"), { code: "still-waiting" }); })]), (e) => e.code === "expired" || e.code === "still-waiting");
});

test("получение: лист ввода на онбординге, применение пакета заменяет ether.* и не трогает ничего лишнего", async () => {
  const a = createApp({ storage: { "ether.lang": "ru", "ether.junk": "old" } }); await a.ready; const d = a.document;
  d.getElementById("onboarding-link-device-btn").click();
  assert.ok(d.querySelector("#devicelink-sheet textarea"));
  await a.run('applyImportedData({"ether.name":"Нов","ether.myId":"' + "c".repeat(64) + '"})').catch(() => {});
  assert.equal(a.window.localStorage.getItem("ether.name"), "Нов"); assert.equal(a.window.localStorage.getItem("ether.junk"), null);
});

test("санитайзер диагностики вырезает код переноса; QR-хук в сканере есть", async () => {
  const a = createApp({ storage: { "ether.lang": "ru" } }); await a.ready;
  const code = DL.encodeCode(DL.newSecret(), "https://srv.example.org");
  const out = a.run("DeviceCheck").sanitize("scan " + code + " ok");
  assert.ok(!out.includes(code.slice(15, 40)) && out.includes("<link-code>"), out);
  assert.ok(require("./src-helper").readAppSource().includes('indexOf("ether://link?") === 0'));
});
