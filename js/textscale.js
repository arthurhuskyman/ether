// Dynamic Type / масштаб текста. Грузится в <head> до первой отрисовки (внешний файл — хэши CSP не затрагиваются).
// Весь текст в css задан в rem, поэтому достаточно менять размер корня html:
//  - «Системный» (по умолчанию): iOS — множитель из шрифта -apple-system-body (17px = 100%) в --sys-text-scale;
//    Android Chrome масштабирует rem сам (html font-size: 100%);
//  - «Мелкий / Обычный / Крупный / Очень крупный» = 87.5% / 100% / 115% / 135% базы (html[data-text-scale], css/styles.css).
// Значение хранится в localStorage "ether.textScale" (system|small|normal|large|xlarge).
const TextScale = (() => {
  const KEY = "ether.textScale";
  const LIST = ["system", "small", "normal", "large", "xlarge"];
  const FACTOR = { small: 0.875, normal: 1, large: 1.15, xlarge: 1.35 };
  const root = () => (typeof document !== "undefined" ? document.documentElement : null);
  function get() { let v = "system"; try { v = localStorage.getItem(KEY) || "system"; } catch (e) {} return LIST.includes(v) ? v : "system"; }
  function sysScale() {
    try {
      const d = root();
      if (!d || typeof CSS === "undefined" || !CSS.supports || !CSS.supports("font", "-apple-system-body")) return 1;
      const p = document.createElement("span");
      p.style.cssText = "position:absolute;visibility:hidden;font:-apple-system-body";
      d.appendChild(p);
      const px = parseFloat(getComputedStyle(p).fontSize); p.remove();
      return isFinite(px) && px > 0 ? Math.min(2, Math.max(0.85, px / 17)) : 1;
    } catch (e) { return 1; }
  }
  function apply(v) {
    const d = root(); if (!d) return;
    v = LIST.includes(v) ? v : get();
    if (v === "system") d.removeAttribute("data-text-scale"); else d.setAttribute("data-text-scale", v);
    d.style.setProperty("--sys-text-scale", String(+sysScale().toFixed(3)));
  }
  function set(v) {
    if (!LIST.includes(v)) v = "system";
    try { if (v === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) {}
    apply(v);
  }
  apply(get());
  if (typeof window !== "undefined" && window.addEventListener) {
    const refresh = () => { if (get() === "system") apply("system"); };
    window.addEventListener("pageshow", refresh);
    window.addEventListener("resize", refresh);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }
  return { KEY, LIST, FACTOR, get, set, apply, sysScale };
})();
