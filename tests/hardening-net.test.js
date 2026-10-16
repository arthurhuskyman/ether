// Находки аудита: ratchet (сбой записи, повтор начального конверта, понижение подписи) и PeerLink (пересогласование, heartbeat).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const ratchetPath = path.join(__dirname, "..", "js", "ratchet.js");
const CH = new Function(fs.readFileSync(path.join(__dirname, "..", "js", "crypto-helper.js"), "utf8") + "\nreturn CryptoHelper;")();

function device(id, keys, saveImpl) {
  delete require.cache[require.resolve(ratchetPath)];
  const R = require(ratchetPath);
  const mem = { json: "{}", fail: false };
  R.setStore({ load: () => JSON.parse(mem.json), save: (o) => { if (mem.fail) return saveImpl ? saveImpl() : false; mem.json = JSON.stringify(o); return true; } });
  return { id, R, mem, priv: keys.privateKeyJwk, pub: keys.publicKeyJwk };
}
const ctx = (me, other, extra) => ({ contactId: other.id, myId: me.id, myPrivJwk: me.priv, theirPubJwk: other.pub, ...extra });
async function pair(saveImpl) {
  return { a: device("alice-id", await CH.generateKeyPair(), saveImpl), b: device("bob-id", await CH.generateKeyPair(), saveImpl) };
}

// ---------- A: сбой записи ----------
test("A: encrypt при сбое записи бросает 'persist failed'; следующий encrypt не отдаёт конверт, пока запись не удастся", async () => {
  const { a, b } = await pair();
  a.mem.fail = true;
  await assert.rejects(a.R.encrypt(ctx(a, b), { t: 1 }), /persist failed/);
  await assert.rejects(a.R.encrypt(ctx(a, b), { t: 2 }), /persist failed/);
  a.mem.fail = false;
  const e = await a.R.encrypt(ctx(a, b), { t: 3 });
  assert.deepEqual(await b.R.decrypt(ctx(b, a), e), { t: 3 });
});

test("A: store.save, бросающий исключение, тоже считается сбоем", async () => {
  const { a, b } = await pair(() => { throw new Error("quota"); });
  a.mem.fail = true;
  await assert.rejects(a.R.encrypt(ctx(a, b), { t: 1 }), /persist failed/);
});

test("A: decrypt при сбое записи возвращает плейнтекст, но блокирует encrypt до успешной записи", async () => {
  const { a, b } = await pair();
  const e1 = await a.R.encrypt(ctx(a, b), { t: 1 });
  b.mem.fail = true;
  assert.deepEqual(await b.R.decrypt(ctx(b, a), e1), { t: 1 });
  await assert.rejects(b.R.encrypt(ctx(b, a), { r: 1 }), /persist failed/);
  b.mem.fail = false;
  const r = await b.R.encrypt(ctx(b, a), { r: 2 });
  assert.deepEqual(await a.R.decrypt(ctx(a, b), r), { r: 2 });
});

// ---------- B: повтор начального конверта ----------
test("B: повтор начального конверта после вытеснения сессии отклоняется; живая сессия ведёт себя как раньше", async () => {
  const { a, b } = await pair();
  const first = await a.R.encrypt(ctx(a, b), { n: 0 });
  assert.deepEqual(await b.R.decrypt(ctx(b, a), first), { n: 0 });
  await assert.rejects(b.R.decrypt(ctx(b, a), first), (e) => !/replayed initial/.test(e.message), "живая сессия: обычный отказ");
  for (let i = 0; i < 5; i++) {
    a.R.reset(b.id);
    const e = await a.R.encrypt(ctx(a, b), { n: i + 1 });
    assert.deepEqual(await b.R.decrypt(ctx(b, a), e), { n: i + 1 });
  }
  await assert.rejects(b.R.decrypt(ctx(b, a), first), /replayed initial/);
});

test("B: список идентификаторов начальных конвертов ограничен 200", async () => {
  const { a, b } = await pair();
  await b.R.decrypt(ctx(b, a), await a.R.encrypt(ctx(a, b), { n: 0 }));
  const saved = JSON.parse(b.mem.json);
  assert.equal(saved.ri[a.id].length, 1);
  saved.ri[a.id].push(...Array.from({ length: 300 }, (_, i) => "x" + i));
  b.mem.json = JSON.stringify(saved);
  b.R.setStore({ load: () => JSON.parse(b.mem.json), save: (o) => { b.mem.json = JSON.stringify(o); return true; } });
  a.R.reset(b.id);
  await b.R.decrypt(ctx(b, a), await a.R.encrypt(ctx(a, b), { n: 1 }));
  assert.ok(JSON.parse(b.mem.json).ri[a.id].length <= 200);
});

// ---------- C: подпись prekey ----------
test("C: после валидно подписанного пакета пакет без подписи игнорируется (старт от долговременных ключей)", async () => {
  const { a, b } = await pair();
  const up = await b.R.prekeyUploadPayload(2, b.priv);
  assert.ok(up.spk.sig);
  const e1 = await a.R.encrypt(ctx(a, b, { getBundle: async () => ({ spk: up.spk, opk: up.opks[0] }) }), { x: 1 });
  assert.ok(e1.h.p, "первый раз пакет принят (prekey-заголовок)");
  assert.equal(JSON.parse(a.mem.json).sg[b.id], true);
  a.R.reset(b.id);
  const unsigned = { spk: { id: up.spk.id, pub: up.spk.pub }, opk: up.opks[1] };
  const e2 = await a.R.encrypt(ctx(a, b, { getBundle: async () => unsigned }), { x: 2 });
  assert.equal(e2.h.p, undefined, "бесподписный пакет отвергнут");
  assert.deepEqual(await b.R.decrypt(ctx(b, a), e2), { x: 2 });
});

test("C: для контакта, не присылавшего подписей, бесподписный пакет принимается как раньше", async () => {
  const { a, b } = await pair();
  const up = await b.R.prekeyUploadPayload(1, null);
  const e = await a.R.encrypt(ctx(a, b, { getBundle: async () => ({ spk: up.spk, opk: up.opks[0] }) }), { x: 1 });
  assert.ok(e.h.p);
});

// ---------- D/E/F/G: PeerLink ----------
function link(a) {
  a.run(`(() => { const l = Object.create(PeerLink.prototype); l._log = () => {}; l._closed = false; l.id = "peerpeerpeerpeer"; l.dispatchEvent = () => true; window.__l = l; return true; })()`);
  return a.window.__l;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fakePc(state) {
  const pc = { signalingState: state, localDescription: null,
    async createOffer() { return { type: "offer", sdp: "v=0 offer" }; },
    async setLocalDescription(d) {
      if (d.type === "rollback") { pc.signalingState = "stable"; pc.localDescription = null; }
      else { pc.signalingState = "have-local-offer"; pc.localDescription = { type: "offer", sdp: "sdp-before-gather" }; }
    } };
  return pc;
}

test("D+F: ICE-restart из non-stable ветки не теряется, даже если таймер завёл другой путь; флаг не залипает", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  l.dc = { readyState: "open" };
  l.pc = fakePc("have-remote-offer");
  l.send = () => true;
  const calls = [];
  const orig = l._negotiate.bind(l);
  l._negotiate = (r) => { calls.push(!!r); return orig(r); };
  l._renegotiationRetryTimer = setTimeout(() => l._retryNegotiate(false), 300); // таймер чужого пути (без restart)
  await l._negotiate(true);
  assert.equal(l._retryRestart, true);
  l.pc.signalingState = "stable";
  await sleep(450);
  assert.equal(calls[calls.length - 1], true, "в срабатывании передан iceRestart");
  assert.equal(l._pendingNegotiation, false);
  assert.equal(l._retryRestart, false);
  a.close();
});

test("D: таймер чужого пути не оставляет _pendingNegotiation залипшим; обработчик таймера сам снимает флаг", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  l.dc = { readyState: "open" };
  l.pc = fakePc("stable");
  l.send = () => true;
  l._renegotiationRetryTimer = setTimeout(() => {}, 2000); // чужой retry-таймер, пока наш вызов в полёте
  await l._negotiate(false);
  assert.equal(l._pendingNegotiation, false, "finally сбросил флаг, хотя таймер существует");
  clearTimeout(l._renegotiationRetryTimer);
  l._pendingNegotiation = true; l._makingOffer = false;
  l.pc.signalingState = "stable"; l.pc.localDescription = null;
  await l._retryNegotiate(false);
  assert.equal(l._renegotiationRetryTimer, null);
  assert.equal(l._pendingNegotiation, false);
  a.close();
});

test("D: при неудачной отправке offer флаг остаётся до срабатывания собственного retry, затем сбрасывается", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  l.dc = { readyState: "open" };
  l.pc = fakePc("stable");
  let n = 0; l.send = () => ++n > 1;
  await l._negotiate(false);
  assert.equal(l._pendingNegotiation, true, "ждём собственный retry");
  await sleep(700);
  assert.equal(n, 2);
  assert.equal(l._pendingNegotiation, false);
  a.close();
});

test("E: при ICE-restart SDP читается после ожидания сбора кандидатов", async () => {
  const a = createApp(); await a.ready;
  const l = link(a);
  l.dc = { readyState: "open" };
  const pc = fakePc("stable");
  l.pc = pc;
  pc.iceGatheringState = "gathering";
  let finish;
  pc.addEventListener = (n, f) => { if (n === "icegatheringstatechange") finish = () => { pc.iceGatheringState = "complete"; f(); }; };
  pc.removeEventListener = () => {};
  const sent = []; l.send = (p) => { sent.push(p); return true; };
  const p = l._negotiate(true);
  await sleep(50);
  assert.equal(sent.length, 0, "пока кандидаты собираются, offer не отправлен");
  pc.localDescription = { type: "offer", sdp: "sdp-after-gather" };
  finish();
  await p;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sdp, "sdp-after-gather");
  a.close();
});

test("G: HEARTBEAT 60 с; входящий ping обновляет метку; первый просроченный тик шлёт ping и даёт ещё интервал", async () => {
  const a = createApp(); await a.ready;
  assert.equal(a.run(`HEARTBEAT_TIMEOUT_MS`), 60000);
  const l = link(a);
  const handlers = {};
  l.dc = { addEventListener: (n, f) => { handlers[n] = f; }, readyState: "open" };
  let tickFn = null;
  a.window.setInterval = (f) => { tickFn = f; return 1; };
  const sent = []; l.send = (p) => { sent.push(p.kind); return true; };
  l._setStatus = (s) => { l.status = s; };
  l._bindDataChannel();
  handlers.open();
  l._lastPongAt = Date.now() - 50000;
  handlers.message({ data: JSON.stringify({ kind: "ping", t: 1 }) });
  assert.ok(Date.now() - l._lastPongAt < 1000, "ping собеседника освежает метку");
  sent.length = 0;
  l._lastPongAt = Date.now() - 90000;
  tickFn();
  assert.equal(l.status, "connected", "первый просроченный тик не рвёт линк");
  assert.deepEqual(sent, ["ping"]);
  tickFn();
  assert.equal(l.status, "disconnected", "второй просроченный тик рвёт");
  l.status = "connected"; l._lastPongAt = Date.now() - 90000; l._staleGrace = false;
  tickFn();
  handlers.message({ data: JSON.stringify({ kind: "pong", t: 1 }) });
  tickFn();
  assert.equal(l.status, "connected", "ответ за дополнительный интервал спасает линк");
  a.close();
});
