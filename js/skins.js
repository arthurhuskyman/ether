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
  function apply(id) {
    id = valid(id) ? id : "default";
    if (!live()) return id;
    const root = document.documentElement;
    if (id === "default") root.removeAttribute("data-skin"); else root.setAttribute("data-skin", id);
    syncMeta();
    markActive(id);
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
  function wire() { render(); }
  return { LIST, IDS, KEY, valid, get, apply, set, render, wire, syncMeta, name };
})();
