"use strict";

// ---------- Состояние ----------

const Store = {
  get name() {
    return localStorage.getItem("ether.name") || "";
  },
  set name(v) {
    localStorage.setItem("ether.name", v);
  },
  get glassAlpha() {
    return parseFloat(localStorage.getItem("ether.glassAlpha") || "0.5");
  },
  set glassAlpha(v) {
    localStorage.setItem("ether.glassAlpha", String(v));
  },
  get theme() {
    return localStorage.getItem("ether.theme") || "auto";
  },
  set theme(v) {
    localStorage.setItem("ether.theme", v);
  },
};

const state = {
  tab: "chats", // chats | connect | settings
  chatId: null, // открытый тред
  callId: null, // активный звонок
  pendingOutgoing: null, // { id, code, link }
  peers: new Map(), // id -> { name, status, messages: [{from, text, ts}] }
};

let mesh;

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
  if (Store.name) {
    startApp();
    return;
  }
  $("#onboarding").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
  $("#onboarding-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = $("#onboarding-name").value.trim();
    if (!val) return;
    Store.name = val;
    $("#onboarding").classList.add("hidden");
    startApp();
  });
}

// ---------- Запуск приложения ----------

function startApp() {
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

  const incoming = SignalingCodec.extractCodeFromLocation();
  history.replaceState(null, "", location.pathname + location.search);
  if (incoming) {
    handleIncomingCode(incoming, true);
  }

  renderTab();
  registerServiceWorker();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
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
  const titles = { chats: "Чаты", connect: "Подключить", settings: "Настройки" };
  $("#nav-title").textContent = titles[state.tab];

  if (state.tab === "chats") renderChatsList();
}

// ---------- Список чатов ----------

function statusLabel(status) {
  return (
    {
      new: "устанавливаем связь…",
      "awaiting-answer": "ждём код ответа…",
      connecting: "соединяемся…",
      connected: "на связи",
      "in-call": "разговор",
      disconnected: "офлайн",
    }[status] || status
  );
}

function renderChatsList() {
  const list = $("#chats-list");
  const empty = $("#chats-empty");
  list.innerHTML = "";

  if (state.peers.size === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const items = Array.from(state.peers.entries()).sort((a, b) => (b[1].lastActivity || 0) - (a[1].lastActivity || 0));

  for (const [id, peer] of items) {
    const last = peer.messages[peer.messages.length - 1];
    const row = document.createElement("button");
    row.className = "chat-row glass-content";
    row.innerHTML = `
      <div class="avatar" style="background:${avatarGradient(peer.name)}">${initials(peer.name)}</div>
      <div class="chat-row-body">
        <div class="chat-row-top">
          <span class="chat-row-name">${escapeHtml(peer.name || "Без имени")}</span>
          <span class="chat-row-status status-${peer.status}">${peer.status === "connected" || peer.status === "in-call" ? "" : "●"}</span>
        </div>
        <div class="chat-row-sub">${last ? escapeHtml(truncate(last.text, 42)) : statusLabel(peer.status)}</div>
      </div>
    `;
    row.addEventListener("click", () => {
      state.chatId = id;
      renderTab();
    });
    list.appendChild(row);
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function initials(name) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

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

function renderChatThread() {
  const peer = state.peers.get(state.chatId);
  if (!peer) {
    state.chatId = null;
    renderTab();
    return;
  }
  $("#chat-peer-name").textContent = peer.name || "Без имени";
  $("#chat-peer-status").textContent = statusLabel(peer.status);
  $("#chat-call-btn").disabled = !(peer.status === "connected" || peer.status === "in-call");

  const wrap = $("#chat-messages");
  wrap.innerHTML = "";
  for (const m of peer.messages) {
    const bubble = document.createElement("div");
    bubble.className = "bubble-row " + (m.from === "me" ? "mine" : "theirs");
    bubble.innerHTML = `<div class="bubble ${m.from === "me" ? "" : "glass-content"}">${escapeHtml(m.text)}<span class="bubble-time">${formatTime(m.ts)}</span></div>`;
    wrap.appendChild(bubble);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function wireChatScreen() {
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text || !state.chatId) return;
    const peer = state.peers.get(state.chatId);
    const link = mesh.get(state.chatId);
    const sent = link && link.send({ kind: "chat", text, ts: Date.now() });
    peer.messages.push({ from: "me", text, ts: Date.now() });
    peer.lastActivity = Date.now();
    if (!sent) toast("Сообщение не доставлено — собеседник офлайн");
    input.value = "";
    renderChatThread();
  });

  $("#chat-call-btn").addEventListener("click", () => beginCall(state.chatId));
}

// ---------- Экран подключения ----------

function wireConnectScreen() {
  $("#create-invite-btn").addEventListener("click", createInvite);
  $("#copy-code-btn").addEventListener("click", () => copyText($("#invite-code-out").textContent, "Код скопирован"));
  $("#copy-link-btn").addEventListener("click", () => copyText($("#invite-link-out").textContent, "Ссылка скопирована"));
  $("#share-link-btn").addEventListener("click", async () => {
    const url = $("#invite-link-out").textContent;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Приглашение в Эфир", text: "Подключимся напрямую без серверов", url });
      } catch (e) {}
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
    smsBtnId: "invite-send-sms",
    mailBtnId: "invite-send-email",
    inputId: "invite-contact",
    textGetter: () =>
      `${Store.name} приглашает вас в Эфир — приложение для прямой связи без серверов. ` +
      `Откройте ссылку на устройстве, где установлено (или откроется) приложение: ${$("#invite-link-out").textContent}`,
  });

  wireContactSend({
    smsBtnId: "answer-send-sms",
    mailBtnId: "answer-send-email",
    inputId: "answer-contact",
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
  state.peers.set(id, { name: "Приглашение…", status: "awaiting-answer", messages: [], lastActivity: Date.now() });

  $("#invite-idle").classList.add("hidden");
  $("#invite-active").classList.remove("hidden");
  $("#invite-code-out").textContent = code;
  $("#invite-link-out").textContent = shareLink;
}

async function handleIncomingCode(code, fromLink) {
  let packet;
  try {
    packet = await SignalingCodec.decode(code);
  } catch (e) {
    toast("Код повреждён или неполный");
    return;
  }

  if (packet.t === "offer") {
    const id = crypto.randomUUID();
    const link = mesh.createIncomingLink(id);
    const answerPacket = await link.acceptOfferAndCreateAnswer(packet);
    const answerCode = await SignalingCodec.encode(answerPacket);
    state.peers.set(id, { name: packet.n || "Собеседник", status: "connecting", messages: [], lastActivity: Date.now() });

    state.tab = "connect";
    renderTab();
    $("#incoming-banner").classList.remove("hidden");
    $("#incoming-banner-text").textContent = `Приглашение от «${packet.n || "без имени"}» принято`;
    $("#answer-out-code").textContent = answerCode;
    $("#answer-out-wrap").classList.remove("hidden");
    $("#paste-code-wrap").classList.add("hidden");
  } else {
    toast("Это приглашение, а не код ответа — вставьте его в поле «У меня есть код»");
  }
}

// ---------- Отправка кода через SMS / почту (номер и email — не код,
// а просто адресат пересылки: открываем нативный SMS/Mail с готовым
// текстом, дальше это уже не касается ни WebRTC, ни нашего приложения) ----------

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function openSmsWith(number, body) {
  if (!number) {
    toast("Введите номер телефона");
    return;
  }
  const sep = isIOS() ? "&" : "?";
  location.href = `sms:${encodeURIComponent(number)}${sep}body=${encodeURIComponent(body)}`;
}

function openMailWith(email, body) {
  if (!email) {
    toast("Введите email");
    return;
  }
  const subject = encodeURIComponent("Приглашение в Эфир");
  location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${encodeURIComponent(body)}`;
}

function wireContactSend({ smsBtnId, mailBtnId, inputId, textGetter }) {
  const smsBtn = document.getElementById(smsBtnId);
  const mailBtn = document.getElementById(mailBtnId);
  if (smsBtn) smsBtn.addEventListener("click", () => openSmsWith($(`#${inputId}`).value.trim(), textGetter()));
  if (mailBtn) mailBtn.addEventListener("click", () => openMailWith($(`#${inputId}`).value.trim(), textGetter()));
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

// ---------- Звонки ----------

async function beginCall(id) {
  const peer = state.peers.get(id);
  const link = mesh.get(id);
  if (!peer || !link) return;
  try {
    await link.startCall();
  } catch (e) {
    toast("Нет доступа к микрофону");
    return;
  }
  openCallScreen(id, "calling");
}

function openCallScreen(id, phase) {
  state.callId = id;
  const peer = state.peers.get(id);
  $("#call-screen").classList.remove("hidden");
  $("#call-peer-name").textContent = peer.name || "Без имени";
  $("#call-peer-avatar").style.background = avatarGradient(peer.name);
  $("#call-peer-avatar").textContent = initials(peer.name);
  $("#call-phase").textContent = phase === "calling" ? "Вызов…" : phase === "ringing" ? "Входящий вызов" : "На связи";
  startCallTimer();
}

let callTimerInterval = null;
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
  state.callId = null;
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
}

// ---------- Настройки ----------

function wireSettingsScreen() {
  $("#settings-name").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) {
      Store.name = v;
      mesh.localName = v;
      toast("Имя обновлено");
    }
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
    if (!confirm("Разорвать все соединения?")) return;
    for (const id of Array.from(state.peers.keys())) mesh.remove(id);
    state.peers.clear();
    resetConnectScreen();
    renderTab();
    toast("Все соединения разорваны");
  });

  $("#how-it-works-btn").addEventListener("click", () => {
    $("#how-it-works-sheet").classList.remove("hidden");
  });
  $("#how-it-works-close").addEventListener("click", () => {
    $("#how-it-works-sheet").classList.add("hidden");
  });
}

// ---------- События mesh ----------

function wireMeshEvents() {
  mesh.addEventListener("link-status", (ev) => {
    const { id, status } = ev.detail;
    const peer = state.peers.get(id);
    if (!peer) return;
    const wasConnected = peer.status === "connected" || peer.status === "in-call";
    peer.status = status;

    if (status === "connected" && !wasConnected) {
      const link = mesh.get(id);
      if (link.remoteName) peer.name = link.remoteName;
      toast(`«${peer.name}» на связи`);
      if (state.pendingOutgoing && state.pendingOutgoing.id === id) resetConnectScreen();
    }
    if (status === "disconnected" && state.callId === id) closeCallScreen();

    if (state.chatId === id) renderChatThread();
    if (state.tab === "chats" && !state.chatId) renderChatsList();
  });

  mesh.addEventListener("message", (ev) => {
    const { id, payload } = ev.detail;
    const peer = state.peers.get(id);
    if (!peer) return;

    if (payload.kind === "chat") {
      peer.messages.push({ from: "them", text: payload.text, ts: payload.ts || Date.now() });
      peer.lastActivity = Date.now();
      if (state.chatId === id) renderChatThread();
      else toast(`${peer.name}: ${truncate(payload.text, 40)}`);
      if (state.tab === "chats") renderChatsList();
    }

    if (payload.kind === "call-state") {
      if (payload.state === "ringing" && state.callId !== id) {
        openCallScreen(id, "ringing");
      }
      if (payload.state === "ended") {
        if (state.callId === id) closeCallScreen();
      }
    }
  });

  mesh.addEventListener("remote-track", (ev) => {
    const { id, stream } = ev.detail;
    let audioEl = document.getElementById("remote-audio-" + id);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = "remote-audio-" + id;
      audioEl.autoplay = true;
      audioEl.hidden = true;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
    if (state.callId === id) $("#call-phase").textContent = "На связи";
  });
}

// ---------- Старт ----------

document.addEventListener("DOMContentLoaded", initOnboarding);
