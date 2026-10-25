"use strict";
// ether-sdk: клиент протокола v1 (docs/PROTOCOL-V1.md) для ботов и мостов на Node ≥ 22 без зависимостей.
// Криптография НЕ переписана: Double Ratchet / X3DH / ML-KEM / env2 берутся из js/ratchet.js и js/crypto-helper.js (см. core.cjs).
const fs = require("fs");
const nodeCrypto = require("crypto");
const { instance, CryptoHelper } = require("./core.cjs");

const PROTOCOL = { version: 1, caps: ["env2", "sk1"], pingMs: 15000 };
const hex = (u8) => Buffer.from(u8).toString("hex");
const rid = (n = 8) => nodeCrypto.randomBytes(n).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

// Доказательство владения id (sha256 от секрета устройства; сам секрет на сервер не уходит) — как в js/app/10-signaling.js
function claimProof(token) { return nodeCrypto.createHash("sha256").update("ether-claim-v1|" + token).digest("hex"); }

async function generateIdentity(opts = {}) {
  const k = await CryptoHelper.generateKeyPair();
  return { id: opts.id || "bot-" + nodeCrypto.randomBytes(15).toString("base64url"), name: String(opts.name || "Bot").slice(0, 60), claimToken: nodeCrypto.randomBytes(24).toString("base64url"), publicKeyJwk: k.publicKeyJwk, privateKeyJwk: k.privateKeyJwk };
}
function identityFromJSON(j) {
  const o = typeof j === "string" ? JSON.parse(j) : j;
  if (!o || typeof o.id !== "string" || !o.id || o.id.length > 128 || o.id.includes("#") || !o.privateKeyJwk || !o.publicKeyJwk) throw new Error("ether-sdk: bad identity");
  return o;
}

class Client {
  // opts: { url, identity, statePath?, WebSocket?, reconnect=true, visible=true, trust="pin"|"update", pad=true, log? }
  constructor(opts) {
    if (!opts || !opts.url || !opts.identity) throw new Error("ether-sdk: url and identity are required");
    this.opts = Object.assign({ reconnect: true, visible: true, trust: "pin" }, opts);
    this.identity = identityFromJSON(opts.identity);
    this.url = opts.url;
    this._h = new Map();
    this._pending = new Map(); // ключ -> {resolve, reject, timer}
    this._seen = new Set();
    this.features = []; this.registered = false; this.ws = null; this._closed = false; this._pingTimer = null; this._retry = 1000;
    this.R = instance("ratchet.js");
    this.Ch = instance("channels.js");
    const fresh = this._loadState();
    this._state = fresh; // { ratchet, peers: {id: publicKeyJwk}, channels: {id: {...}} }
    this.R.setStore({ load: () => this._state.ratchet, save: (o) => { this._state.ratchet = o; return this._saveState(); } });
    this.peers = this._state.peers;
  }

  // ---------- события ----------
  on(ev, fn) { (this._h.get(ev) || this._h.set(ev, []).get(ev)).push(fn); return this; }
  off(ev, fn) { this._h.set(ev, (this._h.get(ev) || []).filter((f) => f !== fn)); return this; }
  once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
  _emit(ev, ...a) { for (const f of (this._h.get(ev) || []).slice()) { try { const r = f(...a); if (r && r.catch) r.catch((e) => this._emit("error", e)); } catch (e) { if (ev !== "error") this._emit("error", e); } } }
  _log(...a) { if (this.opts.log) this.opts.log("[ether-sdk]", ...a); }

  // ---------- состояние (ratchet, закреплённые ключи контактов) ----------
  _loadState() {
    let s = null;
    if (this.opts.statePath) { try { s = JSON.parse(fs.readFileSync(this.opts.statePath, "utf8")); } catch (e) { s = null; } }
    s = s && typeof s === "object" ? s : {};
    return { ratchet: s.ratchet && typeof s.ratchet === "object" ? s.ratchet : {}, peers: s.peers && typeof s.peers === "object" ? s.peers : {}, channels: s.channels && typeof s.channels === "object" ? s.channels : {} };
  }
  _saveState() {
    if (!this.opts.statePath) return true;
    try { const tmp = this.opts.statePath + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(this._state), { mode: 0o600 }); fs.renameSync(tmp, this.opts.statePath); return true; } catch (e) { return false; }
  }

  // ---------- соединение ----------
  async connect() {
    this._closed = false;
    const ready = new Promise((res) => this.once("ready", res));
    await this._open();
    await ready;
    return this;
  }
  _open() {
    return new Promise((resolve, reject) => {
      const WS = this.opts.WebSocket || globalThis.WebSocket;
      if (!WS) return reject(new Error("ether-sdk: no WebSocket (Node >= 22 or opts.WebSocket)"));
      const ws = new WS(this.url);
      this.ws = ws; let done = false;
      const fail = (e) => { if (!done) { done = true; reject(e); } };
      ws.addEventListener("open", () => {
        this._send({ type: "register", id: this.identity.id, name: this.identity.name, visible: this.opts.visible !== false, publicKey: this.identity.publicKeyJwk,
          claim: this.identity.claimToken ? claimProof(this.identity.claimToken) : undefined, caps: PROTOCOL.caps, watch: this.opts.watch });
      });
      ws.addEventListener("message", (ev) => {
        let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch (e) { return; }
        if (!m || typeof m.type !== "string") return;
        if (m.type === "registered" && !done) { done = true; resolve(); }
        if ((m.type === "register-error" || m.type === "register-rate-limited") && !done) fail(new Error("ether-sdk: " + (m.error || m.type)));
        this._onMessage(m).catch((e) => this._emit("error", e));
      });
      ws.addEventListener("error", () => fail(new Error("ether-sdk: websocket error")));
      ws.addEventListener("close", () => {
        this.registered = false; clearInterval(this._pingTimer);
        for (const [k, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error("ether-sdk: connection closed")); this._pending.delete(k); }
        fail(new Error("ether-sdk: closed before registration"));
        this._emit("close");
        if (!this._closed && this.opts.reconnect && this.ws === ws) this._reconnect();
      });
    });
  }
  async _reconnect() {
    await sleep(this._retry); this._retry = Math.min(this._retry * 2, 30000);
    if (this._closed) return;
    try { await this._open(); this._retry = 1000; } catch (e) { this._emit("error", e); if (!this._closed) this._reconnect(); }
  }
  close() { this._closed = true; clearInterval(this._pingTimer); try { this.ws && this.ws.close(); } catch (e) {} this._saveState(); }
  _send(o) { if (!this.ws || this.ws.readyState !== 1) return false; this.ws.send(JSON.stringify(o)); return true; }
  _wait(key, ms = 10000) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { this._pending.delete(key); reject(new Error("ether-sdk: timeout " + key)); }, ms); if (timer.unref) timer.unref(); this._pending.set(key, { resolve, reject, timer }); }); }
  _settle(key, v, err) { const p = this._pending.get(key); if (!p) return false; clearTimeout(p.timer); this._pending.delete(key); err ? p.reject(err) : p.resolve(v); return true; }

  // ---------- ключи контактов (TOFU: первый увиденный ключ закрепляется) ----------
  addPeer(id, publicKeyJwk) { return this._learn(id, publicKeyJwk, true); }
  _learn(id, jwk, force) {
    if (!id || !jwk || typeof jwk !== "object" || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return false;
    const pub = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true };
    const cur = this.peers[id];
    if (cur && (cur.x !== pub.x || cur.y !== pub.y)) {
      if (!force && this.opts.trust !== "update") { this._emit("key-changed", { id, old: cur, new: pub }); return false; }
      this.R.resetTrust(id); // осознанная смена ключа: старые сессии и липкие уровни этого контакта забываем
    }
    if (!cur || force || cur.x !== pub.x) { this.peers[id] = pub; this._saveState(); if (!cur) this._emit("peer", { id, publicKey: pub }); }
    return true;
  }

  // ---------- входящие ----------
  async _onMessage(m) {
    switch (m.type) {
      case "registered": {
        this.registered = true; this.features = Array.isArray(m.features) ? m.features : []; this.prekeyCount = m.prekeyCount | 0;
        for (const u of m.online || []) if (u && u.publicKey) this._learn(u.id, u.publicKey);
        clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => this._send({ type: "ping", t: Date.now() }), PROTOCOL.pingMs); if (this._pingTimer.unref) this._pingTimer.unref();
        await this._ensurePrekeys(this.prekeyCount);
        this._emit("ready", { id: this.identity.id, features: this.features });
        return;
      }
      case "presence": if (m.online && m.publicKey) this._learn(m.id, m.publicKey); this._emit("presence", m); return;
      case "prekey-bundle": this._settle("pb:" + m.rid, m); return;
      case "prekey-stored": this._settle("pks", m, m.error ? new Error("ether-sdk: prekey-stored " + m.error) : null); return;
      case "prekey-low": this._ensurePrekeys(m.count | 0).catch((e) => this._emit("error", e)); return;
      case "deliver-ack": this._settle("ack:" + m.msgId, m, m.error ? new Error("ether-sdk: deliver " + m.error) : null); return;
      case "deliver": if (m.gid || m.kind === "gchat") { this._emit("raw", m); return; } await this._onDeliver(m); return;
      case "channel-post": await this._onChannelPost(m); return;
      case "channel-created": case "channel-post-ack": case "channel-info": case "channel-deleted":
        this._settle("ch:" + m.type.replace(/-ack$/, "") + ":" + m.ch + (m.id ? ":" + m.id : ""), m, m.error ? new Error("ether-sdk: " + m.type + " " + m.error) : null); this._emit("raw", m); return;
      default: this._emit("raw", m);
    }
  }
  async _onDeliver(m) {
    const from = m.from;
    if (typeof from !== "string" || !m.envelope || typeof m.msgId !== "string") return;
    const dupKey = from + "|" + m.msgId;
    if (this._seen.has(dupKey)) { this._send({ type: "mailbox-ack", msgId: m.msgId }); return; }
    if (m.fromPublicKey) this._learn(from, m.fromPublicKey);
    const theirPub = this.peers[from];
    if (!theirPub) { this._emit("decrypt-error", { from, msgId: m.msgId, reason: "unknown-peer" }); return; } // ключа нет: сообщение остаётся в ящике сервера
    let payload;
    try {
      if (m.envelope.h) payload = await this.R.decrypt({ contactId: from, myId: this.identity.id, myPrivJwk: this.identity.privateKeyJwk, theirPubJwk: theirPub }, m.envelope);
      else { // конверты v1/env2 (статический ECDH) — только приём, отправляем всегда Double Ratchet
        const key = await CryptoHelper.deriveSharedKey(this.identity.privateKeyJwk, theirPub);
        payload = await CryptoHelper.decryptJson(key, m.envelope, m.envelope.v === 2 ? CryptoHelper.envAad(from, this.identity.id) : undefined);
      }
    } catch (e) {
      this._emit("decrypt-error", { from, msgId: m.msgId, reason: String(e && e.message || e) });
      this._send({ type: "mailbox-ack", msgId: m.msgId }); // недешифруемое не копим (повтор не поможет: ключ сообщения уже потрачен или конверт испорчен)
      return;
    }
    this._seen.add(dupKey); if (this._seen.size > 2000) this._seen.delete(this._seen.values().next().value);
    this._send({ type: "mailbox-ack", msgId: m.msgId });
    this._emit("message", { from, msgId: m.msgId, kind: m.kind, payload, text: payload && payload.kind === "chat" && typeof payload.text === "string" ? payload.text : undefined, queued: m.queued !== false && m.queued });
  }

  // ---------- prekeys ----------
  async _ensurePrekeys(serverCount) {
    if (!this.features.includes("prekeys") || !this.R.needsPrekeys(serverCount)) return;
    const up = await this.R.prekeyUploadPayload(20, this.identity.privateKeyJwk);
    const w = this._wait("pks"); if (!this._send({ type: "prekey-upload", spk: up.spk, opks: up.opks })) return;
    await w.catch((e) => this._emit("error", e));
  }
  async _fetchBundle(to) {
    const r = rid(8), w = this._wait("pb:" + r, 5000);
    this._send({ type: "prekey-fetch", to, rid: r });
    try { const m = await w; return m && m.spk ? { spk: m.spk, opk: m.opk || null } : null; } catch (e) { return null; }
  }

  // ---------- отправка ----------
  // payload: объект приложения ({kind:"chat", id, text, ts} и т.п.) или строка (станет chat). Возвращает msgId после deliver-ack сервера.
  async send(to, payload, opts = {}) {
    if (!this.registered) throw new Error("ether-sdk: not connected");
    if (typeof to !== "string" || !to || to.includes("#")) throw new Error("ether-sdk: bad recipient");
    const theirPub = this.peers[to]; if (!theirPub) throw new Error("ether-sdk: unknown peer key for " + to + " (addPeer or wait for their first message)");
    const msgId = opts.msgId || rid(12);
    const body = typeof payload === "string" ? { kind: "chat", id: msgId, text: payload, ts: Date.now() } : payload;
    const envelope = await this.R.encrypt({ contactId: to, myId: this.identity.id, myPrivJwk: this.identity.privateKeyJwk, theirPubJwk: theirPub, getBundle: () => this._fetchBundle(to), v3Ok: this.features.includes("pq1") }, body);
    const w = this._wait("ack:" + msgId);
    if (!this._send({ type: "deliver", to, msgId, envelope, fromPublicKey: this.identity.publicKeyJwk, kind: typeof body.kind === "string" && /^[a-z0-9-]{1,24}$/i.test(body.kind) ? body.kind : "chat" })) { this._settle("ack:" + msgId, null, new Error("ether-sdk: not connected")); }
    await w;
    return msgId;
  }
  sendText(to, text) { return this.send(to, String(text)); }

  // Ссылка «добавить контакт» для приложения: <origin>/#add=<id>&name=<имя> (ключ приложение получит из присутствия)
  contactLink(appUrl) { return String(appUrl).replace(/[#?].*$/, "").replace(/\/?$/, "/") + "#add=" + encodeURIComponent(this.identity.id) + "&name=" + encodeURIComponent(this.identity.name); }

  // ---------- каналы (рассылка с подписью владельца, docs/CHANNELS-GROUPS.md) ----------
  async createChannel({ name, desc = "", enc = false }) {
    const c = await this.Ch.generate({ name, desc, enc });
    const w = this._wait("ch:channel-created:" + c.id);
    this._send({ type: "channel-create", ch: c.id, pub: c.pub, meta: c.meta, metaSig: c.metaSig });
    await w;
    this._state.channels[c.id] = c; this._saveState();
    return { id: c.id, link: "#" + this.Ch.fragment(c) };
  }
  async postToChannel(chId, content) {
    const c = this._state.channels[chId]; if (!c || !c.priv) throw new Error("ether-sdk: not the owner of " + chId);
    const post = await this.Ch.makePost(c, typeof content === "string" ? { text: content } : content);
    const w = this._wait("ch:channel-post:" + chId + ":" + post.id);
    this._send({ type: "channel-post", ch: chId, post });
    return w;
  }
  async subscribeChannel(link) {
    const l = this.Ch.parseLink(link); if (!l) throw new Error("ether-sdk: bad channel link");
    const w = this._wait("ch:channel-info:" + l.id);
    this._send({ type: "channel-subscribe", ch: l.id });
    const info = await w;
    if ((await this.Ch.pubHash(info.pub)) !== l.hash) throw new Error("ether-sdk: channel key does not match the link hash"); // закрепление ключа по хешу из ссылки
    this._state.channels[l.id] = { id: l.id, pub: info.pub, key: l.key, kv: info.meta && info.meta.kv | 0 }; this._saveState();
    return info;
  }
  async _onChannelPost(m) {
    const c = this._state.channels[m.ch]; if (!c) return;
    const r = await this.Ch.openPost(c, m.post);
    this._emit(r.ok ? "channel-post" : "channel-post-rejected", { ch: m.ch, seq: m.seq, id: m.post && m.post.id, ...(r.ok ? { content: r.content } : { reason: r.reason }) });
  }
}

module.exports = { Client, generateIdentity, identityFromJSON, claimProof, PROTOCOL };
