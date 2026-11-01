// =====================================================================
// V.81: «Вау-слой» скинов (SkinFX). У каждого из 32 скинов две удивляющие детали:
//   1) салют отправки — частицы в духе скина вылетают из кнопки «Отправить» (лепестки, монеты, POW!, нули-единицы…);
//   2) камео — редкая неожиданная сценка: попугай пролетает, кит проплывает, пингвин скользит, призрак выглядывает,
//      экран «глитчит», мелок рисует рожицу, терминал печатает строку…
// Камео показывается при выборе скина, на каждое 15-е отправленное сообщение и при возвращении в приложение после 10+ минут.
// Всё декоративное: aria-hidden, pointer-events: none, только transform/opacity. Выключается тумблером FX «skinwow»,
// «спокойным режимом» и prefers-reduced-motion. Никаких сетевых запросов и внешних картинок — только эмодзи, текст и SVG.
// =====================================================================
const SkinFX = (() => {
  // b — салют: g глифы, m режим (spray | fall | rise | pop), c цвета (необязательно), n число частиц
  // k — камео: g глиф или текст, m режим (fly | walk | swim | peek | rise | streak | zoom | swing | leap | march | gust |
  //      shake | glitch | shine | doodle | type | stack), p — путь SVG для doodle, c — цвет
  const WOW = {
    default: { b: { g: ["✨", "✦", "·"], m: "spray", c: ["#8a6dff", "#ffd166", "#5ad1ff"] }, k: { g: "🕊️", m: "fly" } },
    glass: { b: { g: ["◯", "○", "◦"], m: "rise", c: ["#a9c8ff", "#ffffff", "#7fb0ff"] }, k: { m: "shine", c: "rgba(255,255,255,.55)" } },
    neon: { b: { g: ["⚡", "▮", "▯", "✦"], m: "spray", c: ["#00e5f5", "#ff2bd6", "#faff00"] }, k: { m: "glitch" } },
    clay: { b: { g: ["●", "●", "◕"], m: "pop", c: ["#ff9f80", "#ffd29d", "#8fd3c1"] }, k: { g: "🧸", m: "peek" } },
    sakura: { b: { g: ["🌸", "🌸", "💮"], m: "spray" }, k: { g: "🌸", m: "gust" } },
    cartoon: { b: { g: ["⭐", "💨", "✨"], m: "spray" }, k: { g: "🎈", m: "rise" } },
    comic: { b: { g: ["POW!", "ZAP!", "BAM!", "WHAM!"], m: "pop", c: ["#c01830", "#1757b8", "#111"] }, k: { g: "💥", m: "shake" } },
    watercolor: { b: { g: ["●", "●", "●"], m: "spray", c: ["#b79cff", "#ff9ccf", "#8fe6ff", "#ffd27a"] }, k: { m: "doodle", p: "M20 70 C 40 20, 80 20, 100 60 S 160 100, 180 40", c: "#b79cff" } },
    steampunk: { b: { g: ["⚙", "⚙", "✺"], m: "spray", c: ["#e0a066", "#b87333", "#ffd29d"] }, k: { g: "⚙️", m: "walk" } },
    gothic: { b: { g: ["🥀", "✝", "🕯️"], m: "fall" }, k: { g: "🦇", m: "gust" } },
    lego: { b: { g: ["🧱", "🟥", "🟨", "🟦"], m: "fall" }, k: { g: "🧱", m: "stack" } },
    wood: { b: { g: ["🍂", "🍁", "🌰"], m: "fall" }, k: { g: "🐿️", m: "walk" } },
    chalk: { b: { g: ["·", "•", "✎"], m: "spray", c: ["#ffffff", "#ffd86b", "#9fe0ff"] }, k: { m: "doodle", p: "M100 20 a40 40 0 1 0 0.1 0 M84 52 v6 M116 52 v6 M78 76 q22 22 44 0" } },
    newyear: { b: { g: ["❄", "🎁", "✨", "❅"], m: "spray" }, k: { g: "🦌🛷", m: "fly" } },
    vampire: { b: { g: ["🩸", "🩸", "🦇"], m: "fall" }, k: { g: "🦇", m: "zoom" } },
    hacker: { b: { g: ["0", "1", "1", "0", "{", "}"], m: "rise", c: ["#39ff7a", "#a6ffcb"] }, k: { g: "> access granted_", m: "type", c: "#39ff7a" } },
    pixel: { b: { g: ["■", "■", "▪"], m: "spray", c: ["#ffd23f", "#ff5a8a", "#4fe3c1", "#9b7bff"] }, k: { g: "👾", m: "march" } },
    vaporwave: { b: { g: ["◇", "✦", "△"], m: "spray", c: ["#ff71ce", "#01cdfe", "#b967ff", "#fffb96"] }, k: { g: "🐬", m: "leap" } },
    ocean: { b: { g: ["○", "◦", "○"], m: "rise", c: ["#8fe6ff", "#4fd8ff", "#ffffff"] }, k: { g: "🐋", m: "swim" } },
    galaxy: { b: { g: ["✦", "✧", "⋆", "✶"], m: "spray", c: ["#ffffff", "#d9ccff", "#ffd6f0"] }, k: { g: "🌠", m: "streak" } },
    western: { b: { g: ["💨", "⭐", "🌵"], m: "spray" }, k: { g: "🐎", m: "walk" } },
    sumie: { b: { g: ["●", "●", "•"], m: "spray", c: ["#111", "#333", "#b3202a"] }, k: { m: "doodle", p: "M100 18 C 150 20, 172 60, 160 92 C 146 128, 70 132, 46 100 C 26 72, 44 30, 92 22" } },
    artdeco: { b: { g: ["✦", "◆", "✧"], m: "spray", c: ["#e6c05a", "#fff1b8", "#b8892b"] }, k: { m: "shine", c: "rgba(230,192,90,.5)" } },
    kawaii: { b: { g: ["💖", "💗", "🍬", "⭐"], m: "pop" }, k: { g: "🦄", m: "leap" } },
    pirate: { b: { g: ["🪙", "🪙", "💰"], m: "fall" }, k: { g: "🦜", m: "fly" } },
    medieval: { b: { g: ["✦", "🛡️", "✧"], m: "spray", c: ["#ffb24a", "#d9b45a"] }, k: { g: "🐉", m: "fly" } },
    jungle: { b: { g: ["🍃", "🌿", "🍀"], m: "spray" }, k: { g: "🐒", m: "swing" } },
    arctic: { b: { g: ["❄", "❅", "❆"], m: "spray", c: ["#ffffff", "#bfeaff", "#8fe0ff"] }, k: { g: "🐧", m: "walk" } },
    halloween: { b: { g: ["🎃", "🦇", "🍬"], m: "spray" }, k: { g: "👻", m: "peek" } },
    retro: { b: { g: ["♪", "♫", "✿"], m: "rise", c: ["#f2a33a", "#4fc0ad", "#ffd27a"] }, k: { g: "🪩", m: "swing" } },
    newspaper: { b: { g: ["✱", "¶", "§"], m: "spray", c: ["#151515", "#8a1c1c"] }, k: { g: "🗞️", m: "zoom" } },
    blueprint: { b: { g: ["+", "⊕", "◌"], m: "spray", c: ["#9fdcff", "#ffffff"] }, k: { m: "doodle", p: "M20 100 H180 M20 92 V108 M180 92 V108 M60 100 V40 H140 V100 M60 40 L100 14 L140 40" } },
  };
  const IDS = Object.keys(WOW);
  const CAMEO_EVERY = 15, AWAY_MS = 10 * 60 * 1000;
  let sendCount = 0, hiddenAt = 0, busy = false;

  const skin = () => (typeof Skins !== "undefined" ? Skins.get() : "default");
  const reduced = () => { try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; } };
  function enabled() {
    if (typeof document === "undefined" || !document.body || reduced()) return false;
    try { if (typeof Store !== "undefined" && Store.calmMode) return false; } catch (e) {}
    try { if (typeof FX !== "undefined" && FX.get("skinwow") === false) return false; } catch (e) {}
    return true;
  }
  function layer() {
    let l = document.getElementById("skin-wow");
    if (!l) { l = document.createElement("div"); l.id = "skin-wow"; l.setAttribute("aria-hidden", "true"); document.body.appendChild(l); }
    return l;
  }
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function spawn(cls, text, css, ms) {
    const e = document.createElement("i"); e.className = cls; if (text) e.textContent = text;
    e.style.cssText = css; layer().appendChild(e);
    setTimeout(() => { try { e.remove(); } catch (x) {} }, ms);
    return e;
  }

  // ---------- салют отправки ----------
  function burst(id, origin) {
    const w = WOW[id] || WOW.default, b = w.b;
    let x = window.innerWidth - 40, y = window.innerHeight - 40;
    const btn = origin || document.querySelector("#chat-form .send-btn:not(.hidden)") || document.querySelector("#chat-form");
    if (btn && btn.getBoundingClientRect) { const r = btn.getBoundingClientRect(); if (r.width) { x = r.left + r.width / 2; y = r.top + r.height / 2; } }
    if (b.m === "pop") {
      const word = pick(b.g), big = word.length > 2;
      spawn("skfx-pop" + (big ? " skfx-word" : ""), word, `left:${x}px;top:${y}px;--rot:${rnd(-14, 14).toFixed(0)}deg;` + (b.c ? `color:${pick(b.c)};` : ""), 900);
      if (big) return;
    }
    const n = b.n || 12;
    for (let i = 0; i < n; i++) {
      const ang = b.m === "rise" ? rnd(-120, -60) : b.m === "fall" ? rnd(-150, -30) : rnd(-170, -10);
      const dist = rnd(50, 140), rad = ang * Math.PI / 180;
      // «fall»: подбрасываем вверх по дуге и роняем чуть ниже кнопки (иначе у нижнего края частицы сразу уходят за экран)
      const fall = b.m === "fall";
      const dx = Math.cos(rad) * dist * (fall ? 1.3 : 1), dy = fall ? rnd(10, 60) : Math.sin(rad) * dist + (b.m === "rise" ? -rnd(40, 120) : 0);
      const my = fall ? -rnd(110, 220) : dy / 2;
      spawn("skfx-p" + (fall ? " skfx-arc" : ""), pick(b.g), `left:${x}px;top:${y}px;--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px;--my:${my.toFixed(0)}px;--r:${rnd(-200, 200).toFixed(0)}deg;--s:${rnd(0.7, 1.3).toFixed(2)};--d:${rnd(650, 1100).toFixed(0)}ms;` + (b.c ? `color:${pick(b.c)};` : ""), 1200);
    }
  }

  // ---------- камео ----------
  function cameo(id, force) {
    if (busy && !force) return false; // одна сценка за раз (force — для предпросмотра и тестов)
    const k = (WOW[id] || WOW.default).k;
    busy = true; setTimeout(() => { busy = false; }, 3600);
    const root = document.documentElement;
    const cls = (c, ms) => { root.classList.add(c); setTimeout(() => root.classList.remove(c), ms); };
    switch (k.m) {
      case "glitch": cls("skfx-glitch", 900); break;
      case "shake": cls("skfx-shake", 600); spawn("skfx-pop skfx-center", k.g, "left:50%;top:42%;font-size:72px;", 900); break;
      case "shine": spawn("skfx-shine", "", `--c:${k.c};`, 1500); break;
      case "type": {
        const e = spawn("skfx-type", "", `color:${k.c || "currentColor"};`, 3400);
        let i = 0; const t = setInterval(() => { i++; e.textContent = k.g.slice(0, i); if (i >= k.g.length) clearInterval(t); }, 70);
        break;
      }
      case "doodle": {
        const e = spawn("skfx-doodle", "", "", 3200);
        const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), path = document.createElementNS(ns, "path");
        svg.setAttribute("viewBox", "0 0 200 140"); path.setAttribute("d", k.p); path.setAttribute("fill", "none"); path.style.stroke = k.c || "var(--accent, currentColor)"; // цвет акцента скина: виден и в светлой, и в тёмной схеме
        path.setAttribute("stroke-width", "5"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round"); path.setAttribute("pathLength", "1");
        svg.appendChild(path); e.appendChild(svg); break;
      }
      case "gust": for (let i = 0; i < 18; i++) spawn("skfx-k skfx-gust", k.g, `top:${rnd(5, 85).toFixed(0)}vh;--d:${rnd(1600, 2600).toFixed(0)}ms;--dl:${rnd(0, 700).toFixed(0)}ms;--s:${rnd(0.6, 1.3).toFixed(2)};`, 3400); break;
      case "stack": for (let i = 0; i < 5; i++) spawn("skfx-k skfx-stack", k.g, `--i:${i};--dl:${i * 180}ms;`, 3200); break;
      default: spawn("skfx-k skfx-" + k.m, k.g, `top:${rnd(18, 60).toFixed(0)}vh;`, 3600);
    }
    return true;
  }

  function onSend() {
    try {
      if (!enabled()) return;
      const id = skin();
      burst(id);
      if (++sendCount % CAMEO_EVERY === 0) setTimeout(() => cameo(id), 500);
    } catch (e) {}
  }
  function onSkinChosen(id) { try { if (enabled()) setTimeout(() => cameo(id || skin()), 450); } catch (e) {} }
  function onVisibility() {
    try {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt >= AWAY_MS && enabled()) setTimeout(() => cameo(skin()), 1200);
      hiddenAt = 0;
    } catch (e) {}
  }
  let wired = false;
  function wire() {
    if (wired || typeof document === "undefined") return;
    wired = true;
    document.addEventListener("visibilitychange", onVisibility);
  }
  return { WOW, IDS, onSend, onSkinChosen, burst, cameo, enabled, wire };
})();
