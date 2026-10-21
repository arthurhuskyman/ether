// Одноразовый rendezvous-канал для переноса данных на новое устройство (docs/MULTIDEVICE.md, этап 1).
// Сервер видит только: t (SHA-256-производная от секрета S, не обратимая), u (проверочный хеш для загрузки),
// публичные ECDH-ключи сторон и непрозрачный шифртекст. Секрета S и ключа K у сервера нет — прочитать пакет он не может.
//
// POST /link/init  {t,u,pub}            старое устройство открывает канал (TTL 5 мин на подключение)
// POST /link/join  {t,pub}              новое устройство подключается: один раз; отдаёт pub старого и jt (токен получателя)
// POST /link/state {t,u}                старое устройство опрашивает: {joined,pub,delivered}
// POST /link/put   (заголовки X-Link-T, X-Link-U; тело — бинарный blob ≤ LINK_MAX_BLOB) старое кладёт пакет (TTL 10 мин)
// POST /link/get   {t,jt}               новое забирает: 204 — ещё нет, 200 octet-stream — отдан и тут же удалён, 410 — уже забрано
// POST /link/cancel {t,u}               отмена
// Без совпадения t ответ всегда 404 (анти-перебор: лимит неудач на IP и глобальный потолок; S — 256 бит, перебор нереален).
const crypto = require("crypto");

const CHANNEL_TTL_MS = Number(process.env.LINK_CHANNEL_TTL_MS) || 5 * 60_000;
const BLOB_TTL_MS = Number(process.env.LINK_BLOB_TTL_MS) || 10 * 60_000;
const MAX_BLOB = Number(process.env.LINK_MAX_BLOB) || 20 * 1024 * 1024;
const MAX_CHANNELS = 200;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const INIT_PER_MIN = Number(process.env.LINK_INIT_PER_MIN) || 6, CALL_PER_MIN = 120, FAIL_PER_10MIN = 30;
const MAX_CHANNELS_PER_IP = Number(process.env.LINK_MAX_PER_IP) || 10; // открытых каналов с одного IP (иначе один IP занимает все MAX_CHANNELS)
const MAX_PUTS_INFLIGHT = Number(process.env.LINK_MAX_PUTS) || 4;       // одновременно читаемых тел /link/put (каждое — до MAX_BLOB в памяти)
const GLOBAL_FAIL_PER_MIN = Number(process.env.LINK_GLOBAL_FAIL_PER_MIN) || 600; // потолок неудачных попыток по всем IP (распределённый перебор)
const HEX64 = /^[0-9a-f]{64}$/, B64U = /^[A-Za-z0-9_-]{20,200}$/;

const channels = new Map(); // t -> {u, pubOld, pubNew, jt, blob, created, blobAt, delivered}
const hits = new Map(), fails = new Map();
let totalBytes = 0, putsInflight = 0, putsReserved = 0, globalFails = { start: Date.now(), n: 0 };

function bump(map, key, windowMs, limit) {
  const now = Date.now();
  let w = map.get(key);
  if (!w || now - w.start > windowMs) { w = { start: now, n: 0 }; map.set(key, w); }
  w.n++;
  if (map.size > 5000) for (const [k, v] of map) if (now - v.start > windowMs) map.delete(k);
  return w.n <= limit;
}
function drop(t) {
  const c = channels.get(t);
  if (c && c.blob) totalBytes -= c.blob.length;
  channels.delete(t);
}
function sweep() {
  const now = Date.now();
  for (const [t, c] of channels) {
    const dead = c.blobAt ? now - c.blobAt > BLOB_TTL_MS : now - c.created > CHANNEL_TTL_MS;
    if (dead || now - c.created > CHANNEL_TTL_MS + BLOB_TTL_MS) drop(t);
  }
}
const sweeper = setInterval(sweep, 30_000); if (sweeper.unref) sweeper.unref();

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on("data", (d) => { n += d.length; if (n > limit) { over = true; chunks.length = 0; } else if (!over) chunks.push(d); });
    req.on("end", () => over ? reject(Object.assign(new Error("too large"), { code: 413 })) : resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("close", () => reject(new Error("aborted"))); // обрыв клиентом: слот/резерв /link/put обязаны освободиться (после «end» reject — no-op)
  });
}
function eq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function jsonOut(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); }

// Возвращает true, если запрос обработан (путь /link/*).
async function handle(req, res, ip) {
  const url = (req.url || "").split("?")[0];
  if (!url.startsWith("/link/")) return false;
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { jsonOut(res, 405, { error: "method" }); return true; }
  const op = url.slice(6);
  if (!["init", "join", "state", "put", "get", "cancel"].includes(op)) { jsonOut(res, 404, { error: "not found" }); return true; }
  if (!bump(hits, ip + "|" + (op === "init" ? "i" : "c"), 60_000, op === "init" ? INIT_PER_MIN : CALL_PER_MIN)) { jsonOut(res, 429, { error: "rate limited" }); return true; }
  const failed = () => {
    const okIp = bump(fails, ip, 10 * 60_000, FAIL_PER_10MIN);
    const now = Date.now(); if (now - globalFails.start > 60_000) globalFails = { start: now, n: 0 };
    globalFails.n++;
    const ok = okIp && globalFails.n <= GLOBAL_FAIL_PER_MIN;
    if (op === "put") res.setHeader("Connection", "close"); // тело не читаем — соединение не переиспользуем
    jsonOut(res, ok ? 404 : 429, { error: ok ? "not found" : "rate limited" });
  };
  // Глобальный потолок неудач: при распределённом переборе временно отвечаем 429 на всё, кроме init (S — 256 бит, потолок страхует от флуда, а не от реального подбора).
  { const now = Date.now(); if (op !== "init" && now - globalFails.start <= 60_000 && globalFails.n > GLOBAL_FAIL_PER_MIN) { jsonOut(res, 429, { error: "rate limited" }); return true; } }
  // Уже накопленные неудачи блокируют IP, даже если следующая догадка «верна».
  { const f = fails.get(ip); if (f && Date.now() - f.start <= 10 * 60_000 && f.n > FAIL_PER_10MIN) { jsonOut(res, 429, { error: "rate limited" }); return true; } }
  const hdr = (n) => String(req.headers[n] || "");
  let body = Buffer.alloc(0), j = {}, putSlot = false;
  if (op === "put") {
    // Заголовки, состояние канала и размер проверяем ДО чтения тела: иначе любой аноним заставлял сервер буферизовать до MAX_BLOB.
    const t = hdr("x-link-t"), u = hdr("x-link-u");
    const c = HEX64.test(t) && channels.get(t);
    if (!c || !HEX64.test(u) || !eq(c.u, u)) return failed(), true;
    res.setHeader("Connection", "close");
    if (!c.pubNew || c.blob || c.delivered) { jsonOut(res, 409, { error: "bad state" }); return true; }
    const cl = req.headers["content-length"];
    if (cl === undefined || !/^\d+$/.test(String(cl))) { jsonOut(res, 411, { error: "length required" }); return true; }
    if (Number(cl) > MAX_BLOB) { jsonOut(res, 413, { error: "too large" }); return true; }
    if (Number(cl) === 0) { jsonOut(res, 400, { error: "empty" }); return true; }
    if (totalBytes + putsReserved + Number(cl) > MAX_TOTAL_BYTES || putsInflight >= MAX_PUTS_INFLIGHT || c.putting) { jsonOut(res, 503, { error: "busy" }); return true; }
    putsInflight++; putSlot = true; c.putting = true; putsReserved += Number(cl);
    var reserved = Number(cl), chan = c;
  }
  try {
    body = await readBody(req, op === "put" ? MAX_BLOB : 4096);
    if (op !== "put" && body.length) j = JSON.parse(body.toString("utf8"));
  } catch (e) {
    if (putSlot) { putsInflight--; putsReserved -= reserved; chan.putting = false; }
    jsonOut(res, e && e.code === 413 ? 413 : 400, { error: e && e.code === 413 ? "too large" : "bad request" }); return true; }
  if (putSlot) { putsInflight--; putsReserved -= reserved; chan.putting = false; }
  if (!j || typeof j !== "object") j = {};
  sweep();

  if (op === "init") {
    if (!HEX64.test(j.t || "") || !HEX64.test(j.u || "") || !B64U.test(j.pub || "")) { jsonOut(res, 400, { error: "bad request" }); return true; }
    if (channels.has(j.t)) { jsonOut(res, 409, { error: "exists" }); return true; }
    { let n = 0; for (const c of channels.values()) if (c.ip === ip) n++; if (n >= MAX_CHANNELS_PER_IP) { jsonOut(res, 429, { error: "too many channels" }); return true; } }
    if (channels.size >= MAX_CHANNELS) { jsonOut(res, 503, { error: "busy" }); return true; }
    channels.set(j.t, { u: j.u, pubOld: j.pub, pubNew: null, jt: null, blob: null, ip, created: Date.now(), blobAt: 0, delivered: false });
    jsonOut(res, 200, { ok: true, ttl: Math.floor(CHANNEL_TTL_MS / 1000), maxBlob: MAX_BLOB });
    return true;
  }
  if (op === "join") {
    const c = HEX64.test(j.t || "") && channels.get(j.t);
    if (!c || !B64U.test(j.pub || "")) return failed(), true;
    if (c.pubNew) { jsonOut(res, 409, { error: "already joined" }); return true; } // одноразовость: второй подключившийся отбивается
    c.pubNew = j.pub; c.jt = crypto.randomBytes(24).toString("base64url");
    jsonOut(res, 200, { pub: c.pubOld, jt: c.jt });
    return true;
  }
  if (op === "state" || op === "cancel") {
    const c = HEX64.test(j.t || "") && channels.get(j.t);
    if (!c || !HEX64.test(j.u || "") || !eq(c.u, j.u)) return failed(), true;
    if (op === "cancel") { drop(j.t); jsonOut(res, 200, { ok: true }); return true; }
    jsonOut(res, 200, { joined: !!c.pubNew, pub: c.pubNew || null, hasBlob: !!c.blob, delivered: c.delivered });
    return true;
  }
  if (op === "put") {
    const t = hdr("x-link-t"), c = channels.get(t); // повторная проверка: за время чтения тела канал могли отменить/истёк
    if (!c) return failed(), true;
    if (!c.pubNew || c.blob || c.delivered) { jsonOut(res, 409, { error: "bad state" }); return true; }
    if (!body.length) { jsonOut(res, 400, { error: "empty" }); return true; }
    if (totalBytes + body.length > MAX_TOTAL_BYTES) { jsonOut(res, 503, { error: "busy" }); return true; }
    c.blob = body; c.blobAt = Date.now(); totalBytes += body.length;
    jsonOut(res, 200, { ok: true });
    return true;
  }
  if (op === "get") {
    const c = HEX64.test(j.t || "") && channels.get(j.t);
    if (!c || !c.jt || typeof j.jt !== "string" || !eq(c.jt, j.jt)) return failed(), true;
    if (c.delivered) { jsonOut(res, 410, { error: "gone" }); return true; }
    if (!c.blob) { res.writeHead(204); res.end(); return true; }
    const blob = c.blob; totalBytes -= blob.length; c.blob = null; c.delivered = true; // удаляется сразу при выдаче
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": blob.length });
    res.end(blob);
    return true;
  }
  return true;
}
function _stats() { return { channels: channels.size, totalBytes }; }
module.exports = { handle, _stats, MAX_BLOB, CHANNEL_TTL_MS, BLOB_TTL_MS };
