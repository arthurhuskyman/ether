// V.80 fuzz (детерминированные seed): SignalingCodec.decode, разбор ссылок/приглашений/хэшей, CryptoHelper.decryptJson.
// Требование: ни необработанных исключений (только Error из разрешённого набора), ни зависаний, ни раздувания памяти.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), zlib = require("zlib");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const load = (f, name) => new Function(fs.readFileSync(path.join(__dirname, "..", f), "utf8") + "\nreturn " + name + ";")();
const SignalingCodec = load("js/signaling-codec.js", "SignalingCodec");
const CryptoHelper = load("js/crypto-helper.js", "CryptoHelper");
const { rng, junkString, withTimeout } = require("./fuzz-helpers");

test("SignalingCodec.decode: мусор, обрезки и мутации валидного кода -> только Error, без зависаний", async () => {
  const r = rng(80001);
  const valid = await SignalingCodec.encode({ t: "offer", n: "Алиса", d: { type: "offer", sdp: "v=0\r\n" + "a=candidate:1 1 udp 1 1.2.3.4 5 typ host\r\n".repeat(30) } });
  const inputs = ["", "1", "10", "11", "1x", "2" + valid.slice(1), "ether://", "ether://1", "ether://10{}", valid.slice(0, 2), valid.slice(0, valid.length >> 1), valid + "!!!", " \n" + valid + "\t ", "1" + "0" + "A".repeat(8190)];
  for (let i = 0; i < 300; i++) inputs.push(junkString(r, 1 + r.int(400)));
  for (let i = 0; i < 300; i++) { const a = valid.split(""); const n = 1 + r.int(4); for (let k = 0; k < n; k++) a[r.int(a.length)] = junkString(r, 1)[0] || "A"; inputs.push(a.join("")); }
  for (let i = 0; i < 100; i++) inputs.push(valid.slice(0, r.int(valid.length)));
  inputs.push(null, undefined, 5, {}, [], "a".repeat(9000));
  let ok = 0, rejected = 0;
  for (const code of inputs) {
    try { const v = await withTimeout(SignalingCodec.decode(code), 5000, "decode завис"); ok++; assert.ok(v === null || ["object", "number", "string", "boolean"].includes(typeof v)); }
    catch (e) { rejected++; assert.ok(e instanceof Error, "бросили не Error: " + String(e)); assert.ok(!/завис/.test(e.message), e.message); }
  }
  assert.ok(rejected > 300 && ok >= 1, `ok=${ok} rejected=${rejected}`);
  const back = await SignalingCodec.decode(valid); assert.equal(back.t, "offer");
});

test("SignalingCodec.decode: gzip-бомба под лимит длины кода отклоняется (потолок 256 КБ распакованного)", async () => {
  const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const bomb = "11" + b64u(zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x20), { level: 9 })); // ≈5 КБ сжатых -> 5 МБ
  assert.ok(bomb.length <= 8192, "бомба должна проходить проверку длины, длина " + bomb.length);
  await assert.rejects(() => withTimeout(SignalingCodec.decode(bomb), 8000, "decode завис"), /badInviteCode/);
  const ok = "11" + b64u(zlib.gzipSync(Buffer.from(JSON.stringify({ t: "offer", d: { sdp: "x".repeat(20000) } }))));
  assert.equal((await SignalingCodec.decode(ok)).t, "offer"); // нормальный код проходит
});

test("CryptoHelper.decryptJson: мусорные/мутированные конверты отклоняются, валидный проходит", async () => {
  const r = rng(80002);
  const kp = await CryptoHelper.generateKeyPair(), kp2 = await CryptoHelper.generateKeyPair();
  const key = await CryptoHelper.deriveSharedKey(kp.privateKeyJwk, kp2.publicKeyJwk);
  const aad = CryptoHelper.envAad("a", "b");
  const good = await CryptoHelper.encryptJson(key, { text: "секрет" }, aad);
  assert.deepEqual(await CryptoHelper.decryptJson(key, good, aad), { text: "секрет" });
  const mutB64 = (s) => { const b = Buffer.from(s, "base64"); if (!b.length) return "AA=="; b[r.int(b.length)] ^= 1 << r.int(8); return b.toString("base64"); };
  const cases = [];
  for (let i = 0; i < 60; i++) cases.push([{ iv: mutB64(good.iv), ct: good.ct, v: 2 }, aad], [{ iv: good.iv, ct: mutB64(good.ct), v: 2 }, aad]);
  for (let i = 0; i < 30; i++) cases.push([{ iv: junkString(r, 16), ct: junkString(r, 40), v: [1, 2, undefined][r.int(3)] }, aad]);
  cases.push([{ iv: good.iv, ct: good.ct.slice(0, 10), v: 2 }, aad], [{ iv: good.iv, ct: "", v: 2 }, aad], [{ iv: "", ct: good.ct, v: 2 }, aad], [{ iv: good.iv, ct: good.ct, v: 2 }, undefined], [{ iv: good.iv, ct: good.ct, v: 99 }, aad],
    [{ iv: good.iv, ct: good.ct, v: 2 }, CryptoHelper.envAad("b", "a")], [{ iv: 5, ct: {}, v: 2 }, aad], [{ iv: null, ct: null }, aad]);
  for (const [env, a] of cases) {
    const p = Promise.resolve().then(() => CryptoHelper.decryptJson(key, env, a));
    await withTimeout(p, 3000, "decrypt завис").then((v) => assert.fail("принят испорченный конверт: " + JSON.stringify(v)), (e) => assert.ok(!/завис/.test(String(e && e.message)), "завис"));
  }
  await assert.rejects(() => CryptoHelper.decryptJson(key, null, aad));
  await assert.rejects(() => CryptoHelper.decryptJson(key, undefined, aad));
});

test("парсеры ссылок/хэшей: LinkCall.parseHash/parseAnswerHash, extractCodeFromLocation на мусоре не бросают", () => {
  const r = rng(80003);
  const src = fs.readFileSync(path.join(__dirname, "..", "js/signaling-client.js"), "utf8");
  const LinkCall = new Function("window", "document", "crypto", src + "\nreturn typeof LinkCall!=='undefined'?LinkCall:null;")({}, {}, globalThis.crypto);
  if (LinkCall) {
    const room = "A".repeat(22);
    const pool = ["call=", "#call=", "#answer=", "&from=", "%", "%E0%A4%A", ".", room, "x".repeat(5000), "\u0000", "🙂", "#answer=" + "a".repeat(81) + "&from=b", "#answer=x%ZZ&from=y"];
    for (let i = 0; i < 500; i++) {
      let s = ""; const n = 1 + r.int(6); for (let k = 0; k < n; k++) s += r.bool() ? pool[r.int(pool.length)] : junkString(r, r.int(12));
      for (const fn of [LinkCall.parseHash, LinkCall.parseAnswerHash]) if (fn) { const v = fn(s); assert.ok(v === null || typeof v === "object"); }
    }
    for (const v of [null, undefined, 0, {}, []]) { assert.doesNotThrow(() => LinkCall.parseHash(v)); }
  }
  for (const h of ["", "#", "#x", "#1" + "A".repeat(100), "?code=%E0", "#c=%", "#/../..", "#\u0000"]) {
    const loc = { hash: h, search: h, href: "http://x/" + h, origin: "http://x", pathname: "/" };
    assert.doesNotThrow(() => { globalThis.location = loc; SignalingCodec.extractCodeFromLocation(); });
  }
  delete globalThis.location;
});
