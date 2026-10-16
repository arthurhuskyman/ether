// Скин «cartoon»: пухлые «стикерные» иконки с цветной подложкой, звуки boing/pop/«бип», плавающие конфетти.
// Регистрируется в Skins (js/skins.js).
(function () {
  const F = ' style="fill:currentColor;fill-opacity:.3"'; // подложка-заливка под толстым контуром
  const S = ' style="fill:currentColor;stroke:none"';
  const icons = {
    chat: `<path${F} d="M12 3.2c5 0 9 3.2 9 7.6s-4 7.6-9 7.6c-.9 0-1.8-.1-2.6-.3L5 20.8l.9-3.6C4 15.8 3 13.5 3 10.8 3 6.400 7 3.200 12 3.200z"/><path d="M8.500 10.800h.01M12 10.800h.01M15.500 10.800h.01" stroke-width="3.600"/>`,
    user: `<circle${F} cx="12" cy="8" r="4.600"/><path${F} d="M3.800 20.800c0-4 3.500-6.300 8.200-6.300s8.200 2.300 8.200 6.300z"/>`,
    users: `<circle${F} cx="8.500" cy="8.500" r="3.800"/><path${F} d="M2 20c0-3.700 2.800-5.600 6.500-5.600S15 16.300 15 20z"/><circle${F} cx="16.800" cy="9.300" r="3"/><path d="M17 14.600c2.700.1 5 1.600 5 4.800"/>`,
    sliders: `<path d="M3.500 7h17M3.500 17h17"/><circle${F} cx="15" cy="7" r="3.100"/><circle${F} cx="8.500" cy="17" r="3.100"/>`,
    plus: `<path d="M12 4.500v15M4.500 12h15" stroke-width="3.400"/>`,
    send: `<path${F} d="M21 3 3 10.200l7.200 3 3 7.300z"/><path d="M10.200 13.200 21 3"/>`,
    mic: `<rect${F} x="8.500" y="2.800" width="7" height="12" rx="3.500"/><path d="M4.800 11.500a7.200 7.200 0 0 0 14.400 0M12 19v2.500"/>`,
    phone: `<path${F} d="M5.200 3.200 8.500 3 10 7.200 8 9a12 12 0 0 0 7 7l1.800-2 4.200 1.500-.2 3.300c-.1 1-1 1.800-2 1.800A17.800 17.800 0 0 1 3.400 5.200c0-1 .8-1.900 1.800-2z"/>`,
    video: `<rect${F} x="2.500" y="6" width="12.500" height="12" rx="4"/><path${F} d="m15.500 10 6-3.200v10.400l-6-3.200z"/>`,
    search: `<circle${F} cx="10.500" cy="10.500" r="6.800"/><path d="m16 16 5 5" stroke-width="3.600"/>`,
    x: `<path d="M6 6l12 12M18 6 6 18" stroke-width="3.600"/>`,
    check: `<path d="m4.500 12.800 5 5L20 6.500" stroke-width="3.800"/>`,
    "chevron-left": `<path d="m15 5-7 7 7 7" stroke-width="3.600"/>`,
    "chevron-right": `<path d="m9 5 7 7-7 7" stroke-width="3.600"/>`,
    "chevron-up": `<path d="m5 15 7-7 7 7" stroke-width="3.600"/>`,
    "chevron-down": `<path d="m5 9 7 7 7-7" stroke-width="3.600"/>`,
    paperclip: `<path d="M19.800 11.500 12.200 19a4.600 4.600 0 0 1-6.500-6.500l7.600-7.500a3 3 0 0 1 4.300 4.300l-7.500 7.500a1.500 1.500 0 0 1-2.200-2.200l6.800-6.700" stroke-width="2.900"/>`,
    more: `<circle cx="5" cy="12" r="2.200"/><circle cx="12" cy="12" r="2.200"/><circle cx="19" cy="12" r="2.200"/>`,
    play: `<path d="M7 3.800c0-.9 1-1.400 1.800-.9l11 7.200c.7.500.7 1.500 0 2l-11 7.200c-.8.500-1.800 0-1.800-.9z" transform="translate(0 1)"/>`,
    pause: `<rect x="5.500" y="4" width="4.500" height="16" rx="2.200"/><rect x="14" y="4" width="4.500" height="16" rx="2.200"/>`,
    stop: `<rect x="5.500" y="5.500" width="13" height="13" rx="4"/>`,
    smile: `<circle${F} cx="12" cy="12" r="9.200"/><path d="M7.800 13.800c1 2.500 2.500 3.500 4.200 3.500s3.200-1 4.200-3.500z" style="fill:currentColor;fill-opacity:.55"/><path d="M8.800 9.300v1.600M15.200 9.300v1.600" stroke-width="3.400"/>`,
    camera: `<path${F} d="M3.500 8c0-1 .8-1.800 1.800-1.800h1.600L8.500 4h7l1.600 2.200h1.600c1 0 1.800.8 1.800 1.800v9.500c0 1-.8 1.800-1.800 1.800H5.300c-1 0-1.800-.8-1.800-1.800z"/><circle cx="12" cy="12.700" r="3.600" style="fill:var(--sk-panel,#fff)"/>`,
    file: `<path${F} d="M6.500 2.800h7.200l5 5v11.500c0 1.100-.9 2-2 2H6.500c-1.100 0-2-.9-2-2V4.800c0-1.100.9-2 2-2z"/><path d="M13.500 3v5h5"/>`,
    poll: `<rect${F} x="3.500" y="11" width="4.600" height="9.500" rx="1.800"/><rect${F} x="9.700" y="3.500" width="4.600" height="17" rx="1.800"/><rect${F} x="15.900" y="14" width="4.600" height="6.500" rx="1.800"/>`,
    board: `<rect${F} x="3" y="4" width="5.500" height="16" rx="2"/><rect${F} x="9.700" y="4" width="5.500" height="10" rx="2"/><rect${F} x="16.400" y="4" width="4.600" height="13" rx="2"/>`,
    pin: `<path${F} d="M9 3.500h6l-.8 5.500 3 3.200v1.800H6.800v-1.800l3-3.200z"/><path d="M12 14v6.500"/>`,
    reply: `<path d="M9.500 14.500 4 9l5.500-5.500"/><path d="M4 9h9a7 7 0 0 1 7 7v2" stroke-width="3"/>`,
    forward: `<path d="m14.500 14.500 5.500-5.500-5.500-5.500"/><path d="M20 9h-9a7 7 0 0 0-7 7v2" stroke-width="3"/>`,
    star: `<path${F} d="m12 2.800 2.900 5.900 6.500.9-4.700 4.600 1.100 6.500L12 17.600l-5.800 3.100 1.100-6.500L2.600 9.600l6.500-.9z"/>`,
    bell: `<path${F} d="M5.500 16.500v-5.200a6.500 6.500 0 0 1 13 0v5.200l2 2H3.500z"/><path d="M9.800 21.500h4.400"/>`,
    lock: `<rect${F} x="4.500" y="10.500" width="15" height="10.500" rx="3.500"/><path d="M8 10.500V7.500a4 4 0 0 1 8 0v3"/>`,
    trash: `<path${F} d="M5.800 7.500h12.400l-.9 12.200c-.1 1-.9 1.800-1.900 1.800H8.600c-1 0-1.800-.8-1.900-1.800z"/><path d="M3.800 7.500h16.400M9.500 7.500V4.500h5v3"/>`,
    edit: `<path${F} d="M4 20.300 4.800 15 16 3.800a2.400 2.400 0 0 1 3.400 3.400L8.200 18.500z"/><path d="m14 6 4 4"/>`,
    copy: `<rect${F} x="8.500" y="8.500" width="12" height="12" rx="3.500"/><path d="M4.500 15V7a3 3 0 0 1 3-3h8"/>`,
    clock: `<circle${F} cx="12" cy="12" r="9.200"/><path d="M12 6.500V12l3.600 2.200"/>`,
    info: `<circle${F} cx="12" cy="12" r="9.200"/><path d="M12 11v5.500M12 7.600v.01" stroke-width="3.400"/>`,
    warning: `<path${F} d="M10.200 3.800a2 2 0 0 1 3.600 0l8 14.900c.6 1.200-.2 2.600-1.800 2.600H4c-1.600 0-2.400-1.400-1.800-2.600z"/><path d="M12 9.500v4.500M12 17.500v.01" stroke-width="3.400"/>`,
    download: `<path d="M12 3.500v11M6.800 10 12 15.200 17.200 10" stroke-width="3"/><path${F} d="M4 16.500v2.500a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.500z"/>`,
    link: `<path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1" stroke-width="3"/>`,
    moon: `<path${F} d="M20.500 14.500A8.500 8.500 0 0 1 9.500 3.500a8.500 8.500 0 1 0 11 11z"/>`,
    sparkle: `<path${F} d="M12 2.500c.8 4.800 2.700 6.700 7.500 7.500-4.800.8-6.700 2.700-7.500 7.500-.8-4.800-2.700-6.700-7.500-7.500 4.800-.8 6.700-2.700 7.500-7.500z"/><path d="M19 17v4M17 19h4"/>`,
    shield: `<path${F} d="M12 2.800 4.500 6v5.500c0 4.600 3.100 8.200 7.500 9.700 4.400-1.500 7.500-5.100 7.500-9.700V6z"/><path d="m8.800 12 2.400 2.400 4-4.200" stroke-width="3"/>`,
    globe: `<circle${F} cx="12" cy="12" r="9.200"/><path d="M3 12h18M12 3c2.600 2.700 3.800 5.700 3.800 9S14.600 18.300 12 21c-2.600-2.700-3.800-5.700-3.800-9S9.400 5.700 12 3z"/>`,
    palette: `<path${F} d="M12 3a9 9 0 1 0 0 18c1.300 0 2.100-.9 2.100-1.900 0-.6-.3-1-.6-1.400s-.5-.8-.5-1.300c0-1 .8-1.800 1.900-1.800H17a4 4 0 0 0 4-4C21 6.500 17 3 12 3z"/><path d="M7.500 11h.01M10 7.500h.01M14.500 7.500h.01" stroke-width="3.400"/>`
  };
  // Звуки: «boing» и «pop» — питч-слайды на square/triangle, короткие «бипы»
  const sound = {
    in: [{ f: [260, 760], t: 0, d: 0.16, v: 0.14, w: "triangle" }, { f: [760, 420], t: 0.15, d: 0.12, v: 0.11, w: "triangle" }, { f: [520, 1040], t: 0.3, d: 0.14, v: 0.1, w: "square", lp: 2200 }, { f: [1040, 1300], t: 0.42, d: 0.1, v: 0.06, w: "sine" }],
    out: [{ f: [420, 1100], t: 0, d: 0.09, v: 0.12, w: "triangle" }, { f: [1100, 700], t: 0.08, d: 0.07, v: 0.07, w: "square", lp: 2500 }],
    tap: [{ f: [900, 1250], t: 0, d: 0.045, v: 0.045, w: "square", lp: 3000 }],
    tab: [{ f: [330, 620], t: 0, d: 0.07, v: 0.07, w: "triangle" }, { f: [620, 880], t: 0.06, d: 0.06, v: 0.06, w: "triangle" }],
    react: [{ f: [700, 1500], t: 0, d: 0.08, v: 0.1, w: "triangle" }, { f: [1500, 1000], t: 0.08, d: 0.1, v: 0.08, w: "square", lp: 3000 }],
    error: [{ f: [300, 140], t: 0, d: 0.28, v: 0.12, w: "triangle" }, { f: [220, 110], t: 0.22, d: 0.3, v: 0.1, w: "triangle" }]
  };
  // Декор: облачка, звёзды и шарики плавно дрейфуют по фону
  function deco(layer, o) {
    const calm = o && o.calm;
    const items = [
      ["cloud", 6, 10, 74, 14, "#ffffff", 0, 11], ["star", 82, 6, 34, 16, "#ffd23f", 8, 9], ["ball", 90, 34, 30, 12, "#ff6b6b", 3, 13], ["star", 4, 40, 28, 15, "#4dabf7", 2, 10],
      ["cloud", 68, 56, 90, 17, "#ffffff", 5, 12], ["ball", 8, 66, 36, 11, "#51cf66", 1, 14], ["star", 76, 80, 40, 14, "#b197fc", 6, 9], ["cloud", 12, 86, 80, 18, "#ffffff", 4, 15],
      ["ball", 52, 4, 24, 12, "#ffa94d", 7, 11], ["star", 46, 92, 30, 13, "#ff8fab", 9, 12]
    ];
    const shape = (k, c) => {
      if (k === "cloud") return `<svg viewBox="0 0 80 48" width="100%" height="100%"><path d="M16 40a12 12 0 0 1-1-23.900A16 16 0 0 1 45 12a14 14 0 0 1 22 12 10 10 0 0 1-3 16z" fill="${c}" stroke="#2a2550" stroke-width="4" stroke-linejoin="round"/></svg>`;
      if (k === "star") return `<svg viewBox="0 0 48 48" width="100%" height="100%"><path d="m24 4 5.600 12.400 13.400 1.300-10 9 3 13.300L24 33l-12 7 3-13.300-10-9 13.400-1.300z" fill="${c}" stroke="#2a2550" stroke-width="4" stroke-linejoin="round"/></svg>`;
      return `<svg viewBox="0 0 48 48" width="100%" height="100%"><circle cx="24" cy="24" r="19" fill="${c}" stroke="#2a2550" stroke-width="4"/><ellipse cx="17" cy="16" rx="6" ry="4" fill="#fff" fill-opacity=".7" transform="rotate(-35 17 16)"/></svg>`;
    };
    const dark = o && o.scheme === "dark";
    for (const [k, x, y, w, d, c, dl, r] of items) {
      const el = document.createElement("div"); el.className = "cd";
      el.style.cssText = `left:${x}%;top:${y}%;width:${w}px;height:${k === "cloud" ? w * 0.6 : w}px;--d:${d}s;--dl:-${dl}s;--r:${r - 10}deg;--dx:${(r % 2 ? 1 : -1) * 16}px;--dy:${-14 - r}px`;
      el.innerHTML = shape(k, dark && k === "cloud" ? "#6a63b8" : c);
      if (calm) el.style.animation = "none";
      layer.appendChild(el);
    }
  }
  Skins.register("cartoon", { icons, sound, haptic: { tap: [8] }, deco });
})();
