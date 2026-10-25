// =====================================================================
// Скины — полное оформление приложения (см. css/skins.css). Атрибут html[data-skin] включает скин, а светлый или тёмный вариант
// выбирает обычная тема (data-scheme). Здесь: список скинов с цветами для превью, применение, выбор в настройках.
// Загружается после app.js; использует его глобалы (Store, T, $, $$).
// =====================================================================
const Skins = (() => {
  const KEY = "ether.skin";
  // id → { emoji, light/dark: [фон, панель, акцент] (цвета превью), bar: цвет полосы статуса iOS }.
  // Значения = --bg-0 / --bg-2 / --accent из css/skins/<id>.css (при смене палитры скина обновлять и здесь; сверяет тест skins).
  const LIST = [
    { id: "default", emoji: "✨", light: ["#fafafc", "#ffffff", "#6446c9"], dark: ["#08080a", "#17171c", "#8a6dff"], bar: { light: "#fafafc", dark: "#08080a" } },
    { id: "glass", emoji: "🪟", light: ["#dfe9ff", "#f7f9ff", "#2953d4"], dark: ["#0d0f2b", "#1b1f4c", "#a9c8ff"], bar: { light: "#dfe9ff", dark: "#0d0f2b" } },
    { id: "neon", emoji: "🌃", light: ["#eaf4ff", "#ffffff", "#005f94"], dark: ["#07060f", "#130f28", "#00e5f5"], bar: { light: "#eaf4ff", dark: "#07060f" } },
    { id: "clay", emoji: "🧸", light: ["#f6e4d1", "#fff6ec", "#a93a1b"], dark: ["#2a2233", "#40354e", "#ff9f80"], bar: { light: "#f6e4d1", dark: "#2a2233" } },
    { id: "sakura", emoji: "🌸", light: ["#fff4f7", "#ffffff", "#b02a5e"], dark: ["#1b1218", "#2a1b24", "#ff9fc0"], bar: { light: "#fff4f7", dark: "#1b1218" } },
    { id: "cartoon", emoji: "🎈", light: ["#fff3d6", "#ffffff", "#1757b8"], dark: ["#1c1a3a", "#2d2a5c", "#ffd23f"], bar: { light: "#fff3d6", dark: "#1c1a3a" } },
    { id: "comic", emoji: "💥", light: ["#fff7d6", "#ffffff", "#c01830"], dark: ["#14142b", "#20204a", "#ffd60a"], bar: { light: "#fff7d6", dark: "#14142b" } },
    { id: "watercolor", emoji: "🎨", light: ["#f8f3fb", "#fffaff", "#5b3fc4"], dark: ["#151226", "#231e3d", "#b79cff"], bar: { light: "#f8f3fb", dark: "#151226" } },
    { id: "steampunk", emoji: "⚙️", light: ["#f5efe6", "#fbf7f0", "#8a4513"], dark: ["#17120f", "#271e19", "#e0a066"], bar: { light: "#f5efe6", dark: "#17120f" } },
    { id: "gothic", emoji: "🖤", light: ["#ece8e6", "#f7f4f2", "#8e1530"], dark: ["#0b080c", "#1a1219", "#e8607a"], bar: { light: "#ece8e6", dark: "#0b080c" } },
    { id: "lego", emoji: "🧱", light: ["#eef1f5", "#ffffff", "#b41318"], dark: ["#101a2b", "#1b2b45", "#ffd01f"], bar: { light: "#eef1f5", dark: "#101a2b" } },
    { id: "wood", emoji: "🌳", light: ["#f4ecdd", "#fcf8f0", "#2d6a3e"], dark: ["#1d1711", "#2a2219", "#a5d97b"], bar: { light: "#f4ecdd", dark: "#1d1711" } },
    { id: "chalk", emoji: "🖍️", light: ["#f7f5ee", "#ffffff", "#b5322a"], dark: ["#1c2622", "#2a3631", "#ffd86b"], bar: { light: "#f7f5ee", dark: "#1c2622" } },
    { id: "newyear", emoji: "🎄", light: ["#eef5fc", "#ffffff", "#b3122b"], dark: ["#0b1530", "#16264d", "#ff9aa8"], bar: { light: "#eef5fc", dark: "#0b1530" } },
{ id: "vampire", emoji: "🧛", light: ["#f3e8e5", "#fbf4f1", "#9c1030"], dark: ["#0d0408", "#1c0a10", "#ff5a76"], bar: { light: "#f3e8e5", dark: "#0d0408" } },
    { id: "hacker", emoji: "💻", light: ["#e8f2ea", "#f5fbf6", "#0b6b2e"], dark: ["#020a05", "#07140b", "#39ff7a"], bar: { light: "#e8f2ea", dark: "#020a05" } },
    { id: "pixel", emoji: "👾", light: ["#e4f0d2", "#f6fbea", "#236b23"], dark: ["#1a1033", "#2a1b4d", "#ffd23f"], bar: { light: "#e4f0d2", dark: "#1a1033" } },
    { id: "vaporwave", emoji: "🌴", light: ["#fde6ff", "#fff5ff", "#a1157f"], dark: ["#1a0b3a", "#2a1458", "#ff71ce"], bar: { light: "#fde6ff", dark: "#1a0b3a" } },
    { id: "ocean", emoji: "🌊", light: ["#e1f5fb", "#f4fcff", "#0a6a93"], dark: ["#03182b", "#072b47", "#4fd8ff"], bar: { light: "#e1f5fb", dark: "#03182b" } },
    { id: "galaxy", emoji: "🪐", light: ["#eceaff", "#f8f7ff", "#5a36d0"], dark: ["#070816", "#121436", "#b9a2ff"], bar: { light: "#eceaff", dark: "#070816" } },
    { id: "western", emoji: "🤠", light: ["#f0e0c4", "#f9eed8", "#8a3f10"], dark: ["#1f1410", "#33211a", "#f0a35c"], bar: { light: "#f0e0c4", dark: "#1f1410" } },
    { id: "sumie", emoji: "🖌️", light: ["#f2eee4", "#fbf8f1", "#b3202a"], dark: ["#101010", "#1b1b1b", "#ee6a73"], bar: { light: "#f2eee4", dark: "#101010" } },
    { id: "artdeco", emoji: "🏛️", light: ["#f3ecd9", "#fbf6e8", "#7a5608"], dark: ["#0b0e14", "#151b26", "#e6c05a"], bar: { light: "#f3ecd9", dark: "#0b0e14" } },
    { id: "kawaii", emoji: "🍭", light: ["#ffeef6", "#fff9fc", "#a82a6a"], dark: ["#271230", "#381a45", "#ff9ccf"], bar: { light: "#ffeef6", dark: "#271230" } },
    { id: "pirate", emoji: "🏴‍☠️", light: ["#ecd9b0", "#f6e8c6", "#8a2a14"], dark: ["#0c1a24", "#15293a", "#e8b64c"], bar: { light: "#ecd9b0", dark: "#0c1a24" } },
    { id: "medieval", emoji: "🏰", light: ["#e9e2d2", "#f6f0e2", "#7b1d1d"], dark: ["#14161c", "#20232c", "#d9b45a"], bar: { light: "#e9e2d2", dark: "#14161c" } },
    { id: "jungle", emoji: "🦜", light: ["#e4f2d8", "#f4faec", "#18682f"], dark: ["#0a1a10", "#12301c", "#7de08a"], bar: { light: "#e4f2d8", dark: "#0a1a10" } },
    { id: "arctic", emoji: "🧊", light: ["#e8f5fb", "#f8fdff", "#0a6095"], dark: ["#06131f", "#0d2236", "#8fe0ff"], bar: { light: "#e8f5fb", dark: "#06131f" } },
    { id: "halloween", emoji: "🎃", light: ["#fdf0dc", "#fff8ec", "#9a3e00"], dark: ["#130a1f", "#22123a", "#ff8a1f"], bar: { light: "#fdf0dc", dark: "#130a1f" } },
    { id: "retro", emoji: "📻", light: ["#f6e7c8", "#fff3da", "#963a08"], dark: ["#2a1a10", "#3d261a", "#f2a33a"], bar: { light: "#f6e7c8", dark: "#2a1a10" } },
    { id: "newspaper", emoji: "📰", light: ["#ece6d8", "#f7f3e8", "#8a1c1c"], dark: ["#1a1a18", "#252522", "#ff9a8a"], bar: { light: "#ece6d8", dark: "#1a1a18" } },
    { id: "blueprint", emoji: "📐", light: ["#eef3f8", "#fafcff", "#0b5ea8"], dark: ["#0a2a4a", "#0f3a66", "#9fdcff"], bar: { light: "#eef3f8", dark: "#0a2a4a" } },
  ];
  // Пять скинов главного списка (сетка 3×2: пять карточек + ячейка «…» со всеми скинами)
  const MAIN = ["default", "glass", "neon", "clay", "sakura"];
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
    // у обычного вида цвет зависит ещё и от темы (OLED — чистый чёрный, aurora — холодный синий), у остальных скинов — от схемы
    const theme = document.documentElement.dataset.theme;
    const dark = s.id === "default" ? (theme === "oled" ? "#000000" : theme === "aurora" ? "#05080d" : s.bar.dark) : s.bar.dark;
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

  // CSS скина добавляется ранним скриптом из <head> ДО основных таблиц (tokens/styles/skins.css), поэтому при холодном старте
  // он оказывается РАНЬШЕ skins.css и проигрывает ему любую ничью специфичности (латунные панели steampunk, чёрный таб-бар comic
  // перекрывались общей панелью → текст на тёмном/светлом фоне терялся). Переносим <link> скина сразу после css/skins.css.
  function orderSkinCss() {
    if (!live()) return;
    const base = document.querySelector('link[rel="stylesheet"][href$="css/skins.css"]'); if (!base) return;
    document.querySelectorAll("link[data-skin-css]").forEach((l) => {
      if (base.compareDocumentPosition(l) & 4 /* DOCUMENT_POSITION_FOLLOWING: l после base — порядок верный */) return;
      base.after(l);
    });
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
    orderSkinCss();
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
    try { if (typeof ThemeEditor !== "undefined") ThemeEditor.disable(); } catch (e) {} // выбор готового скина снимает свою тему
    const r = apply(id); renderMainIfNeeded(); return r;
  }
  const gridsOf = () => ["skin-grid", "skin-sheet-grid"].map((i) => document.getElementById(i)).filter(Boolean);
  function markActive(id) {
    if (!live()) return;
    gridsOf().forEach((grid) => grid.querySelectorAll(".skin-card[data-skin]").forEach((b) => { const on = b.dataset.skin === id; b.classList.toggle("active", on); b.setAttribute("aria-checked", on ? "true" : "false"); }));
  }
  function name(id) { const k = "skin.name." + id; const v = typeof T === "function" ? T(k) : k; return v === k ? id : v; }
  // Какие пять скинов показать в главной сетке: выбранный вне пятёрки занимает последнее место
  function mainFive(cur) { const m = MAIN.slice(); if (!m.includes(cur) && valid(cur)) m[m.length - 1] = cur; return m; }
  function card(s, onPick) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "skin-card"; b.dataset.skin = s.id; b.setAttribute("role", "radio");
    const dots = (arr) => arr.map((c) => `<i style="background:${c}"></i>`).join("");
    b.innerHTML = `<span class="skin-emoji" aria-hidden="true">${s.emoji}</span><span class="skin-name"></span><span class="skin-sw"><span class="skin-sw-day" title="${T("skin.day")}">${dots(s.light)}</span><span class="skin-sw-night" title="${T("skin.night")}">${dots(s.dark)}</span></span>`;
    b.querySelector(".skin-name").textContent = name(s.id);
    b.addEventListener("click", () => onPick(s.id));
    return b;
  }
  function sheetEl() { return document.getElementById("skin-sheet"); }
  function openSheet() { const sh = sheetEl(); if (sh) { renderSheet(); sh.classList.remove("hidden"); } }
  function closeSheet() { const sh = sheetEl(); if (sh) sh.classList.add("hidden"); }
  function renderSheet() {
    const grid = document.getElementById("skin-sheet-grid"); if (!grid) return;
    grid.innerHTML = "";
    for (const s of LIST) grid.appendChild(card(s, (id) => { set(id); closeSheet(); }));
    markActive(get());
  }
  function renderMainIfNeeded() {
    if (!live()) return;
    const grid = document.getElementById("skin-grid"); if (!grid) return;
    const want = mainFive(get()).join(), have = Array.from(grid.querySelectorAll(".skin-card[data-skin]")).map((b) => b.dataset.skin).join();
    if (want !== have) render();
  }
  function render() {
    if (!live()) return;
    const grid = document.getElementById("skin-grid"); if (!grid) return;
    const cur = get();
    grid.innerHTML = "";
    for (const id of mainFive(cur)) grid.appendChild(card(LIST.find((x) => x.id === id), (sid) => set(sid)));
    const more = document.createElement("button");
    more.type = "button"; more.className = "skin-card skin-more"; more.id = "skin-more-btn"; more.setAttribute("aria-haspopup", "dialog"); more.setAttribute("aria-label", T("skin.all"));
    more.innerHTML = `<span class="skin-emoji" aria-hidden="true">…</span><span class="skin-name"></span><span class="skin-sw" aria-hidden="true"></span>`;
    more.querySelector(".skin-name").textContent = T("skin.more");
    more.addEventListener("click", openSheet);
    grid.appendChild(more);
    markActive(cur);
    renderSheet();
  }
  // ---------- Общие помощники для скинов (чтобы файл скина был коротким) ----------
  // kit({ w, f, iv, d, v, lp, nz }) — шесть звуков из одного «голоса»: волна w, основной тон f (Гц), интервалы iv (множители), длина ноты d (с), громкость v,
  // lowpass lp, nz — частота среза щелчка-шума (если задан).
  function kit(o) {
    const w = o.w || "sine", f = o.f || 440, iv = o.iv || [1, 1.25, 1.5], d = o.d || 0.12, v = o.v || 0.08, nz = o.nz ? [{ w: "noise", t: 0, d: 0.03, v: 0.03, lp: o.nz }] : [];
    const N = (fr, t, dd, vv) => { const n = { f: fr, t, d: dd, v: vv, w }; if (o.lp) n.lp = o.lp; return n; };
    const a = iv[1] || 1.25, b = iv[2] || 1.5;
    return {
      in: iv.map((r, i) => N(f * r, i * d * 0.9, d * 1.8, v)).concat(nz),
      out: [N(f * a, 0, d * 0.8, v * 0.9), N(f * b, d * 0.7, d, v * 0.9)],
      tap: [N([f * 1.5, f * 1.2], 0, 0.05, v * 0.6)].concat(nz),
      tab: [N(f * a, 0, 0.06, v * 0.6), N(f * b, 0.05, 0.08, v * 0.6)],
      react: [N(f * 2, 0, 0.12, v * 0.6), N(f * b * 2, 0.07, 0.16, v * 0.5)],
      error: [N([f, f * 0.7], 0, 0.22, v), N(f * 0.66, 0.12, 0.28, v)],
    };
  }
  // fx(layer, { scheme, calm }, cfgs) — лёгкие частицы декора. cfg: g — глифы/эмодзи, m — режим (fall|rise|drift|roll|twinkle|bob|blink),
  // n — число, s — размер px [мин, макс], o — прозрачность, t — период с, y — диапазон высоты vh, c — цвета (массив или { light, dark }), cls — класс скина.
  // Анимация только transform/opacity; при «спокойном режиме» и reduced-motion частицы неподвижны (css/skins.css).
  function fx(layer, o, cfgs) {
    const calm = !!(o && o.calm), sc = (o && o.scheme) === "light" ? "light" : "dark";
    for (const c of [].concat(cfgs || [])) {
      const n = calm ? Math.ceil(c.n / 2) : c.n, col = Array.isArray(c.c) ? c.c : (c.c && c.c[sc]) || null;
      for (let i = 0; i < n; i++) {
        const r = (k) => { const x = Math.sin(i * 12.9898 + k * 78.233 + c.n * 3.1) * 43758.5453; return x - Math.floor(x); }, lerp = (p, k) => p[0] + r(k) * (p[1] - p[0]);
        const e = document.createElement("i"); e.className = "sk-p sk-" + c.m + (c.cls ? " " + c.cls : "");
        e.textContent = c.g[i % c.g.length];
        e.style.cssText = `--x:${(r(2) * 94).toFixed(1)}vw;--y:${(c.y ? lerp(c.y, 3) : r(3) * 92).toFixed(0)}vh;--s:${lerp(c.s, 1).toFixed(0)}px;--o:${lerp(c.o, 4).toFixed(2)};--t:${lerp(c.t, 5).toFixed(1)}s;--dl:${(-r(6) * c.t[1]).toFixed(1)}s;--w:${((r(7) - 0.5) * 70).toFixed(0)}px;` + (col ? `color:${col[i % col.length]};` : "");
        layer.appendChild(e);
      }
    }
    return () => { layer.innerHTML = ""; };
  }

  let tapWired = false;
  function wire() {
    render();
    if (!tapWired && live()) { tapWired = true; document.addEventListener("click", onTap, true); }
    // схема (светлая/тёмная) могла смениться — декор зависит от неё
    if (live() && typeof MutationObserver !== "undefined" && !wire.mo) { wire.mo = new MutationObserver(() => { if (get() !== "default") applyDeco(get()); }); wire.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] }); }
    apply(get());
    try { if (typeof ThemeEditor !== "undefined") ThemeEditor.wire(); } catch (e) {}
  }
  return { LIST, IDS, KEY, valid, get, apply, set, render, wire, syncMeta, name, register, kit, fx, sfx, play, spec, MAIN, mainFive, openSheet, closeSheet };
})();
