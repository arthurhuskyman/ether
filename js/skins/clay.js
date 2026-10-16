// Скин «clay» (пластилин): комковатые иконки, мягкие «чпок/плюх»-звуки, дрейфующие пластилиновые комки на фоне.
Skins.register("clay", {
  // толстые заливные формы без тонких линий (контур 2.7 и мягкая заливка задаются в css/skins/clay.css)
  icons: {
    chat: '<path d="M12 3.5c4.9 0 8.6 3.1 8.6 7.4s-3.7 7.4-8.6 7.4c-1 0-2-.1-2.9-.4L5 20.5l.7-3.9c-1.5-1.3-2.2-3.2-2.2-5.7 0-4.3 3.6-7.4 8.5-7.4z"/>',
    user: '<circle cx="12" cy="8" r="4.4"/><path d="M4.5 20.5c0-4.2 3.2-6.2 7.5-6.2s7.5 2 7.5 6.2z"/>',
    users: '<circle cx="9" cy="8" r="3.8"/><path d="M2.5 20c0-3.8 2.8-5.6 6.5-5.6s6.5 1.8 6.5 5.6z"/><path d="M15.5 4.6a3.8 3.8 0 0 1 0 6.8M18 14.6c2 .6 3.5 2 3.5 5.4"/>',
    sliders: '<path d="M3.5 6h17M3.5 12h17M3.5 18h17"/><circle cx="8" cy="6" r="2.8" fill="currentColor"/><circle cx="16" cy="12" r="2.8" fill="currentColor"/><circle cx="9.5" cy="18" r="2.8" fill="currentColor"/>',
    code: '<path d="m8 6.5-5.5 5.5L8 17.5M16 6.5l5.5 5.5-5.5 5.5"/>',
    "chevron-right": '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
    "chevron-left": '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
    "chevron-up": '<path d="m5.5 14.5 6.5-6.5 6.5 6.5"/>',
    "chevron-down": '<path d="m5.5 9.5 6.5 6.5 6.5-6.5"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    plus: '<path d="M12 4.5v15M4.5 12h15"/>',
    check: '<path d="m4.5 12.5 5 5 10-11"/>',
    phone: '<path d="M5.2 3.8h3.3l1.6 4.4-2.1 1.6c1 2.3 2.9 4.2 5.2 5.2l1.6-2.1 4.4 1.6v3.3a2 2 0 0 1-2 2C9.7 19.8 4 14.1 4 5.8a2 2 0 0 1 1.2-2z"/>',
    video: '<rect x="2.5" y="6" width="13" height="12" rx="4.5"/><path d="m21.5 8-5.5 4 5.5 4z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.8 15.8 4.7 4.7"/>',
    pin: '<path d="M9 3.5h6l-.6 5.6 3 3.2c.3 1-.2 1.8-1.2 1.8H7.8c-1 0-1.5-.8-1.2-1.8l3-3.2zM12 14.5v6"/>',
    reply: '<path d="M9.5 4 4 9.5 9.5 15"/><path d="M4.5 9.5H14a6 6 0 0 1 6 6v3"/>',
    forward: '<path d="m14.5 4 5.5 5.5-5.5 5.5"/><path d="M19.5 9.5H10a6 6 0 0 0-6 6v3"/>',
    send: '<path d="M20.5 3.5 3.5 10.5l6.5 2.5 2.5 6.5z"/><path d="m10 13 10.5-9.5"/>',
    mic: '<rect x="8.3" y="3" width="7.4" height="12" rx="3.7"/><path d="M5.5 11.5c0 4 2.9 6.5 6.5 6.5s6.5-2.5 6.5-6.5M12 18.2V21"/>',
    "mic-off": '<rect x="8.3" y="3" width="7.4" height="12" rx="3.7"/><path d="M5.5 11.5c0 4 2.9 6.5 6.5 6.5s6.5-2.5 6.5-6.5M12 18.2V21M3.5 3.5l17 17"/>',
    play: '<path d="M8 4.5c-.8-.5-1.5 0-1.5.9v13.2c0 .9.7 1.4 1.5.9l11-6.6c.7-.4.7-1.4 0-1.8z"/>',
    pause: '<rect x="5.5" y="4.5" width="4.5" height="15" rx="2.2"/><rect x="14" y="4.5" width="4.5" height="15" rx="2.2"/>',
    stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="4.5"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="4"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    refresh: '<path d="M20 11.5a8 8 0 1 0-2.2 5.8"/><path d="M20.5 4.5v7h-7"/>',
    trash: '<path d="M4 7h16"/><path d="M5.8 7l1 12a2 2 0 0 0 2 1.8h6.4a2 2 0 0 0 2-1.8l1-12zM9 7V4.5h6V7"/>',
    edit: '<path d="M4 20h4.2L19.4 8.8a2.4 2.4 0 0 0-3.4-3.4L4.8 16.6z"/>',
    copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="3.5"/><path d="M5.5 15V7a3 3 0 0 1 3-3H16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12l3.2 2"/>',
    star: '<path d="m12 3.4 2.6 5.3 5.8.9-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.9z"/>',
    bell: '<path d="M6 16.5v-5.2a6 6 0 0 1 12 0v5.2l1.8 2.3H4.2z"/><path d="M10 21.2h4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor"/>',
    warning: '<path d="M10.2 4.6a2 2 0 0 1 3.6 0l7.4 13.6a1.8 1.8 0 0 1-1.6 2.6H4.4a1.8 1.8 0 0 1-1.6-2.6z"/><path d="M12 10v4.4"/><circle cx="12" cy="17.4" r="1" fill="currentColor"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14.2c1 1.7 2.4 2.5 4 2.5s3-.8 4-2.5"/><circle cx="9" cy="9.8" r="1.2" fill="currentColor"/><circle cx="15" cy="9.8" r="1.2" fill="currentColor"/>',
    paperclip: '<path d="m19.5 11.5-7.7 7.7a4.6 4.6 0 0 1-6.5-6.5l8-8a3 3 0 0 1 4.3 4.3l-7.8 7.8a1.5 1.5 0 0 1-2.2-2.2l6.8-6.8"/>',
    camera: '<path d="M4.5 7.5h2.7L8.6 5h6.8l1.4 2.5h2.7a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V9a1.5 1.5 0 0 1 1.5-1.5z"/><circle cx="12" cy="13.3" r="3.8"/>',
    file: '<path d="M6.5 3h7.5l5 5v11.5A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z"/><path d="M14 3.5v4.5a.5.5 0 0 0 .5.5H19"/>',
    poll: '<rect x="3.8" y="11" width="4.6" height="9" rx="2.3"/><rect x="9.7" y="4" width="4.6" height="16" rx="2.3"/><rect x="15.6" y="13.5" width="4.6" height="6.5" rx="2.3"/>',
    board: '<rect x="3" y="4" width="5.6" height="16" rx="2.4"/><rect x="9.7" y="4" width="5.6" height="10" rx="2.4"/><rect x="16.4" y="4" width="4.6" height="13" rx="2.3"/>',
    volume: '<path d="M4 9.5v5h3.6l4.9 4V5.5l-4.9 4z"/><path d="M16.5 9a4.2 4.2 0 0 1 0 6"/>',
    more: '<circle cx="5.5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="18.5" cy="12" r="2.2"/>',
    sparkle: '<path d="M12 3.5c.6 4.2 1.8 5.4 6 6-4.2.6-5.4 1.8-6 6-.6-4.2-1.8-5.4-6-6 4.2-.6 5.4-1.8 6-6z"/><path d="M18.5 15.5c.3 2 .9 2.6 2.5 2.9-1.6.3-2.2.9-2.5 2.9-.3-2-.9-2.6-2.5-2.9 1.6-.3 2.2-.9 2.5-2.9z"/>',
    moon: '<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.2 8.2 0 1 0 20 14.5z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9S14.500 18.400 12 21c-2.500-2.600-3.700-5.600-3.700-9S9.500 5.600 12 3z"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.300 0 2.100-.9 2.100-1.900 0-.5-.2-.9-.5-1.300-.3-.4-.5-.8-.5-1.300 0-1.100.9-1.900 1.900-1.900H17a4 4 0 0 0 4-4C21 6.500 17 3 12 3z"/><circle cx="7.600" cy="11" r="1.100" fill="currentColor"/><circle cx="10" cy="7.500" r="1.100" fill="currentColor"/><circle cx="14.500" cy="7.500" r="1.100" fill="currentColor"/>'
  },
  // «чпок/плюх»: низкие мягкие sine/triangle с быстрым питч-слайдом
  sound: {
    in: [{ f: [260, 520], t: 0, d: 0.14, v: 0.2, w: "sine", lp: 1400 }, { f: [520, 190], t: 0.13, d: 0.2, v: 0.17, w: "sine", lp: 1100 }, { f: [330, 440], t: 0.3, d: 0.16, v: 0.12, w: "triangle", lp: 1000 }],
    out: [{ f: [420, 160], t: 0, d: 0.13, v: 0.2, w: "sine", lp: 1200 }, { f: [200, 120], t: 0.06, d: 0.1, v: 0.08, w: "triangle", lp: 600 }],
    tap: [{ f: [300, 150], t: 0, d: 0.06, v: 0.06, w: "sine", lp: 800 }],
    tab: [{ f: [190, 380], t: 0, d: 0.09, v: 0.09, w: "sine", lp: 900 }, { f: [380, 240], t: 0.08, d: 0.09, v: 0.06, w: "triangle", lp: 800 }],
    react: [{ f: [300, 620], t: 0, d: 0.12, v: 0.12, w: "sine", lp: 1300 }, { f: [620, 340], t: 0.1, d: 0.14, v: 0.1, w: "triangle", lp: 1100 }],
    error: [{ f: [260, 110], t: 0, d: 0.28, v: 0.16, w: "triangle", lp: 600 }]
  },
  haptic: { tap: [8] },
  // пластилиновые комки, медленно дрейфующие и «дышащие» за интерфейсом
  deco(layer, opts) {
    const dark = opts && opts.scheme === "dark";
    const cols = dark ? ["#8a5fc0", "#ff9f80", "#4fb3a6", "#d9a03a", "#c96b9a"] : ["#ffb199", "#ffd166", "#8fd9cc", "#d6a7ec", "#ffa6c1"];
    const radii = ["48% 52% 56% 44% / 52% 44% 56% 48%", "56% 44% 48% 52% / 46% 56% 44% 54%", "44% 56% 52% 48% / 54% 46% 54% 46%"];
    const spots = [[-8, 8, 120], [78, 4, 90], [84, 38, 110], [-10, 52, 90], [14, 88, 130], [70, 82, 120], [40, 60, 70], [52, 14, 60]];
    spots.forEach((s, i) => {
      const b = document.createElement("div"); b.className = "clay-blob";
      b.style.cssText = `left:${s[0]}%;top:${s[1]}%;width:${s[2]}px;height:${Math.round(s[2] * (0.8 + (i % 3) * 0.12))}px;background:${cols[i % cols.length]};border-radius:${radii[i % 3]};--dur:${20 + i * 3}s;--dl:${-i * 4}s;--dx:${(i % 2 ? -1 : 1) * (14 + i * 3)}px;--dy:${18 + (i % 3) * 12}px;`;
      if (opts && opts.calm) b.style.animation = "none";
      layer.appendChild(b);
    });
  }
});
