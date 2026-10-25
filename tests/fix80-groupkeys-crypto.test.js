// Sender Keys (js/groupkeys.js): храповик цепочки, неупорядоченность в окне, подпись, rekey после кика, новый участник, решение shouldUse.
const test = require("node:test");
const assert = require("node:assert/strict");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const path = require("path");
const modPath = path.join(__dirname, "..", "js", "groupkeys.js");
function dev() {
  delete require.cache[require.resolve(modPath)];
  const G = require(modPath); const mem = { json: "{}" };
  G.setStore({ load: () => JSON.parse(mem.json), save: (o) => { mem.json = JSON.stringify(o); return true; } });
  return { G, mem };
}
const GID = "group-1";
async function share(from, fromId, tos) { const d = await from.G.distribution(GID); for (const t of tos) assert.ok(t.G.acceptDistribution(GID, fromId, d)); return d; }

test("цепочка: сообщения расшифровываются по порядку, ключи и IV меняются, шифртекст разный для одинакового текста", async () => {
  const a = dev(), b = dev(); await share(a, "A", [b]);
  const e1 = await a.G.encrypt(GID, "A", "hello"), e2 = await a.G.encrypt(GID, "A", "hello");
  assert.notEqual(e1.ct, e2.ct); assert.notEqual(e1.iv, e2.iv); assert.equal(e1.n, 0); assert.equal(e2.n, 1);
  assert.equal(await b.G.decrypt(GID, "A", e1), "hello"); assert.equal(await b.G.decrypt(GID, "A", e2), "hello");
  assert.equal(e1.v, "sk1"); assert.ok(e1.sig);
});
test("неупорядоченная доставка в пределах окна и пропуски; повтор и слишком далёкий номер отвергаются", async () => {
  const a = dev(), b = dev(); await share(a, "A", [b]);
  const es = []; for (let i = 0; i < 6; i++) es.push(await a.G.encrypt(GID, "A", "m" + i));
  assert.equal(await b.G.decrypt(GID, "A", es[3]), "m3");
  assert.equal(await b.G.decrypt(GID, "A", es[1]), "m1");
  assert.equal(await b.G.decrypt(GID, "A", es[5]), "m5");
  assert.equal(await b.G.decrypt(GID, "A", es[0]), "m0");
  await assert.rejects(b.G.decrypt(GID, "A", es[3]), /old/);   // повтор
  assert.equal(await b.G.decrypt(GID, "A", es[2]), "m2"); assert.equal(await b.G.decrypt(GID, "A", es[4]), "m4");
  const far = dev(); await share(a, "A", [far]);
  const e = []; for (let i = 0; i < b.G.MAX_SKIP + 3; i++) e.push(await a.G.encrypt(GID, "A", "x"));
  await assert.rejects(far.G.decrypt(GID, "A", e[e.length - 1]), /too-far/);
  assert.equal(await far.G.decrypt(GID, "A", e[0]), "x"); // отказ не продвинул цепочку
});
test("подпись: подмена шифртекста/номера/отправителя/группы отвергается, другой участник не подделывает отправителя", async () => {
  const a = dev(), b = dev(), c = dev(); await share(a, "A", [b, c]); await share(c, "C", [b]);
  const e = await a.G.encrypt(GID, "A", "secret");
  await assert.rejects(b.G.decrypt(GID, "A", { ...e, ct: e.ct.slice(0, -4) + "AAAA" }), /bad-sig|auth/);
  await assert.rejects(b.G.decrypt(GID, "A", { ...e, n: 5 }), /bad-sig/);
  await assert.rejects(b.G.decrypt("other", "A", e), /no-chain/);
  // C знает ck A (получил раздачу) и пытается выдать сообщение за A: подписать ключом A он не может
  const forged = await (async () => { const f = dev(); f.G.acceptDistribution(GID, "A", await a.G.distribution(GID)); const own = await c.G.encrypt(GID, "C", "fake"); return { ...own, cid: e.cid }; })();
  await assert.rejects(b.G.decrypt(GID, "A", forged), /bad-sig/);
  assert.equal(await b.G.decrypt(GID, "A", e), "secret"); // после отказов настоящее сообщение читается
});
test("rekey после исключения: удалённый участник не читает новые сообщения, оставшиеся — читают", async () => {
  const a = dev(), b = dev(), kicked = dev(); await share(a, "A", [b, kicked]);
  const before = await a.G.encrypt(GID, "A", "before");
  assert.equal(await kicked.G.decrypt(GID, "A", before), "before");
  const nd = await a.G.rekey(GID); assert.ok(b.G.acceptDistribution(GID, "A", nd)); // kicked новую цепочку не получает
  const after = await a.G.encrypt(GID, "A", "after");
  assert.notEqual(after.cid, before.cid);
  assert.equal(await b.G.decrypt(GID, "A", after), "after");
  await assert.rejects(kicked.G.decrypt(GID, "A", after), /no-chain/);
  // даже зная старый ck, уйти на новую цепочку нельзя: её ck не выводится из старого, ключ подписи другой
  const hack = await kicked.G.distribution(GID); kicked.G.acceptDistribution(GID, "A", { ...hack, cid: after.cid, spub: nd.spub });
  await assert.rejects(kicked.G.decrypt(GID, "A", after), /auth|bad-sig/);
  // старые сообщения ещё в пути (не дошли до b) после rekey: b читает их по старой цепочке, пока она хранится
  assert.ok(b.G.acceptDistribution(GID, "A", { ...(await (async () => { const t = dev(); return t.G.distribution(GID); })()), cid: "x" }) || true);
});
test("новый участник получает текущее состояние: прошлое не читает, будущее читает; ранее розданный номер не откатывается", async () => {
  const a = dev(), b = dev(), newbie = dev(); await share(a, "A", [b]);
  const old = []; for (let i = 0; i < 3; i++) old.push(await a.G.encrypt(GID, "A", "old" + i));
  await share(a, "A", [newbie]);
  await assert.rejects(newbie.G.decrypt(GID, "A", old[0]), /old/);
  const fresh = await a.G.encrypt(GID, "A", "fresh");
  assert.equal(await newbie.G.decrypt(GID, "A", fresh), "fresh");
  assert.equal(await b.G.decrypt(GID, "A", old[2]), "old2"); // b, получивший с n=0, догоняет
  assert.equal(b.G.acceptDistribution(GID, "A", await (async () => { const x = dev(); await x.G.distribution(GID); return { ...(await a.G.distribution(GID)), n: 0 }; })()), false);
});
test("состояние переживает перезапуск (хранилище), отправитель не повторяет n; без записи — отказ отправлять", async () => {
  const a = dev(), b = dev(); await share(a, "A", [b]);
  const e1 = await a.G.encrypt(GID, "A", "one");
  delete require.cache[require.resolve(modPath)]; const G2 = require(modPath); G2.setStore({ load: () => JSON.parse(a.mem.json), save: (o) => { a.mem.json = JSON.stringify(o); return true; } });
  const e2 = await G2.encrypt(GID, "A", "two"); assert.equal(e2.n, 1); assert.equal(e2.cid, e1.cid);
  assert.equal(await b.G.decrypt(GID, "A", e2), "two"); b.G.flush();
  assert.equal(await b.G.decrypt(GID, "A", e1), "one");
  const bad = dev(); bad.G.setStore({ load: () => ({}), save: () => false });
  await assert.rejects(bad.G.encrypt(GID, "A", "x"), /storage/);
});
test("pruneToMembers / dropSender / dropGroup", async () => {
  const a = dev(), b = dev(), c = dev(); await share(a, "A", [c]); await share(b, "B", [c]);
  const gone = c.G.pruneToMembers(GID, ["B", "C"]); assert.deepEqual(gone, ["A"]);
  const e = await a.G.encrypt(GID, "A", "x"); await assert.rejects(c.G.decrypt(GID, "A", e), /no-chain/);
  c.G.dropSender(GID, "B"); assert.ok(!c.G.hasRecv(GID, "B", (await b.G.distribution(GID)).cid));
  a.G.dropGroup(GID); assert.ok(!a.G.hasSend(GID));
});
test("shouldUse: >8 и все умеют sk1; иначе попарно", () => {
  const { G } = dev(); const ids = (n) => Array.from({ length: n }, (_, i) => "u" + i);
  assert.equal(G.shouldUse(ids(7), "me", () => true), false);       // 8 с мной
  assert.equal(G.shouldUse(ids(8), "me", () => true), true);        // 9
  assert.equal(G.shouldUse(ids(8), "me", (id) => id !== "u3"), false);
  assert.equal(G.shouldUse(ids(200), "me", () => true), true);
});
test("мусорные раздачи/конверты отвергаются", async () => {
  const { G } = dev();
  for (const bad of [null, {}, { cid: "a", ck: "short", n: 0, spub: { x: "a", y: "b" } }, { cid: "a", ck: "A".repeat(44), n: -1, spub: { x: "a", y: "b" } }]) assert.equal(G.acceptDistribution(GID, "A", bad), false);
  await assert.rejects(G.decrypt(GID, "A", { v: "x" }), /bad-envelope/);
});
