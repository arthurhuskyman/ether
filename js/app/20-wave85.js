"use strict";
// V.85: дизайн и UX. (1) настройки: разделы «Чаты» и «Связь», строки V.84 по своим разделам; (2) экран «Связь» с кнопкой
// «Найти рабочий сервер»; (3) «Разрешить масштаб»; (4) значок защиты в шапке чата; (5) плавный вход в чат и свайп «назад»
// от левого края; (6) альбомы: несколько фото подряд — сеткой, отправка нескольких фото одним альбомом; (7) редактор фото
// перед отправкой: поворот, квадрат, рисование, размытие; (8) звонок: своё видео перетаскивается в любой угол, тап меняет
// местами большое и малое, кнопки прячутся сами; (9) «Прочитано» из уведомления, даже когда приложение закрыто.

// ---------- 1–2. Разделы настроек и экран «Связь» ----------
const P85_CATS = [
  { id: "chats", labelKey: "settings.category.chats", icon: "chat", after: "privacy" },
  { id: "connection", labelKey: "settings.category.connection", icon: "globe", after: "data" },
];
function p85AddCategories() {
  for (const cat of P85_CATS) {
    if (SETTINGS_CATEGORIES.some((c) => c.id === cat.id)) continue;
    const i = SETTINGS_CATEGORIES.findIndex((c) => c.id === cat.after);
    SETTINGS_CATEGORIES.splice(i < 0 ? SETTINGS_CATEGORIES.length : i + 1, 0, { id: cat.id, labelKey: cat.labelKey, icon: cat.icon });
  }
}
function p85Group(cat, titleKey, id) {
  let g = document.getElementById(id); if (g) return g;
  g = document.createElement("div"); g.id = id; g.className = "settings-group flat-content"; g.dataset.settingsCategory = cat;
  g.innerHTML = `<div class="settings-row column"><span class="settings-group-title" data-i18n="${titleKey}">${escapeHtml(T(titleKey))}</span></div>`;
  const scr = document.getElementById("screen-settings");
  const help = scr && scr.querySelector('[data-settings-category="help"]');
  if (help) help.insertAdjacentElement("beforebegin", g); else if (scr) scr.appendChild(g);
  return g;
}
function p85MoveRow(sel, group) {
  const el = document.querySelector(sel); if (!el || !group || group.contains(el)) return;
  const row = el.closest(".settings-row") || el; group.appendChild(row);
}
// Вызывается при старте и при каждой отрисовке настроек: строки V.84 появляются позже (p84InjectSettings), переносим по мере появления
function p85ArrangeSettings() {
  if (!document.getElementById("screen-settings")) return;
  const first = !document.getElementById("p85-chats-group");
  p85AddCategories();
  const chats = p85Group("chats", "settings.category.chats", "p85-chats-group");
  ["#p84-sendOriginal", "#p84-defaultTtl", "#p84-ctrlEnter"].forEach((s) => p85MoveRow(s, chats));
  const look = p85Group("appearance", "p85.a11y.title", "p85-a11y-group");
  ["#p84-highContrast", "#p84-reduceMotion", "#p84-compactList"].forEach((s) => p85MoveRow(s, look));
  if (!look.querySelector("#p85-zoom")) {
    look.insertAdjacentHTML("beforeend", `<label class="settings-row"><span data-i18n="p85.zoom">${escapeHtml(T("p85.zoom"))}</span><input id="p85-zoom" type="checkbox" class="switch" /></label>`);
    const z = look.querySelector("#p85-zoom"); z.checked = zoomAllowed();
    z.addEventListener("change", () => { try { localStorage.setItem("ether.a11y.zoom", z.checked ? "1" : "0"); } catch (e) {} applyZoomPolicy(); });
  }
  // «Связь»: состояние, поиск рабочего сервера, прежняя группа сервера (была спрятана в «Приватность → Дополнительно»)
  const conn = p85Group("connection", "p85.conn.title", "p85-conn-group");
  if (!conn.querySelector("#p85-find-server")) {
    conn.insertAdjacentHTML("beforeend", `<div class="settings-row column p85-conn-card" id="p85-conn-card" aria-live="polite"></div>
    <button type="button" id="p85-find-server" class="settings-row link-row p85-find-server"><span data-i18n="p85.conn.find">${escapeHtml(T("p85.conn.find"))}</span></button>`);
    conn.querySelector("#p85-find-server").addEventListener("click", () => p85FindServer());
  }
  p85MoveRow("#p84-share-server", conn);
  const dot = document.getElementById("signaling-status-dot");
  const g = dot && dot.closest(".settings-group");
  if (g && g !== conn && g.dataset.settingsCategory !== "connection") { g.dataset.settingsCategory = "connection"; conn.insertAdjacentElement("afterend", g); } // остаётся под «Дополнительно»
  // кнопки «Дополнительно» строятся один раз по SETTINGS_CATEGORIES — для новых разделов добавляем недостающие (клик ловит общий обработчик)
  const box = document.getElementById("settings-adv-toggles");
  if (box && box.dataset.built) for (const cat of P85_CATS) {
    if (box.querySelector('[data-adv-cat="' + cat.id + '"]')) continue;
    const proto = box.querySelector(".settings-adv-toggle"); if (!proto) break;
    const nb = proto.cloneNode(true); nb.dataset.advCat = cat.id; nb.classList.add("category-hidden"); nb.classList.remove("open"); nb.setAttribute("aria-expanded", "false"); box.appendChild(nb);
  }
  if (first) { try { renderSettingsCategories(); updateSettingsCategoryView(); } catch (e) {} }
  p85RenderConn();
}
function p85ConnState() {
  let entries = []; try { entries = serverEntries(); } catch (e) {}
  const url = (() => { try { return effectiveSignalingUrl(); } catch (e) { return ""; } })();
  const online = !!(typeof signaling !== "undefined" && signaling && signaling.connected);
  return { url: String(url || "").replace(/^[a-z]+:\/\//i, ""), online, servers: entries.length };
}
function p85RenderConn() {
  const box = document.getElementById("p85-conn-card"); if (!box) return;
  const s = p85ConnState();
  box.innerHTML = `<span class="p85-conn-state ${s.online ? "ok" : "down"}"><span class="status-dot ${s.online ? "online" : ""}"></span>${escapeHtml(T(s.online ? "p85.conn.online" : "p85.conn.offline"))}</span>
    <span class="fine muted">${escapeHtml(T("p85.conn.server", { url: s.url || "—" }))}</span>
    <span class="fine muted">${escapeHtml(T("p85.conn.count", { n: s.servers }))}</span>`;
}
// Подписанный список (если есть) → проверка всех серверов → переключение на лучший (это делает failover по замерам)
async function p85FindServer() {
  const btn = document.getElementById("p85-find-server"); if (btn) btn.disabled = true;
  toast(T("p85.conn.searching"));
  try { if (typeof srvRefreshSigned === "function") await srvRefreshSigned().catch(() => {}); } catch (e) {}
  let res = null; try { res = await srvProbeAll(); } catch (e) {}
  const ok = res ? Object.values(res).filter((r) => r && typeof r === "object" && r.ok).length : 0;
  if (btn) btn.disabled = false;
  p85RenderConn();
  toast(ok ? T("p85.conn.found", { n: ok }) : T("p85.conn.none"));
  return ok;
}

// ---------- 4. Значок защиты в шапке чата ----------
function p85SecurityState(c) {
  if (!c || isGroup(c)) return null;
  if (c.pendingKey) return "changed";
  if (isContactVerified(c)) return "verified";
  return "e2e";
}
function p85RenderSecBadge() {
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  const tb = document.getElementById("chat-transport-badge"); if (!tb) return;
  let b = document.getElementById("p85-sec-badge");
  const st = p85SecurityState(c);
  if (!st) { if (b) b.classList.add("hidden"); return; }
  if (!b) {
    b = document.createElement("button"); b.type = "button"; b.id = "p85-sec-badge"; b.className = "p85-sec-badge";
    b.addEventListener("click", (e) => { e.stopPropagation(); if (state.chatId) { try { openSafetySheet(state.chatId); } catch (er) {} } });
    tb.insertAdjacentElement("afterend", b);
  }
  b.classList.remove("hidden");
  b.dataset.state = st;
  b.innerHTML = Icons.html(st === "changed" ? "warning" : "shield", 14) + (st === "verified" ? '<span class="p85-sec-check" aria-hidden="true">✓</span>' : "");
  const label = T("p85.sec." + st);
  b.setAttribute("aria-label", label); b.title = label;
}

// ---------- 6. Альбомы: подряд идущие фото одного автора (до 10, не дальше 60 с друг от друга) — сеткой ----------
const ALBUM_GAP_MS = 60000, ALBUM_MAX = 10;
function p85IsPhotoRow(row) {
  if (!row || !row.classList || !row.classList.contains("bubble-row")) return false;
  const slots = row.querySelectorAll('.file-media-slot[data-file-kind="image"]');
  if (slots.length !== 1) return false;
  return !row.querySelector(".bubble-reply, .link-preview-slot");
}
function p85GroupAlbums() {
  const wrap = document.getElementById("chat-messages"); const c = state.chatId && state.contacts.get(state.chatId);
  if (!wrap || !c || wrap.querySelector(".p85-album")) return;
  const byId = new Map(c.messages.map((m) => [m.id, m]));
  const rows = Array.from(wrap.children);
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const box = document.createElement("div");
      box.className = "p85-album " + (run[0].classList.contains("mine") ? "mine" : "theirs") + " n" + Math.min(run.length, 4);
      run[0].insertAdjacentElement("beforebegin", box);
      run.forEach((r) => { r.classList.add("p85-album-item"); box.appendChild(r); });
    }
    run = [];
  };
  for (const row of rows) {
    if (!p85IsPhotoRow(row)) { flush(); continue; }
    const slot = row.querySelector(".file-media-slot"); const m = byId.get(slot.getAttribute("data-file-id"));
    const prev = run.length ? byId.get(run[run.length - 1].querySelector(".file-media-slot").getAttribute("data-file-id")) : null;
    const same = prev && m && prev.from === m.from && (prev.fromId || "") === (m.fromId || "") && Math.abs(m.ts - prev.ts) <= ALBUM_GAP_MS && run.length < ALBUM_MAX;
    if (!m) { flush(); continue; }
    if (run.length && !same) flush();
    run.push(row);
  }
  flush();
}
// Отправка нескольких фото: одна шторка с сеткой превью и общей подписью (подпись уходит с первым фото)
let __p85Album = null;
function p85OpenAlbumSheet(files) {
  __p85Album = files.slice(0, ALBUM_MAX);
  let sheet = document.getElementById("p85-album-sheet");
  if (!sheet) {
    sheet = document.createElement("div"); sheet.id = "p85-album-sheet"; sheet.className = "sheet hidden"; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
    sheet.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet-panel glass-content"><div class="sheet-handle"></div>
      <h2 class="sheet-title" id="p85-album-title"></h2><div id="p85-album-grid" class="p85-album-grid"></div>
      <input id="p85-album-caption" type="text" maxlength="200" class="rename-input" data-i18n-ph="chat.caption" placeholder="${escapeHtml(T("chat.caption"))}" />
      <button type="button" id="p85-album-send" class="btn-primary">${escapeHtml(T("chat.send"))}</button>
      <button type="button" class="btn-tertiary sheet-cancel" id="p85-album-cancel">${escapeHtml(T("sys.cancel"))}</button></div>`;
    document.body.appendChild(sheet);
    const close = () => { sheet.querySelectorAll("img").forEach((i) => { try { URL.revokeObjectURL(i.src); } catch (e) {} }); sheet.classList.add("hidden"); __p85Album = null; };
    sheet.querySelector(".sheet-backdrop").addEventListener("click", close);
    sheet.querySelector("#p85-album-cancel").addEventListener("click", close);
    sheet.querySelector("#p85-album-send").addEventListener("click", () => {
      const files2 = __p85Album || []; const cid = state.chatId; const cap = sheet.querySelector("#p85-album-caption").value.trim();
      close();
      if (cid) p85SendAlbum(cid, files2, cap);
    });
  }
  sheet.querySelector("#p85-album-title").textContent = T("p85.album.title", { n: __p85Album.length });
  sheet.querySelector("#p85-album-caption").value = "";
  const grid = sheet.querySelector("#p85-album-grid"); grid.innerHTML = "";
  __p85Album.forEach((f, i) => {
    const cell = document.createElement("div"); cell.className = "p85-album-cell";
    const img = document.createElement("img"); img.alt = ""; try { img.src = URL.createObjectURL(f); } catch (e) {}
    const rm = document.createElement("button"); rm.type = "button"; rm.className = "p85-album-rm"; rm.setAttribute("aria-label", T("p85.album.remove")); rm.innerHTML = Icons.html("x", 14);
    rm.addEventListener("click", () => { __p85Album.splice(__p85Album.indexOf(f), 1); if (__p85Album.length) p85OpenAlbumSheet(__p85Album); else sheet.querySelector("#p85-album-cancel").click(); });
    cell.appendChild(img); cell.appendChild(rm); grid.appendChild(cell);
  });
  sheet.classList.remove("hidden");
}
async function p85SendAlbum(contactId, files, caption) {
  for (let i = 0; i < files.length; i++) { try { await sendFileMessage(contactId, files[i], { silent: true, caption: i === 0 ? caption : "" }); } catch (e) {} }
}

// ---------- 7. Редактор фото в шторке отправки ----------
const P85_ED = { canvas: null, ctx: null, tool: null, edited: false, img: null, file: null };
function p85EditorTools() {
  const preview = document.getElementById("media-compose-preview"); if (!preview) return null;
  let bar = document.getElementById("p85-edit-bar");
  if (!bar) {
    bar = document.createElement("div"); bar.id = "p85-edit-bar"; bar.className = "p85-edit-bar"; bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", T("p85.edit.title"));
    const b = (id, icon, key) => `<button type="button" class="icon-btn p85-edit-btn" data-edit="${id}" aria-label="${escapeHtml(T(key))}" title="${escapeHtml(T(key))}">${Icons.html(icon, 18)}</button>`;
    bar.innerHTML = b("rotate", "refresh", "p85.edit.rotate") + b("square", "image", "p85.edit.square") + b("draw", "edit", "p85.edit.draw") + b("blur", "sparkle", "p85.edit.blur") + b("reset", "x", "p85.edit.reset");
    preview.insertAdjacentElement("afterend", bar);
    bar.addEventListener("click", (e) => { const t = e.target.closest("[data-edit]"); if (t) p85EditAction(t.dataset.edit); });
  }
  return bar;
}
function p85EditorStart(file) {
  P85_ED.file = file; P85_ED.edited = false; P85_ED.tool = null; P85_ED.canvas = null;
  const bar = p85EditorTools(); if (!bar) return;
  const isImg = fileKindFromMime(file.type) === "image" && !/gif/i.test(file.type);
  bar.classList.toggle("hidden", !isImg);
  bar.querySelectorAll("[data-edit]").forEach((x) => x.setAttribute("aria-pressed", "false"));
}
function p85EnsureCanvas() {
  if (P85_ED.canvas) return Promise.resolve(P85_ED.canvas);
  const preview = document.getElementById("media-compose-preview"); const img = preview && preview.querySelector("img");
  if (!img) return Promise.resolve(null);
  return new Promise((res) => {
    const go = () => {
      const cv = document.createElement("canvas"); const W = img.naturalWidth || 1, H = img.naturalHeight || 1;
      const k = Math.min(1, 2048 / Math.max(W, H)); cv.width = Math.round(W * k); cv.height = Math.round(H * k);
      cv.className = "p85-edit-canvas"; const ctx = cv.getContext && cv.getContext("2d"); if (!ctx) { res(null); return; }
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      img.replaceWith(cv); P85_ED.canvas = cv; P85_ED.ctx = ctx; p85WireCanvas(cv); res(cv);
    };
    if (img.complete) go(); else { img.addEventListener("load", go, { once: true }); img.addEventListener("error", () => res(null), { once: true }); }
  });
}
function p85CanvasPoint(cv, e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (cv.width / (r.width || 1)), y: (e.clientY - r.top) * (cv.height / (r.height || 1)) }; }
function p85BlurAt(ctx, x, y, rad) {
  const s = Math.max(6, Math.round(rad / 4)); const x0 = Math.max(0, Math.round(x - rad)), y0 = Math.max(0, Math.round(y - rad));
  const w = Math.min(ctx.canvas.width - x0, rad * 2), h = Math.min(ctx.canvas.height - y0, rad * 2); if (w <= 0 || h <= 0) return;
  const d = ctx.getImageData(x0, y0, w, h);
  for (let by = 0; by < h; by += s) for (let bx = 0; bx < w; bx += s) { // пикселизация: необратима, в отличие от лёгкого размытия
    const i = (by * w + bx) * 4; const r = d.data[i], g = d.data[i + 1], b = d.data[i + 2];
    for (let yy = by; yy < Math.min(by + s, h); yy++) for (let xx = bx; xx < Math.min(bx + s, w); xx++) { const j = (yy * w + xx) * 4; d.data[j] = r; d.data[j + 1] = g; d.data[j + 2] = b; }
  }
  ctx.putImageData(d, x0, y0);
}
function p85WireCanvas(cv) {
  let down = false, last = null;
  cv.style.touchAction = "none";
  cv.addEventListener("pointerdown", (e) => { if (!P85_ED.tool) return; down = true; last = p85CanvasPoint(cv, e); try { cv.setPointerCapture(e.pointerId); } catch (er) {} p85Stroke(last, last); });
  cv.addEventListener("pointermove", (e) => { if (!down) return; const p = p85CanvasPoint(cv, e); p85Stroke(last, p); last = p; });
  const up = () => { down = false; last = null; };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
}
function p85Stroke(a, b) {
  const ctx = P85_ED.ctx; if (!ctx) return; P85_ED.edited = true;
  const unit = Math.max(ctx.canvas.width, ctx.canvas.height) / 100;
  if (P85_ED.tool === "draw") {
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff3b30";
    ctx.lineWidth = unit * 0.8; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  } else if (P85_ED.tool === "blur") p85BlurAt(ctx, b.x, b.y, Math.round(unit * 5));
}
async function p85EditAction(act) {
  if (act === "reset") { const f = P85_ED.file; if (f) { openMediaComposeSheet(f); } return; }
  const cv = await p85EnsureCanvas(); if (!cv) return;
  const ctx = P85_ED.ctx;
  if (act === "rotate" || act === "square") {
    const src = document.createElement("canvas"); src.width = cv.width; src.height = cv.height; src.getContext("2d").drawImage(cv, 0, 0);
    if (act === "rotate") { cv.width = src.height; cv.height = src.width; ctx.save(); ctx.translate(cv.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(src, 0, 0); ctx.restore(); }
    else { const s = Math.min(src.width, src.height); cv.width = s; cv.height = s; ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, s, s); }
    P85_ED.edited = true; return;
  }
  P85_ED.tool = P85_ED.tool === act ? null : act;
  document.querySelectorAll("#p85-edit-bar [data-edit]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.edit === P85_ED.tool ? "true" : "false"));
}
function p85EditedFile() {
  return new Promise((res) => {
    if (!P85_ED.edited || !P85_ED.canvas || !P85_ED.canvas.toBlob) { res(null); return; }
    const name = String((P85_ED.file && P85_ED.file.name) || "photo").replace(/\.[^.]+$/, "") + ".jpg";
    P85_ED.canvas.toBlob((b) => res(b ? new File([b], name, { type: "image/jpeg" }) : null), "image/jpeg", 0.9);
  });
}

// ---------- 5. Плавный вход в чат и свайп «назад» ----------
function p85ReduceMotion() {
  try { if (document.documentElement.classList.contains("p84-reduce-motion")) return true; return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
}
let __p85LastChat = null;
function p85OnRender() {
  const id = state.chatId || null;
  if (id !== __p85LastChat) {
    const scr = document.getElementById(id ? "screen-chat" : "screen-chats") || document.getElementById("content");
    if (scr && !p85ReduceMotion() && __p85LastChat !== undefined) {
      const cls = id ? "p85-enter" : "p85-back";
      scr.classList.remove("p85-enter", "p85-back"); void scr.offsetWidth; scr.classList.add(cls);
      setTimeout(() => scr.classList.remove(cls), 320);
    }
    __p85LastChat = id;
  }
  try { p85RenderSecBadge(); } catch (e) {}
  try { if (state.tab === "settings") p85ArrangeSettings(); } catch (e) {}
}
function p85WireEdgeSwipe() {
  const scr = document.getElementById("screen-chat"); if (!scr || scr.dataset.p85Swipe) return; scr.dataset.p85Swipe = "1";
  let sx = 0, sy = 0, on = false;
  scr.addEventListener("touchstart", (e) => { const t = e.touches && e.touches[0]; on = !!(t && t.clientX <= 24 && state.chatId && !isWideLayout()); if (on) { sx = t.clientX; sy = t.clientY; } }, { passive: true });
  scr.addEventListener("touchmove", (e) => {
    if (!on) return; const t = e.touches[0]; const dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
    if (dy > 60) { on = false; scr.style.transform = ""; return; }
    if (dx > 0 && !p85ReduceMotion()) scr.style.transform = `translateX(${Math.min(dx, 160) * 0.6}px)`;
  }, { passive: true });
  scr.addEventListener("touchend", (e) => {
    if (!on) return; on = false; scr.style.transform = "";
    const t = e.changedTouches && e.changedTouches[0]; if (!t) return;
    if (t.clientX - sx > 90 && Math.abs(t.clientY - sy) < 60) { try { closeChatSafely(); } catch (er) {} }
  }, { passive: true });
}

// ---------- 8. Звонок: своё видео в любом углу, смена местами, кнопки прячутся сами ----------
const P85_CORNER_KEY = "ether.call.corner";
function p85CallSnap(el, x, y) {
  const W = window.innerWidth || 360, H = window.innerHeight || 640;
  const corner = (y < H / 2 ? "t" : "b") + (x < W / 2 ? "l" : "r");
  el.dataset.corner = corner; el.style.left = el.style.top = el.style.right = el.style.bottom = ""; el.style.transform = "";
  try { localStorage.setItem(P85_CORNER_KEY, corner); } catch (e) {}
  return corner;
}
let __p85CallIdle = null;
function p85CallPoke() {
  const scr = document.getElementById("call-screen"); if (!scr) return;
  scr.classList.remove("p85-idle");
  clearTimeout(__p85CallIdle);
  __p85CallIdle = setTimeout(() => { const rv = document.getElementById("call-remote-video"); if (rv && !rv.classList.contains("hidden") && !scr.classList.contains("hidden")) scr.classList.add("p85-idle"); }, 4000);
}
function p85WireCall() {
  const lv = document.getElementById("call-local-video"), scr = document.getElementById("call-screen");
  if (!lv || !scr || lv.dataset.p85) return; lv.dataset.p85 = "1";
  try { lv.dataset.corner = localStorage.getItem(P85_CORNER_KEY) || "tr"; } catch (e) { lv.dataset.corner = "tr"; }
  let sx = 0, sy = 0, moved = false, down = false;
  lv.addEventListener("pointerdown", (e) => { down = true; moved = false; sx = e.clientX; sy = e.clientY; try { lv.setPointerCapture(e.pointerId); } catch (er) {} });
  lv.addEventListener("pointermove", (e) => { if (!down) return; const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 8) moved = true; if (moved) lv.style.transform = `translate(${dx}px, ${dy}px) scaleX(-1)`; });
  lv.addEventListener("pointerup", (e) => { if (!down) return; down = false; if (moved) p85CallSnap(lv, e.clientX, e.clientY); else scr.classList.toggle("p85-swapped"); });
  ["pointerdown", "touchstart", "keydown"].forEach((ev) => scr.addEventListener(ev, p85CallPoke, { passive: true }));
}

// ---------- 9. «Прочитано» из уведомления при закрытом приложении ----------
async function p85ApplyPendingReads() {
  try {
    if (typeof caches === "undefined") return 0;
    const cache = await caches.open("ether-pending"); const r = await cache.match("./__pending-read.json"); if (!r) return 0;
    const ids = await r.json(); await cache.delete("./__pending-read.json");
    let n = 0;
    for (const id of Array.isArray(ids) ? ids.slice(0, 200) : []) { const c = state.contacts.get(String(id)); if (c) { markThreadRead(c); n++; } }
    if (n) { try { renderChatsList(); } catch (e) {} }
    return n;
  } catch (e) { return 0; }
}

// ---------- Три колонки на компьютере: в правой панели — защита и последние фото ----------
function p85WideExtras() {
  const box = document.getElementById("wide-info"); const c = state.chatId && state.contacts.get(state.chatId);
  if (!box || !c || box.classList.contains("hidden")) return;
  const st = p85SecurityState(c);
  if (st) {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn-secondary p85-wide-sec"; b.dataset.state = st;
    b.innerHTML = Icons.html(st === "changed" ? "warning" : "shield", 16) + "<span>" + escapeHtml(T("p85.sec." + st)) + "</span>";
    b.addEventListener("click", () => { try { openSafetySheet(c.id); } catch (e) {} });
    box.appendChild(b);
  }
  const photos = c.messages.filter((m) => m.file && m.file.kind === "image" && !m.deleted).slice(-6).reverse();
  if (photos.length) {
    const g = document.createElement("div"); g.className = "p85-wide-media";
    for (const m of photos) {
      const cell = document.createElement("button"); cell.type = "button"; cell.className = "p85-wide-thumb"; cell.setAttribute("aria-label", m.file.name || "");
      cell.addEventListener("click", () => { try { ensureMessageRendered(c.id, m.id); const el = document.querySelector('[data-msg-id="' + CSS.escape(m.id) + '"]'); if (el) el.scrollIntoView({ block: "center" }); } catch (e) {} });
      g.appendChild(cell);
      try { IDB.get("file:" + m.id).then((blob) => { if (blob && cell.isConnected) { const u = URL.createObjectURL(blob); cell.style.backgroundImage = "url('" + u + "')"; } }).catch(() => {}); } catch (e) {}
    }
    box.appendChild(g);
  }
}

// ---------- Подключение ----------
let __p85Wired = false;
function p85Wire() {
  if (__p85Wired || typeof document === "undefined") return;
  __p85Wired = true;
  const origThread = renderChatThreadInner;
  renderChatThreadInner = function () { const r = origThread.apply(this, arguments); try { p85GroupAlbums(); } catch (e) {} return r; };
  const origTab = renderTab;
  renderTab = function () { const r = origTab.apply(this, arguments); try { p85OnRender(); } catch (e) {} return r; };
  const origPicked = handlePickedFiles;
  handlePickedFiles = function (files) {
    const imgs = (files || []).filter((f) => fileKindFromMime(f.type) === "image");
    if (files && files.length > 1 && imgs.length === files.length && state.chatId) { p85OpenAlbumSheet(imgs); return; }
    return origPicked.apply(this, arguments);
  };
  const origCompose = openMediaComposeSheet;
  openMediaComposeSheet = function (file) { const r = origCompose.apply(this, arguments); try { p85EditorStart(file); } catch (e) {} return r; };
  const send = document.getElementById("media-compose-send");
  if (send) send.addEventListener("click", (e) => {
    if (!P85_ED.edited || send.dataset.p85Pass) return;
    e.stopImmediatePropagation(); e.preventDefault();
    p85EditedFile().then((f) => { if (f) __pendingComposeFile = f; P85_ED.edited = false; send.dataset.p85Pass = "1"; send.click(); delete send.dataset.p85Pass; });
  }, true);
  if (typeof renderWideInfo === "function") {
    const origWide = renderWideInfo;
    renderWideInfo = function () { const r = origWide.apply(this, arguments); try { p85WideExtras(); } catch (e) {} return r; };
  }
  p85ArrangeSettings();
  p85WireEdgeSwipe();
  p85WireCall();
  setTimeout(() => { p85ApplyPendingReads(); }, 1200);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) p85ApplyPendingReads(); });
  try { p85OnRender(); } catch (e) {}
}
