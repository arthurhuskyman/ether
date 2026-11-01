"use strict";
// V.80.2: Screen Wake Lock на ВРЕМЯ ЗВОНКА (безусловно) + «защита от щеки» (touch guard) на экране звонка.
// ЧЕСТНО: у веб-платформы на iOS Safari нет датчика приближения (а на Android Chrome он недоступен страницам), экран
// физически выключить нельзя, а блокировка телефона/смена приложения всё равно приостанавливает захват. Поэтому:
// (1) Wake Lock держим сами; (2) датчик приближения используем ТОЛЬКО если он реально есть (ProximitySensor /
// deviceproximity); иначе — ручная кнопка «Блокировка экрана» + авто-эвристика по наклону телефона (devicemotion/orientation).
// Разблокировка — осознанным удержанием кнопки ~1 с (щекой не получится) либо с клавиатуры / скринридера.

// ---------- Wake Lock ----------
const WL = { want: false, sentinel: null, state: "idle", err: "", acquires: 0, retries: 0, busy: false };
function wlLog(level, msg) { try { etherLog(level, msg); } catch (e) {} }
async function wlAcquire() {
  if (!WL.want) return;
  if (!(typeof navigator !== "undefined" && navigator.wakeLock && typeof navigator.wakeLock.request === "function")) {
    // Запасной «NoSleep» (крошечное зацикленное видео) на iOS<16.4 не делаем: оно запускает <video> и может перехватить
    // аудиосессию звонка — риск для звука важнее. Просто пропускаем.
    if (WL.state !== "unsupported") { WL.state = "unsupported"; wlLog("info", "[wakelock] не поддерживается этим браузером — пропускаю (без запасного видео-трюка, чтобы не трогать звук)"); }
    return;
  }
  if (WL.sentinel || WL.busy) return;
  if (document.visibilityState === "hidden") { WL.state = "waiting-visible"; return; }
  WL.busy = true;
  try {
    const s = await navigator.wakeLock.request("screen");
    if (!WL.want) { try { const p = s.release(); if (p && p.catch) p.catch(() => {}); } catch (e) {} WL.state = "idle"; return; } // звонок кончился, пока ждали
    WL.sentinel = s; WL.state = "held"; WL.acquires++; WL.err = "";
    try {
      s.addEventListener("release", () => {
        if (WL.sentinel === s) WL.sentinel = null;
        if (!WL.want) return;
        WL.state = "released";
        if (document.visibilityState === "visible" && WL.retries < 5) { WL.retries++; wlAcquire(); }
      });
    } catch (e) {}
  } catch (e) {
    WL.state = "error"; WL.err = String((e && e.name) || e);
    wlLog("warn", "[wakelock] failed: " + WL.err);
    if (WL.want && WL.retries < 3 && document.visibilityState === "visible") { WL.retries++; setTimeout(wlAcquire, 800); }
  } finally { WL.busy = false; }
}
function requestWakeLock() { WL.want = true; return wlAcquire(); }
function releaseWakeLock() {
  WL.want = false; WL.retries = 0;
  const s = WL.sentinel; WL.sentinel = null;
  if (s) { try { const p = s.release(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  WL.state = WL.state === "unsupported" ? "unsupported" : "idle";
}
// Браузер сам снимает Wake Lock при уходе вкладки в фон — по возвращении берём заново, если звонок ещё идёт.
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && WL.want) { WL.retries = 0; wlAcquire(); }
});

// ---------- Touch guard ----------
const CG_CFG = Object.freeze({
  HOLD_MS: 1000,            // удержание для разблокировки
  MAX_CONTACT_PX: 40,       // касание шире — это ладонь/ухо, игнорируем
  ENGAGE_BETA_MIN: 55,      // |beta|: телефон вертикально у головы
  ENGAGE_BETA_MAX: 125,
  ENGAGE_STILL_MS: 1200,    // столько телефон должен быть почти неподвижен в этом диапазоне
  STILL_ROT_MAX: 30,        // °/с — «почти неподвижен»
  RELEASE_BETA: 35,         // |beta| ниже — телефон лёг/опущен
  RELEASE_MS: 800,
  SAMPLE_MIN_DT: 20,
});
const CallGuard = (() => {
  const KEY = "ether.callguard.auto";
  const S = { mode: "off", why: "", beta: null, gamma: null, rot: 0, stillSince: 0, flatSince: 0, rearm: true, perm: "unknown", headset: false, lastT: 0, lastBeta: null, lastGamma: null, motionOn: false, sensor: null, near: null, tickTimer: null, diagAt: 0, holdTimer: null };
  const sup = {
    proximity: () => typeof window !== "undefined" && ("ProximitySensor" in window),
    devprox: () => typeof window !== "undefined" && ("DeviceProximityEvent" in window || "ondeviceproximity" in window),
    light: () => typeof window !== "undefined" && ("AmbientLightSensor" in window),
  };
  function autoEnabled() { try { return localStorage.getItem(KEY) !== "0"; } catch (e) { return true; } }
  function setAuto(on) { try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) {} if (!on && S.mode === "auto") release("auto-off"); if (on) primeMotion(); paintDiag(true); }
  function callActive() { return !!(typeof state !== "undefined" && state.callId && state.callPhase === "active"); }
  function hasVideo() { return !!(typeof state !== "undefined" && state.callWantsVideo); }
  function speakerIsOn() { try { return typeof speakerOn !== "undefined" && !!speakerOn; } catch (e) { return false; } }
  // Авто-режим — только аудио, не громкая связь, не наушники/Bluetooth (если маршрут вообще виден).
  function conditions() {
    return { active: callActive(), audioOnly: !hasVideo(), speakerOff: !speakerIsOn(), noHeadset: !S.headset, auto: autoEnabled(), perm: S.perm !== "denied" };
  }
  function autoEligible() { const c = conditions(); return c.active && c.audioOnly && c.speakerOff && c.noHeadset && c.auto && c.perm; }

  const $id = (id) => (typeof document !== "undefined" ? document.getElementById(id) : null);
  function say(key) { const l = $id("call-guard-live"); if (l) l.textContent = (typeof T === "function" ? T(key) : key); }
  function paint() {
    const ov = $id("call-guard"), b = $id("call-guard-btn");
    const on = S.mode !== "off";
    if (ov) { ov.classList.toggle("hidden", !on); ov.setAttribute("aria-hidden", on ? "false" : "true"); }
    if (b) { b.classList.toggle("active", on); b.setAttribute("aria-pressed", on ? "true" : "false"); b.classList.toggle("hidden", !callActive() || hasVideo()); }
    try { document.documentElement.classList.toggle("call-guard-on", on); } catch (e) {}
    paintDiag(true);
  }
  function engage(mode, why) {
    if (S.mode !== "off") { if (mode === "manual" && S.mode === "auto") { S.mode = "manual"; S.why = why || ""; paint(); } return false; }
    if (!callActive() || hasVideo()) return false; // экран без звонка/с видео не блокируем
    S.mode = mode; S.why = why || ""; S.stillSince = 0; S.flatSince = 0;
    paint(); say("call.guard.on"); wlLog("info", "[callguard] on: " + mode + " " + S.why);
    return true;
  }
  function release(why) {
    cancelHold();
    if (S.mode === "off") return false;
    S.mode = "off"; S.why = why || ""; S.stillSince = 0; S.flatSince = 0;
    // Не включаемся снова, пока телефон не опущен/не лёг (иначе уха хватит, чтобы тут же заблокировать заново).
    S.rearm = false;
    paint(); say("call.guard.off"); wlLog("info", "[callguard] off: " + S.why);
    return true;
  }
  function lock() { return engage("manual", "button"); }
  function unlock(why) { return release(why || "unlock"); }

  // ----- удержание для разблокировки -----
  function cancelHold() {
    if (S.holdTimer) { clearTimeout(S.holdTimer); S.holdTimer = null; }
    const h = $id("call-guard-unlock"); if (h) h.classList.remove("holding");
  }
  // w/h — размеры области касания (CSS px): ладонь/ухо шире порога — не считается.
  function holdStart(w, h) {
    if (S.mode === "off" || S.holdTimer) return false;
    if ((w || 0) > CG_CFG.MAX_CONTACT_PX || (h || 0) > CG_CFG.MAX_CONTACT_PX) return false;
    const el = $id("call-guard-unlock"); if (el) el.classList.add("holding");
    S.holdTimer = setTimeout(() => { S.holdTimer = null; release("hold"); }, CG_CFG.HOLD_MS);
    return true;
  }

  // ----- эвристика наклона -----
  // Вызывается с каждым образцом ориентации. t — мс (для тестов можно подставить своё).
  function sample(beta, gamma, rot, t) {
    t = t == null ? Date.now() : t;
    if (typeof beta !== "number" || !isFinite(beta)) return;
    let r = typeof rot === "number" && isFinite(rot) ? rot : 0;
    if (S.lastBeta != null && t - S.lastT >= CG_CFG.SAMPLE_MIN_DT) {
      const d = (Math.abs(beta - S.lastBeta) + Math.abs((gamma || 0) - (S.lastGamma || 0))) / ((t - S.lastT) / 1000);
      r = Math.max(r, d);
    }
    if (S.lastBeta == null || t - S.lastT >= CG_CFG.SAMPLE_MIN_DT) { S.lastT = t; S.lastBeta = beta; S.lastGamma = gamma || 0; }
    S.beta = beta; S.gamma = gamma; S.rot = r;
    if (!autoEligible()) {
      S.stillSince = 0; S.flatSince = 0;
      if (S.mode === "auto") release("not-eligible");
      return;
    }
    const ab = Math.abs(beta);
    const inBand = ab >= CG_CFG.ENGAGE_BETA_MIN && ab <= CG_CFG.ENGAGE_BETA_MAX;
    const still = r <= CG_CFG.STILL_ROT_MAX;
    // «лёг/опущен»: |beta| < RELEASE_BETA дольше RELEASE_MS (гистерезис: 35..55 — нейтральная зона)
    if (ab < CG_CFG.RELEASE_BETA) { if (!S.flatSince) S.flatSince = t; } else S.flatSince = 0;
    const flat = S.flatSince && t - S.flatSince >= CG_CFG.RELEASE_MS;
    if (flat) {
      S.rearm = true;
      if (S.mode === "auto") { release("flat"); S.rearm = true; }
    }
    if (inBand && still) { if (!S.stillSince) S.stillSince = t; } else S.stillSince = 0;
    if (S.mode === "off" && S.rearm && S.stillSince && t - S.stillSince >= CG_CFG.ENGAGE_STILL_MS) engage("auto", "tilt");
    paintDiag();
  }
  // Реальный датчик приближения (если когда-нибудь появится): near → блокируем, далеко → отпускаем.
  function proximity(near) {
    S.near = !!near;
    if (!autoEligible()) return;
    if (near) engage("auto", "proximity"); else if (S.mode === "auto") release("far");
    paintDiag();
  }

  function onOri(e) { sample(e.beta, e.gamma, S.rotIn, Date.now()); }
  function onMot(e) { const rr = e && e.rotationRate; if (rr) S.rotIn = Math.sqrt((rr.alpha || 0) ** 2 + (rr.beta || 0) ** 2 + (rr.gamma || 0) ** 2); }
  function startMotion() {
    if (S.motionOn || typeof window === "undefined") return;
    if (sup.proximity()) {
      try { const ps = new window.ProximitySensor({ frequency: 5 }); ps.addEventListener("reading", () => proximity(ps.near)); ps.start(); S.sensor = ps; } catch (e) { S.sensor = null; }
    }
    if (sup.devprox()) { try { window.addEventListener("deviceproximity", (e) => { if (e && typeof e.value === "number" && typeof e.max === "number") proximity(e.value <= Math.min(3, e.max / 2)); }); } catch (e) {} }
    window.addEventListener("deviceorientation", onOri);
    window.addEventListener("devicemotion", onMot);
    S.motionOn = true;
  }
  function stopMotion() {
    if (!S.motionOn) return; S.motionOn = false;
    try { window.removeEventListener("deviceorientation", onOri); window.removeEventListener("devicemotion", onMot); } catch (e) {}
    try { if (S.sensor) S.sensor.stop(); } catch (e) {} S.sensor = null;
    S.lastBeta = null; S.beta = null; S.gamma = null; S.rotIn = 0;
  }
  // Вызывать СИНХРОННО из жеста пользователя (старт/принятие аудиозвонка): iOS 13+ требует requestPermission() из тапа.
  function primeMotion() {
    try {
      if (!autoEnabled() || S.perm === "granted" || S.perm === "asking") return;
      const DME = typeof window !== "undefined" && window.DeviceMotionEvent, DOE = typeof window !== "undefined" && window.DeviceOrientationEvent;
      const asker = DME && typeof DME.requestPermission === "function" ? DME : (DOE && typeof DOE.requestPermission === "function" ? DOE : null);
      if (asker) {
        S.perm = "asking";
        asker.requestPermission().then((r) => { S.perm = r === "granted" ? "granted" : "denied"; if (S.perm === "granted" && callActive()) startMotion(); paintDiag(true); })
          .catch(() => { S.perm = "denied"; paintDiag(true); });
      } else if (DME || DOE) S.perm = "granted";
      else S.perm = "unsupported";
      if (S.perm === "granted" && callActive()) startMotion();
    } catch (e) { S.perm = "denied"; }
  }
  async function detectHeadset() {
    try {
      const ds = await navigator.mediaDevices.enumerateDevices();
      S.headset = ds.some((d) => (d.kind === "audiooutput" || d.kind === "audioinput") && /bluetooth|headphone|airpods|earbud|buds|wired|usb|a2dp|hands-?free/i.test(d.label || "") && !/earpiece/i.test(d.label || ""));
    } catch (e) { S.headset = false; }
  }
  function tick() {
    if (!callActive()) return;
    if (S.mode !== "off" && hasVideo()) release("video");
    else if (S.mode === "auto" && !autoEligible()) release("not-eligible");
    paint();
  }
  // Звонок стал активным (setCallPhaseActive).
  function onCallActive() {
    detectHeadset();
    try { if (navigator.mediaDevices && navigator.mediaDevices.addEventListener && !S._dc) { S._dc = true; navigator.mediaDevices.addEventListener("devicechange", detectHeadset); } } catch (e) {}
    if (!hasVideo() && autoEnabled() && (S.perm === "granted" || S.perm === "unknown")) { if (S.perm === "unknown") primeMotion(); else startMotion(); }
    if (!S.tickTimer) S.tickTimer = setInterval(tick, 1000);
    paint();
  }
  function onCallEnd() {
    cancelHold();
    if (S.tickTimer) { clearInterval(S.tickTimer); S.tickTimer = null; }
    const was = S.mode !== "off";
    S.mode = "off"; S.why = "call-end"; S.stillSince = 0; S.flatSince = 0; S.rearm = true; S.headset = false;
    stopMotion();
    if (was) say("call.guard.off");
    paint();
    const gb = $id("call-guard-btn"); if (gb) gb.classList.add("hidden");
  }
  // Входящий второй звонок / критичное состояние: экран должен снова быть доступен.
  function onCritical(why) { release(why || "critical"); }

  function diagText() {
    const c = conditions();
    return [
      "wakeLock: " + WL.state + (WL.err ? " (" + WL.err + ")" : "") + ", want=" + WL.want + ", acquires=" + WL.acquires,
      "guard: " + S.mode + (S.why ? " (" + S.why + ")" : "") + ", rearm=" + S.rearm,
      "beta=" + (S.beta == null ? "-" : S.beta.toFixed(0)) + " gamma=" + (S.gamma == null ? "-" : (S.gamma || 0).toFixed(0)) + " rot=" + S.rot.toFixed(0) + "°/s",
      "auto=" + c.auto + " audioOnly=" + c.audioOnly + " speakerOff=" + c.speakerOff + " noHeadset=" + c.noHeadset + " active=" + c.active,
      "motion perm: " + S.perm + ", listening=" + S.motionOn,
      "ProximitySensor=" + sup.proximity() + " DeviceProximityEvent=" + sup.devprox() + " AmbientLightSensor(не используется)=" + sup.light(),
    ].join("\n");
  }
  function paintDiag(force) {
    const now = Date.now();
    if (!force && now - S.diagAt < 250) return; S.diagAt = now;
    const el = $id("callguard-diag"); if (el) el.textContent = diagText();
  }

  function wire() {
    const b = $id("call-guard-btn");
    if (b && !b.dataset.cgWired) { b.dataset.cgWired = "1"; b.addEventListener("click", () => { if (S.mode === "off") lock(); else unlock("button"); }); }
    const ov = $id("call-guard");
    if (ov && !ov.dataset.cgWired) {
      ov.dataset.cgWired = "1";
      const swallow = (e) => { if (e.cancelable) e.preventDefault(); e.stopPropagation(); };
      for (const ev of ["click", "dblclick", "contextmenu", "touchmove", "wheel"]) ov.addEventListener(ev, swallow, { passive: false });
      ov.addEventListener("touchstart", swallow, { passive: false });
      ov.addEventListener("pointerdown", (e) => { if (e.target && e.target.closest && e.target.closest("#call-guard-unlock")) return; swallow(e); });
    }
    const u = $id("call-guard-unlock");
    if (u && !u.dataset.cgWired) {
      u.dataset.cgWired = "1";
      u.addEventListener("pointerdown", (e) => { if (e.cancelable) e.preventDefault(); holdStart(e.width, e.height); });
      for (const ev of ["pointerup", "pointercancel", "pointerleave"]) u.addEventListener(ev, cancelHold);
      // Клавиатура / скринридер (синтетический click с detail 0) — разблокировка сразу: доступный путь. Настоящее касание (detail>0) — только удержанием.
      u.addEventListener("click", (e) => { if (e.detail === 0) unlock("a11y"); });
    }
    const t = $id("cg-auto-toggle");
    if (t && !t.dataset.cgWired) { t.dataset.cgWired = "1"; t.checked = autoEnabled(); t.addEventListener("change", () => setAuto(t.checked)); }
    paintDiag(true);
  }
  if (typeof document !== "undefined") { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire(); }

  return { S, CFG: CG_CFG, wire, lock, unlock, release, engage, holdStart, cancelHold, sample, proximity, primeMotion, startMotion, stopMotion, onCallActive, onCallEnd, onCritical, tick, conditions, autoEligible, autoEnabled, setAuto, diagText, paint, mode: () => S.mode };
})();
