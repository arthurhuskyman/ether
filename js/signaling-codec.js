// Кодирование сигнального пакета (offer/answer + ICE) в компактную
// текстовую строку, которой можно поделиться вручную — ссылкой, QR-кодом,
// сообщением в любом мессенджере. Никакого сервера для этого не нужно:
// это единственный момент, где двум устройствам нужно «встретиться»,
// и он происходит вне приложения.

const SignalingCodec = (() => {
  function toBase64Url(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(str) {
    const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function gzip(bytes) {
    if (typeof CompressionStream === "undefined") return bytes;
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const out = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(out);
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream === "undefined") return bytes;
    try {
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const out = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(out);
    } catch (e) {
      // Данные не были сжаты (старый браузер на другом конце) — вернуть как есть.
      return bytes;
    }
  }

  // packet: { t: 'offer'|'answer', n: имя отправителя, d: RTCSessionDescriptionInit, r: roomTag }
  async function encode(packet) {
    const json = JSON.stringify(packet);
    const bytes = new TextEncoder().encode(json);
    let compressed = bytes;
    let flag = "0";
    if (typeof CompressionStream !== "undefined") {
      compressed = await gzip(bytes);
      flag = "1";
    }
    return "1" + flag + toBase64Url(compressed);
  }

  async function decode(code) {
    const clean = code.trim().replace(/^ether:\/\//i, "");
    const version = clean[0];
    const flag = clean[1];
    const body = clean.slice(2);
    if (version !== "1") throw new Error("Неизвестный формат кода связи");
    let bytes = fromBase64Url(body);
    if (flag === "1") bytes = await gunzip(bytes);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  }

  function buildShareLink(code) {
    const url = new URL(location.href);
    url.hash = "c=" + code;
    url.search = "";
    return url.toString();
  }

  function extractCodeFromLocation() {
    const hash = location.hash || "";
    const match = hash.match(/c=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
    return null;
  }

  return { encode, decode, buildShareLink, extractCodeFromLocation };
})();
