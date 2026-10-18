// Companion-устройства аккаунта на сервере (docs/MULTIDEVICE.md, этап 2). Основное устройство (без deviceId) работает как раньше.
// Companion регистрируется как (id, deviceId), доказывает владение ключом устройства подписью над нонсом (ключ берётся из сертификата
// в списке устройств, опубликованном владельцем id) и получает ОТДЕЛЬНЫЙ ящик "id#deviceId". Присутствие и ростер он не затрагивает и
// основное соединение не вытесняет. Копии сообщений для устройств приходят от отправителя (по одному конверту на устройство), сервер
// их не создаёт и прочитать не может. Отозванное/просроченное/удалённое из списка устройство не получает доставку, его ящик очищается.
const crypto = require("crypto");
const DEV_RE = /^[0-9a-f]{16}$/;
const MAX_COPIES = 8;
const companions = new Map(); // id -> Map(devId -> {ws, since})

function activeCert(deviceLists, id, devId, now = Date.now()) {
  const e = deviceLists.get(id); if (!e) return null;
  const l = e.list; if ((l.revoked || []).includes(devId)) return null;
  const c = (l.certs || []).find((x) => x && x.devId === devId && x.id === id);
  return c && c.pub && c.expires > now ? c : null;
}
function authMsg(nonce, id, devId) { return Buffer.from("ether-devauth-v1|" + nonce + "|" + id + "|" + devId); }
function verifySig(cert, nonce, id, devId, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: cert.pub.x, y: cert.pub.y }, format: "jwk" });
    return crypto.verify("sha256", authMsg(nonce, id, devId), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(String(sigB64), "base64"));
  } catch (e) { return false; }
}
const boxKey = (id, devId) => id + "#" + devId;

// ctx: { deviceLists, safeSend, mailboxPut, mailboxRemove, scheduleSave, flush(key, ws, extra), isValidEnvelope, cleanEnvelope, cleanKind, rateOk(key, to), WebSocket, clientsGet }
// Возвращает true, если сообщение обработано здесь.
function onMessage(ws, msg, ctx) {
  const { safeSend } = ctx;
  if (msg.type === "register" && typeof msg.deviceId === "string") {
    const id = msg.id, devId = msg.deviceId;
    if (typeof id !== "string" || !id || id.length > 128 || !DEV_RE.test(devId)) { safeSend(ws, { type: "register-error", error: "device-not-authorized" }); return true; }
    const cert = activeCert(ctx.deviceLists, id, devId);
    if (!cert) { safeSend(ws, { type: "register-error", error: "device-not-authorized", id }); return true; }
    ws._devPending = { id, devId, nonce: crypto.randomBytes(16).toString("base64url"), cert, at: Date.now() };
    safeSend(ws, { type: "device-challenge", nonce: ws._devPending.nonce });
    return true;
  }
  if (msg.type === "device-auth" && ws._devPending) {
    const p = ws._devPending; ws._devPending = null;
    if (Date.now() - p.at > 30_000 || !verifySig(p.cert, p.nonce, p.id, p.devId, msg.sig) || !activeCert(ctx.deviceLists, p.id, p.devId)) { safeSend(ws, { type: "register-error", error: "device-not-authorized", id: p.id }); return true; }
    let m = companions.get(p.id); if (!m) { m = new Map(); companions.set(p.id, m); }
    const old = m.get(p.devId); if (old && old.ws !== ws) { safeSend(old.ws, { type: "replaced" }); try { old.ws.close(); } catch (e) {} }
    m.set(p.devId, { ws, since: Date.now() });
    ws._dev = { id: p.id, devId: p.devId }; ws.lastClientPing = Date.now();
    safeSend(ws, { type: "registered", id: p.id, device: true, deviceId: p.devId, online: [], features: ctx.features });
    ctx.flush(boxKey(p.id, p.devId), ws);
    return true;
  }
  if (!ws._dev) return false;
  const { id, devId } = ws._dev;
  if (!activeCert(ctx.deviceLists, id, devId)) { drop(id, devId); try { ws.close(); } catch (e) {} return true; }
  if (msg.type === "mailbox-ack" && typeof msg.msgId === "string") { if (ctx.mailboxRemove(boxKey(id, devId), msg.msgId)) ctx.scheduleSave(); return true; }
  if (msg.type === "devices-get" && typeof msg.to === "string" && msg.to.length <= 128 && typeof msg.rid === "string" && msg.rid.length <= 40) {
    const e = ctx.deviceLists.get(msg.to); safeSend(ws, { type: "devices-list", rid: msg.rid, to: msg.to, list: e ? e.list : null }); return true;
  }
  if (msg.type === "deliver" && typeof msg.to === "string" && msg.to.length <= 128 && typeof msg.msgId === "string" && msg.msgId.length <= 128) {
    if (!ctx.rateOk(boxKey(id, devId), msg.to)) return true;
    const kind = ctx.cleanKind(msg.kind);
    const env = msg.envelope != null ? (ctx.isValidEnvelope(msg.envelope) ? ctx.cleanEnvelope(msg.envelope) : null) : undefined;
    if (env === null) { safeSend(ws, { type: "deliver-ack", msgId: msg.msgId, error: "invalid-envelope" }); return true; }
    const r = dispatch(ctx, { fromId: id, fromDev: devId, to: msg.to, msgId: msg.msgId, kind, envelope: env || null, copies: msg.copies, fromPublicKey: msg.fromPublicKey });
    safeSend(ws, { type: "deliver-ack", msgId: msg.msgId, ...(r ? {} : { error: "invalid-envelope" }) });
    return true;
  }
  return true; // прочее companion-у недоступно (звонки, присутствие, prekeys)
}

// Раздаёт копии получателю и его устройствам. envelope — для основного устройства to (может отсутствовать), copies — [{dev, envelope}]
// (dev "" = основное). Возвращает false при невалидных копиях.
function dispatch(ctx, { fromId, fromDev, to, msgId, kind, envelope, copies, fromPublicKey }) {
  const list = [];
  if (copies != null) {
    if (!Array.isArray(copies) || copies.length > MAX_COPIES) return false;
    const seen = new Set();
    for (const c of copies) {
      if (!c || typeof c !== "object" || typeof c.dev !== "string" || (c.dev !== "" && !DEV_RE.test(c.dev)) || seen.has(c.dev) || !ctx.isValidEnvelope(c.envelope)) return false;
      seen.add(c.dev); const env = ctx.cleanEnvelope(c.envelope); if (!env) return false; list.push({ dev: c.dev, envelope: env });
    }
  }
  if (envelope) list.push({ dev: "", envelope });
  const pk = fromPublicKey && typeof fromPublicKey === "object" && JSON.stringify(fromPublicKey).length <= 1024 ? fromPublicKey : null;
  for (const { dev, envelope: env } of list) {
    if (fromId === to && dev === (fromDev || "")) continue; // себе-же-устройству не доставляем
    const payload = { from: fromId, msgId, envelope: env, fromPublicKey: pk, kind, ...(fromDev ? { fromDev } : {}) };
    if (dev === "") {
      if (fromId === to && !fromDev) continue;
      ctx.mailboxPut(to, msgId, { ...payload, ts: Date.now() });
      const t = ctx.clientsGet(to); if (t && t.ws.readyState === ctx.WebSocket.OPEN) ctx.safeSend(t.ws, { type: "deliver", ...payload, queued: false });
    } else {
      if (!activeCert(ctx.deviceLists, to, dev)) continue; // нет в списке / отозвано / просрочено: не доставляем
      ctx.mailboxPut(boxKey(to, dev), msgId, { ...payload, ts: Date.now() });
      const m = companions.get(to), c = m && m.get(dev);
      if (c && c.ws.readyState === ctx.WebSocket.OPEN) ctx.safeSend(c.ws, { type: "deliver", ...payload, queued: false });
    }
  }
  ctx.scheduleSave();
  return true;
}
function drop(id, devId) { const m = companions.get(id); if (m) { m.delete(devId); if (!m.size) companions.delete(id); } }
function onClose(ws) { if (ws._dev) { const m = companions.get(ws._dev.id); const c = m && m.get(ws._dev.devId); if (c && c.ws === ws) drop(ws._dev.id, ws._dev.devId); } }
// Список обновился: отозванных/удалённых отключаем и чистим их ящики.
function onListChanged(id, ctx) {
  const m = companions.get(id);
  for (const [devId, c] of m ? Array.from(m) : []) if (!activeCert(ctx.deviceLists, id, devId)) { ctx.safeSend(c.ws, { type: "device-revoked" }); try { c.ws.close(); } catch (e) {} drop(id, devId); }
  const e = ctx.deviceLists.get(id);
  if (e) for (const k of ctx.mailboxKeys(id + "#")) { const devId = k.slice(id.length + 1); if (!activeCert(ctx.deviceLists, id, devId)) ctx.mailboxDropBox(k); }
}
module.exports = { onMessage, dispatch, onClose, onListChanged, companions, activeCert, MAX_COPIES };
