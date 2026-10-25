// Смахивание шторки вниз закрывает любую шторку, в том числе созданную на лету («Проверка контакта»).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted() {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}
function touch(a, el, type, x, y) {
  const ev = new a.window.Event(type, { bubbles: true, cancelable: true });
  const pt = [{ clientX: x, clientY: y }];
  ev.touches = type === "touchend" ? [] : pt; ev.changedTouches = pt;
  el.dispatchEvent(ev);
}
test("динамическая шторка «Проверка» закрывается смахиванием вниз с ручки", async () => {
  const a = await booted();
  a.run(`ensureContactEntry("peer", "Peer"); fxOpenSigilSheet({ contactId: "peer", name: "Peer", keyStr: "k2", myKey: "k1", theirKey: "k2" })`);
  const sh = a.document.getElementById("fx-sigil-sheet");
  assert.ok(sh, "шторка открыта");
  const h = sh.querySelector(".sheet-handle");
  touch(a, h, "touchstart", 100, 100); touch(a, h, "touchmove", 100, 140); touch(a, h, "touchmove", 100, 220); touch(a, h, "touchend", 100, 220);
  assert.ok(!a.document.getElementById("fx-sigil-sheet") || a.document.getElementById("fx-sigil-sheet").classList.contains("hidden"), "закрыта");
  a.close();
});
test("короткий свайп (<60px) шторку не закрывает; свайп по полю ввода игнорируется", async () => {
  const a = await booted();
  a.run(`ensureContactEntry("peer", "Peer"); fxOpenSigilSheet({ contactId: "peer", name: "Peer", keyStr: "k2", myKey: "k1", theirKey: "k2" })`);
  const sh = a.document.getElementById("fx-sigil-sheet"), h = sh.querySelector(".sheet-handle");
  touch(a, h, "touchstart", 100, 100); touch(a, h, "touchmove", 100, 130); touch(a, h, "touchend", 100, 150);
  assert.ok(a.document.getElementById("fx-sigil-sheet") && !a.document.getElementById("fx-sigil-sheet").classList.contains("hidden"));
  a.close();
});
