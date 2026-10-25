// js/textscale.js (не входит в бандлы, замер идёт по самому файлу): миграция старой настройки, системный масштаб iOS, события, ошибки localStorage.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { pathToFileURL } = require("url");
const { JSDOM } = require("jsdom");
const FILE = path.join(__dirname, "..", "js", "textscale.js"), SRC = fs.readFileSync(FILE, "utf8");

function load(setup, opts) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { runScripts: "outside-only", url: "http://localhost/" });
  const w = dom.window; if (setup) setup(w);
  const ctx = dom.getInternalVMContext();
  new vm.Script(SRC + "\n;window.__TS = TextScale;", { filename: pathToFileURL(FILE).href }).runInContext(ctx);
  return { w, TS: w.__TS, root: w.document.documentElement };
}
const px = (v) => (w) => { w.CSS = { supports: () => true }; w.getComputedStyle = () => ({ fontSize: v }); };

test("миграция ether.fontSize: compact -> small, large -> large, прочее и уже заданное не трогаем", () => {
  for (const [old, want] of [["compact", "small"], ["large", "large"], ["weird", null]]) {
    const { w } = load((w) => w.localStorage.setItem("ether.fontSize", old)); assert.equal(w.localStorage.getItem("ether.textScale"), want);
  }
  const { w } = load((w) => { w.localStorage.setItem("ether.fontSize", "compact"); w.localStorage.setItem("ether.textScale", "xlarge"); });
  assert.equal(w.localStorage.getItem("ether.textScale"), "xlarge"); assert.equal(w.document.documentElement.getAttribute("data-text-scale"), "xlarge");
});

test("get/set/apply: недопустимые значения -> system, system снимает атрибут и ключ, localStorage бросает", () => {
  const { w, TS, root } = load();
  assert.equal(TS.get(), "system"); assert.equal(root.hasAttribute("data-text-scale"), false);
  TS.set("large"); assert.equal(TS.get(), "large"); assert.equal(root.getAttribute("data-text-scale"), "large");
  TS.set("bogus"); assert.equal(TS.get(), "system"); assert.equal(w.localStorage.getItem(TS.KEY), null); assert.equal(root.hasAttribute("data-text-scale"), false);
  w.localStorage.setItem(TS.KEY, "garbage"); assert.equal(TS.get(), "system");
  TS.set("small"); TS.apply("nope"); assert.equal(root.getAttribute("data-text-scale"), "small");
  const broken = load((w) => { Object.defineProperty(w, "localStorage", { get() { throw new Error("denied"); } }); });
  assert.equal(broken.TS.get(), "system"); broken.TS.set("large"); assert.equal(broken.root.getAttribute("data-text-scale"), "large");
});

test("sysScale: нет CSS.supports/не iOS -> 1; iOS: px/17 с ограничением 0.85..2; мусор и исключения -> 1", () => {
  assert.equal(load().TS.sysScale(), 1);
  assert.equal(load((w) => { w.CSS = {}; }).TS.sysScale(), 1);
  assert.equal(load((w) => { w.CSS = { supports: () => false }; }).TS.sysScale(), 1);
  assert.equal(load(px("20px")).TS.sysScale().toFixed(3), (20 / 17).toFixed(3));
  assert.equal(load(px("40px")).TS.sysScale(), 2); assert.equal(load(px("5px")).TS.sysScale(), 0.85);
  for (const bad of ["", "0px", "abc"]) assert.equal(load(px(bad)).TS.sysScale(), 1);
  assert.equal(load((w) => { w.CSS = { supports: () => true }; w.getComputedStyle = () => { throw new Error("x"); }; }).TS.sysScale(), 1);
  const { root } = load(px("17px")); assert.equal(root.style.getPropertyValue("--sys-text-scale"), "1");
});

test("события pageshow/resize/visibilitychange пересчитывают масштаб только в режиме system", () => {
  let size = "17px"; const { w, TS, root } = load((w) => { w.CSS = { supports: () => true }; w.getComputedStyle = () => ({ fontSize: size }); });
  size = "34px"; w.dispatchEvent(new w.Event("resize")); assert.equal(root.style.getPropertyValue("--sys-text-scale"), "2");
  size = "17px"; w.dispatchEvent(new w.Event("pageshow")); assert.equal(root.style.getPropertyValue("--sys-text-scale"), "1");
  Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
  size = "34px"; w.document.dispatchEvent(new w.Event("visibilitychange")); assert.equal(root.style.getPropertyValue("--sys-text-scale"), "2");
  Object.defineProperty(w.document, "hidden", { value: true, configurable: true }); size = "17px"; w.document.dispatchEvent(new w.Event("visibilitychange")); assert.equal(root.style.getPropertyValue("--sys-text-scale"), "2");
  Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
  TS.set("large"); size = "34px"; w.dispatchEvent(new w.Event("resize")); assert.equal(root.style.getPropertyValue("--sys-text-scale"), "1");
});

test("без document/window (воркер): модуль загружается, apply — no-op", () => {
  const ctx = vm.createContext({});
  new vm.Script(SRC + "\n;this.__TS = TextScale;", { filename: pathToFileURL(FILE).href }).runInContext(ctx);
  assert.equal(ctx.__TS.get(), "system"); assert.equal(ctx.__TS.sysScale(), 1); ctx.__TS.apply("large"); ctx.__TS.set("large");
});
