// Чистая математика контраста WCAG 2.x для tools/skin-contrast.js (и теста tests/skin-contrast.test.js).
// Работает и в Node (module.exports), и внутри страницы (tools/skin-contrast.js вставляет этот файл целиком).
(function (root) {
  // CSS-цвет вида rgb()/rgba()/color(srgb ...) -> [r,g,b,a] (0..255, a 0..1) или null
  function parseColor(s) {
    if (typeof s !== "string") return null;
    s = s.trim().toLowerCase();
    if (s === "transparent") return [0, 0, 0, 0];
    let m = s.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
      let h = m[1]; if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
      if (h.length !== 6 && h.length !== 8) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean);
      const n = (v) => (v.endsWith("%") ? parseFloat(v) * 2.55 : parseFloat(v));
      if (p.length < 3) return null;
      const a = p.length > 3 ? (p[3].endsWith("%") ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1;
      const out = [n(p[0]), n(p[1]), n(p[2]), a];
      return out.some((v) => !isFinite(v)) ? null : out;
    }
    m = s.match(/^color\(srgb\s+([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s\/]+/).filter(Boolean).map(parseFloat);
      if (p.length < 3 || p.some((v) => !isFinite(v))) return null;
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    return null;
  }
  // f поверх b (b непрозрачный или нет): результат [r,g,b,a]
  function over(f, b) {
    const a = f[3] + b[3] * (1 - f[3]);
    if (a <= 0) return [0, 0, 0, 0];
    const ch = (i) => (f[i] * f[3] + b[i] * b[3] * (1 - f[3])) / a;
    return [ch(0), ch(1), ch(2), a];
  }
  function lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function luminance(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function ratio(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  // Градиент -> один средний цвет (по альфа-взвешенному среднему стопов)
  function meanColor(cols) {
    cols = cols.filter(Boolean); if (!cols.length) return null;
    let a = 0, r = 0, g = 0, b = 0;
    for (const c of cols) { a += c[3]; r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; }
    if (a <= 0) return [0, 0, 0, 0];
    return [r / a, g / a, b / a, a / cols.length];
  }
  // layers: от самого верхнего (ближайший к тексту) к нижнему; слой = [r,g,b,a] (градиент уже свёрнут meanColor).
  // base — подложка страницы. Возвращает итоговый непрозрачный цвет фона.
  function composite(layers, base) {
    let acc = base || [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; if (l && l[3] > 0) acc = over(l, acc); }
    return [acc[0], acc[1], acc[2], 1];
  }
  // Контраст текста fg (с альфой) на фоне bg (непрозрачный); opacity — суммарная прозрачность предков
  function textRatio(fg, bg, opacity) {
    const f = [fg[0], fg[1], fg[2], fg[3] * (opacity == null ? 1 : opacity)];
    const eff = over(f, [bg[0], bg[1], bg[2], 1]);
    return ratio(eff, bg);
  }
  // Крупный текст (WCAG): >= 24px или >= 18.66px при жирности >= 700
  function isLarge(px, weight) { return px >= 24 || (px >= 18.66 && weight >= 700); }
  const api = { parseColor, over, luminance, ratio, meanColor, composite, textRatio, isLarge };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SkinContrast = api;
})(typeof window !== "undefined" ? window : globalThis);
