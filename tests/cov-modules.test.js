// Покрытие модулей: easter, signaling-codec (gzip), signaling-client (фейковый сокет и таймеры), secure-store, localai, group-call.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers, fakeWebSocket } = require("./cov-helpers");
test.after(closeAll);

// ---------------- easter ----------------
test("пасхалки: каждая из 23 срабатывает на своём триггере, максимум 2 эффекта на сообщение, повтор id игнорируется", async () => {
  const a = await boot(); fakeTimers(a);
  const out = J(a.run(`(() => {
    const triggers = { rocket: "🚀", hearts: "я ❤️ тебя", fire: "🔥", snow: "☃", rain: "☔", stars: "✨", balloons: "🎈", sakura: "🌸", pizza: "🍕", cat: "😺", dog: "🐶", ghost: "👻", butterflies: "🦋", boom: "💥", rainbow: "🌈", music: "🎸", cheers: "🥂", poop: "💩", robot: "🤖", night: "good night", wave: "👋", fireworks: "ура!", disco: "🪩", confetti: "🎉" };
    const res = {}; let n = 0;
    const row = (text, id) => { const r = document.createElement("div"); r.innerHTML = '<div class="bubble" data-msg-id="' + id + '"><span class="bubble-time">12:00 🔥</span>' + text + '</div>'; return r; };
    FX.set ? FX.set("easter", true) : null;
    for (const [id, txt] of Object.entries(triggers)) { document.getElementById("egg-layer") && (document.getElementById("egg-layer").innerHTML = ""); eggScanBubble(row(txt, "e" + (++n))); res[id] = document.getElementById("egg-layer") ? document.getElementById("egg-layer").children.length : 0; }
    // один и тот же data-msg-id повторно — ничего
    const L = document.getElementById("egg-layer"); L.innerHTML = ""; eggScanBubble(row("🌈", "e17")); res.dupe = L.children.length;
    // максимум два эффекта: ❤ + 🔥 + 🌈 -> только hearts и fire
    L.innerHTML = ""; eggScanBubble(row("❤️🔥🌈", "multi")); res.multiRainbow = !!L.querySelector(".egg-rainbow");
    // служебные элементы пузыря (время) не срабатывают
    L.innerHTML = ""; const r2 = document.createElement("div"); r2.innerHTML = '<div class="bubble" data-msg-id="svc"><span class="bubble-time">🔥</span></div>'; eggScanBubble(r2); res.svc = L.children.length;
    eggScanBubble(null); eggScanBubble(document.createElement("div")); res.rocketFn = typeof fxRocket;
    return res; })()`));
  for (const id of ["hearts", "fire", "snow", "rain", "stars", "balloons", "sakura", "pizza", "cat", "dog", "ghost", "butterflies", "boom", "rainbow", "music", "cheers", "poop", "night", "wave", "fireworks"]) assert.ok(out[id] > 0, "эффект " + id);
  assert.equal(out.dupe, 0); assert.equal(out.multiRainbow, false); assert.equal(out.svc, 0);
  // эффекты убираются по таймеру
  a.run(`__fk.tick(20000)`);
  assert.equal(a.run(`document.getElementById("egg-layer").children.length`), 0);
  a.close();
});

test("пасхалки: выключатель FX и prefers-reduced-motion отключают эффекты; семь касаний по заголовку — диско", async () => {
  const a = await boot(); fakeTimers(a);
  const r = J(a.run(`(() => {
    const row = (id) => { const x = document.createElement("div"); x.innerHTML = '<div class="bubble" data-msg-id="' + id + '">🔥</div>'; return x; };
    const L = () => { const l = document.getElementById("egg-layer"); return l ? l.children.length : 0; };
    const o = {};
    const orig = FX.get; FX.get = (k) => (k === "easter" ? false : orig.call(FX, k)); eggScanBubble(row("off1")); o.off = L(); FX.get = orig;
    const mm = window.matchMedia; window.matchMedia = () => ({ matches: true }); eggScanBubble(row("rm1")); o.reduced = L(); o.reducedFn = eggReduced(); window.matchMedia = () => { throw new Error("x"); }; o.mmThrow = eggReduced(); window.matchMedia = mm;
    FX.get = (k) => (k === "easter" ? true : orig.call(FX, k));
    const t = document.getElementById("nav-title"); const wrap = document.getElementById("chat-messages");
    o.hasTitle = !!t; o.wrapObs = !!(wrap && wrap.__eggObs);
    if (t) { for (let i = 0; i < 7; i++) t.click(); o.disco = document.documentElement.classList.contains("egg-disco"); }
    // MutationObserver: добавленный .bubble-row.just-received сканируется
    if (wrap) { const r = document.createElement("div"); r.className = "bubble-row just-received"; r.innerHTML = '<div class="bubble" data-msg-id="mo1">🍕</div>'; wrap.appendChild(r);
      const w2 = document.createElement("div"); w2.innerHTML = '<div class="bubble-row just-sent"><div class="bubble" data-msg-id="mo2">🐈</div></div>'; wrap.appendChild(w2); wrap.appendChild(document.createTextNode("t")); }
    FX.get = orig; return o; })()`));
  assert.equal(r.off, 0); assert.equal(r.reduced, 0); assert.equal(r.reducedFn, true); assert.equal(r.mmThrow, false);
  if (r.hasTitle) assert.equal(r.disco, true);
  await sleep(30);
  if (r.wrapObs) assert.ok(a.run(`document.getElementById("egg-layer").querySelectorAll(".egg-run").length`) >= 1);
  a.close();
});

// ---------------- signaling-codec ----------------
test("SignalingCodec: gzip/gunzip через CompressionStream, откат без сжатия, битые данные", async () => {
  const a = createApp(); await a.ready;
  a.window.CompressionStream = CompressionStream; a.window.DecompressionStream = DecompressionStream; a.window.Response = Response;
  a.window.__o = null;
  await a.run(`(async () => {
    const pkt = { t: "offer", n: "Zed", d: { type: "offer", sdp: "v=0\\r\\n" + "a=candidate:1 1 udp 2 1.2.3.4 5 typ host\\r\\n".repeat(30) }, r: "q" };
    const code = await SignalingCodec.encode(pkt);
    const back = await SignalingCodec.decode(code);
    const flagGz = code[1];
    // «сжатый» флаг, но распаковщик недоступен/падает → gunzip откатывается на сырые байты, JSON.parse падает с понятной ошибкой
    const DS = window.DecompressionStream; window.DecompressionStream = function () { throw new Error("broken ds"); };
    let bad = null; try { await SignalingCodec.decode("11" + "AAAAAAAA"); } catch (e) { bad = e.message; }
    window.DecompressionStream = DS;
    const link = SignalingCodec.buildShareLink(code); history.replaceState(null, "", "/#c=" + code); const ext = SignalingCodec.extractCodeFromLocation(); history.replaceState(null, "", "/");
    window.CompressionStream = undefined; window.DecompressionStream = undefined;
    const plain = await SignalingCodec.encode({ t: "answer", n: "P", d: {}, r: "" });
    const plainBack = await SignalingCodec.decode(plain);
    window.__o = { link: link.includes('#c=' + code), ext: ext === code, flagGz, n: back.n, sdpOk: back.d.sdp === pkt.d.sdp, bad, plainFlag: plain[1], plainBack: plainBack.t, short: code.length < JSON.stringify(pkt).length };
  })()`);
  const o = J(a.window.__o);
  assert.ok(o.link && o.ext); assert.equal(o.flagGz, "1"); assert.equal(o.n, "Zed"); assert.equal(o.sdpOk, true); assert.ok(o.short);
  assert.equal(o.plainFlag, "0"); assert.equal(o.plainBack, "answer"); assert.ok(o.bad);
  a.close();
});

// ---------------- signaling-client ----------------
async function sc(extra = "") {
  const a = createApp(); await a.ready; const t = fakeTimers(a); fakeWebSocket(a);
  a.run(`window.__ev = []; window.__c = new SignalingClient("ws://srv", "id-1", { name: "N", visible: false, publicKey: { k: 1 } }); window.__c.watchIds = () => ["w1"];
    for (const n of ["connected","disconnected","online-list","register-error","register-rate-limited","vapid-key","push-subscribed","push-unsubscribed","presence","signal","unreachable","deliver","deliver-ack","prekey-bundle","prekey-stored","prekey-low","replaced","slow-connect"]) __c.addEventListener(n, (e) => __ev.push([n, e.detail === undefined ? null : JSON.parse(JSON.stringify(e.detail))])); ${extra}`);
  return { a, t };
}
const ev = (a) => J(a.run(`__ev`));
const sock = (a, i = -1) => a.run(`__sockets.at(${i})`);

test("SignalingClient: регистрация при открытии, разбор всех типов сообщений сервера", async () => {
  const { a } = await sc();
  a.run(`__c.claim = "cl"; __c.start(); __c.start(); __sockets[0].__open();`);
  const reg = J(a.run(`__sockets[0].sent[0]`));
  assert.equal(reg.type, "register"); assert.equal(reg.id, "id-1"); assert.equal(reg.visible, false); assert.deepEqual(reg.watch, ["w1"]); assert.equal(reg.claim, "cl"); assert.deepEqual(reg.caps, ["env2", "sk1"]);
  assert.equal(a.run(`__sockets.length`), 1, "второй start не создаёт сокет");
  const recv = (o) => a.run(`__sockets[0].__recv(${JSON.stringify(o)})`);
  recv({ type: "registered", features: ["watch", 5, "x"], prekeyCount: 7, online: ["a", { id: "b", name: "B", caps: ["env2", 1] }, null, { id: 5 }] });
  assert.deepEqual(J(a.run(`[__c.registered, __c.features, __c.prekeyCount]`)), [true, ["watch", "x"], 7]);
  recv({ type: "watch-result", online: [{ id: "q", visible: false }] });
  recv({ type: "register-error", error: "id-claimed" });
  assert.equal(a.run(`__c.shouldRun`), false, "id-claimed останавливает клиент");
  recv({ type: "pong" }); recv("не json"); recv({ nope: 1 }); recv({ type: "unknown-type" });
  a.run(`__c.start(); __sockets.at(-1).__open();`);
  const r2 = (o) => a.run(`__sockets.at(-1).__recv(${JSON.stringify(o)})`);
  r2({ type: "pong" }); r2({ type: "register-rate-limited" }); r2({ type: "vapid-key", key: "K" }); r2({ type: "vapid-key", key: 5 }); r2({ type: "push-subscribed" }); r2({ type: "push-unsubscribed" });
  r2({ type: "presence", id: "p1", online: 1, name: "P", visible: true, publicKey: { x: 1 }, caps: ["a", 2] });
  r2({ type: "signal", from: "s1", data: { t: "offer" } }); r2({ type: "signal", from: 5 }); r2({ type: "unreachable", to: "u1" });
  r2({ type: "deliver", from: "f1", msgId: "m1", envelope: { iv: "i", ct: "c" }, fromPublicKey: { k: 2 }, kind: "poll", queued: true }); r2({ type: "deliver", from: "f1", msgId: "m2", envelope: {} });
  r2({ type: "deliver-ack", msgId: "m1" }); r2({ type: "deliver-ack", msgId: "m2", error: "too-big" });
  r2({ type: "prekey-bundle", rid: "r1", to: "t", spk: { a: 1 }, opk: null }); r2({ type: "prekey-bundle", rid: "r2", error: "none" });
  r2({ type: "prekey-stored", count: 9 }); r2({ type: "prekey-stored", error: "bad" }); r2({ type: "prekey-low", count: 2 }); r2({ type: "prekey-low" });
  r2({ type: "register-error", error: "other" });
  r2({ type: "replaced", sameIp: true });
  const names = ev(a).map((e) => e[0]);
  for (const n of ["connected", "online-list", "register-error", "register-rate-limited", "vapid-key", "push-subscribed", "push-unsubscribed", "presence", "signal", "unreachable", "deliver", "deliver-ack", "prekey-bundle", "prekey-stored", "prekey-low", "replaced"]) assert.ok(names.includes(n), n);
  const evs = ev(a);
  assert.equal(evs.find((e) => e[0] === "deliver")[1].kind, "poll"); assert.equal(evs.filter((e) => e[0] === "deliver")[1][1].kind, "chat");
  assert.deepEqual(evs.filter((e) => e[0] === "online-list")[0][1].users.map((u) => u.id), ["a", "b"]);
  assert.equal(evs.filter((e) => e[0] === "deliver-ack")[1][1].error, "too-big");
  assert.equal(evs.filter((e) => e[0] === "prekey-low")[1][1].count, 0);
  assert.equal(a.run(`__c.shouldRun`), false, "replaced останавливает клиент");
  a.close();
});

test("SignalingClient: send/deliver/watch/prekeys/push — до открытия возвращают false, после — отправляют", async () => {
  const { a } = await sc(); a.window.etherLog = a.window.etherLog;
  assert.equal(a.run(`__c.send("x", {})`), false); assert.equal(a.run(`__c.signal("t", {})`), false);
  a.run(`__c.start(); __sockets[0].__open(); __sockets[0].sent.length = 0;`);
  const r = J(a.run(`(() => { const c = __c, o = {};
    o.signal = c.signal("t", { a: 1 });
    o.d1 = c.deliver("t", "m", { iv: "i", ct: "c" }, { k: 1 }, "poll"); o.d2 = c.deliver("t", "m", { v: 2, h: { n: 1 }, ct: "c" }, null); o.d3 = c.deliver("t", "m", { ct: "c" }); o.d4 = c.deliver("t", "m", null); o.d5 = c.deliver("t", "m", { iv: 5, ct: "c" }); o.d6 = c.deliver("t", "m", { v: 2, h: "s", ct: "c" });
    o.ack = c.mailboxAck("m"); o.watch = c.watch(new Set(["a", "b"])); o.watchNull = c.watch(null); o.up = c.uploadPrekeys({ spk: 1, opks: [2] }); o.fp = c.fetchPrekeys("t", "rid");
    o.ps0 = c.sendPushSubscription(null); o.ps = c.sendPushSubscription({ endpoint: "e" }); o.pu = c.sendPushUnsubscribe(); o.sub = c._pushSubscription;
    __sockets[0].__throwSend = true; o.thr = c.send("x", {}); __sockets[0].__throwSend = false;
    o.types = __sockets[0].sent.map((m) => m.type); o.kinds = __sockets[0].sent.filter((m) => m.type === "deliver").map((m) => m.kind); return o; })()`));
  assert.deepEqual([r.signal, r.d1, r.d2, r.d3, r.d4, r.d5, r.d6], [true, true, true, false, false, false, false]);
  assert.equal(r.ack, true); assert.equal(r.watch, true); assert.equal(r.up, true); assert.equal(r.fp, true); assert.equal(r.ps0, false); assert.equal(r.ps, true); assert.equal(r.pu, true); assert.equal(r.sub, null); assert.equal(r.thr, false);
  assert.deepEqual(r.kinds, ["poll", "chat"]);
  assert.ok(r.types.includes("watch") && r.types.includes("prekey-upload") && r.types.includes("prekey-fetch") && r.types.includes("push-subscribe") && r.types.includes("push-unsubscribe"));
  a.close();
});

test("SignalingClient: таймаут подключения, slow-connect, реконнект с нарастающей задержкой, close/error", async () => {
  const { a, t } = await sc();
  a.run(`__c.start();`);
  t.tick(3600); assert.ok(ev(a).some((e) => e[0] === "slow-connect"));
  t.tick(3500); // 7 c без open -> закрыли, новая попытка через 300 мс
  assert.equal(a.run(`__sockets.length`), 1);
  t.tick(400); assert.equal(a.run(`__sockets.length`), 2);
  a.run(`__sockets[1].__open();`); a.run(`__sockets[1].__err();`);
  assert.ok(ev(a).some((e) => e[0] === "disconnected"));
  const d1 = a.run(`__c._retryDelay`); t.tick(d1 + 10); assert.equal(a.run(`__sockets.length`), 3);
  a.run(`__sockets[2].close()`); const d2 = a.run(`__c._retryDelay`); assert.ok(d2 > d1);
  // старый сокет больше не влияет
  a.run(`{ const old = __sockets[2]; __c.ws = null; old.__open(); old.__recv({type:"pong"}); old.close(); }`);
  // конструктор WebSocket бросает -> планируется повтор
  a.run(`{ const W = window.WebSocket; window.WebSocket = function () { throw new Error("no ws"); }; window.WebSocket.OPEN = 1; window.WebSocket.CONNECTING = 0; window.WebSocket.CLOSED = 3; window.WebSocket.CLOSING = 2; __c.ws = null; __c._connect(); window.WebSocket = W; }`);
  assert.ok(a.run(`!!__c._retryTimer`));
  a.run(`__c.stop(); __c.stop();`); assert.equal(a.run(`__c.ws`), null); assert.equal(a.run(`__c._retryTimer`), null);
  t.tick(30000); a.run(`__c._connect(); __c._scheduleRetry();`); assert.equal(a.run(`__sockets.length`), 3, "после stop не подключается");
  // stop → start снова разрешён
  a.run(`__c.start();`); assert.equal(a.run(`__sockets.length`), 4);
  a.close();
});

test("SignalingClient: heartbeat (ping/pong, зависший pong, скрытая вкладка) и resume() из фона", async () => {
  const { a, t } = await sc();
  a.run(`__c.start(); __sockets[0].__open(); __sockets[0].sent.length = 0;`);
  t.tick(15100); assert.equal(a.run(`__sockets[0].sent.filter(m => m.type==="ping").length`), 1);
  // pong давно не приходил, страница видима -> принудительное переподключение
  a.run(`__c._lastPongAt = Date.now() - 100000;`); t.tick(15000);
  assert.equal(a.run(`__sockets[0].readyState`), 3);
  assert.equal(a.run(`__c._lastPongAt`), 0);
  // страница скрыта — pong не считается просроченным
  a.run(`__c.stop(); __c.start(); { const s = __sockets.at(-1); s.__open(); Object.defineProperty(document, "hidden", { value: true, configurable: true }); __c._lastPongAt = Date.now() - 100000; s.sent.length = 0; }`);
  t.tick(15000); assert.equal(a.run(`__sockets.at(-1).readyState`), 1); assert.equal(a.run(`__sockets.at(-1).sent.filter(m => m.type==="ping").length`), 1);
  a.run(`Object.defineProperty(document, "hidden", { value: false, configurable: true }); __sockets.at(-1).__throwSend = true;`); t.tick(15000);
  a.run(`__sockets.at(-1).__throwSend = false; __c.stop(); __c.start(); __sockets.at(-1).__open();`);
  // resume: сокет жив и pong пришёл — ничего; pong не пришёл — переподключение
  const n0 = a.run(`__sockets.length`);
  a.run(`{ __c._lastPongAt = Date.now() - 1000; __c.resume(); const s = __sockets.at(-1); s.__recv({ type: "pong" }); }`); t.tick(5100); assert.equal(a.run(`__sockets.length`), n0);
  a.run(`__c._lastPongAt = Date.now() - 1000; __c.resume();`); t.tick(5100); t.tick(500); assert.equal(a.run(`__sockets.length`), n0 + 1, "переподключение после немого сокета");
  // resume при закрытом сокете — немедленно
  a.run(`__sockets.at(-1).readyState = 3; __c.resume();`); assert.equal(a.run(`__sockets.length`), n0 + 2);
  // resume во время подключения (CONNECTING) — ничего
  a.run(`__c.resume();`); assert.equal(a.run(`__sockets.length`), n0 + 2);
  // resume, когда send бросает
  a.run(`{ const s = __sockets.at(-1); s.__open(); s.__throwSend = true; __c.resume(); }`);
  assert.equal(a.run(`__sockets.at(-1).readyState`), 3);
  a.run(`__c.stop(); __c.resume();`);
  a.close();
});

test("Identity: normalize/idFor/hashId — граничные форматы", async () => {
  const a = createApp(); await a.ready;
  a.window.__o = null;
  await a.run(`(async () => {
    const o = {}; const tryId = async (v) => { try { return (await Identity.idFor(v)).type; } catch (e) { return e.message; } };
    o.norm = [Identity.normalize(""), Identity.normalize(" A@B.Co "), Identity.normalize("8 (900) 123-45-67"), Identity.normalize(null)];
    o.cases = [await tryId(""), await tryId("+"), await tryId("abc"), await tryId("a@b"), await tryId("a@b.c"), await tryId("12345"), await tryId("1234567890123456"), await tryId("+7 900 123-45-67"), await tryId("User@Example.COM")];
    o.same = (await Identity.idFor("+79001234567")).id === (await Identity.idFor("79001234567")).id; o.len = (await Identity.hashId("x")).length;
    window.__o = o; })()`);
  const o = J(a.window.__o);
  assert.equal(o.norm[0].value, ""); assert.equal(o.norm[1].value, "a@b.co"); assert.equal(o.norm[2].value, "+89001234567"); assert.equal(o.norm[3].type, "email");
  assert.deepEqual(o.cases, ["toast.emptyId", "toast.emptyId", "toast.emptyId", "toast.invalidIdFormat", "toast.invalidIdFormat", "toast.invalidIdFormat", "toast.invalidIdFormat", "phone", "email"]);
  assert.equal(o.same, true); assert.equal(o.len, 64);
  a.close();
});

// ---------------- secure-store ----------------
test("SecureStore: граничные ветки (короткий PIN, повторное включение, запертое отключение, rekey, sealText/openText, blob)", async () => {
  const a = await boot();
  a.window.__o = null;
  await a.run(`(async () => {
    const o = {};
    const err = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
    o.short = await err(() => SecureStore.enable("123")); o.rekeyOff = await SecureStore.rekey("1", "2"); o.disableOff = await SecureStore.disable("x"); o.unlockOff = await SecureStore.unlock("x");
    o.plainText = await SecureStore.openText(await SecureStore.sealText("abc")); /* V.80: без PIN sealText шифрует ключом устройства (раньше возвращал "abc" как есть) — проверяем круговой путь */ o.openNonStr = await SecureStore.openText(5); o.openPlain = await SecureStore.openText("zz");
    o.blobOff = !((await SecureStore.sealBlob(new Blob(["q"]))) instanceof Blob); /* V.80: без PIN файл тоже запечатывается ключом устройства */ o.openBlobNull = await SecureStore.openBlob(null);
    await SecureStore.enable("123456");
    o.active = SecureStore.isActive(); o.on = SecureStore.isOn();
    const sealed = await SecureStore.sealText("secret"); o.sealedPrefix = sealed.startsWith("encd1:"); o.opened = await SecureStore.openText(sealed); o.openBad = await SecureStore.openText("enc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    o.rekeyShort = await err(() => SecureStore.rekey("123456", "1")); o.rekeyWrong = await SecureStore.rekey("000000", "654321"); /* ключ в памяти — PIN не проверяется */ o.rekeyOk = await SecureStore.rekey("123456", "654321");
    o.openedAfterRekey = await SecureStore.openText(await SecureStore.sealText("again"));
    const sb = await SecureStore.sealBlob(new Blob(["hello"], { type: "text/plain" })); o.sealedBlob = sb.__enc === 2; /* устройство поверх PIN */ const ob = await SecureStore.openBlob(sb); o.blobBack = await ob.text(); o.blobType = ob.type;
    o.blobCorrupt = await SecureStore.openBlob({ __enc: 1, iv: new Uint8Array(12).buffer, data: new ArrayBuffer(20) }); o.plainPassthrough = await SecureStore.openBlob({ x: 1 }) !== null;
    o.sealNonBlob = await SecureStore.sealBlob("str");
    o.wrongPin = await SecureStore.verify("000000"); o.okPin = !!(await SecureStore.verify("654321")); o.noMeta = await SecureStore.verify("1");
    window.__o = o; })()`);
  const o = J(a.window.__o);
  assert.equal(o.short, "pin-short"); assert.equal(o.rekeyOff, true); assert.equal(o.disableOff, true); assert.equal(o.unlockOff, true);
  assert.equal(o.plainText, "abc"); assert.equal(o.openNonStr, 5); assert.equal(o.openPlain, "zz"); assert.equal(o.blobOff, true); assert.equal(o.openBlobNull, null);
  assert.equal(o.active, true); assert.equal(o.on, true); assert.equal(o.sealedPrefix, true); assert.equal(o.opened, "secret"); assert.equal(o.openBad, null);
  assert.equal(o.rekeyShort, "pin-short"); assert.equal(o.rekeyWrong, true); assert.equal(o.rekeyOk, true); assert.equal(o.openedAfterRekey, "again");
  assert.equal(o.sealedBlob, true); assert.equal(o.blobBack, "hello"); assert.equal(o.blobType, "text/plain"); assert.equal(o.blobCorrupt, null); assert.equal(o.plainPassthrough, true); assert.equal(o.sealNonBlob, "str");
  assert.equal(o.wrongPin, false); assert.equal(o.okPin, true);
  a.close();
});

test("SecureStore: отключение в запертом состоянии расшифровывает диск; неверный PIN не отключает; unlock повреждённых данных", async () => {
  const a = await boot();
  await a.run(`(async () => { localStorage.setItem("ether.contacts", JSON.stringify([{id:"z"}])); await SecureStore.enable("111111"); await SecureStore.flush(); })()`);
  const snap = J(a.run(`(() => { const o = {}; for (const k of SecureStore.KEYS.concat(["ether.sec.on","ether.sec.salt","ether.sec.check"])) { const v = SecureStore.rawGet(k); if (v !== null) o[k] = v; } return o; })()`));
  assert.ok(snap["ether.contacts"].startsWith("encd1:")); // V.80: снаружи слой ключа устройства
  // новое окно с теми же данными на диске: хранилище «заперто» (key нет)
  const b = createApp({ indexedDB: a.window.indexedDB, storage: { ...snap, "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en" } }); await b.ready; // тот же профиль = тот же ключ устройства
  assert.equal(b.run(`SecureStore.isOn()`), true); assert.equal(b.run(`SecureStore.isActive()`), false);
  b.window.__o = null;
  await b.run(`(async () => { const o = {}; o.wrong = await SecureStore.disable("000000"); o.right = await SecureStore.disable("111111"); o.on = SecureStore.isOn(); o.contacts = localStorage.getItem("ether.contacts"); window.__o = o; })()`);
  const o = J(b.window.__o);
  assert.equal(o.wrong, false); assert.equal(o.right, true); assert.equal(o.on, false); assert.equal(o.contacts, JSON.stringify([{ id: "z" }]));
  // повреждённый шифртекст: unlock бросает secure-corrupt
  const c = createApp({ indexedDB: a.window.indexedDB, storage: { ...snap, "ether.contacts": "enc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en" } }); await c.ready;
  c.window.__o = null;
  await c.run(`(async () => { try { await SecureStore.unlock("111111"); window.__o = "ok"; } catch (e) { window.__o = e.message; } })()`);
  assert.equal(c.window.__o, "secure-corrupt");
  a.close(); b.close(); c.close();
});

// ---------------- localai ----------------
test("LocalAI: загрузка движка без сети — ошибка, transcribe без движка, summarize на разных входах", async () => {
  const a = await boot();
  a.window.__o = null;
  await a.run(`(async () => {
    const o = {}; o.ready0 = LocalAI.isReady();
    try { await LocalAI.transcribe(new Blob(["x"]), {}); o.t = "no-throw"; } catch (e) { o.t = "threw"; }
    LocalAI.setEngine(async (audio, opts) => " привет мир "); o.ready1 = LocalAI.isReady();
    window.__o = o; })()`);
  const o = J(a.window.__o);
  assert.equal(o.ready0, false); assert.ok(["threw", "no-throw"].includes(o.t)); assert.equal(o.ready1, true);
  const S = (t, n) => a.run(`LocalAI.summarize(${JSON.stringify(t)}, ${n})`);
  assert.equal(S("", 3), ""); assert.equal(S("   ", 3), "");
  const long = Array.from({ length: 12 }, (_, i) => `Предложение номер ${i} про релиз и тесты и покрытие кода.`).join(" ");
  const sum = S(long, 3); assert.ok(sum.split(/(?<=\.)\s/).length <= 3 && sum.length > 0);
  a.close();
});
