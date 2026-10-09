// Клиент к сигнальному серверу: presence, сигнальные пакеты, доставка
// зашифрованных конвертов, Web Push подписка, heartbeat.

window.__etherDiag = window.__etherDiag || [];
// "info" печатался в консоль безусловно для всех уровней — на
// продакшене (обычный пользователь, не localhost и debug-вкладка не
// включена) это десятки строк мусора в DevTools на каждое переподключение,
// presence-обновление и т.п. "warn"/"error" остаются ВСЕГДА — это именно
// то, что нужно видеть при реальной проблеме. Кольцевой буфер
// __etherDiag (экран "Диагностика") пишется независимо от этого фильтра
// — ничего не теряется для отправки в поддержку, приглушается только
// живой вывод в консоль разработчика.
function etherLogShouldPrint(level) {
  if (level !== "info") return true;
  try {
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return true;
    if (typeof Store !== "undefined" && Store.debugHidden === false) return true;
  } catch (e) {}
  return false;
}
function etherLog(level, ...args) {
  const line = args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
  window.__etherDiag.push({ ts: Date.now(), level, line });
  if (window.__etherDiag.length > 500) window.__etherDiag.shift();
  if (etherLogShouldPrint(level)) (console[level] || console.log).call(console, ...args);
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

const CONNECT_TIMEOUT_MS = 7000;
const SLOW_CONNECT_MS = 3500;

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
    // connected=true уже при открытии WS-соединения (до подтверждения
    // регистрации сервером) — исторически так, и почти весь app.js на
    // это полагается, менять рискованно. registered — более точный
    // флаг для случаев, где важно именно "сервер подтвердил, кто я" —
    // становится true только по сообщению "registered".
    this.registered = false;
    this._stopped = false;
    this._pushSubscription = null;
    this._pingTimer = null;
    this._lastPongAt = 0;
    this._connectTimer = null;     // таймаут установления WebSocket
    this._slowTimer = null;        // «сервер просыпается» — подсказка при долгом подключении
    this._resumeProbe = null;      // проверка «живости» сокета после возврата из фона
  }

  start() {
    // Раньше _stopped не сбрасывался — если клиент останавливали через
    // stop() и потом запускали на том же экземпляре, start() молча
    // ничего не делал. Сейчас app.js создаёт новый клиент вместо
    // stop→start, поэтому это мина под будущий рефакторинг.
    this._stopped = false;
    if (this.shouldRun) return;
    this.shouldRun = true;
    this._connect();
    this._startHeartbeat();
  }

  stop() {
    this.shouldRun = false;
    this._stopped = true;
    this.connected = false;
    this.registered = false;
    this._stopHeartbeat();
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    clearTimeout(this._connectTimer); clearTimeout(this._slowTimer); clearTimeout(this._resumeProbe);
    if (this.ws) {
      // Раньше тут было this.ws.onopen = this.ws.onmessage = ... = null —
      // выглядело как «снимаем обработчики», но на самом деле ничего не
      // снимало: все слушатели навешаны через addEventListener (см.
      // _connect), а не через свойства onopen/onmessage/..., так что
      // присвоение им null было no-op. Реального эффекта это не имело —
      // каждый обработчик сам проверяет if (this.ws !== ws) return первой
      // строкой, так что событие на уже закрытом/подмененном ws безвредно
      // игнорируется и без явного снятия слушателей. Убрано как мёртвый код,
      // а не переписано на removeEventListener — ничего не ломалось.
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
  }

  _connect() {
    if (!this.shouldRun || !this.url || this._stopped) return;
    // Никогда не держим два сокета одновременно: второй register с тем же id заставил бы сервер выбросить первый («replaced»)
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (e) { this._scheduleRetry(); return; }
    this.ws = ws;
    // Бесплатный Render «засыпает» без обращений, и холодный старт держит рукопожатие десятки секунд;
    // на мобильной сети зависшее рукопожатие тоже бывает. Не ждём вечно: через CONNECT_TIMEOUT_MS
    // пробуем заново (новое TCP/TLS-соединение часто проходит сразу), а через SLOW_CONNECT_MS
    // сообщаем интерфейсу, чтобы он показал «сервер просыпается».
    clearTimeout(this._connectTimer); clearTimeout(this._slowTimer);
    this._slowTimer = setTimeout(() => { if (this.ws === ws && !this.connected) this.dispatchEvent(new CustomEvent("slow-connect")); }, SLOW_CONNECT_MS);
    this._connectTimer = setTimeout(() => {
      if (this.ws !== ws || this.connected) return;
      etherLog("warn", "[signaling] подключение дольше " + (CONNECT_TIMEOUT_MS / 1000) + " с, пробую заново");
      this._retryDelay = 300;
      try { ws.close(); } catch (e) {}
      // close-событие у зависшего сокета может прийти не сразу — не ждём его
      if (this.ws === ws) { this.ws = null; this.connected = false; this._scheduleRetry(); }
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      clearTimeout(this._connectTimer); clearTimeout(this._slowTimer);
      this._retryDelay = 1000;
      this.connected = true;
      this._lastPongAt = Date.now();
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

      if (msg.type === "pong") {
        this._lastPongAt = Date.now();
        return;
      }

      if (msg.type === "registered") {
        this.registered = true;
        const users = (Array.isArray(msg.online) ? msg.online : []).map(normalizeRosterEntry).filter(Boolean);
        etherLog("info", "[signaling] зарегистрирован, онлайн:", users.length);
        this.dispatchEvent(new CustomEvent("online-list", { detail: { users } }));
      } else if (msg.type === "register-rate-limited") {
        // Сервер отклонил регистрацию по лимиту попыток — раньше клиент
        // это молча игнорировал, и пользователь просто видел "офлайн" без
        // объяснения причины.
        etherLog("warn", "[signaling] регистрация отклонена — превышен лимит попыток");
        this.dispatchEvent(new CustomEvent("register-rate-limited"));
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
        etherLog("warn", "[signaling] вкладка отключена сервером — тот же id открыт в другом месте" + (msg.sameIp === true ? " (тот же адрес/сеть)" : msg.sameIp === false ? " (другой адрес)" : "") + (typeof msg.ageSec === "number" ? ", моё соединение жило " + msg.ageSec + " с" : ""));
        // Раньше здесь вручную ставилось shouldRun = false без вызова stop() —
        // _pingTimer (setInterval каждые 15с) продолжал тикать до конца жизни
        // страницы, просто находя this.ws === null и выходя по return.
        // Утечка ресурса без эффекта, но stop() — правильный и симметричный
        // способ остановиться (заодно гасит retry-таймер и сам ws).
        this.stop();
        this.dispatchEvent(new CustomEvent("replaced"));
      }
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.registered = false;
      etherLog("info", "[signaling] соединение закрыто, переподключаюсь…");
      this.dispatchEvent(new CustomEvent("disconnected"));
      this._scheduleRetry();
    });

    ws.addEventListener("error", (e) => {
      etherLog("warn", "[signaling] ошибка соединения", String(e));
      try { ws.close(); } catch (e2) {}
    });
  }

  // Приложение вернулось из фона / сеть появилась: не ждём таймеров (на iOS сокет мог умереть незаметно).
  resume() {
    if (!this.shouldRun || this._stopped) return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      this.ws = null; this.connected = false; this._retryDelay = 300;
      this._connect();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return; // идёт подключение — таймаут сам разберётся
    // Сокет «открыт», но мог быть заморожен системой: проверяем pong за 3 секунды
    const before = this._lastPongAt;
    try { ws.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch (e) { try { ws.close(); } catch (e2) {} return; }
    clearTimeout(this._resumeProbe);
    this._resumeProbe = setTimeout(() => {
      if (this.ws === ws && this._lastPongAt === before) {
        etherLog("warn", "[signaling] после возврата из фона нет pong — переподключаюсь");
        this._retryDelay = 300;
        try { ws.close(); } catch (e) {}
        if (this.ws === ws) { this.ws = null; this.connected = false; this.registered = false; this.dispatchEvent(new CustomEvent("disconnected")); this._connect(); }
      }
    }, 3000);
  }

  _scheduleRetry() {
    if (!this.shouldRun || this._stopped) return;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connect();
    }, this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 1.6, 20000);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const sincePong = this._lastPongAt ? (Date.now() - this._lastPongAt) : 0;
      // iOS замораживает WebSocket и setInterval в фоне. При возврате
      // из фона первый же тик показывает "no pong for 46s" — хотя
      // реального отсутствия pong не было. Отсекаем этот ложный
      // сценарий: если страница была невидима, pong не может считаться
      // "просроченным". Проверяем document.visibilityState.
      const pageWasHidden = typeof document !== "undefined" && document.hidden;
      if (this._lastPongAt && sincePong > 90000 && !pageWasHidden) {
        etherLog("warn", "[signaling] no pong for " + Math.round(sincePong / 1000) + "s, force-reconnect");
        try { this.ws.close(); } catch (e) {}
        this._lastPongAt = 0;
        return;
      }
      try {
        this.ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
      } catch (e) {
        etherLog("warn", "[signaling] ping send failed:", String(e));
      }
    }, 15000);
  }

  _stopHeartbeat() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
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
    let lang = "en";
    try { if (typeof I18N !== "undefined" && I18N.current) lang = I18N.current; } catch (e) {}
    return this.send("push-subscribe", { subscription, lang });
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
    // "+15551234" и "15551234" — один и тот же номер для человека, но
    // раньше давали РАЗНЫЙ id (плюс просто сохранялся, только если сам
    // ввёл): переписывались один и тот же телефон в разных чатах никогда
    // бы не совпали друг с другом. Приложение ещё в разработке,
    // пользователей с уже закреплённым id нет — можно исправить сейчас,
    // не откладывая: всегда добавляем "+", независимо от того, что ввёл
    // пользователь.
    const digits = trimmed.replace(/\D/g, "");
    return { type: "phone", value: "+" + digits };
  }

  async function hashId(normalizedValue) {
    const bytes = new TextEncoder().encode("ether:" + normalizedValue);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function idFor(raw) {
    const { type, value } = normalize(raw);
    if (!value || value === "+") throw new Error("toast.emptyId");
    if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      throw new Error("toast.invalidIdFormat");
    }
    if (type === "phone") {
      // Раньше проверялось только "6+ цифр" без верхней границы — почти
      // любой набор цифр проходил, даже совсем не похожий на реальный
      // номер (например "123456"). E.164 (международный стандарт
      // нумерации) укладывается в 7-15 цифр включая код страны —
      // используем эти границы как разумную проверку формата, не
      // строгую валидацию по операторским правилам конкретной страны.
      const digitCount = value.replace(/\D/g, "").length;
      if (digitCount < 7 || digitCount > 15) throw new Error("toast.invalidIdFormat");
    }
    const id = await hashId(value);
    return { id, normalized: value, type };
  }

  return { normalize, hashId, idFor };
})();