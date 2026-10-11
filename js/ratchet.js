// Double Ratchet для офлайн-конвертов (сообщения, лежащие на сервере, пока получатель не в сети).
//
// Что это даёт: у каждого сообщения свой одноразовый ключ; ключ удаляется сразу после использования, а цепочка
// «обновляется» при каждой смене направления переписки (DH-храповик). Украденный сегодня ключ устройства
// не открывает уже прочитанные сообщения (forward secrecy после первого ответа собеседника) и перестаёт
// открывать будущие, как только собеседник ответит новым временным ключом (post-compromise security).
//
// Старт сессии: если сервер отдал prekey-пакет получателя (spk + одноразовый opk), используется 3DH/4DH (как X3DH у Signal):
// первые сообщения тоже защищены от компрометации долговременного ключа. Если пакета нет (сервер/собеседник старые, opk кончились,
// сервер недоступен), сессия стартует от долговременных ключей — как раньше. Подписей prekey нет: подмена пакета сервером не даёт
// ему секрета, потому что в общий секрет входит DH с долговременным ключом получателя, а его закрытой части у сервера нет.
// Сообщения по прямому P2P-каналу сюда не попадают — их защищает DTLS WebRTC.
//
// Схема (как в спецификации Double Ratchet, примитивы WebCrypto):
//   стартовый секрет SK = HKDF(ECDH(долговременный мой, долговременный их)), первый храповик инициатор делает
//   против долговременного ключа получателя (тот играет роль «подписанного prekey»);
//   KDF_RK = HKDF-SHA256(salt = корневой ключ, ikm = DH), KDF_CK = HMAC-SHA256(ключ цепочки, 0x01 / 0x02);
//   шифр AES-256-GCM, ключ и IV выводятся из ключа сообщения, AAD = id отправителя/получателя + заголовок.
//
// Состояния хранятся по контактам, до MAX_SESSIONS на контакт (как у Signal: старые сессии нужны, пока доходят
// «хвосты»). В IndexedDB-бэкап они сознательно НЕ попадают: откат состояния назад привёл бы к повторному
// использованию ключей, а потеря состояния лечится новой сессией.
const Ratchet = (() => {
  const MAX_SKIP = 200;          // сколько пропущенных ключей сообщений готовы вычислить за раз
  const MAX_SKIPPED_STORED = 400; // сколько пропущенных ключей хранить в сессии
  const MAX_SESSIONS = 4;
  const HIST = 8;                // сколько последних ключей собеседника помним (чтобы отличить повтор от новой сессии)
  const LS_KEY = "ether.ratchet";
  const te = new TextEncoder(), td = new TextDecoder();
  const ALG = { name: "ECDH", namedCurve: "P-256" };

  function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(str) { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
  function concat(...arrs) { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; }

  // ---------- хранилище ----------
  let store = {
    load() { try { const v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) : {}; } catch (e) { return {}; } },
    save(obj) { try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch (e) { /* квота — состояние будет сохранено при следующей операции */ } },
  };
  function setStore(s) { store = s; db = null; }
  let db = null;
  function getDb() {
    if (!db) {
      const raw = store.load() || {};
      db = { s: raw.s && typeof raw.s === "object" ? raw.s : {}, pk: raw.pk && typeof raw.pk === "object" ? raw.pk : {} };
    }
    return db;
  }
  function persist() { store.save(getDb()); }

  // ---------- примитивы ----------
  // Подпись spk долговременным ключом личности (C2): сервер не может подменить prekey собеседника своим. Тот же P-256 ключ используется
  // для ECDH и ECDSA (как XEdDSA в Signal); сообщение содержит метку домена, чтобы подпись нельзя было перенести в другой контекст.
  const SPK_SIG_DOMAIN = "ether-spk-v1|";
  const spkMsg = (id, x, y) => te.encode(SPK_SIG_DOMAIN + id + "|" + x + "|" + y);
  async function signSpk(priv, id, x, y) {
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return b64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, spkMsg(id, x, y))));
  }
  async function verifySpk(theirPub, spk) {
    try {
      if (!spk || typeof spk.sig !== "string" || spk.sig.length > 200 || !Array.isArray(spk.pub)) return false;
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: theirPub.x, y: theirPub.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(spk.sig), spkMsg(spk.id, spk.pub[0], spk.pub[1]));
    } catch (e) { return false; }
  }
  async function genPair() {
    const pair = await crypto.subtle.generateKey(ALG, true, ["deriveBits"]);
    const j = await crypto.subtle.exportKey("jwk", pair.privateKey);
    return { x: j.x, y: j.y, d: j.d };
  }
  // key_ops у долговременного ключа приложения — ["deriveKey"]; для deriveBits берём только сами числа ключа.
  async function dh(priv, pubXY) {
    const privKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d, ext: true }, ALG, false, ["deriveBits"]);
    const pubKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: pubXY[0], y: pubXY[1], ext: true }, ALG, false, []);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pubKey }, privKey, 256));
  }
  async function hkdf(ikm, salt, info, bytes) {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) }, key, bytes * 8));
  }
  async function hmac(keyBytes, byte) {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([byte])));
  }
  async function kdfRK(rk, dhOut) { const out = await hkdf(dhOut, rk, "ether-dr-rk", 64); return [out.slice(0, 32), out.slice(32)]; }
  async function kdfCK(ck) { return [await hmac(ck, 2), await hmac(ck, 1)]; } // [следующая цепочка, ключ сообщения]
  async function aeadKey(mk) {
    const out = await hkdf(mk, new Uint8Array(32), "ether-dr-aead", 44);
    return { key: await crypto.subtle.importKey("raw", out.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]), iv: out.slice(32) };
  }
  function aad(from, to, h) { return te.encode(["ether-dr1", from, to, h.d[0], h.d[1], h.pn, h.n].join("|")); }
  async function initialSecret(myPriv, theirPubXY, myId, theirId) {
    const shared = await dh(myPriv, theirPubXY);
    const ids = [myId, theirId].sort().join("|");
    return hkdf(shared, te.encode("ether-dr-v1"), "ether-dr-init|" + ids, 32);
  }

  // ---------- состояние сессии ----------
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const dhKey = (xy) => xy[0] + "." + xy[1];

  async function newInitiator(myIdPriv, theirPubJwk, myId, theirId) {
    const theirXY = [theirPubJwk.x, theirPubJwk.y];
    const sk = await initialSecret(myIdPriv, theirXY, myId, theirId);
    const dhs = await genPair();
    const [rk, cks] = await kdfRK(sk, await dh(dhs, theirXY));
    return { id: b64(crypto.getRandomValues(new Uint8Array(6))), rk: b64(rk), dhs, dhr: theirXY, cks: b64(cks), ckr: null, ns: 0, nr: 0, pn: 0, sk: {}, skOrder: [], hist: [], init: true, t: Date.now() };
  }
  // Старт по prekey-пакету получателя (3DH/4DH).
  async function x3dhSecret(parts, myId, theirId) {
    return hkdf(concat(...parts), te.encode("ether-dr-x3dh-v1"), "ether-dr-x3dh|" + [myId, theirId].sort().join("|"), 32);
  }
  async function newInitiatorX(ctx, bundle) {
    const theirXY = [ctx.theirPubJwk.x, ctx.theirPubJwk.y], spkPub = bundle.spk.pub, opkPub = bundle.opk ? bundle.opk.pub : null;
    const ek = await genPair();
    const parts = [await dh(ctx.myPrivJwk, spkPub), await dh(ek, theirXY), await dh(ek, spkPub)];
    if (opkPub) parts.push(await dh(ek, opkPub));
    const sk = await x3dhSecret(parts, ctx.myId, ctx.contactId);
    const dhs = await genPair();
    const [rk, cks] = await kdfRK(sk, await dh(dhs, spkPub));
    return { id: b64(crypto.getRandomValues(new Uint8Array(6))), rk: b64(rk), dhs, dhr: [spkPub[0], spkPub[1]], cks: b64(cks), ckr: null, ns: 0, nr: 0, pn: 0, sk: {}, skOrder: [], hist: [], init: true,
      px: { e: [ek.x, ek.y], s: bundle.spk.id, o: bundle.opk ? bundle.opk.id : null }, t: Date.now() };
  }
  async function newResponderX(ctx, p) {
    const store = pk();
    const spk = store.spk && store.spk.id === p.s ? store.spk : store.old.find((o) => o.id === p.s);
    if (!spk) throw new Error("ratchet: unknown prekey");
    const opk = p.o ? store.opks[p.o] : null;
    if (p.o && !opk) throw new Error("ratchet: unknown one-time prekey");
    const ikA = [ctx.theirPubJwk.x, ctx.theirPubJwk.y];
    const parts = [await dh(spk, ikA), await dh(ctx.myPrivJwk, p.e), await dh(spk, p.e)];
    if (opk) parts.push(await dh(opk, p.e));
    const sk = await x3dhSecret(parts, ctx.myId, ctx.contactId);
    return { s: { id: b64(crypto.getRandomValues(new Uint8Array(6))), rk: b64(sk), dhs: { x: spk.x, y: spk.y, d: spk.d }, dhr: null, cks: null, ckr: null, ns: 0, nr: 0, pn: 0, sk: {}, skOrder: [], hist: [], init: false, t: Date.now() }, opkId: p.o || null };
  }

  async function newResponder(myIdPriv, theirPubJwk, myId, theirId) {
    const sk = await initialSecret(myIdPriv, [theirPubJwk.x, theirPubJwk.y], myId, theirId);
    return { id: b64(crypto.getRandomValues(new Uint8Array(6))), rk: b64(sk), dhs: { x: myIdPriv.x, y: myIdPriv.y, d: myIdPriv.d }, dhr: null, cks: null, ckr: null, ns: 0, nr: 0, pn: 0, sk: {}, skOrder: [], hist: [], init: false, t: Date.now() };
  }

  async function encryptWith(s, from, to, plain) {
    const [nextCk, mk] = await kdfCK(unb64(s.cks));
    s.cks = b64(nextCk);
    const h = { d: [s.dhs.x, s.dhs.y], pn: s.pn, n: s.ns };
    s.ns++;
    const { key, iv } = await aeadKey(mk);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(from, to, h) }, key, te.encode(JSON.stringify(plain))));
    const env = { v: 2, h, ct: b64(ct), rc: 1 };
    if (s.init) { env.h.i = 1; if (s.px) env.h.p = s.px; }
    return env;
  }

  async function skipKeys(s, until) {
    if (s.ckr === null) return;
    if (until - s.nr > MAX_SKIP) throw new Error("too many skipped messages");
    let ck = unb64(s.ckr);
    while (s.nr < until) {
      const [next, mk] = await kdfCK(ck);
      ck = next;
      const id = dhKey(s.dhr) + "|" + s.nr;
      s.sk[id] = b64(mk); s.skOrder.push(id);
      s.nr++;
    }
    s.ckr = b64(ck);
    while (s.skOrder.length > MAX_SKIPPED_STORED) delete s.sk[s.skOrder.shift()];
  }

  async function decryptWith(s, from, to, env) {
    const h = env.h; const ct = unb64(env.ct);
    const open = async (mk) => {
      const { key, iv } = await aeadKey(mk);
      try { return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(from, to, h) }, key, ct))); }
      catch (e) { throw new Error("ratchet: auth failed"); }
    };
    const skId = dhKey(h.d) + "|" + h.n;
    if (s.sk[skId]) {
      const mk = unb64(s.sk[skId]);
      const plain = await open(mk);
      delete s.sk[skId]; s.skOrder = s.skOrder.filter((x) => x !== skId);
      return plain;
    }
    if (!s.dhr || dhKey(s.dhr) !== dhKey(h.d)) {
      if (s.dhr) { await skipKeys(s, h.pn); }
      s.pn = s.ns; s.ns = 0; s.nr = 0;
      s.dhr = [h.d[0], h.d[1]];
      s.hist = [dhKey(s.dhr)].concat(s.hist.filter((x) => x !== dhKey(s.dhr))).slice(0, HIST);
      const [rk1, ckr] = await kdfRK(unb64(s.rk), await dh(s.dhs, s.dhr));
      s.ckr = b64(ckr);
      s.dhs = await genPair();
      const [rk2, cks] = await kdfRK(rk1, await dh(s.dhs, s.dhr));
      s.rk = b64(rk2); s.cks = b64(cks);
      s.init = false;
    }
    if (h.n < s.nr) throw new Error("ratchet: duplicate or old message");
    await skipKeys(s, h.n);
    const [nextCk, mk] = await kdfCK(unb64(s.ckr));
    const plain = await open(mk);
    s.ckr = b64(nextCk); s.nr++;
    return plain;
  }

  // ---------- очередь по контактам (операции асинхронны, состояние должно меняться строго по порядку) ----------
  const chains = new Map();
  function serial(contactId, fn) {
    const prev = chains.get(contactId) || Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(contactId, run.catch(() => {}));
    return run;
  }

  function sessionsOf(contactId) { const d = getDb().s; return d[contactId] || (d[contactId] = []); }

  // Зашифровать объект для контакта. Состояние сохраняется ДО возврата: ключ нельзя использовать дважды даже при падении.
  function encrypt(ctx, plain) {
    return serial(ctx.contactId, async () => {
      const list = sessionsOf(ctx.contactId);
      if (!list.length) {
        let bundle = null;
        if (ctx.getBundle) { try { bundle = await ctx.getBundle(); } catch (e) { bundle = null; } }
        const okPub = (x) => Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === "string" && v.length > 0 && v.length <= 100);
        // Подпись есть и не сходится — пакет подменён/испорчен, начинаем от долговременных ключей; подписи нет (старый клиент) — принимаем как раньше
        if (bundle && bundle.spk && bundle.spk.sig != null && ctx.theirPubJwk && !(await verifySpk(ctx.theirPubJwk, bundle.spk))) bundle = null;
        const usable = bundle && bundle.spk && typeof bundle.spk.id === "string" && okPub(bundle.spk.pub) && (!bundle.opk || (typeof bundle.opk.id === "string" && okPub(bundle.opk.pub)));
        list.unshift(usable ? await newInitiatorX(ctx, bundle) : await newInitiator(ctx.myPrivJwk, ctx.theirPubJwk, ctx.myId, ctx.contactId));
      }
      const s = list[0];
      const env = await encryptWith(s, ctx.myId, ctx.contactId, plain);
      s.t = Date.now();
      persist();
      return env;
    });
  }

  // Расшифровать. Пробуем сессии от новой к старой; если не подошла ни одна, а конверт помечен «начальный» (h.i)
  // и ключ собеседника не из уже известных — открываем новую сессию как получатель.
  function decrypt(ctx, env) {
    return serial(ctx.contactId, async () => {
      if (!env || env.v !== 2 || !env.h || !Array.isArray(env.h.d) || env.h.d.length !== 2 || typeof env.ct !== "string") throw new Error("ratchet: bad envelope");
      const list = sessionsOf(ctx.contactId);
      const from = ctx.contactId, to = ctx.myId;
      let lastErr = null;
      for (let i = 0; i < list.length; i++) {
        const trial = clone(list[i]);
        try {
          const plain = await decryptWith(trial, from, to, env);
          list[i] = trial;
          if (i > 0) { list.splice(i, 1); list.unshift(trial); } // сессия, на которой нам отвечают, становится основной
          trial.t = Date.now();
          persist();
          return plain;
        } catch (e) { lastErr = e; }
      }
      const known = list.some((s) => (s.hist || []).includes(dhKey(env.h.d)));
      if (env.h.i === 1 && !known) {
        let s, opkId = null;
        const p = env.h.p;
        if (p) {
          const okPub = (x) => Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === "string" && v.length > 0 && v.length <= 100);
          if (!okPub(p.e) || typeof p.s !== "string" || (p.o != null && typeof p.o !== "string")) throw new Error("ratchet: bad prekey header");
          const r = await newResponderX(ctx, p); s = r.s; opkId = r.opkId;
        } else {
          s = await newResponder(ctx.myPrivJwk, ctx.theirPubJwk, ctx.myId, from);
        }
        const plain = await decryptWith(s, from, to, env);
        if (opkId) delete pk().opks[opkId]; // одноразовый ключ использован и уничтожен
        list.unshift(s);
        while (list.length > MAX_SESSIONS) list.pop();
        persist();
        return plain;
      }
      throw lastErr || new Error("ratchet: no session");
    });
  }

  // ---------- prekeys получателя ----------
  const SPK_ROTATE_MS = 7 * 24 * 3600 * 1000, SPK_KEEP_OLD = 3, OPK_STORE_MAX = 200, OPK_WANT = 20;
  function pk() { const d = getDb(); if (!d.pk.opks) d.pk.opks = {}; if (!d.pk.old) d.pk.old = []; return d.pk; }
  function rid() { return b64(crypto.getRandomValues(new Uint8Array(9))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  // Нужно ли пополнить запас на сервере: нет spk, пора менять spk, или одноразовых там меньше OPK_WANT.
  function needsPrekeys(serverCount) { const p = pk(); return !p.spk || Date.now() - p.spk.t > SPK_ROTATE_MS || !(serverCount >= OPK_WANT); }
  // Готовит публичную часть для загрузки на сервер: текущий spk (меняется раз в неделю, старые ещё живут) и count новых одноразовых.
  async function prekeyUploadPayload(count, myPrivJwk) {
    const p = pk(), now = Date.now();
    if (!p.spk || now - p.spk.t > SPK_ROTATE_MS) {
      if (p.spk) p.old.unshift(p.spk);
      p.old = p.old.slice(0, SPK_KEEP_OLD);
      const pair = await genPair();
      p.spk = { id: rid(), x: pair.x, y: pair.y, d: pair.d, t: now };
    }
    const fresh = [];
    for (let i = 0; i < count; i++) {
      const pair = await genPair(), id = rid();
      p.opks[id] = { x: pair.x, y: pair.y, d: pair.d, t: now };
      fresh.push({ id, pub: [pair.x, pair.y] });
    }
    const ids = Object.keys(p.opks);
    if (ids.length > OPK_STORE_MAX) for (const id of ids.slice(0, ids.length - OPK_STORE_MAX)) delete p.opks[id];
    persist();
    if (myPrivJwk && !p.spk.sig) { try { p.spk.sig = await signSpk(myPrivJwk, p.spk.id, p.spk.x, p.spk.y); persist(); } catch (e) {} }
    return { spk: { id: p.spk.id, pub: [p.spk.x, p.spk.y], ...(p.spk.sig ? { sig: p.spk.sig } : {}) }, opks: fresh };
  }

  function reset(contactId) { const d = getDb().s; if (d[contactId]) { delete d[contactId]; persist(); } }
  function resetAll() { db = { s: {}, pk: {} }; persist(); }
  function info(contactId) { const l = (getDb().s[contactId] || []); return l.length ? l.length + " сесс., основная: ns=" + l[0].ns + " nr=" + l[0].nr + (l[0].init ? " (ждёт ответа)" : "") : "нет"; }

  return { encrypt, decrypt, reset, resetAll, setStore, info, needsPrekeys, prekeyUploadPayload, verifySpk, signSpk };
})();
if (typeof module !== "undefined") module.exports = Ratchet;
