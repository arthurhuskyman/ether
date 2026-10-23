// Покрытие app.js: онбординг, экран PIN, язык, Service Worker, push-уведомления, запуск по ссылке/уведомлению, dead-man.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createApp, closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers, installTouch, loadLang } = require("./cov-helpers");
test.after(closeAll);

const hash = (pin, saltHex) => crypto.pbkdf2Sync(pin, Buffer.from(saltHex, "hex"), 120000, 32, "sha256").toString("hex");

test("онбординг: слайды, сетка языков, проверка идентичности, анонимный профиль, старт приложения", async () => {
  const a = createApp({ storage: { "ether.lang": "en" } }); await a.ready;
  const t = fakeTimers(a);
  assert.ok(!a.document.querySelector("#onboarding").classList.contains("hidden"), "онбординг показан");
  assert.equal(a.run(`__appStarted`), false);
  const q = (s) => a.document.querySelector(s);
  assert.equal(a.document.querySelectorAll(".onboarding-lang-btn").length, 8);
  assert.ok(q("#onboarding-lang-select").options.length >= 72);
  // слайды вперёд/назад
  q(".onboarding-next").click(); assert.equal(a.run(`__onboardingSlide`), 1);
  q(".onboarding-back").click(); assert.equal(a.run(`__onboardingSlide`), 0);
  a.run(`goToOnboardingSlide(-5)`); assert.equal(a.run(`__onboardingSlide`), 0); a.run(`goToOnboardingSlide(99)`); assert.equal(a.run(`__onboardingSlide`), 2); a.run(`goToOnboardingSlide(0)`);
  // смена языка кнопкой сетки (словарь подгружен заранее) и селектором
  loadLang(a, "de");
  a.document.querySelector('.onboarding-lang-btn[data-lang="de"]') && a.document.querySelector('.onboarding-lang-btn[data-lang="de"]').click();
  a.run(`applyOnboardingLanguage("de")`);
  assert.equal(a.run(`I18N.current`), "de");
  a.run(`applyOnboardingLanguage("zz")`); // неподдерживаемый код → тост об ошибке
  q("#onboarding-lang-select").value = "en"; q("#onboarding-lang-select").dispatchEvent(new a.window.Event("change"));
  // живая валидация идентичности
  const idf = q("#onboarding-identity"); const setId = async (v) => { idf.value = v; idf.dispatchEvent(new a.window.Event("input")); await sleep(30); };
  await setId("bad"); assert.ok(idf.classList.contains("input-invalid"));
  await setId("user@example.com"); assert.ok(!idf.classList.contains("input-invalid")); assert.ok(!q("#onboarding-id-check").classList.contains("hidden"));
  await setId(""); assert.ok(q("#onboarding-id-check").classList.contains("hidden"));
  // отправка формы: пустое имя — ничего; неверная идентичность — тост; затем анонимный профиль
  const submit = async () => { q("#onboarding-form").dispatchEvent(new a.window.Event("submit", { cancelable: true })); await sleep(60); };
  q("#onboarding-name").value = ""; await submit(); assert.equal(a.run(`Store.name`), "");
  q("#onboarding-name").value = "Zed"; idf.value = "bad"; await submit(); assert.equal(a.run(`Store.name`), ""); assert.ok(idf.classList.contains("input-invalid"));
  idf.value = ""; await submit();
  assert.equal(a.run(`Store.name`), "Zed"); assert.ok(a.run(`Store.myId`).length > 20); assert.equal(a.run(`Store.myIdentityRaw`), ""); assert.equal(a.run(`localStorage.getItem("ether.discoverable")`), "0");
  assert.equal(a.run(`__onboardingSlide`), 2, "переход на последний (третий) шаг");
  assert.equal(q("#onboarding-ready-name").textContent, "Zed"); assert.ok(q("#onboarding-avatar").textContent.length > 0);
  // повторный запуск с телефоном
  idf.value = "+7 900 123-45-67"; await submit(); for (let i = 0; i < 100 && a.run(`document.getElementById("onboarding-invite-code").textContent`) !== "+79001234567"; i++) { t.tick(100); await sleep(50); } // таймеры в этом тесте фальшивые: вывод id v2 уступает кадр через setTimeout; новый аккаунт: id v2 (PBKDF2 600k) считается дольше кадра
  assert.equal(a.run(`Store.myIdentityRaw`), "+79001234567"); assert.match(a.run(`Store.myId`), /^v2:[0-9a-f]{64}$/, "новый аккаунт сразу на id v2");
  assert.equal(a.run(`document.getElementById("onboarding-invite-code").textContent`), "+79001234567");
  // drag-and-drop на карточку и кнопка импорта
  const card = q(".onboarding-card"); for (const ev of ["dragenter", "dragover"]) card.dispatchEvent(new a.window.Event(ev, { cancelable: true })); assert.ok(card.classList.contains("drag-over"));
  card.dispatchEvent(new a.window.Event("dragleave", { cancelable: true })); assert.ok(!card.classList.contains("drag-over"));
  a.run(`window.importBackupFile = (f) => { window.__dropped = f && f.name; };`);
  const drop = new a.window.Event("drop", { cancelable: true }); drop.dataTransfer = { files: [{ name: "b.json" }] }; card.dispatchEvent(drop); assert.equal(a.window.__dropped, "b.json");
  const drop2 = new a.window.Event("drop", { cancelable: true }); drop2.dataTransfer = { files: [] }; card.dispatchEvent(drop2);
  let clicked = 0; q("#import-backup-input").addEventListener("click", () => clicked++); q("#onboarding-import-backup-btn") && q("#onboarding-import-backup-btn").click();
  // старт
  q("#onboarding-start-btn").click(); await sleep(100); t.tick(5000); await sleep(100);
  assert.equal(a.run(`__appStarted`), true); assert.ok(q("#onboarding").classList.contains("hidden"));
  a.run(`startApp()`); // повторный вызов — только показывает оболочку
  assert.ok(!q("#app-shell").classList.contains("hidden"));
  a.close();
});

test("экран PIN при запуске: неверный и верный PIN, «забыл PIN» со сбросом, повторная привязка", async () => {
  const salt = "00112233aabbccdd"; const h = hash("2468", salt);
  const a = createApp({ storage: { "ether.lang": "en", "ether.name": "T", "ether.myId": "me-test-id", "ether.pinEnabled": "1", "ether.pinSalt": salt, "ether.pinHash": h } }); await a.ready;
  assert.ok(!a.document.querySelector("#lock-screen").classList.contains("hidden"), "экран блокировки показан");
  assert.equal(a.run(`__appStarted`), false);
  const pin = a.document.querySelector("#lock-pin"), submit = a.document.querySelector("#lock-submit");
  pin.value = "0000"; submit.click(); await sleep(900);
  assert.equal(a.run(`state.unlockAttempts`), 1); assert.equal(pin.value, "");
  a.run(`window.__wiped = 0; window.wipeEverythingAndReload = () => { __wiped++; }; window.confirmSheet = async () => true;`);
  a.document.querySelector("#lock-forgot").click(); await sleep(30); assert.equal(a.window.__wiped, 1);
  pin.value = "2468"; pin.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true })); await sleep(1500);
  for (let i = 0; i < 80 && !a.run(`__appStarted`); i++) await sleep(50);
  assert.equal(a.run(`__appStarted`), true); assert.ok(a.document.querySelector("#lock-screen").classList.contains("hidden"));
  a.close();
});

test("язык: предложение системного языка (да/нет), селектор языка в настройках", async () => {
  const a = await boot(); fakeTimers(a);
  loadLang(a, "de"); loadLang(a, "fr");
  const r = J(a.run(`(() => { const o = {};
    Object.defineProperty(navigator, "languages", { value: ["de-DE"], configurable: true }); Object.defineProperty(navigator, "language", { value: "de-DE", configurable: true });
    localStorage.removeItem(I18N.OFFER_KEY); I18N.setLang("en");
    maybeOfferSystemLanguage(); o.shown = !document.getElementById("lang-offer").classList.contains("hidden"); o.txt = document.getElementById("lang-offer-text").textContent;
    document.getElementById("lang-offer-no").click(); o.hiddenAfterNo = document.getElementById("lang-offer").classList.contains("hidden"); o.offered = localStorage.getItem(I18N.OFFER_KEY);
    maybeOfferSystemLanguage(); o.noSecond = document.getElementById("lang-offer").classList.contains("hidden");
    localStorage.removeItem(I18N.OFFER_KEY); I18N.setLang("en");
    maybeOfferSystemLanguage(); document.getElementById("lang-offer-yes").click(); o.after = I18N.current;
    const sel = document.getElementById("settings-language"); o.opts = sel ? sel.options.length : -1;
    if (sel) { sel.value = "fr"; sel.dispatchEvent(new Event("change")); o.afterSel = I18N.current; sel.value = "zz"; }
    return o; })()`));
  assert.equal(r.shown, true); assert.ok(r.txt.length > 0); assert.equal(r.hiddenAfterNo, true); assert.equal(r.offered, "1"); assert.equal(r.after, "de");
  if (r.opts > 0) assert.ok(r.opts >= 72);
  a.close();
});

function fakeSW(a) {
  a.run(`(() => { const sw = new EventTarget(); sw.controller = { postMessage(m) { (window.__ctrlMsgs = window.__ctrlMsgs || []).push(m); } }; sw.__regs = [];
    const mkReg = () => { const reg = new EventTarget(); reg.waiting = null; reg.installing = null; reg.active = { postMessage(m) { (window.__activeMsgs = window.__activeMsgs || []).push(m); } }; reg.updates = 0; reg.update = () => { reg.updates++; return Promise.resolve(); };
      const subs = { current: null }; reg.pushManager = { getSubscription: async () => subs.current, subscribe: async (o) => { window.__subOpts = o; subs.current = { endpoint: "https://fcm.googleapis.com/x", expirationTime: null, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "a", auth: "b" } }; }, unsubscribe: async () => { subs.current = null; return true; } }; return subs.current; } }; reg.__subs = subs; return reg; };
    sw.register = async () => { const r = mkReg(); window.__reg = r; return r; };
    sw.ready = (async () => { const r = mkReg(); window.__readyReg = r; return r; })();
    Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true }); window.__sw = sw; window.PushManager = function () {}; })()`);
}

test("Service Worker: регистрация, сообщения из SW, баннер обновления, автоприменение, push-подписка", async () => {
  const a = await boot(); const t = fakeTimers(a); fakeSW(a);
  a.run(`state.contacts.set("alice", { id: "alice", name: "Alice", messages: [{ id: "x", from: "them", text: "hi", ts: Date.now() }], lastActivity: 1 }); Store.notificationsEnabled = true; Store.vapidPublicKey = "AQID";`);
  a.run(`wireServiceWorker();`); await sleep(30);
  assert.ok(a.window.__reg, "register вызван");
  t.tick(1100); await sleep(30); // ensurePushSubscription
  assert.ok(a.window.__subOpts && a.window.__subOpts.userVisibleOnly, "подписка создана");
  assert.ok(a.run(`Store.pushSubscriptionJson`).includes("fcm.googleapis"));
  // сообщения из SW
  const post = (data) => a.run(`__sw.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(data)} }))`);
  post({ type: "open-contact", contactId: "alice", kind: "message" }); assert.equal(a.run(`state.chatId`), "alice");
  post({ type: "open-contact", contactId: "alice", kind: "message", focusInput: true }); t.tick(100);
  post({ type: "mark-read", contactId: "alice" }); post({ type: "mark-read", contactId: "nobody" }); post({ type: "push-subscription-changed" }); post({}); a.run(`__sw.dispatchEvent(new MessageEvent("message", { data: null }))`);
  // обновление страницы при смене контроллера (один раз)
  a.run(`sessionStorage.removeItem("ether.reloadingForUpdate"); __sw.dispatchEvent(new Event("controllerchange"));`); assert.equal(a.run(`sessionStorage.getItem("ether.reloadingForUpdate")`), "1");
  a.run(`__sw.dispatchEvent(new Event("controllerchange"));`);
  // видимость → update(); таймер 30 мин и час
  a.run(`document.dispatchEvent(new Event("visibilitychange"))`); t.fireEvery(30 * 60 * 1000); assert.ok(a.run(`__reg.updates`) >= 2);
  a.run(`Store.pushSubscriptionJson = JSON.stringify({ expirationTime: Date.now() + 1000 })`); t.fireEvery(60 * 60 * 1000); await sleep(20);
  a.run(`Store.pushSubscriptionJson = "{bad"`); t.fireEvery(60 * 60 * 1000); a.run(`Store.pushSubscriptionJson = ""`); t.fireEvery(60 * 60 * 1000);
  // ожидающий SW → баннер → «Обновить» / «Позже»
  const r = J(a.run(`(() => { const o = {}; const reg = new EventTarget(); const posted = []; reg.waiting = { postMessage: (m) => posted.push(m) };
    sessionStorage.removeItem("ether.updateDismissedAt"); watchForWaitingSW(reg); o.banner = !!document.getElementById("update-banner");
    document.querySelector('#update-banner [data-act="reload"]').click(); o.posted = posted.slice();
    document.querySelector('#update-banner [data-act="dismiss"]').click(); o.dismissed = !document.getElementById("update-banner"); showUpdateBanner(reg); o.suppressed = !document.getElementById("update-banner");
    sessionStorage.removeItem("ether.updateDismissedAt"); showUpdateBanner(reg); showUpdateBanner(reg); o.once = document.querySelectorAll("#update-banner").length;
    reg.waiting = null; document.querySelector('#update-banner [data-act="reload"]').click();
    // установка нового SW
    const reg2 = new EventTarget(); const nsw = new EventTarget(); reg2.installing = nsw; watchForWaitingSW(reg2); reg2.dispatchEvent(new Event("updatefound")); nsw.state = "installing"; nsw.dispatchEvent(new Event("statechange")); nsw.state = "installed"; nsw.dispatchEvent(new Event("statechange")); o.noCtrl = true;
    const reg3 = new EventTarget(); reg3.installing = null; watchForWaitingSW(reg3); reg3.dispatchEvent(new Event("updatefound"));
    // автоприменение
    o.auto = [shouldAutoApplyUpdate(null), shouldAutoApplyUpdate({ waitingSince: 1, now: 1 + UPDATE_AUTO_AFTER_MS, hidden: true, inCall: false, hasDraft: false }), shouldAutoApplyUpdate({ waitingSince: 1, now: 5, hidden: true }), shouldAutoApplyUpdate({ waitingSince: 1, now: 1 + UPDATE_AUTO_AFTER_MS, hidden: false }), shouldAutoApplyUpdate({ waitingSince: 1, now: 1 + UPDATE_AUTO_AFTER_MS, hidden: true, inCall: true }), shouldAutoApplyUpdate({ waitingSince: 1, now: 1 + UPDATE_AUTO_AFTER_MS, hidden: true, hasDraft: true })];
    const regW = { waiting: { postMessage: (m) => posted.push(["auto", m]) } }; o.maybeNo = maybeAutoApplyUpdate(regW); o.maybeNull = maybeAutoApplyUpdate(null);
    __swWaitingSince = 1; Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); o.maybeYes = maybeAutoApplyUpdate(regW); Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const ci = document.getElementById("chat-input"); o.unsaved0 = swHasUnsavedInput(); if (ci) { ci.value = "draft"; o.unsaved1 = swHasUnsavedInput(); ci.value = ""; }
    return o; })()`));
  assert.equal(r.banner, true); assert.deepEqual(r.posted, [{ type: "SKIP_WAITING" }]); assert.equal(r.dismissed, true); assert.equal(r.suppressed, true); assert.equal(r.once, 1);
  assert.deepEqual(r.auto, [false, true, false, false, false, false]); assert.equal(r.maybeNo, false); assert.equal(r.maybeNull, false); assert.equal(r.maybeYes, true); assert.equal(r.unsaved0, false);
  // ensurePushSubscription: отключено/нет VAPID/нет подписки → null; истекающая подписка пересоздаётся; сервер получает подписку
  const e = J(await a.run(`(async () => { const o = {}; Store.notificationsEnabled = false; o.off = await ensurePushSubscription(); Store.notificationsEnabled = true; Store.vapidPublicKey = ""; localStorage.removeItem("ether.vapidPublicKey"); o.noKey = await ensurePushSubscription(); Store.vapidPublicKey = "AQID";
    const rg = await navigator.serviceWorker.ready; rg.__subs.current = { expirationTime: Date.now() + 1000, unsubscribe: async () => { window.__unsub = 1; }, toJSON() { return { endpoint: "https://fcm.googleapis.com/y" }; } };
    const sent = []; const sg = signaling; signaling = { connected: true, sendPushSubscription: (s) => sent.push(s) };
    const sub = await ensurePushSubscription(); o.renewed = !!sub && window.__unsub === 1; o.sent = sent.length;
    rg.pushManager.subscribe = async () => { throw new Error("denied"); }; rg.__subs.current = null; o.fail = await ensurePushSubscription(); signaling = sg; return o; })()`));
  assert.equal(e.off, null); assert.equal(e.noKey, null); assert.equal(e.renewed, true); assert.equal(e.fail, null);
  a.close();
});

test("уведомления: разрешение в настройках, баннер, showNotification через SW, бейдж приложения", async () => {
  const a = await boot(); const t = fakeTimers(a); fakeSW(a);
  a.window.Notification = class { static get permission() { return a.window.__perm || "default"; } static async requestPermission() { return a.window.__perm = a.window.__req || "granted"; } constructor(t, o) { (a.window.__notes = a.window.__notes || []).push([t, o]); } };
  a.window.PushManager = function () {};
  a.run(`wireNotificationPermission(); wireNotifBanner(); Store.vapidPublicKey = "AQID";`);
  const cb = a.document.querySelector("#settings-notifications");
  const change = async (v) => { cb.checked = v; cb.dispatchEvent(new a.window.Event("change")); await sleep(60); };
  a.window.__req = "denied"; await change(true); assert.equal(cb.checked, false); assert.equal(a.run(`Store.notificationsEnabled`), false);
  a.window.__req = "granted"; await change(true); assert.equal(a.run(`Store.notificationsEnabled`), true);
  await change(false); assert.equal(a.run(`Store.notificationsEnabled`), false); assert.equal(a.run(`Store.notifBannerDismissed`), true);
  // баннер
  a.run(`Store.notifBannerDismissed = false; Store.notificationsEnabled = false; document.getElementById("lang-offer").classList.remove("hidden"); updateNotifBanner();`);
  assert.ok(!a.document.querySelector("#notif-banner").classList.contains("hidden")); assert.equal(a.document.querySelector("#notif-banner").style.marginTop, "96px");
  a.window.__perm = "default"; a.window.__req = "denied"; a.document.querySelector("#notif-enable-btn").click(); await sleep(40);
  a.window.__req = "granted"; a.document.querySelector("#notif-enable-btn").click(); await sleep(60); assert.equal(a.run(`Store.notificationsEnabled`), true);
  assert.ok(a.document.querySelector("#notif-banner").classList.contains("hidden"));
  a.run(`Store.notificationsEnabled = false; Store.notifBannerDismissed = false; updateNotifBanner();`); a.document.querySelector("#notif-dismiss-btn").click(); assert.equal(a.run(`Store.notifBannerDismissed`), true);
  // showNotification: через controller → active → new Notification
  a.run(`Store.notificationsEnabled = true;`);
  a.window.__perm = "granted";
  a.run(`showNotification("Title", "Body", { tag: "t1", contactId: "alice", kind: "message", forceSilent: true, force: true }); showNotification("Call", "x", { tag: "c", contactId: "alice", kind: "call", force: true }); showNotification("NoForce", "x", {}); Store.hideNotifContent = true; showNotification("Hidden", "secret", { force: true, contactId: "alice" }); Store.hideNotifContent = false;`);
  assert.ok((a.window.__ctrlMsgs || []).length >= 3); assert.ok(a.window.__ctrlMsgs.every((m) => m.title !== "NoForce")); assert.ok(!JSON.stringify(a.window.__ctrlMsgs).includes("secret"));
  a.run(`Object.defineProperty(navigator.serviceWorker, "controller", { value: null, configurable: true }); swRegistration = { active: { postMessage: (m) => { window.__act = m; } } }; showNotification("T2", "B2", { tag: "t2", force: true });`);
  assert.ok(a.window.__act);
  a.run(`swRegistration = null; showNotification("T3", "B3", { tag: "t3", force: true });`);
  // бейдж
  a.window.navigator.setAppBadge = (n) => { a.window.__badge = n; }; a.window.navigator.clearAppBadge = () => { a.window.__badge = 0; };
  a.run(`ensureContactEntry("zed", "Zed").messages.push({ id: "u1", from: "them", text: "hi", ts: Date.now(), readAckSent: false }); updateAppBadge();`); assert.ok(a.window.__badge >= 1);
  a.run(`state.contacts.get("zed").messages.length = 0; updateAppBadge();`); assert.equal(a.window.__badge, 0);
  a.close();
});

test("запуск по уведомлению и ссылке: ?call=, ?chat=, share-target, openFromNotification, dead-man switch", async () => {
  const a = await boot(); const t = fakeTimers(a);
  a.run(`ensureContactEntry("alice", "Alice"); window.openCallScreen = (id, ph, o) => { (window.__calls = window.__calls || []).push([id, ph, o]); }; window.playRingtone = () => { window.__ring = (window.__ring || 0) + 1; };`);
  const r = J(a.run(`(() => { const o = {};
    history.replaceState(null, "", "/?chat=alice"); handleNotificationNavigateParams(); o.chat = [state.chatId, location.search];
    history.replaceState(null, "", "/?call=alice&ts=" + Date.now()); state.callId = null; handleNotificationNavigateParams(); o.call = [window.__calls && window.__calls.length, window.__ring];
    history.replaceState(null, "", "/?call=alice&ts=1"); handleNotificationNavigateParams(); o.stale = window.__calls.length;
    state.callId = "alice"; state.callPhase = "ringing"; openFromNotification("alice", "call", false, {}); o.ringing = window.__calls.length; state.callId = null; state.callPhase = null;
    openFromNotification("", "message"); openFromNotification("alice", "message", true); o.fresh = [isCallPushFresh(undefined), isCallPushFresh(Date.now()), isCallPushFresh(Date.now() - 120000), isCallPushFresh(Date.now() + 100000)];
    history.replaceState(null, "", "/?share_title=T&share_text=hello&share_url=https://a.example"); let opened = 0; window.openForwardSheet = (cb, key) => { opened++; cb("alice"); }; handleShareTargetParams(); o.share = [opened, location.search];
    handleShareTargetParams();
    return o; })()`));
  assert.deepEqual(r.chat, ["alice", ""]); assert.equal(r.call[0], 1); assert.equal(r.stale, 1); assert.equal(r.ringing, 2); assert.deepEqual(r.fresh, [true, true, false, false]); assert.equal(r.share[0], 1);
  t.tick(200);
  assert.ok(a.run(`document.getElementById("chat-input") ? document.getElementById("chat-input").value : ""`).includes("hello"));
  // dead-man switch
  const d = J(a.run(`(() => { const o = {}; const sent = []; window.trySendOrQueue = async (c, id, p) => { sent.push(p); };
    Store.deadManEnabled = true; Store.deadManContactId = "alice"; Store.deadManLastSentAt = 0; checkDeadManSwitch(); checkDeadManSwitch(); o.sent = sent.length; o.kind = sent[0] && sent[0].kind;
    const al = state.contacts.get("alice"); al.lastHeartbeatAt = Date.now() - 20 * 86400000; al.heartbeatThresholdDays = 3; checkDeadManSwitch(); o.alerted = !!al.heartbeatAlertedAt; const at = al.heartbeatAlertedAt; checkDeadManSwitch(); o.once = at === al.heartbeatAlertedAt;
    al.lastHeartbeatAt = Date.now(); al.heartbeatAlertedAt = 0; checkDeadManSwitch(); o.fresh = !al.heartbeatAlertedAt;
    const c = ensureContactEntry("bob", "Bob"); c.messages.push({ id: "m", from: "me", ack: "delivered", ts: 1 }, { id: "m2", from: "me", ack: "read", serverAcked: true, ts: 2 }, { id: "m3", from: "them", ts: 3 }); migrateServerAckedFlags(); o.mig = c.messages[0].serverAcked === true;
    localStorage.removeItem(ONBOARDING_HINT_SHOWN); maybeShowOnboardingHint(); maybeShowOnboardingHint(); o.hint = localStorage.getItem(ONBOARDING_HINT_SHOWN);
    return o; })()`));
  assert.equal(d.sent, 1); assert.equal(d.kind, "heartbeat"); assert.equal(d.alerted, true); assert.equal(d.once, true); assert.equal(d.fresh, true); assert.equal(d.mig, true); assert.equal(d.hint, "1");
  t.tick(2000);
  a.close();
});

test("вкладки: свайп между вкладками, клик по вкладке, жёсткие границы", async () => {
  const a = await boot(); fakeTimers(a); installTouch(a);
  const r = J(a.run(`(() => { const o = {}; const c = document.getElementById("content");
    state.tab = "chats"; state.chatId = null; state.contactCardId = null; state.callId = null;
    const swipe = (dx, tgt) => { __touch(tgt || c, "touchstart", 200, 100); __touch(tgt || c, "touchmove", 200 + dx, 102); __touch(tgt || c, "touchend", 200 + dx, 102); return state.tab; };
    o.left = swipe(-120); o.left2 = swipe(-120); o.left3 = swipe(-120); o.right = swipe(120); o.small = swipe(-30);
    state.chatId = "x"; o.blockedChat = swipe(-120); state.chatId = null;
    document.documentElement.dir = "rtl"; state.tab = "chats"; o.rtl = swipe(120); document.documentElement.dir = "ltr";
    state.tab = "chats"; const row = document.createElement("div"); row.className = "chat-row"; c.appendChild(row); o.row = swipe(-120, row); row.remove();
    const btn = document.querySelector('.tab-btn[data-tab="settings"]'); state.callId = "z"; window.minimizeCallScreen = () => { window.__min = 1; }; btn.click(); o.minimized = window.__min; state.callId = null; o.tabAfter = state.tab;
    return o; })()`));
  assert.equal(r.left, "connect"); assert.equal(r.left2, "settings"); assert.equal(r.left3, "settings"); assert.equal(r.right, "connect"); assert.equal(r.small, "connect"); assert.equal(r.blockedChat, "connect"); assert.equal(r.rtl, "connect"); assert.equal(r.row, "chats"); assert.equal(r.minimized, 1); assert.equal(r.tabAfter, "settings");
  a.close();
});
