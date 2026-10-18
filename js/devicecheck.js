// =====================================================================
// Проверка устройства и «Сообщить об ошибке» (вкладка «Отладка»).
// Пошаговый самотест: звук, вибрация, микрофон/запись, Now Playing, Whisper, push, вьюпорт/клавиатура, хранилище, окружение.
// Итог — текстовый отчёт без личных данных и без содержимого чатов; пользователь сам решает, куда его отправить.
// Загружается после app.js/localai.js; всё, что нужно, берёт из window и ловит отсутствие API (iOS/Android/desktop ведут себя по-разному).
// =====================================================================
const DeviceCheck = (() => {
  const RU = {
    title: "Проверка устройства", start: "Начать", close: "Закрыть", copy: "Копировать", share: "Отправить", yes: "Да", no: "Нет", skip: "Пропустить",
    copied: "Отчёт скопирован", copyFail: "Не удалось скопировать", running: "Выполняется…", done: "Готово. Отчёт ниже — его можно скопировать или отправить разработчику.",
    reportBtn: "Сообщить об ошибке", checkBtn: "Проверка устройства", reportTitle: "Сообщить об ошибке",
    reportHint: "Отчёт содержит версию, тип устройства и технический журнал. Текстов сообщений, имён, ключей и токенов в нём нет — проверьте и отправьте сами.",
    qSound: "Вы услышали короткий тон?", qVib: "Телефон завибрировал?", qNow: "На экране блокировки/в шторке появилась карточка «Эфир — тест»?",
    qKb: "Нажмите в поле ниже: появилась клавиатура?", qWhisper: "Проверить распознавание речи? Скачается модель (около 80 МБ) — лучше по Wi-Fi.", qPush: "Запросить разрешение на уведомления?",
    s: { env: "Устройство и версия", audio: "Звук", vibration: "Вибрация", mic: "Микрофон и запись", media: "Now Playing (MediaSession)", whisper: "Whisper (локальный ИИ)", push: "Push-уведомления", viewport: "Экран и клавиатура", storage: "Хранилище" },
  };
  const EN = {
    title: "Device check", start: "Start", close: "Close", copy: "Copy", share: "Share", yes: "Yes", no: "No", skip: "Skip",
    copied: "Report copied", copyFail: "Could not copy", running: "Running…", done: "Done. The report is below: copy it or send it to the developer.",
    reportBtn: "Report a problem", checkBtn: "Device check", reportTitle: "Report a problem",
    reportHint: "The report has the version, device type and a technical log. It has no message texts, names, keys or tokens - review it and send it yourself.",
    qSound: "Did you hear a short tone?", qVib: "Did the phone vibrate?", qNow: "Does a card \"Ether - test\" show on the lock screen / notification shade?",
    qKb: "Tap the field below: did the keyboard appear?", qWhisper: "Test speech recognition? This downloads a model (about 80 MB) - better on Wi-Fi.", qPush: "Ask for notification permission?",
    s: { env: "Device and version", audio: "Sound", vibration: "Vibration", mic: "Microphone and recording", media: "Now Playing (MediaSession)", whisper: "Whisper (local AI)", push: "Push notifications", viewport: "Screen and keyboard", storage: "Storage" },
  };
  const L = () => { let l = "en"; try { l = (document.documentElement.getAttribute("lang") || "en").slice(0, 2); } catch (e) {} return l === "ru" ? RU : EN; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout:" + what)), ms))]);
  const errStr = (e) => String((e && (e.name ? e.name + ": " : "") + (e.message || e)) || e);

  // ---------- Санитайзер: из журнала/отчётов убираем всё, что может быть содержимым или секретом ----------
  const SECRET_KEYS = "text|body|message|msg|content|caption|title|name|nick|token|key|secret|password|pass|pwd|auth|authorization|endpoint|p256dh|sdp|candidate|ice|fingerprint|email|phone|transcript|summary";
  function sanitize(input) {
    let s = String(input == null ? "" : input);
    s = s.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "<pem>");
    s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "<jwt>");
    s = s.replace(/\b(https?|wss?):\/\/([^\s/"'<>?#]+)[^\s"'<>]*/gi, (m, p, host) => p + "://" + host.replace(/^[^@]*@/, "") + "/…"); // путь и query (часто с токенами) убираем, хост оставляем
    s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>");
    s = s.replace(new RegExp("([\"']?\\b(?:" + SECRET_KEYS + ")[\"']?\\s*[:=]\\s*)(\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*'|[^\\s,;}\\]]+)", "gi"), "$1<redacted>");
    s = s.replace(/"(?:[^"\\\n]|\\.){1,}"/g, '"…"'); // любые строки в кавычках: в логах там пользовательские тексты/имена
    s = s.replace(/\b[A-Za-z0-9+/_-]{24,}={0,2}/g, "<token>");
    s = s.replace(/\b[0-9a-f]{8,}(?:…|\.\.\.)?/gi, "<id>");
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>");
    s = s.replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "<ip>");
    return s;
  }
  function envLines() {
    const n = typeof navigator !== "undefined" ? navigator : {};
    const out = [];
    let ver = "?"; try { ver = typeof APP_VERSION !== "undefined" ? APP_VERSION : "?"; } catch (e) {}
    out.push("App: " + ver);
    out.push("UA: " + (n.userAgent || "?"));
    out.push("Platform: " + (n.platform || "?") + ", lang " + (n.language || "?") + ", ui " + (document.documentElement.getAttribute("lang") || "?"));
    let standalone = false; try { standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || n.standalone === true; } catch (e) {}
    out.push("Standalone (PWA): " + standalone + ", online: " + n.onLine);
    out.push("Cores: " + (n.hardwareConcurrency || "?") + ", memory GB: " + (n.deviceMemory || "?") + ", touch points: " + (n.maxTouchPoints || 0));
    try { if (n.connection) out.push("Network: " + n.connection.effectiveType + ", downlink " + n.connection.downlink + ", saveData " + !!n.connection.saveData); } catch (e) {}
    return out;
  }
  // Отчёт об ошибке: версия + окружение + технический журнал (etherLog), всё через sanitize
  function buildErrorReport(opts) {
    const o = opts || {};
    const lines = ["Ether — problem report", "Time: " + new Date().toISOString()].concat(envLines());
    if (o.note) lines.push("Note: " + sanitize(o.note));
    lines.push("", "--- log (last " + (o.max || 150) + ", sanitized) ---");
    let diag = []; try { diag = (window.__etherDiag || []).slice(-(o.max || 150)); } catch (e) {}
    for (const d of diag) lines.push(new Date(d.ts).toISOString().slice(11, 19) + " " + String(d.level || "").toUpperCase() + " " + sanitize(d.line));
    if (!diag.length) lines.push("(empty)");
    return lines.join("\n");
  }

  // ---------- Шаги ----------
  // ctx: { ask(question, {input}) → Promise<boolean|null>, progress(text) }; шаг возвращает { ok: true|false|null(пропуск), detail }
  const STEPS = [
    { id: "env", run: async () => ({ ok: true, detail: envLines().join("\n    ") }) },
    { id: "audio", run: async (ctx) => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return { ok: false, detail: "WebAudio недоступен" };
      const ac = new AC(); const d = ["state before resume: " + ac.state, "sampleRate " + ac.sampleRate];
      try { await withTimeout(ac.resume(), 2000, "resume"); } catch (e) { d.push("resume: " + errStr(e)); }
      d.push("state after resume: " + ac.state + " (visibility " + document.visibilityState + ")");
      const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 660; g.gain.value = 0.15; o.connect(g); g.connect(ac.destination);
      o.start(); o.stop(ac.currentTime + 0.5);
      try { if (typeof Skins !== "undefined" && Skins.sfx) { await sleep(600); Skins.sfx("tap"); d.push("skin sfx: called"); } } catch (e) { d.push("skin sfx: " + errStr(e)); }
      const heard = await ctx.ask(L().qSound);
      try { ac.close(); } catch (e) {}
      return { ok: ac.state !== "suspended" && heard !== false, detail: d.join(", ") + ", heard=" + heard };
    } },
    { id: "vibration", run: async (ctx) => {
      if (!navigator.vibrate) return { ok: null, detail: "navigator.vibrate недоступен (iOS Safari не поддерживает)" };
      let r; try { r = navigator.vibrate([200, 80, 200]); } catch (e) { return { ok: false, detail: errStr(e) }; }
      const felt = await ctx.ask(L().qVib);
      return { ok: r !== false && felt !== false, detail: "vibrate() -> " + r + ", felt=" + felt };
    } },
    { id: "mic", run: async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { ok: false, detail: "getUserMedia недоступен (нужен HTTPS)" };
      if (typeof MediaRecorder === "undefined") return { ok: false, detail: "MediaRecorder недоступен" };
      const cand = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus", "audio/aac"];
      const sup = cand.filter((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
      let stream; try { stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 30000, "getUserMedia"); } catch (e) { return { ok: false, detail: "supported: " + sup.join(" | ") + "; " + errStr(e) }; }
      try {
        const rec = new MediaRecorder(stream, sup[0] ? { mimeType: sup[0] } : undefined); const chunks = []; const t0 = Date.now();
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise((r) => { rec.onstop = r; });
        rec.start(); await sleep(1500); rec.stop(); await withTimeout(stopped, 4000, "stop");
        const size = chunks.reduce((a, b) => a + b.size, 0);
        return { ok: size > 0, detail: "supported: " + (sup.join(" | ") || "none") + "; recorded mime " + rec.mimeType + ", " + size + " B in " + (Date.now() - t0) + " ms, chunks " + chunks.length };
      } catch (e) { return { ok: false, detail: errStr(e) }; }
      finally { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
    } },
    { id: "media", run: async (ctx) => {
      if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return { ok: false, detail: "MediaSession недоступен" };
      const AC = window.AudioContext || window.webkitAudioContext; const d = [];
      // настоящее воспроизведение нужно, чтобы система показала карточку: 3 с тихого сигнала через <audio>
      let el = null, url = null;
      try {
        const sr = 8000, n = sr * 3, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 8) * 600), true);
        url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" })); el = new Audio(url); el.volume = 0.2;
        navigator.mediaSession.metadata = new MediaMetadata({ title: "Ether - test", artist: "Ether" });
        d.push("metadata set: " + (navigator.mediaSession.metadata && navigator.mediaSession.metadata.title));
        try { await el.play(); d.push("audio.play ok"); } catch (e) { d.push("audio.play: " + errStr(e)); }
        const seen = await ctx.ask(L().qNow);
        return { ok: !!navigator.mediaSession.metadata && seen !== false, detail: d.join(", ") + ", cardVisible=" + seen + (AC ? "" : ", no WebAudio") };
      } catch (e) { return { ok: false, detail: errStr(e) }; }
      finally { try { if (el) el.pause(); navigator.mediaSession.metadata = null; if (url) URL.revokeObjectURL(url); } catch (e) {} }
    } },
    { id: "whisper", run: async (ctx) => {
      if (typeof LocalAI === "undefined") return { ok: null, detail: "LocalAI не загружен" };
      if (navigator.onLine === false) return { ok: null, detail: "нет сети — модель не скачать" };
      const go = await ctx.ask(L().qWhisper);
      if (!go) return { ok: null, detail: "пропущено пользователем" };
      const off = LocalAI.onProgress ? LocalAI.onProgress((p) => ctx.progress("Whisper: " + Math.round(p) + "%")) : null;
      const t0 = Date.now();
      try {
        // встроенное аудио — синтетический тон 1.2 с (речь в репозиторий не кладём): проверяем, что конвейер модели грузится и отрабатывает
        const sr = 16000, n = Math.round(sr * 1.2), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i * 0.12) * 9000), true);
        const text = await withTimeout(LocalAI.transcribeBlob(new Blob([buf], { type: "audio/wav" })), 600000, "whisper");
        const eng = LocalAI.isReady() ? "ready" : "not ready";
        return { ok: true, detail: "engine " + eng + ", " + (Date.now() - t0) + " ms, output length " + String(text || "").length };
      } catch (e) { return { ok: false, detail: errStr(e) + " (" + (Date.now() - t0) + " ms)" }; }
      finally { if (off) off(); }
    } },
    { id: "push", run: async (ctx) => {
      const d = [];
      const sup = ("Notification" in window) && ("serviceWorker" in navigator) && ("PushManager" in window);
      d.push("supported=" + sup);
      if ("Notification" in window) {
        d.push("permission=" + Notification.permission);
        if (Notification.permission === "default" && sup && await ctx.ask(L().qPush)) { try { d.push("requested -> " + await Notification.requestPermission()); } catch (e) { d.push("request: " + errStr(e)); } }
      }
      let sub = null;
      try { const reg = await withTimeout(navigator.serviceWorker.getRegistration(), 3000, "sw"); d.push("sw=" + !!reg + (reg && reg.active ? "/active" : "")); if (reg && reg.pushManager) { sub = await reg.pushManager.getSubscription(); d.push("subscription=" + !!sub); } } catch (e) { d.push("sw: " + errStr(e)); }
      return { ok: sup ? true : false, detail: d.join(", ") + (sup ? "" : " (на iOS push доступен только из установленной PWA)") };
    } },
    { id: "viewport", run: async (ctx) => {
      const d = [], vv = window.visualViewport;
      d.push("inner " + innerWidth + "x" + innerHeight + ", dpr " + devicePixelRatio + ", screen " + (screen && screen.width) + "x" + (screen && screen.height));
      if (vv) d.push("visualViewport " + Math.round(vv.width) + "x" + Math.round(vv.height) + " scale " + vv.scale);
      let ins = "?";
      try { const el = document.createElement("div"); el.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"; document.body.appendChild(el); const cs = getComputedStyle(el); ins = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join("/"); el.remove(); } catch (e) {}
      d.push("safe-area t/r/b/l " + ins);
      let orient = ""; try { orient = (screen.orientation && screen.orientation.type) || ""; } catch (e) {} if (orient) d.push("orientation " + orient);
      let kb = "not measured";
      const res = await ctx.ask(L().qKb, { input: true, onAnswer: () => { if (vv) kb = "visualViewport height while focused " + Math.round(vv.height) + " (delta " + Math.round(innerHeight - vv.height) + ")"; } });
      d.push("keyboard shown=" + res + ", " + kb);
      return { ok: res !== false, detail: d.join(", ") };
    } },
    { id: "storage", run: async () => {
      const d = [];
      try {
        const name = "ether-devicecheck";
        await withTimeout(new Promise((res, rej) => { const q = indexedDB.open(name, 1); q.onupgradeneeded = () => q.result.createObjectStore("t"); q.onerror = () => rej(q.error); q.onsuccess = () => { const db = q.result; const tx = db.transaction("t", "readwrite"); tx.objectStore("t").put(1, "k"); tx.oncomplete = () => { db.close(); indexedDB.deleteDatabase(name); res(); }; tx.onerror = () => rej(tx.error); }; }), 5000, "idb");
        d.push("IndexedDB write/read ok");
      } catch (e) { d.push("IndexedDB: " + errStr(e)); return { ok: false, detail: d.join(", ") }; }
      try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); d.push("quota " + Math.round((e.quota || 0) / 1048576) + " MB, used " + Math.round((e.usage || 0) / 1048576) + " MB"); } else d.push("storage.estimate недоступен"); } catch (e) { d.push("estimate: " + errStr(e)); }
      try { if (navigator.storage && navigator.storage.persisted) d.push("persisted=" + await navigator.storage.persisted()); } catch (e) {}
      try { localStorage.setItem("__dc", "1"); localStorage.removeItem("__dc"); d.push("localStorage ok"); } catch (e) { d.push("localStorage: " + errStr(e)); }
      return { ok: true, detail: d.join(", ") };
    } },
  ];

  // Запуск без UI (тесты): ctx по умолчанию отвечает null на все вопросы. Возвращает { results, report }.
  async function run(ctx, only) {
    const c = Object.assign({ ask: async () => null, progress: () => {}, onStep: () => {} }, ctx || {});
    const results = [];
    for (const st of STEPS) {
      if (only && only.indexOf(st.id) < 0) continue;
      c.onStep(st.id, "start");
      let r; try { r = await st.run(c); } catch (e) { r = { ok: false, detail: "exception " + errStr(e) }; }
      r.id = st.id; results.push(r); c.onStep(st.id, "done", r);
    }
    return { results, report: buildReport(results) };
  }
  function buildReport(results) {
    const lines = ["Ether — device check", "Time: " + new Date().toISOString(), ""];
    for (const r of results) lines.push("[" + (r.ok === true ? "OK" : r.ok === false ? "FAIL" : "SKIP") + "] " + (L().s[r.id] || r.id) + (r.detail ? ": " + r.detail : ""));
    return sanitizeReport(lines.join("\n"));
  }
  // Для отчёта устройства санитайзер мягче (UA и размеры — не секреты): режем только то, что похоже на токены/адреса/почту
  function sanitizeReport(s) {
    return String(s).replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "<pem>").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>").replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "<token>");
  }

  // ---------- UI ----------
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function shareOrCopy(text) {
    if (navigator.share) return navigator.share({ title: "Ether report", text }).catch(() => {});
    return copy(text);
  }
  function copy(text) {
    const done = () => { try { toast(L().copied); } catch (e) {} }, fail = () => { try { toast(L().copyFail); } catch (e) {} };
    try { if (navigator.clipboard) return navigator.clipboard.writeText(text).then(done, fail); } catch (e) {}
    try { const ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); const ok = document.execCommand && document.execCommand("copy"); ta.remove(); ok ? done() : fail(); } catch (e) { fail(); }
  }
  function openSheet(title, hint) {
    const sheet = el("div", "sheet"), panel = el("div", "sheet-panel glass-content"), back = el("div", "sheet-backdrop");
    sheet.id = "devicecheck-sheet"; sheet.appendChild(back); sheet.appendChild(panel);
    panel.appendChild(el("div", "sheet-handle")); panel.appendChild(el("h2", "", title));
    if (hint) panel.appendChild(el("p", "fine", hint));
    document.body.appendChild(sheet);
    const close = () => { sheet.remove(); };
    back.addEventListener("click", close);
    return { sheet, panel, close };
  }
  function openCheck() {
    const t = L(); const { panel, close } = openSheet(t.title);
    const list = el("div", "diag-summary"), q = el("div", "diag-summary"), out = el("pre", "diag-log"), actions = el("div", "row-actions");
    const startBtn = el("button", "btn-primary", t.start); startBtn.type = "button";
    const closeBtn = el("button", "btn-tertiary", t.close); closeBtn.type = "button"; closeBtn.addEventListener("click", close);
    panel.append(list, q, out, startBtn, actions, closeBtn);
    const rows = {};
    for (const s of STEPS) { rows[s.id] = el("div", "", "• " + t.s[s.id]); list.appendChild(rows[s.id]); }
    const ctx = {
      progress: (txt) => { q.textContent = txt; },
      onStep: (id, ph, r) => { rows[id].textContent = (ph === "start" ? "… " : r.ok === true ? "✓ " : r.ok === false ? "✗ " : "– ") + t.s[id]; },
      ask: (question, o) => new Promise((resolve) => {
        q.textContent = ""; q.appendChild(el("p", "", question));
        let inp = null; if (o && o.input) { inp = el("input", "search-input"); inp.type = "text"; q.appendChild(inp); try { inp.focus(); } catch (e) {} }
        const row = el("div", "row-actions");
        const mk = (label, val) => { const b = el("button", "btn-secondary", label); b.type = "button"; b.addEventListener("click", () => { if (o && o.onAnswer) { try { o.onAnswer(val); } catch (e) {} } q.textContent = ""; resolve(val); }); return b; };
        row.append(mk(t.yes, true), mk(t.no, false), mk(t.skip, null)); q.appendChild(row);
      }),
    };
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true; startBtn.textContent = t.running;
      const { report } = await run(ctx);
      startBtn.remove(); q.textContent = t.done; out.textContent = report;
      const c = el("button", "btn-secondary", t.copy), s = el("button", "btn-secondary", t.share);
      c.type = s.type = "button"; c.addEventListener("click", () => copy(report)); s.addEventListener("click", () => shareOrCopy(report));
      actions.append(c, s);
    });
  }
  function openReport() {
    const t = L(); const { panel, close } = openSheet(t.reportTitle, t.reportHint);
    const text = buildErrorReport();
    const out = el("pre", "diag-log", text), actions = el("div", "row-actions");
    const c = el("button", "btn-secondary", t.copy), s = el("button", "btn-secondary", t.share), x = el("button", "btn-tertiary", t.close);
    c.type = s.type = x.type = "button"; c.addEventListener("click", () => copy(text)); s.addEventListener("click", () => shareOrCopy(text)); x.addEventListener("click", close);
    actions.append(c, s); panel.append(out, actions, x);
  }
  function wire() {
    const a = document.getElementById("devicecheck-btn"), b = document.getElementById("report-problem-btn");
    const pairs = [[a, "checkBtn", openCheck], [b, "reportBtn", openReport]];
    const relabel = () => { for (const [btn, key] of pairs) { const span = btn && btn.querySelector("span"); if (span) span.textContent = L()[key]; } };
    for (const [btn, , fn] of pairs) { if (!btn || btn.dataset.dcWired) continue; btn.dataset.dcWired = "1"; btn.addEventListener("click", fn); }
    relabel();
    // язык интерфейса выставляется после загрузки скриптов и может смениться в настройках
    try { if (a && typeof MutationObserver !== "undefined" && !wire.mo) { wire.mo = new MutationObserver(relabel); wire.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] }); } } catch (e) {}
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
  }
  return { STEPS, run, buildReport, buildErrorReport, sanitize, wire, openCheck, openReport };
})();
