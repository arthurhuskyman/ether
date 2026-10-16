// Скин «steampunk»: гравированные иконки (шестерни, часы, ключи), механические звуки (колокол, тик-так, пар), декор: трубы, шестерни, пар.
Skins.register("steampunk", {
  icons: {
    chat: '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><circle cx="7.5" cy="10.5" r=".9"/><circle cx="12" cy="10.5" r=".9"/><circle cx="16.5" cy="10.5" r=".9"/>',
    user: '<path d="M7 9h10M8 9V5h8v4"/><circle cx="12" cy="14" r="3.2"/><path d="M5 21c0-3.5 3-5 7-5s7 1.5 7 5"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.2 2.6-5 6-5s6 1.8 6 5z"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.2c3 0 4.5 1.6 4.5 4.3"/>',
    sliders: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.4 2.6 2.9-.8.9 2.8 2.8.9-.8 2.9 2.6 1.4-2.6 1.4.8 2.9-2.8.9-.9 2.8-2.9-.8L12 21.5l-1.4-2.6-2.9.8-.9-2.8-2.8-.9.8-2.9L2.2 12l2.6-1.4-.8-2.9 2.8-.9.9-2.8 2.9.8z"/>',
    code: '<path d="M8 6 3 12l5 6M16 6l5 6-5 6"/><circle cx="12" cy="12" r="1.4"/>',
    "chevron-right": '<path d="M9 5l7 7-7 7"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/>',
    "chevron-left": '<path d="M15 5l-7 7 7 7"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
    "chevron-up": '<path d="M5 15l7-7 7 7"/><circle cx="5" cy="15" r="1"/><circle cx="19" cy="15" r="1"/>',
    "chevron-down": '<path d="M5 9l7 7 7-7"/><circle cx="5" cy="9" r="1"/><circle cx="19" cy="9" r="1"/>',
    x: '<circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>',
    plus: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v9M7.5 12h9"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M7.5 12.5l3 3 6-6.5"/>',
    phone: '<path d="M7 3h10v3H7zM9 6v3M15 6v3"/><path d="M5 12c0-2 2-3 7-3s7 1 7 3v2H5z"/><circle cx="12" cy="17.5" r="3.5"/><circle cx="12" cy="17.5" r="1"/>',
    video: '<circle cx="7" cy="7" r="3.5"/><circle cx="14" cy="6.5" r="3"/><rect x="3" y="11" width="13" height="9" rx="1.5"/><path d="M16 14l5-2.5v9L16 18"/>',
    search: '<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="4" stroke-width="1"/><path d="M15 15l3 3"/><path d="M17.5 17.5l3 3" stroke-width="3.4"/>',
    pin: '<circle cx="12" cy="8" r="5"/><circle cx="12" cy="8" r="1.6"/><path d="M12 13v8"/>',
    reply: '<path d="M10 7 4 12l6 5"/><path d="M4 12h9a7 7 0 0 1 7 7"/>',
    forward: '<path d="M14 7l6 5-6 5"/><path d="M20 12h-9a7 7 0 0 0-7 7"/>',
    send: '<rect x="3" y="8" width="18" height="8" rx="4"/><path d="M7 8v8M17 8v8M10 12h4M12.5 10l2 2-2 2"/><path d="M3 12H1M23 12h-2" />',
    mic: '<path d="M4 9l9-3v8L4 12z"/><path d="M13 7l5-3v12l-5-3"/><path d="M8 12l1 6h3l-1-5"/>',
    "mic-off": '<path d="M4 9l9-3v8L4 12z"/><path d="M13 7l5-3v12l-5-3"/><path d="M2 3l20 18"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    pause: '<rect x="5.5" y="4.5" width="4.5" height="15" rx="1"/><rect x="14" y="4.5" width="4.5" height="15" rx="1"/>',
    stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1.6"/><path d="M12 16.5V19"/>',
    refresh: '<path d="M20 12a8 8 0 1 0-2.5 5.8"/><path d="M20 5v6h-6"/><circle cx="12" cy="12" r="1.5"/>',
    trash: '<path d="M5 7h14M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    edit: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M13 7l4 4M4 20l4-1"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V4H4v12h4"/><circle cx="14" cy="14" r="1.2"/>',
    clock: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9M12 13.5l3 2M10 3h4M12 3v3"/><circle cx="12" cy="13.5" r="1"/>',
    star: '<circle cx="12" cy="12" r="9"/><path d="M12 3l2.2 7.8L21 12l-6.8 1.2L12 21l-2.2-7.8L3 12l6.8-1.2z"/>',
    bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z"/><path d="M10 21a2 2 0 0 0 4 0M12 3V2"/><circle cx="12" cy="13" r="1.2"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M9.5 13h5"/><circle cx="12" cy="16.5" r=".9"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    warning: '<path d="M12 3L2 20h20z"/><path d="M12 9.5v5"/><circle cx="12" cy="17.2" r=".9"/>',
    info: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="6.6" stroke-width="1"/><path d="M12 11v5M12 8v.4"/>',
    volume: '<path d="M3 9v6h4l5 4V5L7 9z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14.5c1 1.6 2.4 2.4 4 2.4s3-.8 4-2.4"/><circle cx="9" cy="9.5" r="1.1"/><circle cx="15" cy="9.5" r="1.1"/>',
    paperclip: '<path d="M19 10l-8 8a4.5 4.5 0 0 1-6.4-6.4l8.4-8.4a3 3 0 0 1 4.3 4.3L9 16a1.5 1.5 0 0 1-2.1-2.1L14 7"/>',
    camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7l1.5-3h5L16 7"/><circle cx="12" cy="13.5" r="4"/><circle cx="12" cy="13.5" r="1.6"/>',
    file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/><circle cx="8.2" cy="5.5" r=".8"/>',
    poll: '<circle cx="12" cy="12" r="9"/><path d="M12 12V5M12 12l5.5 4"/><circle cx="12" cy="12" r="1.3"/>',
    board: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9 4v16M15 4v16"/><circle cx="6" cy="8" r=".8"/><circle cx="12" cy="8" r=".8"/><circle cx="18" cy="8" r=".8"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9.5C7.2 20 4 16.5 4 12V6z"/><circle cx="12" cy="11" r="2.4"/><path d="M12 13.4V16"/>',
    link: '<path d="M10 14l4-4"/><rect x="2.5" y="10" width="9" height="5" rx="2.5" transform="rotate(-45 7 12.5)"/><rect x="12.5" y="9" width="9" height="5" rx="2.5" transform="rotate(-45 17 11.5)"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/><circle cx="4" cy="21" r=".6"/><circle cx="20" cy="21" r=".6"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.3 0 2-.8 2-1.8 0-1-1-1.5-1-2.7 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.5-1.1 1-1.1 1.8"/><circle cx="12" cy="17" r=".8"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/><circle cx="14" cy="14" r="1"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'
  },
  sound: {
    // входящее: латунный колокольчик (гармоники с долгим затуханием) + щелчок механизма
    in: [
      { f: 1568, t: 0, d: 0.5, v: 0.09, w: "sine" },
      { f: 3136, t: 0, d: 0.28, v: 0.04, w: "sine" },
      { f: 4200, t: 0, d: 0.12, v: 0.025, w: "triangle" },
      { f: 1175, t: 0.2, d: 0.55, v: 0.07, w: "sine" },
      { f: 2350, t: 0.2, d: 0.25, v: 0.03, w: "sine" },
      { f: 0, w: "noise", t: 0, d: 0.025, v: 0.07, hp: 2500 }
    ],
    // отправка: щелчок рычага и звон шестерни
    out: [
      { w: "noise", t: 0, d: 0.03, v: 0.12, hp: 1800, lp: 6000 },
      { f: 180, t: 0, d: 0.06, v: 0.1, w: "triangle" },
      { f: [900, 700], t: 0.06, d: 0.1, v: 0.05, w: "triangle", lp: 2500 },
      { w: "noise", t: 0.1, d: 0.02, v: 0.08, hp: 3000 }
    ],
    tap: [{ w: "noise", t: 0, d: 0.022, v: 0.07, hp: 2200 }, { f: 260, t: 0, d: 0.04, v: 0.04, w: "triangle" }],
    tab: [
      { w: "noise", t: 0, d: 0.02, v: 0.08, hp: 2500 }, { f: 330, t: 0, d: 0.05, v: 0.05, w: "triangle" },
      { w: "noise", t: 0.07, d: 0.02, v: 0.07, hp: 3200 }, { f: 440, t: 0.07, d: 0.05, v: 0.04, w: "triangle" }
    ],
    react: [{ f: 2093, t: 0, d: 0.3, v: 0.06, w: "sine" }, { f: 3136, t: 0.05, d: 0.2, v: 0.03, w: "sine" }],
    // ошибка: паровой свисток и глухой удар
    error: [{ w: "noise", t: 0, d: 0.4, v: 0.08, hp: 3000, lp: 6500, q: 3 }, { f: 90, t: 0, d: 0.18, v: 0.12, w: "triangle" }]
  },
  haptic: { tap: [14] },
  deco(layer, opts) {
    const calm = !!(opts && opts.calm);
    const mk = (cls, style) => { const d = document.createElement("div"); d.className = cls; if (style) d.style.cssText = style; layer.appendChild(d); return d; };
    mk("sp-pipe l"); mk("sp-pipe r");
    mk("sp-gear", "width:220px;height:220px;right:-70px;top:90px;animation-duration:50s");
    mk("sp-gear rev", "width:150px;height:150px;left:-50px;top:300px;animation-duration:34s");
    mk("sp-gear", "width:260px;height:260px;left:-80px;bottom:60px;animation-duration:60s");
    mk("sp-gear rev", "width:120px;height:120px;right:10px;bottom:140px;animation-duration:28s");
    if (!calm) for (let i = 0; i < 4; i++) mk("sp-puff", "left:" + (10 + i * 22) + "%;animation-delay:" + (i * 1.9) + "s;animation-duration:" + (6.5 + i) + "s");
    return () => { layer.innerHTML = ""; };
  }
});
