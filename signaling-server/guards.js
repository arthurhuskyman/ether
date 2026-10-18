// Небольшие чистые функции защиты сервера (вынесены из server.js, чтобы их можно было тестировать без запуска сервера).
const net = require("net");

// ---------- SSRF: приватные/служебные адреса ----------
function isPrivateIPv4Parts(p) {
  const [a, b, c] = p;
  if (a === 0) return true;                              // 0.0.0.0/8
  if (a === 10) return true;                             // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64/10 CGNAT
  if (a === 127) return true;                            // loopback
  if (a === 169 && b === 254) return true;               // link-local (метадата облаков)
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true;      // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true;      // TEST-NET-1
  if (a === 192 && b === 168) return true;               // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true;  // 198.18/15 бенчмарки
  if (a === 198 && b === 51 && c === 100) return true;   // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;    // TEST-NET-3
  if (a >= 224) return true;                             // multicast, reserved, broadcast
  return false;
}
// Разбор IPv6 в 8 групп по 16 бит (поддерживает «::», встроенный IPv4 в хвосте и zone-id).
function parseIPv6(ip) {
  let s = String(ip).toLowerCase().split("%")[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (!net.isIPv4(v4[1])) return null;
    const o = v4[1].split(".").map(Number);
    s = s.slice(0, s.length - v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = head.concat(new Array(fill).fill("0"), tail);
  } else groups = head;
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}
function isPrivateIp(ip) {
  ip = String(ip == null ? "" : ip);
  if (net.isIPv4(ip)) return isPrivateIPv4Parts(ip.split(".").map(Number));
  if (net.isIPv6(ip)) {
    const g = parseIPv6(ip);
    if (!g) return true;
    const first5Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    if (first5Zero && g[5] === 0xffff) return isPrivateIPv4Parts([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]); // ::ffff:a.b.c.d
    if (first5Zero && g[5] === 0) return true;                                   // ::, ::1 и IPv4-compatible ::a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b) return true;                           // 64:ff9b::/96 NAT64 (и 64:ff9b:1::/48)
    if (g[0] === 0x2002) return true;                                            // 2002::/16 6to4
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;          // Teredo, документация
    if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;   // 100::/64 discard
    if ((g[0] & 0xffc0) === 0xfe80) return true;                                 // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true;                                 // fec0::/10 site-local
    if ((g[0] & 0xfe00) === 0xfc00) return true;                                 // fc00::/7 ULA
    if ((g[0] & 0xff00) === 0xff00) return true;                                 // ff00::/8 multicast
    return false;
  }
  return true; // не распознали — на всякий случай считаем небезопасным
}

// ---------- Web Push: проверка подписки ----------
const PUSH_HOSTS_EXACT = new Set([
  "fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com",
]);
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];
function pushHostAllowed(host) {
  host = String(host || "").toLowerCase();
  return PUSH_HOSTS_EXACT.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.length > s.length && host.endsWith(s));
}
const B64URL = /^[A-Za-z0-9_\-+/=]+$/;
// Возвращает нормализованную подписку { endpoint, keys:{p256dh,auth}[, expirationTime] } или null.
function validatePushSubscription(sub) {
  try {
    if (!sub || typeof sub !== "object" || Array.isArray(sub)) return null;
    if (JSON.stringify(sub).length > 4096) return null;
    if (typeof sub.endpoint !== "string" || sub.endpoint.length > 1024) return null;
    const u = new URL(sub.endpoint);
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
    if (!pushHostAllowed(u.hostname)) return null;
    const k = sub.keys;
    if (!k || typeof k !== "object") return null;
    if (typeof k.p256dh !== "string" || k.p256dh.length < 20 || k.p256dh.length > 200 || !B64URL.test(k.p256dh)) return null;
    if (typeof k.auth !== "string" || k.auth.length < 8 || k.auth.length > 64 || !B64URL.test(k.auth)) return null;
    const out = { endpoint: sub.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
    if (typeof sub.expirationTime === "number" && Number.isFinite(sub.expirationTime)) out.expirationTime = sub.expirationTime;
    return out;
  } catch (e) { return null; }
}
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
function validLang(lang) { return typeof lang === "string" && lang.length <= 12 && LANG_RE.test(lang); }

// ---------- IP клиента ----------
// За прокси (Render) настоящий IP клиента дописывается В КОНЕЦ X-Forwarded-For; первые записи подделывает сам клиент.
function clientIpFrom(req, trustProxy) {
  const direct = (req && req.socket && req.socket.remoteAddress) || "unknown";
  if (!trustProxy) return direct;
  const xff = req && req.headers && req.headers["x-forwarded-for"];
  if (!xff) return direct;
  const parts = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : "";
  return last && last.length <= 64 ? last : direct;
}

// ---------- Логи ----------
function sanitizeForLog(s, max = 64) {
  const t = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// Разрешённые типы картинок для прокси og:image. SVG не пропускаем (активный контент), остальное — растровые форматы.
function imageMimeOk(ctype) {
  const t = String(ctype || "").split(";")[0].trim().toLowerCase();
  if (!/^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(t)) return null;
  return t === "image/jpg" ? "image/jpeg" : t;
}
module.exports = { imageMimeOk, isPrivateIp, parseIPv6, validatePushSubscription, pushHostAllowed, validLang, clientIpFrom, sanitizeForLog };
