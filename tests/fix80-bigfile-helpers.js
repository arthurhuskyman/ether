// Общие помощники тестов больших файлов (V.80): настоящая пара RTCDataChannel (wrtc), синтетические «разреженные» данные без хранения в памяти,
// фальшивый OPFS на временной папке, транспорт в формате Hub.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const wrtc = require("@roamhq/wrtc");
const BF = require("../js/bigfile.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 25) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }

const PCS = [];
async function makePair() {
  const a = new wrtc.RTCPeerConnection(), b = new wrtc.RTCPeerConnection(); PCS.push(a, b);
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
  const dcA = a.createDataChannel("control", { ordered: true });
  const dcBp = new Promise((r) => { b.ondatachannel = (e) => r(e.channel); });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  const dcB = await dcBp;
  dcA.binaryType = "arraybuffer"; dcB.binaryType = "arraybuffer";
  await until(() => dcA.readyState === "open" && dcB.readyState === "open", 10000);
  return { dcA, dcB, close() { try { a.close(); b.close(); } catch (e) {} } };
}
// Тот же контракт, что WebRTCLink.bigTransport() (js/webrtc.js), но поверх «голого» dc. gate — функция «канал закрыт шлюзом аутентификации».
function transportOf(dc, hooks = {}) {
  return {
    isOpen: () => dc.readyState === "open" && !(hooks.closed && hooks.closed()),
    sendJson: (p) => { if (dc.readyState !== "open") return false; if (hooks.onJson) hooks.onJson(p); try { dc.send(JSON.stringify(p)); return true; } catch (e) { return false; } },
    sendBinary: (b) => { if (dc.readyState !== "open") return false; if (hooks.onBinary) hooks.onBinary(b); try { dc.send(b); return true; } catch (e) { return false; } },
    bufferedAmount: () => dc.bufferedAmount,
    whenLow: (low, ms) => new Promise((res) => {
      if (dc.readyState !== "open") return res(false);
      if (dc.bufferedAmount <= low) return res(true);
      const t0 = Date.now(); const poll = setInterval(() => { if (dc.readyState !== "open") { clearInterval(poll); res(false); } else if (dc.bufferedAmount <= low) { clearInterval(poll); res(true); } else if (Date.now() - t0 > ms) { clearInterval(poll); res(false); } }, 5);
      dc.bufferedAmountLowThreshold = low;
    }),
  };
}
// Подключить Hub к dc: входящие сообщения → hub.handleJson/handleBinary. peerName — идентификатор собеседника в Hub.
function wire(hub, peerName, dc, hooks) {
  dc.onmessage = (ev) => { try { if (typeof ev.data === "string") hub.handleJson(peerName, JSON.parse(ev.data)); else hub.handleBinary(peerName, ev.data); } catch (e) { console.log("HANDLER THROW", e); } };
  hub.bind(peerName, transportOf(dc, hooks));
}

// Синтетический «файл» размера size: байты — детерминированная функция позиции и seed. slice().arrayBuffer() генерирует их на лету.
class SynthBlob {
  constructor(size, seed = 1, name = "big.bin") { this.size = size; this.seed = seed; this.name = name; this.type = "application/octet-stream"; this.off = 0; this.len = size; this.base = null; }
  slice(a, b) { const s = new SynthBlob(this.size, this.seed, this.name); s.base = this; const lo = this.off + Math.max(0, a), hi = this.off + Math.min(this.len, b); s.off = lo; s.len = Math.max(0, hi - lo); return s; }
  async arrayBuffer() { return SynthBlob.gen(this.seed, this.off, this.len).buffer; }
  static gen(seed, off, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) { const p = off + i; out[i] = ((Math.imul(p >>> 3, 2654435761) ^ Math.imul(seed, 40503) ^ (p >>> 11)) >>> ((p & 3) * 8)) & 255; }
    return out;
  }
}
function synthSha256(size, seed) { const h = crypto.createHash("sha256"); for (let o = 0; o < size; o += 4 << 20) h.update(SynthBlob.gen(seed, o, Math.min(4 << 20, size - o))); return h.digest("hex"); }
async function blobSha256(blob) { const h = crypto.createHash("sha256"); for (let o = 0; o < blob.size; o += 4 << 20) h.update(new Uint8Array(await blob.slice(o, o + (4 << 20)).arrayBuffer())); return h.digest("hex"); }

// Фальшивый OPFS: navigator.storage.getDirectory() → каталог во временной папке. Запись createWritable() кладёт данные на диск сразу (close — no-op).
function fakeOpfs(baseDir) {
  baseDir = baseDir || fs.mkdtempSync(path.join(os.tmpdir(), "ether-opfs-"));
  const state = { baseDir, writers: 0, closed: 0 };
  const dirHandle = (dir) => ({
    async getDirectoryHandle(name) { const d = path.join(dir, name); fs.mkdirSync(d, { recursive: true }); return dirHandle(d); },
    async getFileHandle(name) {
      const f = path.join(dir, name); if (!fs.existsSync(f)) fs.writeFileSync(f, "");
      return {
        async createWritable() {
          state.writers++; const fd = fs.openSync(f, "r+");
          return { async write({ position, data }) { fs.writeSync(fd, data, 0, data.byteLength, position); }, async close() { fs.closeSync(fd); state.closed++; }, async abort() { fs.closeSync(fd); } };
        },
        async getFile() { return fs.openAsBlob(f); },
      };
    },
    async removeEntry(name) { fs.rmSync(path.join(dir, name), { force: true }); },
  });
  const global = { navigator: { storage: { getDirectory: async () => dirHandle(baseDir) } } };
  return { global, state, baseDir, fileOf: (id) => path.join(baseDir, "ether-bigfile", id) };
}
function mkHub(extra = {}) {
  const events = [];
  const hub = new BF.Hub(Object.assign({ onEvent: (e) => events.push(e), order: ["memory"] }, extra));
  hub.events = events; return hub;
}
// Петля без сети: Hub напрямую вызывает методы соседа (асинхронно). sent — журнал JSON, отправленных конкретной стороной.
function loopTransport(getOther, name, log) {
  let open = true;
  return {
    isOpen: () => open, close() { open = false; },
    sendJson: (p) => { if (!open) return false; if (log) log.push(p); const o = JSON.parse(JSON.stringify(p)); setImmediate(() => getOther().handleJson(name, o)); return true; },
    sendBinary: (b) => { if (!open) return false; setImmediate(() => getOther().handleBinary(name, b.slice(0))); return true; },
    bufferedAmount: () => 0, whenLow: async () => true,
  };
}
function loopBind(S, R, logS, logR) { S.bind("R", loopTransport(() => R, "S", logS)); R.bind("S", loopTransport(() => S, "R", logR)); }
module.exports = { loopTransport, loopBind, BF, sleep, until, makePair, transportOf, wire, SynthBlob, synthSha256, blobSha256, fakeOpfs, mkHub, PCS };
