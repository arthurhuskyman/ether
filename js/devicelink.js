// =====================================================================
// Перенос на новое устройство (docs/MULTIDEVICE.md, этап 1).
// Старое устройство показывает QR/код: одноразовый секрет S (256 бит, 5 мин) и адрес сервера. Через сервер идёт только одноразовый
// канал t = H(S) и шифртекст. Обе стороны выводят общий ключ K = HKDF(ECDH, соль = S), поэтому сервер (не знающий S) прочитать пакет
// или подменить ключи незаметно не может; «проверочный код» из 6 цифр выводится из K и показывается на обоих экранах.
// Старое устройство отправляет пакет ТОЛЬКО после того, как пользователь подтвердил совпадение кодов.
// Состав пакета — как у экспорта резервной копии (все ether.* из localStorage, кроме привязанного к устройству), без файлов вложений.
// =====================================================================
const DeviceLink = (() => {
  const te = new TextEncoder(), td = new TextDecoder();
  const ECDH = { name: "ECDH", namedCurve: "P-256" };
  const SECRET_TTL_MS = 5 * 60_000, POLL_MS = 1500, GET_TIMEOUT_MS = 10 * 60_000;
  // D3: состояние Double Ratchet и цепочки Sender Keys не копируются: две живые копии одной цепочки повторяют пары (ключ, IV); на новом устройстве сессии начнутся заново (X3DH / rc-reset)
  const EXCLUDED = /^(ether\.sec\.|ether\.pushSubscription$|ether\.vapidPublicKey$|ether\.ratchet$|ether\.groupkeys$)/; // шифрование «в покое» и push привязаны к устройству
  const CODE_PREFIX = "ether://link?";

  function b64u(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function unb64u(str) { const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/")); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; }
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
  async function sha(label, bytes) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...te.encode(label), ...bytes])))); }

  function newSecret() { return crypto.getRandomValues(new Uint8Array(32)); }
  async function ids(S) { return { t: await sha("ether-link-t-v1|", S), u: await sha("ether-link-u-v1|", S) }; }
  function httpBase(wsUrl) {
    try { const u = new URL(String(wsUrl)); u.protocol = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol; return u.origin; } catch (e) { return ""; }
  }
  function encodeCode(S, base) { return CODE_PREFIX + "s=" + b64u(S) + "&h=" + encodeURIComponent(base); }
  // Принимает QR-ссылку ether://link?s=…&h=… или «голый» секрет (43 символа) — тогда сервер берётся по умолчанию (defaultBase).
  function parseCode(text, defaultBase) {
    try {
      let s = String(text || "").trim(), base = defaultBase || "";
      if (s.startsWith(CODE_PREFIX)) { const qs = new URLSearchParams(s.slice(CODE_PREFIX.length)); s = qs.get("s") || ""; base = qs.get("h") || base; }
      if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
      const S = unb64u(s); if (S.length !== 32 || !/^https?:\/\/[^\s/]+$/.test(base)) return null;
      return { S, base };
    } catch (e) { return null; }
  }
  async function genKeyPair() {
    const kp = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
    return { priv: kp.privateKey, pub: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) };
  }
  // K = HKDF(ECDH, соль = S, info = t + оба публичных ключа): подмена любого ключа даёт другой K. Первые 32 байта — AES-ключ, следующие 4 — проверочный код.
  async function deriveKey(priv, theirPub, S, t, pubOld, pubNew) {
    const their = await crypto.subtle.importKey("raw", unb64u(theirPub), ECDH, false, []);
    const ikm = await crypto.subtle.importKey("raw", new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: their }, priv, 256)), "HKDF", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: S, info: te.encode("ether-link-v1|" + t + "|" + pubOld + "|" + pubNew) }, ikm, 288));
    const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
    const n = ((bits[32] << 24) | (bits[33] << 16) | (bits[34] << 8) | bits[35]) >>> 0;
    return { key, verify: String(n % 1_000_000).padStart(6, "0") };
  }
  async function seal(key, t, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode("ether-link-pkg-v1|" + t) }, key, te.encode(JSON.stringify(obj))));
    const out = new Uint8Array(1 + 12 + ct.length); out[0] = 1; out.set(iv, 1); out.set(ct, 13); return out;
  }
  async function open(key, t, bytes) {
    if (!bytes || bytes.length < 30 || bytes[0] !== 1) throw new Error("bad-package");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(1, 13), additionalData: te.encode("ether-link-pkg-v1|" + t) }, key, bytes.slice(13));
    return JSON.parse(td.decode(pt));
  }

  // Пакет переезда: то же, что в экспорте резервной копии (значения уже расшифрованы SecureStore), без привязанного к устройству.
  function collectData(storage) {
    const st = storage || localStorage, data = {};
    for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k && k.startsWith("ether.") && !EXCLUDED.test(k)) data[k] = st.getItem(k); }
    return data;
  }
  function validData(d) { return !!d && typeof d === "object" && Object.keys(d).some((k) => k.startsWith("ether.") && typeof d[k] === "string"); }
  function sanitizeData(d) { const o = {}; for (const k of Object.keys(d || {})) if (k.startsWith("ether.") && typeof d[k] === "string" && !EXCLUDED.test(k)) o[k] = d[k]; return o; }

  function mkApi(base, fetchFn) {
    const f = fetchFn || ((...a) => fetch(...a));
    return async function api(op, body, headers, raw) {
      const r = await f(base + "/link/" + op, { method: "POST", headers: Object.assign({ "Content-Type": raw ? "application/octet-stream" : "application/json" }, headers || {}), body: raw ? body : JSON.stringify(body || {}) });
      return r;
    };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const err = (code) => Object.assign(new Error(code), { code });

  // ---- старое устройство ----
  async function createSender({ base, fetchFn, pollMs }) {
    const api = mkApi(base, fetchFn), poll = pollMs || POLL_MS;
    const S = newSecret(), { t, u } = await ids(S), kp = await genKeyPair();
    const r = await api("init", { t, u, pub: kp.pub });
    if (r.status === 404 || r.status === 405) throw err("unsupported"); // старый сервер без feature devicelink
    if (r.status === 429) throw err("rate");
    if (!r.ok) throw err("init");
    const info = await r.json(); const maxBlob = info.maxBlob || 20 * 1024 * 1024;
    const expiresAt = Date.now() + SECRET_TTL_MS; let cancelled = false, ctx = null;
    const self = {
      code: encodeCode(S, base), expiresAt,
      async waitForJoin() {
        while (!cancelled) {
          if (Date.now() > self.expiresAt) throw err("expired");
          const s = await api("state", { t, u }); if (s.status === 404) throw err("expired");
          if (s.ok) { const j = await s.json(); if (j.joined) { ctx = await deriveKey(kp.priv, j.pub, S, t, kp.pub, j.pub); return { verify: ctx.verify }; } }
          await sleep(poll);
        }
        throw err("cancelled");
      },
      // вызывать только после подтверждения пользователем совпадения проверочных кодов
      async send(data, device) {
        if (!ctx) throw err("not-joined");
        const bytes = await seal(ctx.key, t, device ? { v: 1, data: sanitizeData(data), device } : { v: 1, data: sanitizeData(data) });
        if (bytes.length > maxBlob) throw err("too-large");
        const p = await api("put", bytes, { "X-Link-T": t, "X-Link-U": u }, true);
        if (!p.ok) throw err(p.status === 413 ? "too-large" : "put");
        const until = Date.now() + GET_TIMEOUT_MS;
        while (!cancelled && Date.now() < until) { // ждём, пока новое устройство заберёт пакет (сервер удаляет его при выдаче)
          const s = await api("state", { t, u });
          if (s.ok && (await s.json()).delivered) return true;
          if (s.status === 404) throw err("expired");
          await sleep(poll);
        }
        throw err(cancelled ? "cancelled" : "expired");
      },
      async cancel() { cancelled = true; try { await api("cancel", { t, u }); } catch (e) {} },
    };
    return self;
  }

  // ---- новое устройство ----
  async function join({ code, defaultBase, fetchFn, pollMs }) {
    const parsed = parseCode(code, defaultBase); if (!parsed) throw err("bad-code");
    const api = mkApi(parsed.base, fetchFn), poll = pollMs || POLL_MS;
    const { t } = await ids(parsed.S), kp = await genKeyPair();
    const r = await api("join", { t, pub: kp.pub });
    if (r.status === 409) throw err("taken");   // кто-то уже подключился по этому коду
    if (r.status === 429) throw err("rate");
    if (!r.ok) throw err(r.status === 404 ? "not-found" : "join");
    const j = await r.json(); const ctx = await deriveKey(kp.priv, j.pub, parsed.S, t, j.pub, kp.pub);
    let cancelled = false;
    const side = {
      verify: ctx.verify, device: null,
      async receive() {
        const until = Date.now() + GET_TIMEOUT_MS;
        while (!cancelled && Date.now() < until) {
          const g = await api("get", { t, jt: j.jt });
          if (g.status === 200) {
            const bytes = new Uint8Array(await g.arrayBuffer());
            let pkg; try { pkg = await open(ctx.key, t, bytes); } catch (e) { throw err("decrypt"); }
            if (!pkg || pkg.v !== 1 || !validData(pkg.data)) throw err("bad-package");
            if (pkg.device && typeof pkg.device === "object") side.device = pkg.device; // companion: данные устройства от основного
            return sanitizeData(pkg.data);
          }
          if (g.status === 410 || g.status === 404) throw err("expired");
          await sleep(poll);
        }
        throw err(cancelled ? "cancelled" : "expired");
      },
      cancel() { cancelled = true; },
    };
    return side;
  }
  return { newSecret, ids, httpBase, encodeCode, parseCode, deriveKey, genKeyPair, seal, open, collectData, sanitizeData, validData, createSender, join, EXCLUDED, SECRET_TTL_MS };
})();
if (typeof module !== "undefined") module.exports = DeviceLink;

// ---------------------------------------------------------------------
// Интерфейс. Опирается на глобалы app.js (Store, T, toast, renderQrToCanvas, confirmSheet, wipeEverythingAndReload, applyImportedData).
// ---------------------------------------------------------------------
const DeviceLinkUI = (() => {
  if (typeof document === "undefined") return {};
  const tr = (k, p) => (typeof T === "function" ? T(k, p) : k);
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text, fn) { const b = el("button", cls, text); b.type = "button"; if (fn) b.addEventListener("click", fn); return b; }
  function sheet(title) {
    const s = el("div", "sheet"), panel = el("div", "sheet-panel glass-content"), back = el("div", "sheet-backdrop");
    s.id = "devicelink-sheet"; s.append(back, panel); panel.append(el("div", "sheet-handle"), el("h2", "", title));
    const old = document.getElementById("devicelink-sheet"); if (old) old.remove();
    document.body.appendChild(s);
    const api = { sheet: s, panel, onClose: null, close() { s.remove(); if (api.onClose) { const f = api.onClose; api.onClose = null; f(); } } };
    back.addEventListener("click", () => api.close());
    return api;
  }
  function setBody(sh, ...nodes) { while (sh.panel.childNodes.length > 2) sh.panel.lastChild.remove(); sh.panel.append(...nodes); }
  const verifyBox = (v) => { const e = el("div", "link-verify", v.slice(0, 3) + " " + v.slice(3)); e.style.cssText = "font-size:2rem;letter-spacing:.12em;text-align:center;margin:12px 0;font-variant-numeric:tabular-nums;"; return e; };
  const errText = (e) => tr("devlink.err." + ((e && e.code) || "generic")) === "devlink.err." + ((e && e.code) || "generic") ? tr("devlink.err.generic") : tr("devlink.err." + e.code);
  const serverBase = () => DeviceLink.httpBase(typeof effectiveSignalingUrl === "function" ? effectiveSignalingUrl() : "");

  // Старое устройство
  async function openSend(opts) {
    const companion = !!(opts && opts.companion === true);
    const sh = sheet(tr(companion ? "devices.pair.title" : "devlink.send.title")); let sender = null, timer = null;
    sh.onClose = () => { if (timer) clearInterval(timer); if (sender) sender.cancel(); };
    const start = btn("btn-primary", tr("devlink.send.start"), async () => {
      start.disabled = true;
      try {
        sender = await DeviceLink.createSender({ base: serverBase() });
        const canvas = el("canvas"); canvas.width = canvas.height = 220; canvas.style.cssText = "display:block;margin:10px auto;max-width:100%;";
        const left = el("p", "fine muted"); const codeBox = el("textarea", "link-code"); codeBox.readOnly = true; codeBox.rows = 3; codeBox.value = sender.code; codeBox.style.cssText = "width:100%;font-size:.7rem;";
        const copyB = btn("btn-secondary", tr("devlink.send.copy"), () => { try { navigator.clipboard.writeText(sender.code); toast(tr("devlink.send.copied")); } catch (e) {} });
        const cancelB = btn("btn-tertiary", tr("devlink.cancel"), () => sh.close());
        setBody(sh, el("p", "fine", tr("devlink.send.scan")), canvas, left, codeBox, copyB, cancelB);
        try { renderQrToCanvas(canvas, sender.code); } catch (e) {}
        timer = setInterval(() => { const s = Math.max(0, Math.round((sender.expiresAt - Date.now()) / 1000)); left.textContent = tr("devlink.send.expires", { m: Math.floor(s / 60), s: String(s % 60).padStart(2, "0") }); }, 1000);
        const { verify } = await sender.waitForJoin(); clearInterval(timer); timer = null;
        const yes = btn("btn-primary", tr("devlink.verify.match"), async () => {
          yes.disabled = no.disabled = true; setBody(sh, el("p", "fine", tr("devlink.send.sending")));
          try {
            if (companion) await sender.send(Devices.companionData(), await Devices.issuePairing());
            else await sender.send(DeviceLink.collectData());
            if (companion) { setBody(sh, el("p", "fine", tr("devices.pair.done")), btn("btn-primary", tr("devlink.close"), () => sh.close())); return; }
            const wipe = btn("btn-primary", tr("devlink.send.wipe"), async () => { if (await confirmSheet(tr("devlink.send.wipeConfirm"), { destructive: true })) wipeEverythingAndReload(); });
            setBody(sh, el("p", "fine", tr("devlink.send.done")), wipe, btn("btn-tertiary", tr("devlink.send.keep"), () => sh.close()));
          } catch (e) { setBody(sh, el("p", "fine", errText(e)), btn("btn-tertiary", tr("devlink.close"), () => sh.close())); }
        });
        const no = btn("btn-tertiary", tr("devlink.verify.mismatch"), () => sh.close());
        setBody(sh, el("p", "fine", tr("devlink.verify.hint")), verifyBox(verify), yes, no);
      } catch (e) { if (timer) clearInterval(timer); setBody(sh, el("p", "fine", errText(e)), btn("btn-tertiary", tr("devlink.close"), () => sh.close())); }
    });
    setBody(sh, el("p", "fine", tr(companion ? "devices.pair.explain" : "devlink.send.explain")), companion ? el("p", "fine") : el("p", "fine", tr("devlink.send.warn")), start, btn("btn-tertiary", tr("devlink.cancel"), () => sh.close()));
  }

  // Новое устройство
  async function receiveFromCode(code) {
    const sh = sheet(tr("devlink.recv.title"));
    let linkSide = null;
    sh.onClose = () => { if (linkSide) linkSide.cancel(); };
    setBody(sh, el("p", "fine", tr("devlink.recv.connecting")));
    try {
      linkSide = await DeviceLink.join({ code, defaultBase: serverBase() });
      setBody(sh, el("p", "fine", tr("devlink.recv.verify")), verifyBox(linkSide.verify), el("p", "fine muted", tr("devlink.recv.waiting")), btn("btn-tertiary", tr("devlink.cancel"), () => sh.close()));
      const data = await linkSide.receive(); const device = linkSide.device; linkSide = null;
      const apply = btn("btn-primary", tr("devlink.recv.apply"), async () => {
        if (!await confirmSheet(tr(device ? "devices.recv.confirm" : "devlink.recv.confirm"), { destructive: true })) return;
        apply.disabled = true; await applyImportedData(device ? Devices.applyCompanion(data, device) : data);
      });
      setBody(sh, el("p", "fine", tr("devlink.recv.got")), apply, btn("btn-tertiary", tr("devlink.cancel"), () => sh.close()));
    } catch (e) { linkSide = null; setBody(sh, el("p", "fine", errText(e)), btn("btn-tertiary", tr("devlink.close"), () => sh.close())); }
  }
  function openReceive() {
    const sh = sheet(tr("devlink.recv.title"));
    const input = el("textarea", "link-code"); input.rows = 3; input.placeholder = tr("devlink.recv.placeholder"); input.style.cssText = "width:100%;font-size:.8rem;";
    const go = btn("btn-primary", tr("devlink.recv.go"), () => { const v = input.value.trim(); sh.close(); receiveFromCode(v); });
    const scan = btn("btn-secondary", tr("devlink.recv.scan"), () => { sh.close(); if (typeof startQrScan === "function") startQrScan(); });
    setBody(sh, el("p", "fine", tr("devlink.recv.explain")), scan, input, go, btn("btn-tertiary", tr("devlink.cancel"), () => sh.close()));
  }
  function wire() {
    for (const [id, fn] of [["settings-link-device-btn", openSend], ["onboarding-link-device-btn", openReceive]]) {
      const b = document.getElementById(id); if (b && !b.dataset.dlWired) { b.dataset.dlWired = "1"; b.addEventListener("click", fn); }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
  return { openSend, openReceive, receiveFromCode, wire, sheet, setBody, el, btn, tr };
})();
