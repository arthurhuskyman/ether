// Групповая доставка Sender Keys (js/groupkeys.js): отправитель шифрует сообщение ОДИН раз и шлёт один gdeliver; сервер рассылает тот же
// конверт участникам (онлайн — сразу, офлайн — в обычный ящик, kind "gchat"). Сервер видит только шифртекст и список получателей.
// Реестр групп (gid -> участники, админы, ver) сервер ведёт сам из сообщений group-roster: новую группу регистрирует первый отправитель
// (он становится админом), менять состав дальше могут только админы с большим ver. gdeliver принимается только от участника реестра, получатели —
// пересечение списка отправителя с реестром (отправитель вправе исключить, но не добавить). Лимит группы GROUP_MAX_MEMBERS (по умолчанию 256).
const fs = require("fs");

const envInt = (name, def) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : def; };
const LIM = {
  members: envInt("GROUP_MAX_MEMBERS", 256),
  bytes: envInt("GDELIVER_MAX_BYTES", 256 * 1024),
  perMin: envInt("GDELIVER_PER_MIN", 240),
  perGidMin: envInt("GDELIVER_PER_GROUP_MIN", 600),
  groups: envInt("GROUPS_MAX", 20000),
};
const GID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ID_OK = (x) => typeof x === "string" && x.length > 0 && x.length <= 128 && !x.includes("#");
const strOk = (s, n) => typeof s === "string" && s.length > 0 && s.length <= n && /^[A-Za-z0-9+/_=-]+$/.test(s);

function cleanSk(env) {
  if (!env || typeof env !== "object" || env.v !== "sk1") return null;
  if (!strOk(env.cid, 40) || !Number.isInteger(env.n) || env.n < 0 || env.n > 1e9 || !strOk(env.iv, 64) || !strOk(env.sig, 200)) return null;
  if (typeof env.ct !== "string" || !env.ct.length || env.ct.length > LIM.bytes || !/^[A-Za-z0-9+/_=-]+$/.test(env.ct)) return null;
  return { v: "sk1", cid: env.cid, n: env.n, iv: env.iv, ct: env.ct, sig: env.sig };
}

function create(ctx) {
  // ctx: { safeSend, clientsGet(id), mailboxPut(userId,msgId,entry), scheduleSave(), schedulePush(toId,fromId,msgId), file|null, now() }
  const groups = new Map(); // gid -> { members:Set, admins:Set, ver, at }
  const hits = new Map();
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const rate = (key, limit) => {
    const t = now(); let w = hits.get(key);
    if (!w || t - w.start > 60_000) { w = { start: t, n: 0 }; hits.set(key, w); }
    w.n++;
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start > 60_000) hits.delete(k);
    return w.n <= limit;
  };
  let timer = null;
  function save() {
    if (!ctx.file) return;
    try {
      const tmp = ctx.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, groups: Array.from(groups, ([gid, g]) => [gid, { m: Array.from(g.members), a: Array.from(g.admins), ver: g.ver, at: g.at, i: g.implicit ? 1 : 0 }]) }), { mode: 0o600 });
      fs.renameSync(tmp, ctx.file);
    } catch (e) { console.warn("[groups] не удалось сохранить:", e.message); }
  }
  function saveSoon() { if (!ctx.file || timer) return; timer = setTimeout(() => { timer = null; save(); }, 1500); if (timer.unref) timer.unref(); }
  function load() {
    if (!ctx.file) return 0;
    try {
      if (!fs.existsSync(ctx.file)) return 0;
      const d = JSON.parse(fs.readFileSync(ctx.file, "utf8"));
      for (const [gid, g] of (d && d.groups) || []) if (GID_RE.test(gid) && g && Array.isArray(g.m)) groups.set(gid, { members: new Set(g.m.filter(ID_OK).slice(0, LIM.members)), admins: new Set((g.a || []).filter(ID_OK)), ver: g.ver | 0, at: g.at || now(), implicit: g.i === 1 });
      return groups.size;
    } catch (e) { return 0; }
  }
  function list(arr) { if (!Array.isArray(arr) || arr.length > LIM.members) return null; const s = new Set(); for (const x of arr) { if (!ID_OK(x)) return null; s.add(x); } return s; }

  function onMessage(ws, msg, myId) {
    if (!myId) return false;
    if (msg.type === "group-roster") {
      const ack = (o) => ctx.safeSend(ws, Object.assign({ type: "group-roster-ack", gid: typeof msg.gid === "string" ? msg.gid.slice(0, 64) : "" }, o));
      if (typeof msg.gid !== "string" || !GID_RE.test(msg.gid)) return ack({ error: "invalid" }), true;
      if (!rate("gr:" + myId, 60)) return ack({ error: "rate" }), true;
      const members = list(msg.members); if (!members || !members.has(myId)) return ack({ error: "invalid" }), true;
      let admins = list(msg.admins || [myId]); if (!admins) return ack({ error: "invalid" }), true;
      admins = new Set(Array.from(admins).filter((a) => members.has(a)));
      const ver = Number.isInteger(msg.ver) && msg.ver >= 0 && msg.ver < 1e9 ? msg.ver : 0;
      const cur = groups.get(msg.gid);
      if (cur) {
        const takeover = cur.implicit && cur.members.has(myId); // группу завёл неявный первый gdeliver — явный ростер участника её заменяет
        if (!takeover && !cur.admins.has(myId)) return ack({ error: "not-admin" }), true;
        if (!takeover && ver <= cur.ver) return ack({ error: "stale", ver: cur.ver }), true;
      } else {
        if (groups.size >= LIM.groups) groups.delete(groups.keys().next().value);
        if (!admins.has(myId)) admins.add(myId);
      }
      groups.set(msg.gid, { members, admins, ver, at: now() }); saveSoon();
      return ack({ ver }), true;
    }
    if (msg.type !== "gdeliver") return false;
    const ack = (o) => ctx.safeSend(ws, Object.assign({ type: "gdeliver-ack", msgId: typeof msg.msgId === "string" ? msg.msgId.slice(0, 128) : "" }, o));
    if (typeof msg.gid !== "string" || !GID_RE.test(msg.gid) || typeof msg.msgId !== "string" || !msg.msgId || msg.msgId.length > 128) return ack({ error: "invalid" }), true;
    const to = list(msg.to); const env = cleanSk(msg.envelope);
    if (!to || !env) return ack({ error: to ? "invalid-envelope" : "too-many" }), true;
    if (!rate("gd:" + myId, LIM.perMin) || !rate("gdg:" + msg.gid, LIM.perGidMin)) return ack({ error: "rate" }), true;
    to.delete(myId);
    let g = groups.get(msg.gid);
    if (!g) { // первая весть о группе: отправитель регистрирует её (список получателей + он сам)
      if (groups.size >= LIM.groups) groups.delete(groups.keys().next().value);
      g = { members: new Set([myId, ...to]), admins: new Set([myId]), ver: 0, at: now(), implicit: true }; groups.set(msg.gid, g); saveSoon();
    } else if (!g.members.has(myId)) return ack({ error: "not-member" }), true;
    const targets = Array.from(to).filter((id) => g.members.has(id));
    const dropped = to.size - targets.length;
    let live = 0, queued = 0;
    const t = now();
    for (const id of targets) {
      const entry = { from: myId, msgId: msg.msgId, envelope: env, fromPublicKey: null, kind: "gchat", gid: msg.gid, ts: t };
      ctx.mailboxPut(id, msg.msgId, entry);
      const cl = ctx.clientsGet(id);
      if (cl && cl.ws && cl.ws.readyState === 1) { ctx.safeSend(cl.ws, { type: "deliver", from: myId, msgId: msg.msgId, envelope: env, fromPublicKey: null, kind: "gchat", gid: msg.gid, queued: false }); live++; }
      else { queued++; if (ctx.schedulePush) ctx.schedulePush(id, myId, msg.msgId); }
    }
    ctx.scheduleSave();
    return ack({ live, queued, dropped }), true;
  }
  return { onMessage, load, save, groups, LIM };
}
module.exports = { create, LIM, cleanSk };
