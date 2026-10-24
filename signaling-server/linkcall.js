// Звонок по ссылке (docs/CALL-RELIABILITY-PROTOCOL.md, раздел E): комнаты на двоих, сервер ретранслирует непрозрачные SDP/ICE.
// Гость может быть НЕзарегистрированным сокетом, но только для linkcall-join / linkcall-signal / linkcall-end.
const crypto = require("crypto");

module.exports = function createLinkCalls({ safeSend, rateOk, envInt }) {
  const TTL_MS = envInt("LINKCALL_TTL_MS", 10 * 60 * 1000);          // до входа гостя
  const MAX_MS = envInt("LINKCALL_MAX_MS", 2 * 60 * 60 * 1000);      // жизнь комнаты максимум
  const MAX_PER_ID = envInt("LINKCALL_MAX_PER_ID", 3);
  const MAX_ROOMS = envInt("LINKCALL_MAX_ROOMS", 5000);
  const CREATE_PER_MIN = envInt("LINKCALL_CREATE_PER_MIN", 6);
  const JOIN_ROOM_PER_MIN = envInt("LINKCALL_JOIN_ROOM_PER_MIN", 20);
  const JOIN_CODE_PER_MIN = envInt("LINKCALL_JOIN_CODE_PER_MIN", 5);
  const SIGNAL_PER_MIN = envInt("LINKCALL_SIGNAL_PER_MIN", 1200);
  const SIGNAL_MAX_BYTES = 64 * 1024;
  const TOMB_MS = 60 * 1000;
  const rooms = new Map();   // room -> запись
  const byCode = new Map();  // code -> room
  const tombs = new Map();   // room|code -> ts: комната истекла (отличить "expired" от "notfound")
  const hits = { create: new Map(), createIp: new Map(), room: new Map(), code: new Map(), sig: new Map() };

  const timer = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; };
  const sweeper = setInterval(() => { const now = Date.now(); for (const [k, ts] of tombs) if (now - ts > TOMB_MS) tombs.delete(k); }, 30000);
  sweeper.unref();

  function newCode() {
    for (let i = 0; i < 30; i++) {
      const c = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      if (!byCode.has(c) && !tombs.has(c)) return c;
    }
    return null;
  }
  function close(r, notify, reason, expired) {
    if (r.closed) return;
    r.closed = true;
    clearTimeout(r.ttlT); clearTimeout(r.maxT);
    rooms.delete(r.room); byCode.delete(r.code);
    if (expired) { tombs.set(r.room, Date.now()); tombs.set(r.code, Date.now()); }
    for (const ws of [r.creatorWs, r.guest && r.guest.ws]) {
      if (!ws) continue;
      if (ws._lcRooms) ws._lcRooms.delete(r.room);
      if (notify) safeSend(ws, { type: "linkcall-end", room: r.room, reason });
    }
  }
  function other(r, ws) { return ws === r.creatorWs ? (r.guest && r.guest.ws) : ws === (r.guest && r.guest.ws) ? r.creatorWs : null; }
  function cleanName(n) { return typeof n === "string" ? n.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40) : ""; }

  function create(ws, ctx) {
    if (!ctx.id) return;
    if (!rateOk(hits.create, ctx.id, CREATE_PER_MIN) || !rateOk(hits.createIp, ctx.ip, CREATE_PER_MIN * 3)) return safeSend(ws, { type: "linkcall-error", reason: "ratelimit" });
    let mine = 0; for (const r of rooms.values()) if (r.creatorId === ctx.id) mine++;
    if (mine >= MAX_PER_ID || rooms.size >= MAX_ROOMS) return safeSend(ws, { type: "linkcall-error", reason: "ratelimit" });
    const code = newCode(); if (!code) return safeSend(ws, { type: "linkcall-error", reason: "ratelimit" });
    const room = crypto.randomBytes(16).toString("base64url");
    const expiresAt = Date.now() + TTL_MS;
    const r = { room, code, creatorId: ctx.id, creatorWs: ws, guest: null, expiresAt, closed: false };
    r.ttlT = timer(() => close(r, true, "expired", true), TTL_MS);
    r.maxT = timer(() => close(r, true, "expired", true), MAX_MS);
    rooms.set(room, r); byCode.set(code, room);
    (ws._lcRooms = ws._lcRooms || new Set()).add(room);
    safeSend(ws, { type: "linkcall-created", room, code, expiresAt });
  }
  function join(ws, msg, ctx) {
    const viaCode = typeof msg.code === "string" && !msg.room;
    const key = viaCode ? msg.code : msg.room;
    if (typeof key !== "string" || key.length > 64) return safeSend(ws, { type: "linkcall-error", reason: "notfound" });
    if (!rateOk(viaCode ? hits.code : hits.room, ctx.ip, viaCode ? JOIN_CODE_PER_MIN : JOIN_ROOM_PER_MIN)) return safeSend(ws, { type: "linkcall-error", reason: "ratelimit" });
    const roomId = viaCode ? byCode.get(key) : key;
    const r = roomId && rooms.get(roomId);
    if (!r) return safeSend(ws, { type: "linkcall-error", reason: tombs.has(key) ? "expired" : "notfound" });
    if (r.guest) return safeSend(ws, { type: "linkcall-error", reason: "full" });
    if (ws === r.creatorWs || (ws._lcRooms && ws._lcRooms.size >= MAX_PER_ID)) return safeSend(ws, { type: "linkcall-error", reason: "notfound" });
    if (Date.now() > r.expiresAt) { close(r, true, "expired", true); return safeSend(ws, { type: "linkcall-error", reason: "expired" }); }
    const guestRef = crypto.randomBytes(8).toString("base64url");
    r.guest = { ws, ref: guestRef, name: cleanName(msg.name), viaCode };
    clearTimeout(r.ttlT); // TTL действует только до входа гостя; дальше — MAX_MS
    (ws._lcRooms = ws._lcRooms || new Set()).add(r.room);
    if (ctx.onJoined) ctx.onJoined(); // неавторизованный гость не должен быть закрыт по таймауту регистрации
    safeSend(ws, { type: "linkcall-joined", room: r.room });
    safeSend(r.creatorWs, { type: "linkcall-guest", room: r.room, guestRef, name: r.guest.name, viaCode });
  }
  function decide(ws, msg, ctx, allow) {
    const r = ctx.id && typeof msg.room === "string" && rooms.get(msg.room);
    if (!r || r.creatorWs !== ws || r.creatorId !== ctx.id || !r.guest || r.guest.ref !== msg.guestRef) return;
    if (allow) { r.guest.allowed = true; return safeSend(r.guest.ws, { type: "linkcall-allowed", room: r.room }); }
    const g = r.guest; r.guest = null;
    if (g.ws._lcRooms) g.ws._lcRooms.delete(r.room);
    safeSend(g.ws, { type: "linkcall-denied", room: r.room });
    const left = r.expiresAt - Date.now();
    if (left <= 0) close(r, true, "expired", true); else r.ttlT = timer(() => close(r, true, "expired", true), left);
  }
  function signal(ws, msg) {
    const r = typeof msg.room === "string" && rooms.get(msg.room);
    const peer = r && other(r, ws);
    if (!peer) return; // посторонний сокет (не создатель и не гость комнаты) ничего не вставит
    if (!rateOk(hits.sig, ws._lcSigKey || (ws._lcSigKey = crypto.randomBytes(6).toString("hex")), SIGNAL_PER_MIN)) return;
    let n = 1e9; try { n = JSON.stringify(msg.data === undefined ? null : msg.data).length; } catch (e) {}
    if (n > SIGNAL_MAX_BYTES) return;
    safeSend(peer, { type: "linkcall-signal", room: r.room, data: msg.data });
  }
  function end(ws, msg) {
    const r = typeof msg.room === "string" && rooms.get(msg.room);
    if (!r) return;
    if (ws !== r.creatorWs && !(r.guest && r.guest.ws === ws)) return;
    const peer = other(r, ws);
    close(r, false);
    if (peer) safeSend(peer, { type: "linkcall-end", room: r.room, reason: "ended" });
  }
  return {
    onMessage(ws, msg, ctx) {
      switch (msg.type) {
        case "linkcall-create": return create(ws, ctx);
        case "linkcall-join": return join(ws, msg, ctx);
        case "linkcall-allow": return decide(ws, msg, ctx, true);
        case "linkcall-deny": return decide(ws, msg, ctx, false);
        case "linkcall-signal": return signal(ws, msg);
        case "linkcall-end": return end(ws, msg);
      }
    },
    onClose(ws) {
      if (!ws._lcRooms) return;
      for (const id of Array.from(ws._lcRooms)) {
        const r = rooms.get(id); if (!r) continue;
        const peer = other(r, ws);
        close(r, false);
        if (peer) safeSend(peer, { type: "linkcall-end", room: r.room, reason: "peer-left" });
      }
    },
    _stats: () => ({ rooms: rooms.size, codes: byCode.size, tombs: tombs.size }),
  };
};
