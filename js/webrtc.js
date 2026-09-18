// Слой P2P-связи. TURN-серверы подгружаются с вашего аккаунта Metered.
// Пока они грузятся, никто не создаёт PeerLink — см. window.__etherIceReady
// в app.js. Так первый же вызов createInitialOffer() уже имеет TURN.

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
      ICE_SERVERS = ICE_SERVERS.concat(list);
      console.log("[webrtc] TURN Metered загружены:", list.length, list);
    } else {
      console.warn("[webrtc] Metered вернул пустой список");
    }
  } catch (e) {
    console.warn("[webrtc] не удалось загрузить TURN Metered:", e);
  }
})();

const ICE_GATHER_TIMEOUT_MS = 4000;

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

class PeerLink extends EventTarget {
  constructor({ id, localName, remoteName = "", role }) {
    super();
    this.id = id;
    this.localName = localName;
    this.remoteName = remoteName;
    this.role = role;
    this.status = "new";
    this._closed = false;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 });
    this.dc = null;
    this.localAudioTrack = null;
    this._pendingNegotiation = false;
    this._renegotiationRetryTimer = null;
    this._pingTimer = null;
    this._lastPingAt = 0;

    this.pc.addEventListener("connectionstatechange", () => {
      if (this._closed) return;
      const s = this.pc.connectionState;
      if (s === "connected" && this.status !== "in-call") this._setStatus("connected");
      if (s === "failed" || s === "disconnected" || s === "closed") this._setStatus("disconnected");
    });

    this.pc.addEventListener("iceconnectionstatechange", () => {
      if (this._closed) return;
      if (this.pc.iceConnectionState === "failed") {
        try { this.pc.restartIce(); } catch (e) {}
      }
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

  _setStatus(status) {
    if (this._closed && status !== "disconnected") return;
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent("status", { detail: { status } }));
  }

  _bindDataChannel() {
    this.dc.addEventListener("open", () => {
      this._setStatus("connected");
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => {
        if (this._closed) return;
        this.send({ kind: "ping", t: Date.now() });
      }, 5000);
    });
    this.dc.addEventListener("close", () => {
      clearInterval(this._pingTimer);
      this._setStatus("disconnected");
    });
    this.dc.addEventListener("message", (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      if (!payload) return;
      if (payload.kind === "ping") { this.send({ kind: "pong", t: payload.t }); return; }
      if (payload.kind === "pong") { this._lastPingAt = Date.now(); return; }
      if (payload.kind === "sdp") {
        this._handleRemoteSdp(payload).catch((e) => console.warn("[webrtc] пересогласование:", e));
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
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await waitForIceGathering(this.pc);
      if (this._closed || this.pc.signalingState === "closed") return null;
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
      console.warn("[webrtc] пересогласование не удалось:", e);
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
}