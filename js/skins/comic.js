// Скин «comic»: угловатые иконки с «движущими линиями», звуки ударов («пау», «вжух»), декор — лучи, полутон и надписи POW!/ZAP!.
// Регистрируется в Skins (js/skins.js).
(function () {
  const T = ' style="stroke-width:3.4"'; // особо жирный штрих
  const FL = ' style="fill:currentColor;fill-opacity:.22"';
  const icons = {
    chat: `<path${FL} d="M3 4h18v12h-8l-5 5v-5H3z"/><path d="M7 9h10M7 12.500h6"/>`,
    user: `<path${FL} d="M12 2.500l4 2.500v4.500l-4 3-4-3V5z"/><path d="M3.500 21.500v-3l5-3.500h7l5 3.500v3z"/>`,
    users: `<path${FL} d="M8 3l3.500 2.500v3.500L8 11.500 4.500 9V5.500z"/><path d="M2 21v-3l4-3h4l4 3v3z"/><path d="M16 5l3 2v3l-3 2M17 15l5 3v3h-5"/>`,
    sliders: `<path d="M3 7h18M3 17h18"/><path${FL} d="M13 3.500h5v7h-5zM6 13.500h5v7H6z"/>`,
    plus: `<path d="M12 3.500v17M3.500 12h17"${T.replace(' style=', ' style=')}/>`,
    send: `<path${FL} d="M21.500 2.500 2 10.500l7 3 3 7.500z"/><path d="M9 13.500 21.500 2.500M1 17h4M3 21h4"/>`,
    mic: `<path${FL} d="M8 3h8v10l-2 2.500h-4L8 13z"/><path d="M4.500 11v3.500l3.500 4h8l3.500-4V11M12 18.500v3M9 21.500h6"/>`,
    phone: `<path${FL} d="M3.500 4.500 8 3l2.500 5.500-3 2c1.500 3 3.500 5 6.500 6.500l2-3 5.500 2.500-1.500 4.500C10 22 2 14 3.500 4.500z"/><path d="M15 2.500l1 2.500M19 5l2-1.500M20 9.500l2.500.5"/>`,
    video: `<path${FL} d="M2 6h13v12H2z"/><path d="M15 10.500l7-4v11l-7-4z"/>`,
    search: `<path${FL} d="M7.500 3.500h6l4 4v6l-4 4h-6l-4-4v-6z"/><path d="M16 16l5.500 5.500" style="stroke-width:4"/>`,
    x: `<path d="M5 5l14 14M19 5 5 19"${T}/>`,
    check: `<path d="M3 12.500 9 18.500 21 5"${T}/>`,
    "chevron-left": `<path d="M16 4 7 12l9 8"${T}/>`,
    "chevron-right": `<path d="M8 4l9 8-9 8"${T}/>`,
    "chevron-up": `<path d="M4 16l8-9 8 9"${T}/>`,
    "chevron-down": `<path d="M4 8l8 9 8-9"${T}/>`,
    paperclip: `<path d="M17.500 8.500 9 17a2.800 2.800 0 0 1-4-4l9-9 2.500 2.500-8 8"/>`,
    more: `<rect x="2.500" y="9.500" width="5" height="5"/><rect x="9.500" y="9.500" width="5" height="5"/><rect x="16.500" y="9.500" width="5" height="5"/>`,
    play: `<path d="M6 3.500v17l15-8.500z"/>`,
    pause: `<rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/>`,
    stop: `<rect x="5" y="5" width="14" height="14"/>`,
    smile: `<path${FL} d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M8 9.500v2M16 9.500v2M7.500 14l2.500 3h4l2.500-3"/>`,
    camera: `<path${FL} d="M2.500 7.500h4.500l2-3.500h6l2 3.500h4.500v12.500h-19z"/><path d="M12 10.500l3 2.500-3 3-3-3z"/>`,
    file: `<path${FL} d="M5 2.500h9l5 5v14H5z"/><path d="M14 2.500v5h5M8.500 13h7M8.500 17h5"/>`,
    poll: `<path${FL} d="M3.500 12h5v9h-5zM9.500 3h5v18h-5zM15.500 15h5v6h-5z"/>`,
    board: `<path${FL} d="M3 3.500h5.500v17H3zM9.500 3.500H15v10H9.500zM16 3.500h5V16h-5z"/>`,
    pin: `<path${FL} d="M8 3h8l-1 6 3.500 3.500V15H5.500v-2.500L9 9z"/><path d="M12 15v6.500"/>`,
    reply: `<path d="M10 4 3 10l7 6"/><path d="M3 10h10l7 5v5"${T}/>`,
    forward: `<path d="m14 4 7 6-7 6"/><path d="M21 10H11l-8 5v5"${T}/>`,
    star: `<path${FL} d="M12 2l2.200 5.500 5.800-1.800-3 5.300L21.500 14l-6 .8L14 21l-2-5-2 5-1.500-6.200-6-.8 4.500-3 -3-5.300 5.800 1.800z"/>`,
    bell: `<path${FL} d="M5.500 17v-6l3-6.500h7l3 6.500v6l2 2H3.500z"/><path d="M9.500 22h5M12 2v2.500"/>`,
    lock: `<path${FL} d="M4.500 10.500h15v11h-15z"/><path d="M7.500 10.500V6.500l2-3h5l2 3v4M12 14.500v3"/>`,
    trash: `<path${FL} d="M5.500 7.500h13l-1 14h-11z"/><path d="M3 7.500h18M9 7.500V3.500h6v4M10 11v7M14 11v7"/>`,
    edit: `<path${FL} d="M3.500 21 4.500 15 16 3.500l4.500 4.500L9 19.500z"/><path d="M13.500 6l4.500 4.500"/>`,
    copy: `<path${FL} d="M9 9h12v12H9z"/><path d="M5 15V3.500h11.500"/>`,
    clock: `<path${FL} d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M12 7v5.500l4 2"/>`,
    info: `<path${FL} d="M12 2.500 21.500 12 12 21.500 2.500 12z"/><path d="M12 11v5.500M12 7.500v.5"${T}/>`,
    warning: `<path${FL} d="M12 3 22 20.500H2z"/><path d="M12 9.500v5M12 17.500v.5"${T}/>`,
    download: `<path d="M12 3v12M6 10.500l6 6 6-6"${T}/><path d="M3.500 20.500h17"/>`,
    link: `<path d="M9.500 14.500l5-5M8 8.500 6 10.500a3.500 3.500 0 0 0 5 5l2-2M16 15.500l2-2a3.500 3.500 0 0 0-5-5l-2 2"/>`,
    moon: `<path${FL} d="M20.500 15A9 9 0 0 1 9 3.500 8.500 8.500 0 1 0 20.500 15z"/>`,
    sparkle: `<path${FL} d="M12 2l2.500 7.500L22 12l-7.500 2.500L12 22l-2.500-7.500L2 12l7.500-2.500z"/>`,
    shield: `<path${FL} d="M12 2.500 4 5.500v6l3 6 5 4 5-4 3-6v-6z"/><path d="M8.500 12l2.500 2.500 4.500-5"/>`,
    globe: `<path${FL} d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M3 12h18M12 3v18"/>`,
    palette: `<path${FL} d="M12 2.500 20 6l2 7-4 2.500h-3l-1 3 1 3H9L3 17 2 9z"/><path d="M7 10h.01M11 6.500h.01M16 8.500h.01" style="stroke-width:3.600"/>`
  };
  // Звуки: удары — всплеск шума и быстрый нисходящий слайд
  const sound = {
    in: [{ w: "noise", f: 0, t: 0, d: 0.07, v: 0.16, hp: 700 }, { f: [520, 70], t: 0, d: 0.13, v: 0.2, w: "square", lp: 1800 }, { f: [880, 880], t: 0.17, d: 0.06, v: 0.1, w: "square", lp: 2400 }, { f: [1320, 1320], t: 0.24, d: 0.16, v: 0.11, w: "square", lp: 2600 }],
    out: [{ w: "noise", f: 0, t: 0, d: 0.12, v: 0.08, hp: 2500, lp: 7000 }, { f: [300, 1500], t: 0, d: 0.1, v: 0.07, w: "sawtooth", lp: 2200 }, { f: [220, 90], t: 0.1, d: 0.07, v: 0.1, w: "square", lp: 900 }],
    tap: [{ w: "noise", f: 0, t: 0, d: 0.025, v: 0.07, hp: 1800 }, { f: [260, 140], t: 0, d: 0.04, v: 0.05, w: "square", lp: 1200 }],
    tab: [{ w: "noise", f: 0, t: 0, d: 0.04, v: 0.08, hp: 1500 }, { f: [180, 520], t: 0, d: 0.07, v: 0.07, w: "sawtooth", lp: 1600 }],
    react: [{ f: [600, 1800], t: 0, d: 0.09, v: 0.1, w: "square", lp: 3000 }, { w: "noise", f: 0, t: 0.05, d: 0.08, v: 0.06, hp: 3000 }],
    error: [{ w: "noise", f: 0, t: 0, d: 0.15, v: 0.12, hp: 300, lp: 2200 }, { f: [200, 50], t: 0, d: 0.3, v: 0.16, w: "sawtooth", lp: 900 }]
  };
  function deco(layer, o) {
    const mk = (cls, css, txt) => { const d = document.createElement("div"); d.className = cls; if (css) d.style.cssText = css; if (txt) d.textContent = txt; layer.appendChild(d); return d; };
    mk("cm-rays"); mk("cm-ht a"); mk("cm-ht b");
    const words = [["POW!", 6, 62, 72, -12, 0], ["ZAP!", 52, 13, 54, 8, -2], ["BAM!", 4, 36, 60, -6, -1.500], ["WOW!", 58, 82, 56, 10, -3]];
    for (const [t, x, y, s, r, dl] of words) { const w = mk("cm-word", `left:${x}%;top:${y}%;--s:${s}px;--r:${r}deg;--dl:${dl}s`, t); if (o && o.calm) w.style.animation = "none"; }
  }
  Skins.register("comic", { icons, sound, haptic: { tap: [14] }, deco });
})();
