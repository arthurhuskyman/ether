// Клиент к сигнальному серверу: presence, сигнальные пакеты, доставка
// зашифрованных конвертов, Web Push подписка.

window.__etherDiag = window.__etherDiag || [];
function etherLog(level, ...args) {
  const line = args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
  window.__etherDiag.push({ ts: Date.now(), level, line });
  if (window.__etherDiag.length > 300) window.__etherDiag.shift();
  (console[level] || console.log).call(console, ...args);
}
function safeJson(a) {
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}

function normalizeRosterEntry(u) {
  if (!u) return null;
  if (typeof u === "string") return { id: u, name: "", visible: true, publicKey: null };
  if (typeof u !== "object" || typeof u.id !== "string") return null;
  return { id: u.id, name: u.name || "", visible: u.visible !== false, publicKey: u.publicKey || null };
}

class SignalingClient extends EventTarget {
  constructor(url, myId, opts = {}) {
    super();
    this.url = url;
    this.myId = myId;
    this.name = opts.name || "";
    this.visible = opts.visible !== false;
    this.publicKey = opts.publicKey || null;
    this.ws = null;
    this.shouldRun = false;
    this._retryDelay = 1000;
    this._retryTimer = null;
    this.connected = false;
    this._stopped = false;
    this._pushSubscription = null;
  }

  start() {
    if (this._stopped) return;
    this.shouldRun = true;
    this._connect();
  }

  stop() {
    this.shouldRun = false;
    this._stopped = true;
    this.connected = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this.ws) {
      try {
        this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      } catch (e) {}
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
  }

  _connect() {
    if (!this.shouldRun || !this.url || this._stopped) return;
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (e) { this._scheduleRetry(); return; }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this._retryDelay = 1000;
      this.connected = true;
      etherLog("info", "[signaling] соединение открыто, регистрируюсь как", String(this.myId).slice(0, 10) + "…");
      ws.send(JSON.stringify({
        type: "register",
        id: this.myId,
        name: this.name,
        visible: this.visible,
        publicKey: this.publicKey,
      }));
      this.dispatchEvent(new CustomEvent("connected"));
    });

    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "registered") {
        const users = (Array.isArray(msg.online) ? msg.online : []).map(normalizeRosterEntry).filter(Boolean);
        etherLog("info", "[signaling] зарегистрирован, онлайн:", users.length);
        this.dispatchEvent(new CustomEvent("online-list", { detail: { users } }));
      } else if (msg.type === "vapid-key" && typeof msg.key === "string") {
        etherLog("info", "[push] получен VAPID-ключ от сервера");
        this.dispatchEvent(new CustomEvent("vapid-key", { detail: { key: msg.key } }));
      } else if (msg.type === "push-subscribed") {
        etherLog("info", "[push] сервер подтвердил подписку");
        this.dispatchEvent(new CustomEvent("push-subscribed"));
      } else if (msg.type === "push-unsubscribed") {
        this.dispatchEvent(new CustomEvent("push-unsubscribed"));
      } else if (msg.type === "presence" && typeof msg.id === "string") {
        etherLog("info", "[signaling] presence:", msg.id.slice(0, 10) + "…", msg.online ? "online" : "offline");
        this.dispatchEvent(new CustomEvent("presence", {
          detail: { id: msg.id, online: !!msg.online, name: msg.name, visible: msg.visible, publicKey: msg.publicKey },
        }));
      } else if (msg.type === "signal" && typeof msg.from === "string") {
        etherLog("info", "[signaling] сигнал от", msg.from.slice(0, 10) + "…", msg.data && msg.data.t);
        this.dispatchEvent(new CustomEvent("signal", { detail: { from: msg.from, data: msg.data } }));
      } else if (msg.type === "unreachable" && typeof msg.to === "string") {
        etherLog("info", "[signaling] недоступен:", msg.to.slice(0, 10) + "…");
        this.dispatchEvent(new CustomEvent("unreachable", { detail: { to: msg.to } }));
      } else if (msg.type === "deliver" && typeof msg.from === "string" && typeof msg.msgId === "string") {
        etherLog("info", "[mailbox] конверт от", msg.from.slice(0, 10) + "…", msg.queued ? "(из очереди)" : "(напрямую)", "kind:", msg.kind);
        this.dispatchEvent(new CustomEvent("deliver", {
          detail: {
            from: msg.from,
            msgId: msg.msgId,
            envelope: msg.envelope,
            fromPublicKey: msg.fromPublicKey,
            kind: msg.kind || "chat",
            queued: !!msg.queued,
          },
        }));
      } else if (msg.type === "deliver-ack" && typeof msg.msgId === "string") {
        this.dispatchEvent(new CustomEvent("deliver-ack", { detail: { msgId: msg.msgId } }));
      } else if (msg.type === "replaced") {
        etherLog("warn", "[signaling] вкладка отключена сервером — тот же id открыт в другом месте");
        this.shouldRun = false;
        this.dispatchEvent(new CustomEvent("replaced"));
      }
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      etherLog("info", "[signaling] соединение закрыто, переподключаюсь…");
      this.dispatchEvent(new CustomEvent("disconnected"));
      this._scheduleRetry();
    });

    ws.addEventListener("error", (e) => {
      etherLog("warn", "[signaling] ошибка соединения", String(e));
      try { ws.close(); } catch (e2) {}
    });
  }

  _scheduleRetry() {
    if (!this.shouldRun || this._stopped) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connect();
    }, this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 1.6, 20000);
  }

  send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ type, ...payload }));
      return true;
    } catch (e) {
      etherLog("warn", "[signaling] не удалось отправить", type, String(e));
      return false;
    }
  }

  signal(to, data) { return this.send("signal", { to, data }); }

  // kind — открытая метка для сервера: "chat" | "ack-batch" | "edit" |
  // "delete" | "reaction" | "typing". Сервер использует её, чтобы решить,
  // слать ли push получателю. Само содержимое по-прежнему зашифровано.
  deliver(to, msgId, envelope, fromPublicKey, kind) {
    if (!envelope || typeof envelope.iv !== "string" || typeof envelope.ct !== "string") return false;
    return this.send("deliver", {
      to,
      msgId,
      envelope,
      fromPublicKey,
      kind: typeof kind === "string" ? kind : "chat",
    });
  }

  mailboxAck(msgId) { return this.send("mailbox-ack", { msgId }); }

  sendPushSubscription(subscription) {
    if (!subscription) return false;
    this._pushSubscription = subscription;
    return this.send("push-subscribe", { subscription });
  }

  sendPushUnsubscribe() {
    this._pushSubscription = null;
    return this.send("push-unsubscribe", {});
  }
}

// ---------- Идентификатор из телефона/email ----------
const Identity = (() => {
  function normalize(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return { type: "email", value: "" };
    if (trimmed.includes("@")) return { type: "email", value: trimmed.toLowerCase() };
    const plus = trimmed.startsWith("+") ? "+" : "";
    const digits = trimmed.replace(/\D/g, "");
    return { type: "phone", value: plus + digits };
  }

  async function hashId(normalizedValue) {
    const bytes = new TextEncoder().encode("ether:" + normalizedValue);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function idFor(raw) {
    const { type, value } = normalize(raw);
    if (!value || value === "+") throw new Error("Пустое значение");
    if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new Error("Похоже, это не email и не телефон");
    }
    if (type === "phone" && value.replace(/\D/g, "").length < 6) {
      throw new Error("Похоже, это не email и не телефон");
    }
    const id = await hashId(value);
    return { id, normalized: value, type };
  }

  return { normalize, hashId, idFor };
})();