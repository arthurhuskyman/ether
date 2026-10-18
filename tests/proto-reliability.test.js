// Протокол: идемпотентность и ack после расшифровки, resync ratchet (rc-reset), версия ростера группы, glare звонков,
// очередь «отправить позже», сброс id при claim, прокси картинки превью, длинная руна.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    for (const [id, n] of [["alice", "Alice"], ["bob", "Bob"]]) { const c = ensureContactEntry(id, n); c.managed = true; }
    state.contacts.set("g1", { id: "g1", name: "Team", isGroup: true, managed: true, createdBy: "alice", members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice", role: "admin" }, { id: "bob", name: "Bob" }], messages: [], lastActivity: 1 });
    state._firstRenderDone = true; persistContacts(); window.attemptConnect = () => {}; window.attemptConnectViaRelay = async () => {}; })()`);
}
const ap = (a, from, payload) => a.run(`applyIncomingPayload(${JSON.stringify(from)}, "env-" + Math.random(), ${JSON.stringify(payload)}, true, null)`);

async function setupKeys(a) {
  return a.run(`(async () => {
    const me = await CryptoHelper.generateKeyPair(), al = await CryptoHelper.generateKeyPair(); Store.myPrivateKeyJwk = me.privateKeyJwk; Store.myPublicKeyJwk = me.publicKeyJwk;
    const c = state.contacts.get("alice"); c.publicKey = al.publicKeyJwk;
    window.__acks = []; window.__mbox = []; window.__delivered = [];
    window.sendAckBatch = (...x) => window.__acks.push(x);
    signaling = { mailboxAck: (id) => window.__mbox.push(id), connected: true, registered: true, features: [], signal() { return true; }, deliver: (to, id, env, pk, kind) => { window.__delivered.push([to, id, kind]); return true; } };
    window.__key = await CryptoHelper.deriveSharedKey(al.privateKeyJwk, me.publicKeyJwk);
    window.__enc = async (id, text) => { const e = await CryptoHelper.encryptJson(window.__key, { kind: "chat", id, text }); e.rc = 1; e.e2 = 1; return e; };
    return true; })()`);
}

test("дубли: повторный (from,msgId) игнорируется, но подтверждается; переживает перезапуск", async () => {
  const a = await boot(); seed(a); await setupKeys(a);
  const r = J(await a.run(`(async () => { const o = {}; const c = state.contacts.get("alice");
    const env = await __enc("p1", "hello");
    await handleDeliver({ from: "alice", msgId: "p1", envelope: env, kind: "chat" }, false);
    o.n1 = c.messages.filter((m) => m.id === "p1").length; o.ack1 = __mbox.length;
    await handleDeliver({ from: "alice", msgId: "p1", envelope: env, kind: "chat" }, false);
    o.n2 = c.messages.filter((m) => m.id === "p1").length; o.ack2 = __mbox.length;
    // «перезапуск»: память о seen сброшена, остаётся только сохранённое
    await new Promise((r) => setTimeout(r, 400));
    seenMsgStore = null; seenDeliverIds.clear();
    // другой msgId, тот же payload.id — поймает дедуп по содержимому; тот же msgId — по хранилищу
    await handleDeliver({ from: "alice", msgId: "p1", envelope: env, kind: "chat" }, false);
    o.n3 = c.messages.filter((m) => m.id === "p1").length; o.ack3 = __mbox.length; o.stored = hasSeenMsg("alice", "p1");
    return o; })()`));
  assert.equal(r.n1, 1); assert.equal(r.ack1, 1); assert.equal(r.n2, 1); assert.equal(r.ack2, 2); assert.equal(r.n3, 1); assert.equal(r.ack3, 3); assert.equal(r.stored, true);
  a.close();
});

test("лимит 500 msgId на контакт", async () => {
  const a = await boot(); seed(a);
  const r = J(a.run(`(() => { for (let i = 0; i < 520; i++) markSeenMsg("alice", "x" + i); return [hasSeenMsg("alice", "x0"), hasSeenMsg("alice", "x519"), seenMsgLoad().ids.alice.length]; })()`));
  assert.deepEqual(r, [false, true, 500]);
  a.close();
});

test("ack после расшифровки: ошибка не подтверждается, после 3 попыток — подтверждение и системная запись", async () => {
  const a = await boot(); seed(a); await setupKeys(a);
  const r = J(await a.run(`(async () => { const o = {}; const c = state.contacts.get("alice");
    const bad = { iv: "AAAA", ct: "bad", v: 1 };
    await handleDeliver({ from: "alice", msgId: "b1", envelope: bad, kind: "chat" }, false); o.a1 = __mbox.length;
    await handleDeliver({ from: "alice", msgId: "b1", envelope: bad, kind: "chat" }, false); o.a2 = __mbox.length;
    o.sys2 = c.messages.some((m) => m.textKey === "sys.msgUnreadable");
    await handleDeliver({ from: "alice", msgId: "b1", envelope: bad, kind: "chat" }, false); o.a3 = __mbox.length;
    o.sys3 = c.messages.filter((m) => m.textKey === "sys.msgUnreadable").length;
    // хороший конверт: ack только после сохранения сообщения
    const env = await __enc("g1ok", "ok"); let seenInApply = null; const orig = window.applyIncomingPayload;
    window.applyIncomingPayload = function () { seenInApply = __mbox.length; return orig.apply(this, arguments); };
    await handleDeliver({ from: "alice", msgId: "ok1", envelope: env, kind: "chat" }, false);
    window.applyIncomingPayload = orig; o.ackAfter = seenInApply === o.a3 && __mbox.length === o.a3 + 1 && __mbox[__mbox.length - 1] === "ok1";
    return o; })()`));
  assert.equal(r.a1, 0); assert.equal(r.a2, 0); assert.equal(r.sys2, false); assert.equal(r.a3, 1); assert.equal(r.sys3, 1); assert.equal(r.ackAfter, true);
  a.close();
});

test("потеря ratchet-сессии: rc-reset отправителю (раз в окно), системная запись, ack", async () => {
  const a = await boot(); seed(a); await setupKeys(a);
  const r = J(await a.run(`(async () => { const o = {}; const c = state.contacts.get("alice"); c.rc = true;
    const lost = (n) => ({ v: 2, h: { d: ["AAAAAAAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBBBBBBB"], n, pn: 0 }, ct: "AAAA" });
    await handleDeliver({ from: "alice", msgId: "r1", envelope: lost(5), kind: "chat" }, false);
    await new Promise((r) => setTimeout(r, 50));
    o.kinds = __delivered.map((d) => d[2]); o.note = c.messages.filter((m) => m.textKey === "sys.keysResynced").length; o.acked = __mbox.indexOf("r1") >= 0;
    await handleDeliver({ from: "alice", msgId: "r2", envelope: lost(6), kind: "chat" }, false);
    await new Promise((r) => setTimeout(r, 50));
    o.kinds2 = __delivered.map((d) => d[2]); o.note2 = c.messages.filter((m) => m.textKey === "sys.keysResynced").length; o.ack2 = __mbox.indexOf("r2") >= 0;
    return o; })()`));
  assert.deepEqual(r.kinds, ["rc-reset"]); assert.equal(r.note, 1); assert.equal(r.acked, true);
  assert.deepEqual(r.kinds2, ["rc-reset"], "второй запрос в окне анти-зацикливания не уходит"); assert.equal(r.note2, 1); assert.equal(r.ack2, false, "без resync сообщение ждёт повтора (попытка 1 из 3)");
  a.close();
});

test("rc-reset у отправителя: сброс сессии, повторная отправка неподтверждённых, лимит по времени", async () => {
  const a = await boot(); seed(a); await setupKeys(a);
  const r = J(await a.run(`(async () => { const o = {}; const c = state.contacts.get("alice"); const now = Date.now();
    let resets = 0; const origReset = Ratchet.reset; Ratchet.reset = (id) => { resets++; return origReset.call(Ratchet, id); };
    c.messages.push({ id: "s1", from: "me", text: "one", ts: now - 1000, ack: "sent" }, { id: "s2", from: "me", text: "two", ts: now - 900, ack: "delivered" }, { id: "s3", from: "me", text: "three", ts: now - 800, ack: "pending" }, { id: "s4", from: "me", text: "", ts: now, ack: "sent", file: { name: "f" } });
    envelopeCache.set("s1", { stale: 1 });
    const ids = []; window.flushOutboxItem = (id) => ids.push(id);
    applyIncomingPayload("alice", "e1", { kind: "rc-reset", id: "x", ts: now }, true, "rc-reset");
    o.ids = ids.slice().sort(); o.cacheCleared = !envelopeCache.has("s1"); o.resets = resets;
    o.note = c.messages.filter((m) => m.textKey === "sys.keysResynced").length;
    ids.length = 0; outbox.clear();
    applyIncomingPayload("alice", "e2", { kind: "rc-reset", id: "y", ts: now }, true, "rc-reset");
    o.again = ids.length; o.resets2 = resets;
    c.blocked = true; rcResetHandledAt.clear(); applyIncomingPayload("alice", "e3", { kind: "rc-reset" }, true, "rc-reset"); o.blocked = ids.length;
    return o; })()`));
  assert.deepEqual(r.ids, ["s1", "s3"]); assert.equal(r.cacheCleared, true); assert.equal(r.resets, 1); assert.equal(r.note, 1); assert.equal(r.again, 0); assert.equal(r.resets2, 1); assert.equal(r.blocked, 0);
  a.close();
});

test("ростер группы: ver — устаревшее от админа отбрасывается, равное/новое применяется, старый клиент без ver работает, участник не перезаписывает", async () => {
  const a = await boot(); seed(a);
  const inv = (ver, extra, from) => ap(a, from || "alice", Object.assign({ kind: "group-invite", id: "i" + Math.random(), groupId: "g1", groupName: "T" + ver, members: [{ id: "me", name: "Tester" }, { id: "alice", name: "Alice", role: "admin" }, { id: "bob", name: "Bob" }].concat(extra || []), ver }, ver === undefined ? {} : {}));
  const g = () => J(a.run(`(() => { const g = state.contacts.get("g1"); return { n: g.name, v: g.rosterVer, m: g.members.length }; })()`));
  inv(5, [{ id: "zed", name: "Z" }]); assert.deepEqual(g(), { n: "T5", v: 5, m: 4 });
  inv(3); assert.deepEqual(g(), { n: "T5", v: 5, m: 4 }, "устаревший ver отброшен");
  inv(5); assert.deepEqual(g(), { n: "T5", v: 5, m: 3 }, "равный ver от админа применяется");
  inv(undefined); assert.equal(g().n, "Tundefined", "без ver (старый клиент) от админа применяется"); assert.equal(g().v, 5);
  inv(9, [], "bob"); assert.equal(g().v, 5, "не-админ ростер не перезаписывает");
  // сохранение и загрузка
  a.run(`persistContacts(); persistContactsNow()`); assert.equal(J(a.run(`JSON.parse(Store.contactsJson).find((c) => c.id === "g1").rosterVer`)), 5);
  a.run(`state.contacts.clear(); loadContacts()`); assert.equal(J(a.run(`state.contacts.get("g1").rosterVer`)), 5, "ver читается при загрузке");
  // админ: broadcast повышает ver, старые клиенты получают лишнее поле, а banned не возвращается
  a.run(`(() => { const g = state.contacts.get("g1"); g.createdBy = "me"; g.members.find((m) => m.id === "me").role = "admin"; g.banned = ["zed"]; window.__sentRoster = []; window.trySendOrQueue = async (c, id, p) => { window.__sentRoster.push(p); }; broadcastGroupRoster(g); })()`);
  assert.equal(J(a.run(`state.contacts.get("g1").rosterVer`)), 6); assert.ok(J(a.run(`__sentRoster`)).every((p) => p.ver === 6));
  inv(7, [{ id: "zed", name: "Z" }], "alice");
  assert.ok(!J(a.run(`state.contacts.get("g1").members.some((m) => m.id === "zed")`)), "banned не возвращается ростером другого админа");
  a.close();
});

test("glare звонков: у большего id входящий, у меньшего остаётся звонящим", async () => {
  const a = await boot(); seed(a);
  const r = J(a.run(`(() => { const o = {}; window.__c = [];
    for (const f of ["openCallScreen", "stopCallSounds", "playRingtone", "ensureAudioCtx"]) window[f] = (...x) => { window.__c.push(f + ":" + x.join(",")); if (f === "openCallScreen") { state.callId = x[0]; state.callPhase = x[1]; } };
    state.callId = "bob"; state.callPhase = "calling"; Store.myId = "zzz"; o.big = callGlareYields("bob");
    Store.myId = "aaa"; o.small = callGlareYields("bob");
    Store.myId = "zzz"; state.callPhase = "ringing"; o.ringing = callGlareYields("bob");
    state.callPhase = "calling"; state._callUserAccepted = true; o.accepted = callGlareYields("bob"); state._callUserAccepted = false;
    state.callId = "alice"; o.other = callGlareYields("bob"); state.callId = "bob";
    state.currentCallRecord = { direction: "out", status: "calling" };
    yieldCallGlare("bob", true); o.calls = window.__c.slice(); o.phase = state.callPhase; o.dir = state.currentCallRecord.direction; o.video = state.callWantsVideo;
    return o; })()`));
  assert.equal(r.big, true); assert.equal(r.small, false); assert.equal(r.ringing, false); assert.equal(r.accepted, false); assert.equal(r.other, false);
  assert.deepEqual(r.calls, ["stopCallSounds:", "openCallScreen:bob,ringing", "ensureAudioCtx:", "playRingtone:"]); assert.equal(r.phase, "ringing"); assert.equal(r.dir, "in"); assert.equal(r.video, true);
  a.close();
});

test("glare: встречный call-invite через сигналинг и call-state:ringing по каналу", async () => {
  const a = await boot(); seed(a);
  const r = J(a.run(`(() => { const o = {}; window.__c = [];
    for (const f of ["openCallScreen", "stopCallSounds", "playRingtone", "ensureAudioCtx", "closeCallScreen"]) window[f] = (...x) => { window.__c.push(f); if (f === "openCallScreen") { state.callId = x[0]; state.callPhase = x[1]; } };
    Store.myId = "zzz"; state.callId = "bob"; state.callPhase = "calling";
    const sig = new EventTarget(); sig.sent = []; sig.signal = (to, d) => { sig.sent.push(d.t); return true; };
    const cleanup = wireSignalingEvents(sig);
    sig.dispatchEvent(new CustomEvent("signal", { detail: { from: "bob", data: { t: "call-invite", n: "Bob", x: "u1" } } }));
    o.phase = state.callPhase; o.sent = sig.sent.slice(); return o; })()`));
  await sleep(20);
  assert.equal(r.phase, "ringing"); assert.deepEqual(r.sent, ["call-invite-ack"]);
  a.close();
});

test("отправить позже: запись снимается только после реальной постановки; блокировка -> failed, повтор работает", async () => {
  const a = await boot(); seed(a);
  const r = J(await a.run(`(async () => { const o = {}; const c = state.contacts.get("alice"); c.publicKey = null;
    window.trySendOrQueue = async () => {};
    state.scheduledMessages = [{ id: "sc1", contactId: "alice", isGroup: false, text: "hi", sendAt: Date.now() - 1000 }];
    c.blocked = true; sweepScheduledMessages(); await new Promise((r) => setTimeout(r, 30));
    o.afterBlock = J(state.scheduledMessages); o.msgs1 = c.messages.length;
    sweepScheduledMessages(); await new Promise((r) => setTimeout(r, 30)); o.skipFailed = state.scheduledMessages.length === 1 && c.messages.length === 0;
    c.blocked = false; await retryScheduledMessage("sc1");
    o.after = state.scheduledMessages.length; o.sent = c.messages.filter((m) => m.text === "hi" && m.from === "me").length;
    o.persisted = JSON.parse(Store.scheduledMessagesJson).length;
    // исключение при отправке -> failed
    state.scheduledMessages = [{ id: "sc2", contactId: "alice", isGroup: false, text: "boom", sendAt: Date.now() - 1 }];
    window.trySendOrQueue = async () => { throw new Error("x"); };
    sweepScheduledMessages(); await new Promise((r) => setTimeout(r, 30)); o.thrown = J(state.scheduledMessages).map((s) => [s.id, !!s.failed]);
    // удалённый контакт — запись снимается молча
    state.scheduledMessages = [{ id: "sc3", contactId: "ghost", isGroup: false, text: "x", sendAt: Date.now() - 1 }];
    sweepScheduledMessages(); await new Promise((r) => setTimeout(r, 30)); o.ghost = state.scheduledMessages.length;
    return o; })()`));
  assert.equal(r.afterBlock.length, 1); assert.equal(r.afterBlock[0].failed, true); assert.equal(r.msgs1, 0); assert.equal(r.skipFailed, true);
  assert.equal(r.after, 0); assert.equal(r.sent, 1); assert.equal(r.persisted, 0); assert.deepEqual(r.thrown, [["sc2", true]]); assert.equal(r.ghost, 0);
  a.close();
});

test("claim: диалог «подождать / создать новый id», смена id сбрасывает сессии", async () => {
  const a = await boot(); seed(a);
  const r = J(await a.run(`(async () => { const o = {}; const labels = []; let answers = [false];
    window.confirmSheet = async (m, opts) => { labels.push([m.slice(0, 20), opts && opts.okLabel, opts && opts.cancelLabel]); return answers.shift(); };
    window.initSignaling = () => { window.__reinit = 1; };
    const old = Store.myId;
    await offerIdClaimedRecovery(336); o.waitKept = Store.myId === old; o.labels = labels.slice();
    answers = [true, false]; await offerIdClaimedRecovery(336); o.cancel2 = Store.myId === old;
    answers = [true, true]; await offerIdClaimedRecovery(336); o.changed = Store.myId !== old && /^[0-9a-f-]{36}$/.test(Store.myId); o.reinit = window.__reinit === 1; o.raw = Store.myIdentityRaw;
    return o; })()`));
  assert.equal(r.waitKept, true); assert.equal(r.cancel2, true); assert.equal(r.changed, true); assert.equal(r.reinit, true); assert.equal(r.raw, "");
  assert.ok(/14/.test(String(r.labels[0][2])), "срок в днях в подписи кнопки: " + r.labels[0][2]);
  a.close();
});

test("превью ссылки: картинка идёт через прокси сервера, а не напрямую", async () => {
  const a = await boot(); seed(a);
  const html = a.run(`(() => { Store.signalingUrl = "wss://relay.example.org"; return linkPreviewCardHtml({ url: "https://site.example/p", title: "T", image: "https://cdn.evil.example/i.png?a=1&b=2" }); })()`);
  assert.ok(html.includes("https://relay.example.org/link-preview-image?url=" + encodeURIComponent("https://cdn.evil.example/i.png?a=1&b=2").replace(/&/g, "&amp;")), html);
  assert.ok(!/src="https:\/\/cdn\.evil/.test(html));
  assert.ok(!a.run(`linkPreviewCardHtml({ url: "https://site.example/p", title: "T", image: "javascript:alert(1)" })`).includes("<img"));
  a.close();
});

test("длинная руна: детерминирована, 8×8 симметрична, >=64 бит различий, текстовый отпечаток группами", async () => {
  const a = await boot(); seed(a);
  const r = J(await a.run(`(async () => { const o = {};
    const h1 = await fxSigilLongHex("key-1"), h2 = await fxSigilLongHex("key-2");
    o.same = sigilLongSvg(h1, 100) === sigilLongSvg(h1, 100); o.diff = sigilLongSvg(h1) !== sigilLongSvg(h2);
    o.fp = fxSigilLongFingerprint(h1); o.len = h1.length;
    // симметрия: для каждого x-прямоугольника есть зеркальный
    const rects = [...sigilLongSvg(h1).matchAll(/<rect x="(\\d+)" y="(\\d+)" width="6"/g)].map((m) => [+m[1], +m[2]]).filter((p) => p[0] > 1 && p[1] > 1);
    o.sym = rects.length > 0 && rects.every(([x, y]) => rects.some(([x2, y2]) => y2 === y && x2 + x === 57));
    // 64 бита: меняется любой из первых 8 байт — рисунок меняется
    let allDiffer = true; for (let i = 0; i < 8; i++) { const b = h1.split(""); const pos = i * 2; b[pos] = b[pos] === "0" ? "3" : "0"; if (sigilLongSvg(b.join("")) === sigilLongSvg(h1)) allDiffer = false; }
    o.allDiffer = allDiffer;
    o.quick = sigilSvg("key-1", 48) !== sigilLongSvg(h1, 48);
    return o; })()`));
  assert.equal(r.same, true); assert.equal(r.diff, true); assert.equal(r.len, 64); assert.match(r.fp, /^([0-9A-F]{4} ){7}[0-9A-F]{4}$/); assert.equal(r.sym, true); assert.equal(r.allDiffer, true); assert.equal(r.quick, true);
  a.close();
});
