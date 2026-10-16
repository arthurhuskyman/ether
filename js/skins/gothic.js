// Скин «gothic»: готические иконки (стрельчатые арки, гроб, кинжал, перо), церковные звуки, декор: туман, луна, кладбище, летучие мыши.
Skins.register("gothic", {
  icons: {
    chat: '<path d="M4 20V9l8-6 8 6v11z"/><path d="M8 12h8M8 15.5h5"/>',
    user: '<path d="M12 3c-4 0-6 3-6 6v12h12V9c0-3-2-6-6-6z"/><path d="M9 11c0 3 1.2 4.6 3 4.6s3-1.600 3-4.600c-1-.8-2-1.200-3-1.200s-2 .4-3 1.200z"/>',
    users: '<path d="M8 4c-3 0-4.500 2.200-4.500 4.500V20h9V8.500C12.500 6.200 11 4 8 4z"/><path d="M16 7c2.500 0 4 1.800 4 4v9h-5"/>',
    sliders: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.600 5.600l4.200 4.200M14.200 14.200l4.200 4.200M18.400 5.600l-4.200 4.200M9.800 14.200l-4.200 4.200"/>',
    code: '<path d="M8 5 2 12l6 7M16 5l6 7-6 7"/>',
    "chevron-right": '<path d="M8 3l9 9-9 9"/>',
    "chevron-left": '<path d="M16 3l-9 9 9 9"/>',
    "chevron-up": '<path d="M3 16l9-9 9 9"/>',
    "chevron-down": '<path d="M3 8l9 9 9-9"/>',
    x: '<path d="M5 5l14 14M19 5 5 19"/><path d="M3 7l4-4M17 3l4 4M3 17l4 4M17 21l4-4"/>',
    plus: '<path d="M12 3v18M3 12h18"/><path d="M9.500 3h5M9.500 21h5M3 9.500v5M21 9.500v5"/>',
    check: '<path d="M4 13l5 6L21 4"/><path d="M4 13l-1.500-2"/>',
    phone: '<path d="M4 6c0-2 1-3 3-3l2 5-2.500 1.500c1 2.500 3.500 5 6 6L14 13l5 2c0 2-1 3-3 3C9 18 4 12 4 6z"/>',
    video: '<path d="M2 12c3-5 7-7 10-7s7 2 10 7c-3 5-7 7-10 7S5 17 2 12z"/><circle cx="12" cy="12" r="3.500"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    search: '<circle cx="10" cy="10" r="6.500"/><path d="M15 15l6 6"/><path d="M7 8c.7-1.500 2-2.300 3.500-2.300"/>',
    pin: '<path d="M12 22V10"/><path d="M8 3h8l-1 7H9z"/><path d="M6 10h12"/>',
    reply: '<path d="M9 5 3 11l6 6"/><path d="M3 11h11c4 0 7 2.500 7 8"/>',
    forward: '<path d="M15 5l6 6-6 6"/><path d="M21 11H10c-4 0-7 2.500-7 8"/>',
    send: '<path d="M2 12 22 3l-5 9 5 9z"/><path d="M17 12H6"/>',
    mic: '<path d="M8 12V6c0-2.500 2-4 4-4s4 1.500 4 4v6c0 2.500-2 4-4 4s-4-1.500-4-4z"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6"/>',
    "mic-off": '<path d="M8 12V6c0-2.500 2-4 4-4s4 1.500 4 4v6c0 2.500-2 4-4 4s-4-1.500-4-4z"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3"/><path d="M3 3l18 18"/>',
    play: '<path d="M6 3l15 9-15 9z"/>',
    pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
    stop: '<path d="M5 5h14v14H5z"/>',
    lock: '<path d="M5 11h14v10H5zM8 11V7c0-2.500 1.800-4.500 4-4.500s4 2 4 4.500v4"/><path d="M12 14v4"/>',
    refresh: '<path d="M20 12a8 8 0 1 0-3 6.200"/><path d="M20 4v8h-8"/>',
    trash: '<path d="M9 2h6l4 6-3 14H8L5 8z"/><path d="M12 8v9M9.500 11h5"/>',
    edit: '<path d="M20 3c-6 1-11 6-13 13l-3 5 5-3c7-2 12-7 11-15z"/><path d="M7 16c3-2 6-5 9-9"/>',
    copy: '<path d="M8 8h12v13H8zM16 8V3H4v13h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 3"/><path d="M12 3v1.500M12 20.500V21M3 12h1.500M19.500 12H21"/>',
    star: '<path d="M12 1.500l2 8.500 8.500 2-8.500 2-2 8.500-2-8.500-8.500-2 8.500-2z"/>',
    bell: '<path d="M12 2v2M6 18c0-6 1-11 6-12 5 1 6 6 6 12l2 2H4z"/><path d="M10 21.500h4"/>',
    archive: '<path d="M7 3h10l4 6-3 12H6L3 9z"/><path d="M8 11h8"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.600 5.600l12.800 12.800"/>',
    warning: '<path d="M12 2 2 21h20z"/><path d="M12 9v6M12 17.500v1.500"/>',
    info: '<path d="M12 2c3 3 6 5 6 10a6 6 0 0 1-12 0c0-5 3-7 6-10z"/><path d="M12 11v5M12 8.500v.5"/>',
    volume: '<path d="M3 9v6h4l6 5V4L7 9z"/><path d="M16 9c1.500 1.500 1.500 4.500 0 6M19 6.500c3 3 3 8 0 11"/>',
    smile: '<path d="M12 3c-5 0-8 3-8 8 0 3 1 4.500 3 5.500V21h10v-4.500c2-1 3-2.500 3-5.500 0-5-3-8-8-8z"/><path d="M8 10.500h2.500M13.500 10.500H16M11 14.500h2M9.500 18v3M12 18v3M14.500 18v3"/>',
    paperclip: '<path d="M19 9l-8.500 8.500a4 4 0 0 1-6-5.500L13 3.500a2.700 2.700 0 0 1 4 3.800l-8 8"/>',
    camera: '<path d="M3 7h5l2-3h4l2 3h5v13H3z"/><path d="M12 9.500l3 3.500-3 3.500-3-3.500z"/>',
    file: '<path d="M6 2c-2 0-3 1-3 3h2v14c0 2 1 3 3 3h11V5c0-2-1-3-3-3z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    poll: '<path d="M3 21V11l3-3 3 3v10M10 21V7l3-4 3 4v14M17 21v-8l2-2.500 2 2.500v8"/>',
    board: '<path d="M2 21V9l3-4 3 4v12M9 21V6l3-4 3 4v15M16 21V9l3-4 3 4v12"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-4 3-4 15 0 18M12 3c4 3 4 15 0 18"/>',
    shield: '<path d="M12 2l8 3v7c0 5-4 8-8 10-4-2-8-5-8-10V5z"/><path d="M12 8v8M8.500 11.500h7"/>',
    link: '<path d="M10 14l4-4M8 17H6a4 4 0 0 1 0-8h3M16 7h2a4 4 0 0 1 0 8h-3"/>',
    download: '<path d="M12 3v14M5 11l7 8 7-8M4 22h16"/>',
    moon: '<path d="M19 15A8 8 0 0 1 9 4 8.500 8.500 0 1 0 19 15z"/><path d="M17 4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.300 0 2-.8 2-1.800 0-1-1-1.500-1-2.700 0-1 .8-1.800 1.800-1.800H17a4 4 0 0 0 4-4C21 6.400 17 3 12 3z"/><path d="M7.500 11h.01M10 7.500h.01M14.500 7.500h.01"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9 9.500c0-1.500 1.300-2.500 3-2.500s3 1 3 2.500c0 2-3 2-3 4.500M12 17v1.500"/>',
    database: '<path d="M4 6c0-2 4-3 8-3s8 1 8 3v12c0 2-4 3-8 3s-8-1-8-3z"/><path d="M4 6c0 2 4 3 8 3s8-1 8-3M4 12c0 2 4 3 8 3s8-1 8-3"/>'
  },
  sound: {
    // входящее: удар церковного колокола (основной тон + неточные обертоны, долгое затухание)
    in: [
      { f: 196, t: 0, d: 0.75, v: 0.13, w: "sine" },
      { f: 392 * 1.01, t: 0, d: 0.55, v: 0.06, w: "sine" },
      { f: 540, t: 0, d: 0.4, v: 0.04, w: "sine" },
      { f: 818, t: 0, d: 0.22, v: 0.025, w: "sine" },
      { w: "noise", t: 0, d: 0.03, v: 0.05, lp: 900 }
    ],
    // отправка: скрип двери и глухой стук
    out: [
      { f: [150, 95], t: 0, d: 0.2, v: 0.06, w: "sawtooth", lp: 420, q: 5 },
      { f: [80, 55], t: 0.17, d: 0.1, v: 0.12, w: "sine" }
    ],
    // нажатие: стук по дереву
    tap: [{ f: [110, 70], t: 0, d: 0.06, v: 0.07, w: "sine" }, { w: "noise", t: 0, d: 0.02, v: 0.03, lp: 700 }],
    // вкладка: двойной удар сердца
    tab: [{ f: [75, 55], t: 0, d: 0.1, v: 0.12, w: "sine" }, { f: [68, 50], t: 0.13, d: 0.12, v: 0.1, w: "sine" }],
    // реакция: далёкий хор «аах» (минорное трезвучие)
    react: [
      { f: 220, t: 0, d: 0.5, v: 0.03, w: "sawtooth", lp: 800 },
      { f: 261.6, t: 0, d: 0.5, v: 0.03, w: "sawtooth", lp: 800 },
      { f: 329.6, t: 0, d: 0.5, v: 0.025, w: "sawtooth", lp: 800 }
    ],
    // ошибка: низкий колокол и тритон
    error: [{ f: 110, t: 0, d: 0.6, v: 0.13, w: "sine" }, { f: 155.6, t: 0.02, d: 0.5, v: 0.08, w: "sine" }, { f: 330, t: 0.02, d: 0.3, v: 0.03, w: "sawtooth", lp: 500 }]
  },
  haptic: { tap: [16, 70, 22] },
  deco(layer, opts) {
    const calm = !!(opts && opts.calm);
    const mk = (cls, html) => { const d = document.createElement("div"); d.className = cls; if (html) d.innerHTML = html; layer.appendChild(d); return d; };
    mk("gt-moon");
    mk("gt-fog", ""); layer.lastChild.style.top = "42%";
    mk("gt-fog b", ""); layer.lastChild.style.top = "62%";
    const yard = '<svg class="gt-yard" viewBox="0 0 400 150" preserveAspectRatio="xMidYMax slice" fill="currentColor" aria-hidden="true">' +
      '<path d="M0 150V128h400v22z"/>' +
      '<path d="M18 128V104a8 8 0 0 1 16 0v24zM52 128v-20a9 9 0 0 1 18 0v20zM110 128v-16h4v-9h5v9h4v16zM330 128v-22a8 8 0 0 1 16 0v22zM366 128v-14h4v-10h4v10h4v14z"/>' +
      '<path d="M170 128V84l10-8V54l6-14 6 14v22l10 8v44zM214 128V96l8-6V70l5-12 5 12v20l8 6v32zM186 128v-12a6 6 0 0 1 12 0v12z"/>' +
      '<path d="M272 128c-1-20 2-34 8-48l-14-12 10 3-4-14 9 10 4-16 3 17 10-8-5 14 12 2-14 10c6 10 8 24 7 42z"/>' +
      '<path d="M130 128v-18l6-8 6 8v18zM296 128v-10h14v10z"/></svg>';
    layer.insertAdjacentHTML("beforeend", yard);
    if (calm) return () => { layer.innerHTML = ""; };
    // летучая мышь пролетает раз в ~20 с
    const bat = mk("gt-bat", '<svg viewBox="0 0 44 22" fill="currentColor"><path d="M22 7c1.500 0 2 1.500 2.500 3 2-2 5-3.500 9-3.500-1 1.500-1 3 0 4 3-1 6.500-.5 10.500 1.500-3 0-4.500 1.500-5 3.500-1.500-1.500-3.500-2-5.500-1-1 1.500-3 2.500-5 2.500l-1.500 3.500-1.500-3.500c-2 0-4-1-5-2.500-2-1-4 -.5-5.500 1C5 14.500 3.500 13 .5 13 4.500 11 8 10.500 11 11.500c1-1 1-2.500 0-4 4 0 7 1.500 9 3.500.5-1.500 1-4 2-4z"/></svg>');
    let timer = 0, alive = true;
    const fly = () => {
      if (!alive) return;
      bat.style.top = (14 + Math.random() * 40) + "%";
      bat.classList.remove("fly"); void bat.offsetWidth; bat.classList.add("fly");
      timer = setTimeout(fly, 16000 + Math.random() * 8000);
    };
    timer = setTimeout(fly, 4000);
    return () => { alive = false; clearTimeout(timer); layer.innerHTML = ""; };
  }
});
