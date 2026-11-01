// Эмуляция устройств + автоматическая проверка вёрстки.
// node tools/device-check.js <outdir> [--devices a,b] [--skins x,y] [--schemes light,dark] [--langs ru,ar] [--ui simple|full] [--shots] [--call [--kb]] [--extra] [--scale 1.6]
// --extra: редкие экраны — онбординг, шит сообщения, просмотр историй, групповой звонок, экран блокировки, видеозвонок.
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
const DEV = { se: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: devices["iPhone 14"].userAgent }, desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }, desktop1440: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } };
const devNames = opt("devices", "se,iPhone 15,Pixel 7,Galaxy S24,iPad Pro 11,desktop").split(",");
const skins = opt("skins", "default").split(","), schemes = opt("schemes", "light,dark").split(","), langs = opt("langs", "ru").split(",");
const shots = args.includes("--shots"), callMode = args.includes("--call"), wantKb = args.includes("--kb"), extra = args.includes("--extra"), wantContrast = args.includes("--contrast");
const SCALE = parseFloat(opt("scale", "1")) || 1; // Dynamic Type: множитель корневого размера шрифта (html font-size = 16px × scale)
const SCREENS = ["chats", "chat", "menu", "settings", "appearance"];
fs.mkdirSync(out, { recursive: true });

async function contrastAudit(page) {
  return page.evaluate(() => {
    const P = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
    const over = (f, b) => { const a = f[3]; return [f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a), 1]; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05 && !e.closest(".hidden,[hidden],[aria-hidden=true],#skin-deco,svg,.tab-pane:not(.active)"); };
    const id = (e) => e.id ? "#" + e.id : (e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""));
    const out = [];
    for (const e of document.querySelectorAll("body *")) {
      let txt = ""; for (const n of e.childNodes) if (n.nodeType === 3) txt += n.textContent; txt = txt.trim(); if (!txt || !vis(e) || e.closest(".avatar,.fx-av,.avatar-xl,.gcall-avatar,.egg,#fx-root,#call-screen,#story-viewer,#lock-screen")) continue;
      const r = e.getBoundingClientRect(); if (r.right < 0 || r.left > innerWidth || r.bottom < 0) continue;
      const s = getComputedStyle(e); let fg = P(s.color); if (!fg) continue;
      // фон: собираем стек от предка вниз; градиент -> набор вариантов
      const chain = []; for (let x = e; x; x = x.parentElement) chain.push(x);
      let variants = [[255, 255, 255, 0]];
      let stack = []; let unk = false;
      for (const x of chain) { const cs = getComputedStyle(x); const bg = P(cs.backgroundColor); const gi = cs.backgroundImage; stack.push({ bg, gi }); if (/url\(/.test(gi) || /radial-gradient/.test(gi)) unk = true; if (bg && bg[3] === 1 && gi === "none") break; if (gi !== "none" && /gradient/.test(gi) && bg && bg[3] === 1) break; }
      // от дальнего к ближнему
      let bases = [[0, 0, 0, 1]];
      for (let i = stack.length - 1; i >= 0; i--) {
        const { bg, gi } = stack[i]; let nb = [];
        let layers = [];
        if (gi !== "none") { const cols = (gi.match(/rgba?\([^)]+\)/g) || []).map(P).filter(Boolean); if (cols.length) layers = cols; }
        for (const b of bases) {
          let cur = b; if (bg && bg[3] > 0) cur = over(bg, cur);
          if (layers.length) for (const l of layers) nb.push(l[3] > 0 ? over(l, cur) : cur); else nb.push(cur);
        }
        bases = nb.slice(0, 6);
      }
      if (unk) continue;
      let worst = 99, wb = null;
      for (const b of bases) { const f = over(fg, b); const c = cr(f, b); if (c < worst) { worst = c; wb = b; } }
      const fs = parseFloat(s.fontSize), big = fs >= 24 || (fs >= 18.66 && +s.fontWeight >= 700);
      const need = big ? 3 : 4.5;
      if (worst < need) out.push({ el: id(e), txt: txt.slice(0, 22), ratio: +worst.toFixed(2), fg: s.color, bg: wb && wb.map(Math.round).join(","), fs });
    }
    return { contrast: out };
  });
}

async function audit(page) {
  return page.evaluate(() => {
    const vw = innerWidth, res = { overflowDoc: document.documentElement.scrollWidth > vw + 1, offscreen: [], clipped: [], small: [] };
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !e.closest(".hidden,[hidden],[aria-hidden=true]"); };
    const id = (e) => e.id ? "#" + e.id : (e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""));
    // Намеренные горизонтальные прокрутки (ряд чипов и т.п.): их содержимое за краем экрана — не дефект.
    const inHScroll = (e) => { for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) { if (/auto|scroll/.test(getComputedStyle(x).overflowX) && x.scrollWidth > x.clientWidth + 1) return true; } return false; };
    // Видимая часть рамки: пересечение с рамками предков, обрезающих содержимое (overflow не visible).
    const visRect = (e) => { let r = e.getBoundingClientRect(); let L = r.left, T = r.top, R = r.right, B = r.bottom; for (let x = e.parentElement; x && x !== document.body && x !== document.documentElement; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.overflowX === "visible" && cs.overflowY === "visible") continue; const q = x.getBoundingClientRect(); if (cs.overflowX !== "visible") { L = Math.max(L, q.left); R = Math.min(R, q.right); } if (cs.overflowY !== "visible") { T = Math.max(T, q.top); B = Math.min(B, q.bottom); } } return { left: L, top: T, right: R, bottom: B }; };
    for (const e of document.querySelectorAll("body *")) {
      if (!vis(e) || e.closest("svg,.deco,[class*=deco],.onboarding-glow,#fx-root,.egg")) continue;
      const r = e.getBoundingClientRect();
      if ((r.right > vw + 2 || r.left < -2) && !e.closest("[class*=carousel],.swipe-actions,.chat-row-actions,.onboarding-slides,.tab-pane:not(.active)") && !inHScroll(e) && !e.classList.contains("sr-only") && res.offscreen.length < 15) res.offscreen.push(id(e) + " " + Math.round(r.left) + ".." + Math.round(r.right));
      const s = getComputedStyle(e);
      if (e.children.length === 0 && e.textContent.trim() && !e.classList.contains("sr-only") && /hidden|clip/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 2 && s.textOverflow !== "ellipsis" && res.clipped.length < 15) res.clipped.push(id(e) + " " + e.textContent.trim().slice(0, 24));
      if (/^(BUTTON|A|INPUT|SELECT)$/.test(e.tagName) || e.getAttribute("role") === "button") { const pa = getComputedStyle(e, '::after'); const lbl = e.tagName === "INPUT" && e.closest("label"); const lr = lbl && lbl.getBoundingClientRect(); const bigHit = (lr && lr.height >= 40) || pa.position === 'absolute' && pa.content !== 'none' && parseFloat(pa.width) >= 32 && parseFloat(pa.height) >= 32; if ((r.width < 32 || r.height < 32) && !bigHit && res.small.length < 15 && e.type !== "hidden" && e.type !== "checkbox" && e.type !== "radio") res.small.push(id(e) + " " + Math.round(r.width) + "x" + Math.round(r.height)); }
    }
    // Наложения: пары видимых интерактивных элементов, чьи рамки (или рамки их текста) пересекаются, хотя ни один не вложен в другой.
    // Ловит «вкладки налезают друг на друга» (длинные подписи без ellipsis) и перекрытие композера плавающими панелями.
    res.overlap = [];
    const inter = Array.from(document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=tab], .chat-filter-chip, .tab-btn")).filter((e) => vis(e) && !e.closest("svg,#fx-root,.egg,[class*=deco]") && getComputedStyle(e).position !== "fixed" || (vis(e) && e.id === "mini-call-bar"));
    // рамка текста обрезается рамкой самого элемента: текст с ellipsis/overflow:hidden за пределы своей кнопки не выходит
    const textRect = (e) => { try { const rg = document.createRange(); rg.selectNodeContents(e); const r = rg.getBoundingClientRect(); if (!r.width) return null; const b = e.getBoundingClientRect(); return { left: Math.max(r.left, b.left), right: Math.min(r.right, b.right), top: Math.max(r.top, b.top), bottom: Math.min(r.bottom, b.bottom) }; } catch (x) { return null; } };
    const bar = (e) => e.closest("#tab-bar,#nav-bar"), inScreen = (e) => e.closest(".screen,#content");
    const hit = (a, b) => a && b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
    for (let i = 0; i < inter.length; i++) for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i], b = inter[j]; if (a.contains(b) || b.contains(a) || res.overlap.length >= 15) continue;
      if (a.closest(".sheet,.anchored-menu") || b.closest(".sheet,.anchored-menu") || (bar(a) && inScreen(b) && !b.closest("#call-screen")) || (bar(b) && inScreen(a) && !a.closest("#call-screen"))) continue; // шторки и прокручиваемый контент под шапкой/таб-баром — не наложение
      const ra = visRect(a), rb = visRect(b); if (!hit(ra, rb)) continue; // обрезанное прокруткой/overflow не считается
      if (hit(a.getBoundingClientRect(), b.getBoundingClientRect()) || hit(textRect(a), b.getBoundingClientRect()) || hit(a.getBoundingClientRect(), textRect(b)) || hit(textRect(a), textRect(b))) res.overlap.push(id(a) + " × " + id(b));
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
    await ctx.addInitScript(([skin, scheme, lang, uiMode]) => { try { if (!localStorage.getItem("__init")) { localStorage.setItem("__init", "1"); localStorage.setItem("ether.skin", skin); localStorage.setItem("ether.theme", scheme); localStorage.setItem("ether.lang", lang); if (uiMode === "simple" || uiMode === "full") localStorage.setItem("ether.uiMode", uiMode); } } catch (e) {} }, [skin, scheme, lang, opt("ui", "")]);
    const page = await ctx.newPage(); const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: "load" }); if (SCALE !== 1) await page.addStyleTag({ content: `html{font-size:${16 * SCALE}px !important}` }); await page.waitForTimeout(1200);
    const tag = `${dn.replace(/ /g, "_")}-${skin}-${scheme}-${lang}` + (SCALE !== 1 ? `-x${Math.round(SCALE * 100)}` : "");
    const rec = async (name) => {
      await page.waitForTimeout(350);
      const a = await audit(page).catch((e) => ({ error: e.message }));
      if (wantContrast) Object.assign(a, await contrastAudit(page).catch(() => ({})));
      report.push({ tag, screen: name, ...a });
      if (shots) await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
    };
    if (extra) await rec("onboarding");
    try {
      await page.click('[data-slide="0"] .onboarding-next'); await page.waitForTimeout(250);
      await page.fill("#onboarding-name", "Аня"); await page.click('[data-slide="1"] button[type=submit]'); await page.waitForTimeout(1200);
      await page.click("#onboarding-start-btn").catch(() => {}); await page.waitForTimeout(900);
      await page.evaluate(() => {
        createDemoChat(); const c = state.contacts.get(DEMO_CHAT_ID); const now = Date.now();
        c.messages.push({ id: "m1", from: "me", text: "Привет! Как дела?", ts: now - 60000, ack: "read" }, { id: "m2", from: "them", text: "Отлично, смотри какой скин 😀", ts: now - 50000, readAckSent: true, reactions: { "👍": ["x"] } }, { id: "m3", from: "me", text: "Длинное сообщение, чтобы увидеть перенос строк и форму пузыря целиком, а также время и галочки, и ещё несколько слов, чтобы строка точно переносилась.", ts: now - 40000, ack: "delivered" });
        for (let i = 0; i < 3; i++) { const id = "__x" + i; state.contacts.set(id, { id, name: ["Борис", "Вера", "Глеб"][i], raw: "", managed: true, status: "paired", messages: [{ id: "q" + i, from: "them", text: "Сообщение номер " + i, ts: now - i * 3600000, readAckSent: i > 0 }], lastActivity: now - i * 3600000, online: i === 0 }); }
        renderTab(); renderChatThread();
      });
    } catch (e) { errors.push("setup: " + e.message.split("\n")[0]); }
    const step = async (name, fn) => {
      try { await fn(); } catch (e) { errors.push(name + ": " + e.message.split("\n")[0]); }
      await page.waitForTimeout(350);
      const a = await audit(page).catch((e) => ({ error: e.message }));
      if (wantContrast) Object.assign(a, await contrastAudit(page).catch(() => ({})));
      report.push({ tag, screen: name, ...a });
      if (shots) await page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });
    };
    await step("chat", async () => {});
    await step("menu", async () => { await page.click("#chat-plus-btn").catch(() => {}); });
    await step("chat-more", async () => { await page.keyboard.press("Escape").catch(() => {}); await page.click("#chat-more-btn").catch(() => {}); }); // V.79: меню «⋯» (якорное)
    await step("chats", async () => { await page.keyboard.press("Escape").catch(() => {}); await page.keyboard.press("Escape").catch(() => {}); await page.evaluate(() => { try { closeChat(); } catch (e) {} }); });
    await step("settings", async () => { await page.click('.tab-btn[data-tab="settings"]'); });
    await step("appearance", async () => { await page.evaluate(() => { try { openSettingsCategory("appearance"); } catch (e) {} }); });
    if (callMode) {
      // Звонок: полный экран, свёрнутая полоска над списком/чатом/клавиатурой. Полоска не должна перекрывать композер, «+» и таб-бар.
      const fakeCall = () => page.evaluate(() => { const id = DEMO_CHAT_ID; state.callId = null; openCallScreen(id, "active"); setCallPhaseActive(); });
      await step("call-screen", async () => { await fakeCall(); });
      await step("call-guard", async () => { await page.evaluate(() => { CallGuard.lock(); }); }); // V.80.2: чёрный оверлей «Блокировка экрана»
      await page.evaluate(() => { CallGuard.unlock(); });
      await step("call-mini-list", async () => { await page.evaluate(() => { minimizeCallScreen(); state.chatId = null; renderTab(); }); });
      await step("call-mini-chat", async () => { await page.evaluate(() => { state.tab = "chats"; state.chatId = DEMO_CHAT_ID; renderTab(); }); });
      if (wantKb) await step("call-mini-chat-kb", async () => { await page.evaluate(() => { document.documentElement.classList.add("kb-open"); }); await page.focus("#chat-input").catch(() => {}); });
      await page.evaluate(() => { document.documentElement.classList.remove("kb-open"); });
      const geo = await page.evaluate(() => { const r = (q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) }; }; return { mini: r("#mini-call-bar"), header: r("#nav-bar"), input: r("#chat-input"), plus: r("#chat-plus-btn"), tab: r("#tab-bar"), vh: innerHeight }; });
      const g = geo; const bad2 = [];
      if (g.mini && g.header && g.mini.t < g.header.b - 1) bad2.push("mini выше низа шапки");
      for (const k of ["input", "plus", "tab"]) if (g.mini && g[k] && g.mini.b > g[k].t + 1 && g.mini.t < g[k].b - 1) bad2.push("mini перекрывает " + k);
      report.push({ tag, screen: "call-geometry", geo, errors: bad2 });
    }
    if (wantContrast) for (const cat of ["profile", "appearance", "privacy", "notifications", "data", "help"]) await step("set-" + cat, async () => { await page.click('.tab-btn[data-tab="settings"]').catch(() => {}); await page.evaluate((c) => { try { openSettingsCategory(c); } catch (e) {} }, cat); });
    if (extra) {
      await page.evaluate(() => { try { document.querySelectorAll(".anchored-menu,.sheet").forEach((e) => e.classList.add("hidden")); closeChat(); state.tab = "chats"; } catch (e) {} });
      await step("msg-sheet", async () => { await page.evaluate(() => { state.chatId = DEMO_CHAT_ID; state.tab = "chats"; renderTab(); renderChatThread(); openMessageSheet("m2", DEMO_CHAT_ID); }); });
      await step("msg-sheet-mine", async () => { await page.evaluate(() => { try { closeMessageSheet && closeMessageSheet(); } catch (e) {} document.querySelectorAll(".sheet").forEach((e) => e.classList.add("hidden")); openMessageSheet("m1", DEMO_CHAT_ID); }); });
      await step("story-viewer", async () => { await page.evaluate(() => { document.querySelectorAll(".sheet").forEach((e) => e.classList.add("hidden")); try { closeMessageSheet && closeMessageSheet(); } catch (e) {} state.chatId = null; renderTab(); const a0 = document.getElementById("app-shell"); if (a0) a0.style.visibility = "hidden"; const now = Date.now(); storiesList = [{ id: "s1", owner: DEMO_CHAT_ID, text: "Привет из истории! Длинный текст для проверки переноса строк", bg: 2, ts: now - 5000, seen: false }, { id: "s2", owner: DEMO_CHAT_ID, text: "Вторая", bg: 4, ts: now - 4000, seen: false }]; openStoryViewer(DEMO_CHAT_ID); }); });
      await step("story-composer", async () => { await page.evaluate(() => { try { document.getElementById("story-viewer").classList.add("hidden"); const a1 = document.getElementById("app-shell"); if (a1) a1.style.visibility = ""; if (__storyViewer && __storyViewer.timer) clearTimeout(__storyViewer.timer); __storyViewer = null; } catch (e) {} openStoryComposer(); }); });
      await step("gcall", async () => { await page.evaluate(() => { try { document.querySelectorAll("#story-composer,.story-composer,.sheet").forEach((e) => e.classList.add("hidden")); } catch (e) {} const now = Date.now(); const members = ["Борис", "Вера", "Глеб", "Аня"].map((n, i) => ({ id: "gm" + i, name: n })); state.contacts.set("__g", { id: "__g", name: "Команда", isGroup: true, managed: true, status: "paired", members: [{ id: "me", name: "Аня" }, ...members], messages: [], lastActivity: now }); GC.gid = "__g"; GC.stream = null; GC.peers = new Map(members.map((m, i) => [m.id, { name: m.name, stream: null, hasVideo: false, muted: i === 1 }])); GC.startedAt = now - 65000; gcallRenderScreen(); const a = document.getElementById("app-shell"); if (a) a.style.visibility = "hidden"; }); });
      await page.evaluate(() => { GC.gid = null; gcallRenderScreen(); const a = document.getElementById("app-shell"); if (a) a.style.visibility = ""; });
      await step("call-audio", async () => { await page.evaluate(() => { state.callId = null; openCallScreen(DEMO_CHAT_ID, "active"); setCallPhaseActive(); }); });
      await step("call-video", async () => { await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 320; c.height = 240; const g = c.getContext("2d"); g.fillStyle = "#58a"; g.fillRect(0, 0, 320, 240); g.fillStyle = "#fc6"; g.fillRect(100, 60, 120, 120); const st = c.captureStream(5); const rv = document.getElementById("call-remote-video"), lv = document.getElementById("call-local-video"); rv.srcObject = st; lv.srcObject = st; rv.classList.remove("hidden"); lv.classList.remove("hidden"); document.getElementById("call-video-overlays").classList.remove("hidden"); syncCallVideoState(); }); });
      await page.evaluate(() => { try { const rv = document.getElementById("call-remote-video"), lv = document.getElementById("call-local-video"); rv.srcObject = null; lv.srcObject = null; rv.classList.add("hidden"); lv.classList.add("hidden"); syncCallVideoState(); document.getElementById("call-screen").classList.add("hidden"); state.callId = null; } catch (e) {} });
      await step("lock", async () => { await page.evaluate(() => { showLockScreen(); }); });
      // V.79: экраны надёжности звонка и link-call
      const hideV79 = () => page.evaluate(() => { try { hideAnswerScreen(); guestPanel(false); document.querySelectorAll(".sheet,#devicecheck-sheet").forEach((e) => e.classList.add("hidden")); const d = document.getElementById("devicecheck-sheet"); if (d) d.remove(); document.documentElement.classList.remove("guest-call"); } catch (e) {} });
      await page.evaluate(() => { const l = document.getElementById("lock-screen"); if (l) l.classList.add("hidden"); });
      await step("answer-screen", async () => { await page.evaluate(() => { showAnswerScreen("__x0", "c1"); }); });
      await step("answer-ended", async () => { await page.evaluate(() => { answerSetState("ended"); }); });
      await hideV79();
      await step("guest-call", async () => { await page.evaluate(() => { document.documentElement.classList.add("guest-call"); guestPanel(true); guestPanelSet({ status: T("lc.guestHint"), name: true, join: true, close: false, sas: "" }); }); });
      await step("guest-call-sas", async () => { await page.evaluate(() => { guestPanelSet({ status: T("lc.waitingAllow"), name: false, join: false, close: true, sas: T("lc.sas", { sas: "🐶 🐱 🦊 🐻" }) }); }); });
      await hideV79();
      await step("call-noanswer", async () => { await page.evaluate(() => { state.callId = null; openCallScreen(DEMO_CHAT_ID, "calling"); document.getElementById("call-noanswer-actions").classList.remove("hidden"); }); });
      await page.evaluate(() => { try { document.getElementById("call-noanswer-actions").classList.add("hidden"); closeCallScreen("cancelled", { localError: true }); } catch (e) {} });
      await step("linkcall-wait", async () => { await page.evaluate(() => { lcShowWait({ forName: "Борис", code: "123456" }); }); });
      await hideV79();
      await step("linkcall-approve", async () => { await page.evaluate(() => { lcShowApprove({ guestName: "Гоша", sas: "🐶 🐱 🦊 🐻" }); }); });
      await hideV79();
      await step("linkcall-join", async () => { await page.evaluate(() => { lcSheet("linkcall-join-sheet", true); }); });
      await hideV79();
      await step("notifcheck", async () => { await page.evaluate(() => { DeviceCheck.openNotifCheck(); }); });
      await hideV79();
    }
    if (errors.length) report.push({ tag, screen: "errors", errors });
    await ctx.close();
  }
  await b.close(); srv.close();
  const bad = report.filter((r) => r.error || (r.overlap && r.overlap.length) || r.overflowDoc || (r.offscreen && r.offscreen.length) || (r.clipped && r.clipped.length) || (r.small && r.small.length) || (r.contrast && r.contrast.length) || (r.errors && r.errors.length));
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
  console.log(`экранов: ${report.length}, с замечаниями: ${bad.length}`);
  for (const r of bad) console.log(r.tag, r.screen, JSON.stringify({ doc: r.overflowDoc || undefined, off: r.offscreen && r.offscreen.length ? r.offscreen.slice(0, 4) : undefined, clip: r.clipped && r.clipped.length ? r.clipped.slice(0, 3) : undefined, small: r.small && r.small.length ? r.small.slice(0, 4) : undefined, overlap: r.overlap && r.overlap.length ? r.overlap.slice(0, 5) : undefined, contrast: r.contrast && r.contrast.length ? r.contrast.slice(0, 6).map((c) => c.ratio + " " + c.el + " " + c.txt) : undefined, err: r.errors || r.error }));
  process.exit(bad.length ? 1 : 0);
})();
