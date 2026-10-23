"use strict";
// Часть 12 из 14 бывшего js/app.js: Звонки, pull-to-refresh, поиск. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Звонки
// =====================================================================
function loadCallLog() {
  let arr = [];
  try { arr = JSON.parse(Store.callLogJson) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  state.callLog = arr.filter((e) => e && typeof e.id === "string" && typeof e.contactId === "string");
  // Старые записи (сохранённые до появления бейджа непросмотренных
  // пропущенных) не имеют поля seen вовсе — без этой нормализации все
  // они разом стали бы "непросмотренными" при первом запуске после
  // обновления. Считаем их уже просмотренными.
  for (const r of state.callLog) if (r.seen === undefined) r.seen = true;
}
function persistCallLog() { try { Store.callLogJson = JSON.stringify(state.callLog.slice(-MAX_CALL_LOG)); } catch (e) { handlePersistError(e, "callLog"); } }
function startCallRecord(contactId, direction) {
  const c = state.contacts.get(contactId);
  state.currentCallRecord = {
    id: crypto.randomUUID(), contactId,
    contactName: c ? c.name : "",
    direction, status: direction === "out" ? "calling" : "ringing",
    startedAt: Date.now(), answeredAt: null, endedAt: null, durationMs: 0,
    seen: direction === "out", // исходящие не считаются "пропущенными", входящие — непросмотренными, пока не открыта вкладка "Звонки"
  };
  state.callLog.push(state.currentCallRecord);
  persistCallLog();
}
function updateCallRecordStatus(status) {
  const rec = state.currentCallRecord; if (!rec) return;
  rec.status = status;
  if (status === "active" && !rec.answeredAt) rec.answeredAt = Date.now();
  persistCallLog();
}
function endCallRecord(finalStatus) {
  const rec = state.currentCallRecord; if (!rec) return;
  rec.endedAt = Date.now();
  if (rec.answeredAt) {
    rec.durationMs = rec.endedAt - rec.answeredAt;
    rec.status = finalStatus === "failed" ? "failed" : "completed";
  } else {
    if (!finalStatus || finalStatus === "completed") finalStatus = rec.direction === "in" ? "missed" : "cancelled";
    rec.status = finalStatus;
  }
  state.currentCallRecord = null;
  persistCallLog();
  updateCallsBadge();
}
function callStatusLabel(rec) {
  if (rec.status === "completed") {
    const key = rec.direction === "out" ? "calls.systemCompletedOut" : "calls.systemCompletedIn";
    return T(key, { duration: formatDuration(rec.durationMs) });
  }
  if (rec.status === "missed") return T("calls.missed");
  if (rec.status === "declined") return T("calls.declined");
  // Группировка синонимов (Группа 1 «Умная группировка»): cancelled,
  // failed, busy, ringing/noAnswer — для пользователя это одно
  // состояние «не дозвонились». Разные слова (всего их было 4 разных
  // варианта для одного и того же исхода) создавали путаницу и
  // заставляли думать, что между ними есть разница. Сами состояния
  // в callLog не трогаем — они полезны для диагностики.
  return T("calls.unreachable");
}
// Метаданные иконки звонка: цвет + SVG по статусу. Раньше иконка
// была только по направлению (стрелка внутрь/наружу), а цвет менялся
// только для missed — пять «отменённых» и «пропущенных» подряд
// выглядели почти одинаково. Теперь тип результата видно сразу:
// завершённый = зелёный, пропущенный = красный, отклонённый = оранжевый,
// всё остальное = нейтрально-серое.
function callStatusMeta(rec) {
  const isOut = rec.direction === "out";
  const arrowIn  = "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z";
  const arrowOut = "M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4v-2z";
  const svgArrow = (path) => `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="${path}"/></svg>`;
  if (rec.status === "completed") return { cls: "completed", svg: svgArrow(isOut ? arrowOut : arrowIn) };
  if (rec.status === "missed")    return { cls: "missed",    svg: svgArrow(arrowIn) };
  if (rec.status === "declined")  return { cls: "declined",  svg: svgArrow(arrowIn) };
  return { cls: isOut ? "out" : "in", svg: svgArrow(isOut ? arrowOut : arrowIn) };
}
function renderCallsList() {
  const list = $("#calls-list"), empty = $("#calls-empty");
  if (!list) return;
  list.innerHTML = "";
  if (state.callLog.length === 0) { if (empty) empty.classList.remove("hidden"); return; }
  if (empty) empty.classList.add("hidden");
  const items = state.callLog.slice().sort((a, b) => b.startedAt - a.startedAt);
  for (const rec of items) {
    const c = state.contacts.get(rec.contactId);
    const name = (c && c.name) || rec.contactName || T("sys.someone");
    const statusMeta = callStatusMeta(rec);
    const row = document.createElement("div");
    row.className = "call-row flat-content";
    const canOpen = state.contacts.has(rec.contactId);
    row.innerHTML = `
      <button type="button" class="call-row-main"${canOpen ? "" : " disabled"}>
        <div class="call-direction-icon ${statusMeta.cls}">${statusMeta.svg}</div>
        <div class="call-body">
          <div class="call-name">${escapeHtml(name)}</div>
          <div class="call-sub">${escapeHtml(callStatusLabel(rec))} · ${escapeHtml(formatDay(rec.startedAt))} ${escapeHtml(formatTime(rec.startedAt))}</div>
        </div>
      </button>
      <button type="button" class="call-back-btn" aria-label="${escapeHtml(T("chat.call"))}" ${c ? "" : "disabled"}>
        ${Icons.html("phone", 18)}
      </button>`;
    const backBtn = row.querySelector(".call-back-btn");
    if (backBtn && c) backBtn.addEventListener("click", (e) => { e.stopPropagation(); beginCall(rec.contactId); });
    // Раньше вся строка была <div> с click-обработчиком — без role, tabindex
    // или клавиатурного управления пользователь с клавиатурой/Switch Control
    // не мог открыть чат из истории звонков. Кнопка-обёртка для "открыть
    // чат" отдельно от кнопки "перезвонить" — вложенные <button> внутри
    // <button> невалидны и ведут себя непредсказуемо в браузерах.
    const mainBtn = row.querySelector(".call-row-main");
    if (mainBtn) mainBtn.addEventListener("click", () => { if (state.contacts.has(rec.contactId)) { if (typeof resetChatTransientState === "function") resetChatTransientState(rec.contactId); state.chatId = rec.contactId; renderTab(); } });
    list.appendChild(row);
  }
}
let callInviteTimer = null;
function clearPendingCall() {
  if (pendingCall.timer) clearTimeout(pendingCall.timer); pendingCall.timer = null; pendingCall.contactId = null;
  if (callInviteTimer) { clearInterval(callInviteTimer); callInviteTimer = null; }
}
// Ждём, пока клиент сигнального сервера подключится (на мобильной сети и «спящем» сервере это занимает секунды).
function waitForSignaling(ms) {
  if (signaling && signaling.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const sig = signaling; if (!sig) { resolve(false); return; }
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); sig.removeEventListener("connected", onC); resolve(v); };
    const onC = () => finish(true);
    const t = setTimeout(() => finish(!!(signaling && signaling.connected)), ms);
    sig.addEventListener("connected", onC);
  });
}
// Звонок без готового P2P: шлём приглашение (на сервере оно превращается в push), повторяем его, пока идёт
// набор, и пытаемся поднять P2P, как только контакт появится в сети.
function startCallInviteResend(id, invite) {
  if (callInviteTimer) clearInterval(callInviteTimer);
  callInviteTimer = setInterval(() => {
    if (state.callId !== id || state.callPhase !== "calling") { clearInterval(callInviteTimer); callInviteTimer = null; return; }
    if (signaling && signaling.connected) {
      try { signaling.signal(id, invite); } catch (e) {}
      const l = mesh.get(id);
      if (!l || l.status === "disconnected") attemptConnect(id, true);
    }
  }, CALL_INVITE_RESEND_MS);
}

// Glare: A звонит B и B звонит A одновременно. Детерминированно (одинаково с обеих сторон): звонящим остаётся тот, у кого id МЕНЬШЕ
// (совпадает с порядком в WebRTC: меньший id — «вежливая» сторона). Второй вызов превращается в «принять входящий»: тот же экран,
// фаза ringing; звонящая сторона ничего не замечает (её вызов считается основным, встречный invite/ringing она просто подтверждает).
function callGlareYields(id) { return !!(state.callId === id && state.callPhase === "calling" && !state._callUserAccepted && String(myIdFor(id)) > String(id)); }
function yieldCallGlare(id, video) {
  etherLog("info", "[call] glare: встречный вызов от " + String(id).slice(0, 10) + "… — мой id больше, перехожу на «входящий»");
  clearPendingCall();
  try { stopCallSounds(); } catch (e) {}
  if (video) state.callWantsVideo = true;
  openCallScreen(id, "ringing");
  if (state.currentCallRecord) { try { state.currentCallRecord.direction = "in"; state.currentCallRecord.status = "ringing"; } catch (e) {} }
  try { ensureAudioCtx(); } catch (e) {}
  playRingtone();
}
async function beginCall(id, withVideo) {
  const c = state.contacts.get(id);
  if (!c) return;
  if (isGroup(c)) { if (typeof startGroupCall === "function") startGroupCall(id, !!withVideo); else toast(T("toast.callGroupsUnsupported")); return; }
  if (typeof gcallBusy === "function" && gcallBusy()) { toast(T("toast.alreadyInCall")); return; }
  if (c.isSelf) return; // звонить себе некуда — у "Заметок себе" нет peer-соединения
  if (c.blocked) { toast(T("toast.blocked")); return; }
  if (state.callId && state.callId !== id) { toast(T("toast.alreadyInCall")); return; }
  if (state.callId === id) { openCallScreen(id, state.callPhase || "calling"); return; }
  // Ключ собеседника сменился и не подтверждён — звонок небезопасен всегда; режим «только с проверенными» — по настройке
  if (c.pendingKey) { toast(T("call.keyChanged", { name: c.name || T("sys.someone") })); return; }
  if (Store.requireVerifiedCalls && !isContactVerified(c)) {
    if (await confirmSheet(T("call.needVerify", { name: c.name || T("sys.someone") }))) openSafetySheet(id);
    return;
  }

  // Debounce: не даём запустить новый звонок в течение 1.5с после
  // предыдущего провала — иначе пользователь, быстро тапая «Позвонить»,
  // плодит лавину системных сообщений «Звонок не состоялся».
  // 4с вместо 1.5с: в логе видно три beginCall подряд с интервалами
  // 1.7с и 2.6с — старый debounce их не покрывал.
  if (state._lastCallFailedAt && Date.now() - state._lastCallFailedAt < 4000) {
    try { toast(T("call.tooSoon")); } catch (e) {}
    return;
  }

  etherLog("info", "[call] beginCall to " + String(id).slice(0, 10) + "…");
  state._callUserAccepted = false;
  state._callAcceptInFlight = false;
  state._callMuteOnAnswer = false;
  state._callDeadSeconds = 0;
  state.callWantsVideo = !!withVideo;
  if (withVideo) requestWakeLock();

  openCallScreen(id, "calling");
  playDialingSound();

  // ============================================================
  // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ.
  // Сначала проверяем ЖИВОЙ P2P-канал. Если он уже есть — сигнальный
  // сервер для звонка НЕ НУЖЕН вовсе: call-state:ringing, accepted,
  // ended и медиа-треки идут напрямую через data channel WebRTC.
  // Сервер нужен только для ПЕРВИЧНОГО рукопожатия, и то не всегда
  // (relay через общий контакт тоже работает).
  // Раньше проверка signaling.connected шла ПЕРВОЙ и молча блокировала
  // звонок при живом P2P — именно это видно на скриншоте (P2P зелёный,
  // а тост «нет связи с сервером»).
  // ============================================================
  const link = mesh.get(id);
  const p2pReady = link && (link.status === "connected" || link.status === "in-call");

  if (p2pReady) {
    try {
      await link.startCall(withVideo);
      // пока висел запрос доступа к микрофону, звонок могли отменить: микрофон не оставляем включённым и собеседнику не звоним
      if (state.callId !== id) { try { link.endCall(); } catch (x) {} return; }
      if (withVideo) showLocalVideoPreview(link);
    } catch (e) {
      const name = e && e.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") toast(T("toast.callPermissionDenied"));
      else if (name === "NotFoundError" || name === "DevicesNotFoundError") toast(T("toast.voiceNoMic"));
      else toast(T("calls.failed"));
      state._lastCallFailedAt = Date.now();
      closeCallScreen("failed", { localError: true }); // локальная ошибка (микрофон): голосовую почту не предлагаем
      return;
    }

    // Best-effort: даже если сервер жив — уведомим собеседника через
    // сигналинг. Это лишь дублирует data-channel сигнал call-state
    // (нужно для push-уведомления и записи в истории звонков у
    // получателя, если приложение свёрнуто). Если сервер недоступен —
    // просто пропускаем, звонок уже идёт через P2P.
    if (signaling && signaling.connected) {
      try {
        signaling.signal(id, { t: "call-invite", n: Store.name, x: crypto.randomUUID() });
      } catch (e) {}
    }
    // Если собеседник не ответил (и не отклонил), звонок не должен «звонить» вечно: тот же тайм-аут, что и в ветке через сервер
    clearPendingCall();
    pendingCall.contactId = id;
    pendingCall.timer = setTimeout(() => {
      if (pendingCall.contactId !== id || state.callId !== id || state.callPhase === "active") return;
      clearPendingCall();
      try { const l = mesh.get(id); if (l) l.endCall(); } catch (e) {}
      if (signaling && signaling.connected) { try { signaling.signal(id, { t: "call-ended" }); } catch (e) {} }
      toast(T("calls.noAnswer"));
      playNoAnswerSound();
      state._lastCallFailedAt = Date.now();
      closeCallScreen("cancelled", { noAnswer: true });
    }, PENDING_CALL_TIMEOUT_MS);
    return;
  }

  // P2P пока нет — нужен сигнальный сервер. Он может ещё просыпаться (холодный старт), ждём до CALL_SERVER_WAIT_MS.
  if (!signaling || !signaling.connected) {
    const cp = $("#call-phase"); if (cp) cp.textContent = T("status.waking");
    const ok = await waitForSignaling(CALL_SERVER_WAIT_MS);
    if (state.callId !== id) return; // пока ждали, звонок отменили
    if (!ok) {
      toast(T("toast.noServer"));
      state._lastCallFailedAt = Date.now();
      closeCallScreen("failed");
      return;
    }
  }

  const offline = !onlineSet.has(id);
  const invite = { t: "call-invite", n: Store.name, x: crypto.randomUUID() };
  signaling.signal(id, invite);
  const phaseEl = $("#call-phase");
  if (phaseEl) phaseEl.textContent = offline ? T("call.viaPush") : T("call.calling");

  clearPendingCall();
  pendingCall.contactId = id;
  startCallInviteResend(id, invite);
  attemptConnect(id, true);
  pendingCall.timer = setTimeout(() => {
    if (pendingCall.contactId !== id) return;
    if (state.callId !== id) return;
    if (state.callPhase === "active") return;
    clearPendingCall();
    const l = mesh.get(id);
    if (l) l.endCall();
    if (signaling && signaling.connected) {
      try { signaling.signal(id, { t: "call-ended" }); } catch (e) {}
    }
    toast(T("calls.noAnswer"));
    playNoAnswerSound();
    state._lastCallFailedAt = Date.now();
    closeCallScreen("cancelled", { noAnswer: true });
  }, offline ? CALL_PUSH_TIMEOUT_MS : PENDING_CALL_TIMEOUT_MS);
}

// Сворачивание звонка в тонкую полоску над таб-баром — звонок (и его
// таймер/WebRTC-соединение) продолжается, просто #call-screen больше не
// занимает единолично #content, можно вернуться в чаты/контакты/настройки.
// Разворот — тапом по самой полоске (restoreCallScreen).
function minimizeCallScreen() {
  if (!state.callId) return;
  const cs = $("#call-screen"); if (cs) cs.classList.add("hidden");
  const contentEl = $("#content"); if (contentEl) contentEl.classList.remove("hidden");
  const c = state.contacts.get(state.callId);
  const nameEl = $("#mini-call-name"); if (nameEl) nameEl.textContent = (c && c.name) || T("sys.someone");
  const avEl = $("#mini-call-avatar"); if (avEl) avEl.innerHTML = avatarCircleHtml(c, null, "");
  const miniBar = $("#mini-call-bar"); if (miniBar) miniBar.classList.remove("hidden");
  renderTab();
}
function restoreCallScreen() {
  if (!state.callId) return;
  const miniBar = $("#mini-call-bar"); if (miniBar) miniBar.classList.add("hidden");
  const contentEl = $("#content"); if (contentEl) contentEl.classList.add("hidden");
  const cs = $("#call-screen"); if (cs) cs.classList.remove("hidden");
}
function openCallScreen(id, phase, opts) {
  // media-viewer, будучи position:fixed поверх всего окна, всё равно
  // закрыл бы обзор звонка, даже когда #call-screen стал обычным
  // flex-элементом (а не оверлеем, как раньше) — закрываем его.
  const mv = $("#media-viewer"); if (mv && !mv.classList.contains("hidden")) mv.classList.add("hidden");
  // #call-screen теперь обычный flex-элемент рядом с #content, а не
  // абсолютный оверлей поверх всего #app-shell — таб-бар остаётся
  // виден снизу, контролы звонка появляются НАД ним. Но #content и
  // #call-screen делят одну и ту же flex-ячейку по очереди: пока виден
  // звонок, список чатов/экраны должны быть скрыты явно, иначе оба
  // одновременно заняли бы по половине места.
  const contentEl = $("#content"); if (contentEl) contentEl.classList.add("hidden");
  const miniBar = $("#mini-call-bar"); if (miniBar) miniBar.classList.add("hidden");
  if (state.callId !== id) {
    state._callUserAccepted = false;
    state._callAcceptInFlight = false;
    state._callMuteOnAnswer = false;
    clearCallNotices();
    armCallBackGuard();
    speakerOn = false; // новый звонок всегда начинается с внутреннего динамика
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch (e) {}
  }
  state.callId = id;
  state.callPhase = phase;
  try { ensureAudioCtx(); } catch (e) {}
  updateCallButtonsSupport();
  const muteBtn = $("#call-mute-btn");
  if (muteBtn) {
    muteBtn.classList.remove("active");
    const lbl = $("#call-mute-label");
    if (lbl) lbl.textContent = T("call.mute");
  }
  const c = state.contacts.get(id);
  const cs = $("#call-screen"); if (cs) cs.classList.remove("hidden");
  const pn = $("#call-peer-name"); if (pn) pn.textContent = (c && c.name) || T("sys.someone");
  const pa = $("#call-peer-avatar"); if (pa) { pa.style.background = avatarGradient((c && c.name) || "?"); pa.textContent = initials((c && c.name) || "?"); }
  const cp = $("#call-phase"); if (cp) cp.textContent = phase === "calling" ? T("call.calling") : phase === "ringing" ? T("call.incoming") : T("call.active");
  const incoming = phase === "ringing";
  const ci = $("#call-controls-incoming"); if (ci) ci.classList.toggle("hidden", !incoming);
  const ca = $("#call-controls-active"); if (ca) ca.classList.toggle("hidden", incoming);
  const cv = $(".call-volume"); if (cv) cv.classList.toggle("hidden", incoming);
  const sfb0 = $("#call-sound-fix-btn"); if (sfb0) sfb0.classList.toggle("hidden", phase !== "active");
  // Уровень громкости.
  const vs = $("#call-volume-slider"); if (vs) vs.value = String(Store.callVolume);
  clearInterval(callTimerInterval);
  if (phase === "active") startCallTimer();

  if (phase === "ringing") {
    clearPendingCall();
    pendingCall.contactId = id;
    pendingCall.timer = setTimeout(() => {
      if (state.callId !== id) return;
      if (state.callPhase !== "ringing") return;
      try { const l = mesh.get(id); if (l) l.endCall(); } catch (e) {}
      if (signaling && signaling.connected) {
        try { signaling.signal(id, { t: "call-ended" }); } catch (e) {}
      }
      toast(T("toast.missedCall"));
      closeCallScreen("missed");
    }, (opts && opts.timeoutMs) || INCOMING_CALL_TIMEOUT_MS);
  }

  if (!state.currentCallRecord) {
    if (phase === "calling") startCallRecord(id, "out");
    else if (phase === "ringing") startCallRecord(id, "in");
  }
}

function setCallPhaseActive() {
  state.callPhase = "active";
  state._callUserAccepted = true;
  clearPendingCall();
  stopCallSounds();
  const ci = $("#call-controls-incoming"); if (ci) ci.classList.add("hidden");
  const ca = $("#call-controls-active"); if (ca) ca.classList.remove("hidden");
  const cv = $(".call-volume"); if (cv) cv.classList.remove("hidden");
  const sfb = $("#call-sound-fix-btn"); if (sfb) sfb.classList.remove("hidden");
  startCallTimer();
  resumeCallAudio("active");
  updateCallRecordStatus("active");
  if (state.callId && pendingRemoteStreams.has(state.callId)) {
    const stream = pendingRemoteStreams.get(state.callId);
    attachRemoteAudio(state.callId, stream);
    if (stream.getVideoTracks().length > 0) attachRemoteVideo(state.callId, stream);
    pendingRemoteStreams.delete(state.callId);
  }
}

async function findAudioOutputDevice(pattern) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const found = devices.find((d) => d.kind === "audiooutput" && pattern.test(d.label || ""));
    return found ? found.deviceId : null;
  } catch (e) { return null; }
}
// Веб-платформа не даёт напрямую переключить "наушник vs громкая связь" —
// единственный стандартный механизм — Audio Output Devices API
// (setSinkId), и то он выбирает КОНКРЕТНОЕ устройство вывода, а не
// абстрактный "режим". Поддержка сильно зависит от браузера/ОС — там,
// где API недоступен, честно сообщаем об этом, а не делаем вид, что
// переключили.
async function toggleSpeaker() {
  const id = state.callId; if (!id) return;
  if (!isMobileDevice() && !navigator.audioSession) { await openAudioOutputPicker(); return; }
  const audioEl = document.getElementById("remote-audio-" + id);
  const wantSpeaker = !speakerOn;
  const paint = () => { const btn = $("#call-speaker-btn"); if (btn) btn.classList.toggle("active", speakerOn); };
  // iOS Safari 16.4+: Audio Session API — "play-and-record" во время звонка ведёт звук в
  // наушник (ресивер), "playback" — на громкую связь. setSinkId на iPhone до iOS 26 нет вовсе.
  if (navigator.audioSession && !(audioEl && typeof audioEl.setSinkId === "function")) {
    try {
      navigator.audioSession.type = wantSpeaker ? "playback" : "play-and-record";
      speakerOn = wantSpeaker;
      paint();
    } catch (e) { toast(T("toast.speakerUnsupported")); return; }
    // «playback» на части версий iOS отбирает у страницы захват микрофона (собеседник перестаёт слышать) — проверяем и откатываем.
    if (wantSpeaker) setTimeout(() => verifySpeakerKeepsMic(), 700);
    resumeCallAudio("speaker");
    return;
  }
  if (!audioEl || typeof audioEl.setSinkId !== "function") {
    toast(T("toast.speakerUnsupported"));
    return;
  }
  try {
    // Раньше при отсутствии подходящего устройства подставлялся "default" и кнопка всё равно загоралась — маршрут не менялся
    // (на Android Chrome без подписей устройств громкая связь «включалась» вхолостую). Теперь без найденного устройства честно сообщаем.
    const found = await findAudioOutputDevice(wantSpeaker ? /speaker|loud|динамик|громк/i : /earpiece|receiver|телефон|разговорн/i);
    if (!found && wantSpeaker) { toast(T("toast.speakerUnsupported")); return; }
    await audioEl.setSinkId(found || "default");
    speakerOn = wantSpeaker;
    paint();
    resumeCallAudio("speaker");
  } catch (e) {
    toast(T("toast.speakerUnsupported"));
  }
}
function verifySpeakerKeepsMic() {
  const id = state.callId; if (!id || !speakerOn || !navigator.audioSession) return;
  const link = mesh.get(id), t = link && link.localAudioTrack;
  if (!t || (t.readyState !== "ended" && !t.muted)) return;
  etherLog("warn", "[call] «громкая связь» (audioSession=playback) остановила захват микрофона — возвращаю play-and-record");
  try { navigator.audioSession.type = "play-and-record"; } catch (e) {}
  speakerOn = false;
  const btn = $("#call-speaker-btn"); if (btn) btn.classList.remove("active");
  toast(T("toast.speakerUnsupported"));
  if (link && link.ensureMic) link.ensureMic("speaker-revert", true);
}
// Единая точка изменения громкости собеседника: GainNode (работает и на iOS) либо element.volume,
// если звук идёт напрямую без Web Audio.
function ensureRelayGain(audioEl, stream) {
  if (audioEl._relayGain) return audioEl._relayGain;
  const ctx = ensureGlobalAudioCtx();
  if (!ctx || !stream) return null;
  try {
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
    const source = ctx.createMediaStreamSource(stream);
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = Store.callVolume;
    source.connect(gain); gain.connect(dest);
    audioEl._relaySource = source; audioEl._relayDest = dest; audioEl._relayGain = gain;
    audioEl.srcObject = dest.stream;
    const p = audioEl.play(); if (p && p.catch) p.catch(() => {});
    return gain;
  } catch (e) { etherLog("warn", "[audio] GainNode недоступен:", String(e)); return null; }
}
function applyCallVolume(id, v) {
  const vol = Math.max(0, Math.min(1, Number(v) || 0));
  const el = document.getElementById("remote-audio-" + id);
  if (!el) return;
  if (el._volReadOnly) {
    const g = el._relayGain || (vol < 0.99 ? ensureRelayGain(el, el._relayStream) : null);
    if (g) { try { g.gain.value = vol; } catch (e) {} }
    return;
  }
  try { el.volume = vol; } catch (e) {}
}
function attachRemoteAudio(id, stream) {
  if (!stream) { etherLog("warn", "[audio] empty stream"); return; }
  let audioEl = document.getElementById("remote-audio-" + id);
  if (!audioEl) {
    audioEl = document.createElement("audio");
    audioEl.id = "remote-audio-" + id;
    audioEl.autoplay = true;
    audioEl.setAttribute("playsinline", "");
    audioEl.hidden = true;
    document.body.appendChild(audioEl);
  }
  // Повторный remote-track (например, когда следом приходит видеотрек того же потока) не должен
  // пересобирать цепочку Web Audio — это даёт щелчок и дублирует источник.
  if (audioEl._relayStream === stream && audioEl.srcObject) {
    try { const c0 = ensureGlobalAudioCtx(); if (c0 && c0.state === "suspended") c0.resume(); } catch (e) {}
    applyCallVolume(id, Store.callVolume);
    return;
  }
  // Звук собеседника играет НАПРЯМУЮ из WebRTC-потока. Раньше он шёл через Web Audio (MediaStreamSource → Gain →
  // MediaStreamDestination → <audio>): лишняя передискретизация и задержка давали «плывущий» звук с артефактами, а в
  // Chrome/Edge MediaStreamSource от удалённого потока без <audio> на нём вообще молчит — «звуковой канал не налаживается».
  // Новый поток (пересогласование, перезахват) — старая цепочка Web Audio привязана к мёртвому потоку: её GainNode больше ничего
  // не регулирует, и ползунок «ничего не делал» (звук оставался на старом уровне).
  if (audioEl._relayGain || audioEl._relaySource) {
    try { if (audioEl._relaySource) audioEl._relaySource.disconnect(); } catch (e) {}
    try { if (audioEl._relayGain) audioEl._relayGain.disconnect(); } catch (e) {}
    audioEl._relayGain = audioEl._relaySource = audioEl._relayDest = null;
  }
  audioEl._relayStream = stream;
  audioEl.muted = false;
  audioEl.srcObject = stream;
  audioEl.volume = Store.callVolume;
  { const out = savedAudioOutput(); if (out && audioEl.setSinkId) audioEl.setSinkId(out).catch(() => {}); }
  // iOS: HTMLMediaElement.volume только для чтения. Звук играет напрямую (лучшее качество), а когда пользователь уменьшает громкость
  // слайдером, поток один раз пропускается через GainNode (см. ensureRelayGain). На полной громкости Web Audio не участвует.
  try {
    const keep = audioEl.volume; audioEl.volume = keep > 0.5 ? 0.4 : 0.6;
    audioEl._volReadOnly = Math.abs(audioEl.volume - keep) < 0.01;
    audioEl.volume = keep;
    if (audioEl._volReadOnly && Store.callVolume < 0.99) ensureRelayGain(audioEl, stream);
  } catch (e) {}
  wireRemoteAudioEvents(audioEl);
  playRemoteAudio(audioEl);
  const sl = $("#call-volume-slider"); if (sl) sl.value = String(Store.callVolume);
  // На iOS видеозвонки (в отличие от чисто голосовых) переключаются
  // системой на громкую связь по своей же внутренней эвристике —
  // независимо от того, что говорит speakerOn в JS. Явно возвращаем на
  // наушник, если пользователь ничего вручную не переключал — но не
  // трогаем, если он сам переключился на громкую (speakerOn === true).
  // Best-effort: если setSinkId недоступен/бросит ошибку (нет
  // подходящего контекста пользовательского жеста на некоторых
  // платформах) — тихо оставляем как есть, ничего не ломаем.
  if (!speakerOn && typeof audioEl.setSinkId === "function") {
    findAudioOutputDevice(/earpiece|receiver/i).then((deviceId) => {
      if (deviceId) audioEl.setSinkId(deviceId).catch(() => {});
    }).catch(() => {});
  }
}
// Запуск звука собеседника с повтором. Раньше отказ play() (автоплей-политика, прерывание звонком/Siri) терпел один тап
// по экрану — и тишина оставалась навсегда; теперь есть видимая подсказка и повтор на каждом жесте, возврате и «pause».
function playRemoteAudio(audioEl) {
  if (!audioEl) return;
  let p; try { p = audioEl.play(); } catch (e) { p = null; }
  if (p && p.then) p.then(() => setCallNotice("audio", null), () => {
    setCallNotice("audio", T("call.soundBlocked"));
    if (audioEl._retryOnGesture) return;
    audioEl._retryOnGesture = true;
    const resume = () => {
      audioEl._retryOnGesture = false;
      ["touchstart", "pointerdown", "click", "keydown"].forEach((ev) => document.removeEventListener(ev, resume, true));
      resumeCallAudio("gesture");
    };
    ["touchstart", "pointerdown", "click", "keydown"].forEach((ev) => document.addEventListener(ev, resume, true));
  });
  else setCallNotice("audio", null);
}
function wireRemoteAudioEvents(audioEl) {
  if (audioEl._etherWired) return;
  audioEl._etherWired = true;
  // Системное прерывание (входящий обычный звонок, Siri, смена маршрута) ставит <audio> на паузу — тихо возобновляем.
  audioEl.addEventListener("pause", () => { setTimeout(() => { if (state.callId && audioEl.isConnected && audioEl.paused && audioEl.srcObject) playRemoteAudio(audioEl); }, 150); });
  audioEl.addEventListener("playing", () => setCallNotice("audio", null));
}
// Короткие системные плашки на экране звонка (микрофон приостановлен ОС, звук заблокирован…): ключ → текст; тап = «починить звук».
const __callNotices = new Map();
function setCallNotice(key, text) {
  if (text) __callNotices.set(key, text); else __callNotices.delete(key);
  const el = $("#call-notice"); if (!el) return;
  const first = Array.from(__callNotices.values())[0] || "";
  el.textContent = first;
  el.classList.toggle("hidden", !first);
}
function clearCallNotices() { __callNotices.clear(); setCallNotice("x", null); }
// Всё, что можно сделать с аудио звонка без участия пользователя: контекст Web Audio, <audio>, маршрут iOS, микрофон.
// Вызывается при возврате в приложение, по жесту после отказа autoplay, после смены маршрута и по кнопке «проблема со звуком».
function resumeCallAudio(reason) {
  const id = state.callId; if (!id) return;
  try { if (navigator.audioSession && !speakerOn && navigator.audioSession.type !== "play-and-record") navigator.audioSession.type = "play-and-record"; } catch (e) {}
  try { const c = ensureGlobalAudioCtx(); if (c && c.state !== "running") c.resume().catch(() => {}); } catch (e) {}
  const el = document.getElementById("remote-audio-" + id);
  if (el) {
    try { el.muted = false; } catch (e) {}
    if (el._relayStream && !el.srcObject) el.srcObject = el._relayStream;
    if (el.paused || el.ended) playRemoteAudio(el);
  }
  const link = mesh.get(id);
  if (link && link.ensureMic && !document.hidden) {
    // после возврата из фона трек обычно сам снимает mute за ~секунду; если нет — берём микрофон заново
    setTimeout(() => { if (state.callId === id) link.ensureMic(reason); }, reason === "foreground" ? 1200 : 0);
  }
}
async function fixCallSound() {
  const id = state.callId; if (!id) return;
  const link = mesh.get(id);
  resumeCallAudio("fix");
  let ok = true;
  if (link && link.ensureMic) { try { ok = await link.ensureMic("fix", true); } catch (e) { ok = false; } }
  if (link && link.reInvite && link.pc && link.pc.iceConnectionState && link.pc.iceConnectionState !== "connected" && link.pc.iceConnectionState !== "completed") { try { link.reInvite(); } catch (e) {} }
  toast(T(ok ? "call.soundReset" : "call.micFailed"));
}
function onLocalMicState(d) {
  if (!d || !state.callId) return;
  setCallNotice("mic", d.suspended ? T("call.micSuspended") : null);
}
function wireCallAudioResilience() {
  if (wireCallAudioResilience._done) return; wireCallAudioResilience._done = true;
  const back = () => { if (!document.hidden) resumeCallAudio("foreground"); };
  document.addEventListener("visibilitychange", back);
  window.addEventListener("pageshow", back);
  window.addEventListener("focus", back);
  const fixBtn = $("#call-sound-fix-btn"); if (fixBtn) fixBtn.addEventListener("click", () => fixCallSound());
  const notice = $("#call-notice"); if (notice) notice.addEventListener("click", () => fixCallSound());
  try {
    const ctx = ensureGlobalAudioCtx();
    if (ctx && ctx.addEventListener) ctx.addEventListener("statechange", () => { if (state.callId && ctx.state !== "running") ctx.resume().catch(() => {}); });
  } catch (e) {}
}
// Доступность Picture-in-Picture: requestPictureInPicture (Chrome/Edge,
// большинство Android-браузеров) ИЛИ webkitSetPresentationMode (старый
// Safari/iOS). document.pictureInPictureEnabled === false означает, что
// браузер явно отключил API (например, через Permissions-Policy) —
// в этом случае кнопку не показываем вовсе, а не оставляем декоративной.
// Телефон/планшет (экран касанием, есть переключаемые камеры): здесь нужны «задняя камера» и динамик/наушник,
// а картинка-в-картинке не нужна. На десктопе — наоборот. Недоступные кнопки не показываем вообще.
function isMobileDevice() {
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}
function speakerToggleSupported() {
  if (navigator.audioSession) return true; // iOS: playback ↔ play-and-record
  // Android: динамик/наушник; десктоп: выбор устройства вывода (колонки/наушники/гарнитура) через setSinkId
  return typeof HTMLMediaElement !== "undefined" && typeof HTMLMediaElement.prototype.setSinkId === "function";
}
function savedAudioOutput() { try { return localStorage.getItem("ether.audioOut") || ""; } catch (e) { return ""; } }
async function setAudioOutput(deviceId) {
  try { localStorage.setItem("ether.audioOut", deviceId || ""); } catch (e) {}
  for (const el of document.querySelectorAll("audio[id^=remote-audio-]")) { try { if (el.setSinkId) await el.setSinkId(deviceId || "default"); } catch (e) {} }
  for (const el of soundPool.values()) { try { if (el.setSinkId) await el.setSinkId(deviceId || "default"); } catch (e) {} }
}
// Десктоп: выбор устройства вывода звука из списка (колонки, наушники, гарнитура…)
async function openAudioOutputPicker() {
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput"); } catch (e) {}
  const old = $("#audio-out-menu"); if (old) { old.remove(); return; }
  if (devices.length < 2) { toast(T("toast.noOtherOutput")); return; }
  const cur = savedAudioOutput() || "default";
  const menu = document.createElement("div"); menu.id = "audio-out-menu"; menu.className = "call-more-menu"; menu.setAttribute("role", "menu");
  devices.forEach((d, i) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "call-menu-item"; b.setAttribute("role", "menuitem");
    const label = d.label || (T("call.speaker") + " " + (i + 1));
    b.innerHTML = `<span>${escapeHtml(label)}</span>${(d.deviceId === cur || (cur === "default" && d.deviceId === "default")) ? " ✓" : ""}`;
    b.addEventListener("click", async () => { menu.remove(); await setAudioOutput(d.deviceId); toast(label); const spk = $("#call-speaker-btn"); if (spk) spk.classList.toggle("active", d.deviceId !== "default"); });
    menu.appendChild(b);
  });
  const host = $("#call-controls-active"); if (!host) return;
  host.appendChild(menu);
  setTimeout(() => document.addEventListener("pointerdown", function close(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", close, true); } }, true), 0);
}
function updateCallButtonsSupport() {
  const mobile = isMobileDevice();
  const spk = $("#call-speaker-btn"); if (spk) spk.classList.toggle("hidden", !speakerToggleSupported());
  const lnk = state.callId ? mesh.get(state.callId) : null;
  const flip = $("#call-flip-overlay-btn");
  if (flip) flip.classList.toggle("hidden", !(mobile && lnk && lnk.localVideoTrack && !lnk._screenSharing));
  const pip = $("#call-pip-overlay-btn");
  if (pip) pip.classList.toggle("hidden", mobile || !pipSupported());
  const ov = $("#call-video-overlays");
  if (ov) {
    const any = ["#call-flip-overlay-btn", "#call-pip-overlay-btn"].some((q) => { const b = $(q); return b && !b.classList.contains("hidden"); });
    if (!any) ov.classList.add("hidden");
  }
}
function pipSupported() {
  const v = document.createElement("video");
  if (typeof document.pictureInPictureEnabled === "boolean" && document.pictureInPictureEnabled && typeof v.requestPictureInPicture === "function") return true;
  if (typeof v.webkitSetPresentationMode === "function") return true;
  return false;
}
// Единая точка правды для фона экрана звонка. «video-active» (чёрный фон, без аватара) — ТОЛЬКО пока на экране реально
// есть видео собеседника; своё превью — маленькая плашка в углу и фон аудиозвонка не отменяет. Раньше класс ставился при
// включении любого видео и не снимался при выключении своей камеры — экран оставался чёрным без аватара.
function syncCallVideoState() {
  const cs = $("#call-screen"); if (!cs) return;
  const rv = $("#call-remote-video"), lv = $("#call-local-video");
  const remoteOn = !!(rv && rv.srcObject && !rv.classList.contains("hidden") && !state._remoteVideoOff);
  const localOn = !!(lv && lv.srcObject && !lv.classList.contains("hidden"));
  if (rv && state._remoteVideoOff && !rv.classList.contains("hidden")) rv.classList.add("hidden");
  cs.classList.toggle("video-active", remoteOn);
  cs.classList.toggle("local-video-on", localOn);
}
function attachRemoteVideo(id, stream) {
  if (state.callId !== id) return;
  const videoTracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
  if (videoTracks.length === 0) return;
  const v = $("#call-remote-video");
  if (!v) return;
  // Звук собеседника играет ТОЛЬКО через #remote-audio-<id> (громкость, динамик/наушник).
  // Не заглушённый <video> с тем же потоком проигрывал бы ту же дорожку второй раз — на
  // видеозвонке это давало эхо/двойной звук, не подчинялось слайдеру громкости и
  // переключению динамика.
  v.muted = true; v.defaultMuted = true; v.volume = 0;
  v.srcObject = stream;
  v.classList.remove("hidden");
  state._remoteVideoOff = false;
  syncCallVideoState();
  // Собеседник убрал видео (остановил показ экрана без камеры, выключил камеру с удалением трека) —
  // трек получает mute/ended, и без реакции на это остался бы замороженный последний кадр.
  for (const t of videoTracks) {
    if (t.__etherWatched || !t.addEventListener) continue;
    t.__etherWatched = true;
    const setVisible = (visible) => {
      if (state.callId !== id) return;
      const rv = $("#call-remote-video"); if (!rv || rv.srcObject !== stream) return;
      rv.classList.toggle("hidden", !visible || !!state._remoteVideoOff);
      syncCallVideoState();
    };
    t.addEventListener("mute", () => setVisible(false));
    t.addEventListener("unmute", () => setVisible(true));
    t.addEventListener("ended", () => setVisible(false));
  }
  const p = v.play(); if (p && p.catch) p.catch(() => {});
  // Раньше здесь была отдельная кнопка PiP (#call-pip-btn), показываемая
  // независимо от showLocalVideoPreview — именно для случая "смотрю
  // видео собеседника, свою камеру не включал". Теперь PiP и flip —
  // один оверлей-контейнер (#call-video-overlays), и его включает только
  // showLocalVideoPreview — без этой строки контейнер остался бы скрыт,
  // пока пользователь не включит СВОЮ камеру, хотя PiP для чужого видео
  // уже осмысленен. flip в этом случае — безопасный no-op
  // (PeerLink.switchCamera() сам проверяет наличие localVideoTrack).
  const overlays = $("#call-video-overlays"); if (overlays) overlays.classList.remove("hidden");
  updateCallButtonsSupport();
}
function showLocalVideoPreview(link) {
  const v = $("#call-local-video");
  if (!v || !link || !link.localStream) return;
  v.srcObject = link.localStream;
  v.classList.remove("hidden");
  syncCallVideoState();
  const p = v.play(); if (p && p.catch) p.catch(() => {});
  // Раньше тут были отдельные #call-switch-camera-btn (в основном ряду) и
  // #call-flip-overlay-btn (сам по себе поверх видео) плюс #call-pip-btn
  // в основном ряду — три кнопки управления видео вперемешку с
  // микрофоном/громкой связью/завершением звонка. Теперь flip и PiP —
  // единый оверлей-контейнер над превью (#call-video-overlays), а
  // основной ряд всегда состоит из 4 кнопок (микрофон/громкая связь/
  // видео/завершить). PiP-кнопка внутри оверлея видна всегда — нажатие
  // при неподдерживаемом PiP показывает toast (см. wireCallScreen).
  const overlays = $("#call-video-overlays"); if (overlays) overlays.classList.remove("hidden");
  // Flip камеры бессмысленен, если своя камера не включена (только PiP) — скрываем кнопку.
  const flipBtn = $("#call-flip-overlay-btn");
  if (flipBtn) {
    const lnk = state.callId ? mesh.get(state.callId) : null;
    flipBtn.classList.toggle("hidden", !(lnk && lnk.localVideoTrack));
  }
  const videoBtn = $("#call-video-btn"); if (videoBtn) videoBtn.classList.add("active");
  updateCallButtonsSupport();
}
function hideCallVideo() {
  // Если в этот момент активен PiP — закрываем его явно. Без этого
  // плавающее окошко продолжает показывать видео-поток, который мы вот-вот
  // обнулим (srcObject = null) — на экране остаётся "подвисший" чёрный
  // PiP-прямоугольник вместо того, чтобы просто исчезнуть вместе со звонком.
  if (document.pictureInPictureElement) { try { document.exitPictureInPicture(); } catch (e) {} }
  const rv = $("#call-remote-video"); if (rv) { rv.classList.add("hidden"); rv.srcObject = null; }
  const lv = $("#call-local-video"); if (lv) { lv.classList.add("hidden"); lv.srcObject = null; }
  state._remoteVideoOff = false;
  const cs = $("#call-screen"); if (cs) cs.classList.remove("video-active", "local-video-on", "remote-screen", "sharing");
  const overlays = $("#call-video-overlays"); if (overlays) overlays.classList.add("hidden");
  const videoBtn = $("#call-video-btn"); if (videoBtn) videoBtn.classList.remove("active");
}
// Показ таймера (и в мини-плашке тоже) обновляется 4 раза в секунду и сразу при старте — раньше он зависел от секундного тика логики
// и в мини-плашке отставал до секунды; сама логика «мёртвой связи» ниже по-прежнему считает целые секунды.
let callTimerDisplayInterval = null;
function paintCallTimer(started) {
  const txt = formatClock(Date.now() - started);
  const cp = $("#call-phase"); if (cp && state.callPhase === "active") cp.textContent = txt;
  const mct = $("#mini-call-timer"); if (mct) mct.textContent = txt;
}
function startCallTimer() {
  const started = Date.now();
  clearInterval(callTimerInterval);
  clearInterval(callTimerDisplayInterval);
  paintCallTimer(started);
  callTimerDisplayInterval = setInterval(() => { if (!state.callId) { clearInterval(callTimerDisplayInterval); callTimerDisplayInterval = null; return; } paintCallTimer(started); }, 250);
  state._callDeadSeconds = 0;
  let qualityTick = 0;
  callTimerInterval = setInterval(() => {
    const clock = formatClock(Date.now() - started);
    const cp = $("#call-phase"); if (cp && state.callPhase === "active") cp.textContent = clock;
    const mct = $("#mini-call-timer"); if (mct) mct.textContent = clock;
    const cid = state.callId;
    if (!cid) { state._callDeadSeconds = 0; return; }
    const link = mesh.get(cid);
    const alive = link && (link.status === "connected" || link.status === "in-call");
    if (alive) { state._callDeadSeconds = 0; }
    else {
      state._callDeadSeconds = (state._callDeadSeconds || 0) + 1;
      if (state._callDeadSeconds * 1000 >= CALL_DEAD_LINK_TIMEOUT_MS) { closeCallScreen("completed"); return; }
    }
    // P2 — иконка качества связи, раз в 3 секунды (getStats недёшев,
    // раз в секунду было бы избыточно для индикатора на глаз).
    qualityTick++;
    if (alive && link.pc && qualityTick % 3 === 0) updateCallQualityIcon(link.pc);
  }, 1000);
}
let __lastCallQualityRtt = null;
// Следим, идёт ли реально звук в обе стороны (раз в 3 с вместе с индикатором качества). Само по себе это только диагностика —
// «соединение есть, а звука нет» теперь видно в журнале: сколько байт ушло/пришло и на каком этапе остановилось.
// Если входящий звук молчит 9 секунд, один раз пробуем перезапустить ICE.
const __audioWatch = { callId: null, lastIn: -1, lastOut: -1, silentIn: 0, silentOut: 0, kicked: false };
function watchCallAudioFlow(stats) {
  if (__audioWatch.callId !== state.callId) Object.assign(__audioWatch, { callId: state.callId, lastIn: -1, lastOut: -1, silentIn: 0, silentOut: 0, kicked: false });
  let inB = 0, outB = 0, hasIn = false, hasOut = false;
  stats.forEach((r) => {
    const kind = r.kind || r.mediaType;
    if (r.type === "inbound-rtp" && kind === "audio") { hasIn = true; inB += r.bytesReceived || 0; }
    if (r.type === "outbound-rtp" && kind === "audio") { hasOut = true; outB += r.bytesSent || 0; }
  });
  const w = __audioWatch;
  if (hasIn) { w.silentIn = (w.lastIn >= 0 && inB <= w.lastIn) ? w.silentIn + 1 : 0; w.lastIn = inB; }
  if (hasOut) { w.silentOut = (w.lastOut >= 0 && outB <= w.lastOut) ? w.silentOut + 1 : 0; w.lastOut = outB; }
  if (w.silentOut === 3) {
    const l = mesh.get(state.callId);
    etherLog("warn", "[call] звук не уходит собеседнику уже 9 с (исходящих байт: " + outB + "); " + (l && l.audioDebug ? l.audioDebug() : "") + " — беру микрофон заново");
    if (l && l.recoverAudio) l.recoverAudio().then((ok) => { if (ok) l.reInvite(); });
  }
  if (w.silentIn === 3) {
    etherLog("warn", "[call] звук от собеседника не приходит 9 с (входящих байт: " + inB + ")");
    if (!w.kicked) { w.kicked = true; const l = mesh.get(state.callId); if (l) l.reInvite(); }
  }
}
// Подробная строка о качестве звука в журнал (раз в ~15 с): путь, RTT, джиттер, потери, буфер воспроизведения, «замазанные» сэмплы.
// Нужна, чтобы на жалобу «качество не очень, есть задержка» было видно, что именно не так.
let __callStatsTick = 0, __callStatsPrev = null;
const __callStatsInPrev = new Map();
function logCallStats(stats) {
  if (++__callStatsTick % 5 !== 1) return;
  const byId = new Map(); stats.forEach((r) => byId.set(r.id, r));
  let pair = null, inb = null, outb = null, outSum = 0, outN = 0, inGrow = 0;
  stats.forEach((r) => {
    if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) pair = pair && !r.selected ? pair : r;
    const kind = r.kind || r.mediaType;
    if (r.type === "inbound-rtp" && kind === "audio") {
      const prev = __callStatsInPrev.get(r.id), grow = (r.packetsReceived || 0) - (prev || 0);
      __callStatsInPrev.set(r.id, r.packetsReceived || 0);
      if (!inb || grow > inGrow) { inb = r; inGrow = grow; }
    }
    if (r.type === "outbound-rtp" && kind === "audio") { outb = r; outSum += r.bytesSent || 0; outN++; }
  });
  const lt = pair && byId.get(pair.localCandidateId), rt = pair && byId.get(pair.remoteCandidateId);
  const parts = [];
  if (pair) parts.push(`путь ${lt ? lt.candidateType : "?"}/${lt ? (lt.relayProtocol || lt.protocol) : "?"} → ${rt ? rt.candidateType : "?"}, rtt ${Math.round((pair.currentRoundTripTime || 0) * 1000)}мс`);
  if (inb) {
    const jb = inb.jitterBufferEmittedCount ? Math.round(inb.jitterBufferDelay / inb.jitterBufferEmittedCount * 1000) : null;
    const conc = inb.totalSamplesReceived ? Math.round(inb.concealedSamples / inb.totalSamplesReceived * 100) : null;
    parts.push(`вх: джиттер ${Math.round((inb.jitter || 0) * 1000)}мс, потеряно ${inb.packetsLost || 0}/${(inb.packetsReceived || 0) + (inb.packetsLost || 0)}` + (jb != null ? `, буфер ${jb}мс` : "") + (conc != null ? `, заглушено ${conc}%` : ""));
  }
  if (outb) {
    let kbps = null;
    if (__callStatsPrev && __callStatsPrev.t < outb.timestamp && outSum >= __callStatsPrev.b) kbps = Math.round((outSum - __callStatsPrev.b) * 8 / (outb.timestamp - __callStatsPrev.t));
    __callStatsPrev = { t: outb.timestamp, b: outSum };
    parts.push("исх" + (kbps != null ? ` ${kbps} кбит/с` : "") + (outN > 1 ? ` (потоков ${outN})` : ""));
  }
  const lk = state.callId && mesh.get(state.callId);
  if (lk && lk.audioDebug) parts.push(lk.audioDebug());
  if (parts.length) etherLog("info", "[call-stats] " + parts.join("; "));
}
async function updateCallQualityIcon(pc) {
  const icon = $("#call-quality-icon"); if (!icon) return;
  try {
    const stats = await pc.getStats();
    if (!state.callId) return; // звонок завершился, пока ждали статистику
    let rttMs = null, lossRatio = 0;
    stats.forEach((s) => {
      if (s.type === "candidate-pair" && s.state === "succeeded" && typeof s.currentRoundTripTime === "number") {
        rttMs = s.currentRoundTripTime * 1000;
      }
      if (s.type === "inbound-rtp" && typeof s.packetsLost === "number" && typeof s.packetsReceived === "number" && s.packetsReceived + s.packetsLost > 0) {
        lossRatio = Math.max(lossRatio, s.packetsLost / (s.packetsReceived + s.packetsLost));
      }
    });
    __lastCallQualityRtt = rttMs;
    try { watchCallAudioFlow(stats); } catch (e) {}
    try { logCallStats(stats); } catch (e) {}
    let level = "good";
    if (rttMs == null) { icon.classList.add("hidden"); return; }
    if (rttMs > 300 || lossRatio > 0.08) level = "poor";
    else if (rttMs > 150 || lossRatio > 0.03) level = "medium";
    icon.classList.remove("hidden", "quality-good", "quality-medium", "quality-poor");
    icon.classList.add("quality-" + level);
    icon.title = T("call.quality." + level) + (rttMs ? ` (${Math.round(rttMs)} ms)` : "");
  } catch (e) { /* getStats недоступен/звонок закрылся между тиком и ответом — не страшно, следующий тик попробует снова */ }
}

// Системные сообщения обо ВСЕХ звонках — в обе стороны.
function systemMessageForCall(rec, reason) {
  if (!rec) return null;
  const isOut = rec.direction === "out";
  if (reason === "completed" && rec.answeredAt) {
    const d = formatDuration(rec.durationMs || 0);
    return { key: isOut ? "calls.systemCompletedOut" : "calls.systemCompletedIn", params: { duration: d } };
  }
  // собеседник сбросил звонок до ответа: для входящего это пропущенный, для исходящего — отмена (раньше сообщения не было вовсе)
  if (reason === "completed" && !rec.answeredAt) return { key: isOut ? "calls.cancelled" : "calls.missed" };
  if (reason === "missed") return { key: isOut ? "calls.noAnswer" : "calls.missed" };
  if (reason === "cancelled") return { key: rec.noAnswer ? "calls.noAnswer" : "calls.cancelled" };
  if (reason === "declined") return { key: "calls.declined" };
  if (reason === "busy") return { key: "calls.busy" };
  if (reason === "failed") return { key: "calls.failed" };
  return null;
}

// Голосовая почта: исходящий звонок не дозвонился (отклонён, занято, нет ответа) — предлагаем сразу оставить голосовое сообщение;
// оно доставится обычным путём, в том числе офлайн.
async function offerVoicemail(contactId) {
  const c = state.contacts.get(contactId);
  if (!c || c.isGroup || c.isSelf || c.blocked) return;
  if (!(await confirmSheet(T("call.voicemail.ask", { name: c.name || T("sys.someone") })))) return;
  if (typeof resetChatTransientState === "function") resetChatTransientState(contactId);
  state.tab = "chats"; state.chatId = contactId; state.contactCardId = null; renderTab();
  setTimeout(() => { try { startVoiceRecording(); } catch (e) {} }, 150);
}
function closeCallScreen(reason, opts) {
  const rec = state.currentCallRecord;
  if (rec && opts && opts.noAnswer) rec.noAnswer = true; // «не ответили» — отдельный случай: в чате «Нет ответа» и предложение голосовой почты
  const voicemailFor = rec && !(opts && opts.localError) && rec.direction === "out" && (["declined", "busy", "missed", "failed"].includes(reason) || (reason === "cancelled" && opts && opts.noAnswer)) && !rec.answeredAt ? rec.contactId : null;
  if (voicemailFor) setTimeout(() => offerVoicemail(voicemailFor), 700);
  clearInterval(callTimerInterval); callTimerInterval = null;
  const qIcon = $("#call-quality-icon"); if (qIcon) qIcon.classList.add("hidden");
  state._callDeadSeconds = 0;
  state._callAcceptInFlight = false;
  state._callUserAccepted = false;
  state._callMuteOnAnswer = false;
  state.callWantsVideo = false;
  releaseWakeLock();
  clearPendingCall();
  stopRingtone();
  stopCallSounds();
  hideCallVideo();
  clearCallNotices();
  { const sfb = $("#call-sound-fix-btn"); if (sfb) sfb.classList.add("hidden"); }
  endCallRecord(reason);
  const cs = $("#call-screen"); if (cs) cs.classList.add("hidden");
  const contentEl = $("#content"); if (contentEl) contentEl.classList.remove("hidden");
  const miniBar = $("#mini-call-bar"); if (miniBar) miniBar.classList.add("hidden");
  const cm = $("#call-mute-btn"); if (cm) cm.classList.remove("active");
  const spkBtn = $("#call-speaker-btn"); if (spkBtn) spkBtn.classList.remove("active");
  speakerOn = false;
  try { if (navigator.audioSession) navigator.audioSession.type = "auto"; } catch (e) {}
  const lbl = $("#call-mute-label"); if (lbl) lbl.textContent = T("call.mute");
  if (state.callId) {
    pendingRemoteStreams.delete(state.callId);
    // attachRemoteAudio() создаёт <audio id="remote-audio-*"> с живым
    // srcObject и никогда его не удаляла — раньше элемент чистился только
    // при deleteContact(). За много звонков подряд накапливались висящие
    // DOM-узлы и MediaStream'ы.
    const audioEl = document.getElementById("remote-audio-" + state.callId);
    if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl.srcObject = null; audioEl.remove(); }
  }
  state.callId = null;
  state.callPhase = null;
  if (state.tab === "chats" && state.chatsSegment === "calls") renderCallsList();
  // Защита от повторного рингтона. Если у собеседника ещё не отработал
  // call-ended (сеть мигнула, сигнал не дошёл) — он при пересогласовании
  // WebRTC снова пришлёт call-state:ringing. Запоминаем, что звонок
  // только что завершён, и будем игнорировать такие пакеты 15 секунд.
  if (rec && rec.contactId) {
    recentlyEndedCalls.set(rec.contactId, Date.now());
    // Самоочистка по таймеру — раньше запись пропадала только "заодно",
    // при завершении СЛЕДУЮЩЕГО звонка (см. ниже). Если после этого
    // звонка приложение час провисит без единого нового звонка, старая
    // запись просто висела в Map (безвредно, но мусор). setTimeout
    // гарантирует уборку независимо от того, будут ли ещё звонки.
    const ccid = rec.contactId;
    setTimeout(() => {
      const ts = recentlyEndedCalls.get(ccid);
      if (ts && Date.now() - ts >= RECENTLY_ENDED_CALL_MS) recentlyEndedCalls.delete(ccid);
    }, RECENTLY_ENDED_CALL_MS + 100);
    // и всё равно почистим попутно старые записи от других контактов,
    // чтобы не ждать их собственных таймеров без необходимости.
    const now = Date.now();
    for (const [id, ts] of recentlyEndedCalls) {
      if (now - ts > RECENTLY_ENDED_CALL_MS) recentlyEndedCalls.delete(id);
    }
  }

  if (rec && rec.contactId) {
    const c = state.contacts.get(rec.contactId);
    if (c) {
      const sysMsg = systemMessageForCall(rec, reason);
      if (sysMsg) {
        c.messages.push({ id: crypto.randomUUID(), from: "system", text: T(sysMsg.key, sysMsg.params), textKey: sysMsg.key, textParams: sysMsg.params, ts: Date.now() });
        trimMessages(c);
        c.lastActivity = Date.now();
        persistContacts();
        if (state.chatId === rec.contactId) renderChatThread();
        if (state.tab === "chats") renderChatsList();
      }
    }
  }
}
// Жесты экрана звонка. Звонок НИКОГДА не завершается жестом: свайп вправо/«назад» (в браузере/PWA это навигация «назад» с выгрузкой
// страницы, а pagehide/beforeunload завершают звонок) гасится историей-«якорем» и только сворачивает звонок; свайп вверх — сворачивает.
function armCallBackGuard() { try { history.pushState({ etherCallGuard: 1 }, "", location.href); } catch (e) {} }
function wireCallGestures() {
  const cs = $("#call-screen");
  if (cs && !cs.dataset.gestures) {
    cs.dataset.gestures = "1";
    let x0 = 0, y0 = 0, track = false;
    cs.addEventListener("touchstart", (e) => {
      track = false;
      if (!e.touches || e.touches.length !== 1) return;
      const t = e.target;
      if (t && t.closest && t.closest("button, input, a, canvas, .call-more-menu")) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; track = true;
    }, { passive: true });
    cs.addEventListener("touchend", (e) => {
      if (!track) return; track = false;
      const t = e.changedTouches && e.changedTouches[0]; if (!t) return;
      const dx = t.clientX - x0, dy = t.clientY - y0;
      if (dy < -80 && Math.abs(dx) < Math.abs(dy) * 0.7 && state.callId && state.callPhase !== "ringing") { try { haptic("light"); } catch (er) {} minimizeCallScreen(); }
    }, { passive: true });
  }
  if (!wireCallGestures._pop) {
    wireCallGestures._pop = true;
    window.addEventListener("popstate", () => {
      if (!state.callId) return;
      armCallBackGuard(); // «назад» израсходовал якорь — ставим новый, звонок не трогаем
      const c = $("#call-screen");
      if (c && !c.classList.contains("hidden")) { if (state.callPhase !== "ringing") minimizeCallScreen(); }
      else if (state.chatId) { try { closeChatSafely(); } catch (e) {} }
      else if (state.contactCardId) { try { closeContactCardSafely(); } catch (e) {} }
    });
  }
}
// Меню «ещё» в звонке: кнопка «⋯» видна, только когда в меню есть хотя бы один видимый пункт (показ экрана, рисование на видео).
function wireCallMoreMenu() {
  const btn = $("#call-more-btn"), menu = $("#call-more-menu");
  if (!btn || !menu || btn.dataset.wired) return;
  btn.dataset.wired = "1";
  const sync = () => {
    const any = Array.from(menu.querySelectorAll(".call-menu-item")).some((b) => !b.classList.contains("hidden"));
    if (btn.classList.contains("hidden") === any) btn.classList.toggle("hidden", !any);
    // add() на уже скрытом меню всё равно пишет атрибут → MutationObserver вызывает sync снова (бесконечный цикл)
    if (!any && !menu.classList.contains("hidden")) { menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); }
  };
  const close = () => { menu.classList.add("hidden"); btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", () => { const open = menu.classList.contains("hidden"); menu.classList.toggle("hidden", !open); btn.setAttribute("aria-expanded", open ? "true" : "false"); });
  menu.addEventListener("click", (e) => { if (e.target.closest(".call-menu-item")) close(); });
  document.addEventListener("pointerdown", (e) => { if (!menu.classList.contains("hidden") && !menu.contains(e.target) && !btn.contains(e.target)) close(); }, true);
  try { new MutationObserver(sync).observe(menu, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] }); } catch (e) {}
  sync();
}
function wireCallScreen() {
  wireCallMoreMenu();
  wireCallAudioResilience();
  wireCallGestures();
  const minimizeBtn = $("#call-minimize-btn");
  if (minimizeBtn) minimizeBtn.addEventListener("click", () => minimizeCallScreen());
  const miniBar = $("#mini-call-bar");
  if (miniBar) miniBar.addEventListener("click", () => restoreCallScreen());
  const hangup = $("#call-hangup-btn");
  if (hangup) hangup.addEventListener("click", () => {
    const cid = state.callId;
    const link = mesh.get(cid);
    if (link) {
      // mesh.remove(cid) тут был лишним и единственным местом, где он
      // вызывается после завершения звонка — endCall() уже сам корректно
      // восстанавливает status в "connected", если data channel остался
      // открыт. Разрыв mesh-связи здесь означал, что после КАЖДОГО
      // исходящего "отбоя" P2P рвался без причины: следующее сообщение
      // уходило через сервер, а scheduleAutoConnect пересобирал связь
      // заново через 4 секунды — пользователь видел это как "после
      // звонка связь на секунду пропала".
      try { link.endCall(); } catch (e) {}
    }
    if (signaling && signaling.connected && cid) signaling.signal(cid, { t: "call-ended" });
    stopRingtone();
    closeCallScreen(state.currentCallRecord && state.currentCallRecord.answeredAt ? "completed" : "cancelled");
  });
  const mute = $("#call-mute-btn");
  if (mute) mute.addEventListener("click", () => {
    const link = mesh.get(state.callId);
    const muted = !mute.classList.contains("active");
    if (link) link.setMuted(muted);
    mute.classList.toggle("active", muted);
    const lbl = $("#call-mute-label");
    if (lbl) lbl.textContent = muted ? T("call.mute.off") : T("call.mute");
  });
  const videoBtn = $("#call-video-btn");
  if (videoBtn) videoBtn.addEventListener("click", async () => {
    const link = mesh.get(state.callId); if (!link) return;
    const turningOn = !videoBtn.classList.contains("active");
    if (turningOn) {
      const ok = await link.enableVideo();
      if (ok) { state.callWantsVideo = true; showLocalVideoPreview(link); requestWakeLock(); }
      else toast(T("toast.videoNoCamera"));
    } else {
      // Если в этот момент шёл показ экрана — localVideoTrack сейчас это
      // трек ЭКРАНА, не камеры; disableVideo() просто бы заморозил
      // последний кадр показа (enabled=false), не остановив захват, и
      // кнопка screen-share осталась бы залипшей в активном состоянии.
      // Останавливаем показ целиком, а не просто гасим трек.
      if (link._screenSharing) {
        await link.stopScreenShare();
        const ssBtn = $("#call-screenshare-btn"); if (ssBtn) ssBtn.classList.remove("active");
      } else {
        link.disableVideo();
      }
      const lv = $("#call-local-video"); if (lv) { lv.classList.add("hidden"); lv.srcObject = null; }
      videoBtn.classList.remove("active");
      syncCallVideoState(); // без видео собеседника возвращается обычный фон звонка с аватаром, а не чёрный экран
      // Оверлей (flip+PiP) прячем только если и удалённого видео тоже
      // нет — пользователь мог выключить СВОЮ камеру, но продолжать
      // смотреть видео собеседника (PiP по-прежнему осмысленен, flip
      // своей камеры — нет, но прятать весь контейнер по отдельности
      // сложнее и не нужно: без видео вообще оверлей всё равно скрыт).
      const rv = $("#call-remote-video");
      const remoteActive = rv && rv.srcObject && !rv.classList.contains("hidden");
      const overlays = $("#call-video-overlays");
      if (!remoteActive && overlays) overlays.classList.add("hidden");
      // Видео выключено (но звонок продолжается) — экран больше не
      // обязан гореть сам по себе, отдаём управление системе (на
      // Android это снова уход в сон через её собственный таймаут).
      releaseWakeLock();
    }
  });
  // Screen sharing (раздел 7 роадмапа) — кнопка показывается только если
  // браузер реально поддерживает getDisplayMedia (не через CSS-медиа-
  // запрос, который ничего не знает о реальном API; заметнее всего это
  // отсутствие поддержки в iOS Safari — там кнопка остаётся скрытой).
  const screenShareBtn = $("#call-screenshare-btn");
  if (screenShareBtn) {
    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) screenShareBtn.classList.remove("hidden");
    screenShareBtn.addEventListener("click", async () => {
      const link = mesh.get(state.callId); if (!link) return;
      if (screenShareBtn.classList.contains("active")) {
        await link.stopScreenShare();
        screenShareBtn.classList.remove("active");
        { const cs0 = $("#call-screen"); if (cs0) cs0.classList.remove("sharing"); }
        updateCallButtonsSupport();
      } else {
        const ok = await link.startScreenShare();
        if (ok) {
          screenShareBtn.classList.add("active");
          { const cs0 = $("#call-screen"); if (cs0) cs0.classList.add("sharing"); }
          // Видео теперь точно есть (экран) — показываем локальный превью/
          // оверлеи и держим экран включённым, как и при обычном enableVideo().
          showLocalVideoPreview(link);
          requestWakeLock();
          const videoBtn = $("#call-video-btn"); if (videoBtn) videoBtn.classList.add("active");
          toast(T("call.screenSharing"));
        } else {
          toast(T("toast.screenShareFailed"));
        }
      }
    });
  }
  // Оверлеи на своём видео: flip камеры + PiP. Раньше это были три
  // отдельные кнопки в основном ряду управления звонком вперемешку с
  // микрофоном/громкой связью/завершением (#call-switch-camera-btn,
  // #call-pip-btn) плюс отдельный #call-flip-overlay-btn поверх видео —
  // теперь единый контейнер-оверлей над превью (#call-video-overlays,
  // см. showLocalVideoPreview/hideCallVideo), основной ряд всегда из 4
  // кнопок.
  const flipOverlayBtn = $("#call-flip-overlay-btn");
  if (flipOverlayBtn) flipOverlayBtn.addEventListener("click", () => {
    const link = mesh.get(state.callId);
    if (link) link.switchCamera();
  });
  // P2.36 — Picture-in-Picture: веб-API, не нужна нативная обёртка, но
  // неравномерная поддержка (надёжно в Chrome/Edge, частично в iOS
  // Safari через webkitSetPresentationMode). Кнопка в оверлее теперь
  // видна всегда (а не скрывается через pipSupported(), как раньше
  // #call-pip-btn) — на неподдерживающем устройстве клик просто
  // показывает toast вместо тихого no-op/скрытой кнопки.
  const pipOverlayBtn = $("#call-pip-overlay-btn");
  if (pipOverlayBtn) pipOverlayBtn.addEventListener("click", async () => {
    if (!pipSupported()) { toast(T("toast.pipUnsupported")); return; }
    // В PiP выносим именно удалённое видео (посмотреть на собеседника,
    // переключившись в другое приложение) — если его ещё нет (например,
    // идёт дозвон и показан только свой превью), используем локальное
    // как резервный вариант, чтобы кнопка не была no-op.
    const rv = $("#call-remote-video");
    const lv = $("#call-local-video");
    const v = (rv && rv.srcObject && !rv.classList.contains("hidden")) ? rv : lv;
    if (!v || !v.srcObject) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      } else if (v.webkitSetPresentationMode) {
        // Старый Safari/iOS путь — у него нет requestPictureInPicture(),
        // а есть webkitSetPresentationMode("picture-in-picture"|"inline").
        v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
      }
    } catch (e) { etherLog("warn", "[call] PiP failed:", String(e)); }
  });
  const speakerBtn = $("#call-speaker-btn");
  if (speakerBtn) speakerBtn.addEventListener("click", () => toggleSpeaker());
  const accept = $("#call-accept-btn");
  if (accept) accept.addEventListener("click", () => acceptCall(false));
  const muteAccept = $("#call-mute-accept-btn");
  if (muteAccept) muteAccept.addEventListener("click", () => acceptCall(true));
  const decline = $("#call-decline-btn");
  if (decline) decline.addEventListener("click", () => {
    const cid = state.callId;
    const link = mesh.get(cid); if (link) link.declineCall();
    if (signaling && signaling.connected && cid) signaling.signal(cid, { t: "call-declined" });
    stopRingtone();
    closeCallScreen("declined");
  });
  const vs = $("#call-volume-slider");
  if (vs) {
    vs.value = String(Store.callVolume);
    vs.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      Store.callVolume = v;
      const cid = state.callId;
      if (cid) {
        applyCallVolume(cid, v);
      }
    });
  }
  // flip-камеры и PiP (#call-flip-overlay-btn/#call-pip-overlay-btn)
  // уже подключены выше, вместе с остальными кнопками оверлея — второй
  // отдельный addEventListener на ту же кнопку flip здесь раньше был
  // дублем (навешивал второй идентичный обработчик при каждом вызове
  // wireCallScreen).
}

async function acceptCall(withMute) {
  { const ci = state.callId && state.contacts.get(state.callId);
    if (ci && Store.requireVerifiedCalls && !isContactVerified(ci)) { toast(T("call.needVerifyIncoming", { name: ci.name || T("sys.someone") })); return; } }
  if (state._callUserAccepted) return;
  if (state._callAcceptInFlight) return;
  const cid = state.callId;
  if (!cid) return;
  state._callAcceptInFlight = true;
  state._callUserAccepted = true;
  state._callMuteOnAnswer = !!withMute;

  try {
    stopRingtone();
    const c = state.contacts.get(cid);
    const link = mesh.get(cid);

    if (link && (link.status === "connected" || link.status === "in-call")) {
      try {
        await link.answerCall(state.callWantsVideo);
        if (state.callId !== cid) { try { link.endCall(); } catch (x) {} return; } // за время запроса микрофона звонок закончился
        // Серверный call-accepted шлём ТОЛЬКО после успешного answerCall.
        if (signaling && signaling.connected) {
          try { signaling.signal(cid, { t: "call-accepted" }); } catch (e) {}
        }
        if (state.callWantsVideo) { showLocalVideoPreview(link); requestWakeLock(); }
        if (withMute) {
          link.setMuted(true);
          const mb = $("#call-mute-btn");
          if (mb) {
            mb.classList.add("active");
            const lbl = $("#call-mute-label");
            if (lbl) lbl.textContent = T("call.mute.off");
          }
        }
        setCallPhaseActive();
      } catch (e) {
        etherLog("error", "[call] answerCall failed:", String(e));
        const name = e && e.name;
        if (name === "NotAllowedError" || name === "PermissionDeniedError") toast(T("toast.callPermissionDenied"));
        else if (name === "NotFoundError" || name === "DevicesNotFoundError") toast(T("toast.voiceNoMic"));
        else toast(T("calls.failed"));
        state._lastCallFailedAt = Date.now();
        closeCallScreen("failed");
        return;
      }
      return;
    }
    // P2P ещё нет (экран «входящий» открылся по серверному приглашению или по нажатию на push, а соединение
    // с звонящим ещё строится). Раньше без линка звонок сразу «не удался», хотя звонящий продолжал звонить.
    // Теперь показываем «Соединение…», подталкиваем подключение и ждём "connected" в wireMeshEvents (там уйдёт answerCall).
    const cp = $("#call-phase"); if (cp) cp.textContent = T("call.connecting");
    const ci = $("#call-controls-incoming"); if (ci) ci.classList.add("hidden");
    const ca = $("#call-controls-active"); if (ca) ca.classList.remove("hidden");
    const iShouldOffer = myIdFor(cid) < cid;
    if (signaling && signaling.connected) {
      if (!link || link.status === "disconnected") attemptConnect(cid, iShouldOffer);
    } else {
      waitForSignaling(CALL_SERVER_WAIT_MS).then((ok) => { if (ok && state.callId === cid && state._callUserAccepted && state.callPhase !== "active") attemptConnect(cid, iShouldOffer); });
    }
    clearPendingCall();
    pendingCall.contactId = cid;
    pendingCall.timer = setTimeout(() => {
      if (state.callId !== cid || state.callPhase === "active") return;
      etherLog("warn", "[call] принятый звонок: P2P не поднялся за " + (CALL_ACCEPT_CONNECT_MS / 1000) + " с");
      try { const l = mesh.get(cid); if (l) l.endCall(); } catch (e) {}
      if (signaling && signaling.connected) { try { signaling.signal(cid, { t: "call-ended" }); } catch (e) {} }
      toast(T("calls.failed"));
      state._lastCallFailedAt = Date.now();
      closeCallScreen("failed");
    }, CALL_ACCEPT_CONNECT_MS);
  } catch (e) {
    etherLog("error", "[call] accept handler failed:", String(e));
  } finally {
    state._callAcceptInFlight = false;
  }
}

// =====================================================================
// Pull-to-refresh (список чатов)
// =====================================================================
// Тянем список чатов вниз от самого верха скролла → flushOutbox()
// (досылает застрявшие исходящие) + initSignaling() (переподключение
// к сигнальному серверу). Чисто ручной жест: сервис-воркер и так
// держит соединение, это просто явный способ сказать "попробуй сейчас".
function wirePullToRefresh() {
  const scroller = $("#screen-chats");
  const indicator = $("#chats-ptr");
  if (!scroller || !indicator) return;
  const PTR_TRIGGER_PX = 56;
  const PTR_MAX_PX = 72;
  let startY = 0, pulling = false, refreshing = false;
  scroller.addEventListener("touchstart", (e) => {
    if (refreshing || scroller.scrollTop > 0) { pulling = false; return; }
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  scroller.addEventListener("touchmove", (e) => {
    if (!pulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || scroller.scrollTop > 0) { indicator.style.height = "0px"; return; }
    indicator.style.height = Math.min(dy * 0.6, PTR_MAX_PX) + "px";
  }, { passive: true });
  scroller.addEventListener("touchend", () => {
    if (!pulling || refreshing) return;
    pulling = false;
    const h = parseFloat(indicator.style.height) || 0;
    if (h >= PTR_TRIGGER_PX) {
      refreshing = true;
      indicator.style.height = PTR_TRIGGER_PX + "px";
      haptic("light");
      try { flushOutbox(); } catch (e) {}
      try { initSignaling(); } catch (e) {}
      setTimeout(() => { indicator.style.height = "0px"; refreshing = false; }, 700);
    } else {
      indicator.style.height = "0px";
    }
  });
}

// =====================================================================
// Кастомные папки чатов (раздел 4 роадмапа) — именованные наборы чатов
// (прямых и групповых), доступные как дополнительные чипы в
// #chat-filters рядом с All/Unread/Groups/Direct/Calls. Папка — это
// именно НАБОР конкретных чатов, а не динамическое правило — ближе к
// "альбомам" iOS Photos, чем к сложным Telegram-папкам с комбинацией
// критериев; для первой версии этого достаточно и не требует нового
// языка правил.
let __folderEditingId = null; // null = создаём новую, иначе редактируем существующую
function renderChatFolderChips() {
  const host = $("#chat-filters-custom");
  if (!host) return;
  host.innerHTML = state.folders.map((f) => `
    <button type="button" class="chat-filter-chip" data-filter="folder:${escapeHtml(f.id)}">${escapeHtml(truncate(f.name, 18))}</button>
  `).join("");
  // Клик вешаем здесь же (а не через делегирование на #chat-filters),
  // потому что остальные статичные чипы уже вешают свой обработчик в
  // wireSearchHandlers() при старте — для динамических он должен
  // переустанавливаться при каждом перерендере списка чипов.
  host.querySelectorAll(".chat-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $$("#chat-filters .chat-filter-chip").forEach((b) => b.classList.toggle("active", b === chip));
      state.chatsSegment = "chats";
      state.chatFilter = chip.dataset.filter;
      renderTab(); // из «Звонков» нужно заново показать список чатов, а не только перерисовать его скрытым
    });
  });
}
function openFolderManageSheet() {
  const list = $("#folder-manage-list"), empty = $("#folder-manage-empty");
  if (!list) return;
  list.innerHTML = "";
  if (empty) empty.classList.toggle("hidden", state.folders.length > 0);
  for (const f of state.folders) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "forward-row";
    btn.innerHTML = `<span class="global-search-row-text"><span class="global-search-row-title">${escapeHtml(f.name)}</span><span class="global-search-row-subtitle muted">${T("chats.folder.memberCount", { n: f.contactIds.length })}</span></span>`;
    btn.addEventListener("click", () => { const s = $("#folder-manage-sheet"); if (s) s.classList.add("hidden"); openFolderEditSheet(f.id); });
    list.appendChild(btn);
  }
  const sheet = $("#folder-manage-sheet"); if (sheet) sheet.classList.remove("hidden");
}
function openFolderEditSheet(folderId) {
  __folderEditingId = folderId || null;
  const folder = folderId ? state.folders.find((f) => f.id === folderId) : null;
  const title = $("#folder-edit-title");
  if (title) title.textContent = folder ? folder.name : T("chats.folder.new");
  const nameInput = $("#folder-edit-name");
  if (nameInput) nameInput.value = folder ? folder.name : "";
  const delBtn = $("#folder-edit-delete-btn");
  if (delBtn) delBtn.classList.toggle("hidden", !folder);
  const memberIds = new Set(folder ? folder.contactIds : []);
  const list = $("#folder-edit-member-list");
  if (list) {
    list.innerHTML = "";
    const contacts = Array.from(state.contacts.values()).filter((c) => c.managed && !c.isSelf);
    for (const c of contacts) {
      const row = document.createElement("label");
      row.className = "forward-row";
      row.innerHTML = `${avatarCircleHtml(c, "avatar-sm")}<span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span><input type="checkbox" class="switch folder-member-check" data-contact-id="${escapeHtml(c.id)}" ${memberIds.has(c.id) ? "checked" : ""}>`;
      list.appendChild(row);
    }
  }
  const sheet = $("#folder-edit-sheet"); if (sheet) sheet.classList.remove("hidden");
}
function saveFolderEdit() {
  const nameInput = $("#folder-edit-name");
  const name = (nameInput && nameInput.value || "").trim();
  if (!name) { toast(T("chats.folder.nameRequired")); return; }
  const contactIds = $$("#folder-edit-member-list .folder-member-check:checked").map((el) => el.dataset.contactId);
  if (__folderEditingId) {
    const folder = state.folders.find((f) => f.id === __folderEditingId);
    if (folder) { folder.name = name; folder.contactIds = contactIds; }
  } else {
    state.folders.push({ id: crypto.randomUUID(), name, contactIds });
  }
  persistChatFolders();
  renderChatFolderChips();
  const sheet = $("#folder-edit-sheet"); if (sheet) sheet.classList.add("hidden");
  renderTab();
}
function deleteFolderEdit() {
  if (!__folderEditingId) return;
  // Если удаляемая папка сейчас активна как фильтр — откатываемся на
  // "Все", иначе список чатов тихо остался бы отфильтрован по id папки,
  // которой больше не существует (state.folders.find вернёт undefined,
  // и renderChatsList покажет пустой список без всякого объяснения).
  if (state.chatFilter === "folder:" + __folderEditingId) state.chatFilter = "all";
  state.folders = state.folders.filter((f) => f.id !== __folderEditingId);
  persistChatFolders();
  renderChatFolderChips();
  __folderEditingId = null;
  const sheet = $("#folder-edit-sheet"); if (sheet) sheet.classList.add("hidden");
  renderTab();
}
function wireChatFolders() {
  renderChatFolderChips();
  const addBtn = $("#chat-folder-add-btn");
  if (addBtn) addBtn.addEventListener("click", openFolderManageSheet);
  const createBtn = $("#folder-create-btn");
  if (createBtn) createBtn.addEventListener("click", () => { const s = $("#folder-manage-sheet"); if (s) s.classList.add("hidden"); openFolderEditSheet(null); });
  const saveBtn = $("#folder-edit-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", saveFolderEdit);
  const delBtn = $("#folder-edit-delete-btn");
  if (delBtn) delBtn.addEventListener("click", deleteFolderEdit);
}

