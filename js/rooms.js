// =====================================================================
// Голосовые комнаты: постоянная «комната» внутри группы. Заходишь и выходишь когда угодно, без звонка и мелодии;
// в чате видно, кто сейчас внутри. Построено на групповом звонке (group-call.js, mesh) — это значит до GCALL_MAX участников
// одновременно и присутствие видно только по P2P-связи с участниками (сервер ничего не знает о комнате).
// Присутствие: kind:"gcall", t:"presence" с пульсом раз в 20 с; запись живёт 60 с без пульса.
// Загружается после group-call.js; использует его глобалы.
// =====================================================================
const ROOM_PULSE_MS = 20000, ROOM_TTL_MS = 60000;
const ROOMS = { present: new Map(), pulse: null, bar: null }; // present: gid -> Map(userId -> { name, ts })

function roomGroup(gid) { const g = gcallGroup(gid); return g && g.room ? g : null; }
function roomMarkPresent(gid, id, name, on) {
  let m = ROOMS.present.get(gid);
  if (on) { if (!m) ROOMS.present.set(gid, (m = new Map())); m.set(id, { name: name || "", ts: Date.now() }); }
  else if (m) { m.delete(id); if (!m.size) ROOMS.present.delete(gid); }
}
// Кто сейчас в комнате: свежие записи + я сам, если в её звонке
function roomMembers(gid) {
  const g = gcallGroup(gid); if (!g) return [];
  const out = [], m = ROOMS.present.get(gid), now = Date.now();
  if (m) for (const [id, e] of Array.from(m)) {
    if (now - e.ts > ROOM_TTL_MS || !gcallIsMember(g, id)) { m.delete(id); continue; }
    out.push({ id, name: gcallMemberName(g, id) || e.name });
  }
  if (GC.gid === gid && !out.some((x) => x.id === Store.myId)) out.unshift({ id: Store.myId, name: T("chat.poll.you") });
  return out;
}
function roomSendPresence(gid, on) {
  const g = gcallGroup(gid); if (!g) return;
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const l = mesh && mesh.get(m.id);
    if (!l || !gcallLinkOk(m.id)) continue;
    try { l.send({ kind: "gcall", gid, t: "presence", on: !!on, room: true, name: Store.name || "", ts: Date.now() }); } catch (e) {}
  }
}
function roomStartPulse(gid) {
  clearInterval(ROOMS.pulse);
  ROOMS.pulse = setInterval(() => { if (GC.gid === gid) roomSendPresence(gid, true); else { clearInterval(ROOMS.pulse); ROOMS.pulse = null; } roomRenderBar(); }, ROOM_PULSE_MS);
}
async function joinRoom(gid) {
  const g = roomGroup(gid); if (!g) return false;
  if (GC.gid === gid) return true;
  if (GC.gid || state.callId) { toast(T("toast.alreadyInCall")); return false; }
  await joinGroupCall(gid); // без приглашения и мелодии: тот же вход, что и в обычный звонок
  if (GC.gid !== gid) return false;
  roomSendPresence(gid, true); roomStartPulse(gid); roomRenderBar();
  return true;
}
function leaveRoom() { if (GC.gid && roomGroup(GC.gid)) leaveGroupCall({ silent: true }); }
function roomSetEnabled(gid, on) {
  const g = gcallGroup(gid); if (!g) return;
  g.room = !!on || undefined;
  try { persistContacts(); } catch (e) {}
  for (const m of g.members) { // флаг комнаты рассылает администратор
    if (m.id === Store.myId) continue;
    const l = mesh && mesh.get(m.id); if (!l || !gcallLinkOk(m.id)) continue;
    try { l.send({ kind: "gcall", gid, t: "presence", on: false, room: !!on, setRoom: true, ts: Date.now() }); } catch (e) {}
  }
  roomRenderBar();
}
// Перехват входящих gcall-сообщений; true — сообщение разобрано здесь
function roomHandle(fromId, p, g) {
  if (p.t === "presence") {
    if (p.room === true && !g.room && typeof p.setRoom !== "boolean") g.room = true;
    if (typeof p.setRoom === "boolean" && isGroupAdmin(g, fromId)) { g.room = p.room ? true : undefined; if (!p.room) ROOMS.present.delete(g.id); try { persistContacts(); } catch (e) {} }
    if (g.room) roomMarkPresent(g.id, fromId, String(p.name || "").slice(0, 40), !!p.on);
    roomRenderBar(); return true;
  }
  if (!g.room) return false;
  if (p.t === "leave" || p.t === "end") { roomMarkPresent(g.id, fromId, "", false); roomRenderBar(); return false; }
  // В комнатной группе «invite»/«join» вне нашего звонка — это просто присутствие, а не приглашение со звонком
  if ((p.t === "invite" || p.t === "join") && GC.gid !== g.id) { roomMarkPresent(g.id, fromId, "", true); roomRenderBar(); return true; }
  if (p.t === "join" && GC.gid === g.id) roomMarkPresent(g.id, fromId, "", true);
  return false;
}
function roomRenderBar() {
  const bar = document.getElementById("room-bar"); if (!bar) return;
  const gid = state.chatId, g = gid && roomGroup(gid);
  if (!g) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  const inside = roomMembers(gid), me = GC.gid === gid;
  const names = inside.map((x) => x.name).join(", ");
  bar.classList.remove("hidden");
  bar.innerHTML = `<span class="room-ico">${Icons.html("mic", 18)}</span><span class="room-text"><b>${escapeHtml(T("room.title"))}</b><span>${escapeHtml(inside.length ? T("room.inside", { names }) : T("room.empty"))}</span></span><button type="button" class="room-btn${me ? " is-leave" : ""}">${escapeHtml(T(me ? "room.leave" : "room.join"))}</button>`;
  bar.querySelector(".room-btn").addEventListener("click", () => { if (me) leaveRoom(); else joinRoom(gid); });
}
// Выход из звонка комнаты: сообщаем, что нас там больше нет, и гасим пульс
if (typeof leaveGroupCall === "function") {
  const _roomOrigLeave = leaveGroupCall;
  leaveGroupCall = function (opts) {
    const gid = GC.gid, isRoom = !!(gid && roomGroup(gid));
    const r = _roomOrigLeave.apply(this, arguments);
    if (isRoom) { roomSendPresence(gid, false); roomMarkPresent(gid, Store.myId, "", false); clearInterval(ROOMS.pulse); ROOMS.pulse = null; roomRenderBar(); }
    return r;
  };
}
function roomWire() {
  const t = document.getElementById("group-info-room");
  if (t && !t.dataset.wired) { t.dataset.wired = "1"; t.addEventListener("change", () => { const gid = state.activeGroupContext; if (gid) roomSetEnabled(gid, t.checked); }); }
  if (!ROOMS.bar) ROOMS.bar = setInterval(roomRenderBar, 15000); // истечение записей без пульса
}
