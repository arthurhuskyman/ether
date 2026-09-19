// Шифрование для офлайн-очереди.
//
// Пока оба устройства онлайн одновременно, сообщения идут напрямую по
// WebRTC data channel — сервер их вообще не видит. Но чтобы сообщение
// гарантированно дошло, даже если собеседник сейчас офлайн, его
// приходится на время класть на сервер (в памяти, не на диске — см.
// signaling-server/server.js). Чтобы даже в этом случае сервер видел
// только нечитаемый шифротекст, а не текст переписки, каждое устройство
// при первом запуске генерирует свою пару ключей ECDH; секретный ключ
// никогда никуда не отправляется, публичный — объявляется через
// сигнальный сервер (он не более чувствителен, чем открытый номер
// телефона в адресной книге). Отправитель и получатель совместно
// вычисляют общий секрет (алгоритм Диффи-Хеллмана) и им шифруют/
// расшифровывают сообщение через AES-GCM.

const CryptoHelper = (() => {
  async function generateKeyPair() {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    return { publicKeyJwk, privateKeyJwk };
  }

  async function importPrivateKey(jwk) {
    return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  }

  async function importPublicKey(jwk) {
    return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  }

  async function deriveSharedKey(myPrivateJwk, theirPublicJwk) {
    const privateKey = await importPrivateKey(myPrivateJwk);
    const publicKey = await importPublicKey(theirPublicJwk);
    return crypto.subtle.deriveKey(
      { name: "ECDH", public: publicKey },
      privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function fromBase64(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function encryptJson(sharedKey, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, bytes);
    return { iv: toBase64(iv), ct: toBase64(new Uint8Array(cipherBuf)) };
  }

  async function decryptJson(sharedKey, { iv, ct }) {
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv) },
      sharedKey,
      fromBase64(ct)
    );
    return JSON.parse(new TextDecoder().decode(plainBuf));
  }

  return { generateKeyPair, deriveSharedKey, encryptJson, decryptJson };
})();