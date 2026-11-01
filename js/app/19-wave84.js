"use strict";
// =====================================================================
// V.84: волна из 40 пунктов. Здесь — общие настройки волны и пункты, которым не нужен собственный модуль.
// Настройки — один JSON в localStorage["ether.p84"]; строки настроек добавляются в разметку из JS (p84InjectSettings).
// =====================================================================
const P84_KEY = "ether.p84";
const P84_DEFAULTS = { hidePreviews: false, clipClear: false, incognitoKb: false, linkConfirm: true, defaultTtl: 0, highContrast: false, reduceMotion: false, compactList: false, ctrlEnter: false, sendOriginal: false };
const P84 = {
  _c: null,
  all() { if (!this._c) { try { this._c = JSON.parse(localStorage.getItem(P84_KEY) || "{}") || {}; } catch (e) { this._c = {}; } } return this._c; },
  get(k) { const a = this.all(); return Object.prototype.hasOwnProperty.call(a, k) ? a[k] : P84_DEFAULTS[k]; },
  set(k, v) { const a = this.all(); a[k] = v; try { localStorage.setItem(P84_KEY, JSON.stringify(a)); scheduleIDBBackup(); } catch (e) {} p84Apply(); },
};

// ---------- 1. Метаданные фото: EXIF (в т. ч. GPS), XMP, IPTC вырезаются из JPEG перед отправкой ----------
function stripJpegMeta(u8) {
  if (!(u8 && u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8)) return u8;
  const out = [u8.subarray(0, 2)]; let i = 2;
  while (i + 4 <= u8.length && u8[i] === 0xff) {
    const m = u8[i + 1];
    if (m === 0xda || m === 0xd9) break; // начало данных изображения — дальше копируем как есть
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (len < 2 || i + 2 + len > u8.length) return u8; // битый файл — не трогаем
    const drop = m === 0xe1 || m === 0xed || (m >= 0xe2 && m <= 0xef && m !== 0xe2); // APP1 (EXIF/XMP), APP13 (IPTC), прочие APP кроме ICC (APP2)
    if (!drop) out.push(u8.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  out.push(u8.subarray(i));
  const total = out.reduce((s, p) => s + p.length, 0), res = new Uint8Array(total); let o = 0;
  for (const p of out) { res.set(p, o); o += p.length; }
  return res;
}
async function stripImageFileMeta(file) {
  try {
    if (!file || !/^image\/jpe?g$/i.test(file.type || "")) return file;
    const u8 = new Uint8Array(await file.arrayBuffer()), s = stripJpegMeta(u8);
    if (s === u8 || s.length === u8.length) return file;
    return new File([s], file.name || "photo.jpg", { type: file.type });
  } catch (e) { return file; }
}

// ---------- 2. PIN паники: ввод на экране блокировки стирает все данные ----------
function duressSet() { try { return !!localStorage.getItem("ether.duressHash"); } catch (e) { return false; } }
async function isDuressPin(pin) {
  try {
    const salt = localStorage.getItem("ether.duressSalt"), h = localStorage.getItem("ether.duressHash");
    if (!salt || !h) return false;
    return (await pbkdf2Hex(pin, salt, PIN_ITERATIONS)) === h;
  } catch (e) { return false; }
}
async function setDuressPin(v) {
  v = String(v || "").trim();
  if (!v) { localStorage.removeItem("ether.duressHash"); localStorage.removeItem("ether.duressSalt"); toast(T("duress.off")); return; }
  if (v.length < 4) { toast(T("toast.pinShort")); return; }
  if (Store.pinSalt && (await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS)) === Store.pinHash) { toast(T("duress.sameAsPin")); return; }
  const salt = randomSaltHex(16);
  localStorage.setItem("ether.duressSalt", salt); localStorage.setItem("ether.duressHash", await pbkdf2Hex(v, salt, PIN_ITERATIONS));
  toast(T("duress.on"));
}

// ---------- 4. Буфер обмена очищается через 60 с после копирования (если окно в фокусе) ----------
function p84AfterCopy(text) {
  if (!P84.get("clipClear")) return;
  setTimeout(() => { try { if (document.hasFocus() && navigator.clipboard) navigator.clipboard.writeText("").catch(() => {}); } catch (e) {} }, 60000);
}

// ---------- 6. Внешние ссылки: подтверждение с настоящим доменом, предупреждение о «похожих» доменах ----------
function linkHostInfo(href) {
  let u; try { u = new URL(href, location.href); } catch (e) { return null; }
  const host = u.hostname || "";
  const suspicious = /(^|\.)xn--/i.test(host) || /[^\x00-\x7f]/.test(host);
  return { host, suspicious, external: u.origin !== location.origin };
}
function p84LinkClick(e) {
  if (!P84.get("linkConfirm") || e.defaultPrevented) return;
  const a = e.target && e.target.closest ? e.target.closest("#chat-messages a[href], .link-preview-card[href], #thread-sheet a[href]") : null;
  if (!a || a.target !== "_blank") return;
  const info = linkHostInfo(a.getAttribute("href")); if (!info || !info.external) return;
  e.preventDefault(); e.stopPropagation();
  const href = a.href;
  confirmSheet(T("link.confirm", { host: info.host }) + (info.suspicious ? "\n\n" + T("link.suspicious") : "")).then((ok) => { if (ok) window.open(href, "_blank", "noopener,noreferrer"); });
}

// ---------- 5, 26, 30–32, 34: применение настроек к разметке ----------
const P84_INPUTS = ["#chat-input", "#thread-input", "#search-input", "#text-sheet-input"];
function p84Apply() {
  const root = document.documentElement;
  root.classList.toggle("p84-contrast", !!P84.get("highContrast"));
  root.classList.toggle("p84-reduce-motion", !!P84.get("reduceMotion"));
  root.classList.toggle("p84-compact", !!P84.get("compactList"));
  const inc = !!P84.get("incognitoKb");
  for (const sel of P84_INPUTS) {
    const el = document.querySelector(sel); if (!el) continue;
    if (inc) { el.setAttribute("autocomplete", "off"); el.setAttribute("autocorrect", "off"); el.setAttribute("spellcheck", "false"); el.setAttribute("data-p84-inc", "1"); }
    else if (el.getAttribute("data-p84-inc")) { el.removeAttribute("autocorrect"); el.setAttribute("spellcheck", "true"); el.removeAttribute("data-p84-inc"); }
  }
}

// ---------- 9. Размытие окна при потере фокуса (компьютер, включена автоблокировка) ----------
function p84DesktopVeil(on) {
  try {
    if (!(window.matchMedia && window.matchMedia("(pointer: fine)").matches)) return;
    if (!(Store.pinEnabled && typeof autoLockMinutes === "function" && autoLockMinutes() > 0)) return;
    document.documentElement.classList.toggle("privacy-veil", !!on);
  } catch (e) {}
}

// ---------- Строки настроек ----------
function p84InjectSettings() {
  if (document.getElementById("p84-privacy-rows")) return;
  const anchor = document.getElementById("settings-receipts");
  const row = anchor && anchor.closest(".settings-row");
  if (!row) return;
  const tog = (k, l) => `<label class="settings-row"><span data-i18n="${l}">${escapeHtml(T(l))}</span><input id="p84-${k}" type="checkbox" class="switch" /></label>`;
  const box = document.createElement("div"); box.id = "p84-privacy-rows";
  box.innerHTML = tog("hidePreviews", "p84.hidePreviews") + tog("clipClear", "p84.clipClear") + tog("incognitoKb", "p84.incognitoKb") + tog("linkConfirm", "p84.linkConfirm") + tog("sendOriginal", "p84.sendOriginal")
    + `<label class="settings-row"><span data-i18n="p84.defaultTtl">${escapeHtml(T("p84.defaultTtl"))}</span><select id="p84-defaultTtl" class="settings-select"><option value="0" data-i18n="settings.autolock.off">${escapeHtml(T("settings.autolock.off"))}</option><option value="3600000">1 h</option><option value="86400000">24 h</option><option value="604800000">7 d</option></select></label>`
    + `<button type="button" id="p84-duress-btn" class="settings-row link-row"><span data-i18n="duress.title">${escapeHtml(T("duress.title"))}</span></button>`
    + `<button type="button" id="p84-share-server" class="settings-row link-row"><span data-i18n="p84.serverShare">${escapeHtml(T("p84.serverShare"))}</span></button>`
    + tog("highContrast", "p84.highContrast") + tog("reduceMotion", "p84.reduceMotion") + tog("compactList", "p84.compactList") + tog("ctrlEnter", "p84.ctrlEnter");
  row.insertAdjacentElement("beforebegin", box);
  for (const k of ["hidePreviews", "clipClear", "incognitoKb", "linkConfirm", "sendOriginal", "highContrast", "reduceMotion", "compactList", "ctrlEnter"]) {
    const el = box.querySelector("#p84-" + k); el.checked = !!P84.get(k);
    el.addEventListener("change", () => { P84.set(k, el.checked); if (k === "hidePreviews" || k === "compactList") { try { renderChatsList(); } catch (e) {} } });
  }
  const ttl = box.querySelector("#p84-defaultTtl"); ttl.value = String(P84.get("defaultTtl") || 0);
  ttl.addEventListener("change", () => P84.set("defaultTtl", Number(ttl.value) || 0));
  box.querySelector("#p84-share-server").addEventListener("click", () => shareMyServer());
  box.querySelector("#p84-duress-btn").addEventListener("click", () => openTextSheet({ title: T("duress.title"), value: "", placeholder: T("duress.ph"), onOk: (v) => setDuressPin(v) }));
}

let __p84Wired = false;
function p84Wire() {
  if (__p84Wired || typeof document === "undefined") return;
  __p84Wired = true;
  document.addEventListener("click", p84LinkClick, true);
  document.addEventListener("click", p84SpoilerToggle, true);
  document.addEventListener("keydown", p84SpoilerToggle, true);
  const ci = document.getElementById("chat-input");
  if (ci) { ci.addEventListener("input", p84ComposerInput); ci.addEventListener("input", p84TemplatesOnInput); ci.addEventListener("keydown", p84ComposerKey); }
  p84AddLocationMenu();
  setTimeout(p84ServersFromHash, 800);
  const ra = document.getElementById("p84-read-all"); if (ra) ra.addEventListener("click", (e) => { e.stopPropagation(); markAllChatsRead(); }, true);
  window.addEventListener("blur", () => p84DesktopVeil(true));
  window.addEventListener("focus", () => p84DesktopVeil(false));
  p84Apply();
}

// ---------- 8, 29. Карточка контакта: общие группы и история смены ключа ----------
function p84ContactExtras(c) {
  const anchor = document.getElementById("contact-gallery-group"); if (!anchor) return;
  let box = document.getElementById("p84-contact-extra");
  if (!box) { box = document.createElement("div"); box.id = "p84-contact-extra"; box.className = "settings-group flat-content"; anchor.insertAdjacentElement("afterend", box); }
  const groups = Array.from(state.contacts.values()).filter((g) => g.isGroup && Array.isArray(g.members) && g.members.some((m) => m && m.id === c.id));
  const kh = Array.isArray(c.keyHistory) ? c.keyHistory : [];
  let html = "";
  if (groups.length) html += `<div class="settings-row column"><span class="settings-group-title">${escapeHtml(T("p84.sharedGroups", { n: groups.length }))}</span></div>` + groups.slice(0, 20).map((g) => `<button type="button" class="settings-row link-row" data-p84-group="${escapeHtml(g.id)}"><span>${escapeHtml(g.name || "")}</span></button>`).join("");
  if (kh.length) html += `<p class="fine muted settings-hint">${escapeHtml(T("p84.keyHistory", { n: kh.length, date: formatChatListTime(kh[kh.length - 1].at) }))}</p>`;
  box.innerHTML = html; box.classList.toggle("hidden", !html);
  box.querySelectorAll("[data-p84-group]").forEach((b) => b.addEventListener("click", () => { state.contactCardId = null; state.chatId = b.getAttribute("data-p84-group"); renderTab(); }));
}

// ---------- 25. Только эмодзи (1–3 штуки) — крупно ----------
function isEmojiOnly(text) {
  if (typeof text !== "string") return false;
  const t = text.trim(); if (!t || t.length > 32) return false;
  try {
    if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u.test(t) || /^[\d#*\s]+$/.test(t)) return false;
    const seg = typeof Intl !== "undefined" && Intl.Segmenter ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t.replace(/\s+/g, ""))).length : t.replace(/\s+/g, "").length / 2;
    return seg >= 1 && seg <= 3;
  } catch (e) { return false; }
}
// ---------- 10. Спойлер: нажатие (или Enter/пробел) открывает скрытый текст ----------
function p84SpoilerToggle(e) {
  const sp = e.target && e.target.closest ? e.target.closest(".spoiler") : null; if (!sp) return;
  if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault(); e.stopPropagation(); sp.classList.add("revealed");
}

// ---------- 18. Обои отдельного чата (поверх общей настройки) ----------
function applyChatWallpaper(c) {
  const m = document.getElementById("chat-messages"); if (!m) return;
  m.dataset.wallpaper = (c && c.wp) || Store.chatWallpaper || "none";
}
// ---------- 16. Экспорт чата в обычный текст (.txt) ----------
function chatAsText(c) {
  const name = (m) => m.from === "me" ? (Store.name || T("sys.someone")) : m.from === "system" ? "—" : (m.fromName || c.name || T("sys.someone"));
  const body = (m) => m.file ? "[" + T("chat.file.preview." + (m.file.kind || "file")) + (m.file.name ? ": " + m.file.name : "") + "]" : m.poll ? "[" + T("chat.poll.preview", { q: m.text || "" }) + "]" : (m.text || "");
  return [c.name || "", ""].concat(c.messages.map((m) => `[${new Date(m.ts || 0).toLocaleString()}] ${name(m)}: ${body(m)}`)).join("\n");
}
function exportChatTxt(c) {
  try {
    const blob = new Blob([chatAsText(c)], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = ((c.name || "chat").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "chat") + ".txt";
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) { toast(T("toast.copyFailed")); }
}

// ---------- 12. «Ответить лично»: личный чат с автором группового сообщения, цитата уже в поле ответа ----------
function replyPrivately(g, m) {
  if (!m || !m.fromId) return;
  const pc = ensureContactEntry(m.fromId, m.fromName || "");
  state.chatId = pc.id; state.contactCardId = null;
  state.replyTo = { msgId: m.id, text: (m.text || "").slice(0, 200), from: "them", authorName: m.fromName || pc.name || "" };
  renderTab();
  try { if (typeof renderReplyPreview === "function") renderReplyPreview(); } catch (e) {}
  setTimeout(() => { const i = $("#chat-input"); if (i) i.focus(); }, 60);
}
// ---------- 13. «В Сохранённые»: копия сообщения в чат с самим собой (с пометкой, откуда) ----------
function saveToSaved(c, m) {
  const self = ensureSelfChatContact(); if (!self) return;
  const rec = { id: crypto.randomUUID(), from: "me", text: m.text || "", ts: Date.now(), ack: "read", forwarded: true, forwardedFrom: String((m.from === "me" ? Store.name : (m.fromName || c.name)) || "").slice(0, 40) };
  if (m.file) { rec.file = Object.assign({}, m.file, { pending: false }); rec.savedFileKey = "file:" + m.id; }
  self.messages.push(rec); trimMessages(self); self.lastActivity = Date.now(); persistContacts();
  if (m.file) { IDB.get("file:" + m.id).then((b) => { if (b) return IDB.set("file:" + rec.id, b); }).catch(() => {}); }
  toast(T("p84.savedOk"));
}

// ---------- 36. Цвет имени участника группы — стабильный по id, читаемый в обеих темах ----------
function senderColor(key) {
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const dark = document.documentElement.dataset.scheme !== "light";
  return `hsl(${h % 360} ${dark ? 70 : 60}% ${dark ? 70 : 38}%)`;
}
// ---------- 23. «Прочитать все» ----------
function markAllChatsRead() {
  for (const c of state.contacts.values()) {
    if (c.isSelf || !unreadCount(c)) { c.markedUnread = false; continue; }
    c.markedUnread = false;
    try { markThreadRead(c); } catch (e) {}
  }
  persistContacts(); try { renderChatsList(); updateAppBadge(); } catch (e) {}
  toast(T("p84.readAllDone"));
}
// ---------- 24. Счётчик символов у лимита; 38. ↑ в пустом поле — правка последнего своего сообщения ----------
function p84ComposerInput() {
  const i = $("#chat-input"); if (!i) return;
  let el = document.getElementById("p84-char-count");
  const left = MAX_MESSAGE_LENGTH - i.value.length;
  if (left > 400) { if (el) el.classList.add("hidden"); return; }
  if (!el) { el = document.createElement("span"); el.id = "p84-char-count"; el.className = "p84-char-count"; el.setAttribute("aria-live", "polite"); const f = $("#chat-form"); if (f) f.appendChild(el); }
  el.textContent = String(left); el.classList.remove("hidden"); el.classList.toggle("over", left < 0);
}
function p84ComposerKey(e) {
  if (e.key !== "ArrowUp" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
  const i = e.target; if (!i || i.value) return;
  const c = state.chatId && state.contacts.get(state.chatId); if (!c) return;
  const m = [...c.messages].reverse().find((x) => x.from === "me" && x.text && !x.file && !x.poll && !x.board && !x.note && !x.sticker);
  if (!m) return;
  e.preventDefault(); try { startEditing(m.id); } catch (er) {}
}

// ---------- 14. Быстрые ответы: «/» в пустом поле — список шаблонов ----------
function loadTemplates() { try { const a = JSON.parse(localStorage.getItem("ether.templates") || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(0, 30) : []; } catch (e) { return []; } }
function saveTemplate(text) {
  text = String(text || "").trim().slice(0, 500); if (!text) return;
  const a = loadTemplates().filter((x) => x !== text); a.unshift(text);
  try { localStorage.setItem("ether.templates", JSON.stringify(a.slice(0, 30))); scheduleIDBBackup(); } catch (e) {}
  toast(T("p84.templateSaved"));
}
function p84TemplatesOnInput() {
  const i = $("#chat-input"); if (!i || i.value !== "/") return;
  const a = loadTemplates(); if (!a.length) return;
  openActionSheet(T("p84.templates"), a.map((t) => ({ label: truncate(t, 60), fn: () => { i.value = t; try { updateSendVsMic(); } catch (e) {} i.focus(); } }))
    .concat([{ label: T("p84.templatesClear"), danger: true, fn: () => { try { localStorage.removeItem("ether.templates"); } catch (e) {} } }]));
}
// ---------- 15. Геопозиция: одна точка ссылкой на OpenStreetMap (по запросу, без слежения) ----------
function shareLocation() {
  if (!state.chatId || !navigator.geolocation) { toast(T("p84.geoFail")); return; }
  const id = state.chatId;
  navigator.geolocation.getCurrentPosition((pos) => {
    const la = pos.coords.latitude.toFixed(5), lo = pos.coords.longitude.toFixed(5);
    const text = "📍 " + T("p84.geoMsg") + "\nhttps://www.openstreetmap.org/?mlat=" + la + "&mlon=" + lo + "#map=16/" + la + "/" + lo;
    const c = state.contacts.get(id); if (!c) return;
    if (isGroup(c)) sendGroupMessage(id, text, null); else sendChatMessage(id, text, null);
  }, () => toast(T("p84.geoFail")), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}
function p84AddLocationMenu() {
  const menu = document.querySelector("#composer-menu-sheet .composer-menu-actions");
  if (!menu || document.getElementById("chat-location-btn")) return;
  const b = document.createElement("button"); b.type = "button"; b.id = "chat-location-btn"; b.className = "sheet-action composer-menu-item"; b.setAttribute("data-menu-more", "");
  b.innerHTML = Icons.html("globe", 22) + `<span>${escapeHtml(T("p84.geo"))}</span>`;
  const more = menu.querySelector("#composer-menu-more"); menu.insertBefore(b, more || null);
  b.addEventListener("click", () => { const sh = $("#composer-menu-sheet"); if (sh) sh.classList.add("hidden"); try { collapseComposerPlus(); } catch (e) {} shareLocation(); });
}
// ---------- 39, 40. Серверы: импорт по ссылке #servers=… и «Поделиться своим сервером» ----------
function p84ServersFromHash() {
  const m = /[#&]servers=([^&]+)/.exec(location.hash || ""); if (!m) return;
  const list = ServerList.decodeHints(decodeURIComponent(m[1]), { allowLocal: false });
  try { history.replaceState({}, "", location.pathname + location.search); } catch (e) {}
  if (!list.length) return;
  confirmSheet(T("p84.serversImport", { list: list.join("\n") })).then((ok) => {
    if (!ok) return;
    const cur = ServerList.loadUser(localStorage);
    ServerList.saveUser(localStorage, cur.concat(list.map((u) => ({ url: u, label: u.replace(/^[a-z]+:\/\//i, ""), addedAt: Date.now() }))));
    toast(T("p84.serversAdded", { n: list.length }));
  });
}
function shareMyServer() {
  const hints = ServerList.encodeHints([effectiveSignalingUrl()]);
  const url = location.origin + location.pathname + "#servers=" + encodeURIComponent(hints);
  if (navigator.share) navigator.share({ title: T("app.name"), text: T("p84.serverShareText"), url }).catch(() => {});
  else copyText(url, T("toast.linkCopied"));
}
