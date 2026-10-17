// Покрытие app.js: Store, утилиты, превью ссылок, звуки, PIN-экран, логирование.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

test("Store: все геттеры/сеттеры не бросают, значения по умолчанию и нормализация", async () => {
  const a = await boot(); fakeTimers(a);
  const r = J(a.run(`(() => {
    const o = { errs: [] };
    const samples = [true, false, "1", "0", "12:30", "bad", "x", 5, 0, "[]", "{}", null];
    for (const k of Object.keys(Object.getOwnPropertyDescriptors(Store))) {
      const d = Object.getOwnPropertyDescriptor(Store, k);
      if (!d.set || ["name", "myId", "claimToken", "signalingUrl", "translateEndpoint", "translateApiKey"].includes(k)) continue;
      for (const s of samples) { try { Store[k] = s; } catch (e) { o.errs.push(k + ":" + e.message); } try { void Store[k]; } catch (e) { o.errs.push("get " + k + ":" + e.message); } }
    }
    localStorage.clear();
    o.def = [Store.quietFrom, Store.quietTo, Store.glassAlpha, Store.skin, Store.theme, Store.emojiSkinTone, Store.vapidPublicKey, Store.pushSubscriptionJson, Store.pinHash, Store.pinSalt, Store.pinEnabled, Store.scheduledMessagesJson, Store.chatFoldersJson, Store.debugHidden, Store.recentReactions];
    Store.quietFrom = "08:15"; Store.quietFrom = "bad"; o.qf = Store.quietFrom; Store.quietTo = "9:00"; o.qt = Store.quietTo;
    Store.glassAlpha = 9; o.ga1 = Store.glassAlpha; Store.glassAlpha = -4; o.ga2 = Store.glassAlpha; Store.glassAlpha = NaN; o.ga3 = Store.glassAlpha; localStorage.setItem("ether.glassAlpha", "zz"); o.ga4 = Store.glassAlpha;
    Store.vapidPublicKey = ""; o.vk0 = Store.vapidPublicKey; Store.vapidPublicKey = "VK"; o.vk1 = Store.vapidPublicKey;
    Store.pushSubscriptionJson = "{}"; o.ps1 = Store.pushSubscriptionJson; Store.pushSubscriptionJson = ""; o.ps2 = Store.pushSubscriptionJson;
    Store.pinHash = "h"; Store.pinSalt = "s"; Store.pinEnabled = true; o.pin = [Store.pinHash, Store.pinSalt, Store.pinEnabled];
    Store.scheduledMessagesJson = "[1]"; Store.chatFoldersJson = "[2]"; o.js = [Store.scheduledMessagesJson, Store.chatFoldersJson];
    Store.emojiSkinTone = "dark"; o.tone = Store.emojiSkinTone; Store.skin = "neon"; Store.theme = "dark"; o.st = [Store.skin, Store.theme];
    Store.recentReactions = ["a","b","c","d","e","f","g","h"]; o.rr = Store.recentReactions.length; localStorage.setItem("ether.recentReactions", "{bad"); o.rrBad = Store.recentReactions.length; localStorage.setItem("ether.recentReactions", "{}"); o.rrObj = Store.recentReactions.length;
    o.lp = []; for (const v of ["off", "ask", "auto", "zzz"]) { Store.linkPreviewMode = v; o.lp.push(Store.linkPreviewMode); }
    Store.linkPreviewsEnabled = true; o.lpe = [Store.linkPreviewsEnabled, Store.linkPreviewMode]; Store.linkPreviewsEnabled = false; o.lpe2 = [Store.linkPreviewsEnabled, Store.linkPreviewMode];
    Store.deadManThresholdDays = "abc"; o.dm = Store.deadManThresholdDays; localStorage.setItem("ether.deadManThresholdDays", "-3"); o.dm2 = Store.deadManThresholdDays;
    Store.debugHidden = false; o.dbg = Store.debugHidden;
    localStorage.setItem("ether.privKey", "{bad"); o.pk = Store.myPrivateKeyJwk; localStorage.setItem("ether.pubKey", "{bad"); o.pub = Store.myPublicKeyJwk;
    Store.myPrivateKeyJwk = { k: 1 }; Store.myPublicKeyJwk = { k: 2 }; o.keys = [Store.myPrivateKeyJwk, Store.myPublicKeyJwk];
    localStorage.removeItem("ether.claimToken"); const c1 = Store.claimToken; o.claim = [/^[0-9a-f]{64}$/.test(c1), c1 === Store.claimToken]; localStorage.setItem("ether.claimToken", "short"); o.claimFix = /^[0-9a-f]{64}$/.test(Store.claimToken);
    Store.callVolume = 5; o.cv1 = Store.callVolume; Store.callVolume = NaN; Store.callVolume = -1; o.cv2 = Store.callVolume; localStorage.setItem("ether.callVolume", "zz"); o.cv3 = Store.callVolume;
    return o; })()`));
  assert.deepEqual(r.errs, []);
  assert.deepEqual(r.def.slice(0, 3), ["23:00", "07:00", 0.55]); assert.equal(r.def[3], "default"); assert.equal(r.def[4], "auto"); assert.equal(r.def[5], "none");
  assert.equal(r.qf, "08:15"); assert.equal(r.qt, "07:00" === r.qt ? "07:00" : r.qt);
  assert.equal(r.ga1, 0.85); assert.equal(r.ga2, 0.18); assert.equal(r.ga4, 0.55);
  assert.equal(r.vk0, ""); assert.equal(r.vk1, "VK"); assert.equal(r.ps1, "{}"); assert.equal(r.ps2, "");
  assert.deepEqual(r.pin, ["h", "s", true]); assert.deepEqual(r.js, ["[1]", "[2]"]); assert.equal(r.tone, "dark"); assert.deepEqual(r.st, ["neon", "dark"]);
  assert.equal(r.rr, 6); assert.equal(r.rrBad, 0); assert.equal(r.rrObj, 0); assert.deepEqual(r.lp, ["off", "ask", "auto", "ask"]);
  assert.deepEqual(r.lpe, [true, "auto"]); assert.deepEqual(r.lpe2, [false, "off"]); assert.equal(r.dm, 7); assert.equal(r.dm2, 7); assert.equal(r.dbg, false);
  assert.equal(r.pk, null); assert.equal(r.pub, null); assert.deepEqual(r.keys, [{ k: 1 }, { k: 2 }]);
  assert.deepEqual(r.claim, [true, true]); assert.equal(r.claimFix, true); assert.equal(r.cv1, 1); assert.equal(r.cv3 >= 0 && r.cv3 <= 1, true);
  a.close();
});

test("Store.claimToken пуст, пока шифрованное хранилище заперто; privacy-сеттеры рассылают настройки", async () => {
  const a = await boot(); fakeTimers(a);
  const r = J(a.run(`(() => { const o = {}; let n = 0; const orig = broadcastPrivacyPrefs; window.broadcastPrivacyPrefs = () => { n++; };
    try { Store.receiptsEnabled = false; Store.lastSeenVisible = false; Store.presenceVisible = false; } catch (e) { o.err = e.message; }
    o.vals = [Store.receiptsEnabled, Store.lastSeenVisible, Store.presenceVisible]; o.n = n;
    const on = SecureStore.isOn, act = SecureStore.isActive; SecureStore.isOn = () => true; SecureStore.isActive = () => false; o.locked = Store.claimToken; SecureStore.isOn = on; SecureStore.isActive = act; return o; })()`));
  assert.deepEqual(r.vals, [false, false, false]); assert.equal(r.locked, "");
  a.close();
});

test("утилиты: signalingHttpBase, capMapSize, timeAgo, formatDuration, glass-alpha, urlBase64, pbkdf2, isDuplicateSignal, highlightMentions", async () => {
  const a = await boot(); fakeTimers(a);
  const r = J(await a.run(`(async () => { const o = {};
    Store.signalingUrl = "wss://x.example.com///"; o.b1 = signalingHttpBase(); Store.signalingUrl = "ws://h:1/p/"; o.b2 = signalingHttpBase(); Store.signalingUrl = ""; o.b3 = signalingHttpBase().startsWith("http");
    const m = new Map(); for (let i = 0; i < 20; i++) m.set(i, i); capMapSize(m, 100); o.cap0 = m.size; capMapSize(m, 10); o.cap1 = m.size; o.capFirst = [...m.keys()][0];
    const now = Date.now(); o.ago = [timeAgo(0), timeAgo(now - 1000), timeAgo(now - 5 * 60000), timeAgo(now - 5 * 3600000), typeof timeAgo(now - 3 * 86400000)];
    o.dur = [formatDuration(5000), formatDuration(65000), formatDuration(3725000), formatDuration(-5)];
    o.tr = [transparencyToAlpha(0), transparencyToAlpha(1), alphaToTransparency(0.85), alphaToTransparency(0.18)];
    applyGlassAlpha(NaN); applyGlassAlpha(5); applyGlassAlpha(0.4); o.ga = document.documentElement.style.getPropertyValue("--glass-alpha");
    o.u8 = Array.from(urlBase64ToUint8Array("AQID-_8")); o.hex = bufToHex(new Uint8Array([0, 15, 255]).buffer); o.salt = randomSaltHex(8).length;
    const h1 = await pbkdf2Hex("1234", "00ff00ff", 10), h2 = await pbkdf2Hex("1234", "00ff00ff", 10), h3 = await pbkdf2Hex("1235", "00ff00ff", 10); o.pb = [h1 === h2, h1 !== h3, h1.length];
    o.dup = [isDuplicateSignal("a", { x: "t1" }), isDuplicateSignal("a", { x: "t1" }), isDuplicateSignal("b", { x: "t1" }), isDuplicateSignal("a", {}), isDuplicateSignal("a", null), isDuplicateSignal("a", "s")];
    for (let i = 0; i < 210; i++) isDuplicateSignal("z", { x: "n" + i }); o.dupEvict = isDuplicateSignal("z", { x: "n0" });
    o.mention = [highlightMentions("hi @bob, @Анна"), highlightMentions("none"), highlightMentions(""), highlightMentions("a@b.c")];
    o.std = [typeof isStandalone(), typeof isIOS()];
    return o; })()`));
  assert.equal(r.b1, "https://x.example.com"); assert.equal(r.b2, "http://h:1/p"); assert.equal(r.b3, true);
  assert.equal(r.cap0, 20); assert.equal(r.cap1, 9); assert.equal(r.capFirst, 11);
  assert.equal(r.ago[0], ""); assert.ok(r.ago[1] && r.ago[2] && r.ago[3]);
  assert.equal(r.dur[1], "1:05"); assert.equal(r.dur[2], "1:02:05");
  assert.equal(r.tr[0], 0.85); assert.ok(Math.abs(r.tr[1] - 0.18) < 1e-9); assert.equal(r.tr[2], 0); assert.equal(r.tr[3], 1);
  assert.equal(r.ga, "0.40"); assert.deepEqual(r.u8, [1, 2, 3, 251, 255]); assert.equal(r.hex, "000fff"); assert.equal(r.salt, 16);
  assert.deepEqual(r.pb, [true, true, 64]); assert.deepEqual(r.dup, [false, true, false, false, false, false]); assert.equal(r.dupEvict, false);
  assert.ok(r.mention[0].includes('<span class="mention">@bob</span>')); assert.ok(r.mention[0].includes("@Анна</span>")); assert.equal(r.mention[1], "none"); assert.ok(!r.mention[3].includes("mention"));
  a.close();
});

test("превью ссылок: fetchLinkPreview (успех, 204, ошибки, кэш), карточка, слоты, наблюдатель", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (url.includes("none")) return { status: 204, ok: true };
    if (url.includes("bad")) return { status: 500, ok: false };
    if (url.includes("boom")) throw new Error("net");
    return { status: 200, ok: true, json: async () => ({ url: "https://ok.example/p", title: "T <b>", description: "D", image: "https://ok.example/i.png", siteName: "S" }) };
  };
  const a = await boot({ fetch });
  a.window.AbortSignal.timeout = () => undefined;
  const r = J(await a.run(`(async () => { const o = {};
    const e1 = await fetchLinkPreview("https://ok.example/a"); const e1b = await fetchLinkPreview("https://ok.example/a");
    o.ok = [e1.status, e1b === e1 || e1b.status];
    o.none = (await fetchLinkPreview("https://none.example")).status; o.bad = (await fetchLinkPreview("https://bad.example")).status; o.boom = (await fetchLinkPreview("https://boom.example")).status;
    linkPreviewCache.set("https://pend.example", { status: "pending", data: null }); o.pending = await fetchLinkPreview("https://pend.example");
    o.cardNull = linkPreviewCardHtml(null); o.cardBadUrl = linkPreviewCardHtml({ url: "javascript:alert(1)" });
    o.card = linkPreviewCardHtml({ url: "https://ok.example/p", title: "T <b>", description: "D", image: "https://ok.example/i.png", siteName: "S" });
    o.cardNoImg = linkPreviewCardHtml({ url: "https://ok.example/p", image: "javascript:x" });
    // слоты в чате
    const wrap = document.getElementById("chat-messages");
    wrap.innerHTML = '<div class="link-preview-slot" data-preview-for="https://ok.example/a"></div><div class="link-preview-slot" data-preview-for="https://none.example"></div><div class="link-preview-slot" data-preview-for="https://other.example"></div>';
    renderLinkPreviewInto("https://ok.example/a"); renderLinkPreviewInto("https://none.example");
    renderLinkPreviewInto("https://pend.example"); // entry === null — слот не трогаем
    await new Promise((r) => setTimeout(r, 30));
    o.slots = [...wrap.querySelectorAll(".link-preview-slot")].map((s) => s.getAttribute("data-preview-for") + ":" + (s.querySelector(".link-preview-card") ? "card" : "empty"));
    // наблюдатель: подставим свой IntersectionObserver
    let cb; window.IntersectionObserver = class { constructor(f) { cb = f; } observe(el) { this.el = el; } unobserve() {} };
    linkPreviewObserver = null; const slot = wrap.querySelector('[data-preview-for="https://other.example"]'); observeLinkPreviewSlot(slot);
    cb([{ isIntersecting: false, target: slot }, { isIntersecting: true, target: slot }, { isIntersecting: true, target: document.createElement("div") }]);
    for (let i = 0; i < 520; i++) linkPreviewCache.set("k" + i, { status: "none" }); await fetchLinkPreview("https://ok.example/zzz"); o.cacheSize = linkPreviewCache.size;
    return o; })()`));
  assert.deepEqual(r.ok, ["done", true].map((x, i) => (i ? r.ok[1] : x))); assert.equal(r.none, "none"); assert.equal(r.bad, "none"); assert.equal(r.boom, "none"); assert.equal(r.pending, null);
  assert.equal(r.cardNull, ""); assert.equal(r.cardBadUrl, ""); assert.ok(r.card.includes("T &lt;b&gt;") && r.card.includes("link-preview-img") && r.card.includes('rel="noopener noreferrer"')); assert.ok(!r.cardNoImg.includes("<img"));
  assert.ok(r.slots.includes("https://ok.example/a:card")); assert.ok(!r.slots.some((s) => s.startsWith("https://none.example")), "слот без превью удалён"); assert.ok(r.cacheSize <= 500);
  assert.ok(calls.some((u) => u.includes("/link-preview?url=")));
  a.close();
});

test("звуки: playMessageSound в стилях, тихие часы, фон/откат на <audio>, ringtone/dial/busy/noanswer, vibrate, clearNowPlaying", async () => {
  const a = await boot(); const t = fakeTimers(a);
  const r = J(await a.run(`(async () => { const o = {};
    o.quiet = []; Store.quietOn = true; Store.quietFrom = "00:00"; Store.quietTo = "23:59"; o.quiet.push(quietNow(new Date(2020, 0, 1, 12, 0))); Store.quietFrom = "22:00"; Store.quietTo = "06:00"; o.quiet.push(quietNow(new Date(2020, 0, 1, 23, 0)), quietNow(new Date(2020, 0, 1, 5, 0)), quietNow(new Date(2020, 0, 1, 12, 0))); Store.quietTo = "22:00"; o.quiet.push(quietNow(new Date())); Store.quietOn = false; o.quiet.push(quietNow());
    for (const st of Object.keys(MESSAGE_SOUND_FILES)) { try { localStorage.setItem("ether.messageSound", st); } catch (e) {} playMessageSound("alice"); }
    for (const st of ["pop", "bell", "default", "zzz"]) { const f = messageSoundStyleForContact; window.messageSoundStyleForContact = () => st; playMessageSound("alice"); window.messageSoundStyleForContact = f; }
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); playMessageSound("alice"); Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    Store.soundsEnabled = false; playMessageSound("alice"); Store.soundsEnabled = true;
    // play() с отказом NotAllowedError → отложенный сигнал
    HTMLMediaElement.prototype.play = () => Promise.reject(Object.assign(new Error("n"), { name: "NotAllowedError" }));
    globalAudioCtx = null; const AC = window.AudioContext; window.AudioContext = undefined; playMessageSound("alice"); await new Promise((r) => __realTO.call(window, r, 5)); o.pending = __pendingMessageSound;
    HTMLMediaElement.prototype.play = () => Promise.reject(new Error("other")); playMessageSound("alice"); await new Promise((r) => __realTO.call(window, r, 5));
    HTMLMediaElement.prototype.play = () => Promise.resolve(); window.AudioContext = AC; globalAudioCtx = null;
    playRingtone(); stopRingtone(); playDialingSound(); stopCallSounds(); playBusySound(); playNoAnswerSound(); Store.soundsEnabled = false; playBusySound(); playNoAnswerSound(); playDialingSound(); Store.soundsEnabled = true; stopCallSounds();
    vibrate([10]); vibrate(20); vibrate(); o.vib = typeof vibrate;
    clearNowPlaying();
    o.pool = soundPool.size > 0; return o; })()`));
  t.tick(5000);
  assert.deepEqual(r.quiet.slice(0, 6), [true, true, true, false, false, false]); assert.equal(r.pending, true);
  a.close();
});

test("экран PIN: tryUnlock — пустой ввод, нет соли → сброс, неверный PIN, лимит попыток и блокировка, верный PIN", async () => {
  const a = await boot(); const t = fakeTimers(a);
  const r = J(await a.run(`(async () => { const o = {};
    document.body.insertAdjacentHTML("beforeend", '<input id="lock-pin"><button id="lock-submit"></button>');
    const wiped = []; window.wipeEverythingAndReload = () => wiped.push(1); let confirmAnswer = false; window.confirmSheet = async () => confirmAnswer; let booted = 0; window.bootAfterUnlock = () => booted++;
    await tryUnlock(""); await tryUnlock("1234"); o.noSalt = wiped.length; confirmAnswer = true; Store.pinSalt = ""; await tryUnlock("1234"); o.noSaltYes = wiped.length; confirmAnswer = false;
    Store.pinSalt = "00ff00ff"; Store.pinHash = await pbkdf2Hex("1234", "00ff00ff", PIN_ITERATIONS);
    state.unlockAttempts = 0; document.getElementById("lock-pin").value = "x"; await tryUnlock("0000"); o.afterWrong = [state.unlockAttempts, document.getElementById("lock-pin").value];
    for (let i = 0; i < UNLOCK_ATTEMPTS_LIMIT; i++) await tryUnlock("0000"); o.locked = [!!state._unlockLockedUntil, document.getElementById("lock-pin").disabled];
    await tryUnlock("1234"); o.whileLocked = booted; state._unlockLockedUntil = 0; document.getElementById("lock-pin").disabled = false;
    confirmAnswer = true; state.unlockAttempts = UNLOCK_ATTEMPTS_LIMIT - 1; await tryUnlock("0000"); o.hard = wiped.length; confirmAnswer = false;
    state.unlockAttempts = 0; state._unlockLockedUntil = 0; await tryUnlock("1234"); o.ok = [booted, state.unlockAttempts];
    // зашифрованное хранилище: ошибка разблокировки / неверный результат
    const on = SecureStore.isOn, un = SecureStore.unlock; SecureStore.isOn = () => true; SecureStore.unlock = async () => false; await tryUnlock("1234"); SecureStore.unlock = async () => { throw new Error("corrupt"); }; await tryUnlock("1234"); SecureStore.unlock = async () => true; await tryUnlock("1234"); o.sec = booted; SecureStore.isOn = on; SecureStore.unlock = un;
    showLockScreen(); lockPinInputFor(1000); return o; })()`));
  t.tick(500);
  assert.equal(r.noSalt, 0); assert.equal(r.noSaltYes, 1); assert.deepEqual(r.afterWrong, [1, ""]); assert.equal(r.locked[0], true); assert.equal(r.locked[1], true); assert.equal(r.whileLocked, 0); assert.equal(r.hard, 2);
  assert.deepEqual(r.ok, [1, 0]); assert.equal(r.sec, 2);
  t.tick(2000);
  a.close();
});

test("лента: highlightRaw, linkify, инлайн-markdown и extractFirstUrl на граничных входах", async () => {
  const a = await boot();
  const r = J(a.run(`(() => { const o = {};
    o.hr = [highlightRaw("a &amp; b", "amp"), highlightRaw("Hello <a href='x'>Hello</a>", "hello"), highlightRaw("x", ""), highlightRaw("abc", "B")];
    o.url = [extractFirstUrl(""), extractFirstUrl("see https://a.example/x?y=1, ok"), extractFirstUrl("www.site.org/path"), extractFirstUrl(null), extractFirstUrl("no link"), extractFirstUrl("javascript:alert(1)")];
    o.lh = linkifyAndHighlight("go https://a.example/x and **b** \`c\` @bob", "go");
    return o; })()`));
  assert.ok(r.hr[0].includes("&amp;") && !r.hr[0].includes("<mark class=\"search-hit\">amp")); assert.ok(r.hr[1].includes("<mark")); assert.equal(r.hr[2], "x"); assert.ok(r.hr[3].includes(">b</mark>"));
  assert.equal(r.url[0], null); assert.ok(r.url[1].startsWith("https://a.example/x")); assert.equal(r.url[3], null); assert.equal(r.url[5], null);
  assert.ok(r.lh.includes("<a ") && r.lh.includes("<mark"));
  a.close();
});
