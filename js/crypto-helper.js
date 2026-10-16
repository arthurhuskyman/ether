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

  // v — версия формата конверта (не самого алгоритма AES-GCM/ECDH, а структуры {iv, ct, v}).
  //   v:1 — без AAD (формат с самого начала; им же шифруются резервные копии).
  //   v:2 — AES-GCM с additionalData = utf8("ether-env-v2|"+fromId+"|"+toId): шифртекст привязан к направлению и паре участников, поэтому
  //         перехваченный конверт нельзя подсунуть другому адресату или выдать за сообщение в обратном направлении. Выпускается ТОЛЬКО когда
  //         вызывающий передал aad (приложение делает это, лишь если получатель заведомо умеет v2), иначе остаётся v1 — старые клиенты не теряют сообщения.
  // decryptJson принимает оба формата; v > ENVELOPE_VERSION — явная ошибка. Для v:2 без переданного aad расшифровка невозможна (бросает).
  const ENVELOPE_VERSION = 2;
  function envAad(fromId, toId) { return new TextEncoder().encode("ether-env-v2|" + fromId + "|" + toId); }
  async function encryptJson(sharedKey, obj, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const params = { name: "AES-GCM", iv };
    if (aad) params.additionalData = aad;
    const cipherBuf = await crypto.subtle.encrypt(params, sharedKey, bytes);
    return { iv: toBase64(iv), ct: toBase64(new Uint8Array(cipherBuf)), v: aad ? 2 : 1 };
  }

  async function decryptJson(sharedKey, { iv, ct, v }, aad) {
    // v отсутствует — конверт от версии до введения этого поля; обрабатываем как v1. Неизвестная БУДУЩАЯ версия — явная ошибка.
    if (v !== undefined && v > ENVELOPE_VERSION) throw new Error("unsupported envelope version: " + v);
    const params = { name: "AES-GCM", iv: fromBase64(iv) };
    if (v === 2) {
      if (!aad) throw new Error("envelope v2 requires aad");
      params.additionalData = aad;
    }
    const plainBuf = await crypto.subtle.decrypt(params, sharedKey, fromBase64(ct));
    return JSON.parse(new TextDecoder().decode(plainBuf));
  }

  // Safety number — детерминированный отпечаток пары публичных ключей
  // (мой + собеседника), не зависящий от того, кто его вычисляет: обе
  // стороны получают ОДНУ и ту же строку, если сверяют один и тот же
  // разговор. Меняется при подмене ЛЮБОГО из двух ключей (обнаруживает
  // MITM). Не воспроизводит алгоритм Signal один-в-один — сверка идёт
  // между двумя сторонами этого же приложения, не между приложениями.
  function canonicalJwk(jwk) {
    // JWK может сериализоваться с полями в разном порядке — сортируем
    // ключи объекта, чтобы один и тот же ключ всегда давал одну и ту
    // же строку независимо от порядка полей.
    return JSON.stringify(jwk, Object.keys(jwk).sort());
  }
  async function computeSafetyNumber(myJwk, theirJwk) {
    const a = canonicalJwk(myJwk), b = canonicalJwk(theirJwk);
    // Сортируем сами строки — оба участника разговора получают
    // одинаковый порядок независимо от того, кто "я", а кто "собеседник".
    const combined = a < b ? a + "|" + b : b + "|" + a;
    const bytes = new TextEncoder().encode(combined);
    const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
    const hash = new Uint8Array(hashBuf);
    // 12 групп по 5 цифр = 60 цифр, по 2 байта хэша на группу
    // (0..65535 укладывается в 5 десятичных знаков с ведущими нулями).
    const groups = [];
    for (let i = 0; i < 12; i++) {
      const n = (hash[i * 2] << 8) | hash[i * 2 + 1];
      groups.push(String(n).padStart(5, "0"));
    }
    return groups;
  }

  return { generateKeyPair, deriveSharedKey, encryptJson, decryptJson, envAad, computeSafetyNumber, ENVELOPE_VERSION };
})();