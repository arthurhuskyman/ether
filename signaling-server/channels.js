// Каналы (рассылка один-ко-многим). Сервер — только хранилище и рассыльщик: подлинность постов обеспечивает ПОДПИСЬ владельца
// (ECDSA P-256, ключ канала создаётся владельцем и закреплён подписчиками по хешу из ссылки #ch=<id>.<хеш>). Сервер проверяет подпись
// каждого поста по публичному ключу канала и не может сочинить пост сам; клиент проверяет её повторно. Тела постов — непрозрачные строки
// (для закрытых каналов зашифрованы ключом канала, которого у сервера нет). Хранится кольцо последних постов (CHANNEL_HISTORY_MAX, TTL).
// Протокол: channel-create / channel-meta / channel-delete (подписаны), channel-info, channel-subscribe / -unsubscribe, channel-post, channel-history.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const envInt = (name, def) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : def; };
const LIM = {
  history: envInt("CHANNEL_HISTORY_MAX", 200),
  ttlMs: envInt("CHANNEL_POST_TTL_DAYS", 30) * 86400_000,
  subsMax: envInt("CHANNEL_SUBS_MAX", 5000),
  postBytes: envInt("CHANNEL_POST_MAX_BYTES", 256 * 1024),
  chanBytes: envInt("CHANNEL_MAX_BYTES", 8 * 1024 * 1024),
  perOwner: envInt("CHANNELS_PER_USER", 20),
  total: envInt("CHANNELS_MAX", 5000),
  subsPerUser: envInt("CHANNEL_SUBS_PER_USER", 200),
  postsPerMin: envInt("CHANNEL_POSTS_PER_MIN", 20),
  opsPerMin: envInt("CHANNEL_OPS_PER_MIN", 60),
  skewMs: 10 * 60_000,
};
const ID_RE = /^[a-z0-9]{12,32}$/;
const te = (s) => Buffer.from(String(s));
const clean = (s, n) => String(s == null ? "" : s).replace(/[|\n\r]/g, " ").slice(0, n);
const b64ok = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/_=-]+$/.test(s);
const pubOk = (p) => p && typeof p === "object" && b64ok(p.x, 64) && b64ok(p.y, 64);

// Канонические строки подписи (те же собирает клиент, js/channels.js)
const metaMsg = (ch, m) => te(["ether-chmeta-v1", ch, clean(m.name, 60), clean(m.desc, 200), m.enc ? 1 : 0, Number(m.ts), m.kv | 0, m.av || ""].join("|"));
const postMsg = (ch, p) => te(["ether-chpost-v1", ch, p.id, p.ts, p.enc ? 1 : 0, p.kv | 0, p.iv || "", p.body].join("|"));
const delMsg = (ch, ts) => te(["ether-chdel-v1", ch, ts].join("|"));

function verify(pub, msg, sigB64) {
  try {
    if (!b64ok(sigB64, 200)) return false;
    const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y }, format: "jwk" });
    return crypto.verify("sha256", msg, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sigB64, "base64"));
  } catch (e) { return false; }
}

function create(ctx) {
  // ctx: { safeSend, clientsGet(id), push(userId, channel), file|null, now() }
  const channels = new Map(); // id -> { id, pub, owner, meta, metaSig, created, seq, bytes, subs:Set, posts:[{seq,post,at,size}] }
  const hits = new Map();
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const rate = (key, limit) => {
    const t = now(); let w = hits.get(key);
    if (!w || t - w.start > 60_000) { w = { start: t, n: 0 }; hits.set(key, w); }
    w.n++;
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start > 60_000) hits.delete(k);
    return w.n <= limit;
  };
  const send = (ws, o) => ctx.safeSend(ws, o);
  const err = (ws, type, ch, error) => send(ws, { type, ch, error });

  // ---------- хранение ----------
  let timer = null;
  function save() {
    if (!ctx.file) return;
    try {
      const tmp = ctx.file + ".tmp";
      const data = { v: 1, channels: Array.from(channels.values()).map((c) => ({ id: c.id, pub: c.pub, owner: c.owner, meta: c.meta, metaSig: c.metaSig, created: c.created, seq: c.seq, subs: Array.from(c.subs), posts: c.posts.map((p) => ({ seq: p.seq, post: p.post, at: p.at })) })) };
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, ctx.file); // атомарно
      try { fs.chmodSync(ctx.file, 0o600); } catch (e) {}
    } catch (e) { console.warn("[channels] не удалось сохранить:", e.message); }
  }
  function saveSoon() { if (!ctx.file || timer) return; timer = setTimeout(() => { timer = null; save(); }, 1500); if (timer.unref) timer.unref(); }
  function load() {
    if (!ctx.file) return 0;
    try {
      if (!fs.existsSync(ctx.file)) return 0;
      const d = JSON.parse(fs.readFileSync(ctx.file, "utf8"));
      for (const c of (d && d.channels) || []) {
        if (!c || !ID_RE.test(c.id) || !pubOk(c.pub) || !c.meta) continue;
        const posts = (Array.isArray(c.posts) ? c.posts : []).filter((p) => p && p.post && Number.isInteger(p.seq)).map((p) => ({ seq: p.seq, post: p.post, at: p.at || p.post.ts, size: JSON.stringify(p.post).length }));
        channels.set(c.id, { id: c.id, pub: c.pub, owner: String(c.owner || ""), meta: c.meta, metaSig: c.metaSig, created: c.created || now(), seq: c.seq | 0, bytes: posts.reduce((n, p) => n + p.size, 0), subs: new Set((c.subs || []).filter((x) => typeof x === "string").slice(0, LIM.subsMax)), posts });
      }
      prune();
      return channels.size;
    } catch (e) { console.warn("[channels] не удалось прочитать файл:", e.message); return 0; }
  }
  function trim(c) {
    const t = now();
    while (c.posts.length && (c.posts.length > LIM.history || t - c.posts[0].at > LIM.ttlMs || c.bytes > LIM.chanBytes)) { c.bytes -= c.posts[0].size; c.posts.shift(); }
  }
  function prune() { let ch = false; for (const c of channels.values()) { const n = c.posts.length; trim(c); if (c.posts.length !== n) ch = true; } if (ch) saveSoon(); }

  const info = (c, extra) => Object.assign({ type: "channel-info", ch: c.id, pub: c.pub, meta: c.meta, metaSig: c.metaSig, seq: c.seq, subs: c.subs.size, created: c.created }, extra || {});
  const subCount = (uid) => { let n = 0; for (const c of channels.values()) if (c.subs.has(uid)) n++; return n; };

  function validMeta(m) {
    return m && typeof m === "object" && typeof m.name === "string" && m.name.length > 0 && m.name.length <= 60 && (m.desc == null || (typeof m.desc === "string" && m.desc.length <= 200)) &&
      Number.isSafeInteger(m.ts) && (m.kv == null || (Number.isInteger(m.kv) && m.kv >= 0 && m.kv < 1e6)) && (m.av == null || /^[0-9a-f]{64}$/.test(m.av)) && (m.avatar == null || (typeof m.avatar === "string" && m.avatar.length <= 30000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(m.avatar)));
  }
  function cleanMeta(m) { const o = { name: clean(m.name, 60), desc: clean(m.desc || "", 200), enc: !!m.enc, ts: m.ts, kv: m.kv | 0 }; if (m.av) o.av = m.av; if (m.avatar) o.avatar = m.avatar; return o; }
  function metaOk(ch, pub, m, sig) { return validMeta(m) && verify(pub, metaMsg(ch, m), sig) && (!m.avatar || crypto.createHash("sha256").update(m.avatar).digest("hex") === m.av); }

  // Возвращает true, если сообщение обработано.
  function onMessage(ws, msg, myId) {
    if (typeof msg.type !== "string" || !msg.type.startsWith("channel-") || !myId) return false;
    const T = msg.type, ch = msg.ch;
    if (typeof ch !== "string" || !ID_RE.test(ch)) { send(ws, { type: T === "channel-post" ? "channel-post-ack" : T, ch: typeof ch === "string" ? ch.slice(0, 32) : "", error: "invalid" }); return true; }
    if (!rate("op:" + myId, LIM.opsPerMin)) { err(ws, T === "channel-post" ? "channel-post-ack" : T, ch, "rate"); return true; }

    if (T === "channel-create") {
      if (channels.has(ch)) { err(ws, "channel-created", ch, "exists"); return true; }
      if (!pubOk(msg.pub) || !metaOk(ch, msg.pub, msg.meta, msg.metaSig)) { err(ws, "channel-created", ch, "invalid"); return true; }
      if (channels.size >= LIM.total) { err(ws, "channel-created", ch, "full"); return true; }
      let own = 0; for (const c of channels.values()) if (c.owner === myId) own++;
      if (own >= LIM.perOwner) { err(ws, "channel-created", ch, "limit"); return true; }
      const c = { id: ch, pub: { x: msg.pub.x, y: msg.pub.y }, owner: myId, meta: cleanMeta(msg.meta), metaSig: msg.metaSig, created: now(), seq: 0, bytes: 0, subs: new Set([myId]), posts: [] };
      channels.set(ch, c); saveSoon();
      send(ws, { type: "channel-created", ch, seq: 0 });
      return true;
    }
    const c = channels.get(ch);
    if (!c) { err(ws, T === "channel-post" ? "channel-post-ack" : T, ch, "not-found"); return true; }

    if (T === "channel-info") { send(ws, info(c, { subscribed: c.subs.has(myId) })); return true; }

    if (T === "channel-subscribe") {
      if (!c.subs.has(myId)) {
        if (c.subs.size >= LIM.subsMax) { err(ws, "channel-info", ch, "full"); return true; }
        if (subCount(myId) >= LIM.subsPerUser) { err(ws, "channel-info", ch, "limit"); return true; }
        c.subs.add(myId); saveSoon();
      }
      send(ws, info(c, { subscribed: true }));
      return true;
    }
    if (T === "channel-unsubscribe") {
      if (c.subs.delete(myId)) saveSoon();
      send(ws, { type: "channel-unsubscribed", ch });
      return true;
    }
    if (T === "channel-meta") { // смена названия/описания/версии ключа: только с подписью владельца, ts строго растёт
      if (!validMeta(msg.meta) || msg.meta.ts <= c.meta.ts || Math.abs(msg.meta.ts - now()) > LIM.skewMs * 6 || !metaOk(ch, c.pub, msg.meta, msg.metaSig)) { err(ws, "channel-meta", ch, "invalid"); return true; }
      c.meta = cleanMeta(msg.meta); c.metaSig = msg.metaSig; saveSoon();
      send(ws, { type: "channel-meta", ch, ok: true });
      fan(c, { type: "channel-meta-update", ch, meta: c.meta, metaSig: c.metaSig });
      return true;
    }
    if (T === "channel-delete") {
      if (!Number.isSafeInteger(msg.ts) || Math.abs(msg.ts - now()) > LIM.skewMs || !verify(c.pub, delMsg(ch, msg.ts), msg.sig)) { err(ws, "channel-deleted", ch, "invalid"); return true; }
      fan(c, { type: "channel-gone", ch });
      channels.delete(ch); saveSoon();
      send(ws, { type: "channel-deleted", ch });
      return true;
    }
    if (T === "channel-post") {
      const p = msg.post;
      const ack = (o) => send(ws, Object.assign({ type: "channel-post-ack", ch, id: p && typeof p.id === "string" ? p.id.slice(0, 64) : "" }, o));
      if (!p || typeof p !== "object" || typeof p.id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(p.id) || typeof p.body !== "string" || !p.body.length || !Number.isSafeInteger(p.ts) ||
        (p.iv != null && !b64ok(p.iv, 64)) || (p.kv != null && !(Number.isInteger(p.kv) && p.kv >= 0 && p.kv < 1e6)) || (p.enc != null && typeof p.enc !== "boolean") || (p.enc && !p.iv)) return ack({ error: "invalid" }), true;
      if (p.body.length > LIM.postBytes) return ack({ error: "too-big" }), true;
      if (Math.abs(p.ts - now()) > LIM.skewMs) return ack({ error: "clock" }), true;
      if (!verify(c.pub, postMsg(ch, p), p.sig)) return ack({ error: "bad-sig" }), true; // не владелец (или подделка): сервер не принимает
      if (!rate("post:" + ch, LIM.postsPerMin)) return ack({ error: "rate" }), true;
      const dup = c.posts.find((x) => x.post.id === p.id);
      if (dup) return ack({ seq: dup.seq, dup: true }), true;
      const post = { id: p.id, ts: p.ts, body: p.body, sig: p.sig };
      if (p.enc) { post.enc = true; post.iv = p.iv; } if (p.kv) post.kv = p.kv;
      c.seq++;
      const size = JSON.stringify(post).length;
      c.posts.push({ seq: c.seq, post, at: now(), size }); c.bytes += size; trim(c); saveSoon();
      ack({ seq: c.seq });
      fan(c, { type: "channel-post", ch, seq: c.seq, post }, true);
      return true;
    }
    if (T === "channel-history") {
      if (!c.subs.has(myId)) { err(ws, "channel-history", ch, "not-subscribed"); return true; }
      const since = Number.isInteger(msg.since) && msg.since >= 0 ? msg.since : 0;
      const limit = Math.min(Number.isInteger(msg.limit) && msg.limit > 0 ? msg.limit : LIM.history, LIM.history);
      trim(c);
      const posts = c.posts.filter((p) => p.seq > since).slice(-limit).map((p) => ({ seq: p.seq, post: p.post }));
      send(ws, { type: "channel-history", ch, posts, seq: c.seq, first: c.posts.length ? c.posts[0].seq : c.seq + 1 });
      return true;
    }
    return false;
  }
  function fan(c, obj, withPush) {
    for (const uid of c.subs) {
      const cl = ctx.clientsGet(uid);
      if (cl && cl.ws && cl.ws.readyState === 1) send(cl.ws, obj);
      else if (withPush && ctx.push) { try { ctx.push(uid, c); } catch (e) {} } // офлайн: Web Push (без содержимого), историю он заберёт при входе
    }
  }
  // Сокет пользователя закрылся/зашёл заново: ничего не делаем — подписка привязана к id, а не к сокету.
  return { onMessage, load, save, saveSoon, prune, channels, LIM, metaMsg, postMsg, delMsg };
}
module.exports = { create, LIM, metaMsg, postMsg, delMsg, verify, ID_RE };
