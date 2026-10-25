"use strict";
// Часть 10 из 14 бывшего js/app.js: Сигналинг, relay, онлайн-список, входящие. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Сигналинг
// =====================================================================
function updateSignalingStatusUI(kind, text) {
  const dot = $("#signaling-status-dot"), label = $("#signaling-status-text");
  if (dot) dot.className = "status-dot " + kind;
  if (label) label.textContent = text;
  // Раньше статус связи с сервером был виден только внутри настроек —
  // на главном экране список чатов просто "ждал" без единого намёка на
  // то, что сервер отвалился. Небольшой индикатор в шапке — только когда
  // что-то не так, при "online" скрыт совсем, чтобы не шуметь попусту.
  const nav = $("#nav-conn-indicator");
  if (nav) {
    if (kind === "online") nav.classList.add("hidden");
    else { nav.textContent = text; nav.classList.remove("hidden"); }
  }
}
// При смене языка статусная строка ("в сети"/"офлайн"/...) раньше не
// перерисовывалась — показывала текст на СТАРОМ языке до следующего
// реального события статуса (могло не случиться ещё долго). Здесь же
// просто заново определяем текущее состояние и переводим его текст.
function refreshSignalingStatusText() {
  if (!effectiveSignalingUrl()) { updateSignalingStatusUI("off", "—"); return; }
  if (signaling && signaling.connected) { updateSignalingStatusUI("online", T("status.online")); return; }
  updateSignalingStatusUI("off", T(state._serversDown ? "servers.allDown" : "status.offline"));
}
// Потерян claim-токен (нет резервной копии): id занят «чужим» устройством. Два безопасных выхода: подождать, пока закрепление
// истечёт (сервер освобождает id через CLAIM_TTL_HOURS после последнего появления владельца), либо создать НОВЫЙ случайный id.
// Механизма «уведомить контакты о смене id» в протоколе нет (а старый id принадлежит другому устройству — писать на него нельзя),
// поэтому после смены контактам нужно отправить новый инвайт-код/QR; существующие чаты и история на устройстве сохраняются.
async function offerIdClaimedRecovery(ttlH) {
  if (state._idClaimedDialog) return;
  state._idClaimedDialog = true;
  try {
    const days = Math.max(1, Math.round((Number(ttlH) || 336) / 24));
    const create = await confirmSheet(T("claim.dialog", { days }), { okLabel: T("claim.createNew"), cancelLabel: T("claim.wait", { days }) });
    if (!create) return;
    if (!(await confirmSheet(T("claim.confirmNew"), { destructive: true, okLabel: T("claim.createNew") }))) return;
    regenerateMyId();
  } finally { state._idClaimedDialog = false; }
}
function regenerateMyId() {
  try { discoveryUnpublishBeforeIdChange(); } catch (e) {}
  Store.myIdentityRaw = "";
  Store.myId = crypto.randomUUID();
  try { localStorage.removeItem("ether.idMig"); __idMigRaw = undefined; } catch (e) {} // случайный id: алиасов и миграции больше нет
  try { Ratchet.resetAll(); } catch (e) {} // сессии привязаны к паре id: со старым id они бесполезны
  try { envelopeCache.clear(); } catch (e) {}
  toast(T("claim.newIdDone"));
  initSignaling();
  try { renderTab(); } catch (e) {}
}
// =====================================================================
// Несколько серверов (js/serverlist.js): список, автофейловер, «домашние» серверы контактов, короткие сессии на чужих серверах
// =====================================================================
const SRV_PROBE_INTERVAL_MS = 5 * 60 * 1000, SRV_DRAIN_INTERVAL_MS = 5 * 60 * 1000;
window.__etherActiveUrl = effectiveSignalingUrl; // js/webrtc.js берёт адрес /ice у активного сервера
function srvJson(key, dflt) { try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? dflt : v; } catch (e) { return dflt; } }
function srvSetJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
function srvAllowLocal() { try { return location.hostname === "localhost" || location.hostname === "127.0.0.1"; } catch (e) { return false; } }
function srvDefaults() {
  const d = ServerList.configDefaults(window.__ETHER_CONFIG__);
  return d.length ? d : [{ url: DEFAULT_SIGNALING_URL, label: "Ether", addedAt: 0 }];
}
// Полный список по приоритету: поле «Сервер» (если задано — это единственный путь, как раньше) -> свои -> подписанные -> встроенные.
function serverEntries() {
  let legacy = ""; try { legacy = (Store.signalingUrl || "").trim(); } catch (e) {}
  const defaults = srvDefaults();
  const signed = srvJson(ServerList.KEYS.signed, null);
  const disabled = srvJson(ServerList.KEYS.off, []).concat(legacy ? defaults.map((d) => d.url) : []);
  return ServerList.merge({ legacy: legacy ? { url: legacy, label: legacy.replace(/^[a-z]+:\/\//i, "") } : null, user: ServerList.loadUser(localStorage), signed: legacy ? [] : (signed && Array.isArray(signed.list) ? signed.list : []), defaults, disabled });
}
let __failover = null;
function getFailover() {
  if (!__failover) __failover = ServerList.createFailover({ servers: () => serverEntries(), storage: localStorage, onSwitch: srvOnSwitch });
  return __failover;
}
let __srvProbe = {}, __srvFailStreak = 0;
function srvOnSwitch(to, from, reason) {
  etherLog("warn", "[servers] переключение " + from + " -> " + to + " (" + reason + ")");
  const label = (serverEntries().find((e) => e.url === to) || {}).label || to;
  setTimeout(() => {
    if (reason === "slow" && state.callId) return; // во время звонка соединение не трогаем
    try { toast(T("servers.switched", { name: label })); } catch (e) {}
    initSignaling();
    setTimeout(() => { srvDrainSecondary(true).catch(() => {}); }, 4000);
  }, 0);
}
// Мои «домашние» серверы для приглашений (≤3, https/wss, без путей); пусто, если пользователь на единственном встроенном или отключил рассылку.
function srvMyHints() {
  try {
    if (localStorage.getItem(ServerList.KEYS.share) === "0") return [];
    return ServerList.ownHints(serverEntries(), effectiveSignalingUrl(), srvDefaults(), { allowLocal: srvAllowLocal() });
  } catch (e) { return []; }
}
function srvHintsWire() { return ServerList.encodeHints(srvMyHints()); }
function srvLearn(contactId, urls) {
  const c = state.contacts.get(contactId); if (!c) return;
  const n = ServerList.normalizeHints(urls, { allowLocal: srvAllowLocal() }); if (!n.length) return;
  if (JSON.stringify(c.servers || []) !== JSON.stringify(n)) { c.servers = n; persistContacts(); }
}
// Серверы получателя, отличные от активного, куда стоит доставить конверт сами
function srvRemoteTargets(contact) {
  if (!contact || !Array.isArray(contact.servers) || !contact.servers.length) return [];
  const active = effectiveSignalingUrl();
  return contact.servers.filter((u) => !ServerList.sameServer(u, active)).slice(0, 3);
}
function srvOutboxHasRemote() {
  for (const e of outbox.values()) { const c = state.contacts.get(e.to); if (c && srvRemoteTargets(c).length) return true; }
  return false;
}
// Короткая зарегистрированная сессия на другом сервере. onDeliver подключается до старта, чтобы не потерять конверты из ящика.
function srvOpenSession(url, onDeliver) {
  return new Promise((resolve, reject) => {
    let s = null, done = false;
    const fin = (err) => { if (done) return; done = true; clearTimeout(t); if (err) { try { s.stop(); } catch (e) {} reject(err); } else resolve(s); };
    const t = setTimeout(() => fin(new Error("timeout")), 9000);
    claimProof().catch(() => "").then((proof) => {
      if (done) return;
      s = new SignalingClient(url, Store.myId, { name: Store.name, visible: false, publicKey: Store.myPublicKeyJwk });
      s.claim = proof || undefined;
      if (onDeliver) s.addEventListener("deliver", (ev) => onDeliver(ev.detail, s));
      s.addEventListener("registered", () => fin(null));
      s.addEventListener("register-error", () => fin(new Error("register-error")));
      s.addEventListener("connect-failed", () => fin(new Error("connect-failed")));
      s.start();
    });
  });
}
// Доставка уже зашифрованного конверта на серверы получателя по порядку; возвращает url, принявший конверт, или "".
async function srvRemoteDeliver(urls, to, msgId, envelope, kind) {
  for (const url of urls) {
    let s = null;
    try {
      s = await srvOpenSession(url);
      const ok = await new Promise((res) => {
        const t = setTimeout(() => res(false), 8000);
        s.addEventListener("deliver-ack", (ev) => { if (ev.detail.msgId === msgId) { clearTimeout(t); res(!ev.detail.error); } });
        if (!s.deliver(to, msgId, envelope, Store.myPublicKeyJwk, kind)) { clearTimeout(t); res(false); }
      });
      if (ok) return url;
    } catch (e) { etherLog("info", "[servers] доставка через " + url + " не удалась: " + String(e && e.message || e)); }
    finally { if (s) { try { s.stop(); } catch (e) {} } }
  }
  return "";
}
// Забрать ящики своих запасных серверов (тех, что рекламируются в srv), кроме активного
let __drainBusy = false;
async function srvDrainSecondary(force) {
  if (__drainBusy || !Store.myId || !Store.myPublicKeyJwk) return 0;
  if (document.hidden && !force) return 0;
  try { if (typeof Devices !== "undefined" && Devices.isCompanion()) return 0; } catch (e) {}
  const active = effectiveSignalingUrl();
  const urls = srvMyHints().filter((u) => !ServerList.sameServer(u, active)).slice(0, 2);
  if (!urls.length) return 0;
  __drainBusy = true; let got = 0;
  try {
    for (const url of urls) {
      const pending = []; let last = Date.now(), s = null;
      try {
        s = await srvOpenSession(url, (detail, sess) => { got++; last = Date.now(); pending.push(handleDeliver(Object.assign({}, detail, { ackVia: sess }), false).catch(() => {})); });
        const t0 = Date.now();
        while (Date.now() - last < 1200 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 200));
        await Promise.all(pending);
      } catch (e) { etherLog("info", "[servers] ящик " + url + " недоступен: " + String(e && e.message || e)); }
      finally { if (s) { try { s.stop(); } catch (e) {} } }
    }
  } finally { __drainBusy = false; }
  return got;
}
async function srvProbeAll(opts) {
  const entries = serverEntries();
  const res = await ServerList.probeAll(entries.map((e) => e.url), { fetch: window.fetch.bind(window), timeoutMs: 6000 });
  __srvProbe = Object.assign({}, res, { __at: Date.now() });
  if (!(opts && opts.noSwitch) && !state.callId && entries.length > 1) getFailover().reportProbes(res);
  try { if (typeof srvRenderSheet === "function") srvRenderSheet(); } catch (e) {}
  return res;
}
// Подписанный список из корня приложения (servers.json): применяется сам только при успешной проверке подписи и ts не старее сохранённого
async function srvRefreshSigned(urlOverride, opts) {
  const o = opts || {};
  let obj = o.obj;
  if (!obj) {
    const r = await fetch(urlOverride || ("servers.json?t=" + Date.now()), { cache: "no-store" }); // «?t=» обходит кэш service worker
    if (!r.ok) throw new Error("http-" + r.status);
    obj = await r.json();
  }
  const v = await ServerList.verifySigned(obj, window.RELEASE_PUBKEY);
  if (v.ok && o.apply !== false) {
    const cur = srvJson(ServerList.KEYS.signed, null);
    if (!cur || !(cur.ts > v.parsed.ts)) srvSetJson(ServerList.KEYS.signed, { ts: v.parsed.ts, list: v.parsed.servers });
  }
  return v;
}
let __srvTimersOn = false;
function startServerLoops() {
  if (__srvTimersOn) return; __srvTimersOn = true;
  setTimeout(() => { if (serverEntries().length > 1) srvProbeAll().catch(() => {}); srvRefreshSigned().catch(() => {}); }, 6000);
  setInterval(() => { if (!document.hidden && serverEntries().length > 1) srvProbeAll().catch(() => {}); }, SRV_PROBE_INTERVAL_MS);
  setTimeout(() => { srvDrainSecondary(true).catch(() => {}); }, 5000);
  setInterval(() => { srvDrainSecondary(false).catch(() => {}); }, SRV_DRAIN_INTERVAL_MS);
}
// Фейловер для боевого клиента: подключение не удалось / сервер отклонил регистрацию -> счётчик; успешная регистрация -> сброс
function wireServerFailover(sig) {
  const fo = getFailover(), subs = [];
  const on = (type, fn) => { const w = (ev) => { try { fn(ev); } catch (e) { etherLog("error", "[servers:" + type + "]", String(e)); } }; sig.addEventListener(type, w); subs.push([type, w]); };
  on("connect-failed", () => {
    __srvFailStreak++;
    const r = fo.reportFailure(sig.url);
    if (!r.switched && __srvFailStreak >= 3) srvShowDown();
  });
  on("registered", (ev) => {
    __srvFailStreak = 0; state._serversDown = false;
    fo.reportSuccess(sig.url, sig.connectMs);
    const seen = srvJson(ServerList.KEYS.seen, []);
    if (!seen.includes(sig.url)) {
      seen.push(sig.url); srvSetJson(ServerList.KEYS.seen, seen.slice(-20));
      if (seen.length > 1) { try { toast(T("servers.firstClaim")); } catch (e) {} } // на новом сервере наш id закрепляется впервые
    }
  });
  on("register-error", (ev) => {
    if (ev.detail && ev.detail.error === "id-claimed" && serverEntries().length > 1) {
      for (let i = 0; i < 3; i++) if (fo.reportFailure(sig.url).switched) break;
    }
  });
  return () => { for (const [t, w] of subs) sig.removeEventListener(t, w); };
}
function srvShowDown() {
  state._serversDown = true;
  try { updateSignalingStatusUI("off", T("servers.allDown")); } catch (e) {}
}
// Режим без сервера: вкладка «Связь» с ручным подключением по коду/QR
function srvOpenOfflineMode() {
  const sh = $("#servers-sheet"); if (sh) sh.classList.add("hidden");
  state.tab = "connect"; state.chatId = null; renderTab();
  setTimeout(() => { const sec = $("#manual-section"), b = $("#toggle-manual-btn"); if (sec && b && sec.classList.contains("hidden")) b.click(); }, 60);
}
let __lastReclaimAt = 0;
let __replacedHits = [];
function reclaimSignaling() {
  if (Date.now() - __lastReclaimAt < 4000) return; // два окна рядом не должны бесконечно отбирать соединение друг у друга
  __lastReclaimAt = Date.now();
  state._replaced = false;
  etherLog("info", "[signaling] забираю соединение в этом окне");
  initSignaling();
}
function initSignaling() {
  const url = effectiveSignalingUrl();
  if (signalingCleanup) { try { signalingCleanup(); } catch (e) {} signalingCleanup = null; }
  if (signaling) { signaling.stop(); signaling = null; }
  onlineSet.clear(); onlineRoster.clear();
  for (const c of state.contacts.values()) c.online = false;
  if (!url) { updateSignalingStatusUI("off", "—"); renderChatsList(); renderOnlineRosterList(); return; }
  updateSignalingStatusUI("connecting", "…");
  try { syncRingConfigToSW(); } catch (e) {} // адрес сервера для push-ack мог смениться
  etherLog("info", "[signaling] connecting to " + url);
  const sig = signaling = new SignalingClient(url, Store.myId, { name: Store.name, visible: Store.discoverable, publicKey: Store.myPublicKeyJwk });
  sig.watchIds = watchedContactIds;
  idMigWireSignaling(sig); // миграция id v1 -> v2: алиас старого id и запуск миграции после регистрации
  if (typeof Devices !== "undefined") Devices.wireSignaling(sig); // companion-режим и публикация списка устройств (js/devices.js)
  { const c1 = wireSignalingEvents(sig), c2 = wireServerFailover(sig); signalingCleanup = () => { c1(); c2(); }; }
  sig.addEventListener("slow-connect", () => { if (!sig.connected) updateSignalingStatusUI("connecting", T("status.waking")); });
  // Доказательство владения id (claim) считается асинхронно (SHA-256); результат кешируется, поэтому повторные подключения стартуют синхронно.
  const cached = claimProofCached();
  if (cached !== null) { sig.claim = cached || undefined; sig.start(); }
  else claimProof().then((p) => p, () => "").then((p) => { if (signaling !== sig) return; sig.claim = p || undefined; sig.start(); });
}
let __claimProofCache = null, __claimProofFor = "";
function claimProofCached() { const t = Store.claimToken; if (!t) return ""; return __claimProofFor === t ? __claimProofCache : null; }
async function claimProof() {
  const t = Store.claimToken; if (!t) return "";
  if (__claimProofFor === t && __claimProofCache) return __claimProofCache;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ether-claim-v1|" + t)));
  __claimProofCache = Array.from(d, (x) => x.toString(16).padStart(2, "0")).join(""); __claimProofFor = t;
  return __claimProofCache;
}
// Общая обработка входящего offer/answer — используется и для сигнального
// сервера, и для релея через общий контакт (см. ниже): сама логика
// WebRTC-рукопожатия не должна знать и не знает, через какой транспорт
// пришёл пакет.
// Звонок от заблокированного: у нас — полная тишина (ни звонка, ни уведомления, ни записи в журнале, P2P не поднимаем, чтобы не
// раскрыть IP), а звонящему через 20–30 с приходит обычный «отклонён» — как при ручном отбое. Мгновенный ответ или «занят»
// выдавал бы блокировку; полное молчание оставляло бы его в бесконечном «вызов…» с повторными попытками.
const blockedCallDecline = new Map(); // id -> время, до которого повторные приглашения не плодят новые таймеры
function scheduleBlockedCallDecline(from, sig) {
  const until = blockedCallDecline.get(from);
  if (until && Date.now() < until) return;
  const delay = 20000 + Math.floor(Math.random() * 10000);
  blockedCallDecline.set(from, Date.now() + delay + 60000);
  setTimeout(() => { try { const c = state.contacts.get(from); if (c && c.blocked && sig) sig.signal(from, { t: "call-declined" }); } catch (e) {} }, delay);
}
async function handleIncomingOffer(from, packet, replySignal) {
  if (recentlyDeletedIds.has(from)) return;
  // Заблокированный собеседник не должен устанавливать P2P-соединение.
  // Сообщения от него отсекаются в mesh-обработчике (if (c.blocked) return),
  // но сам линк уже создаётся, тратит ICE, виден в диагностике как
  // "connected", приглашает к дальнейшим пересогласованиям.
  const blockedContact = state.contacts.get(from);
  if (blockedContact && blockedContact.blocked) return;
  clearUnreachable(from);
  const existing = mesh.get(from);
  // Любой живой линк (offerer или answerer, connected или in-call) —
  // игнорируем встречный offer. Раньше проверялась только пара
  // "answerer + connected": если мы были offerer'ом и уже connected,
  // повторный offer убивал рабочее соединение. Проявляется как раз
  // при renegotiation (оба одновременно увидели negotiationneeded).
  if (existing && (existing.status === "connected" || existing.status === "in-call")) {
    etherLog("info", "[offer] " + String(from).slice(0, 10) + "…", "уже live, игнорирую повторный offer");
    return;
  }
  // Оба конца могут одновременно слать offer (звонок с force). Тай-брейк как в attemptConnect: offerer — тот, у кого id меньше.
  // Если мы — этот offerer и наш линк ещё подключается, встречный offer игнорируем: собеседник примет наш и ответит.
  if (existing && existing.role === "offerer" && existing.status === "connecting" && myIdFor(from) < from && Date.now() - (existing._createdAt || 0) < CONNECT_STUCK_MS) {
    etherLog("info", "[offer] " + String(from).slice(0, 10) + "…", "встречный offer: я offerer по тай-брейку, игнорирую");
    return;
  }
  if (existing) mesh.remove(from);
  ensureContactEntry(from, typeof packet.n === "string" ? packet.n.slice(0, 40) : null);
  if (packet.rl) markRelayOnly(from); // собеседник обнаружил, что UDP «глухой» — отвечаем тоже только через TURN
  const link = mesh.createIncomingLink(from);
  flushPendingIceFor(from, link);
  try {
    const answer = await link.acceptOfferAndCreateAnswer(packet);
    if (!answer) return;
    replySignal(answer);
  } catch (e) {
    etherLog("error", "[offer] FAILED:", String(e && e.message || e));
    mesh.remove(from);
  }
}
async function handleIncomingAnswer(from, packet) {
  const link = mesh.get(from);
  if (link) {
    try { await link.acceptAnswer(packet); }
    catch (e) { mesh.remove(from); }
  }
}

// Сервер принял конверт (deliver-ack или доставка на сервер получателя): отметить serverAcked и убрать из очереди.
// Для групповых сообщений entry.to — id участника, а не группы, сообщение лежит в списке ГРУППЫ под contentId — резолвим так же, как markMessageAck.
function outboxMarkServerAcked(msgId, entry) {
  const groupId = entry.payload && entry.payload.groupId;
  const contentId = entry.payload && entry.payload.id;
  if (groupId && contentId) {
    const g = state.contacts.get(groupId);
    const m = g && g.messages.find((x) => x.id === contentId && x.from === "me");
    if (m) { m.serverAcked = true; persistContacts(); }
  } else {
    const c = state.contacts.get(entry.to);
    if (c) {
      const m = c.messages.find((x) => x.id === msgId && x.from === "me");
      if (m) { m.serverAcked = true; persistContacts(); }
    }
  }
  outbox.delete(msgId);
  persistOutbox();
}
function wireSignalingEvents(sig) {
  const on = (type, fn) => {
    const wrapped = (ev) => {
      try { fn(ev); }
      catch (e) { etherLog("error", "[signaling:" + type + "]", String(e && e.stack || e)); }
    };
    sig.addEventListener(type, wrapped);
    return { type, wrapped };
  };
  const subs = [];

  subs.push(on("connected", () => {
    updateSignalingStatusUI("online", T("status.online"));
    if (sig.guest) return; // гость link-call: не регистрируется — ни ростера, ни push, ни очереди
    for (const [id, link] of Array.from(mesh.links)) {
      if (link.status === "disconnected" && link._closed !== true) {
        etherLog("info", "[reconnect] dropping dead link to " + String(id).slice(0, 10) + "…");
        mesh.remove(id);
      }
    }
    for (const id of Array.from(onlineSet)) scheduleAutoConnect(id);
    flushOutbox();
    for (const cid of Array.from(pendingNoKey.keys())) {
      const c = state.contacts.get(cid);
      if (c && c.publicKey) flushPendingNoKey(cid);
    }
    // ПЕРЕОТПРАВЛЯЕМ подписку при каждом переподключении к серверу.
    // Раньше подписка отправлялась только при первом subscribe — а сервер
    // на Render хранит её в файле, который теряется при каждом рестарте
    // инстанса (бесплатный тариф — перезапуск после 15 минут простоя и
    // при каждом деплое). После первого же перезапуска push переставал
    // работать вообще, потому что сервер просто не знал о подписке.
    // Явное пересоздание подписки гарантирует, что она всегда актуальна.
    try {
      if (Store.pushSubscriptionJson) {
        const sub = JSON.parse(Store.pushSubscriptionJson);
        sig.sendPushSubscription(sub);
      }
    } catch (e) {}
    // Полное пересоздание подписки (getSubscription → subscribe) — не
    // только переиспользование сохранённого JSON. Это лечит случаи, когда
    // сохранённый JSON устарел или сама подписка на стороне браузера
    // истекла.
    setTimeout(() => { ensurePushSubscription().catch(() => {}); }, 500);

    // Периодическая переотправка push-подписки — обход той же эфемерной
    // ФС Render (free tier теряет .ether-push-subs.json при каждом
    // рестарте инстанса, в т.ч. простое 15 минут). Переотправка выше
    // срабатывает только при "connected" (новое WS-соединение) — но
    // если телефон не закрывал приложение и WS не переподключался,
    // а сервер за это время перезапустился, клиент никогда не узнает,
    // что сервер "забыл" подписку. Раз в час подчищаем и это. Таймер
    // ставим один раз на весь жизненный цикл страницы — обработчик
    // "connected" может сработать многократно за сессию.
    if (!window.__etherPushResendTimer) {
      window.__etherPushResendTimer = setInterval(() => {
        if (signaling && signaling.connected && Store.pushSubscriptionJson) {
          try {
            const sub = JSON.parse(Store.pushSubscriptionJson);
            signaling.sendPushSubscription(sub);
          } catch (e) {}
        }
      }, 60 * 60 * 1000);
    }
  }));
  subs.push(on("register-error", (ev) => {
    // id закреплён за другим устройством (claim): соединение остановлено клиентом, повторные попытки бессмысленны до истечения claim
    if (ev.detail && ev.detail.error === "id-claimed") {
      updateSignalingStatusUI("off", T("status.idClaimed"));
      toast(T("toast.idClaimed"));
      offerIdClaimedRecovery(ev.detail.claimTtlH).catch(() => {});
    }
  }));
  subs.push(on("discovery-state", () => {
    refreshDiscoveryUI();
    if (window.__etherDiscoveryAfterStart) { // кнопка «Найти по телефону/почте» на экране онбординга: открываем поиск, когда сервер ответил
      window.__etherDiscoveryAfterStart = false;
      if (discoverySupported()) openDiscoverySheet(); else toast(T("discovery.needServer"));
    }
    syncDiscoveryPublish();
  }));
  subs.push(on("discovery-published", (ev) => {
    const d = ev.detail || {};
    if (d.ok) { if (state._discoveryToast) { toast(T(d.count > 0 ? "discovery.published" : "discovery.unpublished")); state._discoveryToast = false; } }
    else if (d.error && d.error !== "rate") { toast(T("discovery.publishFailed", { error: d.error })); state._discoveryToast = false; }
  }));
  subs.push(on("register-rate-limited", () => {
    updateSignalingStatusUI("off", T("status.rateLimited"));
    toast(T("toast.registerRateLimited"));
  }));
  subs.push(on("disconnected", () => {
    updateSignalingStatusUI("off", T(state._serversDown ? "servers.allDown" : "status.offline"));
    for (const c of state.contacts.values()) if (c.managed) {
      if (c.online) { state.lastSeen[c.id] = Date.now(); persistLastSeen(); }
      c.online = false;
    }
    onlineSet.clear();
    onlineRoster.clear();
    relayAttemptCooldown.clear(); // после реконнекта старый "недавно не получилось через релей" неактуален
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  }));
  try { channelsWire(sig, on, subs); } catch (e) { etherLog("warn", "[channels] wire:", String(e)); }
  subs.push(on("call-ringing", (ev) => { callRingingFromServer(ev.detail); })); // V.79 (протокол C): push доставлен, у собеседника звонит
  subs.push(on("linkcall-signal", (ev) => { linkCallOnSignal(sig, ev.detail); })); // V.79 (протокол E): сигналы link-call проходят через шлюз
  for (const lt of ["linkcall-created", "linkcall-joined", "linkcall-error", "linkcall-guest", "linkcall-end", "linkcall-allowed", "linkcall-denied"]) subs.push(on(lt, (ev) => { linkCallOnServer(sig, lt, ev.detail); }));
  subs.push(on("disconnected", () => { try { linkCallOnDisconnected(sig); } catch (e) {} }));
  subs.push(on("unreachable", (ev) => {
    const { to } = ev.detail;
    if (!to) return;
    // Сервер явно сказал: получатель не зарегистрирован. Линк, который
    // мы пытались поднять, точно мёртв — закрываем СРАЗУ, не ждём
    // WATCH_CONNECT_TIMEOUT_MS (20 секунд, все они — мусор в логе и
    // в диагностике). Раньше это событие dispatch'илось, но никто его
    // не слушал.
    const link = mesh.get(to);
    if (link && link.status === "connecting") {
      etherLog("info", "[connect] " + String(to).slice(0, 10) + "…", "unreachable → закрываю линк");
      mesh.remove(to);
    }
    // Прогрессивный cooldown: 60с → 5мин → 30мин при повторных отказах.
    markUnreachable(to);
  }));
  subs.push(on("replaced", () => {
    // Тот же идентификатор открыт в другом окне/вкладке (часто — забытая старая вкладка). Сервер оставляет только одно соединение,
    // и «лишнее» окно раньше навсегда оставалось офлайн. Теперь оно ждёт: как только вы вернётесь в это окно (или нажмёте
    // индикатор «офлайн»), оно заберёт соединение себе — побеждает окно, которым пользуются сейчас.
    state._replaced = true;
    updateSignalingStatusUI("off", T("status.replaced"));
    // Выбросить могло и «призрачное» соединение (старый сокет после перезагрузки страницы, переключения сети). Поэтому, если окно
    // на виду, забираем соединение обратно сами через пару секунд; если за минуту выбрасывало трижды — это настоящее второе окно,
    // и ждём действия пользователя (фокус или нажатие на индикатор), чтобы два окна не отнимали соединение друг у друга бесконечно.
    const now = Date.now();
    __replacedHits = __replacedHits.filter((t) => now - t < 60000); __replacedHits.push(now);
    if (__replacedHits.length < 3) {
      setTimeout(() => { if (state._replaced && !document.hidden) reclaimSignaling(); }, 1500 + Math.random() * 1500);
    } else {
      toast(T("status.replaced"));
    }
  }));
  subs.push(on("vapid-key", (ev) => {
    const { key } = ev.detail;
    if (key) { Store.vapidPublicKey = key; ensurePushSubscription().catch(() => {}); }
  }));
  subs.push(on("push-subscribed", () => { state._pushServerOk = Date.now(); etherLog("info", "[push] server confirmed subscription"); }));
  subs.push(on("online-list", () => { maybeUploadPrekeys(false); }));
  subs.push(on("prekey-low", () => { maybeUploadPrekeys(true); }));
  subs.push(on("online-list", (ev) => {
    for (const u of ev.detail.users) {
      onlineSet.add(u.id);
      onlineRoster.set(u.id, { name: typeof u.name === "string" ? u.name.slice(0, 40) : u.name, visible: u.visible !== false, publicKey: u.publicKey || null });
      const c = state.contacts.get(u.id);
      if (c && c.managed) {
        c.online = true;
        if (Array.isArray(u.caps) && u.caps.includes("env2")) markContactEnv2(c);
        if (Array.isArray(u.caps) && u.caps.includes("sk1")) markContactSk(c);
        if (u.publicKey && keysDiffer(u.publicKey, c.publicKey)) { if (noteContactKey(c, u.publicKey)) { persistContacts(); flushPendingNoKey(u.id); } }
        scheduleAutoConnect(u.id);
      }
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
  }));
  subs.push(on("presence", (ev) => {
    const { id, online, name, visible, publicKey, caps } = ev.detail;
    if (online && Array.isArray(caps) && caps.includes("env2")) { const cc = state.contacts.get(id); if (cc && cc.managed) markContactEnv2(cc); }
    if (online && Array.isArray(caps) && caps.includes("sk1")) { const cs = state.contacts.get(id); if (cs && cs.managed) markContactSk(cs); }
    if (online) {
      onlineSet.add(id);
      onlineRoster.set(id, { name, visible: visible !== false, publicKey: publicKey || null });
      clearUnreachable(id); // target снова онлайн — сбрасываем backoff
    }
    else { onlineSet.delete(id); onlineRoster.delete(id); state.lastSeen[id] = Date.now(); persistLastSeen(); }
    const c = state.contacts.get(id);
    if (c && c.managed) {
      c.online = online;
      if (online && publicKey && keysDiffer(publicKey, c.publicKey)) { if (noteContactKey(c, publicKey)) { persistContacts(); flushPendingNoKey(id); } }
      if (online) scheduleAutoConnect(id); else clearAutoConnectTimer(id);
      if (state.chatId === id) renderChatThread();
      if (state.contactCardId === id) renderContactCard();
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") { renderContactsList(); renderOnlineRosterList(); }
  }));
  subs.push(on("signal", async (ev) => {
    const from = canonPeer(ev.detail.from), packet = ev.detail.data;
    if (!packet || !packet.t) return;
    etherLog("info", "[signal] from " + String(from).slice(0, 10) + "…", "t=" + packet.t);

    if (packet.t === "call-invite") {
      if (isDuplicateSignal(from, packet)) return;
      // Раньше тут стояла защита "игнорирую повторный call-invite после
      // недавнего отбоя" — она ошибочно блокировала и осознанные новые
      // звонки от того же человека в течение 15 секунд после отбоя
      // (пользователь нажимал "Позвонить снова" — звонок молча не
      // шёл). Авто-генерируемые call-state:ringing теперь фильтруются
      // ТОЛЬКО в mesh-обработчике по data channel (там же им и место),
      // а call-invite через сервер — это всегда явное действие
      // собеседника, его фильтровать нельзя.
      // Сообщения от заблокированных уже фильтруются (и в mesh-обработчике,
      // и в deliver), а сигнал входящего звонка — нет. Заблокировав
      // человека, пользователь продолжал бы получать от него звонки.
      const existingBlocked = state.contacts.get(from);
      if (existingBlocked && existingBlocked.blocked) { scheduleBlockedCallDecline(from, sig); return; }
      ensureContactEntry(from, typeof packet.n === "string" ? packet.n.slice(0, 40) : null);
      if ((state.callId && state.callId !== from) || (typeof gcallBusy === "function" && gcallBusy())) {
        const busySent = sig.signal(from, { t: "call-busy" });
        if (!busySent) etherLog("warn", "[call] не удалось отправить call-busy (сигналинг недоступен)");
        return;
      }
      if (callGlareYields(from)) yieldCallGlare(from, false);
      if (state.callId === from) {
        const ackSent = sig.signal(from, { t: "call-invite-ack" });
        if (!ackSent) etherLog("warn", "[call] повторный call-invite — не удалось подтвердить (сигналинг недоступен)");
        return;
      }
      openCallScreen(from, "ringing");
      try { ensureAudioCtx(); } catch (e) {}
      playRingtone();
      try { answerScreenOnInvite(from); } catch (e) { etherLog("warn", "[answer] " + String(e)); }
      const c = state.contacts.get(from);
      if (c && !isContactMuted(c) && Store.notificationsEnabled) {
        // Раньше тут был force: true — уведомление показывалось, даже когда
        // приложение активно. В этом случае звонок уже отрисован на экране
        // (openCallScreen выше), рингтон и вибрация играют (playRingtone
        // выше) — системный баннер только дублировал видимое. Убрали force:
        // showNotification() сам проверит document.visibilityState.
        showNotification(T("call.incoming"), packet.n || "", { tag: "ether-call-" + from, contactId: from, kind: "call" });
      }
      // Раньше ошибка молча проглатывалась. На практике сигналинг
      // почти наверняка жив (иначе call-invite не дошёл бы до нас),
      // но если он отвалился в промежутке — звонящий не узнает, что
      // его вызов дошёл. Логируем для диагностики: при разборе багов
      // будет видно, почему звонящий висит в "Вызов…" до таймаута.
      const ackSent = sig.signal(from, { t: "call-invite-ack" });
      if (!ackSent) {
        etherLog("warn", "[call] " + String(from).slice(0, 10) + "…",
          "call-invite-ack не отправлен (сигналинг недоступен) — звонящий узнает о дозвоне только после установки P2P");
      }
      return;
    }
    if (packet.t === "call-busy") {
      if (state.callId === from) {
        stopRingtone();
        toast(T("toast.peerBusy"));
        closeCallScreen("busy");
      }
      return;
    }
    if (packet.t === "call-invite-ack") {
      if (state.callId === from && state.callPhase === "calling") {
        const p = $("#call-phase"); if (p) p.textContent = T("call.ringing");
      }
      return;
    }
    if (packet.t === "call-accepted") {
      if (state.callId === from) { stopRingtone(); setCallPhaseActive(); }
      return;
    }
    if (packet.t === "call-declined") {
      if (state.callId === from) {
        stopRingtone();
        try { const l = mesh.get(from); if (l) l.endCall(); } catch (e) {}
        closeCallScreen("declined");
      }
      return;
    }
    if (packet.t === "call-ended") {
      if (state.callId === from) {
        stopRingtone();
        try { const l = mesh.get(from); if (l) l.endCall(); } catch (e) {}
        closeCallScreen("completed");
      }
      return;
    }
    if (packet.t === "offer") {
      await handleIncomingOffer(from, packet, (answer) => sig.signal(from, answer));
    } else if (packet.t === "answer") {
      await handleIncomingAnswer(from, packet);
    } else if (packet.t === "ice") {
      // Trickle ICE: кандидат от собеседника. Если link уже создан —
      // отдаём напрямую, он сам разберётся (буферизует, если
      // remoteDescription ещё не установлен). Если link'а ещё нет
      // (offer/answer в пути) — копим глобально, разберём в
      // handleIncomingOffer/attemptConnect через flushPendingIceFor.
      // recentlyDeletedIds — та же защита, что в handleIncomingOffer:
      // удалённый контакт, который продолжает слать ICE-кандидаты
      // (например, не узнал об удалении и ретраит переподключение),
      // не должен копить их здесь — без link'а эти кандидаты никогда
      // никому не передадутся, просто занимают память до следующего
      // удаления или до перезагрузки.
      if (packet.candidate && !recentlyDeletedIds.has(from)) {
        const link = mesh.get(from);
        if (link) {
          link.addIceCandidate(packet.candidate).catch(() => {});
        } else {
          if (!pendingIceCandidates.has(from)) pendingIceCandidates.set(from, []);
          const buf = pendingIceCandidates.get(from);
          buf.push(packet.candidate);
          if (buf.length > 200) buf.shift();
        }
      }
      return;
    }
  }));
  subs.push(on("deliver-ack", (ev) => {
    const { msgId, error } = ev.detail;
    const entry = outbox.get(msgId);
    if (!entry) return;
    if (error) {
      // Сервер отклонил конверт (например, не понимает формат v2). Раньше это считалось успешным подтверждением — сообщение терялось молча.
      etherLog("warn", "[mailbox] сервер отклонил конверт " + String(msgId).slice(0, 8) + "…: " + error + " — повторю прежним форматом");
      entry.forceV1 = true; envelopeCache.delete(msgId);
      markMessageAck(entry.to, msgId, "failed");
      return;
    }
    if (entry.needRemote && !entry.remoteAcked) return; // получатель живёт на других серверах: запись остаётся, пока их сервер не примет конверт
    outboxMarkServerAcked(msgId, entry);
  }));
subs.push(on("deliver", (ev) => handleDeliver(ev.detail, false)));
  return () => { for (const s of subs) sig.removeEventListener(s.type, s.wrapped); };
}
// ---- Аутентификация P2P-канала (js/linkauth.js) ----
// После открытия канала стороны обмениваются нонсами и тегами, привязанными к DTLS-отпечаткам и общему секрету личностей.
// Пока идёт проверка, канал "закрыт на шлюз" (PeerLink.authGate): исходящее отклоняется, входящее копится и разбирается после успеха.
const AUTH_PASS = new Set(["auth", "ping", "pong", "sdp", "call-state"]);
const AUTH_TIMEOUT_MS = 6000;
const authToastAt = new Map();
function startLinkAuth(id) {
  const link = mesh.get(id), c = state.contacts.get(id);
  if (!link || link._authStarted) return;
  if (!link.dc || link.dc.readyState !== "open") return; // статус connected приходит раньше открытия канала данных — стартуем по dc-open
  if (!c || isGroup(c) || !c.publicKey || !Store.myPrivateKeyJwk || typeof LinkAuth === "undefined") {
    // Защита от даунгрейда: если с этим контактом проверка уже проходила, отсутствие ключа/модуля не должно открывать канал
    if (c && c.authSeen && !isGroup(c)) { link.authState = "fail"; link.authGate = "closed"; link._authBuf = []; authDowngradeNotice(id, "downgrade"); try { mesh.remove(id); } catch (e) {} return; }
    link.authGate = null; return;
  }
  link._authStarted = true; link.authGate = "pending"; link.authState = "pending";
  link._authBuf = []; link._myNonce = LinkAuth.nonce(); link._peerNonce = null; link._peerTag = null; link._tagSent = false;
  link.send({ kind: "auth", s: 1, n: link._myNonce });
  clearTimeout(link._authTimer);
  link._authTimer = setTimeout(() => authTimeout(id, link), AUTH_TIMEOUT_MS);
}
function reauthLink(id) {
  const link = mesh.get(id); if (!link || !(link.status === "connected" || link.status === "in-call")) return;
  link._authStarted = false; startLinkAuth(id);
}
async function onAuthMessage(id, link, p) {
  // Собеседник начал проверку заново (после подтверждения нашего нового ключа): повторяем и мы, иначе его запрос игнорировался бы,
  // а он по таймауту счёл бы канал непроверенным и разорвал соединение
  if (p.s === 1 && link._authStarted && link.authGate && link.authGate !== "pending" && typeof p.n === "string" && p.n !== link._peerNonce) { link._authStarted = false; startLinkAuth(id); }
  if (!link._authStarted) startLinkAuth(id);
  if (!link._authStarted || link.authGate !== "pending") return;
  if (p.s === 1 && typeof p.n === "string" && p.n.length <= 64 && !link._peerNonce) link._peerNonce = p.n;
  else if (p.s === 2 && typeof p.t === "string" && p.t.length <= 128 && !link._peerTag) link._peerTag = p.t;
  else return;
  try { await progressAuth(id, link); } catch (e) { etherLog("warn", "[auth] ошибка проверки:", String(e)); }
}
async function progressAuth(id, link) {
  const c = state.contacts.get(id);
  if (!c || link.authGate !== "pending" || !link._peerNonce) return;
  if (authLinkStale(id, link)) return;
  const fp = link.fingerprints();
  if (!fp.local || !fp.remote) { etherLog("warn", "[auth] нет отпечатков DTLS в SDP — проверка невозможна"); finishAuth(id, link, "unverified"); return; } // для контакта с authSeen finishAuth превратит это в «fail» (даунгрейд)
  const myIdA = myIdFor(id);
  const key = await LinkAuth.secret(Store.myPrivateKeyJwk, c.publicKey, myIdA, id);
  if (!link._tagSent) {
    link._tagSent = true;
    link.send({ kind: "auth", s: 2, t: await LinkAuth.tag(key, myIdA, id, link._myNonce, link._peerNonce, fp.local, fp.remote) });
  }
  if (link._peerTag) {
    const ok = await LinkAuth.verify(key, link._peerTag, id, myIdA, link._peerNonce, link._myNonce, fp.local, fp.remote);
    finishAuth(id, link, ok ? "ok" : "fail");
  }
}
// Линк уже заменён/снят с mesh: его таймеры и проверка не должны трогать новый, исправный канал с тем же контактом
function authLinkStale(id, link) {
  let cur; try { cur = mesh.get(id); } catch (e) { return false; }
  if (cur === link) return false;
  clearTimeout(link._authTimer); link._authBuf = [];
  if (link.authGate === "pending") link.authGate = "closed";
  return true;
}
function authTimeout(id, link) {
  if (link.authGate !== "pending") return;
  if (authLinkStale(id, link)) return;
  const c = state.contacts.get(id);
  // Раньше этот собеседник проходил проверку, а теперь молчит — похоже на отключение проверки "по дороге", не пускаем
  finishAuth(id, link, c && c.authSeen ? "fail" : "unverified", "downgrade");
}
// Системное сообщение в чате + тост о том, что проверка подлинности канала не пройдена (reason: "downgrade" — раньше проходила, а теперь
// собеседник молчит/не отвечает/без отпечатков; "mismatch" — тег не сошёлся). Не чаще раза в 10 минут на контакт.
function authDowngradeNotice(id, reason) {
  const c = state.contacts.get(id); if (!c || c.pendingKey) return;
  const last = authToastAt.get(id) || 0;
  if (Date.now() - last <= 600000) return;
  authToastAt.set(id, Date.now());
  const name = c.name || T("sys.someone");
  try {
    if (reason === "downgrade") {
      c.messages.push({ id: crypto.randomUUID(), from: "system", text: T("sys.linkAuthDowngrade", { name }), textKey: "sys.linkAuthDowngrade", textParams: { name }, ts: Date.now() });
      trimMessages(c); persistContacts();
      if (state.chatId === id) renderChatThread();
      toast(T("toast.linkAuthDowngrade", { name }));
    } else toast(T("toast.linkAuthFailed", { name }));
  } catch (e) {}
}
function finishAuth(id, link, result, reason) {
  if (link.authGate !== "pending") return;
  clearTimeout(link._authTimer);
  if (authLinkStale(id, link)) return;
  const c = state.contacts.get(id);
  // Даунгрейд: контакт раньше проходил проверку (authSeen) — «не поддерживает/не ответил» больше не равно «непроверен», а равно провалу
  if (result === "unverified" && c && c.authSeen) { result = "fail"; reason = "downgrade"; }
  link.authState = result;
  if (result === "fail") {
    link.authGate = "closed"; link._authBuf = [];
    etherLog("warn", "[auth] канал с " + String(id).slice(0, 10) + "… НЕ прошёл проверку (" + (reason || "mismatch") + ") — закрываю");
    authDowngradeNotice(id, reason === "downgrade" ? "downgrade" : "mismatch");
    try { mesh.remove(id); } catch (e) {}
    return;
  }
  if (result === "ok" && c && !c.authSeen) { c.authSeen = true; persistContacts(); }
  etherLog("info", "[auth] " + String(id).slice(0, 10) + "… " + (result === "ok" ? "канал подтверждён" : "собеседник не поддерживает проверку (канал без подтверждения)"));
  link.authGate = null;
  const buf = link._authBuf || []; link._authBuf = [];
  // То, что не ушло, пока канал был на шлюзе, и накопленное входящее
  try { sendPrivacyPrefsTo(id); } catch (e) {}
  try { for (const g of state.contacts.values()) if (g.isGroup && g.members.some((m) => m.id === id)) sendGroupRosterTo(g, id); } catch (e) {}
  for (const payload of buf) mesh.dispatchEvent(new CustomEvent("message", { detail: { id, payload } }));
  try { flushOutbox(); } catch (e) {}
  if (state.chatId === id) renderChatThread();
}
// ---- Идемпотентность входящих: последние msgId по контакту (≤500) хранятся в localStorage и переживают перезапуск ----
const SEEN_MSG_PER_CONTACT = 500, SEEN_MSG_TOTAL = 6000, SEEN_MSG_KEY = "ether.seenMsgIds", DELIVER_MAX_ATTEMPTS = 3;
let seenMsgStore = null; // { ids: { contactId: [msgId, ...] }, f: { "from|msgId": попыток } }
let seenMsgTimer = null;
function seenMsgLoad() {
  if (seenMsgStore) return seenMsgStore;
  let o = null; try { o = JSON.parse(localStorage.getItem(SEEN_MSG_KEY) || "null"); } catch (e) { o = null; }
  if (!o || typeof o !== "object" || !o.ids || typeof o.ids !== "object") o = { ids: {}, f: {} };
  if (!o.f || typeof o.f !== "object") o.f = {};
  seenMsgStore = o; return o;
}
function seenMsgPersistSoon() {
  if (seenMsgTimer) return;
  seenMsgTimer = setTimeout(() => { seenMsgTimer = null; try { localStorage.setItem(SEEN_MSG_KEY, JSON.stringify(seenMsgStore)); } catch (e) {} }, 300);
}
function hasSeenMsg(from, msgId) { const l = seenMsgLoad().ids[from]; return !!(l && l.includes(msgId)); }
function markSeenMsg(from, msgId) {
  const st = seenMsgLoad();
  let l = st.ids[from];
  if (l) delete st.ids[from]; else l = []; // переставляем контакт в конец: вытесняются самые давние
  if (!l.includes(msgId)) l.push(msgId);
  while (l.length > SEEN_MSG_PER_CONTACT) l.shift();
  st.ids[from] = l;
  let total = 0; for (const k of Object.keys(st.ids)) total += st.ids[k].length;
  for (const k of Object.keys(st.ids)) { if (total <= SEEN_MSG_TOTAL) break; total -= st.ids[k].length; delete st.ids[k]; }
  delete st.f[from + "|" + msgId];
  seenMsgPersistSoon();
}
function bumpDeliverFail(from, msgId) {
  const st = seenMsgLoad(), k = from + "|" + msgId;
  st.f[k] = (st.f[k] || 0) + 1;
  const keys = Object.keys(st.f); if (keys.length > 200) for (const x of keys.slice(0, keys.length - 200)) delete st.f[x];
  seenMsgPersistSoon();
  return st.f[k];
}
function pushSystemNote(c, key, params) {
  if (!c) return;
  c.messages.push({ id: crypto.randomUUID(), from: "system", text: T(key, params), textKey: key, textParams: params, ts: Date.now() });
  trimMessages(c); persistContacts();
  if (state.chatId === c.id) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
// ---- Потеря ratchet-состояния: служебное «rc-reset» (без содержимого) ----
const RC_RESYNC_MIN_MS = 10 * 60 * 1000, RC_RESET_HANDLE_MIN_MS = 5 * 60 * 1000, RC_RESEND_MAX = 30;
const rcResyncReqAt = new Map(), rcResetHandledAt = new Map();
function isRatchetLostError(e) { return /ratchet: (no session|auth failed|unknown prekey|unknown one-time prekey)/.test(String(e)); }
function isDowngradeError(e) { return /ratchet: downgrade/.test(String(e)); }
// Ratchet сообщает о подозрительном понижении защиты: заметка в чате не чаще раза в час на контакт и код. Чат не блокируется.
const ratchetWarnAt = new Map();
function noteRatchetWarn(id, code) {
  const c = state.contacts.get(id); if (!c || c.isGroup) return;
  const k = id + "|" + code, now = Date.now();
  if (now - (ratchetWarnAt.get(k) || 0) < 3600 * 1000) return;
  ratchetWarnAt.set(k, now);
  pushSystemNote(c, code === "pq-missing" ? "sys.ratchetPqMissing" : "sys.ratchetDowngrade");
}
try { Ratchet.onWarn(noteRatchetWarn); } catch (e) {}
// Явное «сбросить защиту»: человек решил (например, собеседник переустановил приложение). Забывает «липкие» уровни и сессии этого контакта.
function resetContactProtection(id) {
  try { Ratchet.resetTrust(id); } catch (e) {}
  for (const [mid, en] of outbox) if (en.to === id) envelopeCache.delete(mid);
  const c = state.contacts.get(id); if (c) pushSystemNote(c, "sys.ratchetReset");
}
function isBenignDupError(e) { return /ratchet: (duplicate or old message|replayed initial)/.test(String(e)); }
// Получатель: не смог открыть ratchet-конверт — просим отправителя начать сессию заново. Не чаще раза в RC_RESYNC_MIN_MS на контакт.
function requestRatchetResync(from) {
  const c = state.contacts.get(from); if (!c || c.isGroup || !c.publicKey || c.pendingKey || c.blocked) return false;
  const now = Date.now();
  if (now - (rcResyncReqAt.get(from) || 0) < RC_RESYNC_MIN_MS) return false;
  rcResyncReqAt.set(from, now);
  const id = crypto.randomUUID();
  addToOutbox(id, from, { kind: "rc-reset", id, ts: now });
  const e = outbox.get(id); if (e) e.forceV1 = true; // статический ключ: ratchet-сессия как раз сломана
  flushOutboxItem(id);
  pushSystemNote(c, "sys.keysResynced");
  return true;
}
// Отправитель: сбрасываем сессию и пере-отправляем неподтверждённые (ack sent/pending) текстовые сообщения новым конвертом.
function handleRatchetResetRequest(from) {
  const c = state.contacts.get(from); if (!c || c.isGroup || c.blocked) return;
  const now = Date.now();
  if (now - (rcResetHandledAt.get(from) || 0) < RC_RESET_HANDLE_MIN_MS) return;
  rcResetHandledAt.set(from, now);
  try { Ratchet.reset(from); } catch (e) {}
  for (const [id, en] of outbox) if (en.to === from) envelopeCache.delete(id); // эти конверты зашифрованы старой сессией
  let n = 0;
  for (let i = c.messages.length - 1; i >= 0 && n < RC_RESEND_MAX; i--) {
    const m = c.messages[i];
    if (m.from !== "me" || (m.ack !== "sent" && m.ack !== "pending")) continue;
    if (m.file || m.sticker || m.contactCard || m.poll || m.board || m.note || typeof m.text !== "string" || !m.text) continue;
    if (now - m.ts > RESUME_MAX_AGE_MS || outbox.has(m.id)) continue;
    envelopeCache.delete(m.id);
    const payload = { kind: "chat", id: m.id, text: m.text, ts: m.ts };
    if (m.replyTo) payload.replyTo = { id: m.replyTo.id, text: m.replyTo.text, authorName: m.replyTo.authorName };
    if (m.ttl) payload.ttl = m.ttl;
    if (m.forwarded) { payload.forwarded = true; if (m.forwardedFrom) payload.fwdFrom = m.forwardedFrom; }
    addToOutbox(m.id, from, payload); flushOutboxItem(m.id); n++;
  }
  pushSystemNote(c, "sys.keysResynced");
}
const deliverInFlight = new Set();
// Входящий конверт из ящика сервера. replay=true — повторный разбор конверта, удержанного до подтверждения нового ключа контакта.
// mailboxAck уходит ПОСЛЕ расшифровки и сохранения: при ошибке сервер переотправит конверт при следующем подключении (не более
// DELIVER_MAX_ATTEMPTS раз на msgId, затем подтверждаем и показываем системную запись). Повтор (from,msgId) игнорируем, но подтверждаем.
async function handleDeliver(detail, replay) {
  const { msgId, envelope, fromPublicKey, kind, fromDev } = detail;
  const from = canonPeer(detail.from); // контакт уже переименован по уведомлению id-migrate, а сообщение пришло ещё со старым id
  const ackBox = () => { if (replay) return; const s = detail.ackVia || signaling; if (s) s.mailboxAck(msgId); }; // ackVia: короткая сессия на запасном сервере
  const dKey = from + "|" + msgId;
  const sender = state.contacts.get(from);
  if (sender && sender.blocked) {
    ackBox();
    if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
    return;
  }
  if (kind === "gchat") { await handleGroupSkDeliver(detail, replay, ackBox); return; } // V.80: Sender Keys (09-groups.js)
  // group-invite дедуплицируется отдельно, по payload.id (см.
  // applyIncomingPayload) — там же ключ "grp-inv:". Раньше мы добавляли
  // ещё и "from|msgId", и Set рос вдвое быстрее (по 2 записи на
  // каждый group-invite), из-за чего окно дедупликации сжималось.
  if (kind !== "group-invite") {
    if (hasSeenMsg(from, msgId) || seenDeliverIds.has(dKey)) {
      ackBox();
      if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
      return;
    }
    if (deliverInFlight.has(dKey)) return; // тот же конверт уже разбирается — подтвердит первый разбор
    rememberDeliverId(dKey);
  }
  deliverInFlight.add(dKey);
  try {
    let payload, learnKey = false;
    try {
      const c0 = state.contacts.get(from);
      learnKey = !!fromPublicKey && !(c0 && c0.publicKey);
      // Ключ отправителя изменился: пока человек не подтвердил, конверт не расшифровываем — удерживаем (и переживаем перезапуск).
      if (fromPublicKey && c0 && !noteContactKey(c0, fromPublicKey)) {
        seenDeliverIds.delete(dKey);
        if (c0.rejectedKey && !keysDiffer(fromPublicKey, c0.rejectedKey)) { ackBox(); return; } // ключ отклонён пользователем — молча отбрасываем
        if (!heldDeliveries.some((h) => h.from === from && h.msgId === msgId)) { heldDeliveries.push({ from, msgId, envelope, fromPublicKey, kind, at: Date.now() }); persistHeld(); }
        ackBox(); // конверт сохранён в heldDeliveries (localStorage)
        return;
      }
      // Сообщение с другого устройства аккаунта собеседника/моего (fromDev): ключ берём из проверенного списка устройств, ratchet не используется
      const devKey = fromDev && typeof Devices !== "undefined" ? await Devices.deviceKeyFor(from, fromDev) : null;
      if (fromDev && !devKey) throw new Error("unknown device");
      const theirKey = devKey || (from === Store.myId ? Store.myPublicKeyJwk : ((c0 && c0.publicKey) || fromPublicKey));
      if (!theirKey) throw new Error("no key");
      if (envelope && envelope.v === 2 && envelope.h && !devKey) {
        payload = await idMigDecrypt(from, (myIdTry) => Ratchet.decrypt({ contactId: from, myId: myIdTry, myPrivJwk: Store.myPrivateKeyJwk, theirPubJwk: theirKey }, envelope));
        markContactRatchet(c0);
      } else {
        const sharedKey = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, theirKey);
        // v2 без поля h — конверт с AAD (отправитель = from, получатель = я); v1 расшифровывается как раньше
        payload = await idMigDecrypt(from, (myIdTry) => CryptoHelper.decryptJson(sharedKey, envelope, envelope && envelope.v === 2 ? CryptoHelper.envAad(from, myIdTry) : undefined));
        if (envelope && envelope.rc) markContactRatchet(c0);
      }
      if (envelope && envelope.e2) markContactEnv2(c0);
    } catch (e) {
      etherLog("error", "[crypto] decrypt failed:", String(e));
      seenDeliverIds.delete(dKey);
      if (isDowngradeError(e)) { ackBox(); return; } // слабый начальный конверт отвергнут, заметка уже показана; не зацикливаем доставку и не просим пересинхронизацию
      if (isBenignDupError(e)) { // уже расшифрованный ранее конверт (память дедупликации потеряна) — просто подтверждаем
        markSeenMsg(from, msgId); ackBox();
        if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
        return;
      }
      const hasRatchetHeader = !!(envelope && envelope.v === 2 && envelope.h);
      if (hasRatchetHeader && isRatchetLostError(e) && requestRatchetResync(from)) { ackBox(); return; } // отправитель пришлёт сообщения заново
      const nTry = bumpDeliverFail(from, msgId);
      if (nTry >= DELIVER_MAX_ATTEMPTS) {
        ackBox();
        const cf = state.contacts.get(from);
        if (cf && !cf.isGroup && kind !== "rc-reset" && kind !== "typing") pushSystemNote(cf, "sys.msgUnreadable");
      }
      return;
    }

    if ((kind === "sync-sent" || kind === "sync-op") && from === Store.myId && typeof Devices !== "undefined") { // отправленное/сделанное с другого моего устройства (применяется локально, без рассылки: анти-эхо)
      try { if (kind === "sync-op") Promise.resolve(Devices.applySyncOp(payload)).catch(() => {}); else Devices.applySyncSent(payload); } catch (e) {}
      markSeenMsg(from, msgId); ackBox(); return;
    }
    if ((kind === "sync-sent" || kind === "sync-op") && from === Store.myId) { ackBox(); return; }
    // Первый отправитель из ящика: конверт расшифровался этим ключом — запоминаем его, иначе ответить и квитировать нельзя
    if (learnKey) {
      try {
        const nc = ensureContactEntry(from, null);
        if (!nc.publicKey) noteContactKey(nc, fromPublicKey);
        persistContacts();
        flushPendingNoKey(from);
      } catch (e) {}
    }
    try {
      applyIncomingPayload(from, msgId, payload, true, kind);
    } catch (e) {
      etherLog("error", "[deliver] apply failed:", String(e));
      seenDeliverIds.delete(dKey);
      if (bumpDeliverFail(from, msgId) >= DELIVER_MAX_ATTEMPTS) {
        ackBox();
        const cf = state.contacts.get(from);
        if (cf && !cf.isGroup) pushSystemNote(cf, "sys.msgUnreadable");
      }
      return;
    }
    if (kind !== "group-invite") markSeenMsg(from, msgId);
    ackBox();
    if (kind === "chat") sendAckBatch(from, [msgId], "delivered");
  } finally { deliverInFlight.delete(dKey); }
}
function applyIncomingPayload(from, envelopeMsgId, payload, fromServer, openKind) {
  const kind = (payload && payload.kind) || openKind || "chat";
  if (kind === "chat" && (!payload || typeof payload !== "object")) return; // расшифровка могла дать null/не-объект — не падаем
  if (kind === "chat") {
    const groupId = payload.groupId;
    const c = groupId ? state.contacts.get(groupId) : ensureContactEntry(from, null);
    if (!c) return; // сообщение в группу, о которой нам ничего не известно (приглашение не дошло) — сопоставляем именно с группой (c = state.contacts.get(groupId)), а не с отправителем from; группы нет локально — некуда класть сообщение
    // Защита на стороне получателя, а не только запрет в UI отправителя —
    // иначе достаточно отправить сообщение программно (минуя композер),
    // чтобы "только админы пишут" оказалось чисто декоративным. Без
    // доверенного сервера это не защита от модифицированного клиента
    // самого отправителя, но она гарантирует, что ЧЕСТНЫЕ клиенты всех
    // остальных участников согласованно скрывают такое сообщение.
    // Групповое сообщение принимаем только в настоящую группу и только от её участника (как и для файлов): иначе любой контакт
    // мог бы подставить в личную переписку «сообщение от Боба» (groupId = id Боба), а удалённый участник — писать в группу.
    if (groupId && (!isGroup(c) || !c.members.some((m) => m.id === from))) return;
    if (typeof payload.text !== "string") return;
    if (groupId && c.writeRestricted && !isGroupAdmin(c, from)) return;
    if (groupId && !c.isChannel && !groupSlowAccept(c, from)) return; // медленный режим проверяет получатель, не только интерфейс отправителя
    if (c.messages.some((m) => m.id === payload.id)) return;
    const routeId = groupId || from;
    const isOpen = state.chatId === routeId;
    const rec = { id: payload.id, from: "them", text: payload.text, ts: safeMsgTs(payload.ts), readAckSent: false, deliveryId: envelopeMsgId };
    if (groupId) {
      // имя — из списка участников (его нельзя подделать полем senderName), запасной вариант — присланное имя
      const mem = c.members.find((m) => m.id === from);
      rec.fromId = from; rec.fromName = (mem && mem.name) || (state.contacts.get(from) && state.contacts.get(from).name) || (typeof payload.senderName === "string" && payload.senderName.slice(0, 40)) || T("sys.someone");
    }
    if (payload.replyTo && typeof payload.replyTo === "object" && typeof payload.replyTo.id === "string") {
      // цитата: если исходное сообщение есть локально, текст и автор берём из него (чужую цитату подделать нельзя)
      const rt = payload.replyTo, orig = c.messages.find((x) => x.id === rt.id);
      let rtText = typeof rt.text === "string" ? rt.text : "", rtAuthor = typeof rt.authorName === "string" ? rt.authorName : "";
      if (orig) {
        if (orig.text) rtText = orig.text;
        rtAuthor = orig.from === "me" ? (Store.name || rtAuthor) : (orig.fromName || (orig.from === "them" ? c.name : "") || rtAuthor);
      }
      rec.replyTo = { id: rt.id.slice(0, 64), text: rtText.slice(0, 200), authorName: rtAuthor.slice(0, 40) };
    }
    if (payload.forwarded) { rec.forwarded = true; if (typeof payload.fwdFrom === "string" && payload.fwdFrom) rec.forwardedFrom = payload.fwdFrom.slice(0, 40); }
    if (safeTtl(payload.ttl)) rec.ttl = safeTtl(payload.ttl);
    if (groupId && Store.name && typeof payload.text === "string" && isMentioned(payload.text, Store.name)) {
      rec.mentionMe = true;
      state.mentionedChats.add(groupId);
    }
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    const displayName = c.name;
    const previewPrefix = groupId ? `${rec.fromName}: ` : "";
    if (isOpen) {
      renderChatThread(); playMessageSound(routeId); vibrate([80, 40, 80]);
      // aria-live на #chat-messages спамил бы весь список на каждую
      // перерисовку — объявляем только реально новое сообщение через
      // отдельный скрытый узел.
      announceToScreenReader(T("sr.newMessage", { name: groupId ? rec.fromName : displayName, text: truncate(payload.text, 80) }));
      // страница скрыта (вкладка в фоне / экран погашен): чат «открыт», но пользователь сообщения не видит
      if (document.visibilityState === "hidden" && !isContactMuted(c)) showNotification(displayName || T("app.name"), previewPrefix + truncate(payload.text, 80), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
    } else {
      toast(`${displayName}: ${previewPrefix}${truncate(payload.text, 40)}`);
      if (!isContactMuted(c)) showNotification(displayName || T("app.name"), previewPrefix + truncate(payload.text, 80), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
      playMessageSound(routeId);
      vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    // Раньше здесь был немедленный sendAckBatch(..., "read") независимо от
    // того, долистал ли пользователь до этого сообщения — обходил всю
    // логику отложенной пометки прочитанным (markThreadRead внутри
    // renderChatThread, которая честно проверяет прокрутку). Теперь
    // полагаемся только на неё — она сама решит, когда действительно
    // отправить квитанцию, и корректно учтёт группы (см. markThreadRead).
    updateAppBadge();
  } else if (kind === "file") {
    // Файл/голосовое, пришедшее ЦЕЛИКОМ одним payload'ом — путь через
    // почтовый ящик сервера (sendFileOffline/sendVoiceOffline), в
    // отличие от чанкованного P2P-протокола (kind начинается с "file-",
    // см. handleFilePayload/finishIncomingFile — та запись сначала
    // "pending", потом дозаполняется). Тут вся информация уже есть
    // сразу, собирать по частям нечего.
    const fileGroupId = payload.groupId;
    const c = fileGroupId ? state.contacts.get(fileGroupId) : ensureContactEntry(from, null);
    if (!c) return; // файл в группу, о которой мы ничего не знаем
    if (fileGroupId) {
      // Только участник группы; режим «пишут только админы» проверяется и здесь, как для текста
      if (!isGroup(c) || !c.members.some((m) => m.id === from)) return;
      if (c.writeRestricted && !isGroupAdmin(c, from)) return;
    }
    const fileRouteId = fileGroupId || from;
    if (c.messages.some((m) => m.id === payload.id)) return;
    for (const oc of state.contacts.values()) { if (oc !== c && oc.messages && oc.messages.some((m) => m.id === payload.id && m.file)) return; } // IDB-ключ файла общий: чужой id из другого чата не принимаем
    // Симметрично handleFilePayload (чанкованный P2P-путь) — там
    // payload.size проверяется EtherFileLimits.isValidFileMetaSize ещё до
    // того, как собирать чанки. Этот офлайн-путь получает файл целиком
    // одним payload'ом через почтовый ящик сервера, и раньше размер вообще
    // не проверялся. Эксплуатация ограничена isValidEnvelope на сервере и
    // SCTP-лимитами P2P, но для согласованности проверка нужна и тут.
    if (!EtherFileLimits.isValidFileMetaSize(payload.size)) return;
    let blob;
    try { blob = new Blob([base64ToUint8Array(payload.dataB64)], { type: payload.mime || "application/octet-stream" }); }
    catch (e) { etherLog("error", "[file] decode failed:", String(e)); return; }
    const rec = {
      id: payload.id, from: "them", text: "", ts: safeMsgTs(payload.ts), readAckSent: false, deliveryId: envelopeMsgId,
      file: { name: payload.name || "file", mime: payload.mime || "application/octet-stream", size: payload.size || blob.size, kind: fileKindFromMime(payload.mime), duration: safeDuration(payload.duration), wave: sanitizeWave(payload.wave), pending: false },
    };
    if (payload.forwarded) { rec.forwarded = true; if (typeof payload.fwdFrom === "string" && payload.fwdFrom) rec.forwardedFrom = payload.fwdFrom.slice(0, 40); }
    if (typeof payload.caption === "string" && payload.caption) rec.file.caption = payload.caption.slice(0, 200);
    if (safeTtl(payload.ttl)) rec.ttl = safeTtl(payload.ttl);
    if (!rec.ttl && c.disappearingTimer) rec.ttl = c.disappearingTimer;
    if (fileGroupId) { const mem = c.members.find((x) => x.id === from); rec.fromId = from; rec.fromName = (mem && mem.name) || (state.contacts.get(from) && state.contacts.get(from).name) || T("sys.someone"); }
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    // Раньше IDB.set не дожидались: renderChatThread → hydrateFileSlots →
    // getFileBlobUrl → IDB.get мог выполниться раньше, чем put
    // завершится, и слот на секунду показывал «недоступно». Явно
    // дожидаемся записи, весь хвост ветки (тосты/нотификации/рендер)
    // переносим внутрь .then.
    IDB.set("file:" + payload.id, blob)
      .then(() => {
        const isOpen = state.chatId === fileRouteId;
        if (isOpen) { renderChatThread(); playMessageSound(fileRouteId); vibrate([80, 40, 80]); }
        else {
          const label = (fileGroupId ? rec.fromName + ": " : "") + T("chat.file.preview." + rec.file.kind);
          toast(`${c.name}: ${label}`);
          if (!isContactMuted(c)) showNotification(c.name || T("app.name"), label, { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
          playMessageSound(fileRouteId);
          vibrate([80, 40, 80]);
        }
        if (state.tab === "chats") renderChatsList();
        updateAppBadge();
      })
      .catch((e) => {
        etherLog("error", "[file] IDB.set failed:", String(e));
        // даже без сохранённого блоба пузырь уже добавлен — при
        // следующем рендере слот покажет «недоступно»
        const isOpen = state.chatId === fileRouteId;
        if (isOpen) renderChatThread();
        if (state.tab === "chats") renderChatsList();
        updateAppBadge();
      });
   } else if (kind === "group-invite") {
    // Дедупликация по payload.id. group-invite — особый случай: у него
    // нет ack-механизма (получатель не отвечает "получил"), поэтому
    // отправитель всегда дублирует отправку через сервер через
    // P2P_FALLBACK_MS — это видно в логах: один и тот же msgId с
    // kind=group-invite приходит дважды подряд. Без этой проверки
    // получатель видел каждый групповой инвайт как два отдельных
    // события.
    const gDedupKey = "grp-inv:" + payload.id;
    if (seenGroupInviteIds.has(gDedupKey)) return;
    seenGroupInviteIds.add(gDedupKey);
    if (seenGroupInviteIds.size > SEEN_DELIVER_LIMIT) seenGroupInviteIds.delete(seenGroupInviteIds.values().next().value);

    if (!Array.isArray(payload.members) || payload.members.length === 0 || payload.members.length > MAX_GROUP_MEMBERS_SK) return;
    {
      // Поля приглашения приходят от постороннего: оставляем только известные, строковые и ограниченные по длине
      const seenIds = new Set(), clean = [];
      for (const m of payload.members) {
        if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id || m.id.length > 128 || seenIds.has(m.id)) return;
        seenIds.add(m.id);
        const cm = { id: m.id, name: typeof m.name === "string" ? m.name.slice(0, 40) : "" };
        if (m.id === from && typeof m.srv === "string") { const hs = ServerList.decodeHints(m.srv, { allowLocal: srvAllowLocal() }); if (hs.length) try { srvLearn(from, hs); } catch (e) {} } // свои серверы отправитель сообщает сам
        if (m.role === "admin" || m.role === "member" || m.role === "moderator") cm.role = m.role;
        clean.push(cm);
      }
      payload.members = clean;
      if (typeof payload.groupName === "string") payload.groupName = payload.groupName.slice(0, 60); else payload.groupName = undefined;
      if (typeof payload.groupAvatar === "string" && payload.groupAvatar.length > 40000) payload.groupAvatar = undefined;
      if (typeof payload.groupId !== "string" || !payload.groupId || payload.groupId.length > 64) return;
    }
    idMigNormalizeGroupPayload(payload); // мой прежний id / уже переименованные контакты -> текущие id
    if (!payload.members.some((m) => m.id === Store.myId)) return;
  // Ищем группу по payload.groupId. Дополнительно, если по id её нет —
  // ищем по «логической идентичности»: тот же состав участников + то же
  // имя. Нужно как страховка от бага, когда прилетает group-invite с
  // ДРУГИМ groupId, но это на самом деле та же группа (тот же набор
  // людей и имя). Без этой проверки создавался бы дубликат: одна
  // группа с системным сообщением «создана», вторая — без него.
  let g = state.contacts.get(payload.groupId);
  etherLog("info", "[group] invite in:", "from=" + String(from).slice(0, 8) + "…", "payload.groupId=" + String(payload.groupId).slice(0, 8) + "…", "isNew=" + (!g), "existingKeys=" + Array.from(state.contacts.keys()).filter((k) => state.contacts.get(k).isGroup).length);
  if (!g) {
    const incomingIds = payload.members.map((m) => m.id).sort().join("|");
    const incomingName = (payload.groupName || "").trim();
    for (const other of state.contacts.values()) {
      if (!other.isGroup) continue;
      const otherIds = other.members.map((m) => m.id).sort().join("|");
      if (otherIds !== incomingIds) continue;
      if (incomingName && other.name && other.name !== incomingName) continue;
      if (!isGroupAdmin(other, from)) continue; // переименовать локальную группу может только присланное её админом приглашение — иначе участник «ломал» бы id группы у всех
      // Тот же состав участников (+ то же имя) — считаем это той же группой.
      // Указываем её локально под payload.groupId, чтобы последующие
      // инвайты с тем же groupId (но другим именем) нашли её по id.
      etherLog("info", "[group] invite от " + String(from).slice(0, 8) + "…: id не совпал, но состав совпадает с существующей группой — считаю той же группой");
      const oldGroupId = other.id;
      state.contacts.delete(oldGroupId);
      other.id = payload.groupId;
      state.contacts.set(payload.groupId, other);
      if (state.chatId === oldGroupId) state.chatId = payload.groupId;
      if (state.drafts && state.drafts[oldGroupId] !== undefined) { state.drafts[payload.groupId] = state.drafts[oldGroupId]; delete state.drafts[oldGroupId]; }
      g = other;
      break;
    }
  }
  const isNew = !g;
  const gkOldIds = isNew ? [] : g.members.map((m) => m.id);
  // ver: версия ростера. Нет поля (старый клиент) — null: применяем как раньше, если прислал админ. Устаревшая версия от админа отбрасывается.
  const inVer = Number.isInteger(payload.ver) && payload.ver >= 0 && payload.ver < 1e9 ? payload.ver : null;
  if (isNew) {
      // B5: новую группу принимаем только от её админа/создателя (по ролям в самом пакете); createdBy — лишь если он есть среди members.
      const senderM = payload.members.find((m) => m && m.id === from);
      const cbOk = typeof payload.createdBy === "string" && payload.members.some((m) => m && m.id === payload.createdBy);
      const senderIsAdmin = !!senderM && (senderM.role === "admin" || (cbOk && payload.createdBy === from));
      if (!senderIsAdmin) { etherLog("warn", "[group] новая группа от не-админа " + String(from).slice(0, 8) + "… проигнорирована"); return; }
      g = { id: payload.groupId, isGroup: true, name: payload.groupName || T("group.defaultName"),
        members: payload.members, messages: [], lastActivity: Date.now(), archived: false, muted: false,
        createdBy: cbOk ? payload.createdBy : from, managed: true };
      // Валидируем формат ДО записи в g.avatar — тогда "заражённый" аватар
      // (CSS-инъекция через background-image, см. AVATAR_DATAURL_RE выше
      // avatarCircleHtml) просто не попадёт в localStorage вовсе, а не
      // будет каждый раз отфильтровываться только на рендере.
      if (payload.groupAvatar && AVATAR_DATAURL_RE.test(payload.groupAvatar)) g.avatar = payload.groupAvatar;
      if (payload.groupDescription) g.description = String(payload.groupDescription).slice(0, 200);
      if (typeof payload.writeRestricted === "boolean" && payload.writeRestricted) g.writeRestricted = true;
      // «Костёр» (самоудаляющаяся группа): метка срока в описании НОВОЙ группы — её и помечаем локально; на уже существующие группы описание не влияет
      try { if (g.description && /⁣c:\d{10,}⁣/.test(g.description) && typeof fxCampfireMark === "function") fxCampfireMark(g.id); } catch (e) {}
      if (inVer > 0) g.rosterVer = inVer;
      state.contacts.set(payload.groupId, g);
      g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("group.systemCreated", { name: g.name }), textKey: "group.systemCreated", textParams: { name: g.name }, ts: Date.now() });
      trimMessages(g);
    } else {
      // Менять состав, роли, название и аватар существующей группы может только её админ (раньше — любой участник мог перезаписать всё).
      // Исключение — выход самого отправителя из группы: тогда из НАШЕГО списка убирается только он, роли и прочее не берутся из пакета.
      const oldIds = g.members.map((m) => m.id), newIds = payload.members.map((m) => m.id);
      const fromAdmin = isGroupAdmin(g, from);
      const selfLeave = !newIds.includes(from) && oldIds.includes(from) && newIds.every((id) => oldIds.includes(id)) && oldIds.every((id) => newIds.includes(id) || id === from);
      if (!fromAdmin && !selfLeave) { etherLog("warn", "[group] invite от не-админа " + String(from).slice(0, 8) + "… отклонён (группа " + String(g.id).slice(0, 8) + "…)"); return; }
      const localVer = Number.isInteger(g.rosterVer) ? g.rosterVer : 0;
      if (fromAdmin && inVer !== null && inVer < localVer) { etherLog("warn", "[group] устаревший ростер ver=" + inVer + " < " + localVer + " отброшен (группа " + String(g.id).slice(0, 8) + "…)"); return; }
      if (!fromAdmin) {
        g.members = g.members.filter((m) => m.id !== from);
      } else {
      if (inVer !== null && inVer > localVer) g.rosterVer = inVer;
      g.members = GroupAdmin.sanitizeRoster(g, payload.members, from);
      // исключённых нами (banned) старый/параллельный ростер другого админа не возвращает, пока их не добавил админ вручную
      if (Array.isArray(g.banned) && g.banned.length && isGroupAdmin(g, Store.myId)) g.members = g.members.filter((m) => !g.banned.includes(m.id));
      if (payload.groupName) g.name = payload.groupName;
      if (payload.groupAvatar !== undefined) g.avatar = (payload.groupAvatar && AVATAR_DATAURL_RE.test(payload.groupAvatar)) ? payload.groupAvatar : null;
      if (payload.groupDescription !== undefined) g.description = String(payload.groupDescription || "").slice(0, 200) || undefined;
      if (typeof payload.writeRestricted === "boolean") g.writeRestricted = payload.writeRestricted || undefined;
      }
    }
    g.lastActivity = Date.now();
    persistContacts();
    gkOnRosterChange(g, gkOldIds);
    ensureGroupConnections(g);
    if (state.chatId === payload.groupId) renderChatThread();
    if (state.tab === "chats") renderChatsList();
  } else if (kind === "group-settings") {
    // Применяем новое состояние ("только админы пишут") только если его
    // прислал реально действующий админ этой группы на момент получения
    // — иначе разжалованный или выгнанный участник мог бы продолжать
    // рассылать изменения настроек задним числом.
    const g = state.contacts.get(payload.groupId);
    if (!g || !g.isGroup || !isGroupAdmin(g, from)) return;
    if (typeof payload.writeRestricted === "boolean" && g.writeRestricted !== payload.writeRestricted) {
      g.writeRestricted = payload.writeRestricted;
      persistContacts();
      if (state.chatId === payload.groupId) { renderChatThread(); updateSendVsMic(); }
      if (state.activeGroupContext === payload.groupId) openGroupInfo(payload.groupId);
    }
  } else if (kind === "edit") {
    const c = resolveEditDeleteTarget(from, payload);
    if (!c) return;
    const m = c.messages.find((x) => x.id === payload.id && (c.isGroup ? x.fromId === from : x.from === "them"));
    if (m && typeof payload.text === "string") { m.text = payload.text.slice(0, MAX_MESSAGE_LENGTH * 2); m.edited = true; c.lastActivity = Date.now(); persistContacts(); // время сообщения правкой не меняется: иначе его можно «переставить» и сдвинуть срок исчезновения
      if (state.chatId === c.id) renderChatThread(); if (state.tab === "chats") renderChatsList(); }
  } else if (kind === "delete") {
    const c = resolveEditDeleteTarget(from, payload);
    if (!c) return;
    const before = c.messages.length;
    c.messages = c.messages.filter((x) => !(x.id === payload.id && (c.isGroup ? x.fromId === from : x.from === "them")));
    if (c.messages.length !== before) { persistContacts();
      if (state.chatId === c.id) renderChatThread(); if (state.tab === "chats") renderChatsList(); }
  } else if (kind === "ack" || (kind === "ack-batch" && Array.isArray(payload.ids))) {
    // Ветка "ack" (в отличие от "ack-batch") в проекте никем не
    // отправляется — но если такой payload всё же придёт (испорченный
    // или от другого клиента) без payload.state, markMessageAck(...,
    // undefined) мог тихо испортить уже верный ack "sent" на более
    // низкий ранг. Не действуем без явного state.
    // От собеседника принимаем только настоящие квитанции (не «failed» и не произвольные строки) и не больше 500 id за раз
    if (payload.state === "sent" || payload.state === "delivered" || payload.state === "read") {
      const ids = (Array.isArray(payload.ids) ? payload.ids : [payload.id]).filter((x) => typeof x === "string").slice(0, 500);
      for (const id of ids) markMessageAck(from, id, payload.state);
      if (typeof Devices !== "undefined") { try { Devices.syncAckIn(from, payload.state, ids); } catch (e) {} } // другие мои устройства тоже увидят «доставлено/прочитано»
    }
  } else if (kind === "typing") {
    handleIncomingTyping(from, !!payload.active);
  } else if (kind === "privacy-pref") {
    const c = state.contacts.get(from);
    if (c) {
      // Значения собеседника о ТРЁХ тумблерах приватности — влияют на
      // то, что я вижу про НЕГО (моё отображение), а не на мои
      // собственные значения. Отсутствие поля (старый клиент, ещё не
      // успел прислать) трактуем как "не скрыто" — разрешительно по
      // умолчанию, а не наоборот.
      c.peerReceiptsEnabled = payload.receiptsEnabled !== false;
      c.peerLastSeenVisible = payload.lastSeenVisible !== false;
      c.peerPresenceVisible = payload.presenceVisible !== false;
      if (typeof payload.status === "string") c.peerStatus = payload.status.slice(0, 140);
      // Собственное фото собеседника (до ~20 КБ, строгая проверка формата): показывается, пока вы не выбрали контакту своё
      if (typeof payload.avatar === "string") {
        if (payload.avatar === "") delete c.peerAvatar;
        else if (payload.avatar.length <= 40000 && AVATAR_DATAURL_RE.test(payload.avatar)) c.peerAvatar = payload.avatar;
        persistContacts();
      }
      if (state.chatId === from || state.tab === "chats") renderTab();
    }
  } else if (kind === "story") {
    receiveStory(from, payload);
  } else if (kind === "sticker") {
    if (window.EtherStickers && EtherStickers.receive) EtherStickers.receive(from, payload, envelopeMsgId).catch(() => {});
  } else if (kind === "poll" || kind === "board" || kind === "note" || kind === "poll-vote" || kind === "poll-close" || kind === "board-op" || kind === "note-op") {
    applyIncomingRich(from, envelopeMsgId, payload);
  } else if (kind === "reaction") {
    applyReaction(from, payload);
    try { if (!payload.remove && payload.emoji) { const rc = state.contacts.get(from); announceToScreenReader(T("a11y.reactionFrom", { name: (rc && rc.name) || T("sys.someone"), emoji: payload.emoji })); } } catch (e) {}
  } else if (kind === "contact-card") {
    const c = ensureContactEntry(from, null);
    if (c.messages.some((m) => m.id === payload.id)) return;
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: "", ts: safeMsgTs(payload.ts), readAckSent: false, deliveryId: envelopeMsgId, contactCard: { id: payload.contactId, name: payload.contactName || "", servers: ServerList.decodeHints(payload.srv, { allowLocal: srvAllowLocal() }) } };
    if (payload.forwarded) { rec.forwarded = true; if (typeof payload.fwdFrom === "string" && payload.fwdFrom) rec.forwardedFrom = payload.fwdFrom.slice(0, 40); }
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now();
    persistContacts();
    const previewText = T("chat.contactCard.preview", { name: payload.contactName || T("sys.someone") });
    if (isOpen) { renderChatThread(); playMessageSound(from); vibrate([80, 40, 80]); }
    else {
      toast(`${c.name}: ${previewText}`);
      if (!isContactMuted(c)) showNotification(c.name || T("app.name"), previewText, { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
      playMessageSound(from);
      vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    updateAppBadge();
  } else if (kind === "disappearing-timer") {
    const c = ensureContactEntry(from, null);
    const ms = payload.timer ? safeTtl(payload.timer) : 0;
    if (payload.timer && !ms) return; // мусорное значение (не число, слишком мало/велико) не принимаем
    if (c.disappearingTimer === ms) return;
    c.disappearingTimer = ms;
    addDisappearingSystemMessage(c, ms, false);
    c.lastActivity = Date.now();
    persistContacts();
    if (state.chatId === from) renderChatThread();
    if (state.tab === "chats") renderChatsList();
  } else if (kind === "group-admin") {
    handleGroupAdmin(from, payload).catch((e) => etherLog("warn", "[group-admin]", String(e)));
  } else if (kind === "gk-dist") {
    handleGkDist(from, payload);
  } else if (kind === "gk-req") {
    handleGkReq(from, payload);
  } else if (kind === "group-join-request") {
    // Приглашённый по invite-ссылке (см. joinGroupViaInvite) просит
    // добавить его в группу. Генерировать ссылку мог только админ (кнопка
    // скрыта у остальных в openGroupInfo), но проверяем права здесь ещё
    // раз — на случай старого клиента/модифицированного кода, а не
    // доверяем одной лишь UI-видимости кнопки на другой стороне.
    const g = state.contacts.get(payload.groupId);
    if (!g || !g.isGroup || !isGroupAdmin(g, Store.myId)) return;
    if (g.members.some((m) => m.id === from)) return; // уже участник — дублирующийся запрос
    if (Array.isArray(g.banned) && g.banned.includes(from)) return; // исключён админом — вернуть его может только сам админ вручную
    if (g.members.length >= groupMemberLimit(g.members.map((m) => m.id).concat(from))) return;
    ensureContactEntry(from, payload.requesterName || null);
    if (!payload.exp && !payload.ap && !payload.sg) { // обычная ссылка без срока: синхронно
      if (g.joinApproval) groupQueueJoin(g, from, payload.requesterName); else addGroupMember(payload.groupId, from);
    } else checkJoinRequest(g, from, payload).then((ok) => {
      if (!ok) return;
      if (payload._needApproval) groupQueueJoin(g, from, payload.requesterName);
      else addGroupMember(payload.groupId, from);
    }).catch(() => {});
    try { if (typeof fxReferralInviterHit === "function") fxReferralInviterHit(from); } catch (e) {}
  } else if (kind === "id-migrate") {
    handleIdMigrateNotice(from, payload).catch((e) => etherLog("warn", "[idmig] notice:", String(e)));
  } else if (kind === "rc-reset") {
    handleRatchetResetRequest(from);
  } else if (kind === "heartbeat") {
    // killer-features-backlog 0.5 — "мягкий" Dead Man's Switch: "я жив",
    // отправляется из checkDeadManSwitch() при каждом запуске отправителя.
    // Полностью тихо — ни сообщения в ленте, ни тоста, ни бейджа
    // непрочитанного: получатель узнаёт об этом только если сам
    // настроил наблюдение и у него сработает проверка в checkDeadManSwitch().
    const c = state.contacts.get(from); if (!c) return;
    if (payload.off) { // A3: отправитель выключил режим — снимаем наблюдение молча
      delete c.lastHeartbeatAt; delete c.heartbeatThresholdDays; delete c.heartbeatAlertedAt;
      persistContacts();
      return;
    }
    const nowTs = Date.now();
    c.lastHeartbeatAt = (typeof payload.ts === "number" && isFinite(payload.ts) && payload.ts > 0 && payload.ts <= nowTs + 60000) ? payload.ts : nowTs;
    const thr = Number(payload.thresholdDays);
    if (isFinite(thr) && thr >= 1 && thr <= 3650) c.heartbeatThresholdDays = Math.floor(thr);
    delete c.heartbeatAlertedAt; // новый heartbeat пришёл — отправитель снова "на связи", сбрасываем отметку уже показанного предупреждения
    persistContacts();
  }
}
function clearAutoConnectTimer(id) { const t = autoConnectTimers.get(id); if (t) clearTimeout(t); autoConnectTimers.delete(id); }
// =====================================================================
// Relay-сигналинг через общий контакт (без сигнального сервера)
// =====================================================================
//
// Если я уже P2P-подключён к X, а X уже P2P-подключён к T (тому, кого я
// хочу добавить) — X может разово передать между нами offer/answer прямо
// по уже открытым зашифрованным каналам, без сигнального сервера вообще.
// Пересылка — ровно на один хоп (я → X → T и обратно), без дальнейшей
// маршрутизации по цепочке: так надёжнее и не нужно думать про циклы.
//
//   relay-request           я → X:  "передай этот offer контакту T"
//   relay-deliver           X → T:  "вот offer от меня-через-X"
//   relay-deliver-response  T → X:  "вот ответ, верни его обратно"
//   relay-response          X → я:  "вот ответ от T"

function handleRelayPayload(viaId, payload) {
  if (payload.kind === "relay-request") {
    const target = mesh.get(payload.to);
    if (target && target.status === "connected") {
      target.send({ kind: "relay-deliver", from: viaId, packet: payload.packet });
    }
    // Если T через меня недостижим — молча ничего не делаем: запрашивающий
    // либо получит ответ от другого общего контакта, либо не получит вовсе.
    return;
  }
  // Ретранслятор подставляет чужое from: принимаем только от уже известных, не заблокированных контактов (фантомные контакты не создаём)
  if (payload.kind === "relay-deliver" || payload.kind === "relay-response") {
    const rc = typeof payload.from === "string" ? state.contacts.get(payload.from) : null;
    if (!rc || rc.blocked || isGroup(rc) || payload.from === Store.myId) return;
  }
  if (payload.kind === "relay-deliver") {
    if (isDuplicateSignal(payload.from, payload.packet)) return;
    handleIncomingOffer(payload.from, payload.packet, (answer) => {
      const backToRelay = mesh.get(viaId);
      if (backToRelay) backToRelay.send({ kind: "relay-deliver-response", to: payload.from, packet: answer });
    });
    return;
  }
  if (payload.kind === "relay-deliver-response") {
    const requester = mesh.get(payload.to);
    if (requester) requester.send({ kind: "relay-response", from: viaId, packet: payload.packet });
    return;
  }
  if (payload.kind === "relay-response") {
    if (isDuplicateSignal(payload.from, payload.packet)) return;
    handleIncomingAnswer(payload.from, payload.packet);
  }
}

// Пробуем достучаться до contactId через ЛЮБОЙ из уже подключённых
// контактов — полезно, когда цель не видна через сигнальный сервер
// (свой/другой сервер, временно офлайн на сервере), но у нас есть общий
// знакомый, который сейчас с ней на связи.
const relayAttemptCooldown = new Map();
// Прогрессивный cooldown для цели, которую сигнальный сервер только что
// назвал недоступной. Раньше был только плоский relayAttemptCooldown=60с,
// и в группах с офлайн-участниками это давало лавину попыток каждые
// несколько секунд (видно в логах: [signaling] недоступен: dd7315da01…
// раз в 200мс). Теперь cooldown растёт: 60с → 5мин → 30мин.
const _unreachableCooldown = new Map(); // id -> { until, failures }
function isUnreachableCooldown(id) {
  const entry = _unreachableCooldown.get(id);
  if (!entry) return false;
  return Date.now() < entry.until;
}
function markUnreachable(id) {
  const now = Date.now();
  const entry = _unreachableCooldown.get(id) || { failures: 0 };
  entry.failures = (entry.failures || 0) + 1;
  const delay = entry.failures === 1 ? 60_000
              : entry.failures === 2 ? 5 * 60_000
              : 30 * 60_000;
  entry.until = now + delay;
  _unreachableCooldown.set(id, entry);
}
function clearUnreachable(id) {
  if (_unreachableCooldown.delete(id)) {
    etherLog("info", "[connect] " + String(id).slice(0, 10) + "…", "cooldown сброшен (presence online)");
  }
}
// Увеличено с 15с до 60с: реальный провал relay (цель не в сети у хаба)
// выясняется за 10-20 секунд. Пока не пройдёт минута, повторять
// бессмысленно — только плодим мёртвые PeerLink'и, которые висят в
// "connecting" и засоряют diagnostics.
const RELAY_COOLDOWN_MS = 60000;

async function attemptConnectViaRelay(targetId) {
  { const bc = state.contacts.get(targetId); if (bc && bc.blocked) return; }
  const existing = mesh.get(targetId);
  if (existing && existing.status !== "disconnected") return;
  if (_connectInFlight.has(targetId)) return;
  const lastTry = relayAttemptCooldown.get(targetId);
  if (lastTry && Date.now() - lastTry < RELAY_COOLDOWN_MS) return;
  // Помечаем попытку СРАЗУ — раньше cooldown ставился только когда
  // не было ни одного relay-контакта, а при НАЛИЧИИ relay мы пробовали
  // снова и снова каждые 4 секунды (scheduleAutoConnect), плодя
  // PeerLink'и на заведомо недостижимые цели.
  relayAttemptCooldown.set(targetId, Date.now());
  const relays = Array.from(mesh.links.entries()).filter(([rid, l]) => rid !== targetId && l.status === "connected");
  if (relays.length === 0) return;
  _connectInFlight.add(targetId);
  try {
    const link = mesh.createOutgoingLink(targetId);
    flushPendingIceFor(targetId, link);
    const packet = await link.createInitialOffer("");
    if (!packet) { mesh.remove(targetId); return; }
    // Сначала просто send relay-request всем connected-relay'ям.
    for (const [, relayLink] of relays) relayLink.send({ kind: "relay-request", to: targetId, packet });
    watchConnectionTimeout(targetId);
  } catch (e) {
    etherLog("error", "[relay] createInitialOffer failed:", String(e));
    mesh.remove(targetId);
  } finally {
    _connectInFlight.delete(targetId);
  }
}

function scheduleAutoConnect(id) {
  const delay = connectRetryDelayMs(id);
  // Только одна отложенная попытка на контакт (было: немедленная +
  // ещё одна через 4с). Короткая задержка нужна, чтобы дать встречной
  // стороне тоже увидеть presence — тогда тай-брейк по id отработает
  // за нас и мы избежим столкновения двух offer'ов. При presence
  // нескольких контактов одновременно (например, сразу после
  // входа в группу) немедленный вызов давал всплеск PeerLink'ов.
  if (autoConnectTimers.has(id)) return;
  autoConnectTimers.set(id, setTimeout(() => {
    autoConnectTimers.delete(id);
    attemptConnect(id);
    attemptConnectViaRelay(id).catch(() => {});
  }, delay));
}
const _notMyTurnLogAt = new Map();

async function attemptConnect(id, force) {
  const tag = String(id).slice(0, 10) + "…";
  { const bc = state.contacts.get(id); if (bc && bc.blocked) return; }
  if (!signaling || !signaling.connected) return;
  if (!onlineSet.has(id) && !force) return;
  if (!force && isUnreachableCooldown(id)) return;
  const iShouldOffer = myIdFor(id) < id;
  if (!iShouldOffer && !force) {
    const last = _notMyTurnLogAt.get(id);
    if (!last || Date.now() - last > 30000) {
      _notMyTurnLogAt.set(id, Date.now());
      etherLog("info", "[connect] " + tag, "not my turn");
    }
    return;
  }
  if (_connectInFlight.has(id)) return;
  _connectInFlight.add(id);
  try {
    const existing = mesh.get(id);
    if (existing) {
      const age = Date.now() - (existing._createdAt || 0);
      if (existing.status === "connected" || existing.status === "in-call") return;
      if (!force && existing.status === "connecting" && age < CONNECT_STUCK_MS) return;
      mesh.remove(id);
    }
    const link = mesh.createOutgoingLink(id);
    flushPendingIceFor(id, link);
    try {
      const packet = await link.createInitialOffer("");
      if (!packet) return;
      // Результат signal() раньше игнорировался молча — если WS в этот
      // момент отвалился, offer просто терялся без следа в диагностике,
      // и единственным симптомом было "почему-то не подключается".
      if (!signaling.signal(id, packet)) etherLog("warn", "[connect] " + tag, "signal офера не отправлен (WS не готов)");
      watchConnectionTimeout(id);
    } catch (e) {
      mesh.remove(id);
      const c = state.contacts.get(id); if (c) c.status = "disconnected";
      if (state.chatId === id) renderChatThread();
      if (state.tab === "chats") renderChatsList();
    }
  } finally {
    _connectInFlight.delete(id);
  }
}
function watchConnectionTimeout(id) {
  // Следим именно за ЭТИМ экземпляром линка. Раньше таймер смотрел на mesh.get(id) в момент срабатывания:
  // если за 10 с линк уже был заменён новой попыткой, таймер убивал свежий, ещё нормально
  // подключающийся линк — отсюда пары «offer, и через 0,8 с ещё один» и вечный цикл переподключений.
  const watched = mesh.get(id);
  setTimeout(() => {
    const link = mesh.get(id);
    if (!link || link !== watched || link.status === "connected" || link.status === "in-call" || link.status === "disconnected") return;
    connectFails.set(id, (connectFails.get(id) || 0) + 1);
    etherLog("info", "[connect] " + String(id).slice(0, 10) + "…", "не подключились, неудач подряд: " + connectFails.get(id) + "; следующая попытка через " + Math.round(connectRetryDelayMs(id) / 1000) + " с");
    mesh.remove(id);
    const c = state.contacts.get(id);
    if (c) {
      c.status = "disconnected";
      if (state.chatId === id) renderChatThread();
      if (state.tab === "chats") renderChatsList();
      if (c.managed && c.online) scheduleAutoConnect(id);
    }
  }, connectWaitMs(id) + (watched && watched._relayOnly ? 14000 : 0));
}

// =====================================================================
// Онлайн-список
// =====================================================================
function renderOnlineRosterList() {
  const wrap = $("#online-roster-list"), empty = $("#online-roster-empty");
  if (!wrap) return;
  wrap.innerHTML = "";
  const rows = Array.from(onlineRoster.entries()).filter(([id, u]) => id !== Store.myId && u.visible !== false && !state.contacts.has(id));
  if (rows.length === 0) { if (empty) empty.classList.remove("hidden"); return; }
  if (empty) empty.classList.add("hidden");
  for (const [id, u] of rows) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(u.name || id)}">${escapeHtml(initials(u.name || "?"))}</div>
      <span class="roster-name">${escapeHtml(u.name || T("sys.someone"))}</span>
      <button type="button" class="btn-secondary roster-add-btn">${escapeHtml(T("connect.addButton"))}</button>`;
    row.querySelector(".roster-add-btn").addEventListener("click", () => {
      if (recentlyDeletedIds.delete(id)) persistRecentlyDeleted(); // осознанное повторное добавление снимает блокировку из deleteContact
      state.contacts.set(id, {
        id, name: (typeof u.name === "string" ? u.name.slice(0, 40) : "") || T("sys.someone"), raw: "", managed: true,
        publicKey: u.publicKey || null, online: true, status: "disconnected",
        messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false,
      });
      persistContacts();
      toast(T("toast.contactAdded"));
      scheduleAutoConnect(id);
      renderOnlineRosterList();
      renderContactsList();
      state.tab = "chats";
      renderTab();
    });
    wrap.appendChild(row);
  }
}


// =====================================================================
// Миграция id v1 -> v2 (docs/AUDIT-V76.md C2, docs/PRIVACY.md)
// =====================================================================
// v1: id = SHA-256("ether:" + телефон/почта) - без соли, перебирается по всему пространству номеров. v2 = "v2:" + PBKDF2-SHA256 (600 000 итераций).
// Порядок миграции (один раз, после разблокировки, когда сервер объявил feature "alias"):
//  1. из сохранённого телефона/почты считается id v2 (deriveBits вне главного потока; интерфейсу сначала отдаётся кадр);
//  2. личность без телефона (случайный id) просто помечается перенесённой: id не меняется;
//  3. сохраняется состояние ether.idMig и Store.myId меняется на v2; сокет перерегистрируется под новым id (claim-токен тот же, claim старого id
//     остаётся нетронутым) и просит сервер поставить АЛИАС старый -> новый на 90 суток (alias-set: сервер сверяет оба claim-а);
//  4. каждому контакту уходит подписанное долгосрочным ключом уведомление id-migrate {old,new,ts,sig}; получатель проверяет подпись ключом,
//     известным ему за старый id, и переименовывает контакт с сохранением истории (renameContactId). Ratchet-сессия пары начинается заново.
//  5. пока контакт не перешёл (legacyPeers), я для него остаюсь старым id: шифрую с парой (старый id, его id) и шлю с полем as=старый id -
//     сервер штампует from=старый id только если алиас принадлежит этому сокету. Так существующие ratchet-сессии и чаты с необновившимися
//     контактами продолжают работать 90 суток без сбоя; как только расшифровка с новым id удалась, контакт считается перешедшим.
const IDMIG_KEY = "ether.idMig", IDMIG_WINDOW_MS = 90 * 86400_000, IDMIG_NOTICE_MAX_AGE_MS = 150 * 86400_000;
let __idMigRaw, __idMigObj = null, __idMigRunning = null;
function idMigGet() {
  let raw = null; try { raw = localStorage.getItem(IDMIG_KEY); } catch (e) {}
  if (raw === __idMigRaw) return __idMigObj;
  let o = null; try { o = raw ? JSON.parse(raw) : null; } catch (e) { o = null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) o = null;
  if (o) {
    if (!Array.isArray(o.peers)) o.peers = [];
    if (!o.notices || typeof o.notices !== "object" || Array.isArray(o.notices)) o.notices = {};
    if (!o.renames || typeof o.renames !== "object" || Array.isArray(o.renames)) o.renames = {};
  }
  __idMigRaw = raw; __idMigObj = o; return o;
}
function idMigUpdate(fn) {
  const m = idMigGet() || { v: 1 };
  if (!Array.isArray(m.peers)) m.peers = [];
  if (!m.notices || typeof m.notices !== "object") m.notices = {};
  if (!m.renames || typeof m.renames !== "object") m.renames = {};
  fn(m);
  try { localStorage.setItem(IDMIG_KEY, JSON.stringify(m)); scheduleIDBBackup(); } catch (e) {}
  __idMigRaw = undefined; // кэш недействителен: следующий idMigGet перечитает запись
  return m;
}
const idMigWindowOpen = (m) => !!(m && m.legacyId && Number(m.until) > Date.now());
function idMigLegacyId() { const m = idMigGet(); return idMigWindowOpen(m) ? m.legacyId : ""; }
// Для этого собеседника я пока «старый id»: сервер подтвердил алиас, окно 90 суток открыто, контакт ещё не показал, что знает мой новый id
function idMigIsLegacyPeer(peerId) { const m = idMigGet(); return idMigWindowOpen(m) && m.aliasOk === true && m.peers.includes(peerId); }
// Мой id в паре с этим собеседником (ratchet, AAD конвертов, аутентификация P2P-канала, тай-брейк offerer)
function myIdFor(peerId) { return idMigIsLegacyPeer(peerId) ? idMigGet().legacyId : Store.myId; }
// Старый id контакта, уже переименованного по уведомлению, -> его текущий id (запоздавшие сообщения/сигналы с прежним from)
function canonPeer(id) {
  const m = idMigGet(); let r = id, n = 0;
  while (m && typeof r === "string" && Object.prototype.hasOwnProperty.call(m.renames, r) && typeof m.renames[r] === "string" && n++ < 5) r = m.renames[r];
  return r;
}
// Какие «мои id» пробовать при расшифровке входящего от from: ожидаемый для пары, затем второй (если окно миграции открыто)
function idMigDecryptIds(from) {
  const m = idMigGet(), pri = myIdFor(from);
  if (!idMigWindowOpen(m)) return [pri];
  return [pri, pri === Store.myId ? m.legacyId : Store.myId];
}
async function idMigDecrypt(from, fn) {
  const ids = idMigDecryptIds(from); let err = null;
  for (let i = 0; i < ids.length; i++) {
    try {
      const r = await fn(ids[i]);
      if (i > 0) { // подошёл второй id: собеседник обращается ко мне иначе, чем мы считали
        const legacy = ids[i] !== Store.myId;
        idMigUpdate((m) => { const has = m.peers.includes(from); if (legacy && !has) m.peers.push(from); else if (!legacy && has) m.peers = m.peers.filter((x) => x !== from); });
        try { envelopeCache.clear(); } catch (e) {}
      }
      return r;
    } catch (e) { if (!err) err = e; }
  }
  throw err;
}
function idMigProgress(on) {
  try { if (on) updateSignalingStatusUI("connecting", T("idmig.working")); else refreshSignalingStatusText(); } catch (e) {}
}
// Загрузка приложения: если прошлый запуск сохранил состояние миграции, но не успел сменить id - достраиваем (без сети и без перезапуска сокета)
function idMigBootFix() {
  const m = idMigGet();
  if (!(m && m.done && m.newId && m.legacyId && Store.myId === m.legacyId)) return false;
  Store.myId = m.newId; renameIdEverywhere(m.legacyId, m.newId); persistContacts();
  return true;
}
// Привязка к соединению: параметры алиаса и запуск миграции, когда сервер подтвердил регистрацию
function idMigWireSignaling(sig) {
  const m = idMigGet();
  if (idMigWindowOpen(m)) { sig.legacyId = m.legacyId; sig.legacyFor = idMigIsLegacyPeer; sig.aliasOld = m.legacyId; sig.aliasActive = m.aliasOk === true; }
  sig.addEventListener("alias-result", (ev) => { try { idMigOnAliasResult(sig, ev.detail || {}); } catch (e) { etherLog("warn", "[idmig] alias-result:", String(e)); } });
  sig.addEventListener("online-list", () => { try { idMigOnRegistered(sig); } catch (e) { etherLog("warn", "[idmig] boot:", String(e)); } });
  // Ключ контакта становится известен позже (ростер/присутствие) - тогда и уходит ему уведомление; запуск отложен, чтобы сначала отработали обработчики приложения
  let t = null;
  const later = () => { if (t) return; t = setTimeout(() => { t = null; const mm = idMigGet(); if (signaling === sig && mm && idMigWindowOpen(mm) && mm.aliasOk === true) idMigSendNotices().catch(() => {}); }, 400); };
  sig.addEventListener("presence", later); sig.addEventListener("online-list", later);
}
function idMigShouldRun() {
  if (!Store.myId || !Store.myPrivateKeyJwk) return false;
  if (typeof Devices !== "undefined" && Devices.isCompanion()) return false; // companion следует id основного устройства
  const m = idMigGet();
  return !(m && m.done);
}
function idMigOnRegistered(sig) {
  if (signaling !== sig || !sig.registered || !Array.isArray(sig.features) || !sig.features.includes("alias")) return;
  const m = idMigGet();
  if (m && m.done && m.newId && Store.myId === m.legacyId) { idMigApplySwitch(m.legacyId, m.newId); return; } // сбой посреди миграции: достраиваем переключение
  if (m && m.done) {
    if (m.legacyId && !idMigWindowOpen(m) && !m.expired) idMigUpdate((x) => { x.expired = true; x.peers = []; });
    else if (idMigWindowOpen(m) && m.aliasOk === true) idMigSendNotices().catch(() => {});
    return;
  }
  if (sig.claimed !== true) return; // без закреплённого claim старого id алиас не поставить: дождёмся подключения, где сервер его закрепил
  if (idMigShouldRun()) idMigRun({}).then((r) => { if (r && r.status === "migrated") idMigShowSheet(); }).catch((e) => etherLog("warn", "[idmig] run:", String(e)));
}
// Единственный вход миграции. opts.iterations - ТОЛЬКО для тестов (явный параметр; в приложении не передаётся), opts.onProgress - необязательный
function idMigRun(opts) {
  if (__idMigRunning) return __idMigRunning;
  return (__idMigRunning = idMigRunInner(opts || {}).finally(() => { __idMigRunning = null; }));
}
async function idMigRunInner(opts) {
  const m0 = idMigGet();
  if (m0 && m0.done) return { status: "done" };
  const oldId = Store.myId, raw = Store.myIdentityRaw;
  if (!oldId) return { status: "no-id" };
  if (Identity.isV2(oldId)) { idMigUpdate((m) => { m.done = true; m.fresh = true; m.at = Date.now(); }); return { status: "v2" }; }
  if (!raw) { idMigUpdate((m) => { m.done = true; m.anon = true; m.at = Date.now(); }); return { status: "anon" }; } // случайный id: не из номера, менять нечего
  let r;
  idMigProgress(true);
  try { r = await Identity.idV2ForAsync(raw, { iterations: opts.iterations, onProgress: opts.onProgress }); }
  catch (e) { idMigProgress(false); return { status: "error", error: String(e) }; }
  idMigProgress(false);
  if (Store.myId !== oldId || Store.myIdentityRaw !== raw) return { status: "aborted" }; // за время вывода id сменили вручную
  if (r.idV1 !== oldId) { idMigUpdate((m) => { m.done = true; m.anon = true; m.at = Date.now(); }); return { status: "anon" }; } // id не соответствует сохранённому номеру
  const newId = r.id, ts = Date.now();
  const peers = [];
  for (const c of state.contacts.values()) if (!c.isGroup && !c.isSelf && !c.isDemo && c.id && c.id !== oldId && !c.id.startsWith("__")) peers.push(c.id);
  // Устройства аккаунта: сертификаты и список перевыпускаются под новый id; companion получает подписанную команду, пока мы ещё под старым id
  let devs = 0;
  try { if (typeof Devices !== "undefined" && Devices.migrateAnnounce) devs = await Devices.migrateAnnounce(oldId, newId, ts); } catch (e) { etherLog("warn", "[idmig] devices:", String(e)); }
  const notice = await DeviceCert.signIdMigrate(Store.myPrivateKeyJwk, { old: oldId, new: newId, ts });
  idMigUpdate((m) => { Object.assign(m, { done: true, at: ts, legacyId: oldId, newId, until: ts + IDMIG_WINDOW_MS, peers, notice, aliasOk: undefined, devices: devs }); });
  idMigApplySwitch(oldId, newId);
  return { status: "migrated", oldId, newId, peers: peers.length };
}
// Переключение локального состояния на новый id (идемпотентно: можно вызывать повторно после сбоя)
function idMigApplySwitch(oldId, newId) {
  try { discoveryUnpublishBeforeIdChange(); } catch (e) {}
  Store.myId = newId;
  renameIdEverywhere(oldId, newId);
  try { envelopeCache.clear(); } catch (e) {}
  state._discoveryDirty = true;
  persistContacts();
  initSignaling();
  try { renderTab(); } catch (e) {}
}
function idMigOnAliasResult(sig, d) {
  const m = idMigGet(); if (!m || !m.legacyId || d.old !== m.legacyId) return;
  const ok = d.ok === true;
  idMigUpdate((x) => { x.aliasOk = ok; x.aliasErr = ok ? undefined : d.error || "error"; });
  sig.aliasActive = ok;
  if (!ok) {
    etherLog("warn", "[idmig] алиас не установлен:", String(d.error));
    if (d.error === "old-claim" || d.error === "no-claim") { try { Ratchet.resetAll(); envelopeCache.clear(); } catch (e) {} } // без алиаса сессии пар со старым id бесполезны; контакты узнают о смене по уведомлению
  }
  idMigSendNotices().catch((e) => etherLog("warn", "[idmig] notices:", String(e)));
}
// Подписанное уведомление каждому контакту (через обычную очередь отправки: ретраи, ящик сервера для офлайн, статический конверт v1/v2)
async function idMigSendNotices() {
  const m = idMigGet(); if (!m || !m.newId || !m.legacyId || !m.notice || !Store.myPrivateKeyJwk) return 0;
  let n = 0;
  for (const c of Array.from(state.contacts.values())) {
    if (c.isGroup || c.isSelf || c.isDemo || !c.id || c.id === Store.myId || m.notices[c.id] || !c.publicKey || c.blocked) continue;
    const msgId = crypto.randomUUID();
    addToOutbox(msgId, c.id, { kind: "id-migrate", id: msgId, old: m.notice.old, new: m.notice.new, ts: m.notice.ts, sig: m.notice.sig });
    const e = outbox.get(msgId); if (e) e.forceV1 = true; // статический ключ: уведомление должно открыться при любом состоянии ratchet
    idMigUpdate((x) => { x.notices[c.id] = Date.now(); });
    n++;
    flushOutboxItem(msgId);
  }
  return n;
}
// Получатель уведомления. from - id отправителя после canonPeer. opts.viaSync - применение, пересланное другим моим устройством (транспортный from не проверяется)
async function handleIdMigrateNotice(from, p, opts) {
  opts = opts || {};
  if (!p || typeof p !== "object" || typeof p.old !== "string" || typeof p.new !== "string" || typeof p.sig !== "string" || !Number.isFinite(p.ts)) return false;
  if (!p.old || p.old.length > 128 || !Identity.isV2(p.new) || p.old === p.new || p.sig.length > 200) return false;
  if (!opts.viaSync && from !== p.old && from !== p.new) return false; // уведомление приходит либо со старого id (через алиас), либо с нового
  const now = Date.now();
  if (p.ts > now + 86400_000 || now - p.ts > IDMIG_NOTICE_MAX_AGE_MS) return false;
  if (p.new === Store.myId || p.new === idMigLegacyId() || p.old === Store.myId) return false;
  const known = idMigGet();
  const c = state.contacts.get(p.old);
  if (!c) return !!(known && known.renames[p.old] === p.new); // уже применено ранее (повтор) - не ошибка
  if (c.isGroup || c.isSelf || c.isDemo || !c.publicKey) return false;
  if (!(await DeviceCert.verifyIdMigrate(c.publicKey, p))) { etherLog("warn", "[idmig] подпись уведомления не сошлась, игнорирую"); return false; }
  const ex = state.contacts.get(p.new);
  if (ex && (ex.isGroup || ex.isSelf || (ex.publicKey && keysDiffer(ex.publicKey, c.publicKey)))) return false; // новый id уже занят другим человеком
  const nc = renameContactId(p.old, p.new); if (!nc) return false;
  idMigUpdate((m) => {
    m.renames[p.old] = p.new;
    const keys = Object.keys(m.renames); if (keys.length > 2000) delete m.renames[keys[0]];
    if (m.peers.includes(p.old)) m.peers = m.peers.map((x) => (x === p.old ? p.new : x));
    if (m.notices[p.old] !== undefined) { m.notices[p.new] = m.notices[p.old]; delete m.notices[p.old]; }
  });
  try { envelopeCache.clear(); } catch (e) {}
  pushSystemNote(nc, "sys.peerIdUpdated", { name: nc.name || T("sys.someone") });
  if (!opts.viaSync && typeof Devices !== "undefined" && !Devices.isCompanion()) { try { Devices.sendOp({ kind: "peer-rename", notice: { old: p.old, new: p.new, ts: p.ts, sig: p.sig } }, p.new).catch(() => {}); } catch (e) {} }
  try { flushOutbox(); } catch (e) {}
  if (state.tab === "chats") renderChatsList();
  return true;
}
// Роли/участники во входящем ростере группы: мой старый id -> новый, уже переименованные контакты -> их новые id
function idMigNormalizeGroupPayload(payload) {
  const m = idMigGet(); if (!m || !payload || !Array.isArray(payload.members)) return;
  const map = (id) => (id === m.legacyId && id ? Store.myId : canonPeer(id));
  const seen = new Set(), out = [];
  for (const mem of payload.members) { const nid = map(mem.id); if (seen.has(nid)) continue; seen.add(nid); out.push(nid === mem.id ? mem : Object.assign({}, mem, { id: nid })); }
  payload.members = out;
  if (typeof payload.createdBy === "string") payload.createdBy = map(payload.createdBy);
}
// Исходящий ростер для контакта, который ещё знает меня под старым id: мой новый id заменяется старым (иначе у него появится «чужой» участник)
function idMigGroupPayloadFor(payload, memberId) {
  if (!idMigIsLegacyPeer(memberId) || !Array.isArray(payload.members)) return;
  const legacy = idMigGet().legacyId;
  payload.members = payload.members.map((mem) => (mem && mem.id === Store.myId ? Object.assign({}, mem, { id: legacy }) : mem));
  if (payload.createdBy === Store.myId) payload.createdBy = legacy;
}
// Одноразовое пояснение для пользователя (текст - только в js/lang)
async function idMigShowSheet() {
  const m = idMigGet(); if (!m || m.sheetShown || !m.legacyId) return;
  idMigUpdate((x) => { x.sheetShown = true; });
  try { await confirmSheet(T("idmig.sheet"), { okLabel: T("idmig.ok"), cancelLabel: T("idmig.close") }); } catch (e) {}
}
// Новый или изменённый id из номера/почты: сразу v2 (медленный вывод с индикатором). opts.iterations - только тесты.
async function idMigDeriveNewIdentity(raw, opts) {
  opts = opts || {};
  const r = await Identity.idV2ForAsync(raw, { iterations: opts.iterations, onProgress: opts.onProgress });
  return { id: r.id, normalized: r.normalized, type: r.type, idV1: r.idV1 };
}
