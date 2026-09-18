// Слой P2P-связи. Никакого backend нет вообще: единственный момент,
// когда двум устройствам нужен посредник — обмен самым первым
// SDP-пакетом (offer/answer), потому что кто-то должен узнать текущий
// сетевой адрes и параметры другого устройства. Этот обмен происходит
// вручную — кодом или ссылкой, которую пользователь пересылает любым
// удобным способом (AirDrop, сообщением, QR). Для обхода NAT используются
// только публичные STUN-серверы Google — они не видят и не передают ни
// текст, ни звук, а лишь помогают устройству узнать свой внешний адрес.
// После того как канал открыт, все дальнейшие договорённости (например,
// добавление аудио для звонка) идут уже через сам P2P data-channel —
// новый код вводить не нужно.

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

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
    this.role = role; // 'offerer' | 'answerer'
    this.status = "new"; // new | awaiting-answer | connecting | connected | in-call | disconnected
    this._closed = false;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.dc = null;
    this.localAudioTrack = null;
    this.remoteAudioEl = null;
    this._pendingNegotiation = false;

    this.pc.addEventListener("connectionstatechange", () => {
      const s = this.pc.connectionState;
      if (s === "connected" && this.status !== "in-call") this._setStatus("connected");
      if (s === "failed" || s === "disconnected" || s === "closed") this._setStatus("disconnected");
    });

    this.pc.addEventListener("track", (ev) => {
      const [stream] = ev.streams;
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

  _setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent("status", { detail: { status } }));
  }

  _bindDataChannel() {
    this.dc.addEventListener("open", () => this._setStatus("connected"));
    this.dc.addEventListener("close", () => this._setStatus("disconnected"));
    this.dc.addEventListener("message", (ev) => {
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (payload.kind === "sdp") {
        this._handleRemoteSdp(payload);
      } else {
        this.dispatchEvent(new CustomEvent("app-message", { detail: payload }));
      }
    });
  }

  send(payload) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  // ---- Первое рукопожатие (ручной обмен кодом) ----
  //
  // Эти методы асинхронные и могут занимать до нескольких секунд (ожидание
  // ICE). Если за это время связь была отменена другой веткой кода —
  // например, обе стороны почти одновременно решили быть звонящими, и
  // разрешение конфликта закрыло это самое соединение — pc.close() уже
  // вызван, а дальнейшие операции над ним кидают InvalidStateError. Здесь
  // это не бага сети, а нормальная ситуация "нас опередили", поэтому вместо
  // исключения тихо возвращаем null — вызывающий код просто ничего не делает.

  async createInitialOffer(roomTag) {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await waitForIceGathering(this.pc);
      if (this._closed || this.pc.signalingState === "closed") return null;
      return {
        t: "offer",
        n: this.localName,
        r: roomTag,
        x: crypto.randomUUID(),
        d: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp },
      };
    } catch (e) {
      if (this._closed || this.pc.signalingState === "closed") return null;
      throw e;
    }
  }

  async acceptOfferAndCreateAnswer(packet) {
    this.remoteName = packet.n || this.remoteName;
    try {
      await this.pc.setRemoteDescription(packet.d);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await waitForIceGathering(this.pc);
      if (this._closed || this.pc.signalingState === "closed") return null;
      return {
        t: "answer",
        n: this.localName,
        x: crypto.randomUUID(),
        d: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp },
      };
    } catch (e) {
      if (this._closed || this.pc.signalingState === "closed") return null;
      throw e;
    }
  }

  async acceptAnswer(packet) {
    this.remoteName = packet.n || this.remoteName;
    try {
      await this.pc.setRemoteDescription(packet.d);
    } catch (e) {
      if (this._closed || this.pc.signalingState === "closed") return;
      throw e;
    }
  }

  // ---- Дальнейшая пересогласование уже идёт через открытый канал ----

  async _renegotiateOverDataChannel() {
    if (this._pendingNegotiation) return;
    if (!this.dc || this.dc.readyState !== "open") return; // до первого рукопожатия — обычный flow, не через dc
    this._pendingNegotiation = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.send({ kind: "sdp", sdpType: "offer", sdp: this.pc.localDescription.sdp });
    } finally {
      this._pendingNegotiation = false;
    }
  }

  async _handleRemoteSdp(payload) {
    if (payload.sdpType === "offer") {
      await this.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.send({ kind: "sdp", sdpType: "answer", sdp: this.pc.localDescription.sdp });
    } else if (payload.sdpType === "answer") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    }
  }

  // ---- Звонки ----

  async startCall() {
    if (!this.localAudioTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localAudioTrack = stream.getAudioTracks()[0];
    }
    this.pc.addTrack(this.localAudioTrack);
    this._setStatus("in-call");
    this.send({ kind: "call-state", state: "ringing" });
  }

  // Сторона, которой звонят, должна отдельно и явно добавить свой
  // аудиопоток — без этого разговор получается односторонним: звонящий
  // передаёт звук, а его никто не передаёт обратно.
  async answerCall() {
    if (!this.localAudioTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localAudioTrack = stream.getAudioTracks()[0];
    }
    this.pc.addTrack(this.localAudioTrack);
    this._setStatus("in-call");
    this.send({ kind: "call-state", state: "accepted" });
  }

  declineCall() {
    this.send({ kind: "call-state", state: "declined" });
  }

  setMuted(muted) {
    if (this.localAudioTrack) this.localAudioTrack.enabled = !muted;
  }

  endCall() {
    const senders = this.pc.getSenders().filter((s) => s.track && s.track.kind === "audio");
    senders.forEach((s) => this.pc.removeTrack(s));
    if (this.localAudioTrack) {
      this.localAudioTrack.stop();
      this.localAudioTrack = null;
    }
    this._setStatus(this.dc && this.dc.readyState === "open" ? "connected" : "disconnected");
    this.send({ kind: "call-state", state: "ended" });
  }

  close() {
    this._closed = true;
    try {
      if (this.localAudioTrack) this.localAudioTrack.stop();
      if (this.dc) this.dc.close();
      this.pc.close();
    } catch (e) {}
    this._setStatus("disconnected");
  }
}

// Управляет набором PeerLink (mesh: сколько угодно прямых подключений).
class MeshManager extends EventTarget {
  constructor(localName) {
    super();
    this.localName = localName;
    this.links = new Map(); // id -> PeerLink
  }

  createOutgoingLink(id) {
    const link = new PeerLink({ id, localName: this.localName, role: "offerer" });
    this._wire(link);
    return link;
  }

  createIncomingLink(id) {
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
    for (const [id, link] of this.links) {
      if (id === excludeId) continue;
      link.send(payload);
    }
  }

  get(id) {
    return this.links.get(id);
  }

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
