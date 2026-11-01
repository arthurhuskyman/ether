// V.87: хранилище зашифрованных вложений для групп — отправитель шифрует файл ОДИН раз (случайный ключ AES-GCM),
// загружает шифртекст сюда, а участникам рассылает только короткую ссылку с ключом (через gdeliver/ящик, сквозное шифрование).
// Сервер видит лишь непрозрачный шифртекст, размер и время. Загрузка — по одноразовому билету из WS (только
// зарегистрированный клиент, квота в сутки), скачивание — по неугадываемому id (128 бит). Срок хранения BLOB_TTL_DAYS.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const envInt = (n, d) => { const v = parseInt(process.env[n], 10); return Number.isFinite(v) && v > 0 ? v : d; };
const LIM = {
  maxBytes: envInt("BLOB_MAX_BYTES", 16 * 1024 * 1024),
  dailyBytes: envInt("BLOB_DAILY_BYTES", 200 * 1024 * 1024),
  ttlMs: envInt("BLOB_TTL_DAYS", 7) * 86400000,
  totalBytes: envInt("BLOB_TOTAL_BYTES", 5 * 1024 * 1024 * 1024),
};
const ID_RE = /^[0-9a-f]{32}$/;
function create(ctx) {
  const dir = ctx.dir; const now = ctx.now || Date.now;
  const meta = new Map(); // id -> { size, exp }
  const tickets = new Map(); // token -> { id, size, owner, exp }
  const used = new Map(); // owner -> { day, bytes }
  let total = 0;
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} }
  const metaFile = dir ? path.join(dir, "index.json") : null;
  function load() {
    if (!metaFile) return;
    try { const o = JSON.parse(fs.readFileSync(metaFile, "utf8")); for (const [id, m] of Object.entries(o)) if (ID_RE.test(id) && m && m.exp > now()) { meta.set(id, m); total += m.size || 0; } } catch (e) {}
  }
  let saveT = null;
  function save() { if (!metaFile) return; try { fs.writeFileSync(metaFile, JSON.stringify(Object.fromEntries(meta))); } catch (e) {} }
  function saveSoon() { if (saveT) return; saveT = setTimeout(() => { saveT = null; save(); }, 1000); if (saveT.unref) saveT.unref(); }
  function sweep() {
    const t = now();
    for (const [id, m] of meta) if (m.exp <= t) { meta.delete(id); total -= m.size || 0; try { fs.unlinkSync(path.join(dir, id)); } catch (e) {} }
    for (const [k, v] of tickets) if (v.exp <= t) tickets.delete(k);
    saveSoon();
  }
  const timer = setInterval(sweep, 10 * 60000); if (timer.unref) timer.unref();
  function quotaOk(owner, size) {
    const day = Math.floor(now() / 86400000); const u = used.get(owner) || { day, bytes: 0 };
    if (u.day !== day) { u.day = day; u.bytes = 0; }
    if (u.bytes + size > LIM.dailyBytes || total + size > LIM.totalBytes) return false;
    u.bytes += size; used.set(owner, u); return true;
  }
  function onMessage(ws, msg, myId) {
    if (msg.type !== "blob-ticket") return false;
    const size = msg.size, rid = typeof msg.rid === "string" ? msg.rid.slice(0, 40) : "";
    if (!dir) { ctx.safeSend(ws, { type: "blob-ticket", rid, error: "disabled" }); return true; }
    if (!Number.isInteger(size) || size <= 0 || size > LIM.maxBytes) { ctx.safeSend(ws, { type: "blob-ticket", rid, error: "size" }); return true; }
    if (!quotaOk(myId, size)) { ctx.safeSend(ws, { type: "blob-ticket", rid, error: "quota" }); return true; }
    const id = crypto.randomBytes(16).toString("hex"), token = crypto.randomBytes(24).toString("hex");
    tickets.set(token, { id, size, owner: myId, exp: now() + 10 * 60000 });
    ctx.safeSend(ws, { type: "blob-ticket", rid, id, token, ttlDays: Math.round(LIM.ttlMs / 86400000) });
    return true;
  }
  // HTTP: PUT /blob/<id>?t=<token> — загрузка; GET /blob/<id> — скачивание
  function handle(req, res) {
    const u = new URL(req.url, "http://x"); const m = /^\/blob\/([0-9a-f]{32})$/.exec(u.pathname);
    if (!m) return false;
    res.setHeader("Access-Control-Allow-Origin", "*");
    const id = m[1];
    if (req.method === "GET") {
      const mm = meta.get(id);
      if (!mm || mm.exp <= now()) { res.writeHead(404); res.end(); return true; }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": mm.size, "Cache-Control": "private, max-age=86400" });
      fs.createReadStream(path.join(dir, id)).on("error", () => res.end()).pipe(res);
      return true;
    }
    if (req.method === "PUT" || req.method === "POST") {
      const tk = tickets.get(u.searchParams.get("t") || "");
      if (!tk || tk.id !== id || tk.exp <= now()) { res.writeHead(403); res.end(); req.resume(); return true; }
      tickets.delete(u.searchParams.get("t"));
      const chunks = []; let got = 0, bad = false;
      req.on("data", (c) => { got += c.length; if (got > tk.size) { bad = true; req.destroy(); } else chunks.push(c); });
      req.on("end", () => {
        if (bad || got !== tk.size) { res.writeHead(400); res.end(); return; }
        try { fs.writeFileSync(path.join(dir, id), Buffer.concat(chunks)); } catch (e) { res.writeHead(500); res.end(); return; }
        meta.set(id, { size: got, exp: now() + LIM.ttlMs }); total += got; saveSoon();
        res.writeHead(201, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id, size: got }));
      });
      req.on("error", () => { try { res.writeHead(400); res.end(); } catch (e) {} });
      return true;
    }
    res.writeHead(405); res.end(); return true;
  }
  return { onMessage, handle, load, save, sweep, LIM, meta };
}
module.exports = { create, LIM };
