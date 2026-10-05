const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

test("CryptoHelper: ECDH-обмен, шифрование/расшифровка, неверная версия, подмена", async () => {
  const a = createApp(); await a.ready;
  a.window.__out = null;
  await a.run(`(async () => {
    const A = await CryptoHelper.generateKeyPair(), B = await CryptoHelper.generateKeyPair();
    const kA = await CryptoHelper.deriveSharedKey(A.privateKeyJwk, B.publicKeyJwk);
    const kB = await CryptoHelper.deriveSharedKey(B.privateKeyJwk, A.publicKeyJwk);
    const env = await CryptoHelper.encryptJson(kA, { hello: "мир" });
    const dec = await CryptoHelper.decryptJson(kB, env);
    let tampered = false; try { await CryptoHelper.decryptJson(kB, { ...env, ct: env.ct.slice(0, -4) + "AAAA" }); } catch (e) { tampered = true; }
    let future = false; try { await CryptoHelper.decryptJson(kB, { ...env, v: 999 }); } catch (e) { future = String(e).includes("unsupported"); }
    const legacy = await CryptoHelper.decryptJson(kB, { iv: env.iv, ct: env.ct });
    const sn1 = await CryptoHelper.computeSafetyNumber(A.publicKeyJwk, B.publicKeyJwk);
    const sn2 = await CryptoHelper.computeSafetyNumber(B.publicKeyJwk, A.publicKeyJwk);
    window.__out = { dec, tampered, future, legacy, same: JSON.stringify(sn1) === JSON.stringify(sn2), sn: sn1 };
  })()`);
  const o = a.window.__out;
  assert.deepEqual(JSON.parse(JSON.stringify(o.dec)), { hello: "мир" });
  assert.equal(o.tampered, true);
  assert.equal(o.future, true);
  assert.deepEqual(JSON.parse(JSON.stringify(o.legacy)), { hello: "мир" });
  assert.equal(o.same, true);
  a.close();
});

test("SignalingCodec: encode/decode round-trip и ссылка-приглашение", async () => {
  const a = createApp(); await a.ready;
  const pkt = { t: "offer", d: { type: "offer", sdp: "v=0\r\n" + "a=x\r\n".repeat(50) }, n: "Алиса" };
  a.window.__pkt = pkt;
  const code = await a.run(`SignalingCodec.encode(window.__pkt)`);
  assert.equal(typeof code, "string");
  assert.match(code, /^[A-Za-z0-9_\-.:]+$/);
  const back = await a.run(`SignalingCodec.decode(${JSON.stringify(code)})`);
  assert.equal(JSON.parse(JSON.stringify(back)).n, "Алиса");
  assert.match(a.run(`SignalingCodec.buildShareLink(${JSON.stringify(code)})`), /http:\/\/localhost/);
  assert.equal(a.run(`SignalingCodec.extractCodeFromLocation()`) === null || typeof a.run(`SignalingCodec.extractCodeFromLocation()`) === "string", true);
  await assert.rejects(async () => a.run(`SignalingCodec.decode("!!!not-a-code!!!")`));
  a.close();
});

test("EtherFileLimits: размеры и бюджет чанков", () => {
  const a = createApp();
  assert.equal(a.run(`EtherFileLimits.isValidFileMetaSize(1)`), true);
  for (const bad of [0, -1, NaN, "9", null, a.run(`EtherFileLimits.MAX_FILE_SIZE + 1`)]) {
    assert.equal(a.run(`EtherFileLimits.isValidFileMetaSize(${bad === null ? "null" : JSON.stringify(bad)})`), false, String(bad));
  }
  assert.equal(a.run(`EtherFileLimits.chunkExceedsBudget(0, 10, 100)`), false);
  assert.equal(a.run(`EtherFileLimits.chunkExceedsBudget(1e9, 10, 100)`), true);
  a.close();
});

test("I18N: переключение языка и подстановка параметров", () => {
  const a = createApp();
  assert.equal(typeof a.run(`T("app.name")`), "string");
  assert.equal(a.run(`T("definitely.missing.key")`).length > 0, true);
  assert.match(a.run(`T("toast.groupTooBig", { max: 42 })`), /42/);
  a.close();
});
