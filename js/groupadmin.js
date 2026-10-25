// Роли и админ-инструменты группы. Роли: owner (g.createdBy) > admin > moderator > member. Все операции — ПОДПИСАННЫЕ действия (ECDSA P-256 ключом личности автора,
// тот же ключ, что у ECDH-личности; публичный ключ автора получатель знает как контакт) и проверяются КАЖДЫМ получателем по матрице прав can(): UI лишь скрывает
// кнопки. Защита от повтора: у каждого автора seq (время) строго растёт, g.aseq[by]. Чистая логика (без DOM/сети): применение к состоянию группы — apply().
const GroupAdmin = (() => {
  const te = new TextEncoder();
  const ALG = { name: "ECDSA", namedCurve: "P-256" }, SIG = { name: "ECDSA", hash: "SHA-256" };
  const RANK = { member: 0, moderator: 1, admin: 2, owner: 3 };
  const OPS = ["kick", "unban", "role", "settings", "pin", "transfer"];
  const SLOW_CHOICES = [0, 10, 30, 60, 300, 900];
  const MAX_REASON = 120, MAX_BANNED = 50, ACT_SKEW_MS = 24 * 3600_000;
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const unb64 = (str) => { const s = atob(str); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; };

  function role(g, id) {
    if (!g || !Array.isArray(g.members)) return null;
    const m = g.members.find((x) => x.id === id); if (!m) return null;
    if (g.createdBy === id) return "owner";
    return m.role === "admin" ? "admin" : m.role === "moderator" ? "moderator" : "member";
  }
  const rank = (g, id) => { const r = role(g, id); return r == null ? -1 : RANK[r]; };

  // Матрица прав. act: { op, target?, role?, settings?, newOwner? }
  function can(g, actor, act) {
    const ra = rank(g, actor); if (ra < 0 || !act) return false;
    const rt = act.target != null ? rank(g, act.target) : -1;
    switch (act.op) {
      case "kick": return ra >= 1 && rt >= 0 && ra > rt;
      case "unban": return ra >= 2;
      case "role": return ra >= 2 && rt >= 0 && rt < ra && (act.role === "member" || act.role === "moderator" || (act.role === "admin" && ra === 3));
      case "settings": return ra >= 2;
      case "pin": { const p = g.pinPolicy === "admins" ? 2 : g.pinPolicy === "all" ? 0 : 1; return ra >= p; }
      case "transfer": return ra === 3 && actor === g.createdBy && rt >= 0 && act.target !== actor;
      default: return false;
    }
  }
  const canPost = (g, id) => { const r = rank(g, id); return r >= 0 && (!g.writeRestricted || r >= 2); };
  // Медленный режим: участники ниже модератора — не чаще раза в slowSec; last — Map "gid|id" -> время. Допуск 30% на разброс сети.
  function slowAllowed(g, id, now, last) {
    if (!g || !g.slowSec || rank(g, id) >= 1) return true;
    const k = g.id + "|" + id, prev = last.get(k) || 0;
    if (now - prev < g.slowSec * 700) return false;
    last.set(k, now); if (last.size > 2000) last.delete(last.keys().next().value);
    return true;
  }
  function slowWaitMs(g, id, now, last) {
    if (!g || !g.slowSec || rank(g, id) >= 1) return 0;
    return Math.max(0, g.slowSec * 1000 - (now - (last.get(g.id + "|" + id) || 0)));
  }

  // ---------- подписи ----------
  const canon = (a) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]));
  const signKey = (p) => crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: p.x, y: p.y, d: p.d, ext: true }, ALG, false, ["sign"]);
  const verKey = (p) => crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: p.x, y: p.y, ext: true }, ALG, false, ["verify"]);
  async function signAct(priv, act) { return b64(new Uint8Array(await crypto.subtle.sign(SIG, await signKey(priv), te.encode("ether-gadm-v1|" + canon(act))))); }
  async function verifyAct(pub, act, sig) { try { return !!pub && typeof sig === "string" && await crypto.subtle.verify(SIG, await verKey(pub), unb64(sig), te.encode("ether-gadm-v1|" + canon(act))); } catch (e) { return false; } }
  // Построить подписанное действие. seq строго больше прежнего у этого автора.
  async function make(g, by, priv, fields, now) {
    const prev = (g.aseq && g.aseq[by]) || 0;
    const act = Object.assign({ gid: g.id, by, seq: Math.max(prev + 1, now || Date.now()) }, fields);
    if (act.reason) act.reason = String(act.reason).slice(0, MAX_REASON);
    return { act, sig: await signAct(priv, act) };
  }
  function validShape(act) {
    if (!act || typeof act !== "object" || !OPS.includes(act.op) || typeof act.by !== "string" || typeof act.gid !== "string" || !Number.isSafeInteger(act.seq)) return false;
    for (const k of ["target", "newOwner", "msgId", "reason", "role"]) if (act[k] != null && (typeof act[k] !== "string" || act[k].length > 200)) return false;
    if (act.settings != null) {
      const s = act.settings; if (typeof s !== "object") return false;
      if (s.slowSec != null && !SLOW_CHOICES.includes(s.slowSec)) return false;
      if (s.pinPolicy != null && !["admins", "mods", "all"].includes(s.pinPolicy)) return false;
      if (s.writeRestricted != null && typeof s.writeRestricted !== "boolean") return false;
      if (s.joinApproval != null && typeof s.joinApproval !== "boolean") return false;
    }
    return true;
  }
  // Применить проверенное (подпись снаружи) действие к состоянию группы. -> { ok, reason?, sys?: {key, params}, removedSelf?, removed? }
  function apply(g, act, now, myId) {
    if (!validShape(act) || act.gid !== g.id) return { ok: false, reason: "shape" };
    g.aseq = g.aseq || {};
    if (act.seq <= (g.aseq[act.by] || 0)) return { ok: false, reason: "replay" };
    if (act.seq > now + ACT_SKEW_MS) return { ok: false, reason: "future" };
    if (!can(g, act.by, act)) return { ok: false, reason: "denied" };
    g.aseq[act.by] = act.seq;
    const nameOf = (id) => (g.members.find((m) => m.id === id) || {}).name || "";
    switch (act.op) {
      case "kick": {
        const name = nameOf(act.target);
        g.members = g.members.filter((m) => m.id !== act.target);
        g.banned = (Array.isArray(g.banned) ? g.banned.filter((x) => x !== act.target) : []).concat(act.target).slice(-MAX_BANNED);
        g.banReasons = Object.assign({}, g.banReasons || {}); if (act.reason) g.banReasons[act.target] = act.reason; else delete g.banReasons[act.target];
        return { ok: true, removed: act.target, removedSelf: act.target === myId, sys: { key: act.reason ? "group.systemKickedReason" : "group.systemRemoved", params: { name, reason: act.reason || "" } } };
      }
      case "unban": g.banned = (g.banned || []).filter((x) => x !== act.target); if (g.banReasons) delete g.banReasons[act.target]; return { ok: true, sys: { key: "group.systemUnbanned", params: { name: act.target } } };
      case "role": {
        const m = g.members.find((x) => x.id === act.target); m.role = act.role === "member" ? undefined : act.role;
        return { ok: true, sys: { key: act.role === "member" ? "group.systemDemoted" : act.role === "moderator" ? "group.systemModerator" : "group.systemPromoted", params: { name: m.name } } };
      }
      case "settings": {
        const s = act.settings || {};
        if (s.slowSec != null) g.slowSec = s.slowSec || undefined;
        if (s.pinPolicy != null) g.pinPolicy = s.pinPolicy === "mods" ? undefined : s.pinPolicy;
        if (s.writeRestricted != null) g.writeRestricted = s.writeRestricted || undefined;
        if (s.joinApproval != null) g.joinApproval = s.joinApproval || undefined;
        return { ok: true, sys: { key: "group.systemSettings", params: {} } };
      }
      case "pin": g.pinnedMessageId = act.msgId || null; return { ok: true, sys: null };
      case "transfer": {
        const old = g.createdBy, m = g.members.find((x) => x.id === act.target);
        g.createdBy = act.target; m.role = undefined;
        const om = g.members.find((x) => x.id === old); if (om) om.role = "admin";
        return { ok: true, sys: { key: "group.systemTransfer", params: { name: m.name } } };
      }
    }
    return { ok: false, reason: "op" };
  }

  // Роли из чужого ростера: повысить до admin может только владелец; moderator из ростера не берём (только подписанные действия); локальные moderator сохраняем.
  function sanitizeRoster(g, incoming, senderId) {
    const senderOwner = g.createdBy === senderId;
    return incoming.map((m) => {
      const old = g.members.find((x) => x.id === m.id), cm = Object.assign({}, m);
      const was = old && old.role;
      if (cm.role === "admin" && !senderOwner && was !== "admin") cm.role = was === "moderator" ? "moderator" : undefined;
      else if (cm.role === "moderator" && was !== "moderator") cm.role = was === "admin" ? "admin" : undefined;
      else if (was === "moderator" && cm.role !== "admin") cm.role = "moderator";
      if (cm.role === undefined) delete cm.role;
      return cm;
    });
  }

  // ---------- ссылка-приглашение с истечением ----------
  const inviteMsg = (gid, ref, exp, ap) => te.encode(["ether-ginv-v1", gid, ref, exp, ap ? 1 : 0].join("|"));
  async function signInvite(priv, gid, ref, exp, ap) { return b64(new Uint8Array(await crypto.subtle.sign(SIG, await signKey(priv), inviteMsg(gid, ref, exp, ap)))); }
  async function verifyInvite(pub, gid, ref, exp, ap, sig) { try { return !!pub && await crypto.subtle.verify(SIG, await verKey(pub), unb64(sig), inviteMsg(gid, ref, exp, ap)); } catch (e) { return false; } }

  return { RANK, SLOW_CHOICES, MAX_REASON, role, rank, can, canPost, slowAllowed, slowWaitMs, make, signAct, verifyAct, validShape, apply, sanitizeRoster, signInvite, verifyInvite };
})();
if (typeof module !== "undefined") module.exports = GroupAdmin;
