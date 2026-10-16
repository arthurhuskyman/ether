// Скин «lego»: угловатые иконки «из кубиков», пластиковые щелчки и 8-бит мелодии, плывущие кирпичики на фоне.
Skins.register("lego", {
  // прямые углы, квадратные концы штриха (ширина/join задаются в css/skins/lego.css)
  icons: {
    chat: '<path d="M3 4h18v12h-8l-4 4v-4H3z"/>',
    user: '<rect x="8" y="3" width="8" height="8"/><path d="M4 21v-6h16v6z"/>',
    users: '<rect x="3" y="4" width="7" height="7"/><path d="M2 20v-5h9v5zM15 4h6v6h-6zM14 20v-5h8v5z"/>',
    sliders: '<path d="M3 6h18M3 12h18M3 18h18"/><rect x="6" y="3.5" width="4" height="5" fill="currentColor"/><rect x="14" y="9.5" width="4" height="5" fill="currentColor"/><rect x="8" y="15.5" width="4" height="5" fill="currentColor"/>',
    code: '<path d="M8 6 3 12l5 6M16 6l5 6-5 6"/>',
    "chevron-right": '<path d="M8 4l8 8-8 8"/>',
    "chevron-left": '<path d="M16 4l-8 8 8 8"/>',
    "chevron-up": '<path d="M4 16l8-8 8 8"/>',
    "chevron-down": '<path d="M4 8l8 8 8-8"/>',
    x: '<path d="M5 5l14 14M19 5 5 19"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    check: '<path d="M4 13l5 5L20 6"/>',
    phone: '<path d="M3 3h6l2 5-3 2c1 2.200 3.800 5 6 6l2-3 5 2v6h-2C10 22 2 14 2 5V3z"/>',
    video: '<rect x="2" y="6" width="14" height="12"/><path d="M16 10l6-3v10l-6-3z"/>',
    search: '<rect x="4" y="4" width="11" height="11"/><path d="M15 15l6 6"/>',
    pin: '<path d="M8 3h8v6l3 4H5l3-4zM12 13v8"/>',
    reply: '<path d="M10 5 3 11l7 6M3 11h10a7 7 0 0 1 7 7v1"/>',
    forward: '<path d="m14 5 7 6-7 6M21 11H11a7 7 0 0 0-7 7v1"/>',
    send: '<path d="M3 3l18 9-18 9 3-9zM6 12h8"/>',
    mic: '<rect x="9" y="3" width="6" height="11"/><path d="M5 11v4h14v-4M12 17v4M8 21h8"/>',
    "mic-off": '<rect x="9" y="3" width="6" height="11"/><path d="M5 11v4h14v-4M12 17v4M8 21h8M3 3l18 18"/>',
    play: '<path d="M6 3v18l15-9z"/>',
    pause: '<rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/>',
    stop: '<rect x="5" y="5" width="14" height="14"/>',
    lock: '<rect x="4" y="10" width="16" height="11"/><path d="M8 10V6h8v4M12 14v3"/>',
    refresh: '<path d="M19 12a7 7 0 1 0-2 5M20 4v7h-7"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    edit: '<path d="M4 20h5L20 9l-5-5L4 15zM14 6l4 4"/>',
    copy: '<rect x="8" y="8" width="13" height="13"/><path d="M4 16V4h12"/>',
    clock: '<rect x="3" y="3" width="18" height="18"/><path d="M12 7v5h4"/>',
    star: '<path d="M12 2l3 7h7l-5.500 4.500L18.500 21 12 16.500 5.500 21l2-7.500L2 9h7z"/>',
    bell: '<path d="M6 17V9l2-4h8l2 4v8l2 2H4zM10 21h4"/>',
    info: '<rect x="3" y="3" width="18" height="18"/><path d="M12 11v6M12 7v1.500"/>',
    warning: '<path d="M12 3 2 20h20zM12 9v6M12 17v2"/>',
    smile: '<rect x="3" y="3" width="18" height="18"/><path d="M8 8v3M16 8v3M7 15h2v2h6v-2h2"/>',
    paperclip: '<path d="M18 11l-7 7a4 4 0 0 1-6-6l8-8a3 3 0 0 1 4 4l-8 8a1.500 1.500 0 0 1-2-2l6-6"/>',
    camera: '<path d="M3 7h5l2-3h4l2 3h5v13H3z"/><rect x="9" y="10" width="6" height="6"/>',
    file: '<path d="M5 3h9l5 5v13H5zM14 3v5h5"/>',
    poll: '<rect x="3" y="12" width="5" height="8" fill="currentColor"/><rect x="9.500" y="4" width="5" height="16" fill="currentColor"/><rect x="16" y="9" width="5" height="11" fill="currentColor"/>',
    board: '<rect x="3" y="4" width="5" height="16"/><rect x="9.500" y="4" width="5" height="9"/><rect x="16" y="4" width="5" height="12"/>',
    volume: '<path d="M3 9v6h4l5 4V5L7 9zM16 8v8M19 6v12"/>',
    globe: '<rect x="3" y="3" width="18" height="18"/><path d="M3 12h18M12 3v18M8 3v18M16 3v18"/>',
    shield: '<path d="M4 3h16v9l-8 9-8-9zM8 11l3 3 5-5"/>',
    moon: '<path d="M18 15A8 8 0 0 1 9 5a8 8 0 1 0 9 10z"/>',
    sparkle: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>',
    link: '<rect x="2" y="9" width="9" height="6"/><rect x="13" y="9" width="9" height="6"/>',
    download: '<path d="M12 3v12M6 10l6 6 6-6M4 21h16"/>',
    palette: '<path d="M3 3h18v14h-7v4H3z"/><path d="M7 8h2M12 7h2M16 9h2"/>',
    help: '<rect x="3" y="3" width="18" height="18"/><path d="M9 9h6v3l-3 2M12 17v1.500"/>',
    more: '<rect x="3" y="10" width="4" height="4"/><rect x="10" y="10" width="4" height="4"/><rect x="17" y="10" width="4" height="4"/>',
    grip: '<rect x="7" y="4" width="3" height="3"/><rect x="14" y="4" width="3" height="3"/><rect x="7" y="10.500" width="3" height="3"/><rect x="14" y="10.500" width="3" height="3"/><rect x="7" y="17" width="3" height="3"/><rect x="14" y="17" width="3" height="3"/>'
  },
  // пластиковые щелчки (square/noise) и 8-бит мелодия на входящее
  sound: {
    in: [{ f: 523, t: 0, d: 0.09, v: 0.1, w: "square", lp: 3200 }, { f: 659, t: 0.09, d: 0.09, v: 0.1, w: "square", lp: 3200 }, { f: 784, t: 0.18, d: 0.09, v: 0.1, w: "square", lp: 3200 }, { f: 1047, t: 0.27, d: 0.16, v: 0.11, w: "square", lp: 3200 }, { w: "noise", f: 1, t: 0, d: 0.015, v: 0.05, hp: 3000 }],
    out: [{ w: "noise", f: 1, t: 0, d: 0.02, v: 0.14, hp: 2500 }, { f: [1200, 700], t: 0, d: 0.04, v: 0.1, w: "square", lp: 3500 }, { f: 1568, t: 0.05, d: 0.06, v: 0.08, w: "square", lp: 3500 }],
    tap: [{ w: "noise", f: 1, t: 0, d: 0.012, v: 0.07, hp: 3500 }, { f: [2000, 1400], t: 0, d: 0.018, v: 0.04, w: "square", lp: 4000 }],
    tab: [{ w: "noise", f: 1, t: 0, d: 0.015, v: 0.09, hp: 2200 }, { f: [900, 500], t: 0, d: 0.05, v: 0.07, w: "square", lp: 2600 }, { f: [1500, 1200], t: 0.045, d: 0.03, v: 0.05, w: "square", lp: 3500 }],
    react: [{ f: 988, t: 0, d: 0.06, v: 0.09, w: "square", lp: 3200 }, { f: 1319, t: 0.06, d: 0.1, v: 0.09, w: "square", lp: 3200 }],
    error: [{ f: 330, t: 0, d: 0.12, v: 0.12, w: "square", lp: 1800 }, { f: 220, t: 0.12, d: 0.2, v: 0.12, w: "square", lp: 1500 }]
  },
  haptic: { tap: [6] },
  // кирпичики, плавающие за интерфейсом
  deco(layer, opts) {
    const dark = opts && opts.scheme === "dark";
    const cols = dark ? ["#c91a09", "#0055bf", "#f5cd2a", "#237841"] : ["#d01012", "#0055bf", "#f5cd2a", "#237841", "#ff8a00"];
    const spots = [[4, 6, 2], [80, 3, 1], [88, 30, 2], [-2, 40, 1], [6, 70, 2], [76, 62, 1], [48, 90, 2], [30, 24, 1]];
    spots.forEach((s, i) => {
      const b = document.createElement("div"); b.className = "lego-brick";
      const w = 40 + s[2] * 32;
      b.style.cssText = `left:${s[0]}%;top:${s[1]}%;--w:${w}px;--h:${30}px;--c:${cols[i % cols.length]};--r:${(i % 2 ? 1 : -1) * (4 + i)}deg;--dur:${6 + (i % 4) * 1.5}s;--dl:${-i * 1.3}s;`;
      if (opts && opts.calm) b.style.animation = "none";
      layer.appendChild(b);
    });
  }
});
