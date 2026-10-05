// Загружает РЕАЛЬНЫЕ index.html + js/*.js в jsdom (без пересказа логики
// в тесте), подставляя только те браузерные API, которых нет в jsdom.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const { webcrypto } = require("node:crypto");

const wrtc = require("@roamhq/wrtc");
const ROOT = path.resolve(__dirname, "..");

const APPS = [];
const PCS = []; // настоящие RTCPeerConnection держат процесс живым — закрываем в closeAll()
// Окна закрываем только после того, как отработал их асинхронный boot
// (DOMContentLoaded → initBoot), иначе он падает на уже исчезнувшем document.
async function closeAll() {
  await new Promise((r) => setTimeout(r, 300));
  for (const pc of PCS.splice(0)) { try { pc.close(); } catch (e) {} }
  for (const d of APPS.splice(0)) { try { d.window.close(); } catch (e) {} }
}
function createApp(opts = {}) {
  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const srcs = [];
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, s) => { srcs.push(s); return ""; });
  srcs.unshift("js/lang/en.js", "js/lang/ru.js"); // словари подключаем сразу — динамическая подгрузка <script> в jsdom не выполняется
  const fetchLog = [];
  const dom = new JSDOM(html, {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.Notification = class { static get permission() { return "denied"; } static async requestPermission() { return "denied"; } };
      Object.defineProperty(w, "crypto", { value: webcrypto, configurable: true });
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      w.indexedDB = new IDBFactory(); w.IDBKeyRange = IDBKeyRange; // свой IDB на каждое окно — без утечки состояния между тестами
      w.fetch = opts.fetch || (async (url, init) => { fetchLog.push({ url: String(url), init }); throw new Error("offline (test)"); });
      w.AbortSignal.timeout = w.AbortSignal.timeout || ((ms) => AbortSignal.timeout(ms));
      w.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} addEventListener() {} };
      w.Blob = class extends Blob { constructor(parts, o) { super((parts || []).map((p) => (ArrayBuffer.isView(p) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p)), o); } }; // Uint8Array из realm jsdom не instanceof Node-шного
       w.URL.createObjectURL = () => "blob:test"; w.URL.revokeObjectURL = () => {};
      w.requestAnimationFrame = (f) => setTimeout(f, 0);
      w.scrollTo = () => {};
      w.Element.prototype.scrollTo = function () {};
      // jsdom без пакета canvas: getContext() даёт null — подставляем безвредную заглушку
      w.HTMLCanvasElement.prototype.getContext = function () { return new Proxy({ canvas: this, measureText: () => ({ width: 0 }), getImageData: () => ({ data: [] }), createLinearGradient: () => ({ addColorStop() {} }) }, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true }); };
      w.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new Blob(["x"])); };
      w.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,AAAA";
      Object.defineProperty(w.navigator, "serviceWorker", { value: undefined, configurable: true });
      w.confirm = () => true;
      if (opts.storage) for (const [k, v] of Object.entries(opts.storage)) w.localStorage.setItem(k, v);
      w.RTCPeerConnection = class extends wrtc.RTCPeerConnection { constructor(...args) { super(...args); PCS.push(this); } }; w.RTCSessionDescription = wrtc.RTCSessionDescription; w.RTCIceCandidate = wrtc.RTCIceCandidate;
      w.MediaStream = class { constructor() { this.tracks = []; } getTracks() { return this.tracks; } getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); } getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); } addTrack(t) { this.tracks.push(t); } removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); } };
      if (!process.env.ETHER_TEST_VERBOSE) for (const k of ["log", "info", "warn", "debug", "error"]) w.console[k] = () => {};
    },
  });
  const ctx = dom.getInternalVMContext();
  const errors = [];
  dom.window.addEventListener("error", (e) => errors.push(String(e.message)));
  for (const s of srcs) {
    const file = path.join(ROOT, s);
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: require("url").pathToFileURL(file).href }).runInContext(ctx);
  }
  // Доступ к лексическим (const/let/function) именам скриптов — через тот же контекст.
  const run = (code) => new vm.Script(code, { filename: "test-eval.js" }).runInContext(ctx);
  const app = { dom, window: dom.window, document: dom.window.document, run, errors, fetchLog, close() { /* окно закрывается в closeAll() в конце файла — иначе отложенные таймеры падают на уже закрытом window */ } };
  app.ready = new Promise((r) => { const done = () => setTimeout(r, 400); if (dom.window.document.readyState === "complete") done(); else dom.window.addEventListener("load", done); });
  APPS.push(dom);
  return app;
}
module.exports = { createApp, closeAll, ROOT };
