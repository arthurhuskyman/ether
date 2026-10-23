// Руны: на карточке контакта и в сверке — ОБЩАЯ руна пары (из двух ключей, порядок не важен). Раньше каждый видел руну ключа ДРУГОГО
// человека → «они разные». Теперь у обоих одно и то же + эмодзи/слова/QR и кнопки «совпадает / не совпадает».
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("fxPairKeyString симметрична; общая руна/хэш/эмодзи/слова одинаковы с обеих сторон и зависят от пары", async () => {
  const a = await bootApp({ platform: "desktop" });
  const r = await a.run(`(async () => {
    const A = "keyAAAA", B = "keyBBBB", C = "keyCCCC";
    const ab = fxPairKeyString(A, B), ba = fxPairKeyString(B, A), ac = fxPairKeyString(A, C);
    const hab = await fxSigilPairHex(ab), hba = await fxSigilPairHex(ba), hac = await fxSigilPairHex(ac);
    return { sameKey: ab === ba, sameHex: hab === hba, svgSame: sigilLongSvg(hab, 100) === sigilLongSvg(hba, 100), small: sigilSvg(ab, 44) === sigilSvg(ba, 44),
      diffPair: hab !== hac, emoji: fxSigilPairEmoji(hab, 6).join("") === fxSigilPairEmoji(hba, 6).join(""), emojiLen: fxSigilPairEmoji(hab, 6).length,
      words: fxSigilPairWords(hab, 4).join(" ") === fxSigilPairWords(hba, 4).join(" "), wordsLen: fxSigilPairWords(hab, 4).length,
      // личные руны разные — так и задумано, поэтому сравнивать их нельзя
      personalDiffer: sigilSvg(A, 44) !== sigilSvg(B, 44), hexLen: hab.length };
  })()`);
  assert.deepEqual({ ...r }, { sameKey: true, sameHex: true, svgSame: true, small: true, diffPair: true, emoji: true, emojiLen: 6, words: true, wordsLen: 4, personalDiffer: true, hexLen: 64 });
  a.close();
});

test("карточка контакта: миниатюра — общая руна пары; у Алисы и у Боба разметка идентична", async () => {
  const keyOf = (x, y) => ({ kty: "EC", crv: "P-256", x, y });
  const html = [];
  for (const [mine, theirs] of [[keyOf("AAA", "BBB"), keyOf("CCC", "DDD")], [keyOf("CCC", "DDD"), keyOf("AAA", "BBB")]]) {
    const a = await bootApp({ platform: "desktop" });
    a.window.__mine = mine; a.window.__theirs = theirs;
    a.run(`Store.myPublicKeyJwk = window.__mine; FX.set && FX.set("sigil", true); ensureContactEntry("peer", "Peer"); state.contacts.get("peer").publicKey = window.__theirs; state.contacts.get("peer").managed = true; state.tab = "connect"; state.contactCardId = "peer"; renderTab(); fxDecorateContactCard();`);
    const sg = a.document.querySelector("#fx-sigil");
    assert.ok(sg && sg.querySelector("svg"), "руна показана на карточке");
    html.push(sg.innerHTML);
    const probe = a.document.createElement("div"); probe.innerHTML = a.run(`sigilSvg(fxPairKeyString(fxMyKeyString(), fxKeyString(state.contacts.get("peer"))), 44)`);
    assert.equal(sg.innerHTML, probe.innerHTML);
    a.close();
  }
  assert.equal(html[0], html[1], "оба собеседника видят одну и ту же руну на карточке друг друга");
});

test("шторка сверки: общая руна, эмодзи, слова, отпечаток, обе личные руны с подписями, кнопки; у обоих сторон тексты совпадают", async () => {
  const texts = [];
  for (const [my, their] of [["keyAAAA", "keyBBBB"], ["keyBBBB", "keyAAAA"]]) {
    const a = await bootApp({ platform: "desktop" });
    a.run(`ensureContactEntry("peer", "Peer");`);
    a.run(`fxOpenSigilSheet({ contactId: "peer", name: "Peer", keyStr: ${JSON.stringify(their)}, myKey: ${JSON.stringify(my)}, theirKey: ${JSON.stringify(their)} })`);
    await tick(60);
    const sh = a.document.querySelector("#fx-sigil-sheet");
    assert.ok(sh.querySelector(".fx-sigil-match") && sh.querySelector(".fx-sigil-differ"), "кнопки «совпадает / не совпадает»");
    assert.ok(sh.querySelector(".fx-sigil-scan") && sh.querySelector(".fx-sigil-copy") && sh.querySelector(".fx-sigil-share"));
    assert.ok(sh.querySelector("#fx-sigil-long svg"), "большая общая руна");
    assert.equal([...sh.querySelector("#fx-sigil-emoji").textContent.trim().split(/\s+/)].length, 6);
    assert.equal(sh.querySelector("#fx-sigil-words").textContent.split("·").length, 4);
    const caps = [...sh.querySelectorAll(".fx-sigil-own figcaption")].map((e) => e.textContent);
    assert.equal(caps.length, 2); assert.match(caps[0], /Your/i); assert.match(caps[1], /Their/i);
    assert.match(sh.querySelector(".fx-sigil-how").textContent, /Peer/);
    texts.push([sh.querySelector("#fx-sigil-long").innerHTML, sh.querySelector("#fx-sigil-emoji").textContent, sh.querySelector("#fx-sigil-words").textContent, sh.querySelector("#fx-sigil-long-fp").textContent]);
    a.close();
  }
  assert.deepEqual(texts[0], texts[1], "у обоих собеседников общая руна, эмодзи, слова и отпечаток совпадают");
});

test("шторка: «совпадает» отмечает контакт проверенным, «не совпадает» снимает отметку и объясняет, что делать", async () => {
  const a = await bootApp({ platform: "desktop" });
  a.run(`ensureContactEntry("peer", "Peer"); window.__v = []; setContactVerified = (id, on) => window.__v.push([id, on]);`);
  a.run(`fxOpenSigilSheet({ contactId: "peer", name: "Peer", keyStr: "kB", myKey: "kA", theirKey: "kB" })`);
  await tick(60);
  const sh = a.document.querySelector("#fx-sigil-sheet");
  sh.querySelector(".fx-sigil-match").click();
  assert.equal(JSON.stringify(a.window.__v), JSON.stringify([["peer", true]]));
  assert.match(sh.querySelector("#fx-sigil-result").textContent, /Peer/);
  sh.querySelector(".fx-sigil-differ").click();
  assert.equal(JSON.stringify(a.window.__v[1]), JSON.stringify(["peer", false]));
  assert.match(sh.querySelector("#fx-sigil-result").textContent, /do not trust|intercept/i);
  assert.ok(sh.querySelector("#fx-sigil-result").classList.contains("is-bad"));
  a.close();
});

test("QR общей руны: совпадающий код отмечает проверенным, чужой — предупреждает", async () => {
  const a = await bootApp({ platform: "desktop" });
  a.run(`ensureContactEntry("peer", "Peer"); window.__v = []; setContactVerified = (id, on) => window.__v.push([id, on]);`);
  a.run(`fxOpenSigilSheet({ contactId: "peer", name: "Peer", keyStr: "kB", myKey: "kA", theirKey: "kB" })`);
  await tick(60);
  const hex = await a.run(`fxSigilPairHex(fxPairKeyString("kA", "kB"))`);
  assert.equal(a.run(`fxOnSigilQrScanned("ether://sigil?p=${"0".repeat(32)}")`), true);
  assert.equal(JSON.stringify(a.window.__v), JSON.stringify([]));
  await tick(5);
  assert.ok(a.document.querySelector("#fx-sigil-result").classList.contains("is-bad"));
  assert.equal(a.run(`fxOnSigilQrScanned("ether://sigil?p=${hex.slice(0, 32)}")`), true);
  assert.equal(JSON.stringify(a.window.__v), JSON.stringify([["peer", true]]));
  a.close();
});

test("личная руна («моя») и контакт без ключа работают по-старому; в en и ru есть все строки", async () => {
  const a = await bootApp({ platform: "desktop" });
  a.run(`fxOpenSigilSheet({ mine: true, keyStr: "k1", name: "" })`); await tick(40);
  assert.ok(a.document.querySelector("#fx-sigil-sheet .fx-sigil-quick"));
  assert.ok(!a.document.querySelector("#fx-sigil-sheet .fx-sigil-match"));
  a.document.querySelector(".fx-sigil-close").click();
  a.run(`fxOpenSigilSheet({ mine: false, noKey: true, keyStr: "id", name: "X", myKey: "kA", theirKey: "id" })`); await tick(40);
  assert.ok(!a.document.querySelector("#fx-sigil-sheet .fx-sigil-match"), "нет ключа — сверять нечего");
  const keys = ["call.soundBlocked", "call.soundProblem", "call.soundReset", "call.micFailed", "call.micSuspended", "call.peerMicSuspended", "sigil.pair.hint", "sigil.mine.note", "sigil.pair.title", "sigil.pair.intro", "sigil.pair.yours", "sigil.pair.theirs", "sigil.pair.ownNote", "sigil.pair.copy", "sigil.pair.copied", "sigil.pair.scan", "sigil.pair.differ", "sigil.pair.match", "sigil.pair.matchDone", "sigil.pair.differHelp", "sigil.pair.shareText", "sigil.wordlist", "sigil.pair.emoji"];
  for (const lang of ["en", "ru"]) for (const k of keys) assert.ok(a.window.__LANG_DICTS[lang][k], lang + " " + k);
  for (const lang of ["en", "ru"]) assert.equal(a.window.__LANG_DICTS[lang]["sigil.wordlist"].split(",").length, 64);
  a.close();
});
