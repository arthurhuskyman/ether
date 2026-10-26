// Список серверов (multi-server resilience): чистые функции без обращения к DOM/Store — нормализация и проверка wss-адресов,
// слияние списков (встроенные из config.js + пользовательские + подписанные), проверка подписи ECDSA P-256 (WebCrypto) по
// window.RELEASE_PUBKEY, пробы /info|/health с замером RTT, выбор лучшего и автомат фейловера (>=3 подряд сбоев или RTT >3x лучшего
// -> переключение; экспоненциальный backoff; запоминание последнего рабочего). Хранилище и часы передаются снаружи — код тестируется без браузера.
const ServerList = (function () {
  const MAX_SERVERS = 12, MAX_HINTS = 3, MAX_LABEL = 40;
  const KEYS = { servers: "ether.servers", lastGood: "ether.serverLastGood", share: "ether.srvShare", signed: "ether.serversSigned", seen: "ether.serversSeen", off: "ether.serversOff" };

  function isLoopback(h) { return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"; }
  function hostOk(h) {
    if (!h || h.length > 120) return false;
    if (isLoopback(h)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
    return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h);
  }
  // "wss://host[:port][/path]" | "" . Принимает wss/https (и без схемы -> wss); ws/http — только loopback (разработка и тесты).
  function normalizeUrl(input) {
    let s = String(input == null ? "" : input).trim();
    if (!s || s.length > 200) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "wss://" + s;
    let u;
    try { u = new URL(s); } catch (e) { return ""; }
    const proto = u.protocol.toLowerCase();
    if (u.username || u.password) return "";
    const host = u.hostname.toLowerCase();
    if (!hostOk(host)) return "";
    let scheme;
    if (proto === "wss:" || proto === "https:") scheme = "wss";
    else if ((proto === "ws:" || proto === "http:") && isLoopback(host)) scheme = "ws";
    else return "";
    let path = u.pathname.replace(/\/+$/, "");
    if (path === "/") path = "";
    if (/[\s<>"']/.test(path)) return "";
    return scheme + "://" + host + (u.port ? ":" + u.port : "") + path;
  }
  function httpBase(url) { return String(url || "").replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://").replace(/\/+$/, ""); }
  function sameServer(a, b) { const x = normalizeUrl(a), y = normalizeUrl(b); return !!x && x === y; }
  function cleanLabel(l, url) {
    const s = String(l == null ? "" : l).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, MAX_LABEL);
    return s || String(url || "").replace(/^[a-z]+:\/\//i, "").slice(0, MAX_LABEL);
  }
  function entry(raw, src, now, lenient) {
    const rawUrl = raw && typeof raw === "object" ? raw.url : raw;
    let url = normalizeUrl(rawUrl);
    // Старое поле «Сервер» (ether.signalingUrl) принималось как есть (например ws:// в локальной сети) — не ломаем его
    if (!url && lenient && /^wss?:\/\/[^\s<>"']{1,190}$/i.test(String(rawUrl || "").trim())) url = String(rawUrl).trim().replace(/\/+$/, "");
    if (!url) return null;
    return { url, label: cleanLabel(raw && raw.label, url), addedAt: raw && Number.isFinite(raw.addedAt) ? raw.addedAt : (now || 0), src: src || "custom" };
  }
  // Слияние по приоритету: custom (ручной ввод/legacy) -> user -> signed (проверенный) -> defaults; повторы по url отбрасываются.
  function merge(parts, now) {
    const out = [], seen = new Set();
    const p = parts || {};
    const off = new Set((Array.isArray(p.disabled) ? p.disabled : []).map(normalizeUrl).filter(Boolean));
    const add = (list, src, lenient) => { for (const r of Array.isArray(list) ? list : []) { const e = entry(r, src, now, lenient); if (e && !seen.has(e.url) && out.length < MAX_SERVERS && !(src !== "custom" && off.has(e.url))) { seen.add(e.url); out.push(e); } } };
    add(p.legacy ? [p.legacy] : [], "custom", true);
    add(p.user, "custom");
    add(p.signed, "signed");
    add(p.defaults, "default");
    return out;
  }
  function readJson(storage, key, dflt) { try { const v = JSON.parse(storage.getItem(key)); return v == null ? dflt : v; } catch (e) { return dflt; } }
  function loadUser(storage) { const a = readJson(storage, KEYS.servers, []); return Array.isArray(a) ? a.map((r) => entry(r, "custom", 0)).filter(Boolean).map((e) => ({ url: e.url, label: e.label, addedAt: e.addedAt })) : []; }
  function saveUser(storage, list) {
    const clean = merge({ user: list }).map((e) => ({ url: e.url, label: e.label, addedAt: e.addedAt }));
    try { storage.setItem(KEYS.servers, JSON.stringify(clean)); } catch (e) {}
    return clean;
  }
  function configDefaults(cfg) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    return merge({ user: Array.isArray(c.servers) ? c.servers : [] }).map((e) => ({ url: e.url, label: e.label, addedAt: 0 }));
  }

  // ---- Подсказки «домашних» серверов контакта (srv) ----
  // В ссылках/QR/карточках — origin в виде https://host[:port] (≤3, без пути); внутри — wss://host. Loopback только при allowLocal.
  function hintOrigin(url, allowLocal) {
    const u = normalizeUrl(url); if (!u) return "";
    let p; try { p = new URL(u.replace(/^wss:/, "https:").replace(/^ws:/, "http:")); } catch (e) { return ""; }
    if (p.protocol === "http:" && !(allowLocal && isLoopback(p.hostname))) return "";
    // D7: подсказка от контакта не должна заставлять браузер стучаться во внутреннюю сеть: IP-литералы и служебные имена только при allowLocal
    if (!allowLocal && (/^\d{1,3}(\.\d{1,3}){3}$/.test(p.hostname) || /^\[/.test(p.hostname) || /(^|\.)(local|localhost|internal|lan|home|corp|intranet)$/.test(p.hostname))) return "";
    return (p.protocol === "https:" ? "wss://" : "ws://") + p.host;
  }
  function normalizeHints(arr, opts) {
    const allowLocal = !!(opts && opts.allowLocal), out = [];
    for (const x of Array.isArray(arr) ? arr : []) { const o = hintOrigin(x, allowLocal); if (o && !out.includes(o)) out.push(o); if (out.length >= MAX_HINTS) break; }
    return out;
  }
  function encodeHints(urls) { return normalizeHints(urls, { allowLocal: true }).map((u) => httpBase(u)).join(","); }
  function decodeHints(str, opts) { return typeof str === "string" && str.length <= 700 ? normalizeHints(str.split(","), opts) : []; }
  // Список для рекламы: активный первым, затем остальные по приоритету; встроенный сервер-одиночка не рекламируется (старые клиенты и так на нём).
  function ownHints(list, active, defaults, opts) {
    const urls = (list || []).map((e) => e.url);
    if (active) urls.unshift(active);
    const h = normalizeHints(urls, opts);
    const defs = (defaults || []).map((d) => normalizeUrl(d.url || d));
    if (h.length === 1 && defs.includes(h[0])) return [];
    return h;
  }

  // ---- Подписанный список ----
  function canonical(obj, field) {
    const f = field || "servers";
    const items = Array.isArray(obj[f]) ? obj[f] : [];
    return "ether-" + f + "-v1\n" + obj.v + "\n" + obj.ts + "\n" + items.map((s) => s.url + "\t" + (s.label || "")).join("\n");
  }
  function parseSigned(input, field) {
    const f = field || "servers";
    let o = input;
    if (typeof o === "string") { try { o = JSON.parse(o); } catch (e) { return null; } }
    if (!o || typeof o !== "object" || o.v !== 1 || !Number.isFinite(o.ts) || !Array.isArray(o[f]) || o[f].length > 50 || typeof o.sig !== "string" || o.sig.length > 300) return null;
    const items = [];
    for (const s of o[f]) {
      const url = f === "mirrors" ? mirrorUrl(s && s.url) : normalizeUrl(s && s.url);
      if (!url) return null;
      items.push({ url, label: cleanLabel(s.label, url) });
    }
    return { v: 1, ts: o.ts, [f]: items, sig: o.sig };
  }
  function mirrorUrl(u) {
    try { const p = new URL(String(u)); if (p.protocol !== "https:" && !(p.protocol === "http:" && isLoopback(p.hostname))) return ""; p.hash = ""; p.search = ""; return p.toString(); } catch (e) { return ""; }
  }
  function b64ToBytes(s) {
    const t = String(s).replace(/-/g, "+").replace(/_/g, "/"), pad = t + "=".repeat((4 - (t.length % 4)) % 4);
    if (typeof atob === "function") { const bin = atob(pad); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(pad, "base64"));
  }
  function pubkeyUsable(k) {
    if (!k) return false;
    if (typeof k === "string") return k.trim().length >= 40 && !/^(placeholder|todo|none|changeme|x+)$/i.test(k.trim()) && !/placeholder|todo/i.test(k);
    return typeof k === "object" && k.kty === "EC" && typeof k.x === "string" && typeof k.y === "string" && !/placeholder|todo/i.test(k.x + k.y);
  }
  async function importKey(subtle, pub) {
    const alg = { name: "ECDSA", namedCurve: "P-256" };
    let k = pub;
    if (typeof k === "string") { const t = k.trim(); if (t[0] === "{") k = JSON.parse(t); }
    if (typeof k === "object") return subtle.importKey("jwk", { kty: k.kty, crv: k.crv || "P-256", x: k.x, y: k.y, ext: true }, alg, false, ["verify"]);
    const bytes = b64ToBytes(String(k).replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
    return subtle.importKey(bytes.length === 65 && bytes[0] === 4 ? "raw" : "spki", bytes, alg, false, ["verify"]);
  }
  // -> { ok, reason }: reason: nokey | bad-format | bad-sig | no-crypto. Без ключа список «непроверенный» — показываем, но не применяем сами.
  async function verifySigned(input, pubkey, opts) {
    const field = (opts && opts.field) || "servers";
    const parsed = parseSigned(input, field);
    if (!parsed) return { ok: false, reason: "bad-format" };
    if (!pubkeyUsable(pubkey)) return { ok: false, reason: "nokey", parsed };
    const subtle = (opts && opts.subtle) || (typeof crypto !== "undefined" && crypto.subtle);
    if (!subtle) return { ok: false, reason: "no-crypto", parsed };
    try {
      const key = await importKey(subtle, pubkey);
      const sig = b64ToBytes(parsed.sig);
      const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(canonical(parsed, field)));
      return ok ? { ok: true, parsed } : { ok: false, reason: "bad-sig", parsed };
    } catch (e) { return { ok: false, reason: "bad-sig", parsed }; }
  }

  // ---- Пробы ----
  // GET <https base>/info (JSON: version, features), при неудаче /health; RTT = время до ответа.
  async function probe(url, opts) {
    const o = opts || {}, f = o.fetch || (typeof fetch === "function" ? fetch : null), now = o.now || Date.now, timeout = o.timeoutMs || 6000;
    const base = httpBase(url);
    if (!f || !base) return { ok: false, rtt: null, error: "no-fetch" };
    for (const p of ["/info", "/health"]) {
      const t0 = now();
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, timeout) : null;
      try {
        const r = await f(base + p, { cache: "no-store", signal: ctl ? ctl.signal : undefined });
        const rtt = Math.max(0, now() - t0);
        if (r && r.ok) {
          let info = null;
          if (p === "/info") { try { info = await r.json(); } catch (e) {} }
          return { ok: true, rtt, path: p, version: info && typeof info.version === "string" ? info.version.slice(0, 32) : "", features: info && Array.isArray(info.features) ? info.features.filter((x) => typeof x === "string").slice(0, 30) : [] };
        }
      } catch (e) { /* пробуем следующий путь */ } finally { if (timer) clearTimeout(timer); }
    }
    return { ok: false, rtt: null, error: "unreachable" };
  }
  async function probeAll(urls, opts) {
    const res = await Promise.all((urls || []).map((u) => probe(u, opts).then((r) => [u, r], () => [u, { ok: false, rtt: null }])));
    const out = {}; for (const [u, r] of res) out[u] = r; return out;
  }
  // Лучший по пробам: среди живых — минимальный RTT; текущий сохраняем, если он не хуже 3x лучшего (гистерезис).
  function pickBest(results, current, factor) {
    const f = factor || 3; let best = "", bestRtt = Infinity;
    for (const u of Object.keys(results || {})) { const r = results[u]; if (r && r.ok && r.rtt < bestRtt) { best = u; bestRtt = r.rtt; } }
    const cur = results && results[current];
    if (cur && cur.ok && cur.rtt <= bestRtt * f) return current;
    return best;
  }

  // ---- Автомат фейловера ----
  function createFailover(opts) {
    const o = opts || {};
    const now = o.now || Date.now, storage = o.storage || null;
    const THRESH = o.failThreshold || 3, FACTOR = o.rttFactor || 3, BASE = o.backoffBase || 5000, MAXB = o.backoffMax || 300000, FLOOR = o.rttFloor == null ? 200 : o.rttFloor, FAILBACK_MS = o.failbackMs || 300000;
    const st = new Map();
    let cur = "", switchedAt = 0;
    const listUrls = () => (typeof o.servers === "function" ? o.servers() : o.servers || []).map((s) => (typeof s === "string" ? s : s.url)).filter(Boolean);
    const S = (u) => { let s = st.get(u); if (!s) { s = { fails: 0, episodes: 0, rtt: null, backoffUntil: 0, okAt: 0 }; st.set(u, s); } return s; };
    function lastGood() { try { return storage && storage.getItem(KEYS.lastGood) || ""; } catch (e) { return ""; } }
    function saveGood(u) { try { if (storage) storage.setItem(KEYS.lastGood, u); } catch (e) {} }
    function current() {
      const l = listUrls();
      if (cur && l.includes(cur)) return cur;
      const g = lastGood();
      cur = l.includes(g) ? g : (l[0] || "");
      return cur;
    }
    function backoffFor(u) { const s = S(u); s.episodes++; s.backoffUntil = now() + Math.min(BASE * Math.pow(2, s.episodes - 1), MAXB); }
    function pickNext(exclude) {
      const l = listUrls().filter((u) => u !== exclude), t = now();
      const free = l.filter((u) => S(u).backoffUntil <= t);
      if (free.length) { // приоритет списка, но известно мёртвые (fails>0) — в конец
        return free.find((u) => S(u).fails === 0) || free[0];
      }
      return l.sort((a, b) => S(a).backoffUntil - S(b).backoffUntil)[0] || "";
    }
    function doSwitch(from, reason) {
      const to = pickNext(from);
      if (!to || to === from) return { switched: false };
      backoffFor(from); cur = to; switchedAt = now(); S(to).fails = 0;
      if (typeof o.onSwitch === "function") { try { o.onSwitch(to, from, reason); } catch (e) {} }
      return { switched: true, to, from, reason };
    }
    function reportFailure(u) {
      const s = S(u); s.fails++;
      if (u !== current()) { if (s.fails >= THRESH) backoffFor(u); return { switched: false }; }
      if (s.fails >= THRESH) { s.fails = 0; return doSwitch(u, "failures"); }
      return { switched: false };
    }
    function reportSuccess(u, rtt) {
      const s = S(u); s.fails = 0; s.episodes = 0; s.backoffUntil = 0; s.okAt = now();
      if (Number.isFinite(rtt)) s.rtt = s.rtt == null ? rtt : Math.round(s.rtt * 0.5 + rtt * 0.5);
      if (u === current()) saveGood(u);
    }
    // Результаты проб { url: {ok, rtt} }: обновляют RTT/сбои; текущий медленнее лучшего в FACTOR раз -> переключение; вернувшийся приоритетный -> возврат.
    function reportProbes(results) {
      const l = listUrls(), c = current();
      for (const u of l) {
        const r = results && results[u]; if (!r) continue;
        const s = S(u);
        if (r.ok) { s.rtt = r.rtt; if (u !== c) { s.fails = 0; s.backoffUntil = 0; } }
        else if (u !== c) { s.fails++; if (s.fails >= THRESH) { s.fails = 0; backoffFor(u); } }
      }
      const cr = results && results[c];
      if (cr && !cr.ok) return reportFailure(c);
      const ok = l.filter((u) => results[u] && results[u].ok && u !== c);
      let best = "", bestRtt = Infinity;
      for (const u of ok) if (results[u].rtt < bestRtt) { best = u; bestRtt = results[u].rtt; }
      if (cr && cr.ok && best && cr.rtt > FLOOR && cr.rtt > bestRtt * FACTOR) {
        const s = S(c); s.fails = 0; s.backoffUntil = now() + BASE;
        cur = best; switchedAt = now();
        if (typeof o.onSwitch === "function") { try { o.onSwitch(best, c, "slow"); } catch (e) {} }
        return { switched: true, to: best, from: c, reason: "slow" };
      }
      // возврат на более приоритетный сервер, когда он ожил и мы сидим на запасном дольше FAILBACK_MS
      const idx = l.indexOf(c);
      if (idx > 0 && now() - switchedAt >= FAILBACK_MS) {
        const up = l.slice(0, idx).find((u) => results[u] && results[u].ok && (!cr || !cr.ok || results[u].rtt <= Math.max(FLOOR, cr.rtt * FACTOR)));
        if (up) { cur = up; switchedAt = now(); if (typeof o.onSwitch === "function") { try { o.onSwitch(up, c, "failback"); } catch (e) {} } return { switched: true, to: up, from: c, reason: "failback" }; }
      }
      return { switched: false };
    }
    function force(u) { if (listUrls().includes(u)) { cur = u; switchedAt = now(); S(u).fails = 0; S(u).backoffUntil = 0; saveGood(u); } return cur; }
    function stats(u) { const s = S(u); return { fails: s.fails, rtt: s.rtt, backoffUntil: s.backoffUntil, okAt: s.okAt }; }
    return { current, reportFailure, reportSuccess, reportProbes, force, stats, pickNext };
  }

  return { KEYS, MAX_SERVERS, MAX_HINTS, normalizeUrl, httpBase, sameServer, cleanLabel, merge, loadUser, saveUser, configDefaults, normalizeHints, encodeHints, decodeHints, ownHints, hintOrigin, canonical, parseSigned, pubkeyUsable, verifySigned, probe, probeAll, pickBest, createFailover };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ServerList;
