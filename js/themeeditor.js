// =====================================================================
// Редактор темы (V.80): свой акцент, фон, цвета пузырей и скругления поверх выбранной схемы. Хранится ТОЛЬКО на устройстве
// (localStorage "ether.customTheme"), отправляется только если человек сам скопировал JSON. Контраст считает SkinContrast
// (tools/skin-contrast-lib.js, он же в бандле перед этим файлом): текст на фоне и на пузырях подбирается сам (чёрный/белый, всегда
// >= 4.5:1), акцент поджимается к читаемому. Чистые функции (sanitize/derive/fix/validate) тестируются без DOM.
// =====================================================================
const ThemeEditor = (() => {
  const KEY = "ether.customTheme";
  const VERSION = 1;
  const MIN_TEXT = 4.5; // WCAG AA для обычного текста
  const RADII = { sharp: [3, 5, 8, 12], normal: [8, 12, 16, 24], round: [12, 18, 24, 32], pill: [16, 22, 30, 40] };
  const DEFAULT = { v: VERSION, accent: "#6446c9", bg: "#fafafc", mine: "#6244d8", theirs: "#f2f2f5", radius: "normal" };
  const SC = () => (typeof SkinContrast !== "undefined" ? SkinContrast : (typeof globalThis !== "undefined" ? globalThis.SkinContrast : null));
  const HEX = /^#[0-9a-f]{6}$/;

  // "#abc" / "#AABBCC" -> "#aabbcc" или null (в тему попадают только такие значения: ни url(), ни выражений)
  function hex(v) {
    if (typeof v !== "string") return null;
    let s = v.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s.slice(1).split("").map((c) => c + c).join("");
    return HEX.test(s) ? s : null;
  }
  const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1];
  const toHex = (c) => "#" + [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(c[i]))).toString(16).padStart(2, "0")).join("");
  const ratio = (a, b) => SC().ratio(rgb(a), rgb(b));
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t)); };
  // чёрный или белый текст с лучшим контрастом к фону (хотя бы один даёт >= 4.58:1)
  function inkFor(bg) { return ratio("#ffffff", bg) >= ratio("#000000", bg) ? "#ffffff" : "#000000"; }
  const isDark = (bg) => inkFor(bg) === "#ffffff";

  // Любой ввод (локальное хранилище, импорт) -> безопасный объект темы; null, если это не тема вовсе
  function sanitize(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const out = { v: VERSION };
    for (const k of ["accent", "bg", "mine", "theirs"]) { const h = hex(o[k]); if (!h) return null; out[k] = h; }
    out.radius = Object.prototype.hasOwnProperty.call(RADII, o.radius) ? o.radius : "normal";
    return out;
  }
  // Подгоняет цвет к минимальному контрасту с фоном, двигая его к чёрному/белому (что читаемее); меняется как можно меньше
  function pull(color, against, min) {
    if (ratio(color, against) >= min) return color;
    const target = inkFor(against);
    for (let i = 1; i <= 40; i++) { const c = mix(color, target, i / 40); if (ratio(c, against) >= min) return c; }
    return target;
  }
  // Что не так с темой: список {id, ratio, min, ok}; тексты (чёрный/белый) подбираются сами, поэтому проверяем акцент и отличимость пузырей
  function validate(t) {
    const th = sanitize(t); if (!th) return [];
    const inkMine = inkFor(th.mine), inkTheirs = inkFor(th.theirs), ink = inkFor(th.bg);
    return [
      { id: "text", ratio: ratio(ink, th.bg), min: MIN_TEXT },
      { id: "accent", ratio: ratio(th.accent, th.bg), min: MIN_TEXT },
      { id: "mine", ratio: ratio(inkMine, th.mine), min: MIN_TEXT },
      { id: "theirs", ratio: ratio(inkTheirs, th.theirs), min: MIN_TEXT },
      { id: "bubbles", ratio: ratio(th.mine, th.theirs), min: 1.2 },
    ].map((r) => Object.assign(r, { ok: r.ratio + 1e-9 >= r.min }));
  }
  // Автоисправление: возвращает { theme, changed: [ключи] }. Пузыри «мои»/«чужие» не должны сливаться друг с другом.
  function fix(t) {
    const th = sanitize(t); if (!th) return { theme: Object.assign({}, DEFAULT), changed: ["all"] };
    const out = Object.assign({}, th), changed = [];
    const acc = pull(out.accent, out.bg, MIN_TEXT); if (acc !== out.accent) { out.accent = acc; changed.push("accent"); }
    if (ratio(out.mine, out.theirs) < 1.2) {
      const m = pull(out.mine, out.theirs, 1.2); if (m !== out.mine) { out.mine = m; changed.push("mine"); }
    }
    return { theme: out, changed };
  }
  // Готовые CSS-переменные для документа (только цвета и числа, полученные из проверенных hex)
  function vars(t) {
    const th = sanitize(t); if (!th) return null;
    const ink = inkFor(th.bg), dark = ink === "#ffffff";
    const edge = dark ? "#ffffff" : "#000000";
    const r = RADII[th.radius];
    const a = rgb(th.accent);
    return {
      "--bg-0": th.bg, "--bg-1": mix(th.bg, edge, 0.03), "--bg-2": mix(th.bg, edge, 0.07), "--bg-3": mix(th.bg, edge, 0.12),
      "--ink-0": ink, "--ink-1": mix(th.bg, ink, 0.88), "--ink-2": mix(th.bg, ink, 0.7), "--ink-3": mix(th.bg, ink, 0.74),
      "--accent": th.accent, "--accent-hi": mix(th.accent, "#ffffff", 0.18), "--accent-lo": mix(th.accent, "#000000", 0.18),
      "--accent-bg": th.accent, "--accent-ghost": "rgba(" + a.slice(0, 3).map(Math.round).join(",") + ",0.12)", "--on-accent": inkFor(th.accent),
      "--bubble-mine-bg": th.mine, "--bubble-mine-ink": inkFor(th.mine),
      "--bubble-theirs-bg": th.theirs, "--bubble-theirs-ink": inkFor(th.theirs),
      "--r-sm": r[0] + "px", "--r-md": r[1] + "px", "--r-lg": r[2] + "px", "--r-xl": r[3] + "px",
    };
  }

  const live = () => typeof document !== "undefined" && !!document && !!document.documentElement;
  function read() { try { const raw = localStorage.getItem(KEY); return raw ? sanitize(JSON.parse(raw)) : null; } catch (e) { return null; } }
  function write(th) {
    try { if (th) localStorage.setItem(KEY, JSON.stringify(th)); else localStorage.removeItem(KEY); } catch (e) {}
    try { if (typeof scheduleIDBBackup === "function") scheduleIDBBackup(); } catch (e) {}
  }
  let applied = [];
  function clear() {
    if (!live()) return;
    const root = document.documentElement;
    applied.forEach((k) => root.style.removeProperty(k)); applied = [];
    root.removeAttribute("data-custom-theme");
    try { if (typeof Skins !== "undefined") Skins.syncMeta(); } catch (e) {}
  }
  function apply(t) {
    const v = vars(t); if (!v || !live()) return false;
    clear();
    const root = document.documentElement;
    for (const k of Object.keys(v)) { root.style.setProperty(k, v[k]); applied.push(k); }
    root.setAttribute("data-custom-theme", "1");
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", sanitize(t).bg);
    return true;
  }
  const active = () => live() && document.documentElement.getAttribute("data-custom-theme") === "1";
  // Сохраняет (после автоисправления) и применяет; возвращает { theme, changed }
  function save(t) { const f = fix(t); write(f.theme); apply(f.theme); return f; }
  function disable() { write(null); clear(); }
  function applySaved() { const th = read(); if (th) apply(th); return !!th; }

  // --- обмен JSON: только поля темы; чужое молча отбрасывается, слишком большое отклоняется ---
  function exportJson(t) { const th = sanitize(t); return th ? JSON.stringify({ ether: "theme", v: VERSION, accent: th.accent, bg: th.bg, mine: th.mine, theirs: th.theirs, radius: th.radius }, null, 2) : ""; }
  function importJson(text) {
    if (typeof text !== "string" || text.length > 2000) return null;
    let o; try { o = JSON.parse(text); } catch (e) { return null; }
    if (!o || o.ether !== "theme") return null;
    return sanitize(o);
  }

  // ---------------- интерфейс (шторка #theme-editor-sheet в index.html) ----------------
  const $id = (id) => document.getElementById(id);
  const tr = (k, p) => (typeof T === "function" ? T(k, p) : k);
  let draft = null;
  function current() { return draft || read() || startFromPage(); }
  // первый запуск редактора: берём то, что человек видит сейчас, а не фиксированные цвета
  function startFromPage() {
    const th = Object.assign({}, DEFAULT);
    if (!live() || typeof getComputedStyle !== "function") return th;
    try {
      const cs = getComputedStyle(document.documentElement);
      const pick = (name, key) => { const h = hex(cs.getPropertyValue(name)); if (h) th[key] = h; };
      pick("--bg-0", "bg"); pick("--accent", "accent"); pick("--accent-bg", "mine"); pick("--bg-2", "theirs");
    } catch (e) {}
    return th;
  }
  function paintChecks(th) {
    const box = $id("theme-editor-checks"); if (!box) return;
    box.innerHTML = "";
    for (const r of validate(th)) {
      const li = document.createElement("li");
      li.className = r.ok ? "te-ok" : "te-bad";
      li.textContent = (r.ok ? "✓ " : "✗ ") + tr("theme.check." + r.id) + " — " + r.ratio.toFixed(1) + ":1";
      box.appendChild(li);
    }
  }
  function paintPreview(th) {
    const p = $id("theme-editor-preview"); if (!p) return;
    const v = vars(th); if (!v) return;
    for (const k of Object.keys(v)) p.style.setProperty(k, v[k]);
  }
  function syncInputs(th) {
    for (const [k, id] of [["accent", "te-accent"], ["bg", "te-bg"], ["mine", "te-mine"], ["theirs", "te-theirs"]]) { const el = $id(id); if (el) el.value = th[k]; }
    document.querySelectorAll("#theme-editor-sheet [data-te-radius]").forEach((b) => { const on = b.dataset.teRadius === th.radius; b.setAttribute("aria-checked", on ? "true" : "false"); b.classList.toggle("active", on); });
    paintChecks(th); paintPreview(th);
  }
  function readInputs() {
    const th = Object.assign({}, current());
    for (const [k, id] of [["accent", "te-accent"], ["bg", "te-bg"], ["mine", "te-mine"], ["theirs", "te-theirs"]]) { const h = hex(($id(id) || {}).value); if (h) th[k] = h; }
    return th;
  }
  function open() { const sh = $id("theme-editor-sheet"); if (!sh) return; draft = current(); syncInputs(draft); sh.classList.remove("hidden"); }
  function close() { const sh = $id("theme-editor-sheet"); if (sh) sh.classList.add("hidden"); draft = null; }
  function wire() {
    if (!live()) return;
    applySaved();
    const sh = $id("theme-editor-sheet"); if (!sh || sh.dataset.wired) return; sh.dataset.wired = "1";
    ["te-accent", "te-bg", "te-mine", "te-theirs"].forEach((id) => { const el = $id(id); if (el) el.addEventListener("input", () => { draft = readInputs(); syncInputs(draft); }); });
    sh.querySelectorAll("[data-te-radius]").forEach((b) => b.addEventListener("click", () => { draft = Object.assign({}, current(), { radius: b.dataset.teRadius }); syncInputs(draft); }));
    const note = (k) => { const n = $id("theme-editor-note"); if (n) n.textContent = tr(k); };
    const fixBtn = $id("te-fix"); if (fixBtn) fixBtn.addEventListener("click", () => { const f = fix(current()); draft = f.theme; syncInputs(draft); note(f.changed.length ? "theme.fixed" : "theme.allOk"); });
    const saveBtn = $id("te-save"); if (saveBtn) saveBtn.addEventListener("click", () => {
      const f = save(current());
      if (typeof toast === "function") toast(tr(f.changed.length ? "theme.savedFixed" : "theme.saved"));
      close();
    });
    const resetBtn = $id("te-reset"); if (resetBtn) resetBtn.addEventListener("click", () => { disable(); close(); if (typeof toast === "function") toast(tr("theme.removed")); });
    const exp = $id("te-export"); if (exp) exp.addEventListener("click", () => {
      const json = exportJson(fix(current()).theme); const ta = $id("te-json"); if (ta) ta.value = json;
      if (typeof copyText === "function") copyText(json, tr("theme.copied"));
    });
    const imp = $id("te-import"); if (imp) imp.addEventListener("click", () => {
      const ta = $id("te-json"); const th = importJson(ta ? ta.value : "");
      if (!th) { note("theme.importBad"); return; }
      const f = fix(th); draft = f.theme; syncInputs(draft); note(f.changed.length ? "theme.importFixed" : "theme.imported");
    });
    const openBtn = $id("theme-editor-open"); if (openBtn) openBtn.addEventListener("click", () => { try { if (typeof Skins !== "undefined") Skins.closeSheet(); } catch (e) {} open(); });
  }
  return { KEY, RADII, DEFAULT, MIN_TEXT, hex, inkFor, sanitize, validate, fix, vars, apply, clear, save, disable, applySaved, read, active, exportJson, importJson, open, close, wire };
})();
if (typeof window !== "undefined") window.ThemeEditor = ThemeEditor;
