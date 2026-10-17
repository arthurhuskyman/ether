// Покрытие app.js: события сигналинга, оффер/ансвер/ICE, relay через общий контакт, проверка канала (linkauth), подключение, QR/приглашения.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    for (const [id, n] of [["alice", "Alice"], ["bob", "Bob"], ["zed", "Zed"]]) { const c = ensureContactEntry(id, n); c.managed = true; }
    state._firstRenderDone = true; persistContacts();
    window.__calls = []; for (const f of ["openCallScreen", "closeCallScreen", "setCallPhaseActive", "playRingtone", "stopRingtone", "ensureAudioCtx"]) { window[f] = (...x) => { window.__calls.push([f, ...x]); }; }
    window.mkSig = () => { const s = new EventTarget(); s.connected = true; s.sent = []; s.signal = (to, d) => { s.sent.push([to, d]); return !s.failSignal; }; s.sendPushSubscription = (x) => { s.sent.push(["push", x]); }; s.mailboxAck = () => {}; s.stop = () => {}; s.features = []; s.registered = true; return s; };
    window.fire = (s, type, detail) => s.dispatchEvent(new CustomEvent(type, { detail })); })()`);
}
const calls = (a) => J(a.window.__calls).map((x) => x[0]);

test("события сигналинга: connected/disconnected/presence/online-list/unreachable/replaced/vapid/register-error", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.__sig = mkSig(); window.__cleanup = wireSignalingEvents(__sig); Store.pushSubscriptionJson = JSON.stringify({ endpoint: "https://x" });
    window.flushOutbox = () => { window.__flushed = 1; }; window.maybeUploadPrekeys = () => {}; window.ensurePushSubscription = async () => null;
    window.__dead = { status: "disconnected", _closed: false, close() {} }; mesh.links.set("dead", window.__dead);`);
  const fire = (type, d) => a.run(`fire(__sig, ${JSON.stringify(type)}, ${JSON.stringify(d || {})})`);
  fire("connected"); assert.ok(!a.run(`mesh.links.has("dead")`)); assert.equal(a.window.__flushed, 1); assert.ok(J(a.window.__sig.sent).some((x) => x[0] === "push")); t.tick(1000); fire("connected"); t.fireEvery(3600000);
  fire("register-error", { error: "id-claimed" }); fire("register-error", { error: "other" }); fire("register-error"); fire("register-rate-limited");
  a.run(`state.tab = "chats"; state.contacts.get("alice").online = true; onlineSet.add("alice"); onlineRoster.set("alice", {});`); fire("disconnected"); assert.equal(a.run(`state.contacts.get("alice").online`), false); assert.equal(a.run(`onlineSet.size`), 0);
  // online-list
  const kp = await a.run(`(async () => (await CryptoHelper.generateKeyPair()).publicKeyJwk)()`); a.window.__kp = kp;
  fire("online-list", { users: [{ id: "alice", name: "Alice", caps: ["env2"], publicKey: null }, { id: "stranger", name: "Str", visible: false }] });
  assert.equal(a.run(`state.contacts.get("alice").online`), true); assert.equal(a.run(`state.contacts.get("alice").e2`), true);
  a.run(`state.contacts.get("bob").publicKey = null; fire(__sig, "online-list", { users: [{ id: "bob", publicKey: __kp }] });`); assert.ok(a.run(`!!state.contacts.get("bob").publicKey`));
  // presence
  fire("presence", { id: "alice", online: true, name: "Alice", visible: true, caps: ["env2"] }); fire("presence", { id: "alice", online: false }); fire("presence", { id: "ghost", online: true, name: "G" });
  a.run(`state.chatId = "alice"; state.contactCardId = "alice"; fire(__sig, "presence", { id: "alice", online: true, publicKey: __kp });`); a.run(`state.chatId = null; state.contactCardId = null; state.tab = "connect";`); fire("presence", { id: "alice", online: true });
  // unreachable
  a.run(`mesh.links.set("zed", { status: "connecting", close() {} });`); fire("unreachable", { to: "zed" }); assert.ok(!a.run(`mesh.links.has("zed")`)); fire("unreachable", { to: "" }); fire("unreachable", { to: "x" }); assert.ok(a.run(`isUnreachableCooldown("zed")`));
  a.run(`markUnreachable("zed"); markUnreachable("zed"); clearUnreachable("zed"); clearUnreachable("zed");`);
  // replaced: трижды за минуту — тост без автозабора
  a.run(`window.reclaimSignaling = () => { window.__reclaimed = (window.__reclaimed || 0) + 1; };`); fire("replaced"); t.tick(4000); assert.equal(a.window.__reclaimed, 1); fire("replaced"); fire("replaced"); t.tick(4000); assert.ok(a.run(`__replacedHits.length >= 3`));
  // vapid
  fire("vapid-key", { key: "KEY1" }); assert.equal(a.run(`Store.vapidPublicKey`), "KEY1"); fire("vapid-key", {}); fire("push-subscribed"); fire("prekey-low");
  // deliver-ack
  a.run(`const al = state.contacts.get("alice"); al.messages.push({ id: "da1", from: "me", text: "x", ts: 1, ack: "sent" }); addToOutbox("da1", "alice", { kind: "chat", id: "da1" }); addToOutbox("da2", "alice", { kind: "chat", id: "da2" }); state.contacts.get("g1") || state.contacts.set("g1", { id: "g1", isGroup: true, members: [{ id: "alice" }], messages: [{ id: "gc1", from: "me", text: "g" }], lastActivity: 1 }); addToOutbox("da3", "alice", { kind: "chat", id: "gc1", groupId: "g1" });`);
  fire("deliver-ack", { msgId: "da1" }); assert.equal(a.run(`state.contacts.get("alice").messages[0].serverAcked`), true); assert.ok(!a.run(`outbox.has("da1")`));
  fire("deliver-ack", { msgId: "da3" }); assert.equal(a.run(`state.contacts.get("g1").messages[0].serverAcked`), true);
  fire("deliver-ack", { msgId: "da2", error: "bad format" }); assert.equal(a.run(`outbox.get("da2").forceV1`), true); fire("deliver-ack", { msgId: "none" });
  // slow-connect не подписан здесь; cleanup снимает подписки
  a.run(`__cleanup();`); fire("connected"); a.close();
});

test("сигнальные пакеты: call-invite (все ветки), busy/ack/accepted/declined/ended, offer/answer/ice, дубликаты", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.__sig = mkSig(); wireSignalingEvents(__sig);`);
  const sig = (from, data) => a.run(`fire(__sig, "signal", { from: ${JSON.stringify(from)}, data: ${JSON.stringify(data)} })`);
  const flush = () => sleep(20);
  sig("alice", null); sig("alice", {}); await flush();
  sig("alice", { t: "call-invite", n: "Alice", x: "n1" }); await flush(); assert.ok(calls(a).includes("openCallScreen")); assert.ok(J(a.window.__sig.sent).some((x) => x[1].t === "call-invite-ack"));
  sig("alice", { t: "call-invite", n: "Alice", x: "n1" }); await flush(); // дубликат
  a.run(`state.callId = "bob";`); sig("alice", { t: "call-invite", x: "n2" }); await flush(); assert.ok(J(a.window.__sig.sent).some((x) => x[1].t === "call-busy"));
  a.run(`__sig.failSignal = true;`); sig("alice", { t: "call-invite", x: "n3" }); a.run(`state.callId = "alice";`); sig("alice", { t: "call-invite", x: "n4" }); await flush(); a.run(`__sig.failSignal = false; state.callId = null; state.contacts.get("bob").blocked = true;`);
  sig("bob", { t: "call-invite", x: "n5" }); await flush(); t.tick(40000); assert.ok(J(a.window.__sig.sent).some((x) => x[0] === "bob" && x[1].t === "call-declined"));
  a.run(`state.contacts.get("bob").blocked = false; Store.notificationsEnabled = true; Notification = class { static get permission() { return "granted"; } }; window.Notification = Notification;`); sig("zed", { t: "call-invite", n: "Zed", x: "n6" }); await flush();
  // состояния звонка
  a.run(`window.__calls.length = 0; state.callId = "alice"; state.callPhase = "calling"; document.getElementById("call-phase").textContent = "";`);
  sig("alice", { t: "call-invite-ack" }); sig("alice", { t: "call-accepted" }); sig("alice", { t: "call-busy" }); sig("alice", { t: "call-declined" }); sig("alice", { t: "call-ended" }); await flush();
  assert.ok(["setCallPhaseActive", "closeCallScreen", "stopRingtone"].every((f) => calls(a).includes(f)));
  a.run(`state.callId = null;`); for (const tt of ["call-busy", "call-invite-ack", "call-accepted", "call-declined", "call-ended"]) sig("alice", { t: tt });
  // offer / answer / ice
  a.run(`window.handleIncomingOffer = async (f, p, reply) => { window.__offer = [f, p.t]; reply({ t: "answer" }); }; window.handleIncomingAnswer = async (f, p) => { window.__answer = [f, p.t]; };`);
  sig("alice", { t: "offer", sdp: "x" }); sig("alice", { t: "answer", sdp: "y" }); await flush(); assert.deepEqual(J(a.window.__offer), ["alice", "offer"]); assert.deepEqual(J(a.window.__answer), ["alice", "answer"]);
  sig("alice", { t: "ice", candidate: { candidate: "c1" } }); assert.equal(a.run(`pendingIceCandidates.get("alice").length`), 1);
  for (let i = 0; i < 205; i++) sig("alice", { t: "ice", candidate: { candidate: "c" + i } }); assert.equal(a.run(`pendingIceCandidates.get("alice").length`), 200);
  a.run(`const got = []; mesh.links.set("alice", { status: "connecting", addIceCandidate: async (c) => { got.push(c); } }); window.__ice = got; flushPendingIceFor("alice", mesh.get("alice")); flushPendingIceFor("nobody", {});`); assert.equal(a.run(`__ice.length`), 200);
  sig("alice", { t: "ice", candidate: { candidate: "live" } }); assert.equal(a.run(`__ice.length`), 201); a.run(`recentlyDeletedIds.set("ghost", Date.now());`); sig("ghost", { t: "ice", candidate: { candidate: "x" } }); sig("alice", { t: "ice" });
  a.close();
});

test("handleIncomingOffer / Answer / watchConnectionTimeout / attemptConnect / relay: ветки с фейковыми линками", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(await a.run(`(async () => { const o = {}; const replies = []; const mkLink = (extra) => Object.assign({ status: "connecting", role: "answerer", acceptOfferAndCreateAnswer: async (p) => ({ t: "answer", for: p.n }), acceptAnswer: async () => {}, addIceCandidate: async () => {}, createInitialOffer: async () => ({ t: "offer" }), send(p) { (this.sentP = this.sentP || []).push(p); return true; }, endCall() {} }, extra || {});
    recentlyDeletedIds.set("gone", Date.now()); await handleIncomingOffer("gone", {}, (x) => replies.push(x)); const bl = state.contacts.get("bob"); bl.blocked = true; await handleIncomingOffer("bob", {}, (x) => replies.push(x)); bl.blocked = false;
    mesh.links.set("alice", mkLink({ status: "connected" })); await handleIncomingOffer("alice", {}, (x) => replies.push(x)); o.live = replies.length;
    mesh.links.set("alice", mkLink({ status: "connecting", role: "offerer", _createdAt: Date.now() })); Store.myId = "aaa"; await handleIncomingOffer("alice", {}, (x) => replies.push(x)); o.tiebreak = replies.length; Store.myId = "me";
    mesh.createIncomingLink = (id) => { const l = mkLink(); mesh.links.set(id, l); return l; }; mesh.remove = (id) => { mesh.links.delete(id); };
    await handleIncomingOffer("zed", { n: "Zed", rl: 1 }, (x) => replies.push(x)); o.accepted = replies.at(-1); 
    mesh.createIncomingLink = (id) => { const l = mkLink({ acceptOfferAndCreateAnswer: async () => { throw new Error("sdp"); } }); mesh.links.set(id, l); return l; }; await handleIncomingOffer("zed", {}, (x) => replies.push(x)); o.removedOnError = !mesh.links.has("zed");
    mesh.createIncomingLink = (id) => { const l = mkLink({ acceptOfferAndCreateAnswer: async () => null }); mesh.links.set(id, l); return l; }; await handleIncomingOffer("zed", {}, (x) => replies.push(x));
    mesh.links.set("alice", mkLink({ acceptAnswer: async () => { throw new Error("x"); } })); await handleIncomingAnswer("alice", {}); o.answerFail = !mesh.links.has("alice"); await handleIncomingAnswer("nobody", {});
    return o; })()`));
  assert.equal(r.live, 0); assert.equal(r.tiebreak, 0); assert.equal(r.accepted.t, "answer"); assert.equal(r.removedOnError, true); assert.equal(r.answerFail, true);
  const c = J(await a.run(`(async () => { const o = {}; const mk = (extra) => Object.assign({ status: "connecting", _createdAt: Date.now(), createInitialOffer: async () => ({ t: "offer" }), send() { return true; } }, extra || {});
    // attemptConnect
    signaling = mkSig(); onlineSet.add("zed"); onlineSet.add("alice"); mesh.createOutgoingLink = (id) => { const l = mk(); mesh.links.set(id, l); return l; };
    Store.myId = "aaa"; await attemptConnect("alice"); o.offered = signaling.sent.filter((x) => x[1].t === "offer").length; Store.myId = "zzz"; await attemptConnect("alice"); await attemptConnect("alice", true); Store.myId = "aaa"; mesh.links.delete("alice");
    await attemptConnect("nobody"); signaling.connected = false; await attemptConnect("alice"); signaling.connected = true;
    markUnreachable("alice"); await attemptConnect("alice"); clearUnreachable("alice");
    mesh.links.set("alice", mk({ status: "connected" })); await attemptConnect("alice"); mesh.links.set("alice", mk({ status: "connecting" })); await attemptConnect("alice"); mesh.links.set("alice", mk({ status: "connecting", _createdAt: 1 })); await attemptConnect("alice");
    mesh.createOutgoingLink = (id) => { const l = mk({ createInitialOffer: async () => { throw new Error("no"); } }); mesh.links.set(id, l); return l; }; mesh.links.delete("alice"); await attemptConnect("alice"); o.status = state.contacts.get("alice").status;
    mesh.createOutgoingLink = (id) => { const l = mk({ createInitialOffer: async () => null }); mesh.links.set(id, l); return l; }; await attemptConnect("alice");
    mesh.createOutgoingLink = (id) => { const l = mk(); mesh.links.set(id, l); return l; }; signaling.failSignal = true; await attemptConnect("alice", true); signaling.failSignal = false;
    // watchConnectionTimeout
    mesh.links.set("zed", mk()); state.contacts.get("zed").online = true; watchConnectionTimeout("zed"); await new Promise((r) => __realTO.call(window, r, 5)); __fk.tick(60000); o.timedOut = !mesh.links.has("zed") || mesh.get("zed").status;
    // scheduleAutoConnect и relay
    scheduleAutoConnect("zed"); scheduleAutoConnect("zed"); __fk.tick(60000);
    mesh.links.set("zed", mk({ status: "connecting" })); await attemptConnectViaRelay("zed"); mesh.links.set("zed", mk({ status: "connected" })); await attemptConnectViaRelay("zed"); mesh.links.delete("zed");
    relayAttemptCooldown.clear(); mesh.links.delete("zed"); await attemptConnectViaRelay("zed"); relayAttemptCooldown.clear(); const rl = mk({ status: "connected" }); const rs = []; rl.send = (p) => { rs.push(p); return true; }; mesh.links.set("alice", rl); mesh.createOutgoingLink = (id) => { const l = mk(); mesh.links.set(id, l); return l; }; await attemptConnectViaRelay("zed"); o.relayReq = rs.map((p) => p.kind);
    relayAttemptCooldown.clear(); mesh.createOutgoingLink = (id) => { const l = mk({ createInitialOffer: async () => null }); mesh.links.set(id, l); return l; }; await attemptConnectViaRelay("zed"); relayAttemptCooldown.clear(); mesh.createOutgoingLink = (id) => { const l = mk({ createInitialOffer: async () => { throw new Error("x"); } }); mesh.links.set(id, l); return l; }; await attemptConnectViaRelay("zed");
    return o; })()`));
  assert.ok(c.offered >= 1); assert.equal(c.status, "disconnected"); assert.deepEqual(c.relayReq, ["relay-request"]);
  // handleRelayPayload
  const rr = J(a.run(`(() => { const o = {}; const sentTo = {}; const mk = (id) => ({ status: "connected", send: (p) => { (sentTo[id] = sentTo[id] || []).push(p.kind); return true; } }); mesh.links.set("hub", mk("hub")); mesh.links.set("tgt", mk("tgt")); mesh.links.set("req", mk("req"));
    window.handleIncomingOffer = async (f, p, reply) => { reply({ t: "answer" }); }; window.handleIncomingAnswer = async () => { window.__ans = 1; };
    handleRelayPayload("hub", { kind: "relay-request", to: "tgt", packet: { t: "offer" } }); handleRelayPayload("hub", { kind: "relay-request", to: "none", packet: {} });
    handleRelayPayload("hub", { kind: "relay-deliver", from: "req", packet: { t: "offer", x: "rl1" } }); handleRelayPayload("hub", { kind: "relay-deliver", from: "req", packet: { t: "offer", x: "rl1" } });
    handleRelayPayload("hub", { kind: "relay-deliver-response", to: "req", packet: { t: "answer" } }); handleRelayPayload("hub", { kind: "relay-deliver-response", to: "nobody", packet: {} });
    handleRelayPayload("hub", { kind: "relay-response", from: "tgt", packet: { t: "answer", x: "rl2" } }); handleRelayPayload("hub", { kind: "relay-response", from: "tgt", packet: { t: "answer", x: "rl2" } }); handleRelayPayload("hub", { kind: "other" });
    o.sent = sentTo; return o; })()`));
  await sleep(20); assert.deepEqual(rr.sent.tgt, ["relay-deliver"]); assert.equal(a.window.__ans, 1);
  a.close();
});

test("проверка канала (linkauth): успех, неверный тег, таймаут, даунгрейд, повтор", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(await a.run(`(async () => { const o = {};
    const me = await CryptoHelper.generateKeyPair(), al = await CryptoHelper.generateKeyPair(); Store.myPrivateKeyJwk = me.privateKeyJwk; Store.myPublicKeyJwk = me.publicKeyJwk;
    const c = state.contacts.get("alice"); c.publicKey = al.publicKeyJwk;
    const peerKey = await LinkAuth.secret(al.privateKeyJwk, me.publicKeyJwk, "alice", "me");
    const mkLink = () => { const l = { close() {}, status: "connected", dc: { readyState: "open" }, sent: [], send(p) { this.sent.push(p); return true; }, fingerprints: () => ({ local: "AA:BB", remote: "CC:DD" }) }; return l; };
    // успешная проверка
    let link = mkLink(); mesh.links.set("alice", link); startLinkAuth("alice"); o.pending = [link.authGate, link.sent[0].kind];
    await onAuthMessage("alice", link, { s: 1, n: "peerNonce" }); const tag = await LinkAuth.tag(peerKey, "alice", "me", "peerNonce", link._myNonce, "CC:DD", "AA:BB"); await onAuthMessage("alice", link, { s: 2, t: tag });
    o.ok = [link.authState, link.authGate, c.authSeen];
    // чужой/неверный тег
    c.authSeen = false; link = mkLink(); mesh.links.set("alice", link); startLinkAuth("alice"); await onAuthMessage("alice", link, { s: 1, n: "pn2" }); await onAuthMessage("alice", link, { s: 2, t: "AAAA" }); o.fail = [link.authState, link.authGate, mesh.links.has("alice")];
    // таймаут без authSeen — unverified; с authSeen — fail (даунгрейд)
    link = mkLink(); mesh.links.set("alice", link); startLinkAuth("alice"); __fk.tick(7000); o.timeout = [link.authState, link.authGate];
    c.authSeen = true; authToastAt.clear(); link = mkLink(); mesh.links.set("alice", link); startLinkAuth("alice"); __fk.tick(7000); o.downgrade = [link.authState, mesh.links.has("alice"), c.messages.some((m) => m.textKey === "sys.linkAuthDowngrade")];
    // нет отпечатков
    c.authSeen = false; link = mkLink(); link.fingerprints = () => ({}); mesh.links.set("alice", link); startLinkAuth("alice"); await onAuthMessage("alice", link, { s: 1, n: "pn3" }); o.noFp = link.authState;
    // нет ключа у контакта: канал открывается без проверки; при authSeen — закрывается
    c.publicKey = null; link = mkLink(); mesh.links.set("alice", link); startLinkAuth("alice"); o.noKey = link.authGate; c.authSeen = true; link = mkLink(); mesh.links.set("alice", link); authToastAt.clear(); startLinkAuth("alice"); o.noKeyDowngrade = [link.authGate, mesh.links.has("alice")]; c.authSeen = false; c.publicKey = al.publicKeyJwk;
    // канал не открыт / нет линка / повтор
    link = mkLink(); link.dc.readyState = "closed"; mesh.links.set("alice", link); startLinkAuth("alice"); startLinkAuth("none"); o.closedDc = link._authStarted;
    link = mkLink(); mesh.links.set("alice", link); startLinkAuth("alice"); startLinkAuth("alice"); await onAuthMessage("alice", link, { s: 1, n: "x".repeat(100) }); await onAuthMessage("alice", link, { s: 2, t: "t".repeat(200) }); await onAuthMessage("alice", link, { s: 9 }); o.badMsgs = link._peerNonce;
    // повторный запрос на проверку (reauth) после завершения
    link.authGate = null; await onAuthMessage("alice", link, { s: 1, n: "fresh" }); reauthLink("alice"); reauthLink("none"); mesh.links.set("alice", { status: "disconnected" }); reauthLink("alice");
    // authDowngradeNotice: частота, mismatch, pendingKey
    authToastAt.clear(); authDowngradeNotice("alice", "mismatch"); authDowngradeNotice("alice", "mismatch"); authDowngradeNotice("none", "x"); c.pendingKey = { key: {} }; authToastAt.clear(); authDowngradeNotice("alice", "downgrade"); c.pendingKey = undefined;
    return o; })()`));
  assert.deepEqual(r.pending, ["pending", "auth"]); assert.deepEqual(r.ok, ["ok", null, true]); assert.deepEqual(r.fail, ["fail", "closed", false]); assert.deepEqual(r.timeout, ["unverified", null]); assert.deepEqual(r.downgrade, ["fail", false, true]); assert.equal(r.noFp, "unverified"); assert.equal(r.noKey, null); assert.deepEqual(r.noKeyDowngrade, ["closed", false]); assert.equal(r.closedDc, undefined); assert.equal(r.badMsgs, null);
  a.close();
});

test("QR и приглашения: сканирование (контакт, группа, сверка), add-контакт по значению, список онлайн, мастер групп", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const r = J(await a.run(`(async () => { const o = {};
    o.parse = [parseQrAddPayload("ether://add?id=abc&name=Zed"), parseQrAddPayload("ether://add?name=x"), parseQrAddPayload("zzz"), parseQrAddPayload(null)];
    renderQrToCanvas(null); renderQrToCanvas(document.getElementById("my-qr-canvas")); renderQrToCanvas(document.getElementById("my-qr-canvas"), "ether://group?x=1"); renderMyQrCode();
    document.getElementById("show-my-qr-btn").click(); o.qrShown = !document.getElementById("my-qr-sheet").classList.contains("hidden");
    return o; })()`));
  assert.deepEqual(r.parse[0], { id: "abc", name: "Zed" }); assert.equal(r.parse[1], null); assert.ok(r.qrShown);
  // сканирование: нет камеры / отказ / распознан код
  a.run(`window.jsQR = (d, w, h) => window.__qrResult || null; state.tab = "connect"; renderTab();`);
  const stream = `{ getTracks: () => [{ stop() { window.__stopped = 1; } }] }`;
  a.run(`Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });`); await a.run(`startQrScan()`); assert.ok(a.document.querySelector("#qr-scan-status").textContent.length > 0);
  a.run(`Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => { throw new Error("denied"); } }, configurable: true });`); await a.run(`startQrScan()`);
  a.run(`window.requestAnimationFrame = (f) => { window.__rafq = f; return 3; }; window.cancelAnimationFrame = () => {}; window.addContactFromCard = (id, n) => { window.__qrAdd = [id, n]; }; window.joinGroupViaInvite = (c) => { window.__qrJoin = c; }; window.onSafetyQrScanned = (d) => { window.__qrSafety = d; };
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => (${stream}) }, configurable: true });
    const v = document.getElementById("qr-scan-video"); Object.defineProperty(v, "readyState", { value: 4, configurable: true }); Object.defineProperty(v, "HAVE_ENOUGH_DATA", { value: 4, configurable: true }); Object.defineProperty(v, "videoWidth", { value: 4, configurable: true }); Object.defineProperty(v, "videoHeight", { value: 4, configurable: true }); v.play = async () => {};`);
  await a.run(`startQrScan()`);
  const scan = (data) => { a.window.__qrResult = data ? { data } : null; a.window.__rafq(); };
  scan(null); scan("junk"); a.run(`qrScanVerifyMode = true;`); scan("ether://verify?n=123"); assert.equal(a.window.__qrSafety, "ether://verify?n=123");
  await a.run(`startQrScan()`); scan("ether://add?id=qr1&name=QR"); assert.deepEqual(J(a.window.__qrAdd), ["qr1", "QR"]);
  await a.run(`startQrScan()`); scan("ether://group?gid=g&ref=r"); assert.ok(a.window.__qrJoin);
  a.run(`stopQrScan(); stopQrScan(); document.querySelector("#scan-qr-sheet .sheet-cancel").click();`);
  // добавление контакта по значению
  a.run(`window.confirmSheet = async () => true; window.joinGroupViaInvite = async (c) => { window.__join2 = c; };`);
  const addVal = a.document.querySelector("#add-contact-value"), addName = a.document.querySelector("#add-contact-name"), addBtn = a.document.querySelector("#add-contact-btn");
  const typeVal = async (v) => { addVal.value = v; addVal.dispatchEvent(new a.window.Event("input")); await sleep(30); };
  await typeVal(""); await typeVal("bad"); assert.ok(addVal.classList.contains("input-invalid")); await typeVal("ether://group?gid=a&ref=b"); assert.ok(!addVal.classList.contains("input-invalid")); await typeVal("new@example.com"); assert.ok(!addVal.classList.contains("input-invalid"));
  const click = async () => { addBtn.click(); await sleep(60); };
  addVal.value = ""; await click(); addVal.value = "ether://group?gid=a&ref=b"; await click(); assert.ok(a.window.__join2);
  addVal.value = "bad"; await click(); addVal.value = "new@example.com"; addName.value = "Newbie"; await click(); assert.ok([...a.run(`[...state.contacts.values()].map((c) => c.name)`)].includes("Newbie"));
  addVal.value = "new@example.com"; await click(); a.run(`state.tab = "connect"; renderTab();`);
  const myIdent = await a.run(`(async () => { const i = await Identity.idFor("me@example.com"); Store.myId = i.id; return i.id; })()`); addVal.value = "me@example.com"; await click();
  // онлайн-список
  a.run(`onlineRoster.set("stranger1", { name: "Str", visible: true, publicKey: null }); onlineRoster.set("hidden1", { name: "H", visible: false }); renderOnlineRosterList();`); assert.equal(a.document.querySelectorAll("#online-roster-list .roster-row").length, 1);
  a.document.querySelector("#online-roster-list .roster-add-btn").click(); assert.ok(a.run(`state.contacts.has("stranger1")`)); a.run(`onlineRoster.clear(); renderOnlineRosterList();`);
  // мастер групп
  a.run(`state.tab = "connect"; renderTab(); window.attemptConnectViaRelay = async () => {}; window.attemptConnect = () => {};`);
  a.document.querySelector("#new-group-btn").click(); assert.ok(a.document.querySelectorAll("#new-group-members .group-member-check").length >= 2);
  a.document.querySelector("#new-group-create-btn").click();
  a.document.querySelectorAll("#new-group-members .group-member-check").forEach((c) => { c.checked = true; }); a.document.querySelector("#new-group-name").value = "Wizard"; a.document.querySelector("#new-group-create-btn").click(); assert.ok(a.run(`[...state.contacts.values()].some((c) => c.isGroup && c.name === "Wizard")`));
  // инфо о группе: кнопки
  a.run(`state.activeGroupContext = state.chatId; openGroupInfo(state.chatId); window.copyText = (t, m) => { window.__copied = t; }; window.startGroupCall = (g, v) => { window.__gcall = g; };`);
  a.document.querySelector("#group-info-name").value = "Renamed W"; a.document.querySelector("#group-info-rename-btn").click(); a.document.querySelector("#group-info-description").value = "dd"; a.document.querySelector("#group-info-description-btn").click();
  a.document.querySelector("#group-info-call-btn").click(); assert.ok(a.window.__gcall); const wr = a.document.querySelector("#group-info-write-restricted"); wr.checked = true; wr.dispatchEvent(new a.window.Event("change"));
  a.document.querySelector("#group-info-add-btn").click(); a.document.querySelector("#group-info-invite-link-btn").click(); a.document.querySelector("#group-invite-copy-btn").click(); assert.ok(a.window.__copied.startsWith("ether://group?"));
  a.document.querySelector("#group-info-leave-btn").click(); await sleep(30);
  a.close();
});
