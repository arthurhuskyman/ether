// Сертификаты устройств аккаунта (docs/MULTIDEVICE.md, этап 2: подготовка). Основной ключ личности (P-256, как в ratchet.signSpk) остаётся
// на основном устройстве и подписывает: (1) сертификат отдельной пары ключей устройства: id, deviceId, публичный ключ, метка, срок;
// (2) список устройств аккаунта с монотонным seq и списком отозванных. Контакты принимают список только с валидной подписью основного
// ключа и seq больше уже виденного; сервер лишь хранит и отдаёт этот список и подписать/подменить его не может.
const DeviceCert = (() => {
  const te = new TextEncoder();
  const ALG = { name: "ECDSA", namedCurve: "P-256" }, SIG = { name: "ECDSA", hash: "SHA-256" };
  const MAX_TTL_MS = 365 * 86400_000, MAX_DEVICES = 8;
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const unb64 = (str) => { const s = atob(str); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; };
  const clean = (s) => String(s == null ? "" : s).replace(/[|\n\r]/g, " ").slice(0, 40);
  const certMsg = (c) => te.encode(["ether-devcert-v1", c.id, c.devId, c.pub.x, c.pub.y, clean(c.label), c.created, c.expires].join("|"));
  const listMsg = (l) => te.encode(["ether-devlist-v1", l.id, l.seq, l.ts, (l.certs || []).map((c) => c.devId + ":" + c.sig).join(","), (l.revoked || []).join(",")].join("|"));
  const signKey = (p) => crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: p.x, y: p.y, d: p.d, ext: true }, ALG, false, ["sign"]);
  const verKey = (p) => crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: p.x, y: p.y, ext: true }, ALG, false, ["verify"]);
  const sign = async (priv, msg) => b64(new Uint8Array(await crypto.subtle.sign(SIG, await signKey(priv), msg)));
  const verify = async (pub, sig, msg) => { try { return await crypto.subtle.verify(SIG, await verKey(pub), unb64(sig), msg); } catch (e) { return false; } };

  async function genDeviceKey() {
    const kp = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    return { priv: { x: jwk.x, y: jwk.y, d: jwk.d }, pub: { x: jwk.x, y: jwk.y } };
  }
  const newDeviceId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  async function issue(identityPriv, { id, devId, pub, label, ttlMs, now }) {
    const created = now || Date.now(), c = { id, devId, pub: { x: pub.x, y: pub.y }, label: clean(label), created, expires: created + Math.min(ttlMs || MAX_TTL_MS, MAX_TTL_MS) };
    c.sig = await sign(identityPriv, certMsg(c)); return c;
  }
  async function verifyCert(identityPub, cert, now) {
    if (!cert || typeof cert !== "object" || !cert.pub || typeof cert.sig !== "string" || !/^[0-9a-f]{16}$/.test(cert.devId || "")) return false;
    const t = now || Date.now();
    if (!(cert.expires > t) || cert.created > t + 5 * 60_000 || cert.expires - cert.created > MAX_TTL_MS) return false;
    return verify(identityPub, cert.sig, certMsg(cert));
  }
  async function signList(identityPriv, { id, seq, certs, revoked, now }) {
    const l = { id, seq, ts: now || Date.now(), certs: (certs || []).slice(0, MAX_DEVICES), revoked: (revoked || []).slice(0, 64) };
    l.sig = await sign(identityPriv, listMsg(l)); return l;
  }
  // Возвращает {ok, certs}: только действующие сертификаты, не отозванные и с валидной подписью каждого; seq должен быть > minSeq.
  async function verifyList(identityPub, id, list, { minSeq = 0, now } = {}) {
    if (!list || list.id !== id || typeof list.sig !== "string" || !Number.isSafeInteger(list.seq) || list.seq <= minSeq || !Array.isArray(list.certs) || list.certs.length > MAX_DEVICES) return { ok: false, certs: [] };
    if (!(await verify(identityPub, list.sig, listMsg(list)))) return { ok: false, certs: [] };
    const rev = new Set(list.revoked || []), good = [];
    for (const c of list.certs) if (c.id === id && !rev.has(c.devId) && await verifyCert(identityPub, c, now)) good.push(c);
    return { ok: true, certs: good };
  }
  // Отпечаток устройства для показа пользователю и сверки (как safety number): 5 групп по 4 hex из SHA-256 публичного ключа устройства.
  async function fingerprint(cert) {
    const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(cert.devId + "|" + cert.pub.x + "|" + cert.pub.y))), (b) => b.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 20).match(/.{4}/g).join(" ");
  }
  return { genDeviceKey, newDeviceId, issue, verifyCert, signList, verifyList, fingerprint, MAX_DEVICES };
})();
if (typeof module !== "undefined") module.exports = DeviceCert;
