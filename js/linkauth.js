// Аутентификация P2P-канала: привязка DTLS-отпечатков к долговременным ключам личности.
//
// Проблема: WebRTC шифрует канал через DTLS, но отпечатки сертификатов обе стороны получают через сигнальный сервер.
// Недобросовестный сервер мог бы подставить свои отпечатки и стать «человеком посередине» (канал был бы зашифрован,
// но с ним, а не с собеседником). Здесь стороны после открытия канала доказывают друг другу, что знают общий секрет,
// который выводится из долговременных ключей ECDH (его сервер не знает), и что видят ОДНИ И ТЕ ЖЕ отпечатки.
// Если отпечатки подменены, теги не совпадут, и канал закрывается.
//
//   K  = HKDF(ECDH(мой секретный, их публичный), info = отсортированные id)
//   tag(отправитель) = HMAC(K, "ether-linkauth1" | id отправителя | id получателя | нонс отправителя | нонс получателя | отпечатки)
//
// Отпечатки берутся парой (мой, их) и сортируются, поэтому обе стороны считают одну и ту же строку. Свежие нонсы с обеих сторон
// исключают повтор старого обмена. Это даёт подлинность канала и всех звонков по нему (медиа идёт тем же DTLS).
//
// ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (осознанно не меняется): привязка работает «в открытую» (fail-open) для собеседника, который ещё ни разу не
// проходил проверку. Если auth-сообщения теряются/блокируются (в том числе активным посредником), по истечении таймаута
// authTimeout() в app.js даёт результат "unverified", а не "fail", и канал остаётся рабочим — иначе старые клиенты без linkauth
// перестали бы соединяться. Защита включается после первой успешной проверки (contact.authSeen): дальше молчание = "fail".
const LinkAuth = (() => {
  const te = new TextEncoder();
  const ALG = { name: "ECDH", namedCurve: "P-256" };
  function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(str) { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

  function nonce() { return b64(crypto.getRandomValues(new Uint8Array(16))); }

  async function secret(myPrivJwk, theirPubJwk, myId, theirId) {
    // key_ops у ключа приложения — ["deriveKey"]; для deriveBits берём только числа ключа
    const priv = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: myPrivJwk.x, y: myPrivJwk.y, d: myPrivJwk.d, ext: true }, ALG, false, ["deriveBits"]);
    const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: theirPubJwk.x, y: theirPubJwk.y, ext: true }, ALG, false, []);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
    const ikm = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
    const info = te.encode("ether-linkauth-key|" + [myId, theirId].sort().join("|"));
    const k = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: te.encode("ether-linkauth-v1"), info }, ikm, 256));
    return crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }

  function message(senderId, receiverId, senderNonce, receiverNonce, fpA, fpB) {
    const fps = [fpA, fpB].map((x) => String(x || "").toLowerCase()).sort().join("|");
    return te.encode(["ether-linkauth1", senderId, receiverId, senderNonce, receiverNonce, fps].join("|"));
  }
  async function tag(key, senderId, receiverId, senderNonce, receiverNonce, fpLocal, fpRemote) {
    return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, message(senderId, receiverId, senderNonce, receiverNonce, fpLocal, fpRemote))));
  }
  async function verify(key, tagB64, senderId, receiverId, senderNonce, receiverNonce, fpLocal, fpRemote) {
    try { return await crypto.subtle.verify("HMAC", key, unb64(tagB64), message(senderId, receiverId, senderNonce, receiverNonce, fpLocal, fpRemote)); }
    catch (e) { return false; }
  }
  return { nonce, secret, tag, verify };
})();
if (typeof module !== "undefined") module.exports = LinkAuth;
