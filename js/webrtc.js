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

async function fetchIceServers() {
  const base = signalingUrlForIce();
  if (!base) return null;
  try {
    const r = await fetch(base.replace(/\/+$/, "") + "/ice", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const list = await r.json();
    if (Array.isArray(list) && list.length > 0) return list;
    return null;
  } catch (e) {
    if (window.etherLog) window.etherLog("warn", "[webrtc] /ice недоступен:", String(e));
    console.warn("[webrtc] /ice недоступен:", e);
    return null;
  }
}

window.__etherIceReady = (async () => {
  const fromServer = await fetchIceServers();
  if (fromServer) {
    ICE_SERVERS = fromServer;
    if (window.etherLog) window.etherLog("info", "[webrtc] ICE-серверы получены с сигнального сервера:", ICE_SERVERS.length);
    console.log("[webrtc] ICE-серверы получены с сигнального сервера:", ICE_SERVERS.length);
  } else {
    ICE_SERVERS = FALLBACK_ICE.slice();
    if (window.etherLog) window.etherLog("warn", "[webrtc] использую fallback-STUN (без TURN)");
    console.warn("[webrtc] использую fallback-STUN (без TURN)");
  }
})();

const ICE_GATHER_TIMEOUT_MS = 3500;
const HEARTBEAT_TIMEOUT_MS = 20000;

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    });
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
    this._createdAt = Date.now();

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 });
    this.dc = null;
    this.localAudioTrack = null;
    this.localStream = null;
    this._audioAdded = false;
    this._videoAdded = false;
    this.localVideoTrack = null;
    this._muted = false;
    this._muteRecheckTimer = null;
    this._pendingNegotiation = false;
    this._renegotiationRetryTimer = null;
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
      if (s === "disconnected") {
        if (this._iceDisconnectTimer) clearTimeout(this._iceDisconnectTimer);
        this._iceDisconnectTimer = setTimeout(() => {
          this._iceDisconnectTimer = null;
          if (this._closed) return;
          if (this.pc.iceConnectionState === "disconnected" || this.pc.iceConnectionState === "failed") {
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

      if (s === "connecting") {
        if (!inCall) this._setStatus("connecting");
        return;
      }
      if (s === "connected") {
        if (!inCall) this._setStatus("connected");
        return;
      }
      if (s === "failed" || s === "disconnected" || s === "closed") {
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

  _log(level, ...args) {
    if (window.etherLog) window.etherLog(level, ...args);
    else (console[level] || console.log).apply(console, args);
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

  // Отправка файла кусками поверх обычного send() — с учётом bufferedAmount,
  // чтобы не захлебнуть канал на больших вложениях. Работает только пока
  // связь P2P жива (как и звонки — без офлайн-очереди через сервер: файл
  // мог бы быть мегабайты, а серверный почтовый ящик на это не рассчитан).
  async sendFile(meta, base64Chunks, onProgress) {
    if (!this.dc || this.dc.readyState !== "open") return false;
    const metaPayload = { kind: "file-meta", id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, totalChunks: base64Chunks.length };
    if (meta.duration) metaPayload.duration = meta.duration;
    if (!this.send(metaPayload)) return false;
    const BUFFER_THRESHOLD = 262144; // 256KB — не даём буферу канала расти бесконтрольно
    for (let i = 0; i < base64Chunks.length; i++) {
      while (this.dc && this.dc.readyState === "open" && this.dc.bufferedAmount > BUFFER_THRESHOLD) {
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
      await waitForIceGathering(this.pc);
      if (this._closed || this.pc.signalingState === "closed") return null;
      this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "offer ready, candidates:", this._iceCandidates.length);
      return {
        t: "offer", n: this.localName, r: roomTag, x: crypto.randomUUID(),
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
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await waitForIceGathering(this.pc);
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
    try { await this.pc.setRemoteDescription(packet.d); }
    catch (e) {
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
    if (this._pendingNegotiation) {
      if (iceRestart) this._negotiationQueuedIceRestart = true;
      return;
    }
    if (!this.dc || this.dc.readyState !== "open") { this._negotiationPendingOnOpen = true; return; }
    if (this._closed) return;
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
      const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await this.pc.setLocalDescription(offer);
      if (iceRestart) await waitForIceGathering(this.pc);
      const ok = this.send({ kind: "sdp", sdpType: "offer", sdp: this.pc.localDescription.sdp });
      if (!ok && !this._closed) {
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
      const collision = this._makingOffer || this.pc.signalingState !== "stable";
      if (collision && !this._polite) {
        this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "glare: невежливая сторона игнорирует встречный offer");
        return;
      }
      if (collision) {
        this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "glare: откатываю свой offer в пользу встречного");
        try { await this.pc.setLocalDescription({ type: "rollback" }); } catch (e) {}
      }
      await this.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.send({ kind: "sdp", sdpType: "answer", sdp: this.pc.localDescription.sdp });
    } else if (payload.sdpType === "answer") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
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
      this._log("warn", "[webrtc] enableVideo failed:", String(e));
      return false;
    }
  }
  disableVideo() {
    if (this.localVideoTrack) this.localVideoTrack.enabled = false;
  }
  async switchCamera() {
    if (!this.localVideoTrack) return;
    const cur = this.localVideoTrack.getSettings ? this.localVideoTrack.getSettings().facingMode : null;
    const next = cur === "environment" ? "user" : "environment";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next } });
      const newTrack = stream.getVideoTracks()[0];
      const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
      try { this.localVideoTrack.stop(); } catch (e) {}
      this.localVideoTrack = newTrack;
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach((t) => this.localStream.removeTrack(t));
        this.localStream.addTrack(newTrack);
      }
    } catch (e) {
      this._log("warn", "[webrtc] switchCamera failed:", String(e));
    }
  }

  async startCall(withVideo) {
    if (this._closed) throw new Error("link closed");
    await this._addAudioTrackOnce();
    if (withVideo) await this.enableVideo();
    this._setStatus("in-call");
    this.send({ kind: "call-state", state: "ringing", video: !!withVideo });
  }

  async answerCall(withVideo) {
    if (this._closed) throw new Error("link closed");
    await this._addAudioTrackOnce();
    if (withVideo) await this.enableVideo();
    this._setStatus("in-call");
    this.send({ kind: "call-state", state: "accepted" });
  }

  declineCall(reason) { this.send({ kind: "call-state", state: "declined", reason: reason || null }); }

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
    if (el) el.volume = vol;
  }

  async reInvite() {
    if (this._closed) return;
    if (!this.dc || this.dc.readyState !== "open") return;
    this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "reInvite: createOffer iceRestart");
    return this._negotiate(true);
  }

  endCall() {
    try {
      const senders = this.pc.getSenders().filter((s) => s.track && s.track.kind === "audio");
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
    if (this._muteRecheckTimer) { clearInterval(this._muteRecheckTimer); this._muteRecheckTimer = null; }
    this._setStatus(this.dc && this.dc.readyState === "open" ? "connected" : "disconnected");
    this.send({ kind: "call-state", state: "ended" });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._pingTimer);
    if (this._muteRecheckTimer) { clearInterval(this._muteRecheckTimer); this._muteRecheckTimer = null; }
    if (this._renegotiationRetryTimer) { clearTimeout(this._renegotiationRetryTimer); this._renegotiationRetryTimer = null; }
    if (this._iceDisconnectTimer) { clearTimeout(this._iceDisconnectTimer); this._iceDisconnectTimer = null; }
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