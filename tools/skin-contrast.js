// Аудит контраста всех скинов (js/skins.js) x светлая/тёмная схема. Playwright Chromium, без сети.
//   node tools/skin-contrast.js [--skins a,b] [--schemes light,dark] [--out report.json] [--text 4.5] [--ui 3] [--verbose] [--strict] [--probe sel]
//   --strict: градиентный фон проверяется ещё и по самому светлому/тёмному стопу (а не только по среднему цвету)
// Скины берутся из Skins.LIST самого приложения, поэтому новые скины подхватываются автоматически.
// Для каждого экрана (чат с набором сообщений, шторки, меню, баннеры, список чатов, настройки) считает WCAG-контраст:
//  - каждого видимого текстового узла (и placeholder) с эффективным фоном (предки, альфа, градиент -> средний цвет);
//  - иконок (svg) и значков с фоном (порог --ui, 3:1).
// Итог: сгруппированный список нарушений, код выхода 1 при наличии. Математика — tools/skin-contrast-lib.js.
const path = require("path"), http = require("http"), fs = require("fs");
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const ROOT = path.resolve(__dirname, "..");
const LIB = fs.readFileSync(path.join(__dirname, "skin-contrast-lib.js"), "utf8");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/json", ".wav": "audio/wav", ".mp3": "audio/mpeg" };
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i < 0 ? d : args[i + 1]; };
const TEXT_MIN = parseFloat(opt("text", "4.5")), UI_MIN = parseFloat(opt("ui", "3")), verbose = args.includes("--verbose");
const outFile = opt("out", ""), probe = opt("probe", ""), strict = args.includes("--strict"); // --probe <css-селектор>: напечатать контраст всех подходящих элементов, даже проходящих

// Выполняется в странице: возвращает список нарушений на текущем экране
function pageAudit({ TEXT_MIN, UI_MIN, probe, strict }) {
  const SC = window.SkinContrast;
  const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  const col = (s) => {
    if (cache.has(s)) return cache.get(s);
    let c = SC.parseColor(s);
    if (!c) { try { cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = s; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; c = [d[0], d[1], d[2], d[3] / 255]; } catch (e) { c = null; } }
    cache.set(s, c); return c;
  };
  const COLRE = /(?:rgba?|color|oklab|oklch|lab|lch|hsla?|hwb)\((?:[^()]|\([^()]*\))*\)|#[0-9a-f]{3,8}\b/gi;
  const splitTop = (s) => { const out = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const base = (() => { const h = col(getComputedStyle(document.documentElement).backgroundColor), b = col(getComputedStyle(document.body).backgroundColor); let acc = SC.over(h || [0, 0, 0, 0], [255, 255, 255, 1]); if (b && b[3] > 0) acc = SC.over(b, acc); return [acc[0], acc[1], acc[2], 1]; })();
  // слои элемента сверху вниз: градиенты (средний цвет), затем цвет фона
  function elLayers(cs) {
    const out = [];
    if (cs.backgroundImage && cs.backgroundImage !== "none") for (const part of splitTop(cs.backgroundImage)) {
      if (!/gradient/.test(part)) continue; // url() — декоративные текстуры, под ними всё равно лежит цвет
      const m = (part.match(COLRE) || []).map(col).filter(Boolean); const mc = SC.meanColor(m); if (mc) { if (m.length > 1) mc.stops = m; out.push(mc); }
    }
    const bg = col(cs.backgroundColor); if (bg && bg[3] > 0) out.push(bg);
    return out;
  }
  function bgFor(el) {
    const layers = []; let opacity = 1;
    for (let x = el; x && x.nodeType === 1; x = x.parentElement) {
      const cs = getComputedStyle(x); opacity *= parseFloat(cs.opacity);
      const ls = elLayers(cs); let solid = false;
      for (const l of ls) { layers.push(l); if (l[3] >= 0.99) { solid = true; break; } }
      if (solid) break;
    }
    const bg = SC.composite(layers, base);
    // --strict: тот же фон, но градиент ближайшего слоя заменён своим самым светлым и самым тёмным стопом (текст может лежать у края)
    let alts = [];
    if (strict) { const gi = layers.findIndex((l) => l.stops); if (gi >= 0) { const st = layers[gi].stops.slice().sort((p, q) => SC.luminance(p) - SC.luminance(q)); for (const c of [st[0], st[st.length - 1]]) { const L2 = layers.slice(); L2[gi] = c[3] > 0 ? c : [0, 0, 0, 0]; alts.push(SC.composite(L2, base)); } } }
    return { bg, alts, opacity };
  }
  const desc = (e) => { const f = (x) => x.tagName.toLowerCase() + (x.id ? "#" + x.id : "") + (typeof x.className === "string" && x.className.trim() ? "." + x.className.trim().split(/\s+/).slice(0, 2).join(".") : ""); let s = f(e), p = e.parentElement, n = 0; while (p && n < 2 && p !== document.body) { if (p.id || (typeof p.className === "string" && p.className.trim())) { s = f(p) + " > " + s; n++; } p = p.parentElement; } return s; };
  const SKIP = "#skin-deco,.sr-only,[aria-hidden=true],.hidden,[hidden],#fx-root,.egg,script,style,noscript";
  const visible = (e, r) => {
    if (r.width <= 0 || r.height <= 0) return false;
    for (let x = e; x && x.nodeType === 1; x = x.parentElement) { const s = getComputedStyle(x); if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) < 0.05) return false; }
    if (e.closest(SKIP)) return false;
    // не перекрыт чужим слоем (шторка/оверлей поверх): проверяем точку в центре
    const px = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), py = r.top + r.height / 2;
    if (py < 0 || py >= innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const t = document.elementFromPoint(px, py); if (!t) return false;
    return t === e || e.contains(t) || t.contains(e);
  };
  const res = [];
  const push = (kind, e, fg, bg, ratio, need, extra) => res.push(Object.assign({ kind, el: desc(e), ratio: +ratio.toFixed(2), need, fg: fg.map(Math.round).join(","), bg: bg.map(Math.round).slice(0, 3).join(",") }, extra));
  // --- текст
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const txt = n.textContent.trim(); const e = n.parentElement; if (!txt || !e || seen.has(e)) continue;
    if (/^(SCRIPT|STYLE|NOSCRIPT|OPTION|TEXTAREA)$/.test(e.tagName)) continue;
    seen.add(e);
    const r = e.getBoundingClientRect(); if (!visible(e, r)) continue;
    if (e.closest("button:disabled,[disabled],[aria-disabled=true]")) continue;
    const cs = getComputedStyle(e);
    let fgS = cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color; const fg = col(fgS); if (!fg || fg[3] === 0) continue;
    const { bg, alts, opacity } = bgFor(e);
    const px = parseFloat(cs.fontSize), large = SC.isLarge(px, +cs.fontWeight || 400);
    const need = large ? UI_MIN : TEXT_MIN; let ratio = SC.textRatio(fg, bg, opacity);
    for (const a of alts) ratio = Math.min(ratio, SC.textRatio(fg, a, opacity));
    if (ratio < need) push("text", e, fg, bg, ratio, need, { txt: txt.slice(0, 28), fs: px });
    else if (probe && e.matches(probe)) push("probe", e, fg, bg, ratio, need, { txt: txt.slice(0, 28), fs: px });
  }
  // --- placeholder
  for (const e of document.querySelectorAll("input,textarea")) {
    if (!e.getAttribute("placeholder") || e.value) continue; const r = e.getBoundingClientRect(); if (!visible(e, r)) continue;
    const ph = getComputedStyle(e, "::placeholder"); const fg = col(ph.color); if (!fg) continue; const { bg } = bgFor(e);
    const ratio = SC.textRatio(fg, bg, parseFloat(ph.opacity) || 1); if (ratio < TEXT_MIN) push("placeholder", e, fg, bg, ratio, TEXT_MIN, { txt: e.getAttribute("placeholder").slice(0, 28) });
  }
  // --- иконки (svg) и границы
  for (const s of document.querySelectorAll("svg")) {
    const r = s.getBoundingClientRect(); if (r.width < 10 || !visible(s, r)) continue;
    if (s.closest("button:disabled,[disabled],[aria-disabled=true],.avatar,.fx-av,.story-ring")) continue;
    const cs = getComputedStyle(s); let fgS = cs.fill && cs.fill !== "none" ? cs.fill : (cs.stroke && cs.stroke !== "none" ? cs.stroke : null); if (!fgS) continue;
    // иконка-ориентир: у path/g может быть свой fill (например, цветной смайл) — берём только цвета, заданные от currentColor
    const fg = col(fgS); if (!fg || fg[3] === 0) continue;
    if (s.querySelector("[fill]:not([fill=none]):not([fill=currentColor])")) continue; // многоцветные иллюстрации
    const { bg, opacity } = bgFor(s.parentElement || s); const ratio = SC.textRatio(fg, bg, opacity * (parseFloat(cs.opacity) || 1));
    if (ratio < UI_MIN) push("icon", s, fg, bg, ratio, UI_MIN, {});
  }
  // поля ввода: заливка или рамка должны отделять поле от фона (3:1 — только если поле без видимой границы нет вообще)
  for (const e of document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=file]),textarea,select")) {
    const r = e.getBoundingClientRect(); if (!visible(e, r) || e.disabled) continue;
    const cs = getComputedStyle(e); const ob = col(cs.backgroundColor); if (!ob || ob[3] === 0 || (cs.boxShadow && cs.boxShadow !== "none")) continue; /* границу задают контейнер или тень */ /* прозрачное поле лежит в контейнере (строка/композер) — границу задаёт он */ const own = bgFor(e).bg, par = bgFor(e.parentElement).bg;
    const fill = SC.ratio(own, par);
    const bw = parseFloat(cs.borderTopWidth) || 0, bc = col(cs.borderTopColor); const brd = bw >= 1 && bc && bc[3] > 0 ? SC.ratio(SC.over(bc, [par[0], par[1], par[2], 1]), par) : 1;
    if (Math.max(fill, brd) < 1.25 && !e.closest(".composer,#composer,.chat-input-wrap")) push("field", e, own, par, Math.max(fill, brd), 1.25, { note: "поле сливается с фоном" });
  }
  return res;
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
  const ctx = await b.newContext({ viewport: { width: 390, height: 3400 }, deviceScaleFactor: 1, serviceWorkers: "block", locale: "ru-RU" });
  await ctx.addInitScript(() => { try { if (!localStorage.getItem("__init")) { localStorage.setItem("__init", "1"); localStorage.setItem("ether.lang", "ru"); } } catch (e) {} });
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "load" }); await page.waitForTimeout(1200);
  await page.evaluate(LIB);
  await page.click('[data-slide="0"] .onboarding-next'); await page.waitForTimeout(250);
  await page.fill("#onboarding-name", "Аня"); await page.click('[data-slide="1"] button[type=submit]').catch(() => {}); await page.waitForTimeout(1200);
  await page.click("#onboarding-start-btn").catch(() => {}); await page.waitForTimeout(900);
  await page.evaluate(() => {
    createDemoChat(); const c = state.contacts.get(DEMO_CHAT_ID); const now = Date.now(); const mk = (o) => Object.assign({ id: "s" + c.messages.length, ts: now - (30 - c.messages.length) * 40000 }, o);
    c.messages.length = 0;
    c.messages.push(
      mk({ from: "them", text: "Привет! Это входящее сообщение с @mention и ссылкой https://example.org/page", readAckSent: true, reactions: { "👍": ["me", "x"], "🔥": ["x"] } }),
      mk({ from: "me", text: "Исходящее сообщение, прочитано", ack: "read", reactions: { "😀": ["x"] }, favorite: true, edited: true }),
      mk({ from: "me", text: "Исходящее, доставлено", ack: "delivered" }),
      mk({ from: "me", text: "Пересланное мной сообщение", forwarded: true, forwardedFrom: "Борис", ack: "sent" }),
      mk({ from: "them", text: "Пересланное мне сообщение", forwarded: true, forwardedFrom: "Вера", readAckSent: true }),
      mk({ from: "them", text: "Пересланное без автора", forwarded: true, readAckSent: true }),
      mk({ from: "me", text: "Ответ на цитату", replyTo: { id: "s0", authorName: "Борис", text: "Привет! Это входящее сообщение" }, ack: "read" }),
      mk({ from: "them", text: "Ответ на ответ", replyTo: { id: "s1", authorName: "Аня", text: "Исходящее сообщение, прочитано" }, readAckSent: true, translation: { text: "Reply to a reply", lang: "en" } }),
      mk({ from: "them", text: "", file: { kind: "audio", duration: 14, name: "voice.webm", size: 20000, mime: "audio/webm" }, readAckSent: true }),
      mk({ from: "me", text: "", file: { kind: "audio", duration: 7, name: "voice.webm", size: 10000, mime: "audio/webm" }, ack: "read" }),
      mk({ from: "them", text: "", file: { kind: "doc", name: "report-2026.pdf", size: 123456, mime: "application/pdf" }, readAckSent: true }),
      mk({ from: "me", text: "", file: { kind: "doc", name: "table.xlsx", size: 5120, mime: "application/vnd.ms-excel" }, ack: "read" }),
      mk({ from: "them", text: "Опрос", poll: { q: "Куда пойдём?", multi: false, opts: [{ id: "a", t: "В кино" }, { id: "b", t: "В парк" }] }, pollVotes: { x: ["a"], [Store.myId]: ["b"] }, readAckSent: true }),
      mk({ from: "me", text: "", poll: { q: "Мой опрос", multi: true, opts: [{ id: "a", t: "Да" }, { id: "b", t: "Нет" }] }, pollVotes: {}, ack: "sent" }),
      mk({ from: "system", text: "Собеседник сменил ключ безопасности", textKey: "x" }),
      mk({ from: "them", text: "Сообщение со ссылкой https://example.com/article", readAckSent: true }),
      mk({ from: "me", text: "Исчезающее сообщение", ttl: 3600, ack: "sent" }),
      mk({ from: "them", text: "Непрочитанное входящее", mentionMe: true })
    );
    linkPreviewCache.set("https://example.com/article", { status: "done", data: { url: "https://example.com/article", title: "Заголовок статьи", description: "Описание страницы для превью ссылки", siteName: "example.com" } });
    linkPreviewCache.set("https://example.org/page", { status: "none", data: null });
    for (let i = 0; i < 3; i++) { const id = "__x" + i; state.contacts.set(id, { id, name: ["Борис", "Вера", "Глеб"][i], raw: "", managed: true, status: "paired", pinned: i === 0, messages: [{ id: "q" + i, from: "them", text: "Сообщение номер " + i, ts: now - i * 1000 }] }); }
    renderTab(); renderChatThread();
  }).catch((e) => errors.push("seed: " + e.message));
  const skinList = await page.evaluate(() => Skins.LIST.map((s) => s.id));
  const skins = opt("skins", skinList.join(",")).split(","), schemes = opt("schemes", "light,dark").split(",");
  const all = [];
  for (const skin of skins) for (const scheme of schemes) {
    await page.evaluate(([skin, scheme]) => { Store.theme = scheme; applyTheme(scheme); Skins.set(skin); }, [skin, scheme]).catch((e) => errors.push("set: " + e.message));
    await page.waitForTimeout(450);
    const step = async (name, fn) => {
      try { await fn(); } catch (e) { errors.push(`${skin}/${scheme}/${name}: ${e.message.split("\n")[0]}`); }
      await page.waitForTimeout(260);
      await page.evaluate(() => document.getAnimations().forEach((a) => { try { if (a.effect.getComputedTiming().iterations !== Infinity) a.finish(); } catch (e) {} })).catch(() => {}); // конец входных анимаций (появление меню, пузырей): без них снимали бы полупрозрачные кадры
      const r = await page.evaluate(pageAudit, { TEXT_MIN, UI_MIN, probe, strict }).catch((e) => { errors.push(`${skin}/${scheme}/${name} audit: ${e.message.split("\n")[0]}`); return []; });
      for (const x of r) all.push(Object.assign({ skin, scheme, screen: name }, x));
    };
    const closeAll = () => page.evaluate(() => { try { document.querySelectorAll(".sheet,.anchored-menu,.menu").forEach((e) => e.classList.add("hidden")); document.querySelectorAll("#edit-banner,#notif-banner,#keychange-banner,#pinned-msg-banner,#panic-shake-banner,#incoming-banner,#multiselect-banner").forEach((e) => e.classList.add("hidden")); } catch (e) {} });
    await step("chat", async () => { await page.evaluate(() => { document.querySelectorAll(".sheet").forEach((e) => e.classList.add("hidden")); state.tab = "chats"; state.chatId = DEMO_CHAT_ID; renderTab(); renderChatThread(); }); });
    await step("chat-menus", async () => { await page.click("#chat-plus-btn").catch(() => {}); });
    await step("chat-more", async () => { await page.keyboard.press("Escape").catch(() => {}); await closeAll(); await page.click("#chat-more-btn").catch(() => {}); });
    await step("msg-sheet", async () => { await closeAll(); await page.evaluate(() => { openMessageSheet("s1", DEMO_CHAT_ID); }); });
    await step("msg-sheet-fwd", async () => { await closeAll(); await page.evaluate(() => { document.querySelectorAll(".sheet").forEach((e) => e.classList.add("hidden")); openMessageSheet("s4", DEMO_CHAT_ID); }); });
    await step("banners", async () => {
      await closeAll();
      await page.evaluate(() => {
        document.querySelectorAll(".sheet").forEach((e) => e.classList.add("hidden"));
        for (const id of ["notif-banner", "keychange-banner", "edit-banner", "pinned-msg-banner", "panic-shake-banner", "incoming-banner", "multiselect-banner"]) { const e = document.getElementById(id); if (!e) continue; if (!e.textContent.trim()) e.textContent = "Баннер " + id; e.classList.remove("hidden"); }
        toast("Всплывающее уведомление");
      });
    });
    await step("chats", async () => { await closeAll(); await page.evaluate(() => { try { closeChat(); } catch (e) {} state.tab = "chats"; renderTab(); }); });
    await step("settings", async () => { await closeAll(); await page.click('.tab-btn[data-tab="settings"]'); });
    for (const cat of ["profile", "appearance", "privacy", "notifications", "data", "help"]) await step("set-" + cat, async () => { await page.click('.tab-btn[data-tab="settings"]').catch(() => {}); await page.evaluate((c) => { try { openSettingsCategory(c); } catch (e) {} }, cat); });
    await step("skins-sheet", async () => { await page.evaluate(() => { try { Skins.openSheet(); } catch (e) {} }); });
    await closeAll(); await page.evaluate(() => { try { Skins.closeSheet(); } catch (e) {} });
  }
  await b.close(); srv.close();
  // группировка: один дефект = (вид, элемент, скин, схема) -> худший экран
  const key = (x) => [x.kind, x.el].join("|");
  const groups = new Map();
  for (const x of all) { const k = key(x); let g = groups.get(k); if (!g) groups.set(k, g = { kind: x.kind, el: x.el, cases: new Map() }); const ck = x.skin + "/" + x.scheme; const old = g.cases.get(ck); if (!old || x.ratio < old.ratio) g.cases.set(ck, x); }
  const rows = [...groups.values()].sort((a, c) => c.cases.size - a.cases.size);
  const fails = rows.filter((g) => g.kind !== "field" && g.kind !== "probe"), warns = rows.filter((g) => g.kind === "field"), probes = rows.filter((g) => g.kind === "probe");
  for (const g of fails.concat(verbose ? warns : [], probes)) {
    const cs = [...g.cases.entries()];
    console.log(`[${g.kind}] ${g.el}  (${cs.length} комб.)`);
    for (const [ck, x] of cs.slice(0, verbose ? 99 : 6)) console.log(`    ${ck} @${x.screen}: ${x.ratio}:1 < ${x.need} fg=${x.fg} bg=${x.bg}${x.txt ? ' "' + x.txt + '"' : ""}`);
    if (!verbose && cs.length > 6) console.log(`    ... ещё ${cs.length - 6}`);
  }
  if (errors.length) console.log("ошибки прогона:\n  " + [...new Set(errors)].slice(0, 15).join("\n  "));
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(all, null, 1));
  console.log(`скинов: ${skins.length}, схем: ${schemes.length}; нарушений (групп): ${fails.length}${warns.length ? ", предупреждений (поля): " + warns.length : ""}`);
  process.exit(fails.length ? 1 : 0);
})();
