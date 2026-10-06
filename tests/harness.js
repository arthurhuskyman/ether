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
// Профили платформ. Подменяются только то, чем реально различаются браузеры
// (UA, наличие API); сам код приложения исполняется как есть.
const UA = {
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  desktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};
function applyPlatform(w, platform, opts) {
  const nav = w.navigator;
  const def = (o, k, v) => Object.defineProperty(o, k, { value: v, configurable: true, writable: true });
  def(nav, "userAgent", UA[platform] || UA.desktop);
  const vib = [];
  w.__vibrations = vib;
  const badges = [];
  w.__badges = badges;
  const supportedMime = (list) => (t) => list.some((m) => t === m || t.startsWith(m + ";") || m.startsWith(t));
  class FakeRecorder { constructor(stream, o) { this.stream = stream; this.mimeType = (o && o.mimeType) || ""; this.state = "inactive"; } start() { this.state = "recording"; } stop() { this.state = "inactive"; } addEventListener() {} }
  if (platform === "ios") {
    if (opts.standalone) def(nav, "standalone", true); else def(nav, "standalone", false);
    // iOS Safari: нет vibrate, нет Contact Picker, нет getDisplayMedia, PiP — только webkit-API
    def(nav, "vibrate", undefined);
    if (opts.standalone) { def(nav, "setAppBadge", async (n) => { badges.push(n); }); def(nav, "clearAppBadge", async () => { badges.push(0); }); }
    else { delete w.Notification; }
    FakeRecorder.isTypeSupported = supportedMime(["audio/mp4", "video/mp4"]);
    w.MediaRecorder = FakeRecorder;
    w.HTMLVideoElement.prototype.webkitSetPresentationMode = function (mode) { this.webkitPresentationMode = mode; (w.__pipModes = w.__pipModes || []).push(mode); };
    w.DeviceMotionEvent = class DeviceMotionEvent extends w.Event { static requestPermission() { return Promise.resolve(w.__motionPermission || "granted"); } };
    def(nav, "mediaDevices", { getUserMedia: async () => { throw new Error("replaced per test"); } });
  } else if (platform === "android") {
    def(nav, "vibrate", (p) => { vib.push(p); return true; });
    def(nav, "setAppBadge", async (n) => { badges.push(n); });
    def(nav, "clearAppBadge", async () => { badges.push(0); });
    def(nav, "contacts", { select: async () => [{ name: ["Zoe"], tel: ["+1 555 0100"] }] });
    def(nav, "share", async () => {});
    FakeRecorder.isTypeSupported = supportedMime(["audio/webm", "video/webm"]);
    w.MediaRecorder = FakeRecorder;
    w.HTMLVideoElement.prototype.requestPictureInPicture = async function () { w.document.pictureInPictureElement = this; };
    def(w.document, "pictureInPictureEnabled", true);
    w.document.exitPictureInPicture = async () => { w.document.pictureInPictureElement = null; };
    w.DeviceMotionEvent = class DeviceMotionEvent extends w.Event {}; // без requestPermission
    def(nav, "mediaDevices", { getUserMedia: async () => { throw new Error("replaced per test"); } }); // мобильный Chrome без getDisplayMedia
  } else {
    def(nav, "mediaDevices", { getUserMedia: async () => { throw new Error("replaced per test"); }, getDisplayMedia: async () => { throw new Error("replaced per test"); } });
  }
}
function createApp(opts = {}) {
  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const srcs = [];
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, s) => { srcs.push(s); return ""; });
  srcs.unshift("js/lang/en.js", "js/lang/ru.js"); // словари подключаем сразу — динамическая подгрузка <script> в jsdom не выполняется
  const fetchLog = [];
  const dom = new JSDOM(html, {
    url: opts.url || "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true,
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
      applyPlatform(w, opts.platform || "desktop", opts);
      if (opts.storage) for (const [k, v] of Object.entries(opts.storage)) w.localStorage.setItem(k, v);
      w.RTCPeerConnection = class extends wrtc.RTCPeerConnection { constructor(...args) { super(...args); PCS.push(this); } }; w.RTCSessionDescription = wrtc.RTCSessionDescription; w.RTCIceCandidate = wrtc.RTCIceCandidate;
      // Web Audio: заглушка, записывающая граф (jsdom AudioContext не имеет)
      w.__audioNodes = [];
      const mkNode = (type) => { const n = { type, connected: [], connect(t) { this.connected.push(t); return t; }, disconnect() { this.connected = []; } }; w.__audioNodes.push(n); return n; };
      if (!opts.noAudioContext) {
        w.MediaStreamAudioDestinationNode = class {};
        w.AudioContext = class { constructor() { this.state = opts.suspendedAudio ? "suspended" : "running"; this.destination = {}; w.__audioCtx = this; this.resumed = 0; }
          resume() { this.resumed++; this.state = "running"; return Promise.resolve(); }
          createMediaStreamSource(stream) { const n = mkNode("source"); n.stream = stream; return n; }
          createMediaStreamDestination() { const n = mkNode("dest"); n.stream = { id: "dest-stream", getTracks: () => [], getAudioTracks: () => [] }; return n; }
          createGain() { const n = mkNode("gain"); n.gain = { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }; return n; }
          createBuffer(ch, len) { const d = new Float32Array(len); return { getChannelData: () => d, length: len }; }
          createBufferSource() { const n = mkNode("bufsrc"); n.start = () => {}; n.stop = () => {}; return n; }
          createBiquadFilter() { const n = mkNode("biquad"); n.frequency = { value: 0 }; n.Q = { value: 0 }; return n; }
          get sampleRate() { return 44100; }
          createOscillator() { const n = mkNode("osc"); n.frequency = { value: 0, setValueAtTime() {} }; n.start = () => {}; n.stop = () => {}; return n; }
          createAnalyser() { const n = mkNode("analyser"); n.fftSize = 0; n.getByteFrequencyData = () => {}; return n; }
          get currentTime() { return 0; } };
      }
      w.MediaStream = wrtc.MediaStream;
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
// Создаёт окно и дожидается, пока приложение реально стартует (startApp).
async function bootApp(opts = {}) {
  const storage = { "ether.name": "Tester", "ether.myId": "me-test-id", "ether.lang": "en", ...(opts.storage || {}) };
  const a = createApp({ ...opts, storage });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}
module.exports = { createApp, bootApp, closeAll, ROOT };
