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
    qSound: "Вы услышали короткий тон?", qVib: "Телефон завибрировал?", qNow: "На экране блокировки/в шторке появилась карточка «Мессенджер — тест»?",
    qKb: "Нажмите в поле ниже: появилась клавиатура?", qWhisper: "Проверить распознавание речи? Скачается модель (около 80 МБ) — лучше по Wi-Fi.", qPush: "Запросить разрешение на уведомления?",
    notifBtn: "Проверка уведомлений",
    nc: {
      title: "Проверка уведомлений", intro: "Проверим, дойдёт ли звонок, когда приложение закрыто.", refresh: "Проверить снова", allow: "Разрешить уведомления", testBtn: "Позвонить мне (тест)", testAria: "Отправить тестовый звонок на это устройство",
      testHint: "Нажмите и сразу заблокируйте экран или откройте другое приложение: должно прийти уведомление «звонит».", testing: "Ждём тестовый звонок… (до 15 секунд)", testOk: "Тестовый звонок дошёл за {n} с.", testFail: "Тестовый звонок не пришёл за 15 секунд. Посмотрите подсказки ниже.", testNoServer: "Нет связи с сервером — проверьте интернет и повторите.", testNoSub: "Сервер пока не знает ваше устройство: включите уведомления и повторите через несколько секунд.", testDisabled: "На сервере уведомления сейчас выключены.", testRate: "Слишком часто. Подождите минуту.",
      close: "Закрыть", closeAria: "Закрыть проверку уведомлений", tipsTitle: "Если уведомления не приходят",
      perm: "Разрешение на уведомления", permGranted: "разрешено", permDenied: "запрещено: включите в настройках телефона (Настройки → Уведомления → The Messenger)", permDefault: "ещё не запрошено", permNone: "этот браузер не умеет показывать уведомления",
      inst: "Установлено на экран «Домой»", instYes: "да", instNo: "нет: на iPhone уведомления приходят только в установленном приложении (Поделиться → На экран «Домой»)",
      sw: "Фоновая служба приложения", swYes: "работает", swNo: "не запущена: перезагрузите приложение",
      sub: "Подписка на уведомления", subYes: "есть", subNo: "нет: включите уведомления в настройках приложения", subAge: "создана {a} назад", subAgeUnknown: "возраст неизвестен",
      srv: "Сервер знает о вашем устройстве", srvYes: "да", srvNo: "не подтверждено: подождите несколько секунд после запуска и проверьте снова",
      last: "Последнее уведомление получено", lastNone: "ещё ни одного", lastAgo: "{a} назад",
      dMin: "мин.", dHour: "ч.", dDay: "дн.", dNow: "только что",
      tips: ["Добавьте приложение на экран «Домой»: Поделиться → На экран «Домой» — и открывайте его оттуда.", "Выключите «Не беспокоить» и «Фокусирование» или добавьте The Messenger в разрешённые приложения.", "Настройки → Уведомления → The Messenger: включите «Допуск уведомлений», «Звуки» и «Экран блокировки», стиль баннеров — «Постоянные».", "Проверьте, что телефон не в режиме без звука и громкость звонка не на нуле.", "Если ничего не помогло: удалите приложение с экрана «Домой», установите заново и снова разрешите уведомления."],
    },
    s: { env: "Устройство и версия", audio: "Звук", vibration: "Вибрация", mic: "Микрофон и запись", media: "Now Playing (MediaSession)", whisper: "Whisper (локальный ИИ)", push: "Push-уведомления", viewport: "Экран и клавиатура", storage: "Хранилище" },
  };
  const EN = {
    title: "Device check", start: "Start", close: "Close", copy: "Copy", share: "Share", yes: "Yes", no: "No", skip: "Skip",
    copied: "Report copied", copyFail: "Could not copy", running: "Running…", done: "Done. The report is below: copy it or send it to the developer.",
    reportBtn: "Report a problem", checkBtn: "Device check", reportTitle: "Report a problem",
    reportHint: "The report has the version, device type and a technical log. It has no message texts, names, keys or tokens - review it and send it yourself.",
    qSound: "Did you hear a short tone?", qVib: "Did the phone vibrate?", qNow: "Does a card \"The Messenger - test\" show on the lock screen / notification shade?",
    qKb: "Tap the field below: did the keyboard appear?", qWhisper: "Test speech recognition? This downloads a model (about 80 MB) - better on Wi-Fi.", qPush: "Ask for notification permission?",
    notifBtn: "Notification check",
    nc: {
      title: "Notification check", intro: "We will check whether a call reaches you while the app is closed.", refresh: "Check again", allow: "Allow notifications", testBtn: "Call me (test)", testAria: "Send a test call to this device",
      testHint: "Tap it, then lock the screen or open another app: a \"calling\" notification should arrive.", testing: "Waiting for the test call... (up to 15 seconds)", testOk: "The test call arrived in {n} s.", testFail: "The test call did not arrive within 15 seconds. See the tips below.", testNoServer: "No connection to the server - check the internet and try again.", testNoSub: "The server does not know this device yet: turn notifications on and retry in a few seconds.", testDisabled: "Notifications are switched off on the server.", testRate: "Too often. Wait a minute.",
      close: "Close", closeAria: "Close the notification check", tipsTitle: "If notifications do not arrive",
      perm: "Notification permission", permGranted: "allowed", permDenied: "blocked: allow it in the phone settings (Settings > Notifications > The Messenger)", permDefault: "not asked yet", permNone: "this browser cannot show notifications",
      inst: "Installed on the Home Screen", instYes: "yes", instNo: "no: on iPhone, notifications only arrive in the installed app (Share > Add to Home Screen)",
      sw: "App background service", swYes: "running", swNo: "not running: reload the app",
      sub: "Notification subscription", subYes: "present", subNo: "none: turn on notifications in the app settings", subAge: "created {a} ago", subAgeUnknown: "age unknown",
      srv: "Server knows your device", srvYes: "yes", srvNo: "not confirmed: wait a few seconds after launch and check again",
      last: "Last notification received", lastNone: "none yet", lastAgo: "{a} ago",
      dMin: "min", dHour: "h", dDay: "d", dNow: "just now",
      tips: ["Add the app to the Home Screen: Share > Add to Home Screen - and open it from there.", "Turn off Do Not Disturb and Focus, or add The Messenger to the allowed apps.", "Settings > Notifications > The Messenger: turn on Allow Notifications, Sounds and Lock Screen, set the banner style to Persistent.", "Make sure the phone is not on silent and the ringer volume is not zero.", "If nothing helps: remove the app from the Home Screen, install it again and allow notifications again."],
    },
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
    s = s.replace(/ether:\/\/link\?[^\s"'<>]*/gi, "<link-code>"); // одноразовый код переноса на новое устройство (js/devicelink.js)
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
    const lines = ["The Messenger — problem report", "Time: " + new Date().toISOString()].concat(envLines());
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
        navigator.mediaSession.metadata = new MediaMetadata({ title: "The Messenger - test", artist: "The Messenger" });
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
      const t0 = Date.now(); let stage = "wav";
      const whisperEnv = () => { const e = (LocalAI.envInfo && LocalAI.envInfo()) || {}; const g = LocalAI.getDiag && LocalAI.getDiag(); return (g && g.probe ? ", wasm probe " + g.probe : "") + (g && g.wasmHost ? " host=" + g.wasmHost : "") + ", env " + Object.keys(e).map((k) => k + "=" + e[k]).join(" "); };
      try {
        // встроенное аудио — синтетический тон 1.2 с (речь в репозиторий не кладём): проверяем, что конвейер модели грузится и отрабатывает
        const sr = 16000, n = Math.round(sr * 1.2), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i * 0.12) * 9000), true);
        // этап hash: библиотека на нашем origin должна совпасть с закреплённым SHA-384
        stage = "hash";
        try {
          const r = await withTimeout(fetch(LocalAI.TF_URL, { cache: "force-cache" }), 20000, "hash");
          if (!r.ok) throw new Error("http " + r.status);
          const dg = new Uint8Array(await crypto.subtle.digest("SHA-384", await r.arrayBuffer()));
          let b = ""; for (const x of dg) b += String.fromCharCode(x);
          if (btoa(b) !== LocalAI.TF_SHA384) throw new Error("sha384 mismatch");
        } catch (e) { if (/mismatch|http/.test(String(e && e.message))) throw Object.assign(e, { stage: "hash" }); /* subtle недоступен — не блокируем */ }
        stage = "pipeline";
        const text = await withTimeout(LocalAI.transcribeBlob(new Blob([buf], { type: "audio/wav" })), 600000, "whisper");
        const eng = LocalAI.isReady() ? "ready" : "not ready";
        return { ok: true, detail: "engine " + eng + ", model " + ((LocalAI.isReady() && LocalAI.getDiag && LocalAI.getDiag() && (LocalAI.getDiag().attempts.slice(-1)[0] || {}).model) || "?") + ", " + (Date.now() - t0) + " ms, output length " + String(text || "").length + whisperEnv() };
      } catch (e) {
        const dg = (LocalAI.getDiag && LocalAI.getDiag()) || e.localAiDiag || null;
        const st = (dg && dg.ok) ? "decode" : ((dg && dg.stage) || e.stage || stage);
        const nm = (dg && !dg.ok && dg.error && dg.error.name) || (e && e.name) || "Error";
        const msg = (dg && !dg.ok && dg.error && dg.error.msg) || String((e && e.message) || e).slice(0, 200);
        const att = dg ? dg.attempts.map((a, i) => (i + 1) + ":" + String(a.model).replace("Xenova/", "") + "/" + a.stage + (a.ok ? " ok" : a.error ? " " + a.error.name : "")).join("; ") : "";
        const hint = (dg && dg.hint) || (LocalAI.hintFor ? LocalAI.hintFor(st, nm, msg, []) : "");
        return { ok: false, detail: "stage=" + st + ", " + nm + ": " + msg + (dg && dg.http && dg.http.length ? ", http=" + dg.http.join("/") : "") + (dg ? ", downloaded " + Math.round(dg.bytes / 1024) + " KB" : "") + (att ? ", attempts [" + att + "]" : "") + whisperEnv() + ", " + (Date.now() - t0) + " ms. Подсказка: " + hint };
      }
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
    const lines = ["The Messenger — device check", "Time: " + new Date().toISOString(), ""];
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
    if (navigator.share) return navigator.share({ title: "The Messenger report", text }).catch(() => {});
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
  // ---------- V.79: «Проверка уведомлений» (настройки → уведомления): простыми словами, без жаргона ----------
  let ringWaiter = null;
  function onRing(d) { if (ringWaiter) ringWaiter(d || {}); }
  function isStandalone() { try { return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; } catch (e) { return false; } }
  function ageText(ms, nc) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return nc.dNow;
    if (m < 60) return m + " " + nc.dMin;
    if (m < 60 * 24) return Math.floor(m / 60) + " " + nc.dHour;
    return Math.floor(m / 1440) + " " + nc.dDay;
  }
  async function readLastPush() {
    try { const c = await caches.open("ether-meta"); const r = await c.match("./__lastpush.json"); return r ? await r.json() : null; } catch (e) { return null; }
  }
  // Состояние для экрана и тестов: [{ id, ok: true|false|null, label, detail }]
  async function notifState() {
    const nc = L().nc, rows = [];
    const hasN = typeof Notification !== "undefined";
    const perm = hasN ? Notification.permission : "none";
    rows.push({ id: "perm", ok: perm === "granted" ? true : perm === "default" ? null : false, label: nc.perm, detail: perm === "granted" ? nc.permGranted : perm === "denied" ? nc.permDenied : perm === "default" ? nc.permDefault : nc.permNone });
    const st = isStandalone();
    rows.push({ id: "inst", ok: st, label: nc.inst, detail: st ? nc.instYes : nc.instNo });
    let reg = null, sub = null;
    try { reg = await withTimeout(navigator.serviceWorker.getRegistration(), 3000, "sw"); } catch (e) {}
    rows.push({ id: "sw", ok: !!(reg && reg.active), label: nc.sw, detail: reg && reg.active ? nc.swYes : nc.swNo });
    try { if (reg && reg.pushManager) sub = await withTimeout(reg.pushManager.getSubscription(), 3000, "sub"); } catch (e) {}
    let age = ""; try { const at = parseInt(localStorage.getItem("ether.pushSubAt") || "0", 10); age = sub && at ? nc.subAge.replace("{a}", ageText(Date.now() - at, nc)) : nc.subAgeUnknown; } catch (e) { age = nc.subAgeUnknown; }
    rows.push({ id: "sub", ok: !!sub, label: nc.sub, detail: sub ? nc.subYes + ", " + age : nc.subNo });
    let srvOk = false; try { srvOk = typeof state !== "undefined" && !!state._pushServerOk && !!sub; } catch (e) {}
    rows.push({ id: "srv", ok: srvOk, label: nc.srv, detail: srvOk ? nc.srvYes : nc.srvNo });
    const last = await readLastPush();
    rows.push({ id: "last", ok: last && last.ts ? true : null, label: nc.last, detail: last && last.ts ? nc.lastAgo.replace("{a}", ageText(Date.now() - last.ts, nc)) : nc.lastNone });
    return rows;
  }
  // Тест: просим сервер прислать push-звонок на это устройство и ждём 15 с (сообщение от SW или свежая отметка в кэше)
  function runRingTest(ms) {
    const sig = typeof signaling !== "undefined" ? signaling : null;
    const t0 = Date.now(), limit = ms || 15000;
    if (!sig || !sig.connected || !sig.pushTestRing) return Promise.resolve({ ok: false, reason: "noserver" });
    return new Promise((resolve) => {
      let done = false, poll = null;
      let errOff = null;
      const fin = (ok, reason) => { if (done) return; done = true; clearInterval(poll); clearTimeout(tm); ringWaiter = null; if (errOff) errOff(); resolve({ ok, reason: reason || null, sec: Math.max(1, Math.round((Date.now() - t0) / 1000)) }); };
      ringWaiter = () => fin(true);
      const onErr = (ev) => { const why = ev && ev.detail && ev.detail.reason; fin(false, why === "nosub" || why === "disabled" || why === "ratelimit" ? why : "error"); };
      sig.addEventListener("push-test-error", onErr); errOff = () => sig.removeEventListener("push-test-error", onErr);
      poll = setInterval(async () => { const l = await readLastPush(); if (l && l.ts >= t0 && (l.t === "call-ring")) fin(true); }, 1000);
      const tm = setTimeout(() => fin(false), limit);
      if (!sig.pushTestRing()) fin(false);
    });
  }
  function openNotifCheck() {
    const t = L(), nc = t.nc; const { panel, close } = openSheet(nc.title, nc.intro);
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", nc.title);
    const list = el("ul", "notifcheck-list"), res = el("p", "fine", ""), actions = el("div", "row-actions notifcheck-actions"), tipsBox = el("div", "");
    res.setAttribute("role", "status"); res.setAttribute("aria-live", "polite");
    const testBtn = el("button", "btn-primary", nc.testBtn); testBtn.type = "button"; testBtn.setAttribute("aria-label", nc.testAria);
    const refreshBtn = el("button", "btn-secondary", nc.refresh); refreshBtn.type = "button"; refreshBtn.setAttribute("aria-label", nc.refresh);
    const allowBtn = el("button", "btn-secondary", nc.allow); allowBtn.type = "button"; allowBtn.setAttribute("aria-label", nc.allow); allowBtn.classList.add("hidden");
    const closeBtn = el("button", "btn-tertiary", nc.close); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", nc.closeAria); closeBtn.addEventListener("click", close);
    const hint = el("p", "fine muted", nc.testHint);
    actions.append(testBtn, refreshBtn, allowBtn);
    panel.append(list, hint, actions, res, tipsBox, closeBtn);
    const renderTips = () => {
      tipsBox.textContent = "";
      tipsBox.appendChild(el("h3", "", nc.tipsTitle));
      const ul = el("ul", "notifcheck-tips"); for (const tip of nc.tips) ul.appendChild(el("li", "", tip)); tipsBox.appendChild(ul);
    };
    const refresh = async () => {
      const rows = await notifState();
      list.textContent = "";
      for (const r of rows) {
        const li = el("li", "");
        const mark = el("span", "nc-state " + (r.ok === true ? "nc-ok" : r.ok === false ? "nc-bad" : ""), r.ok === true ? "✓" : r.ok === false ? "✗" : "–");
        mark.setAttribute("aria-hidden", "true");
        const txt = el("span", "", r.label + ": " + r.detail);
        li.append(mark, txt); list.appendChild(li);
      }
      const perm = rows.find((r) => r.id === "perm");
      allowBtn.classList.toggle("hidden", !(perm && perm.ok === null && typeof Notification !== "undefined"));
      const anyBad = rows.some((r) => r.ok === false);
      tipsBox.classList.toggle("hidden", !anyBad && !(res.dataset.failed === "1"));
      return rows;
    };
    renderTips();
    refreshBtn.addEventListener("click", refresh);
    allowBtn.addEventListener("click", async () => { try { await Notification.requestPermission(); } catch (e) {} try { if (typeof ensurePushSubscription === "function") await ensurePushSubscription(); } catch (e) {} refresh(); });
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true; res.dataset.failed = ""; res.textContent = nc.testing;
      const r = await runRingTest(15000);
      testBtn.disabled = false;
      if (r.ok) res.textContent = nc.testOk.replace("{n}", String(r.sec));
      else { res.textContent = r.reason === "noserver" ? nc.testNoServer : r.reason === "nosub" ? nc.testNoSub : r.reason === "disabled" ? nc.testDisabled : r.reason === "ratelimit" ? nc.testRate : nc.testFail; res.dataset.failed = "1"; }
      refresh();
    });
    refresh();
    return { refresh, close };
  }
  try { if (typeof window !== "undefined") window.notifCheckOnRing = onRing; } catch (e) {}
  function wire() {
    const a = document.getElementById("devicecheck-btn"), b = document.getElementById("report-problem-btn"), n = document.getElementById("notifcheck-btn");
    const pairs = [[a, "checkBtn", openCheck], [b, "reportBtn", openReport], [n, "notifBtn", openNotifCheck]];
    const relabel = () => { for (const [btn, key] of pairs) { const span = btn && btn.querySelector("span"); if (span) span.textContent = L()[key]; } };
    for (const [btn, , fn] of pairs) { if (!btn || btn.dataset.dcWired) continue; btn.dataset.dcWired = "1"; btn.addEventListener("click", fn); }
    relabel();
    // язык интерфейса выставляется после загрузки скриптов и может смениться в настройках
    try { if (a && typeof MutationObserver !== "undefined" && !wire.mo) { wire.mo = new MutationObserver(relabel); wire.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] }); } } catch (e) {}
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
  }
  return { STEPS, run, buildReport, buildErrorReport, sanitize, wire, openCheck, openReport, openNotifCheck, notifState, runRingTest, onRing };
})();
