"use strict";
// Часть 3 из 14 бывшего js/app.js: Аудио-разогрев, звуки/вибрация, PIN-код. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Аудио-разогрев (iOS)
// =====================================================================
function ensureGlobalAudioCtx() {
  if (!globalAudioCtx) {
    try { globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { globalAudioCtx = null; }
  }
  return globalAudioCtx;
}
let backgroundAudioEl = null;
const SILENT_WAV_DATA_URI = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
// Неофициальный, недокументированный приём для iOS: активная "медиасессия"
// с типом playback иногда продлевает время жизни PWA в фоне — достаточно,
// чтобы успел дойти push с входящим звонком. Не гарантирует ничего, но
// не вредит (звук абсолютно тихий) и не требует дополнительных разрешений
// сверх уже запрошенного разрешения на уведомления. Запускается только
// после настоящего пользовательского жеста — иначе браузер всё равно
// заблокирует автовоспроизведение, и раньше времени просить нет смысла.
function startBackgroundAudioSession() {
  if (backgroundAudioEl || !Store.notificationsEnabled) return;
  try {
    const el = document.createElement("audio");
    el.src = SILENT_WAV_DATA_URI;
    el.loop = true;
    el.volume = 0;
    el.setAttribute("playsinline", "");
    el.style.display = "none";
    document.body.appendChild(el);
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
    backgroundAudioEl = el;
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: (T("app.name") || "Эфир") + " — " + T("audio.background.title") });
        navigator.mediaSession.playbackState = "playing";
        navigator.mediaSession.setActionHandler("play", () => { try { el.play().catch(() => {}); } catch (e) {} });
        navigator.mediaSession.setActionHandler("pause", () => {}); // не даём системе трактовать паузу как повод освободить сессию
      } catch (e) {}
    }
  } catch (e) {}
}
let __nextSoundAt = 0;
// Флаг «разогрев уже сделан» — до этого три события одного тапа
// (touchstart + click + keydown) генерировали три параллельных
// ctx.resume(). На iPhone в логе видно ровно это:
//   22:13:39.061 [audio] ctx resumed, state=running
//   22:13:39.061 [audio] ctx resumed, state=running
//   22:13:39.061 [audio] ctx resumed, state=running
// Каждое resume() видело ctx.state === "suspended" ДО того, как
// предыдущее успевало его разбудить — три наложившихся запроса
// на один и тот же AudioContext. Не критично по эффекту, но грязно
// в логах и мешает диагностике. После первого успешного resume
// (или если ctx уже running) снимаем все слушатели — повторять
// смысла нет.
let __warmDone = false;
let __pendingMessageSound = false;
let __pendingMessageSoundAt = 0;
let __warmInProgress = false;
function initAudioWarmup() {
  const warm = () => {
    // пул звуков разблокируем прямо внутри жеста, до любых ранних выходов
    try { if (!__warmDone) unlockSoundPool(); } catch (e) {}
    if (__warmDone || __warmInProgress) return;
    const ctx = ensureGlobalAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      // __warmInProgress ставим ДО ctx.resume(): пока промис не
      // разрешится, ctx.state всё ещё "suspended", и без этого флага
      // обработчики одного тапа (touchstart+click+keydown) параллельно
      // запускают resume — ровно то, что видно в логе 4 раза подряд.
      __warmInProgress = true;
      ctx.resume().then(() => {
        etherLog("info", "[audio] ctx resumed, state=" + ctx.state);
        __warmDone = true;
        __warmInProgress = false;
        document.removeEventListener("touchstart", warm);
        document.removeEventListener("click", warm);
        document.removeEventListener("keydown", warm);
          if (__pendingMessageSound) {
      __pendingMessageSound = false;
      // отложенный сигнал имеет смысл только «свежим»: через минуту он звучал бы сам по себе, без нового сообщения
      if (Date.now() - __pendingMessageSoundAt < 15000) { try { playMessageSound(); } catch (e) {} }
    }
    }).catch(() => { __warmInProgress = false; });
    } else if (ctx.state === "running") {
      __warmDone = true;
      document.removeEventListener("touchstart", warm);
      document.removeEventListener("click", warm);
      document.removeEventListener("keydown", warm);
    }
    try {
      // Пробный беззвучный осциллятор — это НЕ «разбудить ctx», а
      // проверить, что цепочка createOscillator → connect → start
      // вообще работает в текущем контексте (на iOS в standalone-PWA
      // бывают состояния, когда ctx.running, но звук всё равно
      // заблокирован политикой автовоспроизведения). Оставляем как
      // было — стоимость нулевая, польза от подтверждения есть.
      if (ctx.state === "running") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.01);
      }
    } catch (e) {}
    try { unlockSoundPool(); } catch (e) {}
    // startBackgroundAudioSession — по-прежнему закомментирован
    // (см. комментарий у самой функции).
    // try { startBackgroundAudioSession(); } catch (e) {}
  };
  document.addEventListener("touchstart", warm, { passive: true });
  document.addEventListener("click", warm);
  document.addEventListener("keydown", warm);
  warm();
}

// =====================================================================
// Звуки и вибрация
// =====================================================================
function ensureAudioCtx() {
  const ctx = ensureGlobalAudioCtx();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}
// «Тихие часы»: в заданный интервал (может переходить через полночь) сообщения приходят без звука и вибрации; звонки звонят как обычно
function quietNow(date) {
  if (!Store.quietOn) return false;
  const d = date || new Date(), cur = d.getHours() * 60 + d.getMinutes();
  const mins = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const a = mins(Store.quietFrom), b = mins(Store.quietTo);
  if (a === b) return false;
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}
function playMessageSound(contactId) {
  if (!Store.soundsEnabled || quietNow()) return;
  if (typeof Skins !== "undefined" && Skins.sfx("in")) return; // у скина свой звук входящего
  const style = messageSoundStyleForContact(contactId);
  // Гибридная схема: в foreground (приложение видно) играем через Web Audio
  // — быстро, точно, не зависит от разблокировки пула. В background — через
  // HTMLAudioElement, потому что Web Audio на iOS в фоне НЕ резюмируется:
  // ctx.resume() без user gesture молча не срабатывает, осцилляторы копятся
  // в очереди спящего контекста и выстреливают пачкой при следующем тапе.
  // Это ровно то, что видел пользователь: "звук не с первого раза, потом
  // сразу много".
  //
  // Ключевое отличие от прежнего кода: проверяем ctx.state === "running",
  // а не просто наличие ctx. Если контекст suspended — НЕ пытаемся играть
  // через него и НЕ вызываем resume() (в фоне он всё равно не сработает,
  // а в foreground следующий пользовательский жест всё равно проснёт его
  // через initAudioWarmup). Сразу падаем в HTMLAudioElement.
  const isForeground = document.visibilityState === "visible";
  const ctx = isForeground ? ensureGlobalAudioCtx() : null;
  if (ctx && ctx.state === "running") {
    try {
      const playTone = (freq, at, dur, vol) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(vol, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.start(at);
        osc.stop(at + dur + 0.05);
      };
      // __nextSoundAt ограничиваем "не дальше 500 мс от now" — если
      // контекст долго был suspended, __nextSoundAt мог уйти в далёкое
      // будущее, и следующий звук "улетел" бы за пределы слышимого.
      const now = ctx.currentTime;
      const startAt = Math.max(now + 0.01, Math.min(__nextSoundAt, now + 0.5));
      // Паттерн синтеза подобран так, чтобы звучать узнаваемо похоже на
      // соответствующий mp3-файл из MESSAGE_SOUND_FILES (фоновый фолбэк
      // ниже) — один и тот же "стиль" должен звучать одинаково что на
      // переднем плане (Web Audio), что в фоне (HTMLAudioElement).
      let dur2 = 0.26;
      if (style === "chime") { playTone(1046.5, startAt, 0.14, 0.15); playTone(1318.5, startAt + 0.1, 0.18, 0.13); dur2 = 0.28; }
      else if (style === "pop") { playTone(330, startAt, 0.1, 0.18); dur2 = 0.1; }
      else if (style === "bell") { playTone(1760, startAt, 0.5, 0.15); dur2 = 0.5; }
      else { playTone(880, startAt, 0.12, 0.15); playTone(1175, startAt + 0.08, 0.16, 0.13); }
      __nextSoundAt = startAt + dur2;
      return;
    } catch (e) { etherLog("warn", "[sound] message (webaudio):", String(e)); }
  }
  // Fallback — HTMLAudioElement. Единственный надёжный путь для фона
  // (и для foreground, если ctx почему-то suspended). Элемент разблокирован
  // unlockSoundPool() в первом user gesture.
  try {
    const el = getSoundEl(MESSAGE_SOUND_FILES[style] || SOUND_FILES.message, false);
    el.muted = false;
    el.volume = 1;
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch((e) => {
      const name = e && e.name;
      if (name === "NotAllowedError") {
        // iOS заблокировал play() до первого жеста пользователя —
        // это ОЖИДАЕМОЕ поведение при холодном старте, не ошибка.
        // Запоминаем флаг: initAudioWarmup проиграет отложенный звук
        // при первом touchstart/click/keydown.
        __pendingMessageSound = true; __pendingMessageSoundAt = Date.now();
        etherLog("info", "[sound] message: NotAllowedError — откладываю до первого жеста");
      } else {
        etherLog("warn", "[sound] message (audio):", String(e));
      }
    });
  } catch (e) { etherLog("warn", "[sound] message (audio):", String(e)); }
}

function playOutgoingSound() {
  if (!Store.soundsEnabled) return;
  if (typeof Skins !== "undefined" && Skins.sfx("out")) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 600;
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.start(t);
    osc.stop(t + 0.2);
  } catch (e) {}
}
function vibrate(pattern) {
  if (!Store.soundsEnabled || quietNow()) return;
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (e) {}
  }
}
// Отдельная от vibrate() лёгкая haptic-обёртка для UI-действий (реакция,
// свайп-архив, ошибка отправки) — короткие, "тактильные" импульсы, не
// завязанные на настройку звука (это про ощущение нажатия, не про
// звуковые уведомления), но уважающие prefers-reduced-motion.
function haptic(kind) {
  if (prefersReducedMotion()) return;
  if (!navigator.vibrate) return;
  try { navigator.vibrate(kind === "light" ? 10 : kind === "medium" ? 20 : [40, 30, 40]); } catch (e) {}
}

function currentRingtoneSrc() {
  return RINGTONES[Store.ringtone] || RINGTONES["ring-classic"];
}

function playRingtone() {
  stopRingtone();
  // Форсируем resume() аудио-контекста — если пользователь уже
  // взаимодействовал с приложением хотя бы раз за сессию, на iOS
  // контекст в running, и осцилляторный фолбэк ниже сработает. Если
  // ещё не взаимодействовал — просто no-op, ничего не ломает.
  try { ensureAudioCtx(); } catch (e) {}
  if (!Store.soundsEnabled) { if (navigator.vibrate) { try { navigator.vibrate([400, 200, 400, 200, 400, 1000]); } catch (e) {} } return; }
  // Основной путь — HTMLAudioElement (mp3-файл рингтона). Он работает и в
  // foreground, и в background. Явно сбрасываем muted/volume перед play:
  // stopRingtone() мог оставить элемент в промежуточном состоянии, а
  // предыдущий проигрыш мог не завершиться корректно — оба приводили к
  // "второй звонок не сработал".
  try {
    ringtoneAudioEl = getSoundEl(currentRingtoneSrc(), true);
    ringtoneAudioEl.muted = false;
    ringtoneAudioEl.volume = 1;
    ringtoneAudioEl.currentTime = 0;
    const p = ringtoneAudioEl.play();
    if (p && p.catch) p.catch((e) => etherLog("warn", "[ringtone] play failed:", String(e)));
  } catch (e) { etherLog("warn", "[ringtone] failed:", String(e)); }

  if (navigator.vibrate) {
    try { navigator.vibrate([400, 200, 400, 200, 400, 1000]); } catch (e) {}
  }
  // Web Audio-дублирование — ТОЛЬКО если ctx реально running. Раньше здесь
  // было if (ctx) — и в момент, когда ctx был suspended (например,
  // приложение только что ушло в фон и звонок приходит уже в фоне),
  // планировались осцилляторы, которые никуда не звучали и накапливались,
  // а потом "выстреливали" при следующем пользовательском жесте. Плюс
  // setInterval создавал параллельный таймер, который продолжал работать
  // и после stopRingtone() — второй звонок накладывался на первый.
  try {
    const ctx = ensureGlobalAudioCtx();
    if (ctx && ctx.state === "running") {
      const playTone = (freq, delay, dur, vol) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        const t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      };
      const ringCycle = () => {
        playTone(880, 0, 0.18, 0.35);
        playTone(660, 0.18, 0.18, 0.35);
        playTone(880, 0.4, 0.18, 0.35);
        playTone(660, 0.58, 0.18, 0.35);
      };
      ringCycle();
      ringtoneTimer = setInterval(ringCycle, 2000);
    }
  } catch (e) {}
}
function stopRingtone() {
  if (ringtoneTimer) { clearInterval(ringtoneTimer); ringtoneTimer = null; }
  if (ringtoneAudioEl) clearNowPlaying();
  if (ringtoneAudioEl) {
    try { ringtoneAudioEl.pause(); ringtoneAudioEl.currentTime = 0; } catch (e) {}
    ringtoneAudioEl = null;
  }
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
}

// Звуки для звонящей стороны: дозваниваемся / занято / не дозвонились.
function playDialingSound() {
  stopCallSounds();
  if (!Store.soundsEnabled) return;
  try {
    dialingAudioEl = getSoundEl(SOUND_FILES.dialing, true);
    dialingAudioEl.currentTime = 0;
    const p = dialingAudioEl.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function playBusySound() {
  stopCallSounds();
  if (!Store.soundsEnabled) return;
  try {
    const el = getSoundEl(SOUND_FILES.busy, false);
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function playNoAnswerSound() {
  stopCallSounds();
  if (!Store.soundsEnabled) return;
  try {
    const el = getSoundEl(SOUND_FILES.noanswer, false);
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function stopCallSounds() {
  if (dialingAudioEl) clearNowPlaying();
  if (dialingAudioEl) {
    try { dialingAudioEl.pause(); dialingAudioEl.currentTime = 0; } catch (e) {}
    dialingAudioEl = null;
  }
}

// =====================================================================
// Пин-код
// =====================================================================
function showLockScreen() {
  const l = $("#lock-screen"); if (l) l.classList.remove("hidden");
  const o = $("#onboarding"); if (o) o.classList.add("hidden");
  const a = $("#app-shell"); if (a) a.classList.add("hidden");
  setTimeout(() => { const p = $("#lock-pin"); if (p) p.focus(); }, 100);
  // счётчик неверных PIN и пауза переживают перезагрузку страницы
  try {
    const n = parseInt(localStorage.getItem("ether.unlockAttempts") || "0", 10);
    if (n > (state.unlockAttempts || 0)) state.unlockAttempts = n;
    const until = parseInt(localStorage.getItem("ether.unlockLockedUntil") || "0", 10);
    if (until > Date.now() && until > (state._unlockLockedUntil || 0)) { state._unlockLockedUntil = until; lockPinInputFor(until - Date.now()); }
  } catch (e) {}
}
async function tryUnlock(pin) {
  if (!pin) return;
  if (state._unlockLockedUntil && Date.now() < state._unlockLockedUntil) return;
  if (!Store.pinSalt) {
    if (await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) { wipeEverythingAndReload(); }
    return;
  }
  // pbkdf2Hex с 120000 итерациями занимает 200-500мс на мобильном.
  // Кнопка в это время не отвечает — показываем спиннер поверх неё,
  // чтобы не казалось, что нажатие не сработало.
  const btn = $("#lock-submit");
  if (btn) btn.classList.add("loading");
  let h;
  try {
    h = await pbkdf2Hex(pin, Store.pinSalt, PIN_ITERATIONS);
  } finally {
    if (btn) btn.classList.remove("loading");
  }
  if (h === Store.pinHash) {
    if (SecureStore.isOn()) { // данные зашифрованы PIN'ом — расшифровываем в память до старта приложения
      let ok = false;
      try { ok = await SecureStore.unlock(pin); } catch (e) { toast(T("secure.corrupt")); return; }
      if (!ok) { toast(T("toast.pinWrong")); return; }
    }
    state.unlockAttempts = 0;
    try { localStorage.removeItem("ether.unlockAttempts"); localStorage.removeItem("ether.unlockLockedUntil"); } catch (e) {}
    const p = $("#lock-pin"); if (p) p.value = "";
    const l = $("#lock-screen"); if (l) l.classList.add("hidden");
    bootAfterUnlock();
  } else {
    state.unlockAttempts++;
    try { localStorage.setItem("ether.unlockAttempts", String(state.unlockAttempts)); } catch (e) {}
    const p = $("#lock-pin"); if (p) p.value = "";
    if (state.unlockAttempts >= UNLOCK_ATTEMPTS_LIMIT) {
      // Раньше при отказе от жёсткого сброса счётчик попыток тихо
      // обнулялся до нуля — лимит попыток был чистой формальностью,
      // отклонить диалог можно было бесконечно, каждый раз получая
      // полный новый запас попыток. Теперь при отказе поле блокируется
      // на паузу (растущую с каждым разом), а счётчик НЕ сбрасывается.
      if (await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) { wipeEverythingAndReload(); return; }
      const lockoutRounds = Math.floor(state.unlockAttempts / UNLOCK_ATTEMPTS_LIMIT);
      const lockoutMs = Math.min(30000 * lockoutRounds, 5 * 60 * 1000); // 30с, 60с, 90с... максимум 5 минут
      state._unlockLockedUntil = Date.now() + lockoutMs;
      try { localStorage.setItem("ether.unlockLockedUntil", String(state._unlockLockedUntil)); } catch (e) {}
      lockPinInputFor(lockoutMs);
    } else toast(T("toast.pinWrong"));
  }
}
function lockPinInputFor(ms) {
  const p = $("#lock-pin"), s = $("#lock-submit");
  if (p) p.disabled = true;
  if (s) s.disabled = true;
  toast(T("toast.pinLockedOut", { n: Math.ceil(ms / 1000) }));
  setTimeout(() => {
    if (p) p.disabled = false;
    if (s) s.disabled = false;
  }, ms);
}
function wireLockScreen() {
  if (__lockWired) return;
  __lockWired = true;
  const submit = $("#lock-submit"), pin = $("#lock-pin"), forgot = $("#lock-forgot");
  if (submit) submit.addEventListener("click", (e) => { e.preventDefault(); tryUnlock(pin ? pin.value : ""); });
  if (pin) pin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tryUnlock(pin.value); } });
  if (forgot) forgot.addEventListener("click", async () => {
    if (await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) { wipeEverythingAndReload(); }
  });
}

// =====================================================================
