"use strict";

// =====================================================================
// features2.js — вторая волна «слоя удовольствия» (ux-ui-design-vision, остаток):
// занавес и «пока» 👋, голос-тема контакта, ambient-слой, закрытие дня, мягкий скин (форма/шрифт),
// Созвездие, рисование на видео, Vision Loop, мини-треды реакций, Time Capsule Wall, Replay месяца,
// «Костёр» (временная комната по QR), cosmetic-бонус за приглашение, погодный оттенок (opt-in),
// краевой пульс (только при открытом приложении), хаптика (Android), «активен сейчас» в открытом чате,
// Call Film (небиометрическая сводка группового звонка).
// Всё локальное и отключаемое; ничего не передаётся без явного согласия обеих сторон.
// Подключается после features.js.
// =====================================================================

Object.assign(FX_DEFAULTS, {
  veil: true, wave: true, composer: false, ambient: false, presence: true, pulse: false, haptics: false,
  look: false, draw: true, weather: false, constellation: false,
});

const fx2Esc = (s) => escapeHtml(String(s == null ? "" : s));
const fx2Today = () => new Date(Date.now() - 4 * 3600 * 1000).toDateString(); // «ночь» заканчивается в 04:00
const fx2Link = (id) => (typeof mesh !== "undefined" && mesh && mesh.get ? mesh.get(id) : null);
function fx2Send(id, payload) { const l = fx2Link(id); if (!l) return false; try { l.send(payload); return true; } catch (e) { return false; } }
function fx2Ctx() { try { const c = ensureGlobalAudioCtx(); return c && c.state === "running" ? c : null; } catch (e) { return null; } }

// ---------------------------------------------------------------------
// Занавес при входе в чат, прощальная волна, голос-тема контакта
// ---------------------------------------------------------------------
let fx2LastChat = null;
function fx2OnChatChange() {
  const cur = state.chatId || null;
  if (cur === fx2LastChat) return;
  fx2LastChat = cur;
  if (!cur) return;
  if (FX.get("veil")) {
    const s = document.getElementById("screen-chat");
    if (s) { s.classList.remove("fx-veil"); void s.offsetWidth; s.classList.add("fx-veil"); setTimeout(() => s.classList.remove("fx-veil"), 260); }
  }
  if (FX.get("composer")) { try { playComposerVoice(cur); } catch (e) {} }
}

const FX_GOODBYE = /(?:^|[\s,.!;:])(пока|до свидания|до завтра|до встречи|спокойной ночи|bye|goodbye|good ?night|see you|ciao|adios|tschüss|au revoir)(?=$|[\s,.!?;:])/i;
function fxWaveGoodbye() {
  const el = document.createElement("div"); el.className = "fx-wave"; el.setAttribute("aria-hidden", "true"); el.textContent = "👋";
  document.body.appendChild(el); setTimeout(() => el.remove(), 1800);
}
const _fx2OrigSendChat = sendChatMessage;
sendChatMessage = function (contactId, text) {
  try { if (FX.get("wave") && typeof text === "string" && FX_GOODBYE.test(text)) fxWaveGoodbye(); } catch (e) {}
  try { fxHaptic("send"); fxAmbientBump(); } catch (e) {}
  return _fx2OrigSendChat.apply(this, arguments);
};

// 3-секундная тема контакта: 5 нот пентатоники, детерминированно из ключа
function composerThemeFor(str) {
  const r = fxSeed("composer|" + str); const out = []; let t = 0;
  for (let i = 0; i < 5; i++) { const f = FX_PENTA[r() % FX_PENTA.length]; const d = [0.35, 0.5, 0.7][r() % 3]; out.push({ f, t, d }); t += d * 0.8; }
  const total = out[out.length - 1].t + out[out.length - 1].d;
  const k = total > 3 ? 3 / total : 1;
  return out.map((n) => ({ f: n.f, t: n.t * k, d: n.d * k }));
}
function playComposerVoice(contactId) {
  const c = state.contacts.get(contactId); if (!c || c.isSelf || !Store.soundsEnabled) return false;
  const ctx = document.visibilityState === "visible" ? fx2Ctx() : null; if (!ctx) return false;
  const t0 = ctx.currentTime + 0.05;
  for (const n of composerThemeFor(fxKeyString(c))) {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = "triangle"; osc.frequency.value = n.f; g.gain.value = 0.0001;
    osc.connect(g); g.connect(ctx.destination);
    const at = t0 + n.t;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.05, at + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, at + n.d + 0.25);
    osc.start(at); osc.stop(at + n.d + 0.3);
  }
  return true;
}

// ---------------------------------------------------------------------
// Ambient Sound Layer: шум-«ветер» + редкие колокольчики, синхронно с активностью чата
// ---------------------------------------------------------------------
const fxAmb = { on: false, master: null, nodes: [], timer: null, base: 0.018 };
function fxAmbientStart() {
  if (fxAmb.on) return true;
  const ctx = fx2Ctx(); if (!ctx || !Store.soundsEnabled) return false;
  try {
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const filt = ctx.createBiquadFilter(); filt.type = "bandpass"; filt.frequency.value = 520; filt.Q.value = 0.6;
    const master = ctx.createGain(); master.gain.value = 0.0001;
    const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.frequency.value = 0.07; lfoG.gain.value = fxAmb.base * 0.5;
    lfo.connect(lfoG); lfoG.connect(master.gain);
    src.connect(filt); filt.connect(master); master.connect(ctx.destination);
    const t = ctx.currentTime;
    master.gain.setValueAtTime(0.0001, t); master.gain.linearRampToValueAtTime(fxAmb.base, t + 2);
    src.start(); lfo.start();
    fxAmb.master = master; fxAmb.nodes = [src, lfo]; fxAmb.on = true;
    fxAmbientBell();
  } catch (e) { fxAmb.on = false; return false; }
  return true;
}
function fxAmbientBell() {
  clearTimeout(fxAmb.timer);
  fxAmb.timer = setTimeout(() => {
    const ctx = fx2Ctx();
    if (fxAmb.on && ctx && !document.hidden) {
      try {
        const f = FX_PENTA[Math.floor(Math.random() * FX_PENTA.length)] * 2, o = ctx.createOscillator(), g = ctx.createGain(), at = ctx.currentTime + 0.01;
        o.type = "sine"; o.frequency.value = f; g.gain.value = 0.0001; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.025, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 2.6);
        o.start(at); o.stop(at + 2.7);
      } catch (e) {}
    }
    if (fxAmb.on) fxAmbientBell();
  }, 9000 + Math.random() * 13000);
}
function fxAmbientStop() {
  clearTimeout(fxAmb.timer); fxAmb.timer = null;
  if (!fxAmb.on) return;
  const ctx = fx2Ctx();
  try { if (ctx && fxAmb.master) { fxAmb.master.gain.cancelScheduledValues && fxAmb.master.gain.cancelScheduledValues(ctx.currentTime); fxAmb.master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.5); } } catch (e) {}
  const nodes = fxAmb.nodes; fxAmb.nodes = []; fxAmb.master = null; fxAmb.on = false;
  setTimeout(() => nodes.forEach((n) => { try { n.stop(); } catch (e) {} }), 600);
}
function fxAmbientBump() {
  if (!fxAmb.on || !fxAmb.master) return;
  const ctx = fx2Ctx(); if (!ctx) return;
  try {
    const t = ctx.currentTime;
    fxAmb.master.gain.linearRampToValueAtTime(fxAmb.base * 2.2, t + 0.4);
    fxAmb.master.gain.linearRampToValueAtTime(fxAmb.base, t + 3);
  } catch (e) {}
}
function fxAmbientSync() {
  const want = !!FX.get("ambient") && !document.hidden && !!Store.soundsEnabled;
  if (want) fxAmbientStart(); else fxAmbientStop();
}

// ---------------------------------------------------------------------
// Ритуал закрытия дня
// ---------------------------------------------------------------------
function fxCloseDay() {
  try { localStorage.setItem("ether.fx.lastClose", fx2Today()); } catch (e) {}
  if (document.querySelector(".fx-dusk")) return;
  const el = document.createElement("div"); el.className = "fx-dusk"; el.setAttribute("role", "status");
  el.innerHTML = `<span>🌙 ${fx2Esc(T("fx2.dusk"))}</span>`;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("fx-dusk-in"), 20);
  setTimeout(() => el.remove(), 6500);
}
let fx2LastInput = Date.now();
function fxDuskCheck(now) {
  if (!FX.get("ritual") || document.hidden) return false;
  const d = new Date(now || Date.now()), h = d.getHours();
  if (!(h >= 22 || h < 4)) return false;
  if ((now || Date.now()) - fx2LastInput < 90000) return false;
  let last = null; try { last = localStorage.getItem("ether.fx.lastClose"); } catch (e) {}
  if (last === fx2Today()) return false;
  fxCloseDay(); return true;
}
function fxWireDusk() {
  for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, () => { fx2LastInput = Date.now(); }, { passive: true });
  setInterval(() => { try { fxDuskCheck(); } catch (e) {} }, 15000);
}

// ---------------------------------------------------------------------
// Мягкий скин контакта: форма пузырей и шрифт (сетка интерфейса не меняется)
// ---------------------------------------------------------------------
function skinTraits(c) {
  const r = fxSeed("skin2|" + fxKeyString(c)); const a = r(), b = r();
  return { shape: ["round", "soft", "sharp"][a % 3], font: ["sans", "rounded", "serif"][b % 3] };
}
function fx2ApplySkin() {
  const s = document.getElementById("screen-chat"); if (!s) return;
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  if (FX.get("skin") && c && !c.isSelf) { const t = skinTraits(c); s.setAttribute("data-skin-shape", t.shape); s.setAttribute("data-skin-font", t.font); }
  else { s.removeAttribute("data-skin-shape"); s.removeAttribute("data-skin-font"); }
}

// Сезон: смена палитры по календарю плавно в течение 3 дней после начала сезона (без геолокации)
const FX_SEASONS = [[11, 21, 24], [2, 20, -14], [5, 21, 6], [8, 22, 18]]; // [месяц, день, hue]: зима, весна, лето, осень
function seasonHueSmooth(date) {
  const d = date ? new Date(date) : new Date(), y = d.getFullYear();
  const starts = [];
  for (const yy of [y - 1, y]) for (const [m, day, hue] of FX_SEASONS) starts.push({ t: new Date(yy, m, day).getTime(), hue });
  starts.sort((a, b) => a.t - b.t);
  let i = -1; for (let k = 0; k < starts.length; k++) if (starts[k].t <= d.getTime()) i = k;
  if (i < 0) return starts[0].hue;
  const cur = starts[i], prev = starts[i - 1] || cur;
  const f = Math.min(1, (d.getTime() - cur.t) / (3 * 86400000));
  return Math.round((prev.hue + (cur.hue - prev.hue) * f) * 10) / 10;
}
seasonHue = seasonHueSmooth;

// Активность в ОТКРЫТОМ чате: точка ярче (не на списке аватаров — это слишком шумно и тратит батарею)
function fx2Presence() {
  const av = document.getElementById("chat-peer-avatar"); if (!av) return;
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  const l = c ? fx2Link(c.id) : null;
  av.classList.toggle("fx-active", !!(FX.get("presence") && c && !isGroup(c) && ((l && (l.status === "connected" || l.status === "in-call")) || c.online)));
}

// ---------------------------------------------------------------------
// Созвездие: альтернативный вид списка контактов (точки-звёзды, без связей между контактами)
// ---------------------------------------------------------------------
const FX_CONSTELLATION_MAX = 60;
function constellationStars(contacts, now) {
  now = now || Date.now();
  const list = contacts.filter((c) => c && !c.isGroup && !c.isSelf && !c.blocked).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, FX_CONSTELLATION_MAX);
  const n = list.length || 1, cols = Math.ceil(Math.sqrt(n * 1.1)), rows = Math.ceil(n / cols);
  return list.map((c, i) => {
    const r = fxSeed("star|" + fxKeyString(c));
    const cx = ((i % cols) + 0.5 + ((r() % 61) - 30) / 100) / cols * 100;
    const cy = (Math.floor(i / cols) + 0.5 + ((r() % 61) - 30) / 100) / rows * 118 + 1;
    const days = c.lastActivity ? (now - c.lastActivity) / 86400000 : 999;
    const bright = c.online ? 1 : Math.min(1, Math.max(0.35, 0.85 - Math.min(Math.max(days, 0), 30) / 60));
    return { id: c.id, name: c.name || "?", x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10, r: Math.round((1.2 + 2.4 * vaultLevel((c.messages || []).length)) * 10) / 10, bright, hue: 200 + (r() % 120) };
  });
}
function fx2RenderConstellation() {
  const host = document.getElementById("screen-connect"); if (!host) return;
  const card = host.querySelector(".connect-card"); if (!card) return;
  const search = document.getElementById("contacts-search"); if (!search) return;
  let bar = document.getElementById("fx-view-toggle");
  if (!bar) {
    bar = document.createElement("div"); bar.id = "fx-view-toggle"; bar.className = "fx-view-toggle";
    bar.innerHTML = `<button type="button" data-view="list" data-i18n="fx2.list">${fx2Esc(T("fx2.list"))}</button><button type="button" data-view="constellation" data-i18n="fx2.constellation">${fx2Esc(T("fx2.constellation"))}</button>`;
    bar.addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) { FX.set("constellation", b.dataset.view === "constellation"); } });
    search.insertAdjacentElement("beforebegin", bar);
  }
  let box = document.getElementById("fx-constellation");
  if (!box) { box = document.createElement("div"); box.id = "fx-constellation"; box.className = "fx-constellation hidden"; search.insertAdjacentElement("afterend", box); }
  const stars = constellationStars(Array.from(state.contacts.values()));
  const want = !!FX.get("constellation") && stars.length > 0;
  bar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", (b.dataset.view === "constellation") === !!FX.get("constellation")));
  const list = document.getElementById("contacts-list"), idx = document.getElementById("contacts-index");
  box.classList.toggle("hidden", !want);
  search.classList.toggle("hidden", want);
  if (list) list.classList.toggle("hidden", want);
  if (idx && want) idx.classList.add("hidden");
  if (!want) { box.innerHTML = ""; return; }
  const showNames = stars.length <= 24;
  box.innerHTML = `<svg viewBox="0 0 100 122" role="img" aria-label="${fx2Esc(T("fx2.constellation"))}" preserveAspectRatio="xMidYMid meet">`
    + stars.map((s) => `<g class="fx-star" data-id="${fx2Esc(s.id)}" tabindex="0" role="button" aria-label="${fx2Esc(s.name)}" style="opacity:${s.bright}">`
      + `<circle cx="${s.x}" cy="${s.y}" r="${s.r * 2.6}" fill="hsl(${s.hue} 90% 70% / .14)"/><circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="hsl(${s.hue} 90% 82%)"/>`
      + (showNames ? `<text x="${s.x}" y="${s.y + s.r + 3.4}" text-anchor="middle" font-size="2.9">${fx2Esc(truncate(s.name, 12))}</text>` : "") + `</g>`).join("")
    + `</svg>`;
  box.onclick = (e) => { const g = e.target.closest(".fx-star"); if (g && state.contacts.has(g.dataset.id)) { state.chatId = g.dataset.id; renderTab(); } };
}
const _fx2OrigRenderContactsList = renderContactsList;
renderContactsList = function () { _fx2OrigRenderContactsList.apply(this, arguments); try { fx2RenderConstellation(); } catch (e) {} };

// ---------------------------------------------------------------------
// Рисование на видео в 1:1-звонке (по обоюдному согласию, не сохраняется, штрихи тают за 5 с)
// ---------------------------------------------------------------------
const FXD = { active: false, peer: null, strokes: [], cur: null, raf: 0, asked: null };
const FXD_TTL = 5000, FXD_MAX_STROKES = 80, FXD_MAX_POINTS = 240;
function fxdSanitize(p) {
  if (!p || !Array.isArray(p.p)) return null;
  const pts = p.p.slice(0, FXD_MAX_POINTS).map((q) => Array.isArray(q) ? [Math.min(1, Math.max(0, +q[0] || 0)), Math.min(1, Math.max(0, +q[1] || 0))] : null).filter(Boolean);
  if (!pts.length) return null;
  const c = typeof p.c === "string" && /^#[0-9a-f]{6}$/i.test(p.c) ? p.c : "#5ac8ff";
  return { pts, c, t: Date.now() };
}
function fxdCanvas() {
  const scr = document.getElementById("call-screen"); if (!scr) return null;
  let cv = document.getElementById("fx-draw-canvas");
  if (!cv) {
    cv = document.createElement("canvas"); cv.id = "fx-draw-canvas"; cv.className = "fx-draw-canvas";
    scr.appendChild(cv);
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / Math.max(1, r.width), (e.clientY - r.top) / Math.max(1, r.height)]; };
    let lastSent = 0;
    cv.addEventListener("pointerdown", (e) => { if (!FXD.active) return; FXD.cur = { pts: [pos(e)], c: "#ff5a8a", t: Date.now(), mine: true }; FXD.strokes.push(FXD.cur); try { cv.setPointerCapture(e.pointerId); } catch (er) {} fxdLoop(); });
    cv.addEventListener("pointermove", (e) => {
      if (!FXD.cur) return; FXD.cur.pts.push(pos(e)); FXD.cur.t = Date.now();
      if (Date.now() - lastSent > 120 && FXD.peer) { lastSent = Date.now(); fx2Send(FXD.peer, { kind: "fxdraw", t: "s", c: FXD.cur.c, p: FXD.cur.pts.slice(-40) }); }
    });
    const end = () => { if (!FXD.cur) return; if (FXD.peer) fx2Send(FXD.peer, { kind: "fxdraw", t: "s", c: FXD.cur.c, p: FXD.cur.pts.slice(-FXD_MAX_POINTS) }); FXD.cur = null; };
    cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  }
  return cv;
}
function fxdLoop() {
  if (FXD.raf) return;
  const step = () => {
    FXD.raf = 0;
    const cv = document.getElementById("fx-draw-canvas"); if (!cv) return;
    const now = Date.now();
    FXD.strokes = FXD.strokes.filter((s) => now - s.t < FXD_TTL || s === FXD.cur);
    const w = cv.clientWidth || 300, h = cv.clientHeight || 500;
    if (cv.width !== w) cv.width = w; if (cv.height !== h) cv.height = h;
    const g = cv.getContext("2d"); if (!g) return;
    g.clearRect(0, 0, cv.width, cv.height); g.lineWidth = 5; g.lineCap = "round"; g.lineJoin = "round";
    for (const s of FXD.strokes) {
      g.globalAlpha = s === FXD.cur ? 1 : Math.max(0, 1 - (now - s.t) / FXD_TTL); g.strokeStyle = s.c; g.beginPath();
      s.pts.forEach(([x, y], i) => { if (i) g.lineTo(x * cv.width, y * cv.height); else g.moveTo(x * cv.width, y * cv.height); });
      if (s.pts.length === 1) g.lineTo(s.pts[0][0] * cv.width + 0.1, s.pts[0][1] * cv.height); g.stroke();
    }
    g.globalAlpha = 1;
    if (FXD.strokes.length) FXD.raf = requestAnimationFrame(step);
  };
  FXD.raf = requestAnimationFrame(step);
}
function fxdSetActive(on, peer) {
  FXD.active = !!on; FXD.peer = on ? peer : null;
  if (!on) { FXD.strokes = []; FXD.cur = null; }
  const cv = fxdCanvas(); if (cv) cv.classList.toggle("active", !!on);
  const btn = document.getElementById("fx-draw-btn"); if (btn) btn.classList.toggle("fx-on", !!on);
  fxdLoop();
}
function fxdAsk(peerId) {
  const l = fx2Link(peerId); const c = state.contacts.get(peerId);
  const old = document.getElementById("fx-ask"); if (old) old.remove();
  const box = document.createElement("div"); box.id = "fx-ask"; box.className = "gcall-invite-row fx-ask";
  box.innerHTML = `<span class="gcall-invite-text">${fx2Esc(T("fx2.draw.ask", { name: (c && c.name) || "" }))}</span><button type="button" class="gcall-invite-join">${fx2Esc(T("fx2.draw.allow"))}</button><button type="button" class="gcall-invite-no">${fx2Esc(T("fx2.draw.deny"))}</button>`;
  box.querySelector(".gcall-invite-join").addEventListener("click", () => { box.remove(); fx2Send(peerId, { kind: "fxdraw", t: "ok" }); fxdSetActive(true, peerId); });
  box.querySelector(".gcall-invite-no").addEventListener("click", () => { box.remove(); fx2Send(peerId, { kind: "fxdraw", t: "no" }); });
  (document.getElementById("call-screen") || document.body).appendChild(box);
  return !!l;
}
function fxdIn(from, p) {
  if (p.t === "req") {
    if (!FX.get("draw") || state.callId !== from || state.callPhase !== "active") { fx2Send(from, { kind: "fxdraw", t: "no" }); return; }
    fxdAsk(from);
  } else if (p.t === "ok") {
    if (state.callId === from) fxdSetActive(true, from);
  } else if (p.t === "no") {
    const c = state.contacts.get(from); if (state.callId === from) toast(T("fx2.draw.declined", { name: (c && c.name) || "" }));
  } else if (p.t === "stop") {
    if (FXD.peer === from) fxdSetActive(false);
  } else if (p.t === "s") {
    if (!FXD.active || FXD.peer !== from || state.callId !== from) return;
    const s = fxdSanitize(p); if (!s) return;
    FXD.strokes.push(s); if (FXD.strokes.length > FXD_MAX_STROKES) FXD.strokes.shift();
    fxdCanvas(); fxdLoop();
  }
}
function fx2InjectDrawButton() {
  // Кнопка «Рисовать» живёт в меню «ещё» звонка (основных кнопок четыре), а не в ряду основных
  const menu = document.getElementById("call-more-menu") || document.getElementById("call-controls-active"); if (!menu) return;
  let btn = document.getElementById("fx-draw-btn");
  if (!btn) {
    btn = document.createElement("button"); btn.type = "button"; btn.id = "fx-draw-btn"; btn.className = "call-menu-item hidden"; btn.setAttribute("role", "menuitem");
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg><span data-i18n="fx2.draw.btn">${fx2Esc(T("fx2.draw.btn"))}</span>`;
    btn.addEventListener("click", () => {
      const id = state.callId; if (!id) return;
      if (FXD.active) { fx2Send(id, { kind: "fxdraw", t: "stop" }); fxdSetActive(false); }
      else fx2Send(id, { kind: "fxdraw", t: "req" });
    });
    menu.appendChild(btn);
  }
  btn.classList.toggle("hidden", !(FX.get("draw") && state.callId && state.callPhase === "active"));
  if (!state.callId && FXD.active) fxdSetActive(false);
}

// ---------------------------------------------------------------------
// Vision Loop: 3-секундный «взгляд» — несколько живых кадров, без записи; нужен включённый приём с обеих сторон
// и видимый индикатор «камера открыта» у обоих
// ---------------------------------------------------------------------
const FXL = { sending: false, viewing: null, timer: null };
const FXL_MAX_FRAME = 24000; // символов data-URL одного кадра
function fxLookFrame(video) {
  const cv = document.createElement("canvas"); cv.width = 180; cv.height = 240;
  const g = cv.getContext("2d"); if (!g) return null;
  g.drawImage(video, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.5);
}
function fxLookOverlay(id, text, self) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement("div"); el.id = id; el.className = "fx-look"; el.innerHTML = `<div class="fx-look-dot"></div><img alt="" /><div class="fx-look-note"></div>`; document.body.appendChild(el); }
  el.querySelector(".fx-look-note").textContent = text;
  el.classList.toggle("self", !!self);
  return el;
}
function fxLookClose() {
  clearTimeout(FXL.timer); FXL.timer = null; FXL.viewing = null;
  for (const id of ["fx-look-view", "fx-look-self"]) { const el = document.getElementById(id); if (el) el.remove(); }
}
async function fxLookStart(peerId) {
  const c = state.contacts.get(peerId); if (!c || FXL.sending || !fx2Link(peerId)) return false;
  const ok = await confirmSheet(T("fx2.look.confirm", { name: c.name || "" })); if (!ok) return false;
  FXL.sending = true;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    if (!stream.getVideoTracks().length) throw new Error("no video");
    fx2Send(peerId, { kind: "fxlook", t: "start" });
    const video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    const selfEl = fxLookOverlay("fx-look-self", T("fx2.look.you"), true);
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      const d = fxLookFrame(video);
      if (d && d.length < FXL_MAX_FRAME) { selfEl.querySelector("img").src = d; fx2Send(peerId, { kind: "fxlook", t: "f", d }); }
      await new Promise((r) => setTimeout(r, 350));
    }
  } catch (e) {
    toast(T("toast.callPermissionDenied"));
  } finally {
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    fx2Send(peerId, { kind: "fxlook", t: "end" });
    FXL.sending = false; fxLookClose();
  }
  return true;
}
function fxLookIn(from, p) {
  const c = state.contacts.get(from); if (!c || c.blocked) return;
  if (p.t === "start") {
    if (!FX.get("look") || FXL.viewing) { fx2Send(from, { kind: "fxlook", t: "no" }); return; }
    FXL.viewing = from; try { fxLookOverlay("fx-look-view", T("fx2.look.indicator", { name: c.name || "" }), false); } catch (e) {}
    clearTimeout(FXL.timer); FXL.timer = setTimeout(fxLookClose, 6000);
  } else if (p.t === "f") {
    if (FXL.viewing !== from) return;
    if (typeof p.d !== "string" || p.d.length > FXL_MAX_FRAME || p.d.indexOf("data:image/jpeg;base64,") !== 0) return;
    const el = document.getElementById("fx-look-view"); if (el) el.querySelector("img").src = p.d;
  } else if (p.t === "end") {
    if (FXL.viewing === from) fxLookClose();
  } else if (p.t === "no") {
    if (FXL.sending) toast(T("fx2.look.unavailable", { name: c.name || "" }));
  }
}
function fx2InjectLookButton() {
  // «Заглянуть» (👁) живёт в карточке контакта, а не в шапке чата: шапка и так тесная (имя выдавливалось иконками).
  const nameEl = document.getElementById("contact-name"); if (!nameEl) return;
  let b = document.getElementById("fx-look-btn");
  const cid = state.contactCardId;
  const c = cid ? state.contacts.get(cid) : null;
  const show = !!(FX.get("look") && c && !isGroup(c) && !c.isSelf);
  if (!b) {
    b = document.createElement("button"); b.type = "button"; b.id = "fx-look-btn"; b.className = "btn-secondary fx-look-row hidden";
    b.setAttribute("data-i18n", "fx2.look.btn");
    b.addEventListener("click", () => { if (state.contactCardId) fxLookStart(state.contactCardId); });
    nameEl.parentNode.appendChild(b);
  }
  b.textContent = "👁 " + T("fx2.look.btn");
  b.classList.toggle("hidden", !show);
}

// единая точка для служебных fx*-сообщений по data channel
function handleFxPayload(from, p) {
  if (!p || typeof p.kind !== "string") return;
  if (p.kind === "fxdraw") fxdIn(from, p);
  else if (p.kind === "fxlook") fxLookIn(from, p);
}

// ---------------------------------------------------------------------
// Мини-треды реакций: ответы, привязанные к реакции (обычный reply с невидимой меткой — без смены протокола)
// ---------------------------------------------------------------------
const FX_RT = "⁣";
const fxRtMark = (emoji) => emoji + FX_RT;
function fxThreadReplies(c, msgId, emoji) {
  const mark = fxRtMark(emoji);
  return (c.messages || []).filter((m) => m.replyTo && (m.replyTo.id || m.replyTo.msgId) === msgId && typeof m.replyTo.text === "string" && m.replyTo.text.indexOf(mark) === 0);
}
function fxOpenThread(contactId, msgId, emoji) {
  const c = state.contacts.get(contactId); if (!c) return null;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return null;
  let sh = document.getElementById("fx-thread-sheet"); if (sh) sh.remove();
  sh = document.createElement("div"); sh.id = "fx-thread-sheet"; sh.className = "sheet";
  sh.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet-panel glass-content"><div class="sheet-handle"></div>
    <h3 class="fx-thread-title">${fx2Esc(emoji)} ${fx2Esc(T("fx2.thread.title"))}</h3>
    <p class="fx-thread-origin muted">${fx2Esc(truncate(m.text || "", 120))}</p>
    <div class="fx-thread-list"></div>
    <div class="fx-thread-form"><input type="text" class="search-input" maxlength="500" placeholder="${fx2Esc(T("fx2.thread.ph"))}" /><button type="button" class="btn-primary">${fx2Esc(T("fx2.thread.send"))}</button></div></div>`;
  document.body.appendChild(sh);
  const close = () => sh.remove();
  sh.querySelector(".sheet-backdrop").addEventListener("click", close);
  const render = () => {
    const list = sh.querySelector(".fx-thread-list"), rs = fxThreadReplies(c, msgId, emoji);
    list.innerHTML = rs.length ? rs.map((r) => `<div class="fx-thread-item ${r.from === "me" ? "mine" : ""}"><b>${fx2Esc(r.from === "me" ? (Store.name || "") : (r.fromName || c.name || ""))}</b> ${fx2Esc(r.text)}</div>`).join("") : `<p class="muted">${fx2Esc(T("fx2.thread.empty"))}</p>`;
  };
  render();
  const input = sh.querySelector("input");
  const send = () => {
    const text = input.value.trim(); if (!text) return; input.value = "";
    const reply = { msgId, text: fxRtMark(emoji) + " " + (m.text || ""), authorName: m.from === "me" ? (Store.name || "") : (m.fromName || c.name || "") };
    if (isGroup(c)) sendGroupMessage(contactId, text, reply); else sendChatMessage(contactId, text, reply);
    setTimeout(render, 30);
  };
  sh.querySelector("button").addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
  return sh;
}
function fxWireThreads() {
  const wrap = document.getElementById("chat-messages"); if (!wrap || wrap.__fxThreads) return;
  wrap.__fxThreads = true;
  wrap.addEventListener("click", (e) => {
    const chip = e.target.closest && e.target.closest(".bubble-reaction-chip"); if (!chip || !state.chatId) return;
    const row = chip.closest("[data-msg-id]"); const emoji = chip.getAttribute("data-emoji");
    if (row && emoji) { e.stopPropagation(); fxOpenThread(state.chatId, row.getAttribute("data-msg-id"), emoji); }
  });
}
// Усиленная реакция: долгий тап по эмодзи (вместо pinch) — крупнее и ярче
let fxBigReaction = false;
const _fx2OrigBurst = spawnReactionBurst;
spawnReactionBurst = function (el, emoji) {
  _fx2OrigBurst.apply(this, arguments);
  if (fxBigReaction) { fxBigReaction = false; for (let i = 1; i < 5; i++) setTimeout(() => { try { _fx2OrigBurst(el, emoji); } catch (e) {} }, i * 90); const b = el && el.querySelector && el.querySelector(".reaction-burst"); if (b) b.classList.add("big"); }
};
function fxWireBigReaction() {
  const fl = document.getElementById("quick-reaction-flyout"); if (!fl || fl.__fxBig) return;
  fl.__fxBig = true;
  let t = null;
  fl.addEventListener("pointerdown", (e) => { const b = e.target.closest && e.target.closest(".reaction-emoji"); if (!b) return; fxBigReaction = false; clearTimeout(t); t = setTimeout(() => { fxBigReaction = true; }, 450); });
  const reset = () => clearTimeout(t);
  fl.addEventListener("pointerup", reset); fl.addEventListener("pointercancel", reset);
  fl.addEventListener("click", () => { clearTimeout(t); setTimeout(() => { fxBigReaction = false; }, 0); }, true);
}

// ---------------------------------------------------------------------
// Time Capsule Wall и Replay месяца
// ---------------------------------------------------------------------
function fxWallItems(c) { return (c.messages || []).filter((m) => m.favorite && m.from !== "system").sort((a, b) => (b.ts || 0) - (a.ts || 0)); }
function fxOpenWall(contactId) {
  const c = state.contacts.get(contactId); if (!c) return null;
  const old = document.getElementById("fx-wall"); if (old) old.remove();
  const items = fxWallItems(c);
  const el = document.createElement("div"); el.id = "fx-wall"; el.className = "fx-wall"; el.setAttribute("role", "dialog");
  const cards = items.map((m) => {
    const rot = ((fxSeed("tilt|" + m.id)() % 7) - 3) * 0.6;
    const d = new Date(m.ts || 0).toLocaleDateString(I18N.current, { day: "numeric", month: "short", year: "numeric" });
    return `<div class="fx-card" style="--rot:${rot}deg"><div class="fx-card-text">${fx2Esc(truncate(m.text || (m.file ? "📎 " + (m.file.name || "") : ""), 220))}</div><div class="fx-card-meta">${fx2Esc(m.from === "me" ? (Store.name || "") : (c.name || ""))} · ${fx2Esc(d)}</div></div>`;
  }).join("");
  el.innerHTML = `<div class="fx-wall-head"><b>${fx2Esc(T("fx2.wall"))} — ${fx2Esc(c.name || "")}</b><button type="button" class="fx-wall-close" aria-label="${fx2Esc(T("sys.close"))}">✕</button></div><div class="fx-wall-grid">${cards || `<p class="muted">${fx2Esc(T("fx2.wall.empty"))}</p>`}</div>`;
  el.querySelector(".fx-wall-close").addEventListener("click", () => el.remove());
  document.body.appendChild(el);
  return el;
}

function replayData(c, year, month) {
  const from = new Date(year, month, 1).getTime(), to = new Date(year, month + 1, 1).getTime();
  const msgs = (c.messages || []).filter((m) => m.from !== "system" && m.ts >= from && m.ts < to);
  if (!msgs.length) return null;
  const perDay = new Map(); let sent = 0, received = 0; const emo = new Map();
  for (const m of msgs) {
    const d = new Date(m.ts).getDate(); perDay.set(d, (perDay.get(d) || 0) + 1);
    if (m.from === "me") sent++; else received++;
    for (const e of (m.text || "").match(/\p{Extended_Pictographic}/gu) || []) emo.set(e, (emo.get(e) || 0) + 1);
  }
  let busiest = { day: 0, count: 0 }; for (const [day, count] of perDay) if (count > busiest.count) busiest = { day, count };
  let topEmoji = ""; let best = 0; for (const [e, n] of emo) if (n > best) { best = n; topEmoji = e; }
  let pause = 0; for (let i = 1; i < msgs.length; i++) pause = Math.max(pause, Math.floor((msgs[i].ts - msgs[i - 1].ts) / 86400000));
  const score = (m) => Object.values(m.reactions || {}).reduce((s, u) => s + (Array.isArray(u) ? u.length : 0), 0) * 100 + Math.min((m.text || "").length, 90);
  const pool = msgs.filter((m) => (m.text || "").length >= 8 && (m.text || "").length <= 140);
  const picked = [];
  const add = (m) => { if (m && !picked.includes(m)) picked.push(m); };
  add(pool[0]); pool.slice().sort((a, b) => score(b) - score(a)).slice(0, 3).forEach(add); add(pool[pool.length - 1]);
  picked.sort((a, b) => a.ts - b.ts);
  return { count: msgs.length, sent, received, busiest, topEmoji, pauseDays: pause, quotes: picked.slice(0, 5).map((m) => ({ text: m.text, who: m.from === "me" ? (Store.name || "") : (c.name || ""), ts: m.ts })) };
}
function replayScenes(data, c, year, month) {
  const monthName = new Date(year, month, 1).toLocaleDateString(I18N.current, { month: "long", year: "numeric" });
  const scenes = [{ kind: "title", lines: [c.name || "", monthName], dur: 3 }];
  scenes.push({ kind: "stats", lines: [T("fx2.replay.messages", { n: data.count }), T("fx2.replay.busiest", { n: data.busiest.count }), data.pauseDays ? T("fx2.replay.pause", { n: data.pauseDays }) : "", data.topEmoji ? data.topEmoji : ""].filter(Boolean), dur: 5 });
  for (const q of data.quotes) scenes.push({ kind: "quote", lines: [truncate(q.text, 110), "— " + q.who], dur: 4 });
  scenes.push({ kind: "outro", lines: ["Ether"], dur: 2 });
  return scenes;
}
function replayDraw(g, w, h, scene, t, hue) {
  const grad = g.createLinearGradient(0, 0, w, h); grad.addColorStop(0, `hsl(${hue} 55% 18%)`); grad.addColorStop(1, `hsl(${(hue + 50) % 360} 60% 8%)`);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  const a = Math.min(1, t / 0.6, (scene.dur - t) / 0.6);
  g.globalAlpha = Math.max(0, a); g.fillStyle = "#fff"; g.textAlign = "center";
  const base = scene.kind === "quote" ? 38 : scene.kind === "title" ? 52 : 40;
  scene.lines.forEach((line, i) => {
    g.font = `${i === 0 ? "600" : "400"} ${base - i * 6}px system-ui, sans-serif`;
    const words = String(line).split(" "), rows = []; let cur = "";
    for (const wd of words) { if ((cur + " " + wd).trim().length > 20) { rows.push(cur); cur = wd; } else cur = (cur + " " + wd).trim(); }
    rows.push(cur);
    rows.forEach((r, j) => g.fillText(r, w / 2, h * 0.38 + i * 90 + j * (base + 6)));
  });
  g.globalAlpha = 1;
}
async function fxMakeReplay(contactId, year, month) {
  const c = state.contacts.get(contactId); if (!c) return false;
  const now = new Date(); if (year == null) { year = now.getFullYear(); month = now.getMonth(); }
  const data = replayData(c, year, month);
  if (!data) { toast(T("fx2.replay.empty")); return false; }
  if (typeof MediaRecorder === "undefined") { toast(T("fx2.replay.unsupported")); return false; }
  const cv = document.createElement("canvas"); cv.width = 540; cv.height = 960;
  if (!cv.captureStream) { toast(T("fx2.replay.unsupported")); return false; }
  const g = cv.getContext("2d"); const scenes = replayScenes(data, c, year, month), hue = 200 + (fxSeed("replay|" + fxKeyString(c))() % 120);
  const total = scenes.reduce((s, x) => s + x.dur, 0);
  const rec = new MediaRecorder(cv.captureStream(30), { mimeType: (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("video/webm;codecs=vp9")) ? "video/webm;codecs=vp9" : "video/webm" });
  const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start(250);
  const t0 = performance.now(); let lastToast = -1;
  await new Promise((resolve) => {
    const tick = () => {
      const el = (performance.now() - t0) / 1000; if (el >= total) { resolve(); return; }
      let acc = 0, sc = scenes[0]; for (const s of scenes) { if (el < acc + s.dur) { sc = s; break; } acc += s.dur; }
      replayDraw(g, cv.width, cv.height, sc, el - acc, hue);
      const left = Math.ceil(total - el); if (left !== lastToast) { lastToast = left; toast(T("fx2.replay.making", { s: left })); }
      requestAnimationFrame(tick);
    };
    tick();
  });
  rec.stop(); await done;
  downloadBlob(new Blob(chunks, { type: "video/webm" }), `ether-replay-${year}-${String(month + 1).padStart(2, "0")}.webm`);
  return true;
}

// ---------------------------------------------------------------------
// Костёр: временная комната по QR (группа с «сроком горения»; срок едет в описании группы)
// ---------------------------------------------------------------------
const FX_CF = "⁣";
function fxCampfireUntil(g) { const m = g && typeof g.description === "string" ? g.description.match(/⁣c:(\d{10,})⁣/) : null; return m ? +m[1] : 0; }
function fxCreateCampfire(hours) {
  const until = Date.now() + (hours || 4) * 3600 * 1000;
  const time = new Date(until).toLocaleTimeString(I18N.current, { hour: "2-digit", minute: "2-digit" });
  const id = crypto.randomUUID();
  const g = {
    id, isGroup: true, name: "🔥 " + T("fx2.campfire.name"), members: [{ id: Store.myId, name: Store.name || T("sys.someone"), role: "admin" }],
    messages: [], lastActivity: Date.now(), archived: false, muted: false, createdBy: Store.myId, managed: true,
    description: "🔥 " + T("fx2.campfire.until", { time }) + FX_CF + "c:" + until + FX_CF,
  };
  state.contacts.set(id, g); persistContacts();
  try { openGroupInviteSheet(id); } catch (e) {}
  toast(T("fx2.campfire.created"));
  if (state.tab === "chats") { try { renderChatsList(); } catch (e) {} }
  return id;
}
function fxSweepCampfires(now) {
  now = now || Date.now(); let n = 0;
  for (const g of Array.from(state.contacts.values())) {
    if (!isGroup(g)) continue;
    const u = fxCampfireUntil(g); if (!u || u > now) continue;
    try { removeGroupMember(g.id, Store.myId, true); } catch (e) {}
    if (state.contacts.has(g.id)) { state.contacts.delete(g.id); persistContacts(); }
    n++;
  }
  if (n) toast(T("fx2.campfire.out"));
  return n;
}

// ---------------------------------------------------------------------
// Cosmetic-бонус «Аврора» за приглашение: открывается, когда ты принял приглашение
// или кто-то вошёл в твою группу по твоему приглашению. Чисто косметика — функции не ограничивает.
// ---------------------------------------------------------------------
function fxAuroraUnlocked() { try { return localStorage.getItem("ether.fx.aurora") === "1"; } catch (e) { return false; } }
function fxReferralUnlock() {
  if (fxAuroraUnlocked()) return false;
  try { localStorage.setItem("ether.fx.aurora", "1"); if (typeof scheduleIDBBackup === "function") scheduleIDBBackup(); } catch (e) {}
  toast(T("fx2.aurora.unlocked"));
  return true;
}
function fxReferralInviterHit() { fxReferralUnlock(); }
const _fx2OrigJoinViaInvite = joinGroupViaInvite;
joinGroupViaInvite = async function (text) {
  const r = await _fx2OrigJoinViaInvite.apply(this, arguments);
  try { if (parseGroupInviteCode(text)) fxReferralUnlock(); } catch (e) {}
  return r;
};

// ---------------------------------------------------------------------
// Погодный оттенок (явное согласие: приблизительные координаты уходят на open-meteo.com)
// ---------------------------------------------------------------------
const FX_SKY_KEY = "ether.fx.sky";
function skyKindFor(code, isDay) {
  if (code === 0) return isDay ? "clear" : "night";
  if (code <= 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloud";
}
function fxApplySky() {
  let kind = null;
  if (FX.get("weather")) { try { const o = JSON.parse(localStorage.getItem(FX_SKY_KEY) || "null"); if (o && Date.now() - o.at < 3 * 3600 * 1000) kind = o.kind; } catch (e) {} }
  if (kind) document.documentElement.setAttribute("data-sky", kind); else document.documentElement.removeAttribute("data-sky");
}
async function fxFetchSky() {
  if (!navigator.geolocation) throw new Error("no geolocation");
  const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { maximumAge: 3600000, timeout: 8000, enableHighAccuracy: false }));
  const lat = Math.round(pos.coords.latitude * 10) / 10, lon = Math.round(pos.coords.longitude * 10) / 10; // ~10 км, не точное место
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code,is_day`, { referrerPolicy: "no-referrer", credentials: "omit" });
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json(); const cur = j && j.current; if (!cur) throw new Error("bad");
  const kind = skyKindFor(+cur.weather_code, !!cur.is_day);
  try { localStorage.setItem(FX_SKY_KEY, JSON.stringify({ kind, at: Date.now() })); } catch (e) {} // координаты НЕ сохраняются
  return kind;
}
async function fxEnableWeather() {
  const ok = await confirmSheet(T("fx2.weather.confirm")); if (!ok) return false;
  try { await fxFetchSky(); FX.set("weather", true); fxApplySky(); return true; }
  catch (e) { toast(T("fx2.weather.fail")); FX.set("weather", false); return false; }
}

// ---------------------------------------------------------------------
// Краевой пульс (только пока приложение на экране) и хаптика (Android, progressive enhancement)
// ---------------------------------------------------------------------
function fxPulse() {
  if (document.hidden) return false;
  const el = document.createElement("div"); el.className = "fx-pulse"; el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el); setTimeout(() => el.remove(), 1300); return true;
}
const FX_HAPTIC = { send: [8], recv: [14, 40, 14], call: [30, 60, 30, 60, 30] };
function fxHaptic(kind) {
  if (!FX.get("haptics") || !/Android/i.test(navigator.userAgent || "") || !navigator.vibrate) return false;
  try { if (typeof prefersReducedMotion === "function" && prefersReducedMotion()) return false; navigator.vibrate(FX_HAPTIC[kind] || [10]); return true; } catch (e) { return false; }
}
const _fx2OrigPlayMsg = playMessageSound;
playMessageSound = function (contactId) {
  try { if (FX.get("pulse")) fxPulse(); fxHaptic("recv"); fxAmbientBump(); } catch (e) {}
  return _fx2OrigPlayMsg.apply(this, arguments);
};

// ---------------------------------------------------------------------
// Call Film: небиометрическая сводка группового звонка (длительность, участники, сообщения во время звонка)
// ---------------------------------------------------------------------
const _fx2OrigLeaveGC = typeof leaveGroupCall === "function" ? leaveGroupCall : null;
if (_fx2OrigLeaveGC) {
  leaveGroupCall = function (opts) {
    const snap = GC.gid ? { gid: GC.gid, start: GC.startedAt, names: Array.from(GC.peers.values()).map((p) => p.name), had: GC.everConnected } : null;
    const r = _fx2OrigLeaveGC.apply(this, arguments);
    try { if (snap && snap.had && !(opts && opts.silent)) fxCallFilm(snap); } catch (e) {}
    return r;
  };
}
function fxCallFilm(snap) {
  const g = state.contacts.get(snap.gid); if (!g) return null;
  const dur = Date.now() - snap.start;
  const msgs = (g.messages || []).filter((m) => m.from !== "system" && m.ts >= snap.start).length;
  const el = document.createElement("div"); el.className = "fx-callfilm"; el.setAttribute("role", "status");
  el.innerHTML = `<b>${fx2Esc(T("fx2.callFilm.title"))}</b><span>${fx2Esc(g.name || "")} · ${fx2Esc(formatDuration(dur))}</span><span>${fx2Esc(T("fx2.callFilm.people", { n: snap.names.length + 1 }))}</span><span>${fx2Esc(T("fx2.callFilm.msgs", { n: msgs }))}</span>`;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el); setTimeout(() => el.remove(), 9000);
  return el;
}

// ---------------------------------------------------------------------
// Настройки: вторая группа «Эффекты+» под первой, карточка контакта, интеграция с рендером
// ---------------------------------------------------------------------
function fx2InjectSettings() {
  if (document.getElementById("fx2-settings-group")) return;
  const first = document.getElementById("fx-settings-group"); if (!first) return;
  const grp = document.createElement("div"); grp.className = "settings-group flat-content"; grp.id = "fx2-settings-group"; grp.setAttribute("data-settings-category", "appearance");
  const toggles = ["veil", "wave", "composer", "ambient", "presence", "pulse", "haptics", "look", "draw"];
  grp.innerHTML = `<div class="settings-row column"><span class="settings-group-title" data-i18n="fx2.group">${fx2Esc(T("fx2.group"))}</span></div>`
    + toggles.map((k) => `<label class="settings-row"><span data-i18n="fx2.${k}">${fx2Esc(T("fx2." + k))}</span><input id="fxs-${k}" type="checkbox" class="switch" /></label>`).join("")
    + `<label class="settings-row"><span data-i18n="fx2.weather">${fx2Esc(T("fx2.weather"))}</span><input id="fxs-weather" type="checkbox" class="switch" /></label>`
    + `<label class="settings-row"><span data-i18n="fx2.aurora">${fx2Esc(T("fx2.aurora"))}</span><input id="fxs-aurora" type="checkbox" class="switch" /></label>`
    + `<p id="fx-aurora-hint" class="fine muted hidden" data-i18n="fx2.aurora.locked" style="margin:0 0 6px;">${fx2Esc(T("fx2.aurora.locked"))}</p>`
    + `<button type="button" id="fx-closeday-btn" class="settings-row link-row"><span data-i18n="fx2.closeDay">${fx2Esc(T("fx2.closeDay"))}</span></button>`
    + `<button type="button" id="fx-campfire-btn" class="settings-row link-row"><span data-i18n="fx2.campfire">${fx2Esc(T("fx2.campfire"))}</span></button>`;
  first.insertAdjacentElement("afterend", grp);
  for (const k of toggles) {
    const el = grp.querySelector("#fxs-" + k); el.checked = !!FX.get(k);
    el.addEventListener("change", () => { FX.set(k, el.checked); fxAmbientSync(); });
  }
  const w = grp.querySelector("#fxs-weather"); w.checked = !!FX.get("weather");
  w.addEventListener("change", async () => { if (w.checked) { const ok = await fxEnableWeather(); w.checked = ok; } else { FX.set("weather", false); fxApplySky(); } });
  const au = grp.querySelector("#fxs-aurora");
  const syncAu = () => { const u = fxAuroraUnlocked(); au.disabled = !u; au.checked = u && !!FX.get("aurora"); const h = grp.querySelector("#fx-aurora-hint"); if (h) h.classList.toggle("hidden", u); };
  au.addEventListener("change", () => { FX.set("aurora", au.checked); document.documentElement.classList.toggle("fx-aurora", au.checked && fxAuroraUnlocked()); });
  syncAu(); grp.__syncAu = syncAu;
  grp.querySelector("#fx-closeday-btn").addEventListener("click", () => fxCloseDay());
  grp.querySelector("#fx-campfire-btn").addEventListener("click", () => fxCreateCampfire(4));
}
function fx2DecorateContactCard() {
  const card = document.getElementById("screen-contact"); if (!card || card.classList.contains("hidden")) return;
  const c = state.contactCardId ? state.contacts.get(state.contactCardId) : null; if (!c) return;
  const grp = document.getElementById("contact-settings-group"); if (!grp || document.getElementById("fx-wall-btn")) return;
  const mk = (id, key, fn) => { const b = document.createElement("button"); b.type = "button"; b.id = id; b.className = "settings-row link-row"; b.innerHTML = `<span data-i18n="${key}">${fx2Esc(T(key))}</span>`; b.addEventListener("click", fn); grp.appendChild(b); };
  mk("fx-wall-btn", "fx2.wall", () => { if (state.contactCardId) fxOpenWall(state.contactCardId); });
  mk("fx-replay-btn", "fx2.replay", () => { if (state.contactCardId) fxMakeReplay(state.contactCardId).catch(() => toast(T("calls.failed"))); });
}
function fx2After() {
  fx2OnChatChange();
  fx2Presence();
  fx2ApplySkin();
  fx2InjectSettings();
  fx2DecorateContactCard();
  fx2InjectLookButton();
  fx2InjectDrawButton();
  fxWireThreads();
  fxWireBigReaction();
  if (state.tab === "connect") fx2RenderConstellation();
  const g = document.getElementById("fx2-settings-group"); if (g && g.__syncAu) g.__syncAu();
  document.documentElement.classList.toggle("fx-aurora", !!FX.get("aurora") && fxAuroraUnlocked());
  fxApplySky();
}
const _fx2OrigAfterRender = fxAfterRender;
fxAfterRender = function () { _fx2OrigAfterRender.apply(this, arguments); try { fx2After(); } catch (e) {} };

function fx2Init() {
  try {
    fxWireDusk();
    fx2After();
    document.addEventListener("visibilitychange", () => { try { fxAmbientSync(); } catch (e) {} });
    const unlock = () => { try { fxAmbientSync(); } catch (e) {} };
    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    setInterval(() => { try { fxSweepCampfires(); } catch (e) {} }, 30000);
    setTimeout(() => { try { fxSweepCampfires(); } catch (e) {} }, 2500);
    setInterval(() => { try { fx2After(); } catch (e) {} }, 1000 * 20); // кнопки звонка/чата, «активен сейчас»
  } catch (e) {}
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fx2Init); else fx2Init();
