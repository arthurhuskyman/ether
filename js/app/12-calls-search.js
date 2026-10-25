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
function persistCallLog() { if (state.guestMode) return; /* гость link-call: ничего не сохраняем */ try { Store.callLogJson = JSON.stringify(state.callLog.slice(-MAX_CALL_LOG)); } catch (e) { handlePersistError(e, "callLog"); } }
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
  startCallEscalation(id); // через 20 с без ответа — «Позвать другим способом» / «Оставить голосовое» / «Позвонить ещё раз»

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
        signaling.signal(id, { t: "call-invite", n: Store.name, x: crypto.randomUUID(), video: !!withVideo });
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
  const invite = { t: "call-invite", n: Store.name, x: crypto.randomUUID(), video: !!withVideo };
  signaling.signal(id, invite);
  const phaseEl = $("#call-phase");
  if (phaseEl) phaseEl.textContent = state._peerRinging ? T("call.peerRinging") : T("call.dialing");

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
  try { if (typeof prewarmCallIce === "function") prewarmCallIce(); } catch (e) {}
  if (state.callId !== id) {
    state._callUserAccepted = false;
    state._callAcceptInFlight = false;
    state._callMuteOnAnswer = false;
    clearCallNotices();
    armCallBackGuard();
    speakerOn = false; // новый звонок всегда начинается с внутреннего динамика
  }
  // Маршрут звука iOS: пока ИДЁТ ВХОДЯЩИЙ ВЫЗОВ, нужен "playback" (динамик, громко). Раньше тут всегда ставился "play-and-record" —
  // он уводит ВСЁ воспроизведение в разговорный динамик (у уха), и рингтон на iPhone «пропадал». В "play-and-record" переходим
  // при ответе (acceptCall) — до запроса микрофона.
  if (phase === "ringing") setCallAudioSession("playback");
  else if (state.callId !== id) setCallAudioSession("play-and-record");
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
  const cp = $("#call-phase"); if (cp) cp.textContent = phase === "calling" ? T("call.dialing") : phase === "ringing" ? T("call.incoming") : T("call.active");
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
  clearCallEscalation();
  state.callPhase = "active";
  state._callUserAccepted = true;
  clearPendingCall();
  stopCallSounds();
  setCallAudioSession(speakerOn ? "playback" : "play-and-record");
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
  watchRemoteTracks(id, stream);
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
// Входящий трек получил unmute (iOS вернул звук после прерывания / пошли пакеты) — гарантируем, что <audio> и контекст живы.
function watchRemoteTracks(id, stream) {
  try {
    for (const t of stream.getAudioTracks()) {
      if (t.__etherWatched || typeof t.addEventListener !== "function") continue;
      t.__etherWatched = true;
      t.addEventListener("unmute", () => { if (state.callId === id) resumeCallAudio("remote-unmute"); });
    }
  } catch (e) {}
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
  if (state.callPhase !== "ringing") { try { if (navigator.audioSession && !speakerOn && navigator.audioSession.type !== "play-and-record") navigator.audioSession.type = "play-and-record"; } catch (e) {} }
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
  try { callQualityStart(); } catch (e) {}
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
// Адаптивное качество 1:1 (js/callquality.js): цикл в PeerLink раз в 2 с; здесь только подписка на события, плашки и отчёт.
let __cqLink = null, __cqReport = null;
function callQualityStart() {
  const CQ = window.EtherCallQuality, link = state.callId && mesh.get(state.callId);
  if (!CQ || !link || typeof link.startQuality !== "function") return;
  if (__cqLink === link && link._qTimer) return;
  __cqLink = link;
  __cqReport = Store.callReport ? CQ.createReport() : null;
  if (!link.__cqWired) {
    link.__cqWired = true;
    link.addEventListener("quality", (ev) => {
      if (link !== __cqLink) return;
      const d = ev.detail || {};
      if (d.audioOnly) setCallNotice("quality", T("call.quality.audioOnly"));
      else if (d.restored && !d.audioOnly) setCallNotice("quality", d.level === 0 ? null : T("call.quality.reduced"));
      else if (d.level > 0) setCallNotice("quality", T("call.quality.reduced"));
      else setCallNotice("quality", null);
      if (d.audioOnly) toast(T("call.quality.audioOnly"));
      else if (d.restored && d.level === 0) toast(T("call.quality.restored"));
    });
    link.addEventListener("remote-quality", (ev) => {
      if (link !== __cqLink) return;
      setCallNotice("rquality", ev.detail && ev.detail.audioOnly ? T("call.quality.remoteAudioOnly") : null);
    });
    link.addEventListener("ice-connection-state", (ev) => {
      const s = ev.detail && ev.detail.state;
      if (__cqReport && link === __cqLink && (s === "disconnected" || s === "failed")) __cqReport.reconnects++;
    });
  }
  link.startQuality({ report: __cqReport });
}
function callQualityStop() {
  const link = __cqLink, rep = __cqReport; __cqLink = null; __cqReport = null;
  setCallNotice("quality", null); setCallNotice("rquality", null);
  if (link && typeof link.stopQuality === "function") link.stopQuality();
  if (!rep || !window.EtherCallQuality) return;
  const CQ = window.EtherCallQuality, sum = CQ.summarizeReport(rep);
  if (sum.verdict === "unknown") return;
  window.__lastCallReport = { json: CQ.reportToJson(rep), summary: sum };
  try { localStorage.setItem("ether.lastCallReport", window.__lastCallReport.json); } catch (e) {}
  toast(callReportText(sum));
}
// Простыми словами: «Звук отличный. Задержка 40 мс, потерь 0%.»
function callReportText(sum) {
  let t = T("callreport.v." + sum.verdict) + ". " + T("callreport.detail", { rtt: sum.rttMedianMs == null ? "?" : sum.rttMedianMs, loss: sum.lossAvgPct });
  if (sum.audioOnlyUsed) t += " " + T("callreport.audioOnlyUsed");
  else if (sum.videoDegraded) t += " " + T("callreport.videoReduced");
  if (sum.path === "relay") t += " " + T("callreport.relay");
  return t;
}
function exportCallReport() {
  let json = window.__lastCallReport && window.__lastCallReport.json;
  if (!json) { try { json = localStorage.getItem("ether.lastCallReport"); } catch (e) {} }
  if (!json) { toast(T("callreport.none")); return; }
  downloadBlob(new Blob([json], { type: "application/json" }), "ether-call-report.json");
}
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
  watchCallAudioAct(w, inB, outB);
}
// Решения сторожа (вынесены для тестов). silentOut/silentIn — число подряд идущих замеров (≈3 с) без прироста байт.
// Исходящее: чиним на 3-м замере и повторяем каждые 6 (раньше — один раз: при неудаче в фоне звук молчал до конца звонка).
// Не трогаем, если микрофон выключен пользователем, приложение в фоне (getUserMedia не даст трек) или идёт видео-замена.
// Входящее: сперва дешёвые меры (звук/<audio>), потом один перезапуск ICE; если собеседник сам сообщил «микрофон приостановлен» — ждём его.
function watchCallAudioAct(w, inB, outB) {
  const id = state.callId, l = id && mesh.get(id);
  if (!l) return;
  if (w.silentOut >= 3 && (w.silentOut - 3) % 6 === 0 && !l._muted && !document.hidden) {
    etherLog("warn", "[call] звук не уходит собеседнику уже " + (w.silentOut * 3) + " с (исходящих байт: " + outB + "); " + (l.audioDebug ? l.audioDebug() : "") + " — беру микрофон заново");
    if (l.recoverAudio) l.recoverAudio().then((ok) => { if (ok && l.reInvite) l.reInvite(); });
  }
  if (w.silentIn >= 2 && w.silentIn < 3) resumeCallAudio("watchdog");
  if (w.silentIn === 3 && !__callNotices.has("peerMic")) {
    etherLog("warn", "[call] звук от собеседника не приходит 9 с (входящих байт: " + inB + ")");
    if (!w.kicked) { w.kicked = true; if (l.reInvite) l.reInvite(); }
  }
  // байты идут, а <audio> стоит (прерывание без события pause, потерянный srcObject) — запускаем
  if (w.silentIn === 0) {
    const el = document.getElementById("remote-audio-" + id);
    if (el && !document.hidden && (el.paused || (!el.srcObject && el._relayStream))) resumeCallAudio("watchdog");
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
  clearCallEscalation();
  state._peerRinging = false;
  const lcId = isLinkCallId(state.callId) ? state.callId : null; // link-call: виртуального собеседника убираем после завершения
  const rec = state.currentCallRecord;
  if (rec && opts && opts.noAnswer) rec.noAnswer = true; // «не ответили» — отдельный случай: в чате «Нет ответа» и предложение голосовой почты
  const voicemailFor = rec && !(opts && opts.localError) && rec.direction === "out" && (["declined", "busy", "missed", "failed"].includes(reason) || (reason === "cancelled" && opts && opts.noAnswer)) && !rec.answeredAt ? rec.contactId : null;
  if (voicemailFor) setTimeout(() => offerVoicemail(voicemailFor), 700);
  clearInterval(callTimerInterval); callTimerInterval = null;
  try { callQualityStop(); } catch (e) {}
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
  if (lcId) setTimeout(() => { try { linkCallAfterCall(lcId); } catch (e) { etherLog("warn", "[linkcall] " + String(e)); } }, 0);
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
  try { wireCallAlternatives(); } catch (e) { etherLog("warn", "[call] alternatives: " + String(e)); }
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

function setCallAudioSession(type) {
  try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch (e) {}
}
async function acceptCall(withMute) {
  { const ci = state.callId && state.contacts.get(state.callId);
    if (ci && !ci.ephemeral && Store.requireVerifiedCalls && !isContactVerified(ci)) { toast(T("call.needVerifyIncoming", { name: ci.name || T("sys.someone") })); return; } }
  if (state._callUserAccepted) return;
  if (state._callAcceptInFlight) return;
  const cid = state.callId;
  if (!cid) return;
  state._callAcceptInFlight = true;
  state._callUserAccepted = true;
  state._callMuteOnAnswer = !!withMute;

  try {
    stopRingtone();
    setCallAudioSession(speakerOn ? "playback" : "play-and-record"); // до getUserMedia: микрофону нужна сессия с записью
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


// =====================================================================
// V.79: надёжность звонка (docs/CALL-RELIABILITY-PROTOCOL.md). Экран «Входящий звонок» по уведомлению, состояния звонящего,
// звонок по ссылке (link-call): создатель — зарегистрированный клиент, гость — любой браузер (гостевой режим без аккаунта).
// =====================================================================
const ANSWER_MAX_WAIT_MS = 50000;            // сервер держит неотвеченное приглашение 45 с
const ANSWER_GRACE_AFTER_REGISTER_MS = 5000; // после регистрации сервер отдаёт приглашение сразу; не пришло — звонок завершён
const CALL_ESCALATE_MS = 20000;              // через сколько секунд без ответа показать «другие способы»
const LC_REQ_TIMEOUT_MS = 10000;
const LC_GUEST_WAIT_MS = 90000;              // сколько гость ждёт, пока его впустят и соединят
const answerUi = { active: false, from: "", callId: "", state: "", t0: 0, wantAnswer: false, timer: null, registeredAt: 0 };
const answerDeclined = new Map();            // from -> время отклонения с экрана: опоздавшее приглашение отклоняем сразу

// ---------- Экран «Входящий звонок» (/#answer=<callId>&from=<id>) ----------
function answerNameFor(from, hint) {
  let n = "";
  try { const c = state.contacts.get(from); if (c && c.name) n = c.name; } catch (e) {}
  if (!n) { try { const idx = JSON.parse(localStorage.getItem("ether.cnames") || "{}"); if (idx && typeof idx[from] === "string") n = idx[from]; } catch (e) {} }
  return n || (typeof hint === "string" && hint.slice(0, 40)) || String(from).slice(0, 8);
}
function answerSetState(st) {
  answerUi.state = st;
  const set = (sel, show) => { const e = $(sel); if (e) e.classList.toggle("hidden", !show); };
  set("#answer-accept-btn", st === "ringing"); set("#answer-decline-btn", st === "ringing" || st === "connecting");
  set("#answer-callback-btn", st === "ended"); set("#answer-close-btn", st === "ended");
  const s = $("#answer-status"); if (s) s.textContent = st === "ringing" ? T("call.incoming") : st === "connecting" ? T("ans.connecting") : T("ans.ended");
}
function hideAnswerScreen() {
  answerUi.active = false; clearInterval(answerUi.timer); answerUi.timer = null;
  const el = $("#answer-screen"); if (el) el.classList.add("hidden");
  try { const m = /^#answer=/.test(location.hash); if (m) history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
}
function showAnswerScreen(from, callId, nameHint) {
  const el = $("#answer-screen"); if (!el || !from) return false;
  if (answerUi.active && answerUi.from === from) return true;
  Object.assign(answerUi, { active: true, from, callId: callId || "", t0: Date.now(), wantAnswer: false, registeredAt: 0, named: false, triedJson: false });
  const name = answerNameFor(from, nameHint);
  if (name && name !== String(from).slice(0, 8)) answerUi.named = true;
  const nm = $("#answer-name"); if (nm) nm.textContent = name;
  const av = $("#answer-avatar"); if (av) { av.style.background = avatarGradient(name); av.textContent = initials(name); }
  answerSetState("ringing");
  el.classList.remove("hidden");
  const b = $("#answer-accept-btn"); try { if (b) b.focus(); } catch (e) {}
  clearInterval(answerUi.timer); answerUi.timer = setInterval(answerTick, 500);
  return true;
}
// Имя мог не знать быстрый индекс (первый запуск после обновления): уточняем, когда контакты загружены, либо один раз разбираем сохранённый список
function answerRefreshName() {
  if (answerUi.named) return;
  let name = "";
  const c = state.contacts.get(answerUi.from);
  if (c && c.name) name = c.name;
  else if (!answerUi.triedJson) {
    answerUi.triedJson = true;
    try { const arr = JSON.parse(Store.contactsJson || "[]"); const f = Array.isArray(arr) && arr.find((x) => x && x.id === answerUi.from); if (f && f.name) name = f.name; } catch (e) {}
  }
  if (!name) return;
  answerUi.named = true;
  const nm = $("#answer-name"); if (nm) nm.textContent = name;
  const av = $("#answer-avatar"); if (av) { av.style.background = avatarGradient(name); av.textContent = initials(name); }
}
function answerTick() {
  if (!answerUi.active) { clearInterval(answerUi.timer); answerUi.timer = null; return; }
  answerRefreshName();
  const sig = typeof signaling !== "undefined" ? signaling : null;
  if (sig && sig.registered && !answerUi.registeredAt) answerUi.registeredAt = Date.now();
  const now = Date.now();
  if (state.callId === answerUi.from) return; // приглашение пришло: дальше работает обычный экран звонка
  if (now - answerUi.t0 > ANSWER_MAX_WAIT_MS || (answerUi.registeredAt && now - answerUi.registeredAt > ANSWER_GRACE_AFTER_REGISTER_MS)) {
    if (answerUi.state !== "ended") answerSetState("ended");
    clearInterval(answerUi.timer); answerUi.timer = null;
  }
}
// Вызывается из обработчика call-invite сразу после openCallScreen(from, "ringing")
function answerScreenOnInvite(from) {
  const dAt = answerDeclined.get(from);
  if (dAt && Date.now() - dAt < 60000) { answerDeclined.delete(from); const d = $("#call-decline-btn"); if (d) d.click(); hideAnswerScreen(); return; }
  if (!answerUi.active || answerUi.from !== from) return;
  const want = answerUi.wantAnswer;
  hideAnswerScreen();
  if (want) setTimeout(() => { if (state.callId === from && state.callPhase === "ringing") acceptCall(false); }, 0);
}
// Начальная отрисовка из location.hash (холодный старт по уведомлению). Только для существующего аккаунта.
function answerBootFromLocation() {
  let p = null; try { p = LinkCall.parseAnswerHash(location.hash); } catch (e) {}
  if (!p || !p.from || !(Store.name && Store.myId)) return false;
  return showAnswerScreen(p.from, p.callId);
}
// SW: клик по уведомлению, окно уже было открыто
function answerFromNotification(d) {
  if (!d || !d.from) return;
  if (state.callId === d.from) { try { restoreCallScreen(); } catch (e) {} return; }
  if (state.callId) return; // уже в другом звонке
  showAnswerScreen(d.from, d.callId, d.name);
}
function wireAnswerScreen() {
  const acc = $("#answer-accept-btn");
  if (acc) acc.addEventListener("click", () => {
    answerUi.wantAnswer = true;
    // разрешение на микрофон запрашиваем прямо в жесте нажатия: поздний getUserMedia без жеста iOS может не показать
    try { if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()), () => {}); } catch (e) {}
    if (state.callId === answerUi.from && state.callPhase === "ringing") { const f = answerUi.from; hideAnswerScreen(); acceptCall(false); return; }
    answerSetState("connecting");
  });
  const dec = $("#answer-decline-btn");
  if (dec) dec.addEventListener("click", () => {
    const f = answerUi.from;
    answerDeclined.set(f, Date.now());
    if (state.callId === f && state.callPhase === "ringing") { const d = $("#call-decline-btn"); if (d) d.click(); answerDeclined.delete(f); }
    else if (signaling && signaling.connected) { try { signaling.signal(f, { t: "call-declined" }); } catch (e) {} }
    hideAnswerScreen();
  });
  const cb = $("#answer-callback-btn");
  if (cb) cb.addEventListener("click", () => {
    const f = answerUi.from; hideAnswerScreen();
    const go = () => { if (!__appStarted) { setTimeout(go, 100); return; } if (state.contacts.get(f)) beginCall(f, false); };
    go();
  });
  const cl = $("#answer-close-btn"); if (cl) cl.addEventListener("click", () => hideAnswerScreen());
}

// ---------- Звонящий: «Вызываем…» → «Звонит у собеседника…» → через 20 с «другие способы» ----------
let callEscTimer = null;
function clearCallEscalation() {
  clearTimeout(callEscTimer); callEscTimer = null;
  const a = $("#call-noanswer-actions"); if (a) a.classList.add("hidden");
}
function startCallEscalation(id) {
  clearCallEscalation();
  if (isLinkCallId(id)) return;
  callEscTimer = setTimeout(() => {
    callEscTimer = null;
    if (state.callId !== id || state.callPhase !== "calling") return;
    const a = $("#call-noanswer-actions"); if (a) a.classList.remove("hidden");
  }, CALL_ESCALATE_MS);
}
// call-ringing от сервера (протокол C): push доставлен, у собеседника звонит
function callRingingFromServer() {
  if (!state.callId || state.callPhase !== "calling" || isLinkCallId(state.callId)) return;
  state._peerRinging = true;
  const p = $("#call-phase"); if (p) p.textContent = T("call.peerRinging");
}
// Тихий отбой исходящего (без предложения голосовой почты и без «не удалось»)
function endOutgoingQuiet(id) {
  clearCallEscalation();
  try { const l = mesh.get(id); if (l) l.endCall(); } catch (e) {}
  if (signaling && signaling.connected) { try { signaling.signal(id, { t: "call-ended" }); } catch (e) {} }
  stopRingtone();
  closeCallScreen("cancelled", { noAnswer: true, localError: true });
}
function wireCallAlternatives() {
  const link = $("#call-alt-link-btn");
  if (link) link.addEventListener("click", () => {
    const id = state.callId; if (!id) return;
    const c = state.contacts.get(id);
    endOutgoingQuiet(id);
    linkCallCreateAndShare({ forId: id, forName: (c && c.name) || "" }).catch((e) => etherLog("warn", "[linkcall] " + String(e)));
  });
  const vm = $("#call-alt-voicemail-btn");
  if (vm) vm.addEventListener("click", () => {
    const id = state.callId; if (!id) return;
    endOutgoingQuiet(id);
    if (typeof resetChatTransientState === "function") resetChatTransientState(id);
    state.tab = "chats"; state.chatId = id; state.contactCardId = null; renderTab();
    setTimeout(() => { try { startVoiceRecording(); } catch (e) {} }, 150);
  });
  const retry = $("#call-alt-retry-btn");
  if (retry) retry.addEventListener("click", () => {
    const id = state.callId; if (!id) return;
    const video = !!state.callWantsVideo;
    endOutgoingQuiet(id);
    state._lastCallFailedAt = 0;
    setTimeout(() => beginCall(id, video), 300);
  });
}

// ---------- Звонок по ссылке (протокол E) ----------
const lcRooms = new Map(); // room -> запись { role: "creator"|"guest", room, id, k, sig, status, ... }
function isLinkCallId(id) { return typeof id === "string" && id.slice(0, 3) === "lc:"; }
const sdpOfSignal = (data) => (data && data.d && typeof data.d.sdp === "string" ? data.d.sdp : "");
// Исходящие сигналы комнаты идут строго по порядку; к offer/answer добавляется доказательство знания секрета k
function lcOutFor(sig) {
  if (sig._lcOut) return;
  sig._lcOut = (room, data) => {
    const e = lcRooms.get(room);
    if (!e) return sig.send("linkcall-signal", { room, data });
    e.outChain = e.outChain.then(async () => {
      let d = data;
      if (e.k && data && (data.t === "offer" || data.t === "answer")) {
        try {
          const fp = (mesh && mesh.get(e.id) && mesh.get(e.id).fingerprints()) || {};
          d = { ...data, lcp: await LinkCall.proof(e.k, fp.local || "", data.t === "offer" ? "" : (fp.remote || "")) };
        } catch (err) { d = data; }
      }
      sig.send("linkcall-signal", { room, data: d });
    }).catch(() => {});
    return true;
  };
}
// Ждём один из ответов сервера (или linkcall-error) на наш запрос
function lcWait(sig, types, ms) {
  return new Promise((resolve) => {
    const list = types.concat(["linkcall-error"]);
    const done = (t, d) => { clearTimeout(timer); for (const x of list) sig.removeEventListener(x, hs[x]); resolve(t ? { type: t, detail: d || {} } : null); };
    const hs = {};
    for (const x of list) { hs[x] = (ev) => done(x, ev.detail); sig.addEventListener(x, hs[x]); }
    const timer = setTimeout(() => done(null), ms || LC_REQ_TIMEOUT_MS);
  });
}
function lcNewEntry(role, room, k, sig) {
  const e = { role, room, id: LinkCall.idOf(room), k: k || null, sig, status: "new", queue: [], chain: Promise.resolve(), outChain: Promise.resolve(), createdAt: Date.now() };
  lcRooms.set(room, e);
  lcOutFor(sig);
  return e;
}
function lcCopy(text) {
  const ok = () => { try { toast(T("lc.copied")); } catch (e) {} };
  try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(ok, () => {}); } catch (e) {}
  try { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); if (document.execCommand && document.execCommand("copy")) ok(); ta.remove(); } catch (e) {}
}
async function lcShare(e) {
  if (navigator.share) {
    try { await navigator.share({ text: e.text }); return true; }
    catch (err) { if (err && err.name === "AbortError") return false; }
  }
  lcCopy(e.text); // нет системного «Поделиться»: ссылка и код в буфере, код виден на экране ожидания
  return false;
}
function lcSheet(id, show) { const s = $("#" + id); if (s) s.classList.toggle("hidden", !show); }
let lcWaiting = null;
function lcShowWait(e) {
  lcWaiting = e;
  const t = $("#linkcall-wait-title"); if (t) t.textContent = T("lc.waitTitle", { name: e.forName || T("lc.guest") });
  const c = $("#linkcall-wait-code"); if (c) c.textContent = T("lc.codeLine", { code: e.code });
  const h = $("#linkcall-wait-hint"); if (h) h.textContent = T("lc.waitHint");
  lcSheet("linkcall-wait-sheet", true);
}
// Создатель: linkcall-create → ссылка с секретом k → системное «Поделиться» (или буфер) → экран «Ждём …»
async function linkCallCreateAndShare(opts) {
  opts = opts || {};
  const sig = signaling;
  if (!sig || !sig.connected) await waitForSignaling(CALL_SERVER_WAIT_MS);
  const s = signaling;
  if (!s || !s.connected) { toast(T("toast.noServer")); return null; }
  const w = lcWait(s, ["linkcall-created"], LC_REQ_TIMEOUT_MS);
  if (!s.linkcallCreate()) { toast(T("lc.createFailed")); return null; }
  const r = await w;
  if (!r || r.type !== "linkcall-created" || typeof r.detail.room !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(r.detail.room)) {
    const why = r && r.detail && r.detail.reason;
    toast(why === "ratelimit" || why === "toomany" ? T("lc.tooMany") : T("lc.createFailed"));
    return null;
  }
  const d = r.detail;
  const e = lcNewEntry("creator", d.room, LinkCall.newSecret(), s);
  e.status = "waiting"; e.code = String(d.code || "").slice(0, 6); e.forId = opts.forId || null; e.forName = String(opts.forName || "").slice(0, 40);
  e.expiresAt = Number(d.expiresAt) || Date.now() + 600000;
  e.link = LinkCall.buildLink(location.origin + location.pathname, e.room, e.k);
  e.text = LinkCall.shareText(T("lc.shareText"), Store.name || T("lc.guest"), e.link, e.code);
  e.expTimer = setTimeout(() => { if (e.status === "waiting") { const h = $("#linkcall-wait-hint"); if (h && lcWaiting === e) h.textContent = T("lc.expired"); lcDrop(e, { notify: true, keepSheet: true }); } }, Math.max(1000, e.expiresAt - Date.now()));
  lcShowWait(e);
  lcShare(e);
  return e;
}
function lcDrop(e, o) {
  if (!e || e.dropped) return; e.dropped = true; o = o || {};
  clearTimeout(e.expTimer); clearTimeout(e.joinTimer);
  if (o.notify && e.sig) { try { e.sig.linkcallEnd(e.room); } catch (x) {} }
  lcRooms.delete(e.room);
  if (lcWaiting === e) { lcWaiting = null; if (!o.keepSheet) lcSheet("linkcall-wait-sheet", false); }
  if (lcApproving === e) { lcApproving = null; lcSheet("linkcall-approve-sheet", false); }
  try { if (mesh && mesh.get(e.id)) mesh.remove(e.id); } catch (x) {}
  state.contacts.delete(e.id);
}
let lcApproving = null;
function lcShowApprove(e) {
  lcApproving = e;
  const t = $("#linkcall-approve-text"); if (t) t.textContent = T("lc.approveText", { name: e.guestName ? " (" + e.guestName + ")" : "" });
  const s = $("#linkcall-approve-sas"); if (s) s.textContent = e.sas || "";
  lcSheet("linkcall-wait-sheet", false); lcSheet("linkcall-approve-sheet", true);
}
// Создатель отказал/проверка не прошла: комната снова ждёт гостя (настоящий собеседник ещё может прийти)
function lcDeny(e, reason) {
  try { e.sig.linkcallDeny(e.room, e.guestRef); } catch (x) {}
  if (reason === "verify") { try { toast(T("lc.err.verify")); } catch (x) {} }
  e.status = "waiting"; e.guestRef = null; e.offer = null; e.offerFp = null; e.queue = []; e.deciding = false; e.sas = "";
  if (lcApproving === e) { lcApproving = null; lcSheet("linkcall-approve-sheet", false); }
  if (Date.now() < e.expiresAt) lcShowWait(e);
}
async function lcTryAdmit(e) {
  if (e.status !== "guest" || !e.offer || e.deciding) return;
  e.deciding = true;
  const fp = e.offerFp;
  if (!fp) { lcDeny(e, "verify"); return; }
  if (e.offer.lcp) { // гость по ссылке доказал знание секрета: авто-разрешение
    let exp = ""; try { exp = await LinkCall.proof(e.k, fp, ""); } catch (x) {}
    if (e.status === "guest" && exp && exp === e.offer.lcp) lcAdmit(e); else lcDeny(e, "verify");
    return;
  }
  // вход по коду (секрета нет): только ручное подтверждение, со сверочными значками из отпечатка
  try { e.sas = await LinkCall.emojiOf(fp); } catch (x) { e.sas = ""; }
  if (e.status === "guest") lcShowApprove(e);
}
function lcAdmit(e) {
  if (e.status === "active" || e.dropped) return;
  if (state.callId || (typeof gcallBusy === "function" && gcallBusy())) { lcDeny(e, "busy"); return; }
  e.status = "active"; clearTimeout(e.expTimer);
  lcSheet("linkcall-approve-sheet", false); lcSheet("linkcall-wait-sheet", false); lcApproving = null; lcWaiting = null;
  try { e.sig.linkcallAllow(e.room, e.guestRef); } catch (x) {}
  state.contacts.set(e.id, { id: e.id, name: e.guestName || e.forName || T("lc.guest"), raw: "", managed: false, ephemeral: true, publicKey: null, online: true, status: "disconnected", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false });
  state._callUserAccepted = false; state.callWantsVideo = false;
  openCallScreen(e.id, "calling");
  const ph = $("#call-phase"); if (ph) ph.textContent = T("lc.connecting");
  clearPendingCall(); pendingCall.contactId = e.id;
  pendingCall.timer = setTimeout(() => {
    if (state.callId !== e.id || state.callPhase === "active") return;
    toast(T("calls.failed")); closeCallScreen("failed", { localError: true });
  }, CALL_ACCEPT_CONNECT_MS + 20000);
  // удержанные сигналы воспроизводятся по порядку: offer, затем ICE
  const first = e.offer, rest = e.queue.splice(0);
  e.chain = e.chain.then(() => { for (const data of [first].concat(rest)) e.sig.dispatchEvent(new CustomEvent("signal", { detail: { from: e.id, data } })); });
}
// Все сигналы комнаты проходят строго по очереди через этот шлюз
function linkCallOnSignal(sig, d) {
  const e = d && lcRooms.get(d.room);
  if (!e || e.sig !== sig || !d.data || typeof d.data !== "object" || typeof d.data.t !== "string") return;
  const data = d.data;
  e.chain = e.chain.then(async () => {
    if (e.dropped) return;
    if (e.role === "creator" && e.status !== "active") { // до решения создателя в P2P-слой ничего не отдаём (IP не раскрывается)
      if (data.t === "offer") { if (e.offer) return; e.offer = data; e.offerFp = LinkCall.fingerprintOf(sdpOfSignal(data)); lcTryAdmit(e); }
      else if (e.queue.length < 120) e.queue.push(data);
      return;
    }
    if (e.role === "guest" && data.t === "answer" && e.k) { // создатель обязан доказать знание секрета: иначе подмена на сигналинге
      const fp = LinkCall.fingerprintOf(sdpOfSignal(data)), l = mesh && mesh.get(e.id), local = l && l.fingerprints().local;
      let exp = ""; try { exp = fp && local ? await LinkCall.proof(e.k, fp, local) : ""; } catch (x) {}
      if (!exp || data.lcp !== exp) { lcGuestFail(e, "verify"); return; }
    }
    if (e.role === "guest" && data.t === "answer") e.answered = true;
    sig.dispatchEvent(new CustomEvent("signal", { detail: { from: e.id, data } }));
  }).catch((err) => etherLog("warn", "[linkcall] signal: " + String(err)));
}
// Ответы сервера, не относящиеся к ожидаемому запросу (запрос-ответ обрабатывает lcWait)
function linkCallOnServer(sig, type, d) {
  d = d || {};
  const e = typeof d.room === "string" ? lcRooms.get(d.room) : null;
  if (type === "linkcall-guest") {
    if (!e || e.role !== "creator" || e.sig !== sig) return;
    if (e.status !== "waiting") { try { sig.linkcallDeny(e.room, d.guestRef); } catch (x) {} return; }
    e.guestRef = d.guestRef; e.guestName = String(d.name || "").replace(/[\u0000-\u001f]/g, "").slice(0, 40); e.viaCode = !!d.viaCode; e.status = "guest";
    lcTryAdmit(e);
  } else if (type === "linkcall-end") {
    if (!e || e.sig !== sig) return;
    if (e.role === "guest") { if (state.callId === e.id) closeCallScreen("completed"); else lcGuestFail(e, "ended"); }
    else if (state.callId === e.id) closeCallScreen("completed");
    else lcDrop(e);
  } else if (type === "linkcall-denied") {
    if (e && e.role === "guest" && e.sig === sig) lcGuestFail(e, "denied");
  }
}
function linkCallOnDisconnected(sig) {
  for (const e of Array.from(lcRooms.values())) {
    if (e.sig !== sig || e.status === "active" || state.callId === e.id) continue; // установленный P2P-звонок сервер не нужен
    if (e.role === "guest") lcGuestFail(e, "conn");
    else { lcDrop(e); try { toast(T("lc.createFailed")); } catch (x) {} }
  }
}
// closeCallScreen → линк закрыт: убираем виртуального собеседника и сообщаем серверу
function linkCallAfterCall(id) {
  const e = lcRooms.get(LinkCall.roomOf(id));
  if (!e) { state.contacts.delete(id); return; }
  const wasGuest = e.role === "guest";
  lcDrop(e, { notify: true });
  if (wasGuest && state.guestMode) guestPanelEnded();
}

// ---------- Гость: присоединение по ссылке (#call=<room>.<k>) или по коду ----------
const guestUi = { active: false, mode: "" };
function guestPanel(show) { const p = $("#guest-call"); if (p) p.classList.toggle("hidden", !show); }
function guestPanelSet(o) {
  const set = (sel, v) => { const e = $(sel); if (e) e.classList.toggle("hidden", !v); };
  const st = $("#guest-call-status"); if (st && o.status != null) st.textContent = o.status;
  if (o.name != null) set("#guest-call-name", o.name);
  if (o.join != null) set("#guest-call-join-btn", o.join);
  if (o.close != null) set("#guest-call-close-btn", o.close);
  if (o.sas != null) { const s = $("#guest-call-sas"); if (s) { s.textContent = o.sas; s.classList.toggle("hidden", !o.sas); } }
}
function guestPanelEnded() { guestUi.active = false; guestPanel(true); guestPanelSet({ status: T("lc.ended"), name: false, join: false, close: true, sas: "" }); }
function lcGuestFail(e, reason) {
  if (e) { try { if (state.callId === e.id) closeCallScreen("failed", { localError: true }); } catch (x) {} lcDrop(e, { notify: reason !== "conn" && reason !== "ended" }); }
  guestUi.active = false;
  const key = ["expired", "full", "notfound", "ratelimit", "denied", "verify", "conn"].includes(reason) ? "lc.err." + reason : reason === "ended" ? "lc.ended" : "lc.err.generic";
  guestPanel(true); guestPanelSet({ status: T(key), name: false, join: false, close: true, sas: "" });
}
// Гостевой режим: окружение звонка без аккаунта (ничего не пишем в хранилище)
function guestEnsureEnv(name) {
  if (!mesh) {
    mesh = new MeshManager(name || T("lc.guest"));
    safeCall(wireMeshEvents, "wireMeshEvents");
    safeCall(wireCallScreen, "wireCallScreen");
    safeCall(wireSheetBackdrops, "wireSheetBackdrops");
  }
  const a = $("#app-shell"); if (a) a.classList.remove("hidden");
  const o = $("#onboarding"); if (o) o.classList.add("hidden");
}
async function guestEnsureSignaling(name) {
  if (signaling && signaling.guest) return signaling;
  const url = effectiveSignalingUrl();
  if (signalingCleanup) { try { signalingCleanup(); } catch (e) {} signalingCleanup = null; }
  if (signaling) { try { signaling.stop(); } catch (e) {} signaling = null; }
  const sig = signaling = new SignalingClient(url, "", { guest: true, name: name || "" });
  signalingCleanup = wireSignalingEvents(sig);
  sig.start();
  await waitForSignaling(CALL_SERVER_WAIT_MS);
  return sig;
}
// p: { room, k } (ссылка) или { code } (6 цифр); name — имя гостя без аккаунта
async function linkCallGuestStart(p, name) {
  if (guestUi.active) return;
  guestUi.active = true;
  guestPanel(true);
  guestPanelSet({ status: T("lc.connecting"), name: false, join: false, close: false, sas: "" });
  let sig = null;
  if (state.guestMode) { guestEnsureEnv(name); sig = await guestEnsureSignaling(name); }
  else { sig = signaling; if (!sig || !sig.connected) { await waitForSignaling(CALL_SERVER_WAIT_MS); sig = signaling; } }
  if (!sig || !sig.connected) { lcGuestFail(null, "conn"); return; }
  const myName = state.guestMode ? String(name || "").trim().slice(0, 40) : (Store.name || "");
  const w = lcWait(sig, ["linkcall-joined"], LC_REQ_TIMEOUT_MS);
  sig.linkcallJoin(p.room ? { room: p.room, name: myName } : { code: p.code, name: myName });
  const r = await w;
  if (!r) { lcGuestFail(null, "conn"); return; }
  if (r.type === "linkcall-error") { const why = r.detail && r.detail.reason; lcGuestFail(null, ["expired", "full", "notfound", "ratelimit"].includes(why) ? why : "generic"); return; }
  const room = String((r.detail && r.detail.room) || p.room || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(room)) { lcGuestFail(null, "generic"); return; }
  const e = lcNewEntry("guest", room, p.k || null, sig);
  e.status = "joined";
  state.contacts.set(e.id, { id: e.id, name: T("sys.someone"), raw: "", managed: false, ephemeral: true, publicKey: null, online: true, status: "disconnected", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false });
  e.joinTimer = setTimeout(() => { if (!e.dropped && state.callPhase !== "active" && !(state.callId === e.id)) lcGuestFail(e, e.answered ? "generic" : "denied"); }, LC_GUEST_WAIT_MS);
  try {
    const link = mesh.createOutgoingLink(e.id);
    const packet = await link.createInitialOffer("");
    if (!packet) throw new Error("no offer");
    if (!p.k) { // вход по коду: показываем сверочные значки, которые увидит и создатель при подтверждении
      const fp = link.fingerprints().local;
      let sas = ""; try { sas = await LinkCall.emojiOf(fp); } catch (x) {}
      guestPanelSet({ status: T("lc.waitingAllow"), sas: sas ? T("lc.sas", { sas }) : "" });
    } else guestPanelSet({ status: T("lc.waitingAllow") });
    sig.signal(e.id, packet);
  } catch (err) { etherLog("error", "[linkcall] offer: " + String(err)); lcGuestFail(e, "generic"); }
}
// Гость сам открывает экран звонка и принимает его, как только открылся канал данных: гость уже нажал «Присоединиться»,
// а ringing от создателя по каналу может уйти раньше, чем канал открыт (статус connected приходит до dc-open)
function linkCallWireMesh() {
  mesh.addEventListener("link-dc-open", (ev) => {
    const id = ev.detail && ev.detail.id;
    if (!isLinkCallId(id)) return;
    const e = lcRooms.get(LinkCall.roomOf(id));
    if (!e || e.role !== "guest" || e.dropped || state.callId) return;
    guestPanel(false); clearTimeout(e.joinTimer);
    state.callWantsVideo = false;
    openCallScreen(id, "ringing");
    acceptCall(false);
  });
}

// ---------- Подключение интерфейса и точки входа ----------
function linkCallBoot() { // из initBoot: ссылка #call= в браузере без аккаунта -> гостевой режим (true: обычный запуск не нужен)
  let p = null; try { p = LinkCall.parseHash(location.hash); } catch (e) {}
  if (!p || (Store.name && Store.myId)) return false;
  state.guestMode = true; state.guestLink = p;
  document.documentElement.classList.add("guest-call");
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  wireGuestPanel();
  guestPanel(true);
  guestPanelSet({ status: T("lc.guestHint"), name: true, join: true, close: false, sas: "" });
  return true;
}
function linkCallFromLocation() { // после startApp: аккаунт есть — присоединяемся под своим именем
  let p = null; try { p = LinkCall.parseHash(location.hash); } catch (e) {}
  if (!p) return false;
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  if (state.callId) { toast(T("toast.alreadyInCall")); return true; }
  linkCallGuestStart({ room: p.room, k: p.k }).catch((e) => etherLog("warn", "[linkcall] " + String(e)));
  return true;
}
let __guestPanelWired = false;
function wireGuestPanel() {
  if (__guestPanelWired) return; __guestPanelWired = true;
  const go = $("#guest-call-join-btn");
  if (go) go.addEventListener("click", () => {
    const nm = $("#guest-call-name"), name = nm ? nm.value : "";
    const p = state.guestLink; if (!p) return;
    state.guestLink = null;
    linkCallGuestStart({ room: p.room, k: p.k }, name).catch((e) => etherLog("warn", "[linkcall] " + String(e)));
  });
  const cl = $("#guest-call-close-btn");
  if (cl) cl.addEventListener("click", () => {
    guestPanel(false);
    if (state.guestMode) { try { location.replace(location.pathname + location.search); } catch (e) { location.reload(); } }
  });
}
function wireLinkCallUi() {
  wireGuestPanel();
  wireAnswerScreen();
  const share = $("#linkcall-wait-share"); if (share) share.addEventListener("click", () => { if (lcWaiting) lcShare(lcWaiting); });
  const copy = $("#linkcall-wait-copy"); if (copy) copy.addEventListener("click", () => { if (lcWaiting) lcCopy(lcWaiting.text); });
  const cancel = $("#linkcall-wait-cancel"); if (cancel) cancel.addEventListener("click", () => { if (lcWaiting) lcDrop(lcWaiting, { notify: true }); lcSheet("linkcall-wait-sheet", false); });
  const allow = $("#linkcall-approve-allow"); if (allow) allow.addEventListener("click", () => { if (lcApproving) lcAdmit(lcApproving); });
  const deny = $("#linkcall-approve-deny"); if (deny) deny.addEventListener("click", () => { if (lcApproving) lcDeny(lcApproving, "denied"); });
  // ввод кода (6 цифр)
  const open = () => { const i = $("#linkcall-code-input"); if (i) i.value = ""; const er = $("#linkcall-join-error"); if (er) er.textContent = ""; lcSheet("linkcall-join-sheet", true); setTimeout(() => { try { if (i) i.focus(); } catch (e) {} }, 60); };
  for (const id of ["#chats-empty-join-btn", "#connect-join-code-btn"]) { const b = $(id); if (b) b.addEventListener("click", open); }
  const go = $("#linkcall-join-go");
  const submit = () => {
    const i = $("#linkcall-code-input"), er = $("#linkcall-join-error");
    const code = LinkCall.normalizeCode(i && i.value);
    if (!code) { if (er) er.textContent = T("lc.badCode"); return; }
    if (state.callId) { toast(T("toast.alreadyInCall")); return; }
    lcSheet("linkcall-join-sheet", false);
    linkCallGuestStart({ code }).catch((e) => etherLog("warn", "[linkcall] " + String(e)));
  };
  if (go) go.addEventListener("click", submit);
  const ci = $("#linkcall-code-input"); if (ci) ci.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submit(); } });
  window.addEventListener("hashchange", () => { try { if (/^#call=/.test(location.hash)) linkCallFromLocation(); else if (/^#answer=/.test(location.hash)) answerBootFromLocation(); } catch (e) {} });
}
