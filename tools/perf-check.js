// Замер первой загрузки: node tools/perf-check.js [skin] [--json]
// Запросы/байты, FCP, load, «интерактивность» (DOMContentLoaded + приложение отрисовало onboarding/список). Эмуляция 4G и CPU x4.
const path = require("path"), http = require("http"), fs = require("fs");
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const ROOT = path.resolve(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/json", ".mp3": "audio/mpeg" };
(async () => {
  const skin = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "default";
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(r);
  });
  await new Promise((ok) => srv.listen(0, ok));
  const url = "http://localhost:" + srv.address().port + "/";
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] }).catch(() => chromium.launch({ args: ["--no-sandbox"] }));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await ctx.addInitScript((s) => { try { localStorage.setItem("ether.skin", s); localStorage.setItem("ether.lang", "en"); } catch (e) {} }, skin);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
  page.on("console", (m) => { if (m.type() === "error" || /Content Security|CSP/i.test(m.text())) errs.push("CONSOLE " + m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const reqs = [];
  cdp.on("Network.loadingFinished", (e) => reqs.push(e));
  const urls = {}; cdp.on("Network.requestWillBeSent", (e) => { urls[e.requestId] = e.request.url; });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "load" });
  const tLoad = Date.now() - t0;
  await page.waitForSelector("#onboarding-name, #chat-list, .chat-list", { state: "attached", timeout: 30000 }).catch(() => {});
  const tUi = Date.now() - t0;
  await page.waitForTimeout(1500);
  const fcp = await page.evaluate(() => (performance.getEntriesByName("first-contentful-paint")[0] || {}).startTime || null);
  const by = {}; let total = 0;
  for (const r of reqs) { const u = (urls[r.requestId] || "").replace(url, ""); const k = u.startsWith("data:") ? "data" : (u.match(/^(css\/skins|js\/skins|fonts\/skins|js\/vendor|js\/lang|sounds|fonts|css|js|icons)/) || ["other"])[0]; by[k] = by[k] || { n: 0, kb: 0 }; by[k].n++; by[k].kb += r.encodedDataLength / 1024; total += r.encodedDataLength; }
  const out = { skin, requests: reqs.length, totalKB: Math.round(total / 1024), fcpMs: Math.round(fcp), loadMs: tLoad, uiMs: tUi, byGroup: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.n + " req / " + Math.round(v.kb) + " KB"])), errors: errs };
  console.log(JSON.stringify(out, null, 1));
  await b.close(); srv.close();
})();
