// =====================================================================
// Несколько устройств аккаунта (docs/MULTIDEVICE.md, этапы 2 и 3): companion-устройства, копии по устройствам, sync-sent, список и отзыв.
// Основной ключ личности остаётся на основном устройстве. Companion получает ОТДЕЛЬНЫЙ ключ P-256 (в ether.privKey этого устройства
// лежит ключ устройства) и сертификат, подписанный основным. Копии для устройств шифруются статически (ECDH + AES-GCM с AAD
// «ether-env-v2|от|кому»): ключ = ECDH(мой секретный, публичный ключ устройства получателя или личности). Double Ratchet на
// companion не используется (честное ограничение: у этих копий нет прямой секретности ratchet).
// Опирается на глобалы app.js: Store, state, signaling, CryptoHelper, DeviceCert, DeviceLinkUI, toast, T, pushSystemNote, persistContacts.
// =====================================================================
const Devices = (() => {
  const K_SELF = "ether.dev.self", K_LIST = "ether.dev.list", K_PEERS = "ether.dev.peers", K_REVOKED = "ether.dev.revoked";
  const PEER_TTL_MS = 10 * 60_000;
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const NOT_FOR_COMPANION = ["ether.privKey", "ether.ratchet", "ether.claimToken", "ether.sigKey", "ether.outbox", "ether.pendingNoKey", "ether.heldDeliveries",
    "ether.dev.list", "ether.dev.peers", "ether.dev.self", "ether.dev.revoked", "ether.dev.ops", "ether.dev.wantAt", "ether.pushSubscription", "ether.pinHash", "ether.pinSalt", "ether.pinEnabled", "ether.groupDeliveryMap"];
  const self = () => ls.get(K_SELF);
  const isCompanion = () => !!self();
  const jwkPub = (p) => ({ kty: "EC", crv: "P-256", x: p.x, y: p.y, ext: true });
  const hasFeature = (f) => !!(typeof signaling !== "undefined" && signaling && Array.isArray(signaling.features) && signaling.features.includes(f));
  const peers = () => ls.get(K_PEERS) || {};
  const listState = () => ls.get(K_LIST) || { seq: 0, certs: [], revoked: [], signed: null };
  const active = (c) => c && c.expires > Date.now();

  // ---- основное устройство: выпуск, публикация, отзыв ----
  async function publish() {
    const l = listState(); if (!Store.myId || !Store.myPrivateKeyJwk) return false;
    if (l.seq > 0 && (!l.signed || l.signed.seq !== l.seq)) { l.signed = await DeviceCert.signList(Store.myPrivateKeyJwk, { id: Store.myId, seq: l.seq, certs: l.certs, revoked: l.revoked }); ls.set(K_LIST, l); }
    if (!l.signed || typeof signaling === "undefined" || !signaling || !hasFeature("devlist")) return false;
    return signaling.putDevices(l.signed);
  }
  async function issuePairing(label) {
    if (isCompanion()) throw Object.assign(new Error("companion"), { code: "companion" });
    if (!hasFeature("devmail")) throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    const l = listState(); if (l.certs.filter(active).length >= DeviceCert.MAX_DEVICES - 1) throw Object.assign(new Error("too many"), { code: "too-many" });
    const dk = await DeviceCert.genDeviceKey(), devId = DeviceCert.newDeviceId();
    const cert = await DeviceCert.issue(Store.myPrivateKeyJwk, { id: Store.myId, devId, pub: dk.pub, label: label || (T("devices.companionLabel") + " " + new Date().toLocaleDateString()) });
    l.certs = l.certs.filter(active).concat([cert]); l.seq++; l.signed = null; ls.set(K_LIST, l);
    await publish();
    return { devId, cert, priv: dk.priv };
  }
  async function revoke(devId) {
    const l = listState(); l.certs = l.certs.filter((c) => c.devId !== devId); l.revoked = Array.from(new Set(l.revoked.concat([devId]))).slice(-64); l.seq++; l.signed = null; ls.set(K_LIST, l);
    return publish();
  }
  function companionData() {
    const d = DeviceLink.collectData(); for (const k of NOT_FOR_COMPANION) delete d[k]; return d;
  }
  // ---- новое устройство: применение пакета companion (вызывается до applyImportedData) ----
  function applyCompanion(data, device) {
    const ok = device && /^[0-9a-f]{16}$/.test(device.devId || "") && device.priv && device.priv.d && device.cert && device.cert.devId === device.devId && device.cert.id === data["ether.myId"];
    if (!ok) throw new Error("bad-package");
    const out = Object.assign({}, data);
    out["ether.privKey"] = JSON.stringify({ kty: "EC", crv: "P-256", x: device.priv.x, y: device.priv.y, d: device.priv.d, ext: true });
    out[K_SELF] = JSON.stringify({ devId: device.devId, cert: device.cert });
    out[K_PEERS] = "{}";
    return out;
  }
  // ---- списки устройств собеседников ----
  function rawCerts(id) {
    if (id === Store.myId && !isCompanion()) return listState().certs.filter(active);
    const e = peers()[id]; return e ? e.certs.filter(active) : [];
  }
  function peerCerts(id) { const me = self(); return rawCerts(id).filter((c) => !(me && id === Store.myId && c.devId === me.devId)); }
  const pubOf = (id) => (id === Store.myId ? Store.myPublicKeyJwk : (state.contacts.get(id) || {}).publicKey);
  // M5: параллельные refreshPeer одного id делят один запрос; запись K_PEERS — по свежему снимку (иначе чужие записи теряются)
  const peerInflight = new Map();
  function refreshPeer(id, force) {
    const k = String(id), cur = peerInflight.get(k); if (cur) return cur;
    const p = refreshPeerOnce(id, force).finally(() => { if (peerInflight.get(k) === p) peerInflight.delete(k); });
    peerInflight.set(k, p); return p;
  }
  async function refreshPeerOnce(id, force) {
    const pub = pubOf(id); const e = peers()[id] || { seq: 0, certs: [], known: null, at: 0 };
    if (!pub || (!force && Date.now() - e.at < PEER_TTL_MS)) return e;
    if (typeof signaling === "undefined" || !signaling || !signaling.registered || !hasFeature("devlist")) return e;
    const rid = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random());
    const list = await new Promise((res) => {
      const h = (ev) => { if (ev.detail.rid !== rid) return; clearTimeout(t); signaling.removeEventListener("devices-list", h); res(ev.detail.list); };
      const t = setTimeout(() => { signaling.removeEventListener("devices-list", h); res(undefined); }, 3000);
      signaling.addEventListener("devices-list", h); if (!signaling.getDevices(id, rid)) { clearTimeout(t); signaling.removeEventListener("devices-list", h); res(undefined); }
    });
    if (list === undefined) return e;
    e.at = Date.now(); const prevKnown = e.known;
    if (list) {
      const v = await DeviceCert.verifyList(pub, id, list, { minSeq: e.seq });
      if (v.ok) {
        e.seq = list.seq; e.certs = v.certs;
        const fresh = prevKnown ? v.certs.filter((c) => !prevKnown.includes(c.devId)) : [];
        e.known = Array.from(new Set((prevKnown || []).concat(v.certs.map((c) => c.devId))));
        if (fresh.length) await noteNewDevices(id, fresh).catch(() => {});
      }
    }
    if (!e.known) e.known = []; // первая успешная сверка: уже существующие устройства не считаются «новыми»
    const all = peers(); all[id] = e; ls.set(K_PEERS, all); return e;
  }
  async function noteNewDevices(id, fresh) {
    const c = state.contacts.get(id); if (!c || id === Store.myId) return;
    for (const cert of fresh) {
      let fp = ""; try { fp = await DeviceCert.fingerprint(cert); } catch (e) {}
      pushSystemNote(c, "devices.newDevice", { name: c.name || "", label: cert.label || "", fp });
    }
  }
  // ключ устройства-отправителя (fromDev) для расшифровки; null, если устройство не в проверенном списке
  async function deviceKeyFor(id, devId) {
    let c = rawCerts(id).find((x) => x.devId === devId);
    if (!c) { await refreshPeer(id, true); c = rawCerts(id).find((x) => x.devId === devId); }
    return c ? jwkPub(c.pub) : null;
  }
  // ---- шифрование копий ----
  async function staticEnv(payload, toPub, fromId, toId) {
    const key = await CryptoHelper.deriveSharedKey(Store.myPrivateKeyJwk, toPub);
    const env = await CryptoHelper.encryptJson(key, payload, CryptoHelper.envAad(fromId, toId)); env.e2 = 1; return env;
  }
  function ownTargets() {
    if (!isCompanion()) return listState().certs.filter(active).map((c) => ({ dev: c.devId, pub: jwkPub(c.pub) }));
    return [{ dev: "", pub: Store.myPublicKeyJwk }].concat(peerCerts(Store.myId).map((c) => ({ dev: c.devId, pub: jwkPub(c.pub) })));
  }
  // нужно ли гнать сообщение через сервер (копии устройствам), а не только по P2P
  function needsServer(contact) { return !!contact && !contact.isGroup && (isCompanion() || peerCerts(contact.id).length > 0 || listState().certs.some(active)); }
  async function copiesFor(contact, payload) {
    if (!payload || payload.kind !== "chat" || !hasFeature("devmail") || !contact.publicKey) return null;
    await refreshPeer(contact.id, false);
    const certs = peerCerts(contact.id).slice(0, 7); if (!certs.length) return null;
    return Promise.all(certs.map(async (c) => ({ dev: c.devId, envelope: await staticEnv(payload, jwkPub(c.pub), Store.myId, contact.id) })));
  }
  // ---- sync-op: зеркалирование любых действий между устройствами аккаунта ----
  // Конверт «от себя себе» (статический v2 с AAD ether-env-v2|я|я) вида {kind:"sync-op", opId, to, op}, где op — payload исходного kind.
  // Получатель применяет его к своему состоянию ТОЛЬКО локально (applySyncOp) и никуда не пересылает: анти-эхо по opId.
  const MIRROR_KINDS = new Set(["edit", "delete", "reaction", "file", "sticker", "poll", "board", "note", "poll-vote", "poll-close", "board-op", "note-op"]);
  const MIRROR_FILE_B64_MAX = 400_000, PART_B64 = 300_000, MAX_PARTS = 40; // вложение крупнее копируется заглушкой + докачка частями по запросу
  const K_OPS = "ether.dev.ops";
  const sentKeys = new Map(), partsIn = new Map();
  const rid = () => (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  function opSeen(opId) { const a = ls.get(K_OPS) || []; return a.includes(opId); }
  function opMark(opId) { const a = ls.get(K_OPS) || []; a.push(opId); ls.set(K_OPS, a.slice(-300)); }
  async function sendOp(op, to, onlyDev) {
    if (!hasFeature("devmail") || !hasFeature("devsync")) return false;
    let targets = ownTargets(); if (onlyDev !== undefined) targets = targets.filter((t) => t.dev === onlyDev);
    if (!targets.length) return false;
    const opId = "o" + rid(), inner = { kind: "sync-op", opId, to, op, ts: Date.now() };
    const copies = await Promise.all(targets.slice(0, 8).map(async (t) => ({ dev: t.dev, envelope: await staticEnv(inner, t.pub, Store.myId, Store.myId) })));
    return signaling.deliverMulti(Store.myId, "sop-" + opId, null, Store.myPublicKeyJwk, "sync-op", copies);
  }
  function dedupeKey(contact, p) {
    const k = [p.kind, p.groupId || contact.id, p.id || "", p.ts || "", p.emoji || "", p.remove ? 1 : 0, String(p.text || "").length, String(p.text || "").slice(0, 32), Array.isArray(p.opts) ? p.opts.join(",") : "", p.op ? JSON.stringify(p.op).slice(0, 120) : ""].join("|");
    const now = Date.now(); if (sentKeys.has(k) && now - sentKeys.get(k) < 60_000) return null;
    sentKeys.set(k, now); if (sentKeys.size > 500) sentKeys.delete(sentKeys.keys().next().value); return k;
  }
  // Исходящее на другие устройства аккаунта. chat идёт прежним sync-sent (совместимо со старыми клиентами), остальное — sync-op.
  async function syncSent(contact, payload) {
    if (!payload || typeof payload !== "object" || !hasFeature("devmail")) return false;
    const kind = payload.kind;
    if (kind !== "chat" && !MIRROR_KINDS.has(kind)) return false;
    if (!ownTargets().length || !dedupeKey(contact, payload)) return false;
    if (kind === "chat") {
      const inner = Object.assign({}, payload, { syncTo: contact.id });
      const copies = await Promise.all(ownTargets().slice(0, 8).map(async (t) => ({ dev: t.dev, envelope: await staticEnv(inner, t.pub, Store.myId, Store.myId) })));
      return signaling.deliverMulti(Store.myId, "sync-" + payload.id, null, Store.myPublicKeyJwk, "sync-sent", copies);
    }
    let op = payload;
    if (kind === "file" && typeof payload.dataB64 === "string" && payload.dataB64.length > MIRROR_FILE_B64_MAX) { const { dataB64, ...rest } = payload; op = rest; }
    return sendOp(Object.assign({}, op), contact.isGroup ? contact.id : contact.id);
  }
  // «Прочитано» на этом устройстве: на других устройствах аккаунта те же входящие тоже становятся прочитанными (без повторной отправки квитанций)
  function syncRead(c, msgs) {
    if (!c || !msgs || !msgs.length || !ownTargets().length) return false;
    const ids = msgs.map((m) => m.id).filter((x) => typeof x === "string").slice(0, 200); if (!ids.length) return false;
    sendOp({ kind: "read", ids }, c.id).catch(() => {}); return true;
  }
  // Квитанция собеседника (доставлено/прочитано) на моё сообщение пришла на это устройство: остальные устройства тоже её видят
  function syncAckIn(contactId, ackState, ids) {
    if ((ackState !== "delivered" && ackState !== "read") || !Array.isArray(ids) || !ids.length || !ownTargets().length) return false;
    sendOp({ kind: "ack-in", from: contactId, state: ackState, ids: ids.filter((x) => typeof x === "string").slice(0, 200) }, contactId).catch(() => {}); return true;
  }
  function targetContact(p, op) {
    const gid = typeof op.groupId === "string" && op.groupId ? op.groupId : "";
    if (gid) { const g = state.contacts.get(gid); return g && g.isGroup ? g : null; }
    if (typeof p.to !== "string" || !p.to || p.to.length > 128 || p.to === Store.myId) return null;
    return state.contacts.get(p.to) || ensureContactEntry(p.to, null);
  }
  function refresh(c) { if (state.chatId === c.id) renderChatThread(); if (state.tab === "chats") renderChatsList(); }
  function addMine(c, rec, op) {
    if (c.messages.some((m) => m.id === rec.id)) return false;
    if (safeTtl(op.ttl)) rec.ttl = safeTtl(op.ttl);
    c.messages.push(rec); trimMessages(c); c.lastActivity = Math.max(c.lastActivity || 0, rec.ts); persistContacts(); refresh(c); return true;
  }
  const mineRec = (op, extra) => Object.assign({ id: op.id, from: "me", text: "", ts: Number.isFinite(op.ts) ? op.ts : Date.now(), ack: "sent", serverAcked: true, mirrored: true }, extra);
  async function applySyncOp(p) {
    if (!p || p.kind !== "sync-op" || typeof p.opId !== "string" || !p.op || typeof p.op !== "object" || opSeen(p.opId)) return false;
    opMark(p.opId);
    const op = p.op, k = op.kind;
    if (k === "cert-renew") return applyCertRenew(op);
    if (k === "cert-want") return handleCertWant(op);
    const c = targetContact(p, op); if (!c) return false;
    const mine = (m) => m && m.from === "me";
    const find = (id) => c.messages.find((m) => m.id === id);
    let changed = false;
    if (k === "edit") { const m = find(op.id); if (mine(m) && typeof op.text === "string") { m.text = op.text.slice(0, 20000); m.edited = true; changed = true; } }
    else if (k === "delete") { const n = c.messages.length; c.messages = c.messages.filter((m) => !(m.id === op.id && mine(m))); changed = c.messages.length !== n; }
    else if (k === "reaction") {
      const m = find(op.id), e = op.emoji;
      if (m && typeof e === "string" && e && e.length <= 16 && !/^(__proto__|constructor|prototype)$/.test(e)) {
        if (!m.reactions || typeof m.reactions !== "object") m.reactions = {};
        const arr = Array.isArray(m.reactions[e]) ? m.reactions[e] : (m.reactions[e] = []), i = arr.indexOf(Store.myId);
        if (op.remove) { if (i >= 0) arr.splice(i, 1); if (!arr.length) delete m.reactions[e]; } else if (i < 0) arr.push(Store.myId);
        changed = true;
      }
    }
    else if (k === "read") {
      const ids = new Set((Array.isArray(op.ids) ? op.ids : []).filter((x) => typeof x === "string").slice(0, 200));
      for (const m of c.messages) if (m.from === "them" && !m.readAckSent && ids.has(m.id)) { m.readAckSent = true; if (typeof startExpiryOnRead === "function") startExpiryOnRead(m); changed = true; }
      if (changed) { state.mentionedChats.delete(c.id); if (typeof updateAppBadge === "function") updateAppBadge(); }
    }
    else if (k === "ack-in") {
      if ((op.state === "delivered" || op.state === "read") && Array.isArray(op.ids)) for (const id of op.ids.filter((x) => typeof x === "string").slice(0, 200)) markMessageAck(c.id, id, op.state);
      return true;
    }
    else if (k === "file") {
      if (!EtherFileLimits.isValidFileMetaSize(op.size)) return false;
      const rec = mineRec(op, { file: { name: String(op.name || "file").slice(0, 120), mime: String(op.mime || "application/octet-stream").slice(0, 100), size: op.size, kind: fileKindFromMime(op.mime), duration: safeDuration(op.duration), wave: sanitizeWave(op.wave), pending: false } });
      if (typeof op.caption === "string" && op.caption) rec.file.caption = op.caption.slice(0, 200);
      if (typeof op.dataB64 === "string" && op.dataB64) {
        try { await IDB.set("file:" + op.id, new Blob([base64ToUint8Array(op.dataB64)], { type: rec.file.mime })); } catch (e) { return false; }
      } else rec.file.remote = true; // файл остался на другом устройстве: заглушка и кнопка «Запросить»
      return addMine(c, rec, op);
    }
    else if (k === "sticker") {
      if (!window.EtherStickers || !EtherStickers.validateIncoming) return false;
      const v = EtherStickers.validateIncoming(op); if (!v.ok) return false;
      if (v.bytes) { try { await IDB.set("file:" + op.id, new Blob([v.bytes], { type: v.sticker.mime })); } catch (e) { return false; } }
      return addMine(c, mineRec(op, { text: "🖼 " + T("sticker.label"), sticker: v.sticker }), op);
    }
    else if (k === "poll") { const poll = EtherRich.sanitizePoll(op.poll); return !!poll && addMine(c, mineRec(op, { text: poll.q, poll, pollVotes: {} }), op); }
    else if (k === "board") { const board = EtherRich.sanitizeBoard(op.board); return !!board && addMine(c, mineRec(op, { text: board.title, board }), op); }
    else if (k === "note") {
      const note = EtherRich.sanitizeNote(op.note); if (!note) return false;
      const rec = mineRec(op, { text: note.title, note }); if (op.note && op.note.text) EtherRich.applyNoteOp(rec, { t: "set", text: op.note.text }, rec.ts);
      return addMine(c, rec, op);
    }
    else if (k === "poll-vote") { const m = find(op.id); changed = !!m && m.poll && !EtherRich.isClosed(m) && EtherRich.applyVote(m, Store.myId, op.opts, Math.max(clampOpTs(op.ts, Date.now()), m.ts || 0)); }
    else if (k === "poll-close") { const m = find(op.id); changed = !!m && mine(m) && EtherRich.closePoll(m); }
    else if (k === "note-op") { const m = find(op.id); changed = !!m && !!op.op && EtherRich.applyNoteOp(m, op.op, clampOpTs(op.ts, Date.now())); }
    else if (k === "board-op") { const m = find(op.id); changed = !!m && EtherRich.applyBoardOp(m, op.op, clampOpTs(op.ts, Date.now())); }
    else if (k === "file-req") return answerFileReq(c, op);
    else if (k === "file-part") return takeFilePart(c, op);
    if (changed) { persistContacts(); refresh(c); }
    return !!changed;
  }
  // ---- вложение по запросу: заглушка «файл на другом устройстве», докачка частями через ящик устройства ----
  async function answerFileReq(c, op) {
    if (typeof op.id !== "string" || typeof op.reqDev !== "string") return false;
    const m = c.messages.find((x) => x.id === op.id && x.file && !x.file.remote); if (!m) return false;
    let blob = null; try { blob = await IDB.get("file:" + m.id); } catch (e) {}
    if (!blob) return false;
    const b64 = arrayBufferToBase64(await blob.arrayBuffer()), n = Math.ceil(b64.length / PART_B64); if (n > MAX_PARTS) return false;
    for (let i = 0; i < n; i++) await sendOp({ kind: "file-part", id: m.id, i, n, d: b64.slice(i * PART_B64, (i + 1) * PART_B64), mime: m.file.mime, groupId: c.isGroup ? c.id : undefined }, c.id, op.reqDev);
    return true;
  }
  async function takeFilePart(c, op) {
    const m = c.messages.find((x) => x.id === op.id && x.file && x.file.remote);
    if (!m || !Number.isInteger(op.i) || !Number.isInteger(op.n) || op.n < 1 || op.n > MAX_PARTS || op.i < 0 || op.i >= op.n || typeof op.d !== "string" || op.d.length > PART_B64) return false;
    let e = partsIn.get(m.id); if (!e || e.n !== op.n) { e = { n: op.n, got: new Map() }; partsIn.set(m.id, e); if (partsIn.size > 20) partsIn.delete(partsIn.keys().next().value); }
    e.got.set(op.i, op.d); if (e.got.size < e.n) return true;
    partsIn.delete(m.id);
    const b64 = Array.from({ length: e.n }, (_, i) => e.got.get(i)).join("");
    try { await IDB.set("file:" + m.id, new Blob([base64ToUint8Array(b64)], { type: m.file.mime })); } catch (er) { return false; }
    delete m.file.remote; delete m.file.requested; persistContacts(); refresh(c); return true;
  }
  function requestFile(contactId, msgId) {
    const c = state.contacts.get(contactId); const m = c && c.messages.find((x) => x.id === msgId); if (!m || !m.file) return false;
    m.file.requested = Date.now(); persistContacts();
    sendOp({ kind: "file-req", id: msgId, reqDev: (self() || {}).devId || "", groupId: c.isGroup ? c.id : undefined }, c.id).catch(() => {}); return true;
  }
  // Заглушка вместо недоступного файла (вызывается из hydrateFileSlots): true, если сообщение — зеркальная запись без вложения
  function stubFile(el, msgId) {
    let c = null, m = null;
    for (const x of state.contacts.values()) { const f = x.messages && x.messages.find((y) => y.id === msgId && y.file && y.file.remote); if (f) { c = x; m = f; break; } }
    if (!m) return false;
    const holder = el.querySelector(".file-media-loading") || el.querySelector(".voice-duration") || el;
    holder.textContent = T("devices.fileElsewhere");
    if (!el.querySelector(".dev-file-req")) {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn-tertiary dev-file-req";
      b.textContent = T(m.file.requested && Date.now() - m.file.requested < 120_000 ? "devices.fileRequested" : "devices.fileRequest");
      b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); requestFile(c.id, msgId); b.textContent = T("devices.fileRequested"); b.disabled = true; });
      el.appendChild(b);
    }
    return true;
  }
  function applySyncSent(p) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || typeof p.text !== "string") return false;
    const c = targetContact({ to: p.syncTo }, { groupId: p.groupId }); if (!c || c.messages.some((m) => m.id === p.id)) return false;
    const ts = Number.isFinite(p.ts) ? p.ts : Date.now();
    const rec = { id: p.id, from: "me", text: p.text.slice(0, 20000), ts, ack: "sent", serverAcked: true, mirrored: true };
    if (p.replyTo && typeof p.replyTo === "object" && typeof p.replyTo.id === "string") rec.replyTo = { id: p.replyTo.id.slice(0, 64), text: String(p.replyTo.text || "").slice(0, 200), authorName: String(p.replyTo.authorName || "").slice(0, 40) };
    if (p.forwarded) rec.forwarded = true;
    return addMine(c, rec, p);
  }
  // ---- продление сертификатов companion ----
  const RENEW_BEFORE_MS = 30 * 86400_000;
  async function sendCert(nc) { return sendOp({ kind: "cert-renew", cert: nc }, Store.myId, nc.devId); }
  // Основное: за 30 дней до конца перевыпускает сертификат companion (тот же devId и ключ), публикует новый список и отправляет сертификат устройству
  // M6: один проход за раз (иначе два параллельных выдают два списка с одним seq)
  let renewInflight = null;
  function renewDue() {
    if (renewInflight) return renewInflight;
    const p = renewDueOnce().finally(() => { if (renewInflight === p) renewInflight = null; });
    return (renewInflight = p);
  }
  async function renewDueOnce() {
    if (isCompanion() || !Store.myPrivateKeyJwk || !Store.myId) return 0;
    const l = listState(), now = Date.now(), renewed = [];
    for (let i = 0; i < l.certs.length; i++) {
      const c = l.certs[i]; if (!active(c) || c.expires - now > RENEW_BEFORE_MS) continue;
      const nc = await DeviceCert.issue(Store.myPrivateKeyJwk, { id: Store.myId, devId: c.devId, pub: c.pub, label: c.label });
      l.certs[i] = nc; renewed.push(nc);
    }
    if (!renewed.length) return 0;
    l.seq++; l.signed = null; ls.set(K_LIST, l);
    await publish();
    for (const nc of renewed) await sendCert(nc).catch(() => {});
    return renewed.length;
  }
  // Companion применяет присланный сертификат: подпись личности, тот же devId и ключ устройства, срок строго дальше текущего
  async function applyCertRenew(op) {
    const me = self(), c = op.cert; if (!me || !c || c.devId !== me.devId || c.id !== Store.myId || !c.pub || c.pub.x !== me.cert.pub.x || c.pub.y !== me.cert.pub.y || !(c.expires > me.cert.expires)) return false;
    if (!(await DeviceCert.verifyCert(Store.myPublicKeyJwk, c))) return false;
    ls.set(K_SELF, { devId: me.devId, cert: c }); return true;
  }
  // Основное отвечает на «хочу новый сертификат», если в его списке срок у устройства дальше
  async function handleCertWant(op) {
    if (isCompanion() || typeof op.devId !== "string") return false;
    const c = listState().certs.find((x) => x.devId === op.devId && active(x)); if (!c) return false;
    if (c.expires > (Number(op.expires) || 0)) { await sendCert(c); return true; }
    return (await renewDue()) > 0;
  }
  // Companion: срок подходит к концу — просим основное прислать новый сертификат (не чаще раза в сутки)
  function wantCert() {
    const me = self(); if (!me || me.cert.expires - Date.now() > RENEW_BEFORE_MS) return false;
    const last = ls.get("ether.dev.wantAt") || 0; if (Date.now() - last < 86400_000) return false;
    ls.set("ether.dev.wantAt", Date.now());
    sendOp({ kind: "cert-want", devId: me.devId, expires: me.cert.expires }, Store.myId, "").catch(() => {}); return true;
  }
  // ---- подключение к сигналингу ----
  async function deviceSign(nonce, id, devId) { return DeviceCert.signText(Store.myPrivateKeyJwk, "ether-devauth-v1|" + nonce + "|" + id + "|" + devId); }
  function wireSignaling(sig) {
    const me = self();
    // M7: отзыв запоминается и читается: отозванное устройство больше не подключается к сигналингу после перезапуска
    if (me && ls.get(K_REVOKED)) { sig.start = () => {}; try { sig.stop(); } catch (e) {} toast(T("devices.revokedSelf")); }
    if (me) {
      sig.deviceId = me.devId; sig.deviceSign = deviceSign;
      sig.addEventListener("device-revoked", () => { ls.set(K_REVOKED, 1); try { sig.stop(); } catch (e) {} toast(T("devices.revokedSelf")); });
    }
    sig.addEventListener("online-list", () => {
      if (isCompanion()) { refreshPeer(Store.myId, true).catch(() => {}); wantCert(); } else publish().then(() => renewDue()).catch(() => {}); // сервер хранит список на диске, но публикуем при каждом подключении (запасной путь)
    });
    // Сервер сообщил, что у контакта (или у меня) изменился список устройств: сбрасываем кэш и перезапрашиваем сразу, 10-минутный кэш остаётся запасным
    sig.addEventListener("devices-updated", (ev) => {
      const id = ev.detail && ev.detail.id; if (typeof id !== "string") return;
      const all = peers(), e = all[id];
      if (e && Number.isSafeInteger(ev.detail.seq) && ev.detail.seq <= e.seq) return;
      if (e) { e.at = 0; ls.set(K_PEERS, all); }
      refreshPeer(id, true).catch(() => {});
    });
    if (!isCompanion() && typeof setInterval === "function" && !wireSignaling._t) wireSignaling._t = setInterval(() => { renewDue().catch(() => {}); }, 6 * 3600_000);
  }
  // ---- интерфейс ----
  function openList() {
    const U = DeviceLinkUI, tr = U.tr, sh = U.sheet(tr("devices.title")), body = [];
    const row = (label, sub, extra) => { const r = U.el("div", "settings-row column"); r.append(U.el("strong", "", label)); if (sub) r.append(U.el("span", "fine muted", sub)); if (extra) r.append(extra); return r; };
    if (isCompanion()) {
      body.push(U.el("p", "fine", tr("devices.companionInfo")));
      body.push(U.el("p", "fine muted", tr("devices.validUntil", { date: new Date(self().cert.expires).toLocaleDateString() }) + " " + tr("devices.autoRenew")));
      body.push(U.el("p", "fine muted", tr("devices.backupCopy")));
      body.push(U.btn("btn-secondary", tr("devices.unlink"), async () => { if (await confirmSheet(tr("devices.unlinkConfirm"), { destructive: true })) wipeEverythingAndReload(); }));
    } else {
      body.push(row(tr("devices.thisPhone"), tr("devices.primary")));
      const certs = listState().certs.filter(active);
      const list = U.el("div", "");
      body.push(list);
      if (!certs.length) body.push(U.el("p", "fine muted", tr("devices.none")));
      certs.forEach(async (c) => {
        const fp = await DeviceCert.fingerprint(c).catch(() => "");
        const rv = U.btn("btn-tertiary", tr("devices.revoke"), async () => { if (await confirmSheet(tr("devices.revokeConfirm", { label: c.label }), { destructive: true })) { await revoke(c.devId); sh.close(); openList(); } });
        list.append(row(c.label || tr("devices.companionLabel"), tr("devices.added", { date: new Date(c.created).toLocaleDateString(), fp }) + " " + tr("devices.validUntil", { date: new Date(c.expires).toLocaleDateString() }), rv));
      });
      body.push(U.btn("btn-primary", tr("devices.add"), () => { sh.close(); DeviceLinkUI.openSend({ companion: true }); }));
      if (!hasFeature("devmail")) body.push(U.el("p", "fine muted", tr("devices.err.unsupported")));
    }
    body.push(U.btn("btn-tertiary", tr("devlink.close"), () => sh.close()));
    U.setBody(sh, ...body);
  }
  function wire() {
    const b = document.getElementById("settings-devices-btn");
    if (b && !b.dataset.dvWired) { b.dataset.dvWired = "1"; b.addEventListener("click", openList); }
  }
  if (typeof document !== "undefined") { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire(); }
  return { renewDue, wantCert, syncRead, syncAckIn, applySyncOp, requestFile, stubFile, sendOp, isCompanion, self, listState, peers, issuePairing, revoke, publish, companionData, applyCompanion, refreshPeer, deviceKeyFor, staticEnv, needsServer, copiesFor, syncSent, applySyncSent, wireSignaling, deviceSign, openList, peerCerts, noteNewDevices, ownTargets };
})();
