// id v2 (PBKDF2 600k, тег "v2:"): векторы вывода, подпись/проверка уведомления id-migrate, подделки, обнаружение (verifyV2), параметры SignalingClient.
const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const { closeAll } = require("./harness");
const { boot, fakeWebSocket } = require("./cov-helpers");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = nodeCrypto.webcrypto;
const DC = require("../js/devicecert.js");
test.after(closeAll);

const ref = (v, iter) => "v2:" + nodeCrypto.pbkdf2Sync("v2:" + v, "ether-id-v2", iter, 32, "sha256").toString("hex");
async function idn() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const j = await crypto.subtle.exportKey("jwk", kp.privateKey); return { priv: { x: j.x, y: j.y, d: j.d }, pub: { x: j.x, y: j.y } };
}

test("вывод id v2: векторы 600 000 итераций и независимый эталон (PBKDF2 из node:crypto)", async () => {
  const a = await boot();
  const r = await a.run(`Identity.idV2For("+1 (555) 123-4567")`);
  assert.equal(r.id, "v2:f17edcbff21e8b8446c5f46255cff376f08c23da33aaa0d642bf67651e31c2ee", "вектор для +15551234567");
  assert.equal(r.id, ref("+15551234567", 600000));
  assert.equal(r.normalized, "+15551234567");
  assert.match(r.idV1, /^[0-9a-f]{64}$/, "v1 остаётся прежним SHA-256");
  const e = await a.run(`Identity.idV2For("  Alice@Example.com ")`);
  assert.equal(e.id, "v2:e42cc9c83ee86ce4dda9f7cc1a299a4cacfb497d949d111c38d08096a77920c0", "вектор для почты (нормализация: нижний регистр, пробелы)");
  assert.equal(a.run(`Identity.ID_V2_ITER`), 600000, "по умолчанию 600 000 итераций");
  a.close();
});

test("явный параметр iterations меняет результат только для вызывающего; отдельный путь для приложения всегда 600k", async () => {
  const a = await boot();
  const low = await a.run(`Identity.idV2For("+15551234567", 1000)`);
  assert.equal(low.id, ref("+15551234567", 1000));
  assert.notEqual(low.id, ref("+15551234567", 600000));
  const prog = [];
  a.window.__p = (s) => prog.push(s);
  const asy = await a.run(`Identity.idV2ForAsync("+15551234567", { iterations: 1000, onProgress: window.__p })`);
  assert.equal(asy.id, low.id); assert.deepEqual(prog, ["start", "done"], "прогресс: старт и конец, UI получает кадр до тяжёлой части");
  const ok = await a.run(`Identity.idV2ForAsync("+15551234567", { onProgress: window.__p })`);
  assert.equal(ok.id, ref("+15551234567", 600000), "без параметра - боевые 600 000");
  assert.ok(a.run(`Identity.isV2(${JSON.stringify(ok.id)}) && !Identity.isV2("abc") && !Identity.isV2("v2:zz") && !Identity.isV2(5)`));
  a.close();
});

test("уведомление id-migrate: подпись принимается, подделки отвергаются", async () => {
  const x = await idn(), evil = await idn();
  const old = "a".repeat(64), nw = "v2:" + "b".repeat(64);
  const n = await DC.signIdMigrate(x.priv, { old, new: nw, ts: 1700000000000 });
  assert.deepEqual(Object.keys(n).sort(), ["new", "old", "sig", "ts"]);
  assert.ok(await DC.verifyIdMigrate(x.pub, n));
  assert.ok(!(await DC.verifyIdMigrate(evil.pub, n)), "ключ другого человека");
  assert.ok(!(await DC.verifyIdMigrate(x.pub, { ...n, new: "v2:" + "c".repeat(64) })), "подменён новый id");
  assert.ok(!(await DC.verifyIdMigrate(x.pub, { ...n, old: "z".repeat(64) })), "подменён старый id");
  assert.ok(!(await DC.verifyIdMigrate(x.pub, { ...n, ts: n.ts + 1 })), "подменено время");
  assert.ok(!(await DC.verifyIdMigrate(x.pub, { ...n, sig: "AAAA" })), "битая подпись");
  assert.ok(!(await DC.verifyIdMigrate(x.pub, { old, new: nw, ts: n.ts })), "нет подписи");
  assert.ok(!(await DC.verifyIdMigrate(null, n)) && !(await DC.verifyIdMigrate(x.pub, null)));
  const forged = await DC.signIdMigrate(evil.priv, { old, new: nw, ts: n.ts });
  assert.ok(!(await DC.verifyIdMigrate(x.pub, forged)), "подпись злоумышленника чужим ключом");
  // подпись не должна совпадать с подписью списка/сертификата (разные префиксы доменов)
  const l = await DC.signList(x.priv, { id: old, seq: 1, certs: [], revoked: [] });
  assert.ok(!(await DC.verifyIdMigrate(x.pub, { old, new: nw, ts: n.ts, sig: l.sig })));
});

test("обнаружение: verifyV2 принимает id v2 только при совпадении с выводом из введённого номера", async () => {
  const a = await boot();
  const it = await a.run(`(async () => { const p = await Discovery.prepare(["+15551234567"], "salt-salt-salt-salt"); return p; })()`);
  assert.equal(it.length, 1); assert.equal(it[0].idV1, it[0].id);
  const good = ref("+15551234567", 1000), bad = "v2:" + "0".repeat(64);
  a.window.__prep = JSON.parse(JSON.stringify(it)); const pub = { kty: "EC", crv: "P-256", x: "x", y: "y" };
  const mk = (id) => JSON.stringify([{ hash: it[0].hash, id, publicKey: pub, name: "N" }]);
  const r1 = await a.run(`Discovery.verifyV2(${mk(good)}, __prep, 1000)`);
  assert.equal(r1.length, 1); assert.equal(r1[0].id, good); assert.equal(r1[0].normalized, "+15551234567");
  assert.equal((await a.run(`Discovery.verifyV2(${mk(bad)}, __prep, 1000)`)).length, 0, "сервер подсунул чужой v2 id под известный номер");
  assert.equal((await a.run(`Discovery.verifyV2(${mk(it[0].id)}, __prep, 1000)`)).length, 0, "v1 идёт старым путём verify");
  assert.equal(a.run(`Discovery.verify(${mk(it[0].id)}, __prep).length`), 1, "v1 по-прежнему проходит verify");
  assert.equal(a.run(`Discovery.verify(${mk(good)}, __prep).length`), 0, "v2 в синхронном verify не принимается без вывода");
  a.close();
});

test("SignalingClient: alias-set уходит после registered (с claim), поле as - только при активном алиасе и для контактов в старом режиме", async () => {
  const a = await boot(); fakeWebSocket(a);
  a.run(`window.__ev = []; window.s = new SignalingClient("ws://x", "v2:" + "b".repeat(64), {}); s.claim = "c".repeat(64); s.aliasOld = "a".repeat(64); s.legacyId = s.aliasOld; s.legacyFor = (to) => to === "legacyPeer";
    s.addEventListener("alias-result", (e) => __ev.push(e.detail)); s.start();`);
  const ws = a.window.__sockets[a.window.__sockets.length - 1]; ws.__open();
  assert.equal(ws.sent[0].type, "register"); assert.equal(ws.sent[0].id, "v2:" + "b".repeat(64)); assert.equal(ws.sent[0].claim, "c".repeat(64));
  ws.__recv({ type: "registered", id: "v2:" + "b".repeat(64), online: [], features: ["ratchet2", "alias"] });
  const al = ws.sent.find((m) => m.type === "alias-set");
  assert.ok(al, "alias-set отправлен"); assert.equal(al.old, "a".repeat(64)); assert.equal(al.oldClaim, "c".repeat(64), "тот же секрет устройства");
  ws.sent.length = 0;
  a.run(`s.signal("legacyPeer", { t: "x" }); s.deliver("legacyPeer", "m1", { iv: "a", ct: "b" }, null, "chat");`);
  assert.ok(ws.sent.every((m) => m.as === undefined), "пока алиас не подтверждён, as не добавляется");
  ws.__recv({ type: "alias-result", ok: true, old: "a".repeat(64), ttlDays: 90 });
  assert.equal(a.run(`s.aliasActive`), true); assert.equal(a.window.__ev.length, 1);
  ws.sent.length = 0;
  a.run(`s.signal("legacyPeer", { t: "x" }); s.deliver("legacyPeer", "m1", { iv: "a", ct: "b" }, null, "chat"); s.signal("newPeer", { t: "x" }); s.deliver("newPeer", "m2", { iv: "a", ct: "b" }, null, "chat");`);
  assert.equal(JSON.stringify(ws.sent.map((m) => m.as || null)), JSON.stringify(["a".repeat(64), "a".repeat(64), null, null]));
  ws.__recv({ type: "alias-result", ok: false, old: "a".repeat(64), error: "old-claim" });
  assert.equal(a.run(`s.aliasActive`), false);
  // сервер без feature alias: alias-set не шлётся (старый сервер)
  ws.sent.length = 0; ws.__recv({ type: "registered", id: "x", online: [], features: ["ratchet2"] });
  assert.ok(!ws.sent.some((m) => m.type === "alias-set"));
  a.close();
});
