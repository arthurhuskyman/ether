// Слой P2P-связи. ICE-серверы приходят с нашего сигнального сервера
// (эндпоинт GET /ice), который проксирует их от Metered и хранит
// API-ключ только у себя в переменных окружения. Пока список не
// загружен — ничего не создаётся, ждём window.__etherIceReady.

const DEFAULT_SIGNALING_FALLBACK = "wss://ether-1-baqy.onrender.com";

// Публичные STUN на случай, если наш /ice недоступен. TURN в этом
// режиме нет — пробиться через симметричный NAT не получится, но
// для большинства домашних сетей этого достаточно.
const FALLBACK_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

let ICE_SERVERS = [];

// Режим «только relay»: на ряде мобильных/домашних сетей (DPI-фильтрация WebRTC) ICE по UDP проходит («connected»),
// но DTLS так и не завершается и через ~6 с всё рвётся. Тогда следующая попытка идёт ТОЛЬКО через TURN (TCP/TLS 443 —
// выглядит как обычный HTTPS). Запоминаем по контакту на 30 минут.
const RELAY_ONLY_TTL_MS = 30 * 60 * 1000;
const relayOnlyUntil = new Map();
function markRelayOnly(id) { if (id) relayOnlyUntil.set(id, Date.now() + RELAY_ONLY_TTL_MS); }
function isRelayOnly(id) {
  const t = relayOnlyUntil.get(id);
  if (!t) return false;
  if (t < Date.now()) { relayOnlyUntil.delete(id); return false; }
  return true;
}
function relayCapableServers() {
  return ICE_SERVERS.filter((srv) => [].concat(srv.urls || []).some((u) => /^turns?:/i.test(u)));
}

function getMyId() {
  try { return localStorage.getItem("ether.myId") || ""; } catch (e) { return ""; }
}

function signalingUrlForIce() {
  let url = "";
  try {
    url = (localStorage.getItem("ether.signalingUrl") || "").trim();
  } catch (e) {}
  if (!url) url = DEFAULT_SIGNALING_FALLBACK;
  return url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}

// /ice на «спящем» бесплатном сервере (холодный старт Render) отвечает десятки секунд, а PeerLink'и
// не создаются, пока список не готов. Поэтому ждём не дольше ICE_FETCH_TIMEOUT_MS: на это время
// берём публичный STUN, а настоящий список (с TURN) догружаем в фоне — он применится к следующим соединениям.
const ICE_FETCH_TIMEOUT_MS = 4000;
async function fetchIceServers(timeoutMs) {
  const base = signalingUrlForIce();
  if (!base) return null;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl && timeoutMs ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, timeoutMs) : null;
  try {
    const r = await fetch(base.replace(/\/+$/, "") + "/ice", { cache: "no-store", signal: ctl ? ctl.signal : undefined });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const list = await r.json();
    if (Array.isArray(list) && list.length > 0) return list;
    return null;
  } catch (e) {
    if (window.etherLog) window.etherLog("warn", "[webrtc] /ice недоступен:", String(e));
    console.warn("[webrtc] /ice недоступен:", e);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}

async function refreshIceServersInBackground() {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    const list = await fetchIceServers(15000);
    if (list) {
      ICE_SERVERS = list;
      if (window.etherLog) window.etherLog("info", "[webrtc] ICE-серверы (с TURN) догружены в фоне:", list.length);
      return;
    }
  }
}

window.__etherIceReady = (async () => {
  const fromServer = await fetchIceServers(ICE_FETCH_TIMEOUT_MS);
  if (fromServer) {
    ICE_SERVERS = fromServer;
    if (window.etherLog) window.etherLog("info", "[webrtc] ICE-серверы получены с сигнального сервера:", ICE_SERVERS.length);
    console.log("[webrtc] ICE-серверы получены с сигнального сервера:", ICE_SERVERS.length);
  } else {
    ICE_SERVERS = FALLBACK_ICE.slice();
    if (window.etherLog) window.etherLog("warn", "[webrtc] использую fallback-STUN (без TURN), TURN догрузится в фоне");
    console.warn("[webrtc] использую fallback-STUN (без TURN)");
    refreshIceServersInBackground();
  }
})();

// Урезано с 3500мс: ICE-restart идёт только после уже установленного
// соединения (reInvite при сбое), и ждать 3.5 секунды на сбор полного
// набора кандидатов в этом случае неоправданно долго — реальный таймаут
// на подключение на порядок меньше. На первом соединении это значение
// вообще не используется (SDP уходит сразу, trickle ICE досылает
// кандидатов по мере появления).
const ICE_GATHER_TIMEOUT_MS = 2500;
// 60 секунд вместо 20: iOS/iPadOS замораживает setInterval в фоне, и
// при возврате _lastPongAt мог показывать возраст 40+ секунд — связь
// рвалась, хотя была жива. 60 секунд позволяют пережить короткий
// background-период. При полной заморозке дольше 60с — да, рвём, но
// пересоединение установит всё заново быстрее, чем реальный перерыв.
const HEARTBEAT_TIMEOUT_MS = 60000;
const DISCONNECT_GRACE_MS = 7000; // сколько ждём самовосстановления ICE, прежде чем считать линк отключённым

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function classifyCandidate(candidateStr) {
  if (!candidateStr) return "unknown";
  const m = candidateStr.match(/\b(host|srflx|prflx|relay)\b/);
  return m ? m[1] : "unknown";
}

class PeerLink extends EventTarget {
  constructor({ id, localName, remoteName = "", role }) {
    super();
    this.id = id;
    this.localName = localName;
    this.remoteName = remoteName;
    this.role = role;
    this.status = "new";
    this._closed = false;
    this._iceCandidates = [];
    this._iceErrors = [];
    this._pendingRemoteCandidates = []; // кандидаты, пришедшие ДО setRemoteDescription
    this._createdAt = Date.now();

    // Раньше тут читался модульный ICE_SERVERS напрямую — если линк
    // создаётся ДО того, как /ice успел ответить (особенно на холодном
    // сервере после простоя), ICE_SERVERS ещё [] и RTCPeerConnection
    // создаётся вовсе БЕЗ STUN/TURN, что резко ухудшает прохождение NAT
    // и правдоподобно объясняет "звонок долго устанавливается". Раньше
    // это ещё усугублялось тем, что boot всего приложения ждал именно
    // эту загрузку (см. bootAfterUnlock в app.js) — теперь не ждёт, так
    // что связь может понадобиться и раньше, чем /ice успеет ответить.
    //
    // iceCandidatePoolSize=10 (было 4): браузер собирает кандидатов
    // заранее, до старта сессии — при 4 кандидатах в сложных сетях
    // (двойной NAT, мобильные операторы) пул мог оказаться исчерпан
    // прежде, чем ICE реально стартует. 10 — недорого (несколько лишних
    // UDP-пакетов) и заметно ускоряет setup, особенно через TURN.
    const effectiveIceServers = ICE_SERVERS.length > 0 ? ICE_SERVERS : FALLBACK_ICE;
    const relayServers = isRelayOnly(id) ? relayCapableServers() : [];
    this._relayOnly = relayServers.length > 0;
    this.pc = new RTCPeerConnection(this._relayOnly
      ? { iceServers: relayServers, iceTransportPolicy: "relay", iceCandidatePoolSize: 4 }
      : { iceServers: effectiveIceServers, iceCandidatePoolSize: 10 });
    if (this._relayOnly) this._log("info", "[webrtc]", id.slice(0, 10) + "…", "режим relay-only (TURN)");
    // Страховка от "вечного connecting": обработчики ниже (iceconnectionstatechange
    // на "failed"/"disconnected") реагируют, только если браузер ФОРМАЛЬНО
    // объявит один из этих статусов — а бывают случаи (например, TURN
    // принял запрос на аллокацию, но реально не смог релеить трафик),
    // когда соединение просто зависает в "checking"/"new" НАВСЕГДА,
    // не переходя ни в failed, ни в disconnected, и reInvite() никогда
    // не срабатывает. Если за разумное время не дошли хотя бы до
    // "connected" — форсируем reInvite сами, не дожидаясь браузера.
    // Урезано с 15с до 10с: реальный failed приходит за 5-10с, запас
    // в 15с только зря откладывал восстановление.
    // _connectStallTimer срабатывает ОДИН РАЗ — только если мы ни разу
    // не дошли до "connected". Если соединение уже устанавливалось
    // (даже если сейчас disconnected), "stall" не наш случай —
    // подключение было, и повторять подключение через reInvite
    // бессмысленно (reInvite пересогласовывает SDP, а не пересоздаёт
    // ICE с нуля).
    this._everConnected = false;
    this._connectStallTimer = setTimeout(() => {
      this._connectStallTimer = null;
      if (this._closed) return;
      if (this._everConnected) return;
      if (this.pc.connectionState !== "connected") {
        this._log("warn", "[webrtc]", id.slice(0, 10) + "…", "connectionState всё ещё '" + this.pc.connectionState + "' спустя 10с, reInvite()");
        this.reInvite();
      }
    }, 10000);
    this.dc = null;
    this.localAudioTrack = null;
    this.localStream = null;
    this._audioAdded = false;
    this._videoAdded = false;
    this.localVideoTrack = null;
    // Screen sharing (раздел 7 роадмапа) — отдельный набор полей, не
    // переиспользует _videoAdded/localVideoTrack семантически, а ДЕЛИТ их
    // с камерой: во время показа экрана localVideoTrack временно указывает
    // на track экрана, а не камеры. _preScreenShareTrack хранит трек
    // камеры (если он был) на время показа экрана — чтобы вернуть его при
    // остановке, не запрашивая getUserMedia заново. _screenShareAddedVideo
    // отличает случай "видео не было вообще, экран добавил сендер с нуля"
    // от случая "видео (камера) уже было, экран просто заменил трек" — при
    // остановке в первом случае нужно убрать видео-сендер целиком, во
    // втором — вернуть камеру.
    this._screenSharing = false;
    this._screenShareAddedVideo = false;
    this._preScreenShareTrack = null;
    this._muted = false;
    this._muteRecheckTimer = null;
    this._pendingNegotiation = false;
    this._renegotiationRetryTimer = null;
    this._negotiationQueuedIceRestart = false;
    this._negotiationPendingOnOpen = false; // если addTrack сработал раньше, чем открылся dc — не теряем это молча
    this._makingOffer = false; // для Perfect Negotiation (устранение glare при одновременном createOffer с двух сторон)
    this._polite = getMyId() < id; // детерминированно и одинаково с обеих сторон: у кого id меньше — тот "вежливый" (уступает при столкновении)
    this._pingTimer = null;
    this._iceDisconnectTimer = null;
    this._lastPongAt = 0;

    this._log("info", "[webrtc]", id.slice(0, 10) + "…", "создан PeerLink, role=" + role);

    this.pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate) {
        const c = ev.candidate;
        const kind = c.type || classifyCandidate(c.candidate);
        this._iceCandidates.push({
          type: kind,
          protocol: c.protocol || "?",
          address: c.address || "?",
          port: c.port || 0,
          tcpType: c.tcpType || null,
          ts: Date.now(),
        });
        if (this._iceCandidates.length > 200) this._iceCandidates.shift(); // диагностика, не нужно копить бесконечно через reInvite()-циклы
        this._log("info", "[webrtc]", id.slice(0, 10) + "…", "ICE " + kind + " " + (c.protocol || "?"), (c.address || "") + ":" + (c.port || ""));
        this.dispatchEvent(new CustomEvent("ice-candidate", { detail: { candidate: c, type: kind } }));
      } else {
        this._log("info", "[webrtc]", id.slice(0, 10) + "…", "ICE gathering complete");
        this.dispatchEvent(new CustomEvent("ice-gathering-complete"));
      }
    });

    this.pc.addEventListener("icecandidateerror", (ev) => {
      const err = {
        url: ev.url,
        errorCode: ev.errorCode,
        errorText: ev.errorText,
        address: ev.address,
        port: ev.port,
        ts: Date.now(),
      };
      this._iceErrors.push(err);
      if (this._iceErrors.length > 100) this._iceErrors.shift();
      this._log("warn", "[webrtc]", id.slice(0, 10) + "…", "ICE error " + ev.errorCode, ev.errorText || "", ev.url || "");
    });

    this.pc.addEventListener("icegatheringstatechange", () => {
      this._log("info", "[webrtc]", id.slice(0, 10) + "…", "gathering:", this.pc.iceGatheringState);
      this.dispatchEvent(new CustomEvent("ice-gathering-state", { detail: { state: this.pc.iceGatheringState } }));
    });

    this.pc.addEventListener("iceconnectionstatechange", () => {
      const s = this.pc.iceConnectionState;
      this._log("info", "[webrtc]", id.slice(0, 10) + "…", "iceConnection:", s);
      this.dispatchEvent(new CustomEvent("ice-connection-state", { detail: { state: s } }));
      if (s === "disconnected" || s === "failed") this._logSelectedPair(s);
      if (s === "connected" || s === "completed") {
        // ICE прошёл, а DTLS за 6 с не завершился — путь по UDP «глухой» (фильтрация). Переходим на relay-only.
        if (!this._dtlsWatch && !this._everConnected) this._dtlsWatch = setTimeout(() => {
          this._dtlsWatch = null;
          if (!this._closed && this.pc.connectionState !== "connected") this._fallbackToRelay("dtls-timeout");
        }, 6000);
      }
      if ((s === "disconnected" || s === "failed") && !this._everConnected) this._fallbackToRelay("ice-" + s);
      if (s === "disconnected") {
        if (this._iceDisconnectTimer) clearTimeout(this._iceDisconnectTimer);
        this._iceDisconnectTimer = setTimeout(() => {
          this._iceDisconnectTimer = null;
          if (this._closed) return;
          // Только НАСТОЯЩИЙ failed — повод для reInvite. Status
          // "disconnected" на iOS/WebKit может висеть 10-20 секунд и
          // потом сам восстановиться, если собеседник просто моргнул
          // сетью. Раньше мы на 8-й секунде били reInvite, что ломало
          // уже идущий renegotiation. Увеличили до 20 секунд — если за
          // это время ICE не восстановился сам, тогда да, reInvite.
          if (this.pc.iceConnectionState === "failed") {
            this._log("warn", "[webrtc]", id.slice(0, 10) + "…", "ICE failed, reInvite()");
            this.reInvite();
          } else if (this.pc.iceConnectionState === "disconnected") {
            this._log("warn", "[webrtc]", id.slice(0, 10) + "…", "ICE still disconnected after 8s, reInvite()");
            this.reInvite();
          }
        }, 8000);
      } else if (s === "connected" || s === "completed") {
        if (this._iceDisconnectTimer) { clearTimeout(this._iceDisconnectTimer); this._iceDisconnectTimer = null; }
      } else if (s === "failed") {
        this._log("warn", "[webrtc]", id.slice(0, 10) + "…", "ICE failed, reInvite()");
        this.reInvite();
      }
    });

    this.pc.addEventListener("signalingstatechange", () => {
      this._log("info", "[webrtc]", id.slice(0, 10) + "…", "signaling:", this.pc.signalingState);
      this.dispatchEvent(new CustomEvent("signaling-state", { detail: { state: this.pc.signalingState } }));
    });

    this.pc.addEventListener("connectionstatechange", () => {
      const s = this.pc.connectionState;
      this._log("info", "[webrtc]", id.slice(0, 10) + "…", "connectionState:", s);
      this.dispatchEvent(new CustomEvent("pc-connection-state", { detail: { state: s } }));
      if (this._closed) return;

      const inCall = this.status === "in-call";

      if (s === "disconnected") {
        // «disconnected» в WebRTC — часто короткая потеря связи (переключение сети, «моргнувший» LTE), после которой
        // ICE восстанавливается сам. Раньше мы сразу объявляли линк отключённым, приложение его пересоздавало и
        // обрывало то, что могло вот-вот восстановиться (звонок «самопроизвольно отключался»). Даём время на восстановление.
        if (this._discTimer) clearTimeout(this._discTimer);
        this._discTimer = setTimeout(() => {
          this._discTimer = null;
          if (!this._closed && this.pc.connectionState === "disconnected") this._setStatus("disconnected");
        }, DISCONNECT_GRACE_MS);
        return;
      }
      if (s === "connecting") {
        if (this._discTimer) { clearTimeout(this._discTimer); this._discTimer = null; }
        if (!inCall) this._setStatus("connecting");
        return;
      }
      if (s === "connected") {
        if (this._discTimer) { clearTimeout(this._discTimer); this._discTimer = null; }
        if (this._dtlsWatch) { clearTimeout(this._dtlsWatch); this._dtlsWatch = null; }
        this._everConnected = true;
        if (this._connectStallTimer) { clearTimeout(this._connectStallTimer); this._connectStallTimer = null; }
        if (!inCall) this._setStatus("connected");
        return;
      }
      if (s === "failed" || s === "closed") {
        if (this._discTimer) { clearTimeout(this._discTimer); this._discTimer = null; }
        this._setStatus("disconnected");
      }
    });

    this.pc.addEventListener("track", (ev) => {
      let stream = (ev.streams && ev.streams[0]) || null;
      if (!stream && ev.track) stream = new MediaStream([ev.track]);
      if (!stream) return;
      this._log("info", "[webrtc]", id.slice(0, 10) + "…", "remote track: kind=" + ev.track.kind + ", streams=" + (ev.streams ? ev.streams.length : 0));
      this.dispatchEvent(new CustomEvent("remote-track", { detail: { stream, track: ev.track } }));
    });

    this.pc.addEventListener("negotiationneeded", () => this._renegotiateOverDataChannel());

    if (role === "offerer") {
      this.dc = this.pc.createDataChannel("control", { ordered: true });
      this._bindDataChannel();
    } else {
      this.pc.addEventListener("datachannel", (ev) => {
        this.dc = ev.channel;
        this._bindDataChannel();
      });
    }
  }

  _fallbackToRelay(reason) {
    if (this._closed || this._relayOnly || this._everConnected) return;
    if (!relayCapableServers().length) return;
    markRelayOnly(this.id);
    this._log("warn", "[webrtc]", this.id.slice(0, 10) + "…", "UDP-путь не работает (" + reason + ") → следующая попытка только через TURN (TCP/TLS)");
    this.dispatchEvent(new CustomEvent("relay-fallback", { detail: { reason } }));
  }

  _log(level, ...args) {
    if (window.etherLog) window.etherLog(level, ...args);
    else (console[level] || console.log).apply(console, args);
  }

  // Какая именно пара кандидатов была выбрана и сколько данных по ней прошло — главный вопрос при
  // «ICE connected, а через 5 секунд disconnected». Пишется в журнал и в диагностику.
  async _logSelectedPair(reason) {
    try {
      const stats = await this.pc.getStats();
      const byId = new Map(); stats.forEach((r) => byId.set(r.id, r));
      let pair = null;
      stats.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId); });
      if (!pair) stats.forEach((r) => { if (!pair && r.type === "candidate-pair" && (r.nominated || r.state === "succeeded")) pair = r; });
      if (!pair) { this._lastPairInfo = "нет выбранной пары (" + reason + ")"; this._log("warn", "[webrtc]", this.id.slice(0, 10) + "…", this._lastPairInfo); return; }
      const l = byId.get(pair.localCandidateId) || {}, r = byId.get(pair.remoteCandidateId) || {};
      this._lastPairInfo = reason + ": " + (l.candidateType || "?") + "/" + (l.protocol || "?") + (l.relayProtocol ? "(" + l.relayProtocol + ")" : "") + " → " + (r.candidateType || "?") + "/" + (r.protocol || "?")
        + ", rtt=" + (pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) + "мс" : "?")
        + ", ↑" + (pair.bytesSent || 0) + " ↓" + (pair.bytesReceived || 0) + " Б, consent " + (pair.consentRequestsSent || 0) + ", state=" + pair.state;
      this._log("warn", "[webrtc]", this.id.slice(0, 10) + "…", "pair " + this._lastPairInfo);
    } catch (e) {}
  }

  _setStatus(status) {
    if (this._closed && status !== "disconnected") return;
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent("status", { detail: { status } }));
  }

  _bindDataChannel() {
    this.dc.addEventListener("open", () => {
      this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "dataChannel open");
      if (this.status !== "in-call") this._setStatus("connected");
      clearInterval(this._pingTimer);
      this._lastPongAt = Date.now();
      this._pingTimer = setInterval(() => {
        if (this._closed) return;
        if (this._lastPongAt && Date.now() - this._lastPongAt > HEARTBEAT_TIMEOUT_MS) {
          this._log("warn", "[webrtc]", this.id.slice(0, 10) + "…", "no pong for " + Math.round((Date.now() - this._lastPongAt) / 1000) + "s — closing");
          this._setStatus("disconnected");
          return;
        }
        this.send({ kind: "ping", t: Date.now() });
      }, 5000);
      // Трек мог быть добавлен ДО того, как канал открылся — тогда
      // negotiationneeded сработал вхолостую (событие одноразовое) и
      // пересогласование молча не состоялось. Досылаем его сейчас.
      if (this._negotiationPendingOnOpen) {
        this._negotiationPendingOnOpen = false;
        this._renegotiateOverDataChannel();
      }
    });
    this.dc.addEventListener("close", () => {
      this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "dataChannel close");
      clearInterval(this._pingTimer);
      this._setStatus("disconnected");
    });
    this.dc.addEventListener("error", (ev) => {
      this._log("warn", "[webrtc]", this.id.slice(0, 10) + "…", "dataChannel error", String(ev));
    });
    this.dc.addEventListener("message", (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      if (!payload) return;
      if (payload.kind === "ping") { this.send({ kind: "pong", t: payload.t }); return; }
      if (payload.kind === "pong") { this._lastPongAt = Date.now(); return; }
      if (payload.kind === "sdp") {
        this._handleRemoteSdp(payload).catch((e) => this._log("warn", "[webrtc] пересогласование:", String(e)));
      } else {
        this.dispatchEvent(new CustomEvent("app-message", { detail: payload }));
      }
    });
  }

  send(payload) {
    if (this.dc && this.dc.readyState === "open") {
      try { this.dc.send(JSON.stringify(payload)); return true; }
      catch (e) { return false; }
    }
    return false;
  }
 
  async addIceCandidate(candidateJson) {
    if (this._closed) return;
    // Если remoteDescription ещё не установлен, addIceCandidate бросает
    // InvalidStateError, и кандидат теряется навсегда. Именно поэтому
    // trickle не работал бы вообще: первый кандидат приходит раньше,
    // чем answer доходит и оседает в setRemoteDescription. Копим до
    // этого момента.
    if (!this.pc.remoteDescription || !this.pc.remoteDescription.type) {
      this._pendingRemoteCandidates.push(candidateJson);
      if (this._pendingRemoteCandidates.length > 200) this._pendingRemoteCandidates.shift();
      return;
    }
    try { await this.pc.addIceCandidate(candidateJson); }
    catch (e) { this._log("warn", "[webrtc] addIceCandidate failed:", String(e)); }
  }

  _flushPendingRemoteCandidates() {
    if (!this.pc.remoteDescription || !this.pc.remoteDescription.type) return;
    if (this._pendingRemoteCandidates.length === 0) return;
    const list = this._pendingRemoteCandidates.splice(0);
    for (const c of list) {
      this.pc.addIceCandidate(c).catch((e) => this._log("warn", "[webrtc] flush addIceCandidate:", String(e)));
    }
  }
  // Отправка файла кусками поверх обычного send() — с учётом bufferedAmount,
  // чтобы не захлебнуть канал на больших вложениях. Живой P2P пробуется
  // первым (быстрее, не грузит сервер) — офлайн-путь через зашифрованный
  // почтовый ящик сервера реализован отдельно, на уровне app.js
  // (sendFileOffline/sendVoiceOffline), не здесь.
  async sendFile(meta, base64Chunks, onProgress) {
    if (!this.dc || this.dc.readyState !== "open") return false;
    const metaPayload = { kind: "file-meta", id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, totalChunks: base64Chunks.length };
    if (meta.duration != null) metaPayload.duration = meta.duration;
    if (meta.forwarded) metaPayload.forwarded = true;
    if (meta.caption) metaPayload.caption = meta.caption;
    if (!this.send(metaPayload)) return false;
    const BACKPRESSURE_TIMEOUT_MS = 30000; // залипший SCTP-буфер не должен вешать отправку вечно
    const BUFFER_THRESHOLD = 262144; // 256KB — не даём буферу канала расти бесконтрольно
    for (let i = 0; i < base64Chunks.length; i++) {
      const waitStart = Date.now();
      while (this.dc && this.dc.readyState === "open" && this.dc.bufferedAmount > BUFFER_THRESHOLD) {
        if (Date.now() - waitStart > BACKPRESSURE_TIMEOUT_MS) return false;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!this.dc || this.dc.readyState !== "open") return false;
      if (!this.send({ kind: "file-chunk", id: meta.id, index: i, data: base64Chunks[i] })) return false;
      if (onProgress) onProgress(i + 1, base64Chunks.length);
    }
    return this.send({ kind: "file-done", id: meta.id });
  }

  async createInitialOffer(roomTag) {
    this._setStatus("connecting");
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      // Раньше здесь ждали полного ICE gathering (до 3500 мс) — SDP
      // уходил только когда собраны ВСЕ кандидаты. Теперь SDP уходит
      // сразу после setLocalDescription (~50-150 мс), а оставшиеся
      // кандидаты досылаются по мере появления через сигналинг (см.
      // app.js, обработчик mesh "ice-candidate" и packet.t === "ice").
      // Это и есть trickle ICE: время установки падает с 5-10 секунд
      // до 1-2 секунд на нормальной сети.
      if (this._closed || this.pc.signalingState === "closed") return null;
      this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "offer ready, candidates:", this._iceCandidates.length);
      return {
        t: "offer", n: this.localName, r: roomTag, x: crypto.randomUUID(), ...(this._relayOnly ? { rl: 1 } : {}),
        d: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp },
      };
    } catch (e) {
      if (this._closed || this.pc.signalingState === "closed") return null;
      throw e;
    }
  }

  async acceptOfferAndCreateAnswer(packet) {
    this._setStatus("connecting");
    this.remoteName = (packet && packet.n) || this.remoteName;
    try {
      await this.pc.setRemoteDescription(packet.d);
      this._flushPendingRemoteCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      // Раньше здесь ждали полного ICE gathering (до 3500 мс) — SDP
      // уходил только когда собраны ВСЕ кандидаты. Теперь SDP уходит
      // сразу после setLocalDescription (~50-150 мс), а оставшиеся
      // кандидаты досылаются по мере появления через сигналинг (см.
      // app.js, обработчик mesh "ice-candidate" и packet.t === "ice").
      // Это и есть trickle ICE: время установки падает с 5-10 секунд
      // до 1-2 секунд на нормальной сети.
      if (this._closed || this.pc.signalingState === "closed") return null;
      return {
        t: "answer", n: this.localName, x: crypto.randomUUID(),
        d: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp },
      };
    } catch (e) {
      if (this._closed || this.pc.signalingState === "closed") return null;
      throw e;
    }
  }

  async acceptAnswer(packet) {
    this.remoteName = (packet && packet.n) || this.remoteName;
    try {
      await this.pc.setRemoteDescription(packet.d);
      this._flushPendingRemoteCandidates();
    } catch (e) {
      if (this._closed || this.pc.signalingState === "closed") return;
      throw e;
    }
  }

  // Единая точка пересогласования SDP — используется и для добавления
  // аудио (negotiationneeded), и для перезапуска ICE при сбое сети
  // (раньше reInvite() делал это отдельно, в обход всех защит ниже —
  // из-за этого могли столкнуться ДВА параллельных пересогласования и
  // сломать соединение прямо во время звонка).
  async _negotiate(iceRestart) {
    // _closed проверяется ПЕРВОЙ: на закрытом линке ни одно из
    // последующих действий не имеет смысла, и в частности не надо
    // выставлять _negotiationPendingOnOpen — событие "open" на
    // закрывающемся data channel уже не сработает, а флаг останется
    // висеть мусором. Сейчас это безвредно (линк удаляется из mesh,
    // собирается GC), но защищает от будущих переиспользований
    // PeerLink и от непонимания при чтении кода: во всех остальных
    // методах (_handleRemoteSdp, reInvite, send, addIceCandidate)
    // проверка _closed идёт первой.
    if (this._closed) return;
    if (this._pendingNegotiation) {
      if (iceRestart) this._negotiationQueuedIceRestart = true;
      return;
    }
    if (!this.dc || this.dc.readyState !== "open") { this._negotiationPendingOnOpen = true; return; }
    if (this.pc.signalingState !== "stable") {
      // Сейчас не момент создавать offer — сами ещё разбираем чужой/
      // предыдущий; без этой проверки здесь и вылезал InvalidStateError.
      if (!this._renegotiationRetryTimer) {
        this._renegotiationRetryTimer = setTimeout(() => {
          this._renegotiationRetryTimer = null;
          this._negotiate(iceRestart);
        }, 300);
      }
      return;
    }
    this._pendingNegotiation = true;
    this._makingOffer = true;
    try {
      // Критическая секция «createOffer → setLocalDescription» помечается промисом: если
      // за это время придёт встречный offer, _handleRemoteSdp дождётся её окончания, а не
      // вызовет setRemoteDescription посреди нашего setLocalDescription (иначе обе стороны
      // зависали в have-local-offer — реальный дедлок при одновременном добавлении треков).
      this._offerSetup = (async () => {
        const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
        await this.pc.setLocalDescription(offer);
      })();
      try { await this._offerSetup; } finally { this._offerSetup = null; }
      // Раньше SDP читался из this.pc.localDescription.sdp ПОСЛЕ этого
      // await — между setLocalDescription(offer) и отправкой есть
      // await waitForIceGathering (до нескольких секунд при iceRestart).
      // Если в это окно приходит встречный offer от собеседника (оба
      // могут запустить ICE-restart почти одновременно — оба видят
      // проблему связи в одно и то же время), _handleRemoteSdp у
      // "вежливой" стороны делает rollback + принимает чужой offer +
      // создаёт СВОЙ answer — pc.localDescription к моменту резолва
      // waitForIceGathering уже answer, а не offer. Мы бы отправили
      // answer, подписанный как "offer" — собеседник получил бы
      // рассинхронизированный SDP. Фиксируем SDP СРАЗУ, до await, и
      // после await проверяем signalingState — если он уже не
      // "have-local-offer", кто-то другой перехватил пересогласование,
      // тихо уходим, не отправляя ничего некорректного.
      // Отдельное, более узкое окно: если close() случится ровно во
      // время await setLocalDescription(offer) чуть выше, localDescription
      // по спеке WebRTC обнулится, и .sdp на null бросил бы TypeError
      // (падение ушло бы в catch как warning, но без отката состояния).
      if (this._closed) return;
      const offerSdp = this.pc.localDescription.sdp;
      if (iceRestart) await waitForIceGathering(this.pc);
      if (this._closed) return;
      if (this.pc.signalingState !== "have-local-offer") {
        // Кто-то другой (глубже — "вежливая" сторона в _handleRemoteSdp)
        // перехватил пересогласование за время ожидания — finally ниже
        // сам корректно сбросит _makingOffer/_pendingNegotiation.
        this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "негоциация перехвачена встречным offer во время ICE-gathering — не отправляем");
        return;
      }
      const ok = this.send({ kind: "sdp", sdpType: "offer", sdp: offerSdp });
      if (!ok && !this._closed) {
        // Критично: setLocalDescription(offer) уже перевёл signalingState в
        // "have-local-offer". Без отката это состояние никогда не вернётся
        // в "stable" само — следующий _negotiate() будет видеть "не время
        // договариваться" и вечно перезапускать retry-таймер (реальный
        // бесконечный цикл, не гипотетический). Откатываем локальный offer,
        // чтобы повторная попытка стартовала с чистого stable-состояния.
        try { await this.pc.setLocalDescription({ type: "rollback" }); } catch (e) {}
        this._renegotiationRetryTimer = setTimeout(() => {
          this._renegotiationRetryTimer = null;
          this._pendingNegotiation = false;
          this._makingOffer = false;
          this._negotiate(iceRestart);
        }, 500);
        return;
      }
    } catch (e) {
      this._log("warn", "[webrtc] пересогласование:", String(e));
    } finally {
      this._makingOffer = false;
      if (!this._renegotiationRetryTimer) {
        this._pendingNegotiation = false;
        if (this._negotiationQueuedIceRestart) {
          this._negotiationQueuedIceRestart = false;
          this._negotiate(true);
        }
      }
    }
  }

  async _renegotiateOverDataChannel() {
    return this._negotiate(false);
  }

  async _handleRemoteSdp(payload) {
    if (this._closed) return;
    if (payload.sdpType === "offer") {
      // Perfect Negotiation: если мы сами в этот момент тоже создаём offer
      // (столкновение) — "вежливая" сторона откатывает свой offer и
      // принимает чужой, "невежливая" — молча игнорирует чужой и ждёт,
      // что её собственный offer в итоге примут. Без этого одна из сторон
      // почти гарантированно получает InvalidStateError и рвёт согласование.
      if (this._offerSetup) { try { await this._offerSetup; } catch (e) {} if (this._closed) return; }
      const collision = this._makingOffer || this.pc.signalingState !== "stable";
      if (collision && !this._polite) {
        this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "glare: невежливая сторона игнорирует встречный offer");
        return;
      }
      if (collision) {
        this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "glare: откатываю свой offer в пользу встречного");
        try { await this.pc.setLocalDescription({ type: "rollback" }); } catch (e) {}
      }
      try {
        await this.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        this._flushPendingRemoteCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
      } catch (e) {
        // Раньше исключение здесь просто улетало во внешний .catch
        // (лог warning) без какого-либо отката состояния — если
        // setRemoteDescription бросает (несовместимый/битый SDP от
        // собеседника), PeerLink мог тихо зависнуть в промежуточном
        // состоянии, ничем не сигнализируя, что согласование сорвалось.
        this._log("warn", "[webrtc]", this.id.slice(0, 10) + "…", "не удалось применить встречный offer:", String(e));
        // Возвращаемся в stable и пробуем договориться заново, иначе pc может навсегда остаться
        // в промежуточном состоянии (have-local-offer/have-remote-offer) без единого пакета в сети.
        try { await this.pc.setLocalDescription({ type: "rollback" }); } catch (e2) {}
        if (!this._closed && !this._renegotiationRetryTimer) {
          this._renegotiationRetryTimer = setTimeout(() => { this._renegotiationRetryTimer = null; this._negotiate(false); }, 500);
        }
        if (!this._closed) this._setStatus("disconnected");
        return;
      }
      // Между setLocalDescription(answer) и этой строкой есть async-разрыв
      // (сам await) — если pc.close() случится именно в этом окне (например,
      // пользователь повесил трубку прямо в этот момент), localDescription
      // по спеке WebRTC обнуляется при close(), и .sdp на null бросил бы
      // TypeError — тихо потерянный в .catch у вызывающего кода, без
      // отката состояния. Окно узкое (в начале функции уже есть проверка
      // _closed), но не нулевое.
      if (this._closed || !this.pc.localDescription) return;
      this.send({ kind: "sdp", sdpType: "answer", sdp: this.pc.localDescription.sdp });
    } else if (payload.sdpType === "answer") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      this._flushPendingRemoteCandidates();
    }
  }

  async _ensureLocalAudio() {
    if (this.localAudioTrack) {
      if (!this.localStream) this.localStream = new MediaStream([this.localAudioTrack]);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.localAudioTrack = stream.getAudioTracks()[0];
    this.localStream = stream;
  }

  async _addAudioTrackOnce() {
    if (this._audioAdded) {
      if (this.localAudioTrack) this.localAudioTrack.enabled = !this._muted;
      return;
    }
    await this._ensureLocalAudio();
    this.pc.addTrack(this.localAudioTrack, this.localStream);
    this._audioAdded = true;
    if (this.localAudioTrack) this.localAudioTrack.enabled = !this._muted;
  }

  async _ensureLocalVideo(facingMode) {
    if (this.localVideoTrack) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingMode || "user" } });
    this.localVideoTrack = stream.getVideoTracks()[0];
    this._facingMode = facingMode || "user";
    if (!this.localStream) this.localStream = new MediaStream();
    this.localStream.addTrack(this.localVideoTrack);
  }
  // Добавляет видео, если его ещё не было — работает и при начале звонка
  // сразу с видео, и при включении камеры посреди уже идущего аудиозвонка
  // (второй случай запускает пересогласование через уже существующий
  // _negotiate() — тот же механизм, что чинил glare для аудио).
  async enableVideo(facingMode) {
    if (this._closed) return false;
    if (this._videoAdded) {
      if (this.localVideoTrack) this.localVideoTrack.enabled = true;
      return true;
    }
    try {
      await this._ensureLocalVideo(facingMode);
      this.pc.addTrack(this.localVideoTrack, this.localStream);
      this._videoAdded = true;
      return true;
    } catch (e) {
      // Если _ensureLocalVideo успел создать трек, но addTrack не прошёл
      // (типично: pc закрылся в окне между await внутри _ensureLocalVideo
      // и этой строкой) — трек уже захватил камеру, но ни к какому pc
      // не привязан. Без остановки он остаётся активным: индикатор
      // камеры горит, батарея тратится, а собеседник ничего не видит.
      // Хуже — _videoAdded остаётся false, поэтому следующий вызов
      // enableVideo снова дойдёт до addTrack, но _ensureLocalVideo
      // выйдет на первой строке (localVideoTrack уже есть) и трек так
      // и не остановится. Гарантируем чистое состояние: останавливаем
      // трек, убираем его из localStream и обнуляем поле — при
      // следующем вызове всё будет создано заново.
      if (!this._videoAdded && this.localVideoTrack) {
        try { this.localVideoTrack.stop(); } catch (e2) {}
        if (this.localStream) {
          try { this.localStream.removeTrack(this.localVideoTrack); } catch (e2) {}
        }
        this.localVideoTrack = null;
      }
      this._log("warn", "[webrtc] enableVideo failed:", String(e));
      return false;
    }
  }
  disableVideo() {
    if (this.localVideoTrack) this.localVideoTrack.enabled = false;
  }

async switchCamera() {
  if (!this.localVideoTrack) return;
  // Во время показа экрана localVideoTrack — это трек ЭКРАНА: подмена его камерой
  // оборвала бы показ (трек экрана останавливается), а stopScreenShare потом
  // вернул бы уже неактуальное состояние. Переключать камеру можно только вне показа.
  if (this._screenSharing) return;
  let stream = null;
  try {
    // Не все браузеры (например, Firefox на Android) отдают facingMode в getSettings(),
    // поэтому запоминаем последний запрошенный режим — иначе кнопка всегда просила бы
    // "environment" и вернуться на фронтальную камеру было бы нельзя.
    const settingsMode = this.localVideoTrack.getSettings ? this.localVideoTrack.getSettings().facingMode : null;
    const cur = settingsMode || this._facingMode || "user";
    const next = cur === "environment" ? "user" : "environment";
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next } });
    const newTrack = stream.getVideoTracks()[0];
    const sender = this.pc.getSenders().find(s => s.track && s.track.kind === "video");
    if (!sender) {
      // Видео ещё не добавлено в pc (sender не существует) — нет смысла
      // гасить старый трек и подменять this.localVideoTrack: новый трек
      // так и не привяжется ни к чему, видео пропадёт совсем. Честнее
      // отказаться от переключения, чем молча потерять картинку.
      newTrack.stop();
      return;
    }
    await sender.replaceTrack(newTrack);
    try { this.localVideoTrack.stop(); } catch (e) {}
    this.localVideoTrack = newTrack;
    this._facingMode = next;
    stream = null;                              // ← успешно, стрим больше не «наш»
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((t) => this.localStream.removeTrack(t));
      this.localStream.addTrack(newTrack);
    }
  } catch (e) {
    if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch (e2) {} }
    this._log("warn", "[webrtc] switchCamera failed:", String(e));
  }
}

// Screen sharing (раздел 7 роадмапа) через getDisplayMedia в тот же
// video-сендер, что уже используется камерой — переиспользует ровно тот
// же replaceTrack-приём, что switchCamera() выше, просто источник трека
// другой. Если видео в звонке ещё не было вообще, добавляет новый сендер
// (как enableVideo()), а не падает — показ экрана должен работать и в
// изначально чисто аудио-звонке.
async startScreenShare() {
  if (this._closed) return false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return false;
  if (this._screenSharing) return true;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    // Пользователь закрыл системный выбор окна/экрана, либо браузер
    // запретил — не ошибка приложения, просто показ не начался.
    this._log("warn", "[webrtc] getDisplayMedia failed/cancelled:", String(e));
    return false;
  }
  const screenTrack = stream.getVideoTracks()[0];
  if (!screenTrack) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {} return false; }
  try {
    if (this._videoAdded) {
      const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (!sender) throw new Error("video sender missing despite _videoAdded");
      await sender.replaceTrack(screenTrack);
      // Камеру НЕ останавливаем — запоминаем трек, чтобы вернуть его при
      // stopScreenShare() без повторного getUserMedia (который заново
      // спросил бы разрешение/мигнул индикатором камеры).
      this._preScreenShareTrack = this.localVideoTrack;
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach((t) => this.localStream.removeTrack(t));
        this.localStream.addTrack(screenTrack);
      }
    } else {
      if (!this.localStream) this.localStream = new MediaStream();
      this.localStream.addTrack(screenTrack);
      this.pc.addTrack(screenTrack, this.localStream);
      this._videoAdded = true;
      this._screenShareAddedVideo = true;
    }
  } catch (e) {
    try { screenTrack.stop(); } catch (e2) {}
    this._log("warn", "[webrtc] startScreenShare failed:", String(e));
    return false;
  }
  this.localVideoTrack = screenTrack;
  this._screenSharing = true;
  // "Stop sharing" из системного UI браузера (полоска/нотификация ОС) —
  // единственный надёжный кросс-браузерный сигнал о том, что показ экрана
  // прервали НЕ через нашу кнопку. Без этого обработчика состояние
  // _screenSharing осталось бы true навечно, хотя трек уже мёртв.
  screenTrack.onended = () => {
    if (!this._screenSharing) return;
    this.stopScreenShare()
      .then(() => this.dispatchEvent(new CustomEvent("screen-share-ended")))
      .catch((e) => this._log("warn", "[webrtc] stopScreenShare (onended) failed:", String(e)));
  };
  return true;
}
async stopScreenShare() {
  if (!this._screenSharing) return;
  this._screenSharing = false;
  const screenTrack = this.localVideoTrack;
  try {
    if (this._screenShareAddedVideo) {
      // Видео до показа экрана не было вообще — убираем видео-сендер
      // целиком (симметрично тому, как endCall() выше чистит сендеры).
      const senders = this.pc.getSenders().filter((s) => s.track && s.track.kind === "video");
      senders.forEach((s) => { try { this.pc.removeTrack(s); } catch (e) {} });
      this._videoAdded = false;
      this._screenShareAddedVideo = false;
      if (this.localStream) { try { this.localStream.getVideoTracks().forEach((t) => this.localStream.removeTrack(t)); } catch (e) {} }
      this.localVideoTrack = null;
    } else if (this._preScreenShareTrack) {
      const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(this._preScreenShareTrack);
      this.localVideoTrack = this._preScreenShareTrack;
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach((t) => this.localStream.removeTrack(t));
        this.localStream.addTrack(this._preScreenShareTrack);
      }
      this._preScreenShareTrack = null;
    }
  } catch (e) {
    this._log("warn", "[webrtc] stopScreenShare failed:", String(e));
  }
  try { if (screenTrack) screenTrack.stop(); } catch (e) {}
}

async startCall(withVideo) {
  if (this._closed) throw new Error("link closed");
  await this._addAudioTrackOnce();
  if (withVideo) await this.enableVideo();
  this._setStatus("in-call");
  // ts — чтобы принимающая сторона могла отличить СВЕЖИЙ call-state
  // от того, что буферизовался, пока приложение спало. Без этого
  // iOS-пуш буферизует ringing и проигрывает рингтон при пробуждении
  // спустя минуты после того, как звонок уже отбит.
  this.send({ kind: "call-state", state: "ringing", video: !!withVideo, ts: Date.now() });
}

  async answerCall(withVideo) {
    if (this._closed) throw new Error("link closed");
    await this._addAudioTrackOnce();
    if (withVideo) await this.enableVideo();
    this._setStatus("in-call");
    this.send({ kind: "call-state", state: "accepted", ts: Date.now() });
  }

  declineCall(reason) { this.send({ kind: "call-state", state: "declined", reason: reason || null, ts: Date.now() }); }

  setMuted(muted) {
    this._muted = !!muted;
    if (this.localAudioTrack) {
      this.localAudioTrack.enabled = !this._muted;
    }
    if (this._muteRecheckTimer) { clearInterval(this._muteRecheckTimer); this._muteRecheckTimer = null; }
    if (this._muted) {
      this._muteRecheckTimer = setInterval(() => {
        if (!this.localAudioTrack) return;
        if (this.localAudioTrack.enabled) this.localAudioTrack.enabled = false;
      }, 1500);
      setTimeout(() => {
        if (this._muteRecheckTimer) { clearInterval(this._muteRecheckTimer); this._muteRecheckTimer = null; }
      }, 10000);
    }
  }

  setRemoteVolume(v) {
    const vol = Math.max(0, Math.min(1, Number(v) || 0));
    const el = document.getElementById("remote-audio-" + this.id);
    if (el) { if (el._relayGain) el._relayGain.gain.value = vol; else el.volume = vol; }
  }

  async reInvite() {
    if (this._closed) return;
    if (!this.dc || this.dc.readyState !== "open") {
      // Молчаливый выход прятал реальную проблему: висим в "connecting"
      // потому что dataChannel ещё не открылся (столкновение offer'ов,
      // ICE не прошёл, TURN отвалился). Логируем — иначе из event log
      // непонятно, почему «reInvite()» в строке выше ни к чему не привёл.
      this._log("warn", "[webrtc]", this.id.slice(0, 10) + "…",
        "reInvite: пропущен, dataChannel не открыт (" + (this.dc ? this.dc.readyState : "нет dc") + ")");
      return;
    }
    this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "reInvite: createOffer iceRestart");
    return this._negotiate(true);
  }

  // ---- Групповой звонок (mesh): медиа поверх уже живого соединения, БЕЗ 1:1-семантики ----
  // Не трогаем status ("in-call") и не шлём call-state — у группового звонка свой сигналинг
  // (kind:"gcall", см. js/group-call.js). Один и тот же локальный MediaStream кладётся во все линки.
  addGroupTracks(stream) {
    if (this._closed || !stream) return false;
    if (!this._gSenders) this._gSenders = new Map();
    for (const t of stream.getTracks()) {
      if (this._gSenders.has(t.id)) continue;
      try { this._gSenders.set(t.id, this.pc.addTrack(t, stream)); } catch (e) { this._log("warn", "[webrtc] addGroupTracks:", String(e)); }
    }
    return true;
  }
  removeGroupTracks(kind) {
    if (!this._gSenders) return;
    for (const [tid, sender] of Array.from(this._gSenders)) {
      if (kind && sender.track && sender.track.kind !== kind) continue;
      try { this.pc.removeTrack(sender); } catch (e) {}
      this._gSenders.delete(tid);
    }
  }

  endCall() {
    try {
      // Раньше фильтр брал только audio — video-сендер оставался
      // прикреплённым к pc (с уже остановленным треком) после
      // окончания видеозвонка. При повторном enableVideo() на ТОМ ЖЕ
      // PeerLink (переиспользуется при живом P2P-соединении, не
      // пересоздаётся на каждый звонок) _videoAdded уже false, и
      // addTrack добавил бы ВТОРОЙ video-сендер поверх непочищенного
      // первого — в SDP два m=video, собеседник получил бы один
      // рабочий поток и один пустой/мёртвый.
      const senders = this.pc.getSenders().filter((s) => s.track && (s.track.kind === "audio" || s.track.kind === "video"));
      senders.forEach((s) => { try { this.pc.removeTrack(s); } catch (e) {} });
    } catch (e) {}
    if (this.localAudioTrack) {
      this.localAudioTrack.stop();
      this.localAudioTrack = null;
    }
    if (this.localVideoTrack) {
      try { this.localVideoTrack.stop(); } catch (e) {}
      this.localVideoTrack = null;
    }
    this.localStream = null;
    this._audioAdded = false;
    this._videoAdded = false;
    this._muted = false;
    // Если звонок завершился ПРЯМО во время показа экрана, localVideoTrack
    // (уже остановленный выше) — это трек экрана, а не камеры. Камера,
    // отложенная в _preScreenShareTrack на время показа, своим треком
    // никуда не делась и продолжила бы "гореть" (индикатор камеры у ОС),
    // если её не остановить отдельно — она не входит в senders выше и не
    // равна localVideoTrack в этот момент.
    if (this._preScreenShareTrack) { try { this._preScreenShareTrack.stop(); } catch (e) {} this._preScreenShareTrack = null; }
    this._screenSharing = false;
    this._screenShareAddedVideo = false;
    if (this._muteRecheckTimer) { clearInterval(this._muteRecheckTimer); this._muteRecheckTimer = null; }
    this._setStatus(this.dc && this.dc.readyState === "open" ? "connected" : "disconnected");
    this.send({ kind: "call-state", state: "ended", ts: Date.now() });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._pingTimer);
    if (this._muteRecheckTimer) { clearInterval(this._muteRecheckTimer); this._muteRecheckTimer = null; }
    if (this._renegotiationRetryTimer) { clearTimeout(this._renegotiationRetryTimer); this._renegotiationRetryTimer = null; }
    if (this._iceDisconnectTimer) { clearTimeout(this._iceDisconnectTimer); this._iceDisconnectTimer = null; }
    if (this._connectStallTimer) { clearTimeout(this._connectStallTimer); this._connectStallTimer = null; }
    if (this._dtlsWatch) { clearTimeout(this._dtlsWatch); this._dtlsWatch = null; }
    if (this._discTimer) { clearTimeout(this._discTimer); this._discTimer = null; }
    try {
      if (this.localStream) {
        try { this.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); } catch (e) {}
        this.localStream = null;
      } else if (this.localAudioTrack) {
        this.localAudioTrack.stop();
      }
      this.localAudioTrack = null;
      this._audioAdded = false;
      this._videoAdded = false;
      this.localVideoTrack = null;
      this._negotiationQueuedIceRestart = false;
      // _renegotiationRetryTimer уже очищен выше, до try — повторная
      // идентичная очистка здесь была лишней (косметика, не баг).
      if (this.dc) this.dc.close();
      this.pc.close();
    } catch (e) {}
    this._setStatus("disconnected");
  }

  getDiagnostics() {
    let pcState = "—", iceState = "—", iceGather = "—", signalingState = "—", dcState = "—";
    try { pcState = this.pc.connectionState; } catch (e) {}
    try { iceState = this.pc.iceConnectionState; } catch (e) {}
    try { iceGather = this.pc.iceGatheringState; } catch (e) {}
    try { signalingState = this.pc.signalingState; } catch (e) {}
    try { dcState = this.dc ? this.dc.readyState : "—"; } catch (e) {}
    return {
      id: this.id,
      role: this.role,
      status: this.status,
      pcState, iceState, iceGather, signalingState, dcState,
      candidates: this._iceCandidates.slice(),
      errors: this._iceErrors.slice(),
      createdAt: this._createdAt,
      lastPair: this._lastPairInfo || null,
      relayOnly: !!this._relayOnly,
      closed: this._closed,
    };
  }
}

class MeshManager extends EventTarget {
  constructor(localName) {
    super();
    this.localName = localName;
    this.links = new Map();
  }
  createOutgoingLink(id) {
    this.remove(id);
    const link = new PeerLink({ id, localName: this.localName, role: "offerer" });
    this._wire(link);
    return link;
  }
  createIncomingLink(id) {
    this.remove(id);
    const link = new PeerLink({ id, localName: this.localName, role: "answerer" });
    this._wire(link);
    return link;
  }
  _wire(link) {
    this.links.set(link.id, link);
    link.addEventListener("status", () => {
      this.dispatchEvent(new CustomEvent("link-status", { detail: { id: link.id, status: link.status } }));
    });
    link.addEventListener("app-message", (ev) => {
      this.dispatchEvent(new CustomEvent("message", { detail: { id: link.id, payload: ev.detail } }));
    });
    link.addEventListener("remote-track", (ev) => {
      this.dispatchEvent(new CustomEvent("remote-track", { detail: { id: link.id, ...ev.detail } }));
    });
    link.addEventListener("ice-candidate", (ev) => {
      this.dispatchEvent(new CustomEvent("ice-candidate", { detail: { id: link.id, ...ev.detail } }));
    });
    link.addEventListener("ice-gathering-state", (ev) => {
      this.dispatchEvent(new CustomEvent("ice-gathering-state", { detail: { id: link.id, ...ev.detail } }));
    });
    link.addEventListener("ice-connection-state", (ev) => {
      this.dispatchEvent(new CustomEvent("ice-connection-state", { detail: { id: link.id, ...ev.detail } }));
    });
    link.addEventListener("pc-connection-state", (ev) => {
      this.dispatchEvent(new CustomEvent("pc-connection-state", { detail: { id: link.id, ...ev.detail } }));
    });
    // Показ экрана прервали через системный UI браузера (не через нашу
    // кнопку) — см. startScreenShare()/screenTrack.onended выше. UI
    // (кнопка #call-screenshare-btn) должен узнать об этом, чтобы не
    // остаться "залипшей" в активном состоянии.
    link.addEventListener("relay-fallback", () => {
      this.dispatchEvent(new CustomEvent("relay-fallback", { detail: { id: link.id } }));
    });
    link.addEventListener("screen-share-ended", () => {
      this.dispatchEvent(new CustomEvent("screen-share-ended", { detail: { id: link.id } }));
    });
  }
  broadcast(payload, excludeId = null) {
    for (const [id, link] of this.links) { if (id === excludeId) continue; link.send(payload); }
  }
  get(id) { return this.links.get(id); }
  remove(id) {
    const link = this.links.get(id);
    if (link) link.close();
    this.links.delete(id);
  }
  connectedCount() {
    let n = 0;
    for (const link of this.links.values()) if (link.status === "connected" || link.status === "in-call") n++;
    return n;
  }
  allDiagnostics() {
    const out = [];
    for (const link of this.links.values()) out.push(link.getDiagnostics());
    return out;
  }
}