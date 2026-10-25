// multi-server resilience: js/serverlist.js — адреса, слияние, подсказки srv, подпись ECDSA P-256, пробы, автомат фейловера (часы и fetch подменены).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const SL = require("../js/serverlist.js");
const subtle = crypto.webcrypto.subtle;

test("normalizeUrl: wss/https принимаются, ws/http только loopback, мусор отклоняется", () => {
  assert.equal(SL.normalizeUrl("wss://Example.COM/"), "wss://example.com");
  assert.equal(SL.normalizeUrl("https://relay.example.org:8443/ws/"), "wss://relay.example.org:8443/ws");
  assert.equal(SL.normalizeUrl("relay.example.org"), "wss://relay.example.org");
  assert.equal(SL.normalizeUrl("ws://localhost:8787"), "ws://localhost:8787");
  assert.equal(SL.normalizeUrl("http://127.0.0.1:1"), "ws://127.0.0.1:1");
  for (const bad of ["", "ws://example.com", "http://example.com", "ftp://x.example.com", "wss://user:pw@example.com", "wss://nodot", "javascript:alert(1)", "wss://exa mple.com", "wss://" + "a".repeat(250) + ".com", null]) assert.equal(SL.normalizeUrl(bad), "", String(bad));
  assert.equal(SL.httpBase("wss://a.example.com"), "https://a.example.com");
  assert.equal(SL.httpBase("ws://localhost:5"), "http://localhost:5");
  assert.ok(SL.sameServer("wss://A.example.com/", "https://a.example.com"));
});

test("merge: порядок custom > signed > default, дубликаты и выключенные встроенные отбрасываются, legacy принимается как есть", () => {
  const m = SL.merge({ legacy: { url: "ws://192.168.1.5:8787" }, user: [{ url: "wss://u1.example.com", label: "U1" }, { url: "bad" }], signed: [{ url: "wss://s1.example.com" }, { url: "wss://u1.example.com" }], defaults: [{ url: "wss://d1.example.com" }, { url: "wss://d2.example.com" }], disabled: ["wss://d2.example.com", "wss://s1.example.com"] });
  assert.deepEqual(m.map((e) => e.url + ":" + e.src), ["ws://192.168.1.5:8787:custom", "wss://u1.example.com:custom", "wss://d1.example.com:default"]);
  assert.equal(m[1].label, "U1");
  assert.equal(SL.merge({ user: Array.from({ length: 30 }, (_, i) => ({ url: "wss://h" + i + ".example.com" })) }).length, SL.MAX_SERVERS);
  assert.deepEqual(SL.configDefaults({ servers: [{ url: "wss://x.example.com", label: "X" }, { url: "oops" }] }).map((e) => e.url), ["wss://x.example.com"]);
  assert.deepEqual(SL.configDefaults(undefined), []);
});

test("хранилище: saveUser/loadUser чистят данные и переживают мусор", () => {
  const mem = new Map(); const st = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(SL.loadUser(st), []);
  SL.saveUser(st, [{ url: "wss://a.example.com", label: "<b>A</b>" }, { url: "nope" }]);
  const got = SL.loadUser(st);
  assert.equal(got.length, 1); assert.equal(got[0].label, "bA/b"); // < > вырезаны
  mem.set(SL.KEYS.servers, "{not json"); assert.deepEqual(SL.loadUser(st), []);
});

test("подсказки srv: до 3, только https/wss-origin, round-trip, loopback только по allowLocal, одиночный встроенный не рекламируется", () => {
  const h = SL.normalizeHints(["wss://a.example.com/ws", "https://b.example.com:444", "wss://a.example.com", "http://evil.example.com", "wss://c.example.com", "wss://d.example.com"]);
  assert.deepEqual(h, ["wss://a.example.com", "wss://b.example.com:444", "wss://c.example.com"]);
  const wire = SL.encodeHints(h);
  assert.equal(wire, "https://a.example.com,https://b.example.com:444,https://c.example.com");
  assert.deepEqual(SL.decodeHints(wire), h);
  assert.deepEqual(SL.decodeHints("ws://localhost:9"), []);
  assert.deepEqual(SL.decodeHints("http://localhost:9", { allowLocal: true }), ["ws://localhost:9"]);
  assert.deepEqual(SL.decodeHints("x".repeat(800)), []);
  assert.deepEqual(SL.decodeHints(null), []);
  const defs = [{ url: "wss://def.example.com" }];
  assert.deepEqual(SL.ownHints([{ url: "wss://def.example.com" }], "wss://def.example.com", defs), []);
  assert.deepEqual(SL.ownHints([{ url: "wss://def.example.com" }, { url: "wss://mine.example.com" }], "wss://mine.example.com", defs), ["wss://mine.example.com", "wss://def.example.com"]);
});

async function keypair() {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { pub: await subtle.exportKey("jwk", kp.publicKey), priv: kp.privateKey, raw: Buffer.from(await subtle.exportKey("raw", kp.publicKey)), spki: Buffer.from(await subtle.exportKey("spki", kp.publicKey)) };
}
async function sign(kp, obj, field) {
  const o = SL.parseSigned(Object.assign({}, obj, { sig: "x" }), field);
  const sig = Buffer.from(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.priv, new TextEncoder().encode(SL.canonical(o, field)))).toString("base64url");
  return Object.assign({}, obj, { sig });
}
const LIST = { v: 1, ts: 1700000000, servers: [{ url: "wss://a.example.com", label: "A" }, { url: "wss://b.example.com:8443", label: "B" }] };

test("подпись: JWK, raw и SPKI ключи; подмена списка, чужой ключ, ts, плейсхолдер и мусор", async () => {
  const kp = await keypair(), other = await keypair();
  const signed = await sign(kp, LIST);
  for (const pub of [kp.pub, JSON.stringify(kp.pub), kp.raw.toString("base64"), kp.raw.toString("base64url"), kp.spki.toString("base64")]) {
    const r = await SL.verifySigned(signed, pub, { subtle }); assert.equal(r.ok, true, String(pub).slice(0, 20));
  }
  assert.equal((await SL.verifySigned(JSON.stringify(signed), kp.pub, { subtle })).ok, true, "строка JSON");
  const tampered = JSON.parse(JSON.stringify(signed)); tampered.servers[0].url = "wss://evil.example.com";
  assert.deepEqual(await SL.verifySigned(tampered, kp.pub, { subtle }).then((r) => [r.ok, r.reason]), [false, "bad-sig"]);
  const ts2 = Object.assign({}, signed, { ts: signed.ts + 1 }); assert.equal((await SL.verifySigned(ts2, kp.pub, { subtle })).reason, "bad-sig");
  assert.equal((await SL.verifySigned(signed, other.pub, { subtle })).reason, "bad-sig");
  for (const none of [null, undefined, "", "placeholder", { kty: "EC", x: "PLACEHOLDER", y: "PLACEHOLDER" }]) { const r = await SL.verifySigned(signed, none, { subtle }); assert.deepEqual([r.ok, r.reason], [false, "nokey"]); assert.ok(r.parsed, "список всё равно разобран и показывается"); }
  assert.equal((await SL.verifySigned({ v: 2, ts: 1, servers: [], sig: "x" }, kp.pub, { subtle })).reason, "bad-format");
  assert.equal((await SL.verifySigned({ v: 1, ts: 1, servers: [{ url: "javascript:1" }], sig: "x" }, kp.pub, { subtle })).reason, "bad-format");
  assert.equal((await SL.verifySigned("{broken", kp.pub, { subtle })).reason, "bad-format");
  assert.equal((await SL.verifySigned(Object.assign({}, signed, { sig: "AAAA" }), kp.pub, { subtle })).reason, "bad-sig");
});

test("подпись зеркал (field=mirrors) и совместимость с tools/sign-list.js", async () => {
  const kp = await keypair();
  const L = { v: 1, ts: 5, mirrors: [{ url: "https://m.example.com/ether/", label: "M" }] };
  const s = await sign(kp, L, "mirrors");
  assert.equal((await SL.verifySigned(s, kp.pub, { subtle, field: "mirrors" })).ok, true);
  assert.equal((await SL.verifySigned(s, kp.pub, { subtle })).reason, "bad-format", "это не список серверов");
  const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-"));
  const priv = await subtle.exportKey("jwk", kp.priv);
  fs.writeFileSync(path.join(dir, "priv.json"), JSON.stringify(priv)); fs.writeFileSync(path.join(dir, "pub.json"), JSON.stringify(kp.pub));
  fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify({ v: 1, ts: 0, servers: LIST.servers, sig: "" }));
  const tool = path.join(__dirname, "..", "tools", "sign-list.js");
  cp.execFileSync(process.execPath, [tool, path.join(dir, "servers.json"), "--private", path.join(dir, "priv.json")]);
  cp.execFileSync(process.execPath, [tool, path.join(dir, "servers.json"), "--verify", path.join(dir, "pub.json")]);
  const j = JSON.parse(fs.readFileSync(path.join(dir, "servers.json"), "utf8")); j.servers[0].label = "x"; fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify(j));
  assert.throws(() => cp.execFileSync(process.execPath, [tool, path.join(dir, "servers.json"), "--verify", path.join(dir, "pub.json")], { stdio: "pipe" }));
});

test("probe: /info с версией и RTT, откат на /health, таймаут/ошибка -> не жив; pickBest с гистерезисом", async () => {
  let t = 1000; const now = () => t;
  const mk = (map) => async (url) => { const k = Object.keys(map).find((x) => url.startsWith(x)); if (!k) throw new Error("down"); t += map[k].rtt; return map[k].res(url); };
  const ok = (body) => ({ ok: true, json: async () => body });
  const f = mk({ "https://a.example.com/info": { rtt: 40, res: () => ok({ version: "1.1.0", features: ["claim", 5] }) }, "https://b.example.com/health": { rtt: 90, res: () => ({ ok: true }) }, "https://c.example.com/info": { rtt: 5, res: () => ({ ok: false }) } });
  const a = await SL.probe("wss://a.example.com", { fetch: f, now }); assert.deepEqual([a.ok, a.rtt, a.version, a.features], [true, 40, "1.1.0", ["claim"]]);
  const b = await SL.probe("wss://b.example.com", { fetch: f, now }); assert.deepEqual([b.ok, b.path], [true, "/health"]);
  const c = await SL.probe("wss://c.example.com", { fetch: f, now }); assert.equal(c.ok, false);
  const all = await SL.probeAll(["wss://a.example.com", "wss://c.example.com"], { fetch: f, now }); assert.equal(all["wss://a.example.com"].ok, true);
  const R = { x: { ok: true, rtt: 100 }, y: { ok: true, rtt: 250 }, z: { ok: false, rtt: null } };
  assert.equal(SL.pickBest(R, "y"), "y", "250 < 3*100: остаёмся");
  assert.equal(SL.pickBest({ ...R, y: { ok: true, rtt: 400 } }, "y"), "x");
  assert.equal(SL.pickBest(R, "z"), "x"); assert.equal(SL.pickBest({ z: { ok: false } }, "z"), "");
});

function mkFo(urls, extra) {
  let t = 0; const mem = new Map(), sw = [];
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const list = { v: urls };
  const fo = SL.createFailover(Object.assign({ servers: () => list.v, now: () => t, storage, onSwitch: (to, from, why) => sw.push([from, to, why]) }, extra));
  return { fo, adv: (ms) => { t += ms; }, sw, mem, storage, list, now: () => t };
}
test("фейловер: 3 подряд сбоя -> переключение, успех обнуляет счётчик, запоминание последнего рабочего", () => {
  const { fo, sw, mem } = mkFo(["wss://a.example.com", "wss://b.example.com", "wss://c.example.com"]);
  assert.equal(fo.current(), "wss://a.example.com");
  fo.reportFailure("wss://a.example.com"); fo.reportFailure("wss://a.example.com");
  fo.reportSuccess("wss://a.example.com", 50); // сброс
  fo.reportFailure("wss://a.example.com"); fo.reportFailure("wss://a.example.com");
  assert.equal(fo.current(), "wss://a.example.com", "2 подряд — рано");
  const r = fo.reportFailure("wss://a.example.com");
  assert.deepEqual([r.switched, r.to, r.reason], [true, "wss://b.example.com", "failures"]);
  assert.deepEqual(sw, [["wss://a.example.com", "wss://b.example.com", "failures"]]);
  fo.reportSuccess("wss://b.example.com", 80);
  assert.equal(mem.get(SL.KEYS.lastGood), "wss://b.example.com");
  assert.equal(fo.reportFailure("wss://a.example.com").switched, false, "сбой не-текущего сервера не переключает");
  const again = mkFo(["wss://a.example.com", "wss://b.example.com"]); again.mem.set(SL.KEYS.lastGood, "wss://b.example.com");
  assert.equal(SL.createFailover({ servers: () => ["wss://a.example.com", "wss://b.example.com"], storage: again.storage }).current(), "wss://b.example.com", "после перезапуска — последний рабочий");
  assert.equal(SL.createFailover({ servers: () => ["wss://a.example.com"], storage: again.storage }).current(), "wss://a.example.com", "последний рабочий исчез из списка");
});

test("фейловер: backoff растёт и снимается успехом; один сервер не переключается; все мертвы -> берём с ближайшим backoff", () => {
  const T = mkFo(["wss://a.example.com", "wss://b.example.com"]);
  const A = "wss://a.example.com", B = "wss://b.example.com";
  for (let i = 0; i < 3; i++) T.fo.reportFailure(A);
  assert.equal(T.fo.current(), B);
  const b1 = T.fo.stats(A).backoffUntil - T.now(); assert.equal(b1, 5000);
  for (let i = 0; i < 3; i++) T.fo.reportFailure(B);
  assert.equal(T.fo.current(), A, "A в backoff, но B ещё хуже: возвращаемся на A (ближайший срок)");
  T.adv(6000); for (let i = 0; i < 3; i++) T.fo.reportFailure(A);
  const second = T.fo.stats(A).backoffUntil - T.now(); assert.equal(second, 10000, "второй эпизод — вдвое дольше");
  T.fo.reportSuccess(A, 30); assert.equal(T.fo.stats(A).backoffUntil, 0);
  const one = mkFo([A]); for (let i = 0; i < 9; i++) assert.equal(one.fo.reportFailure(A).switched, false); assert.equal(one.fo.current(), A);
  const mx = mkFo([A, B], { backoffMax: 12000 }); for (let k = 0; k < 6; k++) { mx.fo.reportFailure(mx.fo.current()); mx.fo.reportFailure(mx.fo.current()); mx.fo.reportFailure(mx.fo.current()); mx.adv(100000); }
  assert.ok(mx.fo.stats(A).backoffUntil - mx.now() <= 12000);
});

test("фейловер по пробам: RTT >3x лучшего (и выше порога) -> slow-переключение; возврат на приоритетный через 5 минут; мёртвый текущий -> сбой", () => {
  const A = "wss://a.example.com", B = "wss://b.example.com", C = "wss://c.example.com";
  const T = mkFo([A, B, C]);
  let r = T.fo.reportProbes({ [A]: { ok: true, rtt: 250 }, [B]: { ok: true, rtt: 100 } });
  assert.equal(r.switched, false, "250 < 3*100");
  r = T.fo.reportProbes({ [A]: { ok: true, rtt: 700 }, [B]: { ok: true, rtt: 100 }, [C]: { ok: true, rtt: 300 } });
  assert.deepEqual([r.switched, r.to, r.reason], [true, B, "slow"]);
  assert.equal(T.fo.reportProbes({ [A]: { ok: true, rtt: 100 }, [B]: { ok: true, rtt: 120 } }).switched, false, "до 5 минут не возвращаемся");
  T.adv(301000);
  r = T.fo.reportProbes({ [A]: { ok: true, rtt: 100 }, [B]: { ok: true, rtt: 120 } });
  assert.deepEqual([r.switched, r.to, r.reason], [true, A, "failback"]);
  const F = mkFo([A, B]); F.fo.reportProbes({ [A]: { ok: true, rtt: 50 }, [B]: { ok: true, rtt: 50 } });
  F.fo.reportProbes({ [A]: { ok: false }, [B]: { ok: true, rtt: 50 } }); F.fo.reportProbes({ [A]: { ok: false }, [B]: { ok: true, rtt: 50 } });
  assert.equal(F.fo.current(), A); r = F.fo.reportProbes({ [A]: { ok: false }, [B]: { ok: true, rtt: 50 } });
  assert.deepEqual([r.switched, r.to], [true, B], "3 неудачные пробы текущего подряд");
  const lowRtt = mkFo([A, B]); assert.equal(lowRtt.fo.reportProbes({ [A]: { ok: true, rtt: 150 }, [B]: { ok: true, rtt: 10 } }).switched, false, "ниже порога 200 мс не дёргаемся");
  const dyn = mkFo([A, B]); dyn.fo.force(B); assert.equal(dyn.fo.current(), B); dyn.list.v = [A]; assert.equal(dyn.fo.current(), A, "текущий пропал из списка");
});
