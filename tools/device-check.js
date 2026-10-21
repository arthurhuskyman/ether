// Эмуляция устройств + автоматическая проверка вёрстки.
// node tools/device-check.js <outdir> [--devices a,b] [--skins x,y] [--schemes light,dark] [--langs ru,ar] [--shots]
// Устройства — из playwright.devices (UA, вьюпорт, DPR, touch) + свои (se: 320x568, desktop: 1280x800).
// Движок только Chromium (WebKit в песочнице недоступен): iOS-специфику (safe-area, vibrate, Now Playing) это не проверяет.
// На каждый экран: горизонтальный overflow документа, элементы за правым/левым краем, обрезанный текст,
// тап-цели < 32px, отсутствующий фокус у полей. Итог — JSON + код выхода 1 при проблемах.
const path = require("path"), http = require("http"), fs = require("fs");
const { chromium, devices } = require("/opt/node-tools/node_modules/playwright");
const ROOT = path.resolve(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/json", ".wav": "audio/wav", ".mp3": "audio/mpeg" };
const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith("--") ? args[0] : ".";
const opt = (n, d) => { const i = args.indexOf("--" + n); return i < 0 ? d : args[i + 1]; };
const DEV = { se: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: devices["iPhone 14"].userAgent }, desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } };
const devNames = opt("devices", "se,iPhone 15,Pixel 7,Galaxy S24,iPad Pro 11,desktop").split(",");
const skins = opt("skins", "default").split(","), schemes = opt("schemes", "light,dark").split(","), langs = opt("langs", "ru").split(",");
const shots = args.includes("--shots");
const SCREENS = ["chats", "chat", "menu", "settings", "appearance"];
fs.mkdirSync(out, { recursive: true });

async function audit(page) {
  return page.evaluate(() => {
    const vw = innerWidth, res = { overflowDoc: document.documentElement.scrollWidth > vw + 1, offscreen: [], clipped: [], small: [] };
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !e.closest(".hidden,[hidden],[aria-hidden=true]"); };
    const id = (e) => e.id ? "#" + e.id : (e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""));
    for (const e of document.querySelectorAll("body *")) {
      if (!vis(e) || e.closest("svg,.deco,[class*=deco],#fx-root,.egg")) continue;
      const r = e.getBoundingClientRect();
      if ((r.right > vw + 2 || r.left < -2) && !e.closest("[class*=carousel],.swipe-actions,.chat-row-actions,.onboarding-slides,.tab-pane:not(.active)") && res.offscreen.length < 15) res.offscreen.push(id(e) + " " + Math.round(r.left) + ".." + Math.round(r.right));
      const s = getComputedStyle(e);
      if (e.children.length === 0 && e.textContent.trim() && /hidden|clip/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 2 && s.textOverflow !== "ellipsis" && res.clipped.length < 15) res.clipped.push(id(e) + " " + e.textContent.trim().slice(0, 24));
      if (/^(BUTTON|A|INPUT|SELECT)$/.test(e.tagName) || e.getAttribute("role") === "button") { if ((r.width < 32 || r.height < 32) && res.small.length < 15 && e.type !== "hidden" && e.type !== "checkbox" && e.type !== "radio") res.small.push(id(e) + " " + Math.round(r.width) + "x" + Math.round(r.height)); }
    }
    return res;
  });
}

(async () => {
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(r);
  });
  await new Promise((ok) => srv.listen(0, ok));
  const url = "http://localhost:" + srv.address().port + "/";
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] }).catch(() => chromium.launch({ args: ["--no-sandbox"] }));
  const report = [];
  for (const dn of devNames) for (const skin of skins) for (const scheme of schemes) for (const lang of langs) {
    const d = DEV[dn] || devices[dn]; if (!d) { console.log("нет устройства", dn); continue; }
    const ctx = await b.newContext({ ...d, serviceWorkers: "block", locale: lang === "ru" ? "ru-RU" : lang });
    await ctx.addInitScript(([skin, scheme, lang]) => { try { if (!localStorage.getItem("__init")) { localStorage.setItem("__init", "1"); localStorage.setItem("ether.skin", skin); localStorage.setItem("ether.theme", scheme); localStorage.setItem("ether.lang", lang); } } catch (e) {} }, [skin, scheme, lang]);
    const page = await ctx.newPage(); const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: "load" }); await page.waitForTimeout(1200);
    try {
      await page.click('[data-slide="0"] .onboarding-next'); await page.waitForTimeout(250);
      await page.click('[data-slide="1"] .onboarding-next'); await page.waitForTimeout(250);
      await page.fill("#onboarding-name", "Аня"); await page.click('[data-slide="2"] button[type=submit]'); await page.waitForTimeout(1200);
      await page.click("#onboarding-start-btn").catch(() => {}); await page.waitForTimeout(900);
      await page.evaluate(() => {
        createDemoChat(); const c = state.contacts.get(DEMO_CHAT_ID); const now = Date.now();
        c.messages.push({ id: "m1", from: "me", text: "Привет! Как дела?", ts: now - 60000, ack: "read" }, { id: "m2", from: "them", text: "Отлично, смотри какой скин 😀", ts: now - 50000, readAckSent: true, reactions: { "👍": ["x"] } }, { id: "m3", from: "me", text: "Длинное сообщение, чтобы увидеть перенос строк и форму пузыря целиком, а также время и галочки, и ещё несколько слов, чтобы строка точно переносилась.", ts: now - 40000, ack: "delivered" });
        for (let i = 0; i < 3; i++) { const id = "__x" + i; state.contacts.set(id, { id, name: ["Борис", "Вера", "Глеб"][i], raw: "", managed: true, status: "paired", messages: [{ id: "q" + i, from: "them", text: "Сообщение номер " + i, ts: now - i * 3600000, readAckSent: i > 0 }], lastActivity: now - i * 3600000, online: i === 0 }); }
        renderTab(); renderChatThread();
      });
    } catch (e) { errors.push("setup: " + e.message.split("\n")[0]); }
    const tag = `${dn.replace(/ /g, "_")}-${skin}-${scheme}-${lang}`;
    const step = async (name, fn) => {
      try { await fn(); } catch (e) { errors.push(name + ": " + e.message.split("\n")[0]); }
      await page.waitForTimeout(350);
      const a = await audit(page).catch((e) => ({ error: e.message }));
      report.push({ tag, screen: name, ...a });
      if (shots) await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
    };
    await step("chat", async () => {});
    await step("menu", async () => { await page.click("#chat-plus-btn").catch(() => {}); });
    await step("chats", async () => { await page.keyboard.press("Escape").catch(() => {}); await page.evaluate(() => { try { closeChat(); } catch (e) {} }); });
    await step("settings", async () => { await page.click('.tab-btn[data-tab="settings"]'); });
    await step("appearance", async () => { await page.evaluate(() => { try { openSettingsCategory("appearance"); } catch (e) {} }); });
    if (errors.length) report.push({ tag, screen: "errors", errors });
    await ctx.close();
  }
  await b.close(); srv.close();
  const bad = report.filter((r) => r.error || r.overflowDoc || (r.offscreen && r.offscreen.length) || (r.clipped && r.clipped.length) || (r.small && r.small.length) || (r.errors && r.errors.length));
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
  console.log(`экранов: ${report.length}, с замечаниями: ${bad.length}`);
  for (const r of bad) console.log(r.tag, r.screen, JSON.stringify({ doc: r.overflowDoc || undefined, off: r.offscreen && r.offscreen.length ? r.offscreen.slice(0, 4) : undefined, clip: r.clipped && r.clipped.length ? r.clipped.slice(0, 3) : undefined, small: r.small && r.small.length ? r.small.slice(0, 4) : undefined, err: r.errors || r.error }));
  process.exit(bad.length ? 1 : 0);
})();
