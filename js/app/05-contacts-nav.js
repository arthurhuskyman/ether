"use strict";
// Часть 5 из 14 бывшего js/app.js: Контакты, поиск по хэшу, навигация. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Контакты
// =====================================================================
let __quotaWarningShown = false;
// localStorage — общий лимит ~5-10 МБ на весь домен. Без try/catch
// QuotaExceededError при setItem() улетает как необработанное
// исключение, а данные (новое сообщение, черновик и т.д.) остаются
// только в памяти — при перезагрузке страницы теряются молча.
function handlePersistError(e, what) {
  etherLog("error", "[persist:" + what + "] setItem failed:", String(e && e.message || e));
  if (!__quotaWarningShown) {
    __quotaWarningShown = true;
    try { toast(T("toast.storageFull")); } catch (e2) {}
  }
}
function loadContacts() {
  let arr = [];
  let loadFailed = false;
  try { arr = JSON.parse(Store.contactsJson) || []; } catch (e) { arr = []; loadFailed = true; }
  if (!Array.isArray(arr)) { arr = []; loadFailed = true; }
  if (loadFailed) { try { toast(T("toast.contactsLoadFailed")); } catch (e) {} }
  for (const c of arr) {
    if (!c || typeof c.id !== "string") continue;
    // Передачи, прерванные закрытием страницы, после перезапуска уже не продолжатся (буфер/блоб в памяти потеряны) —
    // иначе вложение навсегда висело бы в состоянии «отправка».
    if (Array.isArray(c.messages)) for (const m of c.messages) {
      if (m && m.file && m.file.pending === true) { m.file.pending = false; if (m.from === "me") m.ack = "failed"; else m.file.failed = true; }
    }
    state.contacts.set(c.id, {
      id: c.id, name: c.name || "", raw: c.raw || "",
      managed: true, publicKey: c.publicKey || null,
      rc: !!c.rc || undefined, e2: !!c.e2 || undefined, verifiedKey: c.verifiedKey || undefined,
      pendingKey: c.pendingKey && c.pendingKey.key ? { key: c.pendingKey.key, at: c.pendingKey.at || 0 } : undefined,
      rejectedKey: c.rejectedKey || undefined, authSeen: !!c.authSeen || undefined,
      online: false, status: "disconnected",
      messages: Array.isArray(c.messages) ? c.messages : [],
      lastActivity: c.lastActivity || 0,
      archived: !!c.archived, muted: !!c.muted, muteUntil: c.muteUntil || null, blocked: !!c.blocked, vibrateOnly: !!c.vibrateOnly,
      pinned: !!c.pinned, pinnedMessageId: c.pinnedMessageId || null,
      pinOrder: typeof c.pinOrder === "number" ? c.pinOrder : null,
      // Группы — без этих полей запись после перезагрузки превращается в
      // битый обычный контакт (isGroup(c) === false, участников нет).
      isGroup: !!c.isGroup, room: c.room || undefined,
      members: Array.isArray(c.members) ? c.members : undefined,
      nameLocal: c.nameLocal || undefined,
      createdBy: c.createdBy || undefined,
      writeRestricted: c.isGroup && c.writeRestricted === true ? true : undefined,
      peerReceiptsEnabled: c.peerReceiptsEnabled === false ? false : undefined,
      peerLastSeenVisible: c.peerLastSeenVisible === false ? false : undefined,
      peerPresenceVisible: c.peerPresenceVisible === false ? false : undefined,
      peerStatus: typeof c.peerStatus === "string" && c.peerStatus ? c.peerStatus.slice(0, 140) : undefined,
      banned: Array.isArray(c.banned) ? c.banned.filter((x) => typeof x === "string").slice(-50) : undefined,
      rosterVer: Number.isInteger(c.rosterVer) && c.rosterVer > 0 ? c.rosterVer : undefined,
      avatar: c.avatar || undefined,
      peerAvatar: typeof c.peerAvatar === "string" && AVATAR_DATAURL_RE.test(c.peerAvatar) ? c.peerAvatar : undefined,
      description: c.description || undefined,
      disappearingTimer: c.disappearingTimer || 0,
      notificationSound: c.notificationSound || undefined,
      // killer-features-backlog 0.5 — Dead Man's Switch: когда пришёл
      // последний heartbeat от этого контакта и при каком пороге (дней)
      // его просили следить, плюс отметка уже показанного предупреждения.
      lastHeartbeatAt: c.lastHeartbeatAt || undefined,
      birthday: typeof c.birthday === "string" ? c.birthday : undefined, birthdayCelebrated: c.birthdayCelebrated || undefined,
      heartbeatThresholdDays: c.heartbeatThresholdDays || undefined,
      heartbeatAlertedAt: c.heartbeatAlertedAt || undefined,
      isSelf: c.id === SELF_CHAT_ID || !!c.isDemo,
      isDemo: c.isDemo || undefined, demoStep: c.demoStep || 0,
    });
  }
  ensureSelfChatContact();
  // Миграция для drag-to-reorder (раздел 4 роадмапа): раньше у закреплённых
  // чатов не было собственного порядка — они сортировались как обычные
  // чаты (онлайн → lastActivity). Чатам, уже закреплённым ДО этого
  // релиза (pinOrder ещё не записан), присваиваем номер по их текущему
  // видимому порядку — так обновление не дёргает уже привычную
  // последовательность, а drag просто начинает работать поверх неё.
  const legacyPinned = Array.from(state.contacts.values()).filter((c) => c.pinned && typeof c.pinOrder !== "number");
  if (legacyPinned.length) {
    legacyPinned.sort((a, b) => {
      const aLive = a.online ? 1 : 0, bLive = b.online ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });
    let next = nextPinOrder();
    for (const c of legacyPinned) c.pinOrder = next++;
  }
}
// Следующий свободный pinOrder — новый закреплённый чат всегда уходит в
// конец списка закреплённых, а не в случайное место.
function nextPinOrder() {
  let max = -1;
  for (const c of state.contacts.values()) {
    if (c.pinned && typeof c.pinOrder === "number" && c.pinOrder > max) max = c.pinOrder;
  }
  return max + 1;
}
// «Заметки себе» — локальный pinned self-chat. Зарезервированный id не
// пересекается с реальными контактами (idFor() всегда нормализует
// телефон/email, а не возвращает "__self__" дословно). Никогда не
// регистрируется на сигнальном сервере, не участвует в mesh/presence —
// единственная точка, которая вообще знает про сеть для этого "контакта",
// это trySendOrQueue(), и там для isSelf стоит ранний выход.
const SELF_CHAT_ID = "__self__";
function ensureSelfChatContact() {
  let c = state.contacts.get(SELF_CHAT_ID);
  if (c) { c.isSelf = true; c.managed = true; return c; }
  c = {
    id: SELF_CHAT_ID, name: T("chats.selfChat.name"), raw: "",
    managed: true, publicKey: null,
    online: false, status: "self",
    messages: [], lastActivity: 0,
    archived: false, muted: false, blocked: false,
    pinned: true, pinnedMessageId: null,
    isGroup: false, disappearingTimer: 0,
    isSelf: true,
  };
  state.contacts.set(SELF_CHAT_ID, c);
  return c;
}
// persistContacts() вызывается очень часто (на каждое отправленное/
// полученное сообщение, реакцию, ack и т.д.) — сериализация ВСЕХ
// контактов с историей в JSON и синхронная запись в localStorage на
// каждый такой вызов ощутимо бьёт по главному потоку при пакетном
// приёме сообщений. Дебаунсим запись на 200мс по тому же паттерну, что
// уже применяется для черновиков (scheduleDraftPersist). state.contacts
// в памяти обновляется вызывающим кодом сразу — риск потери данных
// только в окне до 200мс при аварийном завершении процесса, поэтому
// принудительно сбрасываем очередь перед unload/уходом в фон и перед
// экспортом бэкапа (exportBackup читает localStorage напрямую).
let __contactsPersistTimer = null;
let __contactsPersistPending = null;
function persistContactsNow() {
  if (__contactsPersistTimer) { clearTimeout(__contactsPersistTimer); __contactsPersistTimer = null; }
  if (__contactsPersistPending === null) return;
  const arr = __contactsPersistPending;
  __contactsPersistPending = null;
  try {
    // Страховка от «пропали все сообщения»: если число сообщений резко упало, пишем в журнал откуда это пришло
    // и сохраняем предыдущий снимок в IndexedDB (ключ contactsPrev), чтобы данные можно было вернуть.
    const total = arr.reduce((n, c) => n + (c.messages ? c.messages.length : 0), 0);
    if (__lastPersistMsgCount >= 8 && total < __lastPersistMsgCount * 0.5) {
      etherLog("warn", "[persist] число сообщений упало " + __lastPersistMsgCount + " → " + total + "; снимок прежнего состояния сохранён (contactsPrev). Стек: " + String(new Error().stack).split("\n").slice(1, 6).join(" | "));
      try { if (__lastContactsJson) IDB.set("contactsPrev", __lastContactsJson).catch(() => {}); } catch (e) {}
    }
    const json = JSON.stringify(arr);
    Store.contactsJson = json;
    __lastPersistMsgCount = total; __lastContactsJson = json;
  } catch (e) {
    // QuotaExceededError и подобное — см. persistContactsSafe ниже.
    handlePersistError(e, "contacts");
  }
}
let __lastPersistMsgCount = 0, __lastContactsJson = "";
// Список заблокированных — в service worker (его push-обработчик не видит localStorage)
let __blockedSyncKey = "";
function syncBlockedToSW() {
  try {
    const ids = Array.from(state.contacts.values()).filter((c) => c.blocked && !c.isGroup).map((c) => c.id).sort();
    const key = ids.join(",");
    if (key === __blockedSyncKey) return; __blockedSyncKey = key;
    const msg = { type: "blocked-ids", ids };
    if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage(msg);
    else if (swRegistration && swRegistration.active) swRegistration.active.postMessage(msg);
  } catch (e) {}
}
// A3: какие id просить у сервера в списке «онлайн» — только наши контакты (и участники групп)
function watchedContactIds() {
  const ids = new Set();
  for (const c of state.contacts.values()) {
    if (c.isSelf || c.isDemo) continue;
    if (c.isGroup) { for (const m of (c.members || [])) if (m.id && m.id !== Store.myId) ids.add(m.id); }
    else if (c.managed && c.id) ids.add(c.id);
  }
  return Array.from(ids);
}
let __watchKey = "", __watchTimer = null;
function syncWatch(force) {
  const ids = watchedContactIds().sort(), key = ids.join(",");
  if (!force && key === __watchKey) return;
  __watchKey = key;
  clearTimeout(__watchTimer);
  __watchTimer = setTimeout(() => { try { if (signaling && signaling.connected && signaling.registered && signaling.features.includes("watch")) signaling.watch(ids); } catch (e) {} }, 800);
}
// Включение/выключение шифрования: файлы из IndexedDB перезаписываются (IDB.set сам шифрует/не шифрует по текущему состоянию SecureStore)
async function migrateFilesEncryption(toEncrypted) {
  for (const c of state.contacts.values()) for (const m of c.messages) {
    if (!m.file || m.file.pending || m.file.failed) continue;
    try {
      const raw = await IDB.get("file:" + m.id); // уже расшифрованный Blob (или undefined)
      if (raw instanceof Blob) await IDB.set("file:" + m.id, raw, toEncrypted ? undefined : { plain: true });
    } catch (e) {}
  }
}
function persistContacts() {
  try { syncBlockedToSW(); } catch (e) {}
  try { syncWatch(false); } catch (e) {}
  __contactsPersistPending = Array.from(state.contacts.values()).filter((c) => c.managed).map((c) => ({
    id: c.id, name: c.name, raw: c.raw, publicKey: c.publicKey,
    rc: c.rc || undefined, e2: c.e2 || undefined, verifiedKey: c.verifiedKey || undefined, pendingKey: c.pendingKey || undefined, rejectedKey: c.rejectedKey || undefined, authSeen: c.authSeen || undefined,
    messages: c.messages, lastActivity: c.lastActivity,
    archived: c.archived, muted: c.muted, muteUntil: c.muteUntil || undefined, blocked: c.blocked, vibrateOnly: c.vibrateOnly || undefined,
    pinned: c.pinned || undefined, pinnedMessageId: c.pinnedMessageId || undefined,
    pinOrder: typeof c.pinOrder === "number" ? c.pinOrder : undefined,
    isGroup: c.isGroup || undefined, room: c.isGroup && c.room || undefined,
    members: c.isGroup ? c.members : undefined,
    nameLocal: c.nameLocal || undefined,
    createdBy: c.isGroup ? c.createdBy : undefined,
    writeRestricted: c.isGroup && c.writeRestricted ? true : undefined,
    peerReceiptsEnabled: c.peerReceiptsEnabled === false ? false : undefined,
    peerLastSeenVisible: c.peerLastSeenVisible === false ? false : undefined,
    peerPresenceVisible: c.peerPresenceVisible === false ? false : undefined,
    peerStatus: typeof c.peerStatus === "string" && c.peerStatus ? c.peerStatus.slice(0, 140) : undefined,
    banned: c.isGroup && Array.isArray(c.banned) && c.banned.length ? c.banned.slice(-50) : undefined,
    rosterVer: c.isGroup && Number.isInteger(c.rosterVer) && c.rosterVer > 0 ? c.rosterVer : undefined,
    // killer-features-backlog 0.7 — локальный аватар контакта: раньше
    // persistContacts() сохранял avatar только для групп, т.к. у обычных
    // контактов не было UI для его установки. Теперь c.avatar может быть
    // задан и для 1:1 контакта (см. setContactAvatar) — сохраняем всегда.
    avatar: c.avatar || undefined,
    peerAvatar: c.peerAvatar || undefined,
    description: c.isGroup ? (c.description || undefined) : undefined,
    disappearingTimer: c.disappearingTimer || undefined,
    notificationSound: c.notificationSound || undefined,
    lastHeartbeatAt: c.lastHeartbeatAt || undefined,
    birthday: c.birthday || undefined, birthdayCelebrated: c.birthdayCelebrated || undefined,
    heartbeatThresholdDays: c.heartbeatThresholdDays || undefined,
    heartbeatAlertedAt: c.heartbeatAlertedAt || undefined,
    isDemo: c.isDemo || undefined, demoStep: c.demoStep || undefined,
  }));
  if (__contactsPersistTimer) return;
  __contactsPersistTimer = setTimeout(() => {
    __contactsPersistTimer = null;
    persistContactsNow();
  }, 200);
}
function loadLastSeen() { try { state.lastSeen = JSON.parse(Store.lastSeenJson) || {}; } catch (e) { state.lastSeen = {}; } if (typeof state.lastSeen !== "object") state.lastSeen = {}; }
function persistLastSeen() { try { Store.lastSeenJson = JSON.stringify(state.lastSeen); } catch (e) { handlePersistError(e, "lastSeen"); } }
function loadDrafts() { try { state.drafts = JSON.parse(Store.draftsJson) || {}; } catch (e) { state.drafts = {}; } if (typeof state.drafts !== "object") state.drafts = {}; }
function persistDrafts() { try { Store.draftsJson = JSON.stringify(state.drafts); } catch (e) { handlePersistError(e, "drafts"); } }
// "Отправить позже" — каждая запись { id, contactId, isGroup, text, replyTo, sendAt }.
// sendAt — абсолютный ms-timestamp, поэтому «приложение было закрыто
// дольше таймера» не теряет сообщение: sweepScheduledMessages() при
// следующем запуске увидит sendAt в прошлом и отправит немедленно,
// а не ждёт, что таймер «досчитает» с момента планирования.
function loadScheduledMessages() { try { state.scheduledMessages = JSON.parse(Store.scheduledMessagesJson) || []; } catch (e) { state.scheduledMessages = []; } if (!Array.isArray(state.scheduledMessages)) state.scheduledMessages = []; }
function persistScheduledMessages() { try { Store.scheduledMessagesJson = JSON.stringify(state.scheduledMessages); } catch (e) { handlePersistError(e, "scheduledMessages"); } }
function loadChatFolders() {
  try { state.folders = JSON.parse(Store.chatFoldersJson) || []; } catch (e) { state.folders = []; }
  if (!Array.isArray(state.folders)) state.folders = [];
  // Защита от повреждённых/чужеродных записей — каждая папка обязана
  // иметь строковые id/name и массив contactIds (иначе рендер чипов и
  // фильтрация ниже упадут на мусорных данных из ручного редактирования
  // localStorage или повреждённого бэкапа).
  state.folders = state.folders.filter((f) => f && typeof f.id === "string" && typeof f.name === "string" && Array.isArray(f.contactIds));
}
function persistChatFolders() { try { Store.chatFoldersJson = JSON.stringify(state.folders); } catch (e) { handlePersistError(e, "chatFolders"); } }
// При быстрой печати обработчик "input" дёргает persistDrafts() на
// каждый символ — 5-10 localStorage.setItem в секунду. Дебаунс в
// 250мс группирует их в одну запись за паузу в наборе текста.
// saveCurrentDraft() (срабатывает при выходе из чата) остаётся
// синхронным — там нужна гарантия, что черновик лёг ДО размонтирования.
let __draftPersistTimer = null;
function scheduleDraftPersist() {
  if (__draftPersistTimer) return;
  __draftPersistTimer = setTimeout(() => {
    __draftPersistTimer = null;
    persistDrafts();
  }, 250);
}
function keysDiffer(a, b) { return JSON.stringify(a || null) !== JSON.stringify(b || null); }

function ensureContactEntry(id, suggestedName) {
  let c = state.contacts.get(id);
  if (!c) {
    c = {
      id, name: suggestedName || T("sys.someone"), raw: "", managed: true,
      publicKey: null, online: onlineSet.has(id), status: "new",
      messages: [], lastActivity: Date.now(),
      archived: false, muted: false, blocked: false,
    };
    state.contacts.set(id, c);
    persistContacts();
  } else if (suggestedName && (!c.name || c.name === T("sys.someone"))) {
    c.name = suggestedName;
    persistContacts();
  }
  return c;
}

// =====================================================================
// Поиск по хэшу телефона/почты (discovery.js; добровольно, по умолчанию выключено)
// =====================================================================
function discoverySupported() { return typeof Discovery !== "undefined" && Discovery.supported(signaling); }
function refreshDiscoveryUI() {
  const feat = discoverySupported();
  const blk = $("#settings-discovery-block"); if (blk) blk.classList.toggle("hidden", !feat);
  const fb = $("#find-by-phone-btn"); if (fb) fb.classList.toggle("hidden", !feat);
  const cb = $("#settings-discovery"); if (cb) cb.checked = Store.phoneDiscover;
  const nm = $("#settings-discovery-name"); if (nm) { nm.checked = Store.phoneDiscoverName; nm.disabled = !Store.phoneDiscover; }
}
// Публикуем/снимаем свою запись. Публикация повторяется только если сервер её не помнит или настройки менялись (TTL продлевается самой регистрацией).
function syncDiscoveryPublish() {
  const sig = signaling; if (!discoverySupported()) return;
  if (!Store.phoneDiscover) { if (sig.discoveryPublished) sig.discoveryPublish([], false, ""); return; }
  if (sig.discoveryPublished && !state._discoveryDirty) return;
  const raw = Store.myIdentityRaw; if (!raw) return;
  Discovery.prepareOne(raw, sig.discoverySalt).then((it) => {
    if (!it || signaling !== sig || !Store.phoneDiscover || it.id !== Store.myId) return;
    state._discoveryDirty = false;
    sig.discoveryPublish([it.hash], Store.phoneDiscoverName, Store.phoneDiscoverName ? Store.name : "");
  }).catch(() => {});
}
// Перед сменой id запись старого id снимаем (после смены владеть ею уже нечем)
function discoveryUnpublishBeforeIdChange() {
  if (discoverySupported() && signaling.discoveryPublished) signaling.discoveryPublish([], false, "");
}
function setDiscoveryStatus(text) { const el = $("#discovery-status"); if (el) el.textContent = text || ""; }
function openDiscoverySheet() {
  const sh = $("#discovery-sheet"); if (!sh) return;
  const res = $("#discovery-results"); if (res) res.innerHTML = "";
  setDiscoveryStatus(discoverySupported() ? "" : T(signaling && signaling.registered ? "discovery.needServer" : "discovery.connecting"));
  sh.classList.remove("hidden");
}
function addDiscoveredContact(f) {
  if (!f || f.id === Store.myId) return false;
  if (recentlyDeletedIds.delete(f.id)) persistRecentlyDeleted(); // осознанное добавление снимает блокировку из deleteContact
  const c = ensureContactEntry(f.id, f.name || f.normalized);
  if (!c.raw) c.raw = f.normalized;
  noteContactKey(c, f.publicKey); // как у любого контакта: ключ запоминается при первом знакомстве, смена потребует подтверждения
  persistContacts();
  if (onlineSet.has(f.id)) scheduleAutoConnect(f.id);
  toast(T("discovery.verifyHint"));
  return true;
}
function renderDiscoveryResults(found) {
  const box = $("#discovery-results"); if (!box) return;
  box.innerHTML = "";
  for (const f of found) {
    const row = document.createElement("div");
    row.className = "forward-row";
    const nm = f.name || f.normalized;
    const av = document.createElement("div"); av.className = "avatar avatar-sm"; av.style.background = avatarGradient(nm); av.textContent = initials(nm);
    const lab = document.createElement("span"); lab.className = "forward-name"; lab.textContent = f.name ? f.name + " · " + f.raw : f.raw;
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn-secondary";
    const has = state.contacts.has(f.id);
    btn.textContent = T(has ? "discovery.added" : "discovery.add"); btn.disabled = has;
    btn.addEventListener("click", () => { if (addDiscoveredContact(f)) { btn.textContent = T("discovery.added"); btn.disabled = true; try { renderChatsList(); } catch (e) {} } });
    row.appendChild(av); row.appendChild(lab); row.appendChild(btn);
    box.appendChild(row);
  }
}
async function runDiscoverySearch() {
  const sig = signaling;
  if (!discoverySupported()) { setDiscoveryStatus(T(sig && sig.registered ? "discovery.needServer" : "discovery.connecting")); return; }
  const inp = $("#discovery-input"), btn = $("#discovery-search-btn");
  const prepared = (await Discovery.prepare(Discovery.splitInput(inp ? inp.value : ""), sig.discoverySalt)).filter((p) => p.id !== Store.myId);
  if (!prepared.length) { setDiscoveryStatus(T("discovery.invalid")); renderDiscoveryResults([]); return; }
  if (btn) btn.disabled = true;
  setDiscoveryStatus(T("discovery.searching"));
  try {
    const r = await Discovery.lookup(sig, prepared);
    renderDiscoveryResults(r.found);
    setDiscoveryStatus(r.error === "rate" ? T("discovery.rate") : r.error ? T("discovery.error") : r.found.length ? T("discovery.foundN", { n: r.found.length }) : T("discovery.none"));
  } catch (e) { setDiscoveryStatus(T("discovery.error")); }
  finally { if (btn) btn.disabled = false; }
}
function wireDiscoveryUI() {
  if (state._discoveryWired) return; state._discoveryWired = true;
  const cb = $("#settings-discovery"), nm = $("#settings-discovery-name");
  if (cb) cb.addEventListener("change", async () => {
    if (cb.checked) {
      if (!Store.myIdentityRaw) { cb.checked = false; toast(T("discovery.noIdentity")); return; }
      const ok = await confirmSheet(T("discovery.consent", { days: 90 }), { okLabel: T("discovery.consentOk") });
      if (!ok) { cb.checked = false; return; }
      Store.phoneDiscover = true;
    } else Store.phoneDiscover = false;
    state._discoveryDirty = true; state._discoveryToast = true;
    refreshDiscoveryUI(); syncDiscoveryPublish();
  });
  if (nm) nm.addEventListener("change", () => { Store.phoneDiscoverName = nm.checked; state._discoveryDirty = true; syncDiscoveryPublish(); });
  const fb = $("#find-by-phone-btn"); if (fb) fb.addEventListener("click", openDiscoverySheet);
  const sb = $("#discovery-search-btn"); if (sb) sb.addEventListener("click", () => { runDiscoverySearch().catch(() => {}); });
  const ob = $("#onboarding-find-btn");
  if (ob) ob.addEventListener("click", () => { window.__etherDiscoveryAfterStart = true; const st = $("#onboarding-start-btn"); if (st) st.click(); });
  const pk = $("#discovery-pick-btn");
  if (pk && navigator.contacts && navigator.contacts.select) {
    pk.classList.remove("hidden");
    pk.addEventListener("click", async () => {
      let picked;
      try { picked = await navigator.contacts.select(["tel", "email"], { multiple: true }); } catch (e) { return; }
      const vals = [];
      for (const c of picked || []) { for (const t of (c.tel || [])) vals.push(t); for (const m of (c.email || [])) vals.push(m); }
      const inp = $("#discovery-input"); if (inp && vals.length) { inp.value = (inp.value ? inp.value.trim() + "\n" : "") + vals.join("\n"); setDiscoveryStatus(T("discovery.pickedN", { n: vals.length })); }
    });
  }
}

// =====================================================================
// Навигация
// =====================================================================
function wireTabBar() {
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.callId) {
        // Раньше тап по любой вкладке во время звонка просто возвращал
        // на #call-screen — уйти в чаты/контакты было нельзя иначе как
        // завершив звонок. Теперь сворачиваем его в полоску и даём
        // перейти на нужную вкладку, как и просил отчёт.
        minimizeCallScreen();
      }
      state.tab = btn.dataset.tab;
      state.chatId = null;
      __lastRenderedChatId = null;
      state.contactCardId = null;
      renderTab();
    });
  });
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest("#chat-back")) { ev.preventDefault(); closeChatSafely(); return; }
    if (t.closest("#contact-back")) { ev.preventDefault(); closeContactCardSafely(); return; }
  });
}
// Свайп между Chats/Contacts/Settings — тот же жест, которым уже умеют
// пользоваться строка чата (архив/mute) и пузырь (ответ), поэтому
// намеренно НЕ навешан глобально на весь #content без разбора: старт
// касания внутри .chat-row/.chat-filters/.emoji-tabs (у них у самих уже
// есть горизонтальные жесты) полностью исключает элемент из кандидатов
// на свайп табов, чтобы не конкурировать за один и тот же touchmove.
// Debug-вкладка не входит в список — туда попадают секретными тапами по
// заголовку, свайпом до неё добираться не предполагалось.
function wireTabSwipe() {
  const content = $("#content");
  if (!content) return;
  const TABS = ["chats", "connect", "settings"];
  const SWIPE_TAB_THRESHOLD = 60;
  let startX = 0, startY = 0, swiping = false, blocked = false;
  content.addEventListener("touchstart", (e) => {
    if (state.chatId || state.contactCardId || state.callId || e.touches.length !== 1) { blocked = true; return; }
    const t = e.target;
    if (t && t.closest && t.closest(".chat-row, .chat-filters, .emoji-tabs, input, textarea")) { blocked = true; return; }
    blocked = false;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    swiping = false;
  }, { passive: true });
  content.addEventListener("touchmove", (e) => {
    if (blocked) return;
    const dx = e.touches[0].clientX - startX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (!swiping && Math.abs(dx) > 24 && Math.abs(dx) > dy * 1.5) swiping = true;
  }, { passive: true });
  content.addEventListener("touchend", (e) => {
    if (blocked || !swiping) { swiping = false; return; }
    swiping = false;
    const touch = e.changedTouches && e.changedTouches[0];
    const dx = (touch ? touch.clientX : startX) - startX;
    const isRtl = document.documentElement.dir === "rtl";
    const dir = isRtl ? dx : -dx; // > 0 — "вперёд" по порядку вкладок (следующая), с учётом RTL
    const idx = TABS.indexOf(state.tab);
    if (idx === -1) return;
    if (dir > SWIPE_TAB_THRESHOLD && idx < TABS.length - 1) state.tab = TABS[idx + 1];
    else if (dir < -SWIPE_TAB_THRESHOLD && idx > 0) state.tab = TABS[idx - 1];
    else return;
    haptic("light");
    renderTab();
  });
}
function closeChatSafely() {
  const prevId = state.chatId;
  cancelVoiceRecordingIfLeavingChat(null);
  pauseAllVoicePlayback();
  try { saveCurrentDraft(); } catch (e) {}
  state._inputDraftChatId = null;
  state.chatId = null;
  // Сброс __lastRenderedChatId — иначе при повторном входе в ТОТ ЖЕ
  // чат в renderChatThreadInner срабатывает условие
  // state.chatId === __lastRenderedChatId, «свежая» логика
  // (unreadDividerFor.set) не отрабатывает, и разделитель
  // «Непрочитанные сообщения» не появляется.
  __lastRenderedChatId = null;
  try { if (prevId) sendTypingStop(prevId); } catch (e) {}
  try { cancelEditing(); } catch (e) {}
  try { cancelReply(); } catch (e) {}
  try { closeChatSearch(); } catch (e) {}
  // Режим мультивыбора — состояние ОДНОГО конкретного треда, а не
  // приложения в целом. Без сброса здесь: вошли в мультивыбор в чате A,
  // вышли (‹ или edge-свайп-назад) — state.multiSelect остаётся
  // непустым, и первый же тап по пузырю в ЛЮБОМ другом чате B тихо
  // переключает выбор вместо обычного действия (открыть меню/лайтбокс).
  state.multiSelect = null;
  try { renderTab(); } catch (e) {}
}
function closeContactCardSafely() { state.contactCardId = null; try { renderTab(); } catch (e) {} }
function renderTab() { try { renderTabInner(); } catch (e) { etherLog("error", "[renderTab]", String(e)); } }
function setNavMode(mode) {
  const list = $("#nav-list-mode"), chat = $("#nav-chat-mode"), contact = $("#nav-contact-mode");
  if (list) list.classList.toggle("hidden", mode !== "list");
  if (chat) chat.classList.toggle("hidden", mode !== "chat");
  if (contact) contact.classList.toggle("hidden", mode !== "contact");
}
let __searchTab = null;
function renderTabInner() {
  if (state.pinReorder && (state.tab !== "chats" || state.chatId)) state.pinReorder = false;
  if (state.chatId || state.contactCardId) document.documentElement.classList.remove("inline-search-open");
  if (__searchTab !== state.tab) { if (__searchTab !== null) { try { setInlineSearchOpen(false); } catch (e) {} } __searchTab = state.tab; }
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $$(".screen").forEach((s) => s.classList.add("hidden"));
  const cf0 = $("#chat-filters"); if (cf0) cf0.classList.add("hidden");
  const tb = $("#tab-bar");
  if (tb) {
    // Пользователь явно попросил обратное решение: таб-бар должен
    // оставаться видимым ВСЕГДА, контролы чата/звонка — появляться НАД
    // ним, не вместо него. #call-screen уже переведён на обычный
    // flex-элемент (см. его CSS) специально для этого — но эта строка
    // всё ещё скрывала таб-бар отдельно для чата/карточки контакта,
    // хотя тот же принцип должен применяться и здесь. Раньше двойной
    // футер получался из-за position:absolute у #call-screen поверх
    // всего #app-shell — сейчас оба (#content и #call-screen) обычные
    // flex-сиблинги с явным order, лишнего наложения не будет.
    tb.classList.remove("hidden");
  }

  if (state.chatId) {
    const sc = $("#screen-chat"); if (sc) sc.classList.remove("hidden");
    setNavMode("chat");
    renderChatThread();
    return;
  }
  if (state.contactCardId) {
    const sc = $("#screen-contact"); if (sc) sc.classList.remove("hidden");
    setNavMode("contact");
    renderContactCard();
    return;
  }
  setNavMode("list");
  const map = { chats: "#screen-chats", calls: "#screen-calls", connect: "#screen-connect", settings: "#screen-settings", debug: "#screen-debug" };
  // "Звонки" больше не отдельная вкладка — сегмент внутри "Chats"
  // (Signal/WhatsApp/Telegram всё же держат звонки отдельной вкладкой,
  // но у нас, в отличие от них, было 4 видимых вкладки против их 3-4,
  // и сегмент внутри Chats снижает это число, не убирая звонки в
  // глубь навигации на лишний тап). Показываем нужный экран по
  // сегменту, а не по вкладке напрямую.
  const effectiveScreenKey = state.tab === "chats" ? state.chatsSegment : state.tab;
  const el = $(map[effectiveScreenKey]); if (el) el.classList.remove("hidden");
  if (state.tab === "chats" && cf0) cf0.classList.remove("hidden");
  if (state.tab === "settings") updateFavoritesCount();
  // Чип "Звонки" в #chat-filters синхронизируется с тем же state.chatsSegment,
  // которым раньше управлял отдельный #chats-segment переключатель (теперь
  // удалённый — см. комментарий в wireSearchHandlers()).
  $$("#chat-filters .chat-filter-chip").forEach((b) => {
    const f = b.dataset.filter;
    b.classList.toggle("active", state.chatsSegment === "calls" ? f === "calls" : f === state.chatFilter);
  });
  const titles = {
    // Раньше тут стоял T("nav.chats") ("Чаты") — но сама нижняя вкладка
    // была переименована в "Общение" (nav.hub) ещё раньше в этой сессии,
    // и заголовок страницы должен называться так же, как вкладка, а не
    // расходиться с ней. nav.chats остаётся отдельным ключом — он же
    // используется для подписи кнопки-сегмента "Чаты" внутри вкладки.
    chats: T("nav.hub"),
    calls: T("nav.calls"),
    connect: T("nav.contacts"),
    settings: T("nav.settings"),
    debug: T("nav.debug"),
  };
  const nt = $("#nav-title"); if (nt) nt.textContent = titles[state.tab] || T("app.name");
  if (state.tab === "chats" && state.chatsSegment === "chats") renderChatsList();
  if (state.tab === "chats" && state.chatsSegment === "calls") { markMissedCallsSeen(); renderCallsList(); }
  if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
}

// «Mute for 1h» (из раздела 10 роадмапа) — временный мьют поверх уже
// существующего постоянного c.muted. c.muteUntil — абсолютный timestamp
// (как и у «Отправить позже»): истекает сам по себе при следующей проверке,
// отдельный таймер на снятие не нужен — isContactMuted() всегда считает
// актуальное состояние на момент вызова.
function isContactMuted(c) {
  return !!(c && (c.muted || (c.muteUntil && c.muteUntil > Date.now())));
}
function contactStatusLabel(c) {
  if (c.isGroup) return T("group.memberCount", { n: c.members.length });
  if (c.isDemo) return T("demo.hint");
  if (c.isSelf) return T("chats.selfChat.hint");
  if (c.status === "in-call") return T("status.inCall");
  if (c.status === "connected") return T("status.connected");
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return T("status.connecting");
  if (c.managed) {
    // Тумблеры приватности собеседника (пришли через P2P privacy-pref) —
    // отсутствие поля (старый клиент, ещё не подключался) трактуем как
    // "не скрыто". Онлайн-статус и время последнего визита — РАЗНЫЕ
    // тумблеры, каждый скрывается независимо.
    if (c.online && c.peerPresenceVisible !== false) return T("status.online");
    if (c.peerLastSeenVisible !== false) {
      const seen = state.lastSeen[c.id];
      if (seen) return T("status.lastSeen", { ago: timeAgo(seen) });
    }
    return T("status.offline");
  }
  return T("status.offline");
}
function contactStatusClass(c) {
  if (c.status === "connected" || c.status === "in-call") return "status-connected";
  if (c.managed && c.online && c.peerPresenceVisible !== false) return "status-connected";
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return "status-connecting";
  return "status-disconnected";
}
function isReachable(c) { return c.status === "connected" || c.status === "in-call"; }
function unreadCount(c) { let n = 0; for (const m of c.messages) if (m.from === "them" && !m.readAckSent) n++; if (c.markedUnread) { if (state.chatId === c.id) delete c.markedUnread; else if (n === 0) n = 1; } return n; }

function renderChatsSkeleton(list) {
  list.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    row.innerHTML = `
      <div class="skeleton-avatar"></div>
      <div class="skeleton-lines">
        <div class="skeleton-line" style="width:${55 + (i % 3) * 10}%"></div>
        <div class="skeleton-line short"></div>
      </div>`;
    list.appendChild(row);
  }
}
function formatChatListTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatTime(ts);
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return T("status.yesterday");
  if (d.getFullYear() === now.getFullYear()) { try { return d.toLocaleDateString(I18N.current, { day: "2-digit", month: "2-digit" }); } catch (e) { return formatDay(ts); } }
  return formatDay(ts);
}
// Карточка «Добавьте первого собеседника»: видимый QR, три способа и подсказка про заметки. Кнопки переиспользуют
// существующие обработчики вкладки «Контакты» — своей логики добавления здесь нет.
// Ссылка-приглашение на сам сайт: открытие добавляет отправителя в контакты (см. handleAddLinkFromLocation)
function myAddLink() {
  const u = new URL(location.href); u.search = "";
  u.hash = "add=" + encodeURIComponent(Store.myId) + "&name=" + encodeURIComponent(Store.name || "");
  return u.toString();
}
async function shareMyInviteLink() {
  const url = myAddLink();
  if (navigator.share) { try { await navigator.share({ title: T("app.name"), text: T("firstRun.shareText"), url }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
  copyText(url, T("toast.linkCopied"));
}
function handleAddLinkFromLocation() {
  const m = (location.hash || "").match(/(?:^#|&)add=([^&]+)/);
  if (!m) return false;
  let id = "", name = "";
  try { id = decodeURIComponent(m[1]); const n = location.hash.match(/&name=([^&]*)/); name = n ? decodeURIComponent(n[1]) : ""; } catch (e) { return false; }
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
  if (!id || id === Store.myId) return true;
  try { addContactFromCard(id, name.slice(0, 40)); } catch (e) {}
  return true;
}
function buildFirstRunCard() {
  const card = document.createElement("div");
  card.className = "first-run-card flat-content";
  card.id = "first-run-card";
  card.innerHTML = `
    <h2>${escapeHtml(T("firstRun.title"))}</h2>
    <p class="fine muted">${escapeHtml(T("firstRun.sub"))}</p>
    <div class="first-run-qr"><canvas width="180" height="180" aria-label="${escapeHtml(T("firstRun.qrLabel"))}"></canvas><span class="fine muted">${escapeHtml(T("firstRun.qrHint"))}</span></div>
    <ol class="first-run-actions first-run-steps">
      <li><button type="button" class="btn-primary first-step" data-first="invite"><span class="fs-n">1</span><span class="fs-t">${escapeHtml(T("firstRun.step1"))}</span></button></li>
      <li><button type="button" class="btn-secondary first-step" data-first="scan"><span class="fs-n">2</span><span class="fs-t">${escapeHtml(T("firstRun.step2"))}</span></button></li>
      <li><button type="button" class="btn-secondary first-step" data-first="demo"><span class="fs-n">3</span><span class="fs-t">${escapeHtml(T("firstRun.step3"))}</span></button></li>
    </ol>
    <button type="button" class="btn-tertiary" data-first="find">${escapeHtml(T("firstRun.find"))}</button>
    <p class="fine muted first-run-note">${escapeHtml(T("firstRun.note"))}</p>`;
  try { renderQrToCanvas(card.querySelector("canvas")); } catch (e) {}
  const goConnect = (after) => { state.tab = "connect"; state.chatId = null; renderTab(); if (after) setTimeout(after, 60); };
  card.querySelector('[data-first="scan"]').addEventListener("click", () => { const b = $("#scan-qr-btn"); if (b) b.click(); });
  card.querySelector('[data-first="find"]').addEventListener("click", () => goConnect(() => { const i = $("#contacts-search") || $("#connect-search"); if (i) i.focus(); }));
  card.querySelector('[data-first="invite"]').addEventListener("click", () => shareMyInviteLink());
  card.querySelector('[data-first="demo"]').addEventListener("click", () => createDemoChat());
  return card;
}
// ===== Демо-чат: локальный «гид», ничего не уходит в сеть. Это обычный self-контакт (isSelf) с флагом isDemo, поэтому
// сеть, звонки и списки контактов его обходят так же, как «Заметки себе»; отвечает на сообщения по сценарию. =====
const DEMO_CHAT_ID = "__demo__";
function demoSay(c, text, extra) {
  const rec = Object.assign({ id: crypto.randomUUID(), from: "them", text, ts: Date.now(), readAckSent: true }, extra || {});
  c.messages.push(rec); c.lastActivity = rec.ts; persistContacts();
  if (state.chatId === c.id) { renderChatThread(); playMessageSound(c.id); } else if (state.tab === "chats") renderChatsList();
}
function createDemoChat() {
  let c = state.contacts.get(DEMO_CHAT_ID);
  if (!c) {
    c = { id: DEMO_CHAT_ID, name: T("demo.name"), raw: "", managed: true, publicKey: null, online: false, status: "self", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false, pinned: false, pinnedMessageId: null, isGroup: false, disappearingTimer: 0, isSelf: true, isDemo: true, demoStep: 0 };
    state.contacts.set(DEMO_CHAT_ID, c);
    demoSay(c, T("demo.welcome1")); demoSay(c, T("demo.welcome2"));
  }
  persistContacts();
  state.contactCardId = null; state.tab = "chats"; state.chatId = DEMO_CHAT_ID; renderTab();
}
function demoOnSend(c, payload) {
  if (!payload || !["chat", "poll", "board", "file-meta", "file"].includes(payload.kind)) return;
  const step = c.demoStep || 0; c.demoStep = step + 1;
  const kind = payload.kind;
  setTimeout(() => {
    if (!state.contacts.has(DEMO_CHAT_ID)) return;
    if (kind === "poll") { demoSay(c, T("demo.pollThanks")); return; }
    if (kind === "board") { demoSay(c, T("demo.boardThanks")); return; }
    if (step === 0) demoSay(c, T("demo.s1"));
    else if (step === 1) {
      demoSay(c, T("demo.s2"));
      const poll = EtherRich.sanitizePoll({ q: T("demo.pollQ"), multi: false, opts: [{ id: "o1", t: T("demo.pollA") }, { id: "o2", t: T("demo.pollB") }] });
      if (poll) setTimeout(() => demoSay(c, poll.q, { poll, pollVotes: {} }), 500);
      const board = EtherRich.sanitizeBoard({ title: T("demo.boardTitle"), cols: [{ id: "todo", t: T("chat.board.col1") }, { id: "doing", t: T("chat.board.col2") }, { id: "done", t: T("chat.board.col3") }] });
      if (board) setTimeout(() => {
        const rec = { id: crypto.randomUUID(), from: "them", text: board.title, ts: Date.now(), readAckSent: true, board };
        EtherRich.applyBoardOp(rec, { t: "add", card: { id: "d1", t: T("demo.card1"), col: "todo" } }, 1);
        EtherRich.applyBoardOp(rec, { t: "add", card: { id: "d2", t: T("demo.card2"), col: "doing" } }, 1);
        c.messages.push(rec); c.lastActivity = rec.ts; persistContacts(); if (state.chatId === c.id) renderChatThread();
      }, 1000);
    }
    else if (step === 2) demoSay(c, T("demo.s3"));
    else if (step === 3) demoSay(c, T("demo.s4"));
    else demoSay(c, T("demo.sEnd"));
  }, 700);
}
function setPinReorder(on) { state.pinReorder = !!on; renderChatsList(); }
function renderChatsList() {
  const list = $("#chats-list"), empty = $("#chats-empty"), archivedToggle = $("#chats-archived-toggle");
  if (!list) return;
  list.innerHTML = "";
  try { renderStoriesRow(); } catch (e) {}
  const query = state.searchQuery.toLowerCase();
  const all = Array.from(state.contacts.values());
  // Холодный старт: пока не прошло ~400мс с запуска (см. startApp), и
  // контактов ещё нет в памяти — показываем skeleton вместо пустого
  // экрана, чтобы не мигать "No one is online yet" на долю секунды,
  // пока состояние только восстанавливается из хранилища.
  if (!state._firstRenderDone && all.length === 0 && !query) {
    if (empty) empty.classList.add("hidden");
    if (archivedToggle) archivedToggle.classList.add("hidden");
    renderChatsSkeleton(list);
    return;
  }
  const activeFolder = state.chatFilter.startsWith("folder:") ? state.folders.find((f) => f.id === state.chatFilter.slice(7)) : null;
  const passesChatFilter = (c) => {
    if (state.chatFilter === "unread") return unreadCount(c) > 0;
    if (state.chatFilter === "groups") return isGroup(c);
    if (state.chatFilter === "direct") return !isGroup(c);
    if (state.chatFilter.startsWith("folder:")) return !!activeFolder && activeFolder.contactIds.includes(c.id);
    return true;
  };
  // Тумблер архива виден, только если в архиве есть чат, подходящий под текущий фильтр.
  const withArchived = all.some((c) => c.archived && passesChatFilter(c));
  const visible = all.filter((c) => (c.archived ? state.showArchived : true) && passesChatFilter(c));
  const filtered = query
    ? visible.filter((c) => (c.name || "").toLowerCase().includes(query) || c.messages.some((m) => (m.text || "").toLowerCase().includes(query) || (m.file && m.file.name || "").toLowerCase().includes(query) || (m.contactCard && m.contactCard.name || "").toLowerCase().includes(query)))
    : visible;
  if (filtered.length === 0) {
    // Поиск или фильтр ничего не нашли — объясняем и даём выход, а не пустой экран
    if (query.length > 0 || state.chatFilter !== "all") {
      const nb = document.createElement("div"); nb.className = "empty-inline";
      nb.innerHTML = `${Icons.html("search", 28)}<p>${escapeHtml(T(query ? "chats.noResults" : "chats.noInFilter"))}</p><button type="button" class="btn-secondary">${escapeHtml(T(query ? "chats.clearSearch" : "chats.showAll"))}</button>`;
      nb.querySelector("button").addEventListener("click", () => {
        if (query) { state.searchQuery = ""; const si = $("#global-search"); if (si) si.value = ""; } else state.chatFilter = "all";
        renderChatsList();
      });
      list.appendChild(nb);
    }
    if (empty) empty.classList.toggle("hidden", query.length > 0 || state.chatFilter !== "all");
    if (archivedToggle) archivedToggle.classList.toggle("hidden", !withArchived);
    return;
  }
  if (empty) empty.classList.add("hidden");
  if (archivedToggle) archivedToggle.classList.toggle("hidden", !withArchived);
  // Пока нет ни одного собеседника (есть только «Заметки себе») — карточка с действиями вместо немого пустого списка.
  const noPeers = !all.some((c) => !c.isSelf && !c.isDemo && c.managed);
  if (noPeers && state.chatFilter === "all" && !query && Store.myId) list.appendChild(buildFirstRunCard());
  const ta = $("#toggle-archived");
  if (ta) {
    ta.textContent = state.showArchived ? T("chats.archive.hide") : T("chats.archive.show");
    // Стрелка раньше была зашита прямо в переводимый текст (›/‹) — в RTL
    // браузер не разворачивает текстовые символы автоматически. Теперь
    // стрелка идёт через CSS ::after с учётом dir, а класс здесь только
    // выбирает направление "открыт/закрыт".
    ta.classList.toggle("is-open", state.showArchived);
  }
  // Sticky секция "Непрочитанные": группируем непрочитанные чаты (кроме
  // закреплённых — те и так всегда наверху) в отдельный блок с заголовком.
  // Включаем только когда это реально что-то разделяет (есть и
  // непрочитанные, и прочитанные среди незакреплённых) и только во вкладке
  // "Все" без поиска — во вкладке "Unread" и так показаны только
  // непрочитанные, а при поиске заголовок был бы лишним шумом.
  const showUnreadSection = state.chatFilter === "all" && !query && (() => {
    const rest = filtered.filter((c) => !c.pinned);
    return rest.some((c) => unreadCount(c) > 0) && rest.some((c) => unreadCount(c) === 0);
  })();
  const items = filtered.sort((a, b) => {
    const aPinned = a.pinned ? 1 : 0, bPinned = b.pinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    // Среди закреплённых — явный ручной порядок (раздел 4 роадмапа,
    // drag-to-reorder), а не online/lastActivity, как у обычных чатов:
    // пользователь сам расставил их руками, пересортировка по активности
    // на каждый новый входящий чат сделала бы drag бессмысленным.
    if (a.pinned && b.pinned) return (a.pinOrder || 0) - (b.pinOrder || 0);
    if (showUnreadSection && !a.pinned && !b.pinned) {
      const aUnread = unreadCount(a) > 0 ? 1 : 0, bUnread = unreadCount(b) > 0 ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
    }
    const aLive = isReachable(a) || a.online ? 1 : 0, bLive = isReachable(b) || b.online ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
  // Drag-to-reorder закреплённых (раздел 4) доступен только там, где видимый
  // порядок закреплённых чатов совпадает с их реальным pinOrder "начисто" —
  // то есть во вкладке "Все" без поиска и без включённого "показать
  // архивные" (архивный+закреплённый чат — редкий краевой случай, в этом
  // релизе сознательно не усложняем). pinnedPairs заполняется по ходу
  // рендера и используется один раз после цикла, чтобы навесить обработчики
  // перетаскивания на уже готовые DOM-узлы.
  const canReorderPins = state.chatFilter === "all" && !query && !state.showArchived;
  const pinnedCountTotal = items.filter((c) => c.pinned).length;
  if (state.pinReorder && !(canReorderPins && pinnedCountTotal > 1)) state.pinReorder = false;
  if (state.pinReorder) {
    const bar = document.createElement("div");
    bar.className = "chats-reorder-bar";
    bar.innerHTML = `<span>${escapeHtml(T("chats.reorder.hint"))}</span><button type="button" class="btn-tertiary">${escapeHtml(T("chats.reorder.done"))}</button>`;
    bar.querySelector("button").addEventListener("click", () => setPinReorder(false));
    list.appendChild(bar);
  }
  const pinnedPairs = [];
  let unreadHeaderShown = false;
  for (const c of items) {
    if (showUnreadSection && !c.pinned && !unreadHeaderShown && unreadCount(c) > 0) {
      const header = document.createElement("div");
      header.className = "chats-section-header";
      header.textContent = T("chats.section.unread");
      list.appendChild(header);
      unreadHeaderShown = true;
    }
    const last = c.messages[c.messages.length - 1];
    const unread = unreadCount(c);
    const wrapper = document.createElement("div");
    wrapper.className = "chat-row-wrapper";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chat-row flat-content" + (c.archived ? " archived" : "");
    const __rowMutedForBadge = isContactMuted(c);
    const badge = unread > 0 ? `<span class="unread-badge${__rowMutedForBadge ? " is-muted" : ""}">${unread > 99 ? "99+" : unread}</span>` : "";
    const mentionIcon = state.mentionedChats.has(c.id) ? `<span class="chat-row-mention" title="${escapeHtml(T("chats.mentioned"))}">@</span>` : "";
    // Раньше title у этих двух иконок был захардкожен на английском ("Mute"/
    // "Blocked") — единственное место в списке чатов, где подсказка не шла
    // через T(). При смене языка подсказка оставалась английской.
    const __rowMuted = isContactMuted(c);
    const muteIcon = __rowMuted ? `<span class="muted-icon" title="${escapeHtml(c.muted ? T("chat.contact.mute") : T("chat.mute.until", { time: formatChatListTime(c.muteUntil) }))}"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 5 5.9v4l1.6 2.4a1 1 0 0 1-.8 1.6H5.2a1 1 0 0 1-.8-1.6L6 13.5v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1zm-2 18a2 2 0 0 0 4 0h-4z"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>` : "";
    const blockIcon = c.blocked ? `<span class="muted-icon" title="${escapeHtml(T("chat.contact.block"))}"><svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>` : "";
    const pinIcon = c.pinned ? `<span class="muted-icon" title="${escapeHtml(T("chats.pin"))}">${Icons.html("pin", 13)}</span>` : "";
    let preview = last
      ? (last.from === "system" && last.textKey ? escapeHtml(renderSystemMessageText(last)) : last.file ? escapeHtml(T("chat.file.preview." + last.file.kind)) : (last.poll ? escapeHtml(truncate(T("chat.poll.preview", { q: last.text }), 42)) : last.note ? escapeHtml(truncate(T("chat.note.preview", { title: last.text }), 42)) : last.board ? escapeHtml(truncate(T("chat.board.preview", { title: last.text }), 42)) : last.contactCard ? escapeHtml(T("chat.contactCard.preview", { name: last.contactCard.name || T("sys.someone") })) : escapeHtml(truncate(last.text, 42))))
      : escapeHtml(contactStatusLabel(c));
    if (query && last && (last.text || "").toLowerCase().includes(query)) preview = highlightRaw(escapeHtml(truncate(last.text, 42)), state.searchQuery);
    // "Печатает…" перекрывает обычное превью — раньше это было видно
    // только в шапке уже открытого треда, хотя состояние (typingTimers)
    // уже отслеживалось и для списка чатов, просто не использовалось.
    const isTyping = !isGroup(c) && state.typingTimers.has(c.id);
    if (isTyping) {
      preview = `<span class="chat-row-typing"><span class="typing-dots" aria-label="${escapeHtml(T("chat.typing"))}"><span></span><span></span><span></span></span></span>`;
    } else {
      // Черновик перекрывает обычное превью (но не "печатает") — только
      // если он не пуст. Хранится отдельно от самого текста сообщения,
      // поэтому не влияет на последнее реальное сообщение в чате.
      const draft = state.drafts[c.id];
      if (draft && draft.trim()) {
        preview = `<span class="chat-row-draft">${escapeHtml(T("chats.draft"))}:</span> ` + escapeHtml(truncate(draft, 34));
      }
    }
    // "Не доставлено" — последнее МОЁ сообщение в чате зависло в ack=failed.
    const lastMine = c.messages.length ? [...c.messages].reverse().find((m) => m.from === "me") : null;
    // Иерархия строки: имя, превью, время, непрочитанное, упоминание. Закреп, mute, блок и «не доставлено» из строки убраны:
    // закреплённые и так сверху (состояние видно в свайп-действиях), mute показывает приглушённый бейдж, «не доставлено» видно
    // у самого сообщения в чате. Для скринридера все состояния остаются текстом.
    const stateNotes = [c.pinned ? T("chats.pin") : "", __rowMuted ? (c.muted ? T("chat.contact.mute") : T("chat.mute.until", { time: formatChatListTime(c.muteUntil) })) : "", c.blocked ? T("chat.contact.block") : "", lastMine && lastMine.ack === "failed" ? T("ack.failed") : ""].filter(Boolean);
    const stateSr = stateNotes.length ? `<span class="sr-only">, ${escapeHtml(stateNotes.join(", "))}</span>` : "";

    // Статус онлайн теперь точкой прямо на аватаре (как Signal/WhatsApp),
    // а не текстовым символом ● справа от имени. У групп точку не
    // показываем — там статус не про presence одного человека.
    const showDot = !isGroup(c) && c.managed && !c.isSelf; // self-chat не "онлайн"/"офлайн" — у него просто нет такого понятия
    const statusDot = showDot ? `<span class="avatar-status-dot ${contactStatusClass(c)}"></span>` : "";
    const timeLabel = last ? escapeHtml(formatChatListTime(last.ts)) : "";
    // Ручка drag-to-reorder (раздел 4) — только у закреплённых чатов, и
    // только когда их больше одного (тащить единственный закреплённый чат
    // некуда) и видимый порядок надёжен (см. canReorderPins выше). Это
    // <span>, а не <button>: row сам уже <button>, а вложенные кнопки в
    // кнопке — невалидный HTML и в некоторых браузерах теряют pointer-события.
    const showDragHandle = c.pinned && canReorderPins && pinnedCountTotal > 1 && state.pinReorder;
    const dragHandle = showDragHandle
      ? `<span class="chat-row-drag-handle" aria-hidden="true"><svg viewBox="0 0 12 20" width="12" height="20"><circle cx="3" cy="3" r="1.4" fill="currentColor"/><circle cx="9" cy="3" r="1.4" fill="currentColor"/><circle cx="3" cy="10" r="1.4" fill="currentColor"/><circle cx="9" cy="10" r="1.4" fill="currentColor"/><circle cx="3" cy="17" r="1.4" fill="currentColor"/><circle cx="9" cy="17" r="1.4" fill="currentColor"/></svg></span>`
      : "";
    row.innerHTML = `
      ${avatarCircleHtml(c, null, statusDot)}
      <div class="chat-row-body">
        <div class="chat-row-top">
          <span class="chat-row-name${unread > 0 ? " unread" : ""}${__rowMuted ? " is-muted" : ""}">${escapeHtml(c.name || T("sys.someone"))}${stateSr}</span>
          <span class="chat-row-time">${timeLabel}</span>
        </div>
        <div class="chat-row-sub"><span class="chat-row-preview-text">${preview}</span>${mentionIcon}${badge}${dragHandle}</div>
      </div>`;
    // Свайп открывает фоновые действия (pin/архив слева, удалить справа)
    // — сама кнопка строки едет поверх них через translateX. Структура:
    // wrapper > [фон с действиями] + [сама строка].
    wrapper.innerHTML = `
      <div class="chat-row-actions chat-row-actions-start">
        <button type="button" class="chat-row-action-btn chat-row-action-archive" data-action="archive">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20.5 4h-17A1.5 1.5 0 0 0 2 5.5v2A1.5 1.5 0 0 0 3.5 9H4v9.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9h.5A1.5 1.5 0 0 0 22 7.5v-2A1.5 1.5 0 0 0 20.5 4zM18 18.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V9h12v9.5zM20 7H4V6h16v1z"/><path fill="currentColor" d="M9.5 13h5a.5.5 0 0 0 0-1h-5a.5.5 0 0 0 0 1z"/></svg>
          <span>${escapeHtml(c.archived ? T("chats.action.unarchive") : T("chats.action.archive"))}</span>
        </button>
        <button type="button" class="chat-row-action-btn chat-row-action-mute" data-action="mute">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 5 5.9v4l1.6 2.4a1 1 0 0 1-.8 1.6H5.2a1 1 0 0 1-.8-1.6L6 13.5v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1zm-2 18a2 2 0 0 0 4 0h-4z"/>${__rowMuted ? `<line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` : ""}</svg>
          <span>${escapeHtml(__rowMuted ? T("chats.action.unmute") : T("chats.action.mute"))}</span>
        </button>
      </div>
      <div class="chat-row-actions chat-row-actions-end">
        <button type="button" class="chat-row-action-btn chat-row-action-pin" data-action="pin">
          ${Icons.html("pin", 18)}
          <span>${escapeHtml(c.pinned ? T("chats.unpin") : T("chats.pin"))}</span>
        </button>
        <button type="button" class="chat-row-action-btn chat-row-action-delete" data-action="delete">
          ${Icons.html("trash", 20)}
          <span>${escapeHtml(T("chats.action.delete"))}</span>
        </button>
      </div>`;
    wrapper.appendChild(row);
    row.addEventListener("click", () => {
      if (state.pinReorder) return; // в режиме порядка нажатие по строке чат не открывает
      if (row.__longPressed) { row.__longPressed = false; return; }
      try { closeChatSearch(); } catch (e) {} cancelVoiceRecordingIfLeavingChat(c.id); state.multiSelect = null; state.chatId = c.id; renderTab();
    });
    if (c.pinned && canReorderPins && pinnedCountTotal > 1 && !state.pinReorder) {
      // долгое нажатие на закреплённый чат включает режим порядка: только тогда появляются ручки перетаскивания
      let lpTimer = null, lpX = 0, lpY = 0;
      const lpCancel = () => { clearTimeout(lpTimer); lpTimer = null; };
      row.addEventListener("pointerdown", (e) => { lpX = e.clientX; lpY = e.clientY; lpCancel(); lpTimer = setTimeout(() => { row.__longPressed = true; haptic("light"); setPinReorder(true); }, 550); });
      row.addEventListener("pointermove", (e) => { if (lpTimer && (Math.abs(e.clientX - lpX) > 8 || Math.abs(e.clientY - lpY) > 8)) lpCancel(); });
      row.addEventListener("pointerup", lpCancel); row.addEventListener("pointercancel", lpCancel); row.addEventListener("pointerleave", lpCancel);
    }
    attachChatRowSwipe(wrapper, row, c);
    if (!(c.pinned && canReorderPins && pinnedCountTotal > 1 && !state.pinReorder)) attachChatRowContext(row, c); else row.addEventListener("contextmenu", (e) => { e.preventDefault(); row.__longPressed = true; openChatRowMenu(c); });
    if (showDragHandle) pinnedPairs.push({ wrapper, c });
    list.appendChild(wrapper);
  }
  // Навешиваем обработчики перетаскивания одним проходом после того, как
  // все строки закреплённых чатов уже в DOM — attachPinDragHandle нужны
  // itemBoundingClientRect() соседних строк, а они известны только когда
  // все уже отрендерены.
  if (pinnedPairs.length > 1) {
    pinnedPairs.forEach((pair, i) => {
      const handle = pair.wrapper.querySelector(".chat-row-drag-handle");
      if (handle) attachPinDragHandle(handle, pair.wrapper, pinnedPairs, i);
    });
  }
}
// Drag-to-reorder закреплённых чатов (раздел 4 роадмапа). Решение в пользу
// простоты: во время перетаскивания строка просто едет за пальцем по
// вертикали (translateY), соседние строки визуально НЕ "расступаются" —
// итоговый порядок пересчитывается целиком только в момент отпускания, по
// тому, какая из исходных позиций закреплённых строк (снятых ДО начала
// жеста) оказалась ближе к пальцу. Дороже в UX, чем live-реордер соседей,
// но сильно меньше кода и площади для регрессии — ничего в существующем
// свайпе строки (attachChatRowSwipe) не трогается, обработчики полностью
// изолированы на отдельном маленьком элементе-ручке.
function attachPinDragHandle(handle, wrapper, pinnedPairs, startIndex) {
  let dragging = false, startY = 0, rects = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    startY = e.clientY;
    rects = pinnedPairs.map((p) => p.wrapper.getBoundingClientRect());
    wrapper.classList.add("pin-dragging");
    haptic("light");
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    wrapper.style.transform = `translateY(${e.clientY - startY}px)`;
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    wrapper.classList.remove("pin-dragging");
    wrapper.style.transform = "";
    let targetIndex = startIndex, bestDist = Infinity;
    rects.forEach((r, i) => {
      const d = Math.abs((r.top + r.height / 2) - e.clientY);
      if (d < bestDist) { bestDist = d; targetIndex = i; }
    });
    if (targetIndex !== startIndex) {
      const ids = pinnedPairs.map((p) => p.c.id);
      const movedId = ids.splice(startIndex, 1)[0];
      ids.splice(targetIndex, 0, movedId);
      ids.forEach((id, i) => { const cc = state.contacts.get(id); if (cc) cc.pinOrder = i; });
      persistContacts();
      haptic("light");
      renderChatsList();
    }
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  // Сам клик по ручке (без перетаскивания) не должен открывать чат — row
  // это <button>, клик на вложенном <span> всплывёт на него, если не
  // остановить.
  handle.addEventListener("click", (e) => { e.stopPropagation(); });
}

// Кэш «сейчас светлая тема?» — matchMedia и чтение dataset дорогие
// при вызове на каждый рендер каждого контакта. Сбрасывается в
// applyTheme() и в слушателе prefers-color-scheme.
let __isLightCache = null;
function isLightTheme() {
  if (__isLightCache !== null) return __isLightCache;
  const t = document.documentElement.dataset.theme;
  __isLightCache = (t === "light") || (t === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  return __isLightCache;
}

// Генерация аватара: вместо пяти пресетов — уникальный HSL-градиент
// от хэша имени. В тёмной теме — приглушённее (light 42%), в светлой
// — наоборот светлее (52%). Два угла градиента берутся из одного
// оттенка с комплементарным сдвигом +40°.
// P2: кэш по имени+теме — список чатов/контактов пересчитывал один и
// тот же градиент на каждый renderChatsList (и это не только hsl()
// строка, а ещё и цикл по символам имени на хэш). Инвалидируется вместе
// с __isLightCache, тем же local reset в applyTheme()/слушателе
// prefers-color-scheme — ключ сам включает признак темы, так что даже
// без явной чистки старые записи просто не совпадут по ключу.
const _avatarGradientCache = new Map();
function avatarGradient(name) {
  const s = String(name || "?");
  const light = isLightTheme();
  const cacheKey = (light ? "L:" : "D:") + s;
  const cached = _avatarGradientCache.get(cacheKey);
  if (cached) return cached;
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const hue = ((h % 360) + 360) % 360;
  const hue2 = (hue + 40) % 360;
  const sat = 65 + (h % 15);
  const lt = light ? 52 : 42;
  const grad = `linear-gradient(150deg, hsl(${hue}, ${sat}%, ${lt + 8}%), hsl(${hue2}, ${sat}%, ${lt - 6}%))`;
  // Защита от неограниченного роста — на практике число разных имён в
  // одном клиенте мало (контакты + участники групп), но на всякий
  // случай не копим бесконечно (например, если имя меняется часто).
  // Раньше при переполнении карта чистилась ПОЛНОСТЬЮ (.clear()) — это
  // не LRU, а просто сброс всего кэша разом: на следующей же перерисовке
  // списка чатов все контакты заново считают градиент. Map хранит ключи
  // в порядке вставки, так что первые ключи — самые старые; вытесняем
  // только их, как и в fileBlobUrlCache.
  if (_avatarGradientCache.size > 500) {
    const toRemove = _avatarGradientCache.size - 450;
    let removed = 0;
    for (const k of _avatarGradientCache.keys()) {
      if (removed >= toRemove) break;
      _avatarGradientCache.delete(k);
      removed++;
    }
  }
  _avatarGradientCache.set(cacheKey, grad);
  return grad;
}

function renderContactsList() {
  const wrap = $("#contacts-list");
  const empty = $("#contacts-empty");
  const indexNav = $("#contacts-index");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (indexNav) { indexNav.innerHTML = ""; indexNav.classList.add("hidden"); }
  let contacts = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c) && !c.isSelf);
  const q = (state.contactsSearchQuery || "").trim().toLowerCase();
  if (q) contacts = contacts.filter((c) => (c.name || "").toLowerCase().includes(q));
  if (contacts.length === 0) { if (empty) empty.classList.remove("hidden"); return; }
  if (empty) empty.classList.add("hidden");
  // A-Z вместо "по активности" — список контактов, в отличие от списка
  // чатов, это адресная книга: там ищут по имени, не по тому, кто
  // недавно писал (для этого есть отдельный экран чатов).
  contacts.sort((a, b) => (a.name || "").localeCompare(b.name || "", I18N.current, { sensitivity: "base" }));
  // Буквенный индекс показываем только при длинном списке и без активного
  // поиска (во время поиска список и так короткий, а якоря "прыгали" бы
  // следом за фильтром) — >20 контактов порог из отчёта.
  const showIndex = contacts.length > 20 && !q;
  const seenLetters = new Set();
  for (const c of contacts) {
    const row = document.createElement("div");
    row.className = "roster-row";
    const letter = (c.name || "").trim().charAt(0).toUpperCase() || "#";
    if (showIndex) row.dataset.letter = letter;
    row.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div>
      <div class="roster-name-block" style="flex:1; min-width:0;">
        <div class="roster-name">${escapeHtml(c.name || T("sys.someone"))}</div>
        <div class="fine muted">${escapeHtml(contactStatusLabel(c))}</div>
      </div>
      <button type="button" class="roster-add-btn" data-action="card">${escapeHtml(T("contact.openCard"))}</button>`;
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-action]")) return;
      openContactCard(c.id);
    });
    row.querySelector('[data-action="card"]').addEventListener("click", (ev) => {
      ev.stopPropagation();
      openContactCard(c.id);
    });
    wrap.appendChild(row);
    seenLetters.add(letter);
  }
  if (showIndex && indexNav) {
    indexNav.classList.remove("hidden");
    for (const letter of seenLetters) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "contacts-index-btn"; btn.textContent = letter; btn.tabIndex = -1;
      btn.addEventListener("click", () => {
        const target = Array.from(wrap.children).find((el) => el.dataset.letter === letter);
        if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      indexNav.appendChild(btn);
    }
  }
}

function openContactCard(contactId) {
  if (!state.contacts.has(contactId)) return;
  const c = state.contacts.get(contactId);
  if (isGroup(c)) { openGroupInfo(contactId); return; }
  state.chatId = null;
  __lastRenderedChatId = null;
  state.multiSelect = null; // см. комментарий в closeChatSafely — этот путь выхода из чата её не вызывает
  state.contactCardId = contactId;
  renderTab();
}
function openGroupInfo(groupId) {
  const g = state.contacts.get(groupId); if (!g || !isGroup(g)) return;
  state.activeGroupContext = groupId;
  const avatarBtn = $("#group-info-avatar-btn");
  if (avatarBtn) {
    if (g.avatar) { avatarBtn.style.backgroundImage = `url('${g.avatar}')`; avatarBtn.style.background = ""; avatarBtn.textContent = ""; }
    else { avatarBtn.style.backgroundImage = ""; avatarBtn.style.background = avatarGradient(g.name); avatarBtn.textContent = initials(g.name); }
  }
  const nameInput = $("#group-info-name"); if (nameInput) nameInput.value = g.name || "";
  { const rt = $("#group-info-room"); if (rt) { rt.checked = !!g.room; rt.disabled = !isGroupAdmin(g, Store.myId); } }
  const descInput = $("#group-info-description"); if (descInput) descInput.value = g.description || "";
  const list = $("#group-info-members");
  const myIsAdmin = isGroupAdmin(g, Store.myId);
  if (list) {
    list.innerHTML = "";
    for (const m of g.members) {
      const row = document.createElement("div");
      row.className = "forward-row";
      const isMe = m.id === Store.myId;
      const memberIsAdmin = isGroupAdmin(g, m.id);
      const canRemove = myIsAdmin && !isMe;
      const roleBadge = memberIsAdmin ? `<span class="group-role-badge">${escapeHtml(T("group.admin"))}</span>` : "";
      row.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(m.name)}">${escapeHtml(initials(m.name))}</div><span class="forward-name">${escapeHtml(m.name)}${isMe ? " " + escapeHtml(T("group.you")) : ""}</span>${roleBadge}`;
      if (myIsAdmin && !isMe && g.createdBy !== m.id) {
        const toggle = document.createElement("button");
        toggle.type = "button"; toggle.className = "icon-btn small";
        toggle.textContent = memberIsAdmin ? T("group.demote") : T("group.promote");
        toggle.addEventListener("click", (ev) => { ev.stopPropagation(); setGroupMemberRole(groupId, m.id, memberIsAdmin ? "member" : "admin"); openGroupInfo(groupId); });
        row.appendChild(toggle);
      }
      if (canRemove) {
        const rm = document.createElement("button");
        rm.type = "button"; rm.className = "icon-btn"; rm.setAttribute("aria-label", T("group.remove"));
        rm.innerHTML = '' + Icons.html("x", 18) + '';
        rm.addEventListener("click", (ev) => { ev.stopPropagation(); removeGroupMember(groupId, m.id, false); openGroupInfo(groupId); });
        row.appendChild(rm);
      }
      list.appendChild(row);
    }
  }
  const renameBtnEl = $("#group-info-rename-btn"); if (renameBtnEl) renameBtnEl.classList.toggle("hidden", !myIsAdmin);
  const nameInputEl = $("#group-info-name"); if (nameInputEl) nameInputEl.disabled = !myIsAdmin;
  const descBtnEl = $("#group-info-description-btn"); if (descBtnEl) descBtnEl.classList.toggle("hidden", !myIsAdmin);
  const descInputEl = $("#group-info-description"); if (descInputEl) descInputEl.disabled = !myIsAdmin;
  const addBtnEl = $("#group-info-add-btn"); if (addBtnEl) addBtnEl.classList.toggle("hidden", !myIsAdmin);
  const avatarBtnEl = $("#group-info-avatar-btn"); if (avatarBtnEl) avatarBtnEl.disabled = !myIsAdmin;
  const writeRestrictedEl = $("#group-info-write-restricted");
  if (writeRestrictedEl) { writeRestrictedEl.checked = !!g.writeRestricted; writeRestrictedEl.disabled = !myIsAdmin; }
  // Раздел 8/18 роадмапа — invite-ссылка в группу: создавать её может
  // только админ (см. комментарий у buildGroupInviteCode выше по файлу) —
  // участнику без прав added бы не смог обработать join-request, который
  // придёт в ответ на его же ссылку.
  const inviteLinkBtnEl = $("#group-info-invite-link-btn"); if (inviteLinkBtnEl) inviteLinkBtnEl.classList.toggle("hidden", !myIsAdmin);
  const sheet = $("#group-info-sheet"); if (sheet) sheet.classList.remove("hidden");
}
// Раздел 8 роадмапа — "права группы": единственное право, которое есть
// смысл делать без сервера-арбитра — "писать могут только админы".
// Полноценный "медленный режим" (таймер между сообщениями у каждого
// участника) требует доверенного источника времени/состояния — в чистом
// P2P без сервера это легко обойти, подделав локальные часы, так что
// давать на это ложную гарантию хуже, чем не делать вовсе. Этот тумблер —
// честная версия задачи, которую можно реально обеспечить.
function isGroupWriteAllowed(g, userId) {
  if (!g || !g.writeRestricted) return true;
  return isGroupAdmin(g, userId);
}
function setGroupWriteRestricted(groupId, restricted) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupAdmin(g, Store.myId)) { toast(T("toast.groupAdminOnly")); return; }
  g.writeRestricted = !!restricted;
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T(restricted ? "group.systemWriteRestricted" : "group.systemWriteOpen"), textKey: restricted ? "group.systemWriteRestricted" : "group.systemWriteOpen", ts: Date.now() });
  trimMessages(g);
  g.lastActivity = Date.now();
  persistContacts();
  if (state.chatId === groupId) { renderChatThreadInner(); updateSendVsMic(); }
  // Рассылаем новое состояние всем участникам — иначе их композер и
  // (что важнее) приёмная проверка в applyIncomingPayload остались бы
  // со старым значением writeRestricted, не зная о решении админа.
  const payload = { kind: "group-settings", id: crypto.randomUUID(), groupId, writeRestricted: g.writeRestricted };
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const mc = ensureContactEntry(m.id, m.name);
    trySendOrQueue(mc, crypto.randomUUID(), payload).catch(() => {});
  }
}
function renderContactCard() {
  const c = state.contacts.get(state.contactCardId);
  if (!c) { state.contactCardId = null; renderTab(); return; }
  const av = $("#contact-avatar");
  if (av) {
    // Раньше после backgroundImage шло присваивание av.style.background = "" — сокращённое свойство сбрасывало и картинку,
    // поэтому выбранное фото никогда не показывалось. Теперь сначала фон-заготовка, затем (если есть фото) только backgroundImage.
    const shown = c.avatar || c.peerAvatar;
    if (shown && AVATAR_DATAURL_RE.test(shown)) { av.style.background = ""; av.style.backgroundImage = `url('${shown}')`; av.style.backgroundSize = "cover"; av.style.backgroundPosition = "center"; av.textContent = ""; }
    else { av.style.backgroundImage = ""; av.style.backgroundSize = ""; av.style.background = avatarGradient(c.name); av.textContent = initials(c.name); }
  }
  const n = $("#contact-name"); if (n) n.textContent = c.name || T("sys.someone");
  const navT = $("#nav-contact-title"); if (navT) navT.textContent = c.name || T("sys.someone");
  const st = $("#contact-status"); if (st) st.textContent = contactStatusLabel(c);
  const aboutEl = $("#contact-about-status");
  if (aboutEl) {
    const about = (c.peerStatus || "").trim();
    aboutEl.textContent = about;
    aboutEl.classList.toggle("hidden", !about);
  }
  const idEl = $("#contact-info-id"); if (idEl) idEl.textContent = c.raw || T("chat.contact.identifier.unknown");
  const contactIsMuted = isContactMuted(c);
  const mutedEl = $("#contact-info-muted");
  if (mutedEl) {
    const bellPath = '<path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v.6a6 6 0 0 1 5 5.9v4l1.6 2.4a1 1 0 0 1-.8 1.6H5.2a1 1 0 0 1-.8-1.6L6 13.5v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1zm-2 18a2 2 0 0 0 4 0h-4z"/>';
    const slash = '<line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    mutedEl.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16">${bellPath}${contactIsMuted ? slash : ""}</svg>`;
    mutedEl.title = contactIsMuted && !c.muted ? T("chat.mute.until", { time: formatChatListTime(c.muteUntil) }) : "";
  }
  const vibrateOnlyEl = $("#contact-vibrate-only"); if (vibrateOnlyEl) vibrateOnlyEl.checked = !!c.vibrateOnly;
  const blockBtn = $("#contact-block-btn"); if (blockBtn) blockBtn.textContent = c.blocked ? T("chat.contact.unblock") : T("chat.contact.block");
  const archBtn = $("#contact-archive-btn");
  if (archBtn) {
    // Подпись переключается «В архив» ↔ «Из архива»; меняем только первый <span> (стрелка-шеврон остаётся) и его data-i18n,
    // иначе applyStaticTranslations() вернёт старую подпись.
    const key = c.archived ? "chat.contact.unarchive" : "chat.contact.archive";
    const lb = archBtn.querySelector("span");
    if (lb) { lb.textContent = T(key); lb.setAttribute("data-i18n", key); } else archBtn.textContent = T(key);
  }
  // Раньше здесь было muteBtn.textContent = T(...), что стирало ВСЮ
  // разметку кнопки (включая <span class="chevron"> со стрелкой) — textContent
  // заменяет все дети одним текстовым узлом. Теперь трогаем только первый
  // <span> (подпись), чеврон остаётся на месте; подпись дополнительно
  // отражает реальный статус (постоянный/временный мьют), а не всегда "Mute".
  const muteBtn = $("#contact-mute-btn");
  if (muteBtn) {
    const muteLabel = muteBtn.querySelector("span");
    if (muteLabel) muteLabel.textContent = contactIsMuted ? T("chats.action.unmute") : T("chat.contact.mute");
  }
  const pinBtnLbl = $("#contact-pin-btn span"); if (pinBtnLbl) pinBtnLbl.textContent = c.pinned ? T("chats.unpin") : T("chats.pin");
  const disSel = $("#contact-disappearing-select"); if (disSel) disSel.value = String(c.disappearingTimer || 0);
  const soundSel = $("#contact-sound-select"); if (soundSel) soundSel.value = c.notificationSound || "";
  renderContactGallery(c);
}
// P2 — галерея медиа контакта: мини-грид последних фото/видео из переписки,
// в карточке контакта. Загружаем object URL лениво, только когда карточка
// открыта (getFileBlobUrl уже кеширует и ограничивает размер кеша).
function renderContactGallery(c) {
  const group = $("#contact-gallery-group");
  const grid = $("#contact-gallery-grid");
  const countEl = $("#contact-gallery-count");
  if (!group || !grid) return;
  const media = c.messages.filter((m) => m.file && !m.file.pending && !m.file.failed && (m.file.kind === "image" || m.file.kind === "video")).slice(-24).reverse();
  if (media.length === 0) { group.classList.add("hidden"); grid.innerHTML = ""; return; }
  group.classList.remove("hidden");
  if (countEl) countEl.textContent = String(media.length);
  grid.innerHTML = media.map((m) => `<button type="button" class="contact-gallery-item" data-msg-id="${escapeHtml(m.id)}" data-kind="${escapeHtml(m.file.kind)}"><div class="contact-gallery-loading"></div></button>`).join("");
  for (const m of media) {
    const btn = grid.querySelector(`[data-msg-id="${CSS.escape(m.id)}"]`);
    if (!btn) continue;
    getFileBlobUrl(m.id).then((url) => {
      if (!url || !btn.isConnected) return;
      if (m.file.kind === "video") {
        btn.innerHTML = `<video src="${escapeHtml(url)}" muted playsinline></video><span class="contact-gallery-play">${Icons.html("play", 22)}</span>`;
      } else {
        btn.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`;
      }
    }).catch(() => {});
  }
}
function wireContactGallery() {
  const grid = $("#contact-gallery-grid");
  if (!grid) return;
  grid.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".contact-gallery-item");
    if (!btn) return;
    const msgId = btn.dataset.msgId;
    const url = await getFileBlobUrl(msgId);
    // Не window.open: blob-документ открылся бы в origin приложения (опасно для SVG/HTML от собеседника) — смотрим во встроенном просмотрщике
    if (url) openMediaViewer(url, btn.dataset.kind === "video" ? "video" : "image");
  });
}
function wireContactCard() {
  const msgBtn = $("#contact-msg-btn");
  if (msgBtn) msgBtn.addEventListener("click", () => {
    const id = state.contactCardId; if (!id) return;
    cancelVoiceRecordingIfLeavingChat(id);
    state.contactCardId = null; state.chatId = id; renderTab();
  });
  const callBtn = $("#contact-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => {
    const id = state.contactCardId;
    if (!id) { toast("!"); return; }
    beginCall(id);
  });
  const rename = $("#contact-rename-btn");
  if (rename) rename.addEventListener("click", () => {
    const id = state.contactCardId;
    const c = state.contacts.get(id); if (!c) return;
    state.activeContactContext = id;
    const ri = $("#rename-input"); if (ri) ri.value = c.name || "";
    const rs = $("#rename-sheet"); if (rs) rs.classList.remove("hidden");
    setTimeout(() => { const ri2 = $("#rename-input"); if (ri2) ri2.focus(); }, 50);
  });
  // killer-features-backlog 0.7 — тап по аватару контакта открывает выбор
  // локального фото (см. setContactAvatar — никогда не уходит пиру).
  const avatarBtn = $("#contact-avatar");
  const avatarInput = $("#contact-avatar-input");
  if (avatarBtn && avatarInput) {
    avatarBtn.addEventListener("click", () => avatarInput.click());
    avatarInput.addEventListener("change", async () => {
      const file = avatarInput.files && avatarInput.files[0];
      avatarInput.value = "";
      const id = state.contactCardId; if (!file || !id) return;
      try {
        const dataUrl = await readImageAsAvatarDataUrl(file);
        setContactAvatar(id, dataUrl);
      } catch (e) { toast(T("toast.avatarFailed")); }
    });
  }
  const disSel = $("#contact-disappearing-select");
  if (disSel) disSel.addEventListener("change", (e) => {
    const id = state.contactCardId; if (!id) return;
    setDisappearingTimer(id, parseInt(e.target.value, 10) || 0);
  });
  const soundSel = $("#contact-sound-select");
  if (soundSel) soundSel.addEventListener("change", (e) => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    const v = e.target.value;
    if (v) c.notificationSound = v; else delete c.notificationSound; // "" = убрать override, снова использовать общий дефолт
    persistContacts();
  });
  const mute = $("#contact-mute-btn");
  if (mute) mute.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (isContactMuted(c)) {
      // Уже заглушен (постоянно или временно) — тап просто снимает мьют,
      // без шторки. Шторка с длительностью нужна только для ВКЛЮЧЕНИЯ мьюта.
      c.muted = false; c.muteUntil = null; persistContacts(); renderContactCard();
      toast(T("toast.unmuted"));
    } else {
      const sheet = $("#mute-sheet"); if (sheet) sheet.classList.remove("hidden");
    }
  });
  const vibrateOnly = $("#contact-vibrate-only");
  if (vibrateOnly) vibrateOnly.addEventListener("change", (e) => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.vibrateOnly = e.target.checked; persistContacts();
  });
  const pinBtn = $("#contact-pin-btn");
  if (pinBtn) pinBtn.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.pinned = !c.pinned;
    // Новый pinOrder — только когда чат ЗАКРЕПЛЯЕТСЯ (уходит в конец
    // текущего списка закреплённых); при снятии закрепления обнуляем, чтобы
    // повторное закрепление снова уходило в конец, а не возвращалось на
    // старое место (раздел 4 роадмапа — drag-to-reorder).
    if (c.pinned) c.pinOrder = nextPinOrder(); else c.pinOrder = null;
    persistContacts(); renderContactCard();
    try { renderChatsList(); } catch (e) {}
  });
  const archive = $("#contact-archive-btn");
  if (archive) archive.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.archived = !c.archived; persistContacts(); renderContactCard();
    toast(c.archived ? T("toast.archived") : T("toast.unarchived"));
  });
  const block = $("#contact-block-btn");
  if (block) block.addEventListener("click", () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    c.blocked = !c.blocked; persistContacts(); renderContactCard();
    if (c.blocked && !isGroup(c)) { try { clearAutoConnectTimer(c.id); } catch (e) {} try { mesh.remove(c.id); } catch (e) {} } // заблокированному не держим P2P-канал
    toast(c.blocked ? T("toast.blocked") : T("toast.unblocked"));
  });
  const exportBtn = $("#contact-export-btn");
  if (exportBtn) exportBtn.addEventListener("click", () => exportChat(state.contactCardId));
  const forwardContactBtn = $("#contact-forward-btn");
  if (forwardContactBtn) forwardContactBtn.addEventListener("click", () => {
    const fromId = state.contactCardId; if (!fromId) return;
    openForwardSheet((toId) => forwardContact(fromId, toId));
  });
  const safetyBtn = $("#contact-safety-btn");
  if (safetyBtn) safetyBtn.addEventListener("click", () => { const cid = state.contactCardId; if (cid) openSafetySheet(cid); });
  const clear = $("#contact-clear-btn");
  if (clear) clear.addEventListener("click", async () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (!await confirmSheet(T("toast.confirmDeleteChat", { name: c.name }), { destructive: true })) return;
    cleanupExpiredFileBlobs(c.messages);
    c.messages = []; c.lastActivity = Date.now(); persistContacts();
    toast(T("toast.historyCleared"));
  });
  const del = $("#contact-delete-btn");
  if (del) del.addEventListener("click", async () => {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (!await confirmSheet(T("toast.confirmDeleteContact", { name: c.name }), { destructive: true })) return;
    deleteContact(state.contactCardId);
  });
}

