// Общие помощники для cov-*.test.js: загрузка приложения, детерминированные таймеры, ручной WebSocket.
const { createApp } = require("./harness");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.parse(JSON.stringify(x));

// jsdom без CSS.escape / CSS.supports (в настоящих браузерах есть) — подставляем минимально совместимую реализацию
function polyfill(a) {
  a.run(`if (typeof CSS === "undefined") { window.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_\\u00A0-\\uFFFF-]/g, (c) => "\\\\" + c), supports: () => false }; }`);
  // jsdom-овый File без arrayBuffer() (в браузерах есть) — читаем через FileReader
  a.run(`if (typeof File.prototype.arrayBuffer !== "function") { File.prototype.arrayBuffer = function () { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsArrayBuffer(this); }); }; }`);
  return a;
}
async function boot(opts = {}) {
  const a = createApp({ ...opts, storage: { "ether.name": "Tester", "ether.myId": "me-test-id", "ether.lang": "en", ...(opts.storage || {}) } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return polyfill(a);
}
// Фейковые таймеры внутри окна: window.__fk.tick(ms) прогоняет очередь. Date.now не подменяется.
function fakeTimers(a) {
  a.run(`(() => { const q = []; let now = 0, id = 0;
    window.__fk = { q, tick(ms) { const end = now + ms; for (;;) { q.sort((x, y) => x.at - y.at); const t = q[0]; if (!t || t.at > end) break; q.shift(); now = t.at; if (t.iv) { t.at += t.iv; q.push(t); } t.fn(); } now = end; }, pending() { return q.length; }, fireEvery(ms) { q.filter((t) => t.iv === ms).forEach((t) => t.fn()); } };
    window.__realTO = window.setTimeout; window.__realCT = window.clearTimeout;
    window.setTimeout = (fn, ms) => { const t = { id: ++id, at: now + (ms || 0), fn }; q.push(t); return t.id; };
    window.setInterval = (fn, ms) => { const t = { id: ++id, at: now + ms, iv: ms, fn }; q.push(t); return t.id; };
    window.clearTimeout = window.clearInterval = (i) => { const k = q.findIndex((t) => t.id === i); if (k >= 0) q.splice(k, 1); }; })()`);
  return { tick: (ms) => a.run(`__fk.tick(${ms})`), fireEvery: (ms) => a.run(`__fk.fireEvery(${ms})`), pending: () => a.run(`__fk.pending()`) };
}
// Управляемый WebSocket: window.__sockets — все созданные; ws.__open(), ws.__recv(obj), ws.__drop()
function fakeWebSocket(a) {
  a.run(`(() => { window.__sockets = [];
    class FWS extends EventTarget { constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; window.__sockets.push(this); }
      send(d) { if (this.__throwSend) throw new Error("send fail"); this.sent.push(JSON.parse(d)); }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
      __open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
      __recv(o) { this.dispatchEvent(new MessageEvent("message", { data: typeof o === "string" ? o : JSON.stringify(o) })); }
      __err() { this.dispatchEvent(new Event("error")); } }
    FWS.CONNECTING = 0; FWS.OPEN = 1; FWS.CLOSING = 2; FWS.CLOSED = 3; window.WebSocket = FWS; })()`);
}
module.exports = { polyfill, boot, sleep, J, fakeTimers, fakeWebSocket };
// В окне: имитация касаний (jsdom не создаёт TouchEvent с touches)
const TOUCH_JS = `window.__touch = (el, type, x, y) => { const e = new Event(type, { bubbles: true, cancelable: true }); const pt = [{ clientX: x, clientY: y, identifier: 1, target: el }]; e.touches = type === "touchend" ? [] : pt; e.changedTouches = pt; e.targetTouches = e.touches; el.dispatchEvent(e); return e; };`;
function installTouch(a) { a.run(TOUCH_JS); }
function loadLang(a, code) { const fs = require("fs"), path = require("path"); a.run(fs.readFileSync(path.join(__dirname, "..", "js", "lang", code + ".js"), "utf8")); }
module.exports.installTouch = installTouch; module.exports.loadLang = loadLang;
// Указатель (PointerEvent в jsdom может отсутствовать): обычное Event с координатами
const PTR_JS = `window.__ptr = (el, type, x, y, extra) => { const e = new Event(type, { bubbles: true, cancelable: true }); e.clientX = x; e.clientY = y; e.pointerId = 1; e.pointerType = "touch"; e.button = 0; Object.assign(e, extra || {}); el.dispatchEvent(e); return e; };`;
module.exports.installPtr = (a) => a.run(PTR_JS);
