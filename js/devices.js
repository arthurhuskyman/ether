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
    "ether.dev.list", "ether.dev.peers", "ether.dev.self", "ether.dev.revoked", "ether.pinHash", "ether.pinSalt", "ether.pinEnabled", "ether.groupDeliveryMap"];
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
  async function refreshPeer(id, force) {
    const pub = pubOf(id); const all = peers(); const e = all[id] || { seq: 0, certs: [], known: null, at: 0 };
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
    all[id] = e; ls.set(K_PEERS, all); return e;
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
  async function syncSent(contact, payload) {
    if (!payload || payload.kind !== "chat" || !hasFeature("devmail")) return false;
    const targets = ownTargets(); if (!targets.length) return false;
    const inner = Object.assign({}, payload, { syncTo: contact.id });
    const copies = await Promise.all(targets.slice(0, 8).map(async (t) => ({ dev: t.dev, envelope: await staticEnv(inner, t.pub, Store.myId, Store.myId) })));
    return signaling.deliverMulti(Store.myId, "sync-" + payload.id, null, Store.myPublicKeyJwk, "sync-sent", copies);
  }
  function applySyncSent(p) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || typeof p.text !== "string") return false;
    const c = state.contacts.get(typeof p.groupId === "string" && p.groupId ? p.groupId : p.syncTo); if (!c || c.messages.some((m) => m.id === p.id)) return false;
    const ts = Number.isFinite(p.ts) ? p.ts : Date.now();
    c.messages.push({ id: p.id, from: "me", text: p.text.slice(0, 20000), ts, ack: "sent", serverAcked: true, mirrored: true });
    trimMessages(c); c.lastActivity = Math.max(c.lastActivity || 0, ts); persistContacts();
    if (state.chatId === c.id) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    return true;
  }
  // ---- подключение к сигналингу ----
  async function deviceSign(nonce, id, devId) { return DeviceCert.signText(Store.myPrivateKeyJwk, "ether-devauth-v1|" + nonce + "|" + id + "|" + devId); }
  function wireSignaling(sig) {
    const me = self();
    if (me) {
      sig.deviceId = me.devId; sig.deviceSign = deviceSign;
      sig.addEventListener("device-revoked", () => { ls.set(K_REVOKED, 1); try { sig.stop(); } catch (e) {} toast(T("devices.revokedSelf")); });
    }
    sig.addEventListener("online-list", () => {
      if (isCompanion()) refreshPeer(Store.myId, true).catch(() => {}); else publish().catch(() => {}); // сервер хранит список в памяти: после рестарта публикуем снова
    });
  }
  // ---- интерфейс ----
  function openList() {
    const U = DeviceLinkUI, tr = U.tr, sh = U.sheet(tr("devices.title")), body = [];
    const row = (label, sub, extra) => { const r = U.el("div", "settings-row column"); r.append(U.el("strong", "", label)); if (sub) r.append(U.el("span", "fine muted", sub)); if (extra) r.append(extra); return r; };
    if (isCompanion()) {
      body.push(U.el("p", "fine", tr("devices.companionInfo")));
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
        list.append(row(c.label || tr("devices.companionLabel"), tr("devices.added", { date: new Date(c.created).toLocaleDateString(), fp }), rv));
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
  return { isCompanion, self, listState, peers, issuePairing, revoke, publish, companionData, applyCompanion, refreshPeer, deviceKeyFor, staticEnv, needsServer, copiesFor, syncSent, applySyncSent, wireSignaling, deviceSign, openList, peerCerts, noteNewDevices, ownTargets };
})();
