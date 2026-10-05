// Поведение клиента на разных платформах: iOS Safari (вкладка и установленный PWA),
// Android Chrome и десктоп. Отличия эмулируются профилем в harness.js (UA и набор
// доступных API), сам код приложения не подменяется.
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const click = (a, sel) => a.document.querySelector(sel).click();

for (const platform of ["ios", "android"]) {
  const label = platform === "ios" ? "iOS" : "Android";

  test(`[${label}] определение платформы и режима установки`, async () => {
    const a = await bootApp({ platform });
    assert.equal(a.run(`isIOS()`), platform === "ios");
    assert.equal(a.run(`isStandalone()`), false);
    a.close();
    if (platform === "ios") {
      const b = await bootApp({ platform, standalone: true });
      assert.equal(b.run(`isStandalone()`), true);
      b.close();
    }
  });

  test(`[${label}] вибрация и haptic: не падают, и вызывают API только там, где оно есть`, async () => {
    const a = await bootApp({ platform });
    a.run(`vibrate([80, 40, 80]); haptic("light"); haptic("medium"); haptic("heavy");`);
    if (platform === "android") assert.ok(a.window.__vibrations.length >= 3, "Android должен вибрировать");
    else assert.equal(a.window.__vibrations.length, 0, "iOS Safari не имеет navigator.vibrate");
    a.close();
  });

  test(`[${label}] формат голосовых сообщений выбирается по поддержке MediaRecorder`, async () => {
    const a = await bootApp({ platform });
    const mime = a.run(`pickVoiceMimeType()`);
    assert.equal(mime, platform === "ios" ? "audio/mp4" : "audio/webm;codecs=opus");
    a.close();
  });

  test(`[${label}] Picture-in-Picture: правильный API платформы`, async () => {
    const a = await bootApp({ platform });
    assert.equal(a.run(`pipSupported()`), true);
    a.run(`beginCall; state.callId = "alice"; state.callPhase = "active";`);
    const rv = a.document.querySelector("#call-remote-video");
    rv.srcObject = { getVideoTracks: () => [{ kind: "video" }] }; rv.classList.remove("hidden");
    // jsdom не принимает чужой srcObject — подменяем свойство
    Object.defineProperty(rv, "srcObject", { value: { id: "s" }, configurable: true, writable: true });
    click(a, "#call-pip-overlay-btn"); await tick(20);
    if (platform === "ios") {
      assert.deepEqual(a.window.__pipModes, ["picture-in-picture"]);
      click(a, "#call-pip-overlay-btn"); await tick(20);
      assert.deepEqual(a.window.__pipModes, ["picture-in-picture", "inline"], "второй тап возвращает inline");
    } else {
      assert.equal(a.document.pictureInPictureElement, rv);
      click(a, "#call-pip-overlay-btn"); await tick(20);
      assert.equal(a.document.pictureInPictureElement, null, "второй тап выходит из PiP");
    }
    a.close();
  });

  test(`[${label}] демонстрация экрана недоступна на мобильном браузере`, async () => {
    const a = await bootApp({ platform });
    const btn = a.document.querySelector("#call-screenshare-btn");
    assert.ok(btn.classList.contains("hidden"), "кнопка показа экрана должна быть скрыта без getDisplayMedia");
    a.close();
  });

  test(`[${label}] бейдж приложения (App Badging)`, async () => {
    const standalone = platform === "ios";
    const a = await bootApp({ platform, standalone });
    a.window.__badges.length = 0;
    a.run(`ensureContactEntry("alice","Alice").messages.push({id:"1", from:"them", text:"x"}, {id:"2", from:"them", text:"y"}); updateAppBadge();`);
    assert.deepEqual(a.window.__badges, [2]);
    a.run(`state.contacts.get("alice").messages.forEach((m) => m.readAckSent = true); updateAppBadge();`);
    assert.deepEqual(a.window.__badges, [2, 0]);
    a.close();
  });

  test(`[${label}] Panic Shake: разрешение на датчики и срабатывание`, async () => {
    const a = await bootApp({ platform });
    assert.equal(await a.run(`requestMotionPermissionIfNeeded()`), true);
    if (platform === "ios") {
      a.window.__motionPermission = "denied";
      assert.equal(await a.run(`requestMotionPermissionIfNeeded()`), false, "iOS: отказ в разрешении");
    }
    a.run(`wirePanicShake(); wirePanicShakeBanner();`);
    const shake = (x) => { const ev = new a.window.Event("devicemotion"); ev.accelerationIncludingGravity = { x, y: 0, z: 0 }; a.window.dispatchEvent(ev); };
    shake(5);
    assert.ok(a.document.querySelector("#panic-shake-banner").classList.contains("hidden"), "слабое движение игнорируется");
    shake(60);
    assert.ok(!a.document.querySelector("#panic-shake-banner").classList.contains("hidden"), "сильный рывок показывает баннер отмены");
    click(a, "#panic-shake-cancel-btn");
    assert.ok(a.document.querySelector("#panic-shake-banner").classList.contains("hidden"));
    a.run(`unwirePanicShake();`);
    a.close();
  });

  test(`[${label}] Share Target: общий текст открывает выбор чата и подставляется в поле ввода`, async () => {
    const url = "http://localhost/?share_title=T&share_text=hello&share_url=https%3A%2F%2Fe.com";
    const a = await bootApp({ platform, url });
    a.run(`ensureContactEntry("alice", "Alice");`);
    a.run(`handleShareTargetParams();`);
    assert.ok(!a.document.querySelector("#forward-sheet").classList.contains("hidden"));
    assert.equal(a.window.location.search, "", "параметры очищаются из адресной строки");
    a.document.querySelector("#forward-list .forward-row").click();
    await tick(80);
    assert.match(a.document.querySelector("#chat-input").value, /hello/);
    a.close();
  });

  test(`[${label}] уведомление: без Notification/разрешения тихо ничего не делает, с разрешением идёт в Service Worker`, async () => {
    const a = await bootApp({ platform, standalone: platform === "ios" });
    a.run(`Store.notificationsEnabled = true;`);
    a.run(`showNotification("A", "b", { force: true })`); // не должно падать ни на iOS-вкладке, ни при denied
    const posted = [];
    if (a.window.Notification) {
      Object.defineProperty(a.window.Notification, "permission", { get: () => "granted", configurable: true });
      Object.defineProperty(a.window.navigator, "serviceWorker", { value: { controller: { postMessage: (m) => posted.push(m) } }, configurable: true });
      a.run(`showNotification("Alice", "secret text", { force: true, contactId: "alice", kind: "message", tag: "t1" })`);
      assert.equal(posted.length, 1);
      assert.equal(posted[0].type, "show-notification");
      assert.equal(posted[0].actions.length, 2);
      a.run(`Store.hideNotifContent = true; showNotification("Alice", "secret text", { force: true, contactId: "alice", kind: "message" })`);
      assert.notEqual(posted[1].body, "secret text", "текст скрывается, если включено hideNotifContent");
    }
    a.close();
  });
}

test("[Android] импорт имени из адресной книги (Contact Picker)", async () => {
  const a = await bootApp({ platform: "android" });
  a.run(`wireConnectScreen && wireConnectScreen();`);
  const btn = a.document.querySelector("#import-contact-btn");
  assert.ok(!btn.classList.contains("hidden"));
  btn.click(); await tick(30);
  assert.equal(a.document.querySelector("#add-contact-name").value, "Zoe");
  a.close();
});

test("[iOS] Contact Picker недоступен — кнопка импорта скрыта", async () => {
  const a = await bootApp({ platform: "ios" });
  assert.ok(a.document.querySelector("#import-contact-btn").classList.contains("hidden"));
  a.close();
});

test("[Android] навигатор.share для приглашения; [iOS] без share — копирование", async () => {
  const android = await bootApp({ platform: "android" });
  let shared = null;
  android.window.navigator.share = async (d) => { shared = d; };
  android.document.querySelector("#invite-link-out").textContent = "https://x/#abc";
  android.document.querySelector("#share-link-btn").click(); await tick(20);
  assert.equal(shared && shared.url, "https://x/#abc");
  android.close();

  const ios = await bootApp({ platform: "ios" });
  ios.document.querySelector("#invite-link-out").textContent = "https://x/#abc";
  ios.document.querySelector("#share-link-btn").click(); await tick(20);
  assert.ok(ios.document.querySelector("#toast").textContent.length > 0);
  ios.close();
});

test("[iOS] вкладка Safari без PWA: баннер уведомлений скрыт, включение тумблера откатывается", async () => {
  const a = await bootApp({ platform: "ios" });
  a.run(`updateNotifBanner()`);
  assert.ok(a.document.querySelector("#notif-banner").classList.contains("hidden"));
  const cb = a.document.querySelector("#settings-notifications");
  cb.checked = true; cb.dispatchEvent(new a.window.Event("change", { bubbles: true })); await tick(20);
  assert.equal(cb.checked, false);
  a.close();
});

test("[Android] включение уведомлений запрашивает разрешение", async () => {
  const a = await bootApp({ platform: "android" });
  let asked = 0;
  a.window.Notification.requestPermission = async () => { asked++; return "granted"; };
  const cb = a.document.querySelector("#settings-notifications");
  cb.checked = true; cb.dispatchEvent(new a.window.Event("change", { bubbles: true })); await tick(30);
  assert.equal(asked, 1);
  assert.equal(a.run(`Store.notificationsEnabled`), true);
  a.close();
});
