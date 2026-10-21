// =====================================================================
// Скины — полное оформление приложения (см. css/skins.css). Атрибут html[data-skin] включает скин, а светлый или тёмный вариант
// выбирает обычная тема (data-scheme). Здесь: список скинов с цветами для превью, применение, выбор в настройках.
// Загружается после app.js; использует его глобалы (Store, T, $, $$).
// =====================================================================
const Skins = (() => {
  const KEY = "ether.skin";
  // id → { emoji, light/dark: [фон, панель, акцент] (цвета превью), bar: цвет полосы статуса iOS }
  const LIST = [
    { id: "default", emoji: "✨", light: ["#fafafc", "#ffffff", "#6446c9"], dark: ["#08080a", "#17171c", "#8a6dff"], bar: { light: "#fafafc", dark: "#08080a" } },
    { id: "cartoon", emoji: "🎈", light: ["#fff1cf", "#ffffff", "#ffd23f"], dark: ["#1d1a3d", "#312d63", "#ffd23f"], bar: { light: "#fff1cf", dark: "#1d1a3d" } },
    { id: "comic", emoji: "💥", light: ["#fff4d1", "#ffffff", "#d62839"], dark: ["#14141e", "#26263a", "#ffd60a"], bar: { light: "#fff4d1", dark: "#14141e" } },
    { id: "watercolor", emoji: "🎨", light: ["#fbf6fb", "#ffffff", "#a9dcff"], dark: ["#171427", "#262142", "#b79cff"], bar: { light: "#fbf6fb", dark: "#171427" } },
    { id: "neon", emoji: "🌃", light: ["#f1edfd", "#ffffff", "#c4009f"], dark: ["#07060f", "#130f28", "#00f0ff"], bar: { light: "#f1edfd", dark: "#07060f" } },
    { id: "steampunk", emoji: "⚙️", light: ["#e6d5ae", "#f6ecd2", "#95581a"], dark: ["#1f150d", "#35251a", "#dca044"], bar: { light: "#e6d5ae", dark: "#1f150d" } },
    { id: "gothic", emoji: "🦇", light: ["#d9d2cb", "#f0eae4", "#9b111e"], dark: ["#09060a", "#150c13", "#d11a2a"], bar: { light: "#d9d2cb", dark: "#09060a" } },
    { id: "clay", emoji: "🧸", light: ["#f6e4d1", "#fff6ec", "#58c2b3"], dark: ["#2a2233", "#40354e", "#ff9f80"], bar: { light: "#f6e4d1", dark: "#2a2233" } },
    { id: "lego", emoji: "🧱", light: ["#dde5ee", "#f5cd2a", "#d01012"], dark: ["#13202f", "#0055bf", "#ffd01f"], bar: { light: "#dde5ee", dark: "#13202f" } },
    { id: "wood", emoji: "🌳", light: ["#ecdcbc", "#faf1dc", "#3f7a2d"], dark: ["#281a10", "#402c1f", "#8fd16a"], bar: { light: "#ecdcbc", dark: "#281a10" } },
    { id: "glass", emoji: "🪟", light: ["#dfe9ff", "#ffffff", "#2a62f0"], dark: ["#0d0f2b", "#1b1f4c", "#8cb4ff"], bar: { light: "#dfe9ff", dark: "#0d0f2b" } },
    { id: "chalk", emoji: "🖍️", light: ["#f5f6f0", "#ffffff", "#1e63d0"], dark: ["#1a2a23", "#263d33", "#ffd86b"], bar: { light: "#f5f6f0", dark: "#1a2a23" } },
    { id: "newyear", emoji: "🎄", light: ["#e9f3ff", "#ffffff", "#c8102e"], dark: ["#0b1a3a", "#17325e", "#ff5a6a"], bar: { light: "#e9f3ff", dark: "#0b1a3a" } },
  ];
  const IDS = LIST.map((s) => s.id);
  // Реестр «характера» скина: js/skins/<id>.js вызывает Skins.register(id, spec). spec:
  //   icons: { имя: "<path…/>" } — своя графика иконок (ключи из Icons.names()), остальные остаются обычными;
  //   sound: { in, out, tap, tab, react, error } — партитуры звуков (см. play ниже);
  //   deco(layer, { scheme, calm }) — рисует декор в фиксированном слое #skin-deco (шестерни, снег, огни…), может вернуть функцию очистки;
  //   haptic: { tap: [мс…] } — своя вибрация на тап.
  const REG = {};
  function register(id, spec) { if (IDS.includes(id)) REG[id] = spec || {}; }
  const spec = () => REG[get()] || null;
  const valid = (id) => IDS.includes(id);
  const get = () => { let v = "default"; try { v = localStorage.getItem(KEY) || "default"; } catch (e) {} return valid(v) ? v : "default"; };
  const live = () => typeof document !== "undefined" && !!document && !!document.documentElement; // окно может уже закрыться (тесты, выгрузка страницы)
  const scheme = () => (document.documentElement.dataset.scheme === "light" ? "light" : "dark");

  // Цвет строки состояния (meta theme-color) под фон выбранного скина и текущую схему
  function syncMeta() {
    if (!live()) return;
    const meta = document.querySelector('meta[name="theme-color"]'); if (!meta) return;
    const s = LIST.find((x) => x.id === get()) || LIST[0];
    // у обычного вида цвет зависит ещё и от OLED (чистый чёрный), у остальных скинов — от схемы
    const dark = s.id === "default" && document.documentElement.dataset.theme === "oled" ? "#000000" : s.bar.dark;
    meta.setAttribute("content", scheme() === "light" ? s.bar.light : dark);
  }

  // --tabbar-h: расстояние от низа окна до верха #tab-bar. Высоту таб-бара меняют скины (отступы, поля, скругления) и клавиатура,
  // а плавающий #mini-call-bar должен стоять ровно над ним (css/styles.css).
  let tbRO = null;
  function syncTabbar() {
    if (!live()) return;
    const bar = document.getElementById("tab-bar"), root = document.documentElement;
    if (!bar || typeof bar.getBoundingClientRect !== "function") return;
    const r = bar.getBoundingClientRect();
    if (!r.height || !window.innerHeight) root.style.removeProperty("--tabbar-h");
    else root.style.setProperty("--tabbar-h", Math.max(0, Math.round(window.innerHeight - r.top)) + "px");
    if (!tbRO && typeof ResizeObserver !== "undefined") { tbRO = new ResizeObserver(syncTabbar); tbRO.observe(bar); window.addEventListener("resize", syncTabbar); }
  }

  // ---------- Звуки скина: партитура — массив нот {f|[f0,f1], t, d, v, w, lp, hp, q, n}; w: sine|square|sawtooth|triangle|noise ----------
  let lastTap = 0;
  function play(score, ctx) {
    const t0 = ctx.currentTime + 0.005;
    for (const n of score) {
      const at = t0 + (n.t || 0), dur = Math.max(0.02, n.d || 0.12), vol = Math.min(0.3, n.v == null ? 0.1 : n.v);
      const g = ctx.createGain(); let src;
      if (n.w === "noise") {
        const len = Math.max(1, Math.floor(ctx.sampleRate * dur)), buf = ctx.createBuffer(1, len, ctx.sampleRate), ch = buf.getChannelData(0);
        for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
        src = ctx.createBufferSource(); src.buffer = buf;
      } else {
        src = ctx.createOscillator(); src.type = n.w || "sine";
        const f = n.f, f0 = Array.isArray(f) ? f[0] : f, f1 = Array.isArray(f) ? f[1] : f;
        src.frequency.setValueAtTime(f0, at);
        if (f1 !== f0) src.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
      }
      let node = src;
      if (n.lp) { const b = ctx.createBiquadFilter(); b.type = "lowpass"; b.frequency.value = n.lp; b.Q.value = n.q || 0.7; node.connect(b); node = b; }
      if (n.hp) { const b = ctx.createBiquadFilter(); b.type = "highpass"; b.frequency.value = n.hp; b.Q.value = n.q || 0.7; node.connect(b); node = b; }
      node.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), at + Math.min(0.012, dur / 3));
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      src.start(at); src.stop(at + dur + 0.03);
    }
  }
  // true — звук скина сыгран (тогда обычный сигнал не нужен); false — у скина нет такого звука или звук сейчас недоступен
  function sfx(kind) {
    try {
      const sp = spec(); const score = sp && sp.sound && sp.sound[kind]; if (!score) return false;
      if (typeof Store === "undefined" || !Store.soundsEnabled) return false;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
      const ctx = typeof ensureGlobalAudioCtx === "function" ? ensureGlobalAudioCtx() : null;
      if (!ctx || ctx.state !== "running") return false;
      play(score, ctx); return true;
    } catch (e) { return false; }
  }
  function onTap(e) {
    if (!live() || get() === "default") return;
    const el = e.target && e.target.closest ? e.target.closest("button, .tab-btn, .chat-row, .settings-row, .chip, .composer-menu-item, [role=button]") : null;
    if (!el || el.disabled) return;
    const now = Date.now(); if (now - lastTap < 80) return; lastTap = now;
    const sp = spec();
    if (sp && sp.haptic && sp.haptic.tap && typeof vibrate === "function") { try { vibrate(sp.haptic.tap); } catch (err) {} }
    sfx(el.classList.contains("tab-btn") ? "tab" : "tap") || (el.classList.contains("tab-btn") && sfx("tap"));
  }

  // ---------- Декор: фиксированный слой под интерфейсом, который скин наполняет сам ----------
  let decoCleanup = null;
  function applyDeco(id) {
    if (!live()) return;
    if (decoCleanup) { try { decoCleanup(); } catch (e) {} decoCleanup = null; }
    let layer = document.getElementById("skin-deco");
    if (!layer) { layer = document.createElement("div"); layer.id = "skin-deco"; layer.setAttribute("aria-hidden", "true"); document.body.insertBefore(layer, document.body.firstChild); }
    layer.innerHTML = ""; layer.dataset.skin = id;
    const sp = REG[id];
    if (sp && typeof sp.deco === "function") {
      let calm = false; try { calm = !!(Store && Store.calmMode); } catch (e) {}
      try { const r = sp.deco(layer, { scheme: scheme(), calm }); if (typeof r === "function") decoCleanup = r; } catch (e) {}
    }
  }
  // иконки: свой набор скина поверх обычного
  function applyIcons(id) {
    if (typeof Icons === "undefined" || !Icons.setOverrides) return;
    const sp = REG[id]; Icons.setOverrides(sp && sp.icons ? sp.icons : null);
    try { Icons.hydrate(document, true); } catch (e) {}
  }
  function apply(id) {
    id = valid(id) ? id : "default";
    if (!live()) return id;
    const root = document.documentElement;
    if (id === "default") root.removeAttribute("data-skin"); else root.setAttribute("data-skin", id);
    syncMeta();
    syncTabbar(); if (typeof requestAnimationFrame === "function") requestAnimationFrame(syncTabbar);
    markActive(id);
    applyIcons(id); applyDeco(id);
    return id;
  }
  function set(id) {
    id = valid(id) ? id : "default";
    try { localStorage.setItem(KEY, id); } catch (e) {}
    try { if (typeof scheduleIDBBackup === "function") scheduleIDBBackup(); } catch (e) {}
    return apply(id);
  }
  function markActive(id) {
    if (!live()) return;
    const grid = document.getElementById("skin-grid"); if (!grid) return;
    grid.querySelectorAll(".skin-card").forEach((b) => { const on = b.dataset.skin === id; b.classList.toggle("active", on); b.setAttribute("aria-checked", on ? "true" : "false"); });
  }
  function name(id) { const k = "skin.name." + id; const v = typeof T === "function" ? T(k) : k; return v === k ? id : v; }
  function render() {
    if (!live()) return;
    const grid = document.getElementById("skin-grid"); if (!grid) return;
    const cur = get();
    grid.innerHTML = "";
    for (const s of LIST) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "skin-card"; b.dataset.skin = s.id; b.setAttribute("role", "radio");
      const dots = (arr) => arr.map((c) => `<i style="background:${c}"></i>`).join("");
      b.innerHTML = `<span class="skin-emoji" aria-hidden="true">${s.emoji}</span><span class="skin-name"></span><span class="skin-sw"><span class="skin-sw-day" title="${T("skin.day")}">${dots(s.light)}</span><span class="skin-sw-night" title="${T("skin.night")}">${dots(s.dark)}</span></span>`;
      b.querySelector(".skin-name").textContent = name(s.id);
      b.addEventListener("click", () => set(s.id));
      grid.appendChild(b);
    }
    markActive(cur);
  }
  let tapWired = false;
  function wire() {
    render();
    if (!tapWired && live()) { tapWired = true; document.addEventListener("click", onTap, true); }
    // схема (светлая/тёмная) могла смениться — декор зависит от неё
    if (live() && typeof MutationObserver !== "undefined" && !wire.mo) { wire.mo = new MutationObserver(() => { if (get() !== "default") applyDeco(get()); }); wire.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] }); }
    apply(get());
  }
  return { LIST, IDS, KEY, valid, get, apply, set, render, wire, syncMeta, name, register, sfx, play, spec };
})();
