// Стикеры: только встроенные паки (SVG, рисуются кодом — без внешних загрузок и чужих лицензий) и свой пак пользователя.
// Часть 1 — чистая логика без DOM (проверка чужих данных, SVG, хранилище избранного); часть 2 — интерфейс, подключается после app.js.
// Стикер в чате: m.sticker = { pack, id, custom?, mime?, w?, h? }, m.text = «🖼 Стикер» (для поиска/превью/ответов).
// Принимаются ТОЛЬКО: встроенный (pack+id из белого списка форматов, неизвестный id → заглушка) и пользовательский
// (pack "user": растровые png/webp/jpeg ≤ 64 КБ, сигнатура, base64). SVG и любой HTML от собеседника отбрасываются.
(function (root) {
  "use strict";
  const MAX_CUSTOM_BYTES = 64 * 1024;       // потолок при приёме
  const USER_MAX_BYTES = 60 * 1024;         // потолок при добавлении своего
  const USER_MAX_SIDE = 256, USER_MAX_ITEMS = 60, FAV_MAX = 60, RECENT_MAX = 24;
  const RATE_MAX = 20, RATE_WINDOW_MS = 60000; // не больше 20 стикеров в минуту от одного собеседника
  const MIMES = ["image/png", "image/webp", "image/jpeg"];
  const PACK_RE = /^[a-z][a-z0-9_-]{0,23}$/, ID_RE = /^[A-Za-z0-9_-]{1,40}$/, MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const lang = () => { try { return (document.documentElement.lang || "en").slice(0, 2); } catch (e) { return "en"; } };
  const lbl = (n) => (n && (n[lang()] || n.en)) || "";
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── Встроенные паки ────────────────────────────────────────────────
  // «Мессенджер»: абстрактные значки-руны на фигурах с градиентом
  const RUNES = [
    ["fehu", "Fehu", "M46 100V28M46 54 84 30M46 76 84 52"], ["uruz", "Uruz", "M44 100V28L84 52V100"],
    ["thur", "Thurs", "M46 100V28M46 46 82 64 46 82"], ["ansu", "Ansuz", "M46 100V28L84 46M46 56 84 74"],
    ["raid", "Raido", "M46 100V28H70L84 42 70 60H46M64 60 86 100"], ["kena", "Kenaz", "M82 36 48 64 82 92"],
    ["gebo", "Gebo", "M44 36 84 92M84 36 44 92"], ["wunj", "Wunjo", "M46 100V28H70L84 42 70 58H46"],
    ["hagl", "Hagalaz", "M46 28V100M82 28V100M46 56 82 72"], ["naut", "Nauthiz", "M64 28V100M46 56 82 72"],
    ["isaz", "Isa", "M64 26V102M52 40H76M52 88H76"], ["othl", "Othala", "M64 28 90 52 64 76 38 52ZM64 76 50 100M64 76 78 100"],
  ];
  const RUNE_BG = [["#6a4de0", "#2fb5ff"], ["#ff6a88", "#ffb347"], ["#14b8a6", "#6a4de0"], ["#f59e0b", "#ef4444"], ["#3b82f6", "#22d3ee"], ["#a855f7", "#ec4899"]];
  const SHAPES = [
    (f) => `<circle cx="64" cy="64" r="58" fill="${f}"/>`,
    (f) => `<rect x="8" y="8" width="112" height="112" rx="30" fill="${f}"/>`,
    (f) => `<path d="M64 6 114 35V93L64 122 14 93V35Z" fill="${f}"/>`,
    (f) => `<path d="M64 4 124 64 64 124 4 64Z" fill="${f}" stroke-linejoin="round"/>`,
  ];
  function runeSvg(i) {
    const r = RUNES[i], c = RUNE_BG[i % RUNE_BG.length], g = "g" + i;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient></defs>${SHAPES[i % SHAPES.length]("url(#" + g + ")")}<path d="${r[2]}" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="64" cy="64" r="52" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="2"/></svg>`;
  }
  // «Рожицы»: лица из фигур (без шрифтов — одинаково везде)
  const EYES = {
    dots: '<circle cx="48" cy="54" r="6"/><circle cx="80" cy="54" r="6"/>',
    happy: '<path d="M38 58Q48 44 58 58M70 58Q80 44 90 58" fill="none" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/>',
    wide: '<circle cx="48" cy="54" r="11" fill="#fff"/><circle cx="80" cy="54" r="11" fill="#fff"/><circle cx="48" cy="55" r="5"/><circle cx="80" cy="55" r="5"/>',
    line: '<path d="M38 56H58M70 56H90" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/>',
    wink: '<circle cx="48" cy="54" r="6"/><path d="M70 56Q80 46 90 56" fill="none" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/>',
    heart: '<path d="M48 64 38 54a6 6 0 0 1 10-7 6 6 0 0 1 10 7ZM80 64 70 54a6 6 0 0 1 10-7 6 6 0 0 1 10 7Z" fill="#e11d48"/>',
    shades: '<rect x="33" y="46" width="28" height="16" rx="6"/><rect x="67" y="46" width="28" height="16" rx="6"/><path d="M61 52H67" stroke="#3b2a1a" stroke-width="4"/>',
    angry: '<circle cx="48" cy="56" r="6"/><circle cx="80" cy="56" r="6"/><path d="M36 42 58 50M92 42 70 50" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/>',
    think: '<circle cx="48" cy="56" r="6"/><circle cx="80" cy="56" r="6"/><path d="M70 40H92" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/>',
    star: '<path d="m48 44 3.5 7.5 8 1-6 5.5 1.7 8L48 62l-7.2 4 1.7-8-6-5.5 8-1ZM80 44l3.5 7.5 8 1-6 5.5 1.7 8L80 62l-7.2 4 1.7-8-6-5.5 8-1Z" fill="#f59e0b"/>',
  };
  const MOUTH = {
    smile: '<path d="M42 78Q64 100 86 78" fill="none" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/>',
    grin: '<path d="M38 76Q64 112 90 76Z" fill="#3b2a1a"/><path d="M44 77H84Q64 90 44 77Z" fill="#fff"/>',
    flat: '<path d="M46 88H82" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/>',
    frown: '<path d="M44 94Q64 74 84 94" fill="none" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/>',
    o: '<ellipse cx="64" cy="88" rx="9" ry="12" fill="#3b2a1a"/>',
    tongue: '<path d="M42 78Q64 100 86 78" fill="none" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/><path d="M58 90Q64 108 74 92Z" fill="#fb7185"/>',
    smirk: '<path d="M46 86Q66 90 86 76" fill="none" stroke="#3b2a1a" stroke-width="5" stroke-linecap="round"/>',
  };
  const FACES = [
    ["happy", { en: "Happy", ru: "Радость" }, "#fde047", "dots", "smile"], ["laugh", { en: "Laughing", ru: "Смех" }, "#fde047", "happy", "grin"],
    ["wink", { en: "Wink", ru: "Подмигивание" }, "#fdba74", "wink", "tongue"], ["cool", { en: "Cool", ru: "Круто" }, "#fde047", "shades", "smile"],
    ["sad", { en: "Sad", ru: "Грусть" }, "#93c5fd", "dots", "frown", '<path d="M44 66Q40 78 46 82Q52 78 48 66Z" fill="#38bdf8"/>'],
    ["wow", { en: "Surprised", ru: "Удивление" }, "#fed7aa", "wide", "o"], ["sleepy", { en: "Sleepy", ru: "Сонный" }, "#c4b5fd", "line", "o"],
    ["love", { en: "In love", ru: "Влюблён" }, "#fbcfe8", "heart", "smile"], ["angry", { en: "Angry", ru: "Злость" }, "#fca5a5", "angry", "frown"],
    ["think", { en: "Thinking", ru: "Задумался" }, "#bef264", "think", "smirk"],
    ["cry", { en: "Crying", ru: "Слёзы" }, "#a5f3fc", "line", "frown", '<path d="M40 62Q34 80 42 84Q50 80 46 62ZM88 62Q94 80 86 84Q78 80 82 62Z" fill="#38bdf8"/>'],
    ["party", { en: "Party", ru: "Праздник" }, "#a7f3d0", "star", "grin"],
  ];
  function faceSvg(i) {
    const f = FACES[i];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="58" fill="${f[2]}" stroke="#00000022" stroke-width="3"/><g fill="#3b2a1a">${EYES[f[3]]}</g>${f[5] || ""}${MOUTH[f[4]]}</svg>`;
  }
  // «Настроение»: эмодзи-композиции на цветных пятнах
  const MOODS = [
    ["lol", "😂", "#fde68a", { en: "Laughing", ru: "Ржу" }], ["love", "❤️", "#fecdd3", { en: "Love", ru: "Люблю" }], ["ok", "👍", "#bbf7d0", { en: "Good", ru: "Класс" }],
    ["wow", "😮", "#fed7aa", { en: "Wow", ru: "Ого" }], ["sad", "😢", "#bfdbfe", { en: "Sad", ru: "Грустно" }], ["fire", "🔥", "#fecaca", { en: "Fire", ru: "Огонь" }],
    ["party", "🎉", "#e9d5ff", { en: "Party", ru: "Ура" }], ["pray", "🙏", "#ddd6fe", { en: "Please", ru: "Спасибо" }], ["zzz", "😴", "#c7d2fe", { en: "Sleep", ru: "Сплю" }],
    ["hm", "🤔", "#d9f99d", { en: "Hmm", ru: "Хм" }], ["cool", "😎", "#a5f3fc", { en: "Cool", ru: "Круто" }], ["hug", "🤗", "#fef08a", { en: "Hug", ru: "Обнимаю" }],
  ];
  function moodSvg(i) {
    const m = MOODS[i];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M64 6C98 6 122 30 120 64S96 122 62 120 6 96 8 62 30 6 64 6Z" fill="${m[2]}"/><circle cx="24" cy="26" r="5" fill="#fff" fill-opacity=".7"/><circle cx="106" cy="100" r="4" fill="#fff" fill-opacity=".7"/><text x="64" y="86" font-size="66" text-anchor="middle" font-family="'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif">${m[1]}</text></svg>`;
  }
  const PACKS = [
    { id: "ether", name: { en: "Messenger", ru: "Мессенджер" }, items: RUNES.map((r, i) => ({ id: r[0], name: { en: "Rune " + r[1], ru: "Руна " + r[1] }, emoji: "ᚠ", svg: () => runeSvg(i) })) },
    { id: "faces", name: { en: "Faces", ru: "Рожицы" }, items: FACES.map((f, i) => ({ id: f[0], name: f[1], emoji: "🙂", svg: () => faceSvg(i) })) },
    { id: "mood", name: { en: "Mood", ru: "Настроение" }, items: MOODS.map((m, i) => ({ id: m[0], name: m[3], emoji: m[1], svg: () => moodSvg(i) })) },
  ];
  const byPack = new Map(PACKS.map((p) => [p.id, new Map(p.items.map((it) => [it.id, it]))]));
  const urlCache = new Map();
  function builtin(pack, id) { const p = byPack.get(pack); return p ? p.get(id) || null : null; }
  function dataUrl(pack, id) {
    const k = pack + "/" + id; if (urlCache.has(k)) return urlCache.get(k);
    const it = builtin(pack, id); if (!it) return "";
    const u = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(it.svg()); urlCache.set(k, u); return u;
  }

  // ── Проверка чужих данных ──────────────────────────────────────────
  function bytesOk(bytes, mime) {
    if (!bytes || bytes.length < 12 || bytes.length > MAX_CUSTOM_BYTES) return false;
    if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (mime === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v);
    if (mime === "image/webp") return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    return false;
  }
  function b64ToBytes(b64) {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
    const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u;
  }
  // Возвращает { ok, sticker, bytes? } — sticker содержит только проверенные поля.
  function validateIncoming(p) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !MSG_ID_RE.test(p.id)) return { ok: false };
    if (p.groupId !== undefined) return { ok: false }; // в группы стикеры не рассылаются
    const pack = p.pack, sid = p.sticker;
    if (typeof pack !== "string" || !PACK_RE.test(pack) || typeof sid !== "string" || !ID_RE.test(sid)) return { ok: false };
    if (pack !== "user") {
      if (p.dataB64 !== undefined || p.mime !== undefined) return { ok: false }; // встроенный стикер не несёт данных
      const known = !!builtin(pack, sid);
      return { ok: true, sticker: known ? { pack, id: sid } : { pack, id: sid, unknown: true } };
    }
    const mime = typeof p.mime === "string" ? p.mime.toLowerCase() : "";
    if (!MIMES.includes(mime)) return { ok: false };
    const b = p.dataB64;
    if (typeof b !== "string" || b.length < 16 || b.length > Math.ceil(MAX_CUSTOM_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return { ok: false };
    let bytes; try { bytes = b64ToBytes(b); } catch (e) { return { ok: false }; }
    if (!bytesOk(bytes, mime)) return { ok: false };
    const dim = (v) => (Number.isInteger(v) && v > 0 && v <= 1024 ? v : 0);
    return { ok: true, bytes, sticker: { pack, id: sid, custom: true, mime, w: dim(p.w), h: dim(p.h) } };
  }
  const rateLog = new Map();
  function rateOk(from, now) {
    now = now || Date.now();
    const arr = (rateLog.get(from) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX) { rateLog.set(from, arr); return false; }
    arr.push(now); rateLog.set(from, arr);
    if (rateLog.size > 500) rateLog.delete(rateLog.keys().next().value);
    return true;
  }

  // ── Локальное хранилище (мета, избранное, недавние) ────────────────
  const LS_KEY = "ether.stickers";
  const defState = () => ({ v: 1, packName: "", items: [], fav: [], recent: [] });
  let mem = null;
  function load() {
    if (mem) return mem;
    let s = null; try { s = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) {}
    const d = defState();
    if (s && typeof s === "object") {
      d.packName = typeof s.packName === "string" ? s.packName.slice(0, 40) : "";
      if (Array.isArray(s.items)) d.items = s.items.filter((x) => x && ID_RE.test(String(x.id)) && typeof x.name === "string").slice(0, USER_MAX_ITEMS).map((x) => ({ id: x.id, name: x.name.slice(0, 40), ts: Number(x.ts) || 0 }));
      const key = (k) => typeof k === "string" && /^[a-z][a-z0-9_-]{0,23}\/[A-Za-z0-9_-]{1,40}$/.test(k);
      if (Array.isArray(s.fav)) d.fav = s.fav.filter(key).slice(0, FAV_MAX);
      if (Array.isArray(s.recent)) d.recent = s.recent.filter(key).slice(0, RECENT_MAX);
    }
    mem = d; return d;
  }
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(mem)); } catch (e) {} }
  const exists = (key) => { const [p, i] = key.split("/"); return p === "user" ? load().items.some((x) => x.id === i) : !!builtin(p, i); };
  function favorites() { return load().fav.filter(exists); }
  function recents() { return load().recent.filter(exists); }
  function toggleFav(pack, id) {
    const s = load(), k = pack + "/" + id, i = s.fav.indexOf(k);
    if (i >= 0) s.fav.splice(i, 1); else { s.fav.unshift(k); s.fav = s.fav.slice(0, FAV_MAX); }
    save(); return i < 0;
  }
  function pushRecent(pack, id) { const s = load(), k = pack + "/" + id; s.recent = [k, ...s.recent.filter((x) => x !== k)].slice(0, RECENT_MAX); save(); }
  function userItems() { return load().items.slice(); }
  function addUserMeta(id, name) {
    const s = load(); if (s.items.length >= USER_MAX_ITEMS) return false;
    s.items.push({ id, name: String(name || "").slice(0, 40), ts: Date.now() }); save(); return true;
  }
  function renameUser(id, name) { const it = load().items.find((x) => x.id === id); if (!it) return false; it.name = String(name || "").trim().slice(0, 40); save(); return true; }
  function removeUserMeta(id) {
    const s = load(), n = s.items.length; s.items = s.items.filter((x) => x.id !== id);
    s.fav = s.fav.filter((k) => k !== "user/" + id); s.recent = s.recent.filter((k) => k !== "user/" + id); save(); return s.items.length < n;
  }
  function renamePack(name) { load().packName = String(name || "").trim().slice(0, 40); save(); }
  const packName = () => load().packName;
  function reset() { mem = null; rateLog.clear(); }
  function label(pack, id) {
    if (pack === "user") { const it = load().items.find((x) => x.id === id); return it ? it.name : ""; }
    const it = builtin(pack, id); return it ? lbl(it.name) : "";
  }

  const api = { PACKS, MIMES, MAX_CUSTOM_BYTES, USER_MAX_BYTES, USER_MAX_SIDE, USER_MAX_ITEMS, RATE_MAX, builtin, dataUrl, bytesOk, validateIncoming, rateOk, esc, lbl,
    favorites, recents, toggleFav, pushRecent, userItems, addUserMeta, renameUser, removeUserMeta, renamePack, packName, reset, label, load, ID_RE, b64ToBytes };
  root.EtherStickers = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

// ── Часть 2: интерфейс (нужны глобальные имена app.js) ───────────────
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined" || typeof state === "undefined") return;
  const S = window.EtherStickers, esc = S.esc;
  const userKey = (id) => "file:sticker:" + id;
  const userUrls = new Map();
  const stickerText = () => "🖼 " + T("sticker.label");
  const alt = (st) => T("sticker.alt", { name: S.label(st.pack, st.id) || T("sticker.label") });

  S.bubbleHtml = function (m) {
    const st = m.sticker; if (!st) return "";
    const a = esc(alt(st));
    if (st.custom) return `<span class="sticker-slot" role="img" aria-label="${a}" data-sticker-file="${esc(m.id)}"></span>`;
    const u = S.dataUrl(st.pack, st.id);
    if (!u) return `<span class="sticker-missing" role="img" aria-label="${esc(T("sticker.unknown"))}" title="${esc(T("sticker.unknown"))}">🖼</span>`;
    return `<img class="sticker-img" src="${u}" alt="${a}" width="160" height="160" draggable="false" decoding="async">`;
  };
  S.hydrate = function (root) {
    root.querySelectorAll(".sticker-slot[data-sticker-file]").forEach((el) => {
      const id = el.getAttribute("data-sticker-file");
      let m = null; for (const c of state.contacts.values()) { m = (c.messages || []).find((x) => x.id === id); if (m) break; }
      getFileBlobUrl(id).then((url) => {
        if (!url) { el.classList.add("sticker-missing"); el.textContent = "🖼"; return; }
        if (!el.querySelector("img")) el.innerHTML = `<img class="sticker-img" src="${url}" alt="${esc(m && m.sticker ? alt(m.sticker) : T("sticker.label"))}" width="160" height="160" draggable="false">`;
      }).catch(() => { el.classList.add("sticker-missing"); el.textContent = "🖼"; });
    });
  };

  // Приём: всё проверяется в validateIncoming; данные своего пака в IDB лежат под ключом сообщения (как вложения)
  S.receive = async function (from, payload, envelopeMsgId) {
    const v = S.validateIncoming(payload); if (!v.ok) return;
    const known = state.contacts.get(from); if (known && (known.blocked || known.isGroup)) return;
    if (!S.rateOk(from)) return;
    const c = ensureContactEntry(from, null);
    if (c.messages.some((m) => m.id === payload.id)) return;
    const rec = { id: payload.id, from: "them", text: stickerText(), ts: safeMsgTs(payload.ts), readAckSent: false, deliveryId: envelopeMsgId, sticker: v.sticker };
    if (v.bytes) { try { await IDB.set("file:" + rec.id, new Blob([v.bytes], { type: v.sticker.mime })); } catch (e) { return; } }
    if (c.messages.some((m) => m.id === payload.id)) return;
    if (payload.replyTo && typeof payload.replyTo === "object" && typeof payload.replyTo.id === "string") {
      const rt = payload.replyTo, orig = c.messages.find((x) => x.id === rt.id);
      let t = typeof rt.text === "string" ? rt.text : "", au = typeof rt.authorName === "string" ? rt.authorName : "";
      if (orig) { if (orig.text) t = orig.text; au = orig.from === "me" ? (Store.name || au) : (orig.fromName || c.name || au); }
      rec.replyTo = { id: rt.id.slice(0, 64), text: t.slice(0, 200), authorName: au.slice(0, 40) };
    }
    if (payload.forwarded) { rec.forwarded = true; if (typeof payload.fwdFrom === "string" && payload.fwdFrom) rec.forwardedFrom = payload.fwdFrom.slice(0, 40); }
    if (safeTtl(payload.ttl)) rec.ttl = safeTtl(payload.ttl);
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now(); persistContacts();
    if (state.chatId === from) { renderChatThread(); playMessageSound(from); vibrate([80, 40, 80]); announceToScreenReader(T("sr.newMessage", { name: c.name, text: T("sticker.label") })); }
    else {
      toast(`${c.name}: ${stickerText()}`);
      if (!isContactMuted(c)) showNotification(c.name || T("app.name"), stickerText(), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
      playMessageSound(from); vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    updateAppBadge();
  };

  const isBlob = (b) => !!b && typeof b.arrayBuffer === "function" && typeof b.size === "number";
  const toB64 = (buf) => arrayBufferToBase64(buf);
  async function customBlob(id) { try { const b = await IDB.get(userKey(id)); return isBlob(b) ? b : null; } catch (e) { return null; } }
  async function payloadFor(m, blobForCustom) {
    const st = m.sticker, p = { kind: "sticker", id: m.id, ts: m.ts, pack: st.pack, sticker: st.id };
    if (st.custom) {
      const b = blobForCustom || await IDB.get("file:" + m.id).catch(() => null);
      if (!isBlob(b)) return null;
      p.mime = st.mime; p.dataB64 = toB64(await b.arrayBuffer()); if (st.w) p.w = st.w; if (st.h) p.h = st.h;
    }
    if (m.replyTo) p.replyTo = { id: m.replyTo.id, text: m.replyTo.text, authorName: m.replyTo.authorName };
    if (m.ttl) p.ttl = m.ttl;
    if (m.forwarded) { p.forwarded = true; if (m.forwardedFrom) p.fwdFrom = m.forwardedFrom; }
    return p;
  }
  S.payloadFor = payloadFor;
  S.retry = async function (c, m) {
    const p = await payloadFor(m); if (!p) { m.ack = "failed"; persistContacts(); return; }
    return retrySend(c, m.id, p);
  };
  // Отправка в личный чат. Для группы стикер уходит как обычный текстовый эмодзи (если у него есть эмодзи), иначе — отказ.
  S.send = async function (contactId, pack, sid, replyTo) {
    const c = state.contacts.get(contactId); if (!c) return false;
    if (c.blocked) { toast(T("toast.blocked")); return false; }
    const custom = pack === "user";
    const meta = custom ? S.userItems().find((x) => x.id === sid) : S.builtin(pack, sid);
    if (!meta) return false;
    if (isGroup(c)) { toast(T("sticker.noGroup")); return false; }
    let blob = null;
    if (custom) { blob = await customBlob(sid); if (!blob) { toast(T("sticker.missing")); return false; } }
    const id = crypto.randomUUID(), ts = Date.now();
    const rec = { id, from: "me", text: stickerText(), ts, ack: "sent", serverAcked: false, sticker: custom ? { pack, id: sid, custom: true, mime: blob.type, w: 0, h: 0 } : { pack, id: sid } };
    if (replyTo) rec.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
    if (c.disappearingTimer) rec.ttl = c.disappearingTimer;
    if (custom) { try { await IDB.set("file:" + id, blob); } catch (e) { return false; } }
    c.messages.push(rec); trimMessages(c); c.lastActivity = ts; persistContacts();
    S.pushRecent(pack, sid);
    if (state.chatId === contactId) { renderChatThreadInner(); const w = $("#chat-messages"); if (w) w.scrollTop = w.scrollHeight; }
    if (state.tab === "chats") renderChatsList();
    playOutgoingSound(); haptic("light");
    const p = await payloadFor(rec, blob); if (!p) return false;
    await trySendOrQueue(c, id, p);
    return true;
  };
  // Пересылка: копия под новым id (данные своего пака копируются, чтобы удаление оригинала их не задело)
  S.forward = async function (m, srcMsgId, rec, to) {
    if (m.sticker.custom) { try { const b = await IDB.get("file:" + srcMsgId); if (b) await IDB.set("file:" + rec.id, b); } catch (e) {} }
    const p = await payloadFor(rec);
    if (!p) { rec.ack = "failed"; persistContacts(); if (state.chatId === to.id) renderChatThread(); toast(T("chat.file.unavailable")); return; }
    p.forwarded = true; if (rec.forwardedFrom) p.fwdFrom = rec.forwardedFrom;
    await trySendOrQueue(to, rec.id, p);
  };

  // ── Добавление своего: любое растровое / SVG → canvas → webp ≤256×256, ≤60 КБ ──
  async function loadBitmap(file) {
    if (file.type === "image/svg+xml") { // SVG только как источник для растеризации; в чат уходит уже webp
      const url = URL.createObjectURL(file);
      try { const img = new Image(); await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; }); return { src: img, w: img.naturalWidth || 256, h: img.naturalHeight || 256 }; }
      finally { URL.revokeObjectURL(url); }
    }
    const bmp = await createImageBitmap(file); return { src: bmp, w: bmp.width, h: bmp.height, bmp };
  }
  S.prepare = async function (file) {
    if (!file || !(file.size > 0) || file.size > 8 * 1024 * 1024) return null;
    if (!["image/png", "image/webp", "image/jpeg", "image/svg+xml"].includes(file.type)) return null;
    let bm; try { bm = await loadBitmap(file); } catch (e) { return null; }
    try {
      if (!(bm.w > 0 && bm.h > 0)) return null;
      let side = Math.min(1, S.USER_MAX_SIDE / Math.max(bm.w, bm.h));
      for (let attempt = 0; attempt < 8; attempt++) {
        const w = Math.max(1, Math.round(bm.w * side)), h = Math.max(1, Math.round(bm.h * side));
        const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        const cx = cv.getContext("2d"); if (!cx) return null;
        cx.clearRect(0, 0, w, h); cx.drawImage(bm.src, 0, 0, w, h);
        for (const q of [0.9, 0.75, 0.55, 0.4]) {
          const blob = await new Promise((r) => cv.toBlob(r, "image/webp", q));
          if (!blob || !(blob.size > 0) || !S.MIMES.includes(blob.type)) continue;
          if (blob.size <= S.USER_MAX_BYTES) return { blob, w, h };
          if (blob.type !== "image/webp") break; // Safari не умеет кодировать webp и отдаёт PNG: качество не влияет, уменьшаем сторону
        }
        side *= 0.75;
      }
      return null;
    } finally { try { bm.bmp && bm.bmp.close && bm.bmp.close(); } catch (e) {} }
  };
  // Добавить готовый webp/png/jpeg-блоб (проверка сигнатуры и размера обязательна и здесь)
  S.addBlob = async function (blob, name) {
    if (!isBlob(blob) || blob.size > S.USER_MAX_BYTES || !S.MIMES.includes(blob.type)) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!S.bytesOk(bytes, blob.type)) return null;
    if (S.userItems().length >= S.USER_MAX_ITEMS) { toast(T("sticker.limit", { n: S.USER_MAX_ITEMS })); return null; }
    const id = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try { await IDB.set(userKey(id), blob); } catch (e) { return null; }
    S.addUserMeta(id, name || T("sticker.defaultName"));
    return id;
  };
  S.addFile = async function (file) {
    const prep = await S.prepare(file);
    if (!prep) { toast(T("sticker.bad")); return null; }
    const base = String(file.name || "").replace(/\.[^.]+$/, "").slice(0, 40);
    const id = await S.addBlob(prep.blob, base);
    if (!id) toast(T("sticker.bad"));
    return id;
  };
  S.removeUser = async function (id) {
    if (!S.removeUserMeta(id)) return false;
    try { await IDB.del(userKey(id)); } catch (e) {}
    const u = userUrls.get(id); if (u) { try { URL.revokeObjectURL(u); } catch (e) {} userUrls.delete(id); }
    return true;
  };

  // ── Панель выбора ───────────────────────────────────────────────────
  let tab = "recent";
  async function thumbHtml(key) {
    const [pack, id] = key.split("/");
    const a = esc(alt({ pack, id }));
    if (pack !== "user") return `<img src="${S.dataUrl(pack, id)}" alt="${a}" width="64" height="64" draggable="false">`;
    let u = userUrls.get(id);
    if (!u) { const b = await customBlob(id); if (!b) return ""; u = URL.createObjectURL(b); userUrls.set(id, u); }
    return `<img src="${u}" alt="${a}" width="64" height="64" draggable="false">`;
  }
  function tabList() {
    const t = [{ id: "emoji", icon: "😀", label: T("chat.emoji") }, { id: "fav", icon: "⭐", label: T("sticker.tab.fav") }, { id: "recent", icon: "🕘", label: T("sticker.tab.recent") }];
    for (const p of S.PACKS) t.push({ id: p.id, img: S.dataUrl(p.id, p.items[0].id), label: S.lbl(p.name) });
    t.push({ id: "user", icon: "➕", label: S.packName() || T("sticker.myPack") });
    return t;
  }
  function keysFor(id) {
    if (id === "fav") return S.favorites();
    if (id === "recent") return S.recents();
    if (id === "user") return S.userItems().map((x) => "user/" + x.id);
    const p = S.PACKS.find((x) => x.id === id); return p ? p.items.map((it) => p.id + "/" + it.id) : [];
  }
  let renderGen = 0;
  async function render() {
    const gen = ++renderGen;
    const tabs = $("#sticker-tabs"), grid = $("#sticker-grid"), title = $("#sticker-section-title"); if (!tabs || !grid) return;
    const list = tabList(); if (!list.some((x) => x.id === tab)) tab = "ether";
    tabs.innerHTML = list.map((x) => `<button type="button" class="emoji-tab-btn sticker-tab${x.id === tab ? " active" : ""}" role="tab" aria-selected="${x.id === tab}" data-stab="${x.id}" aria-label="${esc(x.label)}" title="${esc(x.label)}">${x.img ? `<img src="${x.img}" alt="" width="24" height="24">` : x.icon}</button>`).join("");
    const cur = list.find((x) => x.id === tab);
    title.textContent = cur.label;
    const keys = keysFor(tab);
    const manage = tab === "user";
    let html = "";
    if (manage) html += `<button type="button" class="sticker-add" id="sticker-add-btn" aria-label="${esc(T("sticker.add"))}"><span aria-hidden="true">＋</span><small>${esc(T("sticker.add"))}</small></button>`;
    const thumbs = await Promise.all(keys.map(thumbHtml));
    if (gen !== renderGen) return; // M8: пока грузились превью, запущена более новая отрисовка
    keys.forEach((k, i) => {
      const [pack, id] = k.split("/"), name = S.label(pack, id);
      if (!thumbs[i]) return;
      html += `<div class="sticker-cell"><button type="button" class="sticker-btn" data-skey="${esc(k)}" aria-label="${esc(T("sticker.send", { name: name || T("sticker.label") }))}">${thumbs[i]}</button>${manage ? `<span class="sticker-tools"><button type="button" data-sren="${esc(id)}" aria-label="${esc(T("sticker.rename"))}">✎</button><button type="button" data-sdel="${esc(id)}" aria-label="${esc(T("sticker.delete"))}">✕</button></span>` : ""}</div>`;
    });
    if (!keys.length && !manage) html = `<p class="fine muted sticker-empty">${esc(T(tab === "fav" ? "sticker.empty.fav" : "sticker.empty.recent"))}</p>`;
    grid.innerHTML = html;
    grid.classList.toggle("sticker-grid-empty", !keys.length);
    const hint = $("#sticker-hint"); if (hint) hint.textContent = manage ? T("sticker.hint.user") : T("sticker.hint");
    const ren = $("#sticker-pack-rename"); if (ren) ren.classList.toggle("hidden", !manage);
  }
  function closePicker() { const s = $("#sticker-picker-sheet"); if (s) s.classList.add("hidden"); }
  S.openPicker = function () {
    const sheet = $("#sticker-picker-sheet"); if (!sheet || !state.chatId) return;
    if (tab === "recent" && !S.recents().length) tab = S.favorites().length ? "fav" : "ether";
    sheet.classList.remove("hidden");
    try { const panel = sheet.querySelector(".sheet-panel"), shell = $("#app-shell"), form = $("#chat-form"); if (panel && shell && form) panel.style.marginBottom = Math.max(8, Math.round(shell.getBoundingClientRect().bottom - form.getBoundingClientRect().top + 8)) + "px"; } catch (e) {}
    return render();
  };
  function wire() {
    const sheet = $("#sticker-picker-sheet"); if (!sheet) return;
    const open = $("#chat-sticker-btn"); if (open) open.addEventListener("click", () => S.openPicker());
    const eb = $("#emoji-sticker-btn"); if (eb) eb.addEventListener("click", () => { const e = $("#emoji-picker-sheet"); if (e) e.classList.add("hidden"); S.openPicker(); });
    const cap = $("#chat-sticker-btn"), plus = $("#composer-menu-sheet");
    if (cap && plus) cap.addEventListener("click", () => plus.classList.add("hidden"), { capture: true });
    sheet.addEventListener("click", async (e) => {
      const t = e.target.closest("button"); if (!t) return;
      if (t.dataset.stab) {
        if (t.dataset.stab === "emoji") { closePicker(); if (state.chatId) openEmojiPicker(); return; }
        tab = t.dataset.stab; return render();
      }
      if (t.id === "sticker-add-btn") { const f = $("#sticker-file-input"); if (f) f.click(); return; }
      if (t.id === "sticker-pack-rename") { openTextSheet({ title: T("sticker.rename.pack"), value: S.packName() || T("sticker.myPack"), onOk: (v) => { S.renamePack(v); render(); } }); return; }
      if (t.dataset.sren) { const it = S.userItems().find((x) => x.id === t.dataset.sren); if (it) openTextSheet({ title: T("sticker.rename"), value: it.name, onOk: (v) => { S.renameUser(it.id, v); render(); } }); return; }
      if (t.dataset.sdel) { if (await S.removeUser(t.dataset.sdel)) { toast(T("sticker.deleted")); render(); } return; }
      if (t.dataset.skey) {
        if (t.__lp) { t.__lp = false; return; }
        const [pack, id] = t.dataset.skey.split("/");
        const reply = state.replyTo || null;
        closePicker();
        if (await S.send(state.chatId, pack, id, reply) && reply) cancelReply();
      }
    });
    // долгое нажатие / правая кнопка — в избранное
    let lp = null;
    sheet.addEventListener("pointerdown", (e) => {
      const t = e.target.closest(".sticker-btn"); if (!t) return;
      clearTimeout(lp); lp = setTimeout(() => { lp = null; t.__lp = true; fav(t); }, 500);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel", "pointermove"]) sheet.addEventListener(ev, () => { clearTimeout(lp); lp = null; });
    sheet.addEventListener("contextmenu", (e) => { const t = e.target.closest(".sticker-btn"); if (t) { e.preventDefault(); fav(t); } });
    function fav(t) { const [pack, id] = t.dataset.skey.split("/"); const on = S.toggleFav(pack, id); toast(T(on ? "sticker.fav.on" : "sticker.fav.off")); try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {} if (tab === "fav") render(); }
    const fi = $("#sticker-file-input");
    if (fi) fi.addEventListener("change", async () => { const f = fi.files && fi.files[0]; fi.value = ""; if (f && await S.addFile(f)) { tab = "user"; render(); } });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
})();
