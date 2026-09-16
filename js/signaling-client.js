// Тонкий клиент к сигнальному серверу. Его роль строго ограничена:
// сообщить "я на связи", узнать, кто из контактов сейчас тоже на связи,
// и один раз переслать пакет подключения (offer/answer). Дальше в дело
// вступает WebRTC напрямую — сигнальный сервер к переписке и звонку
// никакого отношения больше не имеет.

// ---------- Совместимость со старыми версиями сервера ----------
// Старые сборки relay отдавали online как массив голых id (строк),
// новые — массив объектов {id, name, visible}. Разбираем оба формата,
// чтобы рассинхрон версий клиент/сервер не ломал всё молча.

function normalizeRosterEntry(u) {
  if (typeof u === "string") return { id: u, name: "", visible: true };
  return { id: u.id, name: u.name || "", visible: u.visible !== false };
}

class SignalingClient extends EventTarget {
  constructor(url, myId, opts = {}) {
    super();
    this.url = url;
    this.myId = myId;
    this.name = opts.name || "";
    this.visible = opts.visible !== false;
    this.ws = null;
    this.shouldRun = false;
    this._retryDelay = 1000;
    this.connected = false;
  }

  start() {
    this.shouldRun = true;
    this._connect();
  }

  stop() {
    this.shouldRun = false;
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
    }
  }

  _connect() {
    if (!this.shouldRun || !this.url) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this._retryDelay = 1000;
      this.connected = true;
      console.info("[signaling] соединение открыто, регистрируюсь как", this.myId.slice(0, 10) + "…");
      ws.send(JSON.stringify({ type: "register", id: this.myId, name: this.name, visible: this.visible }));
      this.dispatchEvent(new CustomEvent("connected"));
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === "registered") {
        const users = (msg.online || []).map(normalizeRosterEntry);
        console.info("[signaling] зарегистрирован, сейчас онлайн:", users.length);
        this.dispatchEvent(new CustomEvent("online-list", { detail: { users } }));
      } else if (msg.type === "presence") {
        console.info("[signaling] presence:", msg.id.slice(0, 10) + "…", msg.online ? "online" : "offline");
        this.dispatchEvent(new CustomEvent("presence", { detail: { id: msg.id, online: msg.online, name: msg.name, visible: msg.visible } }));
      } else if (msg.type === "signal") {
        console.info("[signaling] сигнал от", msg.from.slice(0, 10) + "…", msg.data && msg.data.t);
        this.dispatchEvent(new CustomEvent("signal", { detail: { from: msg.from, data: msg.data } }));
      } else if (msg.type === "unreachable") {
        console.info("[signaling] недоступен:", msg.to.slice(0, 10) + "…");
        this.dispatchEvent(new CustomEvent("unreachable", { detail: { to: msg.to } }));
      }
    });

    ws.addEventListener("close", () => {
      this.connected = false;
      console.info("[signaling] соединение закрыто, переподключаюсь…");
      this.dispatchEvent(new CustomEvent("disconnected"));
      this._scheduleRetry();
    });
    ws.addEventListener("error", (e) => {
      console.warn("[signaling] ошибка соединения", e);
      try {
        ws.close();
      } catch (e2) {}
    });
  }

  _scheduleRetry() {
    if (!this.shouldRun) return;
    setTimeout(() => this._connect(), this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 1.6, 20000);
  }

  send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...payload }));
      return true;
    }
    return false;
  }

  signal(to, data) {
    return this.send("signal", { to, data });
  }
}

// ---------- Идентификатор из номера/почты ----------
// Сам номер телефона или email на сервер не уходит — только их хэш,
// посчитанный прямо на устройстве. Это не анонимно (номера телефонов
// легко перебрать хэшированием — их пространство небольшое), но сервер
// физически не хранит и не видит сами контактные данные.

const Identity = (() => {
  function normalize(raw) {
    const trimmed = raw.trim();
    if (trimmed.includes("@")) {
      return { type: "email", value: trimmed.toLowerCase() };
    }
    const digits = trimmed.replace(/[^\d+]/g, "");
    return { type: "phone", value: digits };
  }

  async function hashId(normalizedValue) {
    const bytes = new TextEncoder().encode("ether:" + normalizedValue);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function idFor(raw) {
    const { type, value } = normalize(raw);
    if (!value) throw new Error("Пустое значение");
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
