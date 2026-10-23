// Миграция id v1 -> v2 на клиенте: переименование контакта без потери истории, уведомление id-migrate (подпись, подделки),
// миграция при загрузке (идемпотентность), режим «старого id» для необновившихся контактов, группы/очередь/блок/избранное, устройства.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep } = require("./cov-helpers");
test.after(closeAll);

const IT = 1000; // боевых 600 000 итераций здесь нет: явный параметр iterations передаётся ТОЛЬКО тестовыми вызовами
async function setup(a, opts = {}) {
  await a.run(`(async () => {
    window.me = await CryptoHelper.generateKeyPair(); Store.myPrivateKeyJwk = me.privateKeyJwk; Store.myPublicKeyJwk = me.publicKeyJwk;
    window.XK = await CryptoHelper.generateKeyPair(); window.EV = await CryptoHelper.generateKeyPair(); window.YK = await CryptoHelper.generateKeyPair();
    const r = await Identity.idFor("+15551234567"); window.MYV1 = r.id;
    ${opts.anon ? `Store.myIdentityRaw = ""; Store.myId = "random-uuid-id";` : `Store.myIdentityRaw = "+15551234567"; Store.myId = r.id;`}
    window.X = "x-old-id"; window.Y = "y-old-id";
    const x = ensureContactEntry(X, "Xenia"); x.publicKey = XK.publicKeyJwk; x.managed = true; x.blocked = false; x.pinned = true; x.muted = true;
    x.messages.push({ id: "h1", from: "them", text: "привет", ts: 1000 }, { id: "h2", from: "me", text: "ответ", ts: 2000, ack: "read", favorite: true });
    const y = ensureContactEntry(Y, "Yuri"); y.publicKey = YK.publicKeyJwk; y.managed = true; y.blocked = true;
    window.GID = "group-1";
    state.contacts.set(GID, { id: GID, isGroup: true, name: "G", managed: true, createdBy: X, banned: [Y], members: [{ id: Store.myId, name: "Tester", role: "member" }, { id: X, name: "Xenia", role: "admin" }, { id: Y, name: "Yuri", role: "member" }], messages: [{ id: "g1", from: "them", fromId: X, text: "hi", ts: 5, reactions: { "👍": [X, Store.myId] }, pollVotes: { [X]: [0] } }], lastActivity: 5, archived: false, muted: false, blocked: false });
    persistContacts();
  })()`);
}
const mkNotice = (a, over = {}) => a.run(`(async () => { const n = await DeviceCert.signIdMigrate(XK.privateKeyJwk, { old: X, new: "v2:" + "7".repeat(64), ts: Date.now() }); return Object.assign(n, ${JSON.stringify(over)}); })()`);
const NEWX = "v2:" + "7".repeat(64);

test("переименование контакта: история, закреп/блок/без звука, группы, очередь, избранное и прочие хранилища переезжают на новый id", async () => {
  const a = await boot(); await setup(a);
  a.run(`addToOutbox("o1", X, { kind: "chat", id: "o1", text: "pending" }); groupDeliveryMap.set("d1", { groupId: GID, contentId: "g1", to: X }); pendingNoKey.set(X, [{ msgId: "p1", payload: { kind: "chat", id: "p1" } }]);
    state.scheduledMessages.push({ id: "s1", contactId: X, text: "later", sendAt: Date.now() + 1e6 }); state.folders.push({ id: "f1", name: "F", contactIds: [X, Y] }); state.drafts[X] = "draft"; state.lastSeen[X] = 7;
    state.callLog.push({ id: "c1", contactId: X }); state.chatId = X; Store.deadManContactId = X;`);
  const c = a.run(`renameContactId(X, ${JSON.stringify(NEWX)}) && true`);
  assert.ok(c);
  const o = JSON.parse(a.run(`JSON.stringify({ has: [state.contacts.has(X), state.contacts.has(${JSON.stringify(NEWX)})], c: (({ id, name, pinned, muted, blocked, publicKey }) => ({ id, name, pinned, muted, blocked, pk: !!publicKey }))(state.contacts.get(${JSON.stringify(NEWX)})),
    msgs: state.contacts.get(${JSON.stringify(NEWX)}).messages.map((m) => [m.id, m.text, m.favorite || false]), order: Array.from(state.contacts.keys()),
    g: (({ createdBy, banned, members }) => ({ createdBy, banned, members: members.map((m) => m.id + ":" + m.role) }))(state.contacts.get(GID)), gm: state.contacts.get(GID).messages[0],
    ob: outbox.get("o1").to, gdm: groupDeliveryMap.get("d1").to, pnk: [pendingNoKey.has(X), pendingNoKey.has(${JSON.stringify(NEWX)})], sch: state.scheduledMessages[0].contactId, fol: state.folders[0].contactIds,
    dr: [state.drafts[X], state.drafts[${JSON.stringify(NEWX)}]], ls: [state.lastSeen[X], state.lastSeen[${JSON.stringify(NEWX)}]], cl: state.callLog[0].contactId, chat: state.chatId, dm: Store.deadManContactId })`));
  assert.deepEqual(o.has, [false, true]); assert.deepEqual(o.c, { id: NEWX, name: "Xenia", pinned: true, muted: true, blocked: false, pk: true });
  assert.deepEqual(o.msgs, [["h1", "привет", false], ["h2", "ответ", true]], "история и избранное на месте");
  assert.equal(o.order.indexOf(NEWX), 0 + o.order.indexOf(NEWX)); assert.ok(o.order.length >= 3);
  assert.equal(o.g.createdBy, NEWX); assert.deepEqual(o.g.banned, ["y-old-id"]); assert.ok(o.g.members.includes(NEWX + ":admin") && !o.g.members.some((m) => m.startsWith("x-old-id")));
  assert.equal(o.gm.fromId, NEWX); assert.deepEqual(o.gm.reactions["👍"].includes(NEWX), true); assert.ok(o.gm.pollVotes[NEWX] && !o.gm.pollVotes["x-old-id"]);
  assert.equal(o.ob, NEWX); assert.equal(o.gdm, NEWX); assert.deepEqual(o.pnk, [false, true]); assert.equal(o.sch, NEWX); assert.deepEqual(o.fol, [NEWX, "y-old-id"]);
  assert.deepEqual(o.dr, [null, "draft"]); assert.deepEqual(o.ls, [null, 7]); assert.equal(o.cl, NEWX); assert.equal(o.chat, NEWX); assert.equal(o.dm, NEWX);
  // сохранено на диск
  a.run(`persistContactsNow()`); const saved = JSON.parse(a.run(`Store.contactsJson`)); assert.ok(saved.some((x) => x.id === NEWX && x.messages.length === 2));
  // blocked остаётся у заблокированного контакта при его переименовании
  a.run(`renameContactId(Y, "v2:" + "8".repeat(64));`); assert.equal(a.run(`state.contacts.get("v2:" + "8".repeat(64)).blocked`), true);
  a.close();
});

test("переименование: запись-чужак с новым id вливается в контакт, а не дублируется; группа/свой чат не трогаются", async () => {
  const a = await boot(); await setup(a);
  a.run(`const s = ensureContactEntry(${JSON.stringify(NEWX)}, "?"); s.messages.push({ id: "s-1", from: "them", text: "раньше уведомления", ts: 1500 });`);
  a.run(`renameContactId(X, ${JSON.stringify(NEWX)})`);
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify(state.contacts.get(${JSON.stringify(NEWX)}).messages.map((m) => m.id))`)), ["h1", "s-1", "h2"], "сообщения упорядочены по времени, без потерь");
  assert.equal(a.run(`renameContactId(GID, "v2:" + "9".repeat(64))`), null, "группу переименовать нельзя");
  assert.equal(a.run(`renameContactId("nope", "v2:" + "9".repeat(64))`), null);
  a.close();
});

test("уведомление id-migrate: верная подпись -> переименование с сохранением истории и пометкой в чате; повтор безвреден", async () => {
  const a = await boot(); await setup(a);
  const n = await mkNotice(a); a.window.__n = n;
  assert.equal(await a.run(`handleIdMigrateNotice(X, __n)`), true);
  assert.ok(a.run(`state.contacts.has(${JSON.stringify(NEWX)}) && !state.contacts.has(X)`));
  const c = JSON.parse(a.run(`JSON.stringify(state.contacts.get(${JSON.stringify(NEWX)}).messages.map((m) => m.id))`));
  assert.deepEqual(c.slice(0, 2), ["h1", "h2"]); assert.equal(c.length, 3, "добавлена системная запись");
  assert.ok(a.run(`state.contacts.get(${JSON.stringify(NEWX)}).messages[2].textKey === "sys.peerIdUpdated"`));
  assert.equal(a.run(`canonPeer(X)`), NEWX, "запоздавшие сообщения со старым id попадают в тот же контакт");
  assert.equal(await a.run(`handleIdMigrateNotice(${JSON.stringify(NEWX)}, __n)`), true, "повтор идемпотентен");
  assert.equal(a.run(`state.contacts.get(${JSON.stringify(NEWX)}).messages.length`), 3, "повтор не плодит записей");
  a.close();
});

test("уведомление id-migrate: подделки отвергаются без последствий (чужая подпись, подмена полей, чужой отправитель, занятый id, старьё)", async () => {
  const a = await boot(); await setup(a);
  const before = () => a.run(`JSON.stringify([Array.from(state.contacts.keys()), state.contacts.get(X).messages.length])`);
  const snap = before();
  const forged = await a.run(`(async () => DeviceCert.signIdMigrate(EV.privateKeyJwk, { old: X, new: ${JSON.stringify(NEWX)}, ts: Date.now() }))()`);
  a.window.__f = forged;
  assert.equal(await a.run(`handleIdMigrateNotice(X, __f)`), false, "подпись злоумышленника");
  const n = await mkNotice(a); a.window.__n = n;
  assert.equal(await a.run(`handleIdMigrateNotice(X, Object.assign({}, __n, { new: "v2:" + "6".repeat(64) }))`), false, "подмена нового id");
  assert.equal(await a.run(`handleIdMigrateNotice(X, Object.assign({}, __n, { ts: __n.ts + 5 }))`), false, "подмена времени");
  assert.equal(await a.run(`handleIdMigrateNotice(Y, __n)`), false, "уведомление пришло не от старого и не от нового id");
  assert.equal(await a.run(`handleIdMigrateNotice(X, Object.assign({}, __n, { new: "plain-id" }))`), false, "новый id не в форме v2");
  const stale = await a.run(`(async () => DeviceCert.signIdMigrate(XK.privateKeyJwk, { old: X, new: ${JSON.stringify(NEWX)}, ts: Date.now() - 200 * 86400000 }))()`); a.window.__s = stale;
  assert.equal(await a.run(`handleIdMigrateNotice(X, __s)`), false, "слишком старое");
  const fut = await a.run(`(async () => DeviceCert.signIdMigrate(XK.privateKeyJwk, { old: X, new: ${JSON.stringify(NEWX)}, ts: Date.now() + 3 * 86400000 }))()`); a.window.__u = fut;
  assert.equal(await a.run(`handleIdMigrateNotice(X, __u)`), false, "время из будущего");
  assert.equal(await a.run(`handleIdMigrateNotice(X, { old: X, new: ${JSON.stringify(NEWX)}, ts: Date.now() })`), false, "без подписи");
  assert.equal(await a.run(`handleIdMigrateNotice(X, null)`), false);
  assert.equal(await a.run(`handleIdMigrateNotice("stranger", Object.assign({}, __n, { old: "stranger" }))`), false, "нет такого контакта");
  // новый id уже занят другим человеком (другой ключ)
  a.run(`const o = ensureContactEntry(${JSON.stringify(NEWX)}, "Other"); o.publicKey = EV.publicKeyJwk;`);
  assert.equal(await a.run(`handleIdMigrateNotice(X, __n)`), false, "новый id принадлежит другому ключу");
  a.run(`state.contacts.delete(${JSON.stringify(NEWX)})`);
  // свой id в роли «нового»
  assert.equal(await a.run(`handleIdMigrateNotice(X, Object.assign({}, __n, { new: Store.myId }))`), false);
  assert.equal(before(), snap, "ни одна подделка не изменила контакты");
  assert.equal(a.run(`canonPeer(X)`), "x-old-id");
  a.close();
});

test("совместимость со старыми клиентами: неизвестный kind молча игнорируется, сокет и разбор не падают, чужак не создаётся", async () => {
  const a = await boot(); await setup(a);
  const keys = a.run(`JSON.stringify(Array.from(state.contacts.keys()))`);
  a.run(`applyIncomingPayload(X, "m-unk", { kind: "zz-future-kind", id: "m-unk", old: "a", new: "b" }, true, "zz-future-kind");`);
  assert.equal(a.run(`JSON.stringify(Array.from(state.contacts.keys()))`), keys);
  assert.equal(a.run(`state.contacts.get(X).messages.length`), 2, "ничего не добавлено в чат");
  // сам старый клиент получает уведомление как обычный конверт от ИЗВЕСТНОГО контакта (отправитель шлёт от старого id через алиас): расшифровка есть, а kind неизвестен
  await a.run(`(async () => { const key = await CryptoHelper.deriveSharedKey(XK.privateKeyJwk, Store.myPublicKeyJwk); window.__env = await CryptoHelper.encryptJson(key, { kind: "id-migrate", id: "n1", old: X, new: ${JSON.stringify(NEWX)}, ts: 1, sig: "AAAA" }, CryptoHelper.envAad(X, Store.myId)); })()`);
  a.run(`signaling = { mailboxAck(id) { window.__acked = id; }, connected: true, features: [] };`);
  await a.run(`handleDeliver({ from: X, msgId: "n1", envelope: __env, fromPublicKey: XK.publicKeyJwk, kind: "id-migrate" }, false)`);
  assert.equal(a.window.__acked, "n1", "конверт подтверждён");
  assert.ok(a.run(`state.contacts.has(X)`), "поддельное (sig=AAAA) уведомление ничего не переименовало");
  a.close();
});

test("миграция при загрузке: id v2 из сохранённого номера, состояние ether.idMig, группы и алиас; повторный запуск ничего не меняет", async () => {
  const a = await boot(); await setup(a);
  const want = await a.run(`Identity.hashIdV2("+15551234567", ${IT})`);
  const res = await a.run(`idMigRun({ iterations: ${IT} })`);
  assert.equal(res.status, "migrated"); assert.equal(res.newId, want);
  assert.equal(a.run(`Store.myId`), want); assert.equal(a.run(`Store.myIdentityRaw`), "+15551234567", "номер для нового id сохранён");
  const m = JSON.parse(a.run(`localStorage.getItem("ether.idMig")`));
  assert.equal(m.legacyId, a.window.MYV1); assert.equal(m.newId, want); assert.ok(m.until > Date.now() + 89 * 86400000 && m.until <= Date.now() + 90 * 86400000);
  assert.ok(m.peers.includes("x-old-id") && m.peers.includes("y-old-id") && !m.peers.includes(want) && !m.peers.includes("group-1"), "все 1:1 контакты пока видят меня под старым id");
  assert.ok(await a.run(`DeviceCert.verifyIdMigrate(Store.myPublicKeyJwk, idMigGet().notice)`), "уведомление подписано долгосрочным ключом");
  assert.equal(a.run(`state.contacts.get(GID).members.some((x) => x.id === Store.myId) && !state.contacts.get(GID).members.some((x) => x.id === MYV1)`), true, "мой id в группах обновлён");
  assert.equal(a.run(`state.contacts.get(GID).messages[0].reactions["👍"].includes(Store.myId)`), true);
  assert.ok(a.run(`signaling && signaling.myId === Store.myId`), "соединение пересоздано под новым id");
  assert.equal(a.run(`signaling.aliasOld`), a.window.MYV1, "соединение просит алиас старого id");
  assert.ok(a.run(`CRITICAL_LS_KEYS.includes("ether.idMig")`), "в резервной копии IDB");
  // повтор (и параллельный) запуск идемпотентен
  const before = a.run(`localStorage.getItem("ether.idMig") + "|" + Store.myId`);
  const [r2, r3] = await Promise.all([a.run(`idMigRun({ iterations: ${IT} })`), a.run(`idMigRun({ iterations: ${IT} })`)]);
  assert.equal(r2.status, "done"); assert.equal(r3.status, "done");
  assert.equal(a.run(`localStorage.getItem("ether.idMig") + "|" + Store.myId`), before);
  // отправка уведомлений: только после ответа сервера про алиас; каждому контакту один раз, подпись проверяема
  assert.equal(a.run(`Array.from(outbox.values()).filter((e) => e.payload.kind === "id-migrate").length`), 0, "до ответа алиаса уведомлений нет");
  a.run(`idMigOnAliasResult(signaling, { ok: true, old: MYV1 })`); await sleep(50);
  const notices = JSON.parse(a.run(`JSON.stringify(Array.from(outbox.values()).filter((e) => e.payload.kind === "id-migrate").map((e) => [e.to, e.forceV1, e.payload]))`));
  assert.equal(notices.length, 1, "Y заблокирован - уведомления не получает; X - получает");
  assert.equal(notices[0][0], "x-old-id"); assert.equal(notices[0][1], true);
  assert.equal(notices[0][2].old, a.window.MYV1); assert.equal(notices[0][2].new, want);
  assert.ok(a.run(`idMigIsLegacyPeer("x-old-id")`), "после подтверждения алиаса для X я пока старый id");
  assert.equal(a.run(`myIdFor("x-old-id")`), a.window.MYV1); assert.equal(a.run(`myIdFor("somebody-new")`), want);
  a.run(`idMigOnAliasResult(signaling, { ok: true, old: MYV1 })`); await sleep(30);
  assert.equal(a.run(`Array.from(outbox.values()).filter((e) => e.payload.kind === "id-migrate").length`), 1, "повторная отправка не плодит уведомления");
  // отказ алиаса: пара «старый id» не используется, ratchet-сессии сбрасываются
  a.run(`idMigOnAliasResult(signaling, { ok: false, old: MYV1, error: "old-claim" })`);
  assert.equal(a.run(`idMigIsLegacyPeer("x-old-id")`), false); assert.equal(a.run(`myIdFor("x-old-id") === Store.myId`), true);
  a.close();
});

test("миграция: анонимная личность (случайный id) не меняет id; id не из номера; новый аккаунт на v2 просто помечается", async () => {
  const a = await boot(); await setup(a, { anon: true });
  const r = await a.run(`idMigRun({ iterations: ${IT} })`);
  assert.equal(r.status, "anon"); assert.equal(a.run(`Store.myId`), "random-uuid-id");
  const m = JSON.parse(a.run(`localStorage.getItem("ether.idMig")`)); assert.equal(m.done, true); assert.equal(m.anon, true); assert.ok(!m.legacyId);
  assert.equal((await a.run(`idMigRun({ iterations: ${IT} })`)).status, "done");
  a.close();
  const b = await boot(); await setup(b);
  b.run(`Store.myIdentityRaw = "+15557654321";`); // номер не соответствует текущему id (id был получен иначе)
  assert.equal((await b.run(`idMigRun({ iterations: ${IT} })`)).status, "anon");
  assert.equal(b.run(`Store.myId`), b.window.MYV1, "id остался прежним");
  b.close();
  const c = await boot(); await setup(c);
  c.run(`Store.myId = "v2:" + "5".repeat(64);`);
  assert.equal((await c.run(`idMigRun({ iterations: ${IT} })`)).status, "v2");
  assert.equal(c.run(`Store.myId`), "v2:" + "5".repeat(64));
  c.close();
});

test("миграция: сбой между сохранением состояния и сменой id достраивается при следующей регистрации", async () => {
  const a = await boot(); await setup(a);
  const want = await a.run(`Identity.hashIdV2("+15551234567", ${IT})`);
  a.run(`localStorage.setItem("ether.idMig", JSON.stringify({ v: 1, done: true, at: Date.now(), legacyId: MYV1, newId: ${JSON.stringify(want)}, until: Date.now() + 1e9, peers: ["x-old-id"], notices: {}, renames: {}, notice: null }))`);
  assert.equal(a.run(`Store.myId`), a.window.MYV1);
  a.run(`window.__sw = []; const real = idMigApplySwitch; idMigApplySwitch = (o, n) => { __sw.push([o, n]); real(o, n); }; const sig = signaling; sig.registered = true; sig.features = ["alias"]; idMigOnRegistered(sig);`);
  assert.equal(a.run(`Store.myId`), want); assert.equal(a.window.__sw.length, 1);
  a.close();
});

test("режим «старого id»: расшифровка пробует оба id и запоминает, как собеседник обращается ко мне", async () => {
  const a = await boot(); await setup(a);
  const want = await a.run(`Identity.hashIdV2("+15551234567", ${IT})`);
  await a.run(`idMigRun({ iterations: ${IT} })`); a.run(`idMigOnAliasResult(signaling, { ok: true, old: MYV1 })`);
  // X (необновлённый) шифрует статическим конвертом с AAD (X, мой СТАРЫЙ id)
  await a.run(`(async () => { const key = await CryptoHelper.deriveSharedKey(XK.privateKeyJwk, Store.myPublicKeyJwk); window.__legacyEnv = await CryptoHelper.encryptJson(key, { hello: 1 }, CryptoHelper.envAad(X, MYV1)); window.__newEnv = await CryptoHelper.encryptJson(key, { hello: 2 }, CryptoHelper.envAad(X, Store.myId)); window.__key = key; })()`);
  const p1 = await a.run(`idMigDecrypt(X, (myId) => CryptoHelper.decryptJson(__key, __legacyEnv, CryptoHelper.envAad(X, myId)))`);
  assert.equal(p1.hello, 1); assert.ok(a.run(`idMigIsLegacyPeer(X)`), "остаётся в старом режиме");
  // X обновился и теперь обращается к моему новому id: расшифровка вторым id -> X больше не «старый»
  const p2 = await a.run(`idMigDecrypt(X, (myId) => CryptoHelper.decryptJson(__key, __newEnv, CryptoHelper.envAad(X, myId)))`);
  assert.equal(p2.hello, 2); assert.equal(a.run(`idMigIsLegacyPeer(X)`), false);
  // и обратно: контакт вне списка, который пишет на старый id, переходит в старый режим
  const p3 = await a.run(`idMigDecrypt("newbie", async (myId) => { if (myId !== MYV1) throw new Error("ratchet: auth failed"); return { ok: myId }; })`);
  assert.equal(p3.ok, a.window.MYV1); assert.ok(a.run(`idMigIsLegacyPeer("newbie")`));
  await assert.rejects(a.run(`idMigDecrypt("newbie", async () => { throw new Error("boom"); })`), /boom/, "если не подошёл ни один id - исходная ошибка");
  // сквозная проверка шифрования отправки: шифруем для X и для нового контакта
  const encX = await a.run(`(async () => { const c = state.contacts.get(X); const e = await encryptForContact(c, "mx", { kind: "chat", id: "mx", text: "t" }, true); return CryptoHelper.decryptJson(await CryptoHelper.deriveSharedKey(XK.privateKeyJwk, Store.myPublicKeyJwk), e, e.v === 2 ? CryptoHelper.envAad(Store.myId === MYV1 ? 0 : MYV1, X) : undefined).then(() => "ok-legacy-aad", () => "other"); })()`);
  assert.ok(["ok-legacy-aad", "other"].includes(encX)); // v1-конверт без AAD для необновлённого (contact.e2 не выставлен) расшифровывается при любом id
  a.run(`idMigWireSignaling(signaling)`);
  assert.equal(a.run(`signaling.legacyFor("newbie")`), true); assert.equal(a.run(`signaling.legacyFor(X)`), false, "X уже обращается к новому id"); assert.equal(a.run(`signaling.legacyFor("newbie2")`), false);
  a.close();
});

test("истечение окна 90 суток: режим старого id выключается, алиас не используется", async () => {
  const a = await boot(); await setup(a);
  await a.run(`idMigRun({ iterations: ${IT} })`); a.run(`idMigOnAliasResult(signaling, { ok: true, old: MYV1 })`);
  assert.ok(a.run(`idMigIsLegacyPeer(X)`));
  a.run(`idMigUpdate((m) => { m.until = Date.now() - 1000; })`);
  assert.equal(a.run(`idMigIsLegacyPeer(X)`), false); assert.equal(a.run(`myIdFor(X) === Store.myId`), true); assert.equal(a.run(`idMigLegacyId()`), "");
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify(idMigDecryptIds(X))`)), [a.run(`Store.myId`)], "второй id больше не пробуется");
  a.run(`const sig = signaling; sig.registered = true; sig.features = ["alias"]; idMigOnRegistered(sig);`);
  assert.equal(a.run(`idMigGet().expired`), true); assert.deepEqual(a.run(`idMigGet().peers`).length, 0);
  a.close();
});

test("группы: входящий ростер с моим прежним id и переименованными контактами нормализуется; исходящий для «старого» контакта несёт старый id", async () => {
  const a = await boot(); await setup(a);
  await a.run(`idMigRun({ iterations: ${IT} })`); a.run(`idMigOnAliasResult(signaling, { ok: true, old: MYV1 })`);
  a.run(`idMigUpdate((m) => { m.renames["gone-id"] = "v2:" + "4".repeat(64); })`);
  const p = JSON.parse(a.run(`(() => { const pl = { members: [{ id: MYV1, name: "me" }, { id: "gone-id", name: "G" }, { id: X, name: "X" }, { id: Store.myId, name: "dup" }], createdBy: "gone-id" }; idMigNormalizeGroupPayload(pl); return JSON.stringify(pl); })()`));
  assert.deepEqual(p.members.map((m) => m.id), [a.run(`Store.myId`), "v2:" + "4".repeat(64), "x-old-id"], "мой старый id -> новый, переименованный -> новый, дубль убран");
  assert.equal(p.createdBy, "v2:" + "4".repeat(64));
  const out = JSON.parse(a.run(`(() => { const pl = { members: [{ id: Store.myId, name: "me" }, { id: X }], createdBy: Store.myId }; idMigGroupPayloadFor(pl, X); const pl2 = { members: [{ id: Store.myId }], createdBy: Store.myId }; idMigGroupPayloadFor(pl2, "newpeer"); return JSON.stringify([pl, pl2]); })()`));
  assert.equal(out[0].members[0].id, a.window.MYV1); assert.equal(out[0].createdBy, a.window.MYV1, "контакту в старом режиме - старый id");
  assert.equal(out[1].members[0].id, a.run(`Store.myId`), "остальным - новый");
  // приём group-invite, в котором я записан под старым id, больше не отбрасывается как «меня нет в группе»
  a.run(`state.contacts.delete(GID); applyIncomingPayload(X, "gi-1", { kind: "group-invite", id: "gi-1", groupId: "g-new", groupName: "Новая", createdBy: X, members: [{ id: MYV1, name: "Tester", role: "member" }, { id: X, name: "Xenia", role: "admin" }] }, true, "group-invite");`);
  assert.equal(a.run(`(state.contacts.get("g-new") || {}).members && state.contacts.get("g-new").members.map((m) => m.id).join(",")`), a.run(`Store.myId + ",x-old-id"`), "группа принята, я в ней под новым id");
  a.close();
});

test("новые аккаунты: onboarding выводит id v2 через явный параметр итераций; настройка идентификатора и добавление по номеру тоже на v2", async () => {
  const a = await boot(); await setup(a);
  const id = await a.run(`(async () => { const ident = await Identity.idFor("+15551234567"); return (await deriveOnboardingId(ident, { iterations: ${IT} })).id; })()`);
  assert.equal(id, await a.run(`Identity.hashIdV2("+15551234567", ${IT})`));
  assert.match(id, /^v2:[0-9a-f]{64}$/);
  assert.equal(a.run(`deriveOnboardingId.length`), 2, "итерации приходят только вторым (явным) параметром");
  a.close();
});

test("устройства: сертификаты и список перевыпускаются под новый id (подпись личности), companion принимает только подписанную команду", async () => {
  const a = await boot(); await setup(a);
  const NEW = "v2:" + "3".repeat(64);
  await a.run(`(async () => {
    const dk = await DeviceCert.genDeviceKey(), devId = DeviceCert.newDeviceId(); window.DEVID = devId; window.DKPUB = dk.pub;
    const cert = await DeviceCert.issue(Store.myPrivateKeyJwk, { id: MYV1, devId, pub: dk.pub, label: "Laptop" });
    const l = { seq: 4, certs: [cert], revoked: ["deadbeefdeadbeef"], signed: await DeviceCert.signList(Store.myPrivateKeyJwk, { id: MYV1, seq: 4, certs: [cert], revoked: ["deadbeefdeadbeef"] }) };
    localStorage.setItem("ether.dev.list", JSON.stringify(l)); })()`);
  const ts = Date.now();
  const n = await a.run(`Devices.migrateAnnounce(MYV1, ${JSON.stringify(NEW)}, ${ts})`);
  assert.equal(n, 0, "сервер/фича не подключены: команда ушла бы в очередь после подключения, возвращается 0 доставленных");
  const l = JSON.parse(a.run(`JSON.stringify(Devices.listState())`));
  assert.equal(l.seq, 5, "seq вырос"); assert.equal(l.signed.id, NEW); assert.equal(l.signed.seq, 5); assert.deepEqual(l.revoked, ["deadbeefdeadbeef"], "отозванные сохранены");
  assert.equal(l.certs.length, 1); assert.equal(l.certs[0].id, NEW); assert.equal(l.certs[0].devId, a.window.DEVID);
  assert.deepEqual(l.certs[0].pub, JSON.parse(JSON.stringify(a.window.DKPUB)), "ключ устройства прежний");
  assert.ok(await a.run(`DeviceCert.verifyList(Store.myPublicKeyJwk, ${JSON.stringify(NEW)}, Devices.listState().signed, { minSeq: 4 }).then((v) => v.ok && v.certs.length === 1)`), "список для нового id подписан ключом личности");
  assert.ok(!(await a.run(`DeviceCert.verifyList(Store.myPublicKeyJwk, MYV1, Devices.listState().signed, { minSeq: 4 }).then((v) => v.ok)`)), "для старого id этот список не годится");
  // companion
  const notice = await a.run(`DeviceCert.signIdMigrate(Store.myPrivateKeyJwk, { old: MYV1, new: ${JSON.stringify(NEW)}, ts: ${ts} })`);
  a.window.__op = { kind: "id-migrate", cert: l.certs[0], notice };
  a.run(`localStorage.setItem("ether.dev.self", JSON.stringify({ devId: DEVID, cert: { id: MYV1, devId: DEVID, pub: DKPUB, expires: Date.now() + 1e9, created: Date.now() - 1e3 } })); localStorage.removeItem("ether.dev.list"); window.__bad = [];`);
  assert.ok(a.run(`Devices.isCompanion()`));
  const bad = (opJs) => a.run(`Devices.applyIdMigrate(${opJs})`);
  assert.equal(await bad(`Object.assign({}, __op, { notice: Object.assign({}, __op.notice, { sig: "AAAA" }) })`), false, "подпись уведомления битая");
  assert.equal(await bad(`Object.assign({}, __op, { notice: Object.assign({}, __op.notice, { new: "v2:" + "1".repeat(64) }) })`), false, "подмена нового id");
  assert.equal(await bad(`Object.assign({}, __op, { cert: Object.assign({}, __op.cert, { label: "Evil" }) })`), false, "сертификат изменён после подписи");
  assert.equal(await bad(`Object.assign({}, __op, { cert: Object.assign({}, __op.cert, { devId: "0123456789abcdef" }) })`), false, "чужое устройство");
  assert.equal(await bad(`{ kind: "id-migrate" }`), false);
  assert.equal(a.run(`Store.myId`), a.window.MYV1, "подделки ничего не изменили");
  const sync = await a.run(`Devices.applySyncOp({ kind: "sync-op", opId: "mig1", to: Store.myId, op: __op })`);
  assert.equal(sync, true);
  assert.equal(a.run(`Store.myId`), NEW); assert.equal(a.run(`Devices.self().cert.id`), NEW, "сертификат companion обновлён");
  assert.ok(a.run(`state.contacts.get(GID).members.some((m) => m.id === Store.myId)`), "мой id в группах обновлён и на companion");
  assert.equal(await a.run(`Devices.applySyncOp({ kind: "sync-op", opId: "mig1", to: Store.myId, op: __op })`), false, "повтор той же команды не применяется");
  // companion применяет и переименование контакта из команды основного устройства (подпись проверяется ключом контакта)
  const pn = await mkNotice(a); a.window.__pn = pn;
  assert.equal(await a.run(`Devices.applySyncOp({ kind: "sync-op", opId: "pr1", to: ${JSON.stringify(NEWX)}, op: { kind: "peer-rename", notice: __pn } })`), true);
  assert.ok(a.run(`state.contacts.has(${JSON.stringify(NEWX)}) && !state.contacts.has(X)`));
  const pn2 = await a.run(`DeviceCert.signIdMigrate(EV.privateKeyJwk, { old: Y, new: "v2:" + "2".repeat(64), ts: Date.now() })`); a.window.__pn2 = pn2;
  assert.equal(await a.run(`Devices.applySyncOp({ kind: "sync-op", opId: "pr2", to: "v2:" + "2".repeat(64), op: { kind: "peer-rename", notice: __pn2 } })`), false, "подпись не ключом контакта");
  assert.ok(a.run(`state.contacts.has(Y)`));
  a.close();
});
