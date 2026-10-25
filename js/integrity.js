// Целостность приложения и «Центр безопасности» (V.80). Сверяет файлы, которые страница реально загрузила, с подписанным
// release-manifest.json (ECDSA P-256; публичный ключ — window.RELEASE_PUBKEY из js/release-key.js; null = «не настроено»).
// Честные границы: проверка работает внутри того же кода, который проверяет (скомпрометированный хостинг может подменить и сам
// integrity.js) — это защита от ошибок деплоя/подмены отдельных файлов и опора для внешней сверки (tools/release-verify.js), а не абсолют.
// Состояния: unconfigured (ключа нет) | checking | verified | mismatch | unsigned (манифеста/подписи нет) | offline.
const Integrity = (() => {
  const MAX_BYTES = 2 * 1024 * 1024;
  const PROTECTS = 5, NOT_PROTECTS = 7; // число строк security.protect.N / security.not.N в словарях = сводка docs/THREAT-MODEL.md
  let st = { status: "unconfigured", checkedAt: 0, version: "", ts: "", checked: 0, diffs: [], updatePending: false, updateRejected: false };
  const T2 = (k, v) => { try { return typeof T === "function" ? T(k, v) : k; } catch (e) { return k; } };
  function pubKey() {
    const k = typeof window !== "undefined" ? window.RELEASE_PUBKEY : null;
    return k && typeof k === "object" && k.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string" ? { kty: k.kty, crv: k.crv, x: k.x, y: k.y } : null;
  }
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  function fromB64u(s) {
    const t = String(s).replace(/-/g, "+").replace(/_/g, "/"), b = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
    const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u;
  }
  async function sha256Hex(buf) { return hex(await crypto.subtle.digest("SHA-256", buf)); }
  // Подпись — по точным байтам release-manifest.json (IEEE P1363, как отдаёт WebCrypto и tools/release-sign.js)
  async function verifySignature(manifestBytes, sigObj, jwk) {
    try {
      if (!jwk || !sigObj || typeof sigObj.sig !== "string") return false;
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64u(sigObj.sig), manifestBytes);
    } catch (e) { return false; }
  }
  // Какие файлы страница загрузила: {путь в манифесте: абсолютный URL}. Только своё происхождение.
  function loadedFiles(doc, baseHref) {
    const base = new URL("./", baseHref || doc.baseURI), out = {};
    const add = (u, path) => { try { const a = new URL(u, base); if (a.origin === base.origin && a.pathname.startsWith(base.pathname) && !a.search) out[path || decodeURIComponent(a.pathname.slice(base.pathname.length))] = a.href; } catch (e) {} };
    add(base.href, "index.html"); add("sw.js");
    doc.querySelectorAll("script[src]").forEach((s) => add(s.getAttribute("src")));
    doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach((l) => add(l.getAttribute("href")));
    return out;
  }
  async function getBytes(f, url, init) {
    const r = await f(url, init);
    if (!r.ok) { const e = new Error("http " + r.status); e.status = r.status; throw e; }
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BYTES * 20) throw new Error("too big");
    return buf;
  }
  async function check(opts) {
    opts = opts || {};
    const jwk = opts.key !== undefined ? opts.key : pubKey();
    const prev = { updateRejected: st.updateRejected };
    const upd = opts.updatePending !== undefined ? !!opts.updatePending : (typeof swRegistration !== "undefined" && !!(swRegistration && swRegistration.waiting));
    const set = (o) => (st = Object.assign({ status: "unconfigured", checkedAt: Date.now(), version: "", ts: "", checked: 0, diffs: [], updatePending: upd }, prev, o));
    if (!jwk) return set({ status: "unconfigured" });
    const f = opts.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    const doc = opts.document || (typeof document !== "undefined" ? document : null);
    if (!f || !doc || typeof crypto === "undefined" || !crypto.subtle) return set({ status: "offline" });
    st = Object.assign({}, st, { status: "checking" });
    try {
      const base = new URL("./", opts.baseHref || doc.baseURI), bust = "?v=" + Date.now(); // ?query обходит кэш service worker (он отдаёт запросы с query сети)
      let mBuf, sObj;
      try { mBuf = await getBytes(f, new URL("release-manifest.json" + bust, base).href, { cache: "no-store" }); }
      catch (e) { return set({ status: e && (e.status === 404 || e.status === 403) ? "unsigned" : "offline" }); }
      try { sObj = JSON.parse(new TextDecoder().decode(await getBytes(f, new URL("release-manifest.sig.json" + bust, base).href, { cache: "no-store" }))); }
      catch (e) { return set({ status: e && (e.status === 404 || e.status === 403) ? "unsigned" : (e && e.status ? "offline" : "unsigned") }); }
      if (!(await verifySignature(mBuf, sObj, jwk))) return set({ status: "mismatch", diffs: ["signature"] });
      let m; try { m = JSON.parse(new TextDecoder().decode(mBuf)); } catch (e) { m = null; }
      if (!m || m.v !== 1 || !m.files || typeof m.files !== "object") return set({ status: "mismatch", diffs: ["manifest"] });
      const files = loadedFiles(doc, opts.baseHref), diffs = [];
      const names = Object.keys(files);
      await Promise.all(names.map(async (p) => {
        if (!Object.prototype.hasOwnProperty.call(m.files, p)) { diffs.push(p + " (not in manifest)"); return; }
        try { if ((await sha256Hex(await getBytes(f, files[p], { cache: "no-store" }))) !== m.files[p]) diffs.push(p); } catch (e) { diffs.push(p + " (unreadable)"); }
      }));
      diffs.sort();
      return set({ status: diffs.length ? "mismatch" : "verified", version: String(m.version || ""), ts: String(m.ts || ""), checked: names.length, diffs: diffs.slice(0, 20) });
    } catch (e) { return set({ status: "offline" }); }
  }
  // Сообщение от service worker: новая версия не прошла проверку подписи, осталась старая
  function onUpdateRejected(info) {
    st.updateRejected = true;
    try { if (typeof toast === "function") toast(T2("security.updateRejected")); } catch (e) {}
    try { renderCentre(); } catch (e) {}
  }
  // ---- Центр безопасности ----
  const esc = (s) => (typeof escapeHtml === "function" ? escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"));
  function contactStats() {
    let total = 0, verified = 0;
    try { for (const c of state.contacts.values()) { if (!c || c.isGroup || !c.publicKey) continue; total++; if (typeof isContactVerified === "function" && isContactVerified(c)) verified++; } } catch (e) {}
    return { total, verified };
  }
  function stateText(s) {
    let t = T2("security.state." + s.status);
    if (s.status === "verified" && s.checked) t += " (" + s.checked + ")";
    if (s.status === "mismatch" && s.updatePending) t += " — " + T2("security.state.updatePending");
    return t;
  }
  function html() {
    const s = st, cs = contactStats();
    const list = (pre, n) => { let h = ""; for (let i = 1; i <= n; i++) h += "<li>" + esc(T2("security." + pre + "." + i)) + "</li>"; return h; };
    let host = ""; try { host = new URL(effectiveSignalingUrl()).host; } catch (e) {}
    let srv = ""; try { const el = document.getElementById("signaling-status-text"); srv = el ? el.textContent : ""; } catch (e) {}
    const ver = typeof APP_VERSION === "string" ? APP_VERSION : "";
    return `<section aria-labelledby="sec-h-int"><h4 id="sec-h-int" class="settings-group-title">${esc(T2("security.integrity"))}</h4>
      <p class="fine"><span>${esc(T2("security.version"))}: <b>${esc(ver)}</b></span><br><span id="security-state" class="security-state" data-state="${esc(s.status)}" role="status" aria-live="polite">${esc(stateText(s))}</span></p>
      ${s.updateRejected ? `<p class="fine" role="alert">${esc(T2("security.updateRejected"))}</p>` : ""}
      ${s.diffs.length ? `<p class="fine muted">${esc(s.diffs.slice(0, 5).join(", "))}</p>` : ""}
      <button type="button" id="security-check-btn" class="btn-secondary" aria-label="${esc(T2("security.check.aria"))}">${esc(T2("security.check"))}</button></section>
    <section aria-labelledby="sec-h-p"><h4 id="sec-h-p" class="settings-group-title">${esc(T2("security.protects"))}</h4><ul class="fine security-list" aria-label="${esc(T2("security.protects"))}">${list("protect", PROTECTS)}</ul></section>
    <section aria-labelledby="sec-h-n"><h4 id="sec-h-n" class="settings-group-title">${esc(T2("security.notProtects"))}</h4><ul class="fine security-list" aria-label="${esc(T2("security.notProtects"))}">${list("not", NOT_PROTECTS)}</ul></section>
    <section aria-labelledby="sec-h-c"><h4 id="sec-h-c" class="settings-group-title">${esc(T2("security.contacts"))}</h4><p class="fine" id="security-contacts">${esc(T2("security.contacts.count", { n: cs.verified, total: cs.total }))}</p></section>
    <section aria-labelledby="sec-h-s"><h4 id="sec-h-s" class="settings-group-title">${esc(T2("security.servers"))}</h4><p class="fine" id="security-server-line">${esc(host)}${srv ? " — " + esc(srv) : ""}</p><div id="security-servers-slot" data-slot="servers"></div></section>
    <p class="fine"><a id="security-policy-link" href=".well-known/security.txt" target="_blank" rel="noopener noreferrer" aria-label="${esc(T2("security.policy.aria"))}">${esc(T2("security.policy"))}</a></p>`;
  }
  function renderCentre() {
    const body = document.getElementById("security-body"); if (!body) return;
    body.innerHTML = html();
    const b = document.getElementById("security-check-btn");
    if (b) b.addEventListener("click", async () => { b.disabled = true; await check(); b.disabled = false; renderCentre(); const nb = document.getElementById("security-check-btn"); if (nb) nb.focus(); });
  }
  function openCentre() {
    const sheet = document.getElementById("security-sheet"); if (!sheet) return;
    renderCentre(); sheet.classList.remove("hidden");
    if (st.status === "unconfigured" && st.checkedAt === 0) check().then(renderCentre);
    else if (st.status !== "unconfigured") check().then(renderCentre);
    setTimeout(() => { try { const b = document.getElementById("security-check-btn"); if (b) b.focus(); } catch (e) {} }, 40);
  }
  if (typeof document !== "undefined") document.addEventListener("click", (e) => { const t = e.target && e.target.closest ? e.target.closest("#settings-security-btn") : null; if (t) openCentre(); });
  return { check, verifySignature, loadedFiles, fromB64u, onUpdateRejected, openCentre, renderCentre, pubKey, get state() { return st; }, PROTECTS, NOT_PROTECTS };
})();
if (typeof window !== "undefined") window.Integrity = Integrity;
