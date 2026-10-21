// M2 (Safari: toBlob("image/webp") отдаёт PNG), M5/M6 (гонки devices), M7 (K_REVOKED читается), M8 (render со счётчиком поколения).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted() {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}

test("M2: Safari отдаёт PNG вместо webp — стикер принимается и ужимается под лимит", async () => {
  const a = await booted();
  a.run(`window.createImageBitmap = async () => ({ width: 800, height: 800, close() {} });
    window.__sizes = [];
    HTMLCanvasElement.prototype.toBlob = function (cb, type) { const px = this.width * this.height; window.__sizes.push(this.width); cb(new Blob([new Uint8Array(Math.round(px / 2))], { type: "image/png" })); };`);
  const r = await a.run(`EtherStickers.prepare(new File([new Uint8Array(100)], "a.png", { type: "image/png" })).then((p) => p && { type: p.blob.type, size: p.blob.size, w: p.w })`);
  assert.ok(r, "prepare вернул результат");
  assert.equal(r.type, "image/png");
  assert.ok(r.size <= a.run(`EtherStickers.USER_MAX_BYTES`));
  assert.ok(r.w < 256, "сторона уменьшена");
  a.close();
});

test("M2: blob неподдерживаемого типа от toBlob по-прежнему отклоняется", async () => {
  const a = await booted();
  a.run(`window.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
    HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new Blob(["x"], { type: "image/bmp" })); };`);
  assert.equal(await a.run(`EtherStickers.prepare(new File([new Uint8Array(100)], "a.png", { type: "image/png" }))`), null);
  a.close();
});

test("M6: параллельные renewDue делят один проход; M5: параллельные refreshPeer тоже", async () => {
  const a = await booted();
  assert.equal(a.run(`(() => { const p1 = Devices.renewDue(), p2 = Devices.renewDue(); return p1 === p2; })()`), true);
  assert.equal(a.run(`(() => { const p1 = Devices.refreshPeer("zz"), p2 = Devices.refreshPeer("zz"); return p1 === p2; })()`), true);
  a.close();
});

test("M7: отозванный companion не стартует сигналинг; K_REVOKED читается", async () => {
  const a = await booted();
  a.run(`localStorage.setItem("ether.dev.self", JSON.stringify({ devId: "d1", cert: { expires: Date.now() + 1e10 } })); localStorage.setItem("ether.dev.revoked", "1");`);
  const started = a.run(`(() => { const sig = new EventTarget(); sig.started = 0; sig.start = () => { sig.started++; }; sig.stop = () => {}; Devices.wireSignaling(sig); sig.start(); return sig.started; })()`);
  assert.equal(started, 0);
  a.close();
});

test("M8: render() сверяет поколение после await превью", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "stickers.js"), "utf8");
  assert.match(src, /const gen = \+\+renderGen;/);
  assert.match(src, /await Promise\.all\(keys\.map\(thumbHtml\)\);\s*if \(gen !== renderGen\) return;/);
});
