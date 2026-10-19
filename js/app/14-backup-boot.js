"use strict";
// Часть 14 из 14 бывшего js/app.js: Экспорт/импорт, mesh-события, форма чата, boot-recovery. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Экспорт/импорт
// =====================================================================
function buildFullDiagnosticsText() {
  const sections = [
    ["=== " + T("debug.diagnostics") + " ===", buildDiagnosticsText()],
    ["=== " + T("debug.webrtc") + " ===", buildWebRtcText()],
    ["=== " + T("debug.storage") + " ===", buildStorageText()],
    ["=== " + T("debug.eventLog") + " ===", buildLogsText()],
  ];
  return sections.map(([title, body]) => title + "\n" + body).join("\n\n");
}
function exportFullDiagnostics() {
  const blob = new Blob([buildFullDiagnosticsText()], { type: "text/plain" });
  downloadBlob(blob, `ether-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`);
  toast(T("toast.diagnosticsSaved"));
}
// === Шифрование бэкапа паролем (раздел 2 роадмапа) ===
// PBKDF2(пароль, случайная соль) → AES-GCM 256 ключ, тот же envelope-формат
// {iv, ct, v}, что и CryptoHelper.encryptJson/decryptJson используют для
// ECDH-ключей — AES-GCM не знает и не обязан знать, откуда взялся ключ.
// Забытый пароль делает бэкап безвозвратно нечитаемым — это осознанное
// свойство (без него "шифрование" было бы фикцией с чёрным ходом), а не
// баг, но его необходимо явно объяснять на экране экспорта (см. i18n-ключ
// backup.password.exportHint) — отдельная УХ-задача, помимо собственно
// шифрования, которую сам отчёт выделял как главный риск этого пункта.
const BACKUP_PBKDF2_ITERATIONS = 210000;
const BACKUP_ENCRYPTED_MARKER = "etherEncryptedBackup"; // без точки после "ether" — не пересекается с ключами localStorage вида "ether.xxx"
async function deriveBackupKey(password, saltBytes) {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: BACKUP_PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
// Промис-обёртка вокруг шторки #backup-password-sheet: resolve(password)
// при подтверждении с непустым паролем, resolve(null) при "Без пароля"
// (режим export) или любом способе закрыть шторку не дав пароль (backdrop,
// Esc через общий wireEscCloseAnySheet — ни один из них не знает про этот
// промис, поэтому settle() в wireBackupPasswordSheet подписан через
// MutationObserver на сам факт появления класса .hidden, а не только на
// свои кнопки — иначе промис мог бы повиснуть навечно).
let __backupPasswordResolve = null;
function openBackupPasswordSheet(mode) {
  return new Promise((resolve) => {
    const sheet = $("#backup-password-sheet");
    if (!sheet) { resolve(null); return; }
    __backupPasswordResolve = resolve;
    const title = $("#backup-password-title");
    const hint = $("#backup-password-hint");
    const input = $("#backup-password-input");
    const skipBtn = $("#backup-password-skip");
    if (input) input.value = "";
    const titleKey = mode === "import" ? "backup.password.importTitle" : "backup.password.exportTitle";
    const hintKey = mode === "import" ? "backup.password.importHint" : "backup.password.exportHint";
    if (title) { title.setAttribute("data-i18n", titleKey); title.textContent = T(titleKey); }
    if (hint) { hint.setAttribute("data-i18n", hintKey); hint.textContent = T(hintKey); }
    // При импорте пароль обязателен (иначе нечего расшифровывать) —
    // кнопки "Без пароля" на этом шаге просто нет смысла показывать.
    if (skipBtn) skipBtn.classList.toggle("hidden", mode === "import");
    sheet.classList.remove("hidden");
    if (input) setTimeout(() => input.focus(), 50);
  });
}
let __backupPasswordSheetWired = false;
function wireBackupPasswordSheet() {
  if (__backupPasswordSheetWired) return;
  __backupPasswordSheetWired = true;
  const sheet = $("#backup-password-sheet"); if (!sheet) return;
  const input = $("#backup-password-input");
  const confirmBtn = $("#backup-password-confirm");
  const skipBtn = $("#backup-password-skip");
  const settle = (value) => {
    const resolve = __backupPasswordResolve;
    if (!resolve) return; // уже резолвлено (или шторка открылась не через openBackupPasswordSheet)
    __backupPasswordResolve = null;
    sheet.classList.add("hidden");
    resolve(value);
  };
  if (confirmBtn) confirmBtn.addEventListener("click", () => settle((input && input.value) || null));
  if (skipBtn) skipBtn.addEventListener("click", () => settle(null));
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (confirmBtn) confirmBtn.click(); } });
  // Закрытие шторки ЛЮБЫМ другим путём (backdrop-клик через общий
  // wireSheetBackdrops, Esc через wireEscCloseAnySheet) — эти обработчики
  // просто навешивают .hidden и ничего не знают про наш промис.
  // MutationObserver перехватывает сам факт появления .hidden и
  // резолвит оставшийся промис как "отмена" (null), не оставляя его
  // висеть навечно, даже если settle() выше не был вызван напрямую.
  // undefined = отмена (закрыли шторку), null = осознанное «Без пароля»: при экспорте их нельзя путать, иначе Esc скачивал бы открытую копию
  new MutationObserver(() => {
    if (sheet.classList.contains("hidden")) settle(undefined);
  }).observe(sheet, { attributes: true, attributeFilter: ["class"] });
}
// Воркер — singleton, создаётся лениво при первом реальном экспорте/
// импорте бэкапа (не на старте приложения, это не нужно почти никому
// каждый сеанс). Если конструктор Worker бросил исключение (очень
// старый браузер, ограничение окружения) — getCryptoWorker() вернёт
// null один раз и дальше вызывающий код просто считает на основном
// потоке, как было до этой версии; никакой деградации корректности.
let __cryptoWorker = null;
let __cryptoWorkerFailed = false;
let __cryptoWorkerReqId = 0;
const __cryptoWorkerPending = new Map();
function getCryptoWorker() {
  if (__cryptoWorkerFailed) return null;
  if (__cryptoWorker) return __cryptoWorker;
  try {
    __cryptoWorker = new Worker("js/crypto-worker.js");
    __cryptoWorker.onmessage = (ev) => {
      const { reqId, ok, envelope, data, error } = ev.data || {};
      const pending = __cryptoWorkerPending.get(reqId);
      if (!pending) return;
      __cryptoWorkerPending.delete(reqId);
      if (ok) pending.resolve({ envelope, data }); else pending.reject(new Error(error || "crypto worker error"));
    };
    __cryptoWorker.onerror = () => {
      // Воркер упал целиком (не отдельный запрос, а сам поток) —
      // отклоняем всё, что всё ещё ждёт ответа, и больше не пытаемся
      // создать новый: дальнейшие вызовы сразу идут на основной поток.
      for (const [, pending] of __cryptoWorkerPending) pending.reject(new Error("crypto worker crashed"));
      __cryptoWorkerPending.clear();
      __cryptoWorkerFailed = true;
      __cryptoWorker = null;
    };
  } catch (e) { __cryptoWorkerFailed = true; return null; }
  return __cryptoWorker;
}
function runInCryptoWorker(action, msg) {
  const worker = getCryptoWorker();
  if (!worker) return Promise.reject(new Error("crypto worker unavailable"));
  const reqId = ++__cryptoWorkerReqId;
  return new Promise((resolve, reject) => {
    __cryptoWorkerPending.set(reqId, { resolve, reject });
    worker.postMessage(Object.assign({ reqId, action }, msg));
  });
}
// encrypt у бэкапа не имеет понятия "неверный пароль" (пароль здесь
// просто вход для KDF, не проверка) — поэтому любую ошибку воркера тут
// безопасно считать поводом пересчитать на основном потоке, без риска
// замаскировать настоящую семантическую ошибку.
async function encryptBackupPayload(password, salt, data) {
  try {
    const res = await runInCryptoWorker("encrypt", { password, salt, data });
    return res.envelope;
  } catch (e) {
    const key = await deriveBackupKey(password, salt);
    return CryptoHelper.encryptJson(key, data);
  }
}
// decrypt — наоборот, ошибка воркера МОЖЕТ означать "неверный пароль"
// (AES-GCM не прошёл проверку подлинности). Пересчёт на основном потоке
// в этом случае просто повторит ту же ошибку (цена — одна лишняя
// PBKDF2 на 210000 итераций в редком случае опечатки в пароле, не в
// горячем пути), но зато единообразен с encryptBackupPayload и не
// пытается угадывать причину ошибки по тексту сообщения.
async function decryptBackupPayload(password, salt, envelope) {
  try {
    const res = await runInCryptoWorker("decrypt", { password, salt, envelope });
    return res.data;
  } catch (e) {
    const key = await deriveBackupKey(password, salt);
    return CryptoHelper.decryptJson(key, envelope);
  }
}
async function exportBackup() {
  persistContactsNow(); // гарантируем, что дебаунс-таймер не "съест" последние изменения
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("ether.")) data[k] = localStorage.getItem(k);
  }
  let payload = data;
  let password = null;
  try { password = await openBackupPasswordSheet("export"); } catch (e) {}
  if (password === undefined) return; // шторку закрыли — экспорт отменён
  if (password) {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const envelope = await encryptBackupPayload(password, salt, data);
      payload = { [BACKUP_ENCRYPTED_MARKER]: true, kdf: "PBKDF2", iterations: BACKUP_PBKDF2_ITERATIONS, salt: arrayBufferToBase64(salt), envelope };
    } catch (e) {
      etherLog("error", "[backup] encryption failed, export aborted:", String(e));
      toast(T("toast.backupEncryptFailed")); // не отдаём открытый бэкап с приватным ключом, когда просили зашифрованный
      return;
    }
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(blob, `ether-backup-${new Date().toISOString().slice(0, 10)}.json`);
  toast(T("toast.backupSaved") + (typeof Devices !== "undefined" && Devices.isCompanion() ? " " + T("devices.backupCopy") : ""));
}
async function importBackup(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  await importBackupFile(file);
}
// Вынесено из importBackup() отдельно: drag-and-drop файла бэкапа прямо
// на карточку онбординга (см. wireOnboardingOnce) даёт File через
// DataTransfer, а не через <input type="file">, так что общая логика
// не может зависеть от ev.target.
async function importBackupFile(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("bad");
    let data = parsed;
    if (parsed[BACKUP_ENCRYPTED_MARKER]) {
      const password = await openBackupPasswordSheet("import");
      if (!password) return; // пользователь закрыл шторку без пароля — тихо отменяем импорт, а не падаем с ошибкой
      try {
        const salt = base64ToUint8Array(parsed.salt);
        data = await decryptBackupPayload(password, salt, parsed.envelope);
      } catch (e) {
        toast(T("toast.wrongBackupPassword"));
        return;
      }
    }
    if (!data || typeof data !== "object") throw new Error("bad");
    // Файл без единого ключа ether.* — не бэкап; без этой проверки импорт
    // стёр бы все локальные данные и ничего не восстановил.
    if (!Object.keys(data).some((k) => k.startsWith("ether.") && typeof data[k] === "string")) throw new Error("bad");
    if (!await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) return;
    await applyImportedData(data);
  } catch (e) { toast(String(e.message)); }
}
// Применение набора ether.* (резервная копия или пакет переезда с другого устройства, js/devicelink.js): заменяет локальные данные и перезагружает.
async function applyImportedData(data) {
  // Отменяем (не сбрасываем!) любой "летящий" дебаунс-таймер
  // persistContacts() — он держит СТАРЫЙ снимок контактов (ещё с ДО
  // импорта) и, сработав в течение 800мс до reload ниже, переписал бы
  // поверх только что импортированных данных это старьё.
  if (__contactsPersistTimer) { clearTimeout(__contactsPersistTimer); __contactsPersistTimer = null; }
  __contactsPersistPending = null;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith("ether.")) localStorage.removeItem(k);
  }
  for (const k of Object.keys(data)) if (k.startsWith("ether.") && typeof data[k] === "string") localStorage.setItem(k, data[k]);
  // Резервная копия в IndexedDB — от прежнего профиля: пересоздаём её из импортированных данных, иначе при загрузке старые значения
  // отсутствующих в файле ключей (PIN, аватар, контакты) вернулись бы поверх импорта. И никакого сохранения «из памяти» при перезагрузке.
  __wiping = false;
  try { await Promise.all(CRITICAL_LS_KEYS.map((k) => IDB.del(k))); await backupToIDB(); } catch (e) {}
  __wiping = true;
  toast(T("toast.imported"));
  location.reload();
}

// =====================================================================
// Mesh события
// =====================================================================
function wireMeshEvents() {
  if (typeof gcallWire === "function") gcallWire();
  if (typeof roomWire === "function") roomWire();
  if (typeof wireLocalAi === "function") wireLocalAi();
  // Показ экрана прервали через системный UI браузера, а не через нашу
  // кнопку (см. PeerLink.startScreenShare/screenTrack.onended в webrtc.js)
  // — синхронизируем кнопку обратно в неактивное состояние.
  mesh.addEventListener("screen-share-ended", (ev) => {
    if (ev.detail && ev.detail.id === state.callId) {
      const btn = $("#call-screenshare-btn"); if (btn) btn.classList.remove("active");
      { const cs0 = $("#call-screen"); if (cs0) cs0.classList.remove("sharing"); updateCallButtonsSupport(); }
    }
  });
  mesh.addEventListener("relay-fallback", (ev) => {
    const rid = ev.detail.id;
    setTimeout(() => {
      const l = mesh.get(rid);
      if (l && (l.status === "connected" || l.status === "in-call")) return;
      attemptConnect(rid, true).catch(() => {});
    }, 400);
  });
  mesh.addEventListener("link-dc-open", (ev) => { try { startLinkAuth(ev.detail.id); } catch (e) { etherLog("warn", "[auth] старт проверки:", String(e)); } });
  mesh.addEventListener("link-caps", (ev) => {
    const c = state.contacts.get(ev.detail.id);
    if (c && ev.detail.rc) markContactRatchet(c);
    if (c && ev.detail.e2) markContactEnv2(c);
  });
  mesh.addEventListener("link-status", (ev) => {
    try {
      const { id, status } = ev.detail;
      const c = state.contacts.get(id); if (!c) return;
      const wasConnected = c.status === "connected" || c.status === "in-call";
      c.status = status;
      etherLog("info", "[link] " + String(id).slice(0, 10) + "…", "status=" + status);
      if (status === "connected" || status === "in-call") { connectFails.delete(id); startLinkAuth(id); }
      if (status === "connected" && !wasConnected) {
        const link = mesh.get(id);
        // имя, которое пользователь задал контакту сам (переименование), перезаписывать нельзя
        if (link && link.remoteName && !c.nameLocal) c.name = String(link.remoteName).slice(0, 40);
        if (c.managed) persistContacts();
        toast(T("toast.peerOnline", { name: c.name }));
        clearAutoConnectTimer(id);
        if (state.pendingOutgoing && state.pendingOutgoing.id === id) resetConnectScreen();
        sendPrivacyPrefsTo(id);
        // Если этот контакт состоит в ОБЩЕЙ со мной группе — пересылаю
        // ему актуальный ростер при каждом переподключении. Раньше
        // ростер уходил ТОЛЬКО при явном действии в группе (добавили/
        // убрали участника) — если у НЕГО данные группы пропали
        // (переустановка приложения, своего бэкапа контактов/групп нет),
        // ничего не пересылало её заново, пока кто-то не совершит новое
        // действие. Группа просто не появлялась у вернувшегося участника.
        for (const g of state.contacts.values()) {
          if (g.isGroup && g.members.some((m) => m.id === id)) sendGroupRosterTo(g, id);
        }

        if (state.callId === id && link) {
          if (state.callPhase === "calling") {
            if (!link._audioAdded) {
              link.startCall(state.callWantsVideo).then(() => {
                if (state.callWantsVideo) { showLocalVideoPreview(link); requestWakeLock(); }
                // P2P установлен = собеседник в сети и его экран входящего
                // уже открыт. Обновляем фазу на "Гудки…" — независимо от
                // того, дошёл ли call-invite-ack через сигналинг (он мог
                // отвалиться на секунду). Раньше пользователь видел
                // "Вызов…" до явного ack'а или таймаута, даже когда
                // звонок фактически уже дозвонился.
                if (state.callId === id && state.callPhase === "calling") {
                  const p = $("#call-phase");
                  if (p) p.textContent = T("call.ringing");
                }
              }).catch((e) => etherLog("error", "[call] caller startCall failed:", String(e)));
            } else if (state.callWantsVideo && !link._videoAdded) {
              link.enableVideo().then((ok) => { if (ok) showLocalVideoPreview(link); }).catch((e) => etherLog("error", "[call] caller enableVideo failed:", String(e)));
            }
          } else if (state._callUserAccepted && state.callPhase !== "active") {
            link.answerCall(state.callWantsVideo).then(() => {
              if (state.callWantsVideo) { showLocalVideoPreview(link); requestWakeLock(); }
              if (state._callMuteOnAnswer) {
                link.setMuted(true);
                const mb = $("#call-mute-btn");
                if (mb) {
                  mb.classList.add("active");
                  const lbl = $("#call-mute-label");
                  if (lbl) lbl.textContent = T("call.mute.off");
                }
                state._callMuteOnAnswer = false;
              }
              // P2P-путь реально сработал (answerCall завершился успешно) —
              // ТОЛЬКО ТЕПЕРЬ уведомляем сигнальный сервер, что мы приняли.
              // Раньше серверный call-accepted уходил из acceptCall() ДО
              // link.answerCall: если P2P падал (микрофон запрещён,
              // getUserMedia упал, ICE не прошёл) — собеседник видел
              // "принято", хотя звонок не поднялся. Best-effort: если
              // сигналинг недоступен, не критично — P2P-путь уже работает.
              if (signaling && signaling.connected && state.callId === id) {
                try { signaling.signal(id, { t: "call-accepted" }); } catch (e) {}
              }
              setCallPhaseActive();
            }).catch((e) => etherLog("error", "[call] deferred answerCall failed:", String(e)));
          }
        }

        flushOutbox();
      }
      if (status === "disconnected") {
        sendTypingStop(id);
        if (c.managed && c.online) {
          setTimeout(() => {
            const stillGone = !mesh.get(id) || mesh.get(id).status === "disconnected";
            if (stillGone && state.contacts.get(id)) scheduleAutoConnect(id);
          }, 10000);
        }
      }
      if (state.chatId === id) renderChatThread();
      if (state.contactCardId === id) renderContactCard();
      if (state.tab === "chats" && !state.chatId) renderChatsList();
    } catch (e) {
      etherLog("error", "[link-status] handler failed:", String(e && e.stack || e));
    }
  });
  mesh.addEventListener("message", (ev) => {
    try {
      const { id, payload } = ev.detail;
      const c = state.contacts.get(id); if (!c) return;
      if (c.blocked) { if (payload && payload.kind === "call-state" && payload.state === "ringing") scheduleBlockedCallDecline(id, signaling); return; }
      { // шлюз аутентификации канала
        const lk = mesh.get(id);
        if (payload && payload.kind === "auth") { if (lk) onAuthMessage(id, lk, payload); return; }
        if (lk && c.authSeen && !lk._authStarted && lk.authGate !== "closed" && !isGroup(c)) { try { startLinkAuth(id); } catch (e) {} if (!lk._authStarted && lk.authGate !== "closed") return; } // проверка ещё не стартовала, а контакт уже проходил её: ничего не пропускаем
        if (lk && lk.authGate === "closed") return;
        if (lk && lk.authGate === "pending" && !AUTH_PASS.has(payload && payload.kind)) { if (lk._authBuf && lk._authBuf.length < 100) lk._authBuf.push(payload); return; }
      }
if (payload && typeof payload.kind === "string" && payload.kind.indexOf("fx") === 0) { if (typeof handleFxPayload === "function") handleFxPayload(id, payload); return; }
if (payload && payload.kind === "gcall") { if (typeof handleGroupCallPayload === "function") handleGroupCallPayload(id, payload); return; }
if (payload && payload.kind === "call-state") {
  // Групповой звонок идёт — входящий 1:1 получает «занято»
  if (payload.state === "ringing" && typeof gcallBusy === "function" && gcallBusy()) {
    const lb = mesh.get(id); if (lb) { try { lb.declineCall("busy"); } catch (e) {} }
    return;
  }
  // Свежесть пакета. Если сообщение старше 20 секунд — оно пришло из
  // буфера iOS (приложение спало, а собеседник звонил). Реальный
  // звонок в этот момент уже давно отбит — рингтон играть не надо.
  // Свежесть проверяем только у «ringing»: время берётся с часов СОБЕСЕДНИКА, и при расхождении часов больше 20 с остальные состояния
  // (accepted/declined/ended/screen) отбрасывались бы как «старые» — звонок не соединялся бы или не завершался. Они и так защищены state.callId === id.
  const isStale = payload.state === "ringing" && payload.ts && (Date.now() - payload.ts > 20000);

  // Второй входящий от ДРУГОГО контакта, пока первый ещё звонит, тоже должен получить «занято» (раньше молча игнорировался).
  if (payload.state === "ringing" && state.callId !== id && (state.callId || state.callPhase !== "ringing")) {
    if (isStale) {
      etherLog("info", "[call] игнорирую устаревший call-state:ringing от " + String(id).slice(0, 10) + "… (" + Math.round((Date.now() - payload.ts) / 1000) + "с назад)");
      return;
    }
    const recent = recentlyEndedCalls.get(id);
    if (recent && Date.now() - recent < RECENTLY_ENDED_CALL_MS) {
      etherLog("info", "[call] игнорирую повторный ringing после недавнего отбоя");
      return;
    }
    if (state.callId) {
      const l = mesh.get(id);
      if (l) { try { l.declineCall("busy"); } catch (e) {} }
      return;
    }
    state.callWantsVideo = !!payload.video;
    openCallScreen(id, "ringing");
    try { ensureAudioCtx(); } catch (e) {}
    playRingtone();
  }
  if (payload.state === "ringing" && !isStale && callGlareYields(id)) yieldCallGlare(id, !!payload.video);
  if (payload.state === "screen" && state.callId === id && !isStale) {
    const cs1 = $("#call-screen"); if (cs1) cs1.classList.toggle("remote-screen", !!payload.on);
  }
  if (payload.state === "accepted" && state.callId === id && !isStale) setCallPhaseActive();
  if (payload.state === "declined" && state.callId === id && !isStale) {
    toast(T("calls.declined"));
    if (payload.reason === "busy") playBusySound(); else playNoAnswerSound();
    const link = mesh.get(id); if (link) link.endCall();
    closeCallScreen("declined");
  }
  if (payload.state === "ended" && state.callId === id && !isStale) {
    try { const l = mesh.get(id); if (l) l.endCall(); } catch (e) {}
    closeCallScreen("completed");
  }
  return;
}
      if (payload && payload.kind && String(payload.kind).indexOf("relay-") === 0) {
        handleRelayPayload(id, payload);
        return;
      }
      if (payload && payload.kind && String(payload.kind).indexOf("file-") === 0) {
        handleFilePayload(id, payload);
        return;
      }
      applyIncomingPayload(id, payload && payload.id, payload, false, payload && payload.kind);
      if (payload && payload.kind === "chat") sendAckBatch(id, [payload.id], "delivered");
    } catch (e) {
      etherLog("error", "[message] handler failed:", String(e && e.stack || e));
    }
  });
  mesh.addEventListener("remote-track", (ev) => {
    try {
      const { id, stream, track } = ev.detail;
      // Раньше это условие проверяло ТОЛЬКО "callId===id && не active" и
      // буферизовало поток — но если callId вообще не совпадает с id (мы
      // не в звонке с этим контактом, например, собеседник не отреагировал
      // на call-busy и всё равно продолжил слать медиа), код проваливался
      // прямо в attachRemoteAudio без проверки. attachRemoteVideo сам
      // внутри себя проверяет state.callId !== id — attachRemoteAudio такой
      // защиты не имеет, поэтому тут нужна она явно, симметрично.
      if (state.callId !== id) return;
      if (state.callPhase !== "active") { pendingRemoteStreams.set(id, stream); return; }
      attachRemoteAudio(id, stream);
      if (track && track.kind === "video") attachRemoteVideo(id, stream);
    } catch (e) {
      etherLog("error", "[remote-track] handler failed:", String(e && e.stack || e));
    }
  });
  mesh.addEventListener("ice-candidate", (ev) => {
    // Trickle ICE — отправляем КАЖДЫЙ собранный кандидат собеседнику
    // отдельным сигналом. До этой правки это событие никто не слушал:
    // кандидаты накапливались в _iceCandidates (только для диагностики),
    // а собеседник узнавал о них лишь из SDP — поэтому и приходилось
    // ждать полного gather ДО отправки offer/answer (см. webrtc.js).
    const { id, candidate } = ev.detail;
    if (!candidate) return;
    if (!signaling || !signaling.connected) return;
    try {
      const json = candidate.toJSON ? candidate.toJSON() : candidate;
      signaling.signal(id, { t: "ice", candidate: json });
    } catch (e) {}
  });
}

// =====================================================================
// Форма чата
// =====================================================================
function wireChatScreen() {
  if (__chatWired) return;
  __chatWired = true;
  const form = $("#chat-form");
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input"); if (!input) return;
    const text = input.value.trim();
    if (!text || !state.chatId) return;
    if (state.editingMessageId) {
      commitEdit(state.chatId, state.editingMessageId, text);
      cancelEditing();
      // Черновик (если был) всё это время не трогался — восстанавливаем
      // его в поле, а не стираем: пользователь редактировал ЧУЖОЕ
      // сообщение, а не своё недописанное.
      const savedDraft = state.drafts[state.chatId];
      input.value = savedDraft || "";
      updateSendVsMic();
      return;
    }
    const cc = state.contacts.get(state.chatId);
    if (isGroup(cc)) sendGroupMessage(state.chatId, text, state.replyTo);
    else sendChatMessage(state.chatId, text, state.replyTo);
    cancelReply();
    input.value = "";
    delete state.drafts[state.chatId];
    persistDrafts();
    sendTypingStop(state.chatId);
    updateSendVsMic();
  });
const attachBtn = $("#chat-attach-btn");
const fileInput = $("#chat-file-input");
if (attachBtn && fileInput) {
  attachBtn.addEventListener("click", () => {
    if (!state.chatId) return;
    fileInput.value = "";
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    handlePickedFiles(files);
    fileInput.value = "";
  });
}
const cameraInput = $("#chat-camera-input");
if (cameraInput) {
  cameraInput.addEventListener("change", () => {
    const files = Array.from(cameraInput.files || []);
    cameraInput.value = "";
    // Снимок с СИСТЕМНОЙ камеры (capture="environment") — пользователь
    // уже подтвердил кадр в самой камере (отдельный экран с галочкой/
    // пересъёмкой — это UI ОС, не наш). Прогонять его ещё и через
    // handlePickedFiles → openMediaComposeSheet значит показать ВТОРОЙ
    // экран подтверждения с полем подписи поверх уже принятого решения —
    // раздражающее двойное подтверждение. Поэтому снимок уходит сразу,
    // в отличие от обычного выбора файлов (#chat-file-input), где
    // openMediaComposeSheet — первое и единственное подтверждение.
    if (!files.length || !state.chatId) return;
    sendFileMessage(state.chatId, files[0]);
  });
}
  const input = $("#chat-input");
  if (input) {
    let typingSendTimer = null;
    updateSendVsMic();
    input.addEventListener("input", () => {
      updateSendVsMic();
      if (!state.chatId) return;
      if (state.editingMessageId) return; // не затираем черновик текстом редактируемого сообщения
      const v = input.value.trim();
      if (v) state.drafts[state.chatId] = v; else delete state.drafts[state.chatId];
      scheduleDraftPersist();
      sendTypingStart(state.chatId);
      clearTimeout(typingSendTimer);
      typingSendTimer = setTimeout(() => sendTypingStop(state.chatId), TYPING_DEBOUNCE_MS);
      updateMentionAutocomplete();
    });
    input.addEventListener("blur", () => { if (state.chatId) sendTypingStop(state.chatId); closeMentionAutocomplete(); });
    input.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeMentionAutocomplete(); });
  }
  wireMentionAutocomplete();
  wireRichSheets();
  wireThreadSheet();
  wireStories();
  { const cb = $("#calls-empty-btn"); if (cb) cb.addEventListener("click", () => { state.tab = "connect"; state.chatId = null; renderTab(); }); }
  { const sb = $("#contacts-empty-scan"); if (sb) sb.addEventListener("click", () => { const b = $("#scan-qr-btn"); if (b) b.click(); }); }
  { const ib = $("#contacts-empty-invite"); if (ib) ib.addEventListener("click", () => { const t = $("#add-contact-card"); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" }); }); }
  const micBtn = $("#voice-record-btn");
  if (micBtn) micBtn.addEventListener("click", () => { startVoiceRecording(); });
  const voiceCancelBtn = $("#voice-cancel-btn");
  if (voiceCancelBtn) voiceCancelBtn.addEventListener("click", () => stopVoiceRecording(false));
  const voicePauseBtn = $("#voice-pause-btn");
  if (voicePauseBtn) voicePauseBtn.addEventListener("click", toggleVoiceRecordingPause);
  const voiceSendBtn = $("#voice-send-btn");
  if (voiceSendBtn) voiceSendBtn.addEventListener("click", () => stopVoiceRecording(true));
  const callBtn = $("#chat-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => {
    if (!state.chatId) return;
    beginCall(state.chatId);
  });
  const videoCallBtn = $("#chat-video-call-btn");
  if (videoCallBtn) videoCallBtn.addEventListener("click", () => {
    if (!state.chatId) return;
    beginCall(state.chatId, true);
  });
  const retryAllBtn = $("#chat-retry-all-btn");
  if (retryAllBtn) retryAllBtn.addEventListener("click", () => {
    const id = state.chatId; if (!id) return;
    retryAllFailed(id).then(() => { if (state.chatId === id) renderChatThreadInner(); if (state.tab === "chats") renderChatsList(); });
  });
  const pinnedJump = $("#pinned-msg-jump");
  if (pinnedJump) pinnedJump.addEventListener("click", () => {
    const c = state.chatId && state.contacts.get(state.chatId); if (!c || !c.pinnedMessageId) return;
    ensureMessageRendered(c.id, c.pinnedMessageId);
    const el = document.querySelector(`.bubble[data-msg-id="${CSS.escape(c.pinnedMessageId)}"]`);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("jump-highlight"); setTimeout(() => el.classList.remove("jump-highlight"), 1200); }
  });
  const pinnedUnpin = $("#pinned-msg-unpin");
  if (pinnedUnpin) pinnedUnpin.addEventListener("click", () => {
    const id = state.chatId; if (!id) return;
    const c = state.contacts.get(id); if (!c) return;
    c.pinnedMessageId = null; persistContacts(); renderChatThreadInner();
  });
  const msCancel = $("#multiselect-cancel-btn");
  if (msCancel) msCancel.addEventListener("click", () => exitMultiSelect());
  const msDelete = $("#multiselect-delete-btn");
  if (msDelete) msDelete.addEventListener("click", async () => {
    const id = state.chatId; if (!id || !state.multiSelect) return;
    if (!await confirmSheet(T("chat.selectMsgs.deleteConfirm", { n: state.multiSelect.size }), { destructive: true })) return;
    for (const msgId of state.multiSelect) deleteMessageLocal(id, msgId, true);
    persistContacts();
    if (state.chatId === id) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    exitMultiSelect();
  });
  const msForward = $("#multiselect-forward-btn");
  if (msForward) msForward.addEventListener("click", () => {
    const id = state.chatId; if (!id || !state.multiSelect || state.multiSelect.size === 0) return;
    const ids = Array.from(state.multiSelect);
    openForwardSheet((toId) => { for (const msgId of ids) forwardMessage(msgId, id, toId); });
    exitMultiSelect();
  });
  const peerTap = $("#chat-peer-tap");
  if (peerTap) peerTap.addEventListener("click", () => { const id = state.chatId; if (id) openContactCard(id); });
  const editCancel = $("#edit-cancel-btn");
  if (editCancel) editCancel.addEventListener("click", () => {
    const id = state.chatId;
    cancelEditing();
    const inp = $("#chat-input"); if (!inp) return;
    if (id && state.drafts[id]) inp.value = state.drafts[id]; else inp.value = "";
    updateSendVsMic();
  });
  const replyCancel = $("#reply-cancel-btn");
  if (replyCancel) replyCancel.addEventListener("click", () => cancelReply());
  const scrollBtn = $("#scroll-bottom-btn");
  if (scrollBtn) scrollBtn.addEventListener("click", () => {
    const wrap = $("#chat-messages"); if (wrap) wrap.scrollTo({ top: wrap.scrollHeight, behavior: "smooth" });
  });
  const wrap = $("#chat-messages");
  if (wrap) wrap.addEventListener("scroll", () => {
    updateScrollBottomButton();
    if (state.chatId && unreadDividerFor.has(state.chatId) && isNearBottom(wrap)) {
      const c = state.contacts.get(state.chatId);
      if (c) {
        unreadDividerFor.delete(state.chatId);
        dividerScrolledFor.delete(state.chatId);
        markThreadRead(c);
        const div = wrap.querySelector(".unread-divider");
        if (div) div.remove();
      }
    }
  });
  wireChatEdgeBackGesture();
}
// Свайп от самого левого края экрана закрывает открытый чат — привычный
// iOS-жест "назад", дополняющий кнопку "‹" в шапке. Срабатывает только
// если палец стартовал в первых 24px экрана (почти никогда не совпадает
// с пузырём сообщения — у того есть свой свайп-ответ, см. attachSwipeReply)
// и палец ушёл по горизонтали больше чем по вертикали.
function wireChatEdgeBackGesture() {
  const chatScreenEl = $("#screen-chat");
  if (!chatScreenEl || chatScreenEl.dataset.edgeBackWired) return;
  chatScreenEl.dataset.edgeBackWired = "1";
  let edgeStartX = 0, edgeStartY = 0, edgeTracking = false;
  chatScreenEl.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (t.clientX < 24 && Math.abs(t.clientY - window.innerHeight / 2) < window.innerHeight / 2) {
      edgeStartX = t.clientX; edgeStartY = t.clientY;
      edgeTracking = true;
    } else edgeTracking = false;
  }, { passive: true });
  chatScreenEl.addEventListener("touchmove", (e) => {
    if (!edgeTracking) return;
    const t = e.touches[0];
    if (Math.abs(t.clientY - edgeStartY) > 60) { edgeTracking = false; return; }
  }, { passive: true });
  chatScreenEl.addEventListener("touchend", (e) => {
    if (!edgeTracking) return;
    edgeTracking = false;
    const t = e.changedTouches[0];
    if (t.clientX - edgeStartX > 80) {
      closeChatSafely();
      if (navigator.vibrate) try { navigator.vibrate(5); } catch (e) {}
    }
  }, { passive: true });
}

// =====================================================================
// Boot-recovery
// =====================================================================
function showBootRecovery() {
  if (typeof document === "undefined" || !document || !document.getElementById) return; // страница уже выгружена — показывать нечего
  const o = document.getElementById("onboarding"); if (o) o.classList.add("hidden");
  const a = document.getElementById("app-shell"); if (a) a.classList.add("hidden");
  const l = document.getElementById("lock-screen"); if (l) l.classList.add("hidden");
  const r = document.getElementById("boot-recovery"); if (r) r.classList.remove("hidden");
  // На случай, если сбой случился настолько рано, что I18N.init()/
  // applyStaticTranslations() ещё не успели отработать (например,
  // ошибка ДО DOMContentLoaded) — заголовок иначе остался бы на
  // английском независимо от языка устройства.
  // Раньше тут стояла проверка !I18N.current — она никогда не истинна:
  // current инициализируется как DEFAULT_LANG на уровне модуля, до
  // всякого реального init(), так что I18N.init() по факту никогда не
  // вызывался этим путём. init() безопасен для повторного вызова
  // (просто перечитывает сохранённый язык из localStorage) — вызываем
  // безусловно, чтобы при раннем крэше (до нормального boot) заголовок
  // всё равно перевёлся на реальный язык пользователя, а не остался
  // на DEFAULT_LANG.
  try { if (typeof I18N !== "undefined") I18N.init(); } catch (e) {}
  try { applyStaticTranslations(); } catch (e) {}
}
function bootDidNotRender() {
  const on = document.getElementById("onboarding");
  const ap = document.getElementById("app-shell");
  const lk = document.getElementById("lock-screen");
  const rc = document.getElementById("boot-recovery");
  if (!on || !ap || !lk || !rc) return false;
  return on.classList.contains("hidden") && ap.classList.contains("hidden")
      && lk.classList.contains("hidden") && rc.classList.contains("hidden");
}
const bootWatchdog = setTimeout(() => { if (bootDidNotRender()) showBootRecovery(); }, 10000);
window.addEventListener("error", () => { if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); } });
window.addEventListener("unhandledrejection", () => { if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); } });

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") setTimeout(clearNowPlaying, 1200); });
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await restoreFromIDB().catch(() => {});
    try { I18N.init(); } catch (e) {}
    try { applyStaticTranslations(); } catch (e) {} // экран блокировки показывается ДО startApp() — переводим его до этого момента, а не после
    // Очистка "залипшей" Media Session. startBackgroundAudioSession() в более
    // ранних версиях объявляла активную mediaSession и оставляла её висеть —
    // iOS показывает "Now Playing" виджет на экране блокировки, пока
    // приложение явно не скажет metadata = null и playbackState = "none".
    // Приложение её не очищает при закрытии, поэтому чистим сами при старте.
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      }
    } catch (e) {}
    // Также останавливаем любые случайно оставшиеся аудио-элементы —
    // помимо виджета они держат активную аудио-сессию, которая мешает
    // Web Audio воспроизводить короткие тоны (звук сообщения при этом
    // просто не слышен, хотя осциллятор формально запускается).
    try {
      document.querySelectorAll("audio").forEach((el) => {
        try { el.pause(); el.currentTime = 0; } catch (e) {}
      });
    } catch (e) {}
    initBoot();
    clearTimeout(bootWatchdog);
  } catch (e) { etherLog("error", "[boot]", String(e)); showBootRecovery(); }
});

const brReset = document.getElementById("boot-recovery-reset");
if (brReset) brReset.addEventListener("click", () => { wipeEverythingAndReload(); });

function shutdownCallIfActive() {
  try { if (typeof leaveGroupCall === "function") leaveGroupCall({ silent: true }); } catch (e) {}
  try {
    const cid = state.callId;
    if (!cid) return;
    if (signaling && signaling.connected) {
      try { signaling.signal(cid, { t: "call-ended" }); } catch (e) {}
    }
    try {
      const link = mesh && mesh.get(cid);
      if (link) link.endCall();
    } catch (e) {}
    try { closeCallScreen("completed"); } catch (e) {}
  } catch (e) {}
}
window.addEventListener("beforeunload", () => {
  if (__wiping) return;
  try { saveCurrentDraft(); } catch (e) {}
  try { persistContactsNow(); } catch (e) {}
  try { backupToIDB(); } catch (e) {}
  shutdownCallIfActive();
});
// Уход в фон (сворачивание, переключение вкладки) на мобильных — не менее
// вероятная точка "внезапной смерти" процесса, чем beforeunload, который
// на iOS Safari часто просто не успевает сработать. Сбрасываем дебаунс
// persistContacts() и здесь же, не дожидаясь unload.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    try { persistContactsNow(); } catch (e) {}
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // Сбрасываем очередь Web Audio при возврате на передний план.
    // Пока приложение было в фоне, playMessageSound могла накопить
    // __nextSoundAt (осцилляторы не играли — ctx был suspended, но
    // расписание заполнялось). Без сброса первый же звук после возврата
    // прозвучит "отложенно", с уже накопленным временным сдвигом.
    __nextSoundAt = 0;
    // iOS замораживает setInterval в фоне — пока приложение спало,
    // _lastPongAt не обновлялся, и первый же тик после возврата видел
    // "no pong for 137s" (реальная цифра из лога) и ЗАКРЫВАЛ рабочее
    // соединение. На самом деле соединение было живо — просто мы его
    // сами не "проверяли" из-за заморозки. Обновляем _lastPongAt
    // принудительно: реальная проверка произойдёт при следующем пинге
    // через 5 секунд, если собеседник действительно отвалился.
    if (mesh && mesh.links) {
      for (const link of mesh.links.values()) {
        if (link._lastPongAt) link._lastPongAt = Date.now();
      }
    }
    if (signaling && signaling._lastPongAt) signaling._lastPongAt = Date.now();
    try { updateAppBadge(); } catch (e) {}
    try {
      if (globalAudioCtx && globalAudioCtx.state === "suspended") globalAudioCtx.resume().catch(() => {});
    } catch (e) {}
    if (state.callId) {
      const cs = $("#call-screen");
      const miniBarNow = $("#mini-call-bar"); // свёрнутый звонок (мини-плашка) разворачивается только пользователем, не возвратом из фона
      if (cs && cs.classList.contains("hidden") && (!miniBarNow || miniBarNow.classList.contains("hidden"))) cs.classList.remove("hidden");
      const ci = $("#call-controls-incoming");
      const ca = $("#call-controls-active");
      if (state.callPhase === "ringing") {
        if (ci) ci.classList.remove("hidden");
        if (ca) ca.classList.add("hidden");
      } else if (state.callPhase === "active") {
        if (ci) ci.classList.add("hidden");
        if (ca) ca.classList.remove("hidden");
      }
    }
    // Wake Lock автоматически освобождается браузером при уходе
    // вкладки/приложения в фон (это часть спецификации, не баг) —
    // при возврате на передний план запрашиваем заново, если в этот
    // момент идёт видеозвонок. Без этого экран начинал гаснуть по
    // таймауту ОС после каждого переключения в другое приложение и
    // обратно, хотя видеозвонок продолжался.
    if (state.callId && state.callWantsVideo) requestWakeLock();
    if (state.chatId) {
      const c = state.contacts.get(state.chatId);
      const wrap = $("#chat-messages");
      // Как и при открытии чата — помечаем прочитанным только если сейчас
      // реально виден низ переписки, а не потому что приложение просто
      // вернулось на передний план. Та же ошибка, что и в
      // renderChatThreadInner: "нет разделителя" не означает "видно всё" —
      // новое сообщение в уже прочитанном открытом чате не создаёт
      // разделитель вовсе, и старое условие срабатывало вне зависимости
      // от прокрутки.
      if (c && isNearBottom(wrap)) {
        unreadDividerFor.delete(state.chatId);
        dividerScrolledFor.delete(state.chatId);
        markThreadRead(c);
      }
    }
  }
});
