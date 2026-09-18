"use strict";

// Сервер, прописанный по умолчанию — можно изменить в Настройках.
const DEFAULT_SIGNALING_URL = "wss://ether-1-baqy.onrender.com";

function effectiveSignalingUrl() {
  return (Store.signalingUrl || DEFAULT_SIGNALING_URL).trim();
}

// ---------- Хранилище ----------

const Store = {
  get name() { return localStorage.getItem("ether.name") || ""; },
  set name(v) { localStorage.setItem("ether.name", v); },

  get myIdentityRaw() { return localStorage.getItem("ether.identityRaw") || ""; },
  set myIdentityRaw(v) { localStorage.setItem("ether.identityRaw", v); },

  get myId() { return localStorage.getItem("ether.myId") || ""; },
  set myId(v) { localStorage.setItem("ether.myId", v); },

  get signalingUrl() { return localStorage.getItem("ether.signalingUrl") || ""; },
  set signalingUrl(v) { localStorage.setItem("ether.signalingUrl", v); },

  get discoverable() { return localStorage.getItem("ether.discoverable") !== "0"; },
  set discoverable(v) { localStorage.setItem("ether.discoverable", v ? "1" : "0"); },

  get contactsJson() { return localStorage.getItem("ether.contacts") || "[]"; },
  set contactsJson(v) { localStorage.setItem("ether.contacts", v); },

  get myPrivateKeyJwk() {
    try {
      const v = localStorage.getItem("ether.privKey");
      return v ? JSON.parse(v) : null;
    } catch (e) {
      return null; // повреждённая запись — не роняем запуск приложения из-за нее
    }
  },
  set myPrivateKeyJwk(v) { localStorage.setItem("ether.privKey", JSON.stringify(v)); },
  get myPublicKeyJwk() {
    try {
      const v = localStorage.getItem("ether.pubKey");
      return v ? JSON.parse(v) : null;
    } catch (e) {
      return null;
    }
  },
  set myPublicKeyJwk(v) { localStorage.setItem("ether.pubKey", JSON.stringify(v)); },

  get glassAlpha() { return parseFloat(localStorage.getItem("ether.glassAlpha") || "0.5"); },
  set glassAlpha(v) { localStorage.setItem("ether.glassAlpha", String(v)); },

  get theme() { return localStorage.getItem("ether.theme") || "auto"; },
  set theme(v) { localStorage.setItem("ether.theme", v); },
};

// ---------- Состояние ----------

const state = {
  tab: "chats",
  chatId: null,
  callId: null,
  callPhase: null, // "calling" | "ringing" | "active"
  pendingOutgoing: null, // ручной поток (без сервера)
  contacts: new Map(), // id -> { id, name, raw, managed, online, status, messages, lastActivity }
};

let mesh;
let signaling = null;
const onlineSet = new Set();
const onlineRoster = new Map(); // id -> { name, visible, publicKey } — все, кто сейчас зарегистрирован на сервере
const autoConnectTimers = new Map();
const recentSignalNonces = new Set(); // защита от повторной обработки одного и того же offer/answer

// ---------- Гарантированная доставка: очереди и сопоставление квитанций ----------
const pendingAcks = new Map(); // msgId (наше исходящее сообщение) -> contactId, чтобы применять входящие квитанции
const outbox = new Map(); // msgId -> { to, envelope, fromPublicKey } — конверты, не дошедшие до сервера, на повтор при переподключении
const pendingNoKey = new Map(); // contactId -> [{ msgId, payload }] — ждут, пока не узнаем публичный ключ контакта
const seenDeliverIds = new Set(); // защита от повторной обработки одного и того же конверта из "deliver"

function isDuplicateSignal(from, packet) {
  if (!packet || !packet.x) return false; // старый формат без метки — не фильтруем
  const key = from + ":" + packet.x;
  if (recentSignalNonces.has(key)) return true;
  recentSignalNonces.add(key);
  if (recentSignalNonces.size > 200) recentSignalNonces.delete(recentSignalNonces.values().next().value);
  return false;
}

// ---------- Утилиты интерфейса ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function applyGlassAlpha(v) {
  document.documentElement.style.setProperty("--glass-alpha", v.toFixed(2));
  document.documentElement.style.setProperty("--glass-blur", (14 + v * 26).toFixed(0) + "px");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

// ---------- Онбординг ----------

function initOnboarding() {
  if (Store.name && Store.myId) {
    $("#onboarding").classList.add("hidden");
    ensureKeyPair().then(startApp).catch((e) => { etherLog("error", "[boot] сбой при запуске:", String(e)); startApp(); }); // на случай апгрейда с версии без шифрования
    return;
  }
  $("#onboarding").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
  if (Store.name) $("#onboarding-name").value = Store.name;

  $("#onboarding-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nameVal = $("#onboarding-name").value.trim();
    const idVal = $("#onboarding-identity").value.trim();
    if (!nameVal || !idVal) return;
    let identity;
    try {
      identity = await Identity.idFor(idVal);
    } catch (err) {
      toast(err.message);
      return;
    }
    Store.name = nameVal;
    Store.myIdentityRaw = identity.normalized;
    Store.myId = identity.id;
    await ensureKeyPair();
    $("#onboarding").classList.add("hidden");
    startApp();
  });
}

// Ключевая пара для сквозного шифрования сообщений, которые приходится
// временно класть на сервер, пока контакт офлайн. Генерируется один раз
// на устройство и остаётся тут же — секретный ключ никуда не уходит.
// Если это по какой-то причине не удаётся (старый iOS, повреждённое
// хранилище и т.п.) — приложение всё равно должно запуститься: просто
// офлайн-доставка сообщений будет недоступна, а не весь экран станет
// пустым/серым из-за одного упавшего await в цепочке запуска.
async function ensureKeyPair() {
  try {
    if (Store.myPrivateKeyJwk && Store.myPublicKeyJwk) return;
    const { publicKeyJwk, privateKeyJwk } = await CryptoHelper.generateKeyPair();
    Store.myPrivateKeyJwk = privateKeyJwk;
    Store.myPublicKeyJwk = publicKeyJwk;
  } catch (e) {
    etherLog("error", "[crypto] не удалось создать ключевую пару, офлайн-доставка будет недоступна:", String(e));
  }
}

// ---------- Запуск приложения ----------

function startApp() {
  $("#onboarding").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  mesh = new MeshManager(Store.name);
  wireMeshEvents();
  wireTabBar();
  wireConnectScreen();
  wireChatScreen();
  wireCallScreen();
  wireSettingsScreen();

  applyGlassAlpha(Store.glassAlpha);
  applyTheme(Store.theme);
  $("#glass-slider").value = Store.glassAlpha;
  $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === Store.theme));
  $("#settings-name").value = Store.name;
  $("#settings-identity").value = Store.myIdentityRaw;
  $("#settings-signaling-url").value = Store.signalingUrl || DEFAULT_SIGNALING_URL;
  $("#settings-discoverable").checked = Store.discoverable;

  loadContacts();

  const incoming = SignalingCodec.extractCodeFromLocation();
  history.replaceState(null, "", location.pathname + location.search);
  if (incoming) handleIncomingCode(incoming, true);

  renderTab();
  initSignaling();
  registerServiceWorker();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

// ---------- Контакты (персистентные, по телефону/email) ----------

function loadContacts() {
  let arr = [];
  try { arr = JSON.parse(Store.contactsJson) || []; } catch (e) {}
  for (const c of arr) {
    state.contacts.set(c.id, {
      id: c.id, name: c.name, raw: c.raw || "", managed: true, publicKey: c.publicKey || null,
      online: false, status: "disconnected", messages: c.messages || [], lastActivity: c.lastActivity || 0,
    });
  }
}

function persistContacts() {
  const arr = Array.from(state.contacts.values())
    .filter((c) => c.managed)
    .map((c) => ({ id: c.id, name: c.name, raw: c.raw, publicKey: c.publicKey, messages: c.messages, lastActivity: c.lastActivity }));
  Store.contactsJson = JSON.stringify(arr);
}

function keysDiffer(a, b) {
  return JSON.stringify(a || null) !== JSON.stringify(b || null);
}

function ensureContactEntry(id, suggestedName) {
  let c = state.contacts.get(id);
  if (!c) {
    c = { id, name: suggestedName || "Новый контакт", raw: "", managed: true, publicKey: null, online: true, status: "new", messages: [], lastActivity: Date.now() };
    state.contacts.set(id, c);
    persistContacts();
  } else if (suggestedName && (!c.name || c.name === "Новый контакт")) {
    c.name = suggestedName;
    persistContacts();
  }
  return c;
}

// ---------- Таб-бар ----------

function wireTabBar() {
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      state.chatId = null;
      renderTab();
    });
  });
  $("#chat-back").addEventListener("click", () => {
    state.chatId = null;
    renderTab();
  });
}

function renderTab() {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $$(".screen").forEach((s) => s.classList.add("hidden"));

  if (state.chatId) {
    $("#screen-chat").classList.remove("hidden");
    $("#tab-bar").classList.add("hidden");
    renderChatThread();
    return;
  }

  $("#tab-bar").classList.remove("hidden");
  const map = { chats: "#screen-chats", connect: "#screen-connect", settings: "#screen-settings" };
  $(map[state.tab]).classList.remove("hidden");
  const titles = { chats: "Чаты", connect: "Контакты", settings: "Настройки" };
  $("#nav-title").textContent = titles[state.tab];

  if (state.tab === "chats") renderChatsList();
  if (state.tab === "connect") { renderSignalingBanner(); renderOnlineRosterList(); }
}

// ---------- Статусы контактов ----------

function contactStatusLabel(c) {
  if (c.status === "in-call") return "разговор";
  if (c.status === "connected") return "на связи";
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return "соединяемся…";
  if (c.managed) return c.online ? "в сети" : "офлайн";
  return "офлайн";
}

function contactStatusClass(c) {
  if (c.status === "connected" || c.status === "in-call") return "status-connected";
  if (c.managed && c.online) return "status-connected";
  if (c.status === "connecting" || c.status === "new" || c.status === "awaiting-answer") return "status-connecting";
  return "status-disconnected";
}

function isReachable(c) {
  return c.status === "connected" || c.status === "in-call";
}

// ---------- Список чатов ----------

function renderChatsList() {
  const list = $("#chats-list");
  const empty = $("#chats-empty");
  list.innerHTML = "";

  if (state.contacts.size === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const items = Array.from(state.contacts.entries()).sort((a, b) => {
    const aLive = isReachable(a[1]) || a[1].online ? 1 : 0;
    const bLive = isReachable(b[1]) || b[1].online ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return (b[1].lastActivity || 0) - (a[1].lastActivity || 0);
  });

  for (const [id, c] of items) {
    const last = c.messages[c.messages.length - 1];
    const row = document.createElement("button");
    row.className = "chat-row glass-content";
    row.innerHTML = `
      <div class="avatar" style="background:${avatarGradient(c.name)}">${initials(c.name)}</div>
      <div class="chat-row-body">
        <div class="chat-row-top">
          <span class="chat-row-name">${escapeHtml(c.name || "Без имени")}</span>
          <span class="chat-row-status ${contactStatusClass(c)}">●</span>
        </div>
        <div class="chat-row-sub">${last ? escapeHtml(truncate(last.text, 42)) : contactStatusLabel(c)}</div>
      </div>
    `;
    row.addEventListener("click", () => {
      state.chatId = id;
      renderTab();
    });
    list.appendChild(row);
  }
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function initials(name) { return (name || "?").trim().slice(0, 2).toUpperCase(); }

function avatarGradient(name) {
  const palettes = [
    "linear-gradient(160deg,#0A84FF,#5E5CE6)",
    "linear-gradient(160deg,#FF9F0A,#FF375F)",
    "linear-gradient(160deg,#30D158,#0A84FF)",
    "linear-gradient(160deg,#BF5AF2,#FF375F)",
    "linear-gradient(160deg,#64D2FF,#5E5CE6)",
  ];
  let h = 0;
  for (const c of name || "?") h = (h * 31 + c.charCodeAt(0)) % palettes.length;
  return palettes[h];
}

// ---------- Тред чата ----------

function ackGlyph(ack) {
  if (ack === "failed") return `<span class="ack-tick ack-failed" title="Не доставлено до сервера">✓</span>`;
  if (ack === "read") return `<span class="ack-tick ack-read" title="Прочитано">✓</span>`;
  if (ack === "delivered") return `<span class="ack-tick ack-delivered" title="Доставлено">✓</span>`;
  return `<span class="ack-tick ack-sent" title="Отправлено">✓</span>`;
}

function renderChatThread() {
  const c = state.contacts.get(state.chatId);
  if (!c) {
    state.chatId = null;
    renderTab();
    return;
  }
  $("#chat-peer-name").textContent = c.name || "Без имени";
  $("#chat-peer-status").textContent = contactStatusLabel(c);
  $("#chat-call-btn").disabled = !isReachable(c);

  const wrap = $("#chat-messages");
  wrap.innerHTML = "";
  for (const m of c.messages) {
    const bubble = document.createElement("div");
    bubble.className = "bubble-row " + (m.from === "me" ? "mine" : "theirs");
    const tick = m.from === "me" ? ackGlyph(m.ack) : "";
    bubble.innerHTML = `<div class="bubble ${m.from === "me" ? "" : "glass-content"}">${escapeHtml(m.text)}<span class="bubble-time">${formatTime(m.ts)}${tick}</span></div>`;
    wrap.appendChild(bubble);
  }
  wrap.scrollTop = wrap.scrollHeight;

  markThreadRead(c);
}

// Пока человек смотрит именно этот тред, все непрочитанные входящие
// сообщения сразу помечаются прочитанными и квитанция уходит обратно
// отправителю — напрямую, если он сейчас на связи, иначе через сервер,
// как и обычное сообщение.
function markThreadRead(c) {
  for (const m of c.messages) {
    if (m.from === "them" && !m.readAckSent) {
      m.readAckSent = true;
      sendAckFor(c.id, m.id, "read");
    }
  }
  persistContacts();
}

function wireChatScreen() {
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text || !state.chatId) return;
    sendChatMessage(state.chatId, text);
    input.value = "";
  });

  $("#chat-call-btn").addEventListener("click", () => beginCall(state.chatId));

  $("#chat-delete-btn").addEventListener("click", () => {
    const c = state.contacts.get(state.chatId);
    if (!c) return;
    if (!confirm(`Удалить контакт «${c.name}»? Переписка будет потеряна.`)) return;
    deleteContact(state.chatId);
  });
}

async function sendChatMessage(contactId, text) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  c.messages.push({ id: msgId, from: "me", text, ts, ack: "sent" });
  c.lastActivity = ts;
  pendingAcks.set(msgId, contactId);
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();

  const link = mesh.get(contactId);
  if (link && link.send({ kind: "chat", id: msgId, text, ts })) {
    return; // ушло напрямую по P2P; статус обновится квитанцией по тому же каналу
  }

  await deliverEncrypted(c, msgId, { kind: "chat", id: msgId, text, ts });
}

function deleteContact(id) {
  clearAutoConnectTimer(id);
  mesh.remove(id);
  const audioEl = document.getElementById("remote-audio-" + id);
  if (audioEl) audioEl.remove();
  state.contacts.delete(id);
  persistContacts();
  if (state.callId === id) closeCallScreen();
  if (state.chatId === id) state.chatId = null;
  renderTab();
  toast("Контакт удалён");
}

// ---------- Гарантированная доставка (офлайн-очередь на сервере) ----------
//
// Пока оба устройства онлайн, сообщения идут напрямую по P2P — сервер их
// не видит вообще. Если собеседник офлайн, сообщение шифруется прямо на
// устройстве (ECDH + AES-GCM, см. js/crypto-helper.js) и кладётся на
// сервер, который хранит только нечитаемый шифротекст в памяти до тех
// пор, пока собеседник не подключится — после чего сразу его получает.

function markMessageAck(contactId, msgId, ack) {
  const c = state.contacts.get(contactId);
  if (!c) return;
  const m = c.messages.find((mm) => mm.id === msgId && mm.from === "me");
  if (!m) return;
  const rank = { failed: -1, sent: 0, delivered: 1, read: 2 };
  if ((rank[ack] ?? 0) >= (rank[m.ack] ?? 0) || ack === "failed") m.ack = ack;
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
}

async function deliverEncrypted(contact, msgId, payloadObj) {
  if (!contact.publicKey) {
    // Ключа собеседника ещё не видели — не можем зашифровать. Запоминаем и
    // отправим сразу, как только узнаем его ключ (обычно — в момент, когда
    // он в первый раз появится в сети).
    markMessageAck(contact.id, msgId, "failed");
    if (!pendingNoKey.has(contact.id)) pendingNoKey.set(contact.id, []);
    pendingNoKey.get(contact.id).push({ msgId, payload: payloadObj });
    return;
  }
  try {
    const sharedKey = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, contact.publicKey);
    const envelope = await CryptoHelper.encryptJson(sharedKey, payloadObj);
    outbox.set(msgId, { to: contact.id, envelope });
    const sent = signaling && signaling.deliver(contact.id, msgId, envelope, Store.myPublicKeyJwk);
    if (!sent) markMessageAck(contact.id, msgId, "failed"); // останется в outbox, повторим при переподключении
  } catch (e) {
    etherLog("error", "[crypto] не удалось зашифровать конверт:", String(e));
    markMessageAck(contact.id, msgId, "failed");
  }
}

function flushPendingNoKey(contactId) {
  const list = pendingNoKey.get(contactId);
  if (!list || list.length === 0) return;
  pendingNoKey.delete(contactId);
  const c = state.contacts.get(contactId);
  if (!c) return;
  for (const { msgId, payload } of list) deliverEncrypted(c, msgId, payload);
}

function flushOutbox() {
  for (const [msgId, entry] of outbox) {
    signaling.deliver(entry.to, msgId, entry.envelope, Store.myPublicKeyJwk);
  }
}

// Квитанция (доставлено/прочитано) для чужого сообщения — тем же путём:
// напрямую, если собеседник сейчас на связи, иначе тоже через очередь.
function sendAckFor(contactId, originalMsgId, ackState) {
  const link = mesh.get(contactId);
  if (link && link.send({ kind: "ack", id: originalMsgId, state: ackState })) return;
  const c = state.contacts.get(contactId);
  if (c) deliverEncrypted(c, crypto.randomUUID(), { kind: "ack", id: originalMsgId, state: ackState });
}

// ---------- Идентификатор и сигнальный сервер ----------

function updateSignalingStatusUI(kind, text) {
  const dot = $("#signaling-status-dot");
  dot.className = "status-dot " + kind;
  $("#signaling-status-text").textContent = text;
}

function renderSignalingBanner() {
  const banner = $("#signaling-banner");
  if (!signaling || !signaling.connected) {
    $("#signaling-banner-text").textContent = "Нет связи с сигнальным сервером — переподключаемся… Бесплатный хостинг сервера может «просыпаться» до 30 секунд после простоя.";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function initSignaling() {
  const url = effectiveSignalingUrl();
  if (signaling) { signaling.stop(); signaling = null; }
  onlineSet.clear();
  onlineRoster.clear();
  for (const c of state.contacts.values()) c.online = false;

  if (!url) {
    updateSignalingStatusUI("off", "Сервер не настроен");
    renderSignalingBanner();
    renderChatsList();
    renderOnlineRosterList();
    return;
  }
  updateSignalingStatusUI("connecting", "Подключение…");
  signaling = new SignalingClient(url, Store.myId, { name: Store.name, visible: Store.discoverable, publicKey: Store.myPublicKeyJwk });
  wireSignalingEvents();
  signaling.start();
  renderSignalingBanner();
}

function wireSignalingEvents() {
  signaling.addEventListener("connected", () => {
    updateSignalingStatusUI("online", "Подключено");
    renderSignalingBanner();
    flushOutbox();
  });

  signaling.addEventListener("disconnected", () => {
    updateSignalingStatusUI("off", "Нет соединения — переподключаемся…");
    for (const c of state.contacts.values()) if (c.managed) c.online = false;
    onlineRoster.clear();
    renderSignalingBanner();
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  });

  signaling.addEventListener("replaced", () => {
    updateSignalingStatusUI("off", "Отключено — тот же телефон/email открыт в другом месте");
    toast("Этот же контакт подключён в другой вкладке или на другом устройстве — здесь связь с сервером отключена, чтобы не мешать друг другу");
    renderSignalingBanner();
  });

  signaling.addEventListener("online-list", (ev) => {
    for (const u of ev.detail.users) {
      onlineSet.add(u.id);
      onlineRoster.set(u.id, { name: u.name, visible: u.visible !== false, publicKey: u.publicKey || null });
      const c = state.contacts.get(u.id);
      if (c && c.managed) {
        c.online = true;
        if (u.publicKey && keysDiffer(u.publicKey, c.publicKey)) { c.publicKey = u.publicKey; persistContacts(); flushPendingNoKey(u.id); }
        scheduleAutoConnect(u.id);
      }
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  });

  signaling.addEventListener("presence", (ev) => {
    const { id, online, name, visible, publicKey } = ev.detail;
    if (online) { onlineSet.add(id); onlineRoster.set(id, { name, visible: visible !== false, publicKey: publicKey || null }); }
    else { onlineSet.delete(id); onlineRoster.delete(id); }

    const c = state.contacts.get(id);
    if (c && c.managed) {
      c.online = online;
      if (online && publicKey && keysDiffer(publicKey, c.publicKey)) { c.publicKey = publicKey; persistContacts(); flushPendingNoKey(id); }
      if (online) scheduleAutoConnect(id); else clearAutoConnectTimer(id);
      if (state.chatId === id) renderChatThread();
    }
    if (state.tab === "chats") renderChatsList();
    if (state.tab === "connect") renderOnlineRosterList();
  });

  signaling.addEventListener("signal", async (ev) => {
    const { from, data: packet } = ev.detail;
    if (!packet || !packet.t) return;
    if (isDuplicateSignal(from, packet)) return; // тот же пакет уже обработан — игнорируем молча

    if (packet.t === "offer") {
      const existing = mesh.get(from);
      const iAmSupposedToOffer = Store.myId < from;
      if (existing && existing.role === "offerer" && iAmSupposedToOffer && existing.status !== "disconnected") {
        return; // ждём свой offer/answer, входящий игнорируем (защита от гонки)
      }
      if (existing) mesh.remove(from);
      ensureContactEntry(from, packet.n);
      const link = mesh.createIncomingLink(from);
      try {
        const answer = await link.acceptOfferAndCreateAnswer(packet);
        if (!answer) { etherLog("info", "[connect]", from.slice(0, 10) + "…", "ответ на offer отменён — соединение уже переопределено"); return; }
        signaling.signal(from, answer);
      } catch (e) {
        etherLog("error", "[webrtc] не удалось ответить на offer:", String(e));
        mesh.remove(from); // не оставляем зависшую полусвязь, блокирующую повторные попытки
        const c = state.contacts.get(from);
        if (c) c.status = "disconnected";
        if (state.chatId === from) renderChatThread();
        if (state.tab === "chats") renderChatsList();
      }
    } else if (packet.t === "answer") {
      const link = mesh.get(from);
      if (link) {
        try { await link.acceptAnswer(packet); } catch (e) {
          etherLog("error", "[webrtc] не удалось принять answer:", String(e));
          mesh.remove(from);
          const c = state.contacts.get(from);
          if (c) c.status = "disconnected";
          if (state.chatId === from) renderChatThread();
          if (state.tab === "chats") renderChatsList();
        }
      }
    }
  });

  signaling.addEventListener("unreachable", (ev) => {
    const c = state.contacts.get(ev.detail.to);
    if (c) { c.online = false; if (state.tab === "chats") renderChatsList(); }
  });

  signaling.addEventListener("deliver-ack", (ev) => {
    // Сервер подтвердил, что принял конверт на себя — либо сразу передал
    // адресату, либо гарантированно придержит его. С нашей стороны это и
    // есть "доставлено" (жёлтая галочка); сама запись остаётся в outbox
    // до переподключения на случай повторной отправки не потребуется —
    // но outbox чистим сразу, раз сервер уже подтвердил приём.
    const { msgId } = ev.detail;
    const entry = outbox.get(msgId);
    outbox.delete(msgId);
    const contactId = pendingAcks.get(msgId);
    if (contactId) markMessageAck(contactId, msgId, "delivered");
    else if (entry) markMessageAck(entry.to, msgId, "delivered");
  });

  signaling.addEventListener("deliver", async (ev) => {
    const { from, msgId, envelope, fromPublicKey, queued } = ev.detail;
    signaling.mailboxAck(msgId); // иначе сервер пришлёт этот же конверт заново при следующем подключении
    if (seenDeliverIds.has(msgId)) return;
    seenDeliverIds.add(msgId);
    if (seenDeliverIds.size > 500) seenDeliverIds.delete(seenDeliverIds.values().next().value);

    let payload;
    try {
      const theirKey = fromPublicKey || (state.contacts.get(from) || {}).publicKey;
      if (!theirKey) throw new Error("нет публичного ключа отправителя");
      const sharedKey = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, theirKey);
      payload = await CryptoHelper.decryptJson(sharedKey, envelope);
      if (fromPublicKey) {
        const c = state.contacts.get(from);
        if (c && fromPublicKey && keysDiffer(fromPublicKey, c.publicKey)) { c.publicKey = fromPublicKey; persistContacts(); }
      }
    } catch (e) {
      etherLog("error", "[crypto] не удалось расшифровать конверт из", queued ? "очереди" : "прямой доставки", "от", from.slice(0, 10) + "…:", String(e));
      return;
    }

    if (payload.kind === "chat") {
      const c = ensureContactEntry(from, null);
      if (fromPublicKey && !c.publicKey) c.publicKey = fromPublicKey;
      if (c.messages.some((m) => m.id === payload.id)) return;
      const isOpen = state.chatId === from;
      c.messages.push({ id: payload.id, from: "them", text: payload.text, ts: payload.ts || Date.now(), readAckSent: isOpen });
      c.lastActivity = Date.now();
      persistContacts();
      if (isOpen) renderChatThread();
      else toast(`${c.name}: ${truncate(payload.text, 40)}`);
      if (state.tab === "chats") renderChatsList();
      sendAckFor(from, payload.id, "delivered");
      if (isOpen) sendAckFor(from, payload.id, "read");
    } else if (payload.kind === "ack") {
      markMessageAck(from, payload.id, payload.state);
    }
  });
}

function clearAutoConnectTimer(id) {
  const t = autoConnectTimers.get(id);
  if (t) clearTimeout(t);
  autoConnectTimers.delete(id);
}

function scheduleAutoConnect(id) {
  attemptConnect(id);
  if (autoConnectTimers.has(id)) return; // повтор уже запланирован — не откладываем его каждый раз заново
  autoConnectTimers.set(
    id,
    setTimeout(() => {
      autoConnectTimers.delete(id);
      attemptConnect(id, { force: true });
    }, 4000)
  );
}

async function attemptConnect(id, { force = false } = {}) {
  const tag = id.slice(0, 10) + "…";
  if (!signaling || !signaling.connected) { etherLog("info", "[connect]", tag, "пропуск: сигнальный сервер не подключён"); return; }
  const existing = mesh.get(id);
  if (existing && existing.status !== "disconnected") { etherLog("info", "[connect]", tag, "пропуск: уже есть связь в статусе", existing.status); return; }
  if (!onlineSet.has(id)) { etherLog("info", "[connect]", tag, "пропуск: контакт не онлайн по данным сервера"); return; }
  if (!force && !(Store.myId < id)) { etherLog("info", "[connect]", tag, "жду — инициатором должен быть собеседник (тай-брейк)"); return; }
  if (existing) mesh.remove(id);
  etherLog("info", "[connect]", tag, "создаю offer" + (force ? " (force)" : ""));
  const link = mesh.createOutgoingLink(id);
  try {
    const packet = await link.createInitialOffer("");
    if (!packet) { etherLog("info", "[connect]", tag, "offer отменён — соединение уже переопределено"); return; }
    signaling.signal(id, packet);
    etherLog("info", "[connect]", tag, "offer отправлен через сигнальный сервер");
    watchConnectionTimeout(id);
  } catch (e) {
    etherLog("error", "[webrtc] не удалось создать offer:", String(e));
    mesh.remove(id); // без этого статус навсегда останется "new" и заблокирует повторные попытки
    const c = state.contacts.get(id);
    if (c) c.status = "disconnected";
    if (state.chatId === id) renderChatThread();
    if (state.tab === "chats") renderChatsList();
  }
}

// Сторожевой таймер: если через 10с после отправки offer соединение так и
// не поднялось (а явной ошибки/события failed не было), считаем попытку
// зависшей и сбрасываем её — иначе контакт мог бы застрять в "Соединяемся…"
// навсегда, а автоповтор никогда бы не сработал.
function watchConnectionTimeout(id) {
  setTimeout(() => {
    const link = mesh.get(id);
    if (!link || link.status === "connected" || link.status === "in-call" || link.status === "disconnected") return;
    etherLog("warn", "[webrtc] соединение с", id.slice(0, 10) + "…", "зависло, сбрасываю и пробую снова");
    mesh.remove(id);
    const c = state.contacts.get(id);
    if (c) {
      c.status = "disconnected";
      if (state.chatId === id) renderChatThread();
      if (state.tab === "chats") renderChatsList();
      if (c.managed && c.online) scheduleAutoConnect(id);
    }
  }, 10000);
}

// ---------- Экран "Контакты" ----------

// ---------- Экран "Контакты" ----------

function renderOnlineRosterList() {
  const wrap = $("#online-roster-list");
  const empty = $("#online-roster-empty");
  if (!wrap) return;
  wrap.innerHTML = "";

  const rows = Array.from(onlineRoster.entries()).filter(
    ([id, u]) => id !== Store.myId && u.visible !== false && !state.contacts.has(id)
  );

  if (rows.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  for (const [id, u] of rows) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(u.name || id)}">${initials(u.name || "?")}</div>
      <span class="roster-name">${escapeHtml(u.name || "Без имени")}</span>
      <button class="btn-secondary roster-add-btn">Добавить</button>
    `;
    row.querySelector(".roster-add-btn").addEventListener("click", () => {
      state.contacts.set(id, {
        id, name: u.name || "Без имени", raw: "", managed: true, publicKey: u.publicKey || null,
        online: true, status: "disconnected", messages: [], lastActivity: Date.now(),
      });
      persistContacts();
      toast("Контакт добавлен");
      scheduleAutoConnect(id);
      renderOnlineRosterList();
      state.tab = "chats";
      renderTab();
    });
    wrap.appendChild(row);
  }
}

function wireConnectScreen() {
  $("#add-contact-btn").addEventListener("click", async () => {
    const nameVal = $("#add-contact-name").value.trim();
    const raw = $("#add-contact-value").value.trim();
    if (!raw) { toast("Введите телефон или email"); return; }
    let identity;
    try { identity = await Identity.idFor(raw); }
    catch (e) { toast(e.message); return; }

    if (identity.id === Store.myId) { toast("Это ваш собственный идентификатор"); return; }

    if (state.contacts.has(identity.id)) {
      toast("Этот контакт уже добавлен");
    } else {
      state.contacts.set(identity.id, {
        id: identity.id, name: nameVal || identity.normalized, raw: identity.normalized,
        managed: true, online: onlineSet.has(identity.id), status: "disconnected",
        messages: [], lastActivity: Date.now(),
      });
      persistContacts();
      toast("Контакт добавлен");
      if (onlineSet.has(identity.id)) scheduleAutoConnect(identity.id);
    }
    $("#add-contact-name").value = "";
    $("#add-contact-value").value = "";
    state.tab = "chats";
    renderTab();
  });

  $("#toggle-manual-btn").addEventListener("click", () => {
    const sec = $("#manual-section");
    sec.classList.toggle("hidden");
    $("#toggle-manual-btn").textContent = sec.classList.contains("hidden")
      ? "Ручное подключение без сервера, по коду ›"
      : "Скрыть ручное подключение ‹";
  });

  // ---- Ручной поток (полностью без сервера), как раньше ----

  $("#create-invite-btn").addEventListener("click", createInvite);
  $("#copy-code-btn").addEventListener("click", () => copyText($("#invite-code-out").textContent, "Код скопирован"));
  $("#copy-link-btn").addEventListener("click", () => copyText($("#invite-link-out").textContent, "Ссылка скопирована"));
  $("#share-link-btn").addEventListener("click", async () => {
    const url = $("#invite-link-out").textContent;
    if (navigator.share) {
      try { await navigator.share({ title: "Приглашение в Эфир", text: "Подключимся напрямую без серверов", url }); } catch (e) {}
    } else {
      copyText(url, "Ссылка скопирована");
    }
  });

  $("#complete-invite-btn").addEventListener("click", async () => {
    const code = $("#answer-code-in").value.trim();
    if (!code || !state.pendingOutgoing) return;
    try {
      const packet = await SignalingCodec.decode(code);
      if (packet.t !== "answer") throw new Error("Это не код ответа");
      const link = mesh.get(state.pendingOutgoing.id);
      await link.acceptAnswer(packet);
      $("#answer-code-in").value = "";
      toast("Код принят — соединяемся…");
    } catch (e) {
      toast("Не удалось прочитать код: " + e.message);
    }
  });

  $("#reply-btn").addEventListener("click", async () => {
    const code = $("#paste-code-in").value.trim();
    if (!code) return;
    await handleIncomingCode(code, false);
  });

  $("#new-invite-again").addEventListener("click", resetConnectScreen);
  $("#answer-copy-btn").addEventListener("click", () => copyText($("#answer-out-code").textContent, "Код скопирован"));

  wireContactSend({
    smsBtnId: "invite-send-sms", mailBtnId: "invite-send-email", inputId: "invite-contact",
    textGetter: () =>
      `${Store.name} приглашает вас в Эфир — приложение для прямой связи без серверов. ` +
      `Откройте ссылку на устройстве, где установлено (или откроется) приложение: ${$("#invite-link-out").textContent}`,
  });

  wireContactSend({
    smsBtnId: "answer-send-sms", mailBtnId: "answer-send-email", inputId: "answer-contact",
    textGetter: () => `Код ответа для подключения в Эфир: ${$("#answer-out-code").textContent}`,
  });
}

function resetConnectScreen() {
  state.pendingOutgoing = null;
  $("#invite-idle").classList.remove("hidden");
  $("#invite-active").classList.add("hidden");
  $("#answer-code-in").value = "";
  $("#paste-code-in").value = "";
  $("#incoming-banner").classList.add("hidden");
}

async function createInvite() {
  const id = crypto.randomUUID();
  const link = mesh.createOutgoingLink(id);
  const packet = await link.createInitialOffer("");
  const code = await SignalingCodec.encode(packet);
  const shareLink = SignalingCodec.buildShareLink(code);

  state.pendingOutgoing = { id, code, shareLink };
  state.contacts.set(id, { id, name: "Приглашение…", raw: "", managed: false, online: false, status: "awaiting-answer", messages: [], lastActivity: Date.now() });

  $("#invite-idle").classList.add("hidden");
  $("#invite-active").classList.remove("hidden");
  $("#invite-code-out").textContent = code;
  $("#invite-link-out").textContent = shareLink;
}

async function handleIncomingCode(code, fromLink) {
  let packet;
  try { packet = await SignalingCodec.decode(code); }
  catch (e) { toast("Код повреждён или неполный"); return; }

  if (packet.t === "offer") {
    const id = crypto.randomUUID();
    const link = mesh.createIncomingLink(id);
    const answerPacket = await link.acceptOfferAndCreateAnswer(packet);
    const answerCode = await SignalingCodec.encode(answerPacket);
    state.contacts.set(id, { id, name: packet.n || "Собеседник", raw: "", managed: false, online: false, status: "connecting", messages: [], lastActivity: Date.now() });

    state.tab = "connect";
    renderTab();
    $("#manual-section").classList.remove("hidden");
    $("#toggle-manual-btn").textContent = "Скрыть ручное подключение ‹";
    $("#incoming-banner").classList.remove("hidden");
    $("#incoming-banner-text").textContent = `Приглашение от «${packet.n || "без имени"}» принято`;
    $("#answer-out-code").textContent = answerCode;
    $("#answer-out-wrap").classList.remove("hidden");
    $("#paste-code-wrap").classList.add("hidden");
  } else {
    toast("Это приглашение, а не код ответа — вставьте его в поле «У меня есть код»");
  }
}

function copyText(text, msg) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast(msg));
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast(msg);
  }
}

function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }

function openSmsWith(number, body) {
  if (!number) { toast("Введите номер телефона"); return; }
  const sep = isIOS() ? "&" : "?";
  location.href = `sms:${encodeURIComponent(number)}${sep}body=${encodeURIComponent(body)}`;
}

function openMailWith(email, body) {
  if (!email) { toast("Введите email"); return; }
  const subject = encodeURIComponent("Приглашение в Эфир");
  location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${encodeURIComponent(body)}`;
}

function wireContactSend({ smsBtnId, mailBtnId, inputId, textGetter }) {
  const smsBtn = document.getElementById(smsBtnId);
  const mailBtn = document.getElementById(mailBtnId);
  if (smsBtn) smsBtn.addEventListener("click", () => openSmsWith($(`#${inputId}`).value.trim(), textGetter()));
  if (mailBtn) mailBtn.addEventListener("click", () => openMailWith($(`#${inputId}`).value.trim(), textGetter()));
}

// ---------- Звонки ----------

async function beginCall(id) {
  const c = state.contacts.get(id);
  let link = mesh.get(id);
  if (!c) return;
  if (!link || !isReachable(c)) {
    if (c.managed && c.online) { toast("Соединяемся…"); attemptConnect(id, { force: true }); }
    else toast("Контакт сейчас не на связи");
    return;
  }
  try { await link.startCall(); }
  catch (e) { toast("Нет доступа к микрофону"); return; }
  openCallScreen(id, "calling");
}

function openCallScreen(id, phase) {
  state.callId = id;
  state.callPhase = phase;
  const c = state.contacts.get(id);
  $("#call-screen").classList.remove("hidden");
  $("#call-peer-name").textContent = c.name || "Без имени";
  $("#call-peer-avatar").style.background = avatarGradient(c.name);
  $("#call-peer-avatar").textContent = initials(c.name);
  $("#call-phase").textContent = phase === "calling" ? "Вызов…" : phase === "ringing" ? "Входящий вызов" : "На связи";

  const incoming = phase === "ringing";
  $("#call-controls-incoming").classList.toggle("hidden", !incoming);
  $("#call-controls-active").classList.toggle("hidden", incoming);

  clearInterval(callTimerInterval);
  if (phase === "active") startCallTimer();
}

function setCallPhaseActive() {
  state.callPhase = "active";
  $("#call-controls-incoming").classList.add("hidden");
  $("#call-controls-active").classList.remove("hidden");
  startCallTimer();
  if (state.callId && pendingRemoteStreams.has(state.callId)) {
    attachRemoteAudio(state.callId, pendingRemoteStreams.get(state.callId));
    pendingRemoteStreams.delete(state.callId);
  }
}

let callTimerInterval = null;
const pendingRemoteStreams = new Map(); // id -> MediaStream, ждёт явного "Принять" из-за autoplay-политики браузера

function attachRemoteAudio(id, stream) {
  let audioEl = document.getElementById("remote-audio-" + id);
  if (!audioEl) {
    audioEl = document.createElement("audio");
    audioEl.id = "remote-audio-" + id;
    audioEl.autoplay = true;
    audioEl.hidden = true;
    document.body.appendChild(audioEl);
  }
  audioEl.srcObject = stream;
  audioEl.play().catch(() => {}); // если браузер всё равно заблокирует — молча, звонок сам по себе всё равно работает
}
function startCallTimer() {
  const started = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    $("#call-phase").textContent = `${mm}:${ss}`;
  }, 1000);
}

function closeCallScreen() {
  clearInterval(callTimerInterval);
  $("#call-screen").classList.add("hidden");
  $("#call-mute-btn").classList.remove("active");
  if (state.callId) pendingRemoteStreams.delete(state.callId);
  state.callId = null;
  state.callPhase = null;
}

function wireCallScreen() {
  $("#call-hangup-btn").addEventListener("click", () => {
    const link = mesh.get(state.callId);
    if (link) link.endCall();
    closeCallScreen();
  });
  $("#call-mute-btn").addEventListener("click", () => {
    const btn = $("#call-mute-btn");
    const link = mesh.get(state.callId);
    const muted = !btn.classList.contains("active");
    if (link) link.setMuted(muted);
    btn.classList.toggle("active", muted);
  });
  $("#call-accept-btn").addEventListener("click", async () => {
    const link = mesh.get(state.callId);
    if (!link) return;
    try {
      await link.answerCall();
      setCallPhaseActive();
    } catch (e) {
      toast("Нет доступа к микрофону");
      link.declineCall();
      closeCallScreen();
    }
  });
  $("#call-decline-btn").addEventListener("click", () => {
    const link = mesh.get(state.callId);
    if (link) link.declineCall();
    closeCallScreen();
  });
}

// ---------- Настройки ----------

function wireSettingsScreen() {
  $("#settings-name").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) { Store.name = v; toast("Имя обновлено"); initSignaling(); }
  });

  $("#settings-identity").addEventListener("change", async (e) => {
    const v = e.target.value.trim();
    if (!v) return;
    try {
      const identity = await Identity.idFor(v);
      Store.myIdentityRaw = identity.normalized;
      Store.myId = identity.id;
      toast("Идентификатор обновлён — переподключаемся");
      initSignaling();
    } catch (err) {
      toast(err.message);
      e.target.value = Store.myIdentityRaw;
    }
  });

  $("#save-signaling-btn").addEventListener("click", () => {
    Store.signalingUrl = $("#settings-signaling-url").value.trim();
    initSignaling();
    toast("Сохранено, подключаемся");
  });

  $("#settings-discoverable").addEventListener("change", (e) => {
    Store.discoverable = e.target.checked;
    initSignaling();
    toast(e.target.checked ? "Вы видны в общем списке онлайн" : "Вы скрыты из общего списка онлайн");
  });

  $("#glass-slider").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    Store.glassAlpha = v;
    applyGlassAlpha(v);
  });

  $$(".theme-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      Store.theme = btn.dataset.theme;
      applyTheme(btn.dataset.theme);
      $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  $("#reset-all-btn").addEventListener("click", () => {
    if (!confirm("Разорвать все соединения и удалить контакты?")) return;
    for (const id of Array.from(state.contacts.keys())) mesh.remove(id);
    for (const t of autoConnectTimers.values()) clearTimeout(t);
    autoConnectTimers.clear();
    onlineSet.clear();
    state.contacts.clear();
    Store.contactsJson = "[]";
    resetConnectScreen();
    renderTab();
    toast("Все соединения и контакты удалены");
  });

  $("#how-it-works-btn").addEventListener("click", () => $("#how-it-works-sheet").classList.remove("hidden"));
  $("#how-it-works-close").addEventListener("click", () => $("#how-it-works-sheet").classList.add("hidden"));

  $("#diagnostics-btn").addEventListener("click", () => {
    renderDiagnostics();
    $("#diagnostics-sheet").classList.remove("hidden");
  });
  $("#diagnostics-close").addEventListener("click", () => $("#diagnostics-sheet").classList.add("hidden"));
  $("#diagnostics-refresh-btn").addEventListener("click", renderDiagnostics);
  $("#diagnostics-copy-btn").addEventListener("click", () => copyText(buildDiagnosticsText(), "Диагностика скопирована"));
}

function buildDiagnosticsText() {
  const lines = [];
  lines.push("=== Эфир — диагностика ===");
  lines.push("Время: " + new Date().toLocaleString("ru-RU"));
  lines.push("Мой id: " + (Store.myId ? Store.myId.slice(0, 16) + "…" : "(не задан)"));
  lines.push("Сигнальный сервер: " + effectiveSignalingUrl());
  lines.push("Статус сервера: " + (signaling ? (signaling.connected ? "подключён" : "не подключён, переподключается") : "не инициализирован"));
  lines.push("Онлайн по данным сервера: " + onlineSet.size + " (roster: " + onlineRoster.size + ")");
  lines.push("");
  lines.push("--- Контакты ---");
  if (state.contacts.size === 0) lines.push("(нет контактов)");
  for (const c of state.contacts.values()) {
    lines.push(
      `${c.name} | id=${c.id.slice(0, 10)}… | managed=${c.managed} | online=${c.online} | status=${c.status} | сообщений=${c.messages.length}`
    );
  }
  lines.push("");
  lines.push("--- Журнал событий (последние) ---");
  const log = window.__etherDiag || [];
  for (const entry of log.slice(-80)) {
    const d = new Date(entry.ts);
    const stamp = `${d.toLocaleTimeString("ru-RU")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    lines.push(`[${stamp}] [${entry.level}] ${entry.line}`);
  }
  return lines.join("\n");
}

function renderDiagnostics() {
  $("#diagnostics-summary").innerHTML = `
    <div><b>Мой id:</b> ${Store.myId ? escapeHtml(Store.myId.slice(0, 16)) + "…" : "не задан"}</div>
    <div><b>Сервер:</b> ${escapeHtml(effectiveSignalingUrl())}</div>
    <div><b>Статус сервера:</b> ${signaling ? (signaling.connected ? "подключён ✅" : "не подключён ⚠️") : "не инициализирован ⚠️"}</div>
    <div><b>Онлайн сейчас:</b> ${onlineSet.size}</div>
    <div><b>Контактов:</b> ${state.contacts.size}</div>
  `;
  $("#diagnostics-log").textContent = buildDiagnosticsText();
}

// ---------- События mesh (WebRTC-соединения) ----------

function wireMeshEvents() {
  mesh.addEventListener("link-status", (ev) => {
    const { id, status } = ev.detail;
    const c = state.contacts.get(id);
    if (!c) return;
    const wasConnected = c.status === "connected" || c.status === "in-call";
    c.status = status;

    if (status === "connected" && !wasConnected) {
      const link = mesh.get(id);
      if (link.remoteName) c.name = link.remoteName;
      if (c.managed) persistContacts();
      toast(`«${c.name}» на связи`);
      clearAutoConnectTimer(id);
      if (state.pendingOutgoing && state.pendingOutgoing.id === id) resetConnectScreen();
    }
    if (status === "disconnected") {
      if (state.callId === id) closeCallScreen();
      if (c.managed && c.online) scheduleAutoConnect(id);
    }

    if (state.chatId === id) renderChatThread();
    if (state.tab === "chats" && !state.chatId) renderChatsList();
  });

  mesh.addEventListener("message", (ev) => {
    const { id, payload } = ev.detail;
    const c = state.contacts.get(id);
    if (!c) return;

    if (payload.kind === "chat") {
      const msgId = payload.id || crypto.randomUUID(); // на случай пакета от старой версии без id
      if (c.messages.some((m) => m.id === msgId)) return; // уже получали (например, повтор после реконнекта)
      const isOpen = state.chatId === id;
      c.messages.push({ id: msgId, from: "them", text: payload.text, ts: payload.ts || Date.now(), readAckSent: isOpen });
      c.lastActivity = Date.now();
      persistContacts();
      if (isOpen) renderChatThread();
      else toast(`${c.name}: ${truncate(payload.text, 40)}`);
      if (state.tab === "chats") renderChatsList();

      // Подтверждаем доставку сразу; прочтение — только если тред открыт.
      sendAckFor(id, msgId, "delivered");
      if (isOpen) sendAckFor(id, msgId, "read");
    }

    if (payload.kind === "ack") {
      markMessageAck(id, payload.id, payload.state);
    }

    if (payload.kind === "call-state") {
      if (payload.state === "ringing" && state.callId !== id) openCallScreen(id, "ringing");
      if (payload.state === "accepted" && state.callId === id) setCallPhaseActive();
      if (payload.state === "declined" && state.callId === id) {
        toast("Собеседник отклонил вызов");
        const link = mesh.get(id);
        if (link) link.endCall();
        closeCallScreen();
      }
      if (payload.state === "ended" && state.callId === id) closeCallScreen();
    }
  });

  mesh.addEventListener("remote-track", (ev) => {
    const { id, stream } = ev.detail;
    if (state.callId === id && state.callPhase !== "active") {
      // Звук пришёл раньше, чем нажали "Принять" — не запускаем
      // автовоспроизведение сейчас (строгие браузеры вроде Safari это
      // заблокируют без прямого жеста пользователя), просто запоминаем.
      pendingRemoteStreams.set(id, stream);
      return;
    }
    attachRemoteAudio(id, stream);
  });
}

// ---------- Старт ----------

// Страховка: если через несколько секунд после загрузки страницы ни
// экран приветствия, ни само приложение так и не показались — что-то
// сломалось раньше, чем ожидалось (необработанное исключение где-то в
// цепочке запуска). Вместо тихого пустого/серого экрана даём человеку
// явный выход.
function showBootRecovery() {
  document.getElementById("onboarding").classList.add("hidden");
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("boot-recovery").classList.remove("hidden");
}

function bootDidNotRender() {
  const onboardingHidden = document.getElementById("onboarding").classList.contains("hidden");
  const appHidden = document.getElementById("app-shell").classList.contains("hidden");
  return onboardingHidden && appHidden;
}

const bootWatchdog = setTimeout(() => {
  if (bootDidNotRender()) showBootRecovery();
}, 6000);

window.addEventListener("error", (ev) => {
  if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); }
});
window.addEventListener("unhandledrejection", (ev) => {
  if (bootDidNotRender()) { clearTimeout(bootWatchdog); showBootRecovery(); }
});

document.addEventListener("DOMContentLoaded", () => {
  try {
    initOnboarding();
    clearTimeout(bootWatchdog);
  } catch (e) {
    showBootRecovery();
  }
});

document.getElementById("boot-recovery-reset")?.addEventListener("click", () => {
  localStorage.clear();
  if ("caches" in window) caches.keys().then((names) => names.forEach((n) => caches.delete(n)));
  location.reload();
});
