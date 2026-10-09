"use strict";

// =====================================================================
// features.js — «слой удовольствия» (ux-ui-design-vision) и безопасные функции из killer-features-backlog.
// Подключается ПОСЛЕ app.js и использует его глобальные имена (state, Store, T, toast, ...). Все эффекты
// локальные: ничего не уходит из устройства, всё отключаемо в Настройки → Оформление → «Эффекты».
// Намеренно НЕ реализовано (см. «Отклонено» в документе): live-курсор при наборе, pinch-реакции, «эхо присутствия»
// на списке, погода по геолокации, биометрия по лицу в звонках.
// =====================================================================

const fxEsc = (v) => (window.CSS && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/[^\w-]/g, (c) => "\\" + c));
const FX_KEY = "ether.fx";
const FX_DEFAULTS = {
  sonic: false, dance: true, vault: true, patina: true, easter: true, farewell: true, silence: true,
  ritual: true, breathing: null, season: true, skin: false, sigil: true, voiceStyle: "default", burn: "off",
};
const FX = {
  _c: null,
  _all() {
    if (!this._c) { try { this._c = JSON.parse(localStorage.getItem(FX_KEY) || "{}") || {}; } catch (e) { this._c = {}; } }
    return this._c;
  },
  get(k) {
    const a = this._all();
    if (Object.prototype.hasOwnProperty.call(a, k)) return a[k];
    if (k === "breathing") return !isIOS(); // на iOS по умолчанию «спокойный» режим (экономия батареи)
    return FX_DEFAULTS[k];
  },
  set(k, v) {
    const a = this._all(); a[k] = v;
    try { localStorage.setItem(FX_KEY, JSON.stringify(a)); if (typeof scheduleIDBBackup === "function") scheduleIDBBackup(); } catch (e) {}
    try { fxApplyClasses(); fxAfterRender(); } catch (e) {}
  },
};

// ---------- детерминированный хэш (косметика: звук, знак, оттенок — не криптография) ----------
function fxSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0);
  };
}
function fxKeyString(c) {
  if (c && c.publicKey) { const k = c.publicKey; return String(k.x || "") + String(k.y || "") || JSON.stringify(k); }
  return String((c && c.id) || "");
}
function fxMyKeyString() {
  const k = Store.myPublicKeyJwk; return k ? String(k.x || "") + String(k.y || "") : String(Store.myId || "");
}

// ---------- Sonic Signature: уникальный chime контакта (пентатоника, 3 ноты) ----------
const FX_PENTA = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0];
function sonicNotesFor(str) {
  const r = fxSeed("sonic|" + str);
  const notes = [];
  while (notes.length < 3) { const f = FX_PENTA[r() % FX_PENTA.length]; if (notes[notes.length - 1] !== f) notes.push(f); }
  return notes;
}
function playSonicSignature(contactId) {
  const c = state.contacts.get(contactId); if (!c || c.isSelf) return false;
  const ctx = document.visibilityState === "visible" ? ensureGlobalAudioCtx() : null;
  if (!ctx || ctx.state !== "running") return false;
  const notes = sonicNotesFor(fxKeyString(c));
  const t0 = ctx.currentTime + 0.01;
  notes.forEach((f, i) => {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = f;
    gain.gain.value = 0.0001;
    osc.connect(gain); gain.connect(ctx.destination);
    const at = t0 + i * 0.13;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.16, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
    osc.start(at); osc.stop(at + 0.36);
  });
  return true;
}
const _fxOrigPlayMessageSound = playMessageSound;
playMessageSound = function (contactId) {
  try { if (FX.get("sonic") && Store.soundsEnabled && contactId && playSonicSignature(contactId)) return; } catch (e) {}
  return _fxOrigPlayMessageSound.apply(this, arguments);
};

// ---------- Personal Sigil: генеративная «руна» из ключа (5×5, симметрия, кольцо) ----------
function sigilSvg(str, size) {
  const r = fxSeed("sigil|" + str);
  const hue = r() % 360, hue2 = (hue + 40 + (r() % 80)) % 360;
  let cells = "";
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if (r() % 2) {
      cells += `<rect x="${x * 8 + 4}" y="${y * 8 + 4}" width="7" height="7" rx="2"/>`;
      if (x < 2) cells += `<rect x="${(4 - x) * 8 + 4}" y="${y * 8 + 4}" width="7" height="7" rx="2"/>`;
    }
  }
  const s = size || 48;
  return `<svg class="fx-sigil-svg" viewBox="0 0 48 48" width="${s}" height="${s}" role="img" aria-label="sigil">`
    + `<defs><linearGradient id="sg${hue}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 85% 65%)"/><stop offset="1" stop-color="hsl(${hue2} 85% 60%)"/></linearGradient></defs>`
    + `<circle cx="24" cy="24" r="22.5" fill="none" stroke="url(#sg${hue})" stroke-width="1.5"/>`
    + `<g fill="url(#sg${hue})">${cells}</g></svg>`;
}

// ---------- The Vault: кристалл «истории вместе» (виден только вам) ----------
function vaultLevel(count) { return Math.max(0, Math.min(1, Math.log10((count || 0) + 1) / 4)); }
function fxUpdateVault() {
  const nameEl = document.getElementById("chat-peer-name"); if (!nameEl) return;
  let v = document.getElementById("fx-vault-crystal");
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  if (!FX.get("vault") || !c || isGroup(c) || c.isSelf || c.messages.length === 0) { if (v) v.remove(); return; }
  if (!v) { v = document.createElement("span"); v.id = "fx-vault-crystal"; v.className = "fx-vault"; nameEl.insertAdjacentElement("afterend", v); }
  const lvl = vaultLevel(c.messages.length);
  v.style.setProperty("--vault", lvl.toFixed(2));
  v.title = String(c.messages.length);
  v.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1 13 6 8 15 3 6Z" fill="currentColor" opacity=".9"/><path d="M3 6h10M8 1 6 6l2 9 2-9Z" fill="none" stroke="rgba(255,255,255,.55)" stroke-width=".6"/></svg>`;
}

// ---------- Bubble Dance: два сообщения в пределах 500 мс сталкиваются в центре ----------
const fxDanced = new Set();
function fxDance() {
  if (!FX.get("dance") || !state.chatId) return;
  const c = state.contacts.get(state.chatId); if (!c) return;
  const msgs = c.messages; const now = Date.now();
  for (let i = Math.max(1, msgs.length - 12); i < msgs.length; i++) {
    const a = msgs[i - 1], b = msgs[i];
    if (!a || !b || a.from === b.from || !a.ts || !b.ts) continue;
    if (Math.abs(b.ts - a.ts) > 500 || now - Math.max(a.ts, b.ts) > 8000) continue;
    const key = a.id + "|" + b.id; if (fxDanced.has(key)) continue;
    const ea = document.querySelector(`[data-msg-id="${fxEsc(a.id)}"]`), eb = document.querySelector(`[data-msg-id="${fxEsc(b.id)}"]`);
    if (!ea || !eb) continue;
    fxDanced.add(key);
    for (const e of [ea, eb]) {
      const row = e.closest(".bubble-row"); if (!row) continue;
      row.classList.add(row.classList.contains("mine") ? "fx-dance-mine" : "fx-dance-theirs");
      setTimeout(() => row.classList.remove("fx-dance-mine", "fx-dance-theirs"), 1200);
    }
  }
}

// ---------- Message Patina: старые сообщения слегка «стареют» ----------
function patinaLevel(ts, now) {
  const age = (now || Date.now()) - (ts || 0), day = 86400000;
  if (age > 730 * day) return 3; if (age > 365 * day) return 2; if (age > 90 * day) return 1; return 0;
}
function fxPatina() {
  const wrap = document.getElementById("chat-messages"); if (!wrap) return;
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  const on = FX.get("patina") && c;
  const byId = on ? new Map(c.messages.map((m) => [m.id, m])) : null;
  wrap.querySelectorAll("[data-msg-id]").forEach((el) => {
    if (!on) { el.removeAttribute("data-age"); return; }
    const m = byId.get(el.getAttribute("data-msg-id"));
    const lvl = m ? patinaLevel(m.ts) : 0;
    if (lvl) el.setAttribute("data-age", String(lvl)); else el.removeAttribute("data-age");
  });
}

// ---------- Birthday Sparkle ----------
function fxParseBirthday(text) {
  const m = /^\s*(\d{1,2})[.\-/](\d{1,2})\s*$/.exec(String(text || "")); if (!m) return null;
  const d = +m[1], mo = +m[2]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}
function fxIsBirthdayToday(c, now) {
  if (!c || !c.birthday) return false;
  const d = now ? new Date(now) : new Date();
  return c.birthday === String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function fxConfetti(ms) {
  const box = document.createElement("div"); box.className = "fx-confetti"; box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 36; i++) {
    const p = document.createElement("i");
    p.style.left = Math.round(Math.random() * 100) + "%";
    p.style.background = `hsl(${Math.round(Math.random() * 360)} 85% 60%)`;
    p.style.animationDelay = (Math.random() * 0.4).toFixed(2) + "s";
    p.style.animationDuration = (1.4 + Math.random() * 1.2).toFixed(2) + "s";
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), ms || 3000);
}
const BIRTHDAY_WORDS = /поздрав|с днём рождения|с днем рождения|happy birthday|🎂|🎉|🥳/i;
const _fxOrigSendChatMessage = sendChatMessage;
sendChatMessage = async function (contactId, text) {
  const r = _fxOrigSendChatMessage.apply(this, arguments);
  try {
    const c = state.contacts.get(contactId);
    const year = new Date().getFullYear();
    if (c && fxIsBirthdayToday(c) && c.birthdayCelebrated !== year && BIRTHDAY_WORDS.test(String(text || ""))) {
      c.birthdayCelebrated = year; persistContacts(); fxConfetti(3200);
    }
    if (FX.get("easter") && /🚀/.test(String(text || ""))) fxRocket();
  } catch (e) {}
  return r;
};

// ---------- Easter eggs ----------
function fxStarfall(ms) {
  const box = document.createElement("div"); box.className = "fx-starfall"; box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 40; i++) {
    const s = document.createElement("i");
    s.style.left = Math.round(Math.random() * 100) + "%";
    s.style.animationDelay = (Math.random() * 3).toFixed(2) + "s";
    s.style.animationDuration = (1.6 + Math.random() * 1.6).toFixed(2) + "s";
    box.appendChild(s);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), ms || 5000);
}
function fxRocket() {
  const r = document.createElement("div"); r.className = "fx-rocket"; r.textContent = "🚀"; r.setAttribute("aria-hidden", "true");
  document.body.appendChild(r); setTimeout(() => r.remove(), 2200);
}
const fxRocketSeen = new Set();
function fxScanRockets() {
  if (!FX.get("easter") || !state.chatId) return;
  const c = state.contacts.get(state.chatId); if (!c) return;
  const now = Date.now();
  for (let i = Math.max(0, c.messages.length - 5); i < c.messages.length; i++) {
    const m = c.messages[i];
    if (m.from === "them" && m.text && /🚀/.test(m.text) && !fxRocketSeen.has(m.id) && now - (m.ts || 0) < 8000) { fxRocketSeen.add(m.id); fxRocket(); }
  }
}
let fxTaps = [];
function fxWireEasterEggs() {
  document.addEventListener("click", (e) => {
    if (!FX.get("easter")) return;
    const wrap = document.getElementById("chat-messages");
    if (!wrap || e.target !== wrap) return; // «пустое место» — сам контейнер, не пузыри
    const now = Date.now();
    fxTaps = fxTaps.filter((t) => now - t < 700); fxTaps.push(now);
    if (fxTaps.length >= 3) { fxTaps = []; fxStarfall(5000); }
  });
}

// ---------- Farewell Fade: прощание при удалении контакта ----------
function farewellText(c) {
  const msgs = c.messages || [];
  const first = msgs.length ? Math.min(...msgs.map((m) => m.ts || Date.now())) : Date.now();
  const years = Math.max(0, (Date.now() - first) / (365.25 * 86400000));
  const span = years >= 1 ? T("fx.farewell.years", { n: Math.floor(years) }) : T("fx.farewell.lessYear");
  return T("fx.farewell.msg", { name: c.name || T("sys.someone"), span, count: msgs.length.toLocaleString(I18N.current || "en") });
}
const _fxOrigDeleteContact = deleteContact;
deleteContact = function (id) {
  const c = state.contacts.get(id);
  const text = c && !isGroup(c) && !c.isSelf && FX.get("farewell") && c.messages && c.messages.length ? farewellText(c) : null;
  const r = _fxOrigDeleteContact.apply(this, arguments);
  try {
    if (text && !state.contacts.has(id)) {
      toast(text); clearTimeout(toast._t); toast._t = setTimeout(() => { const el = document.getElementById("toast"); if (el) el.classList.remove("show"); }, 5200);
      const shell = document.getElementById("app-shell");
      if (shell) { shell.classList.add("fx-farewell"); setTimeout(() => shell.classList.remove("fx-farewell"), 900); }
    }
  } catch (e) {}
  return r;
};

// ---------- Aesthetic of silence: сцена в пустом чате ----------
function fxSilenceScene() {
  const empty = document.querySelector("#chat-messages .chat-thread-empty");
  if (!empty || empty.querySelector(".fx-scene") || !FX.get("silence")) return;
  const scene = document.createElement("button");
  scene.type = "button"; scene.className = "fx-scene"; scene.setAttribute("aria-label", T("fx.silence.hint"));
  scene.innerHTML = `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true"><path class="fx-flame" d="M32 8c6 9 12 14 12 24a12 12 0 0 1-24 0c0-6 4-9 6-14 2 4 4 5 6 3-1-5-1-9 0-13Z" fill="#ffb454"/><path class="fx-flame fx-flame-in" d="M32 26c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-6 6-11Z" fill="#fff2b3"/><path d="M14 56h36M20 52l24 6M44 52l-24 6" stroke="rgba(255,255,255,.4)" stroke-width="3" stroke-linecap="round"/></svg><span class="fx-scene-hint">${escapeHtml(T("fx.silence.hint"))}</span>`;
  scene.addEventListener("click", () => { scene.classList.remove("fx-poke"); void scene.offsetWidth; scene.classList.add("fx-poke"); });
  empty.appendChild(scene);
}

// ---------- Рitual: первое открытие за день ----------
function fxRitual() {
  if (!FX.get("ritual")) return;
  const today = new Date().toDateString();
  let last = null; try { last = localStorage.getItem("ether.fx.lastOpen"); } catch (e) {}
  if (last === today) return;
  try { localStorage.setItem("ether.fx.lastOpen", today); } catch (e) {}
  if (last === null) return; // самое первое открытие не «ритуал»
  const h = new Date().getHours();
  const key = h < 5 ? "night" : h < 12 ? "morning" : h < 18 ? "day" : "evening";
  const el = document.createElement("div"); el.className = "fx-ritual"; el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<span>${escapeHtml(T("fx.ritual." + key))}</span>`;
  document.body.appendChild(el); setTimeout(() => el.remove(), 2600);
}

// ---------- Ether Breathing, Seasonal Ambience, мягкий скин контакта ----------
function seasonHue(date) {
  const d = date ? new Date(date) : new Date();
  const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  return Math.round(28 * Math.sin((2 * Math.PI * (doy - 80)) / 365) * 10) / 10; // плавно за весь год, без скачков
}
function skinHue(c) { const r = fxSeed("skin|" + fxKeyString(c)); return (r() % 51) - 25; } // −25…+25°
function fxApplyClasses() {
  const root = document.documentElement;
  const reduced = (() => { try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } })();
  root.classList.toggle("fx-breathing", !!FX.get("breathing") && !reduced);
  root.classList.toggle("fx-season", !!FX.get("season"));
  root.classList.toggle("fx-skin", !!FX.get("skin"));
  root.style.setProperty("--fx-season-hue", seasonHue() + "deg");
  root.setAttribute("data-voice-style", FX.get("voiceStyle") || "default");
}
function fxUpdateChatState() {
  const root = document.documentElement;
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  root.classList.toggle("fx-chat-open", !!c);
  if (c) {
    root.style.setProperty("--fx-skin-hue", skinHue(c) + "deg");
    root.style.setProperty("--breath-s", (c.online ? 5 : 8) + "s"); // активный контакт — чуть быстрее «дыхание»
  }
}
function fxWireBreathingGuards() {
  document.addEventListener("visibilitychange", () => document.documentElement.classList.toggle("fx-paused", document.hidden));
  try {
    if (navigator.getBattery) navigator.getBattery().then((b) => {
      const upd = () => document.documentElement.classList.toggle("fx-lowbat", !b.charging && b.level < 0.2);
      upd(); b.addEventListener("levelchange", upd); b.addEventListener("chargingchange", upd);
    }).catch(() => {});
  } catch (e) {}
}

// ---------- Голосовые: кассета / пластинка ----------
function fxWireVoiceStyle() {
  const wrap = document.getElementById("chat-messages"); if (!wrap || wrap.__fxVoiceObs || typeof MutationObserver === "undefined") return;
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      const btn = m.target.closest ? m.target.closest(".voice-play-btn") : (m.target.parentElement && m.target.parentElement.closest(".voice-play-btn"));
      if (!btn) continue;
      const bubble = btn.closest(".voice-bubble"); if (!bubble) continue;
      bubble.classList.toggle("fx-playing", btn.innerHTML.includes("M7 5h4v14"));
    }
  });
  obs.observe(wrap, { subtree: true, childList: true });
  wrap.__fxVoiceObs = obs;
}


const FX_VINYL_SVG = '<svg viewBox="0 0 40 40" width="38" height="38" aria-hidden="true"><g class="fx-disc"><circle cx="20" cy="20" r="19" fill="#15151a"/><circle cx="20" cy="20" r="16.5" fill="none" stroke="#33333c" stroke-width=".7"/><circle cx="20" cy="20" r="14" fill="none" stroke="#33333c" stroke-width=".7"/><circle cx="20" cy="20" r="11.5" fill="none" stroke="#33333c" stroke-width=".7"/><path d="M20 4.5a15.5 15.5 0 0 1 11 4.6" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="1.5" stroke-linecap="round"/><circle cx="20" cy="20" r="7" fill="#8a6dff"/><circle cx="20" cy="20" r="7" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width=".6"/><circle cx="20" cy="20" r="1.6" fill="#15151a"/></g></svg>';
const FX_CASSETTE_SVG = '<svg viewBox="0 0 48 32" width="46" height="31" aria-hidden="true"><rect x="1" y="1" width="46" height="30" rx="4" fill="#2f2b45" stroke="#14121f"/><rect x="5" y="4" width="38" height="13" rx="2" fill="#efe6cf"/><rect x="8" y="6.5" width="32" height="2" rx="1" fill="#c9bb92"/><rect x="8" y="10.5" width="20" height="1.4" rx=".7" fill="#c9bb92"/><rect x="14" y="19" width="20" height="9" rx="4.5" fill="#14121f"/><g class="fx-reel"><circle cx="19" cy="23.5" r="3.4" fill="#efe6cf"/><path d="M19 20.3v6.4M15.8 23.5h6.4M16.7 21.2l4.6 4.6M21.3 21.2l-4.6 4.6" stroke="#14121f" stroke-width=".8"/></g><g class="fx-reel"><circle cx="29" cy="23.5" r="3.4" fill="#efe6cf"/><path d="M29 20.3v6.4M25.8 23.5h6.4M26.7 21.2l4.6 4.6M31.3 21.2l-4.6 4.6" stroke="#14121f" stroke-width=".8"/></g><path d="M9 31l3.2-4.2h23.6L39 31" fill="none" stroke="#14121f"/><circle cx="6" cy="27.5" r="1" fill="#14121f"/><circle cx="42" cy="27.5" r="1" fill="#14121f"/></svg>';
// Рисунок кассеты/пластинки добавляется к каждому голосовому пузырю один раз; показывается по data-voice-style (см. CSS)
function fxDecorateVoice() {
  const wrap = document.getElementById("chat-messages"); if (!wrap) return;
  for (const b of wrap.querySelectorAll(".voice-bubble")) {
    if (b.querySelector(".fx-voice-deco")) continue;
    const btn = b.querySelector(".voice-play-btn"); if (!btn) continue;
    for (const [cls, svg] of [["cassette", FX_CASSETTE_SVG], ["vinyl", FX_VINYL_SVG]]) {
      const d = document.createElement("span"); d.className = "fx-voice-deco " + cls; d.innerHTML = svg; btn.insertBefore(d, btn.firstChild);
    }
  }
}


// ---------- Sigil: крупный показ, сверка и «поделиться» ----------
async function fxSigilFingerprint(str) {
  const hex = await fxSha256Hex("sigil-fp|" + str);
  return hex.slice(0, 16).toUpperCase().replace(/(.{4})/g, "$1 ").trim();
}
// PNG-картинка руны с подписью — для «поделиться» и «сохранить»
function fxSigilPng(keyStr, name, fp) {
  return new Promise((resolve) => {
    try {
      const W = 720, H = 880, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const g = cv.getContext("2d"); if (!g) { resolve(null); return; }
      g.fillStyle = "#0e0c1c"; g.fillRect(0, 0, W, H);
      const img = new Image();
      img.onload = () => {
        g.drawImage(img, 110, 80, 500, 500);
        g.fillStyle = "#fff"; g.textAlign = "center";
        g.font = "600 44px system-ui, sans-serif"; g.fillText(String(name || "").slice(0, 28), W / 2, 670);
        g.font = "500 30px ui-monospace, monospace"; g.fillStyle = "#b9b1e8"; g.fillText(fp || "", W / 2, 730);
        g.font = "400 26px system-ui, sans-serif"; g.fillStyle = "#7f78a8"; g.fillText("Ether · " + T("fx.sigil.title"), W / 2, 820);
        try { cv.toBlob((b) => resolve(b), "image/png"); } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(sigilSvg(keyStr, 500).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" '));
    } catch (e) { resolve(null); }
  });
}
function fxOpenSigilSheet(opts) {
  const old = document.getElementById("fx-sigil-sheet"); if (old) old.remove();
  const mine = !!opts.mine, keyStr = opts.keyStr || "", name = opts.name || "";
  const sh = document.createElement("div"); sh.id = "fx-sigil-sheet"; sh.className = "sheet"; sh.setAttribute("role", "dialog");
  sh.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet-panel glass-content fx-sigil-panel"><div class="sheet-handle"></div>
    <h3>${escapeHtml(mine ? T("fx.mySigil") : T("fx.sigil.of", { name }))}</h3>
    <div class="fx-sigil-big">${sigilSvg(keyStr, 220)}</div>
    <div class="fx-sigil-fp" id="fx-sigil-fp">…</div>
    <p class="fine muted fx-sigil-how">${escapeHtml(T("fx.sigil.verifyHow"))}</p>
    <div class="row-actions"><button type="button" class="btn-tertiary fx-sigil-close">${escapeHtml(T("sys.close"))}</button><button type="button" class="btn-primary fx-sigil-share">${escapeHtml(T("fx.sigil.share"))}</button></div></div>`;
  document.body.appendChild(sh);
  const close = () => sh.remove();
  sh.querySelector(".sheet-backdrop").addEventListener("click", close);
  sh.querySelector(".fx-sigil-close").addEventListener("click", close);
  let fp = "";
  fxSigilFingerprint(keyStr).then((v) => { fp = v; const el = sh.querySelector("#fx-sigil-fp"); if (el) el.textContent = v; });
  sh.querySelector(".fx-sigil-share").addEventListener("click", async () => {
    const title = mine ? (Store.name || "") : name;
    const blob = await fxSigilPng(keyStr, title, fp);
    const fileName = "ether-sigil.png";
    const text = T("fx.sigil.shareText", { name: title }) + (fp ? "\n" + fp : "");
    try {
      if (blob && navigator.canShare && navigator.share) {
        const file = new File([blob], fileName, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text }); return; }
      }
      if (navigator.share) { await navigator.share({ text }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    if (blob) { downloadBlob(blob, fileName); toast(T("fx.sigil.saved")); }
    else { copyText(text, T("toast.msgCopied")); }
  });
  return sh;
}
// Своя руна — в Настройки → Профиль (раньше её можно было лишь мельком увидеть в «Эффектах», поделиться было нельзя)
function fxInjectProfileSigil() {
  const grp = document.querySelector('.settings-group[data-settings-category="profile"]');
  if (!grp) return;
  let row = document.getElementById("fx-profile-sigil-row");
  if (!row) {
    row = document.createElement("button"); row.type = "button"; row.id = "fx-profile-sigil-row"; row.className = "settings-row link-row";
    row.innerHTML = `<span data-i18n="fx.mySigil">${escapeHtml(T("fx.mySigil"))}</span><span id="fx-profile-sigil" class="fx-sigil"></span>`;
    row.addEventListener("click", () => fxOpenSigilSheet({ mine: true, keyStr: fxMyKeyString(), name: Store.name || "" }));
    grp.appendChild(row);
  }
  const holder = row.querySelector("#fx-profile-sigil");
  const ks = fxMyKeyString();
  if (holder && holder.getAttribute("data-k") !== ks) { holder.innerHTML = sigilSvg(ks, 40); holder.setAttribute("data-k", ks); }
}

// ---------- Сгорание self-destruct-сообщений: приватный fade / театральный пепел ----------
let fxBurning = false;
const _fxOrigSweepExpired = sweepExpiredMessages;
sweepExpiredMessages = function () {
  try {
    const mode = FX.get("burn");
    if (mode !== "off" && !fxBurning && state.chatId) {
      const c = state.contacts.get(state.chatId); const now = Date.now();
      const exp = c ? c.messages.filter((m) => m.ttl && now > m.ts + m.ttl) : [];
      const els = exp.map((m) => document.querySelector(`[data-msg-id="${fxEsc(m.id)}"]`)).filter(Boolean).map((e) => e.closest(".bubble-row")).filter(Boolean);
      if (els.length) {
        fxBurning = true;
        els.forEach((row) => {
          row.classList.add(mode === "ash" ? "fx-burn-ash" : "fx-burn-fade"); // без дымного следа в обоих режимах
          if (mode === "ash") {
            const r = row.getBoundingClientRect();
            for (let i = 0; i < 10; i++) {
              const p = document.createElement("i"); p.className = "fx-ash"; p.setAttribute("aria-hidden", "true");
              p.style.left = Math.round(r.left + Math.random() * r.width) + "px"; p.style.top = Math.round(r.top + Math.random() * r.height) + "px";
              p.style.animationDelay = (Math.random() * 0.3).toFixed(2) + "s";
              document.body.appendChild(p); setTimeout(() => p.remove(), 1500);
            }
          }
        });
        setTimeout(() => { fxBurning = false; _fxOrigSweepExpired(); }, 850);
        return;
      }
    }
  } catch (e) { fxBurning = false; }
  return _fxOrigSweepExpired();
};

// ---------- Итоги года (Yearly Wrapped), полностью локально ----------
function computeWrapped(year, now) {
  const y = year || new Date().getFullYear();
  let sent = 0, received = 0; const perContact = []; const emoji = new Map(); const hours = new Array(24).fill(0);
  let longestPause = { ms: 0, name: "" };
  for (const c of state.contacts.values()) {
    if (c.isSelf) continue;
    const ms = (c.messages || []).filter((m) => m.ts && new Date(m.ts).getFullYear() === y && !m.system);
    if (!ms.length) continue;
    perContact.push({ id: c.id, name: c.name || T("sys.someone"), count: ms.length });
    let prev = null;
    for (const m of ms) {
      if (m.from === "me") sent++; else received++;
      hours[new Date(m.ts).getHours()]++;
      for (const e of String(m.text || "").match(/\p{Extended_Pictographic}/gu) || []) emoji.set(e, (emoji.get(e) || 0) + 1);
      if (prev && m.ts - prev > longestPause.ms) longestPause = { ms: m.ts - prev, name: c.name || "" };
      prev = m.ts;
    }
  }
  perContact.sort((a, b) => b.count - a.count);
  const topEmoji = Array.from(emoji.entries()).sort((a, b) => b[1] - a[1])[0];
  const peak = hours.indexOf(Math.max(...hours));
  return {
    year: y, sent, received, total: sent + received, top: perContact.slice(0, 3),
    topEmoji: topEmoji ? topEmoji[0] : "", peakHour: sent + received ? peak : null,
    longestPauseDays: Math.round(longestPause.ms / 86400000 * 10) / 10, longestPauseWith: longestPause.name,
  };
}
function openYearlyWrapped() {
  const w = computeWrapped();
  const slides = [
    `<h2>${escapeHtml(T("fx.wrapped.title", { year: w.year }))}</h2><p>${escapeHtml(T("fx.wrapped.local"))}</p>`,
    `<h2>${w.total.toLocaleString(I18N.current || "en")}</h2><p>${escapeHtml(T("fx.wrapped.total", { sent: w.sent, received: w.received }))}</p>`,
    `<h2>${escapeHtml((w.top[0] && w.top[0].name) || "—")}</h2><p>${escapeHtml(T("fx.wrapped.top"))}: ${w.top.map((t) => escapeHtml(t.name) + " · " + t.count).join(" / ") || "—"}</p>`,
    `<h2>${escapeHtml(w.topEmoji || "—")}</h2><p>${escapeHtml(T("fx.wrapped.emoji"))}</p>`,
    `<h2>${w.peakHour === null ? "—" : String(w.peakHour).padStart(2, "0") + ":00"}</h2><p>${escapeHtml(T("fx.wrapped.hour"))}</p>`,
    `<h2>${w.longestPauseDays}</h2><p>${escapeHtml(T("fx.wrapped.pause", { name: w.longestPauseWith || "—" }))}</p>`,
  ];
  const ov = document.createElement("div"); ov.className = "fx-wrapped"; ov.setAttribute("role", "dialog");
  let i = 0;
  const render = () => { ov.innerHTML = `<div class="fx-wrapped-card" data-i="${i}">${slides[i]}<small>${i + 1}/${slides.length}</small></div>`; };
  render();
  ov.addEventListener("click", () => { i++; if (i >= slides.length) { ov.remove(); return; } render(); });
  document.body.appendChild(ov);
  return ov;
}

// ---------- Conversation Poster (PNG-постер переписки) ----------
function posterPhrases(c, n) {
  const pool = (c.messages || []).filter((m) => m.text && !m.system && m.text.length >= 8 && m.text.length <= 90);
  const r = fxSeed("poster|" + fxKeyString(c) + "|" + pool.length);
  const out = [];
  const used = new Set();
  for (let k = 0; k < Math.min(n, pool.length); k++) { let idx = r() % pool.length, guard = 0; while (used.has(idx) && guard++ < 20) idx = (idx + 1) % pool.length; used.add(idx); out.push(pool[idx].text); }
  return out;
}
async function exportConversationPoster(contactId) {
  const c = state.contacts.get(contactId); if (!c) return null;
  const W = 1080, H = 1350, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, "#1b1140"); grad.addColorStop(1, "#08131f");
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.fillStyle = "#fff"; g.font = "700 84px Inter, sans-serif"; g.textAlign = "center";
  g.fillText(c.name || "", W / 2, 220);
  const ts = (c.messages || []).map((m) => m.ts).filter(Boolean);
  const fmt = (t) => new Date(t).toLocaleDateString(I18N.current || "en");
  g.font = "400 36px Inter, sans-serif"; g.fillStyle = "rgba(255,255,255,.7)";
  if (ts.length) g.fillText(fmt(Math.min(...ts)) + " — " + fmt(Math.max(...ts)), W / 2, 290);
  g.font = "700 140px Inter, sans-serif"; g.fillStyle = "#b9a6ff"; g.fillText(String((c.messages || []).length), W / 2, 520);
  g.font = "400 36px Inter, sans-serif"; g.fillStyle = "rgba(255,255,255,.7)"; g.fillText(T("fx.poster.messages"), W / 2, 580);
  g.fillStyle = "#fff"; g.font = "italic 44px Inter, sans-serif";
  posterPhrases(c, 4).forEach((p, i) => g.fillText("«" + p + "»", W / 2, 760 + i * 120));
  g.font = "400 30px Inter, sans-serif"; g.fillStyle = "rgba(255,255,255,.5)"; g.fillText("Ether", W / 2, H - 70);
  const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
  if (blob && typeof downloadBlob === "function") downloadBlob(blob, `ether-poster-${(c.name || "chat").replace(/[^\p{L}\p{N}]+/gu, "-")}.png`);
  return blob;
}

// ---------- Экспорт переписки с подписью целостности (ECDSA + hash-chain) ----------
const FX_SIG_KEY = "ether.sigKey";
async function fxSha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function fxGetSigningKeys() {
  let raw = null; try { raw = localStorage.getItem(FX_SIG_KEY); } catch (e) {}
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
  try { localStorage.setItem(FX_SIG_KEY, JSON.stringify(keys)); if (typeof scheduleIDBBackup === "function") scheduleIDBBackup(); } catch (e) {}
  return keys;
}
const fxEntry = (m) => ({ id: m.id, from: m.from === "me" ? "me" : "them", ts: m.ts || 0, text: m.text || "", file: m.file ? { name: m.file.name || "", size: m.file.size || 0, kind: m.file.kind || "" } : null });
async function buildSignedExport(contactId) {
  const c = state.contacts.get(contactId); if (!c) throw new Error("no contact");
  const keys = await fxGetSigningKeys();
  const entries = (c.messages || []).filter((m) => !m.system).map(fxEntry);
  let h = await fxSha256Hex("ether-export-v1|" + Store.myId + "|" + c.id);
  const chain = [];
  for (const e of entries) { h = await fxSha256Hex(h + "|" + JSON.stringify(e)); chain.push(h); }
  const meta = { version: 1, exportedAt: Date.now(), exporterId: Store.myId, exporterName: Store.name || "", peerId: c.id, peerName: c.name || "", count: entries.length, finalHash: h };
  const priv = await crypto.subtle.importKey("jwk", keys.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(JSON.stringify(meta)));
  return { format: "ether-signed-export", meta, publicKey: keys.pub, signature: Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join(""), messages: entries, chain };
}
async function verifySignedExport(obj) {
  try {
    if (!obj || obj.format !== "ether-signed-export" || !obj.meta || !Array.isArray(obj.messages) || !Array.isArray(obj.chain)) return { ok: false, reason: "format" };
    if (obj.messages.length !== obj.meta.count || obj.chain.length !== obj.messages.length) return { ok: false, reason: "count" };
    let h = await fxSha256Hex("ether-export-v1|" + obj.meta.exporterId + "|" + obj.meta.peerId);
    for (let i = 0; i < obj.messages.length; i++) {
      h = await fxSha256Hex(h + "|" + JSON.stringify(fxEntry(obj.messages[i])));
      if (h !== obj.chain[i]) return { ok: false, reason: "chain", index: i };
    }
    if (h !== obj.meta.finalHash) return { ok: false, reason: "final" };
    const pub = await crypto.subtle.importKey("jwk", obj.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = new Uint8Array((obj.signature.match(/../g) || []).map((x) => parseInt(x, 16)));
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, new TextEncoder().encode(JSON.stringify(obj.meta)));
    return ok ? { ok: true } : { ok: false, reason: "signature" };
  } catch (e) { return { ok: false, reason: "error" }; }
}
async function exportSignedChat(contactId) {
  const data = await buildSignedExport(contactId);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  if (typeof downloadBlob === "function") downloadBlob(blob, `ether-signed-${(data.meta.peerName || "chat").replace(/[^\p{L}\p{N}]+/gu, "-")}.json`);
  return data;
}

// ---------- встраивание в интерфейс ----------
function fxAfterRender() {
  fxUpdateChatState();
  fxUpdateVault();
  fxPatina();
  fxDance();
  fxScanRockets();
  fxSilenceScene();
  fxWireVoiceStyle();
  fxDecorateVoice();
  fxInjectProfileSigil();
  fxDecorateContactCard();
  fxBirthdayDecor();
}
function fxBirthdayDecor() {
  const c = state.chatId ? state.contacts.get(state.chatId) : (state.contactCardId ? state.contacts.get(state.contactCardId) : null);
  const on = !!c && fxIsBirthdayToday(c);
  for (const id of ["chat-peer-avatar", "contact-avatar"]) { const el = document.getElementById(id); if (el) el.classList.toggle("fx-birthday", on); }
}
function fxDecorateContactCard() {
  const card = document.getElementById("screen-contact"); if (!card || card.classList.contains("hidden")) return;
  const c = state.contactCardId ? state.contacts.get(state.contactCardId) : null; if (!c) return;
  const prof = card.querySelector(".contact-profile");
  let sg = document.getElementById("fx-sigil");
  if (FX.get("sigil") && prof) {
    if (!sg) { sg = document.createElement("div"); sg.id = "fx-sigil"; sg.className = "fx-sigil"; const nameEl = document.getElementById("contact-name"); if (nameEl) nameEl.insertAdjacentElement("afterend", sg); }
    sg.innerHTML = sigilSvg(fxKeyString(c), 44); sg.title = T("fx.sigil.hint");
    sg.setAttribute("role", "button"); sg.tabIndex = 0;
    sg.onclick = () => { const cc = state.contactCardId ? state.contacts.get(state.contactCardId) : null; if (cc) fxOpenSigilSheet({ title: cc.name || "", keyStr: fxKeyString(cc), name: cc.name || "" }); };
  } else if (sg) sg.remove();
  const grp = document.getElementById("contact-settings-group"); if (!grp) return;
  if (!document.getElementById("fx-birthday-row")) {
    const row = document.createElement("div"); row.className = "settings-row"; row.id = "fx-birthday-row";
    row.innerHTML = `<span>${escapeHtml(T("fx.birthday"))}</span><input id="fx-birthday" type="text" inputmode="numeric" maxlength="5" placeholder="${escapeHtml(T("fx.birthday.ph"))}" autocomplete="off" />`;
    grp.appendChild(row);
    row.querySelector("input").addEventListener("change", (e) => {
      const cc = state.contactCardId ? state.contacts.get(state.contactCardId) : null; if (!cc) return;
      const v = e.target.value.trim();
      if (!v) { delete cc.birthday; } else { const p = fxParseBirthday(v); if (!p) { toast(T("fx.birthday.bad")); return; } cc.birthday = p; }
      persistContacts(); fxBirthdayDecor();
    });
    const exp = document.createElement("button"); exp.type = "button"; exp.id = "fx-export-signed"; exp.className = "settings-row link-row";
    exp.innerHTML = `<span>${escapeHtml(T("fx.signedExport"))}</span>`;
    exp.addEventListener("click", async () => { if (state.contactCardId) { try { await exportSignedChat(state.contactCardId); toast(T("fx.signedExport.done")); } catch (e) { toast(T("calls.failed")); } } });
    grp.appendChild(exp);
    const pst = document.createElement("button"); pst.type = "button"; pst.id = "fx-export-poster"; pst.className = "settings-row link-row";
    pst.innerHTML = `<span>${escapeHtml(T("fx.poster"))}</span>`;
    pst.addEventListener("click", async () => { if (state.contactCardId) { try { await exportConversationPoster(state.contactCardId); } catch (e) { toast(T("calls.failed")); } } });
    grp.appendChild(pst);
  }
  const inp = document.getElementById("fx-birthday");
  if (inp && document.activeElement !== inp) { inp.value = c.birthday ? c.birthday.slice(3) + "." + c.birthday.slice(0, 2) : ""; }
}
function fxInjectSettings() {
  if (document.getElementById("fx-settings-group")) return;
  const anchor = document.querySelector('[data-settings-category="appearance"]:last-of-type') || document.querySelector('[data-settings-category="appearance"]');
  if (!anchor) return;
  const grp = document.createElement("div"); grp.className = "settings-group flat-content"; grp.id = "fx-settings-group"; grp.setAttribute("data-settings-category", "appearance");
  const toggles = [["sonic", "fx.sonic"], ["dance", "fx.dance"], ["vault", "fx.vault"], ["patina", "fx.patina"], ["easter", "fx.easter"], ["farewell", "fx.farewell"], ["silence", "fx.silence"], ["ritual", "fx.ritual"], ["breathing", "fx.breathing"], ["season", "fx.season"], ["skin", "fx.skin"], ["sigil", "fx.sigilToggle"]];
  const sel = (key, label, opts) => `<label class="settings-row"><span data-i18n="${label}">${escapeHtml(T(label))}</span><select id="fxs-${key}" class="settings-select">${opts.map(([v, l]) => `<option value="${v}" data-i18n="${l}">${escapeHtml(T(l))}</option>`).join("")}</select></label>`;
  grp.innerHTML = `<div class="settings-row column"><span class="settings-group-title" data-i18n="fx.group">${escapeHtml(T("fx.group"))}</span><p class="fine muted" style="margin:0;" data-i18n="fx.group.note">${escapeHtml(T("fx.group.note"))}</p></div>`
    + toggles.map(([k, l]) => `<label class="settings-row"><span data-i18n="${l}">${escapeHtml(T(l))}</span><input id="fxs-${k}" type="checkbox" class="switch" /></label>`).join("")
    + sel("voiceStyle", "fx.voiceStyle", [["default", "fx.voice.default"], ["cassette", "fx.voice.cassette"], ["vinyl", "fx.voice.vinyl"]])
    + sel("burn", "fx.burn", [["off", "fx.burn.off"], ["fade", "fx.burn.fade"], ["ash", "fx.burn.ash"]])
    + `<button type="button" id="fx-wrapped-btn" class="settings-row link-row"><span data-i18n="fx.wrapped.open">${escapeHtml(T("fx.wrapped.open"))}</span></button>`
    + `<button type="button" id="fx-verify-btn" class="settings-row link-row"><span data-i18n="fx.verify">${escapeHtml(T("fx.verify"))}</span></button>`
    + `<input id="fx-verify-input" type="file" accept="application/json,.json" style="display:none;" />`;
  anchor.insertAdjacentElement("afterend", grp);
  for (const [k] of toggles) {
    const el = grp.querySelector("#fxs-" + k); el.checked = !!FX.get(k);
    el.addEventListener("change", () => FX.set(k, el.checked));
  }
  for (const k of ["voiceStyle", "burn"]) { const el = grp.querySelector("#fxs-" + k); el.value = FX.get(k); el.addEventListener("change", () => FX.set(k, el.value)); }
  grp.querySelector("#fx-wrapped-btn").addEventListener("click", () => openYearlyWrapped());
  const vf = grp.querySelector("#fx-verify-input");
  grp.querySelector("#fx-verify-btn").addEventListener("click", () => vf.click());
  vf.addEventListener("change", async () => {
    const f = vf.files && vf.files[0]; vf.value = ""; if (!f) return;
    let obj = null; try { obj = JSON.parse(await f.text()); } catch (e) {}
    const r = await verifySignedExport(obj);
    toast(r.ok ? T("fx.verify.ok", { name: (obj.meta && obj.meta.exporterName) || "" }) : T("fx.verify.bad"));
  });
  if (typeof updateSettingsCategoryView === "function") updateSettingsCategoryView();
}
// сборка чипа реакции: мини-стек аватаров (до 3) + число
function fxReactionStack(users) {
  const ids = (users || []).slice(0, 3); let html = "";
  for (const id of ids) {
    const c = state.contacts.get(id); const name = id === Store.myId ? (Store.name || "") : (c && c.name) || "";
    html += `<span class="fx-av" style="background:${avatarGradient(name || id)}">${escapeHtml(initials(name || id).slice(0, 1))}</span>`;
  }
  return html ? `<span class="fx-av-stack">${html}</span>` : "";
}

// обёртки, чтобы эффекты применялись после каждой перерисовки
const _fxOrigRenderTab = renderTab;
renderTab = function () { _fxOrigRenderTab.apply(this, arguments); try { fxAfterRender(); } catch (e) {} };
const _fxOrigRenderChatThreadInner = renderChatThreadInner;
renderChatThreadInner = function () { _fxOrigRenderChatThreadInner.apply(this, arguments); try { fxAfterRender(); } catch (e) {} };

function fxInit() {
  try { fxApplyClasses(); fxInjectSettings(); fxWireEasterEggs(); fxWireBreathingGuards(); fxRitual(); } catch (e) {}
  if (!document.getElementById("fx-breath")) { const b = document.createElement("div"); b.id = "fx-breath"; b.setAttribute("aria-hidden", "true"); document.body.appendChild(b); }
  setInterval(() => { try { fxApplyClasses(); } catch (e) {} }, 6 * 3600 * 1000); // оттенок сезона обновляется без перезапуска
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fxInit); else fxInit();
