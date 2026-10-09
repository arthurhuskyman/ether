// Пасхалки второй волны. Срабатывают и у отправителя, и у получателя: следим за новыми пузырями в открытом чате
// (текст сообщения содержит эмодзи/слово-триггер). Включаются тем же переключателем «Пасхалки» (FX "easter"),
// не мешают нажатиям (pointer-events: none) и отключаются при prefers-reduced-motion.
const EGG_SEEN = new Set();
function eggReduced() { try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; } }
function eggLayer() {
  let l = document.getElementById("egg-layer");
  if (!l) { l = document.createElement("div"); l.id = "egg-layer"; l.setAttribute("aria-hidden", "true"); document.body.appendChild(l); }
  return l;
}
const eggRnd = (a, b) => a + Math.random() * (b - a);
// Частицы-эмодзи: kind = rise | fall | run | pop | drift
function eggBurst({ chars, n = 18, kind = "rise", dur = 3.2, size = [22, 40], spread = 100, delay = 1.2 }) {
  const L = eggLayer(); const items = [];
  for (let i = 0; i < n; i++) {
    const el = document.createElement("span"); el.className = "egg-p egg-" + kind;
    el.textContent = chars[Math.floor(Math.random() * chars.length)];
    const st = el.style;
    st.setProperty("--x", eggRnd(2, spread - 2).toFixed(1) + "%");
    st.setProperty("--s", Math.round(eggRnd(size[0], size[1])) + "px");
    st.setProperty("--t", eggRnd(dur * 0.75, dur * 1.25).toFixed(2) + "s");
    st.setProperty("--d", eggRnd(0, delay).toFixed(2) + "s");
    st.setProperty("--dx", Math.round(eggRnd(-60, 60)) + "px");
    st.setProperty("--r", Math.round(eggRnd(-40, 40)) + "deg");
    st.setProperty("--y", eggRnd(55, 90).toFixed(0) + "%");
    L.appendChild(el); items.push(el);
  }
  setTimeout(() => items.forEach((e) => e.remove()), (dur * 1.25 + delay) * 1000 + 200);
}
function eggClass(el, cls, ms) { if (!el) return; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms); }
function eggFireworks() {
  const L = eggLayer(); const cols = ["#ff5a8a", "#ffd24a", "#5ac8ff", "#7dff9a", "#c08bff", "#ff9a4a"];
  for (let b = 0; b < 5; b++) {
    const cx = eggRnd(15, 85), cy = eggRnd(18, 50), col = cols[b % cols.length];
    for (let i = 0; i < 16; i++) {
      const d = document.createElement("i"); d.className = "egg-spark";
      const ang = (i / 16) * Math.PI * 2, dist = eggRnd(50, 90);
      d.style.cssText = `left:${cx}%;top:${cy}%;background:${col};--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px;animation-delay:${b * 0.35}s`;
      L.appendChild(d); setTimeout(() => d.remove(), 2600 + b * 350);
    }
  }
}
function eggRainbow() {
  const el = document.createElement("div"); el.className = "egg-rainbow"; eggLayer().appendChild(el); setTimeout(() => el.remove(), 3200);
}
function eggNight() {
  const el = document.createElement("div"); el.className = "egg-night"; el.innerHTML = '<span class="egg-moon">🌙</span>';
  eggLayer().appendChild(el); setTimeout(() => el.remove(), 4200);
  eggBurst({ chars: ["✨", "⭐", "💤"], n: 14, kind: "drift", dur: 3.6, size: [16, 28] });
}
function eggClink() {
  const el = document.createElement("div"); el.className = "egg-clink"; el.innerHTML = '<span class="g1">🥂</span><span class="g2">🥂</span><span class="sp">✨</span>';
  eggLayer().appendChild(el); setTimeout(() => el.remove(), 2400);
}
function eggWave() {
  const el = document.createElement("div"); el.className = "egg-wave"; el.textContent = "👋"; eggLayer().appendChild(el); setTimeout(() => el.remove(), 2600);
}

// 23 пасхалки (ракета 🚀 из первой волны теперь тоже у получателя). Триггеры не зависят от языка (эмодзи) + несколько слов.
const EGGS = [
  { id: "rocket",     re: /🚀/,                         run: () => { if (typeof fxRocket === "function") fxRocket(); } },
  { id: "hearts",     re: /[\u2764💕💖💗😍🥰💘]/u,           run: () => eggBurst({ chars: ["❤️", "💕", "💖", "💗"], n: 18, kind: "rise" }) },
  { id: "fire",       re: /🔥/,                         run: () => eggBurst({ chars: ["🔥", "✨", "🔥"], n: 16, kind: "rise", dur: 2.4, size: [20, 36] }) },
  { id: "snow",       re: /[\u2744\u26C4\u2603]/u,                    run: () => eggBurst({ chars: ["❄️", "❄️", "✦", "❅"], n: 26, kind: "fall", dur: 4.2, size: [16, 30] }) },
  { id: "rain",       re: /[\u{1F327}\u2614\u26C8]/u,                    run: () => eggBurst({ chars: ["💧", "💧", "💦"], n: 34, kind: "fall", dur: 1.6, size: [14, 24], delay: 1.6 }) },
  { id: "stars",      re: /[\u2728\u2B50🌟💫]/u,                  run: () => eggBurst({ chars: ["✨", "⭐", "🌟", "💫"], n: 22, kind: "pop", dur: 1.8, size: [18, 38] }) },
  { id: "balloons",   re: /🎈/,                         run: () => eggBurst({ chars: ["🎈", "🎈", "🎈"], n: 12, kind: "rise", dur: 4.2, size: [34, 52] }) },
  { id: "sakura",     re: /🌸/,                         run: () => eggBurst({ chars: ["🌸", "🌸", "💮"], n: 24, kind: "fall", dur: 5, size: [18, 32] }) },
  { id: "pizza",      re: /🍕/,                         run: () => eggBurst({ chars: ["🍕"], n: 1, kind: "run", dur: 2.6, size: [56, 56], delay: 0 }) },
  { id: "cat",        re: /[🐱🐈😺😸😻]/u,              run: () => eggBurst({ chars: ["🐈"], n: 1, kind: "run", dur: 3.2, size: [54, 54], delay: 0 }) },
  { id: "dog",        re: /[🐶🐕🐩]/u,                  run: () => eggBurst({ chars: ["🐕"], n: 1, kind: "run", dur: 2.8, size: [54, 54], delay: 0 }) },
  { id: "ghost",      re: /👻/,                         run: () => eggBurst({ chars: ["👻"], n: 5, kind: "drift", dur: 4, size: [40, 64] }) },
  { id: "butterflies",re: /🦋/,                         run: () => eggBurst({ chars: ["🦋"], n: 10, kind: "drift", dur: 4.4, size: [26, 44] }) },
  { id: "boom",       re: /[💣💥]/u,                    run: () => { eggClass(document.getElementById("app-shell"), "egg-shake", 650); eggBurst({ chars: ["💥"], n: 1, kind: "pop", dur: 1.2, size: [120, 120], delay: 0 }); } },
  { id: "rainbow",    re: /🌈/,                         run: eggRainbow },
  { id: "music",      re: /[🎵🎶🎸🎹🎷🎺🎻]/u,           run: () => eggBurst({ chars: ["🎵", "🎶", "🎼"], n: 14, kind: "rise", dur: 3.4 }) },
  { id: "cheers",     re: /[🍺🥂🍻🍷🍾]/u,              run: eggClink },
  { id: "poop",       re: /💩/,                         run: () => eggBurst({ chars: ["💩"], n: 1, kind: "fall", dur: 1.1, size: [64, 64], delay: 0 }) },
  { id: "robot",      re: /[🤖👾]/u,                    run: () => eggClass(document.getElementById("app-shell"), "egg-glitch", 1100) },
  { id: "night",      re: /[🌙😴🌛]|спокойной ночи|доброй ночи|good ?night/iu, run: eggNight },
  { id: "wave",       re: /👋/,                         run: eggWave },
  { id: "fireworks",  re: /[🎆🎇]|(^|[\s,!.])(ура+|hooray|yay)(?=[\s,!.?]|$)/iu, run: eggFireworks },
  { id: "disco",      re: /[🪩🕺💃]/u,                  run: () => eggClass(document.documentElement, "egg-disco", 4200) },
  { id: "confetti",   re: /[🎉🥳🎊]/u,                  run: () => { if (typeof fxConfetti === "function") fxConfetti(2600); } },
];
function eggScanBubble(row) {
  if (!row || typeof FX === "undefined" || !FX.get("easter") || eggReduced()) return;
  const inner = row.querySelector(".bubble"); if (!inner) return;
  const mid = inner.getAttribute("data-msg-id") || ""; if (mid && EGG_SEEN.has(mid)) return; if (mid) EGG_SEEN.add(mid);
  if (EGG_SEEN.size > 400) EGG_SEEN.clear();
  const clone = inner.cloneNode(true);
  clone.querySelectorAll(".bubble-time, .bubble-reactions, .bubble-reply, .bubble-forwarded, .bubble-sender, .bubble-translation, .link-preview, .link-preview-slot").forEach((e) => e.remove());
  const text = (clone.textContent || "").trim(); if (!text) return;
  let fired = 0;
  for (const egg of EGGS) {
    if (fired >= 2) break; // не больше двух эффектов на одно сообщение
    if (egg.re.test(text)) { try { egg.run(); fired++; } catch (e) {} }
  }
}
function wireEasterEggs2() {
  const wrap = document.getElementById("chat-messages"); if (!wrap || wrap.__eggObs || typeof MutationObserver === "undefined") return;
  const obs = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (!(n instanceof Element)) continue;
      if (n.matches && n.matches(".bubble-row.just-sent, .bubble-row.just-received")) eggScanBubble(n);
      else if (n.querySelectorAll) n.querySelectorAll(".bubble-row.just-sent, .bubble-row.just-received").forEach(eggScanBubble);
    }
  });
  obs.observe(wrap, { childList: true });
  wrap.__eggObs = obs;
  // секретная: семь быстрых касаний по названию приложения — диско
  const title = document.getElementById("nav-title");
  if (title && !title.__eggTaps) {
    title.__eggTaps = [];
    title.addEventListener("click", () => {
      const now = Date.now(); const t = title.__eggTaps.filter((x) => now - x < 2500); t.push(now); title.__eggTaps = t;
      if (t.length >= 7) { title.__eggTaps = []; if (typeof FX !== "undefined" && FX.get("easter")) eggClass(document.documentElement, "egg-disco", 4200); }
    });
  }
}
try { wireEasterEggs2(); } catch (e) {}
document.addEventListener("DOMContentLoaded", () => { try { wireEasterEggs2(); } catch (e) {} });
setTimeout(() => { try { wireEasterEggs2(); } catch (e) {} }, 800);
