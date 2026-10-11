// Аутентификация P2P-канала (js/linkauth.js) и её встраивание в приложение.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const LinkAuth = require("../js/linkauth.js");
const CH = new Function(fs.readFileSync(path.join(__dirname, "..", "js", "crypto-helper.js"), "utf8") + "\nreturn CryptoHelper;")();
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

const FP_A = "sha-256 aa:bb:cc", FP_B = "sha-256 11:22:33";

async function handshake({ aKeys, bKeys, fpAseenByA, fpBseenByA, fpAseenByB, fpBseenByB, tamper }) {
  const na = LinkAuth.nonce(), nb = LinkAuth.nonce();
  const ka = await LinkAuth.secret(aKeys.privateKeyJwk, bKeys.publicKeyJwk, "alice", "bob");
  const kb = await LinkAuth.secret(bKeys.privateKeyJwk, aKeys.publicKeyJwk, "bob", "alice");
  const tagA = await LinkAuth.tag(ka, "alice", "bob", na, nb, fpAseenByA, fpBseenByA);
  const tagB = await LinkAuth.tag(kb, "bob", "alice", nb, na, fpBseenByB, fpAseenByB);
  const okAtB = await LinkAuth.verify(kb, tamper ? tagA.slice(0, -2) + "AA" : tagA, "alice", "bob", na, nb, fpBseenByB, fpAseenByB);
  const okAtA = await LinkAuth.verify(ka, tagB, "bob", "alice", nb, na, fpAseenByA, fpBseenByA);
  return { okAtA, okAtB };
}

test("честный канал: теги сходятся с обеих сторон", async () => {
  const aKeys = await CH.generateKeyPair(), bKeys = await CH.generateKeyPair();
  const r = await handshake({ aKeys, bKeys, fpAseenByA: FP_A, fpBseenByA: FP_B, fpAseenByB: FP_A, fpBseenByB: FP_B });
  assert.deepEqual(r, { okAtA: true, okAtB: true });
});

test("подмена отпечатков посредником (серверу не известен общий секрет) — проверка не проходит", async () => {
  const aKeys = await CH.generateKeyPair(), bKeys = await CH.generateKeyPair();
  // Алиса видит отпечаток посредника M1 вместо Боба, Боб видит M2 вместо Алисы
  const r = await handshake({ aKeys, bKeys, fpAseenByA: FP_A, fpBseenByA: "sha-256 de:ad:01", fpAseenByB: "sha-256 de:ad:02", fpBseenByB: FP_B });
  assert.equal(r.okAtA, false); assert.equal(r.okAtB, false);
});

test("посредник с чужими ключами личности и испорченный тег не проходят", async () => {
  const aKeys = await CH.generateKeyPair(), bKeys = await CH.generateKeyPair(), mKeys = await CH.generateKeyPair();
  const na = LinkAuth.nonce(), nb = LinkAuth.nonce();
  const km = await LinkAuth.secret(mKeys.privateKeyJwk, aKeys.publicKeyJwk, "bob", "alice"); // Мэллори выдаёт себя за Боба
  const kb = await LinkAuth.secret(bKeys.privateKeyJwk, aKeys.publicKeyJwk, "bob", "alice");
  const forged = await LinkAuth.tag(km, "bob", "alice", nb, na, FP_A, FP_B);
  const ka = await LinkAuth.secret(aKeys.privateKeyJwk, bKeys.publicKeyJwk, "alice", "bob");
  assert.equal(await LinkAuth.verify(ka, forged, "bob", "alice", nb, na, FP_A, FP_B), false);
  const good = await LinkAuth.tag(kb, "bob", "alice", nb, na, FP_A, FP_B);
  assert.equal(await LinkAuth.verify(ka, good, "bob", "alice", nb, na, FP_A, FP_B), true);
  assert.equal(await LinkAuth.verify(ka, good.slice(0, -2) + "AA", "bob", "alice", nb, na, FP_A, FP_B), false);
  assert.equal(await LinkAuth.verify(ka, "не-base64!!", "bob", "alice", nb, na, FP_A, FP_B), false);
});

test("повтор старого обмена с другими нонсами не проходит; тег привязан к направлению", async () => {
  const aKeys = await CH.generateKeyPair(), bKeys = await CH.generateKeyPair();
  const ka = await LinkAuth.secret(aKeys.privateKeyJwk, bKeys.publicKeyJwk, "alice", "bob");
  const kb = await LinkAuth.secret(bKeys.privateKeyJwk, aKeys.publicKeyJwk, "bob", "alice");
  const n1 = LinkAuth.nonce(), n2 = LinkAuth.nonce(), n3 = LinkAuth.nonce();
  const t = await LinkAuth.tag(kb, "bob", "alice", n2, n1, FP_A, FP_B);
  assert.equal(await LinkAuth.verify(ka, t, "bob", "alice", n2, n3, FP_A, FP_B), false, "другой нонс получателя");
  assert.equal(await LinkAuth.verify(ka, t, "alice", "bob", n2, n1, FP_A, FP_B), false, "тег Боба нельзя выдать за тег Алисы");
});

// ---------- в приложении ----------
async function booted(id, name) {
  const a = createApp({ storage: { "ether.name": name, "ether.myId": id, "ether.lang": "en" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted && !!Store.myPublicKeyJwk`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}
async function ev(a, code) {
  a.window.__r = undefined; a.window.__e = undefined;
  a.run(`(async () => { ${code} })().then((v) => { window.__r = JSON.stringify(v === undefined ? null : v); }, (e) => { window.__e = String(e); })`);
  for (let i = 0; i < 200 && a.window.__r === undefined && a.window.__e === undefined; i++) await new Promise((r) => setTimeout(r, 25));
  if (a.window.__e) throw new Error(a.window.__e);
  return JSON.parse(a.window.__r);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Подставляем в mesh «линк»-заглушку и играем роль собеседника Боба с его настоящими ключами.
async function scenario({ bobFpSeenByBob = { local: FP_B, remote: FP_A }, bobKnowsAuth = true } = {}) {
  const A = await booted("alice-id", "Alice");
  const bob = await CH.generateKeyPair();
  A.run(`{ const c = ensureContactEntry("bob-id", "Bob"); c.publicKey = ${JSON.stringify(bob.publicKeyJwk)}; }
    window.__sent = []; window.__removed = [];
    const fake = { id: "bob-id", status: "connected", authGate: null, authState: null, dc: { readyState: "open" },
      send(p) { if (this.authGate === "closed") return false; if (this.authGate === "pending" && !AUTH_PASS.has(p.kind)) return false; window.__sent.push(p); return true; },
      fingerprints() { return { local: ${JSON.stringify(FP_A)}, remote: ${JSON.stringify(FP_B)} }; }, close() {} };
    mesh.links.set("bob-id", fake);
    mesh.remove = (id) => { window.__removed.push(id); mesh.links.delete(id); };`);
  const alicePub = JSON.parse(A.run(`JSON.stringify(Store.myPublicKeyJwk)`));
  const nb = LinkAuth.nonce();
  const key = await LinkAuth.secret(bob.privateKeyJwk, alicePub, "bob-id", "alice-id");
  const send = (p) => A.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "bob-id", payload: ${JSON.stringify(p)} } }))`);
  return { A, bob, nb, key, send, link: () => JSON.parse(A.run(`JSON.stringify({ gate: mesh.get("bob-id") && mesh.get("bob-id").authGate, state: mesh.get("bob-id") && mesh.get("bob-id").authState, sent: window.__sent, removed: window.__removed, seen: !!state.contacts.get("bob-id").authSeen })`)) };
}
async function bobAnswers(sc, fps) {
  const sent = sc.link().sent; const my = sent.find((m) => m.kind === "auth" && m.s === 1);
  sc.send({ kind: "auth", s: 1, n: sc.nb });
  await wait(150);
  const aliceTag = sc.link().sent.find((m) => m.kind === "auth" && m.s === 2);
  const t = await LinkAuth.tag(sc.key, "bob-id", "alice-id", sc.nb, my.n, fps.local, fps.remote);
  sc.send({ kind: "auth", s: 2, t });
  await wait(200);
  return aliceTag;
}

test("приложение: успешная проверка открывает канал, копившееся входящее разбирается, authSeen запоминается", async () => {
  const sc = await scenario();
  sc.A.run(`startLinkAuth("bob-id")`);
  assert.equal(sc.link().gate, "pending");
  assert.equal(sc.A.run(`mesh.get("bob-id").send({ kind: "chat", text: "рано" })`), false, "пока идёт проверка, чат наружу не уходит");
  assert.equal(sc.A.run(`mesh.get("bob-id").send({ kind: "call-state", state: "ringing" })`), true, "служебное проходит");
  sc.send({ kind: "chat", id: "early1", text: "раннее", ts: Date.now() });
  await wait(100);
  assert.equal(sc.A.run(`state.contacts.get("bob-id").messages.some((m) => m.id === "early1")`), false, "входящее копится до проверки");
  const aliceTag = await bobAnswers(sc, { local: FP_B, remote: FP_A });
  assert.ok(aliceTag && aliceTag.t, "Алиса прислала свой тег");
  const st = sc.link();
  assert.equal(st.gate, null); assert.equal(st.state, "ok"); assert.equal(st.seen, true);
  assert.equal(sc.A.run(`state.contacts.get("bob-id").messages.some((m) => m.id === "early1")`), true, "накопленное входящее разобрано");
  assert.equal(sc.A.run(`mesh.get("bob-id").send({ kind: "chat", text: "теперь можно" })`), true);
});

test("приложение: подменённые отпечатки — канал закрыт, переписка не принимается", async () => {
  const sc = await scenario();
  sc.A.run(`startLinkAuth("bob-id")`);
  sc.send({ kind: "chat", id: "evil1", text: "вброс", ts: Date.now() });
  await bobAnswers(sc, { local: "sha-256 de:ad:02", remote: "sha-256 de:ad:01" }); // Боб видит другие отпечатки, чем Алиса
  const st = sc.link();
  assert.deepEqual(st.removed, ["bob-id"], "линк закрыт");
  assert.equal(sc.A.run(`state.contacts.get("bob-id").messages.some((m) => m.id === "evil1")`), false, "накопленное не показано");
});

test("приложение: собеседник без поддержки проверки — по таймауту канал открывается как «без подтверждения»", async () => {
  const sc = await scenario();
  sc.A.run(`startLinkAuth("bob-id"); authTimeout("bob-id", mesh.get("bob-id"))`);
  const st = sc.link();
  assert.equal(st.gate, null); assert.equal(st.state, "unverified"); assert.equal(st.seen, false);
});

test("приложение: раньше проверку проходил, а теперь молчит — считается отключением проверки, канал закрыт", async () => {
  const sc = await scenario();
  sc.A.run(`state.contacts.get("bob-id").authSeen = true; startLinkAuth("bob-id"); authTimeout("bob-id", mesh.get("bob-id"))`);
  assert.deepEqual(sc.link().removed, ["bob-id"]);
});

test("приложение: контакт без ключа — шлюз не включается", async () => {
  const A = await booted("alice-id", "Alice");
  A.run(`ensureContactEntry("zed-id", "Zed"); mesh.links.set("zed-id", { id: "zed-id", status: "connected", authGate: undefined, dc: { readyState: "open" }, send() { return true; }, fingerprints() { return {}; } }); startLinkAuth("zed-id");`);
  assert.equal(A.run(`mesh.get("zed-id").authGate`), null);
});

// ---------- сквозной: два приложения, настоящий WebRTC, рукопожатие идёт само ----------
const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
async function e2eConnect(tamperKeyOfBobSeenByAlice) {
  const A = await booted("alice-e2e", "Alice"), B = await booted("bob-e2e", "Bob");
  const pubA = JSON.parse(A.run(`JSON.stringify(Store.myPublicKeyJwk)`)), pubB = JSON.parse(B.run(`JSON.stringify(Store.myPublicKeyJwk)`));
  let bobKeyForAlice = pubB;
  if (tamperKeyOfBobSeenByAlice) bobKeyForAlice = (await CH.generateKeyPair()).publicKeyJwk; // у Алисы записан не тот ключ Боба
  A.run(`ensureContactEntry("bob-e2e", "Bob").publicKey = ${JSON.stringify(bobKeyForAlice)}`);
  B.run(`ensureContactEntry("alice-e2e", "Alice").publicKey = ${JSON.stringify(pubA)}`);
  const LA = A.run(`mesh.createOutgoingLink("bob-e2e")`), LB = B.run(`mesh.createIncomingLink("alice-e2e")`);
  const offer = await LA.createInitialOffer("");
  const answer = await LB.acceptOfferAndCreateAnswer(offer);
  await LA.acceptAnswer(answer);
  return { A, B, LA, LB };
}
async function untilTrue(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep2(50); } return false; }

test("сквозной: два приложения сами проходят взаимную проверку и открывают шлюз", async () => {
  const { A, B, LA, LB } = await e2eConnect(false);
  assert.ok(await untilTrue(() => LA.authState === "ok" && LB.authState === "ok"), "состояния: A=" + LA.authState + " B=" + LB.authState);
  assert.equal(LA.authGate, null); assert.equal(LB.authGate, null);
  assert.equal(A.run(`!!state.contacts.get("bob-e2e").authSeen`), true);
  assert.equal(LA.send({ kind: "chat", id: "e2e1", text: "после проверки", ts: Date.now() }), true);
  assert.ok(await untilTrue(() => B.run(`state.contacts.get("alice-e2e").messages.some((m) => m.id === "e2e1")`)), "сообщение по проверенному каналу дошло");
});

test("сквозной: у Алисы записан чужой ключ Боба (подмена) — обе стороны закрывают канал", async () => {
  const { A, B, LA, LB } = await e2eConnect(true);
  assert.ok(await untilTrue(() => LA.authState === "fail" || LB.authState === "fail"), "ожидали провал проверки");
  assert.ok(await untilTrue(() => LA.authGate === "closed" && LB.authGate === "closed"), "A=" + LA.authGate + " B=" + LB.authGate);
  assert.equal(LA.send({ kind: "chat", text: "нельзя" }), false);
  assert.equal(B.run(`state.contacts.get("alice-e2e").messages.length`), 0);
});
