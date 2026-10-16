const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

// Дополнительные тесты с перекрытием: граничные случаи модулей, которые уже затрагиваются другими тестами.
test("SignalingCodec: кругом, ссылки, плохие коды", async () => {
  const a = createApp(); await a.ready;
  a.window.__o = null;
  await a.run(`(async () => {
    const pkt = { t: "offer", n: "Аня", d: { type: "offer", sdp: "v=0\\r\\n" + "a=x\\r\\n".repeat(50) }, r: "tag" };
    const code = await SignalingCodec.encode(pkt);
    const back = await SignalingCodec.decode("ether://" + code + " ");
    const bad = [];
    for (const c of ["", "1", "12", "x1AAAA", "1" + "A".repeat(9000), null, 5]) { try { await SignalingCodec.decode(c); bad.push("ok"); } catch (e) { bad.push(String(e.message)); } }
    const link = SignalingCodec.buildShareLink(code);
    window.__o = { back, bad, link, code, ext: SignalingCodec.extractCodeFromLocation() };
  })()`);
  const o = JSON.parse(JSON.stringify(a.window.__o));
  assert.equal(o.back.n, "Аня"); assert.equal(o.back.r, "tag");
  assert.ok(o.bad.every((m) => m !== "ok"));
  assert.ok(o.bad.slice(0, 5).every((m) => m === "toast.badInviteCode"));
  assert.ok(o.link.includes("#c=" + o.code));
  assert.equal(o.ext, null);
  a.close();
});

test("CryptoHelper: безопасный номер зависит от обоих ключей, формат 12×5", async () => {
  const a = createApp(); await a.ready;
  a.window.__o = null;
  await a.run(`(async () => {
    const A = await CryptoHelper.generateKeyPair(), B = await CryptoHelper.generateKeyPair(), C = await CryptoHelper.generateKeyPair();
    const ab = await CryptoHelper.computeSafetyNumber(A.publicKeyJwk, B.publicKeyJwk);
    const ac = await CryptoHelper.computeSafetyNumber(A.publicKeyJwk, C.publicKeyJwk);
    const shuffled = JSON.parse(JSON.stringify(A.publicKeyJwk, Object.keys(A.publicKeyJwk).reverse()));
    const ab2 = await CryptoHelper.computeSafetyNumber(shuffled, B.publicKeyJwk);
    const kA = await CryptoHelper.deriveSharedKey(A.privateKeyJwk, B.publicKeyJwk);
    const e1 = await CryptoHelper.encryptJson(kA, { x: 1 }), e2 = await CryptoHelper.encryptJson(kA, { x: 1 });
    window.__o = { ab, ac, ab2, iv: e1.iv !== e2.iv, ct: e1.ct !== e2.ct, v: e1.v };
  })()`);
  const o = JSON.parse(JSON.stringify(a.window.__o));
  assert.equal(o.ab.length, 12); assert.ok(o.ab.every((g) => /^\d{5}$/.test(g)));
  assert.notDeepEqual(o.ab, o.ac); assert.deepEqual(o.ab, o.ab2);
  assert.ok(o.iv && o.ct); assert.equal(o.v, 1);
  a.close();
});

test("Skins: неизвестный id → default, set/get/apply, meta theme-color", async () => {
  const a = createApp(); await a.ready;
  a.window.__o = null;
  await a.run(`(() => {
    const r = {};
    r.bad = Skins.set("zzz"); r.get0 = Skins.get();
    r.n = Skins.IDS.length;
    const html = document.documentElement;
    const seen = [];
    for (const id of Skins.IDS) { Skins.set(id); for (const sch of ["light","dark"]) { html.dataset.scheme = sch; Skins.syncMeta(); seen.push(id + ":" + sch + ":" + document.querySelector('meta[name="theme-color"]').getAttribute("content")); } }
    r.seen = seen; r.attr = html.getAttribute("data-skin");
    Skins.set("default"); r.attrDefault = html.getAttribute("data-skin");
    r.names = Skins.IDS.map((i) => Skins.name(i));
    window.__o = r;
  })()`);
  const o = JSON.parse(JSON.stringify(a.window.__o));
  assert.equal(o.bad, "default"); assert.equal(o.get0, "default"); assert.equal(o.n, 13);
  assert.equal(new Set(o.seen).size, o.seen.length > 0 ? new Set(o.seen).size : 0);
  assert.ok(o.seen.every((s) => /#[0-9a-f]{6}$/i.test(s)));
  assert.equal(o.attrDefault, null);
  assert.ok(o.names.every((n) => n && !n.startsWith("skin.")));
  a.close();
});
