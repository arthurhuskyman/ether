// ЭКСПЕРИМЕНТАЛЬНО (fed0): пересылка непрозрачных конвертов между ретрансляторами. ВЫКЛЮЧЕНО по умолчанию (FEDERATION_ENABLED=1 включает).
//
// Что это: адрес "bob@beta" в поле `to` сообщения deliver означает «пользователь bob на ретрансляторе beta». Ретранслятор-отправитель подписывает
// запрос своим серверным ключом Ed25519 и делает POST /federation/inbox на ретранслятор-получатель; тот проверяет подпись ЗАКРЕПЛЁННЫМ ключом пира,
// кладёт конверт в ящик/доставляет сокету, а получателю показывает отправителя как "alice@alpha" (ответ уйдёт обратно тем же путём).
// Сервер НЕ читает содержимое: конверт — это то же E2E-шифрование (Double Ratchet), что и для локальных пользователей, он лишь проходит cleanEnvelope/isValidEnvelope.
//
// Чего это НЕ делает (v0): нет обнаружения пиров, нет присутствия/prekey/каналов/групп/файлов/push через границу ретрансляторов, нет очереди повторов
// (при недоступности пира отправитель получает ошибку в deliver-ack и повторяет сам, как при обычной ошибке сети). Доверие к пирам — решение оператора:
// FEDERATION_PEERS='[{"name":"beta","url":"https://beta.example","pub":"<base64url Ed25519 из GET /federation/identity>"}]'. Ретранслятор-пир может подставить любое
// имя пользователя на своей стороне — личность проверяется только E2E-ключами контактов (TOFU/safety number в клиенте), как и с обычным сервером.
//
// Подпись запроса: Ed25519 по строке "ether-fed-v1\nPOST\n/federation/inbox\n<relay>\n<ts>\n<sha256hex(тело)>"; заголовки X-Ether-Fed-Relay / -Ts / -Sig (base64url).
// Защита: ключ пира закреплён оператором (нет TOFU), окно часов ±5 мин, тело хэшируется в подпись, повторы по (relay,msgId,ts) отбрасываются, лимит запросов на пира в минуту,
// потолок размера тела, адресат только локальный (цепочки пересылки запрещены), отправитель без '@'.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const envInt = (name, def) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : def; };
const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const MAX_BODY = envInt("FEDERATION_MAX_BODY", 4 * 1024 * 1024 + 65536);
const SKEW_MS = 5 * 60 * 1000;
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const canon = (relay, ts, bodyHash) => Buffer.from(["ether-fed-v1", "POST", "/federation/inbox", relay, ts, bodyHash].join("\n"));
const idDoc = (name, pub) => Buffer.from("ether-fed-id-v1|" + name + "|" + pub);

function pubKeyObj(x) { return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }); }
function verify(x, data, sigB64u) { try { return crypto.verify(null, data, pubKeyObj(x), Buffer.from(String(sigB64u), "base64url")); } catch (e) { return false; } }

function loadOrCreateKey(file) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && j.kty === "OKP" && j.d && j.x) return j; } catch (e) { /* создаём новый */ }
  const { privateKey } = crypto.generateKeyPairSync("ed25519"), jwk = privateKey.export({ format: "jwk" });
  if (file) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 }); } catch (e) { console.warn("[federation] ключ не сохранён:", e.message); } }
  return jwk;
}

// ctx: { isValidEnvelope, cleanEnvelope, cleanKind, validPeerId, deliverLocal(to, {from,msgId,envelope,fromPublicKey,kind}), fetch? , now? }
function create(ctx, opts) {
  opts = opts || {};
  const E = opts.env || process.env;
  const off = { enabled: false, isRemote: () => false, handle: async () => false };
  if (E.FEDERATION_ENABLED !== "1") return off;
  const name = String(E.FEDERATION_NAME || "").toLowerCase();
  if (!NAME_RE.test(name)) { console.warn("[federation] FEDERATION_NAME обязателен ([a-z0-9.-], ≤63) — федерация выключена"); return off; }
  let peersRaw = []; try { peersRaw = JSON.parse(E.FEDERATION_PEERS || "[]"); } catch (e) { console.warn("[federation] FEDERATION_PEERS: не JSON — пиров нет"); }
  const peers = new Map();
  for (const p of Array.isArray(peersRaw) ? peersRaw : []) {
    if (p && NAME_RE.test(String(p.name)) && p.name !== name && /^https?:\/\//.test(String(p.url)) && /^[A-Za-z0-9_-]{43}$/.test(String(p.pub))) peers.set(p.name, { name: p.name, url: String(p.url).replace(/\/+$/, ""), pub: p.pub });
    else console.warn("[federation] пир пропущен (name/url/pub неверны):", p && p.name);
  }
  const keyFile = E.FEDERATION_KEY_FILE || (E.DATA_DIR ? path.join(E.DATA_DIR, ".ether-federation-key.json") : path.join(__dirname, ".ether-federation-key.json"));
  const jwk = loadOrCreateKey(keyFile), priv = crypto.createPrivateKey({ key: jwk, format: "jwk" }), pub = jwk.x;
  const now = ctx.now || Date.now, doFetch = ctx.fetch || globalThis.fetch;
  const seen = new Map(), hits = new Map();
  const rateOk = (relay) => { const t = now(); let w = hits.get(relay); if (!w || t - w.start > 60000) { w = { start: t, n: 0 }; hits.set(relay, w); } return ++w.n <= envInt("FEDERATION_RATE_PER_MIN", 600); };

  const identity = () => ({ v: 1, name, pub, fp: sha256hex(Buffer.from(pub, "base64url")).slice(0, 32), features: ["fed0"], sig: b64u(crypto.sign(null, idDoc(name, pub), priv)) });
  // "bob@beta" -> {id, peer}; адрес с неизвестным суффиксом остаётся обычным локальным id (поведение без федерации не меняется)
  function parse(addr) { if (typeof addr !== "string") return null; const i = addr.lastIndexOf("@"); if (i < 1) return null; const peer = peers.get(addr.slice(i + 1)); return peer ? { id: addr.slice(0, i), peer } : null; }

  async function forward(o) { // {from, to:"bob@beta", msgId, envelope, fromPublicKey, kind} -> {ok}|{ok:false,error}
    const a = parse(o.to); if (!a) return { ok: false, error: "unknown-relay" };
    if (!ctx.validPeerId(a.id) || a.id.includes("@") || String(o.from).includes("@")) return { ok: false, error: "bad-address" };
    const ts = String(now()), body = JSON.stringify({ v: 1, from: o.from, to: a.id, msgId: o.msgId, envelope: o.envelope, fromPublicKey: o.fromPublicKey || null, kind: o.kind, ts: Number(ts) });
    const sig = b64u(crypto.sign(null, canon(name, ts, sha256hex(body)), priv));
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), envInt("FEDERATION_TIMEOUT_MS", 5000));
    try {
      const r = await doFetch(a.peer.url + "/federation/inbox", { method: "POST", body, signal: ac.signal, headers: { "Content-Type": "application/json", "X-Ether-Fed-Relay": name, "X-Ether-Fed-Ts": ts, "X-Ether-Fed-Sig": sig } });
      if (r.status === 200) return { ok: true };
      return { ok: false, error: "federation-" + r.status };
    } catch (e) { return { ok: false, error: "federation-unreachable" }; } finally { clearTimeout(timer); }
  }

  async function handle(req, res) {
    const url = (req.url || "").split("?")[0];
    const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); return true; };
    if (req.method === "GET" && url === "/federation/identity") return send(200, identity());
    if (!(req.method === "POST" && url === "/federation/inbox")) return false;
    const relay = String(req.headers["x-ether-fed-relay"] || ""), ts = String(req.headers["x-ether-fed-ts"] || ""), sig = String(req.headers["x-ether-fed-sig"] || "");
    const peer = peers.get(relay);
    if (!peer) return send(401, { error: "unknown-peer" });
    if (!rateOk(relay)) return send(429, { error: "rate" });
    if (!/^\d{10,16}$/.test(ts) || Math.abs(now() - Number(ts)) > SKEW_MS) return send(401, { error: "clock" });
    const chunks = []; let size = 0, tooBig = false;
    await new Promise((resolve) => { req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { tooBig = true; req.destroy(); resolve(); } else chunks.push(c); }); req.on("end", resolve); req.on("error", resolve); req.on("close", resolve); });
    if (tooBig) return send(413, { error: "too-big" });
    const body = Buffer.concat(chunks);
    if (!verify(peer.pub, canon(relay, ts, sha256hex(body)), sig)) return send(401, { error: "bad-sig" });
    let m; try { m = JSON.parse(body.toString("utf8")); } catch (e) { return send(400, { error: "bad-json" }); }
    if (!m || m.v !== 1 || typeof m.from !== "string" || typeof m.to !== "string" || typeof m.msgId !== "string" || m.msgId.length > 128 || m.ts !== Number(ts)) return send(400, { error: "bad-request" });
    if (!ctx.validPeerId(m.from) || m.from.includes("@") || !ctx.validPeerId(m.to) || m.to.includes("@") || (m.from + "@" + relay).length > 128) return send(400, { error: "bad-address" });
    if (m.fromPublicKey != null && (typeof m.fromPublicKey !== "object" || Array.isArray(m.fromPublicKey) || JSON.stringify(m.fromPublicKey).length > 1024)) return send(400, { error: "bad-request" });
    if (!ctx.isValidEnvelope(m.envelope)) return send(400, { error: "invalid-envelope" });
    const envelope = ctx.cleanEnvelope(m.envelope); if (!envelope) return send(400, { error: "invalid-envelope" });
    const dup = relay + "|" + m.from + "|" + m.msgId + "|" + ts;
    if (seen.has(dup)) return send(200, { ok: true, dup: true });
    seen.set(dup, now()); if (seen.size > 5000) seen.delete(seen.keys().next().value);
    ctx.deliverLocal(m.to, { from: m.from + "@" + relay, msgId: m.msgId, envelope, fromPublicKey: m.fromPublicKey || null, kind: ctx.cleanKind(m.kind) });
    return send(200, { ok: true });
  }

  console.log("[federation] ЭКСПЕРИМЕНТАЛЬНО включена: имя=" + name + " пиров=" + peers.size + " pub=" + pub);
  return { enabled: true, name, pub, peers, identity, isRemote: (addr) => !!parse(addr), parse, forward, handle };
}

module.exports = { create, verify, canon, loadOrCreateKey, NAME_RE };
