// Слой P2P-связи. TURN-серверы подгружаются с аккаунта Metered; пока
// они не загружены — ничего не создаётся, ждём window.__etherIceReady.

const METERED_API_KEY = "aa111f28aa9541c01ac274e43e383bd7f685";
const METERED_API_URL = `https://arthurhusky.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;

let ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

window.__etherIceReady = (async () => {
  try {
    const r = await fetch(METERED_API_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const list = await r.json();
    if (Array.isArray(list) && list.length > 0) {
      // Берём только 1 UDP TURN и 1 TCP TURN. Остальные серверы Metered
      // через тот же релей — лишние только тормозят ICE discovery.
      const filtered = [];
      const seen = new Set();
      for (const s of list) {
        const url = (s.urls || "").toString();
        const key = url.includes("transport=tcp") ? "tcp" : "udp";
        if (seen.has(key)) continue;
        seen.add(key);
        filtered.push(s);
      }
      ICE_SERVERS = ICE_SERVERS.concat(filtered.slice(0, 2));
      if (window.etherLog) window.etherLog("info", "[webrtc] TURN Metered: используем", filtered.slice(0, 2).length, "сервера (1 UDP + 1 TCP)");
      console.log("[webrtc] TURN Metered: используем", filtered.slice(0, 2).length, "сервера");
    } else {
      console.warn("[webrtc] Metered вернул пустой список");
      if (window.etherLog) window.etherLog("warn", "[webrtc] Metered вернул пустой список TURN");
    }
  } catch (e) {
    console.warn("[webrtc] не удалось загрузить TURN Metered:", e);
    if (window.etherLog) window.etherLog("error", "[webrtc] TURN Metered не загрузился:", String(e));
  }
})();

const ICE_GATHER_TIMEOUT_MS = 6000;

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
    this._pendingNegotiation = false;
    this._renegotiationRetryTimer = null;
    this._pingTimer = null;

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
      this._log("warn", "[webrtc]", id.slice(0, 10) + "…", "ICE error " + ev.errorCode, ev.errorText || "", ev.url || "");
    });

    this.pc.addEventListener("icegatheringstatechange", () => {
      this._log("info", "[webrtc]", id.slice(0, 10) + "…", "gathering:", this.pc.iceGatheringState);
      this.dispatchEvent(new CustomEvent("ice-gathering-state", { detail: { state: this.pc.iceGatheringState } }));
    });

    this.pc.addEventListener("iceconnectionstatechange", () => {
      this._log("info", "[webrtc]", id.slice(0, 10) + "…", "iceConnection:", this.pc.iceConnectionState);
      this.dispatchEvent(new CustomEvent("ice-connection-state", { detail: { state: this.pc.iceConnectionState } }));
      if (this.pc.iceConnectionState === "failed") {
        this._log("warn", "[webrtc]", id.slice(0, 10) + "…", "ICE failed, restartIce()");
        try { this.pc.restartIce(); } catch (e) {}
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
      if (s === "connecting") this._setStatus("connecting");
      if (s === "connected" && this.status !== "in-call") this._setStatus("connected");
      if (s === "failed" || s === "disconnected" || s === "closed") this._setStatus("disconnected");
    });

    this.pc.addEventListener("track", (ev) => {
      const [stream] = ev.streams;
      if (stream) this.dispatchEvent(new CustomEvent("remote-track", { detail: { stream, track: ev.track } }));
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
      this._setStatus("connected");
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => {
        if (this._closed) return;
        this.send({ kind: "ping", t: Date.now() });
      }, 5000);
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
      if (payload.kind === "pong") return;
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
    this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "acceptOffer: setRemoteDescription start");
    try {
      await this.pc.setRemoteDescription(packet.d);
      this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "acceptOffer: setRemoteDescription OK");
      const answer = await this.pc.createAnswer();
      this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "acceptOffer: createAnswer OK");
      await this.pc.setLocalDescription(answer);
      this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "acceptOffer: setLocalDescription OK");
      await waitForIceGathering(this.pc);
      if (this._closed || this.pc.signalingState === "closed") {
        this._log("warn", "[webrtc]", this.id.slice(0, 10) + "…", "acceptOffer: closed before return");
        return null;
      }
      this._log("info", "[webrtc]", this.id.slice(0, 10) + "…", "answer ready, candidates:", this._iceCandidates.length);
      return {
        t: "answer", n: this.localName, x: crypto.randomUUID(),
        d: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp },
      };
    } catch (e) {
      this._log("error", "[webrtc]", this.id.slice(0, 10) + "…", "acceptOffer FAILED:", String(e && e.message || e));
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

  async _renegotiateOverDataChannel() {
    if (this._pendingNegotiation) return;
    if (!this.dc || this.dc.readyState !== "open") return;
    if (this._closed) return;
    this._pendingNegotiation = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const ok = this.send({ kind: "sdp", sdpType: "offer", sdp: this.pc.localDescription.sdp });
      if (!ok && !this._closed) {
        this._renegotiationRetryTimer = setTimeout(() => {
          this._renegotiationRetryTimer = null;
          this._pendingNegotiation = false;
          this._renegotiateOverDataChannel();
        }, 500);
        return;
      }
    } catch (e) {
      this._log("warn", "[webrtc] пересогласование:", String(e));
    } finally {
      if (!this._renegotiationRetryTimer) this._pendingNegotiation = false;
    }
  }

  async _handleRemoteSdp(payload) {
    if (this._closed) return;
    if (payload.sdpType === "offer") {
      await this.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.send({ kind: "sdp", sdpType: "answer", sdp: this.pc.localDescription.sdp });
    } else if (payload.sdpType === "answer") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    }
  }

  async startCall() {
    if (this._closed) throw new Error("link closed");
    if (!this.localAudioTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localAudioTrack = stream.getAudioTracks()[0];
    }
    this.pc.addTrack(this.localAudioTrack);
    this._setStatus("in-call");
    this.send({ kind: "call-state", state: "ringing" });
  }

  async answerCall() {
    if (this._closed) throw new Error("link closed");
    if (!this.localAudioTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localAudioTrack = stream.getAudioTracks()[0];
    }
    this.pc.addTrack(this.localAudioTrack);
    this._setStatus("in-call");
    this.send({ kind: "call-state", state: "accepted" });
  }

  declineCall() { this.send({ kind: "call-state", state: "declined" }); }

  setMuted(muted) {
    if (this.localAudioTrack) this.localAudioTrack.enabled = !muted;
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
    this._setStatus(this.dc && this.dc.readyState === "open" ? "connected" : "disconnected");
    this.send({ kind: "call-state", state: "ended" });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._pingTimer);
    if (this._renegotiationRetryTimer) { clearTimeout(this._renegotiationRetryTimer); this._renegotiationRetryTimer = null; }
    try {
      if (this.localAudioTrack) this.localAudioTrack.stop();
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