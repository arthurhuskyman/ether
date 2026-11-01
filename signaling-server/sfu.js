// V.87: SFU — ретранслятор для групповых звонков. Каждый участник держит ОДНО соединение с сервером вместо N−1 соединений
// друг с другом. Сервер не декодирует медиа: пересылает RTP-пакеты как есть, поэтому кадры, зашифрованные на устройствах
// (js/framecrypt.js, ключи отправителей раздаются по сквозному каналу), остаются для него непрозрачными.
// Доступ: только участник группы из реестра (gdeliver.js). Сервер — всегда предлагающая сторона (offer), ICE без trickle.
// Переменные: SFU=1 включает; SFU_MAX_ROOM (25); SFU_PORT_MIN/SFU_PORT_MAX — UDP-диапазон; SFU_PUBLIC_IP — внешний адрес VPS.
const envInt = (n, d) => { const v = parseInt(process.env[n], 10); return Number.isFinite(v) && v > 0 ? v : d; };
function create(ctx) {
  const W = ctx.werift || require("werift");
  const MAX = envInt("SFU_MAX_ROOM", 25);
  const codecs = {
    audio: [new W.RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 })],
    video: [new W.RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96, rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "goog-remb" }] })],
  };
  const portMin = envInt("SFU_PORT_MIN", 0), portMax = envInt("SFU_PORT_MAX", 0);
  const peerCfg = () => Object.assign({ codecs, iceServers: ctx.iceServers ? ctx.iceServers() : [] },
    portMin && portMax > portMin ? { icePortRange: [portMin, portMax] } : {},
    process.env.SFU_PUBLIC_IP ? { iceAdditionalHostAddresses: [process.env.SFU_PUBLIC_IP] } : {},
    ctx.peerConfig || {});
  const rooms = new Map(); // gid -> Map(id -> peer)

  function gathered(pc, ms) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((res) => { const t = setTimeout(res, ms); pc.iceGatheringStateChange.subscribe((s) => { if (s === "complete") { clearTimeout(t); res(); } }); });
  }
  function addOut(sub, src) { // sub будет получать медиа src
    if (sub.outs.has(src.id)) return;
    const a = sub.pc.addTransceiver("audio", { direction: "sendonly" }), v = sub.pc.addTransceiver("video", { direction: "sendonly" });
    sub.outs.set(src.id, { audio: a, video: v });
  }
  function removeOut(sub, srcId) {
    const o = sub.outs.get(srcId); if (!o) return;
    for (const t of [o.audio, o.video]) { try { sub.pc.removeTrack(t.sender); } catch (e) {} }
    sub.outs.delete(srcId);
  }
  async function negotiate(p) {
    if (p.closed) return;
    if (p.busy) { p.again = true; return; }
    p.busy = true; p.again = false;
    try {
      const offer = await p.pc.createOffer(); await p.pc.setLocalDescription(offer); await gathered(p.pc, 3000);
      const map = [];
      for (const [from, o] of p.outs) { map.push({ mid: o.audio.mid, from, kind: "audio" }); map.push({ mid: o.video.mid, from, kind: "video" }); }
      const answered = new Promise((res) => { p.onAnswer = res; setTimeout(() => res(null), 15000); });
      ctx.safeSend(p.ws, { type: "sfu-offer", gid: p.gid, sdp: p.pc.localDescription.sdp, map, up: { audio: p.upA.mid, video: p.upV.mid } });
      const sdp = await answered; p.onAnswer = null;
      if (sdp && !p.closed) await p.pc.setRemoteDescription({ type: "answer", sdp });
    } catch (e) { /* соединение могли закрыть посреди согласования */ }
    p.busy = false;
    if (p.again && !p.closed) negotiate(p);
    else if (!p.closed) keyframeFromAll(p);
  }
  // Новому получателю нужен ключевой кадр от каждого отправителя (иначе картинка появится только со следующим)
  function keyframeFromAll(p) {
    const room = rooms.get(p.gid); if (!room) return;
    for (const src of room.values()) if (src !== p && src.videoSsrc) { try { src.upV.receiver.sendRtcpPLI(src.videoSsrc); } catch (e) {} }
  }
  function forward(src, kind, rtp) {
    const room = rooms.get(src.gid); if (!room) return;
    if (kind === "video") src.videoSsrc = rtp.header.ssrc;
    for (const sub of room.values()) {
      if (sub === src || sub.closed) continue;
      const o = sub.outs.get(src.id); if (!o) continue;
      try { o[kind].sender.sendRtp(rtp); } catch (e) {}
    }
  }
  function join(ws, myId, gid) {
    if (!ctx.isMember(gid, myId)) return { error: "not-member" };
    let room = rooms.get(gid); if (!room) { room = new Map(); rooms.set(gid, room); }
    if (room.has(myId)) leave(myId, gid);
    if (room.size >= MAX) return { error: "full" };
    const pc = new W.RTCPeerConnection(peerCfg());
    const p = { id: myId, gid, ws, pc, outs: new Map(), busy: false, again: false, closed: false, onAnswer: null, videoSsrc: 0 };
    p.upA = pc.addTransceiver("audio", { direction: "recvonly" }); p.upV = pc.addTransceiver("video", { direction: "recvonly" });
    pc.onTrack.subscribe((track) => { const kind = track.kind; track.onReceiveRtp.subscribe((rtp) => forward(p, kind, rtp)); });
    pc.iceConnectionStateChange.subscribe((s) => { if (s === "failed" || s === "closed") leave(myId, gid); });
    for (const o of room.values()) { addOut(p, o); addOut(o, p); }
    room.set(myId, p);
    negotiate(p);
    for (const o of room.values()) if (o !== p) negotiate(o);
    return { ok: true, peers: Array.from(room.keys()).filter((x) => x !== myId) };
  }
  function leave(myId, gid) {
    const room = rooms.get(gid); const p = room && room.get(myId); if (!p) return false;
    p.closed = true; room.delete(myId);
    try { p.pc.close(); } catch (e) {}
    for (const o of room.values()) { removeOut(o, myId); negotiate(o); try { ctx.safeSend(o.ws, { type: "sfu-left", gid, id: myId }); } catch (e) {} }
    if (!room.size) rooms.delete(gid);
    return true;
  }
  function onMessage(ws, msg, myId) {
    if (typeof msg.type !== "string" || !msg.type.startsWith("sfu-")) return false;
    const gid = typeof msg.gid === "string" ? msg.gid.slice(0, 80) : "";
    if (!gid) return true;
    if (msg.type === "sfu-join") { const r = join(ws, myId, gid); ctx.safeSend(ws, Object.assign({ type: "sfu-joined", gid }, r)); }
    else if (msg.type === "sfu-answer") { const p = rooms.get(gid) && rooms.get(gid).get(myId); if (p && p.onAnswer && typeof msg.sdp === "string" && msg.sdp.length < 200000) p.onAnswer(msg.sdp); }
    else if (msg.type === "sfu-leave") leave(myId, gid);
    return true;
  }
  function onClose(myId) { for (const [gid, room] of Array.from(rooms)) if (room.has(myId)) leave(myId, gid); }
  return { onMessage, onClose, rooms, join, leave };
}
module.exports = { create };
