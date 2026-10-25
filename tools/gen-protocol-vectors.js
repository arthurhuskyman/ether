#!/usr/bin/env node
// Генератор тестовых векторов протокола v1: node tools/gen-protocol-vectors.js [--check]
// Векторы получены ИЗ НАСТОЯЩЕГО кода (js/ratchet.js, js/groupkeys.js, js/channels.js, js/crypto-helper.js, js/bigfile.js): ГСЧ и генерация
// эфемерных ключей подменены детерминированными, поэтому запуск воспроизводим (кроме подписей ECDSA: они рандомизированы, в файл попадает
// одна конкретная подпись, а тест её ПРОВЕРЯЕТ). Проверяет файл tests/protocol-v1.test.js, который только расшифровывает/проверяет векторы.
"use strict";
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "tests", "vectors", "protocol-v1.json");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = nodeCrypto.webcrypto;
const subtle = globalThis.crypto.subtle;

// ---------- детерминированные источники случайности ----------
const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"); // порядок P-256
let rngLabel = "x", rngCtr = 0, keyCtr = 0;
function seedAll(label) { rngLabel = label; rngCtr = 0; keyCtr = 0; }
function rngBytes(n) {
  const out = Buffer.alloc(n); let o = 0;
  while (o < n) { const h = nodeCrypto.createHash("sha256").update("rng|" + rngLabel + "|" + (rngCtr++)).digest(); h.copy(out, o, 0, Math.min(32, n - o)); o += 32; }
  return out;
}
const b64u = (b) => Buffer.from(b).toString("base64url");
function detJwk(label) {
  let d = BigInt("0x" + nodeCrypto.createHash("sha256").update("key|" + label).digest("hex")) % (N - 1n) + 1n;
  const hex = d.toString(16).padStart(64, "0");
  const ecdh = nodeCrypto.createECDH("prime256v1"); ecdh.setPrivateKey(Buffer.from(hex, "hex"));
  const pub = ecdh.getPublicKey(); // 04 || x || y
  return { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(Buffer.from(hex, "hex")) };
}
Object.defineProperty(globalThis.crypto, "getRandomValues", { configurable: true, writable: true, value: (arr) => { arr.set(rngBytes(arr.length)); return arr; } });
const realImport = subtle.importKey.bind(subtle), realGenerate = subtle.generateKey.bind(subtle);
Object.defineProperty(subtle, "generateKey", { configurable: true, writable: true, value: async (alg, ext, usages) => {
  if (!alg || (alg.name !== "ECDH" && alg.name !== "ECDSA") || alg.namedCurve !== "P-256") return realGenerate(alg, ext, usages);
  const j = detJwk("gen|" + rngLabel + "|" + (keyCtr++)), priv = usages.filter((u) => u === "sign" || u === "deriveKey" || u === "deriveBits"), pubU = usages.filter((u) => u === "verify");
  return { privateKey: await realImport("jwk", j, alg, true, priv), publicKey: await realImport("jwk", { kty: j.kty, crv: j.crv, x: j.x, y: j.y }, alg, true, pubU) };
} });

const CHJ = new Function(fs.readFileSync(path.join(ROOT, "js", "crypto-helper.js"), "utf8") + "\nreturn CryptoHelper;")();
function fresh(file) { const p = path.join(ROOT, "js", file); delete require.cache[require.resolve(p)]; return require(p); }
require(path.join(ROOT, "js", "vendor", "ml-kem768.js"));

const pubOf = (j) => ({ kty: "EC", crv: "P-256", x: j.x, y: j.y });
const priv = (j) => ({ x: j.x, y: j.y, d: j.d });
const IDK = { alice: detJwk("identity|alice"), bob: detJwk("identity|bob") };
const IDS = { alice: "alice-id", bob: "bob-id" };

function device(who, preset) {
  const R = fresh("ratchet.js"), mem = { json: JSON.stringify(preset || {}) };
  R.setStore({ load: () => JSON.parse(mem.json), save: (o) => { mem.json = JSON.stringify(o); return true; } });
  return { who, R, mem };
}
const cx = (me, other, extra) => ({ contactId: IDS[other], myId: IDS[me], myPrivJwk: priv(IDK[me]), theirPubJwk: pubOf(IDK[other]), ...(extra || {}) });

// Упрощённый, явный конструктор сценария: send(from,to,id,plain,useBundle) и recv(id) в нужном порядке.
async function build(name, desc, o) {
  seedAll("sc|" + name);
  const A = device("alice", o.alicePreset), B = device("bob", o.bobPreset), dev = { alice: A, bob: B };
  const env = {}, meta = {}, log = [], snaps = {}, need = { alice: true, bob: true };
  const api = {
    async send(id, from, to, plain, useBundle) {
      const extra = useBundle ? { getBundle: async () => JSON.parse(JSON.stringify(o.bundle)) } : {};
      env[id] = await dev[from].R.encrypt(cx(from, to, extra), plain); meta[id] = { from, to, plain }; need[from] = true;
    },
    async recv(id) { const m = meta[id]; if (need[m.to]) { snaps[id] = JSON.parse(dev[m.to].mem.json); need[m.to] = false; } const got = await dev[m.to].R.decrypt(cx(m.to, m.from), JSON.parse(JSON.stringify(env[id]))); if (JSON.stringify(got) !== JSON.stringify(m.plain)) throw new Error("self-check " + id); log.push(id); },
  };
  await o.script(api);
  return { name, desc, bundle: o.bundle || null, order: log, messages: Object.fromEntries(Object.keys(env).map((id) => [id, { from: meta[id].from, to: meta[id].to, plain: meta[id].plain, envelope: env[id], ...(snaps[id] ? { stateBefore: snaps[id] } : {}) }])) };
}

async function main() {
  const vec = { version: 1, generator: "tools/gen-protocol-vectors.js", note: "ГСЧ детерминирован; подписи ECDSA рандомизированы (проверяются, не воспроизводятся).", identities: {}, ratchet: [] };
  for (const w of ["alice", "bob"]) vec.identities[w] = { id: IDS[w], publicKeyJwk: pubOf(IDK[w]), privateKeyJwk: priv(IDK[w]) };

  // --- prekey-пакет Боба (spk + opk, sig, sig2, ML-KEM) — настоящим кодом ---
  seedAll("bob-prekeys");
  const bobDev = device("bob");
  const up = await bobDev.R.prekeyUploadPayload(3, priv(IDK.bob));
  const bobPk = JSON.parse(bobDev.mem.json);
  vec.prekeys = { upload: up, bobStore: bobPk, spkVerify: { id: IDS.bob, publicKeyJwk: pubOf(IDK.bob) } };

  const fullBundle = (i) => ({ spk: up.spk, opk: up.opks[i] });
  const classicBundle = (i) => ({ spk: { id: up.spk.id, pub: up.spk.pub, sig: up.spk.sig }, opk: up.opks[i] });

  vec.ratchet.push(await build("identity-start-aad-v1", "Старт без prekey-пакета: SK от долговременных ключей, первый конверт AAD v1; ответ Боба и следующие — AAD v3 (подсказка cp в конверте)", {
    async script(a) {
      await a.send("a1", "alice", "bob", { kind: "chat", id: "m1", text: "привет" });
      await a.recv("a1");
      await a.send("b1", "bob", "alice", { kind: "chat", id: "m2", text: "ответ" });
      await a.recv("b1");
      await a.send("a2", "alice", "bob", { kind: "chat", id: "m3", text: "ещё" });
      await a.recv("a2");
    } }));

  vec.ratchet.push(await build("identity-start-aad-v2", "Старт без пакета, Алиса знает от Боба флаг ac=1 (db.ca): первый конверт AAD v2 (покрывает h.i и h.p)", {
    alicePreset: { ca: { [IDS.bob]: 1 } },
    async script(a) {
      await a.send("a1", "alice", "bob", { kind: "chat", id: "m1", text: "v2 aad" });
      await a.recv("a1");
      await a.send("b1", "bob", "alice", { kind: "chat", id: "m2", text: "ok" });
      await a.recv("b1");
    } }));

  vec.ratchet.push(await build("x3dh-classic", "Старт по prekey-пакету без расширения (spk+opk, подпись sig): 4DH, заголовок p={e,s,o}, AAD v1", {
    bobPreset: bobPk, bundle: classicBundle(0),
    async script(a) {
      await a.send("a1", "alice", "bob", { kind: "chat", id: "m1", text: "x3dh classic" }, true);
      await a.recv("a1");
      await a.send("b1", "bob", "alice", { kind: "chat", id: "m2", text: "reply" });
      await a.recv("b1");
    } }));

  vec.ratchet.push(await build("x3dh-v3-pq-reorder", "Старт по подписанному пакету с sig2/ML-KEM-768: AAD v3, гибридный секрет, дополнение до корзины 256; три сообщения доставлены не по порядку (2,1,3), затем ответ", {
    bobPreset: bobPk, bundle: fullBundle(1),
    async script(a) {
      await a.send("a1", "alice", "bob", { kind: "chat", id: "m1", text: "pq first" }, true);
      await a.send("a2", "alice", "bob", { kind: "chat", id: "m2", text: "pq second" }, true);
      await a.send("a3", "alice", "bob", { kind: "chat", id: "m3", text: "pq third" }, true);
      await a.recv("a2"); await a.recv("a1"); await a.recv("a3");
      await a.send("b1", "bob", "alice", { kind: "chat", id: "m4", text: "pq reply" });
      await a.recv("b1");
      await a.send("a4", "alice", "bob", { kind: "chat", id: "m5", text: "after dh ratchet" });
      await a.recv("a4");
    } }));

  // --- конверт офлайн-очереди env2 (js/crypto-helper.js): статический ECDH + AES-GCM, AAD "ether-env-v2|from|to" ---
  seedAll("env2");
  const shA = await CHJ.deriveSharedKey(IDK.alice, pubOf(IDK.bob));
  const obj = { kind: "chat", id: "e1", text: "static ecdh" };
  vec.env2 = { from: IDS.alice, to: IDS.bob, plain: obj, v2: await CHJ.encryptJson(shA, obj, CHJ.envAad(IDS.alice, IDS.bob)), v1: await CHJ.encryptJson(shA, obj) };

  // --- safety number ---
  vec.safetyNumber = { groups: await CHJ.computeSafetyNumber(pubOf(IDK.alice), pubOf(IDK.bob)) };

  // --- Sender Keys ---
  seedAll("sk1");
  const GKS = fresh("groupkeys.js"), memS = { j: "{}" };
  GKS.setStore({ load: () => JSON.parse(memS.j), save: (o) => { memS.j = JSON.stringify(o); return true; } });
  const gid = "group-test-0001", dist = await GKS.distribution(gid), plains = ["sk one", "sk two", "sk three"], skEnv = [];
  for (const p of plains) skEnv.push(await GKS.encrypt(gid, IDS.alice, p));
  vec.senderKeys = { gid, sender: IDS.alice, distribution: dist, plains, envelopes: skEnv, order: [1, 0, 2] };
  GKS.flush();

  // --- каналы ---
  seedAll("channels");
  const CH = fresh("channels.js"), chOut = {};
  for (const enc of [false, true]) {
    const c = await CH.generate({ name: enc ? "Закрытый" : "Открытый", desc: "тест", enc });
    const post = await CH.makePost(c, { text: enc ? "secret post" : "public post" }, 1760000000000);
    chOut[enc ? "private" : "public"] = { id: c.id, pub: c.pub, pubHash: c.pubHash, key: c.key, kv: c.kv, meta: c.meta, metaSig: c.metaSig, link: "#" + CH.fragment(c), post, text: enc ? "secret post" : "public post" };
  }
  vec.channels = chOut;

  // --- filebin1 ---
  const BF = fresh("bigfile.js"), payload = Uint8Array.from({ length: 40 }, (_, i) => i + 1);
  vec.filebin1 = { id: "abc123", index: 5, payloadHex: Buffer.from(payload).toString("hex"), crc: BF.crc32(payload), frameCrcHex: Buffer.from(new Uint8Array(BF.encodeFrame("abc123", 5, payload, true))).toString("hex"), frameNoCrcHex: Buffer.from(new Uint8Array(BF.encodeFrame("abc123", 5, payload, false))).toString("hex"), crc32_123456789: BF.crc32(new TextEncoder().encode("123456789")) };

  // --- claim ---
  vec.claim = { token: "claim-token-example", proof: nodeCrypto.createHash("sha256").update("ether-claim-v1|claim-token-example").digest("hex") };

  const json = JSON.stringify(vec, null, 1) + "\n";
  if (process.argv.includes("--check")) {
    const cur = JSON.parse(fs.readFileSync(OUT, "utf8"));
    // подписи ECDSA рандомизированы — сравниваем только детерминированную часть (конверты и ключи)
    const strip = (v) => JSON.stringify(v, (k, x) => (k === "sig" || k === "sig2" || k === "metaSig" || k === "bundle" || k === "prekeys" || k === "upload" ? undefined : x));
    const same = strip(cur.ratchet.map((r) => r.messages)) === strip(vec.ratchet.map((r) => r.messages)) && cur.filebin1.frameCrcHex === vec.filebin1.frameCrcHex;
    console.log(same ? "protocol vectors: OK" : "protocol vectors: DIFFER (запустите без --check и проверьте diff)");
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(OUT, json);
  console.log("written", path.relative(ROOT, OUT), json.length, "bytes");
}
main().catch((e) => { console.error(e); process.exit(1); });
