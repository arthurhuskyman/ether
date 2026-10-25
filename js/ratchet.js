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
  const RI_MAX = 200;            // сколько идентификаторов уже принятых начальных конвертов помним на контакт
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
    // true — записано; false — не удалось (квота и т.п.). Внешние хранилища, вернувшие undefined, считаем успешными; throw = неудача.
    save(obj) { try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); return true; } catch (e) { return false; } },
  };
  function setStore(s) { store = s; db = null; dirty = false; }
  let db = null;
  // dirty: продвинутое состояние есть только в памяти (запись не удалась). Пока не удастся сохранить, encrypt() отказывается:
  // иначе после перезагрузки ключ/IV сообщения могли бы быть использованы повторно (AES-GCM nonce reuse).
  let dirty = false;
  function getDb() {
    if (!db) {
      const raw = store.load() || {};
      db = { s: raw.s && typeof raw.s === "object" ? raw.s : {}, pk: raw.pk && typeof raw.pk === "object" ? raw.pk : {},
        ri: raw.ri && typeof raw.ri === "object" ? raw.ri : {}, sg: raw.sg && typeof raw.sg === "object" ? raw.sg : {},
        ca: raw.ca && typeof raw.ca === "object" ? raw.ca : {},
        // v3 (см. docs/THREAT-MODEL.md): cv — достигнутый ПРОВЕРЕННЫМ (расшифрованным) конвертом уровень AAD контакта (2|3), «липкий»;
        // cp — его проверенные возможности (из шифртекста), cb — возможности из подписанного prekey-пакета, ch — НЕпроверенная подсказка из конверта,
        // b2 — контакт хоть раз присылал пакет с расширением (caps/KEM) под подписью личности.
        cv: raw.cv && typeof raw.cv === "object" ? raw.cv : {}, cp: raw.cp && typeof raw.cp === "object" ? raw.cp : {},
        cb: raw.cb && typeof raw.cb === "object" ? raw.cb : {}, ch: raw.ch && typeof raw.ch === "object" ? raw.ch : {},
        b2: raw.b2 && typeof raw.b2 === "object" ? raw.b2 : {} };
    }
    return db;
  }
  function persist() {
    let ok = false;
    try { ok = store.save(getDb()) !== false; } catch (e) { ok = false; }
    if (!ok) { dirty = true; throw new Error("ratchet: persist failed"); }
    dirty = false;
  }
  // Для операций, которые не расходуют ключи сообщений (prekeys, reset): неудача не бросается, но помечает состояние как «грязное».
  function persistSoft() { try { persist(); } catch (e) { /* dirty уже выставлен */ } }

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
  // Расширение пакета (v3): подпись sig2 покрывает id, ключ, биты возможностей c и открытый ключ ML-KEM (kem). Старая подпись sig (только id|x|y) остаётся —
  // старые клиенты и старые серверы, отрезавшие новые поля, продолжают работать; сервер не может ни добавить, ни убрать c/kem незаметно для новых клиентов.
  const SPK_SIG2_DOMAIN = "ether-spk-v2|";
  const spkMsg2 = (id, x, y, c, kem) => te.encode(SPK_SIG2_DOMAIN + [id, x, y, c, kem].join("|"));
  async function signSpk2(priv, id, x, y, c, kem) {
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return b64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, spkMsg2(id, x, y, c, kem))));
  }
  async function verifySpk2(theirPub, spk) {
    try {
      if (!spk || typeof spk.sig2 !== "string" || spk.sig2.length > 200 || !Array.isArray(spk.pub) || !Number.isInteger(spk.c) || typeof spk.kem !== "string") return false;
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: theirPub.x, y: theirPub.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64(spk.sig2), spkMsg2(spk.id, spk.pub[0], spk.pub[1], spk.c, spk.kem));
    } catch (e) { return false; }
  }
  async function sha256b64(bytes) { return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))); }

  // ---------- ML-KEM-768 (FIPS 203): нативный WebCrypto, если есть и прошёл самопроверку против вшитой реализации, иначе js/vendor/ml-kem768.js ----------
  const KEM_NAME = "ML-KEM-768", KEM_PUB = 1184, KEM_CT = 1088, KEM_SEED = 64;
  const Kem = (() => {
    let nativeState = null; // null — не проверяли; true/false
    const soft = () => {
      let m = typeof globalThis !== "undefined" ? globalThis.EtherMlKem768 : null;
      if (!m && typeof require === "function") { try { require("./vendor/ml-kem768.js"); m = globalThis.EtherMlKem768; } catch (e) { m = null; } }
      return m || null;
    };
    const sub = () => (typeof crypto !== "undefined" && crypto.subtle) || null;
    async function nativeKeygen() {
      const s = sub(), pair = await s.generateKey({ name: KEM_NAME }, true, ["encapsulateBits", "decapsulateBits"]);
      return { seed: new Uint8Array(await s.exportKey("raw-seed", pair.privateKey)), pub: new Uint8Array(await s.exportKey("raw-public", pair.publicKey)) };
    }
    async function nativeEncaps(pub) {
      const s = sub(), k = await s.importKey("raw-public", pub, { name: KEM_NAME }, false, ["encapsulateBits"]);
      const r = await s.encapsulateBits({ name: KEM_NAME }, k);
      return { ct: new Uint8Array(r.ciphertext), ss: new Uint8Array(r.sharedKey) };
    }
    async function nativeDecaps(seed, ct) {
      const s = sub(), k = await s.importKey("raw-seed", seed, { name: KEM_NAME }, false, ["decapsulateBits"]);
      return new Uint8Array(await s.decapsulateBits({ name: KEM_NAME }, k, ct));
    }
    // Самопроверка нативной реализации против вшитой в обе стороны; любое расхождение/ошибка — навсегда используем вшитую.
    async function useNative() {
      if (nativeState !== null) return nativeState;
      nativeState = false;
      const m = soft(), s = sub();
      if (!m || !s || typeof s.encapsulateBits !== "function") return false;
      try {
        const a = await nativeKeygen(), e1 = await nativeEncaps(a.pub), ref = m.keygen(a.seed), e2 = m.encapsulate(a.pub);
        const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
        nativeState = eq(ref.publicKey, a.pub) && eq(m.decapsulate(e1.ct, ref.secretKey), e1.ss) && eq(await nativeDecaps(a.seed, e2.cipherText), e2.sharedSecret);
      } catch (e) { nativeState = false; }
      return nativeState;
    }
    return {
      available() { return !!soft() || nativeState === true; },
      async backend() { return (await useNative()) ? "webcrypto" : (soft() ? "vendor" : "none"); },
      _reset() { nativeState = null; },
      async keygen() {
        if (await useNative()) { try { return await nativeKeygen(); } catch (e) { nativeState = false; } }
        const m = soft(); if (!m) throw new Error("ratchet: no kem");
        const seed = crypto.getRandomValues(new Uint8Array(KEM_SEED)), r = m.keygen(seed);
        return { seed, pub: r.publicKey };
      },
      async encaps(pub) {
        if (!(pub instanceof Uint8Array) || pub.length !== KEM_PUB) throw new Error("ratchet: bad kem key");
        if (await useNative()) { try { return await nativeEncaps(pub); } catch (e) { nativeState = false; } }
        const m = soft(); if (!m) throw new Error("ratchet: no kem");
        const r = m.encapsulate(pub); return { ct: r.cipherText, ss: r.sharedSecret };
      },
      async decaps(seed, ct) {
        if (!(ct instanceof Uint8Array) || ct.length !== KEM_CT || !(seed instanceof Uint8Array) || seed.length !== KEM_SEED) throw new Error("ratchet: bad kem ct");
        if (await useNative()) { try { return await nativeDecaps(seed, ct); } catch (e) { nativeState = false; } }
        const m = soft(); if (!m) throw new Error("ratchet: no kem");
        return m.decapsulate(ct, m.keygen(seed).secretKey);
      },
    };
  })();

  // ---------- возможности (битовая маска) и дополнение до корзин ----------
  // A3 — AAD v3 (возможности и начальный заголовок под AEAD), PQ1 — гибридный старт ML-KEM-768, PAD1 — выравнивание размера открытого текста.
  const CAP = { A3: 1, PQ1: 2, PAD1: 4 }, LOCAL_CAPS = 7;
  const PAD_BUCKETS = [256, 1024, 4096, 16384], PAD_STEP = 65536, PAD_MAX = 2 * 1024 * 1024; // сверх PAD_MAX не дополняем: серверный потолок конверта не должен превышаться
  function padBucket(n) {
    for (const b of PAD_BUCKETS) if (n <= b) return b;
    return Math.ceil(n / PAD_STEP) * PAD_STEP;
  }
  // Кадр v3 внутри AEAD: [3][caps][длина JSON, uint32 BE][JSON][нули до корзины]. Длина и caps аутентифицированы вместе с остальным шифртекстом.
  function frameEncode(json, caps, pad) {
    const body = te.encode(json), n = 6 + body.length;
    const total = pad && n <= PAD_MAX ? padBucket(n) : n;
    const out = new Uint8Array(total);
    out[0] = 3; out[1] = caps & 255;
    out[2] = (body.length >>> 24) & 255; out[3] = (body.length >>> 16) & 255; out[4] = (body.length >>> 8) & 255; out[5] = body.length & 255;
    out.set(body, 6);
    return out;
  }
  function frameDecode(bytes) {
    if (bytes.length < 6 || bytes[0] !== 3) throw new Error("ratchet: bad frame");
    const len = ((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) >>> 0;
    if (len > bytes.length - 6) throw new Error("ratchet: bad frame");
    for (let i = 6 + len; i < bytes.length; i++) if (bytes[i] !== 0) throw new Error("ratchet: bad frame");
    return { caps: bytes[1], json: td.decode(bytes.subarray(6, 6 + len)) };
  }
  const envLevel = (env) => (env && env.a === 3 ? 3 : env && env.a === 1 ? 2 : 1);

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
  // AAD v1 (старые клиенты) не покрывает h.i и h.p. AAD v2 (env.a === 1) добавляет их: флаг «начальный» и prekey-заголовок (e, s, o) нельзя подменить.
  // v2 шлём только контакту, чей клиент заявил поддержку (ca[contact], см. noteCap); старые клиенты v2 не расшифруют.
  // AAD v3 (env.a === 3): всё из v2 плюс биты возможностей h.c и все поля prekey-заголовка (в т.ч. шифртекст KEM p.k и версия p.v).
  function aad(from, to, h, level) {
    if (level === 3) {
      const p = h.p && typeof h.p === "object" ? h.p : null;
      const px = p ? ["p", Array.isArray(p.e) ? p.e.join(".") : "", p.s == null ? "" : p.s, p.o == null ? "" : p.o, p.k == null ? "" : p.k, p.v == null ? "" : p.v].join(",") : "-";
      return te.encode(["ether-dr3", from, to, h.d[0], h.d[1], h.pn, h.n, h.i === 1 ? 1 : 0, px, Number.isInteger(h.c) ? h.c : -1].join("|"));
    }
    const v2 = level === 2;
    if (!v2) return te.encode(["ether-dr1", from, to, h.d[0], h.d[1], h.pn, h.n].join("|"));
    const p = h.p && typeof h.p === "object" ? h.p : null;
    const px = p ? ["p", Array.isArray(p.e) ? p.e.join(".") : "", p.s == null ? "" : p.s, p.o == null ? "" : p.o].join(",") : "-";
    return te.encode(["ether-dr2", from, to, h.d[0], h.d[1], h.pn, h.n, h.i === 1 ? 1 : 0, px].join("|"));
  }
  // НЕпроверенные подсказки о возможностях собеседника (поля конверта ac / cp не под AEAD, сервер может их убрать или добавить): годятся лишь чтобы ПОПРОБОВАТЬ
  // повысить уровень. Понижать уровень они не могут — этим занимается «липкий» cv (только по успешно расшифрованным конвертам).
  function noteCap(contactId, env) {
    const d = getDb(), want = env && env.ac === 1, cp = env && Number.isInteger(env.cp) && env.cp >= 0 && env.cp <= 255 ? env.cp : 0;
    if (want) d.ca[contactId] = 1; else delete d.ca[contactId];
    if (cp) d.ch[contactId] = cp; else delete d.ch[contactId];
  }
  // Проверенное знание: конверт открылся (AEAD) на уровне level с возможностями caps (для v3 — из шифртекста).
  function noteAuth(contactId, level, caps) {
    const d = getDb();
    if (level >= 2 && (d.cv[contactId] | 0) < level) d.cv[contactId] = level;
    if (level === 3) d.cp[contactId] = caps | 0;
  }
  // Уровень и возможности для отправки контакту. Уровень не падает ниже проверенного (cv): без этого сервер, убрав ac, мог бы заставить нас слать слабый AAD v1.
  function sendLevel(contactId, v3Ok) {
    const d = getDb(), hint = d.ch[contactId] | 0, auth = (d.cp[contactId] | 0) | (d.cb[contactId] | 0);
    let lvl = d.cv[contactId] | 0;
    if (((hint | auth) & CAP.A3)) lvl = 3; else if (lvl < 2 && d.ca[contactId]) lvl = 2;
    if (lvl < 1) lvl = 1;
    if (lvl === 3 && v3Ok === false) lvl = 1; // сервер без pq1 вырежет поля a/cp: v3 до адресата не дойдёт
    return { level: lvl, caps: hint | auth };
  }
  let warnHook = null;
  function warn(contactId, code) { try { if (warnHook) warnHook(contactId, code); } catch (e) {} }
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
  // v3: в HKDF входят (info) биты возможностей и ВЕСЬ начальный заголовок (ek, id spk/opk, хэши открытого ключа и шифртекста KEM), а секрет KEM — в ikm.
  // Любая правка заголовка в пути даёт другой SK (и, кроме того, другой AAD) — расшифровка не удастся, тихого понижения нет.
  async function x3dhSecret3(parts, myId, theirId, bind) {
    return hkdf(concat(...parts), te.encode("ether-dr-x3dh-v3"), "ether-dr-x3dh3|" + [myId, theirId].sort().join("|") + "|" + bind, 32);
  }
  async function bindString(caps, e, sId, oId, kemPubBytes, kemCtBytes) {
    return ["v3", caps, e[0] + "." + e[1], sId, oId || "", kemPubBytes ? await sha256b64(kemPubBytes) : "", kemCtBytes ? await sha256b64(kemCtBytes) : ""].join("|");
  }
  // ext = { c, kem } из ПРОВЕРЕННОГО (sig2) пакета или null; v3 — используем ли формат v3 (иначе поведение прежнее, байт в байт).
  async function newInitiatorX(ctx, bundle, v3, ext, caps) {
    const theirXY = [ctx.theirPubJwk.x, ctx.theirPubJwk.y], spkPub = bundle.spk.pub, opkPub = bundle.opk ? bundle.opk.pub : null;
    const ek = await genPair();
    const parts = [await dh(ctx.myPrivJwk, spkPub), await dh(ek, theirXY), await dh(ek, spkPub)];
    if (opkPub) parts.push(await dh(ek, opkPub));
    let kemCt = null, sk;
    if (v3) {
      let kemPub = null;
      if (ext && (ext.c & CAP.PQ1) && ctx.pq !== false && Kem.available()) {
        kemPub = unb64(ext.kem);
        const r = await Kem.encaps(kemPub); kemCt = r.ct; parts.push(r.ss);
      }
      sk = await x3dhSecret3(parts, ctx.myId, ctx.contactId, await bindString(caps, [ek.x, ek.y], bundle.spk.id, bundle.opk ? bundle.opk.id : null, kemPub, kemCt));
    } else sk = await x3dhSecret(parts, ctx.myId, ctx.contactId);
    const dhs = await genPair();
    const [rk, cks] = await kdfRK(sk, await dh(dhs, spkPub));
    return { id: b64(crypto.getRandomValues(new Uint8Array(6))), rk: b64(rk), dhs, dhr: [spkPub[0], spkPub[1]], cks: b64(cks), ckr: null, ns: 0, nr: 0, pn: 0, sk: {}, skOrder: [], hist: [], init: true,
      px: Object.assign({ e: [ek.x, ek.y], s: bundle.spk.id, o: bundle.opk ? bundle.opk.id : null }, v3 ? { v: 3 } : {}, kemCt ? { k: b64(kemCt) } : {}), pq: !!kemCt, t: Date.now() };
  }
  async function newResponderX(ctx, p, hc) {
    const store = pk();
    const spk = store.spk && store.spk.id === p.s ? store.spk : store.old.find((o) => o.id === p.s);
    if (!spk) throw new Error("ratchet: unknown prekey");
    const opk = p.o ? store.opks[p.o] : null;
    if (p.o && !opk) throw new Error("ratchet: unknown one-time prekey");
    const ikA = [ctx.theirPubJwk.x, ctx.theirPubJwk.y];
    const parts = [await dh(spk, ikA), await dh(ctx.myPrivJwk, p.e), await dh(spk, p.e)];
    if (opk) parts.push(await dh(opk, p.e));
    let sk, pq = false;
    if (p.v === 3) {
      let kemPub = null, kemCt = null;
      if (p.k != null) {
        if (!spk.ks || !spk.kem) throw new Error("ratchet: unknown kem key");
        kemPub = unb64(spk.kem); kemCt = unb64(p.k);
        parts.push(await Kem.decaps(unb64(spk.ks), kemCt)); pq = true;
      }
      sk = await x3dhSecret3(parts, ctx.myId, ctx.contactId, await bindString(hc, p.e, p.s, p.o, kemPub, kemCt));
    } else sk = await x3dhSecret(parts, ctx.myId, ctx.contactId);
    return { s: { id: b64(crypto.getRandomValues(new Uint8Array(6))), rk: b64(sk), pq, dhs: { x: spk.x, y: spk.y, d: spk.d }, dhr: null, cks: null, ckr: null, ns: 0, nr: 0, pn: 0, sk: {}, skOrder: [], hist: [], init: false, t: Date.now() }, opkId: p.o || null };
  }

  async function newResponder(myIdPriv, theirPubJwk, myId, theirId) {
    const sk = await initialSecret(myIdPriv, [theirPubJwk.x, theirPubJwk.y], myId, theirId);
    return { id: b64(crypto.getRandomValues(new Uint8Array(6))), rk: b64(sk), dhs: { x: myIdPriv.x, y: myIdPriv.y, d: myIdPriv.d }, dhr: null, cks: null, ckr: null, ns: 0, nr: 0, pn: 0, sk: {}, skOrder: [], hist: [], init: false, t: Date.now() };
  }

  async function encryptWith(s, from, to, plain, lv) {
    const [nextCk, mk] = await kdfCK(unb64(s.cks));
    s.cks = b64(nextCk);
    const h = { d: [s.dhs.x, s.dhs.y], pn: s.pn, n: s.ns };
    s.ns++;
    if (s.init) { h.i = 1; if (s.px) h.p = s.px; }
    const level = lv ? lv.level : 1;
    if (level === 3) h.c = LOCAL_CAPS;
    const { key, iv } = await aeadKey(mk);
    const json = JSON.stringify(plain);
    const data = level === 3 ? frameEncode(json, LOCAL_CAPS, !!(lv.caps & CAP.PAD1)) : te.encode(json);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(from, to, h, level) }, key, data));
    const env = { v: 2, h, ct: b64(ct), rc: 1, ac: 1, cp: LOCAL_CAPS }; // rc/ac/cp — подсказки вне AEAD; проверенные копии (h.c и кадр) есть только в v3
    if (level === 2) env.a = 1; else if (level === 3) env.a = 3;
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

  async function decryptWith(s, from, to, env, meta) {
    const h = env.h; const ct = unb64(env.ct), level = envLevel(env);
    const open = async (mk) => {
      const { key, iv } = await aeadKey(mk);
      try {
        const raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(from, to, h, level) }, key, ct));
        if (level !== 3) return JSON.parse(td.decode(raw));
        const f = frameDecode(raw);
        if (f.caps !== h.c) throw new Error("caps mismatch");
        if (meta) meta.caps = f.caps;
        return JSON.parse(f.json);
      }
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
      s.init = false; delete s.px; // prekey-заголовок нужен только пока ответа нет
      
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
      if (dirty) persist(); // прошлая запись не удалась: пробуем снова, иначе отказ (бросает 'ratchet: persist failed')
      const list = sessionsOf(ctx.contactId);
      let sawSigned = false;
      if (!list.length) {
        let bundle = null;
        if (ctx.getBundle) { try { bundle = await ctx.getBundle(); } catch (e) { bundle = null; } }
        const okPub = (x) => Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === "string" && v.length > 0 && v.length <= 100);
        // Подпись есть и не сходится — пакет подменён/испорчен, начинаем от долговременных ключей; подписи нет (старый клиент) — принимаем как раньше,
        // КРОМЕ контактов, чей пакет уже хоть раз приходил с верной подписью (флаг sg): для них пакет без подписи — понижение защиты, считаем недействительным.
        if (bundle && bundle.spk && ctx.theirPubJwk) {
          if (bundle.spk.sig != null) {
            if (await verifySpk(ctx.theirPubJwk, bundle.spk)) sawSigned = true; else bundle = null;
          } else if (getDb().sg[ctx.contactId]) bundle = null;
        }
        const usable = bundle && bundle.spk && typeof bundle.spk.id === "string" && okPub(bundle.spk.pub) && (!bundle.opk || (typeof bundle.opk.id === "string" && okPub(bundle.opk.pub)));
        list.unshift(usable ? await newInitiatorX(ctx, bundle) : await newInitiator(ctx.myPrivJwk, ctx.theirPubJwk, ctx.myId, ctx.contactId));
      }
      const s = list[0];
      const env = await encryptWith(s, ctx.myId, ctx.contactId, plain);
      s.t = Date.now();
      if (sawSigned) getDb().sg[ctx.contactId] = true;
      persist(); // не удалось — бросает: конверт не возвращаем (приложение откатится на прежний способ шифрования)
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
          noteCap(from, env);
          if (i > 0) { list.splice(i, 1); list.unshift(trial); } // сессия, на которой нам отвечают, становится основной
          trial.t = Date.now();
          // Выбор при неудаче записи: плайнтекст всё равно возвращаем (сообщение уже расшифровано, терять его хуже),
          // но состояние помечено dirty — следующий encrypt() не отдаст конверт, пока запись не удастся.
          persistSoft();
          return plain;
        } catch (e) { lastErr = e; }
      }
      const known = list.some((s) => (s.hist || []).includes(dhKey(env.h.d)));
      if (env.h.i === 1 && !known) {
        let s, opkId = null;
        const p = env.h.p;
        // Повтор давно использованного начального конверта (сессия уже вытеснена из списка) не должен создавать фиктивную сессию.
        const riId = dhKey(env.h.d) + "|" + (p && typeof p.s === "string" ? p.s + "|" + (typeof p.o === "string" ? p.o : "") : "-");
        const riList = getDb().ri[from] || (getDb().ri[from] = []);
        if (riList.includes(riId)) throw new Error("ratchet: replayed initial");
        if (p) {
          const okPub = (x) => Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === "string" && v.length > 0 && v.length <= 100);
          if (!okPub(p.e) || typeof p.s !== "string" || (p.o != null && typeof p.o !== "string")) throw new Error("ratchet: bad prekey header");
          const r = await newResponderX(ctx, p); s = r.s; opkId = r.opkId;
        } else {
          s = await newResponder(ctx.myPrivJwk, ctx.theirPubJwk, ctx.myId, from);
        }
        const plain = await decryptWith(s, from, to, env);
        // Удаление opk должно быть записано ДО выдачи plaintext: иначе после падения/перезагрузки opk «воскреснет» и позволит
        // расшифровать повтор. Не удалось записать — откатываем память и бросаем (сообщение придёт повторно).
        const opkSaved = opkId ? pk().opks[opkId] : null, capBefore = getDb().ca[from], listBefore = list.slice(), riBefore = riList.slice();
        if (opkId) delete pk().opks[opkId]; // одноразовый ключ использован и уничтожен
        list.unshift(s);
        while (list.length > MAX_SESSIONS) list.pop();
        riList.push(riId);
        while (riList.length > RI_MAX) riList.shift();
        noteCap(from, env);
        try { persist(); }
        catch (e) {
          if (opkId && opkSaved) pk().opks[opkId] = opkSaved;
          list.splice(0, list.length, ...listBefore); riList.splice(0, riList.length, ...riBefore);
          if (capBefore) getDb().ca[from] = capBefore; else delete getDb().ca[from];
          throw e;
        }
        return plain;
      }
      throw lastErr || new Error("ratchet: no session");
    });
  }

  // ---------- prekeys получателя ----------
  const SPK_ROTATE_MS = 7 * 24 * 3600 * 1000, SPK_KEEP_OLD = 3, OPK_STORE_MAX = 200, OPK_WANT = 20, OPK_TTL_MS = 60 * 24 * 3600 * 1000;
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
    // Сервер раздаёт загруженные opk, пока их не разберут: удалять «живые» нельзя (иначе первое сообщение придёт с «unknown one-time prekey»).
    // Вытесняем только давно загруженные (старше OPK_TTL_MS), а новых создаём не больше, чем осталось места.
    for (const id of Object.keys(p.opks)) if (now - (p.opks[id].t || 0) > OPK_TTL_MS) delete p.opks[id];
    count = Math.max(0, Math.min(count, OPK_STORE_MAX - Object.keys(p.opks).length));
    const fresh = [];
    for (let i = 0; i < count; i++) {
      const pair = await genPair(), id = rid();
      p.opks[id] = { x: pair.x, y: pair.y, d: pair.d, t: now };
      fresh.push({ id, pub: [pair.x, pair.y] });
    }
    persistSoft();
    if (myPrivJwk && !p.spk.sig) { try { p.spk.sig = await signSpk(myPrivJwk, p.spk.id, p.spk.x, p.spk.y); persistSoft(); } catch (e) {} }
    return { spk: { id: p.spk.id, pub: [p.spk.x, p.spk.y], ...(p.spk.sig ? { sig: p.spk.sig } : {}) }, opks: fresh };
  }

  function reset(contactId) { const d = getDb().s; if (d[contactId]) { delete d[contactId]; persistSoft(); } }
  function resetAll() { db = { s: {}, pk: {}, ri: {}, sg: {}, ca: {} }; persistSoft(); }
  function info(contactId) { const l = (getDb().s[contactId] || []); return l.length ? l.length + " сесс., основная: ns=" + l[0].ns + " nr=" + l[0].nr + (l[0].init ? " (ждёт ответа)" : "") : "нет"; }

  return { encrypt, decrypt, reset, resetAll, setStore, info, needsPrekeys, prekeyUploadPayload, verifySpk, signSpk };
})();
if (typeof module !== "undefined") module.exports = Ratchet;
