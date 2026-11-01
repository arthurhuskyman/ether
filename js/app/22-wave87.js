"use strict";
// V.87: (1) большие вложения в группы одним зашифрованным блобом: файл шифруется ОДИН раз случайным ключом AES-GCM,
// шифртекст уходит в хранилище сервера (signaling-server/blobs.js), участникам — обычный payload «file» без данных, но с
// {id, k, iv, u}; получатель скачивает, расшифровывает и дальше всё идёт прежним путём. Сервер видит только шифртекст.
// (2) Групповой звонок через SFU (signaling-server/sfu.js) для больших групп: одно соединение с сервером, кадры
// шифруются на устройстве (js/framecrypt.js + ключи отправителей V.86), сервер пересылает их не расшифровывая.

const BLOB_MAX = 16 * 1024 * 1024;
function serverHas(feature) { try { return !!(signaling && signaling.registered && Array.isArray(signaling.features) && signaling.features.includes(feature)); } catch (e) { return false; } }
function httpBaseOf(wsUrl) { const u = String(wsUrl || ""); return /^wss?:\/\//i.test(u) ? u.replace(/^ws/i, "http").replace(/\/+$/, "") : ""; }
function blobBaseAllowed(base) {
  if (!/^https:\/\/[^/]+$/i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)) return false;
  let urls = []; try { urls = serverEntries().map((e) => httpBaseOf(e.url)); } catch (e) {}
  try { urls.push(httpBaseOf(effectiveSignalingUrl())); } catch (e) {}
  return urls.includes(base); // только свои серверы: чужой адрес в сообщении не заставит приложение ходить куда-то ещё
}
function p87B64(u) { let s = ""; const a = new Uint8Array(u); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }
async function blobEncrypt(buf) {
  const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf);
  return { ct, k: p87B64(raw), iv: p87B64(iv) };
}
async function blobDecrypt(ct, k, iv) {
  const key = await crypto.subtle.importKey("raw", base64ToUint8Array(k), "AES-GCM", false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToUint8Array(iv) }, key, ct);
}
function blobTicket(size) {
  return new Promise((resolve) => {
    const rid = crypto.randomUUID(); let done = false;
    const on = (ev) => { const d = ev.detail || {}; if (d.rid !== rid || done) return; done = true; signaling.removeEventListener("blob-ticket", on); resolve(d); };
    signaling.addEventListener("blob-ticket", on);
    if (!signaling.send("blob-ticket", { rid, size })) { done = true; signaling.removeEventListener("blob-ticket", on); resolve({ error: "offline" }); }
    setTimeout(() => { if (!done) { done = true; signaling.removeEventListener("blob-ticket", on); resolve({ error: "timeout" }); } }, 15000);
  });
}
async function uploadBlob(ct) {
  const t = await blobTicket(ct.byteLength); if (!t || t.error || !t.id) throw new Error((t && t.error) || "ticket");
  const base = httpBaseOf(effectiveSignalingUrl());
  const r = await fetch(base + "/blob/" + t.id + "?t=" + t.token, { method: "PUT", body: ct });
  if (r.status !== 201) throw new Error("upload-" + r.status);
  return { id: t.id, u: base };
}
// Отправка в группу файла больше прежнего потолка (1 МБ) — до 16 МБ одним блобом
async function sendGroupFileBlob(groupId, file, meta) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return false;
  meta = meta || {};
  const mime = file.type || meta.mime || "application/octet-stream", name = meta.name || file.name || "file";
  const caption = typeof meta.caption === "string" ? meta.caption.trim().slice(0, 200) : "";
  const msgId = crypto.randomUUID(), ts = Date.now();
  const rec = { id: msgId, from: "me", text: "", ts, ack: "sent", file: { name, mime, size: file.size, kind: fileKindFromMime(mime), pending: true } };
  if (caption) rec.file.caption = caption;
  if (g.disappearingTimer) rec.ttl = g.disappearingTimer;
  g.messages.push(rec); trimMessages(g); g.lastActivity = ts; persistContacts();
  if (state.chatId === groupId) renderChatThreadInner();
  try {
    const buf = await file.arrayBuffer();
    try { await IDB.set("file:" + msgId, new Blob([buf], { type: mime })); } catch (e) {}
    const enc = await blobEncrypt(buf); const up = await uploadBlob(enc.ct);
    const payload = { kind: "file", id: msgId, ts, name, mime, size: file.size, groupId, senderName: Store.name || T("sys.someone"), blob: { id: up.id, u: up.u, k: enc.k, iv: enc.iv } };
    if (caption) payload.caption = caption;
    if (g.disappearingTimer) payload.ttl = g.disappearingTimer;
    for (const m of g.members) {
      if (m.id === Store.myId) continue;
      const mc = ensureContactEntry(m.id, m.name); const deliveryId = crypto.randomUUID();
      groupDeliveryMap.set(deliveryId, { groupId, contentId: msgId, to: m.id }); trimMap(groupDeliveryMap, GROUP_DELIVERY_MAP_LIMIT);
      await trySendOrQueue(mc, deliveryId, payload);
    }
    persistGroupDeliveryMap();
    rec.file.pending = false;
  } catch (e) { rec.file.pending = false; rec.ack = "failed"; toast(T("p87.blob.failed")); }
  persistContacts(); if (state.chatId === groupId) renderChatThreadInner();
  return true;
}
// Приём: скачиваем шифртекст со своего сервера, расшифровываем, дальше — обычный путь файла (dataB64)
async function hydrateBlobPayload(payload) {
  const b = payload.blob;
  if (!b || typeof b.id !== "string" || !/^[0-9a-f]{32}$/.test(b.id) || typeof b.k !== "string" || typeof b.iv !== "string") return null;
  if (!Number.isInteger(payload.size) || payload.size <= 0 || payload.size > BLOB_MAX) return null;
  const base = String(b.u || "").replace(/\/+$/, ""); if (!blobBaseAllowed(base)) return null;
  const r = await fetch(base + "/blob/" + b.id); if (!r.ok) return null;
  const ct = await r.arrayBuffer(); if (ct.byteLength > BLOB_MAX + 64) return null;
  const pt = await blobDecrypt(ct, b.k, b.iv);
  if (pt.byteLength !== payload.size) return null;
  return Object.assign({}, payload, { dataB64: arrayBufferToBase64(pt), blob: undefined });
}

// ---------- SFU для групповых звонков ----------
const SFU_MIN_MEMBERS = 6; // в группах до 6 человек сетка (mesh) не хуже, а сервер не нужен
const SFU = { pc: null, gid: null, map: new Map(), streams: new Map() };
function sfuWanted(g) {
  let mode = "auto"; try { mode = localStorage.getItem("ether.sfuMode") || "auto"; } catch (e) {}
  if (mode === "off" || !g || !serverHas("sfu") || !p86FrameE2EESupported()) return false;
  return mode === "on" || (Array.isArray(g.members) && g.members.length > SFU_MIN_MEMBERS);
}
async function sfuGathered(pc, ms) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((res) => { const t = setTimeout(res, ms); pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } }); });
}
async function sfuOnOffer(d) {
  if (!GC.gid || d.gid !== GC.gid || !GC.sfu) return false;
  if (!SFU.pc) {
    let ice = []; try { ice = await fetchIceServers(4000); } catch (e) {}
    SFU.pc = new RTCPeerConnection({ iceServers: ice || [] }); SFU.gid = GC.gid;
    SFU.pc.addEventListener("track", (ev) => {
      const from = SFU.map.get(ev.transceiver && ev.transceiver.mid); if (!from) return;
      let ms = SFU.streams.get(from); if (!ms) { ms = new MediaStream(); SFU.streams.set(from, ms); }
      ms.addTrack(ev.track); GC.joined.add(from);
      try { gcallOnRemoteTrack({ detail: { id: from, stream: ms, track: ev.track } }); } catch (e) {}
    });
  }
  for (const m of Array.isArray(d.map) ? d.map : []) if (m && typeof m.mid === "string" && typeof m.from === "string") SFU.map.set(m.mid, m.from);
  await SFU.pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
  for (const t of SFU.pc.getTransceivers()) {
    const up = d.up && (t.mid === d.up.audio || t.mid === d.up.video);
    if (up) {
      t.direction = "sendonly";
      const kind = t.mid === d.up.audio ? "audio" : "video";
      const tr = GC.stream && GC.stream.getTracks().find((x) => x.kind === kind);
      if (tr && t.sender.track !== tr) { try { await t.sender.replaceTrack(tr); } catch (e) {} }
    } else t.direction = "recvonly";
  }
  try { sfuAttachE2EE(SFU.pc); } catch (e) {}
  const ans = await SFU.pc.createAnswer(); await SFU.pc.setLocalDescription(ans); await sfuGathered(SFU.pc, 2500);
  signaling.send("sfu-answer", { gid: d.gid, sdp: SFU.pc.localDescription.sdp });
  return true;
}
// Шифрование кадров: отправка — своим ключом, приём — ключом того участника, чей это поток
function sfuAttachE2EE(pc) {
  if (!p86FrameE2EESupported()) return false;
  if (!FK.worker) { FK.worker = new Worker("js/frame-worker.js"); if (FK.raw) p86WorkerKey("me", FK.epoch, FK.raw); for (const [id, m] of FK.peers) for (const [e, raw] of m) p86WorkerKey(id, e, raw); }
  for (const t of pc.getTransceivers()) {
    const from = SFU.map.get(t.mid);
    if (from && !t.receiver.transform) t.receiver.transform = new RTCRtpScriptTransform(FK.worker, { dir: "dec", peer: from });
    if (!from && t.sender && !t.sender.transform) t.sender.transform = new RTCRtpScriptTransform(FK.worker, { dir: "enc" });
  }
  return true;
}
function sfuLeave() {
  try { if (SFU.gid && signaling) signaling.send("sfu-leave", { gid: SFU.gid }); } catch (e) {}
  try { if (SFU.pc) SFU.pc.close(); } catch (e) {}
  SFU.pc = null; SFU.gid = null; SFU.map = new Map(); SFU.streams = new Map();
}
function sfuFallbackToMesh() { // сервер не пустил — звонок продолжается сеткой
  GC.sfu = false; sfuLeave();
  for (const id of GC.peers.keys()) { const l = mesh.get(id); if (l && GC.stream && typeof l.addGroupTracks === "function") l.addGroupTracks(GC.stream); }
}

let __p87Wired = false;
function p87WireGroupCall() {
  if (__p87Wired || typeof gcallEnter !== "function") return; __p87Wired = true;
  const origEnter = gcallEnter;
  gcallEnter = function (gid) {
    const r = origEnter.apply(this, arguments);
    GC.sfu = sfuWanted(gcallGroup(gid));
    if (GC.sfu) signaling.send("sfu-join", { gid });
    return r;
  };
  const origReg = gcallRegisterPeer;
  gcallRegisterPeer = function () { // в режиме SFU свои треки не уходят в прямые соединения — только на сервер
    if (!GC.sfu) return origReg.apply(this, arguments);
    const s = GC.stream; GC.stream = null;
    try { return origReg.apply(this, arguments); } finally { GC.stream = s; }
  };
  const origLeave = leaveGroupCall;
  leaveGroupCall = function () { if (GC.sfu) sfuLeave(); GC.sfu = false; return origLeave.apply(this, arguments); };
}
function p87Wire() {
  if (typeof document === "undefined") return;
  const origSend = sendGroupFile;
  sendGroupFile = function (groupId, file, meta) {
    if (file && file.size > GROUP_FILE_MAX && file.size <= BLOB_MAX && serverHas("blob")) return sendGroupFileBlob(groupId, file, meta);
    return origSend.apply(this, arguments);
  };
  const origFileCheck = sendFileMessage;
  sendFileMessage = function (contactId, file, opts) { // для групп потолок поднимается до 16 МБ, если сервер хранит блобы
    const c = state.contacts.get(contactId);
    if (c && isGroup(c) && !c.isChannel && file && file.size > GROUP_FILE_MAX && file.size <= BLOB_MAX && serverHas("blob")) return sendGroupFileBlob(contactId, file, Object.assign({}, opts || {}));
    return origFileCheck.apply(this, arguments);
  };
  const origApply = applyIncomingPayload;
  applyIncomingPayload = function (from, envelopeMsgId, payload) {
    if (payload && payload.kind === "file" && payload.blob && !payload.dataB64) {
      const args = Array.prototype.slice.call(arguments);
      hydrateBlobPayload(payload).then((p) => { if (p) { args[2] = p; origApply.apply(this, args); } }).catch((e) => etherLog("warn", "[blob] " + String(e)));
      return;
    }
    return origApply.apply(this, arguments);
  };
  const origWire = wireSignalingEvents;
  wireSignalingEvents = function (sig) { const r = origWire.apply(this, arguments); try { p87WireSignaling(sig); } catch (e) {} return r; };
  try { if (signaling && signaling.addEventListener) p87WireSignaling(signaling); } catch (e) {}
  const origTab = renderTab;
  renderTab = function () { const r = origTab.apply(this, arguments); try { p87InjectSettings(); } catch (e) {} return r; };
  p87WireSealed();
  if (typeof gcallEnter === "function") p87WireGroupCall();
  else window.addEventListener("load", p87WireGroupCall, { once: true });
}
const __p87Sig = new WeakSet();
function p87WireSignaling(s) {
  if (!s || __p87Sig.has(s)) return; __p87Sig.add(s);
  s.addEventListener("sfu-offer", (ev) => { sfuOnOffer(ev.detail || {}).catch((e) => etherLog("warn", "[sfu] " + String(e))); });
  s.addEventListener("sfu-joined", (ev) => { const d = ev.detail || {}; if (d.error && GC.sfu && d.gid === GC.gid) sfuFallbackToMesh(); });
  s.addEventListener("sealed", (ev) => { onSealed(s, ev.detail || {}); });
  const uak = () => { if (Array.isArray(s.features) && s.features.includes("sealed")) sha256Hex(base64ToUint8Array(sealedAccessKey())).then((h) => s.send("set-uak", { h: sealedOn() ? h : "" })).catch(() => {}); };
  s.addEventListener("registered", uak); if (s.registered) uak();
  const pqr = () => { try { if (s === signaling && typeof Ratchet !== "undefined" && Ratchet.setQOk) Ratchet.setQOk(Array.isArray(s.features) && s.features.includes("pqr")); } catch (e) {} }; // V.88
  s.addEventListener("registered", pqr); if (s.registered) pqr();
  s.addEventListener("sfu-left", (ev) => { const d = ev.detail || {}; if (d.gid === GC.gid) SFU.streams.delete(d.id); });
}

function p87InjectSettings() {
  const conn = document.getElementById("p85-conn-group"); if (!conn || document.getElementById("p87-sfu-mode")) return false;
  conn.insertAdjacentHTML("beforeend", `<label class="settings-row"><span data-i18n="p87.sfu">${escapeHtml(T("p87.sfu"))}</span><select id="p87-sfu-mode" class="settings-select">
    <option value="auto">${escapeHtml(T("p87.sfu.auto"))}</option><option value="on">${escapeHtml(T("p87.sfu.on"))}</option><option value="off">${escapeHtml(T("p87.sfu.off"))}</option></select></label>
    <p class="fine muted settings-hint" data-i18n="p87.sfu.hint">${escapeHtml(T("p87.sfu.hint"))}</p>`);
  const priv = document.getElementById("p84-privacy-rows");
  if (priv && !document.getElementById("p87-sealed")) {
    priv.insertAdjacentHTML("beforeend", `<label class="settings-row"><span data-i18n="p87.sealed">${escapeHtml(T("p87.sealed"))}</span><input id="p87-sealed" type="checkbox" class="switch" /></label>`);
    const cb = document.getElementById("p87-sealed"); cb.checked = sealedOn();
    cb.addEventListener("change", () => { try { localStorage.setItem("ether.sealed", cb.checked ? "1" : "0"); } catch (e) {} try { if (signaling && signaling.registered) sha256Hex(base64ToUint8Array(sealedAccessKey())).then((h) => signaling.send("set-uak", { h: cb.checked ? h : "" })); } catch (e) {} });
  }
  const sel = document.getElementById("p87-sfu-mode");
  try { sel.value = localStorage.getItem("ether.sfuMode") || "auto"; } catch (e) {}
  sel.addEventListener("change", () => { try { localStorage.setItem("ether.sfuMode", sel.value); } catch (e) {} });
  return true;
}

// ---------- Запечатанный отправитель ----------
// Конверт (уже зашифрованный храповиком) дополнительно запечатывается одноразовым ключом ECDH на открытый ключ получателя
// и уходит с отдельного анонимного соединения: в ящике и в журнале сервера нет поля «от кого». Сервер пускает конверт
// только с ключом доступа получателя (16 байт; его знают только контакты — приходит в privacy-pref по сквозному каналу).
function sealedAccessKey() {
  let v = null; try { v = localStorage.getItem("ether.ak"); } catch (e) {}
  if (!v || !/^[A-Za-z0-9+/]{22}==$/.test(v)) { v = p87B64(crypto.getRandomValues(new Uint8Array(16))); try { localStorage.setItem("ether.ak", v); } catch (e) {} }
  return v;
}
async function sha256Hex(bytes) { const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join(""); }
function sealedOn() { try { return localStorage.getItem("ether.sealed") !== "0"; } catch (e) { return true; } }
async function sealFor(c, inner) {
  const eph = await CryptoHelper.generateKeyPair();
  const key = await CryptoHelper.deriveSharedKey(eph.privateKeyJwk, c.publicKey);
  const enc = await CryptoHelper.encryptJson(key, inner, new TextEncoder().encode("ether-sealed|" + c.id));
  return btoa(JSON.stringify({ e: eph.publicKeyJwk, iv: enc.iv, ct: enc.ct }));
}
async function unseal(s) {
  const o = JSON.parse(atob(String(s)));
  if (!o || !o.e || typeof o.iv !== "string" || typeof o.ct !== "string") return null;
  const key = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, o.e);
  return CryptoHelper.decryptJson(key, { iv: o.iv, ct: o.ct, v: 2 }, new TextEncoder().encode("ether-sealed|" + Store.myId));
}
// Анонимное соединение — тот же сервер, но без регистрации (сервер не связывает его с нашим id)
const ANON = { ws: null, url: "", q: [], wait: new Map() };
function anonSocket() {
  const url = effectiveSignalingUrl();
  if (ANON.ws && ANON.url === url && ANON.ws.readyState <= 1) return ANON.ws;
  try { if (ANON.ws) ANON.ws.close(); } catch (e) {}
  ANON.url = url; ANON.ws = new WebSocket(url);
  ANON.ws.addEventListener("open", () => { const q = ANON.q.splice(0); for (const m of q) ANON.ws.send(m); });
  ANON.ws.addEventListener("message", (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m && m.type === "sealed-ack") { const f = ANON.wait.get(m.msgId); if (f) { ANON.wait.delete(m.msgId); f(m); } } });
  ANON.ws.addEventListener("close", () => { for (const f of ANON.wait.values()) f({ error: "closed" }); ANON.wait.clear(); });
  return ANON.ws;
}
function anonSend(obj) {
  return new Promise((res) => {
    const ws = anonSocket(); const raw = JSON.stringify(obj);
    ANON.wait.set(obj.msgId, res); setTimeout(() => { if (ANON.wait.get(obj.msgId) === res) { ANON.wait.delete(obj.msgId); res({ error: "timeout" }); } }, 12000);
    if (ws.readyState === 1) ws.send(raw); else ANON.q.push(raw);
  });
}
function sealedUsable(sig, to, kind, nb) {
  if (!sealedOn() || sig !== signaling || nb || !Array.isArray(sig.features) || !sig.features.includes("sealed")) return null;
  if (typeof kind === "string" && /^(sync-|dev|gchat|chan)/.test(kind)) return null;
  const c = state.contacts.get(to);
  return c && !isGroup(c) && typeof c.ak === "string" && c.publicKey && typeof c.publicKey === "object" ? c : null;
}
async function sealedDeliver(sig, c, msgId, envelope, fromPublicKey, kind) {
  const s = await sealFor(c, { from: Store.myId, msgId, envelope, fromPublicKey: fromPublicKey || null, kind: typeof kind === "string" ? kind : "chat" });
  const r = await anonSend({ type: "sealed-deliver", to: c.id, msgId, s, ak: c.ak });
  if (r && !r.error) { sig.dispatchEvent(new CustomEvent("deliver-ack", { detail: { msgId, error: null } })); return true; }
  return false;
}
function p87WireSealed() {
  if (typeof SignalingClient !== "function" || SignalingClient.prototype.__p87) return;
  SignalingClient.prototype.__p87 = true;
  const orig = SignalingClient.prototype.deliver;
  SignalingClient.prototype.deliver = function (to, msgId, envelope, fromPublicKey, kind, nb) {
    const c = sealedUsable(this, to, kind, nb);
    if (!c) return orig.apply(this, arguments);
    const self = this, args = arguments;
    sealedDeliver(self, c, msgId, envelope, fromPublicKey, kind).then((ok) => { if (!ok) orig.apply(self, args); }).catch(() => orig.apply(self, args));
    return true;
  };
}
async function onSealed(sig, d) {
  let inner = null; try { inner = await unseal(d.s); } catch (e) {}
  const c = inner && typeof inner.from === "string" && state.contacts.get(inner.from);
  if (!c || inner.msgId !== d.msgId || !inner.envelope) { try { sig.send("mailbox-ack", { msgId: d.msgId }); } catch (e) {} return false; }
  handleDeliver({ from: inner.from, msgId: d.msgId, envelope: inner.envelope, fromPublicKey: inner.fromPublicKey || null, kind: inner.kind || "chat", queued: !!d.queued, sealed: true }, false);
  return true;
}
