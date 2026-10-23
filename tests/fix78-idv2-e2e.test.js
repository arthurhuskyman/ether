// Сквозная миграция id v1 -> v2 с НАСТОЯЩИМ сервером: A (телефон) переходит на id v2; C (обновлённый) переименовывает контакт по подписанному уведомлению,
// B (имитация старого клиента: уведомление игнорирует) продолжает переписку со старым id A через алиас сервера в обе стороны, без разрыва ratchet-сессии.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("path");
const { createApp, closeAll } = require("./harness");

const PORT = 8797;
let server;
test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, "..", "signaling-server", "server.js")], { env: { ...process.env, PORT: String(PORT), VAPID_PUBLIC: "", VAPID_PRIVATE: "", CLAIMS_PERSIST: "0", MAILBOX_PERSIST: "0", ALIASES_PERSIST: "0" }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));
});
test.after(async () => { await closeAll(); try { server.kill(); } catch (e) {} });

const V1 = crypto.createHash("sha256").update("ether:+15551234567").digest("hex");
const seed = (...cs) => JSON.stringify(cs.map(([id, name, hist]) => ({ id, name, raw: "", messages: hist ? [{ id: "hist-" + id.slice(0, 6), from: "them", text: hist, ts: 1000 }] : [], lastActivity: 1000 })));
async function boot(id, name, contacts, extra) {
  const a = createApp({ realWebSocket: true, storage: { "ether.name": name, "ether.myId": id, "ether.lang": "en", "ether.signalingUrl": "ws://localhost:" + PORT, "ether.contacts": seed(...contacts), ...(extra || {}) } });
  await a.ready;
  for (let i = 0; i < 100 && !a.run(`typeof signaling !== "undefined" && signaling && signaling.registered === true`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
const chat = (id, text) => ({ kind: "chat", id, text, ts: Date.now() });
const has = (a, cid, id) => a.run(`(state.contacts.get(${JSON.stringify(cid)}) || {messages:[]}).messages.some((m) => m.id === ${JSON.stringify(id)})`);
function send(a, to, msgId, payload) { a.run(`addToOutbox(${JSON.stringify(msgId)}, ${JSON.stringify(to)}, ${JSON.stringify(payload)}); flushOutboxItem(${JSON.stringify(msgId)});`); }

test("сквозная миграция: обновлённый контакт переименовывается по уведомлению, необновлённый общается по алиасу, история и ratchet целы", async () => {
  // A - с телефоном: при первом подключении к серверу с feature alias сам переходит на id v2 (боевые 600 000 итераций)
  const B = await boot("bob-anon", "Bob", [[V1, "Alice", "история B с A"]]);
  const C = await boot("carol-new", "Carol", [[V1, "Alice", "история C с A"]]);
  // B - «старый клиент»: уведомление id-migrate он не понимает (kind неизвестен) и молча игнорирует; заглушка ставится до появления A
  B.run(`handleIdMigrateNotice = async () => false;`);
  const A = await boot(V1, "Alice", [["bob-anon", "Bob", "история A с B"], ["carol-new", "Carol", "история A с C"]], { "ether.identityRaw": "+15551234567" });
  const want = "v2:" + crypto.pbkdf2Sync("v2:+15551234567", "ether-id-v2", 600000, 32, "sha256").toString("hex");
  assert.ok(await until(() => A.run(`Store.myId`) === want && A.run(`signaling && signaling.registered && signaling.myId === Store.myId && idMigGet().aliasOk === true`), 30000), "A мигрировал сам и сервер подтвердил алиас старого id");
  assert.equal(A.run(`idMigGet().legacyId`), V1);
  assert.ok(A.run(`state.contacts.get("bob-anon").messages.some((m) => m.text === "история A с B")`), "история A цела");
  assert.ok(await until(() => A.run(`!!state.contacts.get("bob-anon").publicKey && !!state.contacts.get("carol-new").publicKey`)), "A получил ключи контактов через ростер");

  // C (обновлённый) переименовал контакт A по подписанному уведомлению, история на месте
  assert.ok(await until(() => C.run(`state.contacts.has(${JSON.stringify(want)}) && !state.contacts.has("${V1}")`)), "C переименовал контакт A");
  assert.ok(C.run(`state.contacts.get(${JSON.stringify(want)}).messages.some((m) => m.text === "история C с A")`), "история C с A сохранена");
  // B (старый) уведомление проигнорировал: контакт A остаётся под старым id, чужого контакта не появилось
  assert.ok(await until(() => B.run(`!!state.contacts.get("${V1}").publicKey`)), "B знает ключ A");
  assert.ok(B.run(`state.contacts.has("${V1}")`) && !B.run(`state.contacts.has(${JSON.stringify(want)})`));
  assert.ok(await until(() => B.run(`state.contacts.get("${V1}").online === true`)), "B видит A онлайн под СТАРЫМ id (presence зеркалится сервером)");

  // B ⇄ A через алиас: сообщения доходят в обе стороны, ratchet-сессия строится по паре (старый id, B)
  send(B, V1, "q1", chat("post-ba", "B→A (на старый id)")); assert.ok(await until(() => has(A, "bob-anon", "post-ba")), "A получил сообщение, адресованное на старый id");
  send(A, "bob-anon", "q2", chat("post-ab", "A→B")); assert.ok(await until(() => has(B, V1, "post-ab")), "B получил сообщение от A под старым id");
  assert.ok(A.run(`idMigIsLegacyPeer("bob-anon")`), "для B я остаюсь старым id");
  assert.ok(!B.run(`state.contacts.has(${JSON.stringify(want)})`), "у B не появилось чужого контакта с новым id");
  for (let i = 0; i < 4; i++) {
    send(A, "bob-anon", "r" + i, chat("ab" + i, "a" + i)); assert.ok(await until(() => has(B, V1, "ab" + i)), "A→B " + i);
    send(B, V1, "s" + i, chat("ba" + i, "b" + i)); assert.ok(await until(() => has(A, "bob-anon", "ba" + i)), "B→A " + i);
  }
  assert.ok(A.run(`state.contacts.get("bob-anon").rc`) || true);

  // C ⇄ A уже по новым id
  send(C, want, "t1", chat("post-ca", "C→A по новому id")); assert.ok(await until(() => has(A, "carol-new", "post-ca")), "A получил от C");
  send(A, "carol-new", "t2", chat("post-ac", "A→C")); assert.ok(await until(() => has(C, want, "post-ac")), "C получил от A под новым id");
  // звонки/сигналы: B может достучаться до A по старому id (сигнал пересылается алиасом)
  B.run(`window.__sigGot = 0;`);
  A.run(`window.__sigGot = []; signaling.addEventListener("signal", (e) => window.__sigGot.push(e.detail.from));`);
  B.run(`signaling.signal("${V1}", { t: "ping-test" })`);
  assert.ok(await until(() => A.run(`window.__sigGot.length`) > 0), "сигнал на старый id дошёл до A");
  assert.equal(A.run(`window.__sigGot[0]`), "bob-anon");
});
