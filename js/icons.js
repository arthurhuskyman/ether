// Единый набор иконок «Эфира»: линейные, сетка 24×24, штрих 1.8 со скруглениями (как Lucide/Phosphor Regular).
// Все иконки рисуются через currentColor, поэтому подчиняются теме/состоянию кнопки.
// Использование: в разметке — <svg class="ico" data-icon="chat" width="20" height="20"></svg> (заполняется Icons.hydrate),
// в строках JS — Icons.html("chat", 20).
(function (root) {
  "use strict";
  // Значения — содержимое <svg>. Имена с префиксом "fill:" рисуются заливкой (play/pause/stop).
  const SET = {
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.2-4.7A8 8 0 1 1 21 12z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-.5A5.5 5.5 0 0 1 8 14h2a5.5 5.5 0 0 1 5.5 5.5v.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3a5.5 5.5 0 0 1 3.5 5.2v.5"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
    "chevron-right": '<path d="m9 6 6 6-6 6"/>',
    "chevron-left": '<path d="m15 6-6 6 6 6"/>',
    "chevron-up": '<path d="m6 15 6-6 6 6"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    phone: '<path d="M21 16.5v2.7a2 2 0 0 1-2.2 2A18.5 18.5 0 0 1 2.8 5.2 2 2 0 0 1 4.8 3h2.7a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.4 2.1L8.6 10.6a14.5 14.5 0 0 0 4.8 4.8l1.2-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.6 2.6.7a2 2 0 0 1 1.7 2z"/>',
    video: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m21.5 8.5-6 3.5 6 3.5z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    pin: '<path d="M9 3.5h6l-.8 5.5 3 3.2v1.8H6.8v-1.8l3-3.2zM12 14v6.5"/>',
    reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 7 7v2"/>',
    forward: '<path d="m15 14 5-5-5-5"/><path d="M20 9h-9a7 7 0 0 0-7 7v2"/>',
    send: '<path d="M21.5 2.5 10.5 13.5"/><path d="M21.5 2.5 14.5 21.5l-4-8-8-4z"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    "mic-off": '<path d="m3 3 18 18"/><path d="M9 9v2a3 3 0 0 0 5 2.2M15 9.5V6a3 3 0 0 0-5.7-1.3"/><path d="M5.5 11a6.5 6.5 0 0 0 10.7 5M12 17.5V21"/>',
    play: '<path d="M7.5 4.5v15l12-7.5z"/>',
    pause: '<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10 11v6M14 11v6"/>',
    edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="m14 6 4 4"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    hourglass: '<path d="M6.5 3h11M6.5 21h11M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/>',
    star: '<path d="m12 3.2 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.2l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.8 2H4.2z"/><path d="M10 21h4"/>',
    "bell-off": '<path d="M6 16v-5a6 6 0 0 1 9.5-4.9M18 11v5l1.8 2H8"/><path d="M10 21h4M3 3l18 18"/>',
    archive: '<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
    warning: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    volume: '<path d="M4 9.5v5h4l5 4v-13l-5 4z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>',
    monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M8 20.5h8M12 16.5v4"/>',
    more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14s1.3 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01"/>',
    paperclip: '<path d="m20.5 11.5-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8"/>',
    camera: '<path d="M4 7.5h3L8.7 5h6.6L17 7.5h3a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.2" r="3.7"/>',
    file: '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
    poll: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
    board: '<rect x="3" y="4" width="5.5" height="16" rx="1.5"/><rect x="9.8" y="4" width="5.5" height="10" rx="1.5"/><rect x="16.5" y="4" width="4.5" height="13" rx="1.5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    flip: '<path d="M4 8V5.5h2.5M20 16v2.5h-2.5"/><path d="M5 9.5A8 8 0 0 1 19 8M19 14.5A8 8 0 0 1 5 16"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    download: '<path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 20h14"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.4 17 3 12 3z"/><path d="M7.5 11h.01M10 7.5h.01M14.5 7.5h.01"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
    text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    "grip": '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>'
  };
  const FILLED = new Set(["play", "pause", "stop", "more", "grip"]);
  function inner(name) { return SET[name] || SET.info; }
  function attrs(name, size, cls) {
    const filled = FILLED.has(name);
    return 'class="ico' + (filled ? " ico-fill" : "") + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false"';
  }
  // Готовая разметка для вставки в строки JS
  function html(name, size, cls) { return "<svg " + attrs(name, size || 20, cls) + ' data-icon="' + name + '">' + inner(name) + "</svg>"; }
  // Заполняет <svg data-icon="..."> в статической разметке (и в любом динамически добавленном корне)
  function hydrate(rootEl) {
    const scope = rootEl || (typeof document !== "undefined" ? document : null); if (!scope) return;
    scope.querySelectorAll("svg[data-icon]").forEach((el) => {
      const name = el.getAttribute("data-icon");
      if (el.dataset.icoDone === name) return;
      el.setAttribute("viewBox", "0 0 24 24");
      el.setAttribute("aria-hidden", "true"); el.setAttribute("focusable", "false");
      el.classList.add("ico"); el.classList.toggle("ico-fill", FILLED.has(name));
      el.innerHTML = inner(name); el.dataset.icoDone = name;
    });
  }
  function names() { return Object.keys(SET); }
  const api = { html, hydrate, names, has: (n) => Object.prototype.hasOwnProperty.call(SET, n) };
  root.Icons = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document !== "undefined") { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => hydrate()); else hydrate(); }
})(typeof window !== "undefined" ? window : globalThis);
