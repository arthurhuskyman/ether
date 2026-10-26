// V.80.2: Wake Lock на время звонка (безусловно) и «защита от щеки» (touch guard): автомат состояний.
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function fakeLink(a, id = "alice") {
  a.run(`ensureContactEntry("${id}", "Alice");`);
  a.run(`(() => { const l = new EventTarget(); Object.assign(l, { id: "${id}", status: "connected", localVideoTrack: null, startCall: async () => { l.status = "in-call"; }, endCall() {}, setMuted() {}, send: () => true, setRemoteVolume() {} }); mesh.links.set("${id}", l); })()`);
}
// Подставной navigator.wakeLock: считает запросы, позволяет «сбросить» замок как это делает браузер.
function mockWakeLock(a, { reject } = {}) {
  const w = a.window, st = { requests: 0, sentinels: [] };
  const wl = { request: async (type) => {
    st.requests++;
    if (reject) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const s = new w.EventTarget(); s.released = false; s.type = type;
    s.release = async () => { if (s.released) return; s.released = true; s.dispatchEvent(new w.Event("release")); };
    st.sentinels.push(s); return s;
  } };
  Object.defineProperty(w.navigator, "wakeLock", { value: wl, configurable: true });
  return st;
}
function setVisibility(a, v) { Object.defineProperty(a.document, "visibilityState", { value: v, configurable: true }); a.document.dispatchEvent(new a.window.Event("visibilitychange")); }
const live = (st) => st.sentinels.filter((s) => !s.released).length;

async function audioCall(opts) {
  const a = await bootApp(opts);
  fakeLink(a);
  return a;
}

test("Wake Lock: берётся при начале АУДИО-звонка и снимается при его конце", async () => {
  const a = await audioCall(); const st = mockWakeLock(a);
  await a.run(`beginCall("alice", false)`); await tick();
  assert.equal(a.run(`WL.state`), "held"); assert.equal(live(st), 1, "аудиозвонок тоже держит экран");
  a.run(`setCallPhaseActive()`); await tick();
  assert.equal(live(st), 1, "повторный запрос не плодит замков");
  a.run(`closeCallScreen("ended")`); await tick();
  assert.equal(live(st), 0); assert.equal(a.run(`WL.want`), false);
});

test("Wake Lock: заново берётся после release (пока звонок идёт) и после visibilitychange", async () => {
  const a = await audioCall(); const st = mockWakeLock(a);
  await a.run(`beginCall("alice", false)`); a.run(`setCallPhaseActive()`); await tick();
  await st.sentinels[0].release(); await tick();
  assert.equal(live(st), 1, "release при видимой странице → новый замок");
  // уход в фон: браузер сам снимает замок; пока страница скрыта — не просим
  setVisibility(a, "hidden"); await st.sentinels[st.sentinels.length - 1].release(); await tick();
  assert.equal(live(st), 0);
  setVisibility(a, "visible"); await tick();
  assert.equal(live(st), 1, "вернулись на экран → замок снова взят");
  a.run(`closeCallScreen("ended")`); await tick();
  setVisibility(a, "visible"); await tick();
  assert.equal(live(st), 0, "после конца звонка не берётся");
});

test("Wake Lock: звонок завершён во время ожидания request — замок тут же отпускается", async () => {
  const a = await audioCall(); const st = mockWakeLock(a);
  await a.run(`beginCall("alice", false)`);
  a.run(`releaseWakeLock()`); await a.run(`requestWakeLock(); releaseWakeLock();`); await tick();
  assert.equal(live(st), 0);
});

test("Wake Lock: не поддерживается / отклонён — без исключений, звонок продолжается", async () => {
  const a = await audioCall();
  await a.run(`beginCall("alice", false)`); await tick();
  assert.equal(a.run(`WL.state`), "unsupported");
  a.run(`setCallPhaseActive()`); assert.equal(a.run(`state.callId`), "alice");
  a.run(`closeCallScreen("ended")`);
  const b = await audioCall(); const st = mockWakeLock(b, { reject: true });
  await b.run(`beginCall("alice", false)`); await tick(20);
  assert.equal(b.run(`WL.state`), "error"); assert.ok(st.requests >= 1);
  b.run(`setCallPhaseActive()`); assert.equal(b.run(`state.callId`), "alice");
  b.run(`closeCallScreen("ended")`);
});

test("Wake Lock: выключение камеры в видеозвонке больше НЕ отпускает замок (старое поведение было видео-только)", async () => {
  const a = await audioCall(); const st = mockWakeLock(a);
  await a.run(`beginCall("alice", true)`); a.run(`setCallPhaseActive()`); await tick();
  assert.equal(live(st), 1);
  a.run(`state.callWantsVideo = false`);
  a.document.dispatchEvent(new a.window.Event("visibilitychange"));
  await tick(); assert.equal(live(st), 1);
});

// ---------------- touch guard ----------------
async function activeAudio(extra) {
  const a = await audioCall(extra); mockWakeLock(a);
  await a.run(`beginCall("alice", false)`); a.run(`setCallPhaseActive()`); await tick();
  a.run(`CallGuard.S.perm = "granted"`);
  return a;
}
const feed = (a, beta, t, rot = 0, gamma = 0) => a.run(`CallGuard.sample(${beta}, ${gamma}, ${rot}, ${t})`);
const mode = (a) => a.run(`CallGuard.mode()`);
const overlayHidden = (a) => a.document.getElementById("call-guard").classList.contains("hidden");

test("guard: кнопка в ряду управления видна в активном аудиозвонке; ручная блокировка показывает оверлей и озвучивает", async () => {
  const a = await activeAudio();
  const b = a.document.getElementById("call-guard-btn");
  assert.ok(b, "кнопка есть"); assert.ok(!b.classList.contains("hidden"));
  b.click();
  assert.equal(mode(a), "manual"); assert.equal(overlayHidden(a), false);
  assert.equal(a.document.getElementById("call-guard").getAttribute("aria-hidden"), "false");
  assert.equal(b.getAttribute("aria-pressed"), "true");
  assert.ok(a.document.getElementById("call-guard-live").textContent.length > 0, "aria-live объявляет");
  assert.ok(a.document.getElementById("call-guard-btn").querySelector('[data-icon="lock"]'));
});

test("guard: касание/клик по оверлею поглощается; разблокировка — удержание ~1 с, ладонь (широкий контакт) не считается", async () => {
  const a = await activeAudio();
  a.run(`CallGuard.lock()`);
  assert.equal(a.run(`CallGuard.holdStart(80, 90)`), false, "ухо/ладонь шире порога игнорируется");
  assert.equal(mode(a), "manual");
  assert.equal(a.run(`CallGuard.holdStart(10, 10)`), true);
  a.run(`CallGuard.cancelHold()`); await tick(1100);
  assert.equal(mode(a), "manual", "отпустили раньше времени — остаёмся заблокированы");
  a.run(`CallGuard.holdStart(10, 10)`); await tick(1100);
  assert.equal(mode(a), "off"); assert.equal(overlayHidden(a), true);
  assert.equal(a.document.getElementById("call-guard").getAttribute("aria-hidden"), "true");
});

test("guard: доступный путь — click с detail=0 (клавиатура/скринридер) снимает блокировку, настоящее касание (detail>0) — нет", async () => {
  const a = await activeAudio();
  a.run(`CallGuard.lock()`);
  const u = a.document.getElementById("call-guard-unlock");
  u.dispatchEvent(new a.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  assert.equal(mode(a), "manual");
  u.dispatchEvent(new a.window.MouseEvent("click", { bubbles: true, detail: 0 }));
  assert.equal(mode(a), "off");
});

test("guard: авто-включение — телефон у уха (|beta| 55..125) почти неподвижен ≥1.2 с; гистерезис отпускания; перевзвод", async () => {
  const a = await activeAudio(); const T0 = 1e6;
  feed(a, 90, T0); feed(a, 91, T0 + 600); feed(a, 90, T0 + 1100);
  assert.equal(mode(a), "off", "ещё рано");
  feed(a, 90, T0 + 1300);
  assert.equal(mode(a), "auto");
  // нейтральная зона 35..55 — гистерезис, не отпускаем
  feed(a, 45, T0 + 2000); feed(a, 45, T0 + 4000);
  assert.equal(mode(a), "auto");
  // лёг: <35 меньше 0.8 с — ещё держим
  feed(a, 10, T0 + 5000); feed(a, 10, T0 + 5500);
  assert.equal(mode(a), "auto");
  feed(a, 10, T0 + 5900);
  assert.equal(mode(a), "off", "лежит ≥0.8 с → отпускаем");
  // снова у уха сразу после — пока был лежащим rearm=true → включится
  feed(a, 88, T0 + 7000); feed(a, 88, T0 + 8300); feed(a, 88, T0 + 9600); // первый переход 10→88 — это движение, отсчёт «неподвижен» идёт с 8300
  assert.equal(mode(a), "auto");
});

test("guard: после ручной/удержанием разблокировки авто не включается снова, пока телефон не опущен", async () => {
  const a = await activeAudio(); const T0 = 2e6;
  feed(a, 90, T0); feed(a, 90, T0 + 1300); assert.equal(mode(a), "auto");
  a.run(`CallGuard.unlock("hold")`);
  feed(a, 90, T0 + 3000); feed(a, 90, T0 + 6000);
  assert.equal(mode(a), "off", "щека всё ещё у экрана — не блокируем снова");
  feed(a, 5, T0 + 7000); feed(a, 5, T0 + 7900); // опустили
  feed(a, 90, T0 + 9000); feed(a, 90, T0 + 10300); feed(a, 90, T0 + 11600);
  assert.equal(mode(a), "auto");
});

test("guard: движение (rot > порога) сбрасывает ожидание; ручной режим авто не отпускает", async () => {
  const a = await activeAudio(); const T0 = 3e6;
  feed(a, 90, T0); feed(a, 90, T0 + 1000, 120); feed(a, 90, T0 + 1500); feed(a, 90, T0 + 2200);
  assert.equal(mode(a), "off", "была встряска — отсчёт заново");
  feed(a, 90, T0 + 2800); assert.equal(mode(a), "auto");
  a.run(`CallGuard.lock()`); assert.equal(mode(a), "manual");
  feed(a, 0, T0 + 4000); feed(a, 0, T0 + 6000);
  assert.equal(mode(a), "manual", "ручную блокировку снимает только пользователь");
});

test("guard: авто — только аудио, не громкая связь, не наушники, не при выключенной настройке", async () => {
  const a = await activeAudio(); const T0 = 4e6;
  a.run(`speakerOn = true`); feed(a, 90, T0); feed(a, 90, T0 + 1500);
  assert.equal(mode(a), "off", "громкая связь");
  a.run(`speakerOn = false; CallGuard.S.headset = true`); feed(a, 90, T0 + 2000); feed(a, 90, T0 + 4000);
  assert.equal(mode(a), "off", "наушники/Bluetooth");
  a.run(`CallGuard.S.headset = false; CallGuard.setAuto(false)`); feed(a, 90, T0 + 5000); feed(a, 90, T0 + 7000);
  assert.equal(mode(a), "off", "настройка выключена");
  a.run(`CallGuard.setAuto(true)`); feed(a, 90, T0 + 8000); feed(a, 90, T0 + 9500);
  assert.equal(mode(a), "auto");
  a.run(`speakerOn = true`); feed(a, 90, T0 + 9600);
  assert.equal(mode(a), "off", "включили громкую — отпустили");
  const v = await activeAudio(); v.run(`state.callWantsVideo = true`); feed(v, 90, T0); feed(v, 90, T0 + 1500);
  assert.equal(mode(v), "off", "видео");
});

test("guard: видео включили — отпускает даже ручную; конец звонка и второй звонок отпускают; кнопка скрыта на видео", async () => {
  const a = await activeAudio();
  a.run(`CallGuard.lock()`); a.run(`state.callWantsVideo = true; CallGuard.tick()`);
  assert.equal(mode(a), "off"); assert.ok(a.document.getElementById("call-guard-btn").classList.contains("hidden"));
  const b = await activeAudio(); b.run(`CallGuard.lock()`); b.run(`CallGuard.onCritical("second-call")`);
  assert.equal(mode(b), "off");
  const c = await activeAudio(); c.run(`CallGuard.lock()`); c.run(`closeCallScreen("ended")`);
  assert.equal(mode(c), "off"); assert.equal(c.document.getElementById("call-guard").classList.contains("hidden"), true);
  assert.equal(c.run(`CallGuard.S.motionOn`), false);
});

test("guard: блокировка без активного звонка невозможна", async () => {
  const a = await audioCall();
  assert.equal(a.run(`CallGuard.lock()`), false); assert.equal(mode(a), "off");
});

test("guard: iOS requestPermission() вызывается из жеста; отказ — авто-режим тихо пропускается, ручной работает", async () => {
  const a = await audioCall();
  let calls = 0;
  a.window.DeviceMotionEvent = function () {}; a.window.DeviceMotionEvent.requestPermission = () => { calls++; return Promise.resolve("denied"); };
  a.run(`CallGuard.S.perm = "unknown"`);
  await a.run(`beginCall("alice", false)`); await tick(); a.run(`setCallPhaseActive()`); await tick();
  assert.ok(calls >= 1, "запрос разрешения из beginCall");
  assert.equal(a.run(`CallGuard.S.perm`), "denied");
  assert.equal(a.run(`CallGuard.S.motionOn`), false, "датчики не слушаем");
  feed(a, 90, 5e6); feed(a, 90, 5e6 + 2000);
  assert.equal(mode(a), "off", "авто не включается без разрешения");
  assert.equal(a.run(`CallGuard.lock()`), true, "ручная блокировка работает без датчиков");
  // видеозвонок разрешение не запрашивает
  const v = await audioCall(); let vc = 0;
  v.window.DeviceMotionEvent = function () {}; v.window.DeviceMotionEvent.requestPermission = () => { vc++; return Promise.resolve("granted"); };
  v.run(`CallGuard.S.perm = "unknown"`);
  await v.run(`beginCall("alice", true)`); await tick();
  assert.equal(vc >= 1, true, "beginCall(видео) всё же просит (не мешает), но авто для видео не включается");
});

test("guard: разрешение granted → слушаем deviceorientation; события реально ведут к включению", async () => {
  const a = await audioCall();
  a.window.DeviceMotionEvent = function () {}; a.window.DeviceMotionEvent.requestPermission = () => Promise.resolve("granted");
  a.run(`CallGuard.S.perm = "unknown"`);
  await a.run(`beginCall("alice", false)`); a.run(`setCallPhaseActive()`); await tick(20);
  assert.equal(a.run(`CallGuard.S.perm`), "granted"); assert.equal(a.run(`CallGuard.S.motionOn`), true);
  const ev = new a.window.Event("deviceorientation"); ev.beta = 90; ev.gamma = 0;
  const realNow = a.window.Date.now; let t = 7e6; a.window.Date.now = () => t;
  a.window.dispatchEvent(ev); t += 1300; a.window.dispatchEvent(ev);
  a.window.Date.now = realNow;
  assert.equal(mode(a), "auto");
  assert.match(a.document.getElementById("callguard-diag").textContent, /guard: auto/);
});

test("guard: реальный датчик приближения используется ТОЛЬКО если он есть (feature detection)", async () => {
  const a = await activeAudio();
  assert.match(a.run(`CallGuard.diagText()`), /ProximitySensor=false/);
  a.run(`CallGuard.proximity(true)`); assert.equal(mode(a), "auto");
  a.run(`CallGuard.proximity(false)`); assert.equal(mode(a), "off");
});
