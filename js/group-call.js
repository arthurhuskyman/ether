// =====================================================================
// Групповые звонки (mesh): каждый участник держит медиа-соединение с каждым.
// Поверх уже существующих P2P-линков группового чата — отдельный сигналинг
// kind:"gcall" по data channel, 1:1-звонки (call-state) не затрагиваются.
// Лимит участников — GCALL_MAX (mesh растёт квадратично по исходящему трафику).
// Загружается после app.js; использует его глобалы (mesh, state, Store, T, toast…).
// =====================================================================
const GCALL_MAX = 6;
const GCALL_INVITE_TTL_MS = 30000;

const GC = {
  gid: null,           // id группы, в звонке которой мы участвуем (null — не в звонке)
  stream: null,        // локальный MediaStream (аудио + опционально видео)
  muted: false,
  video: false,
  peers: new Map(),    // peerId -> { name, stream, hasVideo, muted }
  joined: new Set(),   // кто явно объявил join в этом звонке (только таких регистрируем по треку)
  joining: false,      // идёт запрос микрофона/вход (защита от двойного нажатия)
  sentJoin: new Set(), // кому уже отправили join в этой сессии звонка
  startedAt: 0,
  everConnected: false,
  timer: null,
  invites: new Map(),  // gid -> { from, fromName, ts }
  ringTimer: null,
  wired: false,
};

// Адаптивный предел участников: 6, но слабое устройство / слабый исходящий канал -> меньше (см. EtherCallQuality.groupLimit)
function gcallLimit() {
  const CQ = window.EtherCallQuality; if (!CQ) return GCALL_MAX;
  let up = 0, n = 0;
  for (const id of GC.peers.keys()) { const l = mesh && mesh.get(id); const a = l && l._lastSample && l._lastSample.availBps; if (a > 0) { up += a; n++; } }
  return Math.min(GCALL_MAX, CQ.groupLimit({ max: GCALL_MAX, cores: (navigator && navigator.hardwareConcurrency) || 0, uplinkBps: n && n === GC.peers.size ? up : 0 }));
}
// Бюджет исходящего видео: делим канал между получателями; больше 4 видео-получателей -> видео выключается, остаётся звук.
function gcallApplyBudget() {
  const CQ = window.EtherCallQuality; if (!CQ || !GC.gid) return;
  let up = 0, n = 0;
  for (const id of GC.peers.keys()) { const l = mesh && mesh.get(id); const a = l && l._lastSample && l._lastSample.availBps; if (a > 0) { up += a; n++; } }
  const plan = CQ.groupVideoPlan({ peers: GC.peers.size, uplinkBps: n && n === GC.peers.size ? Math.max(500000, Math.min(up, 6000000)) : 2500000 });
  const budget = GC.video && plan.video ? plan.perPeerBps : (GC.video ? 0 : null);
  for (const id of GC.peers.keys()) { const l = mesh && mesh.get(id); if (l && typeof l.setVideoBudget === "function" && l._videoBudget !== budget && budget !== null) l.setVideoBudget(budget); }
  if (GC.video && !plan.video && !GC._capNoticed) { GC._capNoticed = true; try { toast(T("callq.groupAudioOnly")); } catch (e) {} }
  if (plan.video) GC._capNoticed = false;
}

function gcallBusy() { return !!GC.gid; }
function gcallGroup(gid) { const g = state.contacts.get(gid); return g && isGroup(g) ? g : null; }
function gcallIsMember(g, id) { return !!(g && Array.isArray(g.members) && g.members.some((m) => m.id === id)); }
function gcallMemberName(g, id) { const m = g && g.members && g.members.find((x) => x.id === id); return (m && m.name) || T("sys.someone"); }
function gcallLinkOk(id) { const l = mesh && mesh.get(id); return !!(l && (l.status === "connected" || l.status === "in-call")); }
function gcallSend(id, payload) {
  const l = mesh && mesh.get(id);
  if (!l || !gcallLinkOk(id)) return false;
  try { return l.send(Object.assign({ kind: "gcall", gid: GC.gid, ts: Date.now() }, payload)) !== false; } catch (e) { return false; } // send() вернёт false, пока линк не прошёл проверку подлинности
}
function gcallBroadcast(payload) {
  const g = gcallGroup(GC.gid); if (!g) return;
  for (const m of g.members) if (m.id !== Store.myId) gcallSend(m.id, payload);
}

// ---------- старт / вступление ----------
async function gcallAcquire(withVideo) {
  try {
    const got = await navigator.mediaDevices.getUserMedia(withVideo ? { audio: true, video: { facingMode: "user" } } : { audio: true });
    // за время запроса разрешения мы уже могли войти в другой звонок — не затираем и не теряем поток
    if (GC.gid || state.callId) { try { got.getTracks().forEach((t) => t.stop()); } catch (e) {} return false; }
    GC.stream = got;
  } catch (e) {
    const name = e && e.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") toast(T("toast.callPermissionDenied"));
    else if (name === "NotFoundError" || name === "DevicesNotFoundError") toast(T("toast.voiceNoMic"));
    else toast(T("calls.failed"));
    return false;
  }
  GC.video = !!(GC.stream && GC.stream.getVideoTracks().length);
  try { GC.stream.getAudioTracks().forEach(gcallWatchMic); } catch (e) {}
  return true;
}

// ---------- устойчивость звука (iOS/Android отбирают микрофон и ставят <video> на паузу) ----------
// Микрофон: ОС может заглушить трек (mute) или убить его (ended) — раньше участники просто переставали слышать нас до конца звонка.
function gcallWatchMic(track) {
  if (!track || track.__gcWatched || typeof track.addEventListener !== "function") return;
  track.__gcWatched = true;
  track.addEventListener("mute", () => { if (GC.gid) GC.micSuspended = true; });
  track.addEventListener("unmute", () => { GC.micSuspended = false; });
  track.addEventListener("ended", () => { if (GC.gid && GC.stream && !GC.leaving) { GC.micSuspended = true; gcallEnsureMic("ended"); } });
}
// Проверка/починка исходящего звука: трек жив и не заглушён -> всё хорошо; иначе берём микрофон заново и подставляем во все линки (replaceTrack).
async function gcallEnsureMic(reason, force) {
  if (!GC.gid || !GC.stream) return false;
  const old = GC.stream.getAudioTracks()[0];
  const dead = !old || old.readyState === "ended";
  if (!dead && !force && !old.muted) { old.enabled = !GC.muted; GC.micSuspended = false; return true; }
  if (typeof document !== "undefined" && document.hidden) return false; // в фоне getUserMedia не даст трек — повторим при возврате
  if (GC.micP) return GC.micP;
  const gid = GC.gid;
  const p = (async () => {
    try {
      let ns;
      try { ns = await navigator.mediaDevices.getUserMedia({ audio: typeof AUDIO_CAPTURE !== "undefined" ? AUDIO_CAPTURE : true }); }
      catch (e) { ns = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      const nt = ns.getAudioTracks()[0];
      if (!nt) return false;
      if (GC.gid !== gid || !GC.stream) { try { ns.getTracks().forEach((t) => t.stop()); } catch (e) {} return false; }
      nt.enabled = !GC.muted;
      const oldId = old && old.id;
      if (old) { try { old.stop(); } catch (e) {} try { GC.stream.removeTrack(old); } catch (e) {} }
      GC.stream.addTrack(nt);
      gcallWatchMic(nt);
      for (const id of GC.peers.keys()) {
        const l = mesh && mesh.get(id);
        if (!l) continue;
        let done = false;
        if (oldId && l.replaceGroupTrack) { try { done = await l.replaceGroupTrack(oldId, nt, GC.stream); } catch (e) { done = false; } }
        if (!done && l.addGroupTracks) l.addGroupTracks(GC.stream);
      }
      GC.micSuspended = false;
      return true;
    } catch (e) { return false; }
  })();
  GC.micP = p;
  const clear = () => { if (GC.micP === p) GC.micP = null; };
  p.then(clear, clear);
  return p;
}
// Звук собеседников: <video> мог встать на паузу (прерывание, автоплей) — запускаем снова; AudioContext и маршрут iOS возвращаем.
function gcallResumeAudio(reason) {
  if (!GC.gid) return;
  try { if (navigator.audioSession && navigator.audioSession.type !== "play-and-record") navigator.audioSession.type = "play-and-record"; } catch (e) {}
  try { const c = typeof ensureGlobalAudioCtx === "function" ? ensureGlobalAudioCtx() : null; if (c && c.state !== "running") c.resume().catch(() => {}); } catch (e) {}
  const scr = typeof document !== "undefined" && document.getElementById("gcall-screen");
  const vids = scr ? scr.querySelectorAll("video") : [];
  for (const v of vids) {
    if (v.muted && v.srcObject === GC.stream) continue; // свой собственный предпросмотр
    if (v.srcObject && v.paused) { try { const pr = v.play(); if (pr && pr.catch) pr.catch(() => gcallRetryOnGesture()); } catch (e) {} }
  }
  if (!document.hidden) setTimeout(() => { if (GC.gid) gcallEnsureMic(reason); }, reason === "foreground" ? 1200 : 0);
}
function gcallRetryOnGesture() {
  if (GC.gestureRetry) return;
  GC.gestureRetry = true;
  const go = () => {
    GC.gestureRetry = false;
    ["touchstart", "pointerdown", "click", "keydown"].forEach((ev) => document.removeEventListener(ev, go, true));
    gcallResumeAudio("gesture");
  };
  ["touchstart", "pointerdown", "click", "keydown"].forEach((ev) => document.addEventListener(ev, go, true));
}

async function startGroupCall(gid, withVideo) {
  const g = gcallGroup(gid); if (!g) return;
  if (state.callId || GC.gid) { toast(T("toast.alreadyInCall")); return; }
  if (!g.members.some((m) => m.id !== Store.myId && gcallLinkOk(m.id))) { toast(T("gcall.noOneOnline")); return; }
  if (GC.joining) return;
  GC.joining = true;
  try {
    if (!(await gcallAcquire(!!withVideo))) return;
    if (GC.gid || state.callId) return;
    gcallEnter(gid);
  } finally { GC.joining = false; }
  gcallBroadcast({ t: "invite", name: g.name || "", from: Store.name || "" });
  // звонок из группы-комнаты должен быть виден остальным как присутствие в комнате
  try { if (typeof roomGroup === "function" && roomGroup(gid)) { roomSendPresence(gid, true); roomStartPulse(gid); roomRenderBar(); } } catch (e) {}
}

async function joinGroupCall(gid) {
  gcallStopRing();
  GC.invites.delete(gid); gcallRenderInvite();
  const g = gcallGroup(gid); if (!g || GC.gid || state.callId) return;
  if (GC.joining) return;
  GC.joining = true;
  try {
    if (!(await gcallAcquire(false))) return;
    if (GC.gid || state.callId) return;
    gcallEnter(gid);
  } finally { GC.joining = false; }
  gcallBroadcast({ t: "join" });
  g.members.forEach((m) => { if (m.id !== Store.myId && gcallLinkOk(m.id)) GC.sentJoin.add(m.id); });
}

function gcallEnter(gid) {
  if (GC.timer) { clearInterval(GC.timer); GC.timer = null; }
  GC.gid = gid; GC.peers = new Map(); GC.sentJoin = new Set(); GC.joined = new Set(); GC.muted = false;
  GC.startedAt = Date.now(); GC.everConnected = false; GC.leaving = false; GC.micSuspended = false;
  try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch (e) {}
  gcallRenderScreen();
  GC.timer = setInterval(gcallTick, 1000);
  try { requestWakeLock(); } catch (e) {}
}

// Подключить свои треки к линку участника и зарегистрировать его
function gcallRegisterPeer(id, hasVideo, muted) {
  const g = gcallGroup(GC.gid); if (!g || !gcallIsMember(g, id)) return false;
  if (!GC.peers.has(id) && GC.peers.size + 1 >= gcallLimit()) { gcallSend(id, { t: "full" }); return false; }
  const p = GC.peers.get(id) || { name: gcallMemberName(g, id), stream: null, hasVideo: false, muted: false };
  if (hasVideo != null) p.hasVideo = !!hasVideo;
  if (muted != null) p.muted = !!muted;
  GC.peers.set(id, p);
  const l = mesh.get(id);
  if (l && GC.stream && typeof l.addGroupTracks === "function") l.addGroupTracks(GC.stream);
  if (l && typeof l.startQuality === "function") { try { l.startQuality(); } catch (e) {} }
  try { gcallApplyBudget(); } catch (e) {}
  GC.everConnected = true;
  gcallRenderScreen();
  return true;
}

// ---------- входящие сообщения ----------
function handleGroupCallPayload(fromId, p) {
  if (!p || !p.gid) return;
  const g = gcallGroup(p.gid);
  if (!g || !gcallIsMember(g, fromId)) return; // только участники этой группы
  const fresh = !p.ts || Date.now() - p.ts < GCALL_INVITE_TTL_MS;
  if (typeof roomHandle === "function" && roomHandle(fromId, p, g)) return; // голосовые комнаты: присутствие и тихий вход
  if (p.t === "invite" || p.t === "join") {
    if (GC.gid === p.gid) {
      if (p.t === "invite") return;
      if (!gcallRegisterPeer(fromId, p.video, p.muted)) return; // звонок переполнен — не отвечаем join'ом
      GC.joined.add(fromId);
      if (!GC.sentJoin.has(fromId)) gcallJoinRetry(fromId);
      return;
    }
    if (!fresh || GC.gid || state.callId) return; // уже заняты или протухшее приглашение
    const c = state.contacts.get(fromId); if (c && c.blocked) return;
    const invTs = Date.now();
    GC.invites.set(p.gid, { from: fromId, fromName: gcallMemberName(g, fromId), ts: invTs });
    // без leave приглашение не должно висеть вечно — гасим по TTL (по времени приёма, не по чужим часам)
    setTimeout(() => { const cur = GC.invites.get(p.gid); if (cur && cur.ts === invTs) { GC.invites.delete(p.gid); gcallRenderInvite(); } }, GCALL_INVITE_TTL_MS);
    gcallRenderInvite();
    if (p.t === "invite") { try { playRingtone(); } catch (e) {} clearTimeout(GC.ringTimer); GC.ringTimer = setTimeout(gcallStopRing, 25000); }
    return;
  }
  if (GC.gid !== p.gid) {
    if (p.t === "leave" || p.t === "end") { const inv = GC.invites.get(p.gid); if (inv && inv.from === fromId) { GC.invites.delete(p.gid); gcallRenderInvite(); } }
    return;
  }
  if (p.t === "leave") {
    const peer = GC.peers.get(fromId);
    GC.peers.delete(fromId); GC.sentJoin.delete(fromId); GC.joined.delete(fromId);
    const l = mesh.get(fromId); if (l && typeof l.removeGroupTracks === "function") l.removeGroupTracks();
    if (peer) toast(T("gcall.left", { name: peer.name }));
    gcallRenderScreen();
  } else if (p.t === "state") {
    const peer = GC.peers.get(fromId); if (!peer) return;
    if (typeof p.muted === "boolean") peer.muted = p.muted;
    if (typeof p.video === "boolean") peer.hasVideo = p.video;
    gcallRenderScreen();
  } else if (p.t === "full") {
    toast(T("gcall.full", { n: GCALL_MAX }));
  }
}

function gcallOnRemoteTrack(ev) {
  if (!GC.gid) return;
  const { id, stream, track } = ev.detail || {};
  const g = gcallGroup(GC.gid);
  if (!g || !gcallIsMember(g, id) || !stream) return;
  if (!GC.peers.has(id) && !GC.joined.has(id)) return; // трек без явного join не делает человека участником
  let p = GC.peers.get(id);
  if (!p) { if (!gcallRegisterPeer(id, null, null)) return; p = GC.peers.get(id); }
  p.stream = stream;
  if (track && track.kind === "video") {
    p.hasVideo = true;
    const upd = () => { p.hasVideo = !track.muted && track.readyState === "live"; gcallRenderScreen(); };
    track.addEventListener("mute", upd); track.addEventListener("unmute", upd); track.addEventListener("ended", upd);
  }
  gcallRenderScreen();
}

function gcallOnLinkStatus(ev) {
  const { id, status } = ev.detail || {};
  if (!GC.gid) return;
  const g = gcallGroup(GC.gid); if (!g || !gcallIsMember(g, id)) return;
  if (status === "disconnected") { // линк оборвался — убираем плитку и разрешаем новый join после переподключения
    GC.sentJoin.delete(id); GC.joined.delete(id);
    if (GC.peers.delete(id)) {
      try { if (typeof roomMarkPresent === "function" && g.room) roomMarkPresent(g.id, id, "", false); } catch (e) {}
      gcallRenderScreen();
    }
    return;
  }
  if (status !== "connected") return;
  // (пере)подключившемуся участнику сообщаем, что мы в звонке — иначе он не узнает
  GC.sentJoin.delete(id);
  gcallJoinRetry(id);
}
// Статус 'connected' приходит раньше открытия канала данных и проверки подлинности, поэтому первая отправка может не пройти:
// повторяем каждые 500 мс (до ~30 с: под нагрузкой рукопожатие канала данных занимает дольше 10 с — раньше join тогда терялся навсегда), а в sentJoin записываем только реально отправленное.
function gcallJoinRetry(id, attempt) {
  const gid = GC.gid; if (!gid) return;
  if (GC.sentJoin.has(id)) return;
  if (gcallSend(id, { t: "join", muted: GC.muted, video: GC.video })) { GC.sentJoin.add(id); return; }
  if ((attempt || 0) >= 60) return;
  setTimeout(() => { if (GC.gid === gid && !GC.sentJoin.has(id) && gcallLinkOk(id)) gcallJoinRetry(id, (attempt || 0) + 1); }, 500);
}

function gcallWire() {
  if (GC.wired || !mesh) return;
  GC.wired = true;
  mesh.addEventListener("remote-track", gcallOnRemoteTrack);
  mesh.addEventListener("link-status", gcallOnLinkStatus);
  try {
    const back = () => { if (!document.hidden) gcallResumeAudio("foreground"); };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("pageshow", back);
    window.addEventListener("focus", back);
  } catch (e) {}
}

// ---------- управление ----------
function gcallToggleMute() {
  if (!GC.stream) return;
  GC.muted = !GC.muted;
  GC.stream.getAudioTracks().forEach((t) => { t.enabled = !GC.muted; });
  gcallBroadcast({ t: "state", muted: GC.muted, video: GC.video });
  gcallRenderScreen();
}

async function gcallToggleCamera() {
  if (!GC.stream || GC.camBusy) return; // двойное нажатие: второй getUserMedia оставил бы первую камеру включённой без владельца
  GC.camBusy = true;
  try { await gcallToggleCameraInner(); } finally { GC.camBusy = false; }
}
async function gcallToggleCameraInner() {
  if (GC.video) {
    GC.stream.getVideoTracks().forEach((t) => { try { t.stop(); } catch (e) {} GC.stream.removeTrack(t); });
    GC.video = false;
    for (const id of GC.peers.keys()) { const l = mesh.get(id); if (l && l.removeGroupTracks) l.removeGroupTracks("video"); }
  } else {
    let vs;
    try { vs = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } }); }
    catch (e) { toast(T("toast.callPermissionDenied")); return; }
    if (!GC.gid || !GC.stream) { try { vs.getTracks().forEach((t) => t.stop()); } catch (e) {} return; }
    const vt = vs.getVideoTracks()[0]; if (!vt) return;
    GC.stream.addTrack(vt); GC.video = true;
    for (const id of GC.peers.keys()) { const l = mesh.get(id); if (l && l.addGroupTracks) l.addGroupTracks(GC.stream); }
    try { gcallApplyBudget(); } catch (e) {}
  }
  gcallBroadcast({ t: "state", muted: GC.muted, video: GC.video });
  gcallRenderScreen();
}

function leaveGroupCall(opts) {
  if (!GC.gid) return;
  const gid = GC.gid;
  const g = gcallGroup(gid);
  const dur = Date.now() - GC.startedAt;
  const hadPeers = GC.everConnected;
  GC.leaving = true;
  gcallBroadcast({ t: "leave" });
  for (const id of GC.peers.keys()) { const l = mesh && mesh.get(id); if (l && l.stopQuality) { try { l.stopQuality(); l._videoBudget = null; } catch (e) {} } if (l && l.removeGroupTracks) l.removeGroupTracks(); }
  if (GC.stream) { try { GC.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); } catch (e) {} }
  clearInterval(GC.timer); GC.timer = null;
  GC.gid = null; GC.stream = null; GC.peers = new Map(); GC.sentJoin = new Set(); GC.joined = new Set(); GC.video = false; GC.muted = false;
  try { releaseWakeLock(); } catch (e) {}
  try { if (navigator.audioSession) navigator.audioSession.type = "auto"; } catch (e) {}
  gcallRenderScreen();
  if (g && hadPeers && !(opts && opts.silent)) {
    g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("gcall.systemEnded", { duration: formatDuration(dur) }), textKey: "gcall.systemEnded", textParams: { duration: formatDuration(dur) }, ts: Date.now() });
    g.lastActivity = Date.now();
    try { persistContacts(); } catch (e) {}
    if (state.chatId === gid) { try { renderChatThread(); } catch (e) {} }
  }
}

let __gcTick = 0;
function gcallTick() {
  if (++__gcTick % 4 === 0) { try { gcallApplyBudget(); } catch (e) {} }
  const el = document.getElementById("gcall-timer");
  if (el) el.textContent = formatClock(Date.now() - GC.startedAt);
}

// ---------- UI ----------
function gcallStopRing() { clearTimeout(GC.ringTimer); GC.ringTimer = null; try { stopRingtone(); } catch (e) {} }

function gcallRenderInvite() {
  let box = document.getElementById("gcall-invite");
  if (!GC.invites.size) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement("div"); box.id = "gcall-invite"; box.className = "gcall-invite"; document.body.appendChild(box); }
  box.innerHTML = "";
  for (const [gid, inv] of GC.invites) {
    const g = gcallGroup(gid); if (!g) continue;
    const row = document.createElement("div"); row.className = "gcall-invite-row"; row.dataset.gid = gid;
    const txt = document.createElement("span"); txt.className = "gcall-invite-text";
    txt.textContent = T("gcall.incoming", { name: inv.fromName, group: g.name || "" });
    const join = document.createElement("button"); join.type = "button"; join.className = "gcall-invite-join"; join.textContent = T("gcall.join");
    join.addEventListener("click", () => joinGroupCall(gid));
    const no = document.createElement("button"); no.type = "button"; no.className = "gcall-invite-no"; no.textContent = T("gcall.dismiss");
    no.addEventListener("click", () => { GC.invites.delete(gid); gcallStopRing(); gcallRenderInvite(); });
    row.append(txt, join, no); box.appendChild(row);
  }
}

function gcallTileHtml(id, name, opts) {
  return `<div class="gcall-tile${opts.speaking ? " speaking" : ""}" data-peer="${escapeHtml(id)}">
    <div class="gcall-avatar" style="background:${avatarGradient(name)}">${escapeHtml(initials(name))}</div>
    <video class="gcall-video${opts.hasVideo ? "" : " novid"}" autoplay playsinline ${opts.local ? "muted" : ""}></video>
    <div class="gcall-name">${escapeHtml(name)}${opts.muted ? ' <span class="gcall-muted" aria-hidden="true">🔇</span>' : ""}</div>
  </div>`;
}

function gcallRenderScreen() {
  let scr = document.getElementById("gcall-screen");
  if (!GC.gid) { if (scr) scr.remove(); return; }
  const g = gcallGroup(GC.gid);
  if (!scr) {
    scr = document.createElement("div"); scr.id = "gcall-screen"; scr.className = "gcall-screen";
    scr.innerHTML = `<div class="gcall-head"><div class="gcall-title"></div><div class="gcall-sub"><span id="gcall-count"></span> · <span id="gcall-timer">0:00</span></div></div>
      <div class="gcall-grid" id="gcall-grid"></div>
      <div class="gcall-controls">
        <button type="button" id="gcall-mute" class="gcall-btn"></button>
        <button type="button" id="gcall-cam" class="gcall-btn"></button>
        <button type="button" id="gcall-leave" class="gcall-btn gcall-leave"></button>
      </div>`;
    document.body.appendChild(scr);
    scr.querySelector("#gcall-mute").addEventListener("click", gcallToggleMute);
    scr.querySelector("#gcall-cam").addEventListener("click", gcallToggleCamera);
    scr.querySelector("#gcall-leave").addEventListener("click", () => leaveGroupCall());
  }
  scr.querySelector(".gcall-title").textContent = (g && g.name) || T("gcall.title");
  scr.querySelector("#gcall-count").textContent = T("gcall.participants", { n: GC.peers.size + 1 });
  const mb = scr.querySelector("#gcall-mute"); mb.textContent = GC.muted ? "🔇" : "🎤"; mb.setAttribute("aria-label", T(GC.muted ? "gcall.unmute" : "gcall.mute")); mb.classList.toggle("off", GC.muted);
  const cb = scr.querySelector("#gcall-cam"); cb.textContent = GC.video ? "📹" : "🚫"; cb.setAttribute("aria-label", T(GC.video ? "gcall.cameraOff" : "gcall.cameraOn")); cb.classList.toggle("off", !GC.video);
  scr.querySelector("#gcall-leave").textContent = "📞"; scr.querySelector("#gcall-leave").setAttribute("aria-label", T("gcall.leave"));
  const grid = scr.querySelector("#gcall-grid");
  const ids = ["__me"].concat(Array.from(GC.peers.keys()));
  grid.setAttribute("data-n", String(ids.length));
  // Плитки пересобираются по списку; <video> переиспользуются, чтобы не мигало
  const existing = new Map(Array.from(grid.children).map((el) => [el.dataset.peer, el]));
  for (const [pid, el] of existing) if (!ids.includes(pid)) el.remove();
  for (const pid of ids) {
    const local = pid === "__me";
    const p = local ? null : GC.peers.get(pid);
    const name = local ? T("gcall.you") : p.name;
    let el = grid.querySelector(`[data-peer="${CSS_ESC(pid)}"]`);
    if (!el) { const tmp = document.createElement("div"); tmp.innerHTML = gcallTileHtml(pid, name, { local, hasVideo: false, muted: false }); el = tmp.firstElementChild; grid.appendChild(el); }
    const hasVideo = local ? GC.video : !!(p && p.hasVideo && p.stream);
    const muted = local ? GC.muted : !!(p && p.muted);
    const v = el.querySelector("video");
    v.classList.toggle("novid", !hasVideo);
    const want = local ? GC.stream : (p && p.stream);
    if (want && v.srcObject !== want) { v.srcObject = want; try { v.play && v.play().catch(() => { if (!local) gcallRetryOnGesture(); }); } catch (e) {} }
    if (!v.__gcPause) { v.__gcPause = true; v.addEventListener("pause", () => { setTimeout(() => { if (GC.gid && v.isConnected && v.paused && v.srcObject && !(v.muted && v.srcObject === GC.stream)) { try { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {} } }, 200); }); }
    // аудио удалённых участников играет через <video> даже когда картинка скрыта
    v.muted = local; // свой звук не воспроизводим (эхо); чужой играет через <video> даже при скрытой картинке
    el.querySelector(".gcall-name").innerHTML = escapeHtml(name) + (muted ? ' <span class="gcall-muted" aria-hidden="true">🔇</span>' : "");
  }
}
function CSS_ESC(s) { return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/[^\w-]/g, (c) => "\\" + c); }
