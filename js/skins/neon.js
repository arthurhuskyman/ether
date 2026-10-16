// Скин «neon»: угловатые «проволочные» иконки, синтвейв-звуки, декор (закат, сетка-пол, скан-луч). Регистрируется в Skins (js/skins.js).
Skins.register("neon", {
  icons: {
    chat: '<path d="M3 4h18v12H11l-5 4v-4H3z"/><path d="M7 9h10M7 12h6"/>',
    user: '<path d="M8 4h8v7H8z"/><path d="M4 21v-4l3-3h10l3 3v4"/>',
    users: '<path d="M6 5h6v6H6z"/><path d="M2 20v-3l2-2h8l2 2v3"/><path d="M15 5h4v6h-4M17 15h3l2 2v3"/>',
    sliders: '<path d="M3 6h18M3 12h18M3 18h18"/><path d="M8 3v6M15 9v6M10 15v6" stroke-width="2.4"/>',
    code: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6M13 4l-2 16"/>',
    "chevron-right": '<path d="m8 4 8 8-8 8"/>',
    "chevron-left": '<path d="m16 4-8 8 8 8"/>',
    "chevron-up": '<path d="m4 16 8-8 8 8"/>',
    "chevron-down": '<path d="m4 8 8 8 8-8"/>',
    x: '<path d="M4 4l16 16M20 4 4 20"/>',
    plus: '<path d="M12 3v18M3 12h18"/><path d="M9 3h6M9 21h6M3 9v6M21 9v6" stroke-width="1"/>',
    check: '<path d="M3 13l6 6L21 6"/>',
    phone: '<path d="M4 3h5l2 6-3 2a12 12 0 0 0 5 5l2-3 6 2v5h-3A16 16 0 0 1 3 6z"/>',
    video: '<path d="M2 6h14v12H2zM16 10l6-3v10l-6-3"/>',
    search: '<path d="M4 4h12v12H4z"/><path d="M16 16l5 5" stroke-width="2.4"/>',
    pin: '<path d="M8 3h8l-1 7 4 4H5l4-4zM12 14v8"/>',
    reply: '<path d="M10 4 3 11l7 7M3 11h11l7 4v5"/>',
    forward: '<path d="m14 4 7 7-7 7M21 11H10l-7 4v5"/>',
    send: '<path d="M2 12 22 2 16 22l-5-8z"/><path d="M11 14 22 2"/>',
    mic: '<path d="M8 2h8v13H8z"/><path d="M4 11v4l4 4h8l4-4v-4M12 19v3"/>',
    "mic-off": '<path d="M8 2h8v10l-8 3z"/><path d="M3 3l18 18M4 11v4l4 4h6M12 19v3"/>',
    play: '<path d="M6 3v18l15-9z"/>',
    pause: '<path d="M5 4h5v16H5zM14 4h5v16h-5z"/>',
    stop: '<path d="M5 5h14v14H5z"/>',
    lock: '<path d="M4 10h16v11H4zM8 10V4h8v6"/><path d="M12 14v3"/>',
    refresh: '<path d="M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5"/><path d="M20 3v5h-5M4 21v-5h5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    edit: '<path d="M3 21v-5L16 3l5 5L8 21zM13 6l5 5"/>',
    copy: '<path d="M8 8h13v13H8z"/><path d="M16 8V3H3v13h5"/>',
    clock: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 7v5l4 2"/>',
    star: '<path d="m12 2 3 7h7l-5.5 4.5 2 8L12 17l-6.5 4.5 2-8L2 9h7z"/>',
    bell: '<path d="M6 17V9l3-5h6l3 5v8l2 2H4z"/><path d="M10 22h4"/>',
    archive: '<path d="M2 4h20v5H2zM4 9v12h16V9M9 13h6"/>',
    ban: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M5 5l14 14"/>',
    warning: '<path d="M12 2 2 21h20z"/><path d="M12 9v6M12 17.5v2" stroke-width="2"/>',
    info: '<path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z"/><path d="M12 11v6M12 7v2" stroke-width="2"/>',
    volume: '<path d="M3 9v6h4l6 5V4L7 9zM17 8l3 4-3 4"/>',
    monitor: '<path d="M2 4h20v13H2zM8 21h8M12 17v4"/>',
    more: '<rect x="3" y="10" width="4" height="4"/><rect x="10" y="10" width="4" height="4"/><rect x="17" y="10" width="4" height="4"/>',
    smile: '<path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z"/><path d="M8 14l2 2h4l2-2M8 9h2M14 9h2"/>',
    paperclip: '<path d="M19 9l-9 9a4 4 0 0 1-6-6l9-9 4 4-8 8-2-2 6-6"/>',
    camera: '<path d="M2 7h5l2-3h6l2 3h5v13H2z"/><path d="M8 13l2-3h4l2 3-2 3h-4z"/>',
    file: '<path d="M5 2h9l5 5v15H5z"/><path d="M14 2v5h5M8 12h8M8 16h5"/>',
    poll: '<path d="M4 21V12h4v9M10 21V4h4v17M16 21v-6h4v6"/>',
    board: '<path d="M2 3h6v18H2zM9 3h6v11H9zM16 3h6v14h-6z"/>',
    globe: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 12h18M12 2v20"/>',
    shield: '<path d="M12 2 3 5v7l9 10 9-10V5z"/><path d="M8 11l3 3 5-6"/>',
    link: '<path d="M9 15l6-6M7 11 4 14l5 5 3-3M17 13l3-3-5-5-3 3"/>',
    download: '<path d="M12 3v13M6 11l6 6 6-6M3 21h18"/>',
    sparkle: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4"/>',
    moon: '<path d="M20 15A9 9 0 0 1 9 3 9 9 0 1 0 20 15z"/>'
  },
  sound: {
    // входящее: пилообразное арпеджио вверх с «лазерным» хвостом
    in: [
      { f: 330, t: 0, d: 0.1, v: 0.07, w: "sawtooth", lp: 2400 },
      { f: 440, t: 0.08, d: 0.1, v: 0.07, w: "sawtooth", lp: 2800 },
      { f: 660, t: 0.16, d: 0.1, v: 0.07, w: "sawtooth", lp: 3400 },
      { f: [1320, 440], t: 0.26, d: 0.22, v: 0.06, w: "square", lp: 2600 }
    ],
    // отправка: лазерный «зап» вниз
    out: [
      { f: [1800, 240], t: 0, d: 0.13, v: 0.08, w: "sawtooth", lp: 4200 },
      { f: 880, t: 0.1, d: 0.05, v: 0.05, w: "square", lp: 2000 }
    ],
    tap: [{ f: 1900, t: 0, d: 0.035, v: 0.035, w: "square", lp: 3500 }],
    tab: [
      { f: 660, t: 0, d: 0.045, v: 0.045, w: "square", lp: 3000 },
      { f: [990, 1480], t: 0.05, d: 0.06, v: 0.04, w: "square", lp: 3500 }
    ],
    react: [{ f: 1200, t: 0, d: 0.05, v: 0.05, w: "square" }, { f: 1800, t: 0.05, d: 0.08, v: 0.05, w: "square" }],
    error: [{ f: [300, 90], t: 0, d: 0.22, v: 0.1, w: "sawtooth", lp: 1200 }, { f: 120, t: 0.04, d: 0.2, v: 0.06, w: "square", lp: 600 }]
  },
  haptic: { tap: [6] },
  deco(layer, opts) {
    const calm = !!(opts && opts.calm);
    const mk = (cls, inner) => { const d = document.createElement("div"); d.className = cls; if (inner) d.innerHTML = inner; layer.appendChild(d); return d; };
    mk("nx-sun");
    mk("nx-floor", "<i></i>");
    mk("nx-hz");
    if (!calm) mk("nx-beam");
    return () => { layer.innerHTML = ""; };
  }
});
