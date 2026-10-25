// Sender Keys для больших групп (как у Signal): у каждого участника своя цепочка отправки — ключ цепочки (ck) и пара ECDSA для подписи.
// Цепочка один раз раздаётся каждому участнику по обычному 1:1 E2E-каналу (kind "gk-dist"). Сообщение группе шифруется ОДИН раз
// (AES-256-GCM, ключ и IV выводятся из ck симметричным храповиком: mk = HMAC(ck,01), ck' = HMAC(ck,02), iv = HMAC(ck,03)[0..12)),
// подписывается ключом цепочки отправителя и уходит одним gdeliver; сервер рассылает тот же шифртекст всем. Подпись не даёт участнику,
// знающему ck, выдать себя за другого; сервер не знает ключей. Прямая секретность внутри цепочки: ck' необратимо, использованные ключи стираются.
// При исключении участника ВСЕ оставшиеся делают rekey() (новая цепочка, раздаётся только оставшимся) — исключённый новых сообщений не прочтёт.
// Новому участнику раздаётся текущее состояние цепочки (n на сейчас) — историю до входа он не прочтёт.
// Окно пропусков MAX_SKIP: сообщения могут прийти не по порядку (сервер/ящик), пропущенные ключи хранятся до MAX_SKIPPED.
const GroupKeys = (() => {
  const MAX_SKIP = 256, MAX_SKIPPED = 512, MAX_CHAINS_PER_SENDER = 3;
  const SK_THRESHOLD = 8;        // группы ≤ 8 участников остаются попарными
  const LS_KEY = "ether.groupkeys";
  const te = new TextEncoder(), td = new TextDecoder();
  const SIG_ALG = { name: "ECDSA", namedCurve: "P-256" }, SIG = { name: "ECDSA", hash: "SHA-256" };
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const unb64 = (str) => { const s = atob(str); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; };

  let store = {
    load() { try { const v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) : {}; } catch (e) { return {}; } },
    save(obj) { try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); return true; } catch (e) { return false; } },
  };
  let db = null, timer = null;
  function getDb() {
    if (!db) { const raw = store.load() || {}; db = { send: raw.send && typeof raw.send === "object" ? raw.send : {}, recv: raw.recv && typeof raw.recv === "object" ? raw.recv : {} }; }
    return db;
  }
  function setStore(s) { store = s; db = null; if (timer) { clearTimeout(timer); timer = null; } }
  function persistNow() { if (timer) { clearTimeout(timer); timer = null; } const r = store.save(getDb()); return r !== false; }
  function persistSoon() { if (timer) return; timer = setTimeout(() => { timer = null; persistNow(); }, 150); }
  function reset() { db = { send: {}, recv: {} }; persistNow(); }

  async function hmac(keyBytes, byte) {
    const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, new Uint8Array([byte])));
  }
  async function step(ckB64) { // -> { key, iv, next }
    const ck = unb64(ckB64);
    const [mk, nx, ivb] = await Promise.all([hmac(ck, 1), hmac(ck, 2), hmac(ck, 3)]);
    return { key: mk, iv: ivb.slice(0, 12), next: b64(nx) };
  }
  const aesKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const aad = (gid, sender, cid, n) => te.encode(["ether-sk1", gid, sender, cid, n].join("|"));
  const sigKeyPriv = (j) => crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d, ext: true }, SIG_ALG, false, ["sign"]);
  const sigKeyPub = (j) => crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: j.x, y: j.y, ext: true }, SIG_ALG, false, ["verify"]);
  const cat = (a, b, c) => { const o = new Uint8Array(a.length + b.length + (c ? c.length : 0)); o.set(a, 0); o.set(b, a.length); if (c) o.set(c, a.length + b.length); return o; };
  const rid = () => { const a = crypto.getRandomValues(new Uint8Array(9)); return b64(a).replace(/\+/g, "-").replace(/\//g, "_"); };

  async function newChain() {
    const kp = await crypto.subtle.generateKey(SIG_ALG, true, ["sign", "verify"]);
    const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
    return { cid: rid(), ck: b64(crypto.getRandomValues(new Uint8Array(32))), n: 0, spub: { x: j.x, y: j.y }, spriv: { x: j.x, y: j.y, d: j.d }, at: Date.now() };
  }

  // ---------- решение: когда использовать Sender Keys ----------
  // members: [{id}], capsOf(id) -> true, если участник умеет sk1. Я считаюсь участником. Любой без sk1 — вся группа попарная.
  function shouldUse(memberIds, myId, hasCap) {
    const ids = Array.from(new Set((memberIds || []).concat(myId ? [myId] : [])));
    if (ids.length <= SK_THRESHOLD) return false;
    return ids.every((id) => id === myId || !!hasCap(id));
  }

  // ---------- отправка ----------
  async function ensureSend(gid) {
    const d = getDb();
    if (!d.send[gid]) { d.send[gid] = await newChain(); if (!persistNow()) throw new Error("groupkeys: storage unavailable"); }
    return d.send[gid];
  }
  // Состояние цепочки отправки для раздачи участникам (ck на ТЕКУЩЕМ n: раньше отправленное новичок не прочтёт)
  async function distribution(gid) {
    const c = await ensureSend(gid);
    return { gid, cid: c.cid, ck: c.ck, n: c.n, spub: c.spub };
  }
  async function rekey(gid) {
    const d = getDb(); d.send[gid] = await newChain();
    if (!persistNow()) throw new Error("groupkeys: storage unavailable");
    return distribution(gid);
  }
  async function encrypt(gid, myId, plaintext) {
    const c = await ensureSend(gid);
    const { key, iv, next } = await step(c.ck);
    const n = c.n, a = aad(gid, myId, c.cid, n);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: a }, await aesKey(key), te.encode(String(plaintext))));
    const sig = new Uint8Array(await crypto.subtle.sign(SIG, await sigKeyPriv(c.spriv), cat(a, iv, ct)));
    // Сначала фиксируем продвинутое состояние: если записать не удалось, ключ мог бы повториться после перезапуска — отказываемся отправлять
    const prev = { ck: c.ck, n: c.n };
    c.ck = next; c.n = n + 1;
    if (!persistNow()) { c.ck = prev.ck; c.n = prev.n; throw new Error("groupkeys: storage unavailable"); }
    return { v: "sk1", cid: c.cid, n, iv: b64(iv), ct: b64(ct), sig: b64(sig) };
  }

  // ---------- приём ----------
  const rkey = (gid, sender) => gid + "|" + sender;
  function validDist(x) {
    return x && typeof x === "object" && typeof x.cid === "string" && x.cid.length > 0 && x.cid.length <= 40 && typeof x.ck === "string" && x.ck.length === 44 &&
      Number.isInteger(x.n) && x.n >= 0 && x.n < 1e9 && x.spub && typeof x.spub.x === "string" && typeof x.spub.y === "string" && x.spub.x.length <= 64 && x.spub.y.length <= 64;
  }
  // Принять цепочку собеседника. Та же цепочка с меньшим/равным n не откатывает состояние (повтор раздачи безвреден).
  function acceptDistribution(gid, sender, dist) {
    if (!validDist(dist)) return false;
    const d = getDb(), k = rkey(gid, sender);
    const list = d.recv[k] || (d.recv[k] = []);
    const cur = list.find((c) => c.cid === dist.cid);
    if (cur) {
      if (dist.n > cur.n && cur.spub.x === dist.spub.x && cur.spub.y === dist.spub.y) { cur.ck = dist.ck; cur.n = dist.n; cur.skipped = {}; persistSoon(); return true; }
      return false;
    }
    list.unshift({ cid: dist.cid, ck: dist.ck, n: dist.n, spub: { x: dist.spub.x, y: dist.spub.y }, skipped: {} });
    while (list.length > MAX_CHAINS_PER_SENDER) list.pop();
    persistSoon();
    return true;
  }
  const hasRecv = (gid, sender, cid) => ((getDb().recv[rkey(gid, sender)]) || []).some((c) => c.cid === cid);
  function validEnv(e) { return e && e.v === "sk1" && typeof e.cid === "string" && Number.isInteger(e.n) && e.n >= 0 && typeof e.iv === "string" && typeof e.ct === "string" && typeof e.sig === "string"; }

  // Возвращает расшифрованную строку; бросает Error("groupkeys: <причина>"): no-chain | bad-sig | too-far | old | auth
  async function decrypt(gid, sender, env) {
    if (!validEnv(env)) throw new Error("groupkeys: bad-envelope");
    const chain = ((getDb().recv[rkey(gid, sender)]) || []).find((c) => c.cid === env.cid);
    if (!chain) throw new Error("groupkeys: no-chain");
    const a = aad(gid, sender, env.cid, env.n);
    const iv = unb64(env.iv), ct = unb64(env.ct), sig = unb64(env.sig);
    if (!(await crypto.subtle.verify(SIG, await sigKeyPub(chain.spub), sig, cat(a, iv, ct)))) throw new Error("groupkeys: bad-sig");
    let keyRaw, ivRaw, newCk = chain.ck, newN = chain.n, newSkipped = Object.assign({}, chain.skipped);
    if (env.n < chain.n) { // догоняем пропущенное
      const sk = newSkipped[env.n];
      if (!sk) throw new Error("groupkeys: old");
      keyRaw = unb64(sk.k); ivRaw = unb64(sk.i); delete newSkipped[env.n];
    } else {
      if (env.n - chain.n > MAX_SKIP) throw new Error("groupkeys: too-far");
      let ck = chain.ck;
      for (let i = chain.n; i < env.n; i++) { const s = await step(ck); newSkipped[i] = { k: b64(s.key), i: b64(s.iv) }; ck = s.next; }
      const s = await step(ck); keyRaw = s.key; ivRaw = s.iv; newCk = s.next; newN = env.n + 1;
      const keys = Object.keys(newSkipped).map(Number).sort((x, y) => x - y);
      while (keys.length > MAX_SKIPPED) delete newSkipped[keys.shift()];
    }
    if (b64(ivRaw) !== env.iv) throw new Error("groupkeys: auth");
    let pt;
    try { pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivRaw, additionalData: a }, await aesKey(keyRaw), ct); } catch (e) { throw new Error("groupkeys: auth"); }
    chain.ck = newCk; chain.n = newN; chain.skipped = newSkipped; // коммит только после успешной проверки
    persistSoon();
    return td.decode(pt);
  }

  // ---------- состав ----------
  function dropSender(gid, sender) { const d = getDb(); if (d.recv[rkey(gid, sender)]) { delete d.recv[rkey(gid, sender)]; persistSoon(); } }
  function dropGroup(gid) {
    const d = getDb(); delete d.send[gid];
    for (const k of Object.keys(d.recv)) if (k.startsWith(gid + "|")) delete d.recv[k];
    persistNow();
  }
  // Оставить цепочки только текущих участников (после смены ростера); возвращает id, чьи цепочки удалены
  function pruneToMembers(gid, memberIds) {
    const keep = new Set(memberIds), d = getDb(), gone = [];
    for (const k of Object.keys(d.recv)) if (k.startsWith(gid + "|")) { const s = k.slice(gid.length + 1); if (!keep.has(s)) { delete d.recv[k]; gone.push(s); } }
    if (gone.length) persistSoon();
    return gone;
  }
  const hasSend = (gid) => !!getDb().send[gid];
  const sendInfo = (gid) => { const c = getDb().send[gid]; return c ? { cid: c.cid, n: c.n } : null; };

  return { SK_THRESHOLD, MAX_SKIP, setStore, reset, flush: persistNow, shouldUse, ensureSend, distribution, rekey, encrypt, acceptDistribution, hasRecv, decrypt, dropSender, dropGroup, pruneToMembers, hasSend, sendInfo, validDist };
})();
if (typeof module !== "undefined") module.exports = GroupKeys;
