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
  try { // окно могло уже закрыться (выгрузка страницы, тесты) — журнал не должен ронять вызывающий код
    window.__etherDiag.push({ ts: Date.now(), level, line });
    if (window.__etherDiag.length > 500) window.__etherDiag.shift();
  } catch (e) { return; }
  if (etherLogShouldPrint(level)) (console[level] || console.log).call(console, ...args);
}
function safeJson(a) {
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}

function normalizeRosterEntry(u) {
  if (!u) return null;
  if (typeof u === "string") return { id: u, name: "", visible: true, publicKey: null };
  if (typeof u !== "object" || typeof u.id !== "string") return null;
  return { id: u.id, name: u.name || "", visible: u.visible !== false, publicKey: u.publicKey || null, caps: Array.isArray(u.caps) ? u.caps.filter((x) => typeof x === "string").slice(0, 8) : [] };
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
    this.guest = opts.guest === true; // V.79: гость звонка по ссылке — сокет без register (допустим только linkcall-join)
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
    catch (e) { this.dispatchEvent(new CustomEvent("connect-failed", { detail: { url: this.url } })); this._scheduleRetry(); return; }
    this.ws = ws;
    const startedAt = Date.now(); let opened = false; // multi-server: сообщаем о неудачной попытке подключения (connect-failed) и замеряем время рукопожатия
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
      if (this.ws === ws) { this.ws = null; this.connected = false; this.dispatchEvent(new CustomEvent("connect-failed", { detail: { url: this.url } })); this._scheduleRetry(); }
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      clearTimeout(this._connectTimer); clearTimeout(this._slowTimer);
      this._retryDelay = 1000;
      opened = true; this.connectMs = Date.now() - startedAt;
      this.connected = true;
      this._lastPongAt = Date.now();
      if (this.guest) { this.dispatchEvent(new CustomEvent("connected")); return; }
      etherLog("info", "[signaling] соединение открыто, регистрируюсь как", String(this.myId).slice(0, 10) + "…");
      ws.send(JSON.stringify({
        type: "register",
        deviceId: this.deviceId || undefined, // companion-устройство (docs/MULTIDEVICE.md): сервер ответит device-challenge
        id: this.myId,
        name: this.name,
        visible: this.visible,
        publicKey: this.publicKey,
        // Доказательство владения id (sha256 от секрета устройства, не сам секрет); старый сервер поле игнорирует
        claim: this.claim || undefined,
        // Что умеет этот клиент (env2 — офлайн-конверты v2 с AAD)
        caps: ["env2"],
        // Контакты, чьё присутствие нужно видеть: сервер не раскрывает остальных (старый сервер поле просто игнорирует)
        watch: this.watchIds ? this.watchIds() : undefined,
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
      if (msg.type === "device-challenge" && typeof msg.nonce === "string" && this.deviceSign) {
        Promise.resolve(this.deviceSign(msg.nonce, this.myId, this.deviceId)).then((sig) => { if (this.ws === ws && sig) this.send("device-auth", { sig }); }).catch(() => {});
        return;
      }
      if (msg.type === "devices-list" && typeof msg.rid === "string") { this.dispatchEvent(new CustomEvent("devices-list", { detail: { rid: msg.rid, to: msg.to, list: msg.list || null } })); return; }
      if (msg.type === "devices-updated" && typeof msg.id === "string") { this.dispatchEvent(new CustomEvent("devices-updated", { detail: { id: msg.id, seq: msg.seq } })); return; }
      if (msg.type === "device-revoked") { this.shouldRun = false; this.dispatchEvent(new CustomEvent("device-revoked")); return; }
      if (msg.type === "register-error" && msg.error === "device-not-authorized") { this.dispatchEvent(new CustomEvent("device-unauthorized")); return; }

      if (msg.type === "registered") {
        this.registered = true;
        this.claimed = msg.claimed === true; // сервер держит claim этого id (нужен для алиаса при миграции id)
        this.features = Array.isArray(msg.features) ? msg.features.filter((f) => typeof f === "string").slice(0, 20) : [];
        this.prekeyCount = Number.isInteger(msg.prekeyCount) ? msg.prekeyCount : null;
        const users = (Array.isArray(msg.online) ? msg.online : []).map(normalizeRosterEntry).filter(Boolean);
        etherLog("info", "[signaling] зарегистрирован, онлайн:", users.length);
        this.dispatchEvent(new CustomEvent("online-list", { detail: { users } }));
        this.dispatchEvent(new CustomEvent("registered", { detail: { claimed: this.claimed, connectMs: this.connectMs || 0 } }));
        // Обнаружение по хэшу телефона/почты: соль HMAC и признак «моя запись опубликована» (только если сервер объявил feature "discovery")
        this.discoverySalt = this.features.includes("discovery") && typeof msg.discoverySalt === "string" && /^[0-9a-zA-Z_-]{16,200}$/.test(msg.discoverySalt) ? msg.discoverySalt : "";
        this.discoveryPublished = msg.discoveryPublished === true;
        this.dispatchEvent(new CustomEvent("discovery-state", { detail: { salt: this.discoverySalt, published: this.discoveryPublished } }));
        // Миграция id: алиас старого id -> этот (сервер пересылает на него сообщения контактов, ещё не перешедших на новый id)
        if (this.aliasOld && (this.aliasOldClaim || this.claim) && this.features.includes("alias")) this.send("alias-set", { old: this.aliasOld, oldClaim: this.aliasOldClaim || this.claim });
      } else if (msg.type === "alias-result") {
        this.aliasActive = msg.ok === true;
        this.dispatchEvent(new CustomEvent("alias-result", { detail: { ok: msg.ok === true, old: typeof msg.old === "string" ? msg.old.slice(0, 128) : "", error: typeof msg.error === "string" ? msg.error.slice(0, 30) : null } }));
      } else if (msg.type === "discovery-result" && typeof msg.rid === "string") {
        this.dispatchEvent(new CustomEvent("discovery-result", { detail: { rid: msg.rid, found: Array.isArray(msg.found) ? msg.found.slice(0, 200) : [], error: typeof msg.error === "string" ? msg.error.slice(0, 30) : null } }));
      } else if (msg.type === "discovery-published") {
        this.discoveryPublished = msg.ok === true && msg.count > 0;
        this.dispatchEvent(new CustomEvent("discovery-published", { detail: { ok: msg.ok === true, count: msg.count | 0, error: typeof msg.error === "string" ? msg.error.slice(0, 30) : null } }));
      } else if (msg.type === "watch-result") {
        const users = (Array.isArray(msg.online) ? msg.online : []).map(normalizeRosterEntry).filter(Boolean);
        this.dispatchEvent(new CustomEvent("online-list", { detail: { users } }));
      } else if (msg.type === "register-error") {
        // Сервер отказал в регистрации (id-claimed: id закреплён за другим устройством). Повторять смысла нет — останавливаемся.
        etherLog("warn", "[signaling] регистрация отклонена:", String(msg.error || "").slice(0, 40));
        this.lastRegisterError = typeof msg.error === "string" ? msg.error.slice(0, 40) : "error";
        if (msg.error === "id-claimed") this.stop();
        this.dispatchEvent(new CustomEvent("register-error", { detail: { error: this.lastRegisterError, claimTtlH: Number.isFinite(msg.claimTtlH) ? msg.claimTtlH : undefined } }));
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
          detail: { id: msg.id, online: !!msg.online, name: msg.name, visible: msg.visible, publicKey: msg.publicKey, caps: Array.isArray(msg.caps) ? msg.caps.filter((x) => typeof x === "string").slice(0, 8) : [] },
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
            fromDev: typeof msg.fromDev === "string" ? msg.fromDev : null,
            kind: msg.kind || "chat",
            queued: !!msg.queued,
          },
        }));
      } else if (msg.type === "deliver-ack" && typeof msg.msgId === "string") {
        this.dispatchEvent(new CustomEvent("deliver-ack", { detail: { msgId: msg.msgId, error: typeof msg.error === "string" ? msg.error : null } }));
      } else if (msg.type === "prekey-bundle" && typeof msg.rid === "string") {
        this.dispatchEvent(new CustomEvent("prekey-bundle", { detail: { rid: msg.rid, to: msg.to, spk: msg.spk || null, opk: msg.opk || null, error: typeof msg.error === "string" ? msg.error : null } }));
      } else if (msg.type === "prekey-stored") {
        if (Number.isInteger(msg.count)) this.prekeyCount = msg.count;
        this.dispatchEvent(new CustomEvent("prekey-stored", { detail: { count: msg.count, error: msg.error || null } }));
      } else if (msg.type === "prekey-low") {
        this.prekeyCount = Number.isInteger(msg.count) ? msg.count : 0;
        this.dispatchEvent(new CustomEvent("prekey-low", { detail: { count: this.prekeyCount } }));
      } else if (msg.type === "linkcall-signal" && typeof msg.room === "string") {
        this.dispatchEvent(new CustomEvent("linkcall-signal", { detail: { room: msg.room.slice(0, 64), data: msg.data } }));
      } else if (/^(linkcall-|call-ringing$|push-test)/.test(msg.type)) {
        // V.79 (docs/CALL-RELIABILITY-PROTOCOL.md C/E): ответы сервера на link-call, «звонит у собеседника», результат теста гудков
        this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
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
      if (!opened) this.dispatchEvent(new CustomEvent("connect-failed", { detail: { url: this.url } }));
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
    }, 5000); // 3 с на медленном мобильном канале и холодном сервере давали лишние переподключения
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
      if (this._lastPongAt && sincePong > 90000 && !pageWasHidden && !this.guest) {
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

  // Миграция id: legacyId/legacyFor(to) - от имени какого id слать этому адресату (контакт ещё пишет на старый id; сервер ставит from=старый id только по алиасу)
  _asFor(to) { return this.aliasActive && this.legacyId && typeof this.legacyFor === "function" && this.legacyFor(to) ? { as: this.legacyId } : {}; }
  signal(to, data) {
    // V.79: виртуальный собеседник link-call ("lc:<room>") — тот же код звонка, но транспорт linkcall-signal (docs протокол E)
    if (typeof to === "string" && to.slice(0, 3) === "lc:") return this._lcOut ? this._lcOut(to.slice(3), data) : this.send("linkcall-signal", { room: to.slice(3), data });
    return this.send("signal", { to, data, ...this._asFor(to) });
  }
  linkcallCreate() { return this.send("linkcall-create", {}); }
  linkcallJoin(p) { return this.send("linkcall-join", p && p.room ? { room: p.room, name: p.name || undefined } : { code: p && p.code, name: p && p.name || undefined }); }
  linkcallAllow(room, guestRef) { return this.send("linkcall-allow", { room, guestRef }); }
  linkcallDeny(room, guestRef) { return this.send("linkcall-deny", { room, guestRef }); }
  linkcallEnd(room) { return this.send("linkcall-end", { room }); }
  pushTestRing() { return this.send("push-test-ring", {}); }

  // Копии для других устройств получателя/аккаунта: [{dev, envelope}] (dev "" = основное); sync-sent себе — только копии, без envelope
  deliverMulti(to, msgId, envelope, fromPublicKey, kind, copies) {
    if (!Array.isArray(copies) || !copies.length || copies.length > 8) return false;
    return this.send("deliver", { to, msgId, envelope: envelope || undefined, fromPublicKey, kind: typeof kind === "string" ? kind : "chat", copies, ...this._asFor(to) });
  }
  getDevices(to, rid) { return this.send("devices-get", { to, rid }); }
  putDevices(list) { return this.send("devices-put", { list }); }

  deliver(to, msgId, envelope, fromPublicKey, kind) {
    // v1: {iv, ct}; v2 (Double Ratchet): {v:2, h, ct} — у v2 нет iv, заголовок h несёт номера и ключи храповика
    if (!envelope || typeof envelope.ct !== "string") return false;
    if (typeof envelope.iv !== "string" && !(envelope.v === 2 && envelope.h && typeof envelope.h === "object")) return false;
    return this.send("deliver", {
      to,
      msgId,
      envelope,
      fromPublicKey,
      kind: typeof kind === "string" ? kind : "chat",
      ...this._asFor(to),
    });
  }

  mailboxAck(msgId) { return this.send("mailbox-ack", { msgId }); }

  // Prekey-пакеты для начала Double Ratchet (см. ratchet.js): выложить свои публичные ключи / запросить пакет собеседника.
  // Заменяет список наблюдаемых контактов (сервер ответит watch-result с теми, кто сейчас онлайн)
  watch(ids) { return this.send("watch", { ids: Array.from(ids || []).slice(0, 2000) }); }
  uploadPrekeys(payload) { return this.send("prekey-upload", { spk: payload.spk, opks: payload.opks }); }
  fetchPrekeys(to, rid) { return this.send("prekey-fetch", { to, rid }); }
  // Обнаружение по хэшу: публикация своего ключа (hashes=[] — снять) и поиск по списку хэшей (≤200)
  discoveryPublish(hashes, shareName, name) { return this.send("discovery-publish", { hashes: Array.from(hashes || []).slice(0, 3), shareName: !!shareName, name: shareName ? String(name || "").slice(0, 60) : "" }); }
  discoveryLookup(rid, hashes) { return this.send("discovery-lookup", { rid, hashes: Array.from(hashes || []).slice(0, 200) }); }

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

// ---------- V.79: звонок по ссылке (docs/CALL-RELIABILITY-PROTOCOL.md, E): формат ссылки, секрет k, HMAC отпечатков, сверочные значки ----------
const LinkCall = (() => {
  const b64u = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64u = (s) => { const t = String(s).replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  const ROOM_RE = "[A-Za-z0-9_-]{16,64}", K_RE = "[A-Za-z0-9_-]{22}";
  function newSecret() { return b64u(crypto.getRandomValues(new Uint8Array(16))); }
  function buildLink(base, room, k) { return String(base || "") + "#call=" + room + "." + k; }
  // "#call=<room>.<k>" (или целая ссылка/текст сообщения) -> { room, k } | null
  function parseHash(h) {
    const m = new RegExp("(?:^|[#&?\\s])call=(" + ROOM_RE + ")\\.(" + K_RE + ")(?![A-Za-z0-9_-])").exec(String(h || ""));
    return m ? { room: m[1], k: m[2] } : null;
  }
  // "#answer=<callId>&from=<id>" -> { callId, from } | null
  function parseAnswerHash(h) {
    const m = /^#?answer=([^&]{1,80})&from=([^&]{1,200})$/.exec(String(h || ""));
    if (!m) return null;
    try { return { callId: decodeURIComponent(m[1]), from: decodeURIComponent(m[2]) }; } catch (e) { return null; }
  }
  function normalizeCode(v) { const d = String(v || "").replace(/\D/g, ""); return d.length === 6 ? d : null; }
  function shareText(tpl, name, link, code) { return String(tpl).replace("{name}", () => name).replace("{link}", () => link).replace("{code}", () => code); }
  // первый a=fingerprint из SDP в формате PeerLink.fingerprints(): "sha-256 ab:cd:…" (нижний регистр)
  function fingerprintOf(sdp) {
    const m = /a=fingerprint:(\S+)[ \t]+([0-9A-Fa-f:]+)/.exec(String(sdp || ""));
    return m ? m[1].toLowerCase() + " " + m[2].toLowerCase() : null;
  }
  // HMAC-SHA256(k, "<локальный>|<удалённый>") -> base64url. До согласования удалённого отпечатка remote = "".
  async function proof(k, local, remote) {
    const key = await crypto.subtle.importKey("raw", unb64u(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(local || "") + "|" + String(remote || "")))));
  }
  const EMOJI = ["🐶", "🐱", "🦊", "🐻", "🐼", "🐸", "🐵", "🦁", "🐯", "🐰", "🦄", "🐙", "🐢", "🐳", "🦋", "🐝", "🌵", "🌲", "🌻", "🍀", "🍎", "🍋", "🍉", "🍓", "🍕", "🍪", "🎈", "🎸", "🚀", "⚽", "🔑", "🔔", "⭐", "🌙", "☀️", "⚡", "❄️", "🔥", "🌈", "☂️", "🎁", "📌", "🧩", "🎲", "🚲", "⛵", "🏠", "🎯", "🍄", "🥑", "🍩", "🥕", "🎻", "🪁", "🧲", "🔭", "🪐", "🦉", "🐞", "🦀", "🍇", "🌶️", "🎺", "🛎️"];
  // 4 значка из отпечатка DTLS: обе стороны видят одно и то же, если никто не подменил SDP по дороге
  async function emojiOf(fp) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ether-lc-sas|" + String(fp || ""))));
    return [0, 1, 2, 3].map((i) => EMOJI[h[i] % EMOJI.length]).join(" ");
  }
  const isId = (id) => typeof id === "string" && id.slice(0, 3) === "lc:";
  return { newSecret, buildLink, parseHash, parseAnswerHash, normalizeCode, shareText, fingerprintOf, proof, emojiOf, isId, roomOf: (id) => String(id).slice(3), idOf: (room) => "lc:" + room, b64u, unb64u, EMOJI };
})();

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

  // C2 (аудит V.76): id = SHA-256 телефона без соли перебирается по всему пространству номеров. Полная замена (случайный id /
  // HMAC с серверной солью) ломает существующие id и поиск контактов по номеру (обе стороны обязаны получить один id; старые клиенты
  // считают v1), поэтому здесь только совместимый шаг: id v1 остаётся как есть (idFor), а для НОВЫХ механизмов есть версионированный
  // медленный вывод v2 = PBKDF2-SHA256(600k итераций, соль "ether-id-v2") с тегом "v2:". Он не подключён к регистрации/поиску,
  // пока сервер не научится принимать оба вида (v1 остаётся принимаемым). Перебор номеров становится дороже на ~5 порядков на попытку.
  const ID_V2_TAG = "v2:", ID_V2_ITER = 600000;
  async function hashIdV2(normalizedValue, iterations) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ID_V2_TAG + normalizedValue), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode("ether-id-v2"), iterations: iterations || ID_V2_ITER }, key, 256);
    return ID_V2_TAG + Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function idV2For(raw, iterations) {
    const r = await idFor(raw); // та же нормализация и проверка формата
    return { id: await hashIdV2(r.normalized, iterations), idV1: r.id, normalized: r.normalized, type: r.type };
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

  const isV2 = (id) => typeof id === "string" && /^v2:[0-9a-f]{64}$/.test(id);
  // Вывод id v2 для интерфейса: перед тяжёлой частью отдаём управление UI (onProgress("start") -> кадр отрисовки -> deriveBits, который браузер
  // считает вне главного потока), затем onProgress("done"). iterations - ТОЛЬКО явный параметр для тестов; в приложении не передаётся (600 000).
  async function idV2ForAsync(raw, opts) {
    const o = opts || {};
    if (typeof o.onProgress === "function") { try { o.onProgress("start"); } catch (e) {} }
    await new Promise((r) => setTimeout(r, 30));
    try { return await idV2For(raw, o.iterations); }
    finally { if (typeof o.onProgress === "function") { try { o.onProgress("done"); } catch (e) {} } }
  }
  return { normalize, hashId, idFor, hashIdV2, idV2For, idV2ForAsync, isV2, ID_V2_ITER };
})();