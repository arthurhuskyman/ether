// Скриншоты приложения в выбранном скине: node tools/skin-shots.js <skin> <light|dark> <outdir> [screens...]
// Экраны: chats, chat, settings. Поднимает статический сервер на свободном порту, мобильный вьюпорт 390x844.
const path = require("path"), http = require("http"), fs = require("fs");
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const ROOT = path.resolve(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/json", ".wav": "audio/wav", ".mp3": "audio/mpeg" };
(async () => {
  const [skin = "default", scheme = "dark", out = ".", ...screens] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(r);
  });
  await new Promise((ok) => srv.listen(0, ok));
  const url = "http://localhost:" + srv.address().port + "/";
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] }).catch(() => chromium.launch({ args: ["--no-sandbox"] }));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block", locale: "ru-RU" });
  await ctx.addInitScript(([skin, scheme]) => { try { if (!localStorage.getItem("__init")) { localStorage.setItem("__init", "1"); localStorage.setItem("ether.skin", skin); localStorage.setItem("ether.theme", scheme); localStorage.setItem("ether.lang", "ru"); } } catch (e) {} }, [skin, scheme]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const shot = async (n) => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, `${skin}-${scheme}-${n}.png`) }); };
  // онбординг → демо-чат с набором сообщений
  await page.click('[data-slide="0"] .onboarding-next'); await page.waitForTimeout(300);
  await page.click('[data-slide="1"] .onboarding-next'); await page.waitForTimeout(300);
  await page.fill("#onboarding-name", "Аня"); await page.click('[data-slide="2"] button[type=submit]'); await page.waitForTimeout(1500);
  await page.click("#onboarding-start-btn").catch(() => {}); await page.waitForTimeout(1200);
  await page.evaluate(() => {
    createDemoChat(); const c = state.contacts.get(DEMO_CHAT_ID); const now = Date.now();
    c.messages.push({ id: "m1", from: "me", text: "Привет! Как дела?", ts: now - 60000, ack: "read" }, { id: "m2", from: "them", text: "Отлично, смотри какой скин 😀", ts: now - 50000, readAckSent: true, reactions: { "👍": ["x"] } }, { id: "m3", from: "me", text: "Длинное сообщение, чтобы увидеть перенос строк и форму пузыря целиком, а также время и галочки.", ts: now - 40000, ack: "delivered" });
    for (let i = 0; i < 3; i++) { const id = "__x" + i; state.contacts.set(id, { id, name: ["Борис", "Вера", "Глеб"][i], raw: "", managed: true, status: "paired", messages: [{ id: "q" + i, from: "them", text: "Сообщение номер " + i, ts: now - i * 3600000, readAckSent: i > 0 }], lastActivity: now - i * 3600000, online: i === 0 }); }
    renderTab(); renderChatThread();
  });
  await shot("1-chat");
  await page.evaluate(() => { state.chatId = null; renderTab(); const s = document.getElementById("screen-chat"); s && s.classList.add("hidden"); });
  await page.evaluate(() => { try { closeChat(); } catch (e) {} });
  await shot("2-chats");
  await page.click('.tab-btn[data-tab="settings"]').catch(() => {}); await shot("3-settings");
  await page.evaluate(() => { try { openSettingsCategory("appearance"); } catch (e) {} }); await shot("4-appearance");
  await b.close(); srv.close();
})();
