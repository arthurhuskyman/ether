"use strict";
// V.86: волна из 50+ пунктов. Защита (ключи кадров для групповых звонков, авто-стирание, сила пароля, блокировка при
// бездействии, срок хранения медиа, чистка ссылок, опасные файлы), связь (отчёт, зеркала), функции (отмена отправки,
// вставка картинок, история правок, чтение вслух, цитаты и код, подсказки эмодзи, длинные сообщения, упоминания,
// рука и реакции в групповом звонке), интерфейс (значок на вкладке, тёмная по расписанию, тихие часы, интервал строк,
// без прозрачности, озвучка новых сообщений, проверка уведомлений, сброс и перенос настроек, панель форматирования).

// ---------- настройки V.86 ----------
const P86_KEY = "ether.p86";
const P86_DEFAULTS = { autoWipe: false, idleLock: 0, mediaDays: 0, cleanLinks: true, riskyWarn: true, undoSend: false, smartPunct: false,
  darkSchedule: false, quietHours: false, airy: false, solid: false, dimBg: false, announce: true, favBadge: true };
const P86 = {
  all() { try { return Object.assign({}, P86_DEFAULTS, JSON.parse(localStorage.getItem(P86_KEY) || "{}")); } catch (e) { return Object.assign({}, P86_DEFAULTS); } },
  get(k) { return this.all()[k]; },
  set(k, v) { const a = this.all(); a[k] = v; try { localStorage.setItem(P86_KEY, JSON.stringify(a)); } catch (e) {} p86Apply(); },
};
function p86Apply() {
  const r = document.documentElement;
  r.classList.toggle("p86-airy", !!P86.get("airy"));
  r.classList.toggle("p86-solid", !!P86.get("solid"));
  r.classList.toggle("p86-dim", !!P86.get("dimBg"));
  p86ThemeTick();
}

// ---------- 1–5. Ключи кадров для групповых звонков (сквозное шифрование через SFU) ----------
// Свой ключ отправителя на звонок; эпоха растёт, когда кто-то уходит (ушедший не расшифрует дальнейшее).
const FK = { epoch: 0, raw: null, peers: new Map(), worker: null };
function p86B64(u) { let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s); }
function p86Unb64(s) { const b = atob(String(s || "")); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function p86NewSenderKey() { FK.epoch = (FK.epoch + 1) & 255; FK.raw = FrameCrypt.newRawKey(); p86WorkerKey("me", FK.epoch, FK.raw); return FK; }
function p86SendKeyTo(id) { if (!FK.raw) return false; return gcallSend(id, { t: "fkey", e: FK.epoch, k: p86B64(FK.raw), fe: p86FrameE2EESupported() ? 1 : 0 }); }
function p86OnPeerKey(fromId, p) {
  if (typeof p.k !== "string" || p.k.length > 64) return;
  let raw; try { raw = p86Unb64(p.k); } catch (e) { return; } if (raw.length !== 32) return;
  if (!FK.peers.has(fromId)) FK.peers.set(fromId, new Map());
  const m = FK.peers.get(fromId); m.set(p.e & 255, raw); while (m.size > 3) m.delete(m.keys().next().value);
  p86WorkerKey(fromId, p.e & 255, raw);
}
function p86WorkerKey(owner, epoch, raw) { try { if (FK.worker) FK.worker.postMessage({ type: "key", owner, epoch, raw: raw.buffer.slice(0) }); } catch (e) {} }
// Для режима SFU: шифрование на отправке и расшифровка на приёме (RTCRtpScriptTransform). В сетке (mesh) медиа и так
// шифруется от устройства до устройства (DTLS-SRTP), поэтому там не включается.
function p86FrameE2EESupported() { return typeof RTCRtpScriptTransform === "function" && typeof Worker === "function"; }
function p86AttachFrameE2EE(pc, peerId) {
  if (!p86FrameE2EESupported() || !pc) return false;
  if (!FK.worker) { FK.worker = new Worker("js/frame-worker.js"); if (FK.raw) p86WorkerKey("me", FK.epoch, FK.raw); for (const [id, m] of FK.peers) for (const [e, raw] of m) p86WorkerKey(id, e, raw); }
  for (const s of pc.getSenders()) if (s.track && !s.transform) s.transform = new RTCRtpScriptTransform(FK.worker, { dir: "enc" });
  for (const r of pc.getReceivers()) if (!r.transform) r.transform = new RTCRtpScriptTransform(FK.worker, { dir: "dec", peer: peerId });
  return true;
}

// ---------- 6–9. Защита на устройстве ----------
const P86_WIPE_AFTER = 10;
function p86AfterUnlockAttempt() {
  if (P86.get("autoWipe") && (state.unlockAttempts || 0) >= P86_WIPE_AFTER) { try { wipeEverythingAndReload(); } catch (e) {} return true; }
  return false;
}
function passStrength(s) {
  s = String(s || ""); if (!s) return 0;
  let sc = Math.min(4, Math.floor(s.length / 4));
  const cls = [/[a-zа-яё]/, /[A-ZА-ЯЁ]/, /\d/, /[^\w\sа-яё]/i].filter((r) => r.test(s)).length;
  sc += cls - 1; if (/^(.)\1+$/.test(s) || /^(1234|qwer|пароль|password)/i.test(s)) sc = 0;
  return Math.max(0, Math.min(4, Math.round(sc * 4 / 7)));
}
function p86WireStrength() {
  const inp = document.getElementById("set-pin-input"); if (!inp || inp.dataset.p86) return; inp.dataset.p86 = "1";
  const bar = document.createElement("div"); bar.id = "p86-strength"; bar.className = "p86-strength"; bar.setAttribute("aria-live", "polite");
  inp.insertAdjacentElement("afterend", bar);
  const upd = () => {
    const pass = (() => { try { return localStorage.getItem("ether.pinKind") === "pass"; } catch (e) { return false; } })();
    if (!pass || !inp.value) { bar.className = "p86-strength hidden"; return; }
    const v = passStrength(inp.value); bar.className = "p86-strength s" + v; bar.textContent = T("p86.strength." + v);
  };
  inp.addEventListener("input", upd); upd();
}
let __p86LastInput = Date.now();
function p86IdleTick() {
  const min = Number(P86.get("idleLock")) || 0;
  if (!min || !Store.pinEnabled || state._relocked || document.hidden) return false;
  if (Date.now() - __p86LastInput >= min * 60000) { try { relockApp(); } catch (e) {} return true; }
  return false;
}
async function p86MediaSweep(now) {
  const days = Number(P86.get("mediaDays")) || 0; if (!days) return 0;
  const edge = (now || Date.now()) - days * 86400000; let n = 0;
  for (const c of state.contacts.values()) for (const m of c.messages) {
    if (!m.file || m.file.expired || !m.ts || m.ts >= edge || m.favorite) continue;
    try { await IDB.del("file:" + m.id); } catch (e) {}
    m.file.expired = true; n++;
  }
  if (n) { try { persistContacts(); } catch (e) {} }
  return n;
}
// Чистка ссылок от меток слежки перед отправкой
const P86_TRACK = /^(utm_[a-z_]+|fbclid|gclid|dclid|yclid|msclkid|mc_eid|mc_cid|igshid|_hsenc|_hsmi|ref_src|si)$/i;
function cleanTrackingParams(text) {
  return String(text || "").replace(/https?:\/\/[^\s<>"']+/g, (u) => {
    try {
      const url = new URL(u); let hit = false;
      for (const k of Array.from(url.searchParams.keys())) if (P86_TRACK.test(k)) { url.searchParams.delete(k); hit = true; }
      if (!hit) return u;
      let out = url.toString(); if (!url.search && out.endsWith("?")) out = out.slice(0, -1);
      return out;
    } catch (e) { return u; }
  });
}
const P86_RISKY = /\.(apk|exe|msi|bat|cmd|com|scr|pif|js|jse|vbs|vbe|wsf|jar|ps1|psm1|sh|dmg|pkg|app|lnk|reg|hta|cpl|docm|xlsm|pptm)$/i;
function isRiskyFileName(n) { return P86_RISKY.test(String(n || "").trim()); }

// ---------- 10–12. Связь: отчёт и зеркала ----------
let __p86LastOnline = 0;
function p86ConnReport() {
  const s = p85ConnState();
  let entries = []; try { entries = serverEntries().map((e) => e.url); } catch (e) {}
  const mirrors = p86Mirrors();
  return [T("app.name") + " " + APP_VERSION, "server: " + (s.url || "—") + (s.online ? " (online)" : " (offline)"),
    "last online: " + (__p86LastOnline ? new Date(__p86LastOnline).toISOString() : "—"), "servers: " + entries.join(", "),
    "mirrors: " + (mirrors.join(", ") || "—"), "ua: " + navigator.userAgent].join("\n");
}
function p86Mirrors() {
  const out = new Set();
  try { const cfg = window.__ETHER_CONFIG__ || {}; (cfg.mirrors || []).forEach((m) => { const u = typeof m === "string" ? m : m && m.url; if (u && /^https:\/\//.test(u)) out.add(u); }); } catch (e) {}
  try { const sg = JSON.parse(localStorage.getItem(ServerList.KEYS.signed) || "null"); ((sg && sg.mirrors) || []).forEach((m) => { const u = typeof m === "string" ? m : m && m.url; if (u && /^https:\/\//.test(u)) out.add(u); }); } catch (e) {}
  return Array.from(out).slice(0, 10);
}
function p86ConnExtras() {
  const conn = document.getElementById("p85-conn-group"); if (!conn || conn.querySelector("#p86-conn-report")) return;
  conn.insertAdjacentHTML("beforeend", `<button type="button" id="p86-conn-report" class="settings-row link-row"><span data-i18n="p86.conn.report">${escapeHtml(T("p86.conn.report"))}</span></button><div id="p86-mirrors" class="settings-row column"></div>`);
  conn.querySelector("#p86-conn-report").addEventListener("click", () => copyText(p86ConnReport(), T("p86.conn.copied")));
  const box = conn.querySelector("#p86-mirrors"); const ms = p86Mirrors();
  box.innerHTML = `<span class="fine muted">${escapeHtml(T("p86.conn.mirrors"))}</span>` + (ms.length ? ms.map((u) => `<a class="p86-mirror" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u.replace(/^https:\/\//, ""))}</a>`).join("") : `<span class="fine muted">${escapeHtml(T("p86.conn.noMirrors"))}</span>`);
}

// ---------- 13–26. Функции чата ----------
let __p86Undo = null;
function p86QueueUndo(fn, restore) {
  if (__p86Undo) { clearTimeout(__p86Undo.t); __p86Undo.fn(); }
  const u = { fn, restore, t: setTimeout(() => { if (__p86Undo === u) { __p86Undo = null; fn(); } p86HideUndo(); }, 4000) };
  __p86Undo = u;
  let bar = document.getElementById("p86-undo");
  if (!bar) { bar = document.createElement("div"); bar.id = "p86-undo"; bar.className = "p86-undo"; bar.setAttribute("role", "status"); document.body.appendChild(bar); }
  bar.innerHTML = `<span>${escapeHtml(T("p86.undo.sending"))}</span><button type="button" class="btn-tertiary" id="p86-undo-btn">${escapeHtml(T("p86.undo.cancel"))}</button>`;
  bar.classList.remove("hidden");
  bar.querySelector("#p86-undo-btn").addEventListener("click", () => { if (__p86Undo === u) { clearTimeout(u.t); __p86Undo = null; restore(); } p86HideUndo(); });
}
function p86HideUndo() { const b = document.getElementById("p86-undo"); if (b) b.classList.add("hidden"); }
function smartPunct(t) { return String(t).replace(/(^|\s)--(\s|$)/g, "$1—$2").replace(/\.\.\./g, "…"); }
// Подсказки эмодзи по «:слово»
function emojiSuggest(q, max) {
  q = String(q || "").toLowerCase(); if (q.length < 2 || typeof EMOJI_NAMES === "undefined") return [];
  const out = [];
  for (const e of Object.keys(EMOJI_NAMES)) {
    const hay = (EMOJI_NAMES[e] || "") + " " + ((typeof EMOJI_RU !== "undefined" && EMOJI_RU[e]) || "");
    if (hay.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))) { out.push(e); if (out.length >= (max || 6)) break; }
  }
  return out;
}
function p86EmojiBar(inp) {
  let bar = document.getElementById("p86-emoji-sug");
  const m = /(^|\s):([\p{L}\d_]{2,20})$/u.exec(inp.value.slice(0, inp.selectionEnd == null ? inp.value.length : inp.selectionEnd));
  const list = m ? emojiSuggest(m[2]) : [];
  if (!list.length) { if (bar) bar.classList.add("hidden"); return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "p86-emoji-sug"; bar.className = "p86-emoji-sug"; bar.setAttribute("role", "listbox"); inp.closest("form, .chat-input-bar, .composer, div").insertAdjacentElement("beforebegin", bar); }
  bar.innerHTML = list.map((e) => `<button type="button" role="option" class="p86-emoji-opt">${e}</button>`).join("");
  bar.classList.remove("hidden");
  bar.querySelectorAll(".p86-emoji-opt").forEach((b) => b.addEventListener("click", () => {
    const end = inp.selectionEnd == null ? inp.value.length : inp.selectionEnd;
    const start = inp.value.slice(0, end).lastIndexOf(":");
    inp.value = inp.value.slice(0, start) + b.textContent + inp.value.slice(end); bar.classList.add("hidden");
    inp.dispatchEvent(new Event("input", { bubbles: true })); inp.focus();
  }));
}
// Панель форматирования при выделении текста в поле ввода
const P86_FMT = [["b", "**", "p86.fmt.bold"], ["i", "*", "p86.fmt.italic"], ["s", "~~", "p86.fmt.strike"], ["c", "`", "p86.fmt.code"], ["h", "||", "p86.fmt.spoiler"]];
function p86FormatSelection(inp, mark) {
  const a = inp.selectionStart, b = inp.selectionEnd; if (a == null || a === b) return false;
  inp.value = inp.value.slice(0, a) + mark + inp.value.slice(a, b) + mark + inp.value.slice(b);
  inp.selectionStart = a + mark.length; inp.selectionEnd = b + mark.length;
  inp.dispatchEvent(new Event("input", { bubbles: true })); return true;
}
function p86FmtBar(inp) {
  let bar = document.getElementById("p86-fmt");
  const sel = inp.selectionStart != null && inp.selectionStart !== inp.selectionEnd;
  if (!sel) { if (bar) bar.classList.add("hidden"); return; }
  if (!bar) {
    bar = document.createElement("div"); bar.id = "p86-fmt"; bar.className = "p86-fmt"; bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", T("p86.fmt.title"));
    bar.innerHTML = P86_FMT.map(([id, mk, key]) => `<button type="button" class="p86-fmt-btn" data-fmt="${id}" aria-label="${escapeHtml(T(key))}" title="${escapeHtml(T(key))}">${escapeHtml(id === "h" ? "▒" : id === "c" ? "</>" : id.toUpperCase())}</button>`).join("");
    bar.addEventListener("mousedown", (e) => e.preventDefault());
    bar.addEventListener("click", (e) => { const t = e.target.closest("[data-fmt]"); if (!t) return; const f = P86_FMT.find((x) => x[0] === t.dataset.fmt); p86FormatSelection(inp, f[1]); p86FmtBar(inp); });
    inp.closest("form, .chat-input-bar, .composer, div").insertAdjacentElement("beforebegin", bar);
  }
  bar.classList.remove("hidden");
}
// После отрисовки ленты: длинные сообщения, ссылки, кнопка «к упоминаниям», озвучка нового
const P86_LONG = 1500;
let __p86Announced = "";
function p86AfterThread() {
  const wrap = document.getElementById("chat-messages"); const c = state.chatId && state.contacts.get(state.chatId);
  if (!wrap || !c) return;
  wrap.querySelectorAll("a[href]").forEach((a) => { if (/^https?:/i.test(a.getAttribute("href") || "")) { a.setAttribute("rel", "noopener noreferrer"); a.setAttribute("target", "_blank"); } });
  wrap.querySelectorAll(".bubble:not(.p86-checked)").forEach((b) => {
    b.classList.add("p86-checked");
    if (b.querySelector(".file-media-slot, .file-bubble")) return;
    if ((b.textContent || "").length > P86_LONG) {
      b.classList.add("p86-long");
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn-tertiary p86-more"; btn.textContent = T("p86.readMore");
      btn.addEventListener("click", (e) => { e.stopPropagation(); const open = b.classList.toggle("p86-open"); btn.textContent = T(open ? "p86.readLess" : "p86.readMore"); });
      b.appendChild(btn);
    }
  });
  p86MentionButton(c);
  if (P86.get("announce")) {
    const last = c.messages[c.messages.length - 1];
    if (last && last.from === "them" && last.id !== __p86Announced && Date.now() - last.ts < 15000 && last.text) {
      __p86Announced = last.id; p86Announce((last.fromName || c.name || "") + ": " + String(last.text).slice(0, 200));
    }
  }
}
function p86Announce(text) {
  let r = document.getElementById("p86-live"); if (!r) { r = document.createElement("div"); r.id = "p86-live"; r.className = "sr-only"; r.setAttribute("aria-live", "polite"); r.setAttribute("role", "status"); document.body.appendChild(r); }
  r.textContent = ""; setTimeout(() => { r.textContent = text; }, 30);
}
let __p86MentionIdx = -1;
function p86MentionButton(c) {
  const ids = c.messages.slice(-RENDER_WINDOW_STEP).filter((m) => m.mentionMe && m.from === "them").map((m) => m.id);
  let b = document.getElementById("p86-mention-btn");
  if (!ids.length) { if (b) b.classList.add("hidden"); return; }
  if (!b) {
    b = document.createElement("button"); b.type = "button"; b.id = "p86-mention-btn"; b.className = "p86-mention-btn"; b.textContent = "@";
    b.setAttribute("aria-label", T("p86.mentions"));
    b.addEventListener("click", () => {
      const cc = state.chatId && state.contacts.get(state.chatId); if (!cc) return;
      const list = cc.messages.filter((m) => m.mentionMe && m.from === "them").map((m) => m.id); if (!list.length) return;
      __p86MentionIdx = (__p86MentionIdx + 1) % list.length; const id = list[list.length - 1 - __p86MentionIdx];
      try { ensureMessageRendered(cc.id, id); } catch (e) {}
      const el = document.querySelector('#chat-messages [data-msg-id="' + p86Esc(id) + '"]'); if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("p86-flash"); setTimeout(() => el.classList.remove("p86-flash"), 1200); }
    });
    const host = document.getElementById("screen-chat"); if (host) host.appendChild(b);
  }
  b.classList.remove("hidden"); b.dataset.count = String(ids.length);
}
// Действия в шторке сообщения
function p86SheetActions(c, m, rare, act) {
  if (m.text) rare.push(act("read-aloud", T("p86.readAloud")));
  if (m.text) rare.push(act("copy-quote", T("p86.copyQuote")));
  rare.push(act("msg-info", T("p86.info")));
}
function p86SheetAction(action, c, m) {
  if (action === "read-aloud") { readAloud(m.text); return true; }
  if (action === "copy-quote") { copyText(String(m.text).split("\n").map((l) => "> " + l).join("\n"), T("toast.copied")); return true; }
  if (action === "msg-info") { openMsgInfo(m); return true; }
  return false;
}
function readAloud(text) {
  try {
    if (!("speechSynthesis" in window)) { toast(T("p86.noSpeech")); return false; }
    speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(String(text).slice(0, 4000)); u.lang = document.documentElement.lang || "ru"; speechSynthesis.speak(u); return true;
  } catch (e) { return false; }
}
function msgInfoLines(m) {
  const f = (t) => (t ? new Date(t).toLocaleString() : "—");
  const lines = [T("p86.info.sent", { t: f(m.ts) })];
  if (m.edited) lines.push(T("p86.info.edited", { t: f(m.editedAt) }));
  if (Array.isArray(m.editHistory) && m.editHistory.length) {
    lines.push(T("p86.info.history"));
    m.editHistory.slice().reverse().forEach((h) => lines.push("• " + f(h.at) + ": " + String(h.t).slice(0, 300)));
  }
  return lines;
}
function openMsgInfo(m) { try { openActionSheet(T("p86.info"), [{ label: msgInfoLines(m).join("\n"), icon: "info", fn: () => {} }]); } catch (e) { toast(msgInfoLines(m).join("\n")); } }

// ---------- 27–28. Групповой звонок: рука и реакции ----------
function gcallRaiseHand() { GC.hand = !GC.hand; gcallBroadcast({ t: "hand", up: GC.hand }); p86ShowHand(Store.myId, GC.hand); return GC.hand; }
function gcallReact(emoji) { if (!/^\p{Extended_Pictographic}/u.test(emoji)) return false; gcallBroadcast({ t: "react", e: emoji }); p86FloatEmoji(emoji); return true; }
function p86ShowHand(id, up) {
  const tile = document.querySelector('[data-gcall-id="' + p86Esc(id) + '"]'); if (tile) tile.classList.toggle("p86-hand", !!up);
  if (up && id !== Store.myId) { const g = gcallGroup(GC.gid); toast(T("p86.hand.raised", { name: gcallMemberName(g, id) })); }
}
function p86FloatEmoji(e) {
  const scr = document.getElementById("gcall-screen") || document.body; const s = document.createElement("span");
  s.className = "p86-float"; s.textContent = e; s.style.insetInlineStart = (10 + Math.random() * 70) + "%"; scr.appendChild(s); setTimeout(() => s.remove(), 2600);
}

// ---------- 35–44. Интерфейс ----------
let __p86Fav = -1;
function p86FaviconBadge(n) {
  if (!P86.get("favBadge") || n === __p86Fav) return false; __p86Fav = n;
  const link = document.querySelector('link[rel="icon"]'); if (!link) return false;
  if (!link.dataset.base) link.dataset.base = link.getAttribute("href");
  if (!n) { link.setAttribute("href", link.dataset.base); return true; }
  const cv = document.createElement("canvas"); cv.width = cv.height = 64; const ctx = cv.getContext && cv.getContext("2d"); if (!ctx) return false;
  const img = new Image(); img.onload = () => {
    ctx.drawImage(img, 0, 0, 64, 64); ctx.fillStyle = "#e5484d"; ctx.beginPath(); ctx.arc(46, 18, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 24px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(n > 9 ? "9+" : String(n), 46, 19);
    try { link.setAttribute("href", cv.toDataURL("image/png")); } catch (e) {}
  };
  img.src = link.dataset.base; return true;
}
function inQuietHours(d) { const h = (d || new Date()).getHours(); return h >= 23 || h < 8; }
function p86ThemeTick(d) {
  if (!P86.get("darkSchedule")) return null;
  const h = (d || new Date()).getHours(); const want = h >= 21 || h < 7 ? "dark" : "light";
  if (document.documentElement.dataset.theme !== want) { try { applyTheme(want); } catch (e) {} }
  return want;
}
const P86_UI_KEYS = ["ether.p84", "ether.p86", "ether.a11y.zoom", "ether.settingsAdv", "ether.call.corner"];
function exportUiSettings() { const o = {}; for (const k of P86_UI_KEYS) { try { const v = localStorage.getItem(k); if (v != null) o[k] = v; } catch (e) {} } o.theme = Store.theme; return JSON.stringify({ v: 1, ui: o }); }
function importUiSettings(json) {
  let d; try { d = JSON.parse(json); } catch (e) { return false; }
  if (!d || d.v !== 1 || !d.ui || typeof d.ui !== "object") return false;
  for (const k of P86_UI_KEYS) if (typeof d.ui[k] === "string" && d.ui[k].length < 5000) { try { localStorage.setItem(k, d.ui[k]); } catch (e) {} }
  if (typeof d.ui.theme === "string" && /^(light|dark|auto|oled)$/.test(d.ui.theme)) { Store.theme = d.ui.theme; try { applyTheme(d.ui.theme); } catch (e) {} }
  try { p84Apply(); } catch (e) {} p86Apply(); try { applyZoomPolicy(); } catch (e) {}
  return true;
}
function resetAppearance() { try { localStorage.removeItem("ether.p84"); } catch (e) {} for (const k of ["airy", "solid", "dimBg", "darkSchedule"]) { const a = P86.all(); a[k] = false; try { localStorage.setItem(P86_KEY, JSON.stringify(a)); } catch (e) {} } try { p84Apply(); } catch (e) {} p86Apply(); }
function testNotification() {
  if (!("Notification" in window)) { toast(T("p86.notif.unsupported")); return false; }
  if (Notification.permission !== "granted") { toast(T("p86.notif.denied")); return false; }
  try { showNotification(T("app.name"), T("p86.notif.body"), { force: true, kind: "test" }); } catch (e) {}
  return true;
}
const P86_SHORTCUTS = [["Ctrl/⌘ + K", "p86.sc.jump"], ["Ctrl/⌘ + F", "p86.sc.search"], ["/", "p86.sc.focusSearch"], ["Esc", "p86.sc.close"], ["Alt + ↑/↓", "p86.sc.prevNext"], ["↑", "p86.sc.editLast"], ["Ctrl/⌘ + B / I", "p86.sc.format"], ["Ctrl/⌘ + Shift + M", "p86.sc.mute"], ["Shift + ?", "p86.sc.help"]];
function openShortcuts() { try { openActionSheet(T("p86.sc.title"), P86_SHORTCUTS.map(([k, key]) => ({ label: k + " — " + T(key), icon: "text", fn: () => {} }))); } catch (e) {} }
function p86KeyDown(e) {
  const t = e.target; const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (!typing && (e.key === "?" || ((e.ctrlKey || e.metaKey) && e.key === "/"))) { e.preventDefault(); openShortcuts(); return; }
  if (!typing && e.key === "/" && !e.ctrlKey && !e.metaKey) { const s = document.querySelector("#chats-search, .search-input:not([disabled])"); if (s && s.offsetParent !== null) { e.preventDefault(); s.focus(); } return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "M" || e.key === "m")) {
    e.preventDefault();
    try { if (GC && GC.gid) gcallToggleMute(); else { const b = document.getElementById("call-mute-btn"); if (b && !document.getElementById("call-screen").classList.contains("hidden")) b.click(); } } catch (er) {}
    return;
  }
  if (typing && t.id === "chat-input" && (e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "i")) { if (p86FormatSelection(t, e.key === "b" ? "**" : "*")) e.preventDefault(); }
}
function p86BackCount() {
  const back = document.getElementById("chat-back"); if (!back) return;
  let n = 0; for (const c of state.contacts.values()) if (!c.isSelf && c.id !== state.chatId) n += unreadCount(c);
  let b = back.querySelector(".p86-back-count");
  if (!n) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement("span"); b.className = "p86-back-count"; back.appendChild(b); }
  b.textContent = n > 99 ? "99+" : String(n);
}
function chatStats(c) {
  let mine = 0, theirs = 0, media = 0, first = 0;
  for (const m of c.messages) { if (m.from === "me") mine++; else if (m.from === "them") theirs++; if (m.file) media++; if (!first || (m.ts && m.ts < first)) first = m.ts; }
  return { total: mine + theirs, mine, theirs, media, first };
}

// ---------- строки настроек ----------
function p86Toggle(k, l) { return `<label class="settings-row"><span data-i18n="${l}">${escapeHtml(T(l))}</span><input id="p86-${k}" type="checkbox" class="switch" /></label>`; }
function p86Select(k, l, opts) { return `<label class="settings-row"><span data-i18n="${l}">${escapeHtml(T(l))}</span><select id="p86-${k}" class="settings-select">${opts.map(([v, lab]) => `<option value="${v}">${escapeHtml(lab)}</option>`).join("")}</select></label>`; }
function p86InjectSettings() {
  const priv = document.getElementById("p84-privacy-rows"), chats = document.getElementById("p85-chats-group"), look = document.getElementById("p85-a11y-group");
  const notif = document.querySelector('#screen-settings [data-settings-category="notifications"]');
  if (!priv || !chats || !look || document.getElementById("p86-autoWipe")) return false;
  const off = T("settings.autolock.off");
  priv.insertAdjacentHTML("beforeend", p86Toggle("autoWipe", "p86.autoWipe") + p86Select("idleLock", "p86.idleLock", [[0, off], [5, "5 min"], [15, "15 min"], [60, "60 min"]])
    + p86Select("mediaDays", "p86.mediaDays", [[0, off], [30, "30 d"], [90, "90 d"], [365, "365 d"]]) + p86Toggle("cleanLinks", "p86.cleanLinks") + p86Toggle("riskyWarn", "p86.riskyWarn"));
  chats.insertAdjacentHTML("beforeend", p86Toggle("undoSend", "p86.undoSend") + p86Toggle("smartPunct", "p86.smartPunct"));
  look.insertAdjacentHTML("beforeend", p86Toggle("darkSchedule", "p86.darkSchedule") + p86Toggle("airy", "p86.airy") + p86Toggle("solid", "p86.solid") + p86Toggle("dimBg", "p86.dimBg")
    + p86Toggle("announce", "p86.announce") + p86Toggle("favBadge", "p86.favBadge")
    + `<button type="button" id="p86-reset-look" class="settings-row link-row"><span data-i18n="p86.resetLook">${escapeHtml(T("p86.resetLook"))}</span></button>`
    + `<button type="button" id="p86-export-ui" class="settings-row link-row"><span data-i18n="p86.exportUi">${escapeHtml(T("p86.exportUi"))}</span></button>`
    + `<button type="button" id="p86-import-ui" class="settings-row link-row"><span data-i18n="p86.importUi">${escapeHtml(T("p86.importUi"))}</span></button>`
    + `<button type="button" id="p86-shortcuts" class="settings-row link-row"><span data-i18n="p86.sc.title">${escapeHtml(T("p86.sc.title"))}</span></button>`);
  if (notif) notif.insertAdjacentHTML("beforeend", p86Toggle("quietHours", "p86.quietHours") + `<button type="button" id="p86-test-notif" class="settings-row link-row"><span data-i18n="p86.notif.test">${escapeHtml(T("p86.notif.test"))}</span></button>`);
  for (const k of Object.keys(P86_DEFAULTS)) {
    const el = document.getElementById("p86-" + k); if (!el) continue;
    if (el.type === "checkbox") { el.checked = !!P86.get(k); el.addEventListener("change", () => P86.set(k, el.checked)); }
    else { el.value = String(P86.get(k) || 0); el.addEventListener("change", () => P86.set(k, Number(el.value) || 0)); }
  }
  const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
  on("p86-reset-look", () => { resetAppearance(); toast(T("p86.resetDone")); });
  on("p86-export-ui", () => copyText(exportUiSettings(), T("p86.exportDone")));
  on("p86-import-ui", () => openTextSheet({ title: T("p86.importUi"), value: "", placeholder: "{…}", onOk: (v) => toast(T(importUiSettings(v) ? "p86.importDone" : "p86.importBad")) }));
  on("p86-shortcuts", openShortcuts);
  on("p86-test-notif", testNotification);
  return true;
}

function p86Esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/[^\w-]/g, (c) => "\\" + c); }
let __p86GcWired = false;
function p86WireGroupCall() {
  if (__p86GcWired) return; __p86GcWired = true;
  const origGc = handleGroupCallPayload;
  handleGroupCallPayload = function (fromId, p) {
    if (p && GC.gid && p.gid === GC.gid && gcallIsMember(gcallGroup(GC.gid), fromId)) {
      if (p.t === "fkey") { p86OnPeerKey(fromId, p); return; }
      if (p.t === "hand") { p86ShowHand(fromId, !!p.up); return; }
      if (p.t === "react") { if (typeof p.e === "string" && p.e.length <= 16 && /^\p{Extended_Pictographic}/u.test(p.e)) p86FloatEmoji(p.e); return; }
    }
    return origGc.apply(this, arguments);
  };
  const origEnter = gcallEnter;
  gcallEnter = function () { FK.epoch = 0; FK.peers = new Map(); p86NewSenderKey(); GC.hand = false; return origEnter.apply(this, arguments); };
  const origReg = gcallRegisterPeer;
  gcallRegisterPeer = function (id) { const r = origReg.apply(this, arguments); if (r) p86SendKeyTo(id); return r; };
  const origLeave = leaveGroupCall;
  leaveGroupCall = function () { FK.raw = null; FK.peers = new Map(); try { if (FK.worker) FK.worker.terminate(); } catch (e) {} FK.worker = null; return origLeave.apply(this, arguments); };
}

// ---------- подключение ----------
let __p86Wired = false;
function p86Wire() {
  if (__p86Wired || typeof document === "undefined") return;
  __p86Wired = true;
  p86Apply();
  // замок: авто-стирание после 10 ошибок
  // отправка: чистка ссылок, типографика, отмена в течение 4 с
  const origSend = sendChatMessage;
  sendChatMessage = function (contactId, text, replyTo) {
    let t = text;
    if (typeof t === "string") { if (P86.get("cleanLinks")) t = cleanTrackingParams(t); if (P86.get("smartPunct")) t = smartPunct(t); }
    const args = [contactId, t, replyTo].concat(Array.prototype.slice.call(arguments, 3));
    if (P86.get("undoSend") && typeof t === "string" && t) {
      return new Promise((res) => p86QueueUndo(() => res(origSend.apply(this, args)), () => {
        const inp = document.getElementById("chat-input"); if (inp && state.chatId === contactId) { inp.value = text; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.focus(); } res(null);
      }));
    }
    return origSend.apply(this, args);
  };
  const origSound = playMessageSound;
  playMessageSound = function () { if (P86.get("quietHours") && inQuietHours()) return; return origSound.apply(this, arguments); };
  const origThread = renderChatThreadInner;
  renderChatThreadInner = function () { const r = origThread.apply(this, arguments); try { p86AfterThread(); } catch (e) {} return r; };
  const origTab = renderTab;
  renderTab = function () { const r = origTab.apply(this, arguments); try { p86InjectSettings(); p86ConnExtras(); p86WireStrength(); p86BackCount(); } catch (e) {} return r; };
  const origBadge = updateAppBadge;
  updateAppBadge = function () { const r = origBadge.apply(this, arguments); try { let n = 0; for (const c of state.contacts.values()) if (!c.isSelf) n += unreadCount(c); p86FaviconBadge(n); } catch (e) {} return r; };
  // групповой звонок: ключи кадров, рука, реакции (модуль звонков в другом бандле — подключаем, когда он есть)
  if (typeof handleGroupCallPayload === "function" && typeof gcallEnter === "function") p86WireGroupCall();
  else window.addEventListener("load", () => { if (typeof handleGroupCallPayload === "function") p86WireGroupCall(); }, { once: true });

  // поле ввода: вставка картинки, подсказки эмодзи, панель форматирования
  const inp = document.getElementById("chat-input");
  if (inp) {
    inp.addEventListener("paste", (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => /^image\//.test(f.type));
      if (!files.length || !state.chatId) return;
      e.preventDefault(); if (files.length === 1) openMediaComposeSheet(files[0]); else p85OpenAlbumSheet(files);
    });
    inp.addEventListener("input", () => { try { p86EmojiBar(inp); } catch (er) {} });
    ["select", "keyup", "mouseup"].forEach((ev) => inp.addEventListener(ev, () => { try { p86FmtBar(inp); } catch (er) {} }));
  }
  // опасные файлы: предупреждение перед открытием
  const wrap = document.getElementById("chat-messages");
  if (wrap) wrap.addEventListener("click", async (e) => {
    if (!P86.get("riskyWarn")) return;
    const fb = e.target.closest(".file-bubble-doc, .file-bubble"); if (!fb || fb.dataset.p86Ok) return;
    const id = fb.getAttribute("data-msg-id") || (fb.closest("[data-msg-id]") || {}).getAttribute && fb.closest("[data-msg-id]").getAttribute("data-msg-id");
    const c = state.chatId && state.contacts.get(state.chatId); const m = c && c.messages.find((x) => x.id === id);
    if (!m || !m.file || m.from === "me" || !isRiskyFileName(m.file.name)) return;
    e.preventDefault(); e.stopPropagation();
    if (await confirmSheet(T("p86.risky", { name: m.file.name }), { destructive: true })) { fb.dataset.p86Ok = "1"; fb.click(); }
  }, true);
  document.addEventListener("keydown", p86KeyDown);
  ["pointerdown", "keydown", "touchstart", "wheel"].forEach((ev) => document.addEventListener(ev, () => { __p86LastInput = Date.now(); }, { passive: true, capture: true }));
  setInterval(() => { p86IdleTick(); p86ThemeTick(); try { if (signaling && signaling.connected) __p86LastOnline = Date.now(); } catch (e) {} }, 15000);
  setTimeout(() => { p86MediaSweep(); }, 5000);
  try { p86InjectSettings(); } catch (e) {}
}
