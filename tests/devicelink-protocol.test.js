// Перенос на новое устройство (js/devicelink.js) поверх настоящего rendezvous-модуля сервера: протокол, шифрование, отказы.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
process.env.LINK_CHANNEL_TTL_MS = "600000"; process.env.LINK_INIT_PER_MIN = "100";
const Srv = require("../signaling-server/devicelink.js");
const DL = require("../js/devicelink.js");

let server, base;
test.before(async () => {
  server = http.createServer(async (req, res) => { if (!(await Srv.handle(req, res, "127.0.0.1"))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());
const DATA = { "ether.name": "Аня", "ether.privKey": '{"d":"SECRET-PRIV"}', "ether.contacts": "[{\"id\":\"x\"}]", "ether.ratchet": "{}", "ether.sec.on": "1", "ether.pushSubscription": "{}" };

test("полный перенос: оба видят один проверочный код, пакет доходит, привязанное к устройству не едет", async () => {
  const s = await DL.createSender({ base, pollMs: 20 });
  assert.match(s.code, /^ether:\/\/link\?s=[A-Za-z0-9_-]{43}&h=/);
  const r = await DL.join({ code: s.code, pollMs: 20 });
  const { verify } = await s.waitForJoin();
  assert.match(verify, /^\d{6}$/); assert.equal(verify, r.verify);
  const got = r.receive(); await s.send(DATA);
  const d = await got;
  assert.equal(d["ether.name"], "Аня"); assert.equal(d["ether.privKey"], DATA["ether.privKey"]);
  assert.equal(d["ether.sec.on"], undefined); assert.equal(d["ether.pushSubscription"], undefined);
});

test("сервер видит только шифртекст: в blob нет открытых данных; второй get = 410", async () => {
  const s = await DL.createSender({ base, pollMs: 20 }); const parsed = DL.parseCode(s.code); const { t } = await DL.ids(parsed.S);
  let seen = null; const orig = global.fetch;
  global.fetch = async (u, init) => { if (String(u).endsWith("/link/put")) seen = Buffer.from(init.body); return orig(u, init); };
  try {
    const r = await DL.join({ code: s.code, pollMs: 20 }); await s.waitForJoin();
    const p = r.receive(); await s.send(DATA); await p;
  } finally { global.fetch = orig; }
  assert.ok(seen && seen.length > 30 && !seen.toString("latin1").includes("SECRET-PRIV") && !seen.toString("latin1").includes("Аня"));
  const again = await fetch(base + "/link/get", { method: "POST", body: JSON.stringify({ t, jt: "x" }) });
  assert.ok(again.status === 404 || again.status === 410);
});

test("второй подключившийся по тому же коду отбивается (taken), легитимному ничего не уходит", async () => {
  const s = await DL.createSender({ base, pollMs: 20 });
  await DL.join({ code: s.code, pollMs: 20 });
  await assert.rejects(DL.join({ code: s.code }), (e) => e.code === "taken");
});

test("подмена публичного ключа посредником (знает t, но не S): коды не совпадают, расшифровка не удаётся", async () => {
  const s = await DL.createSender({ base, pollMs: 20 }); const parsed = DL.parseCode(s.code); const { t } = await DL.ids(parsed.S);
  // «сервер» сам подключается как новое устройство со своим ключом, но секрета S у него нет — подставляет другой S
  const fake = await DL.genKeyPair(); const j = await (await fetch(base + "/link/join", { method: "POST", body: JSON.stringify({ t, pub: fake.pub }) })).json();
  const mitm = await DL.deriveKey(fake.priv, j.pub, DL.newSecret(), t, j.pub, fake.pub);
  const { verify } = await s.waitForJoin();
  assert.notEqual(mitm.verify, verify);
});

test("неверный код / мусор / чужой формат", async () => {
  assert.equal(DL.parseCode("hello"), null); assert.equal(DL.parseCode("ether://link?s=abc&h=http%3A%2F%2Fx"), null);
  const S = DL.newSecret(); const code = DL.encodeCode(S, base);
  await assert.rejects(DL.join({ code, pollMs: 20 }), (e) => e.code === "not-found");
  await assert.rejects(DL.join({ code: "zzz" }), (e) => e.code === "bad-code");
  assert.ok(DL.parseCode(code.split("&h=")[0].replace("ether://link?s=", ""), base), "голый секрет + сервер по умолчанию");
});

test("отмена отправителем закрывает канал; httpBase; старый сервер без /link даёт unsupported", async () => {
  const s = await DL.createSender({ base, pollMs: 20 }); await s.cancel();
  await assert.rejects(DL.join({ code: s.code }), (e) => e.code === "not-found");
  assert.equal(DL.httpBase("wss://a.example.org/x?y"), "https://a.example.org");
  await assert.rejects(DL.createSender({ base, fetchFn: async () => ({ status: 404, ok: false }) }), (e) => e.code === "unsupported");
});

test("просроченный секрет: waitForJoin завершается expired", async () => {
  const s = await DL.createSender({ base, pollMs: 10 }); s.expiresAt = Date.now() - 1;
  await assert.rejects(s.waitForJoin(), (e) => e.code === "expired");
});

test("TTL пакета на сервере: после выдачи данных у сервера не остаётся", async () => {
  const before = Srv._stats().totalBytes; const s = await DL.createSender({ base, pollMs: 20 });
  const r = await DL.join({ code: s.code, pollMs: 20 }); await s.waitForJoin(); const p = r.receive(); await s.send(DATA); await p;
  assert.equal(Srv._stats().totalBytes, before);
});

test("companion: данные устройства едут в зашифрованном пакете рядом с data", async () => {
  const s = await DL.createSender({ base, pollMs: 20 }); const r = await DL.join({ code: s.code, pollMs: 20 }); await s.waitForJoin();
  const p = r.receive(); await s.send(DATA, { devId: "0123456789abcdef", priv: { x: "x", y: "y", d: "SECRET-DEV" } });
  await p; assert.equal(r.device.devId, "0123456789abcdef"); assert.equal(r.device.priv.d, "SECRET-DEV");
});
