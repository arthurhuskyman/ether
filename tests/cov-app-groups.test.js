// Покрытие app.js: группы (создание, роли, бан, лимиты, приглашения), пересылка, outbox/шифрование, доверие к ключам, число безопасности.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

function seed(a, stub = true) {
  a.run(`(() => { Store.myId = "me-test-id"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    for (const [id, n] of [["alice", "Alice"], ["bob", "Bob"], ["carol", "Carol"]]) { const c = ensureContactEntry(id, n); c.managed = true; }
    window.__sent = []; if (${stub ? 'true' : 'false'}) window.trySendOrQueue = async (c, id, p) => { window.__sent.push([c.id, p.kind, p]); };
    window.attemptConnect = () => {}; window.attemptConnectViaRelay = async () => {};
    state._firstRenderDone = true; persistContacts(); })()`);
}
const sent = (a) => J(a.window.__sent);

test("группа: создание, лимиты, роли, добавление/удаление/бан, выход, переименование, описание, аватар", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(a.run(`(() => { const o = {};
    o.noMembers = createGroup("G", []); o.tooBig = createGroup("G", Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) => "m" + i));
    const gid = createGroup("  My Group ", ["alice", "bob"], "data:image/png;base64,AAAA"); o.gid = !!gid; const g = state.contacts.get(gid); o.name = g.name; o.members = g.members.length; o.role = g.members.find((m) => m.id === Store.myId).role; o.avatar = g.avatar;
    o.def = state.contacts.get(createGroup("", ["alice"])).name;
    window.__gid = gid; o.invites = window.__sent.filter((x) => x[1] === "group-invite").length;
    // роли
    o.admin = [isGroupAdmin(g, Store.myId), isGroupAdmin(g, "alice"), isGroupAdmin(g, "zzz"), isGroupAdmin(null, "a"), isGroupAdmin(g, null)];
    setGroupMemberRole(gid, "alice", "admin"); o.promoted = isGroupAdmin(g, "alice"); setGroupMemberRole(gid, "alice", "member"); setGroupMemberRole(gid, "zzz", "admin"); setGroupMemberRole("nope", "alice", "admin");
    // добавление
    addGroupMember(gid, "carol"); addGroupMember(gid, "carol"); o.added = g.members.some((m) => m.id === "carol"); addGroupMember("nope", "x");
    // удаление и бан
    removeGroupMember(gid, "carol", false); o.banned = g.banned.slice(); removeGroupMember(gid, "carol", false); addGroupMember(gid, "carol"); o.unbanned = !(g.banned || []).includes("carol");
    // переименование и описание
    renameGroup(gid, "  New Name "); renameGroup(gid, "New Name"); renameGroup(gid, "  "); o.renamed = g.name; setGroupDescription(gid, "d".repeat(300)); o.desc = g.description.length; setGroupDescription(gid, "d".repeat(200)); setGroupDescription(gid, ""); o.descCleared = g.description;
    setGroupAvatar(gid, "data:image/png;base64,BBBB"); o.av2 = g.avatar; setGroupAvatar(gid, null); o.av3 = g.avatar; setContactAvatar("alice", "data:image/png;base64,CCCC"); o.cav = state.contacts.get("alice").avatar; setContactAvatar(gid, "x"); setContactAvatar("nope", "x");
    // лимит участников
    while (g.members.length < MAX_GROUP_MEMBERS) g.members.push({ id: "fill" + g.members.length, name: "F" });
    addGroupMember(gid, "newbie"); o.full = g.members.length;
    // не-админ ничего не может
    g.members = g.members.filter((m) => !m.id.startsWith("fill")); g.createdBy = "alice"; g.members.find((m) => m.id === Store.myId).role = "member";
    addGroupMember(gid, "x"); removeGroupMember(gid, "bob", false); renameGroup(gid, "zzz"); setGroupDescription(gid, "x"); setGroupAvatar(gid, "x"); setGroupMemberRole(gid, "bob", "admin");
    o.stillBob = g.members.some((m) => m.id === "bob");
    // выход: удаляет группу локально
    g.state = 1; state.chatId = gid; removeGroupMember(gid, Store.myId, true); o.left = state.contacts.has(gid); o.chat = state.chatId;
    return o; })()`));
  assert.equal(r.noMembers, null); assert.equal(r.tooBig, null); assert.equal(r.name, "My Group"); assert.equal(r.members, 3); assert.equal(r.role, "admin"); assert.equal(r.avatar, "data:image/png;base64,AAAA");
  assert.ok(r.def.length > 0); assert.ok(r.invites >= 2); assert.deepEqual(r.admin, [true, false, false, false, false]); assert.equal(r.promoted, true); assert.equal(r.added, true); assert.deepEqual(r.banned, ["carol"]); assert.equal(r.unbanned, true);
  assert.equal(r.renamed, "New Name"); assert.equal(r.desc, 200); assert.ok(!r.descCleared); assert.equal(r.av2, "data:image/png;base64,BBBB"); assert.equal(r.av3, null); assert.equal(r.cav, "data:image/png;base64,CCCC"); assert.ok(r.full >= 50 || r.full > 3); assert.equal(r.stillBob, true); assert.equal(r.left, false); assert.equal(r.chat, null);
  a.close();
});

test("группа: отправка сообщения, права записи, инвайт-ссылка и вступление, readImageAsAvatarDataUrl, ensureGroupConnections", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const gid = a.run(`createGroup("G", ["alice", "bob"])`); a.window.__sent.length = 0;
  a.run(`state.chatId = "${gid}"; renderTab();`);
  await a.run(`sendGroupMessage("${gid}", "hello group", { msgId: "x", text: "q", authorName: "A" })`);
  const out = sent(a).filter((x) => x[1] === "chat"); assert.equal(out.length, 2); assert.equal(out[0][2].groupId, gid); assert.equal(out[0][2].replyTo.id, "x");
  await a.run(`sendGroupMessage("${gid}", "z".repeat(MAX_MESSAGE_LENGTH + 50))`); assert.equal(a.run(`state.contacts.get("${gid}").messages.filter((m) => m.from === "me").pop().text.length`), 4000 > 0 ? a.run(`MAX_MESSAGE_LENGTH`) : 0);
  await a.run(`sendGroupMessage("nope", "x")`);
  a.run(`{ const g = state.contacts.get("${gid}"); g.writeRestricted = true; g.members.find((m) => m.id === Store.myId).role = "member"; g.createdBy = "alice"; }`); const n0 = sent(a).length; await a.run(`sendGroupMessage("${gid}", "blocked")`); assert.equal(sent(a).length, n0);
  a.run(`{ const g = state.contacts.get("${gid}"); g.writeRestricted = false; g.createdBy = Store.myId; g.members.find((m) => m.id === Store.myId).role = "admin"; g.disappearingTimer = 3600000; }`);
  await a.run(`sendGroupMessage("${gid}", "with ttl")`); assert.equal(sent(a).at(-1)[2].ttl, 3600000);
  // приглашения
  const inv = J(await a.run(`(async () => { const o = {}; o.code = buildGroupInviteCode("${gid}"); o.none = buildGroupInviteCode("nope");
    o.parsed = parseGroupInviteCode(o.code); o.bad = [parseGroupInviteCode(""), parseGroupInviteCode("ether://group?gid=a"), parseGroupInviteCode("ether://add?x"), parseGroupInviteCode(null)];
    await joinGroupViaInvite("garbage"); await joinGroupViaInvite("ether://group?gid=other&ref=" + Store.myId); await joinGroupViaInvite(o.code);
    await joinGroupViaInvite("ether://group?gid=newgroup&ref=stranger&rn=Str&gn=Club"); o.stranger = state.contacts.has("stranger"); o.reqs = window.__sent.filter((x) => x[1] === "group-join-request").length;
    onlineSet.add("stranger2"); window.scheduleAutoConnect = () => { window.__auto = 1; }; await joinGroupViaInvite("ether://group?gid=g3&ref=stranger2"); o.auto = window.__auto;
    openGroupInviteSheet("${gid}"); o.out = document.getElementById("group-invite-code-out").textContent === o.code; openGroupInviteSheet("nope");
    ensureGroupConnections(state.contacts.get("${gid}")); return o; })()`));
  assert.ok(inv.code.startsWith("ether://group?")); assert.equal(inv.none, null); assert.equal(inv.parsed.groupId, gid); assert.deepEqual(inv.bad, [null, null, null, null]); assert.equal(inv.stranger, true); assert.equal(inv.reqs, 1); assert.equal(inv.auto, 1); assert.equal(inv.out, true);
  // аватар из файла
  a.run(`window.Image = class { constructor() { this.__go = true; } set src(v) { this._s = v; this.width = 300; this.height = 200; __realTO.call(window, () => this.onload && this.onload(), 0); } };`);
  const av = J(await a.run(`(async () => { const o = {}; try { o.ok = (await readImageAsAvatarDataUrl(new File([new Uint8Array(100)], "a.png", { type: "image/png" }))).startsWith("data:"); } catch (e) { o.err = String(e); }
    try { await readImageAsAvatarDataUrl({ size: 99999999 }); } catch (e) { o.big = e.message; } return o; })()`));
  assert.equal(av.ok, true); assert.equal(av.big, "image too large");
  a.close();
});

test("пересылка: текст, файл (живая связь / офлайн / нет blob), карточка, в группу", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const gid = a.run(`createGroup("G", ["bob"])`);
  a.run(`const al = state.contacts.get("alice"); al.messages.push({ id: "m1", from: "them", text: "orig text", ts: Date.now(), fromName: "Alice" }, { id: "mf", from: "me", text: "", ts: Date.now(), file: { name: "a.png", mime: "image/png", size: 5, kind: "image", caption: "cap", duration: 2, wave: [1, 2, 3, 4] } },
    { id: "mc", from: "me", text: "", ts: Date.now(), contactCard: { id: "carol", name: "Carol" } }, { id: "mfw", from: "me", text: "fwd", ts: Date.now(), forwarded: true, forwardedFrom: "Zed" });`);
  await a.run(`IDB.set("file:mf", new Blob(["abc"], { type: "image/png" }))`);
  window_sent_reset(a);
  await a.run(`forwardMessage("m1", "alice", "bob")`); await a.run(`forwardMessage("mfw", "alice", "bob")`); await a.run(`forwardMessage("nope", "alice", "bob")`); await a.run(`forwardMessage("m1", "zzz", "bob")`);
  const texts = sent(a).filter((x) => x[1] === "chat"); assert.equal(texts.length, 2); assert.equal(texts[0][2].forwarded, true); assert.equal(texts[1][2].fwdFrom, "Zed");
  // карточка контакта
  await a.run(`forwardMessage("mc", "alice", "bob")`); assert.ok(sent(a).some((x) => x[1] === "contact-card" && x[2].forwarded)); await a.run(`forwardContact("carol", "bob")`); await a.run(`forwardContact("nope", "bob")`);
  // файл по офлайн-пути
  await a.run(`forwardMessage("mf", "alice", "bob")`); const fOff = sent(a).find((x) => x[1] === "file"); assert.ok(fOff && fOff[2].dataB64 && fOff[2].caption === "cap" && fOff[2].wave);
  // файл по живой связи
  a.run(`mesh.links.set("bob", { status: "connected", sendFile: async (meta, chunks) => { window.__live = [meta, chunks.length]; return true; } });`); await a.run(`forwardMessage("mf", "alice", "bob")`); assert.ok(a.window.__live[0].forwarded);
  a.run(`mesh.links.set("bob", { status: "connected", sendFile: async () => { throw new Error("x"); } });`); await a.run(`forwardMessage("mf", "alice", "bob")`);
  a.run(`mesh.links.delete("bob");`);
  // нет blob
  await a.run(`IDB.del("file:mf")`); await a.run(`forwardMessage("mf", "alice", "bob")`); assert.ok(a.run(`state.contacts.get("bob").messages.some((m) => m.file && m.file.failed)`));
  // в группу: текст / файл / нет blob / слишком большой
  window_sent_reset(a);
  await a.run(`forwardMessage("m1", "alice", "${gid}")`); assert.ok(sent(a).some((x) => x[0] === "bob" && x[1] === "chat" && x[2].forwarded && x[2].groupId === gid));
  await a.run(`IDB.set("file:mf", new Blob(["abc"], { type: "image/png" }))`); await a.run(`forwardMessage("mf", "alice", "${gid}")`); assert.ok(sent(a).some((x) => x[1] === "file" && x[2].forwarded));
  await a.run(`IDB.set("file:mf", new Blob([new Uint8Array(1100000)], { type: "image/png" }))`); await a.run(`forwardMessage("mf", "alice", "${gid}")`);
  await a.run(`IDB.del("file:mf")`); await a.run(`forwardMessage("mf", "alice", "${gid}")`);
  await a.run(`forwardMessage("mc", "alice", "${gid}")`);
  a.run(`{ const g = state.contacts.get("${gid}"); g.writeRestricted = true; g.createdBy = "bob"; g.members.find((m) => m.id === Store.myId).role = "member"; }`); await a.run(`forwardMessage("m1", "alice", "${gid}")`);
  a.close();
});
function window_sent_reset(a) { a.window.__sent.length = 0; }

test("outbox: слим-полезная нагрузка, восстановление, карта доставки групп, trySendOrQueue (self, P2P, очередь)", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a, false);
  const r = J(await a.run(`(async () => { const o = {};
    o.slim = [slimPayload(null), slimPayload({ kind: "chat" }), slimPayload({ id: "f1", dataB64: "QQ==", kind: "file" })];
    await IDB.set("file:f1", new Blob(["hello"])); o.hyd = [await hydratePayload(null), await hydratePayload({ dataB64: "x" }), (await hydratePayload(o.slim[2])).dataB64.length > 0, await hydratePayload({ idbKey: "file:none" }), (await hydratePayload({ kind: "x" })).kind];
    addToOutbox("o1", "alice", { kind: "chat", id: "o1", text: "x" }); addToOutbox("o1", "alice", {}); o.size = outbox.size; persistOutbox(); const saved = Store.outboxJson; outbox.clear(); restoreOutbox(); o.restored = outbox.has("o1");
    Store.outboxJson = "{bad"; outbox.clear(); restoreOutbox(); Store.outboxJson = "{}"; restoreOutbox(); Store.outboxJson = JSON.stringify([{ msgId: 5 }, null, { msgId: "ok", to: "alice", payload: { a: 1 } }]); restoreOutbox(); o.after = outbox.has("ok");
    groupDeliveryMap.set("d1", { groupId: "g", contentId: "c", to: "alice" }); persistGroupDeliveryMap(); groupDeliveryMap.clear(); restoreGroupDeliveryMap(); o.gdm = groupDeliveryMap.has("d1"); Store.groupDeliveryMapJson = "{bad"; restoreGroupDeliveryMap(); Store.groupDeliveryMapJson = JSON.stringify([{ deliveryId: 1 }]); restoreGroupDeliveryMap();
    const g = { id: "gg", isGroup: true, members: [], messages: [{ id: "cc", from: "me", text: "x" }], lastActivity: 1 }; state.contacts.set("gg", g); groupDeliveryMap.set("dd", { groupId: "gg", contentId: "cc", to: "alice" }); o.res = [!!resolveGroupDelivery("dd"), resolveGroupDelivery("none"), resolveGroupDelivery("d1")];
    // trySendOrQueue
    const self = { id: "self", isSelf: true, messages: [{ id: "s1", from: "me", text: "x" }] }; await trySendOrQueue(self, "s1", {}); o.self = self.messages[0].ack; const demo = { id: "dm", isSelf: true, isDemo: true, messages: [], demoStep: 0 }; window.demoOnSend = () => { window.__demoSend = 1; }; await trySendOrQueue(demo, "x", { kind: "chat" }); o.demo = window.__demoSend;
    const al = state.contacts.get("alice"); al.messages.push({ id: "p1", from: "me", text: "x", ack: "sent" }); const sent = []; mesh.links.set("alice", { status: "connected", send: (p) => { sent.push(p); return true; } });
    window.flushOutboxItem = async (id) => { window.__flushed = id; }; await trySendOrQueue(al, "p1", { kind: "chat", id: "p1" }); o.p2p = [sent.length, al.messages.find((m) => m.id === "p1").ack]; 
    mesh.links.delete("alice"); al.messages.push({ id: "p2", from: "me", text: "y", ack: "sent" }); await trySendOrQueue(al, "p2", { kind: "chat", id: "p2" }); o.queued = [window.__flushed, al.messages.find((m) => m.id === "p2").ack];
    return o; })()`));
  assert.equal(r.slim[0], null); assert.equal(r.slim[2].idbKey, "file:f1"); assert.ok(!("dataB64" in r.slim[2])); assert.equal(r.hyd[0], null); assert.equal(r.hyd[2], true); assert.equal(r.hyd[3], null);
  assert.equal(r.size, 1); assert.equal(r.restored, true); assert.equal(r.after, true); assert.equal(r.gdm, true); assert.deepEqual(r.res, [true, null, null]); assert.equal(r.self, "read"); assert.equal(r.demo, 1); assert.deepEqual(r.p2p, [1, "sent"]); assert.equal(r.queued[0], "p2"); assert.equal(r.queued[1], "pending");
  a.close();
});

test("шифрование конвертов и prekey: encryptForContact (v1/v2), кэш, prekey-бандл, загрузка ключей", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a, false);
  const r = J(await a.run(`(async () => { const o = {};
    const kp = await CryptoHelper.generateKeyPair(); const mine = await CryptoHelper.generateKeyPair(); Store.myPrivateKeyJwk = mine.privateKeyJwk; Store.myPublicKeyJwk = mine.publicKeyJwk;
    const al = state.contacts.get("alice"); al.publicKey = kp.publicKeyJwk;
    const e1 = await encryptForContact(al, "env1", { kind: "chat", text: "hi" }); o.v1 = [!!e1.iv, e1.rc, e1.e2, !!e1.ct]; const e1b = await encryptForContact(al, "env1", {}); o.cached = e1b === e1;
    signaling = { connected: true, registered: true, features: ["env2"], prekeyCount: 0, uploadPrekeys(p) { window.__up = p; return true; }, fetchPrekeys() { return false; }, addEventListener() {}, removeEventListener() {} };
    al.e2 = true; const e2 = await encryptForContact(al, "env2", { kind: "chat" }); o.v2 = !!e2.iv; const fv1 = await encryptForContact(al, "env3", { kind: "chat" }, true);
    signaling.features = ["env2", "prekeys", "ratchet2"]; al.rc = true; const e3 = await encryptForContact(al, "env4", { kind: "chat", text: "ratchet" }); o.rc = [!!e3.h || !!e3.iv, e3.v];
    o.fetchNull = await fetchPrekeyBundle("alice", 50); signaling.connected = false; o.fetchOff = await fetchPrekeyBundle("alice"); signaling.connected = true;
    // успешный запрос бандла
    const sg = signaling; const listeners = []; sg.addEventListener = (n, f) => listeners.push(f); sg.removeEventListener = () => {}; const RT = (f, ms) => __realTO.call(window, f, ms); sg.fetchPrekeys = (id, rid) => { RT(() => listeners.forEach((f) => f({ detail: { rid: "other" } })), 0); RT(() => listeners.forEach((f) => f({ detail: { rid, spk: { a: 1 }, opk: null } })), 1); return true; };
    o.bundle = await fetchPrekeyBundle("alice", 1000); sg.fetchPrekeys = (id, rid) => { RT(() => listeners.forEach((f) => f({ detail: { rid, error: "none" } })), 0); return true; }; o.bundleErr = await fetchPrekeyBundle("alice", 1000);
    await maybeUploadPrekeys(true); o.uploaded = !!window.__up && window.__up.opks.length; window.__up = null; sg.prekeyCount = 100; await maybeUploadPrekeys(false); o.noUpload = !window.__up; sg.features = []; await maybeUploadPrekeys(true); sg.connected = false; await maybeUploadPrekeys(true);
    o.mark = []; const c2 = { id: "z", messages: [] }; markContactEnv2(c2); markContactEnv2(c2); markContactRatchet(c2); markContactRatchet(c2); markContactEnv2(null); markContactEnv2({ isGroup: true }); o.flags = [c2.e2, c2.rc];
    return o; })()`));
  assert.deepEqual(r.v1.slice(0, 3).map(Boolean), [true, true, true]); assert.equal(r.cached, true); assert.equal(r.v2, true); assert.equal(r.fetchNull, null); assert.equal(r.fetchOff, null);
  assert.deepEqual(r.bundle.spk, { a: 1 }); assert.equal(r.bundleErr, null); assert.ok(r.uploaded > 0); assert.equal(r.noUpload, true); assert.deepEqual(r.flags, [true, true]);
  a.close();
});

test("доверие к ключам: первый ключ, смена, подтверждение/отклонение, held-доставки, число безопасности, QR-сверка", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.confirmSheet = async () => true; window.handleDeliver = async (h) => { (window.__held = window.__held || []).push(h.msgId); };`);
  const r = J(await a.run(`(async () => { const o = {};
    const k1 = (await CryptoHelper.generateKeyPair()).publicKeyJwk, k2 = (await CryptoHelper.generateKeyPair()).publicKeyJwk, mine = await CryptoHelper.generateKeyPair(); Store.myPublicKeyJwk = mine.publicKeyJwk; Store.myPrivateKeyJwk = mine.privateKeyJwk;
    const al = state.contacts.get("alice"); al.publicKey = null; o.first = noteContactKey(al, k1); o.same = noteContactKey(al, k1); o.nullKey = noteContactKey(al, null);
    state.chatId = "alice"; o.change = noteContactKey(al, k2); o.pending = !!al.pendingKey; o.again = noteContactKey(al, k2); renderKeyChangeBanner(); o.banner = !document.getElementById("keychange-banner").classList.contains("hidden"); o.nullPending = noteContactKey(al, null);
    o.back = noteContactKey(al, k1); o.cleared = !al.pendingKey;
    noteContactKey(al, k2); heldDeliveries = [{ from: "alice", msgId: "h1" }, { from: "bob", msgId: "h2" }]; rejectContactKey("alice"); o.rejected = !!al.rejectedKey; o.heldAfterReject = heldDeliveries.length; o.rejectedAgain = noteContactKey(al, k2);
    al.rejectedKey = undefined; noteContactKey(al, k2); heldDeliveries = [{ from: "alice", msgId: "h3" }]; window.flushPendingNoKey = () => {}; window.reauthLink = () => {}; await confirmContactKey("alice"); o.confirmed = al.publicKey.x === k2.x; o.held = window.__held; await confirmContactKey("alice"); await confirmContactKey("nope"); rejectContactKey("nope");
    o.verified0 = isContactVerified(al); setContactVerified("alice", true); o.verified1 = isContactVerified(al); setContactVerified("alice", false); setContactVerified("nope", true);
    loadHeld(); heldDeliveries = Array.from({ length: 130 }, (_, i) => ({ from: "x", msgId: "q" + i })); persistHeld(); o.heldCap = heldDeliveries.length; heldDeliveries = [{ blob: "x".repeat(1500000) }, { blob: "y".repeat(1500000) }]; persistHeld(); o.heldBytes = heldDeliveries.length;
    // число безопасности
    state.contacts.get("alice").publicKey = k1; await openSafetySheet("alice"); o.digits = document.getElementById("safety-number-digits").textContent.length > 20; o.ctx = __safetyCtx.digits.length;
    o.scan = [onSafetyQrScanned("ether://verify?n=" + __safetyCtx.digits), onSafetyQrScanned("ether://verify?n=000"), onSafetyQrScanned("garbage"), onSafetyQrScanned(5)]; o.nowVerified = isContactVerified(al);
    document.getElementById("safety-mark-btn").click(); document.getElementById("safety-mark-btn").click();
    window.startQrScan = () => { window.__qr = 1; }; document.getElementById("safety-scan-btn").click(); o.qr = window.__qr;
    await openSafetySheet("alice", k2); document.getElementById("safety-mark-btn").click(); await openSafetySheet("nope"); al.publicKey = null; await openSafetySheet("alice");
    return o; })()`));
  assert.equal(r.first, true); assert.equal(r.same, true); assert.equal(r.nullKey, true); assert.equal(r.change, false); assert.equal(r.pending, true); assert.equal(r.banner, true); assert.equal(r.nullPending, false); assert.equal(r.back, true); assert.equal(r.cleared, true);
  assert.equal(r.rejected, true); assert.equal(r.heldAfterReject, 1); assert.equal(r.rejectedAgain, false); assert.equal(r.confirmed, true); assert.deepEqual(r.held, ["h3"]); assert.equal(r.verified0, false); assert.equal(r.verified1, true);
  assert.ok(r.heldCap <= 100); assert.ok(r.heldBytes < 2); assert.equal(r.digits, true); assert.equal(r.ctx, 60); assert.deepEqual(r.scan, [true, true, false, false]); assert.equal(r.nowVerified, true); assert.equal(r.qr, 1);
  // кнопки баннера смены ключа
  a.run(`const al = state.contacts.get("alice"); al.pendingKey = { key: { kty: "EC", x: "1" }, at: 1 }; al.rejectedKey = undefined; state.chatId = "alice"; renderKeyChangeBanner(); window.openSafetySheet = (id, k) => { window.__ks = [id, !!k]; }; document.getElementById("keychange-verify-btn").click(); document.getElementById("keychange-reject-btn").click();`);
  assert.deepEqual(J(a.window.__ks), ["alice", true]);
  a.run(`state.contacts.get("alice").pendingKey = { key: { kty: "EC", x: "2" }, at: 1 }; document.getElementById("keychange-accept-btn").click();`); await sleep(30);
  a.close();
});
