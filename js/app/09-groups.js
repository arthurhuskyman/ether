"use strict";
// Часть 9 из 14 бывшего js/app.js: Групповые чаты, invite-ссылки. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Групповые чаты (полносвязная mesh, до MAX_GROUP_MEMBERS участников)
// =====================================================================
// Каждый участник напрямую P2P-подключён к каждому другому — группового
// сервера нет, сообщение просто рассылается N-1 раз через уже
// существующий 1-к-1 канал каждому (P2P если на связи, иначе — через тот
// же зашифрованный почтовый ящик, что и обычные сообщения). Поэтому
// группа наследует ту же гарантию доставки офлайн-участникам, что и
// обычная переписка — почти бесплатно. Сознательное ограничение
// масштаба: 10 участников, дальше mesh перестаёт быть практичной.
const MAX_GROUP_MEMBERS = 10;

function isGroup(c) { return !!(c && c.isGroup); }

// Роли в группе: создатель группы (g.createdBy) всегда админ, даже если
// запись об этом потерялась при синхронизации — остальные становятся
// админами только явно (m.role === "admin"), назначаются другим админом.
function isGroupAdmin(g, userId) {
  if (!g || !userId) return false;
  const m = g.members.find((x) => x.id === userId);
  if (!m) return false;                     // вышедший или удалённый создатель больше не админ
  return g.createdBy === userId || m.role === "admin";
}
function setGroupMemberRole(groupId, memberId, role) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  const m = g.members.find((x) => x.id === memberId); if (!m) return;
  m.role = role;
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T(role === "admin" ? "group.systemPromoted" : "group.systemDemoted", { name: m.name }), textKey: role === "admin" ? "group.systemPromoted" : "group.systemDemoted", textParams: { name: m.name }, ts: Date.now() });
  trimMessages(g);
  persistContacts();
  broadcastGroupRoster(g);
  if (state.chatId === groupId) renderChatThread();
}

// @упоминания в группах: ищем "@" + имя как отдельное слово, без учёта
// регистра. Простая, но достаточная эвристика — полноценный токенайзер
// избыточен для мессенджера на 10 участников.
function isMentioned(text, name) {
  if (!text || !name) return false;
  const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  const re = new RegExp("@" + escaped + "(?![\\p{L}\\p{N}_])", "iu");
  return re.test(text);
}

function createGroup(name, memberIds, avatar) {
  { const lim = groupMemberLimit(memberIds); if (memberIds.length + 1 > lim) { toast(T("toast.groupTooBig", { max: lim })); return null; } }
  if (memberIds.length === 0) { toast(T("toast.groupNeedsMembers")); return null; }
  const groupId = crypto.randomUUID();
  const members = memberIds.map((id) => {
    const c = state.contacts.get(id);
    return { id, name: (c && c.name) || T("sys.someone") };
  });
  members.push({ id: Store.myId, name: Store.name || T("sys.someone"), role: "admin" });
  const g = {
    id: groupId, isGroup: true, name: (name || "").trim() || T("group.defaultName"),
    members, messages: [], lastActivity: Date.now(), archived: false, muted: false,
    createdBy: Store.myId, managed: true,
  };
  if (avatar) g.avatar = avatar; // dataURL, уменьшенный до компактного размера на клиенте перед сохранением
  state.contacts.set(groupId, g);
  persistContacts();
  g.messages.push({
    id: crypto.randomUUID(), from: "system",
    text: T("group.systemCreated", { name: g.name }),
    textKey: "group.systemCreated",
    textParams: { name: g.name },
    ts: Date.now()
  });
  trimMessages(g);
  persistContacts();
  broadcastGroupRoster(g);
  for (const m of members) {
    if (m.id === Store.myId) continue;
    attemptConnect(m.id);
    attemptConnectViaRelay(m.id).catch(() => {});
  }
  etherLog("info", "[group] createGroup:", "id=" + groupId.slice(0, 8) + "…", "name=" + JSON.stringify(g.name), "members=" + members.length);
  return groupId;
}
// Рассылает текущий состав/название группы всем участникам — при
// создании, добавлении/удалении участника или переименовании.
function broadcastGroupRoster(g) {
  // ver — монотонный счётчик версии ростера; растёт только у админа (его правки и рассылаются). Старые клиенты поле игнорируют.
  if (isGroupAdmin(g, Store.myId)) { g.rosterVer = (Number.isInteger(g.rosterVer) ? g.rosterVer : 0) + 1; persistContacts(); }
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    sendGroupRosterTo(g, m.id);
  }
  gkPublishRoster(g);
}
// Единственная точка отправки ростера ОДНОМУ конкретному участнику —
// переиспользуется и явной рассылкой всем (выше), и авто-восстановлением
// при переподключении (ниже). Раньше группа синхронизировалась только
// при явном действии (добавили/убрали участника) — если у ОРГАНИЗАТОРА
// (или любого участника) локальные данные исчезли (переустановка
// приложения — своего сервер-бэкапа контактов/групп у приложения нет),
// НИЧЕГО не пересылало ему ростер заново, пока кто-то не совершит новое
// действие в группе. Группа просто не появлялась у него снова.
// В ростере группы своя запись несёт srv (мои домашние серверы); чужие записи не трогаем — чужие серверы я не раскрываю
function srvRosterMembers(members) {
  const srv = srvHintsWire(); if (!srv) return members;
  return members.map((m) => (m && m.id === Store.myId ? Object.assign({}, m, { srv }) : m));
}
function sendGroupRosterTo(g, memberId) {
  { const bc = state.contacts.get(memberId); if (bc && bc.blocked) return; }
  const payload = { kind: "group-invite", id: crypto.randomUUID(), groupId: g.id, groupName: g.name, members: srvRosterMembers(g.members), groupAvatar: g.avatar || undefined, groupDescription: g.description || undefined };
  if (g.createdBy) payload.createdBy = g.createdBy; // B5: создатель едет в ростере — иначе получатель новой группы делал создателем/админом того, кто прислал (любого участника при авто-досылке)
  if (g.rosterVer > 0) payload.ver = g.rosterVer;
  if (typeof idMigGroupPayloadFor === "function") idMigGroupPayloadFor(payload, memberId); // контакту, знающему меня под старым id, ростер уходит с прежним id
  if (g.writeRestricted) payload.writeRestricted = true;
  else if (typeof g.writeRestricted === "boolean") payload.writeRestricted = false;
  etherLog("info", "[group] roster →", String(memberId).slice(0, 8) + "…", "groupId=" + String(g.id).slice(0, 8) + "…", "payload.id=" + String(payload.id).slice(0, 8) + "…");
  const mc = ensureContactEntry(memberId, (g.members.find((m) => m.id === memberId) || {}).name);
  trySendOrQueue(mc, crypto.randomUUID(), payload).catch(() => {});
}
async function sendGroupMessage(groupId, text, replyTo) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return false;
  if (g.isChannel) return channelSendPost(g, text, replyTo);
  if (!isGroupWriteAllowed(g, Store.myId)) { toast(T("toast.groupWriteRestricted")); return false; }
  { const wait = groupSlowCheck(g); if (wait > 0) { toast(T("toast.groupSlow", { n: Math.ceil(wait / 1000) })); return false; } groupSlowNoteSent(g); }
  text = applyEmojiAutoReplace(text);
  // Симметрично sendChatMessage — иначе длинное сообщение, отправленное
  // программно (retry, вставка через JS), а не через <input maxlength>
  // обычным набором текста, уходит без обрезки.
  if (text.length > MAX_MESSAGE_LENGTH) { text = text.slice(0, MAX_MESSAGE_LENGTH); toast(T("toast.messageCut")); }
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId, from: "me", text, ts, ack: "sent" };
  if (replyTo) rec.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  if (g.disappearingTimer) rec.ttl = g.disappearingTimer;
  g.messages.push(rec); trimMessages(g); g.lastActivity = ts; persistContacts();
  if (state.chatId === groupId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();
  playOutgoingSound();
  haptic("light"); // симметрично sendChatMessage — раньше в группах не вибрировало при отправке
  const payload = { kind: "chat", id: msgId, text, ts, groupId, senderName: Store.name || T("sys.someone") };
  if (replyTo) payload.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  if (g.disappearingTimer) payload.ttl = g.disappearingTimer;
  if (groupUsesSenderKeys(g) && await gkSendChat(g, msgId, payload)) { if (state.chatId === groupId) renderChatThreadInner(); return true; }
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const mc = ensureContactEntry(m.id, m.name);
    // Отдельный id доставки на каждого получателя — outbox в проекте
    // ключуется только по msgId, без адресата; один и тот же msgId на
    // нескольких получателей потерял бы все копии кроме первой.
    const deliveryId = crypto.randomUUID();
    // Фиксируем deliveryId -> {groupId, contentId} ДО отправки — ack от
    // этого получателя (в т.ч. "доставлено"/"прочитано" через много
    // часов, когда outbox-запись давно удалена по deliver-ack с
    // сервера) должен находить именно это сообщение в группе. См.
    // groupDeliveryMap / resolveGroupDelivery.
    groupDeliveryMap.set(deliveryId, { groupId, contentId: msgId, to: m.id });
    trimMap(groupDeliveryMap, GROUP_DELIVERY_MAP_LIMIT);
    persistGroupDeliveryMap();
    await trySendOrQueue(mc, deliveryId, payload);
  }
  return true;
}
function addGroupMember(groupId, memberId) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  if (g.members.some((m) => m.id === memberId)) return;
  { const lim = groupMemberLimit(g.members.map((m) => m.id).concat(memberId)); if (g.members.length >= lim) { toast(T("toast.groupTooBig", { max: lim })); return; } }
  const c = state.contacts.get(memberId);
  if (Array.isArray(g.banned)) g.banned = g.banned.filter((x) => x !== memberId); // админ добавил сам — снимаем запрет
  const gkOld = g.members.map((m) => m.id);
  g.members.push({ id: memberId, name: (c && c.name) || T("sys.someone") });
  gkOnRosterChange(g, gkOld);
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemAdded", { name: (c && c.name) || T("sys.someone") }), textKey: "group.systemAdded", textParams: { name: (c && c.name) || T("sys.someone") }, ts: Date.now() });
  trimMessages(g);
  g.lastActivity = Date.now();
  persistContacts();
  broadcastGroupRoster(g);
  attemptConnect(memberId);
  attemptConnectViaRelay(memberId).catch(() => {});
  if (state.chatId === groupId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
function removeGroupMember(groupId, memberId, leftBySelf) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!leftBySelf && !isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  const wasIn = g.members.some((m) => m.id === memberId);
  if (!wasIn) return;
  const removedName = (g.members.find((m) => m.id === memberId) || {}).name || T("sys.someone");
  const gkOld = g.members.map((m) => m.id);
  g.members = g.members.filter((m) => m.id !== memberId);
  gkOnRosterChange(g, gkOld);
  if (!leftBySelf) { g.banned = (Array.isArray(g.banned) ? g.banned.filter((x) => x !== memberId) : []).concat(memberId).slice(-50); } // исключённый не может вернуться запросом по ссылке
  g.lastActivity = Date.now();
  if (leftBySelf && memberId === Store.myId) {
    // Уход из группы — не полу-рабочее состояние (группа с текстом "вы
    // вышли", в которую всё ещё можно писать и которая продолжает висеть
    // в списке чатов), а полное локальное удаление, как у обычного
    // контакта.
    broadcastGroupRoster(g); // сначала уведомляем оставшихся, пока g.members ещё доступен
    state.contacts.delete(groupId);
    delete state.drafts[groupId]; persistDrafts();
    unreadDividerFor.delete(groupId);
    dividerScrolledFor.delete(groupId);
    state.mentionedChats.delete(groupId); // иначе бейдж @упоминания переживает удаление группы до перезагрузки
    persistContacts();
    if (state.chatId === groupId) { state.chatId = null; __lastRenderedChatId = null; state.multiSelect = null; renderTab(); }
    else if (state.tab === "chats") renderChatsList();
    return;
  }
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: leftBySelf ? T("group.systemLeft", { name: removedName }) : T("group.systemRemoved", { name: removedName }), textKey: leftBySelf ? "group.systemLeft" : "group.systemRemoved", textParams: { name: removedName }, ts: Date.now() });
  trimMessages(g);
  persistContacts();
  // И при добровольном выходе (чтобы остальные узнали, что меня больше
  // нет), и при исключении кем-то другим — рассылаем новый состав
  // оставшимся участникам. Исключение: самого исключённого в новом
  // составе уже нет, поэтому отдельным сообщением он о выходе не узнает
  // этим путём — известное упрощение v1.
  broadcastGroupRoster(g);
  if (state.chatId === groupId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
function setGroupAvatar(groupId, dataUrl) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  g.avatar = dataUrl || null;
  persistContacts();
  if (state.chatId === groupId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
  if (state.contactCardId === groupId) renderContactCard();
}
// killer-features-backlog 0.7 — локальный аватар 1:1 контакта. ПРИНЦИПИАЛЬНО
// локальный: в отличие от группового аватара (который рассылается всем
// участникам через group-invite/roster), этот dataURL никогда не уходит по
// сети — ни пиру, ни на сигнальный сервер. Это просто то, как контакт
// выглядит у МЕНЯ, независимо от того, что показывает он сам.
function setContactAvatar(contactId, dataUrl) {
  const c = state.contacts.get(contactId); if (!c || c.isGroup) return;
  c.avatar = dataUrl || null;
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
  if (state.contactCardId === contactId) renderContactCard();
}
// Сжимаем выбранное фото до маленького квадратного аватара (как иконки
// контактов) — иначе dataURL из телефона в несколько МБ разбухал бы
// persistContacts() (localStorage) на каждую группу.
const AVATAR_SOURCE_MAX_BYTES = 25 * 1024 * 1024; // огромный исходник (TIFF и т.п.) только подвесит вкладку на чтении и декодировании
function readImageAsAvatarDataUrl(file, size = 160) {
  return new Promise((resolve, reject) => {
    if (file && file.size > AVATAR_SOURCE_MAX_BYTES) { reject(new Error("image too large")); return; }
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => { img.onerror = () => reject(new Error("img")); img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size); // B15: JPEG без альфы — прозрачный PNG иначе становился чёрным кругом
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    }; img.src = reader.result; };
    reader.readAsDataURL(file);
  });
}
function renameGroup(groupId, name) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  name = (name || "").trim(); if (!name || name === g.name) return;
  g.name = name;
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemRenamed", { name }), textKey: "group.systemRenamed", textParams: { name }, ts: Date.now() });
  trimMessages(g);
  g.lastActivity = Date.now();
  persistContacts();
  broadcastGroupRoster(g);
  if (state.chatId === groupId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
function setGroupDescription(groupId, description) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  description = (description || "").trim().slice(0, 200);
  if (description === (g.description || "")) return;
  g.description = description || undefined;
  g.lastActivity = Date.now();
  persistContacts();
  broadcastGroupRoster(g);
}
function ensureGroupConnections(g) {
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    ensureContactEntry(m.id, m.name);
    if (!isReachable(state.contacts.get(m.id))) {
      attemptConnect(m.id);
      attemptConnectViaRelay(m.id).catch(() => {});
    }
  }
}

// =====================================================================
// Invite-ссылка в группу (раздел 8/18 роадмапа)
// =====================================================================
// Новый участник изначально не контакт НИКОМУ в группе — "ether://add?"
// тут не поможет (он добавляет только того, кто выдал код, себе в
// контакты, но не добавляет получателя кода В ГРУППУ). Поэтому код
// приглашения кодирует ещё и того, кто его выдал (referrer, уже
// состоящий в группе) и сам groupId — трёхсторонний обмен:
//   1. Я (приглашённый) parse-ю код → добавляю referrer-а в контакты
//      (если его ещё нет) и пытаюсь к нему подключиться.
//   2. Как только есть связь (или через очередь/relay, см.
//      trySendOrQueue) — шлю referrer-у payload "group-join-request".
//   3. Если referrer — админ группы, обычный addGroupMember() добавляет
//      меня: это само рассылает новый ростер всем участникам и пытается
//      подключиться ко мне, без дополнительного кода.
// Генерировать ссылку может только админ (кнопка скрыта у остальных в
// openGroupInfo) — иначе join-request пришёл бы участнику без прав его
// обработать, и приглашённый молча не узнал бы, что приглашение зависло.
function buildGroupInviteCode(groupId) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return null;
  const qs = new URLSearchParams();
  qs.set("gid", groupId);
  qs.set("ref", Store.myId);
  qs.set("rn", Store.name || "");
  qs.set("gn", g.name || "");
  const srv = srvHintsWire(); if (srv) qs.set("srv", srv);
  return "ether://group?" + qs.toString();
}
function parseGroupInviteCode(text) {
  try {
    if (!text || text.indexOf("ether://group?") !== 0) return null;
    const qs = new URLSearchParams(text.slice(text.indexOf("?")));
    const groupId = qs.get("gid"), refId = qs.get("ref");
    if (!groupId || !refId) return null;
    const r = { groupId, refId, refName: qs.get("rn") || "", groupName: qs.get("gn") || "" };
    if (qs.get("exp") != null) { r.exp = Number(qs.get("exp")) || 0; r.ap = qs.get("ap") === "1"; r.sg = qs.get("sg") || ""; }
    const servers = ServerList.decodeHints(qs.get("srv") || "", { allowLocal: srvAllowLocal() });
    if (servers.length) r.servers = servers;
    return r;
  } catch (e) { return null; }
}
async function joinGroupViaInvite(text) {
  const parsed = parseGroupInviteCode(text);
  if (!parsed) { toast(T("toast.badInviteCode")); return false; }
  const { groupId, refId, refName, groupName } = parsed;
  if (parsed.exp && Date.now() > parsed.exp) { toast(T("toast.inviteExpired")); return false; }
  if (refId === Store.myId) { toast(T("toast.ownId")); return false; }
  const existing = state.contacts.get(groupId);
  if (existing && existing.isGroup) { toast(T("toast.groupAlreadyJoined")); return false; }
  if (recentlyDeletedIds.delete(refId)) persistRecentlyDeleted(); // осознанное повторное добавление снимает блокировку из deleteContact
  ensureContactEntry(refId, refName || null);
  if (parsed.servers && parsed.servers.length) srvLearn(refId, parsed.servers);
  persistContacts();
  if (onlineSet.has(refId)) scheduleAutoConnect(refId);
  else attemptConnectViaRelay(refId).catch(() => {});
  const refC = state.contacts.get(refId);
  if (!refC) return false;
  await trySendOrQueue(refC, crypto.randomUUID(), { kind: "group-join-request", groupId, groupName, requesterName: Store.name || "", ...(parsed.sg ? { exp: parsed.exp, ap: parsed.ap ? 1 : 0, sg: parsed.sg } : {}) });
  toast(T("toast.groupJoinRequested", { name: groupName || T("group.defaultName") }));
  return true;
}
function openGroupInviteSheet(groupId) {
  const code = buildGroupInviteCode(groupId); if (!code) return;
  const out = $("#group-invite-code-out"); if (out) out.textContent = code;
  renderQrToCanvas($("#group-invite-qr-canvas"), code);
  try { state.activeGroupContext = groupId; gaInviteControls(groupId); } catch (e) {}
  const sheet = $("#group-invite-sheet"); if (sheet) sheet.classList.remove("hidden");
}

async function forwardContact(fromContactId, toContactId) {
  const shared = state.contacts.get(fromContactId), to = state.contacts.get(toContactId);
  if (!shared || !to) return;
  // B4: заблокированному личному контакту не пересылаем; в группу — только если можно писать
  if (!isGroup(to) && to.blocked) { toast(T("toast.blocked")); return; }
  if (isGroup(to) && !isGroupWriteAllowed(to, Store.myId)) { toast(T("toast.groupWriteRestricted")); return; }
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const inGroup = isGroup(to);
  // В группе карточки контакта получатели не поддерживают (как и в forwardMessage) — уходит текст «📇 имя» каждому участнику.
  const sharedName = shared.name || T("sys.someone");
  const rec = inGroup
    ? { id: msgId, from: "me", text: "📇 " + sharedName, ts, ack: "sent", serverAcked: false, forwarded: true }
    : { id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false, contactCard: { id: shared.id, name: sharedName } };
  if (!inGroup && to.disappearingTimer) rec.ttl = to.disappearingTimer;
  if (inGroup && to.disappearingTimer) rec.ttl = to.disappearingTimer;
  to.messages.push(rec); trimMessages(to); to.lastActivity = ts; persistContacts();
  if (state.chatId === toContactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
  toast(T("toast.contactForwarded"));
  const payload = inGroup
    ? { kind: "chat", id: msgId, ts, text: rec.text, forwarded: true }
    : { kind: "contact-card", id: msgId, ts, contactId: shared.id, contactName: shared.name || "", srv: ServerList.encodeHints(shared.servers || []) || undefined };
  if (rec.ttl) payload.ttl = rec.ttl;
  if (inGroup) await dispatchRich(to, payload, msgId);
  else await trySendOrQueue(to, msgId, payload);
}
// Пересылка в группу: каждому участнику уходит своя копия (как у обычных групповых сообщений), с пометкой «Переслано»
async function forwardIntoGroup(g, rec, m, srcMsgId) {
  const payload = { id: rec.id, ts: rec.ts, groupId: g.id, senderName: Store.name || T("sys.someone"), forwarded: true };
  if (rec.forwardedFrom) payload.fwdFrom = rec.forwardedFrom;
  if (g.disappearingTimer) { payload.ttl = g.disappearingTimer; rec.ttl = g.disappearingTimer; }
  const fail = (msgKey) => {
    if (rec.file) { rec.file.pending = false; rec.file.failed = true; }
    rec.ack = "failed"; persistContacts();
    if (state.chatId === g.id) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    toast(msgKey);
  };
  if (m.file) {
    let blob = null;
    try { blob = await IDB.get("file:" + srcMsgId); } catch (e) {}
    if (!blob) return fail(T("chat.file.unavailable"));
    if (blob.size > GROUP_FILE_MAX) return fail(T("toast.fileTooLarge", { size: formatFileSize(GROUP_FILE_MAX) }));
    try { await IDB.set("file:" + rec.id, blob); } catch (e) {}
    let b64;
    try { b64 = arrayBufferToBase64(await blob.arrayBuffer()); } catch (e) { return fail(T("chat.file.unavailable")); }
    Object.assign(payload, { kind: "file", name: m.file.name, mime: m.file.mime, size: m.file.size, dataB64: b64 });
    if (m.file.duration != null) payload.duration = m.file.duration;
    if (m.file.wave) payload.wave = m.file.wave;
    if (m.file.caption) payload.caption = m.file.caption;
  } else {
    Object.assign(payload, { kind: "chat", text: rec.text || "" });
  }
  for (const mem of g.members) {
    if (mem.id === Store.myId) continue;
    const mc = ensureContactEntry(mem.id, mem.name);
    const deliveryId = crypto.randomUUID();
    groupDeliveryMap.set(deliveryId, { groupId: g.id, contentId: rec.id, to: mem.id });
    trimMap(groupDeliveryMap, GROUP_DELIVERY_MAP_LIMIT);
    persistGroupDeliveryMap();
    await trySendOrQueue(mc, deliveryId, payload);
  }
  if (rec.file) rec.file.pending = false;
  persistContacts();
  if (state.chatId === g.id) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
async function forwardMessage(msgId, fromContactId, toContactId) {
  const from = state.contacts.get(fromContactId), to = state.contacts.get(toContactId);
  if (!from || !to) return;
  const m = from.messages.find((x) => x.id === msgId); if (!m) return;
  if (to.isGroup && !isGroupWriteAllowed(to, Store.myId)) { toast(T("toast.groupWriteRestricted")); return; }
  const msgId2 = crypto.randomUUID();
  const ts = Date.now();
  // Автор оригинала: «Переслано от …» (если сообщение уже пересылали — остаётся первый автор)
  const origName = String(m.forwardedFrom || (m.from === "me" ? (Store.name || "") : (m.fromName || from.name || ""))).slice(0, 40);
  const rec = {
    id: msgId2, from: "me", text: m.text || "", ts,
    ack: "sent", forwarded: true, serverAcked: false,
  };
  if (origName) rec.forwardedFrom = origName;
  if (!to.isGroup && to.disappearingTimer) rec.ttl = to.disappearingTimer; // пересылка не обходит таймер исчезновения
  if (to.isGroup && m.contactCard) { rec.contactCard = undefined; rec.text = "📇 " + (m.contactCard.name || ""); }

  // ── Копируем метаданные файла (если это файл/фото/видео/голосовое) ──
  // Раньше здесь было только text — для файловых сообщений получался
  // пустой пузырь «Переслано» без содержимого. Именно это и было
  // «пересылка не работает».
  if (m.file) {
    rec.file = {
      name: m.file.name,
      mime: m.file.mime,
      size: m.file.size,
      kind: m.file.kind,
      pending: true,
    };
    if (m.file.duration != null) rec.file.duration = m.file.duration;
    if (m.file.wave) rec.file.wave = m.file.wave;
    // retryMessage сохраняет caption при повторной отправке — forwardMessage
    // раньше его терял: подпись к фото/видео пропадала при пересылке.
    if (m.file.caption) rec.file.caption = m.file.caption;
  }
  // ── Копируем карточку контакта ──
  if (m.sticker && !to.isGroup) rec.sticker = Object.assign({}, m.sticker);
  if (m.contactCard && !to.isGroup) { // в группу карточка уходит текстом «📇 имя» — у отправителя должно быть то же самое
    rec.contactCard = { id: m.contactCard.id, name: m.contactCard.name };
  }

  to.messages.push(rec); trimMessages(to); to.lastActivity = ts; persistContacts();
  if (state.chatId === toContactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
  toast(T("toast.forwarded"));

  if (to.isGroup) { await forwardIntoGroup(to, rec, m, msgId); return; }

  // ── 1. ФАЙЛЫ (фото/видео/документ/голосовое) ──
  if (m.file) {
    let blob;
    try { blob = await IDB.get("file:" + msgId); }
    catch (e) { blob = null; }
    if (!blob) {
      // Исходный blob уже удалён (TTL, ручная очистка, IDB сбой) —
      // пересылать нечего. Показываем честно «недоступно».
      rec.file.pending = false;
      rec.file.failed = true;
      rec.ack = "failed";
      persistContacts();
      if (state.chatId === toContactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
      toast(T("chat.file.unavailable"));
      return;
    }
    // Копируем blob под новым ID — иначе исходное сообщение и копия
    // указывали бы на один и тот же ключ IDB, и удаление оригинала
    // утащило бы за собой и пересланную копию.
    try { await IDB.set("file:" + msgId2, blob); }
    catch (e) { etherLog("error", "[forward] IDB.set failed:", String(e)); }

    const link = mesh.get(toContactId);
    const liveLink = link && (link.status === "connected" || link.status === "in-call");

    if (liveLink) {
      // P2P-путь: быстро, не грузит сервер, работает для любых размеров
      // через чанкование (sendFile).
      try {
        const buffer = await blob.arrayBuffer();
        const chunks = [];
        for (let offset = 0; offset < buffer.byteLength; offset += FILE_CHUNK_SIZE) {
          chunks.push(arrayBufferToBase64(buffer.slice(offset, offset + FILE_CHUNK_SIZE)));
        }
        const meta = { id: msgId2, name: m.file.name, mime: m.file.mime, size: m.file.size, forwarded: true };
        if (rec.forwardedFrom) meta.fwdFrom = rec.forwardedFrom;
        if (rec.ttl) meta.ttl = rec.ttl; // B13: таймер исчезновения; webrtc.js sendFile должен копировать fwdFrom/ttl в metaPayload (отдельный исполнитель)
        if (m.file.duration != null) meta.duration = m.file.duration;
        if (m.file.wave) meta.wave = m.file.wave;
        if (m.file.caption) meta.caption = m.file.caption;
        const ok = await link.sendFile(meta, chunks);
        rec.file.pending = false;
        rec.ack = ok ? "sent" : "failed";
      } catch (e) {
        etherLog("error", "[forward] P2P sendFile failed:", String(e));
        rec.file.pending = false;
        rec.ack = "failed";
      }
      persistContacts();
      if (state.chatId === toContactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
      return;
    }

    // Офлайн-путь: через зашифрованный почтовый ящик сервера — тот же
    // путь, что и sendFileOffline. trySendOrQueue сам всё сделает:
    // зашифрует, положит в outbox, отправит.
    try {
      const buffer = await blob.arrayBuffer();
      const payload = {
        kind: "file", id: msgId2,
        name: m.file.name, mime: m.file.mime, size: m.file.size,
        dataB64: arrayBufferToBase64(buffer),
        forwarded: true,
      };
      if (rec.forwardedFrom) payload.fwdFrom = rec.forwardedFrom;
      if (m.file.duration != null) payload.duration = m.file.duration;
      if (m.file.wave) payload.wave = m.file.wave;
    if (m.file.wave) payload.wave = m.file.wave;
      if (m.file.caption) payload.caption = m.file.caption;
      if (rec.ttl) payload.ttl = rec.ttl;
      await trySendOrQueue(to, msgId2, payload);
      rec.file.pending = false;
      persistContacts();
      if (state.chatId === toContactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    } catch (e) {
      etherLog("error", "[forward] offline file failed:", String(e));
      rec.file.pending = false;
      rec.file.failed = true;
      rec.ack = "failed";
      persistContacts();
      if (state.chatId === toContactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }
    return;
  }

  if (m.sticker) { await EtherStickers.forward(m, msgId, rec, to); return; }
  // ── 2. КАРТОЧКА КОНТАКТА ──
  if (m.contactCard) {
    const payload = {
      kind: "contact-card", id: msgId2, ts,
      contactId: m.contactCard.id,
      contactName: m.contactCard.name || "",
      srv: ServerList.encodeHints(m.contactCard.servers || []) || undefined,
      forwarded: true,
    };
    if (rec.forwardedFrom) payload.fwdFrom = rec.forwardedFrom;
    if (rec.ttl) payload.ttl = rec.ttl;
    await trySendOrQueue(to, msgId2, payload);
    return;
  }

  // ── 3. ОБЫЧНЫЙ ТЕКСТ ──
  const payload = { kind: "chat", id: msgId2, text: m.text || "", ts, forwarded: true };
  if (rec.forwardedFrom) payload.fwdFrom = rec.forwardedFrom;
  if (rec.ttl) payload.ttl = rec.ttl;
  await trySendOrQueue(to, msgId2, payload);
}
async function trySendOrQueue(contact, msgId, payloadObj) {
  // «Заметки себе» — локальный self-chat без второй стороны: ему некуда
  // отправлять, нет ни peer-соединения, ни смысла класть в outbox (там
  // бы это зависло навсегда и зря дёргало flushOutboxItem). Любое
  // действие над сообщением в нём (отправка/правка/удаление/пересылка)
  // считается мгновенно доставленным и прочитанным.
  if (contact.isSelf) {
    const mSelf = contact.messages.find((x) => x.id === msgId);
    if (mSelf) { mSelf.ack = "read"; mSelf.serverAcked = true; startExpiryOnRead(mSelf); }
    if (contact.isDemo) demoOnSend(contact, payloadObj);
    return;
  }
  // Раньше ack сразу оптимистично выставлялся в "sent" при создании
  // записи — это была маленькая ложь: на плохой сети между "нажал
  // отправить" и реальной отправкой (P2P или через сервер) может пройти
  // 2-5 секунд. Честный pending-статус на этот момент.
  const mPending = contact.messages.find((x) => x.id === msgId);
  if (mPending && mPending.ack === "sent") {
    mPending.ack = "pending";
    if (state.chatId === contact.id) renderChatThread();
  }
  const link = mesh.get(contact.id);
  const viaServerOnly = typeof Devices !== "undefined" && Devices.needsServer(contact); // есть другие устройства: копии идут только через сервер
  const p2pSent = !viaServerOnly && link && (link.status === "connected" || link.status === "in-call") && link.send(payloadObj);
  addToOutbox(msgId, contact.id, payloadObj);
  if (p2pSent) {
    if (mPending && mPending.ack === "pending") {
      mPending.ack = "sent";
      persistContacts();
      if (state.chatId === contact.id) renderChatThread();
    }
    setTimeout(() => { if (!outbox.has(msgId)) return; flushOutboxItem(msgId); }, P2P_FALLBACK_MS);
    return;
  }
  await flushOutboxItem(msgId);
}
function addToOutbox(msgId, to, payload) {
  if (outbox.has(msgId)) return;
  outbox.set(msgId, { msgId, to, payload, sentAt: Date.now(), attempts: 0, serverAcked: false });
  trimMap(outbox, OUTBOX_LIMIT);
  persistOutbox();
}
// Вложение целиком (base64) в очереди отправки раздувало localStorage (квота ~5–10 МБ на всё приложение, а в группе копия
// на каждого участника). В сохранённой очереди вместо dataB64 лежит ключ IndexedDB, откуда файл достаётся перед отправкой.
function slimPayload(payload) {
  if (!payload || typeof payload.dataB64 !== "string") return payload;
  const { dataB64, ...rest } = payload;
  rest.idbKey = "file:" + payload.id;
  return rest;
}
async function hydratePayload(payload) {
  if (!payload || payload.dataB64 || !payload.idbKey) return payload;
  const blob = await IDB.get(payload.idbKey);
  if (!blob || typeof blob.arrayBuffer !== "function") return null;
  const { idbKey, ...rest } = payload;
  rest.dataB64 = arrayBufferToBase64(await blob.arrayBuffer());
  return rest;
}
function persistOutbox() {
  const arr = Array.from(outbox.values()).map((e) => ({ msgId: e.msgId, to: e.to, payload: slimPayload(e.payload), sentAt: e.sentAt, attempts: e.attempts, serverAcked: !!e.serverAcked }));
  try { Store.outboxJson = JSON.stringify(arr); } catch (e) { handlePersistError(e, "outbox"); }
}
function restoreOutbox() {
  let arr = []; try { arr = JSON.parse(Store.outboxJson) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  for (const e of arr) if (e && typeof e.msgId === "string" && typeof e.to === "string" && e.payload) {
    outbox.set(e.msgId, { msgId: e.msgId, to: e.to, payload: e.payload, sentAt: e.sentAt || Date.now(), attempts: e.attempts || 0, serverAcked: !!e.serverAcked });
  }
}
// См. комментарий у Store.groupDeliveryMapJson и groupDeliveryMap: эта
// карта — единственный надёжный способ сопоставить deliveryId (ack,
// пришедший от конкретного получателя группового сообщения, в том
// числе через много часов после отправки) с самим сообщением в группе,
// независимо от того, жива ли ещё соответствующая запись в outbox.
function persistGroupDeliveryMap() {
  const arr = Array.from(groupDeliveryMap.entries()).map(([deliveryId, v]) => ({ deliveryId, groupId: v.groupId, contentId: v.contentId, to: v.to }));
  try { Store.groupDeliveryMapJson = JSON.stringify(arr); } catch (e) { handlePersistError(e, "groupDeliveryMap"); }
}
function restoreGroupDeliveryMap() {
  let arr = []; try { arr = JSON.parse(Store.groupDeliveryMapJson) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  for (const e of arr) if (e && typeof e.deliveryId === "string" && typeof e.groupId === "string" && typeof e.contentId === "string") {
    groupDeliveryMap.set(e.deliveryId, { groupId: e.groupId, contentId: e.contentId, to: e.to });
  }
}
// Резолвит deliveryId в { ownerChat, targetMsg } для группового
// сообщения "от меня", независимо от состояния outbox. Возвращает null,
// если deliveryId не относится к группе (личные сообщения через эту
// карту не проходят) или сама запись сообщения не найдена (например,
// группу уже удалили).
function resolveGroupDelivery(deliveryId) {
  const entry = groupDeliveryMap.get(deliveryId);
  if (!entry) return null;
  const g = state.contacts.get(entry.groupId);
  const m = g && g.messages.find((mm) => mm.id === entry.contentId && mm.from === "me");
  if (!g || !m) return null;
  return { ownerChat: g, targetMsg: m };
}
// ---- Double Ratchet (js/ratchet.js) для офлайн-конвертов ----
// Конверт для одного msgId шифруется один раз и кэшируется: повторная отправка не должна тратить новые ключи цепочки.
const envelopeCache = new Map();
async function encryptForContact(contact, msgId, payload, forceV1) {
  const cached = envelopeCache.get(msgId);
  if (cached) return cached;
  let envelope = null;
  const serverOk = !!(signaling && Array.isArray(signaling.features) && signaling.features.includes("ratchet2"));
  if (contact.rc && serverOk && !forceV1 && !(typeof Devices !== "undefined" && Devices.isCompanion())) {
    try {
      envelope = await Ratchet.encrypt({ contactId: contact.id, myId: myIdFor(contact.id), myPrivJwk: Store.myPrivateKeyJwk, theirPubJwk: contact.publicKey, getBundle: () => fetchPrekeyBundle(contact.id), v3Ok: !!(signaling && Array.isArray(signaling.features) && signaling.features.includes("pq1")) }, payload);
    } catch (e) { etherLog("warn", "[ratchet] шифрование не удалось, отправляю прежним способом:", String(e)); }
  }
  if (!envelope) {
    const sharedKey = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, contact.publicKey);
    // v2 (AES-GCM с AAD «ether-env-v2|от|кому»: конверт нельзя перенаправить другому адресату/направлению) — только если получатель заведомо умеет
    // (contact.e2) и сервер пропускает такой формат (feature env2); иначе прежний v1, чтобы старые клиенты не теряли сообщения.
    const env2Ok = !!(contact.e2 && signaling && Array.isArray(signaling.features) && signaling.features.includes("env2"));
    envelope = await CryptoHelper.encryptJson(sharedKey, payload, env2Ok ? CryptoHelper.envAad(myIdFor(contact.id), contact.id) : undefined);
    envelope.rc = 1; // «я умею Double Ratchet» — собеседник запомнит и дальше отвечает уже им
  }
  envelope.e2 = 1; // «я умею конверты v2»
  envelopeCache.set(msgId, envelope);
  trimMap(envelopeCache, 200);
  return envelope;
}
// ---- Prekey-пакеты: свои выкладываем на сервер, чужие забираем перед стартом новой сессии ----
let prekeyUploadBusy = false;
async function maybeUploadPrekeys(force) {
  if (!signaling || !signaling.connected || !signaling.registered || prekeyUploadBusy) return;
  if (!Array.isArray(signaling.features) || !signaling.features.includes("prekeys")) return;
  if (!force && !Ratchet.needsPrekeys(signaling.prekeyCount)) return;
  prekeyUploadBusy = true;
  try {
    const payload = await Ratchet.prekeyUploadPayload(30, Store.myPrivateKeyJwk);
    signaling.uploadPrekeys(payload);
    etherLog("info", "[prekey] выложено одноразовых ключей: " + payload.opks.length);
  } catch (e) { etherLog("warn", "[prekey] не удалось подготовить ключи:", String(e)); }
  finally { prekeyUploadBusy = false; }
}
function fetchPrekeyBundle(id, timeoutMs) {
  return new Promise((resolve) => {
    if (!signaling || !signaling.connected || !Array.isArray(signaling.features) || !signaling.features.includes("prekeys")) { resolve(null); return; }
    const rid = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    let done = false, timer = null;
    const handler = (ev) => {
      if (ev.detail.rid !== rid) return;
      finish(ev.detail.error || !ev.detail.spk ? null : { spk: ev.detail.spk, opk: ev.detail.opk });
    };
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); signaling.removeEventListener("prekey-bundle", handler); resolve(v); };
    timer = setTimeout(() => finish(null), timeoutMs || 2500);
    signaling.addEventListener("prekey-bundle", handler);
    if (!signaling.fetchPrekeys(id, rid)) finish(null);
  });
}
// Контакт умеет офлайн-конверты v2 (AAD) — узнаём из флага e2 в конверте, из ping/pong по каналу и из caps в присутствии
function markContactEnv2(c) {
  if (!c || c.e2 || isGroup(c)) return;
  c.e2 = true; persistContacts();
  etherLog("info", "[env2] " + String(c.id).slice(0, 10) + "… поддерживает конверты v2");
}
function markContactRatchet(c) {
  if (!c || c.rc) return;
  c.rc = true; persistContacts();
  etherLog("info", "[ratchet] " + String(c.id).slice(0, 10) + "… поддерживает Double Ratchet");
}
// ---- Доверие к долговременному ключу контакта ----
// Первый увиденный ключ принимается сразу (как и раньше). Любое ПОСЛЕДУЮЩЕЕ изменение ключа — это либо новое устройство
// собеседника, либо подмена: новый ключ не используется, пока человек не подтвердит (c.pendingKey), входящие от нового ключа
// удерживаются (heldDeliveries) и расшифровываются после подтверждения, исходящие ждут в pendingNoKey.
const HELD_LIMIT = 100, HELD_MAX_CHARS = 2000000;
let heldDeliveries = [];
function loadHeld() { try { heldDeliveries = JSON.parse(localStorage.getItem("ether.heldDeliveries") || "[]") || []; } catch (e) { heldDeliveries = []; } if (!Array.isArray(heldDeliveries)) heldDeliveries = []; }
function persistHeld() {
  while (heldDeliveries.length > HELD_LIMIT) heldDeliveries.shift();
  let total = 0;
  for (let i = heldDeliveries.length - 1; i >= 0; i--) {
    total += JSON.stringify(heldDeliveries[i]).length;
    if (total > HELD_MAX_CHARS) { heldDeliveries.splice(0, i + 1); break; }
  }
  try { localStorage.setItem("ether.heldDeliveries", JSON.stringify(heldDeliveries)); } catch (e) { handlePersistError(e, "heldDeliveries"); }
}
// true — ключ можно использовать прямо сейчас; false — он ждёт подтверждения (или отклонён).
// «Проверен» — вы сверили число безопасности (цифры или QR) именно с ТЕКУЩИМ ключом; при смене ключа отметка пропадает сама.
function isContactVerified(c) { return !!(c && c.verifiedKey && c.publicKey && !keysDiffer(c.verifiedKey, c.publicKey)); }
function setContactVerified(id, on) {
  const c = state.contacts.get(id); if (!c || !c.publicKey) return;
  c.verifiedKey = on ? c.publicKey : undefined; persistContacts();
  try { if (state.chatId === id) renderChatThread(); if (state.contactCardId === id) renderContactCard(); } catch (e) {}
}
function noteContactKey(c, newKey) {
  if (!newKey) return !c.pendingKey;
  if (!c.publicKey) { c.publicKey = newKey; return true; }
  if (!keysDiffer(newKey, c.publicKey)) {
    if (c.pendingKey) { c.pendingKey = undefined; persistContacts(); renderKeyChangeBanner(); } // вернулся прежний ключ — ожидание снимается
    return true;
  }
  if (c.rejectedKey && !keysDiffer(newKey, c.rejectedKey)) return false;
  if (!c.pendingKey || keysDiffer(newKey, c.pendingKey.key)) {
    c.pendingKey = { key: newKey, at: Date.now() };
    persistContacts();
    etherLog("warn", "[trust] ключ " + String(c.id).slice(0, 10) + "… изменился — нужно подтверждение");
    try { toast(T("toast.contactKeyChanged", { name: c.name || T("sys.someone") })); } catch (e) {}
    // Ключ собеседника сменился — это важно, даже если приложение свёрнуто: системное уведомление (если разрешены)
    try { if (Store.notificationsEnabled) showNotification(T("notif.keyChanged.title"), T("notif.keyChanged.body", { name: c.name || T("sys.someone") }), { tag: "ether-key-" + c.id, contactId: c.id, kind: "message", force: false }); } catch (e) {}
    try { renderKeyChangeBanner(); if (state.tab === "chats") renderChatsList(); } catch (e) {}
  }
  return false;
}
async function confirmContactKey(id) {
  const c = state.contacts.get(id); if (!c || !c.pendingKey) return;
  c.publicKey = c.pendingKey.key; c.pendingKey = undefined; c.rejectedKey = undefined;
  try { Ratchet.reset(id); } catch (e) {}
  envelopeCache.clear();
  persistContacts();
  etherLog("info", "[trust] ключ " + String(id).slice(0, 10) + "… подтверждён пользователем");
  try { toast(T("toast.keyAccepted", { name: c.name || T("sys.someone") })); } catch (e) {}
  renderKeyChangeBanner(); if (state.tab === "chats") renderChatsList();
  const held = heldDeliveries.filter((h) => h.from === id);
  heldDeliveries = heldDeliveries.filter((h) => h.from !== id); persistHeld();
  for (const h of held) await handleDeliver(h, true);
  flushPendingNoKey(id);
  try { reauthLink(id); } catch (e) {}
}
function rejectContactKey(id) {
  const c = state.contacts.get(id); if (!c || !c.pendingKey) return;
  c.rejectedKey = c.pendingKey.key; c.pendingKey = undefined;
  heldDeliveries = heldDeliveries.filter((h) => h.from !== id); persistHeld();
  persistContacts();
  etherLog("warn", "[trust] новый ключ " + String(id).slice(0, 10) + "… отклонён");
  try { toast(T("toast.keyRejected", { name: c.name || T("sys.someone") })); } catch (e) {}
  renderKeyChangeBanner(); if (state.tab === "chats") renderChatsList();
}
// Баннер в открытом чате: «ключ собеседника изменился» + сверка числа безопасности + принять / отклонить.
function renderKeyChangeBanner() {
  const b = $("#keychange-banner"); if (!b) return;
  const c = state.chatId && state.contacts.get(state.chatId);
  if (!c || !c.pendingKey) { b.classList.add("hidden"); return; }
  const t = b.querySelector(".keychange-text");
  if (t) t.textContent = T("chat.keyChange.text", { name: c.name || T("sys.someone") });
  b.classList.remove("hidden");
}
// Число безопасности: цифры + QR (его можно показать собеседнику или отсканировать его QR — совпадение ставит отметку «проверен»)
let __safetyCtx = null; // { id, key, digits }
async function openSafetySheet(contactId, keyOverride) {
  const c = state.contacts.get(contactId); if (!c) return;
  const key = keyOverride || c.publicKey;
  if (!key || !Store.myPublicKeyJwk) { toast(T("toast.safetyNumberNoKey")); return; }
  const digitsEl = $("#safety-number-digits"); if (digitsEl) digitsEl.textContent = "…";
  const sheet = $("#safety-number-sheet"); if (sheet) sheet.classList.remove("hidden");
  __safetyCtx = { id: contactId, key, digits: "", pending: !!keyOverride };
  try {
    const groups = await CryptoHelper.computeSafetyNumber(Store.myPublicKeyJwk, key);
    __safetyCtx.digits = groups.join("");
    if (digitsEl) digitsEl.innerHTML = groups.map((g) => `<span>${escapeHtml(g)}</span>`).join("");
    const cv = $("#safety-qr-canvas"); if (cv) { try { renderQrToCanvas(cv, "ether://verify?n=" + __safetyCtx.digits); } catch (e) {} }
  } catch (e) { if (digitsEl) digitsEl.textContent = ""; toast(T("toast.safetyNumberNoKey")); }
  refreshSafetyVerifyUi();
}
function refreshSafetyVerifyUi() {
  const ctx = __safetyCtx, c = ctx && state.contacts.get(ctx.id);
  const st = $("#safety-verified-state"), btn = $("#safety-mark-btn"), scan = $("#safety-scan-btn");
  if (!c || !st) return;
  const verified = !ctx.pending && isContactVerified(c);
  st.textContent = verified ? T("safety.verified") : T("safety.unverified");
  st.classList.toggle("is-ok", verified);
  if (btn) { btn.textContent = T(verified ? "safety.unmark" : "safety.mark"); btn.classList.toggle("hidden", !!ctx.pending); }
  if (scan) scan.classList.toggle("hidden", false);
}
function onSafetyQrScanned(data) {
  const ctx = __safetyCtx; if (!ctx || !ctx.digits) return false;
  if (typeof data !== "string" || data.indexOf("ether://verify?n=") !== 0) return false;
  const theirs = data.slice("ether://verify?n=".length);
  if (theirs === ctx.digits) {
    if (!ctx.pending) setContactVerified(ctx.id, true);
    toast(T("safety.match")); refreshSafetyVerifyUi();
  } else toast(T("safety.mismatch"));
  return true;
}
function wireSafetySheet() {
  const mark = $("#safety-mark-btn");
  if (mark && !mark.dataset.wired) { mark.dataset.wired = "1"; mark.addEventListener("click", () => { const ctx = __safetyCtx, c = ctx && state.contacts.get(ctx.id); if (!c || ctx.pending) return; setContactVerified(ctx.id, !isContactVerified(c)); refreshSafetyVerifyUi(); }); }
  const scan = $("#safety-scan-btn");
  if (scan && !scan.dataset.wired) { scan.dataset.wired = "1"; scan.addEventListener("click", () => { qrScanVerifyMode = true; startQrScan(); }); }
}
function wireKeyChangeBanner() {
  const b = $("#keychange-banner"); if (!b || b.dataset.wired) return; b.dataset.wired = "1";
  const withCid = (fn) => () => { const id = state.chatId; if (id) fn(id); };
  const verify = $("#keychange-verify-btn"), ok = $("#keychange-accept-btn"), no = $("#keychange-reject-btn");
  if (verify) verify.addEventListener("click", withCid((id) => { const c = state.contacts.get(id); if (c && c.pendingKey) openSafetySheet(id, c.pendingKey.key); }));
  if (ok) ok.addEventListener("click", withCid(async (id) => {
    const c = state.contacts.get(id);
    if (!await confirmSheet(T("chat.keyChange.confirm", { name: (c && c.name) || T("sys.someone") }))) return;
    confirmContactKey(id);
  }));
  if (no) no.addEventListener("click", withCid((id) => rejectContactKey(id)));
}
async function flushOutboxItem(msgId) {
  const entry = outbox.get(msgId); if (!entry) return;
  if (entry.serverAcked) { outbox.delete(msgId); persistOutbox(); return; }
  const contact = state.contacts.get(entry.to);
  if (!contact) { outbox.delete(msgId); persistOutbox(); return; }
  if (!contact.publicKey || contact.pendingKey) {
    // Нет публичного ключа получателя (или он сменился и ждёт подтверждения) — зашифровать нечем. Кладём в
    // pendingNoKey (уйдёт автоматически, когда ключ появится), НО
    // помечаем сообщение статусом "failed", а не оставляем вечный
    // "pending". Именно это было причиной «голосовые висят с крутящимся
    // спиннером бесконечно, пока собеседник не появится онлайн»: файлы
    // и голосовые имеют свойство file.pending = true, которое никто
    // не сбрасывал — запись в outbox удалялась, а UI продолжал
    // показывать "отправка идёт". Теперь сразу переводим UI в честное
    // "не отправлено" (!), а не держим пользователя в неведении.
    const isFirstTime = !pendingNoKey.has(contact.id) || !pendingNoKey.get(contact.id).some((x) => x.msgId === msgId);
    if (!pendingNoKey.has(contact.id)) pendingNoKey.set(contact.id, []);
    const list = pendingNoKey.get(contact.id);
    if (!list.some((x) => x.msgId === msgId)) { list.push({ msgId, payload: entry.payload }); persistPendingNoKey(); }
    outbox.delete(msgId); persistOutbox();
    // КРИТИЧНО: помечаем сообщение "failed" явно. Без этого ack
    // остаётся "pending" навсегда — в UI это символ ◷ с CSS-
    // анимацией вращения, ровно то, что видел пользователь: "иконка
    // отправки крутится бесконечно, пока второй абонент не
    // подключится". Сообщение уйдёт автоматически, когда ключ
    // появится (flushPendingNoKey), и там ack уже обновится в "sent".
    // Снимаем также file.pending, если это вложение — иначе
    // file-bubble-pending держит спиннер поверх.
    const c0 = state.contacts.get(contact.id);
    if (c0) {
      const m0 = c0.messages.find((x) => x.id === msgId);
      if (m0 && m0.file) m0.file.pending = false;
    }
    markMessageAck(contact.id, msgId, "failed");
    if (isFirstTime) toast(T(contact.pendingKey ? "toast.waitingKeyConfirm" : "toast.waitingForKey", { name: contact.name || T("sys.someone") }));
    return;
  }
  try {
    if (entry.payload && entry.payload.idbKey && !entry.payload.dataB64) {
      const full = await hydratePayload(entry.payload);
      if (!full) { outbox.delete(msgId); persistOutbox(); markMessageAck(entry.to, msgId, "failed"); return; } // файл пропал из IndexedDB — отправить нечего
      entry.payload = full;
    }
    const envelope = await encryptForContact(contact, msgId, entry.payload, entry.forceV1 || (entry.payload && entry.payload.kind === "rc-reset") || (typeof Devices !== "undefined" && Devices.isCompanion()));
    entry.attempts = (entry.attempts || 0) + 1;
    entry.lastAttemptAt = Date.now();
    persistOutbox();
    const kind = (entry.payload && entry.payload.kind) || "chat";
    let devCopies = null; // копии другим устройствам получателя (js/devices.js)
    if (typeof Devices !== "undefined") { try { devCopies = await Devices.copiesFor(contact, entry.payload); } catch (e) { etherLog("warn", "[devices] copies:", String(e)); } }
    const sent = signaling && (devCopies && devCopies.length ? signaling.deliverMulti(entry.to, entry.msgId, envelope, Store.myPublicKeyJwk, kind, devCopies) : signaling.deliver(entry.to, entry.msgId, envelope, Store.myPublicKeyJwk, kind));
    if (sent && typeof Devices !== "undefined") Devices.syncSent(contact, entry.payload).catch(() => {}); // зеркалим отправленное на другие устройства аккаунта
    // Домашние серверы получателя (srv): если активный сервер не среди них или не принял — кладём конверт (тот же, уже зашифрованный) на них по порядку
    const remoteUrls = srvRemoteTargets(contact);
    const needRemote = remoteUrls.length > 0 && (!sent || !contact.servers.some((u) => ServerList.sameServer(u, effectiveSignalingUrl())));
    if (needRemote) {
      entry.needRemote = true;
      if (!entry._remoteBusy) {
        entry._remoteBusy = true;
        srvRemoteDeliver(remoteUrls, entry.to, entry.msgId, envelope, kind).then((url) => {
          entry._remoteBusy = false;
          if (url) {
            entry.remoteAcked = true;
            if (outbox.get(msgId) === entry) outboxMarkServerAcked(msgId, entry);
            if (kind === "chat" || kind === "file") markMessageAck(entry.to, msgId, "sent");
          } else if (!sent) markMessageAck(entry.to, msgId, "failed");
        }).catch(() => { entry._remoteBusy = false; });
      }
    }
    if (!sent) { if (!needRemote) markMessageAck(entry.to, msgId, "failed"); }
    else if (kind === "chat" || kind === "file") {
      // Раньше здесь стояло только `kind === "chat"` — для kind
      // === "file" (голосовые и любые вложения, ушедшие офлайн-путём
      // через сервер) ack НЕ обновлялся, и сообщение навсегда
      // оставалось в состоянии "pending" — с точки зрения UI это
      // вечно крутящийся символ ◷. Именно поэтому голосовое,
      // успешно принятое сервером, визуально висело "отправляется".
      // Комментарий про группы ниже остаётся в силе — markMessageAck
      // уже корректно резолвит группу через outbox-запись.
      markMessageAck(entry.to, msgId, "sent");
    }
  } catch (e) { etherLog("error", "[crypto] encrypt:", String(e)); markMessageAck(entry.to, msgId, "failed"); }
}
async function flushOutbox() {
  if ((!signaling || !signaling.connected) && !srvOutboxHasRemote()) return; // без активного сервера можно доставить через серверы получателя
  const ids = Array.from(outbox.keys());
  for (const id of ids) await flushOutboxItem(id);
  pruneOutbox();
}
function startOutboxRetryLoop() {
  if (outboxRetryTimer) clearInterval(outboxRetryTimer);
  outboxRetryTimer = setInterval(() => { if (outbox.size === 0) return; flushOutbox(); }, OUTBOX_RETRY_INTERVAL_MS);
}
function pruneOutbox() {
  const now = Date.now(); let changed = false;
  for (const [msgId, entry] of outbox) {
    if (entry.serverAcked) { outbox.delete(msgId); changed = true; continue; }
    if (now - entry.sentAt > OUTBOX_MAX_AGE_MS) { outbox.delete(msgId); changed = true; markMessageAck(entry.to, msgId, "failed"); }
    else if (entry.payload && entry.payload.kind === "ack-batch" && now - entry.sentAt > RECEIPT_MAX_AGE_MS) { outbox.delete(msgId); changed = true; }
  }
  if (changed) persistOutbox();
}
// Короткая вспышка пузыря при копировании — отклик «скопировано» на самом сообщении, а не только тостом
function flashCopiedBubble(msgId) {
  const el = Array.from(document.querySelectorAll(".bubble[data-msg-id]")).find((b) => b.getAttribute("data-msg-id") === msgId); if (!el) return;
  el.classList.remove("bubble-copied"); void el.offsetWidth; el.classList.add("bubble-copied");
  setTimeout(() => el.classList.remove("bubble-copied"), 700);
}
function trimMap(map, max) { while (map.size > max) map.delete(map.keys().next().value); }
function persistPendingNoKey() {
  const obj = {};
  for (const [cid, list] of pendingNoKey) { if (!list || list.length === 0) continue; obj[cid] = list.map((x) => ({ msgId: x.msgId, payload: slimPayload(x.payload) })); }
  try { Store.pendingNoKeyJson = JSON.stringify(obj); } catch (e) { handlePersistError(e, "pendingNoKey"); }
}
function restorePendingNoKey() {
  let obj = {}; try { obj = JSON.parse(Store.pendingNoKeyJson) || {}; } catch (e) { obj = {}; }
  if (!obj || typeof obj !== "object") return;
  for (const cid of Object.keys(obj)) { const list = obj[cid]; if (Array.isArray(list)) pendingNoKey.set(cid, list.filter((x) => x && x.msgId && x.payload)); }
}
function flushPendingNoKey(contactId) {
  const list = pendingNoKey.get(contactId); if (!list || list.length === 0) return;
  pendingNoKey.delete(contactId); persistPendingNoKey();
  for (const { msgId, payload } of list) { addToOutbox(msgId, contactId, payload); flushOutboxItem(msgId); }
}
function resumeUnsentMessages() {
  if (!Store.myPublicKeyJwk) return;
  const now = Date.now();
  for (const c of state.contacts.values()) {
    if (isGroup(c)) continue; // групповой fan-out ретраев не поддержан — некуда слать одному "получателю"-группе
    for (const m of c.messages) {
      if (m.from !== "me") continue;
      if (m.serverAcked) continue;
      if (m.ack !== "failed") continue;
      // Файлы, голосовые и карточки контактов НЕ восстанавливаем автоматом:
      // для них нужен исходный Blob из IndexedDB и полный payload, а не
      // просто text. Иначе на сервер уйдёт пустой текстовый конверт, а
      // получатель увидит пустой пузырь — файл потерян. Ручной повтор —
      // через "Повторить" в меню сообщения (см. handleMessageAction).
      if (m.file || m.sticker || m.contactCard || m.poll || m.board || m.note) continue; // опросы/доски/заметки уходят своим payload — как обычный текст они бы потерялись
      if (outbox.has(m.id)) continue;
      if (now - m.ts > RESUME_MAX_AGE_MS) continue;
      const payload = { kind: "chat", id: m.id, text: m.text, ts: m.ts };
      if (m.replyTo) payload.replyTo = { id: m.replyTo.id, text: m.replyTo.text, authorName: m.replyTo.authorName };
      if (m.ttl) payload.ttl = m.ttl;
      if (m.forwarded) { payload.forwarded = true; if (m.forwardedFrom) payload.fwdFrom = m.forwardedFrom; }
      addToOutbox(m.id, c.id, payload);
      flushOutboxItem(m.id);
    }
  }
}

const _recentAckSent = new Map();
function sendAckBatch(contactId, originalMsgIds, ackState) {
  if (!Array.isArray(originalMsgIds) || originalMsgIds.length === 0) return;
  { const lc = state.contacts.get(contactId); if (lc && lc.isSelf) return; } // «Заметки себе» и демо-чат — локальные, квитанции некому слать
  // JSON.stringify, не join(",") — id'шники здесь обычные crypto.
  // randomUUID() без запятых, но join() молча склеил бы два разных
  // набора id в один и тот же ключ, если в массив когда-нибудь попадёт
  // строка с запятой (например, ручной retry через консоль).
  const key = contactId + ":" + ackState + ":" + JSON.stringify(originalMsgIds);
  const now = Date.now();
  const last = _recentAckSent.get(key);
  if (last && now - last < ACK_DEDUP_WINDOW_MS) return;
  _recentAckSent.set(key, now);
  if (_recentAckSent.size > 200) {
    const first = _recentAckSent.keys().next().value;
    _recentAckSent.delete(first);
  }

  const link = mesh.get(contactId);
  const actionId = crypto.randomUUID();
  const payload = { kind: "ack-batch", ids: originalMsgIds.slice(), state: ackState };
  if (link && (link.status === "connected" || link.status === "in-call") && link.send(payload)) return;
  const c = state.contacts.get(contactId); if (!c) return;
  addToOutbox(actionId, contactId, payload);
  flushOutboxItem(actionId);
}

function markMessageAck(contactId, msgId, ack) {
  if (ack === "failed") haptic("medium");
  // Квитанции собеседника принимаем как есть: настройка receiptsEnabled управляет только ОТПРАВКОЙ наших «прочитано» (markThreadRead)
  const rank = { failed: -1, sent: 0, delivered: 1, read: 2 };

  const entry = outbox.get(msgId);
  const groupId = entry && entry.payload && entry.payload.groupId;
  const contentId = entry && entry.payload && entry.payload.id;

  // Ищем сообщение и его чат-«владелец» (личный или групповой).
  // 1) Сначала — прямой путь через outbox-entry, если запись ещё жива.
  // 2) Затем — groupDeliveryMap: переживает удаление outbox-записи по
  //    deliver-ack с сервера, и это ЕДИНСТВЕННЫЙ надёжный путь для
  //    группового сообщения, доставленного через офлайн-mailbox —
  //    настоящая квитанция "доставлено"/"прочитано" от получателя может
  //    прийти через много часов после того, как deliver-ack (просто
  //    подтверждение, что конверт лёг на сервер) уже удалил outbox-
  //    запись. См. resolveGroupDelivery.
  // 3) Затем — личный чат с contactId.
  // 4) В конце — fallback для P2P-групповых ack'ов: при P2P-доставке
  //    deliveryId, который получатель возвращает в ack'е, совпадает с
  //    contentId самого сообщения (см. applyIncomingPayload — там для
  //    P2P-пути envelopeMsgId = payload.id), так что достаточно простого
  //    поиска по id. Без этого fallback'а P2P-групповое сообщение
  //    навсегда осталось бы с одной галочкой.
  let ownerChat = null, targetMsg = null;

  if (groupId && contentId) {
    const g = state.contacts.get(groupId);
    const m = g && g.messages.find((mm) => mm.id === contentId && mm.from === "me");
    if (m) { ownerChat = g; targetMsg = m; }
  }
  if (!targetMsg) {
    const resolved = resolveGroupDelivery(msgId);
    if (resolved) { ownerChat = resolved.ownerChat; targetMsg = resolved.targetMsg; }
  }
  if (!targetMsg) {
    const c = state.contacts.get(contactId);
    const m = c && c.messages.find((mm) => mm.id === msgId && mm.from === "me");
    if (m) { ownerChat = c; targetMsg = m; }
  }
  if (!targetMsg) {
    for (const g of state.contacts.values()) {
      if (!g.isGroup || !g.members.some((x) => x.id === contactId)) continue; // квитанцию может прислать только участник этой группы
      const m = g.messages.find((mm) => mm.id === msgId && mm.from === "me");
      if (m) { ownerChat = g; targetMsg = m; break; }
    }
  }

  // Групповое сообщение уходит каждому участнику отдельно: сбой одного получателя не должен затирать уже полученное/прочитанное другими
  const groupAlreadyOk = !!(ownerChat && ownerChat.isGroup && (rank[targetMsg && targetMsg.ack] ?? -1) >= 1);
  if (targetMsg && ((rank[ack] ?? 0) >= (rank[targetMsg.ack] ?? 0) || (ack === "failed" && !groupAlreadyOk))) {
    targetMsg.ack = ack;
    if (ack === "read") startExpiryOnRead(targetMsg);
    // B7: собеседник отключил квитанции прочтения — «read» не придёт никогда и ttl висел бы 30 суток: считаем от «доставлено»
    else if (ack === "delivered" && ownerChat && !ownerChat.isGroup && ownerChat.peerReceiptsEnabled === false) startExpiryOnRead(targetMsg);
    persistContacts();
    if (ownerChat && state.chatId === ownerChat.id) renderChatThread();
  }

  if (ack === "delivered" || ack === "read") {
    if (outbox.has(msgId)) { outbox.delete(msgId); persistOutbox(); }
  }
  // "read" — старший статус (rank 2), выше него квитанций не бывает,
  // так что groupDeliveryMap-запись для этого deliveryId больше не
  // нужна — убираем, чтобы карта не росла бессмысленно до лимита.
  if (ack === "read" && groupDeliveryMap.has(msgId)) { groupDeliveryMap.delete(msgId); persistGroupDeliveryMap(); }
}
function sendTypingStart(contactId) {
  if (state.typingSendingState.get(contactId)) return;
  state.typingSendingState.set(contactId, true);
  const c = state.contacts.get(contactId); if (!c) return;
  if (state.typingTimers.has(contactId) && state.chatId === contactId) { try { renderChatHeaderSoft(); } catch (e) {} }
  const link = mesh.get(contactId);
  // Typing — временный статус. Если P2P-связи нет, отправлять его через
  // сервер (в офлайн-очередь mailbox) смысла нет: получатель получит
  // "печатает…" уже когда собеседник давно закрыл приложение. Раньше
  // typing уходил в офлайн-очередь наравне с обычными сообщениями —
  // видно в логах сервера: "[deliver] ... kind=typing online=false".
  // Просто ничего не отправляем, если P2P нет.
  if (link && (link.status === "connected" || link.status === "in-call")) {
    link.send({ kind: "typing", active: true });
  }
}
function sendTypingStop(contactId) {
  if (!state.typingSendingState.get(contactId)) return;
  state.typingSendingState.delete(contactId);
  const c = state.contacts.get(contactId); if (!c) return;
  if (state.typingTimers.has(contactId) && state.chatId === contactId) { try { renderChatHeaderSoft(); } catch (e) {} }
  const link = mesh.get(contactId);
  if (link && (link.status === "connected" || link.status === "in-call")) {
    link.send({ kind: "typing", active: false });
  }
}
// Три тумблера приватности сообщаются собеседнику через P2P (тот же
// принцип, что и typing-статус) — сервер тут ни при чём, это прямое
// сообщение между уже связанными пирами.
function sendPrivacyPrefsTo(contactId) {
  { const bc = state.contacts.get(contactId); if (bc && bc.blocked) return; }
  const link = mesh.get(contactId);
  if (!link || (link.status !== "connected" && link.status !== "in-call")) return;
  link.send({ kind: "privacy-pref", receiptsEnabled: Store.receiptsEnabled, lastSeenVisible: Store.lastSeenVisible, presenceVisible: Store.presenceVisible, status: Store.myStatus || "", avatar: Store.myAvatar || "" });
}
function broadcastPrivacyPrefs() {
  for (const c of state.contacts.values()) if (!isGroup(c)) sendPrivacyPrefsTo(c.id);
}
function handleIncomingTyping(contactId, active) {
  const t = state.typingTimers.get(contactId);
  if (t) { clearTimeout(t); state.typingTimers.delete(contactId); }
  if (active) {
    state.typingTimers.set(contactId, setTimeout(() => {
      state.typingTimers.delete(contactId);
      if (state.chatId === contactId) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }, TYPING_AUTO_CLEAR_MS));
  }
  if (state.chatId === contactId) renderChatThread();
  // Раньше "печатает…" было видно только в шапке открытого треда —
  // список чатов ничего не показывал, хотя состояние уже отслеживается.
  if (state.tab === "chats") renderChatsList();
}
// Использованная реакция становится самой первой в "недавних" —
// дедуп, кап на 6.
// Визуальный отклик на быструю реакцию двойным тапом — раньше тап
// просто молча ставил реакцию без какой-либо анимации на экране.
function spawnReactionBurst(bubbleEl, emoji) {
  try {
    const burst = document.createElement("span");
    burst.className = "reaction-burst";
    burst.textContent = emoji;
    bubbleEl.appendChild(burst);
    const cleanup = () => { try { burst.remove(); } catch (e) {} };
    burst.addEventListener("animationend", cleanup, { once: true });
    setTimeout(cleanup, 600); // страховка, если animationend не пришёл (reduced-motion и т.п.)
  } catch (e) {}
}
function recordRecentReaction(emoji) {
  const cur = Store.recentReactions.filter((e) => e !== emoji);
  cur.unshift(emoji);
  Store.recentReactions = cur;
}
async function toggleReaction(contactId, msgId, emoji) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  haptic("light");
  if (!m.reactions || typeof m.reactions !== "object") m.reactions = {};
  if (!Array.isArray(m.reactions[emoji])) m.reactions[emoji] = [];
  const meIdx = m.reactions[emoji].indexOf(Store.myId);
  let remove = false;
  if (meIdx >= 0) { m.reactions[emoji].splice(meIdx, 1); remove = true; if (m.reactions[emoji].length === 0) delete m.reactions[emoji]; }
  else { m.reactions[emoji].push(Store.myId); recordRecentReaction(emoji); }
  persistContacts();
  try { announceToScreenReader(T(remove ? "a11y.reactionRemoved" : "a11y.reactionAdded", { emoji })); } catch (e) {}
  if (state.chatId === contactId) renderChatThread();
  if (c.isChannel) return; // в канале реакции личные (у подписчиков нет канала обратной связи к владельцу)
  const actionId = crypto.randomUUID();
  const payload = { kind: "reaction", id: msgId, emoji, remove, ts: Date.now() };
  await dispatchRich(c, payload);
}
function applyReaction(contactId, payload) {
  const c = resolveEditDeleteTarget(contactId, payload); // группа (отправитель — её участник) или личный чат
  if (!c) return;
  const m = c.messages.find((x) => x.id === payload.id); if (!m) return;
  // Эмодзи — короткая строка без служебных имён: «__proto__»/«constructor» и мегабайтные ключи сохранялись бы в данных
  if (typeof payload.emoji !== "string" || !payload.emoji || payload.emoji.length > 16 || /^(__proto__|constructor|prototype)$/.test(payload.emoji)) return;
  if (!m.reactions || typeof m.reactions !== "object") m.reactions = {};
  if (!Array.isArray(m.reactions[payload.emoji])) m.reactions[payload.emoji] = [];
  const idx = m.reactions[payload.emoji].indexOf(contactId);
  if (payload.remove) { if (idx >= 0) m.reactions[payload.emoji].splice(idx, 1); if (m.reactions[payload.emoji].length === 0) delete m.reactions[payload.emoji]; }
  else { if (idx < 0) m.reactions[payload.emoji].push(contactId); }
  persistContacts();
  if (state.chatId === c.id) renderChatThread();
}


// =====================================================================
// V.80: большие группы на Sender Keys (js/groupkeys.js, signaling-server/gdeliver.js)
// =====================================================================
// Группа >8 участников, где КАЖДЫЙ умеет sk1 (флаг c.sk1 из caps присутствия) и сервер знает gdeliver, шлёт текст одним зашифрованным
// конвертом через сервер. Иначе — прежняя попарная рассылка (она же запасной путь при ошибке/таймауте). Остальные виды сообщений
// (файлы, реакции, правки) по-прежнему идут попарно: они редки/нужны подтверждения доставки. Квитанции доставки/прочтения для
// сообщений Sender Keys не рассылаются (N×N трафика): у них один статус «отправлено» после приёма сервером.
const MAX_GROUP_MEMBERS_SK = 256;
function contactHasSk(id) { const c = state.contacts.get(id); return !!(c && c.sk1); }
function markContactSk(c) { if (c && !c.sk1) { c.sk1 = true; try { persistContacts(); } catch (e) {} } }
function serverHasGdeliver() { return !!(typeof signaling !== "undefined" && signaling && signaling.registered && Array.isArray(signaling.features) && signaling.features.includes("gdeliver")); }
// Лимит участников: до 256, если все (кроме меня) умеют sk1 и сервер умеет gdeliver; иначе прежние 10
function groupMemberLimit(memberIds) {
  const ids = (memberIds || []).filter((id) => id !== Store.myId);
  return typeof GroupKeys !== "undefined" && serverHasGdeliver() && ids.every(contactHasSk) ? MAX_GROUP_MEMBERS_SK : MAX_GROUP_MEMBERS;
}
function groupUsesSenderKeys(g) {
  if (!g || !g.isGroup || typeof GroupKeys === "undefined" || !serverHasGdeliver()) return false;
  return GroupKeys.shouldUse(g.members.map((m) => m.id).filter((id) => id !== Store.myId), Store.myId, contactHasSk);
}
function gkPublishRoster(g) {
  if (!g || !serverHasGdeliver() || !groupUsesSenderKeys(g)) return;
  try { signaling.groupRoster(g.id, g.members.map((m) => m.id), g.members.filter((m) => isGroupAdmin(g, m.id)).map((m) => m.id), Number.isInteger(g.rosterVer) ? g.rosterVer : 0); } catch (e) {}
}
// Раздать свою цепочку отправки участникам, которые её ещё не получали (only — ограничить списком id)
async function gkDistribute(g, only) {
  const dist = await GroupKeys.distribution(g.id);
  g.gk = g.gk || {}; g.gk.sent = g.gk.sent || {};
  const todo = g.members.filter((m) => m.id !== Store.myId && (!only || only.includes(m.id)) && g.gk.sent[m.id] !== dist.cid);
  for (let i = 0; i < todo.length; i += 16) {
    await Promise.all(todo.slice(i, i + 16).map((m) => {
      g.gk.sent[m.id] = dist.cid;
      const mc = ensureContactEntry(m.id, m.name);
      return trySendOrQueue(mc, crypto.randomUUID(), { kind: "gk-dist", id: crypto.randomUUID(), groupId: g.id, cid: dist.cid, ck: dist.ck, n: dist.n, spub: dist.spub }).catch(() => { delete g.gk.sent[m.id]; });
    }));
  }
  persistContacts();
}
function gkWaitAck(msgId, sendFn, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); try { signaling.removeEventListener("gdeliver-ack", onAck); } catch (e) {} resolve(v); };
    const onAck = (ev) => { if (ev.detail && ev.detail.msgId === msgId) fin(!ev.detail.error); };
    const t = setTimeout(() => fin(false), timeoutMs || 6000);
    try { signaling.addEventListener("gdeliver-ack", onAck); } catch (e) { fin(false); return; }
    if (!sendFn()) fin(false);
  });
}
// Отправка текстового payload (kind "chat") в группу Sender Keys. true — сервер принял; false — вызывающий шлёт попарно
async function gkSendChat(g, msgId, payload) {
  try {
    if (!signaling || !signaling.connected) return false;
    if (g.gk && g.gk.rekey) { await GroupKeys.rekey(g.id); g.gk.rekey = false; g.gk.sent = {}; }
    await gkDistribute(g);
    const env = await GroupKeys.encrypt(g.id, Store.myId, JSON.stringify(payload));
    const to = g.members.map((m) => m.id).filter((id) => id !== Store.myId);
    const ok = await gkWaitAck(msgId, () => signaling.gdeliver(g.id, msgId, to, env));
    if (ok) { const rec = g.messages.find((m) => m.id === msgId); if (rec) { rec.sk = true; rec.serverAcked = true; persistContacts(); } }
    return ok;
  } catch (e) { etherLog("warn", "[groupkeys] send:", String(e)); return false; }
}
// Состав группы изменился: после исключения — новая цепочка (лениво, перед следующей отправкой); новым участникам — текущая цепочка
function gkOnRosterChange(g, oldIds) {
  if (typeof GroupKeys === "undefined" || !g) return;
  const nowIds = g.members.map((m) => m.id);
  if (!nowIds.includes(Store.myId)) { GroupKeys.dropGroup(g.id); return; }
  const removed = oldIds.filter((id) => !nowIds.includes(id)), added = nowIds.filter((id) => !oldIds.includes(id));
  if (removed.length) {
    GroupKeys.pruneToMembers(g.id, nowIds);
    if (GroupKeys.hasSend(g.id)) { g.gk = g.gk || {}; g.gk.rekey = true; g.gk.sent = {}; }
  }
  if (added.length && GroupKeys.hasSend(g.id) && groupUsesSenderKeys(g) && !(g.gk && g.gk.rekey)) gkDistribute(g, added).catch(() => {});
  gkPublishRoster(g);
}
const gkParked = new Map(), gkReqAt = new Map();
function gkRequestKey(g, from, cid) {
  const k = g.id + "|" + from + "|" + cid, t = Date.now();
  if (t - (gkReqAt.get(k) || 0) < 30000) return;
  gkReqAt.set(k, t); trimMap(gkReqAt, 200);
  trySendOrQueue(ensureContactEntry(from, null), crypto.randomUUID(), { kind: "gk-req", id: crypto.randomUUID(), groupId: g.id, cid }).catch(() => {});
}
// Входящий gchat: расшифровать цепочкой отправителя и передать обычному обработчику чата группы
async function handleGroupSkDeliver(detail, replay, ackBox) {
  const { msgId, envelope } = detail, from = canonPeer(detail.from), gid = detail.gid;
  const dKey = "gk|" + from + "|" + msgId;
  if (hasSeenMsg(from, msgId) || seenDeliverIds.has(dKey)) { ackBox(); return; }
  if (deliverInFlight.has(dKey)) return;
  const g = typeof gid === "string" ? state.contacts.get(gid) : null;
  if (g && (!g.isGroup || !g.members.some((m) => m.id === from))) { ackBox(); return; } // не участник — отбрасываем
  deliverInFlight.add(dKey);
  const fail = () => { if (bumpDeliverFail(from, msgId) >= DELIVER_MAX_ATTEMPTS) ackBox(); };
  try {
    if (!g || typeof GroupKeys === "undefined") { fail(); return; } // приглашение ещё не пришло — повторим при следующем подключении
    let text;
    try { text = await GroupKeys.decrypt(gid, from, envelope); }
    catch (e) {
      if (/no-chain/.test(String(e)) && envelope) { // ключа отправителя ещё нет: просим и ждём раздачу
        const pk = gid + "|" + from + "|" + envelope.cid, arr = gkParked.get(pk) || [];
        if (!arr.some((d) => d.msgId === msgId) && arr.length < 50) arr.push(detail);
        gkParked.set(pk, arr); trimMap(gkParked, 100);
        gkRequestKey(g, from, envelope.cid);
        return;
      }
      if (/old|bad-sig|bad-envelope/.test(String(e))) { ackBox(); return; } // повтор/подделка: молча отбрасываем
      fail(); return;
    }
    let payload = null; try { payload = JSON.parse(text); } catch (e) {}
    if (!payload || typeof payload !== "object" || payload.kind !== "chat" || payload.groupId !== gid) { markSeenMsg(from, msgId); ackBox(); return; }
    rememberDeliverId(dKey);
    applyIncomingPayload(from, msgId, payload, true, "chat");
    const rec = g.messages.find((m) => m.id === payload.id); if (rec) { rec.sk = true; delete rec.deliveryId; }
    markSeenMsg(from, msgId); ackBox();
  } finally { deliverInFlight.delete(dKey); }
}
function handleGkDist(from, payload) {
  const g = state.contacts.get(payload.groupId);
  if (!g || !g.isGroup || !g.members.some((m) => m.id === from) || typeof GroupKeys === "undefined") return;
  if (!GroupKeys.acceptDistribution(g.id, from, payload)) return;
  const pk = g.id + "|" + from + "|" + payload.cid, arr = gkParked.get(pk);
  if (arr) { gkParked.delete(pk); for (const d of arr) handleDeliver(d, false).catch(() => {}); }
}
function handleGkReq(from, payload) {
  const g = state.contacts.get(payload.groupId);
  if (!g || !g.isGroup || !g.members.some((m) => m.id === from) || typeof GroupKeys === "undefined" || !GroupKeys.hasSend(g.id)) return;
  if (g.gk && g.gk.sent) delete g.gk.sent[from];
  gkDistribute(g, [from]).catch(() => {});
}
