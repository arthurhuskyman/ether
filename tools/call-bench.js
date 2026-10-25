#!/usr/bin/env node
// Синтетический замер звонка: две страницы Chromium (fake media) -> звонок по ссылке через локальный signaling-server,
// 20 секунд getStats(), на выходе JSON: битрейт, fps, джиттер, потери, кодек, RTT, тип пути.
// ВАЖНО: это loopback на одной машине. Он проверяет, что звонок поднимается и адаптация/кодеки работают, но НЕ измеряет
// качество в реальных сетях (для них см. docs/CALL-QUALITY.md).
// Запуск: node tools/call-bench.js [--seconds 20] [--video] [--out file.json] [--relay]
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true); };
const SECONDS = +arg("seconds", 20) || 20, VIDEO = !!arg("video", false), RELAY = !!arg("relay", false), OUT = arg("out", null);
const PW = process.env.PLAYWRIGHT_DIR || "/opt/node-tools/node_modules/playwright";
const CHROME = process.env.CHROME_BIN || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

function staticServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
      const f = path.join(ROOT, path.normalize(p));
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
    }).listen(0, "127.0.0.1", () => resolve(s));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 200) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(step); } return false; }

async function main() {
  const { chromium } = require(PW);
  const web = await staticServer(), WEB = web.address().port, SIG = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(ROOT, "signaling-server", "server.js")], { env: { ...process.env, PORT: String(SIG), VAPID_PUBLIC: "", VAPID_PRIVATE: "", CLAIMS_PERSIST: "0", MAILBOX_PERSIST: "0", ALIASES_PERSIST: "0", TRUST_PROXY: "", LINKCALL_JOIN_CODE_PER_MIN: "100", LINKCALL_JOIN_ROOM_PER_MIN: "100", LINKCALL_CREATE_PER_MIN: "100" }, stdio: "ignore" });
  await sleep(1200);
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const result = { note: "loopback на одной машине, не реальная сеть", seconds: SECONDS, video: VIDEO, relay: RELAY };
  const mkPage = async (name, id) => {
    const ctx = await browser.newContext({ serviceWorkers: "block", permissions: ["microphone", "camera"] });
    await ctx.addInitScript(({ name, id, sig, relay }) => { try { localStorage.setItem("ether.name", name); localStorage.setItem("ether.myId", id); localStorage.setItem("ether.lang", "en"); localStorage.setItem("ether.signalingUrl", "ws://localhost:" + sig); if (relay) localStorage.setItem("ether.hideIpInCalls", "1"); } catch (e) {} }, { name, id, sig: SIG, relay: RELAY });
    return ctx.newPage();
  };
  try {
    const A = await mkPage("Bench A", "bench-a-" + Date.now()), B = await mkPage("Bench B", "bench-b-" + Date.now());
    await A.goto(`http://localhost:${WEB}/`);
    if (!(await until(() => A.evaluate(() => typeof signaling !== "undefined" && signaling && signaling.registered === true), 20000))) throw new Error("A не зарегистрировался на signaling");
    await A.evaluate(() => { window.__clip = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__clip.push(t); } } }); Object.defineProperty(navigator, "share", { configurable: true, value: undefined }); });
    await A.evaluate(() => linkCallCreateAndShare({}));
    if (!(await until(() => A.evaluate(() => window.__clip.length > 0), 10000))) throw new Error("ссылка звонка не создана");
    const link = (await A.evaluate(() => window.__clip[0])).match(/#call=[A-Za-z0-9_.-]+/)[0];
    await B.goto(`http://localhost:${WEB}/${link}`);
    const t0 = Date.now();
    const active = (P) => P.evaluate(() => state.callPhase === "active").catch(() => false);
    // гостю может понадобиться нажать «принять»/«присоединиться» — пробуем типичные кнопки
    const ok = await until(async () => {
      for (const sel of ["#linkcall-join", "#linkcall-join-btn", "#call-accept-btn", "#call-answer"]) { try { const el = await B.$(sel); if (el && (await el.isVisible())) await el.click({ timeout: 500 }); } catch (e) {} }
      try { const el = await A.$("#call-accept-btn"); if (el && (await el.isVisible())) await el.click({ timeout: 500 }); } catch (e) {}
      return (await active(A)) && (await active(B));
    }, 40000, 500);
    if (!ok) throw new Error("звонок не перешёл в active за 40 с (A=" + (await A.evaluate(() => state.callPhase)) + ", B=" + (await B.evaluate(() => state.callPhase)) + ")");
    result.setupMs = Date.now() - t0;
    if (VIDEO) for (const P of [A, B]) await P.evaluate(() => mesh.get(state.callId).enableVideo()).catch(() => {});
    const sample = (P) => P.evaluate(async () => {
      const l = mesh.get(state.callId); if (!l || !l.pc) return null;
      const st = await l.pc.getStats(), CQ = window.EtherCallQuality;
      window.__bprev = window.__bprev || null;
      const s = CQ.extractSample(st, window.__bprev); window.__bprev = s.raw;
      let inKbps = null, inFps = null, w = null, h = null;
      const inb = { b: 0, t: 0 };
      st.forEach((r) => { if (r.type === "inbound-rtp") { inb.b += r.bytesReceived || 0; inb.t = Math.max(inb.t, r.timestamp); if ((r.kind || r.mediaType) === "video") { inFps = r.framesPerSecond; w = r.frameWidth; h = r.frameHeight; } } });
      const prev = window.__binb; window.__binb = inb;
      if (prev && inb.t > prev.t) inKbps = (inb.b - prev.b) * 8 / (inb.t - prev.t);
      return { rttMs: s.rttMs, jitterMs: s.jitterMs, lossPct: s.lossPct, outKbps: s.outKbps, inKbps, fps: s.fps, inFps, res: w ? w + "x" + h : null, audioCodec: s.audioCodec, videoCodec: s.videoCodec, path: s.pathType, pair: s.pairType, availKbps: s.availBps ? Math.round(s.availBps / 1000) : null, qualityLevel: l._qc ? l._qc.level : null };
    });
    const rows = { A: [], B: [] };
    for (let i = 0; i < SECONDS; i++) { await sleep(1000); const [a, b] = await Promise.all([sample(A), sample(B)]); if (i > 0) { if (a) rows.A.push(a); if (b) rows.B.push(b); } }
    const avg = (arr, k) => { const v = arr.map((x) => x[k]).filter((x) => typeof x === "number" && isFinite(x)); return v.length ? Math.round(v.reduce((p, c) => p + c, 0) / v.length * 100) / 100 : null; };
    const max = (arr, k) => { const v = arr.map((x) => x[k]).filter((x) => typeof x === "number" && isFinite(x)); return v.length ? Math.round(Math.max(...v) * 100) / 100 : null; };
    const last = (arr, k) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i][k] != null) return arr[i][k]; return null; };
    for (const side of ["A", "B"]) {
      const r = rows[side];
      result[side] = { samples: r.length, outKbpsAvg: avg(r, "outKbps"), inKbpsAvg: avg(r, "inKbps"), fpsAvg: avg(r, "fps"), inFpsAvg: avg(r, "inFps"), resolution: last(r, "res"), jitterMsAvg: avg(r, "jitterMs"), jitterMsMax: max(r, "jitterMs"), lossPctAvg: avg(r, "lossPct"), rttMsAvg: avg(r, "rttMs"), audioCodec: last(r, "audioCodec"), videoCodec: last(r, "videoCodec"), path: last(r, "path"), pair: last(r, "pair"), qualityLevel: last(r, "qualityLevel") };
    }
  } catch (e) { result.error = String(e && e.message || e); process.exitCode = 1; }
  finally { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { web.close(); } catch (e) {} }
  const json = JSON.stringify(result, null, 2);
  if (OUT && OUT !== true) fs.writeFileSync(OUT, json);
  console.log(json);
  process.exit(process.exitCode || 0);
}
main();
