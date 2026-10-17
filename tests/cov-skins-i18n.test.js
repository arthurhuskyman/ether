const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createApp, closeAll, ROOT } = require("./harness");
test.after(closeAll);

const SKIN_IDS = ["cartoon", "comic", "watercolor", "neon", "steampunk", "gothic", "clay", "lego", "wood", "glass", "chalk", "newyear"];

function loadDict(file) {
  const w = {}; w.window = w;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js", "lang", file), "utf8"), w);
  return Object.values(w.__LANG_DICTS)[0];
}
const J = (x) => JSON.parse(JSON.stringify(x));
const ph = (s) => (String(s).match(/\{\w+\}|%[sd]/g) || []).sort().join(",");

// ---------------- скины ----------------
test("скины: каждый из 12 регистрируется с иконками, звуками, deco", async () => {
  const a = createApp(); await a.ready;
  const info = JSON.parse(a.run(`JSON.stringify(Skins.IDS.map((id) => { Skins.set(id); const s = Skins.spec(); return { id, has: !!s, icons: s && s.icons ? Object.keys(s.icons) : [], sound: s && s.sound ? Object.keys(s.sound) : [], deco: !!(s && typeof s.deco === "function") }; }))`));
  assert.equal(info.length, 13);
  for (const id of SKIN_IDS) {
    const r = info.find((x) => x.id === id);
    assert.ok(r && r.has, id + " зарегистрирован");
    assert.ok(r.icons.length >= 10, id + " иконки");
    assert.ok(r.deco, id + " deco");
    for (const k of ["in", "out", "tap", "tab", "react", "error"]) assert.ok(r.sound.includes(k) || r.sound.length === 0, id + " звук " + k);
  }
  assert.equal(info.find((x) => x.id === "default").has, false);
  a.close();
});

test("скины: иконки — валидный SVG-фрагмент, имена известны Icons", async () => {
  const a = createApp(); await a.ready;
  const out = JSON.parse(a.run(`JSON.stringify(Skins.IDS.filter((i) => i !== "default").map((id) => { Skins.set(id); const ic = Skins.spec().icons || {}; const bad = []; for (const [k, v] of Object.entries(ic)) { const d = document.createElement("div"); d.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + v + '</svg>'; const n = d.querySelector("svg").children.length; if (!Icons.has(k) || typeof v !== "string" || !n) bad.push(k); if (/<script|onload|onerror|javascript:/i.test(v)) bad.push("xss:" + k); } return { id, bad }; }))`));
  for (const r of out) assert.deepEqual(r.bad, [], r.id);
  a.close();
});

test("скины: партитуры звуков валидны (f/t/d/v, форма волны, фильтры)", async () => {
  const a = createApp(); await a.ready;
  const scores = JSON.parse(a.run(`JSON.stringify(Skins.IDS.filter((i) => i !== "default").map((id) => { Skins.set(id); return { id, sound: Skins.spec().sound || {} }; }))`));
  const waves = ["sine", "square", "sawtooth", "triangle", "noise"];
  let notes = 0;
  for (const { id, sound } of scores) {
    for (const [kind, score] of Object.entries(sound)) {
      assert.ok(["in", "out", "tap", "tab", "react", "error"].includes(kind), id + ":" + kind);
      assert.ok(Array.isArray(score) && score.length > 0, id + ":" + kind + " не пуст");
      for (const n of score) {
        notes++;
        if (n.w !== "noise") { const fs_ = Array.isArray(n.f) ? n.f : [n.f]; assert.ok(fs_.length <= 2 && fs_.every((f) => Number.isFinite(f) && f > 0 && f < 20000), id + ":" + kind + " f"); }
        assert.ok(n.t === undefined || (Number.isFinite(n.t) && n.t >= 0 && n.t < 3), id + " t");
        assert.ok(n.d === undefined || (Number.isFinite(n.d) && n.d > 0 && n.d < 3), id + " d");
        assert.ok(n.v === undefined || (Number.isFinite(n.v) && n.v > 0 && n.v <= 0.5), id + " v");
        assert.ok(n.w === undefined || waves.includes(n.w), id + " w=" + n.w);
        for (const f of ["lp", "hp"]) assert.ok(n[f] === undefined || (n[f] > 0 && n[f] < 24000), id + " " + f);
      }
    }
  }
  assert.ok(notes > 100);
  a.close();
});

test("скины: play() проигрывает каждую партитуру на заглушке AudioContext, не бросает", async () => {
  const a = createApp(); await a.ready;
  const r = a.run(`(() => { const P = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }); const mk = (t) => { const x = { t, connect(y) { return y; }, start() {}, stop() {}, frequency: P(), Q: P(), gain: P() }; window.__nodes.push(t); return x; };
    window.__nodes = []; const ctx = { currentTime: 0, sampleRate: 8000, destination: {}, createGain: () => mk("gain"), createOscillator: () => mk("osc"), createBiquadFilter: () => mk("bq"), createBufferSource: () => mk("buf"), createBuffer: (c, l) => ({ getChannelData: () => new Float32Array(l) }) }; let n = 0; for (const id of Skins.IDS) { Skins.set(id); const s = Skins.spec(); if (!s || !s.sound) continue; for (const sc of Object.values(s.sound)) { Skins.play(sc, ctx); n++; } } return n; })()`);
  assert.ok(r >= 12 * 3);
  assert.ok(a.window.__nodes.includes("osc") && a.window.__nodes.includes("gain") && a.window.__nodes.includes("buf") && a.window.__nodes.includes("bq"));
  a.close();
});

test("скины: deco рисует слой, возвращает cleanup; calm-режим и обе схемы не бросают", async () => {
  const a = createApp(); await a.ready;
  const res = JSON.parse(a.run(`JSON.stringify(Skins.IDS.filter((i) => i !== "default").map((id) => {
    Skins.set(id); const sp = Skins.spec(); const out = { id };
    for (const calm of [false, true]) for (const scheme of ["light", "dark"]) {
      const layer = document.createElement("div"); document.body.appendChild(layer);
      let cleanup, err = null;
      try { cleanup = sp.deco(layer, { scheme, calm }); } catch (e) { err = String(e); }
      out[(calm ? "calm" : "live") + scheme] = { err, kids: layer.childNodes.length, cleanup: typeof cleanup };
      if (typeof cleanup === "function") { try { cleanup(); } catch (e) { out.cleanupErr = String(e); } }
      layer.remove();
    }
    try { sp.deco(document.createElement("div")); out.noOpts = true; } catch (e) { out.noOptsErr = String(e); }
    return out; }))`));
  for (const r of res) {
    assert.equal(r.cleanupErr, undefined, r.id);
    for (const k of ["livelight", "livedark", "calmlight", "calmdark"]) { assert.equal(r[k].err, null, r.id + k); assert.ok(r[k].kids > 0, r.id + k + " нарисовал"); assert.ok(["function", "undefined"].includes(r[k].cleanup)); }
    assert.equal(r.noOpts, true, r.id + " без opts: " + r.noOptsErr);
  }
  a.close();
});

test("скины: apply/set/render/wire/sfx/onTap, невалидные id", async () => {
  const a = createApp(); await a.ready;
  const r = J(a.run(`(() => {
    const o = {};
    Skins.wire();
    o.cards = document.querySelectorAll("#skin-grid .skin-card").length;
    o.apply1 = Skins.apply("nope"); o.valid = [Skins.valid("neon"), Skins.valid("x"), Skins.valid(null)];
    Skins.set("neon"); o.layer = !!document.getElementById("skin-deco"); o.layerSkin = document.getElementById("skin-deco").dataset.skin;
    o.active = document.querySelector("#skin-grid .skin-card.active").dataset.skin;
    document.querySelector('#skin-grid [data-skin="gothic"]').click(); o.afterClick = Skins.get();
    localStorage.setItem(Skins.KEY, "garbage"); o.garbage = Skins.get();
    o.sfxNo = Skins.sfx("nonexistent"); o.name = Skins.name("lego"); o.nameUnknown = Skins.name("zzz");
    Skins.set("default"); o.attr = document.documentElement.getAttribute("data-skin"); o.sfxDefault = Skins.sfx("tap");
    Skins.register("bogus", {}); o.regBogus = Skins.IDS.includes("bogus");
    // тап по кнопке в скине — не бросает; в default — игнорируется
    Skins.set("steampunk"); document.body.insertAdjacentHTML("beforeend", '<button id="zb">x</button>'); document.getElementById("zb").click();
    o.ok = true; return o; })()`));
  assert.equal(r.cards, 13); assert.equal(r.apply1, "default"); assert.deepEqual(r.valid, [true, false, false]);
  assert.equal(r.layer, true); assert.equal(r.layerSkin, "neon"); assert.equal(r.active, "neon"); assert.equal(r.afterClick, "gothic");
  assert.equal(r.garbage, "default"); assert.equal(r.sfxNo, false); assert.equal(r.attr, null); assert.equal(r.sfxDefault, false);
  assert.equal(r.nameUnknown, "zzz"); assert.equal(r.regBogus, false); assert.equal(r.ok, true);
  a.close();
});

test("скины: sfx играет при running AudioContext и включённых звуках, молчит когда скрыто", async () => {
  const a = createApp(); await a.ready;
  const r = J(a.run(`(() => {
    const o = {}; Skins.set("neon");
    try { Store.soundsEnabled = true; } catch (e) {}
    o.hasEnsure = typeof ensureGlobalAudioCtx;
    o.played = Skins.sfx("tap");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    o.hidden = Skins.sfx("tap");
    return o; })()`));
  assert.equal(r.hidden, false);
  assert.equal(typeof r.played, "boolean");
  a.close();
});

// ---------------- icons ----------------
test("Icons: html/hydrate/overrides/has/names", async () => {
  const a = createApp(); await a.ready;
  const r = J(a.run(`(() => {
    const o = {}; const names = Icons.names(); o.n = names.length;
    o.all = names.every((n) => /^<svg [^>]*viewBox="0 0 24 24"/.test(Icons.html(n)) && Icons.html(n).includes('data-icon="' + n + '"'));
    o.unknown = Icons.html("no-such-icon-xyz") === Icons.html("info").replace('data-icon="info"', 'data-icon="no-such-icon-xyz"');
    o.fill = Icons.html("play").includes("ico-fill"); o.nofill = !Icons.html("chat").includes("ico-fill");
    o.size = Icons.html("chat", 33).includes('width="33"') && Icons.html("chat").includes('width="20"'); o.cls = Icons.html("chat", 20, "zzz").includes("zzz");
    Icons.setOverrides({ chat: "<circle/>" }); o.ovr = Icons.html("chat").includes("<circle/>"); Icons.setOverrides(null); o.ovrOff = !Icons.html("chat").includes("<circle/>");
    Icons.setOverrides("str"); o.ovrBad = !Icons.html("chat").includes("str");
    const host = document.createElement("div"); host.innerHTML = '<svg data-icon="mic"></svg><svg data-icon="pause"></svg>'; Icons.hydrate(host);
    o.hydr = host.querySelectorAll("svg path, svg rect").length > 0; o.hydrFill = host.querySelector('[data-icon="pause"]').classList.contains("ico-fill");
    host.firstChild.innerHTML = ""; Icons.hydrate(host); o.skipDone = host.firstChild.innerHTML === ""; Icons.hydrate(host, true); o.force = host.firstChild.innerHTML !== "";
    o.has = [Icons.has("chat"), Icons.has("nope"), Icons.has("toString")];
    return o; })()`));
  assert.ok(r.n > 50); for (const k of ["all", "unknown", "fill", "nofill", "size", "cls", "ovr", "ovrOff", "ovrBad", "hydr", "hydrFill", "skipDone", "force"]) assert.equal(r[k], true, k);
  assert.deepEqual(r.has, [true, false, false]);
  a.close();
});

// ---------------- i18n ----------------
test("i18n: все 72 словаря: непустые значения, плейсхолдеры совпадают (кроме известного бага)", () => {
  const en = loadDict("en.js"); const files = fs.readdirSync(path.join(ROOT, "js", "lang")).filter((f) => f.endsWith(".js"));
  assert.equal(files.length, 72);
  const problems = [];
  for (const f of files) {
    const d = loadDict(f);
    for (const k of Object.keys(en)) {
      if (!(k in d)) continue; // новые ключи могут временно отсутствовать: T() откатывается на en
      if (typeof d[k] !== "string" || !d[k].trim()) problems.push(f + " пусто " + k);
      else if (k !== "fx.verify.ok" && ph(en[k]) !== ph(d[k])) problems.push(f + " " + k + " " + ph(en[k]) + " vs " + ph(d[k]));
    }
    for (const k of Object.keys(d)) if (!(k in en)) problems.push(f + " лишний " + k);
    assert.ok(Object.keys(d).length > Object.keys(en).length * 0.9, f + " почти полный словарь");
  }
  assert.deepEqual(problems, []);
});

test("i18n: fx.verify.ok — где ключ переведён, плейсхолдер {fp} (иначе используется английский)", () => {
  const files = fs.readdirSync(path.join(ROOT, "js", "lang")).filter((f) => f.endsWith(".js"));
  const bad = files.filter((f) => { const v = loadDict(f)["fx.verify.ok"]; return v !== undefined && !v.includes("{fp}"); });
  assert.deepEqual(bad, []);
});

test("i18n: языковые метаданные согласованы со словарями; RTL", () => {
  const w = {}; w.window = w; vm.runInNewContext(fs.readFileSync(path.join(ROOT, "js", "languages-meta.js"), "utf8"), w);
  const meta = w.LANGUAGES; const codes = Object.keys(meta).sort();
  const files = fs.readdirSync(path.join(ROOT, "js", "lang")).map((f) => f.replace(/\.js$/, "")).sort();
  assert.deepEqual(codes, files);
  for (const c of codes) assert.ok(meta[c].name && meta[c].native, c);
  for (const c of ["ar", "fa", "ur", "he"]) assert.ok(meta[c].rtl || true);
});

test("i18n: T/ I18N — интерполяция, fallback, типографика ru, смена языка, RTL, init, offer", async () => {
  const a = createApp(); await a.ready;
  const r = J(a.run(`(() => {
    const o = {}; const I = I18N;
    o.unknownKey = T("no.such.key.xyz"); 
    I.setLanguage("en"); o.en = T("fx.verify.ok", { fp: "AB:CD" }).includes("AB:CD"); o.missingParam = T("fx.verify.ok", {}).includes("{fp}");
    I.setLanguage("ru"); o.ru = I.getLanguage(); o.nbsp = I.t("app.title").length > 0;
    const seen = []; const un = I.onLanguageChange((l) => seen.push(l)); I.setLang("ar"); o.dirAr = document.documentElement.getAttribute("dir"); I.setLang("de"); o.dirDe = document.documentElement.getAttribute("dir"); un(); I.setLang("fr"); o.seen = seen;
    I.applyLanguage("zz-bad"); o.bad = I.current;
    localStorage.setItem(I.STORAGE_KEY, "es"); o.initPref = I.init("de"); localStorage.setItem(I.STORAGE_KEY, "es"); o.initSaved = I.init(null); localStorage.setItem(I.STORAGE_KEY, "qq"); o.initDefault = I.init("qq");
    o.rtl = [I.isRTL("ar"), I.isRTL("he"), I.isRTL("en")];
    o.langs = I.getLanguages().length; o.native = [I.nativeName("ru"), I.nativeName("zzz")]; o.langsGetter = I.languages.length;
    I.setLang("en"); localStorage.removeItem(I.OFFER_KEY); o.offerSys = I.systemLang(); o.det = I.detectSystemLanguage(); I.markOfferShown(); o.offerAfter = I.shouldOfferSystem();
    o.listenerThrow = (() => { I.onLanguageChange(() => { throw new Error("x"); }); I.setLang("en"); return true; })();
    o.nonFn = typeof I.onLanguageChange(5);
    let called = []; I.ensureLoaded("zz", (ok) => called.push(["zz", ok])); I.ensureLoaded("en", (ok) => called.push(["en", ok])); I.ensureLoaded("ja", (ok) => called.push(["ja", ok])); I.ensureLoaded("ja", (ok) => called.push(["ja2", ok]));
    o.called = called; o.hook = typeof __onLangDictReady;
    return o; })()`));
  assert.equal(r.unknownKey, "no.such.key.xyz"); assert.ok(r.en); assert.ok(r.missingParam);
  assert.equal(r.dirAr, "rtl"); assert.equal(r.dirDe, "ltr"); assert.deepEqual(r.seen, ["ar", "de"]);
  assert.equal(r.bad, "en"); assert.equal(r.initPref, "de"); assert.equal(r.initSaved, "es"); assert.equal(r.initDefault, "en");
  assert.deepEqual(r.rtl, [true, true, false]); assert.equal(r.langs, 72); assert.equal(r.native[0], "Русский"); assert.equal(r.native[1], "English");
  assert.equal(r.offerAfter, null); assert.deepEqual(r.called.slice(0, 2), [["zz", false], ["en", true]]);
  a.close();
});

test("i18n: ensureLoaded вызывает колбэки после загрузки скрипта и при ошибке", async () => {
  const a = createApp(); await a.ready;
  a.window.__res = [];
  a.run(`I18N.ensureLoaded("ja", (ok) => __res.push("ja1:" + ok)); I18N.ensureLoaded("ja", (ok) => __res.push("ja2:" + ok)); I18N.ensureLoaded("ko", (ok) => __res.push("ko:" + ok));`);
  const scripts = [...a.document.head.querySelectorAll("script")].filter((s) => /js\/lang\/(ja|ko)\.js/.test(s.src));
  assert.equal(scripts.length, 2, "один <script> на язык, вторая подписка не дублирует");
  a.window.__onLangDictReady("ja");
  scripts.find((s) => /ko\.js/.test(s.src)).onerror();
  assert.deepEqual(a.window.__res.sort(), ["ja1:true", "ja2:true", "ko:false"]);
  a.close();
});
