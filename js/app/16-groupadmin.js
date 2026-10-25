"use strict";
// V.80: админ-инструменты группы (роли admin/moderator/member, кик/бан с причиной, медленный режим, закрепление по ролям, одобрение входа, передача владения).
// Логика и права — js/groupadmin.js (GroupAdmin); здесь отправка подписанных действий, их приём на получателе и панель «Дополнительно» в сведениях о группе.
// Только function-объявления: бандл склеен в один скрипт, const/let из этого файла к моменту раннего запуска были бы недоступны.
var __gaSlowLast = new Map();

function groupMyRank(g) { return GroupAdmin.rank(g, Store.myId); }
// Подписать действие, применить у себя и разослать участникам (получатели заново проверяют права и подпись)
async function groupAdminDo(groupId, fields) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup || g.isChannel) return false;
  if (!GroupAdmin.can(g, Store.myId, fields)) { toast(T("toast.groupAdminOnly")); return false; }
  const recipients = g.members.map((m) => m.id).filter((id) => id !== Store.myId);
  const oldIds = g.members.map((m) => m.id);
  const { act, sig } = await GroupAdmin.make(g, Store.myId, Store.myPrivateKeyJwk, fields);
  const r = GroupAdmin.apply(g, act, Date.now(), Store.myId);
  if (!r.ok) { toast(T("toast.groupAdminOnly")); return false; }
  groupAdminAfterApply(g, r, oldIds, act);
  const payload = { kind: "group-admin", id: crypto.randomUUID(), groupId, act, sig };
  for (const id of recipients) { const mc = ensureContactEntry(id, null); trySendOrQueue(mc, crypto.randomUUID(), payload).catch(() => {}); }
  if (GroupAdmin.rank(g, Store.myId) >= 2 && (act.op === "kick" || act.op === "role" || act.op === "transfer")) broadcastGroupRoster(g);
  return true;
}
function groupAdminAfterApply(g, r, oldIds, act) {
  if (r.sys) {
    const params = Object.assign({}, r.sys.params);
    if (r.sys.key === "group.systemUnbanned") params.name = (state.contacts.get(act.target) || {}).name || T("sys.someone");
    g.messages.push({ id: crypto.randomUUID(), from: "system", text: T(r.sys.key, params), textKey: r.sys.key, textParams: params, ts: Date.now() });
    trimMessages(g);
  }
  g.lastActivity = Date.now();
  if (r.removed) gkOnRosterChange(g, oldIds);
  persistContacts();
  if (state.chatId === g.id) { try { renderChatThread(); updateSendVsMic(); } catch (e) {} }
  if (state.tab === "chats") renderChatsList();
  if (state.activeGroupContext === g.id && !$("#group-info-sheet").classList.contains("hidden")) openGroupInfo(g.id);
}
async function handleGroupAdmin(from, payload) {
  const g = state.contacts.get(payload.groupId);
  if (!g || !g.isGroup || g.isChannel || !payload.act || payload.act.by !== from) return;
  const c = state.contacts.get(from);
  if (!(await GroupAdmin.verifyAct(c && c.publicKey, payload.act, payload.sig))) { etherLog("warn", "[group-admin] подпись не прошла"); return; }
  const oldIds = g.members.map((m) => m.id);
  const r = GroupAdmin.apply(g, payload.act, Date.now(), Store.myId);
  if (!r.ok) { etherLog("warn", "[group-admin] отклонено:", r.reason); return; }
  if (r.removedSelf) { // меня исключили: убираем группу локально (как при выходе) и сообщаем причину
    toast(payload.act.reason ? T("toast.groupKickedReason", { name: g.name, reason: payload.act.reason }) : T("toast.groupKicked", { name: g.name }));
    try { GroupKeys.dropGroup(g.id); } catch (e) {}
    state.contacts.delete(g.id); delete state.drafts[g.id]; persistDrafts(); persistContacts();
    if (state.chatId === g.id) { state.chatId = null; __lastRenderedChatId = null; renderTab(); } else if (state.tab === "chats") renderChatsList();
    return;
  }
  groupAdminAfterApply(g, r, oldIds, payload.act);
}
// Закрепление сообщения в группе: по политике ролей (pinPolicy), у всех через подписанное действие
function groupAdminPin(g, msgId) {
  const unpin = g.pinnedMessageId === msgId;
  if (!GroupAdmin.can(g, Store.myId, { op: "pin" })) { toast(T("toast.groupPinDenied")); return; }
  groupAdminDo(g.id, { op: "pin", msgId: unpin ? "" : msgId });
}
function groupSlowCheck(g) { // отправитель: сколько ждать до следующего сообщения (мс), 0 — можно
  return GroupAdmin.slowWaitMs(g, Store.myId, Date.now(), __gaSlowLast);
}
function groupSlowNoteSent(g) { if (g.slowSec) __gaSlowLast.set(g.id + "|" + Store.myId, Date.now()); }
function groupSlowAccept(g, from) { return GroupAdmin.slowAllowed(g, from, Date.now(), __gaSlowLast); }

// ---- Одобрение входа по ссылке ----
function groupQueueJoin(g, from, name) {
  g.pendingJoins = (g.pendingJoins || []).filter((p) => p.id !== from);
  g.pendingJoins.push({ id: from, name: String(name || "").slice(0, 40), ts: Date.now() });
  if (g.pendingJoins.length > 30) g.pendingJoins.shift();
  persistContacts();
  toast(T("toast.groupJoinPending", { name: name || T("sys.someone"), group: g.name }));
  if (state.activeGroupContext === g.id) openGroupInfo(g.id);
}
function groupResolveJoin(groupId, userId, approve) {
  const g = state.contacts.get(groupId); if (!g || !isGroupAdmin(g, Store.myId)) return;
  const p = (g.pendingJoins || []).find((x) => x.id === userId); g.pendingJoins = (g.pendingJoins || []).filter((x) => x.id !== userId);
  if (approve && p) { ensureContactEntry(userId, p.name || null); addGroupMember(groupId, userId); }
  persistContacts(); openGroupInfo(groupId);
}
// Подписанная ссылка с сроком действия (3600 / 86400 / 604800 с) и признаком одобрения
async function buildSignedGroupInvite(groupId, ttlSec, needApproval) {
  const base = buildGroupInviteCode(groupId); if (!base) return null;
  if (!ttlSec && !needApproval) return base;
  const exp = ttlSec ? Date.now() + ttlSec * 1000 : 0, ap = !!needApproval;
  const sg = await GroupAdmin.signInvite(Store.myPrivateKeyJwk, groupId, Store.myId, exp, ap);
  return base + "&exp=" + exp + "&ap=" + (ap ? 1 : 0) + "&sg=" + encodeURIComponent(sg);
}
async function checkJoinRequest(g, from, payload) { // true — запрос допустим; устанавливает payload._needApproval
  const exp = Number(payload.exp) || 0, ap = payload.ap === 1 || payload.ap === true;
  if (exp || ap) {
    if (typeof payload.sg !== "string" || !(await GroupAdmin.verifyInvite(Store.myPublicKeyJwk, g.id, Store.myId, exp, ap, payload.sg))) return false; // срок/признак подделаны
    if (exp && Date.now() > exp) return false;
  }
  payload._needApproval = ap || !!g.joinApproval;
  return true;
}

// ---- Панель «Дополнительно» в сведениях о группе ----
function renderGroupAdminPanel(g) {
  const sheetPanel = $("#group-info-sheet .sheet-panel"); if (!sheetPanel) return;
  let box = $("#group-admin-panel"); if (box) box.remove();
  const rank = groupMyRank(g); if (rank < 1 || g.isChannel) return;
  box = document.createElement("details"); box.id = "group-admin-panel"; box.className = "group-admin-panel";
  const sum = document.createElement("summary"); sum.textContent = T("group.admin.advanced"); box.appendChild(sum);
  const row = (label, el) => { const l = document.createElement("label"); l.className = "settings-row"; const s = document.createElement("span"); s.textContent = label; l.appendChild(s); l.appendChild(el); box.appendChild(l); return l; };
  const sel = (opts, cur, onChange, aria) => { const s = document.createElement("select"); s.className = "rename-input"; s.setAttribute("aria-label", aria); for (const [v, lab] of opts) { const o = document.createElement("option"); o.value = String(v); o.textContent = lab; if (String(v) === String(cur)) o.selected = true; s.appendChild(o); } s.addEventListener("change", () => onChange(s.value)); return s; };
  if (rank >= 2) {
    row(T("group.slowMode"), sel(GroupAdmin.SLOW_CHOICES.map((s) => [s, s ? (s < 60 ? T("group.slow.sec", { n: s }) : T("group.slow.min", { n: s / 60 })) : T("group.slow.off")]), g.slowSec || 0, (v) => groupAdminDo(g.id, { op: "settings", settings: { slowSec: Number(v) } }), T("group.slowMode")));
    row(T("group.pinPolicy"), sel([["admins", T("group.pin.admins")], ["mods", T("group.pin.mods")], ["all", T("group.pin.all")]], g.pinPolicy || "mods", (v) => groupAdminDo(g.id, { op: "settings", settings: { pinPolicy: v } }), T("group.pinPolicy")));
    const ja = document.createElement("input"); ja.type = "checkbox"; ja.className = "switch"; ja.checked = !!g.joinApproval; ja.addEventListener("change", () => groupAdminDo(g.id, { op: "settings", settings: { joinApproval: ja.checked } }));
    row(T("group.joinApproval"), ja);
  }
  const reason = document.createElement("input"); reason.type = "text"; reason.className = "rename-input"; reason.maxLength = GroupAdmin.MAX_REASON; reason.placeholder = T("group.kickReason"); reason.setAttribute("aria-label", T("group.kickReason")); box.appendChild(reason);
  const list = document.createElement("div"); list.className = "forward-list"; box.appendChild(list);
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const mr = GroupAdmin.rank(g, m.id), r = document.createElement("div"); r.className = "forward-row";
    const nm = document.createElement("span"); nm.className = "forward-name"; nm.textContent = m.name + " · " + T("group.role." + GroupAdmin.role(g, m.id)); r.appendChild(nm);
    const btn = (label, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "icon-btn small"; b.textContent = label; b.setAttribute("aria-label", label + ": " + m.name); b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); }); r.appendChild(b); };
    if (GroupAdmin.can(g, Store.myId, { op: "role", target: m.id, role: mr === 1 ? "member" : "moderator" }) && mr <= 1) btn(mr === 1 ? T("group.unmoderator") : T("group.moderator"), () => groupAdminDo(g.id, { op: "role", target: m.id, role: mr === 1 ? "member" : "moderator" }));
    if (GroupAdmin.can(g, Store.myId, { op: "kick", target: m.id })) btn(T("group.kick"), () => groupAdminDo(g.id, { op: "kick", target: m.id, reason: reason.value.trim() }));
    if (GroupAdmin.can(g, Store.myId, { op: "transfer", target: m.id })) btn(T("group.transferOwner"), () => { if (confirm(T("group.transferConfirm", { name: m.name }))) groupAdminDo(g.id, { op: "transfer", target: m.id }); });
    list.appendChild(r);
  }
  if (rank >= 2 && (g.banned || []).length) {
    const h = document.createElement("p"); h.className = "fine muted"; h.textContent = T("group.bannedList"); box.appendChild(h);
    for (const id of g.banned) {
      const r = document.createElement("div"); r.className = "forward-row"; const nm = document.createElement("span"); nm.className = "forward-name";
      nm.textContent = ((state.contacts.get(id) || {}).name || id.slice(0, 8)) + ((g.banReasons || {})[id] ? " — " + g.banReasons[id] : ""); r.appendChild(nm);
      const b = document.createElement("button"); b.type = "button"; b.className = "icon-btn small"; b.textContent = T("group.unban"); b.addEventListener("click", () => groupAdminDo(g.id, { op: "unban", target: id })); r.appendChild(b); box.appendChild(r);
    }
  }
  if (rank >= 2 && (g.pendingJoins || []).length) {
    const h = document.createElement("p"); h.className = "fine muted"; h.textContent = T("group.pendingJoins"); box.appendChild(h);
    for (const p of g.pendingJoins) {
      const r = document.createElement("div"); r.className = "forward-row"; const nm = document.createElement("span"); nm.className = "forward-name"; nm.textContent = p.name || p.id.slice(0, 8); r.appendChild(nm);
      for (const [ap, lab] of [[true, T("group.approve")], [false, T("group.reject")]]) { const b = document.createElement("button"); b.type = "button"; b.className = "icon-btn small"; b.textContent = lab; b.setAttribute("aria-label", lab + ": " + nm.textContent); b.addEventListener("click", () => groupResolveJoin(g.id, p.id, ap)); r.appendChild(b); }
      box.appendChild(r);
    }
  }
  const anchor = $("#group-info-add-btn"); if (anchor && anchor.parentNode === sheetPanel) sheetPanel.insertBefore(box, anchor); else sheetPanel.appendChild(box);
}
// Выбор срока действия и одобрения в окне ссылки-приглашения (вставляется один раз, в «Дополнительно»)
function gaInviteControls(groupId) {
  const out = $("#group-invite-code-out"); if (!out || !out.parentNode) return;
  let box = $("#gadm-invite-opts");
  if (!box) {
    box = document.createElement("details"); box.id = "gadm-invite-opts";
    const sum = document.createElement("summary"); sum.textContent = T("group.admin.advanced"); box.appendChild(sum);
    const sel = document.createElement("select"); sel.id = "gadm-invite-exp"; sel.className = "rename-input"; sel.setAttribute("aria-label", T("group.invite.expiry"));
    for (const [v, k] of [[0, "group.invite.never"], [3600, "group.invite.1h"], [86400, "group.invite.1d"], [604800, "group.invite.7d"]]) { const o = document.createElement("option"); o.value = String(v); o.textContent = T(k); sel.appendChild(o); }
    const ap = document.createElement("input"); ap.type = "checkbox"; ap.id = "gadm-invite-ap"; ap.className = "switch";
    const l1 = document.createElement("label"); l1.className = "settings-row"; l1.innerHTML = "<span></span>"; l1.firstChild.textContent = T("group.invite.expiry"); l1.appendChild(sel);
    const l2 = document.createElement("label"); l2.className = "settings-row"; l2.innerHTML = "<span></span>"; l2.firstChild.textContent = T("group.joinApproval"); l2.appendChild(ap);
    box.appendChild(l1); box.appendChild(l2); out.parentNode.insertBefore(box, out);
    const regen = async () => {
      const gid = state.activeGroupContext; if (!gid) return;
      const code = await buildSignedGroupInvite(gid, Number(sel.value), ap.checked); if (!code) return;
      out.textContent = code; renderQrToCanvas($("#group-invite-qr-canvas"), code);
    };
    sel.addEventListener("change", regen); ap.addEventListener("change", regen);
  }
  $("#gadm-invite-exp").value = "0"; $("#gadm-invite-ap").checked = false;
}
