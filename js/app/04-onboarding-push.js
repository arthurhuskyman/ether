"use strict";
// Часть 4 из 14 бывшего js/app.js: Онбординг и запуск, Web Push. Глобальная область общая; порядок <script> важен.

// Онбординг и запуск
// =====================================================================
function bootAfterUnlock() {
  if (__appStarted) return;
  if (Store.name && Store.myId) {
    // Раньше здесь ЖДАЛИ window.__etherIceReady (ответ /ice с сервера)
    // ПЕРЕД тем, как вообще показать приложение — хотя ICE-серверы
    // нужны только в момент РЕАЛЬНОГО соединения (звонок, автоподключение
    // к чату), не для того, чтобы просто открыть список чатов. Если
    // сервер "холодный" (спит после простоя), это превращалось в
    // многосекундную задержку самого ПОКАЗА приложения — пользователь
    // видел пустой экран, хотя список чатов и все настройки уже давно
    // доступны локально. PeerLink теперь сам подстрахуется резервным
    // STUN, если ICE_SERVERS к моменту реального соединения ещё пуст
    // (см. webrtc.js) — ждать здесь стало не нужно вовсе.
    ensureKeyPair().catch(() => {}).then(() => {
      try { startApp(); }
      catch (e) { etherLog("error", "[startApp]", String(e)); }
    }).catch(() => {
      try { startApp(); } catch (e) {}
    });
  } else {
    // Предложение сменить язык теперь вызывается ЗДЕСЬ, до показа формы
    // регистрации — раньше maybeOfferSystemLanguage() вызывалась только
    // внутри startApp(), которая для нового пользователя срабатывает
    // уже ПОСЛЕ заполнения формы. #lang-offer вынесен из #app-shell
    // специально для этого (см. комментарий в CSS) — иначе физически
    // не мог бы показаться раньше.
    try { maybeOfferSystemLanguage(); } catch (e) {}
    const o = $("#onboarding"); if (o) o.classList.remove("hidden");
    wireOnboardingOnce();
  }
}
function initBoot() {
  // confirmSheet() используется и на экране блокировки (забыли PIN →
  // жёсткий сброс) — то есть ДО bootAfterUnlock()/основного safeCall-
  // списка, где эта шторка обычно подключалась бы. Подключаем здесь же,
  // раньше show/hide lock-screen, иначе на confirmSheet() с экрана
  // блокировки некому было бы ответить (шторка в DOM статична и есть
  // всегда, не хватало бы только обработчиков кнопок).
  wireConfirmSheet();
  wireKeyChangeBanner(); wireSafetySheet();
  wireLockScreen();
  if (Store.pinEnabled && Store.pinHash) { showLockScreen(); return; }
  bootAfterUnlock();
}
let __onboardingWired = false;
// Подключение change-обработчика для #import-backup-input — раньше
// жило только внутри wireDebugScreen(), которая запускается лишь
// ПОСЛЕ startApp(). На экране онбординга (до входа в приложение,
// сразу после переустановки) startApp() ещё не вызывался — кнопка
// импорта там открыла бы выбор файла, но сам выбор ничего бы не делал.
// Отдельная идемпотентная функция — вызывается и из онбординга, и из
// wireDebugScreen, но обработчик вешается не больше одного раза.
let __importBackupInputWired = false;
function wireImportBackupInput() {
  if (__importBackupInputWired) return;
  __importBackupInputWired = true;
  const impInput = $("#import-backup-input");
  if (impInput) impInput.addEventListener("change", importBackup);
}
// Раздел 2 роадмапа — флоу онбординга из 4 слайдов. Навигация — кнопки
// Next/Back (не свайп): для разового 4-шагового флоу это надёжнее, чем
// вводить ещё один жест, который пришлось бы отличать от уже существующих
// в приложении (свайп табов V.38.0.0, свайп строки чата и т.п.).
const ONBOARDING_SLIDE_COUNT = 4;
let __onboardingSlide = 0;
let __onboardingKeyPairPromise = null;
// 8 "популярных" языков для сетки на слайде 1 — не претендуют на
// исчерпывающий охват (как и EMOJI_CATEGORIES, который тоже не покрывает
// все ~3000 эмодзи): это быстрый путь для большинства, полный список из
// всех 72 языков доступен тут же через обычный <select> ниже сетки.
const ONBOARDING_POPULAR_LANG_CODES = ["ru", "en", "es", "pt", "de", "fr", "ar", "zh"];
function goToOnboardingSlide(idx) {
  __onboardingSlide = Math.max(0, Math.min(ONBOARDING_SLIDE_COUNT - 1, idx));
  $$(".onboarding-slide").forEach((el) => {
    el.classList.toggle("hidden", Number(el.dataset.slide) !== __onboardingSlide);
  });
  $$(".onboarding-dot").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.dot) === __onboardingSlide);
  });
  if (__onboardingSlide === 3) renderOnboardingReadySlide();
}
function renderOnboardingLangGrid() {
  const grid = $("#onboarding-lang-grid"); if (!grid) return;
  grid.innerHTML = "";
  const byCode = new Map(I18N.languages.map((l) => [l.code, l]));
  for (const code of ONBOARDING_POPULAR_LANG_CODES) {
    const lang = byCode.get(code); if (!lang) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "onboarding-lang-btn" + (code === I18N.current ? " active" : "");
    btn.dataset.lang = code;
    btn.textContent = lang.native;
    btn.addEventListener("click", () => applyOnboardingLanguage(code));
    grid.appendChild(btn);
  }
}
function populateOnboardingLangSelect() {
  const sel = $("#onboarding-lang-select"); if (!sel) return;
  sel.innerHTML = "";
  const langs = I18N.languages.slice().sort((a, b) => a.english.localeCompare(b.english, "en"));
  for (const lang of langs) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.english + " · " + lang.native;
    sel.appendChild(opt);
  }
  sel.value = I18N.current;
  sel.addEventListener("change", () => applyOnboardingLanguage(sel.value));
}
// Смена языка прямо на слайде онбординга — минимальная версия того, что
// делает setupLanguageSelector() в Settings: до startApp() ещё не
// существует ни открытого чата, ни списка контактов, которые пришлось бы
// перерисовывать, так что нужны только ensureLoaded+setLang+применение
// статичных переводов (они покрывают и текст самого онбординга).
function applyOnboardingLanguage(code) {
  const sel = $("#onboarding-lang-select");
  if (sel) sel.disabled = true;
  I18N.ensureLoaded(code, (ok) => {
    if (sel) sel.disabled = false;
    if (!ok) { toast(T("toast.langLoadFailed")); return; }
    I18N.setLang(code);
    applyStaticTranslations();
    $$(".onboarding-lang-btn").forEach((b) => b.classList.toggle("active", b.dataset.lang === code));
    if (sel) sel.value = code;
  });
}
function renderOnboardingReadySlide() {
  const name = Store.name || "";
  const av = $("#onboarding-avatar");
  if (av) { av.style.background = avatarGradient(name); av.textContent = initials(name); }
  const nameEl = $("#onboarding-ready-name"); if (nameEl) nameEl.textContent = name;
  renderQrToCanvas($("#onboarding-qr-canvas"));
  const codeEl = $("#onboarding-invite-code"); if (codeEl) codeEl.textContent = Store.myIdentityRaw || Store.myId || "";
}
function wireOnboardingOnce() {
  if (__onboardingWired) return;
  __onboardingWired = true;
  if (Store.name) { const el = $("#onboarding-name"); if (el) el.value = Store.name; }
  // Восстановление из файла бэкапа прямо с экрана регистрации — раньше
  // это было спрятано в скрытом Debug-экране (5 тапов по заголовку),
  // куда обычный пользователь никогда бы не попал, особенно СРАЗУ после
  // переустановки, когда он ещё даже не внутри приложения. importBackup
  // сама перезагружает страницу после успешного импорта — онбординг
  // корректно пропустится, раз Store.name/myId уже заполнены из бэкапа.
  // Доступно с первого (Welcome) слайда — обходит весь флоу целиком.
  wireImportBackupInput();
  wireBackupPasswordSheet();
  const impBtn = $("#onboarding-import-backup-btn");
  if (impBtn) impBtn.addEventListener("click", () => { const el = $("#import-backup-input"); if (el) el.click(); });
  // Drag-and-drop файла бэкапа — висит на самой карточке (а не на
  // конкретном слайде), поэтому работает независимо от того, какой слайд
  // сейчас показан. Актуально в первую очередь для desktop-сценария.
  const card = document.querySelector(".onboarding-card");
  if (card) {
    const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
    ["dragenter", "dragover"].forEach((evt) => card.addEventListener(evt, (e) => { prevent(e); card.classList.add("drag-over"); }));
    ["dragleave", "dragend"].forEach((evt) => card.addEventListener(evt, (e) => { prevent(e); card.classList.remove("drag-over"); }));
    card.addEventListener("drop", (e) => {
      prevent(e);
      card.classList.remove("drag-over");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) importBackupFile(file);
    });
  }
  renderOnboardingLangGrid();
  populateOnboardingLangSelect();
  $$(".onboarding-next").forEach((btn) => btn.addEventListener("click", () => goToOnboardingSlide(__onboardingSlide + 1)));
  $$(".onboarding-back").forEach((btn) => btn.addEventListener("click", () => goToOnboardingSlide(__onboardingSlide - 1)));
  const form = $("#onboarding-form");
  if (!form) return;
  // Живая ✓-индикация валидности (раздел 2 роадмапа) вместо исключительно
  // красной обводки при ошибке, как было на едином экране раньше. idFor()
  // тут вызывается только ради проверки формата — результат (id/хэш)
  // отбрасывается, сама проверка достаточно дешёвая для запуска на
  // каждый ввод.
  const idField = $("#onboarding-identity");
  const idCheck = $("#onboarding-id-check");
  if (idField) {
    idField.addEventListener("input", () => {
      const v = idField.value.trim();
      if (!v) { idField.classList.remove("input-invalid"); if (idCheck) idCheck.classList.add("hidden"); return; }
      Identity.idFor(v).then(
        () => { idField.classList.remove("input-invalid"); if (idCheck) idCheck.classList.remove("hidden"); },
        () => { idField.classList.add("input-invalid"); if (idCheck) idCheck.classList.add("hidden"); }
      );
    });
  }
  // Переход слайд 2 → 3: вычисляем идентичность и запускаем генерацию
  // ключевой пары В ФОНЕ (не блокируя переход на слайд с аватаром/QR —
  // они используют Store.myId/Store.name, которые уже установлены ниже,
  // а не сам факт готовности ключей). Сам запуск приложения — отдельное
  // действие на слайде 4 (#onboarding-start-btn), которое дожидается эту
  // же Promise перед тем, как продолжить — порядок асинхронных шагов
  // идентичен тому, что было на едином экране, просто разнесён по двум
  // UI-шагам вместо одного.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameVal = $("#onboarding-name").value.trim();
    const idVal = $("#onboarding-identity").value.trim();
    if (!nameVal) return;
    // killer-features-backlog 0.1 — Анонимная identity как default UX:
    // телефон/email больше не обязателен. Если поле пустое — профиль
    // анонимный: id генерируется случайно (crypto.randomUUID()) и НЕ
    // выводится из телефона/email, значит найти такого пользователя по
    // номеру/почте нельзя — добавить его можно только по инвайт-коду/QR.
    if (idVal) {
      let identity;
      try { identity = await Identity.idFor(idVal); }
      catch (err) { toast(T(err.message)); idField && idField.classList.add("input-invalid"); return; }
      Store.myIdentityRaw = identity.normalized;
      Store.myId = identity.id;
    } else {
      Store.myIdentityRaw = "";
      Store.myId = crypto.randomUUID();
    }
    Store.name = nameVal;
    // Новый профиль не виден незнакомцам в списке «онлайн» по умолчанию (включить можно в настройках) — меньше следов, чем у «видимого всем»
    try { if (localStorage.getItem("ether.discoverable") === null) Store.discoverable = false; } catch (e) {}
    __onboardingKeyPairPromise = ensureKeyPair({ fresh: true }).catch(() => {});
    goToOnboardingSlide(3);
  });
  const startBtn = $("#onboarding-start-btn");
  if (startBtn) startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    await (__onboardingKeyPairPromise || Promise.resolve()).catch(() => {});
    await (window.__etherIceReady || Promise.resolve()).catch(() => {});
    await backupToIDB().catch(() => {});
    const o = $("#onboarding"); if (o) o.classList.add("hidden");
    try { startApp(); } catch (e) { etherLog("error", "[startApp]", String(e)); }
  });
}
async function ensureKeyPair(opts) {
  try {
    if (Store.myPrivateKeyJwk && Store.myPublicKeyJwk) return;
    const hadProfile = !(opts && opts.fresh) && !!Store.myId; // при первом входе id уже выставлен регистрацией, но это не «пропавшие ключи»
    // Перед созданием новой пары — ещё раз пробуем достать старую из резервной копии в IndexedDB (руна и safety number не должны
    // меняться из-за того, что localStorage на устройстве оказался пуст, а копия ключей цела).
    try {
      const pv = await IDB.get("ether.privKey"), pb = await IDB.get("ether.pubKey");
      if (pv && pb) {
        JSON.parse(pv); JSON.parse(pb);
        localStorage.setItem("ether.privKey", pv); localStorage.setItem("ether.pubKey", pb);
        etherLog("warn", "[crypto] ключи восстановлены из резервной копии IndexedDB");
        return;
      }
    } catch (e) {}
    const { publicKeyJwk, privateKeyJwk } = await CryptoHelper.generateKeyPair();
    Store.myPrivateKeyJwk = privateKeyJwk;
    Store.myPublicKeyJwk = publicKeyJwk;
    try { Ratchet.resetAll(); } catch (e) {} // новая личность — старые ratchet-сессии бессмысленны
    let info = {}; try { info = JSON.parse(localStorage.getItem("ether.keyInfo") || "{}") || {}; } catch (e) {}
    info = { at: Date.now(), count: (info.count || 0) + 1, existing: hadProfile };
    try { localStorage.setItem("ether.keyInfo", JSON.stringify(info)); scheduleIDBBackup(); } catch (e) {}
    if (hadProfile) {
      etherLog("warn", "[crypto] ключи СОЗДАНЫ ЗАНОВО для существующего профиля (в хранилище и в копии IndexedDB их не было); руна изменилась");
      setTimeout(() => { try { toast(T("toast.keysRegenerated")); } catch (e) {} }, 2500);
    }
  } catch (e) { etherLog("error", "[crypto] key pair:", String(e)); }
}

// Блокировка поворота экрана — приложение не рассчитано на альбомную
// раскладку вовсе. screen.orientation.lock() поддерживается лишь
// частично (Chrome/Firefox на Android — то есть НЕ iOS Safari, где
// этот API отсутствует физически, Apple ещё в 2020 отказалась его
// реализовывать) и требует режима fullscreen на большинстве платформ
// — который сам по себе достаточно навязчивая смена интерфейса для
// обычного мессенджера, так что fullscreen тут НЕ запрашиваем,
// пробуем только сам lock() напрямую. Там, где не поддерживается
// (в первую очередь iOS) — тихо ничего не происходит, honest best-effort.
function tryLockPortraitOrientation() {
  try {
    if (screen.orientation && typeof screen.orientation.lock === "function") {
      screen.orientation.lock("portrait").catch(() => {});
    }
  } catch (e) {}
}
function startApp() {
  if (__appStarted) {
    const o = $("#onboarding"); if (o) o.classList.add("hidden");
    const l = $("#lock-screen"); if (l) l.classList.add("hidden");
    const a = $("#app-shell"); if (a) a.classList.remove("hidden");
    return;
  }
  __appStarted = true;
  tryLockPortraitOrientation();
  const o = $("#onboarding"); if (o) o.classList.add("hidden");
  const l = $("#lock-screen"); if (l) l.classList.add("hidden");
  const a = $("#app-shell"); if (a) a.classList.remove("hidden");

  // I18N.init() уже вызван в DOMContentLoaded до initBoot() — startApp()
  // всегда достигается уже после этого, повторный вызов здесь был чистым
  // дублированием (идемпотентно, но лишний проход).

  etherLog("info", "[startApp] init, id=" + (Store.myId ? Store.myId.slice(0, 10) + "…" : "(none)"));
  mesh = new MeshManager(Store.name);
  // ⚠️ УБРАНО: navigator.audioSession.type = "playback".
  // На iOS установка категории "playback" ЗАПРЕЩАЕТ захват звука с
  // микрофона: любой getUserMedia({audio:true}) падает с
  // InvalidStateError: "AudioSession category is not compatible with
  // audio capture". Из-за этого вызов answerCall()/startCall() в
  // звонке ВСЕГДА падал с ошибкой, и звонки были полностью
  // невозможны. Попытка была направлена на улучшение фонового
  // рингтона, но такой ценой она не оправдана — откатываем.
  safeCall(wireMeshEvents, "wireMeshEvents");
  safeCall(wireTabBar, "wireTabBar");
  safeCall(wireTabSwipe, "wireTabSwipe");
  safeCall(() => {
    // Если данные были полностью сброшены (localStorage.clear()) в ДРУГОЙ
    // открытой вкладке — эта вкладка иначе продолжала бы работать со
    // старыми данными в памяти, ничего не подозревая, до следующего
    // случайного действия. storage-событие с key===null — это именно
    // .clear() из другой вкладки того же origin (для set/remove
    // конкретного ключа key был бы непустым).
    window.addEventListener("storage", (e) => { if (e.key === null) location.reload(); });
  }, "wireCrossTabReset");
  safeCall(() => {
    // Раньше тап по индикатору соединения переключал на вкладку
    // настроек — единственный способ понять, что происходит с
    // соединением, был "иди в настройки и смотри". Теперь он открывает
    // очередь отправки (P1.14): что именно зависло и почему. Настройки
    // остаются на расстоянии одного тапа через нижнюю вкладку Settings.
    const nav = $("#nav-conn-indicator");
    if (nav) nav.addEventListener("click", () => { if (state._replaced) reclaimSignaling(); else openOutboxSheet(); });
  }, "wireNavConnIndicator");
  safeCall(wireConnectScreen, "wireConnectScreen");
  safeCall(wireQrButtons, "wireQrButtons");
  safeCall(wireGroupInfo, "wireGroupInfo");
  safeCall(wireChatScreen, "wireChatScreen");
  safeCall(wireScheduleSend, "wireScheduleSend");
  safeCall(wireReminders, "wireReminders");
  safeCall(wireChatHeaderMenu, "wireChatHeaderMenu");
  safeCall(wireCmdk, "wireCmdk");
  safeCall(wireMuteSheet, "wireMuteSheet");
  safeCall(wireCallScreen, "wireCallScreen");
  safeCall(wireSettingsScreen, "wireSettingsScreen");
  safeCall(wireGlobalSearch, "wireGlobalSearch");
  safeCall(wireEscCloseAnySheet, "wireEscCloseAnySheet");
  safeCall(wireSheetFocusManagement, "wireSheetFocusManagement");
  safeCall(wireDebugScreen, "wireDebugScreen");
  safeCall(wireSheetBackdrops, "wireSheetBackdrops");
  safeCall(wireCameraButton, "wireCameraButton");
  safeCall(wireSearchHandlers, "wireSearchHandlers");
  safeCall(wireChatFolders, "wireChatFolders");
  safeCall(wirePullToRefresh, "wirePullToRefresh");
  safeCall(wireMediaComposeSheet, "wireMediaComposeSheet");
  safeCall(wireJumpToDateSheet, "wireJumpToDateSheet");
  safeCall(wireEmojiPicker, "wireEmojiPicker");
  safeCall(wireComposerPlusMode, "wireComposerPlusMode");
  safeCall(wireSkipLink, "wireSkipLink");
  safeCall(wireBackupPasswordSheet, "wireBackupPasswordSheet");
  safeCall(wireHandshakeToneSheet, "wireHandshakeToneSheet");
  safeCall(wireNotificationPermission, "wireNotificationPermission");
  safeCall(wireServiceWorker, "wireServiceWorker");
  safeCall(wireRenameSheet, "wireRenameSheet");
  safeCall(wireNotifBanner, "wireNotifBanner");
  safeCall(wireContactCard, "wireContactCard");
  safeCall(wireContactGallery, "wireContactGallery");
  safeCall(wireNavTitleTaps, "wireNavTitleTaps");
  safeCall(wirePanicButton, "wirePanicButton");
  safeCall(wirePanicShakeBanner, "wirePanicShakeBanner");
  safeCall(() => { if (Store.panicShakeEnabled) wirePanicShake(); }, "wirePanicShakeAutostart");
  safeCall(wireShakeUndoGuard, "wireShakeUndoGuard");
  safeCall(wireKeyboardFix, "wireKeyboardFix");
  safeCall(wireKeepKeyboard, "wireKeepKeyboard");
  safeCall(wireNetworkListeners, "wireNetworkListeners");
  safeCall(wireViewportRecalc, "wireViewportRecalc");
  safeCall(wireMediaViewer, "wireMediaViewer");
  safeCall(wireLinkActionSheet, "wireLinkActionSheet");
  safeCall(applyDebugTabVisibility, "applyDebugTabVisibility");
  safeCall(() => { const el = $("#about-version"); if (el) el.textContent = APP_VERSION; }, "aboutVersion");
  safeCall(initAudioWarmup, "initAudioWarmup");
  safeCall(applyChatAppearancePrefs, "applyChatAppearancePrefs");
  safeCall(applyCalmMode, "applyCalmMode");
  safeCall(setupLanguageSelector, "setupLanguageSelector");
  safeCall(applyStaticTranslations, "applyStaticTranslations");

  try {
    applyGlassAlpha(Store.glassAlpha);
    applyTheme(Store.theme);
    try { Skins.apply(Store.skin); Skins.wire(); } catch (e) { /* скины необязательны: без них приложение работает в обычном виде */ }
    const slider = $("#glass-slider"); if (slider) slider.value = alphaToTransparency(Store.glassAlpha).toFixed(2);
    $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === Store.theme));
    const sn = $("#settings-name"); if (sn) sn.value = Store.name;
    const si = $("#settings-identity"); if (si) si.value = Store.myIdentityRaw;
    const sms = $("#settings-my-status"); if (sms) sms.value = Store.myStatus;
    const ss = $("#settings-signaling-url"); if (ss) ss.value = Store.signalingUrl || "";
    const sd = $("#settings-discoverable"); if (sd) sd.checked = Store.discoverable;
    const sr = $("#settings-receipts"); if (sr) sr.checked = Store.receiptsEnabled;
    const sls = $("#settings-last-seen"); if (sls) sls.checked = Store.lastSeenVisible;
    const sp = $("#settings-presence"); if (sp) sp.checked = Store.presenceVisible;
    try { refreshDiscoveryUI(); } catch (e) {}
    const snn = $("#settings-notifications"); if (snn) snn.checked = Store.notificationsEnabled;
    const shn = $("#settings-hide-notif"); if (shn) shn.checked = Store.hideNotifContent;
    const slp = $("#settings-link-previews"); if (slp) slp.value = Store.linkPreviewMode;
    const ste = $("#settings-translate-endpoint"); if (ste) ste.value = Store.translateEndpoint;
    const stk = $("#settings-translate-key"); if (stk) stk.value = Store.translateApiKey;
    const ssn = $("#settings-sounds"); if (ssn) ssn.checked = Store.soundsEnabled;
    const srt = $("#settings-ringtone"); if (srt) srt.value = Store.ringtone;
    const spl = $("#settings-pinlock"); if (spl) spl.checked = Store.pinEnabled;
    const sae = $("#settings-auto-emoji"); if (sae) sae.checked = Store.autoEmoji;
    const dme = $("#settings-deadman-enabled"); if (dme) dme.checked = Store.deadManEnabled;
    try { refreshSettingsQuick(); } catch (e) {}
    const dmt = $("#settings-deadman-threshold"); if (dmt) dmt.value = String(Store.deadManThresholdDays);
    const psEl = $("#settings-panic-shake"); if (psEl) psEl.checked = Store.panicShakeEnabled;
  } catch (e) { etherLog("error", "[startApp] settings init:", String(e)); }

  try {
    loadContacts(); loadHeld(); loadLastSeen(); loadDrafts(); loadScheduledMessages(); loadChatFolders();
    restoreOutbox(); restoreGroupDeliveryMap(); restorePendingNoKey(); restoreRecentlyDeleted(); loadCallLog();
    migrateServerAckedFlags();
    // Контакты теперь загружены — можно подставить имя уже выбранного
    // доверенного контакта для Dead Man's Switch (до этой точки
    // state.contacts был бы ещё пуст, см. settings init выше).
    const dmcName = $("#settings-deadman-contact-name");
    if (dmcName) {
      const dmc = state.contacts.get(Store.deadManContactId);
      dmcName.textContent = dmc ? (dmc.name || T("sys.someone")) : "";
    }
  } catch (e) { etherLog("error", "[startApp] load data:", String(e)); }

  try { handleNotificationNavigateParams(); } catch (e) { etherLog("error", "[startApp] notification params:", String(e)); }

  try { handleShareTargetParams(); } catch (e) { etherLog("error", "[startApp] share target params:", String(e)); }

  try { checkDeadManSwitch(); } catch (e) { etherLog("error", "[startApp] dead man switch:", String(e)); }

  try {
    const addedByLink = handleAddLinkFromLocation();
    const incoming = addedByLink ? null : SignalingCodec.extractCodeFromLocation();
    if (incoming) {
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
      handleIncomingCode(incoming).catch(() => { try { toast(T("toast.badInviteCode")); } catch (e) {} });
    }
  } catch (e) { etherLog("error", "[startApp] incoming code:", String(e)); }

  try { renderTab(); } catch (e) { etherLog("error", "[startApp] renderTab:", String(e)); }
  // Снимаем skeleton-флаг чуть погодя: на холодном старте contacts ещё
  // могла не успеть восстановиться из IndexedDB-бэкапа в этот самый тик,
  // 400мс достаточно, чтобы это не мигало на быстрых устройствах, но
  // хватило на медленных, чтобы показать skeleton, а не пустой экран.
  setTimeout(() => {
    state._firstRenderDone = true;
    if (state.tab === "chats" && !state.chatId) { try { renderChatsList(); } catch (e) {} }
  }, 400);
  try { initSignaling(); } catch (e) { etherLog("error", "[startApp] initSignaling:", String(e)); }
  try { startOutboxRetryLoop(); } catch (e) {}
  try { setInterval(sweepExpiredMessages, 30000); sweepExpiredMessages(); } catch (e) {}
  // Проверяем раз в 30с + сразу при старте (не ждём первого тика) — так
  // отложенное сообщение, время которого уже прошло пока приложение было
  // закрыто, уходит немедленно при следующем запуске, а не теряется.
  try { setInterval(sweepScheduledMessages, 30000); sweepScheduledMessages(); } catch (e) {}
  try { setInterval(sweepIncomingFileBuffers, 60000); } catch (e) {}
  try { setInterval(() => { if (!document.hidden) checkDeadManSwitch(); }, 30 * 60 * 1000); document.addEventListener("visibilitychange", () => { if (!document.hidden) checkDeadManSwitch(); }); } catch (e) {}
  try { document.addEventListener("visibilitychange", () => { if (!document.hidden) sweepScheduledMessages(); }); } catch (e) {}
  try { updateNotifBanner(); } catch (e) {}
  try { resumeUnsentMessages(); } catch (e) {}
  try { updateAppBadge(); } catch (e) {}
  try { updateCallsBadge(); } catch (e) {}
  try { maybeShowOnboardingHint(); } catch (e) {}
  try { maybeOfferSystemLanguage(); } catch (e) {}
}

function applyStaticTranslations() {
  try { if (typeof Skins !== "undefined") Skins.render(); } catch (e) {}
  $$("[data-i18n]").forEach((el) => {
    const k = el.getAttribute("data-i18n");
    if (!k) return;
    el.textContent = T(k);
  });
  $$("[data-i18n-ph]").forEach((el) => {
    const k = el.getAttribute("data-i18n-ph");
    if (k) el.setAttribute("placeholder", T(k));
  });
  $$("[data-i18n-aria]").forEach((el) => {
    const k = el.getAttribute("data-i18n-aria");
    if (k) el.setAttribute("aria-label", T(k));
  });
  // <title> и meta description не переводились вовсе (нет data-i18n) —
  // пользователь видел английский заголовок вкладки/PWA-плитки и в
  // поиске браузера независимо от выбранного языка приложения.
  document.title = T("app.title");
  // Смена языка меняет ширину подписей вкладок (а значит и центр
  // иконки) — индикатор нужно пересчитать уже после реального реflow.
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.setAttribute("content", T("app.description"));
  // Список категорий Настроек строится из JS (не из data-i18n) — без перерисовки после смены языка
  // подписи оставались на языке, действовавшем в момент старта приложения.
  try { renderSettingsCategories(); updateSettingsCategoryView(); } catch (e) {}
}

function setupLanguageSelector() {
  const sel = $("#settings-language");
  if (!sel) return;
  sel.innerHTML = "";
  const langs = I18N.languages.slice().sort((a, b) => a.english.localeCompare(b.english, "en"));
  // Всегда показываем обе части (раньше пара пропадала для языков, где
  // native === english — English, Hausa, Filipino, Cebuano — совпадение
  // ошибочно трактовалось как "нечего добавлять"). Без искусственного
  // выравнивания через пробелы: на мобильных <select> рендерится через
  // нативный пикер ОС, который игнорирует шрифт и стили страницы —
  // padding только добавлял бы лишние видимые пробелы, не выравнивая
  // ничего на практике.
  for (const lang of langs) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.english + " · " + lang.native;
    sel.appendChild(opt);
  }
  sel.value = I18N.current;
  sel.addEventListener("change", () => {
    const code = sel.value;
    // Словарь новой (ещё не выбранной) вкладки может быть не загружен —
    // подгружаем лениво (js/lang/<code>.js, обычно 15-30КБ, а не все
    // 72 языка разом) и только после этого переключаемся.
    sel.disabled = true;
    I18N.ensureLoaded(code, (ok) => {
      sel.disabled = false;
      if (!ok) { toast(T("toast.langLoadFailed")); sel.value = I18N.current; return; }
      I18N.setLang(code);
      applyStaticTranslations();
      try { renderTab(); } catch (e) {}
      if (state.chatId) renderChatThread();
      if (state.contactCardId) renderContactCard();
      if (state.tab === "chats" && state.chatsSegment === "calls") renderCallsList();
      refreshSignalingStatusText();
      renderOnlineRosterList();
    });
  });
}

function maybeOfferSystemLanguage() {
  const sys = I18N.shouldOfferSystem();
  if (!sys) return;
  const banner = $("#lang-offer");
  if (!banner) return;
  banner.classList.remove("hidden");
  const title = $("#lang-offer-title"); if (title) title.textContent = T("lang.offer.title");
  const txt = $("#lang-offer-text"); if (txt) txt.textContent = T("lang.offer.text", { lang: I18N.nativeName(sys) });
  const yes = $("#lang-offer-yes");
  if (yes) {
    yes.textContent = T("lang.offer.yes");
    yes.addEventListener("click", () => {
      I18N.ensureLoaded(sys, (ok) => {
        if (!ok) { toast(T("toast.langLoadFailed")); return; }
        I18N.setLang(sys);
        I18N.markOfferShown();
        banner.classList.add("hidden");
        try { updateNotifBanner(); } catch (e) {}
        applyStaticTranslations();
        try { renderTab(); } catch (e) {}
        const sel = $("#settings-language"); if (sel) sel.value = I18N.current;
      });
    });
  }
  const no = $("#lang-offer-no");
  if (no) no.addEventListener("click", () => {
    I18N.markOfferShown();
    banner.classList.add("hidden");
    try { updateNotifBanner(); } catch (e) {}
  });
}

// iOS Safari/PWA в standalone-режиме иногда "замораживает" значения
// env(safe-area-inset-*) и 100dvh на момент сворачивания приложения —
// при повторном открытии эти значения могут не пересчитаться, из-за
// чего футер визуально "плывёт" и растёт с каждым новым открытием.
// Обходной приём: на возврате в приложение принудительно вызываем
// перерасчёт layout, ненадолго переключая высоту #app-shell.
function forceViewportRecalc() {
  try {
    const shell = document.getElementById("app-shell");
    if (!shell) return;
    // Переключение #app-shell на height:auto и обратно (нужно, чтобы
    // форсировать у iOS Safari пересчёт 100dvh после возврата из
    // фона — реальный, задокументированный баг WebKit) попутно СБРАСЫВАЛО
    // scrollTop у #chat-messages в 0 — дочерний элемент временно
    // оказывается в другом по размеру родителе, и браузер теряет
    // позицию прокрутки. Явно сохраняем и восстанавливаем её вокруг
    // переключения, а не полагаемся на то, что браузер сам её удержит.
    const wrap = document.getElementById("chat-messages");
    const savedScroll = wrap ? wrap.scrollTop : null;
    shell.style.height = "auto";
    // eslint-disable-next-line no-unused-expressions
    shell.offsetHeight; // принудительный reflow между сбросом и восстановлением
    shell.style.height = "";
    if (wrap && savedScroll !== null) wrap.scrollTop = savedScroll;
  } catch (e) {}
}
// Запрет масштабирования и поворота. iOS Safari игнорирует user-scalable=no для щипка, поэтому
// блокируем жесты явно; ориентацию пытаемся зафиксировать API (iOS его не поддерживает — там
// портретный режим держит оверлей #rotate-lock, см. CSS).
function lockViewportGestures() {
  ["gesturestart", "gesturechange", "gestureend"].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    // двойной тап = зум; но на заголовке (5 быстрых тапов открывают «Отладку») click должен доходить
    const onTitle = e.target && e.target.closest && e.target.closest("#nav-title, #about-app-logo");
    if (now - lastTouchEnd < 300 && e.cancelable && !onTitle) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock("portrait").catch(() => {}); } catch (e) {}
}
function wireViewportRecalc() {
  lockViewportGestures();
  try { document.documentElement.classList.toggle("is-standalone", isStandalone()); } catch (e) {}
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { forceViewportRecalc(); try { applyDynamicType(); } catch (e) {} } });
  window.addEventListener("pageshow", () => { forceViewportRecalc(); });
  window.addEventListener("focus", () => { forceViewportRecalc(); });
}
// Закрытие вкладки/приложения посреди звонка: успеваем сказать собеседнику «звонок завершён», а не оставлять его висеть.
function hangupOnPageClose() {
  const cid = state.callId; if (!cid || !state.callPhase) return;
  try { const l = mesh.get(cid); if (l) { l.send({ kind: "call-state", state: "ended", ts: Date.now() }); } } catch (e) {}
  try { if (signaling && signaling.connected) signaling.signal(cid, { t: "call-ended" }); } catch (e) {}
}
window.addEventListener("pagehide", hangupOnPageClose);
window.addEventListener("beforeunload", hangupOnPageClose);
function wireNetworkListeners() {
  const resumeSignaling = () => {
    try {
      if (state._replaced && !document.hidden) { reclaimSignaling(); return; }
      if (signaling && typeof signaling.resume === "function") signaling.resume();
    } catch (e) {}
  };
  window.addEventListener("online", () => { etherLog("info", "[net] online"); resumeSignaling(); });
  window.addEventListener("pageshow", resumeSignaling);
  window.addEventListener("focus", resumeSignaling);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeSignaling(); });
  window.addEventListener("offline", () => etherLog("warn", "[net] offline"));
  // Поворот экрана/ресайз окна сдвигает позиции кнопок таб-бара —
  // индикатор иначе остался бы на старых координатах до следующего
  // переключения вкладки.
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    conn.addEventListener("change", () => {
      etherLog("info", "[net] connection change: " + conn.effectiveType + ", downlink=" + conn.downlink);
    });
  }
}

function migrateServerAckedFlags() {
  let touched = false;
  for (const c of state.contacts.values()) {
    for (const m of c.messages) {
      if (m.from !== "me") continue;
      if (m.serverAcked) continue;
      if (m.ack === "delivered" || m.ack === "read") { m.serverAcked = true; touched = true; }
    }
  }
  if (touched) persistContacts();
}

function maybeShowOnboardingHint() {
  if (localStorage.getItem(ONBOARDING_HINT_SHOWN) === "1") return;
  // Один раз за жизнь профиля (флаг ставим сразу) и только в спокойный момент: без открытых шторок и без клавиатуры.
  try { localStorage.setItem(ONBOARDING_HINT_SHOWN, "1"); } catch (e) {}
  let tries = 0;
  const attempt = () => {
    const ae = document.activeElement, typing = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
    if (document.querySelector(".sheet:not(.hidden)") || typing) { if (++tries < 8) setTimeout(attempt, 4000); return; }
    try { toast(T("onboarding.gestureHint")); } catch (e) {}
  };
  setTimeout(attempt, 1500);
}

// Push о входящем звонке «живёт» недолго: если нажали на него позже минуты, звонящий уже сдался.
function isCallPushFresh(ts) {
  const t = Number(ts);
  return !t || (Date.now() - t >= 0 && Date.now() - t < 60000);
}
function openFromNotification(contactId, kind, focusInput, meta) {
  try { closeChatSearch(); } catch (e) {}
  if (!contactId) return;
  { const _nc = state.contacts.get(contactId); if (!_nc || _nc.blocked) return; } // ссылка/push с чужим id не должна открывать чат или звонок
  window.focus();
  state.chatId = contactId;
  __lastRenderedChatId = null;
  state.multiSelect = null;
  state.contactCardId = null; // иначе после закрытия этого чата могла неожиданно всплыть карточка контакта, на которой пользователь был до уведомления
  renderTab();
  if (kind === "call") {
    if (state.callId === contactId && state.callPhase === "ringing") {
      openCallScreen(contactId, "ringing");
      if (!ringtoneAudioEl || ringtoneAudioEl.paused) { try { ensureAudioCtx(); } catch (e) {} playRingtone(); }
    } else if (!state.callId && isCallPushFresh(meta && meta.ts)) {
      // Приложение запустили (или развернули) нажатием на push о звонке, а серверное приглашение к нам ещё не дошло:
      // сервер/соединение только поднимаются. Раньше здесь показывалось «пропущенный звонок», а звонящий продолжал
      // звонить. Теперь сразу открываем экран «входящий» и подключаемся к звонящему; принять можно уже сейчас.
      state.callWantsVideo = false;
      openCallScreen(contactId, "ringing", { timeoutMs: INCOMING_PUSH_CALL_TIMEOUT_MS });
      try { ensureAudioCtx(); } catch (e) {}
      playRingtone();
      if (signaling && signaling.connected) scheduleAutoConnect(contactId);
    } else {
      toast(T("toast.missedCall"));
    }
  } else if (focusInput) {
    // P2.37 (урезанный вариант) — клик по кнопке "Ответить" в уведомлении:
    // полноценного инлайн-ответа веб-API не даёт (см. showNotification),
    // но можно хотя бы сразу поставить курсор в поле ввода, не заставляя
    // пользователя ещё и тапать по нему самому. renderTab() выше рендерит
    // асинхронно/синхронно в зависимости от перехода — small delay, чтобы
    // #chat-input гарантированно уже был в DOM.
    setTimeout(() => { const inp = $("#chat-input"); if (inp) inp.focus(); }, 50);
  }
}
// Открытие по клику на декларативное push-уведомление (Safari/iOS): в
// этом случае notificationclick в sw.js не срабатывает вовсе — платформа
// сразу переходит по URL из поля "navigate", минуя Service Worker. Единственный
// канал передать, что именно открыть — сам URL, поэтому читаем его здесь.
function handleNotificationNavigateParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    const callId = params.get("call");
    const chatId = params.get("chat");
    if (callId) openFromNotification(callId, "call", false, { ts: params.get("ts") });
    else if (chatId) openFromNotification(chatId, "message");
    if (callId || chatId) {
      const url = new URL(window.location.href);
      url.search = "";
      window.history.replaceState({}, "", url.toString());
    }
  } catch (e) {}
}
// killer-features-backlog 0.4 — Share Target (Android "Поделиться" → Эфир).
// GET-метод, только text/url (см. manifest.webmanifest "share_target") —
// без POST/файлов, чтобы не усложнять sw.js перехватом multipart-запроса.
// Открываем список контактов (переиспользуя forward-sheet) — пользователь
// сам выбирает, кому отправить, текст подставляется в поле ввода, но НЕ
// отправляется автоматически — так его можно проверить/дополнить перед отправкой.
function handleShareTargetParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    const title = params.get("share_title") || "";
    const text = params.get("share_text") || "";
    const url = params.get("share_url") || "";
    const combined = [title, text, url].filter(Boolean).join("\n").trim();
    if (!combined) return;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = "";
    window.history.replaceState({}, "", cleanUrl.toString());
    openForwardSheet((contactId) => {
      state.contactCardId = null; state.chatId = contactId; renderTab();
      const inp = $("#chat-input");
      if (inp) { inp.value = combined; inp.dispatchEvent(new Event("input")); setTimeout(() => inp.focus(), 50); }
    }, "shareTarget.pickChat");
  } catch (e) {}
}
// killer-features-backlog 0.5 — "мягкий" Dead Man's Switch. Два независимых
// направления в одной функции, обе стороны вызывают её при каждом СВОЁМ
// открытии приложения — никакого фонового таймера нет и не может быть
// (см. Store.deadManEnabled выше):
//  1) отправить: если я настроил наблюдение за мной (включил тумблер и
//     выбрал доверенный контакт) — шлю ему heartbeat, но не чаще раза в
//     12 часов (не на каждый перезапуск подряд).
//  2) проверить: для ЛЮБОГО контакта, от которого я когда-либо получал
//     heartbeat (значит, он когда-то настроил наблюдение, где доверенным
//     указан я), если с последнего heartbeat прошло больше заявленного
//     порога — предупреждаю один раз (не на каждый повторный запуск,
//     пока не придёт новый heartbeat или не истечёт сутки).
function checkDeadManSwitch() {
  try {
    const now = Date.now();
    if (Store.deadManEnabled && Store.deadManContactId) {
      const target = state.contacts.get(Store.deadManContactId);
      if (target && now - Store.deadManLastSentAt > 12 * 60 * 60 * 1000) {
        Store.deadManLastSentAt = now;
        trySendOrQueue(target, crypto.randomUUID(), { kind: "heartbeat", ts: now, thresholdDays: Store.deadManThresholdDays }).catch(() => {});
      }
    }
    for (const c of state.contacts.values()) {
      if (!c.lastHeartbeatAt || !c.heartbeatThresholdDays) continue;
      const staleMs = c.heartbeatThresholdDays * 24 * 60 * 60 * 1000;
      if (now - c.lastHeartbeatAt <= staleMs) continue;
      if (c.heartbeatAlertedAt && now - c.heartbeatAlertedAt < 24 * 60 * 60 * 1000) continue; // уже предупреждали за последние сутки
      c.heartbeatAlertedAt = now;
      persistContacts();
      toast(T("toast.deadManAlert", { name: c.name || T("sys.someone"), days: c.heartbeatThresholdDays }));
    }
  } catch (e) {}
}

function wireServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.register("./sw.js").then((reg) => {
    swRegistration = reg;
    setTimeout(() => { ensurePushSubscription().catch(() => {}); }, 1000);
    watchForWaitingSW(reg);
  }).catch(() => {});

  // Проверка обновлений при возврате в приложение и раз в 30 минут.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && swRegistration) {
      swRegistration.update().catch(() => {});
    }
  });
  setInterval(() => {
    if (swRegistration) swRegistration.update().catch(() => {});
  }, 30 * 60 * 1000);

  // Раз в час проверяем, не истекла ли push-подписка. На iOS подписка
  // иногда «протухает» после долгого неиспользования — тогда Web Push
  // перестаёт работать без единого сигнала пользователю. Признак —
  // expirationTime в подписке.
  setInterval(() => {
    if (!Store.pushSubscriptionJson) return;
    try {
      const sub = JSON.parse(Store.pushSubscriptionJson);
      if (sub.expirationTime && sub.expirationTime < Date.now() + 24 * 3600 * 1000) { // expirationTime — уже миллисекунды
        ensurePushSubscription().catch(() => {});
      }
    } catch (e) {}
  }, 60 * 60 * 1000);

  navigator.serviceWorker.addEventListener("message", (ev) => {
    const data = ev.data || {};
    if (data.type === "open-contact" && data.contactId) {
      openFromNotification(data.contactId, data.kind, data.focusInput, { ts: data.ts });
    }
    if (data.type === "mark-read" && data.contactId) {
      const c = state.contacts.get(data.contactId);
      if (c) {
        markThreadRead(c);
        if (state.tab === "chats" && state.chatsSegment === "chats" && !state.chatId) renderChatsList();
        if (state.chatId === data.contactId) renderChatThreadInner();
      }
    }
    if (data.type === "push-subscription-changed") {
      ensurePushSubscription().catch(() => {});
    }
  });

  // Когда новый SW активировался после SKIP_WAITING — перезагружаем
  // страницу, чтобы весь UI подхватил новые ресурсы. sessionStorage
  // защищает от петли перезагрузок.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    __blockedSyncKey = ""; try { syncBlockedToSW(); } catch (e) {} // новый SW не знает список заблокированных — отправляем заново
    if (sessionStorage.getItem("ether.reloadingForUpdate")) return;
    sessionStorage.setItem("ether.reloadingForUpdate", "1");
    location.reload();
  });
}

// Подписка на события конкретной регистрации: либо SW уже waiting
// (пользователь вернулся, когда обновление скачалось в прошлой сессии),
// либо ещё в процессе install — ждём statechange.
// Автоприменение обновления: баннер можно отложить, но «вечно сидеть на старом JS» нельзя. Если новый SW ждёт дольше UPDATE_AUTO_AFTER_MS
// и приложение скрыто (свёрнуто/в другой вкладке), нет звонка и нет недописанного текста — активируем его сами (страница перезагрузится незаметно).
const UPDATE_AUTO_AFTER_MS = 10 * 60 * 1000;
function shouldAutoApplyUpdate(o) {
  return !!(o && o.waitingSince && o.now - o.waitingSince >= UPDATE_AUTO_AFTER_MS && o.hidden && !o.inCall && !o.hasDraft);
}
let __swWaitingSince = 0;
function swHasUnsavedInput() {
  try { const ci = document.getElementById("chat-input") || document.querySelector("textarea.chat-input, #composer-input"); return !!(ci && String(ci.value || "").trim()); } catch (e) { return false; }
}
function maybeAutoApplyUpdate(reg) {
  try {
    if (!reg || !reg.waiting) return false;
    if (!shouldAutoApplyUpdate({ waitingSince: __swWaitingSince, now: Date.now(), hidden: document.visibilityState === "hidden", inCall: !!state.callId, hasDraft: swHasUnsavedInput() })) return false;
    reg.waiting.postMessage({ type: "SKIP_WAITING" });
    return true;
  } catch (e) { return false; }
}
function noteWaitingSW(reg) {
  if (!__swWaitingSince) __swWaitingSince = Date.now();
  showUpdateBanner(reg);
  if (!noteWaitingSW._wired) {
    noteWaitingSW._wired = true;
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") maybeAutoApplyUpdate(reg); });
    setInterval(() => maybeAutoApplyUpdate(reg), 5 * 60 * 1000);
  }
}
function watchForWaitingSW(reg) {
  if (reg.waiting) { noteWaitingSW(reg); return; }
  reg.addEventListener("updatefound", () => {
    const newSW = reg.installing;
    if (!newSW) return;
    newSW.addEventListener("statechange", () => {
      if (newSW.state === "installed" && navigator.serviceWorker.controller) {
        noteWaitingSW(reg);
      }
    });
  });
}

// Баннер «Доступно обновление». Кнопка «Обновить» шлёт waiting-SW
// сообщение SKIP_WAITING — он активируется, сработает controllerchange,
// страница перезагрузится. Кнопка «Позже» скрывает баннер на час
// (sessionStorage — не localStorage: закрыл вкладку — и следующая сессия
// снова покажет).
function showUpdateBanner(reg) {
  if (document.getElementById("update-banner")) return;
  try {
    const dismissedAt = parseInt(sessionStorage.getItem("ether.updateDismissedAt") || "0", 10);
    if (dismissedAt && Date.now() - dismissedAt < 60 * 60 * 1000) return;
  } catch (e) {}
  // Снимаем флаг "reloading" при каждом показе баннера. Без этого после
  // первого обновления (клик "Обновить" → SW активировался →
  // controllerchange → reload) флаг оставался "1" в sessionStorage до
  // конца сессии, и при следующем баннере controllerchange видел
  // залипший флаг и делал return — reload не происходил. Именно поэтому
  // кнопка "Нажать, чтобы получить новую версию" срабатывала только со
  // второго раза (второй клик шёл по ветке else — reg.waiting уже был
  // null после первого клика — и перезагружал напрямую).
  try { sessionStorage.removeItem("ether.reloadingForUpdate"); } catch (e) {}

  const el = document.createElement("div");
  el.id = "update-banner";
  el.className = "notif-banner glass-content";
  el.innerHTML = `
    <div class="notif-banner-text">
      <strong>${escapeHtml(T("update.available.title"))}</strong>
      <span>${escapeHtml(T("update.available.text"))}</span>
    </div>
    <button type="button" class="btn-primary notif-banner-btn" data-act="reload">${escapeHtml(T("update.reload"))}</button>
    <button type="button" class="icon-btn small" data-act="dismiss" aria-label="${escapeHtml(T("sys.close"))}">
      ${Icons.html("x", 18)}
    </button>`;
  document.body.appendChild(el);

  el.querySelector('[data-act="reload"]').addEventListener("click", () => {
    if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
    else location.reload();
  });
  el.querySelector('[data-act="dismiss"]').addEventListener("click", () => {
    el.remove();
    try { sessionStorage.setItem("ether.updateDismissedAt", String(Date.now())); } catch (e) {}
  });
}

// =====================================================================
// Web Push
// =====================================================================
async function ensurePushSubscription() {
  if (!Store.notificationsEnabled) return null;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  if (!Store.vapidPublicKey) return null;
  let reg;
  try { reg = await navigator.serviceWorker.ready; }
  catch (e) { return null; }
  let sub = null;
  try { sub = await reg.pushManager.getSubscription(); }
  catch (e) { sub = null; }
  // Подписка вот-вот истечёт — отписываемся и создаём новую (иначе getSubscription вернул бы ту же самую и обновления не произошло бы)
  if (sub && sub.expirationTime && sub.expirationTime < Date.now() + 24 * 3600 * 1000) { try { await sub.unsubscribe(); } catch (e) {} sub = null; }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(Store.vapidPublicKey),
      });
    } catch (e) { etherLog("warn", "[push] subscribe failed:", String(e)); return null; }
  }
  const subJson = sub.toJSON ? sub.toJSON() : sub;
  Store.pushSubscriptionJson = JSON.stringify(subJson);
  if (signaling && signaling.connected) signaling.sendPushSubscription(subJson);
  return sub;
}
function showNotification(title, body, opts) {
  opts = opts || {};
  if (!Store.notificationsEnabled) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && !opts.force) return;
  // P1.17 — скрывает ТЕКСТ сообщения в уведомлении (экран блокировки
  // виден кому угодно), но не имя контакта: иначе непонятно, кто вообще
  // написал. Звонки не трогаем — там body уже не содержит произвольного
  // пользовательского текста.
  if (Store.hideNotifContent && opts.kind !== "call") {
    body = T("notif.newMessage");
  }
  const payload = {
    type: "show-notification", title, body,
    tag: opts.tag || "ether",
    contactId: opts.contactId || null,
    kind: opts.kind || "message",
    // Per-contact "только вибрация" (opts.forceSilent) перебивает общий
    // звуковой тоггл — специфичнее настройка должна выигрывать у общей.
    silent: opts.forceSilent || !Store.soundsEnabled || (opts.kind !== "call" && quietNow()),
  };
  // P2.37 (урезанный вариант) — настоящего инлайн-ответа (текстовое поле
  // прямо в уведомлении) в вебе не существует — это нативный API
  // (Android RemoteInput и т.п.), у Notification API есть только
  // кнопки-действия. Поэтому кнопка "Ответить" не отправляет текст сама,
  // а открывает чат уже с фокусом в поле ввода (см. notificationclick в
  // sw.js и openFromNotification(..., focusInput) в app.js) — на один тап
  // ближе к ответу, чем просто разворачивание уведомления.
  if (payload.kind !== "call" && payload.contactId) {
    // Notification.actions ограничены 2 видимыми кнопками на большинстве
    // платформ (см. комментарий у showNotification в sw.js) — "Ответить"
    // уже занимает одну, вторая — "Прочитано" (переиспользуем T("ack.read"),
    // он уже переведён на все 72 языка, отдельный ключ не нужен).
    payload.actions = [
      { action: "reply", title: T("notif.action.reply") },
      { action: "mark-read", title: T("ack.read") },
    ];
  }
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(payload); return;
  }
  if (swRegistration && swRegistration.active) {
    swRegistration.active.postMessage(payload); return;
  }
  try { new Notification(title, { body, tag: payload.tag }); } catch (e) {}
}
function wireNotificationPermission() {
  const el = $("#settings-notifications");
  if (!el) return;
  el.addEventListener("change", async (e) => {
    if (e.target.checked) {
      if (!("Notification" in window)) { toast("!"); e.target.checked = false; return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("!"); e.target.checked = false; return; }
      Store.notificationsEnabled = true;
      ensurePushSubscription().catch(() => {});
      toast(T("toast.notificationsOn"));
      updateNotifBanner();
    } else {
      Store.notificationsEnabled = false;
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch (e) {}
      Store.pushSubscriptionJson = "";
      if (signaling && signaling.connected) signaling.sendPushUnsubscribe();
      // Пользователь осознанно выключил уведомления через настройки — баннер
      // "включите уведомления" не должен тут же всплыть снова с призывом
      // включить то, что он только что сам выключил.
      Store.notifBannerDismissed = true;
      updateNotifBanner();
      toast(T("toast.notificationsOff"));
    }
  });
}
function wireNotifBanner() {
  const enableBtn = $("#notif-enable-btn");
  const dismissBtn = $("#notif-dismiss-btn");
  if (enableBtn) enableBtn.addEventListener("click", async () => {
    if (!("Notification" in window)) { toast("!"); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("!"); return; }
    Store.notificationsEnabled = true;
    const cb = $("#settings-notifications"); if (cb) cb.checked = true;
    ensurePushSubscription().catch(() => {});
    toast(T("toast.notificationsOn"));
    updateNotifBanner();
  });
  if (dismissBtn) dismissBtn.addEventListener("click", () => {
    Store.notifBannerDismissed = true;
    updateNotifBanner();
  });
}
function updateNotifBanner() {
  const banner = $("#notif-banner");
  if (!banner) return;
  const supported = ("Notification" in window) && ("serviceWorker" in navigator) && ("PushManager" in window);
  const granted = supported && Notification.permission === "granted";
  const enabled = Store.notificationsEnabled && granted;
  const dismissed = Store.notifBannerDismissed;
  if (!supported || enabled || dismissed) { banner.classList.add("hidden"); return; }
  banner.classList.remove("hidden");
  // #lang-offer — фиксированный оверлей ВНЕ #app-shell (см. комментарий
  // в CSS), показывается тем же вызовом startApp(), что и этот баннер,
  // для уже зарегистрированного пользователя с системным языком,
  // отличным от сохранённого. Оба претендуют на верх экрана —
  // #notif-banner в обычном потоке документа оказывался ПОД фиксированным
  // #lang-offer, физически перекрытым им. Сдвигаем баннер ниже, пока
  // предложение смены языка не закрыто.
  const langOffer = $("#lang-offer");
  const langOfferVisible = langOffer && !langOffer.classList.contains("hidden");
  banner.style.marginTop = langOfferVisible ? "96px" : "";
}
function updateAppBadge() {
  let total = 0;
  for (const c of state.contacts.values()) { if (c.isSelf) continue; total += unreadCount(c); }
  const tabBadge = $("#tab-chats-badge");
  if (tabBadge) {
    if (total > 0) { tabBadge.textContent = total > 99 ? "99+" : String(total); tabBadge.classList.remove("hidden"); }
    else tabBadge.classList.add("hidden");
  }
  try {
    if (!("setAppBadge" in navigator)) return;
    if (total > 0) navigator.setAppBadge(total);
    else if ("clearAppBadge" in navigator) navigator.clearAppBadge();
  } catch (e) {}
}
// Пропущенные звонки нигде не бейджались, в отличие от чатов — по
// аналогии с другими мессенджерами: непросмотренные пропущенные
// (rec.seen === false) считаем и показываем на вкладке "Звонки".
function updateCallsBadge() {
  const missed = state.callLog.filter((r) => r.status === "missed" && !r.seen).length;
  // Раньше был один #tab-calls-badge на отдельной вкладке. Теперь два
  // индикатора: число на кнопке сегмента "Звонки" (видна, только когда
  // открыта вкладка Chats) и маленькая точка на иконке самой вкладки
  // Chats внизу — чтобы пропущенный звонок был заметен, даже если
  // пользователь сейчас смотрит сегмент "Чаты" или другую вкладку.
  const segBadge = $("#chats-segment-calls-badge");
  if (segBadge) {
    if (missed > 0) { segBadge.textContent = missed > 99 ? "99+" : String(missed); segBadge.classList.remove("hidden"); }
    else segBadge.classList.add("hidden");
  }
  const dot = $("#tab-chats-missed-dot");
  if (dot) dot.classList.toggle("hidden", missed === 0);
}
function markMissedCallsSeen() {
  let changed = false;
  for (const r of state.callLog) if (r.status === "missed" && !r.seen) { r.seen = true; changed = true; }
  if (changed) { persistCallLog(); updateCallsBadge(); }
}

